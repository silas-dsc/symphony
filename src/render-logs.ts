import { createHash } from "node:crypto";
import type { Logger, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";
import { isFixableError, normalizeMessage } from "./firebase-logs.js";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface RenderLogsConfig {
  enabled: boolean;
  /** Render API key (`$RENDER_API_KEY`). */
  apiKey: string;
  /** Render workspace (owner) id, e.g. `tea-…` (`$RENDER_OWNER_ID`). */
  ownerId: string;
  /** Render service ids (`srv-…`) to scan. All must be in the same region. */
  serviceIds: string[];
  teamKey: string;
  targetState: string;
  label: string;
  lookbackHours: number;
  minOccurrences: number;
  maxOpenTickets: number;
  maxTicketsPerRun: number;
  runIntervalMs: number;
}

export const DEFAULT_RENDER_LOGS_CONFIG: RenderLogsConfig = {
  enabled: false,
  apiKey: "",
  ownerId: "",
  serviceIds: [],
  teamKey: "TEA",
  targetState: "Dev in Progress",
  label: "render-logs",
  lookbackHours: 24,
  minOccurrences: 3,
  maxOpenTickets: 5,
  maxTicketsPerRun: 3,
  runIntervalMs: 6 * 60 * 60 * 1000,
};

/** Fills unset fields from defaults; secrets/ids fall back to `$RENDER_API_KEY`, `$RENDER_OWNER_ID`, `$RENDER_SERVICE_IDS` (comma-separated). */
export function renderLogsConfigWithDefaults(
  overrides: Partial<RenderLogsConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): RenderLogsConfig {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const cfg: RenderLogsConfig = { ...DEFAULT_RENDER_LOGS_CONFIG, ...defined };
  if (!cfg.apiKey) cfg.apiKey = env.RENDER_API_KEY ?? "";
  if (!cfg.ownerId) cfg.ownerId = env.RENDER_OWNER_ID ?? "";
  if (cfg.serviceIds.length === 0 && env.RENDER_SERVICE_IDS) {
    cfg.serviceIds = env.RENDER_SERVICE_IDS.split(",").map(s => s.trim()).filter(Boolean);
  }
  return cfg;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface RenderLogEntry {
  timestamp: string;
  message: string;
  /** Render resource id (`srv-…`) the line came from, when known. */
  service?: string;
}

/** Pulls error-level log lines. Injected so tests don't call Render. */
export interface RenderLogsClient {
  fetchErrors(sinceIso: string, untilIso: string): Promise<RenderLogEntry[]>;
}

type FetchFn = typeof fetch;

interface RenderLogsResponse {
  hasMore?: boolean;
  nextStartTime?: string;
  nextEndTime?: string;
  logs?: Array<{
    id?: string;
    message?: string;
    timestamp?: string;
    labels?: Array<{ name?: string; value?: string }>;
  }>;
}

/**
 * Default client: `GET https://api.render.com/v1/logs` (Render public API, "List logs").
 * `resource` and `level` are array params, sent repeated. `limit` max is 100; follows
 * `hasMore` by re-querying with `nextStartTime`/`nextEndTime`, up to `maxPages`.
 */
export class HttpRenderLogsClient implements RenderLogsClient {
  constructor(
    private readonly cfg: Pick<RenderLogsConfig, "apiKey" | "ownerId" | "serviceIds">,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly maxPages = 20,
    private readonly baseUrl = "https://api.render.com/v1",
  ) {}

  async fetchErrors(sinceIso: string, untilIso: string): Promise<RenderLogEntry[]> {
    if (this.cfg.serviceIds.length === 0) return [];
    const out: RenderLogEntry[] = [];
    let startTime = sinceIso;
    let endTime = untilIso;
    for (let page = 0; page < this.maxPages; page++) {
      const params = new URLSearchParams();
      params.set("ownerId", this.cfg.ownerId);
      for (const id of this.cfg.serviceIds) params.append("resource", id);
      params.append("level", "error");
      params.set("startTime", startTime);
      params.set("endTime", endTime);
      params.set("limit", "100");
      params.set("direction", "backward");

      const res = await this.fetchImpl(`${this.baseUrl}/logs?${params.toString()}`, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Render logs HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as RenderLogsResponse;
      for (const row of data.logs ?? []) {
        if (typeof row.message !== "string" || !row.message.trim()) continue;
        const service = row.labels?.find(l => l.name === "resource")?.value;
        out.push({
          timestamp: typeof row.timestamp === "string" ? row.timestamp : untilIso,
          message: row.message,
          ...(service ? { service } : {}),
        });
      }
      if (!data.hasMore || !data.nextStartTime || !data.nextEndTime) break;
      if (data.nextStartTime === startTime && data.nextEndTime === endTime) break; // no progress
      startTime = data.nextStartTime;
      endTime = data.nextEndTime;
    }
    return out;
  }
}

// ─── Grouping ───────────────────────────────────────────────────────────────

export interface RenderErrorGroup {
  service: string;
  signature: string;
  sample: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Platform / infra noise that isn't an app bug: health checks, shutdown signals
 * and restarts, deploy chatter, and 502s (Render returns these while an instance
 * is being swapped during a deploy). Applied on top of firebase-logs' transient
 * patterns (timeouts, ECONNRESET, 503/504, rate limits…).
 */
export const RENDER_NOISE_PATTERNS: RegExp[] = [
  /health[\s-]?check/i,
  /\/health(?:z|check)?\b/i,
  /\/ping\b/i,
  /\bSIG(?:TERM|INT|KILL|HUP)\b/,
  /exit(?:ed)? (?:with )?(?:code|status) (?:137|143)\b/i,
  /\brestart(?:ing|ed)?\b/i,
  /shutting down|graceful(?:ly)? shut/i,
  /\bdeploy(?:ing|ed|ment|s)?\b/i,
  /\bbuild (?:failed|succeeded|started)\b/i,
  /\b502\b/,
  /bad gateway/i,
  /no open ports? detected/i,
  /instance (?:failed|is unhealthy)/i,
];

export function isRenderNoise(message: string): boolean {
  return RENDER_NOISE_PATTERNS.some(re => re.test(message)) || !isFixableError(message);
}

/**
 * Normalised signature: strip a leading log timestamp/level, ISO timestamps,
 * Mongo/Render/hex ids, then the firebase-logs normaliser (urls, uuids, quoted
 * strings, numbers).
 */
export function normalizeRenderMessage(message: string): string {
  const firstLine = (message.split("\n").find(l => l.trim()) ?? "").trim();
  const stripped = firstLine
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/^(?:<ts>\s*)?(?:\[?(?:ERROR|ERR|error|Error)\]?:?\s+)/, "")
    .replace(/^<ts>\s*/, "")
    .replace(/\b(?:srv|dep|evt|tea|usr|crn|dpg|red)-[a-z0-9]{6,}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{24}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<id>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "<id>");
  return normalizeMessage(stripped);
}

/** Groups raw lines by service + normalised signature. Does NOT filter noise. */
export function groupRenderErrors(entries: RenderLogEntry[]): RenderErrorGroup[] {
  const groups = new Map<string, RenderErrorGroup>();
  for (const e of entries) {
    const signature = normalizeRenderMessage(e.message);
    if (!signature) continue;
    const service = e.service ?? "unknown";
    const k = `${service} ${signature}`;
    const g = groups.get(k);
    if (!g) {
      groups.set(k, {
        service,
        signature,
        sample: e.message.trim(),
        count: 1,
        firstSeen: e.timestamp || null,
        lastSeen: e.timestamp || null,
      });
      continue;
    }
    g.count++;
    if (e.timestamp) {
      if (!g.firstSeen || e.timestamp < g.firstSeen) g.firstSeen = e.timestamp;
      if (!g.lastSeen || e.timestamp > g.lastSeen) g.lastSeen = e.timestamp;
    }
  }
  return [...groups.values()];
}

export function renderErrorKey(group: Pick<RenderErrorGroup, "service" | "signature">): string {
  return createHash("sha1").update(`${group.service} ${group.signature}`).digest("hex").slice(0, 16);
}

/**
 * Error-signature counts in a window, noise removed — for the deploy guard to
 * diff before vs after a deploy. Keys are `"<service>: <signature>"` (readable,
 * stable across windows); values are occurrence counts.
 */
export async function fetchErrorSignatures(
  client: RenderLogsClient,
  sinceIso: string,
  untilIso: string,
): Promise<Map<string, number>> {
  const entries = await client.fetchErrors(sinceIso, untilIso);
  const out = new Map<string, number>();
  for (const g of groupRenderErrors(entries)) {
    if (isRenderNoise(g.sample)) continue;
    const k = `${g.service}: ${g.signature}`;
    out.set(k, (out.get(k) ?? 0) + g.count);
  }
  return out;
}

const MARKER_RE = /<!--\s*symphony-render-log:([0-9a-f]+)\s*-->/;

export function extractRenderErrorKey(description: string): string | null {
  const m = description.match(MARKER_RE);
  return m ? m[1] : null;
}

export function buildRenderTicketTitle(group: RenderErrorGroup): string {
  const firstLine = (group.sample.split("\n").find(l => l.trim()) ?? group.signature).trim();
  return truncate(`[Render Logs] ${group.service}: ${firstLine} (${group.count}×)`, 120);
}

export function buildRenderTicketDescription(group: RenderErrorGroup, key: string): string {
  return [
    `<!-- symphony-render-log:${key} -->`,
    "> Auto-filed by Symphony from Render service error logs. Reproduce the error, fix the root cause, verify, and open a PR.",
    "",
    "## Error",
    `- **Service:** \`${group.service}\``,
    `- **Occurrences (window):** ${group.count}`,
    `- **First seen:** ${group.firstSeen ?? "—"}`,
    `- **Last seen:** ${group.lastSeen ?? "—"}`,
    `- **Signature:** \`${truncate(group.signature, 300)}\``,
    "",
    "## Sample log",
    "```",
    truncate(group.sample, 2000),
    "```",
    "",
    "## Acceptance criteria",
    "- [ ] Reproduce the error (trace it to the call site using the sample above).",
    "- [ ] Fix the root cause — not just the symptom.",
    "- [ ] Add or extend a test that would have caught this error.",
    "- [ ] Run the affected package's typecheck, lint, and tests.",
    "- [ ] Open a PR. The error stops appearing in the Render logs once the fix is deployed.",
  ].join("\n");
}

// ─── Ticket store ───────────────────────────────────────────────────────────

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

export interface RenderLogsTicketSnapshot {
  existingKeys: Set<string>;
  openCount: number;
}

export interface RenderLogsTicketStore {
  snapshot(): Promise<RenderLogsTicketSnapshot>;
  createTicket(group: RenderErrorGroup, key: string): Promise<CreatedTicket>;
}

export class LinearRenderTicketStore implements RenderLogsTicketStore {
  private refs: { teamId: string; stateId: string; labelId: string | null } | null = null;
  private readonly terminal: Set<string>;

  constructor(
    private readonly cfg: RenderLogsConfig,
    private readonly tracker: TrackerConfig,
  ) {
    this.terminal = new Set(tracker.terminalStates.map(s => s.toLowerCase()));
  }

  async snapshot(): Promise<RenderLogsTicketSnapshot> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const existingKeys = new Set<string>();
    let openCount = 0;
    for (const issue of issues) {
      // Only open tickets dedupe — a fixed-and-closed error that regresses is re-filed.
      if (this.terminal.has(issue.state.toLowerCase())) continue;
      openCount++;
      const key = extractRenderErrorKey(issue.description);
      if (key) existingKeys.add(key);
    }
    return { existingKeys, openCount };
  }

  async createTicket(group: RenderErrorGroup, key: string): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildRenderTicketTitle(group),
      description: buildRenderTicketDescription(group, key),
    });
    return { identifier: issue.identifier, url: issue.url };
  }

  private async ensureRefs(): Promise<{ teamId: string; stateId: string; labelId: string | null }> {
    if (this.refs) return this.refs;
    const team = await linear.fetchTeamByKey(this.tracker, this.cfg.teamKey);
    if (!team) throw new Error(`Linear team not found for key "${this.cfg.teamKey}"`);
    const states = await linear.fetchWorkflowStates(this.tracker, team.id);
    const state = states.find(s => s.name.toLowerCase() === this.cfg.targetState.toLowerCase());
    if (!state) {
      throw new Error(`Linear workflow state "${this.cfg.targetState}" not found in team "${this.cfg.teamKey}"`);
    }
    const labelId = this.cfg.label
      ? await linear.resolveOrCreateLabelId(this.tracker, team.id, this.cfg.label)
      : null;
    this.refs = { teamId: team.id, stateId: state.id, labelId };
    return this.refs;
  }
}

