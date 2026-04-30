#!/usr/bin/env node
/**
 * symphony-status — terminal dashboard for a running symphony orchestrator.
 *
 * Polls http://127.0.0.1:<port>/status once per second and re-renders a
 * full-screen TUI in place. No external dependencies — vanilla ANSI.
 */
import type { StatusSnapshot, RunningSnapshot, RetrySnapshot } from "./types.js";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const ANSI = {
  clear: `${ESC}2J`,
  home: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  altScreenOn: `${ESC}?1049h`,
  altScreenOff: `${ESC}?1049l`,
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  fgYellow: `${ESC}33m`,
  fgGreen: `${ESC}32m`,
  fgCyan: `${ESC}36m`,
  fgRed: `${ESC}31m`,
  fgMagenta: `${ESC}35m`,
  fgGrey: `${ESC}90m`,
};

function bold(s: string): string { return `${ANSI.bold}${s}${ANSI.reset}`; }
function dim(s: string): string { return `${ANSI.dim}${s}${ANSI.reset}`; }
function yellow(s: string): string { return `${ANSI.fgYellow}${s}${ANSI.reset}`; }
function green(s: string): string { return `${ANSI.fgGreen}${s}${ANSI.reset}`; }
function cyan(s: string): string { return `${ANSI.fgCyan}${s}${ANSI.reset}`; }
function red(s: string): string { return `${ANSI.fgRed}${s}${ANSI.reset}`; }
function grey(s: string): string { return `${ANSI.fgGrey}${s}${ANSI.reset}`; }

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { port: number; refreshMs: number } {
  const args = argv.slice(2);
  let port = 7777;
  let refreshMs = 1000;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (a === "--refresh-ms" && args[i + 1]) {
      refreshMs = Math.max(200, parseInt(args[i + 1], 10));
      i++;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: symphony-status [--port 7777] [--refresh-ms 1000]\n"
      );
      process.exit(0);
    }
  }
  return { port, refreshMs };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function shortSession(id: string | null): string {
  if (!id) return "—";
  if (id.length <= 13) return id;
  return `${id.slice(0, 4)}...${id.slice(-6)}`;
}

function pad(s: string, width: number): string {
  // Strip ANSI for length math, then pad to visual width.
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length >= width) return s + " ";
  return s + " ".repeat(width - stripped.length);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function colorState(state: string): string {
  const lower = state.toLowerCase();
  if (lower.includes("progress")) return cyan(state);
  if (lower.includes("rework")) return yellow(state);
  if (lower.includes("review")) return green(state);
  if (lower === "todo") return grey(state);
  return state;
}

// ─── Render ──────────────────────────────────────────────────────────────────

interface RenderState {
  port: number;
  refreshMs: number;
  lastSnap: StatusSnapshot | null;
  lastError: string | null;
  lastFetchAt: Date | null;
}

