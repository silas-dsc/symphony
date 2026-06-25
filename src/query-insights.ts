import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger, QueryInsightsConfig, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

const execFileP = promisify(execFile);

/**
 * One offending query shape, aggregated over the lookback window from the
 * BigQuery `query_insights.query_stats` table that the team-dsc app streams to
 * (see packages/app/src/lib/queryInsights.server.ts).
 */
export interface QueryOffender {
  callSite: string;
  shape: string;
  execCount: number;
  totalReadOps: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgResults: number;
  sampleIndexesUsed: string | null;
  /** SUM(readOps) * AVG(latencyMs) — the absolute-cost rank, NOT scan/result ratio. */
  score: number;
}

/** Runs the ranking query. Injected so tests don't shell out to `bq`. */
export interface OffenderClient {
  topOffenders(config: QueryInsightsConfig): Promise<QueryOffender[]>;
}

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

export interface QueryInsightsTicketSnapshot {
  /** Stable fingerprints (`callSite|shape`) that already have a ticket, in any state. Dedupe. */
  existingKeys: Set<string>;
  /** Count of query-insights-labelled tickets currently non-terminal. Caps concurrency. */
  openCount: number;
}

export interface QueryInsightsTicketStore {
  snapshot(): Promise<QueryInsightsTicketSnapshot>;
  createTicket(offender: QueryOffender, key: string): Promise<CreatedTicket>;
}

