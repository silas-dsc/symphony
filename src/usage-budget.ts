import type { ChildProcess } from "node:child_process";

/**
 * Hourly Claude usage budget.
 *
 * Claude subscription usage is measured per 5-hour window (0–100%), shared by
 * every Claude process on the account: Symphony's agents and the operator's own
 * sessions. Every `checkMs` Symphony reads the account's current 5-hour
 * utilisation and keeps a short history. If usage in the trailing hour goes over
 * `maxPerHour` (e.g. 0.17 = 17% of the 5-hour limit), it suspends every
 * token-using child process (SIGSTOP), blocks new agents, and resumes (SIGCONT)
 * once enough time has passed for the trailing hour to fall back under budget.
 *
 * Measuring: a 1-token Haiku request with the account's OAuth token returns
 * `anthropic-ratelimit-unified-5h-utilization` / `-5h-reset` headers. That costs
 * a handful of tokens per check, which is negligible at one check every 15 min.
 */

export interface UsageSample {
  /** Epoch ms when measured. */
  at: number;
  /** 5-hour window utilisation, 0..1. */
  fiveHour: number;
  /** Epoch seconds when the 5-hour window resets (identifies the window). */
  fiveHourResetsAt: number;
  sevenDay: number | null;
}

export interface BudgetConfig {
  enabled: boolean;
  /** Max share of the 5-hour limit to use per trailing hour (0..1). */
  maxPerHour: number;
  checkMs: number;
}

export function parseBudgetConfig(raw: Record<string, unknown>): BudgetConfig {
  const share = typeof raw.max_share_per_hour === "number" ? raw.max_share_per_hour : 0.17;
  const minutes = typeof raw.check_minutes === "number" && raw.check_minutes >= 1 ? raw.check_minutes : 15;
  return {
    enabled: raw.enabled !== false,
    maxPerHour: share > 0 && share <= 1 ? share : 0.17,
    checkMs: minutes * 60_000,
  };
}

const HOUR = 60 * 60_000;

/** Usage increments between consecutive samples, attributed to the later sample's time. */
export function increments(samples: UsageSample[]): Array<{ at: number; amount: number }> {
  const out: Array<{ at: number; amount: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    // A new 5-hour window starts from 0, so everything measured in it is new usage.
    const sameWindow = cur.fiveHourResetsAt === prev.fiveHourResetsAt;
    const amount = sameWindow ? cur.fiveHour - prev.fiveHour : cur.fiveHour;
    if (amount > 0) out.push({ at: cur.at, amount });
  }
  return out;
}

export class UsageBudget {
  private samples: UsageSample[] = [];
  constructor(private readonly maxPerHour: number) {}

  record(s: UsageSample): void {
    this.samples.push(s);
    // Keep the newest sample older than an hour as the baseline; drop the rest.
    const cutoff = s.at - HOUR;
    while (this.samples.length > 2 && this.samples[1].at <= cutoff) this.samples.shift();
  }

  latest(): UsageSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /** Share of the 5-hour limit used in the hour before `now`. */
  spentLastHour(now: number): number {
    return increments(this.samples).filter(i => i.at > now - HOUR).reduce((s, i) => s + i.amount, 0);
  }

  /**
   * When usage may continue: null if under budget now; otherwise the earliest
   * time the trailing hour drops back under budget assuming no more usage, or
   * the 5-hour reset if that comes first.
   */
  resumeAt(now: number): number | null {
    const latest = this.latest();
    if (!latest) return null;
    const resetMs = latest.fiveHourResetsAt * 1000;
    if (latest.fiveHour >= 0.99) return Math.max(resetMs, now + 60_000); // effectively out until the window resets
    const recent = increments(this.samples).filter(i => i.at > now - HOUR);
    let total = recent.reduce((s, i) => s + i.amount, 0);
    if (total <= this.maxPerHour) return null;
    // Drop the oldest increments until the rest fit; we can resume an hour after the last one dropped.
    let at = now;
    for (const inc of recent) {
      total -= inc.amount;
      at = inc.at + HOUR;
      if (total <= this.maxPerHour) break;
    }
    return Math.min(at, resetMs > now ? resetMs : Infinity);
  }
}

// ─── measuring ────────────────────────────────────────────────────────────────

const PROBE_MODEL = "claude-haiku-4-5";

/** Read the account's unified rate-limit headers with a 1-token request. Null if unavailable. */
export async function probeUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<UsageSample | null> {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return parseUsageHeaders(res.headers, Date.now());
}

export function parseUsageHeaders(h: Headers, at: number): UsageSample | null {
  const util = h.get("anthropic-ratelimit-unified-5h-utilization");
  const reset = h.get("anthropic-ratelimit-unified-5h-reset");
  if (util === null || reset === null || !Number.isFinite(Number(util)) || !Number.isFinite(Number(reset))) return null;
  const seven = h.get("anthropic-ratelimit-unified-7d-utilization");
  return {
    at,
    fiveHour: Number(util),
    fiveHourResetsAt: Number(reset),
    sevenDay: seven !== null && Number.isFinite(Number(seven)) ? Number(seven) : null,
  };
}

// ─── pausing token-using processes ────────────────────────────────────────────

interface Tracked { proc: ChildProcess; label: string }

/**
 * Registry of token-using child processes (Claude/Codex/Ollama CLIs). Spawn
 * sites call `trackTokenProcess`; the budget suspends and resumes them all.
 * Processes registered while paused are suspended straight away.
 */
class TokenProcesses {
  private procs = new Set<Tracked>();
  private pausedUntilMs = 0;

  track(proc: ChildProcess, label: string): void {
    const t = { proc, label };
    this.procs.add(t);
    proc.once("exit", () => this.procs.delete(t));
    if (this.isPaused()) signal(proc, "SIGSTOP");
  }

  isPaused(): boolean {
    return this.pausedUntilMs > 0;
  }

  pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** Suspend everything until `untilMs` (the budget decides when to actually resume). */
  pause(untilMs: number): string[] {
    const was = this.isPaused();
    this.pausedUntilMs = untilMs;
    if (was) return [];
    for (const t of this.procs) signal(t.proc, "SIGSTOP");
    return [...this.procs].map(t => t.label);
  }

  resume(): string[] {
    if (!this.isPaused()) return [];
    this.pausedUntilMs = 0;
    for (const t of this.procs) signal(t.proc, "SIGCONT");
    return [...this.procs].map(t => t.label);
  }

  count(): number {
    return this.procs.size;
  }
}

function signal(proc: ChildProcess, sig: NodeJS.Signals): void {
  // Not `proc.killed`: Node sets it after any signal, SIGSTOP included, which would block the SIGCONT.
  if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
  try {
    proc.kill(sig);
  } catch {
    // Already gone.
  }
}

export const tokenProcesses = new TokenProcesses();

/** Register a spawned Claude/Codex/Ollama process so the usage budget can pause it. */
export function trackTokenProcess(proc: ChildProcess, label: string): void {
  tokenProcesses.track(proc, label);
}
