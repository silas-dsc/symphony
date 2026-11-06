import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import type { Lesson } from "./lessons.js";
import type { RunRecord } from "./run-log.js";
import type { GateInput, Logger } from "./types.js";

/**
 * Symphony's self-improvement loop (v2.improve). Symphony itself spends no
 * tokens here; the thinking happens in a Claude desktop Scheduled task
 * ("Symphony daily improvement", prompts/DAILY_IMPROVE.md) that reads the brief
 * this loop writes.
 *
 * - Retro queue: tickets Symphony ran that are now Done and have no lesson are
 *   listed in the brief (with their run history). The daily task writes their
 *   lessons in one batch. (`retro_mode: per_ticket` runs one retrospective agent
 *   per ticket instead — more thorough, more tokens.)
 * - Detectors: retry loops, costly tickets and failure spikes from the run log.
 *   A looping ticket gets the hold label (no more dispatches) and a Resume card;
 *   removing the label in Linear also resumes it.
 * - Brief: `<state>/improve-brief.md` — metrics, today's alerts, the retro queue
 *   and how earlier process changes scored.
 * - Process changes: any open `improve/*` PR on the Symphony repo gets a 🛠️
 *   Merge / Close card. Merged ones are scored on the run log after 2 days
 *   (failure rate, cost per ticket, rework vs the week before) and the result
 *   goes in the brief, so the next pass can revert a change that hurt.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface ImproveConfig {
  retroMode: "batched" | "per_ticket";
  retroPollMs: number;
  retroLookbackDays: number;
  retrosPerPoll: number;
  triggerStates: string[];
  detectEveryMs: number;
  prPollMs: number;
  loopFailures: number;
  loopWindowHours: number;
  ticketCostAlertUsd: number;
  /** Linear label that stops dispatch. Remove it (or click Resume) to let Symphony retry. */
  holdLabel: string;
  statePath: string;
  briefPath: string;
}

export interface TicketInfo {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  labels: string[];
}

export interface Metrics {
  runs: number;
  tickets: number;
  failRate: number;
  costPerTicket: number;
  avgTurns: number;
  reworkShare: number;
}

export interface Finding {
  key: string;
  kind: "loop" | "cost" | "systemic";
  ticket: string | null;
  text: string;
}

export interface ImprovePr { number: number; url: string; title: string; branch: string }

export interface ImproveDeps {
  readRuns(): RunRecord[];
  readLessons(): Lesson[];
  ticket(identifier: string): Promise<TicketInfo | null>;
  /** Only used with retro_mode: per_ticket. */
  retro(t: TicketInfo, runHistory: string): Promise<void>;
  openGate(input: GateInput): Promise<void>;
  dm(text: string): Promise<void>;
  addLabel(issueId: string, name: string): Promise<void>;
  removeLabel(issueId: string, name: string): Promise<void>;
  /** Open PRs on the Symphony repo whose branch starts with improve/. */
  listImprovePrs(): Promise<ImprovePr[]>;
  prState(n: number): Promise<{ state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null }>;
  mergePr(n: number): Promise<void>;
  closePr(n: number): Promise<void>;
  paused(): boolean;
  now(): number;
}

type Verdict = "better" | "worse" | "unclear";

interface Change {
  pr: number;
  url: string;
  title: string;
  openedAt: string;
  mergedAt: string | null;
  closed: boolean;
  baseline: Metrics;
  verdict: Verdict | null;
  after: Metrics | null;
}

interface Hold { ticket: string; issueId: string; since: string; reason: string }
interface Pending { title: string; url: string; state: string; since: string }

interface State {
  retroDone: Record<string, string>;
  retroChecked: Record<string, string>;
  /** Done tickets waiting for the daily task to write their lesson. */
  pendingRetro: Record<string, Pending>;
  holds: Record<string, Hold>;
  /** Ticket → time it was resumed; detectors ignore failures before it. */
  resumed: Record<string, string>;
  alerts: Record<string, { at: string; text: string }>;
  changes: Change[];
}