export interface QueryInsightsWatcherOptions {
  config: QueryInsightsConfig;
  tracker: TrackerConfig;
  logger: Logger;
  offenderClient?: OffenderClient;
  ticketStore?: QueryInsightsTicketStore;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/** Stable dedupe fingerprint — values are already stripped from `shape` upstream. */
export function offenderKey(offender: Pick<QueryOffender, "callSite" | "shape">): string {
  return `${offender.callSite}|${offender.shape}`;
}

const MARKER_RE = /<!--\s*symphony-query-insights:(.+?)\s*-->/;

export function extractOffenderKey(description: string): string | null {
  const m = description.match(MARKER_RE);
  return m ? m[1] : null;
}

export function buildTicketTitle(offender: QueryOffender): string {
  const reads = Math.round(offender.totalReadOps).toLocaleString("en-US");
  const lat = Math.round(offender.avgLatencyMs);
  return truncate(
    `[Query Insights] ${offender.callSite} — ${reads} reads, ~${lat}ms avg`,
    120,
  );
}

export function buildTicketDescription(offender: QueryOffender, key: string): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  return [
    `<!-- symphony-query-insights:${key} -->`,
    "> Auto-filed by Symphony from Firestore Query Insights (BigQuery `query_insights.query_stats`).",
    "> A high-cost query shape. Diagnose the call site, reduce read volume, verify, and open a PR.",
    "",
    "## Offender",
    `- **Call site:** \`${offender.callSite}\``,
    `- **Query shape:** \`${offender.shape}\``,
    `- **Executions (window):** ${fmt(offender.execCount)}`,
    `- **Total read operations:** ${fmt(offender.totalReadOps)}`,
    `- **Avg latency:** ${fmt(offender.avgLatencyMs)}ms (p95 ${fmt(offender.p95LatencyMs)}ms)`,
    `- **Avg results returned:** ${fmt(offender.avgResults)}`,
    `- **Indexes used (sample):** ${offender.sampleIndexesUsed ? `\`${truncate(offender.sampleIndexesUsed, 300)}\`` : "—"}`,
    "",
    "## Why this is expensive",
    "Ranked by absolute cost — `SUM(readOps) × AVG(latencyMs)` — not the docs-scanned/results ratio. The fix is almost always to read fewer documents, not to add an index to a query that already returns what it scans.",
    "",
    "## Likely fixes (verify against the call site)",
    "- [ ] Add a `.select(...)` projection if the caller only needs a few fields — Firestore still bills per doc, but smaller payloads cut latency and downstream cost.",
    "- [ ] Scope the query more tightly (e.g. by `userId` rather than a stale/broad `teamId`) so fewer rows are read.",
    "- [ ] Add or correct a composite index if the query is doing a wide scan with a filter that isn't indexed.",
    "- [ ] Paginate / bound with `.limit(...)` where the caller doesn't truly need the full set (existence checks, previews).",
    "- [ ] Confirm the read isn't happening per-request when it could be cached or precomputed.",
    "",
    "## Acceptance criteria",
    "- [ ] Read operations for this call site drop materially (confirm via the BigQuery table after deploy).",
    "- [ ] No behavioural regression — the query still returns the rows callers depend on.",
    "- [ ] Affected package's typecheck, lint, and tests pass.",
    "- [ ] Open a PR.",
  ].join("\n").trim();
}

/**
 * Weekly triage: queries the BigQuery offender table, ranks query shapes by
 * absolute cost, and files a Linear ticket for the worst un-ticketed ones — in
 * the configured active state so Symphony's normal poll loop dispatches an
 * agent to read the call site, reduce read volume, test, and open a PR.
 *
 * Mirrors DependabotWatcher: a `cycleInFlight` guard, an injectable client,
 * marker-based dedupe that survives restarts, and an open-ticket cap. Adds a
 * `runIntervalMs` gate so the (relatively expensive) BigQuery scan runs about
 * once a week rather than every poll tick.
 */
export class QueryInsightsWatcher {
  private readonly cfg: QueryInsightsConfig;
  private readonly tracker: TrackerConfig;
  private readonly log: Logger;
  private readonly offenderClient: OffenderClient;
  private readonly ticketStore: QueryInsightsTicketStore;
  private readonly now: () => number;
  private readonly createdKeys = new Set<string>();
  private cycleInFlight = false;
  private nextRunAt = 0; // 0 → run on first tick after startup.

  constructor(opts: QueryInsightsWatcherOptions) {
    this.cfg = opts.config;
    this.tracker = opts.tracker;
    this.log = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.offenderClient = opts.offenderClient ?? new BqOffenderClient(opts.logger);
    this.ticketStore =
      opts.ticketStore ?? new LinearTicketStore(opts.config, opts.tracker, opts.logger);
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return; // weekly gate

    this.cycleInFlight = true;
    try {
      let offenders: QueryOffender[];
      try {
        offenders = await this.offenderClient.topOffenders(this.cfg);
      } catch (e) {
        this.log.warn(`Query Insights BigQuery scan failed: ${fmtErr(e)}`);
        return; // do NOT advance nextRunAt — retry next tick.
      }

      // Only advance the weekly clock once the scan itself succeeded.
      this.nextRunAt = this.now() + this.cfg.runIntervalMs;

      if (offenders.length === 0) {
        this.log.info("Query Insights: no offenders above threshold this window");
        return;
      }

      let snap: QueryInsightsTicketSnapshot;
      try {
        snap = await this.ticketStore.snapshot();
      } catch (e) {
        this.log.warn(
          `Query Insights ticket snapshot failed, skipping creation this run: ${fmtErr(e)}`,
        );
        return;
      }

      let openCount = snap.openCount;
      let filed = 0;
      for (const offender of offenders) {
        if (openCount >= this.cfg.maxOpenTickets) break;
        if (filed >= this.cfg.maxTicketsPerRun) break;
        const key = offenderKey(offender);
        if (this.createdKeys.has(key) || snap.existingKeys.has(key)) continue;

        try {
          const ticket = await this.ticketStore.createTicket(offender, key);
          this.createdKeys.add(key);
          openCount++;
          filed++;
          this.log.info("Filed Linear ticket for query-insights offender", {
            key,
            issue: ticket.identifier,
            totalReadOps: Math.round(offender.totalReadOps),
            avgLatencyMs: Math.round(offender.avgLatencyMs),
          });
        } catch (e) {
          this.log.warn(`Failed to file query-insights ticket for ${key}: ${fmtErr(e)}`, { key });
        }
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  getCreatedCount(): number {
    return this.createdKeys.size;
  }
}

// ─── Default BigQuery offender client (`bq query`) ──────────────────────────

/** Row shape the BigQuery JSON output returns (all values arrive as strings). */
interface BqRow {
  callSite?: string;
  shape?: string;
  execCount?: string;
  totalReadOps?: string;
  avgLatencyMs?: string;
  p95LatencyMs?: string;
  avgResults?: string;
  sampleIndexesUsed?: string | null;
}

export function buildRankingSql(cfg: QueryInsightsConfig): string {
  const table = `\`${cfg.projectId}.${cfg.dataset}.${cfg.table}\``;
  // All interpolated values are our own validated integers — no injection risk.
  const days = Math.max(1, Math.floor(cfg.lookbackDays));
  const minReadOps = Math.max(0, Math.floor(cfg.minReadOps));
  const limit = Math.max(1, Math.floor(cfg.maxTicketsPerRun * 3)); // over-fetch; dedupe trims.
  return [
    "SELECT",
    "  callSite,",
    "  shape,",
    "  COUNT(*) AS execCount,",
    "  SUM(readOps) AS totalReadOps,",
    "  AVG(latencyMs) AS avgLatencyMs,",
    "  APPROX_QUANTILES(latencyMs, 100)[OFFSET(95)] AS p95LatencyMs,",
    "  AVG(resultsReturned) AS avgResults,",
    "  ANY_VALUE(indexesUsed) AS sampleIndexesUsed",
    `FROM ${table}`,
    `WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)`,
    "GROUP BY callSite, shape",
    `HAVING totalReadOps >= ${minReadOps}`,
    "ORDER BY SUM(readOps) * AVG(latencyMs) DESC",
    `LIMIT ${limit}`,
  ].join("\n");
}

