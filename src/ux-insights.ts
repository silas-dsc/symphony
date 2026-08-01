import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { Logger, TrackerConfig, UxInsightsConfig } from "./types.js";
import * as linear from "./linear.js";
import { postToSlackWithRetry } from "./notifications.js";

/**
 * The UX / product-research agent (TEA-4562). Unlike the `posthog` error watcher
 * — which files one Linear ticket per error-tracking row — this pulls *behavioural*
 * data from PostHog (on-site searches, content→conversion paths, drop-off pages,
 * rage/dead-click confusion signals), asks Claude to synthesise actionable UX and
 * product insights, posts the weekly write-up to Slack, and files a Linear ticket
 * for the high-confidence, actionable ones so Symphony's normal poll loop can close
 * the loop (e.g. "correct the common search typo `pmp` → `PMP` so users find the course").
 *
 * Shape mirrors QueryInsightsWatcher/PostHogWatcher: a `cycleInFlight` guard, a
 * `runIntervalMs` weekly gate, injectable clients (so tests never touch the
 * network, Claude, or Slack), marker-based ticket dedupe that survives restarts,
 * and open-ticket / per-run caps.
 */

// ─── Data model ─────────────────────────────────────────────────────────────

/** The four behavioural lenses the query pack collects, matching the ticket's questions. */
export type UxCategory = "search-gap" | "conversion" | "drop-off" | "confusion";

export const UX_CATEGORIES: readonly UxCategory[] = [
  "search-gap",
  "conversion",
  "drop-off",
  "confusion",
];

/** One aggregated behavioural row, normalised across the different query shapes. */
export interface UxMetric {
  category: UxCategory;
  /** The subject of the row — a search term, a page path, or an event name. */
  label: string;
  /** The primary magnitude — searches, exits, rage-clicks, or conversions. */
  value: number;
  /** Supporting columns (zero-result rate, sessions, sample url, …) for context. */
  detail: Record<string, string | number>;
}

export interface UxDataset {
  metrics: UxMetric[];
}

export type InsightConfidence = "low" | "medium" | "high";

const CONFIDENCE_RANK: Record<InsightConfidence, number> = { low: 0, medium: 1, high: 2 };

/** Sort comparator: highest-confidence first. Used for both the Slack report and the ticket budget. */
function byConfidenceDesc(a: Insight, b: Insight): number {
  return CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
}

/** One synthesised insight. `ticketable` + `confidence` gate whether it becomes a Linear ticket. */
export interface Insight {
  /** Which lens this came from, or "opportunity" for a novel product idea. */
  category: UxCategory | "opportunity";
  title: string;
  /** The "why" — the reasoning and the evidence behind the insight. */
  detail: string;
  confidence: InsightConfidence;
  /** A concrete, buildable fix, or null if it's an observation only. */
  recommendation: string | null;
  /** Whether this is an actionable engineering change (vs. an FYI). */
  ticketable: boolean;
}

export interface UxReport {
  /** A short narrative answering the ticket's questions. */
  summary: string;
  insights: Insight[];
}

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

// ─── Injectable collaborators ───────────────────────────────────────────────

/** Pulls the behavioural query pack from PostHog. Injected so tests don't hit the network. */
export interface HogQlClient {
  collect(config: UxInsightsConfig): Promise<UxDataset>;
}

/** Turns a dataset into a narrative report. Injected so tests don't spawn Claude. */
export interface InsightSynthesizer {
  synthesize(dataset: UxDataset, config: UxInsightsConfig): Promise<UxReport>;
}

/** Posts the weekly report. Injected so tests don't call Slack. */
export interface UxSlackReporter {
  post(report: UxReport, config: UxInsightsConfig): Promise<void>;
}

export interface UxTicketSnapshot {
  /** Insight keys that already have a Linear ticket, in any state. Dedupe. */
  existingKeys: Set<string>;
  /** Count of ux-insights-labelled tickets currently non-terminal. Caps concurrency. */
  openCount: number;
}