// ─── Watcher ────────────────────────────────────────────────────────────────

export interface RenderLogsWatcherOptions {
  config: RenderLogsConfig;
  tracker: TrackerConfig;
  logger: Logger;
  logsClient?: RenderLogsClient;
  ticketStore?: RenderLogsTicketStore;
  now?: () => number;
}

/**
 * Scans Render error logs, groups them by normalised signature, drops infra
 * noise and low-volume signatures, and files a Linear ticket (dev lane) for the
 * loudest un-ticketed ones. Mirrors FirebaseLogsWatcher.
 */
export class RenderLogsWatcher {
  private readonly cfg: RenderLogsConfig;
  private readonly log: Logger;
  private readonly client: RenderLogsClient;
  private readonly store: RenderLogsTicketStore;
  private readonly now: () => number;
  private readonly createdKeys = new Set<string>();
  private cycleInFlight = false;
  private nextRunAt = 0;

  constructor(opts: RenderLogsWatcherOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.client = opts.logsClient ?? new HttpRenderLogsClient(opts.config);
    this.store = opts.ticketStore ?? new LinearRenderTicketStore(opts.config, opts.tracker);
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return;
    this.cycleInFlight = true;
    try {
      let entries: RenderLogEntry[];
      try {
        entries = await this.fetchWindow();
      } catch (e) {
        this.log.warn(`Render logs scan failed: ${fmtErr(e)}`);
        return; // retry next tick
      }
      this.nextRunAt = this.now() + this.cfg.runIntervalMs;
      await this.fileTickets(entries);
    } finally {
      this.cycleInFlight = false;
    }
  }