class BqOffenderClient implements OffenderClient {
  constructor(private readonly log: Logger) {}

  async topOffenders(config: QueryInsightsConfig): Promise<QueryOffender[]> {
    const sql = buildRankingSql(config);
    const { stdout } = await execFileP(
      "bq",
      [
        "query",
        `--project_id=${config.projectId}`,
        "--use_legacy_sql=false",
        "--format=json",
        "--max_rows=1000",
        sql,
      ],
      { env: process.env, encoding: "utf8", timeout: config.bqTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );

    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const rows = JSON.parse(trimmed) as BqRow[];
    if (!Array.isArray(rows)) return [];

    return rows
      .filter((r): r is BqRow & { callSite: string; shape: string } =>
        typeof r.callSite === "string" && typeof r.shape === "string",
      )
      .map(normalizeRow);
  }
}

function normalizeRow(r: BqRow & { callSite: string; shape: string }): QueryOffender {
  const num = (v: string | undefined | null) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const totalReadOps = num(r.totalReadOps);
  const avgLatencyMs = num(r.avgLatencyMs);
  return {
    callSite: r.callSite,
    shape: r.shape,
    execCount: num(r.execCount),
    totalReadOps,
    avgLatencyMs,
    p95LatencyMs: num(r.p95LatencyMs),
    avgResults: num(r.avgResults),
    sampleIndexesUsed: r.sampleIndexesUsed ?? null,
    score: totalReadOps * avgLatencyMs,
  };
}

// ─── Default Linear ticket store (reuses src/linear.ts) ─────────────────────

interface ResolvedRefs {
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  labelId: string | null;
}

class LinearTicketStore implements QueryInsightsTicketStore {
  private refs: ResolvedRefs | null = null;
  private readonly terminalStatesLower: Set<string>;

  constructor(
    private readonly cfg: QueryInsightsConfig,
    private readonly tracker: TrackerConfig,
    private readonly log: Logger,
  ) {
    this.terminalStatesLower = new Set(tracker.terminalStates.map(s => s.toLowerCase()));
  }

  async snapshot(): Promise<QueryInsightsTicketSnapshot> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const existingKeys = new Set<string>();
    let openCount = 0;
    for (const issue of issues) {
      const key = extractOffenderKey(issue.description);
      if (key) existingKeys.add(key);
      if (!this.terminalStatesLower.has(issue.state.toLowerCase())) openCount++;
    }
    return { existingKeys, openCount };
  }

  async createTicket(offender: QueryOffender, key: string): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      assigneeId: refs.assigneeId ?? undefined,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildTicketTitle(offender),
      description: buildTicketDescription(offender, key),
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
        this.log.warn(`Query Insights assignee "${this.cfg.assigneeEmail}" not found in Linear; filing unassigned`);
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
