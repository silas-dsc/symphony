import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import { Liquid } from "liquidjs";
import type { Lesson } from "./lessons.js";
import { claudeEffortArgs, claudeModelArgs } from "./llm.js";
import type { RunRecord } from "./run-log.js";
import type { GateInput, Logger } from "./types.js";
import { trackTokenProcess } from "./usage-budget.js";

/**
 * Symphony's self-improvement loop (v2.improve).
 *
 * 1. Retros: every few minutes, find tickets Symphony ran that are now Done and
 *    have no lesson yet, and run the retrospective. This replaces the old trigger,
 *    which only fired while the orchestrator still tracked the ticket — in v2 it
 *    stops tracking at In Review, so retros had silently stopped.
 * 2. Detectors (no tokens): read the run log for retry loops, costly tickets and
 *    broad failure spikes. A looping ticket gets the hold label (no more
 *    dispatches) and a Resume card; removing the label in Linear also resumes it.
 * 3. Daily pass: once a day, an agent reads the day's lessons, metrics and
 *    detector findings, edits Symphony's prompts/workflow in a throwaway
 *    worktree (one commit per change), and Symphony opens a PR with a Merge card.
 *    Problems in team-dsc code become Linear tickets.
 * 4. Outcomes: each merged change is scored on the run log a few days later
 *    (failure rate, cost per ticket, rework) and the result feeds the next pass,
 *    which can revert a change that made things worse.
 *
 * Prompt changes never merge without the operator clicking Merge.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface ImproveConfig {
  retroPollMs: number;
  retroLookbackDays: number;
  retrosPerPoll: number;
  triggerStates: string[];
  detectEveryMs: number;
  loopFailures: number;
  loopWindowHours: number;
  ticketCostAlertUsd: number;
  dailyHourLocal: number;
  maxChanges: number;
  maxTickets: number;
  /** Linear label that stops dispatch. Remove it (or click Resume) to let Symphony retry. */
  holdLabel: string;
  statePath: string;
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

export interface PassInput {
  date: string;
  lessonsRecent: Lesson[];
  lessonsWindow: Lesson[];
  metrics: string;
  findings: string;
  outcomes: string;
  maxChanges: number;
  maxTickets: number;
}

export interface PassChange { title: string; file: string; why: string; evidence: string[]; expect: string }
export interface PassTicket { title: string; description: string; evidence: string[] }

export interface PassResult {
  /** Branch holding the agent's commits, or null when it made none. */
  branch: string | null;
  /** Files changed against origin/main. */
  files: string[];
  changes: PassChange[];
  tickets: PassTicket[];
  /** Problems in Symphony's own code (the agent may not edit .ts) — listed on the card. */
  engineering: string[];
  skipped: string[];
  cleanup(): Promise<void>;
}

export interface ImproveDeps {
  readRuns(): RunRecord[];
  readLessons(): Lesson[];
  ticket(identifier: string): Promise<TicketInfo | null>;
  retro(t: TicketInfo, runHistory: string): Promise<void>;
  openGate(input: GateInput): Promise<void>;
  dm(text: string): Promise<void>;
  addLabel(issueId: string, name: string): Promise<void>;
  removeLabel(issueId: string, name: string): Promise<void>;
  runPass(input: PassInput): Promise<PassResult | null>;
  openPr(branch: string, title: string, body: string): Promise<{ number: number; url: string }>;
  prState(n: number): Promise<{ state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null }>;
  mergePr(n: number): Promise<void>;
  closePr(n: number): Promise<void>;
  createTicket(title: string, description: string): Promise<{ identifier: string; url: string | null } | null>;
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
  expect: string[];
  verdict: Verdict | null;
  after: Metrics | null;
}

interface Hold { ticket: string; issueId: string; since: string; reason: string }

interface State {
  retroDone: Record<string, string>;
  retroChecked: Record<string, string>;
  holds: Record<string, Hold>;
  /** Ticket → time it was resumed; detectors ignore failures before it. */
  resumed: Record<string, string>;
  alerts: Record<string, { at: string; text: string }>;
  lastPassDay: string | null;
  changes: Change[];
  ticketsFiled: string[];
}