  async runOnce(): Promise<CreatedTicket[]> {
    if (this.cycleInFlight) return [];
    this.cycleInFlight = true;
    try {
      return await this.fileTickets(await this.fetchWindow());
    } finally {
      this.cycleInFlight = false;
    }
  }

  getCreatedCount(): number {
    return this.createdKeys.size;
  }

  private fetchWindow(): Promise<RenderLogEntry[]> {
    const until = this.now();
    const since = until - this.cfg.lookbackHours * 60 * 60 * 1000;
    return this.client.fetchErrors(new Date(since).toISOString(), new Date(until).toISOString());
  }

  private async fileTickets(entries: RenderLogEntry[]): Promise<CreatedTicket[]> {
    const created: CreatedTicket[] = [];
    const eligible = groupRenderErrors(entries)
      .filter(g => !isRenderNoise(g.sample) && g.count >= this.cfg.minOccurrences)
      .sort((a, b) => b.count - a.count);
    if (eligible.length === 0) {
      this.log.info("Render logs: no error signatures above the occurrence threshold this run");
      return created;
    }

    let snap: RenderLogsTicketSnapshot;
    try {
      snap = await this.store.snapshot();
    } catch (e) {
      this.log.warn(`Render logs ticket snapshot failed, skipping creation this run: ${fmtErr(e)}`);
      return created;
    }

    let openCount = snap.openCount;
    let filed = 0;
    for (const group of eligible) {
      if (openCount >= this.cfg.maxOpenTickets) break;
      if (filed >= this.cfg.maxTicketsPerRun) break;
      const key = renderErrorKey(group);
      if (this.createdKeys.has(key) || snap.existingKeys.has(key)) continue;
      try {
        const ticket = await this.store.createTicket(group, key);
        this.createdKeys.add(key);
        openCount++;
        filed++;
        created.push(ticket);
        this.log.info("Filed Linear ticket for Render log error", {
          key,
          issue: ticket.identifier,
          service: group.service,
          count: group.count,
        });
      } catch (e) {
        this.log.warn(`Failed to file Render logs ticket for ${key}: ${fmtErr(e)}`, { key });
      }
    }
    return created;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
