import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface TriageConfig {
  enabled: boolean;
  teamKey: string;
  triageState: string;
  /** Lane for clear, buildable bugs and machine signals. */
  devState: string;
  /** Lane for features / design work. */
  backlogState: string;
  duplicateState: string;
  runIntervalMs: number;
  /** Max triage issues acted on (moved, deduped or asked about) per run. */
  maxPerRun: number;
  /** JSON file remembering which issues were already sent to `onUnclear`. */
  statePath: string;
  /** 0..1 — below this the issue is left in Triage and `onUnclear` is called. */
  confidenceThreshold: number;
}

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  enabled: false,
  teamKey: "TEA",
  triageState: "Triage",
  devState: "Dev in Progress",
  backlogState: "Backlog",
  duplicateState: "Duplicate",
  runIntervalMs: 4 * 60 * 60 * 1000,
  maxPerRun: 20,
  statePath: ".symphony-triage.json",
  confidenceThreshold: 0.7,
};

export function triageConfigWithDefaults(overrides: Partial<TriageConfig> = {}): TriageConfig {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_TRIAGE_CONFIG, ...defined };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TriageIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
  priority: number;
  state: string;
  url: string | null;
}

export interface OpenIssueRef {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
}

export type TriagePriority = 1 | 2 | 3 | 4;
export type TriageLane = "dev" | "backlog";

export interface TriageScore {
  priority: TriagePriority;
  lane: TriageLane | null;
  /** 0..1 */
  confidence: number;
  reasons: string[];
}

export interface TriageSuggestion {
  priority: TriagePriority;
  lane: TriageLane | null;
  /** Target state name for the lane (null when no lane could be picked). */
  state: string | null;
  confidence: number;
  reasons: string[];
}

export type OnUnclear = (issue: TriageIssue, suggestion: TriageSuggestion) => void | Promise<void>;

// ─── Pure scoring ───────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "it", "at", "by", "with", "from",
  "be", "are", "was", "this", "that", "when", "not", "no", "i", "we", "our", "my", "page", "issue",
]);

export function titleTokens(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // "[Firebase Logs]" style prefixes
    .replace(/\(\d+×\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ");
  return new Set(cleaned.split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t)));
}

/** Token Jaccard similarity of two normalised titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function findDuplicate(
  issue: Pick<TriageIssue, "id" | "title">,
  candidates: OpenIssueRef[],
  threshold = 0.6,
): { original: OpenIssueRef; similarity: number } | null {
  let best: { original: OpenIssueRef; similarity: number } | null = null;
  for (const c of candidates) {
    if (c.id === issue.id) continue;
    const s = titleSimilarity(issue.title, c.title);
    if (s >= threshold && (!best || s > best.similarity)) best = { original: c, similarity: s };
  }
  return best;
}

const MACHINE_LABELS = ["firebase-logs", "render-logs", "posthog", "dependabot"];
const CUSTOMER_LABELS = ["bug", "slack-intake"];
const FEATURE_LABELS = ["feature", "design needed", "enhancement", "improvement", "feature request"];

const URGENT_RE =
  /\boutage\b|\b(?:site|app|server|website|api|platform|everything)\s+(?:is\s+|went\s+)?down\b|\bcan'?t log ?in\b|\bcannot log ?in\b|\bunable to log ?in\b|\blog ?in (?:is )?broken\b|\bpayments? (?:failed|failing|declined|broken|not working)\b|\bdata loss\b|\blost (?:all )?(?:their |the |our )?data\b|\ball users\b|\b500 (?:error )?on checkout\b|\bcheckout\b[^.\n]{0,40}\b500\b/i;
const LOW_RE = /\btypos?\b|\bcosmetic\b|\bcopy\b|\bwording\b|\bspelling\b|\bmisaligned\b|\balignment\b|\bpadding\b/i;
const CUSTOMER_RE = /\b(?:customers?|learners?|clients?|students?)\b/i;
const BUG_RE =
  /\berrors?\b|\bbroken\b|\bbug\b|\bnot working\b|\bcrash(?:es|ed)?\b|\bfail(?:s|ed|ing)?\b|\bexception\b|\b50\d\b|\bdoesn'?t work\b|\bblank\b|\bstuck\b/i;
const FEATURE_RE =
  /\bfeature request\b|\bwould be (?:nice|great|good)\b|\bcould we\b|\bcan we (?:add|have|get)\b|\bability to\b|\benhancement\b|\bsuggestion\b|\bnew (?:feature|page|section|option)\b|\bredesign\b|\bmock-?ups?\b|\bdesign needed\b/i;
const REPRO_RE =
  /steps to reproduce|\brepro(?:duction)? steps\b|\bto reproduce:|\brepro:|\bexpected(?: behaviou?r| result)?\s*:|\bactual(?: behaviou?r| result)?\s*:|^\s*(?:1[.)]\s|step 1\b)/im;

function hasLabel(issue: Pick<TriageIssue, "labels">, names: string[]): string | null {
  const lower = issue.labels.map(l => l.toLowerCase());
  return names.find(n => lower.includes(n)) ?? null;
}

/**
 * Deterministic triage score: priority, lane and a 0..1 confidence with reasons.
 * Does not check duplicates (that needs the open-issue corpus — see findDuplicate).
 */