export interface UxTicketStore {
  snapshot(): Promise<UxTicketSnapshot>;
  createTicket(insight: Insight, key: string): Promise<CreatedTicket>;
}

export interface UxInsightsWatcherOptions {
  config: UxInsightsConfig;
  tracker: TrackerConfig;
  logger: Logger;
  hogQlClient?: HogQlClient;
  synthesizer?: InsightSynthesizer;
  slackReporter?: UxSlackReporter;
  ticketStore?: UxTicketStore;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/** Result of a single run — the report that was produced and the tickets it filed. */
export interface UxRunResult {
  report: UxReport | null;
  created: CreatedTicket[];
}

// ─── Keys & markers ─────────────────────────────────────────────────────────

const MARKER_RE = /<!--\s*symphony-ux-insight:(.+?)\s*-->/;

export function extractInsightKey(description: string): string | null {
  const m = description.match(MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Stable dedupe fingerprint for an insight: `category/slug(title)`. Kept stable
 * across weeks so the same recurring insight (same category + title) is only
 * ticketed once — a re-run that surfaces it again is deduped, not re-filed.
 */
export function insightKey(insight: Pick<Insight, "category" | "title">): string {
  const slug = insight.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${insight.category}/${slug || "untitled"}`;
}

export function meetsTicketBar(insight: Insight, minConfidence: string): boolean {
  if (!insight.ticketable) return false;
  const floor = CONFIDENCE_RANK[normalizeConfidence(minConfidence)];
  return CONFIDENCE_RANK[insight.confidence] >= floor;
}

function normalizeConfidence(value: string): InsightConfidence {
  const v = value.toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : "high";
}

// ─── Ticket copy ────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<Insight["category"], string> = {
  "search-gap": "Search gap",
  conversion: "Conversion",
  "drop-off": "Drop-off",
  confusion: "Confusion",
  opportunity: "Opportunity",
};

export function buildTicketTitle(insight: Insight): string {
  return truncate(`[UX] ${CATEGORY_LABEL[insight.category]}: ${insight.title}`, 120);
}

export function buildTicketDescription(insight: Insight, key: string): string {
  return [
    `<!-- symphony-ux-insight:${key} -->`,
    "> Auto-filed by Symphony from a PostHog UX/product-research pass (TEA-4562).",
    "> A behavioural insight worth acting on. Validate it against the data, implement the change, verify, and open a PR.",
    "",
    "## Insight",
    `- **Category:** ${CATEGORY_LABEL[insight.category]}`,
    `- **Confidence:** ${insight.confidence}`,
    "",
    "## What the data shows",
    insight.detail.trim() || "_No detail captured._",
    "",
    "## Recommended change",
    insight.recommendation?.trim() || "_No specific fix proposed — investigate and decide the right change._",
    "",
    "## Acceptance criteria",
    "- [ ] Confirm the behaviour in PostHog (reproduce the funnel / search / path this insight describes).",
    "- [ ] Implement the change above (or a better one you can justify from the data).",
    "- [ ] Add or extend a test where the change is testable.",
    "- [ ] Run the affected package's typecheck, lint, and tests.",
    "- [ ] Open a PR. Note in the PR how to measure whether the change moved the metric.",
  ].join("\n").trim();
}

// ─── Slack report copy ──────────────────────────────────────────────────────

const CONFIDENCE_EMOJI: Record<InsightConfidence, string> = {
  high: "🟢",
  medium: "🟡",
  low: "⚪",
};

/**
 * Build the Slack message for a weekly report. Insights are ordered
 * highest-confidence first so the most actionable land at the top, and each
 * ticketable one is flagged so a reader can see what will be auto-filed.
 */
export function buildSlackReport(
  report: UxReport,
  minConfidence: string,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const ordered = [...report.insights].sort(byConfidenceDesc);

  const lines: string[] = ["*📊 Weekly UX / product insights*", "", report.summary.trim()];
  if (ordered.length > 0) lines.push("");

  for (const insight of ordered) {
    const willTicket = meetsTicketBar(insight, minConfidence) ? "  · _will file ticket_" : "";
    lines.push(
      `${CONFIDENCE_EMOJI[insight.confidence]} *${CATEGORY_LABEL[insight.category]}:* ${insight.title}${willTicket}`,
    );
    const detail = firstLine(insight.detail);
    if (detail) lines.push(`> ${detail}`);
    if (insight.recommendation?.trim()) lines.push(`> ↳ ${firstLine(insight.recommendation)}`);
  }

  const text = lines.join("\n");
  return {
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } }],
  };
}

// ─── HogQL query pack ───────────────────────────────────────────────────────

export interface HogQlQuerySpec {
  category: UxCategory;
  name: string;
  hogql: string;
}

/**
 * The four HogQL queries behind the four lenses. All interpolated values are our
 * own validated integers/identifiers (no user input), so string interpolation is
 * safe here. Tune these with `symphony-ux-insights --dry-run` against live data
 * before trusting the output — event/property names depend on the app's tracking.
 */
export function buildQueryPack(cfg: UxInsightsConfig): HogQlQuerySpec[] {
  const days = Math.max(1, Math.floor(cfg.lookbackDays));
  const limit = Math.max(1, Math.floor(cfg.maxSignalsPerCategory));
  const since = `now() - INTERVAL ${days} DAY`;
  const search = sqlName(cfg.searchEventName);
  const queryProp = cfg.searchQueryProperty;
  const conversionList = (cfg.conversionEvents.length ? cfg.conversionEvents : ["$autocapture"])
    .map(e => `'${sqlName(e)}'`)
    .join(", ");

  return [
    {
      category: "search-gap",
      name: "top-searches",
      hogql: [
        `SELECT properties.${sqlName(queryProp)} AS label, count() AS value,`,
        "  count(DISTINCT person_id) AS users",
        `FROM events WHERE event = '${search}' AND timestamp > ${since}`,
        `  AND properties.${sqlName(queryProp)} != ''`,
        "GROUP BY label ORDER BY value DESC",
        `LIMIT ${limit}`,
      ].join("\n"),
    },
    {
      category: "conversion",
      name: "conversion-referrers",
      hogql: [
        "SELECT properties.$referrer AS label, count() AS value,",
        "  count(DISTINCT person_id) AS users",
        `FROM events WHERE event IN (${conversionList}) AND timestamp > ${since}`,
        "GROUP BY label ORDER BY value DESC",
        `LIMIT ${limit}`,
      ].join("\n"),
    },
    {
      category: "drop-off",
      name: "exit-pages",
      hogql: [
        "SELECT properties.$current_url AS label, count() AS value,",
        "  count(DISTINCT $session_id) AS sessions",
        `FROM events WHERE event = '$pageleave' AND timestamp > ${since}`,
        "GROUP BY label ORDER BY value DESC",
        `LIMIT ${limit}`,
      ].join("\n"),
    },
    {
      category: "confusion",
      name: "rage-and-dead-clicks",
      hogql: [
        "SELECT properties.$current_url AS label, count() AS value,",
        "  countIf(event = '$rageclick') AS rageclicks,",
        "  countIf(event = '$dead_click') AS dead_clicks",
        `FROM events WHERE event IN ('$rageclick', '$dead_click') AND timestamp > ${since}`,
        "GROUP BY label ORDER BY value DESC",
        `LIMIT ${limit}`,
      ].join("\n"),
    },
  ];
}

/** Strip anything that isn't a safe HogQL identifier/event char — defence in depth for interpolation. */
function sqlName(value: string): string {
  return value.replace(/[^A-Za-z0-9_$.\-]/g, "");
}

/**
 * Map raw PostHog query rows (`{ columns, results }`) to normalised metrics.
 * Column 0 is the label; column 1 is the primary value; remaining columns become
 * `detail`. Rows with an empty label or a non-finite value are dropped.
 */
export function rowsToMetrics(
  category: UxCategory,
  columns: string[],
  results: unknown[][],
): UxMetric[] {
  const metrics: UxMetric[] = [];
  for (const row of results) {
    const label = row[0];
    if (typeof label !== "string" || !label.trim()) continue;
    const value = Number(row[1]);
    if (!Number.isFinite(value)) continue;

    const detail: Record<string, string | number> = {};
    for (let i = 2; i < columns.length; i++) {
      const col = columns[i];
      const cell = row[i];
      if (typeof cell === "number" && Number.isFinite(cell)) detail[col] = cell;
      else if (typeof cell === "string" && cell.trim()) detail[col] = cell;
    }
    metrics.push({ category, label: label.trim(), value, detail });
  }
  return metrics;
}

// ─── Synthesis prompt + output parsing ──────────────────────────────────────

/**
 * The instruction the synthesiser Claude session receives, with the dataset
 * inlined as JSON. Kept in code (not a prompt file) because it's a focused,
 * structured call, matching how the other watchers build their own strings.
 */
export function buildSynthesisPrompt(dataset: UxDataset, cfg: UxInsightsConfig): string {
  const grouped: Record<string, UxMetric[]> = {};
  for (const m of dataset.metrics) (grouped[m.category] ??= []).push(m);

  return [
    "You are a product analyst mining PostHog behavioural data for the team-dsc website",
    "(workshops, courses, tools, membership). Answer these questions from the data below:",
    "",
    "1. Gaps in the workshop offering — what unmet demand or new-product signals do searches/browsing show?",
    "2. Which content/landing pages most drive users toward courses, tools, or membership?",
    "3. Which pages disproportionately lose people, and why?",
    "4. Where do users look confused — repeated clicking, backtracking, refreshing?",
    "Also raise any other actionable insight that could lift conversion or improve the product.",
    "",
    `Data (last ${cfg.lookbackDays} days), grouped by lens:`,
    "```json",
    JSON.stringify(grouped, null, 2),
    "```",
    "",
    "Return ONLY a single fenced ```json block with this exact shape:",
    "```json",
    JSON.stringify(
      {
        summary: "2-4 sentence narrative answering the questions above",
        insights: [
          {
            category: "search-gap | conversion | drop-off | confusion | opportunity",
            title: "short, specific",
            detail: "the why + the evidence from the data",
            confidence: "low | medium | high",
            recommendation: "a concrete change, or null",
            ticketable: true,
          },
        ],
      },
      null,
      2,
    ),
    "```",
    `Mark an insight ticketable only when it is a concrete engineering change worth doing (${cfg.minConfidenceToTicket}+ confidence gets auto-filed).`,
    "Do not invent data. If the data is too thin to answer a question, say so in the summary and omit the insight.",
  ].join("\n");
}

/** Pull the first fenced ```json block (or the first `{…}`) out of Claude's text output. */
export function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

/** Parse + coerce Claude's output into a UxReport, dropping malformed insights. Throws only if no JSON at all. */
export function parseSynthesisOutput(text: string): UxReport {
  const block = extractJsonBlock(text);
  if (!block) throw new Error("synthesis output contained no JSON block");

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`synthesis output was not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("synthesis output JSON was not an object");
  }

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const rawInsights = Array.isArray(obj.insights) ? obj.insights : [];
  const insights: Insight[] = [];
  for (const raw of rawInsights) {
    const coerced = coerceInsight(raw);
    if (coerced) insights.push(coerced);
  }
  return { summary, insights };
}

const VALID_CATEGORIES = new Set<Insight["category"]>([...UX_CATEGORIES, "opportunity"]);

function coerceInsight(raw: unknown): Insight | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;
  const category = (typeof r.category === "string" ? r.category.trim() : "") as Insight["category"];
  const recommendation = typeof r.recommendation === "string" && r.recommendation.trim()
    ? r.recommendation.trim()
    : null;
  return {
    category: VALID_CATEGORIES.has(category) ? category : "opportunity",
    title,
    detail: typeof r.detail === "string" ? r.detail.trim() : "",
    confidence: normalizeConfidence(typeof r.confidence === "string" ? r.confidence : "medium"),
    recommendation,
    ticketable: r.ticketable === true,
  };
}

// ─── Watcher ────────────────────────────────────────────────────────────────

export class UxInsightsWatcher {
  private readonly cfg: UxInsightsConfig;
  private readonly log: Logger;
  private readonly hogQlClient: HogQlClient;
  private readonly synthesizer: InsightSynthesizer;
  private readonly slackReporter: UxSlackReporter;
  private readonly ticketStore: UxTicketStore;
  private readonly now: () => number;
  private readonly createdKeys = new Set<string>();
  private cycleInFlight = false;
  private nextRunAt = 0; // 0 → run on first tick after startup.

  constructor(opts: UxInsightsWatcherOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.hogQlClient = opts.hogQlClient ?? new HttpHogQlClient(opts.logger);
    this.synthesizer = opts.synthesizer ?? new ClaudeInsightSynthesizer(opts.logger);
    this.slackReporter = opts.slackReporter ?? new HttpUxSlackReporter(opts.logger);
    this.ticketStore = opts.ticketStore ?? new LinearTicketStore(opts.config, opts.tracker, opts.logger);
  }

  /** Periodic entry point used by the orchestrator. Gated by `enabled` and the weekly interval. */
  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return; // weekly gate

    this.cycleInFlight = true;
    try {
      let dataset: UxDataset;
      try {
        dataset = await this.hogQlClient.collect(this.cfg);
      } catch (e) {
        this.log.warn(`UX insights PostHog pull failed: ${fmtErr(e)}`);
        return; // do NOT advance nextRunAt — retry next tick.
      }

      // Only advance the weekly clock once the pull itself succeeded.
      this.nextRunAt = this.now() + this.cfg.runIntervalMs;
      await this.runPipeline(dataset);
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * One-shot pull → synthesise → report → file, bypassing `enabled` and the
   * weekly gate (but keeping dedupe + caps). Used by the `symphony-ux-insights`
   * CLI. `skipSlack`/`skipTickets` back the CLI's `--dry-run`.
   */
  async runOnce(opts: { skipSlack?: boolean; skipTickets?: boolean } = {}): Promise<UxRunResult> {
    if (this.cycleInFlight) return { report: null, created: [] };
    this.cycleInFlight = true;
    try {
      const dataset = await this.hogQlClient.collect(this.cfg);
      return await this.runPipeline(dataset, opts);
    } finally {
      this.cycleInFlight = false;
    }
  }

  private async runPipeline(
    dataset: UxDataset,
    opts: { skipSlack?: boolean; skipTickets?: boolean } = {},
  ): Promise<UxRunResult> {
    if (dataset.metrics.length === 0) {
      this.log.info("UX insights: no behavioural data in the window; skipping synthesis");
      return { report: null, created: [] };
    }

    let report: UxReport;
    try {
      report = await this.synthesizer.synthesize(dataset, this.cfg);
    } catch (e) {
      this.log.warn(`UX insights synthesis failed: ${fmtErr(e)}`);
      return { report: null, created: [] };
    }

    if (!opts.skipSlack) {
      try {
        await this.slackReporter.post(report, this.cfg);
        this.log.info("Posted weekly UX insights to Slack", { insights: report.insights.length });
      } catch (e) {
        this.log.warn(`UX insights Slack post failed: ${fmtErr(e)}`); // non-fatal; still file tickets.
      }
    }

    const created = opts.skipTickets ? [] : await this.fileTickets(report);
    return { report, created };
  }

  private async fileTickets(report: UxReport): Promise<CreatedTicket[]> {
    const created: CreatedTicket[] = [];
    const eligible = report.insights
      .filter(i => meetsTicketBar(i, this.cfg.minConfidenceToTicket))
      // Highest confidence first, so the limited budget targets the strongest insights.
      .sort(byConfidenceDesc);
    if (eligible.length === 0) {
      this.log.info("UX insights: no ticketable insights above the confidence bar this run");
      return created;
    }

    let snap: UxTicketSnapshot;
    try {
      snap = await this.ticketStore.snapshot();
    } catch (e) {
      this.log.warn(`UX insights ticket snapshot failed, skipping creation this run: ${fmtErr(e)}`);
      return created;
    }

    let openCount = snap.openCount;
    let filed = 0;
    for (const insight of eligible) {
      if (openCount >= this.cfg.maxOpenTickets) break;
      if (filed >= this.cfg.maxTicketsPerRun) break;
      const key = insightKey(insight);
      if (this.createdKeys.has(key) || snap.existingKeys.has(key)) continue;

      try {
        const ticket = await this.ticketStore.createTicket(insight, key);
        this.createdKeys.add(key);
        openCount++;
        filed++;
        created.push(ticket);
        this.log.info("Filed Linear ticket for UX insight", {
          key,
          issue: ticket.identifier,
          confidence: insight.confidence,
        });
      } catch (e) {
        this.log.warn(`Failed to file UX insight ticket for ${key}: ${fmtErr(e)}`, { key });
      }
    }
    return created;
  }

  getCreatedCount(): number {
    return this.createdKeys.size;
  }
}

// ─── Default HogQL client (PostHog query API) ───────────────────────────────

/** PostHog `HogQLQuery` responses arrive as `{ columns: string[], results: unknown[][] }`. */
export class HttpHogQlClient implements HogQlClient {
  constructor(private readonly log: Logger) {}

  async collect(config: UxInsightsConfig): Promise<UxDataset> {
    const metrics: UxMetric[] = [];
    for (const spec of buildQueryPack(config)) {
      try {
        metrics.push(...(await this.runQuery(config, spec)));
      } catch (e) {
        // One lens failing (e.g. an event name that doesn't exist yet) shouldn't
        // sink the whole report — log and carry on with the other lenses.
        this.log.warn(`UX insights query "${spec.name}" failed: ${fmtErr(e)}`);
      }
    }
    return { metrics };
  }

  private async runQuery(config: UxInsightsConfig, spec: HogQlQuerySpec): Promise<UxMetric[]> {
    const host = config.host.replace(/\/+$/, "");
    const url = `${host}/api/projects/${config.projectId}/query/`;
    const body = { query: { kind: "HogQLQuery", query: spec.hogql } };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = await response.text(); } catch { /* ignore */ }
      throw new Error(`PostHog query HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as { columns?: unknown; results?: unknown };
    const columns = Array.isArray(payload.columns) ? payload.columns.map(String) : [];
    const results = Array.isArray(payload.results) ? (payload.results as unknown[][]) : [];
    return rowsToMetrics(spec.category, columns, results);
  }
}

// ─── Default synthesizer (headless Claude) ──────────────────────────────────

/** Spawns `claude -p`, feeds the synthesis prompt, and parses the structured output. */
export class ClaudeInsightSynthesizer implements InsightSynthesizer {
  constructor(private readonly log: Logger) {}