const emptyState = (): State => ({
  retroDone: {}, retroChecked: {}, pendingRetro: {}, holds: {}, resumed: {}, alerts: {}, changes: [],
});

// ─── pure helpers ─────────────────────────────────────────────────────────────

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

export function metricsFor(runs: RunRecord[], from: number, to: number): Metrics {
  const rs = runs.filter(r => { const t = Date.parse(r.at); return t >= from && t < to; });
  const tickets = new Set(rs.map(r => r.issue)).size;
  const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  return {
    runs: rs.length,
    tickets,
    failRate: rs.length ? round(rs.filter(r => !r.success).length / rs.length) : 0,
    costPerTicket: tickets ? round(cost / tickets) : 0,
    avgTurns: rs.length ? round(rs.reduce((s, r) => s + r.turns, 0) / rs.length, 1) : 0,
    reworkShare: rs.length ? round(rs.filter(r => r.rework).length / rs.length) : 0,
  };
}

export function formatMetrics(m: Metrics): string {
  return `${m.runs} runs on ${m.tickets} tickets, ${Math.round(m.failRate * 100)}% failed, $${m.costPerTicket.toFixed(2)}/ticket, ` +
    `${m.avgTurns} turns/run, ${Math.round(m.reworkShare * 100)}% rework`;
}

/** Rough before/after call. Confounded by ticket mix, so the daily pass treats it as a hint. */
export function judge(before: Metrics, after: Metrics): Verdict {
  const failUp = after.failRate - before.failRate;
  const costRatio = before.costPerTicket > 0 ? after.costPerTicket / before.costPerTicket : 1;
  if (failUp > 0.1 || (costRatio > 1.25 && failUp >= 0)) return "worse";
  if (failUp < -0.1 || (costRatio < 0.8 && failUp <= 0)) return "better";
  return "unclear";
}

export function detect(
  runs: RunRecord[], now: number, cfg: Pick<ImproveConfig, "loopFailures" | "loopWindowHours" | "ticketCostAlertUsd">,
  resumed: Record<string, string> = {},
): Finding[] {
  const out: Finding[] = [];
  const byTicket = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const t = Date.parse(r.at);
    if (t < now - Math.max(cfg.loopWindowHours * HOUR, DAY)) continue;
    if (resumed[r.issue] && t <= Date.parse(resumed[r.issue])) continue;
    if (!byTicket.has(r.issue)) byTicket.set(r.issue, []);
    byTicket.get(r.issue)!.push(r);
  }
  for (const [ticket, rs] of byTicket) {
    rs.sort((a, b) => a.at.localeCompare(b.at));
    // Trailing streak of failures inside the loop window.
    const recent = rs.filter(r => Date.parse(r.at) >= now - cfg.loopWindowHours * HOUR);
    const streak: RunRecord[] = [];
    for (let i = recent.length - 1; i >= 0 && !recent[i].success; i--) streak.unshift(recent[i]);
    if (streak.length >= cfg.loopFailures) {
      const errors = new Map<string, number>();
      for (const r of streak) { const e = shortError(r.error); errors.set(e, (errors.get(e) ?? 0) + 1); }
      const top = [...errors.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const cost = streak.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      out.push({
        key: `loop:${ticket}:${streak[0].at}`, kind: "loop", ticket,
        text: `${ticket} failed ${streak.length} runs in a row (${top}; $${cost.toFixed(2)}, ${streak.reduce((s, r) => s + r.turns, 0)} turns).`,
      });
    }
    const dayCost = rs.filter(r => Date.parse(r.at) >= now - DAY).reduce((s, r) => s + (r.costUsd ?? 0), 0);
    if (cfg.ticketCostAlertUsd > 0 && dayCost >= cfg.ticketCostAlertUsd) {
      out.push({
        key: `cost:${ticket}:${new Date(now).toISOString().slice(0, 10)}`, kind: "cost", ticket,
        text: `${ticket} used $${dayCost.toFixed(2)} of agent time in 24h (alert at $${cfg.ticketCostAlertUsd}).`,
      });
    }
  }
  const last = runs.filter(r => Date.parse(r.at) >= now - 6 * HOUR).slice(-10);
  const failed = last.filter(r => !r.success);
  if (last.length >= 10 && failed.length >= 7 && new Set(failed.map(r => r.issue)).size >= 3) {
    out.push({
      key: `systemic:${new Date(now).toISOString().slice(0, 13)}`, kind: "systemic", ticket: null,
      text: `${failed.length} of the last ${last.length} runs failed across ${new Set(failed.map(r => r.issue)).size} tickets (${[...new Set(failed.map(r => shortError(r.error)))].slice(0, 3).join("; ")}).`,
    });
  }
  return out;
}

