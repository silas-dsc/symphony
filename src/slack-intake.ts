import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface SlackIntakeConfig {
  enabled: boolean;
  /** Slack channel ids to read (e.g. `#dsc-website` = C0A07RQJXP1). */
  channels: string[];
  /** When non-empty, only messages from these Slack user ids are considered. */
  reporterUserIds: string[];
  teamKey: string;
  /** Workflow state new tickets land in. */
  targetState: string;
  label: string;
  runIntervalMs: number;
  maxTicketsPerRun: number;
  /** JSON file holding the per-channel read cursor. */
  statePath: string;
  /** Slack bot token (xoxb-…) with `channels:history` (+ `groups:history` for private) scope. */
  botToken: string;
  /** Minimum keyword score for a message to count as a problem report. */
  minScore: number;
}

export const DEFAULT_SLACK_INTAKE_CONFIG: SlackIntakeConfig = {
  enabled: false,
  channels: ["C0A07RQJXP1"],
  reporterUserIds: [],
  teamKey: "TEA",
  targetState: "Triage",
  label: "slack-intake",
  runIntervalMs: 30 * 60 * 1000,
  maxTicketsPerRun: 5,
  statePath: ".symphony-slack-intake.json",
  botToken: "",
  minScore: 2,
};

/** Fills unset fields from the defaults; `botToken` falls back to `$SLACK_BOT_TOKEN`. */
export function slackIntakeConfigWithDefaults(
  overrides: Partial<SlackIntakeConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): SlackIntakeConfig {
  const cfg = { ...DEFAULT_SLACK_INTAKE_CONFIG, ...stripUndefined(overrides) };
  if (!cfg.botToken) cfg.botToken = env.SLACK_BOT_TOKEN ?? "";
  return cfg;
}

// ─── Slack client ───────────────────────────────────────────────────────────

export interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
  threadTs?: string;
  botId?: string;
  subtype?: string;
}

/** Reads channel history. Injected so tests don't call Slack. */
export interface SlackHistoryClient {
  /** Messages strictly newer than `oldestTs` (any order). */
  history(channel: string, oldestTs: string): Promise<SlackMessage[]>;
  permalink(channel: string, ts: string): Promise<string | null>;
}

type FetchFn = typeof fetch;

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: Array<{
    ts?: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  }>;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/** Default client: Slack Web API `conversations.history` + `chat.getPermalink` with a bot token. */
export class SlackWebHistoryClient implements SlackHistoryClient {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly maxPages = 10,
  ) {}

  async history(channel: string, oldestTs: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const params = new URLSearchParams({ channel, oldest: oldestTs, limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const data = await this.call<SlackHistoryResponse>("conversations.history", params);
      if (!data.ok) throw new Error(`Slack conversations.history failed: ${data.error ?? "unknown error"}`);
      for (const m of data.messages ?? []) {
        if (typeof m.ts !== "string") continue;
        out.push({
          ts: m.ts,
          user: m.user,
          text: typeof m.text === "string" ? m.text : "",
          threadTs: m.thread_ts,
          botId: m.bot_id,
          subtype: m.subtype,
        });
      }
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!data.has_more || !cursor) break;
    }
    return out;
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      const data = await this.call<{ ok: boolean; permalink?: string }>(
        "chat.getPermalink",
        new URLSearchParams({ channel, message_ts: ts }),
      );
      return data.ok && typeof data.permalink === "string" ? data.permalink : null;
    } catch {
      return null;
    }
  }

  private async call<T>(method: string, params: URLSearchParams): Promise<T> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Keyword → weight. Strong signals score 2, weaker ones 1. Deterministic, no model call. */