export function scoreTriage(issue: Pick<TriageIssue, "title" | "description" | "labels">): TriageScore {
  const text = `${issue.title}\n${issue.description}`;
  const reasons: string[] = [];

  // Priority
  const machine = hasLabel(issue, MACHINE_LABELS);
  const customerLabel = hasLabel(issue, CUSTOMER_LABELS);
  const urgent = URGENT_RE.test(text);
  const cosmetic = LOW_RE.test(text);
  const customerWords = CUSTOMER_RE.test(text);
  let priority: TriagePriority;
  if (urgent) {
    priority = 1;
    reasons.push("urgent signal (outage / login / payment / data loss / all users)");
  } else if (cosmetic) {
    priority = 4;
    reasons.push("cosmetic / copy change");
  } else if (customerLabel || customerWords) {
    priority = 2;
    reasons.push(customerLabel ? `customer-reported (label ${customerLabel})` : "mentions customers/learners/clients");
  } else {
    priority = 3;
    reasons.push("default priority");
  }

  // Lane
  const featureLabel = hasLabel(issue, FEATURE_LABELS);
  const featureWords = FEATURE_RE.test(text);
  const isFeature = !!featureLabel || featureWords;
  const isBug = !!hasLabel(issue, ["bug"]) || BUG_RE.test(text) || urgent;
  const hasRepro = REPRO_RE.test(issue.description);
  const descLen = issue.description.trim().length;

  let lane: TriageLane | null = null;
  let confidence = 0.5;
  if (machine) {
    lane = "dev";
    confidence = 0.95;
    reasons.push(`machine signal (label ${machine})`);
  } else if (featureLabel && !isBug) {
    lane = "backlog";
    confidence = 0.85;
    reasons.push(`feature/design (label ${featureLabel})`);
  } else if (isBug && hasRepro && !isFeature) {
    lane = "dev";
    confidence = 0.85;
    reasons.push("clear bug with repro steps");
  } else if (urgent && !isFeature) {
    lane = "dev";
    confidence = 0.75;
    reasons.push("urgent bug");
  } else if (isFeature && !isBug) {
    lane = "backlog";
    confidence = 0.75;
    reasons.push("reads as a feature request");
  } else if (isBug && isFeature) {
    lane = featureLabel ? "backlog" : "dev";
    confidence = 0.4;
    reasons.push("mixed signals: bug and feature");
  } else if (isBug) {
    lane = "dev";
    confidence = 0.55;
    reasons.push("bug without repro steps");
  } else {
    lane = null;
    confidence = 0.25;
    reasons.push("no clear bug or feature signal");
  }

  if (!machine) {
    if (descLen < 40) {
      confidence -= 0.25;
      reasons.push("very short description");
    }
    if (urgent && cosmetic) {
      confidence -= 0.2;
      reasons.push("mixed signals: urgent and cosmetic");
    } else if (cosmetic && (customerLabel || customerWords)) {
      confidence -= 0.05;
    }
  }

  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  return { priority, lane, confidence, reasons };
}

// ─── Tracker abstraction ────────────────────────────────────────────────────