function shortError(e: string | null): string {
  if (!e) return "no error text";
  return e.replace(/\s+/g, " ").slice(0, 80);
}

export function runHistory(runs: RunRecord[], ticket: string): string {
  return runs.filter(r => r.issue === ticket).slice(-30).map(r =>
    `${r.at.slice(0, 16)} ${r.success ? "ok  " : "FAIL"} ${r.rework ? "rework " : ""}turns=${r.turns} $${(r.costUsd ?? 0).toFixed(2)}${r.error ? ` ${shortError(r.error)}` : ""}`,
  ).join("\n");
}

// ─── the loop ────────────────────────────────────────────────────────────────

export class ImprovementLoop {
  private state: State;
  private lastRetroPoll = 0;
  private lastDetect = 0;
  private lastPrPoll = 0;
  private retroBusy = false;

  constructor(private readonly cfg: ImproveConfig, private readonly deps: ImproveDeps, private readonly log: Logger) {
    this.state = emptyState();
    try {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(cfg.statePath, "utf8")) };
    } catch {
      // first run
    }
  }

  /** True while a ticket is on hold — the orchestrator must not dispatch it. */
  isHeld(issue: { identifier?: string; labels?: string[] }): boolean {
    const label = this.cfg.holdLabel.toLowerCase();
    return (!!issue.identifier && !!this.state.holds[issue.identifier]) || (issue.labels ?? []).some(l => l.toLowerCase() === label);
  }

  holds(): Hold[] {
    return Object.values(this.state.holds);
  }

  /** Called every tick. Only per-ticket retros (if on) spend tokens, and they run in the background. */
  async reconcile(): Promise<void> {
    const now = this.deps.now();
    const step = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { this.log.warn(`Improvement ${name} failed`, { error: errMsg(e) }); }
    };
    if (now - this.lastDetect >= this.cfg.detectEveryMs) {
      this.lastDetect = now;
      await step("detectors", () => this.runDetectors(now));
    }
    if (now - this.lastPrPoll >= this.cfg.prPollMs) {
      this.lastPrPoll = now;
      await step("PR discovery", () => this.discoverPrs(now));
      await step("outcomes", () => this.updateOutcomes(now));
    }
    let retros: Promise<void> | null = null;
    if (!this.retroBusy && now - this.lastRetroPoll >= this.cfg.retroPollMs && !(this.cfg.retroMode === "per_ticket" && this.deps.paused())) {
      this.lastRetroPoll = now;
      this.retroBusy = true;
      retros = step("retro poll", () => this.runRetros(now)).finally(() => { this.retroBusy = false; });
    }
    if (retros && this.cfg.retroMode === "batched") await retros; // Linear reads only — quick
    await step("brief", async () => this.writeBrief(now));
    if (retros) await retros;
  }

  // ── retros ──

  private async runRetros(now: number): Promise<void> {
    const runs = this.deps.readRuns();
    const withLesson = new Set(this.deps.readLessons().map(l => l.ticket).filter((t): t is string => !!t));
    for (const t of Object.keys(this.state.pendingRetro)) if (withLesson.has(t)) { delete this.state.pendingRetro[t]; this.state.retroDone[t] = new Date(now).toISOString(); }
    const since = now - this.cfg.retroLookbackDays * DAY;
    const tickets = [...new Set(runs.filter(r => Date.parse(r.at) >= since).map(r => r.issue))]
      .filter(t => !this.state.retroDone[t] && !this.state.pendingRetro[t] && !withLesson.has(t))
      .sort((a, b) => (this.state.retroChecked[a] ?? "").localeCompare(this.state.retroChecked[b] ?? ""))
      .slice(0, 10);
    const trigger = this.cfg.triggerStates.map(s => s.toLowerCase());
    let ran = 0;
    for (const id of tickets) {
      if (this.cfg.retroMode === "per_ticket" && (ran >= this.cfg.retrosPerPoll || this.deps.paused())) break;
      this.state.retroChecked[id] = new Date(now).toISOString();
      const t = await this.deps.ticket(id).catch(() => null);
      if (!t || !trigger.includes(t.state.toLowerCase())) continue;
      if (this.cfg.retroMode === "batched") {
        this.state.pendingRetro[id] = { title: t.title, url: t.url, state: t.state, since: new Date(now).toISOString() };
        continue;
      }
      this.log.info("Running retrospective", { issue_identifier: id, state: t.state });
      await this.deps.retro(t, runHistory(runs, id)).catch(e => this.log.warn("Retrospective failed", { issue_identifier: id, error: errMsg(e) }));
      this.state.retroDone[id] = new Date(this.deps.now()).toISOString();
      ran++;
    }
    // Forget tickets that fell out of the lookback window.
    for (const map of [this.state.retroDone, this.state.retroChecked]) {
      for (const [k, v] of Object.entries(map)) if (Date.parse(v) < since - DAY) delete map[k];
    }
    for (const [k, v] of Object.entries(this.state.pendingRetro)) if (Date.parse(v.since) < now - 14 * DAY) delete this.state.pendingRetro[k];
    this.persist();
  }

  // ── detectors ──

  private async runDetectors(now: number): Promise<void> {
    const findings = detect(this.deps.readRuns(), now, this.cfg, this.state.resumed);
    for (const f of findings) {
      if (this.state.alerts[f.key]) continue;
      this.state.alerts[f.key] = { at: new Date(now).toISOString(), text: f.text };
      this.persist();
      if (f.kind === "loop" && f.ticket && !this.state.holds[f.ticket]) await this.hold(f);
      else if (f.kind !== "loop") await this.deps.dm(`${f.kind === "cost" ? "💸" : "🚨"} ${f.text}`);
    }
    for (const [k, v] of Object.entries(this.state.alerts)) if (Date.parse(v.at) < now - 7 * DAY) delete this.state.alerts[k];
    // Someone removed the label in Linear → resume.
    for (const h of Object.values(this.state.holds)) {
      const t = await this.deps.ticket(h.ticket).catch(() => undefined);
      if (t === undefined) continue;
      const label = this.cfg.holdLabel.toLowerCase();
      if (!t || !t.labels.some(l => l.toLowerCase() === label)) this.release(h.ticket, now);
    }
    this.persist();
  }

  private release(ticket: string, now: number): void {
    delete this.state.holds[ticket];
    this.state.resumed[ticket] = new Date(now).toISOString();
  }

  private async hold(f: Finding): Promise<void> {
    const t = await this.deps.ticket(f.ticket!).catch(() => null);
    if (!t) return;
    await this.deps.addLabel(t.id, this.cfg.holdLabel);
    this.state.holds[t.identifier] = { ticket: t.identifier, issueId: t.id, since: new Date(this.deps.now()).toISOString(), reason: f.text };
    this.persist();
    this.log.warn("Ticket put on hold: repeated failures", { issue_identifier: t.identifier, reason: f.text });
    await this.deps.openGate({
      kind: "ticket_hold",
      issueId: t.id,
      issueIdentifier: t.identifier,
      title: `Paused ${t.identifier}: ${t.title}`.slice(0, 120),
      summary: `${f.text}\nSymphony stopped retrying it (label "${this.cfg.holdLabel}") so it doesn't keep burning tokens. Fix the cause or the ticket, then resume here or remove the label.`,
      question: "Resume it?",
      links: [{ label: t.identifier, url: t.url }],
      meta: { ticket: t.identifier },
    });
  }

  /** Card decision for a held ticket. */
  async onHoldDecision(ticket: string, actionId: string): Promise<void> {
    const h = this.state.holds[ticket];
    if (!h || actionId !== "resume") return; // "Keep paused": the label stays until someone removes it
    await this.deps.removeLabel(h.issueId, this.cfg.holdLabel);
    this.release(ticket, this.deps.now());
    this.persist();
  }

  // ── process changes ──

  /** New improve/* PRs (opened by the daily task) → baseline + Merge card. */
  private async discoverPrs(now: number): Promise<void> {
    const prs = await this.deps.listImprovePrs();
    for (const pr of prs) {
      if (this.state.changes.some(c => c.pr === pr.number)) continue;
      this.state.changes.push({
        pr: pr.number, url: pr.url, title: pr.title, openedAt: new Date(now).toISOString(),
        mergedAt: null, closed: false, baseline: metricsFor(this.deps.readRuns(), now - 7 * DAY, now), verdict: null, after: null,
      });
      this.state.changes = this.state.changes.slice(-50);
      this.persist();
      await this.deps.openGate({
        kind: "process_change",
        title: `Process change: ${pr.title}`.slice(0, 120),
        summary: "Today's improvement pass proposes edits to Symphony's prompts/workflow. The PR body lists each change, its evidence and what should improve.",
        question: "Merge these prompt/workflow changes?",
        links: [{ label: `PR #${pr.number}`, url: pr.url }],
        meta: { prNumber: String(pr.number), prUrl: pr.url },
      });
    }
  }

  /** Card decision on a process-change PR. */
  async onChangeDecision(prNumber: number, actionId: string): Promise<void> {
    const c = this.state.changes.find(x => x.pr === prNumber);
    if (actionId === "merge") {
      await this.deps.mergePr(prNumber);
      if (c) c.mergedAt = new Date(this.deps.now()).toISOString();
    } else if (actionId === "close") {
      await this.deps.closePr(prNumber);
      if (c) c.closed = true;
    }
    this.persist();
  }

  private async updateOutcomes(now: number): Promise<void> {
    const runs = this.deps.readRuns();
    for (const c of this.state.changes) {
      if (c.closed || c.verdict) continue;
      if (!c.mergedAt) {
        const s = await this.deps.prState(c.pr).catch(() => null);
        if (s?.state === "MERGED") c.mergedAt = s.mergedAt ?? new Date(now).toISOString();
        else if (s?.state === "CLOSED") c.closed = true;
        continue;
      }
      const merged = Date.parse(c.mergedAt);
      if (now - merged < 2 * DAY) continue;
      const after = metricsFor(runs, merged, now);
      if (after.runs < 10 && now - merged < 7 * DAY) continue;
      c.after = after;
      c.verdict = after.runs < 10 ? "unclear" : judge(c.baseline, after);
      if (c.verdict === "worse") {
        await this.deps.dm(`⚠️ Process change PR #${c.pr} (${c.title}) looks worse since it merged: ${formatMetrics(c.baseline)} → ${formatMetrics(after)}. The next improvement pass will consider reverting it. ${c.url}`);
      }
    }
    this.persist();
  }

  // ── brief for the daily Scheduled task ──

  brief(now: number): string {
    const runs = this.deps.readRuns();
    const alerts = Object.values(this.state.alerts).filter(a => Date.parse(a.at) >= now - DAY).map(a => `- ${a.text}`);
    const pending = Object.entries(this.state.pendingRetro).sort(([a], [b]) => a.localeCompare(b));
    const outcomes = this.state.changes.filter(c => c.verdict && c.mergedAt && Date.parse(c.mergedAt) >= now - 21 * DAY)
      .map(c => `- PR #${c.pr} "${c.title}" merged ${c.mergedAt!.slice(0, 10)}: **${c.verdict}**. Before: ${formatMetrics(c.baseline)}. After: ${c.after ? formatMetrics(c.after) : "n/a"}.`);
    const open = this.state.changes.filter(c => !c.closed && !c.mergedAt).map(c => `- PR #${c.pr} (open, awaiting review): ${c.title} ${c.url}`);
    const waiting = this.state.changes.filter(c => c.mergedAt && !c.verdict).map(c => `- PR #${c.pr} merged ${c.mergedAt!.slice(0, 10)}: not scored yet`);
    return [
      `# Symphony improvement brief`,
      ``,
      `Written by Symphony at ${new Date(now).toISOString()} (refreshed every few minutes while it runs).`,
      ``,
      `## Run metrics`,
      `- Last 24h: ${formatMetrics(metricsFor(runs, now - DAY, now))}`,
      `- Last 7d: ${formatMetrics(metricsFor(runs, now - 7 * DAY, now))}`,
      ``,
      `## Alerts in the last 24h`,
      ...(alerts.length ? alerts : ["- none"]),
      ...(this.holds().length ? ["", "Tickets on hold:", ...this.holds().map(h => `- ${h.ticket}: ${h.reason}`)] : []),
      ``,
      `## Tickets that need a lesson (${pending.length})`,
      `Done, ran by Symphony, no entry in lessons.jsonl yet. Run history: time, ok/FAIL, turns, cost, error.`,
      ...(pending.length ? [] : ["- none"]),
      ...pending.flatMap(([id, p]) => [``, `### ${id}: ${p.title}`, p.url, "```", runHistory(runs, id) || "(no runs logged)", "```"]),
      ``,
      `## Earlier process changes`,
      ...([...outcomes, ...waiting, ...open].length ? [...outcomes, ...waiting, ...open] : ["- none yet"]),
      ``,
    ].join("\n");
  }

  private writeBrief(now: number): void {
    try {
      fs.writeFileSync(this.cfg.briefPath, this.brief(now));
    } catch (e) {
      this.log.warn("Could not write improvement brief", { error: errMsg(e) });
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // best effort
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── gh helpers for improve/* PRs ────────────────────────────────────────────

const execFileP = promisify(execFile);

async function sh(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** owner/name of the Symphony repo, so gh never touches the live checkout's branches. */
async function repoSlug(repoRoot: string): Promise<string> {
  return (await sh("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot)).trim();
}

export async function listImprovePrs(repoRoot: string): Promise<ImprovePr[]> {
  const out = await sh("gh", ["pr", "list", "-R", await repoSlug(repoRoot), "--state", "open", "--limit", "20", "--json", "number,url,title,headRefName"], repoRoot);
  return (JSON.parse(out) as Array<{ number: number; url: string; title: string; headRefName: string }>)
    .filter(p => p.headRefName.startsWith("improve/"))
    .map(p => ({ number: p.number, url: p.url, title: p.title, branch: p.headRefName }));
}

export async function improvePrState(repoRoot: string, n: number): Promise<{ state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null }> {
  const j = JSON.parse(await sh("gh", ["pr", "view", String(n), "-R", await repoSlug(repoRoot), "--json", "state,mergedAt"], repoRoot)) as { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null };
  return { state: j.state, mergedAt: j.mergedAt || null };
}

export async function improvePrAction(repoRoot: string, n: number, action: "merge" | "close"): Promise<void> {
  const repo = await repoSlug(repoRoot);
  if (action === "merge") await sh("gh", ["pr", "merge", String(n), "-R", repo, "--squash", "--delete-branch"], repoRoot);
  else await sh("gh", ["pr", "close", String(n), "-R", repo, "--delete-branch"], repoRoot);
}
