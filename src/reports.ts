/**
 * Reports (ORCHESTRATOR_REDESIGN.md §10): a daily progress draft and a weekly roadmap,
 * both built straight from Linear. Deterministic — no LLM calls.
 *
 * - `fetchDailyActivity` + `formatDailyDraft` → Silas's Slack update (Done / Working on / Waiting on).
 * - `fetchRoadmap` + `formatWeeklyRoadmap` → one line per project plus "Suggested next".
 * - `ReportScheduler` → runs each job at most once per local day / ISO week, after its hour.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

// ─── Shared types ────────────────────────────────────────────────────────────

export interface ReportIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  /** Assignee display name, or null when unassigned. */
  assignee: string | null;
  /** Project name, or null when the issue has no project. */
  project: string | null;
  stateName: string;
  /** Linear workflow state type: triage | backlog | unstarted | started | completed | canceled. */
  stateType: string;
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  labels: string[];
  createdAt: string;
}

export interface WaitingIssue extends ReportIssue {
  /** Who the issue is waiting on, from `waiting-on:<person>` labels. */
  waitingOn: string[];
  /** Optional reason, from `waiting-on:<person>:<reason>` labels. */
  reason?: string;
}

export interface DailyActivity {
  since: string;
  done: ReportIssue[];
  inReview: ReportIssue[];
  inProgress: ReportIssue[];
  waiting: WaitingIssue[];
}

// ─── Raw GraphQL node shapes ─────────────────────────────────────────────────

export interface RawLabel {
  name: string;
  parent?: { name: string } | null;
}

export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority?: number | null;
  createdAt: string;
  updatedAt?: string | null;
  completedAt?: string | null;
  state?: { name: string; type: string } | null;
  assignee?: { name: string; displayName?: string | null } | null;
  project?: { id: string; name?: string | null } | null;
  labels?: { nodes: RawLabel[] } | null;
  attachments?: { nodes: Array<{ sourceType?: string | null; metadata?: Record<string, unknown> | null }> } | null;
}

interface IssuesPage {
  issues: {
    nodes: RawIssue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const PAGE_SIZE = 50;

async function fetchAllIssues(
  tracker: TrackerConfig,
  query: string,
  filter: Record<string, unknown>,
  maxPages: number,
): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const vars: Record<string, unknown> = { filter, first: PAGE_SIZE };
    if (after) vars.after = after;
    const data = (await linear.executeGraphQL(tracker, query, vars)) as IssuesPage;
    out.push(...(data.issues?.nodes ?? []));
    const info = data.issues?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return out;
}

function personName(p: RawIssue["assignee"]): string | null {
  if (!p) return null;
  return p.displayName || p.name || null;
}

function toReportIssue(raw: RawIssue): ReportIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    assignee: personName(raw.assignee),
    project: raw.project?.name ?? null,
    stateName: raw.state?.name ?? "",
    stateType: raw.state?.type ?? "",
    priority: raw.priority ?? 0,
    labels: (raw.labels?.nodes ?? []).map(l => l.name),
    createdAt: raw.createdAt,
  };
}

// ─── Daily activity ──────────────────────────────────────────────────────────

const WAITING_PREFIX = "waiting-on";
const IN_PROGRESS_STATES = new Set(["dev in progress", "human dev", "design in progress"]);
const READY_TO_DEPLOY = "ready to deploy";
const IN_REVIEW = "in review";