export interface TriageTracker {
  fetchTriageIssues(): Promise<TriageIssue[]>;
  /** Open (non-terminal) issues outside Triage — the dedup corpus. */
  fetchOpenIssues(): Promise<OpenIssueRef[]>;
  /** `state` is a workflow-state *name*. */
  updateIssue(issueId: string, update: { priority?: number; state?: string }): Promise<void>;
  /** Links `issueId` as a duplicate of `originalId` (best-effort). */
  markDuplicate(issueId: string, originalId: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}

const ISSUE_FIELDS = `id identifier title description priority url state { name } labels { nodes { name } }`;

const TRIAGE_ISSUES_QUERY = `
  query TriageIssues($teamKey: String!, $state: String!, $first: Int!, $after: String) {
    issues(
      filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $state } } }
      first: $first
      after: $after
      orderBy: createdAt
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const OPEN_ISSUES_QUERY = `
  query OpenIssues($teamKey: String!, $triage: String!, $first: Int!, $after: String) {
    issues(
      filter: {
        team: { key: { eq: $teamKey } }
        state: { type: { nin: ["completed", "canceled"] }, name: { neq: $triage } }
      }
      first: $first
      after: $after
      orderBy: updatedAt
    ) {
      nodes { id identifier title url }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation TriageIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

const RELATION_CREATE_MUTATION = `
  mutation TriageRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success }
  }
`;

const ISSUE_TEAM_QUERY = `
  query TriageIssueTeam($id: String!) {
    issue(id: $id) { id team { id key } }
  }
`;

interface RawIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  state: { name: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
}

interface IssuesPage<N> {
  issues: { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

async function paginate<N>(
  tracker: TrackerConfig,
  query: string,
  vars: Record<string, unknown>,
  maxPages: number,
): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const v: Record<string, unknown> = { ...vars, first: 50 };
    if (after) v.after = after;
    const data = (await linear.executeGraphQL(tracker, query, v)) as IssuesPage<N>;
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }
  return out;
}

async function issueUpdate(tracker: TrackerConfig, id: string, input: Record<string, unknown>): Promise<void> {
  const data = (await linear.executeGraphQL(tracker, ISSUE_UPDATE_MUTATION, { id, input })) as {
    issueUpdate: { success: boolean } | null;
  };
  if (!data?.issueUpdate?.success) throw new Error(`Linear issueUpdate did not report success for ${id}`);
}

async function resolveStateId(
  tracker: TrackerConfig,
  teamId: string,
  name: string,
  cache?: Map<string, string>,
): Promise<string> {
  const key = `${teamId}:${name.toLowerCase()}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const states = await linear.fetchWorkflowStates(tracker, teamId);
  for (const s of states) cache?.set(`${teamId}:${s.name.toLowerCase()}`, s.id);
  const match = states.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`Linear workflow state "${name}" not found`);
  return match.id;
}

export class LinearTriageTracker implements TriageTracker {
  private teamId: string | null = null;
  private readonly stateIds = new Map<string, string>();

  constructor(
    private readonly cfg: TriageConfig,
    private readonly tracker: TrackerConfig,
  ) {}

  async fetchTriageIssues(): Promise<TriageIssue[]> {
    const nodes = await paginate<RawIssueNode>(
      this.tracker,
      TRIAGE_ISSUES_QUERY,
      { teamKey: this.cfg.teamKey, state: this.cfg.triageState },
      10,
    );
    return nodes.map(n => ({
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      description: n.description ?? "",
      labels: n.labels?.nodes.map(l => l.name) ?? [],
      priority: n.priority ?? 0,
      state: n.state?.name ?? "",
      url: n.url,
    }));
  }

  async fetchOpenIssues(): Promise<OpenIssueRef[]> {
    // ~500 most recently updated open issues is plenty of corpus for title dedup.
    return paginate<OpenIssueRef>(
      this.tracker,
      OPEN_ISSUES_QUERY,
      { teamKey: this.cfg.teamKey, triage: this.cfg.triageState },
      10,
    );
  }

  async updateIssue(issueId: string, update: { priority?: number; state?: string }): Promise<void> {
    const input: Record<string, unknown> = {};
    if (update.priority !== undefined) input.priority = update.priority;
    if (update.state) input.stateId = await resolveStateId(this.tracker, await this.team(), update.state, this.stateIds);
    if (Object.keys(input).length === 0) return;
    await issueUpdate(this.tracker, issueId, input);
  }

  async markDuplicate(issueId: string, originalId: string): Promise<void> {
    const data = (await linear.executeGraphQL(this.tracker, RELATION_CREATE_MUTATION, {
      input: { issueId, relatedIssueId: originalId, type: "duplicate" },
    })) as { issueRelationCreate: { success: boolean } | null };
    if (!data?.issueRelationCreate?.success) throw new Error("Linear issueRelationCreate did not report success");
  }

  addComment(issueId: string, body: string): Promise<void> {
    return linear.addComment(this.tracker, issueId, body);
  }

  private async team(): Promise<string> {
    if (this.teamId) return this.teamId;
    const team = await linear.fetchTeamByKey(this.tracker, this.cfg.teamKey);
    if (!team) throw new Error(`Linear team not found for key "${this.cfg.teamKey}"`);
    this.teamId = team.id;
    return team.id;
  }
}

function isTriageTracker(t: TrackerConfig | TriageTracker): t is TriageTracker {
  return typeof (t as TriageTracker).updateIssue === "function";
}

/**
 * Applies a (confirmed) triage suggestion — used by the "Triage decision" card's
 * Confirm button. Accepts either a TrackerConfig (resolves the issue's team and
 * state id itself) or a TriageTracker.
 */
export async function applyTriageDecision(
  tracker: TrackerConfig | TriageTracker,
  issueId: string,
  decision: { priority?: number; state?: string },
): Promise<void> {
  if (isTriageTracker(tracker)) {
    await tracker.updateIssue(issueId, decision);
    return;
  }
  const input: Record<string, unknown> = {};
  if (decision.priority !== undefined) input.priority = decision.priority;
  if (decision.state) {
    const data = (await linear.executeGraphQL(tracker, ISSUE_TEAM_QUERY, { id: issueId })) as {
      issue: { id: string; team: { id: string } | null } | null;
    };
    const teamId = data?.issue?.team?.id;
    if (!teamId) throw new Error(`Could not resolve team for issue ${issueId}`);
    input.stateId = await resolveStateId(tracker, teamId, decision.state);
  }
  if (Object.keys(input).length === 0) return;
  await issueUpdate(tracker, issueId, input);
}

// ─── Watcher ────────────────────────────────────────────────────────────────

export interface TriageWatcherOptions {
  config: TriageConfig;
  tracker: TrackerConfig;
  logger: Logger;
  /** Called for issues the rules can't decide confidently; Symphony turns it into a "Triage decision" card. */
  onUnclear?: OnUnclear;
  triageTracker?: TriageTracker;
  now?: () => number;
}

export interface TriageRunResult {
  duplicates: string[];
  moved: Array<{ identifier: string; priority: number; state: string }>;
  unclear: string[];
}

const PRIORITY_NAMES: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };
const MAX_ASKED = 1000;

/**
 * Rule-based triage over the Triage state: dedup → priority → lane. Confident
 * results are applied (priority + state + an explanatory comment); unclear ones
 * stay in Triage and are handed to `onUnclear` once (remembered in `statePath`).
 * An existing non-zero priority set by a human is kept.
 */
export class TriageWatcher {
  private readonly cfg: TriageConfig;
  private readonly log: Logger;
  private readonly tt: TriageTracker;
  private readonly onUnclear: OnUnclear | undefined;
  private readonly now: () => number;
  private cycleInFlight = false;
  private nextRunAt = 0;

  constructor(opts: TriageWatcherOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.onUnclear = opts.onUnclear;
    this.now = opts.now ?? (() => Date.now());
    this.tt = opts.triageTracker ?? new LinearTriageTracker(opts.config, opts.tracker);
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return;
    this.cycleInFlight = true;
    try {
      const res = await this.run();
      if (res) this.nextRunAt = this.now() + this.cfg.runIntervalMs;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** One-shot pass, bypassing `enabled` and the interval gate. */
  async runOnce(): Promise<TriageRunResult | null> {
    if (this.cycleInFlight) return null;
    this.cycleInFlight = true;
    try {
      return await this.run();
    } finally {
      this.cycleInFlight = false;
    }
  }

  stateLabel(lane: TriageLane | null): string | null {
    if (lane === "dev") return this.cfg.devState;
    if (lane === "backlog") return this.cfg.backlogState;
    return null;
  }

  private async run(): Promise<TriageRunResult | null> {
    let triage: TriageIssue[];
    let open: OpenIssueRef[];
    try {
      [triage, open] = await Promise.all([this.tt.fetchTriageIssues(), this.tt.fetchOpenIssues()]);
    } catch (e) {
      this.log.warn(`Triage: fetching issues failed: ${fmtErr(e)}`);
      return null;
    }

    const state = readState(this.cfg.statePath);
    const asked = new Set(state.asked);
    const result: TriageRunResult = { duplicates: [], moved: [], unclear: [] };
    let acted = 0;

    for (const issue of triage) {
      if (acted >= this.cfg.maxPerRun) break;

      // (a) dedup
      const dup = findDuplicate(issue, open);
      if (dup) {
        acted++;
        try {
          await this.markDuplicate(issue, dup.original, dup.similarity);
          result.duplicates.push(issue.identifier);
        } catch (e) {
          this.log.warn(`Triage: failed to mark ${issue.identifier} duplicate: ${fmtErr(e)}`);
        }
        continue;
      }

      // (b)+(c)
      const score = scoreTriage(issue);
      const targetState = this.stateLabel(score.lane);
      const priority = issue.priority > 0 ? issue.priority : score.priority;

      if (targetState && score.confidence >= this.cfg.confidenceThreshold) {
        acted++;
        try {
          await this.tt.updateIssue(issue.id, { priority, state: targetState });
          await this.tt
            .addComment(issue.id, buildTriageComment(priority, targetState, score))
            .catch(e => this.log.warn(`Triage: comment failed on ${issue.identifier}: ${fmtErr(e)}`));
          result.moved.push({ identifier: issue.identifier, priority, state: targetState });
          // Corpus grows so later triage items dedup against this one too.
          open.push({ id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url });
          this.log.info("Triage: moved issue", { issue: issue.identifier, priority, state: targetState });
        } catch (e) {
          this.log.warn(`Triage: failed to update ${issue.identifier}: ${fmtErr(e)}`);
        }
        continue;
      }

      // (d) unclear
      if (asked.has(issue.id) || !this.onUnclear) continue;
      acted++;
      try {
        await this.onUnclear(issue, {
          priority: score.priority,
          lane: score.lane,
          state: targetState,
          confidence: score.confidence,
          reasons: score.reasons,
        });
        asked.add(issue.id);
        result.unclear.push(issue.identifier);
      } catch (e) {
        this.log.warn(`Triage: onUnclear failed for ${issue.identifier}: ${fmtErr(e)}`);
      }
    }

    // Drop remembered ids that have left Triage, then cap.
    const stillInTriage = new Set(triage.map(i => i.id));
    const keep = [...asked].filter(id => stillInTriage.has(id)).slice(-MAX_ASKED);
    writeState(this.cfg.statePath, { asked: keep }, this.log);
    return result;
  }

  private async markDuplicate(issue: TriageIssue, original: OpenIssueRef, similarity: number): Promise<void> {
    await this.tt.updateIssue(issue.id, { state: this.cfg.duplicateState });
    try {
      await this.tt.markDuplicate(issue.id, original.id);
    } catch (e) {
      this.log.warn(`Triage: duplicate relation failed for ${issue.identifier} (comment only): ${fmtErr(e)}`);
    }
    const link = original.url ? `[${original.identifier}](${original.url})` : original.identifier;
    await this.tt
      .addComment(
        issue.id,
        `Symphony triage: looks like a duplicate of ${link} (title similarity ${Math.round(similarity * 100)}%). ` +
          `Moved to ${this.cfg.duplicateState}. Reopen if this is a different problem.`,
      )
      .catch(e => this.log.warn(`Triage: comment failed on ${issue.identifier}: ${fmtErr(e)}`));
    this.log.info("Triage: marked duplicate", { issue: issue.identifier, original: original.identifier });
  }
}

export function buildTriageComment(priority: number, state: string, score: TriageScore): string {
  return [
    `Symphony triage: **${PRIORITY_NAMES[priority] ?? priority}** priority → **${state}** (confidence ${Math.round(score.confidence * 100)}%).`,
    "",
    ...score.reasons.map(r => `- ${r}`),
  ].join("\n");
}

// ─── State file ─────────────────────────────────────────────────────────────

interface TriageState {
  asked: string[];
}

function readState(file: string): TriageState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<TriageState>;
    return { asked: Array.isArray(parsed.asked) ? parsed.asked.filter(x => typeof x === "string") : [] };
  } catch {
    return { asked: [] };
  }
}

function writeState(file: string, state: TriageState, log: Logger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn(`Triage: failed to persist state: ${fmtErr(e)}`);
  }
}

function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