  synthesize(dataset: UxDataset, config: UxInsightsConfig): Promise<UxReport> {
    const prompt = buildSynthesisPrompt(dataset, config);
    return new Promise((resolve, reject) => {
      const proc = spawn(
        "claude",
        [
          "-p",
          "--max-turns", String(config.synthesisMaxTurns),
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
        ],
        { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
      );

      let settled = false;
      const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
      const texts: string[] = [];

      proc.stdin.write(prompt, "utf-8");
      proc.stdin.end();

      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", line => {
        const t = extractAssistantText(line);
        if (t) texts.push(t);
      });
      proc.stderr.on("data", () => { /* drain */ });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 2000);
        settle(() => reject(new Error(`synthesis timeout after ${config.synthesisTimeoutMs}ms`)));
      }, config.synthesisTimeoutMs);

      proc.on("close", code => {
        clearTimeout(timer);
        rl.close();
        settle(() => {
          if (code !== 0) return reject(new Error(`claude exited with code ${code ?? "null"}`));
          try {
            resolve(parseSynthesisOutput(texts.join("")));
          } catch (e) {
            reject(e as Error);
          }
        });
      });
      proc.on("error", e => { clearTimeout(timer); settle(() => reject(e)); });
    });
  }
}

/** Pull assistant text out of one `claude --output-format stream-json` line. Best-effort. */
export function extractAssistantText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let evt: unknown;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof evt !== "object" || evt === null) return null;
  const e = evt as Record<string, unknown>;
  if (e.type !== "assistant") return null;
  const message = e.message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) return null;
  const parts: string[] = [];
  for (const block of message.content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.length ? parts.join("") : null;
}

