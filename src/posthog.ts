import type { Logger, PostHogConfig, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

/**
 * One PostHog error-tracking report (an "issue" in PostHog's error-tracking
 * product — the rows behind `…/project/<id>/inbox/reports`), normalised down to
 * the fields a Linear ticket needs.
 */
export interface PostHogReport {
  /** Stable PostHog issue id (UUID). Used as the dedupe key. */
  id: string;
  name: string;
  description: string | null;
  status: string;
  occurrences: number;
  sessions: number;
  users: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** Deep link back to the report in the PostHog UI. */
  url: string;
}

/** Pulls error-tracking reports from PostHog. Injected so tests don't hit the network. */
export interface PostHogReportsClient {
  listReports(config: PostHogConfig): Promise<PostHogReport[]>;
}

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

export interface PostHogTicketSnapshot {
  /** PostHog issue ids that already have a Linear ticket, in any state. Dedupe. */
  existingKeys: Set<string>;
  /** Count of posthog-labelled tickets currently non-terminal. Caps concurrency. */
  openCount: number;
}

export interface PostHogTicketStore {
  snapshot(): Promise<PostHogTicketSnapshot>;
  createTicket(report: PostHogReport, key: string): Promise<CreatedTicket>;
}

export interface PostHogWatcherOptions {
  config: PostHogConfig;
  tracker: TrackerConfig;
  logger: Logger;
  reportsClient?: PostHogReportsClient;
  ticketStore?: PostHogTicketStore;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/** Stable dedupe fingerprint — the PostHog issue id is already stable across pulls. */
export function reportKey(report: Pick<PostHogReport, "id">): string {
  return report.id;
}

const MARKER_RE = /<!--\s*symphony-posthog:(.+?)\s*-->/;

export function extractReportKey(description: string): string | null {
  const m = description.match(MARKER_RE);
  return m ? m[1] : null;
}

export function buildTicketTitle(report: PostHogReport): string {
  const occ = Math.round(report.occurrences).toLocaleString("en-US");
  return truncate(`[PostHog] ${report.name} — ${occ} occurrences`, 120);
}

export function buildTicketDescription(report: PostHogReport, key: string): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  return [
    `<!-- symphony-posthog:${key} -->`,
    "> Auto-filed by Symphony from a PostHog error-tracking report. Reproduce the exception, fix the root cause, verify, and open a PR.",
    "",
    "## Report",
    `- **Issue:** ${report.name}`,
    `- **Status:** ${report.status}`,
    `- **Occurrences:** ${fmt(report.occurrences)}`,
    `- **Sessions affected:** ${fmt(report.sessions)}`,
    `- **Users affected:** ${fmt(report.users)}`,
    `- **First seen:** ${report.firstSeen ?? "—"}`,
    `- **Last seen:** ${report.lastSeen ?? "—"}`,
    `- **PostHog:** ${report.url}`,
    "",
    "## Details",
    report.description?.trim() ? truncate(report.description, 1500) : "_No description captured on the PostHog issue._",
    "",
    "## Acceptance criteria",
    "- [ ] Reproduce the exception (use the PostHog stack trace and the affected sessions linked above).",
    "- [ ] Fix the root cause — not just the symptom; confirm the same input path no longer throws.",
    "- [ ] Add or extend a test that would have caught this exception.",
    "- [ ] Run the affected package's typecheck, lint, and tests.",
    "- [ ] Open a PR. Resolve the issue in PostHog once the fix is deployed.",
  ].join("\n").trim();
}

/**
 * Pulls PostHog error-tracking reports and files a Linear ticket for the worst
 * un-ticketed ones — in the configured active state so Symphony's normal poll
 * loop dispatches an agent to reproduce, fix, test, and open a PR.
 *
 * Mirrors QueryInsightsWatcher: a `cycleInFlight` guard, an injectable client,
 * marker-based dedupe that survives restarts, an open-ticket cap, and a
 * `runIntervalMs` gate so the pull runs about once a day rather than every tick.
 */
export class PostHogWatcher {
  private readonly cfg: PostHogConfig;
  private readonly tracker: TrackerConfig;
  private readonly log: Logger;
  private readonly reportsClient: PostHogReportsClient;
  private readonly ticketStore: PostHogTicketStore;
  private readonly now: () => number;
  private readonly createdKeys = new Set<string>();
  private cycleInFlight = false;
  private nextRunAt = 0; // 0 → run on first tick after startup.

  constructor(opts: PostHogWatcherOptions) {
    this.cfg = opts.config;
    this.tracker = opts.tracker;
    this.log = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.reportsClient = opts.reportsClient ?? new HttpPostHogReportsClient(opts.logger);
    this.ticketStore =
      opts.ticketStore ?? new LinearTicketStore(opts.config, opts.tracker, opts.logger);
  }

  /** Periodic entry point used by the orchestrator. Gated by `enabled` and the daily interval. */
  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return; // daily gate

    this.cycleInFlight = true;
    try {
      let reports: PostHogReport[];
      try {
        reports = await this.reportsClient.listReports(this.cfg);
      } catch (e) {
        this.log.warn(`PostHog report pull failed: ${fmtErr(e)}`);
        return; // do NOT advance nextRunAt — retry next tick.
      }

      // Only advance the daily clock once the pull itself succeeded.
      this.nextRunAt = this.now() + this.cfg.runIntervalMs;
      await this.fileTickets(reports);
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * One-shot pull → file tickets, bypassing the `enabled` flag and the daily
   * interval gate (but keeping dedupe + the open-ticket cap). Used by the
   * `symphony-posthog` CLI so an operator can pull reports on demand.
   */
  async runOnce(): Promise<CreatedTicket[]> {
    if (this.cycleInFlight) return [];
    this.cycleInFlight = true;
    try {
      const reports = await this.reportsClient.listReports(this.cfg);
      return await this.fileTickets(reports);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async fileTickets(reports: PostHogReport[]): Promise<CreatedTicket[]> {
    const created: CreatedTicket[] = [];

    const eligible = reports
      .filter(r => r.occurrences >= this.cfg.minOccurrences)
      // Worst first, so the limited ticket budget targets the loudest reports.
      .sort((a, b) => b.occurrences - a.occurrences);
    if (eligible.length === 0) {
      this.log.info("PostHog: no reports above the occurrence threshold this run");
      return created;
    }

    let snap: PostHogTicketSnapshot;
    try {
      snap = await this.ticketStore.snapshot();
    } catch (e) {
      this.log.warn(`PostHog ticket snapshot failed, skipping creation this run: ${fmtErr(e)}`);
      return created;
    }

    let openCount = snap.openCount;
    let filed = 0;
    for (const report of eligible) {
      if (openCount >= this.cfg.maxOpenTickets) break;
      if (filed >= this.cfg.maxTicketsPerRun) break;
      const key = reportKey(report);
      if (this.createdKeys.has(key) || snap.existingKeys.has(key)) continue;

      try {
        const ticket = await this.ticketStore.createTicket(report, key);
        this.createdKeys.add(key);
        openCount++;
        filed++;
        created.push(ticket);
        this.log.info("Filed Linear ticket for PostHog report", {
          key,
          issue: ticket.identifier,
          occurrences: Math.round(report.occurrences),
        });
      } catch (e) {
        this.log.warn(`Failed to file PostHog ticket for ${key}: ${fmtErr(e)}`, { key });
      }
    }
    return created;
  }

  getCreatedCount(): number {
    return this.createdKeys.size;
  }
}

// ─── Default PostHog client (query API) ─────────────────────────────────────

/**
 * Lists error-tracking reports via PostHog's query API. The error-tracking
 * inbox has no stable dedicated REST list endpoint, so this uses the same
 * `POST /api/projects/:id/query/` path the UI itself drives, with an
 * `ErrorTrackingQuery`. The request body is intentionally small and lives in
 * one place — adjust `orderBy`/`status`/`dateRange` here (or via config) if a
 * future PostHog schema change rejects it; `symphony-posthog --dry-run` lets
 * you confirm the pull before any ticket is filed.
 */
export class HttpPostHogReportsClient implements PostHogReportsClient {
  constructor(private readonly log: Logger) {}

  async listReports(config: PostHogConfig): Promise<PostHogReport[]> {
    const host = config.host.replace(/\/+$/, "");
    const url = `${host}/api/projects/${config.projectId}/query/`;
    const days = Math.max(1, Math.floor(config.lookbackDays));
    const body = {
      query: {
        kind: "ErrorTrackingQuery",
        orderBy: config.orderBy,
        orderDirection: "DESC",
        dateRange: { date_from: `-${days}d` },
        // Number of buckets for the per-issue volume sparkline. Required by the
        // ErrorTrackingQuery schema; 1 keeps the response small (we don't render it).
        volumeResolution: 1,
        // PostHog uses "all" to mean "don't filter by status".
        status: config.status === "all" ? undefined : config.status,
        // Over-fetch so dedupe/threshold trimming still leaves enough to file.
        limit: Math.max(50, config.maxTicketsPerRun * 5),
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(`PostHog query request failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!response.ok) {
      let detail = "";
      try { detail = await response.text(); } catch { /* ignore */ }
      throw new Error(`PostHog query returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (e) {
      throw new Error(`PostHog query returned non-JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const results = (payload as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      this.log.warn("PostHog query response had no `results` array; treating as empty");
      return [];
    }

    return results
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r))
      .map(r => normalizeReport(r, host, config.projectId))
      .filter((r): r is PostHogReport => r !== null);
  }
}

/** PostHog issue rows arrive with either snake_case or camelCase keys and may nest counts under `aggregations`. */
function normalizeReport(
  row: Record<string, unknown>,
  host: string,
  projectId: string,
): PostHogReport | null {
  const id = firstString(row.id, row.issue_id, row.issueId);
  if (!id) return null;

  const agg = (typeof row.aggregations === "object" && row.aggregations !== null)
    ? (row.aggregations as Record<string, unknown>)
    : {};
  const num = (...vals: unknown[]): number => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };

  const name = firstString(row.name, row.title, row.exception_type) ?? `Issue ${id}`;
  return {
    id,
    name,
    description: firstString(row.description, row.message) ?? null,
    status: firstString(row.status) ?? "active",
    occurrences: num(row.occurrences, agg.occurrences),
    sessions: num(row.sessions, agg.sessions),
    users: num(row.users, agg.users),
    firstSeen: firstString(row.first_seen, row.firstSeen) ?? null,
    lastSeen: firstString(row.last_seen, row.lastSeen) ?? null,
    url: `${host}/project/${projectId}/error_tracking/${id}`,
  };
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

// ─── Default Linear ticket store (reuses src/linear.ts) ─────────────────────

interface ResolvedRefs {
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  labelId: string | null;
}

class LinearTicketStore implements PostHogTicketStore {
  private refs: ResolvedRefs | null = null;
  private readonly terminalStatesLower: Set<string>;

  constructor(
    private readonly cfg: PostHogConfig,
    private readonly tracker: TrackerConfig,
    private readonly log: Logger,
  ) {
    this.terminalStatesLower = new Set(tracker.terminalStates.map(s => s.toLowerCase()));
  }

  async snapshot(): Promise<PostHogTicketSnapshot> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const existingKeys = new Set<string>();
    let openCount = 0;
    for (const issue of issues) {
      // Dedupe against ALL tickets (any state): a report that was fixed and
      // closed should not be re-filed just because PostHog still lists it within
      // the lookback window — the occurrences age out by the next pull.
      const key = extractReportKey(issue.description);
      if (key) existingKeys.add(key);
      if (!this.terminalStatesLower.has(issue.state.toLowerCase())) openCount++;
    }
    return { existingKeys, openCount };
  }

  async createTicket(report: PostHogReport, key: string): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      assigneeId: refs.assigneeId ?? undefined,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildTicketTitle(report),
      description: buildTicketDescription(report, key),
    });
    return { identifier: issue.identifier, url: issue.url };
  }

  private async ensureRefs(): Promise<ResolvedRefs> {
    if (this.refs) return this.refs;

    const team = await linear.fetchTeamByKey(this.tracker, this.cfg.teamKey);
    if (!team) throw new Error(`Linear team not found for key "${this.cfg.teamKey}"`);

    const states = await linear.fetchWorkflowStates(this.tracker, team.id);
    const state = states.find(s => s.name.toLowerCase() === this.cfg.targetState.toLowerCase());
    if (!state) {
      throw new Error(`Linear workflow state "${this.cfg.targetState}" not found in team "${this.cfg.teamKey}"`);
    }

    let assigneeId: string | null = null;
    if (this.cfg.assigneeEmail) {
      const user = await linear.fetchUserByEmailOrName(this.tracker, this.cfg.assigneeEmail);
      if (user) {
        assigneeId = user.id;
      } else {
        this.log.warn(`PostHog assignee "${this.cfg.assigneeEmail}" not found in Linear; filing unassigned`);
      }
    }

    let labelId: string | null = null;
    if (this.cfg.label) {
      labelId = await linear.resolveOrCreateLabelId(this.tracker, team.id, this.cfg.label);
    }

    this.refs = { teamId: team.id, stateId: state.id, assigneeId, labelId };
    return this.refs;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