function renderHeader(s: RenderState): string {
  const out: string[] = [];
  out.push(bold("┌ SYMPHONY STATUS"));

  if (!s.lastSnap) {
    if (s.lastError) {
      out.push(`  ${red("Connection error:")} ${s.lastError}`);
      out.push(`  ${dim(`Polling http://127.0.0.1:${s.port}/status every ${s.refreshMs}ms…`)}`);
    } else {
      out.push(`  ${dim("Connecting…")}`);
    }
    return out.join("\n");
  }

  const snap = s.lastSnap;
  const agentsLine = `${snap.counts.running}/${snap.counts.max_concurrent}`;
  const tps = fmtNumber(snap.totals.throughput_tps);

  out.push(`${bold("Agents:")} ${yellow(agentsLine)}`);
  out.push(`${bold("Throughput:")} ${tps} tps`);
  out.push(`${bold("Runtime:")} ${fmtDuration(snap.process.uptime_seconds)}`);
  out.push(
    `${bold("Tokens:")} in ${fmtTokens(snap.totals.input_tokens)} | ` +
    `out ${fmtTokens(snap.totals.output_tokens)} | ` +
    `total ${fmtTokens(snap.totals.total_tokens)}`
  );

  const rl = snap.rate_limit;
  if (rl) {
    const statusColored =
      rl.status === "allowed" ? green(rl.status) :
      rl.status === "warning" ? yellow(rl.status) :
      rl.status === "blocked" ? red(rl.status) :
      rl.status;
    const overage = rl.overage_status
      ? `overage ${rl.is_using_overage ? yellow(rl.overage_status) : grey(rl.overage_status)}`
      : `overage ${grey("n/a")}`;
    out.push(
      `${bold("Rate Limits:")} claude (${rl.rate_limit_type}) | ` +
      `status ${statusColored} | ` +
      `resets in ${fmtDuration(rl.resets_in_seconds)} | ${overage}`
    );
  } else {
    out.push(
      `${bold("Rate Limits:")} ${grey("claude n/a")} | ` +
      `${grey("status n/a")} | ${grey("resets n/a")} | ${grey("overage n/a")}`
    );
  }

  const projectLine = snap.project.team_url
    ? `${cyan(snap.project.team_url)}`
    : snap.project.team_key
      ? `${grey("team")} ${snap.project.team_key}`
      : grey(snap.project.project_slug || "—");
  out.push(`${bold("Project:")} ${projectLine}`);

  const nextRefreshSec = Math.ceil(s.refreshMs / 1000);
  out.push(`${bold("Next refresh:")} ${nextRefreshSec}s`);

  return out.join("\n");
}

interface ColumnSpec {
  header: string;
  width: number;
}

const RUNNING_COLS: ColumnSpec[] = [
  { header: "ID",          width: 12 },
  { header: "STAGE",       width: 16 },
  { header: "PID",         width: 9 },
  { header: "AGE / TURN",  width: 14 },
  { header: "TOKENS",      width: 12 },
  { header: "SESSION",     width: 14 },
  { header: "EVENT",       width: 60 },
];

const RETRY_COLS: ColumnSpec[] = [
  { header: "ID",          width: 12 },
  { header: "ATTEMPT",     width: 10 },
  { header: "DUE IN",      width: 12 },
  { header: "ERROR",       width: 80 },
];

function renderTableHeader(cols: ColumnSpec[]): string {
  const cells = cols.map(c => pad(dim(bold(c.header)), c.width));
  return "  " + cells.join("");
}

function renderRunning(running: RunningSnapshot[]): string[] {
  if (running.length === 0) {
    return [`  ${dim("No agents running.")}`];
  }
  const lines: string[] = [];
  for (const r of running) {
    const dot = green("●");
    const id = pad(r.issue_identifier, RUNNING_COLS[0].width);
    const stage = pad(colorState(truncate(r.state, RUNNING_COLS[1].width - 1)), RUNNING_COLS[1].width);
    const pid = pad(r.pid !== null ? String(r.pid) : "—", RUNNING_COLS[2].width);
    const age = `${fmtDuration(r.age_seconds)} / ${r.turn_count}`;
    const ageCol = pad(age, RUNNING_COLS[3].width);
    const tokens = pad(fmtTokens(r.tokens.total_tokens), RUNNING_COLS[4].width);
    const session = pad(shortSession(r.session_id), RUNNING_COLS[5].width);

    const eventLabel = r.last_event ?? "—";
    const eventDetail = r.last_message ? `: ${truncate(r.last_message, 50)}` : "";
    const eventStr = truncate(`${eventLabel}${eventDetail}`, RUNNING_COLS[6].width - 1);

    lines.push(`${dot} ${id}${stage}${pid}${ageCol}${tokens}${session}${eventStr}`);
  }
  return lines;
}

function renderRetrying(retrying: RetrySnapshot[]): string[] {
  if (retrying.length === 0) {
    return [`  ${dim("No queued retries")}`];
  }
  const lines: string[] = [];
  for (const r of retrying) {
    const dot = yellow("●");
    const id = pad(r.issue_identifier, RETRY_COLS[0].width);
    const attempt = pad(`#${r.attempt}`, RETRY_COLS[1].width);
    const due = pad(fmtDuration(r.due_in_seconds), RETRY_COLS[2].width);
    const err = truncate(r.error ?? "—", RETRY_COLS[3].width - 1);
    lines.push(`${dot} ${id}${attempt}${due}${err}`);
  }
  return lines;
}

function render(state: RenderState): string {
  const parts: string[] = [];
  parts.push(renderHeader(state));
  parts.push("");

  if (state.lastSnap) {
    parts.push(`${bold("├ Running")}`);
    parts.push("");
    parts.push(renderTableHeader(RUNNING_COLS));
    parts.push(dim("  " + "─".repeat(RUNNING_COLS.reduce((sum, c) => sum + c.width, 0))));
    parts.push(...renderRunning(state.lastSnap.running));
    parts.push("");
    parts.push(`${bold("├ Backoff queue")}`);
    parts.push("");
    parts.push(renderTableHeader(RETRY_COLS));
    parts.push(dim("  " + "─".repeat(RETRY_COLS.reduce((sum, c) => sum + c.width, 0))));
    parts.push(...renderRetrying(state.lastSnap.retrying));
  }

  parts.push("");
  parts.push(dim(`└ ${state.lastFetchAt ? state.lastFetchAt.toISOString() : "—"} · q=quit`));

  return parts.join("\n");
}

// ─── Polling ─────────────────────────────────────────────────────────────────

async function fetchSnapshot(port: number): Promise<StatusSnapshot> {
  const res = await fetch(`http://127.0.0.1:${port}/status`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as StatusSnapshot;
  return json;
}

async function main(): Promise<void> {
  const { port, refreshMs } = parseArgs(process.argv);

  const state: RenderState = {
    port,
    refreshMs,
    lastSnap: null,
    lastError: null,
    lastFetchAt: null,
  };

  // Enter alt screen + hide cursor for a clean dashboard.
  process.stdout.write(ANSI.altScreenOn + ANSI.hideCursor + ANSI.clear + ANSI.home);

  let stopped = false;
  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    process.stdout.write(ANSI.showCursor + ANSI.altScreenOff);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Allow `q` to quit if stdin is a TTY.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const ch = buf.toString();
      if (ch === "q" || ch === "Q" || ch === "\x03") cleanup();
    });
  }

  const tick = async (): Promise<void> => {
    try {
      state.lastSnap = await fetchSnapshot(port);
      state.lastError = null;
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
    }
    state.lastFetchAt = new Date();

    // Re-render: home cursor and clear from there. Avoids flicker compared
    // to clear-screen on every tick.
    process.stdout.write(ANSI.home + ANSI.clear + ANSI.home + render(state));
  };

  await tick();
  const interval = setInterval(() => { void tick(); }, refreshMs);

  // Keep alive until cleanup; clean up the interval on exit.
  process.on("exit", () => clearInterval(interval));
}

main().catch((e) => {
  process.stdout.write(ANSI.showCursor + ANSI.altScreenOff);
  process.stderr.write(`Fatal: ${String(e)}\n`);
  process.exit(1);
});