export const PROBLEM_KEYWORDS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\berrors?\b/i, weight: 2, label: "error" },
  { re: /\bbroken\b|\bbroke\b/i, weight: 2, label: "broken" },
  { re: /\bbugs?\b|\bbuggy\b/i, weight: 2, label: "bug" },
  { re: /\bnot (?:working|loading|showing|saving|sending|opening)\b/i, weight: 2, label: "not working" },
  { re: /\bcrash(?:es|ed|ing)?\b/i, weight: 2, label: "crash" },
  { re: /\b50[0-4]\b/, weight: 1, label: "500" },
  { re: /\bfail(?:s|ed|ing|ure)?\b/i, weight: 2, label: "failed" },
  { re: /\bcan'?t\b|\bcannot\b|\bcan’t\b|\bunable to\b/i, weight: 1, label: "can't" },
  { re: /\bdoesn'?t\b|\bdoesn’t\b|\bdon'?t\b|\bwon'?t\b|\bisn'?t\b/i, weight: 1, label: "doesn't" },
  { re: /\bissues?\b|\bproblems?\b/i, weight: 1, label: "issue" },
  { re: /\bblank\b|\bempty page\b|\bwhite screen\b/i, weight: 1, label: "blank" },
  { re: /\bstuck\b|\bfrozen\b|\bhangs?\b|\bspinning\b/i, weight: 1, label: "stuck" },
  { re: /\bwrong\b|\bincorrect\b/i, weight: 1, label: "wrong" },
  { re: /\bmissing\b|\bdisappeared\b|\bgone\b/i, weight: 1, label: "missing" },
  { re: /\bcomplain(?:t|ts|ed|ing)?\b/i, weight: 1, label: "complaint" },
  {
    re: /\b(?:customer|learner|student|client|user)s? (?:said|says|reported|emailed|called|mentioned|can'?t|cannot)\b/i,
    weight: 2,
    label: "customer said",
  },
];

export function scoreProblemReport(text: string): { score: number; matches: string[] } {
  let score = 0;
  const matches: string[] = [];
  for (const k of PROBLEM_KEYWORDS) {
    if (k.re.test(text)) {
      score += k.weight;
      matches.push(k.label);
    }
  }
  return { score, matches };
}

/** True when the message already references a Linear ticket (link or `TEA-123`). */
export function referencesTicket(text: string): boolean {
  return /linear\.app\//i.test(text) || /\bTEA-\d+\b/i.test(text);
}

/** Slack mrkdwn → plain text: `<@U1>` → `@U1`, `<url|label>` → `label`, `<url>` → `url`, entities decoded. */
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function slackMarker(channel: string, ts: string): string {
  return `<!-- symphony-slack:${channel}:${ts} -->`;
}

const MARKER_RE = /<!--\s*symphony-slack:([^:\s]+):([\d.]+)\s*-->/g;

/** All `channel:ts` keys found in a ticket description. */
export function extractSlackKeys(description: string): string[] {
  return [...description.matchAll(MARKER_RE)].map(m => `${m[1]}:${m[2]}`);
}

/** First sentence (or line) of the message, trimmed to 80 chars. */
export function buildSlackTicketTitle(text: string): string {
  const clean = cleanSlackText(text).replace(/[*_~`]/g, "");
  const firstLine = clean.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  const m = firstLine.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = (m ? m[1] : firstLine).trim();
  return truncate(sentence || "Slack problem report", 80);
}

export interface SlackTicketDraft {
  channel: string;
  ts: string;
  user: string | null;
  text: string;
  permalink: string | null;
  score: number;
  matches: string[];
}

export function buildSlackTicketDescription(d: SlackTicketDraft): string {
  const quoted = truncate(cleanSlackText(d.text), 4000)
    .split("\n")
    .map(l => `> ${l}`)
    .join("\n");
  return [
    slackMarker(d.channel, d.ts),
    "_Drafted by Symphony from a Slack problem report. Triage: confirm it's a real problem, find out how to reproduce it, set priority._",
    "",
    "## Report",
    quoted,
    "",
    "## Source",
    `- **Reporter:** ${d.user ? `Slack user \`${d.user}\`` : "unknown"}`,
    `- **Channel:** \`${d.channel}\``,
    `- **Message:** ${d.permalink ?? `ts ${d.ts}`}`,
    `- **Problem signals:** ${d.matches.join(", ") || "—"} (score ${d.score})`,
  ].join("\n");
}

/** Slack ts strings ("1730700000.123456") compared numerically. */
export function tsGreater(a: string, b: string): boolean {
  return Number(a) > Number(b);
}

// ─── Ticket store ───────────────────────────────────────────────────────────

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

export interface SlackIntakeTicketStore {
  /** `channel:ts` keys already filed (any state — a closed report is never re-filed). */
  existingKeys(): Promise<Set<string>>;
  createTicket(draft: SlackTicketDraft): Promise<CreatedTicket>;
}

export class LinearSlackTicketStore implements SlackIntakeTicketStore {
  private refs: { teamId: string; stateId: string; labelId: string | null } | null = null;

  constructor(
    private readonly cfg: SlackIntakeConfig,
    private readonly tracker: TrackerConfig,
  ) {}

  async existingKeys(): Promise<Set<string>> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const keys = new Set<string>();
    for (const issue of issues) for (const k of extractSlackKeys(issue.description)) keys.add(k);
    return keys;
  }

  async createTicket(draft: SlackTicketDraft): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildSlackTicketTitle(draft.text),
      description: buildSlackTicketDescription(draft),
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

interface SlackIntakeState {
  /** channel id → last processed message ts. */
  cursors: Record<string, string>;
}

export interface SlackIntakeWatcherOptions {
  config: SlackIntakeConfig;
  tracker: TrackerConfig;
  logger: Logger;
  historyClient?: SlackHistoryClient;
  ticketStore?: SlackIntakeTicketStore;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Reads new messages in the configured Slack channels, keeps the ones that look
 * like problem reports (deterministic keyword score) and don't already reference
 * a ticket, and drafts a Linear ticket into Triage for each.
 *
 * Mirrors FirebaseLogsWatcher: `reconcile()` is called every poll tick and gated
 * by `runIntervalMs`; dedupe is a marker in the ticket description (survives
 * restarts); a per-channel ts cursor in `statePath` means each message is read once.
 * On first run for a channel the cursor starts one run interval back, so history
 * is not back-filled.
 */
export class SlackIntakeWatcher {
  private readonly cfg: SlackIntakeConfig;
  private readonly log: Logger;
  private readonly client: SlackHistoryClient;
  private readonly store: SlackIntakeTicketStore;
  private readonly now: () => number;
  private readonly reporters: Set<string>;
  private cycleInFlight = false;
  private nextRunAt = 0;

  constructor(opts: SlackIntakeWatcherOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.client = opts.historyClient ?? new SlackWebHistoryClient(opts.config.botToken);
    this.store = opts.ticketStore ?? new LinearSlackTicketStore(opts.config, opts.tracker);
    this.reporters = new Set(opts.config.reporterUserIds);
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    if (this.now() < this.nextRunAt) return;
    this.cycleInFlight = true;
    try {
      const ok = await this.scan();
      if (ok) this.nextRunAt = this.now() + this.cfg.runIntervalMs;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** One-shot scan, bypassing `enabled` and the interval gate. */
  async runOnce(): Promise<CreatedTicket[]> {
    if (this.cycleInFlight) return [];
    this.cycleInFlight = true;
    try {
      const created: CreatedTicket[] = [];
      await this.scan(created);
      return created;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** Returns false when the scan could not run at all (so the interval clock isn't advanced). */
  private async scan(created: CreatedTicket[] = []): Promise<boolean> {
    let existing: Set<string>;
    try {
      existing = await this.store.existingKeys();
    } catch (e) {
      this.log.warn(`Slack intake: ticket snapshot failed, skipping run: ${fmtErr(e)}`);
      return false;
    }

    const state = readState(this.cfg.statePath);
    const defaultOldest = ((this.now() - this.cfg.runIntervalMs) / 1000).toFixed(6);
    let filed = 0;
    let anyChannelOk = false;

    for (const channel of this.cfg.channels) {
      if (filed >= this.cfg.maxTicketsPerRun) break;
      const oldest = state.cursors[channel] ?? defaultOldest;
      let messages: SlackMessage[];
      try {
        messages = await this.client.history(channel, oldest);
      } catch (e) {
        this.log.warn(`Slack intake: history read failed for ${channel}: ${fmtErr(e)}`);
        continue;
      }
      anyChannelOk = true;
      messages = messages.filter(m => tsGreater(m.ts, oldest)).sort((a, b) => Number(a.ts) - Number(b.ts));

      let cursor = oldest;
      for (const msg of messages) {
        const candidate = this.candidate(msg);
        if (candidate) {
          const key = `${channel}:${msg.ts}`;
          if (!existing.has(key)) {
            if (filed >= this.cfg.maxTicketsPerRun) break; // leave cursor here; pick up next run
            const permalink = await this.client.permalink(channel, msg.ts).catch(() => null);
            try {
              const ticket = await this.store.createTicket({
                channel,
                ts: msg.ts,
                user: msg.user ?? null,
                text: msg.text,
                permalink,
                score: candidate.score,
                matches: candidate.matches,
              });
              existing.add(key);
              filed++;
              created.push(ticket);
              this.log.info("Slack intake: drafted Triage ticket", { issue: ticket.identifier, channel, ts: msg.ts });
            } catch (e) {
              this.log.warn(`Slack intake: failed to file ticket for ${key}: ${fmtErr(e)}`);
              break; // don't advance past it — retry next run (marker dedupe covers partial success)
            }
          }
        }
        cursor = msg.ts;
      }
      state.cursors[channel] = cursor;
    }

    writeState(this.cfg.statePath, state, this.log);
    return anyChannelOk || this.cfg.channels.length === 0;
  }

  /** Returns the keyword score when the message is a filable problem report, else null. */
  private candidate(msg: SlackMessage): { score: number; matches: string[] } | null {
    if (msg.botId || msg.subtype) return null;
    if (msg.threadTs && msg.threadTs !== msg.ts) return null;
    if (!msg.text.trim()) return null;
    if (this.reporters.size > 0 && (!msg.user || !this.reporters.has(msg.user))) return null;
    if (referencesTicket(msg.text)) return null;
    const scored = scoreProblemReport(cleanSlackText(msg.text));
    return scored.score >= this.cfg.minScore ? scored : null;
  }
}

// ─── State file ─────────────────────────────────────────────────────────────

function readState(file: string): SlackIntakeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SlackIntakeState>;
    const cursors: Record<string, string> = {};
    if (parsed && typeof parsed.cursors === "object" && parsed.cursors) {
      for (const [k, v] of Object.entries(parsed.cursors)) if (typeof v === "string") cursors[k] = v;
    }
    return { cursors };
  } catch {
    return { cursors: {} };
  }
}

function writeState(file: string, state: SlackIntakeState, log: Logger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (e) {
    log.warn(`Slack intake: failed to persist state: ${fmtErr(e)}`);
  }
}

function stripUndefined<T extends object>(o: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function fmtErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