// ─── Default Slack reporter ─────────────────────────────────────────────────

/** Posts the weekly report via the shared, retry-hardened Slack sender in notifications.ts. */
export class HttpUxSlackReporter implements UxSlackReporter {
  constructor(private readonly log: Logger) {}

  async post(report: UxReport, config: UxInsightsConfig): Promise<void> {
    if (!config.slackBotToken || config.slackChannels.length === 0) {
      this.log.warn("UX insights: Slack not configured (bot token / channels missing); skipping report post");
      return;
    }
    const payload = buildSlackReport(report, config.minConfidenceToTicket);

    // Post to every configured channel. One channel failing (e.g. the bot isn't a
    // member) must not stop the others, so failures are collected; we only throw if
    // every channel failed, so the watcher's non-fatal catch logs a real outage.
    const failures: string[] = [];
    for (const channel of config.slackChannels) {
      const body = JSON.stringify({ channel, ...payload });
      try {
        await postToSlackWithRetry(config.slackBotToken, body, this.log, `UX insights report (${channel})`);
      } catch (e) {
        failures.push(channel);
        this.log.warn(`UX insights: failed to post report to ${channel}: ${fmtErr(e)}`);
      }
    }
    if (failures.length === config.slackChannels.length) {
      throw new Error(`UX insights: report post failed for all ${failures.length} channel(s): ${failures.join(", ")}`);
    }
  }
}