const emptyState = (): State => ({
  retroDone: {}, retroChecked: {}, holds: {}, resumed: {}, alerts: {}, lastPassDay: null, changes: [], ticketsFiled: [],
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

/** Rough before/after call. Confounded by ticket mix, so the pass treats it as a hint. */
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

/** Files the daily pass may change. Anything else voids the pass. */
export function allowedFile(f: string): boolean {
  return f === "WORKFLOW.md" || f === "docs/AGENT_MEMORY.md" || /^prompts\/[^/]+\.md$/.test(f);
}

export function parsePassResult(text: string): Omit<PassResult, "branch" | "files" | "cleanup"> | null {
  const m = text.match(/```improve-result\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]) as Partial<Record<"changes" | "tickets" | "engineering" | "skipped", unknown>>;
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      changes: arr<PassChange>(j.changes).filter(c => c && typeof c.title === "string"),
      tickets: arr<PassTicket>(j.tickets).filter(t => t && typeof t.title === "string" && typeof t.description === "string"),
      engineering: arr<string>(j.engineering).filter(s => typeof s === "string"),
      skipped: arr<string>(j.skipped).filter(s => typeof s === "string"),
    };
  } catch {
    return null;
  }
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── the loop ────────────────────────────────────────────────────────────────

export class ImprovementLoop {
  private state: State;
  private lastRetroPoll = 0;
  private lastDetect = 0;
  private retroBusy = false;
  private passBusy = false;

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

  /** Called every tick. Detectors run inline; retros and the daily pass run in the background. */
  async reconcile(): Promise<void> {
    const now = this.deps.now();
    if (now - this.lastDetect >= this.cfg.detectEveryMs) {
      this.lastDetect = now;
      try {
        await this.runDetectors(now);
      } catch (e) {
        this.log.warn("Improvement detectors failed", { error: errMsg(e) });
      }
    }
    const jobs: Promise<void>[] = [];
    if (!this.retroBusy && now - this.lastRetroPoll >= this.cfg.retroPollMs && !this.deps.paused()) {
      this.lastRetroPoll = now;
      this.retroBusy = true;
      jobs.push(this.runRetros(now).catch(e => this.log.warn("Retro poll failed", { error: errMsg(e) })).finally(() => { this.retroBusy = false; }));
    }
    if (!this.passBusy && this.passDue(now)) {
      this.passBusy = true;
      jobs.push(this.runDaily(now).catch(e => this.log.warn("Daily improvement pass failed", { error: errMsg(e) })).finally(() => { this.passBusy = false; }));
    }
    await Promise.all(jobs);
  }

  // ── retros ──

  private async runRetros(now: number): Promise<void> {
    const runs = this.deps.readRuns();
    const withLesson = new Set(this.deps.readLessons().map(l => l.ticket).filter((t): t is string => !!t));
    const since = now - this.cfg.retroLookbackDays * DAY;
    const tickets = [...new Set(runs.filter(r => Date.parse(r.at) >= since).map(r => r.issue))]
      .filter(t => !this.state.retroDone[t] && !withLesson.has(t))
      .sort((a, b) => (this.state.retroChecked[a] ?? "").localeCompare(this.state.retroChecked[b] ?? ""))
      .slice(0, 10);
    const trigger = this.cfg.triggerStates.map(s => s.toLowerCase());
    let ran = 0;
    for (const id of tickets) {
      if (ran >= this.cfg.retrosPerPoll || this.deps.paused()) break;
      this.state.retroChecked[id] = new Date(now).toISOString();
      const t = await this.deps.ticket(id).catch(() => null);
      if (!t || !trigger.includes(t.state.toLowerCase())) continue;
      this.log.info("Running retrospective", { issue_identifier: id, state: t.state });
      await this.deps.retro(t, runHistory(runs, id)).catch(e => this.log.warn("Retrospective failed", { issue_identifier: id, error: errMsg(e) }));
      this.state.retroDone[id] = new Date(this.deps.now()).toISOString();
      ran++;
    }
    // Forget tickets that fell out of the lookback window.
    for (const map of [this.state.retroDone, this.state.retroChecked]) {
      for (const [k, v] of Object.entries(map)) if (Date.parse(v) < since - DAY) delete map[k];
    }
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

  // ── daily pass ──

  private passDue(now: number): boolean {
    return this.state.lastPassDay !== localDay(now) && new Date(now).getHours() >= this.cfg.dailyHourLocal && !this.deps.paused();
  }

  private async runDaily(now: number): Promise<void> {
    const day = localDay(now);
    this.state.lastPassDay = day; // once a day, even if it fails
    this.persist();
    const runs = this.deps.readRuns();
    const outcomes = await this.updateOutcomes(now, runs);
    const lessons = this.deps.readLessons();
    const at = (l: Lesson) => (l.completed_at ? Date.parse(l.completed_at) : NaN);
    const recent = lessons.filter(l => at(l) >= now - DAY);
    const window = lessons.filter(l => at(l) >= now - 14 * DAY);
    const findings = Object.values(this.state.alerts).filter(a => Date.parse(a.at) >= now - DAY).map(a => `- ${a.text}`);
    const m1 = metricsFor(runs, now - DAY, now);
    if (recent.length === 0 && findings.length === 0 && m1.runs === 0 && outcomes.fresh.length === 0) {
      this.log.info("Daily improvement pass: nothing new today");
      return;
    }
    const m7 = metricsFor(runs, now - 7 * DAY, now);
    const open = this.state.changes.filter(c => !c.closed && !c.mergedAt).map(c => `- PR #${c.pr} (open): ${c.title}`);
    this.log.info("Daily improvement pass starting", { lessons_today: recent.length, findings: findings.length });
    const result = await this.deps.runPass({
      date: day,
      lessonsRecent: recent,
      lessonsWindow: window,
      metrics: `Last 24h: ${formatMetrics(m1)}\nLast 7d: ${formatMetrics(m7)}`,
      findings: findings.join("\n"),
      outcomes: [...outcomes.lines, ...open].join("\n"),
      maxChanges: this.cfg.maxChanges,
      maxTickets: this.cfg.maxTickets,
    });
    if (!result) {
      await this.deps.dm("🛠️ Today's improvement pass didn't finish (no result block). Nothing changed.");
      return;
    }
    try {
      await this.applyPass(day, result, m7);
    } finally {
      await result.cleanup().catch(() => undefined);
    }
  }

  private async applyPass(day: string, r: PassResult, baseline: Metrics): Promise<void> {
    const bad = r.files.filter(f => !allowedFile(f));
    if (bad.length) {
      await this.deps.dm(`🛠️ Today's improvement pass edited files it may not touch (${bad.join(", ")}), so Symphony dropped it.`);
      return;
    }
    const filed: string[] = [];
    for (const t of r.tickets.slice(0, this.cfg.maxTickets)) {
      if (this.state.ticketsFiled.includes(t.title)) continue;
      const desc = `${t.description}\n\nEvidence: ${t.evidence.join(", ") || "run log"}\n\n_Filed by Symphony's daily improvement pass (${day})._`;
      const made = await this.deps.createTicket(t.title, desc).catch(e => { this.log.warn("Improvement ticket failed", { error: errMsg(e) }); return null; });
      if (made) { filed.push(`${made.identifier} ${t.title}`); this.state.ticketsFiled.push(t.title); }
    }
    this.state.ticketsFiled = this.state.ticketsFiled.slice(-100);
    this.persist();

    if (r.branch && r.files.length > 0 && r.changes.length > 0) {
      const body = [
        `Daily improvement pass, ${day}. Each commit is one change.`, "",
        ...r.changes.map(c => `### ${c.title}\n- File: \`${c.file}\`\n- Why: ${c.why}\n- Evidence: ${c.evidence.join(", ") || "run log"}\n- Expect: ${c.expect}`), "",
        ...(r.engineering.length ? ["### Needs a code change (not done here)", ...r.engineering.map(e => `- ${e}`), ""] : []),
        ...(filed.length ? ["### Tickets filed", ...filed.map(f => `- ${f}`), ""] : []),
        ...(r.skipped.length ? ["### Seen but not acted on", ...r.skipped.map(s => `- ${s}`), ""] : []),
        "Merging puts these edits live on the next self-update. Symphony scores the change against the run log after 2 days.",
      ].join("\n");
      const pr = await this.deps.openPr(r.branch, `Daily improvement ${day}: ${r.changes.map(c => c.title).join("; ")}`.slice(0, 120), body);
      this.state.changes.push({
        pr: pr.number, url: pr.url, title: r.changes.map(c => c.title).join("; "), openedAt: new Date(this.deps.now()).toISOString(),
        mergedAt: null, closed: false, baseline, expect: r.changes.map(c => c.expect), verdict: null, after: null,
      });
      this.state.changes = this.state.changes.slice(-50);
      this.persist();
      await this.deps.openGate({
        kind: "process_change",
        title: `Process change: ${r.changes.length} edit${r.changes.length === 1 ? "" : "s"} from today's lessons`,
        summary: [
          ...r.changes.map(c => `• ${c.title} (${c.file}) — ${c.why}`),
          ...(r.engineering.length ? [`Needs code: ${r.engineering.join("; ")}`] : []),
          ...(filed.length ? [`Filed: ${filed.join("; ")}`] : []),
        ].join("\n").slice(0, 2900),
        question: "Merge these prompt/workflow changes?",
        links: [{ label: `PR #${pr.number}`, url: pr.url }],
        meta: { prNumber: String(pr.number), prUrl: pr.url },
      });
      return;
    }
    if (filed.length || r.engineering.length) {
      await this.deps.dm([
        "🛠️ Today's improvement pass: no prompt changes.",
        ...(filed.length ? [`Filed: ${filed.join("; ")}`] : []),
        ...(r.engineering.length ? [`Needs a Symphony code change: ${r.engineering.join("; ")}`] : []),
      ].join("\n"));
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

  private async updateOutcomes(now: number, runs: RunRecord[]): Promise<{ lines: string[]; fresh: string[] }> {
    const fresh: string[] = [];
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
      fresh.push(`PR #${c.pr}`);
      if (c.verdict === "worse") {
        await this.deps.dm(`⚠️ Process change PR #${c.pr} (${c.title}) looks worse since it merged: ${formatMetrics(c.baseline)} → ${formatMetrics(after)}. Today's improvement pass will consider reverting it. ${c.url}`);
      }
    }
    this.persist();
    const lines = this.state.changes
      .filter(c => c.verdict && c.mergedAt && Date.parse(c.mergedAt) >= now - 21 * DAY)
      .map(c => `- PR #${c.pr} "${c.title}" merged ${c.mergedAt!.slice(0, 10)}: ${c.verdict}. Before: ${formatMetrics(c.baseline)}. After: ${c.after ? formatMetrics(c.after) : "n/a"}. Expected: ${c.expect.join("; ")}`);
    return { lines, fresh };
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

// ─── real daily-pass runner (git worktree + claude) ──────────────────────────

const execFileP = promisify(execFile);
const liquid = new Liquid({ strictVariables: true, strictFilters: true });

async function sh(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export interface PassRunnerConfig {
  /** The Symphony git checkout (branches are cut from its origin/main). */
  repoRoot: string;
  /** Folder for the throwaway worktree and input files. */
  workDir: string;
  maxTurns: number;
  timeoutMs: number;
}

/** Runs the daily pass agent in a fresh worktree of origin/main and reports what it committed. */
export function localPassRunner(cfg: PassRunnerConfig, log: Logger): (input: PassInput) => Promise<PassResult | null> {
  return async input => {
    const ws = path.join(cfg.workDir, "worktree");
    const inputs = path.join(cfg.workDir, "inputs");
    const branch = `improve/${input.date}`;
    fs.mkdirSync(inputs, { recursive: true });
    await sh("git", ["worktree", "remove", "--force", ws], cfg.repoRoot).catch(() => undefined);
    fs.rmSync(ws, { recursive: true, force: true });
    await sh("git", ["worktree", "prune"], cfg.repoRoot).catch(() => undefined);
    await sh("git", ["fetch", "origin", "main"], cfg.repoRoot);
    await sh("git", ["worktree", "add", "-B", branch, ws, "origin/main"], cfg.repoRoot);
    const cleanup = async () => {
      await sh("git", ["worktree", "remove", "--force", ws], cfg.repoRoot).catch(() => undefined);
      await sh("git", ["branch", "-D", branch], cfg.repoRoot).catch(() => undefined);
    };
    try {
      const recentPath = path.join(inputs, "lessons-24h.jsonl");
      const windowPath = path.join(inputs, "lessons-14d.jsonl");
      fs.writeFileSync(recentPath, input.lessonsRecent.map(l => JSON.stringify(l)).join("\n") + "\n");
      fs.writeFileSync(windowPath, input.lessonsWindow.map(l => JSON.stringify(l)).join("\n") + "\n");
      const template = fs.readFileSync(path.join(ws, "prompts", "DAILY_IMPROVE.md"), "utf8");
      const prompt = liquid.parseAndRenderSync(template, {
        date: input.date,
        lessons_recent_path: recentPath,
        lessons_window_path: windowPath,
        lessons_recent_count: input.lessonsRecent.length,
        lessons_window_count: input.lessonsWindow.length,
        metrics: input.metrics,
        findings: input.findings,
        outcomes: input.outcomes,
        max_changes: input.maxChanges,
        max_tickets: input.maxTickets,
      });
      const text = await runClaudeText(prompt, ws, cfg.maxTurns, cfg.timeoutMs, "improve");
      const parsed = parsePassResult(text);
      if (!parsed) {
        log.warn("Daily improvement pass: no improve-result block");
        await cleanup();
        return null;
      }
      const files = (await sh("git", ["diff", "--name-only", "origin/main", "HEAD"], ws)).split("\n").filter(Boolean);
      return { ...parsed, branch: files.length ? branch : null, files, cleanup };
    } catch (e) {
      await cleanup();
      throw e;
    }
  };
}

/** Push the pass branch (hooks off: the agent could write them) and open the PR. */
export async function openImprovePr(repoRoot: string, workDir: string, branch: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const ws = path.join(workDir, "worktree");
  await sh("git", ["-c", "core.hooksPath=/dev/null", "push", "--force", "origin", `HEAD:refs/heads/${branch}`], ws);
  const url = (await sh("gh", ["pr", "create", "-R", await repoSlug(repoRoot), "--base", "main", "--head", branch, "--title", title, "--body", body], repoRoot)).trim().split("\n").pop() ?? "";
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(n)) throw new Error(`gh pr create gave no PR URL: ${url}`);
  return { number: n, url };
}

/** owner/name of the Symphony repo, so gh never touches the live checkout's branches. */
async function repoSlug(repoRoot: string): Promise<string> {
  return (await sh("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot)).trim();
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

function runClaudeText(prompt: string, cwd: string, maxTurns: number, timeoutMs: number, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
    const proc = spawn("claude", [
      "-p", "--strict-mcp-config", ...claudeModelArgs(), ...claudeEffortArgs(),
      "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
    ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    trackTokenProcess(proc, label);
    proc.stdin.end(prompt);
    let result = "";
    let lastText = "";
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", line => {
      try {
        const ev = JSON.parse(line) as { type?: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
        if (ev.type === "result" && typeof ev.result === "string") result = ev.result;
        if (ev.type === "assistant") {
          const t = (ev.message?.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
          if (t) lastText = t;
        }
      } catch {
        // not JSON
      }
    });
    proc.stderr.on("data", () => { /* drain */ });
    const timer = setTimeout(() => { proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000); }, timeoutMs);
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("close", () => { clearTimeout(timer); rl.close(); resolve(result || lastText); });
  });
}