const DAILY_ACTIVITY_QUERY = `
  query DailyActivity($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id identifier title url priority createdAt updatedAt completedAt
        state { name type }
        assignee { name displayName }
        project { id name }
        labels(first: 20) { nodes { name parent { name } } }
        attachments(first: 10) { nodes { sourceType metadata } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Parses waiting-on labels. Supports flat labels (`waiting-on:Nika`, `waiting-on:Nika:visual check`)
 * and grouped labels (group `waiting-on`, child `Nika`).
 */
export function parseWaitingLabels(labels: RawLabel[]): { who: string[]; reason?: string } {
  const who: string[] = [];
  let reason: string | undefined;
  for (const l of labels) {
    if (l.parent?.name?.toLowerCase() === WAITING_PREFIX) {
      who.push(l.name.trim());
      continue;
    }
    const lower = l.name.toLowerCase();
    if (!lower.startsWith(`${WAITING_PREFIX}:`)) continue;
    const [person, ...rest] = l.name.slice(WAITING_PREFIX.length + 1).split(":");
    if (person?.trim()) who.push(person.trim());
    if (!reason && rest.length && rest.join(":").trim()) reason = rest.join(":").trim();
  }
  return reason ? { who, reason } : { who };
}

function hasMergedPr(raw: RawIssue): boolean {
  return (raw.attachments?.nodes ?? []).some(a => {
    const m = a.metadata ?? {};
    const status = String(m.status ?? m.state ?? "").toLowerCase();
    return status === "merged" || Boolean(m.mergedAt);
  });
}

function atOrAfter(iso: string | null | undefined, sinceMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs;
}

/** Pure grouping step, exported for tests. */
export function groupDailyActivity(nodes: RawIssue[], sinceIso: string): DailyActivity {
  const sinceMs = Date.parse(sinceIso);
  const result: DailyActivity = { since: sinceIso, done: [], inReview: [], inProgress: [], waiting: [] };
  const seen = new Set<string>();

  for (const raw of nodes) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);

    const issue = toReportIssue(raw);
    const stateName = issue.stateName.toLowerCase();
    const type = issue.stateType;
    const touchedSince = atOrAfter(raw.updatedAt, sinceMs);

    const isDone =
      (type === "completed" && atOrAfter(raw.completedAt ?? raw.updatedAt, sinceMs)) ||
      (stateName === READY_TO_DEPLOY && touchedSince) ||
      (stateName === IN_REVIEW && touchedSince && hasMergedPr(raw));
    if (isDone) {
      result.done.push(issue);
      continue;
    }
    if (type === "completed" || type === "canceled") continue;

    const waiting = parseWaitingLabels(raw.labels?.nodes ?? []);
    if (waiting.who.length > 0) {
      result.waiting.push({ ...issue, waitingOn: waiting.who, ...(waiting.reason ? { reason: waiting.reason } : {}) });
      continue;
    }
    if (stateName === IN_REVIEW) {
      result.inReview.push(issue);
      continue;
    }
    if (IN_PROGRESS_STATES.has(stateName)) result.inProgress.push(issue);
  }
  return result;
}

/**
 * Issues for the team that were updated since `sinceIso`, plus anything currently started or
 * waiting on someone (those may not have been touched today but still belong in the update).
 */
export async function fetchDailyActivity(
  tracker: TrackerConfig,
  teamKey: string,
  sinceIso: string,
): Promise<DailyActivity> {
  const filter = {
    team: { key: { eq: teamKey } },
    or: [
      { updatedAt: { gte: sinceIso } },
      { state: { type: { eq: "started" } } },
      { labels: { some: { name: { startsWithIgnoreCase: `${WAITING_PREFIX}:` } } } },
      { labels: { some: { parent: { name: { eqIgnoreCase: WAITING_PREFIX } } } } },
    ],
  };
  const nodes = await fetchAllIssues(tracker, DAILY_ACTIVITY_QUERY, filter, 10);
  return groupDailyActivity(nodes, sinceIso);
}

// ─── Daily draft formatting ──────────────────────────────────────────────────

const MAX_BULLETS = 6;
const SHORT_TITLE = 60;

export function shortTitle(title: string, max = SHORT_TITLE): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Slack mrkdwn link text can't contain `|`, `<` or `>`. */
function linkText(s: string): string {
  return s.replace(/[|<>]/g, " ").replace(/\s+/g, " ").trim();
}

function issueLink(i: Pick<ReportIssue, "identifier" | "title" | "url">): string {
  return `${i.identifier} <${i.url}|${linkText(shortTitle(i.title))}>`;
}

function section(heading: string, bullets: string[]): string | null {
  if (bullets.length === 0) return null;
  const shown = bullets.slice(0, MAX_BULLETS).map(b => `• ${b}`);
  const extra = bullets.length - MAX_BULLETS;
  if (extra > 0) shown.push(`+${extra} more`);
  return [`*${heading}:*`, ...shown].join("\n");
}

export const QUIET_DAY = "Quiet day — nothing shipped.";

export function formatDailyDraft(
  activity: DailyActivity,
  opts: { openGates: number; governorNote?: string },
): string {
  const working = [
    ...activity.inProgress.map(issueLink),
    ...activity.inReview.map(i => `${issueLink(i)} (in review)`),
  ];
  const waiting = activity.waiting.map(i => {
    const who = i.waitingOn.join(", ");
    return `${issueLink(i)} — ${who}${i.reason ? ` (${i.reason})` : ""}`;
  });

  const parts = [
    section("Done", activity.done.map(issueLink)),
    section("Working on", working),
    section("Waiting on", waiting),
  ].filter((p): p is string => p !== null);

  if (parts.length === 0) return QUIET_DAY;

  const footer: string[] = [];
  if (opts.openGates > 0) footer.push(`_${opts.openGates} ${opts.openGates === 1 ? "gate" : "gates"} open._`);
  if (opts.governorNote?.trim()) footer.push(`_${opts.governorNote.trim()}_`);
  if (footer.length) parts.push(footer.join("\n"));

  return parts.join("\n\n");
}

// ─── Roadmap ─────────────────────────────────────────────────────────────────

export interface StateTypeCounts {
  completed: number;
  started: number;
  unstarted: number;
  backlog: number;
  canceled: number;
}

export interface RoadmapProject {
  id: string;
  name: string;
  url: string;
  /** Project status type: "started" or "planned". */
  state: string;
  /** Linear's `progress` (0–1). */
  progress: number;
  /** `YYYY-MM-DD`, or null. */
  targetDate: string | null;
  lead: string | null;
  counts: StateTypeCounts;
  /** Open issues that are blocked (state/label "Blocked") or waiting on someone. */
  blocked: number;
  /** Top 3 not-started issues: priority, then ux-insights/Bug labels, then oldest. */
  topNext: ReportIssue[];
}

export interface Roadmap {
  teamKey: string;
  projects: RoadmapProject[];
}

export interface RawProject {
  id: string;
  name: string;
  url: string;
  progress?: number | null;
  targetDate?: string | null;
  status?: { name: string; type: string } | null;
  lead?: { name: string; displayName?: string | null } | null;
}

interface TeamProjectsPage {
  team: {
    projects: {
      nodes: RawProject[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

const TEAM_PROJECTS_QUERY = `
  query RoadmapProjects($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      projects(first: $first, after: $after) {
        nodes {
          id name url progress targetDate
          status { name type }
          lead { name displayName }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ROADMAP_ISSUES_QUERY = `
  query RoadmapIssues($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id identifier title url priority createdAt
        state { name type }
        assignee { name displayName }
        project { id name }
        labels(first: 20) { nodes { name parent { name } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ACTIVE_PROJECT_TYPES = new Set(["started", "planned"]);
const PREFERRED_LABELS = new Set(["ux-insights", "bug"]);

/** Priority rank: urgent(1) first … low(4), "no priority"(0) last. */
function priorityRank(p: number): number {
  return p >= 1 && p <= 4 ? p : 5;
}

function hasPreferredLabel(i: ReportIssue): boolean {
  return i.labels.some(l => PREFERRED_LABELS.has(l.toLowerCase()));
}

export function compareNotStarted(a: ReportIssue, b: ReportIssue): number {
  const p = priorityRank(a.priority) - priorityRank(b.priority);
  if (p !== 0) return p;
  const l = Number(hasPreferredLabel(b)) - Number(hasPreferredLabel(a));
  if (l !== 0) return l;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function isBlocked(raw: RawIssue): boolean {
  if (/blocked/i.test(raw.state?.name ?? "")) return true;
  const labels = raw.labels?.nodes ?? [];
  if (labels.some(l => l.name.toLowerCase() === "blocked")) return true;
  return parseWaitingLabels(labels).who.length > 0;
}

/** Pure assembly step, exported for tests. */
export function buildRoadmap(teamKey: string, projects: RawProject[], issues: RawIssue[]): Roadmap {
  const byProject = new Map<string, RawIssue[]>();
  for (const i of issues) {
    const pid = i.project?.id;
    if (!pid) continue;
    const list = byProject.get(pid) ?? [];
    list.push(i);
    byProject.set(pid, list);
  }

  const out: RoadmapProject[] = projects
    .filter(p => ACTIVE_PROJECT_TYPES.has(p.status?.type ?? ""))
    .map(p => {
      const list = byProject.get(p.id) ?? [];
      const counts: StateTypeCounts = { completed: 0, started: 0, unstarted: 0, backlog: 0, canceled: 0 };
      let blocked = 0;
      for (const raw of list) {
        const t = raw.state?.type ?? "";
        if (t === "triage") counts.backlog++;
        else if (t in counts) counts[t as keyof StateTypeCounts]++;
        if (t !== "completed" && t !== "canceled" && isBlocked(raw)) blocked++;
      }
      const topNext = list
        .filter(raw => ["unstarted", "backlog", "triage"].includes(raw.state?.type ?? ""))
        .map(raw => ({ ...toReportIssue(raw), project: p.name }))
        .sort(compareNotStarted)
        .slice(0, 3);
      return {
        id: p.id,
        name: p.name,
        url: p.url,
        state: p.status?.type ?? "",
        progress: p.progress ?? 0,
        targetDate: p.targetDate ?? null,
        lead: p.lead ? p.lead.displayName || p.lead.name : null,
        counts,
        blocked,
        topNext,
      };
    });

  // Started before planned; within each, closest to done first.
  out.sort((a, b) => {
    if (a.state !== b.state) return a.state === "started" ? -1 : 1;
    return b.progress - a.progress;
  });
  return { teamKey, projects: out };
}

export async function fetchRoadmap(tracker: TrackerConfig, teamKey: string): Promise<Roadmap> {
  const team = await linear.fetchTeamByKey(tracker, teamKey);
  if (!team) throw new Error(`Linear team not found: ${teamKey}`);

  const projects: RawProject[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const vars: Record<string, unknown> = { teamId: team.id, first: PAGE_SIZE };
    if (after) vars.after = after;
    const data = (await linear.executeGraphQL(tracker, TEAM_PROJECTS_QUERY, vars)) as TeamProjectsPage;
    const conn = data.team?.projects;
    projects.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  const active = projects.filter(p => ACTIVE_PROJECT_TYPES.has(p.status?.type ?? ""));
  if (active.length === 0) return { teamKey, projects: [] };

  const issues = await fetchAllIssues(
    tracker,
    ROADMAP_ISSUES_QUERY,
    { project: { id: { in: active.map(p => p.id) } } },
    20,
  );
  return buildRoadmap(teamKey, active, issues);
}

// ─── Weekly roadmap formatting ───────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_WIDTH = 6;

export function progressBar(progress: number): string {
  const p = Math.min(1, Math.max(0, progress));
  const filled = Math.round(p * BAR_WIDTH);
  return "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

/** `2026-12-12` → `12 Dec`. Returns the input unchanged when it isn't a plain date. */
export function formatTargetDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : date;
}

function pct(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

export function formatProjectLine(p: RoadmapProject): string {
  const target = p.targetDate ? ` (target ${formatTargetDate(p.targetDate)})` : "";
  const planned = p.state === "planned" ? " [planned]" : "";
  const bits = [`${progressBar(p.progress)} ${pct(p.progress)}% — <${p.url}|${linkText(p.name)}>${target}${planned}`];
  if (p.counts.started > 0) bits.push(`${p.counts.started} in progress`);
  if (p.blocked > 0) bits.push(`${p.blocked} blocked`);
  return bits.join(" · ");
}

export interface Suggestion {
  issue: ReportIssue;
  project: RoadmapProject;
  reason: string;
  score: number;
}

/**
 * Ranks the not-started issues of in-progress projects. Higher priority, customer/UX/bug
 * signals and projects close to done score higher. Max 2 per project so one project
 * doesn't take the whole list.
 */
export function suggestNext(roadmap: Roadmap, limit = 5): Suggestion[] {
  const candidates: Suggestion[] = [];
  for (const project of roadmap.projects) {
    if (project.state !== "started") continue;
    for (const issue of project.topNext) {
      const clauses: Array<{ score: number; reason: string }> = [];
      const prio = priorityRank(issue.priority);
      if (prio === 1) clauses.push({ score: 100, reason: "urgent" });
      else if (prio === 2) clauses.push({ score: 50, reason: "high priority" });
      else if (prio === 3) clauses.push({ score: 20, reason: "medium priority" });
      else if (prio === 4) clauses.push({ score: 5, reason: "low priority" });

      const labels = issue.labels.map(l => l.toLowerCase());
      if (labels.some(l => l.includes("customer"))) clauses.push({ score: 45, reason: "customer-reported" });
      if (labels.includes("ux-insights")) clauses.push({ score: 40, reason: "from UX insights" });
      if (labels.includes("bug")) clauses.push({ score: 30, reason: "bug" });

      if (project.progress >= 0.6) {
        clauses.push({
          score: Math.round(project.progress * 60),
          reason: `helps finish ${project.name} (${pct(project.progress)}% done)`,
        });
      }

      const score = clauses.reduce((s, c) => s + c.score, 0);
      const top = clauses.slice().sort((a, b) => b.score - a.score)[0];
      candidates.push({ issue, project, score, reason: top?.reason ?? `next in ${project.name}` });
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score || Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt),
  );

  const perProject = new Map<string, number>();
  const picked: Suggestion[] = [];
  for (const c of candidates) {
    const n = perProject.get(c.project.id) ?? 0;
    if (n >= 2) continue;
    perProject.set(c.project.id, n + 1);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function formatWeeklyRoadmap(
  roadmap: Roadmap,
  extras: { shippedThisWeek: number; errorTicketsOpen?: number },
): string {
  const lines: string[] = ["*Weekly roadmap*"];
  const stats = [`Shipped this week: ${extras.shippedThisWeek}`];
  if (extras.errorTicketsOpen !== undefined) stats.push(`open error tickets: ${extras.errorTicketsOpen}`);
  lines.push(stats.join(" · "));
  lines.push("");

  if (roadmap.projects.length === 0) {
    lines.push("No active projects.");
  } else {
    for (const p of roadmap.projects) lines.push(formatProjectLine(p));
  }

  const suggestions = suggestNext(roadmap);
  if (suggestions.length > 0) {
    lines.push("", "*Suggested next:*");
    for (const s of suggestions) lines.push(`• ${issueLink(s.issue)} — ${s.reason}`);
  }
  return lines.join("\n");
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface ReportSchedulerOptions {
  /** Local hour (0–23) after which the daily draft runs. Default 16. */
  dailyHourLocal?: number;
  /** Day of week for the weekly roadmap (0 = Sunday … 6 = Saturday). Default 1 (Monday). */
  weeklyDay?: number;
  /** Local hour (0–23) after which the weekly roadmap runs. Default 9. */
  weeklyHourLocal?: number;
  /** JSON file holding the last-run markers. */
  statePath: string;
  now?: () => Date;
  runDaily: () => Promise<void>;
  runWeekly: () => Promise<void>;
  log: Logger;
}

interface SchedulerState {
  /** Local date `YYYY-MM-DD` of the last daily run. */
  lastDaily?: string;
  /** ISO week `YYYY-Www` of the last weekly run. */
  lastWeekly?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO-8601 week key (`2026-W45`) for the local calendar date of `d`. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ReportScheduler {
  private readonly dailyHour: number;
  private readonly weeklyDay: number;
  private readonly weeklyHour: number;
  private readonly now: () => Date;
  private state: SchedulerState | null = null;

  constructor(private readonly opts: ReportSchedulerOptions) {
    this.dailyHour = opts.dailyHourLocal ?? 16;
    this.weeklyDay = opts.weeklyDay ?? 1;
    this.weeklyHour = opts.weeklyHourLocal ?? 9;
    this.now = opts.now ?? (() => new Date());
  }

  /** Called every poll tick. Never throws. */
  async reconcile(): Promise<void> {
    const now = this.now();
    const state = this.loadState();

    const day = now.getDay();
    const today = localDateKey(now);
    const dueDaily =
      day !== 0 && day !== 6 && now.getHours() >= this.dailyHour && state.lastDaily !== today;

    const week = isoWeekKey(now);
    const dueWeekly =
      day === this.weeklyDay && now.getHours() >= this.weeklyHour && state.lastWeekly !== week;

    // Mark before running (at most once per period, even if the job fails), and before
    // awaiting so an overlapping tick can't start the same job twice.
    if (dueDaily) state.lastDaily = today;
    if (dueWeekly) state.lastWeekly = week;
    if (dueDaily || dueWeekly) this.saveState(state);

    if (dueWeekly) await this.runJob("weekly roadmap", this.opts.runWeekly);
    if (dueDaily) await this.runJob("daily draft", this.opts.runDaily);
  }

  private async runJob(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      this.opts.log.info(`Report: running ${name}`);
      await fn();
    } catch (e) {
      this.opts.log.error(`Report: ${name} failed: ${errMsg(e)}`);
    }
  }

  private loadState(): SchedulerState {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, "utf8")) as unknown;
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      this.state = {
        ...(typeof obj.lastDaily === "string" ? { lastDaily: obj.lastDaily } : {}),
        ...(typeof obj.lastWeekly === "string" ? { lastWeekly: obj.lastWeekly } : {}),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.opts.log.warn(`Report: could not read ${this.opts.statePath}: ${errMsg(e)}`);
      }
      this.state = {};
    }
    return this.state;
  }

  private saveState(state: SchedulerState): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      fs.writeFileSync(this.opts.statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (e) {
      this.opts.log.warn(`Report: could not write ${this.opts.statePath}: ${errMsg(e)}`);
    }
  }
}