// ─── Default Linear ticket store (reuses src/linear.ts) ─────────────────────

interface ResolvedRefs {
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  labelId: string | null;
}

class LinearTicketStore implements UxTicketStore {
  private refs: ResolvedRefs | null = null;
  private readonly terminalStatesLower: Set<string>;

  constructor(
    private readonly cfg: UxInsightsConfig,
    private readonly tracker: TrackerConfig,
    private readonly log: Logger,
  ) {
    this.terminalStatesLower = new Set(tracker.terminalStates.map(s => s.toLowerCase()));
  }

  async snapshot(): Promise<UxTicketSnapshot> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const existingKeys = new Set<string>();
    let openCount = 0;
    for (const issue of issues) {
      const key = extractInsightKey(issue.description);
      if (key) existingKeys.add(key);
      if (!this.terminalStatesLower.has(issue.state.toLowerCase())) openCount++;
    }
    return { existingKeys, openCount };
  }

  async createTicket(insight: Insight, key: string): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      assigneeId: refs.assigneeId ?? undefined,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildTicketTitle(insight),
      description: buildTicketDescription(insight, key),
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
      if (user) assigneeId = user.id;
      else this.log.warn(`UX insights assignee "${this.cfg.assigneeEmail}" not found in Linear; filing unassigned`);
    }

    let labelId: string | null = null;
    if (this.cfg.label) {
      labelId = await linear.resolveOrCreateLabelId(this.tracker, team.id, this.cfg.label);
    }

    this.refs = { teamId: team.id, stateId: state.id, assigneeId, labelId };
    return this.refs;
  }
}

// ─── small helpers ──────────────────────────────────────────────────────────

function firstLine(value: string): string {
  const line = value.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? "";
  return truncate(line, 240);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
