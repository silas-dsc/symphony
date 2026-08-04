import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { loadWorkflow, validateConfig } from "../config.js";
import {
  ClaudeInsightSynthesizer,
  FileUxStateStore,
  HttpHogQlClient,
  HttpUxSlackReporter,
  UX_CATEGORIES,
  UxInsightsWatcher,
  buildQueryPack,
  buildSlackReport,
  buildSynthesisPrompt,
  buildTicketDescription,
  buildTicketTitle,
  extractAssistantText,
  extractInsightKey,
  extractJsonBlock,
  insightKey,
  meetsTicketBar,
  parseSynthesisOutput,
  rowsToMetrics,
  type HogQlClient,
  type Insight,
  type InsightSynthesizer,
  type UxDataset,
  type UxInsightsConfig,
  type UxReport,
  type UxSchedulerState,
  type UxSlackReporter,
  type UxStateStore,
  type UxTicketSnapshot,
  type UxTicketStore,
} from "../ux-insights.js";
import type { Logger, TrackerConfig } from "../types.js";

// ─── linear.js is mocked so the default LinearTicketStore can be exercised ────
vi.mock("../linear.js", () => ({
  fetchIssuesByLabel: vi.fn(),
  createIssue: vi.fn(),
  fetchTeamByKey: vi.fn(),
  fetchWorkflowStates: vi.fn(),
  fetchUserByEmailOrName: vi.fn(),
  resolveOrCreateLabelId: vi.fn(),
}));
import * as linear from "../linear.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

// Fixed clock the harness defaults to. reportDayOfWeek defaults to this clock's
// weekday so the day-of-week gate passes by default; the other test clocks (0,
// +7 days) land on the same weekday, so they clear the gate too.
const FIXED_NOW_MS = 1_000_000;

function makeConfig(overrides?: Partial<UxInsightsConfig>): UxInsightsConfig {
  return {
    enabled: true,
    host: "https://us.posthog.com",
    projectId: "49303",
    apiKey: "phx_test",
    slackChannel: "C123",
    slackBotToken: "xoxb-test",
    teamKey: "TEA",
    targetState: "Dev in Progress",
    assigneeEmail: "silas@teamdsc.com.au",
    label: "ux-insights",
    lookbackDays: 7,
    searchEventName: "search",
    searchQueryProperty: "query",
    conversionEvents: ["signed_up", "subscribed"],
    maxSignalsPerCategory: 20,
    minConfidenceToTicket: "high",
    maxOpenTickets: 3,
    maxTicketsPerRun: 3,
    runIntervalMs: 7 * 24 * 60 * 60 * 1000,
    reportDayOfWeek: new Date(FIXED_NOW_MS).getDay(),
    requestTimeoutMs: 30_000,
    synthesisMaxTurns: 20,
    synthesisTimeoutMs: 600_000,
    ...overrides,
  };
}

const tracker: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "test-key",
  projectSlug: "ALL",
  teamKey: "TEA",
  activeStates: ["Dev in Progress"],
  terminalStates: ["Done"],
};

function makeInsight(overrides?: Partial<Insight>): Insight {
  return {
    category: "search-gap",
    title: "Users search 'pmp' but get no results",
    detail: "142 searches for 'pmp' returned zero results; the course is titled 'PMP Prep'.",
    confidence: "high",
    recommendation: "Add 'pmp' as a search alias for the PMP Prep course.",
    ticketable: true,
    ...overrides,
  };
}

function makeReport(overrides?: Partial<UxReport>): UxReport {
  return {
    summary: "Search data shows unmet demand for PMP content.",
    insights: [makeInsight()],
    ...overrides,
  };
}

function makeDataset(overrides?: Partial<UxDataset>): UxDataset {
  return {
    metrics: [{ category: "search-gap", label: "pmp", value: 142, detail: { users: 90 } }],
    ...overrides,
  };
}

interface WatcherHarness {
  watcher: UxInsightsWatcher;
  created: Array<{ key: string; title: string }>;
  collectCalls: () => number;
  synthCalls: () => number;
  slackPosts: () => number;
}

function makeWatcher(opts: {
  config?: Partial<UxInsightsConfig>;
  dataset?: () => Promise<UxDataset>;
  report?: () => Promise<UxReport>;
  snapshot?: () => Promise<UxTicketSnapshot>;
  createThrows?: boolean;
  slackThrows?: boolean;
  now?: () => number;
  stateStore?: UxStateStore;
}): WatcherHarness {
  let collectCalls = 0;
  let synthCalls = 0;
  let slackPosts = 0;
  const created: Array<{ key: string; title: string }> = [];

  const hogQlClient: HogQlClient = {
    collect: async () => { collectCalls++; return opts.dataset ? opts.dataset() : makeDataset(); },
  };
  const synthesizer: InsightSynthesizer = {
    synthesize: async () => { synthCalls++; return opts.report ? opts.report() : makeReport(); },
  };
  const slackReporter: UxSlackReporter = {
    post: async () => { slackPosts++; if (opts.slackThrows) throw new Error("slack down"); },
  };
  const ticketStore: UxTicketStore = {
    snapshot: async () =>
      opts.snapshot ? opts.snapshot() : { existingKeys: new Set<string>(), openCount: 0 },
    createTicket: async (insight: Insight, key: string) => {
      if (opts.createThrows) throw new Error("create failed");
      created.push({ key, title: buildTicketTitle(insight) });
      return { identifier: `TEA-${created.length}`, url: `https://linear.app/x/TEA-${created.length}` };
    },
  };

  const watcher = new UxInsightsWatcher({
    config: makeConfig(opts.config),
    tracker,
    logger: makeLogger(),
    hogQlClient,
    synthesizer,
    slackReporter,
    ticketStore,
    now: opts.now ?? (() => FIXED_NOW_MS),
    stateStore: opts.stateStore,
  });

  return {
    watcher,
    created,
    collectCalls: () => collectCalls,
    synthCalls: () => synthCalls,
    slackPosts: () => slackPosts,
  };
}

// ─── config parsing / validation ─────────────────────────────────────────────

function writeWorkflow(body: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ux-cfg-"));
  const workflowPath = path.join(tmpDir, "WORKFLOW.md");
  fs.writeFileSync(workflowPath, body, "utf8");
  return workflowPath;
}

const BASE_TRACKER = `tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress`;

describe("ux_insights config parsing", () => {
  let prev: NodeJS.ProcessEnv;
  beforeEach(() => { prev = { ...process.env }; });
  afterEach(() => { process.env = prev; });

  it("defaults to disabled and inherits creds, team, slack, and first active state", () => {
    process.env.POSTHOG_HOST = "https://eu.posthog.com";
    process.env.POSTHOG_PROJECT_ID = "777";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_envkey";
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
notifications:
  slack:
    bot_token: xoxb-abc
    channel: C999
---

prompt body`);
    const { config } = loadWorkflow(workflowPath);
    const u = config.uxInsights;
    expect(u.enabled).toBe(false);
    expect(u.host).toBe("https://eu.posthog.com");
    expect(u.projectId).toBe("777");
    expect(u.apiKey).toBe("phx_envkey");
    expect(u.slackBotToken).toBe("xoxb-abc");
    expect(u.slackChannel).toBe("C999");
    expect(u.teamKey).toBe("TEA");
    expect(u.targetState).toBe("Dev in Progress");
    expect(u.label).toBe("ux-insights");
    expect(u.conversionEvents).toEqual(["signed_up", "subscribed", "purchased"]);
    expect(u.minConfidenceToTicket).toBe("high");
  });

  it("falls back to us.posthog.com when POSTHOG_HOST is unset and honours explicit overrides", () => {
    delete process.env.POSTHOG_HOST;
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  slack_channel: C-explicit
  slack_bot_token: xoxb-explicit
  lookback_days: 14
  min_confidence_to_ticket: MEDIUM
  conversion_events:
    - bought
---

prompt body`);
    const { config } = loadWorkflow(workflowPath);
    expect(config.uxInsights.host).toBe("https://us.posthog.com");
    expect(config.uxInsights.slackChannel).toBe("C-explicit");
    expect(config.uxInsights.slackBotToken).toBe("xoxb-explicit");
    expect(config.uxInsights.lookbackDays).toBe(14);
    expect(config.uxInsights.minConfidenceToTicket).toBe("medium");
    expect(config.uxInsights.conversionEvents).toEqual(["bought"]);
  });

  it("rejects an enabled config missing the project id", () => {
    delete process.env.POSTHOG_PROJECT_ID;
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  enabled: true
---

prompt body`);
    expect(validateConfig(loadWorkflow(workflowPath).config)).toMatch(/project_id/);
  });

  it("rejects an enabled config missing the api key", () => {
    process.env.POSTHOG_PROJECT_ID = "49303";
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  enabled: true
---

prompt body`);
    expect(validateConfig(loadWorkflow(workflowPath).config)).toMatch(/api_key/);
  });

  it("rejects a target_state that is not an active state", () => {
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  enabled: true
  target_state: Backlog
---

prompt body`);
    expect(validateConfig(loadWorkflow(workflowPath).config)).toMatch(/target_state/);
  });

  it("rejects an invalid min_confidence_to_ticket", () => {
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  enabled: true
  min_confidence_to_ticket: nonsense
---

prompt body`);
    expect(validateConfig(loadWorkflow(workflowPath).config)).toMatch(/min_confidence_to_ticket/);
  });

  it("rejects non-positive numeric fields", () => {
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    const cases: Array<[string, RegExp]> = [
      ["lookback_days: 0", /lookback_days/],
      ["max_signals_per_category: 0", /max_signals_per_category/],
      ["max_open_tickets: 0", /max_open_tickets/],
      ["max_tickets_per_run: 0", /max_tickets_per_run/],
      ["run_interval_ms: 0", /run_interval_ms/],
      ["request_timeout_ms: 0", /request_timeout_ms/],
      ["synthesis_max_turns: 0", /synthesis_max_turns/],
      ["synthesis_timeout_ms: 0", /synthesis_timeout_ms/],
    ];
    for (const [line, re] of cases) {
      const workflowPath = writeWorkflow(`---
${BASE_TRACKER}
ux_insights:
  enabled: true
  ${line}
---

prompt body`);
      expect(validateConfig(loadWorkflow(workflowPath).config), line).toMatch(re);
    }
  });

  it("rejects when team_key cannot be resolved", () => {
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    // project_slug is a bare project (not ALL) so there's no tracker.team_key to inherit.
    const workflowPath = writeWorkflow(`---
tracker:
  kind: linear
  api_key: test-key
  project_slug: my-project
  active_states:
    - Dev in Progress
ux_insights:
  enabled: true
  target_state: Dev in Progress
---

prompt body`);
    expect(validateConfig(loadWorkflow(workflowPath).config)).toMatch(/team_key/);
  });
});

// ─── keys, markers, ticket bar ───────────────────────────────────────────────

describe("insight keys & markers", () => {
  it("slugifies title into a stable, category-scoped key", () => {
    expect(insightKey({ category: "search-gap", title: "Users search 'pmp'!!" }))
      .toBe("search-gap/users-search-pmp");
  });

  it("falls back to 'untitled' when the title has no slug characters", () => {
    expect(insightKey({ category: "opportunity", title: "!!!" })).toBe("opportunity/untitled");
  });

  it("round-trips the dedupe marker", () => {
    const insight = makeInsight();
    const key = insightKey(insight);
    const desc = buildTicketDescription(insight, key);
    expect(extractInsightKey(desc)).toBe(key);
  });

  it("returns null when no marker is present", () => {
    expect(extractInsightKey("no marker here")).toBeNull();
  });

  it("gates ticketing on ticketable flag and confidence floor", () => {
    expect(meetsTicketBar(makeInsight({ ticketable: false }), "low")).toBe(false);
    expect(meetsTicketBar(makeInsight({ confidence: "medium" }), "high")).toBe(false);
    expect(meetsTicketBar(makeInsight({ confidence: "high" }), "high")).toBe(true);
    expect(meetsTicketBar(makeInsight({ confidence: "medium" }), "medium")).toBe(true);
    // Unknown floor is treated as the strictest ("high").
    expect(meetsTicketBar(makeInsight({ confidence: "medium" }), "bogus")).toBe(false);
  });
});

// ─── ticket copy ─────────────────────────────────────────────────────────────

describe("ticket copy", () => {
  it("builds an actionable ticket with the category label and recommendation", () => {
    const insight = makeInsight();
    expect(buildTicketTitle(insight)).toContain("[UX] Search gap:");
    const desc = buildTicketDescription(insight, "k");
    expect(desc).toContain("Confidence:** high");
    expect(desc).toContain(insight.recommendation!);
    expect(desc).toContain("Open a PR");
  });

  it("handles a null recommendation and empty detail", () => {
    const insight = makeInsight({ recommendation: null, detail: "   ", category: "opportunity" });
    const desc = buildTicketDescription(insight, "k");
    expect(buildTicketTitle(insight)).toContain("Opportunity:");
    expect(desc).toContain("No specific fix proposed");
    expect(desc).toContain("No detail captured");
  });

  it("truncates an over-long title", () => {
    const insight = makeInsight({ title: "x".repeat(200) });
    expect(buildTicketTitle(insight).length).toBeLessThanOrEqual(120);
    expect(buildTicketTitle(insight).endsWith("…")).toBe(true);
  });
});

// ─── slack report ────────────────────────────────────────────────────────────

describe("buildSlackReport", () => {
  it("orders by confidence, flags ticketable insights, and includes detail + recommendation", () => {
    const report: UxReport = {
      summary: "Weekly summary.",
      insights: [
        makeInsight({ title: "low one", confidence: "low", ticketable: false }),
        makeInsight({ title: "high one", confidence: "high" }),
      ],
    };
    const { text, blocks } = buildSlackReport(report, "high");
    expect(text).toContain("Weekly UX / product insights");
    // High-confidence insight appears before the low one.
    expect(text.indexOf("high one")).toBeLessThan(text.indexOf("low one"));
    expect(text).toContain("will file ticket");
    expect(text).toContain("↳");
    expect(blocks).toHaveLength(1);
  });

  it("handles a report with no insights", () => {
    const { text } = buildSlackReport({ summary: "Nothing notable.", insights: [] }, "high");
    expect(text).toContain("Nothing notable.");
    expect(text).not.toContain("will file ticket");
  });

  it("omits the recommendation line when there is none, and the detail line when blank", () => {
    const report: UxReport = {
      summary: "s",
      insights: [makeInsight({ recommendation: null, detail: "   " })],
    };
    const { text } = buildSlackReport(report, "high");
    expect(text).not.toContain("↳");
    expect(text).not.toContain(">");
  });

  it("truncates the block text for very long reports", () => {
    const report: UxReport = {
      summary: "s".repeat(4000),
      insights: [],
    };
    const { blocks } = buildSlackReport(report, "high");
    const blockText = (blocks[0].text as { text: string }).text;
    expect(blockText.length).toBeLessThanOrEqual(2900);
    expect(blockText.endsWith("…")).toBe(true);
  });
});

// ─── query pack ──────────────────────────────────────────────────────────────

describe("buildQueryPack", () => {
  it("produces one query per category with the lookback + limit applied", () => {
    const pack = buildQueryPack(makeConfig({ lookbackDays: 5, maxSignalsPerCategory: 7 }));
    expect(pack.map(q => q.category)).toEqual([...UX_CATEGORIES]);
    for (const spec of pack) {
      expect(spec.hogql).toContain("INTERVAL 5 DAY");
      expect(spec.hogql).toContain("LIMIT 7");
    }
  });

  it("sanitises event/property names and defaults conversion events", () => {
    const pack = buildQueryPack(makeConfig({
      searchEventName: "search; DROP",
      searchQueryProperty: "q'uery",
      conversionEvents: [],
    }));
    const search = pack.find(q => q.category === "search-gap")!;
    expect(search.hogql).toContain("event = 'searchDROP'");
    expect(search.hogql).toContain("properties.query");
    const conv = pack.find(q => q.category === "conversion")!;
    expect(conv.hogql).toContain("'$autocapture'");
  });
});

// ─── rowsToMetrics ───────────────────────────────────────────────────────────

describe("rowsToMetrics", () => {
  it("maps label + value and folds remaining columns into detail", () => {
    const metrics = rowsToMetrics(
      "search-gap",
      ["label", "value", "users", "sample"],
      [["pmp", 142, 90, "https://x"]],
    );
    expect(metrics).toEqual([
      { category: "search-gap", label: "pmp", value: 142, detail: { users: 90, sample: "https://x" } },
    ]);
  });

  it("drops rows with an empty label or a non-finite value, and skips empty/NaN detail cells", () => {
    const metrics = rowsToMetrics(
      "confusion",
      ["label", "value", "note", "count"],
      [
        ["", 5, "x", 1],            // empty label → dropped
        ["/a", "not-a-number", "x", 1], // bad value → dropped
        ["/b", 3, "  ", Number.NaN],   // kept, but blank string + NaN detail skipped
        [42, 3, "x", 1],            // non-string label → dropped
      ],
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0].label).toBe("/b");
    expect(metrics[0].detail).toEqual({});
  });

  it("skips detail columns whose header is undefined", () => {
    // More cells than headers → the extra cell has no column name and is skipped.
    const metrics = rowsToMetrics("drop-off", ["label", "value"], [["/p", 9, 123]]);
    expect(metrics[0].detail).toEqual({});
  });
});

// ─── synthesis prompt + output parsing ───────────────────────────────────────

describe("buildSynthesisPrompt", () => {
  it("embeds the questions, the grouped data, and the ticket confidence bar", () => {
    const prompt = buildSynthesisPrompt(makeDataset(), makeConfig({ minConfidenceToTicket: "medium" }));
    expect(prompt).toContain("Gaps in the workshop offering");
    expect(prompt).toContain('"search-gap"');
    expect(prompt).toContain("medium+ confidence");
  });

  it("instructs plain, succinct English for a non-technical reader", () => {
    const prompt = buildSynthesisPrompt(makeDataset(), makeConfig());
    expect(prompt).toContain("non-technical marketing graduate");
    expect(prompt).toContain("Plain, everyday English");
    expect(prompt).toContain("as short as possible");
  });
});

describe("extractJsonBlock", () => {
  it("prefers a fenced json block", () => {
    expect(extractJsonBlock('text\n```json\n{"a":1}\n```\nmore')).toBe('{"a":1}');
  });
  it("accepts an unlabelled fence", () => {
    expect(extractJsonBlock("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
  it("falls back to the outermost braces when there is no usable fence", () => {
    expect(extractJsonBlock("prefix {\"a\":1} suffix")).toBe('{"a":1}');
    // Empty fence body → fall through to brace scan.
    expect(extractJsonBlock("``` ``` {\"a\":1}")).toBe('{"a":1}');
  });
  it("returns null when there is no JSON at all", () => {
    expect(extractJsonBlock("no json here")).toBeNull();
  });
});

describe("parseSynthesisOutput", () => {
  it("parses a valid report and coerces insight fields", () => {
    const out = parseSynthesisOutput(`\`\`\`json
{
  "summary": "  trimmed  ",
  "insights": [
    { "category": "search-gap", "title": "a", "detail": "d", "confidence": "high", "recommendation": "r", "ticketable": true },
    { "category": "weird", "title": "b", "confidence": "nope", "ticketable": "yes" },
    { "category": "conversion", "title": "c" },
    { "title": "" },
    { "title": 123 },
    "not-an-object"
  ]
}
\`\`\``);
    expect(out.summary).toBe("trimmed");
    expect(out.insights).toHaveLength(3);
    // Unknown category → opportunity; unknown confidence string → high; non-true ticketable → false.
    expect(out.insights[1]).toMatchObject({ category: "opportunity", confidence: "high", ticketable: false });
    // Missing confidence → default "medium"; missing recommendation → null.
    expect(out.insights[2]).toMatchObject({ category: "conversion", confidence: "medium", recommendation: null });
  });

  it("treats a whitespace-only recommendation as null", () => {
    const out = parseSynthesisOutput('{"summary":"s","insights":[{"title":"t","recommendation":"   "}]}');
    expect(out.insights[0].recommendation).toBeNull();
  });

  it("defaults summary and insights when absent", () => {
    const out = parseSynthesisOutput('{"foo":1}');
    expect(out).toEqual({ summary: "", insights: [] });
  });

  it("throws on no JSON block", () => {
    expect(() => parseSynthesisOutput("nothing")).toThrow(/no JSON block/);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseSynthesisOutput("```json\n{not json}\n```")).toThrow(/not valid JSON/);
  });

  it("throws when the JSON parses to a non-object primitive", () => {
    expect(() => parseSynthesisOutput("```json\nnull\n```")).toThrow(/not an object/);
    expect(() => parseSynthesisOutput("```json\n42\n```")).toThrow(/not an object/);
  });
});

// ─── FileUxStateStore ─────────────────────────────────────────────────────────

describe("FileUxStateStore", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ux-state-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("round-trips the scheduler state through disk", () => {
    const file = path.join(dir, "state.json");
    const store = new FileUxStateStore(file, makeLogger());
    store.save({ nextRunAt: 123456789 });
    expect(new FileUxStateStore(file, makeLogger()).load()).toEqual({ nextRunAt: 123456789 });
  });

  it("returns null when the file does not exist yet", () => {
    const store = new FileUxStateStore(path.join(dir, "missing.json"), makeLogger());
    expect(store.load()).toBeNull();
  });

  it("returns null (does not throw) on a corrupt file", () => {
    const file = path.join(dir, "corrupt.json");
    fs.writeFileSync(file, "{not json", "utf-8");
    expect(new FileUxStateStore(file, makeLogger()).load()).toBeNull();
  });

  it("returns null when nextRunAt is missing or not a finite number", () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ nextRunAt: "soon" }), "utf-8");
    expect(new FileUxStateStore(file, makeLogger()).load()).toBeNull();
  });
});

// ─── extractAssistantText ────────────────────────────────────────────────────

describe("extractAssistantText", () => {
  it("pulls concatenated text blocks from an assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }, { type: "tool_use" }] },
    });
    expect(extractAssistantText(line)).toBe("Hello world");
  });
  it("returns null for blank lines, non-JSON, non-objects, and other event types", () => {
    expect(extractAssistantText("   ")).toBeNull();
    expect(extractAssistantText("{not json")).toBeNull();
    expect(extractAssistantText("123")).toBeNull();
    expect(extractAssistantText(JSON.stringify({ type: "result" }))).toBeNull();
  });
  it("returns null when the message content is missing or has no text", () => {
    expect(extractAssistantText(JSON.stringify({ type: "assistant" }))).toBeNull();
    expect(extractAssistantText(JSON.stringify({ type: "assistant", message: { content: "x" } }))).toBeNull();
    expect(extractAssistantText(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }, null] } }))).toBeNull();
  });
});

// ─── watcher ─────────────────────────────────────────────────────────────────

describe("UxInsightsWatcher", () => {
  it("does nothing and never pulls when disabled", async () => {
    const h = makeWatcher({ config: { enabled: false } });
    await h.watcher.reconcile();
    expect(h.collectCalls()).toBe(0);
    expect(h.synthCalls()).toBe(0);
  });

  it("constructs its default HTTP/Claude/Slack collaborators when none are injected", () => {
    const watcher = new UxInsightsWatcher({ config: makeConfig(), tracker, logger: makeLogger() });
    expect(watcher.getCreatedCount()).toBe(0);
  });

  it("runs the full pipeline: synthesise, post to Slack, file the ticketable insight", async () => {
    const h = makeWatcher({
      report: async () => makeReport({
        insights: [
          makeInsight({ title: "high ticketable" }),
          makeInsight({ title: "fyi", confidence: "low", ticketable: false }),
        ],
      }),
    });
    await h.watcher.reconcile();
    expect(h.synthCalls()).toBe(1);
    expect(h.slackPosts()).toBe(1);
    expect(h.created.map(c => c.key)).toEqual(["search-gap/high-ticketable"]);
    expect(h.watcher.getCreatedCount()).toBe(1);
  });

  it("respects the weekly gate", async () => {
    let clock = 1_000_000;
    const h = makeWatcher({ now: () => clock, dataset: async () => makeDataset({ metrics: [] }) });
    await h.watcher.reconcile();
    expect(h.collectCalls()).toBe(1);
    await h.watcher.reconcile();
    expect(h.collectCalls()).toBe(1);
    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    await h.watcher.reconcile();
    expect(h.collectCalls()).toBe(2);
  });

  it("only runs on the configured day of week", async () => {
    // Pick any clock, then gate on its actual weekday so the test is timezone-independent.
    const clock = 1_000_000;
    const today = new Date(clock).getDay();
    const otherDay = (today + 1) % 7;

    const blocked = makeWatcher({
      now: () => clock,
      config: { reportDayOfWeek: otherDay },
      dataset: async () => makeDataset({ metrics: [] }),
    });
    await blocked.watcher.reconcile();
    expect(blocked.collectCalls()).toBe(0); // not the configured day → skipped

    const allowed = makeWatcher({
      now: () => clock,
      config: { reportDayOfWeek: today },
      dataset: async () => makeDataset({ metrics: [] }),
    });
    await allowed.watcher.reconcile();
    expect(allowed.collectCalls()).toBe(1);
  });

  it("persists the weekly clock after a successful run", async () => {
    const clock = 1_000_000;
    const saved: UxSchedulerState[] = [];
    const stateStore: UxStateStore = { load: () => null, save: s => { saved.push(s); } };
    const h = makeWatcher({ now: () => clock, stateStore, dataset: async () => makeDataset({ metrics: [] }) });
    await h.watcher.reconcile();
    expect(saved).toEqual([{ nextRunAt: clock + 7 * 24 * 60 * 60 * 1000 }]);
  });

  it("does not persist when the pull fails (clock must not advance)", async () => {
    const clock = 1_000_000;
    const saved: UxSchedulerState[] = [];
    const stateStore: UxStateStore = { load: () => null, save: s => { saved.push(s); } };
    const h = makeWatcher({
      now: () => clock,
      stateStore,
      dataset: async () => { throw new Error("posthog 500"); },
    });
    await h.watcher.reconcile();
    expect(saved).toEqual([]);
  });

  it("restores the weekly clock on construction so a restart does not re-post", async () => {
    // A restart on the configured day: the day gate is open, but the persisted
    // clock is still in the future, so the interval gate must block the re-post.
    // +7 days lands on the same weekday, so the day gate stays open in both cases
    // and we isolate the interval gate — timezone-independent.
    const clock = 1_000_000;
    const persisted = { nextRunAt: clock + 7 * 24 * 60 * 60 * 1000 };
    const stateStore: UxStateStore = { load: () => persisted, save: () => undefined };
    const h = makeWatcher({ now: () => clock, stateStore, dataset: async () => makeDataset({ metrics: [] }) });
    await h.watcher.reconcile();
    expect(h.collectCalls()).toBe(0); // gated by the restored clock

    // Once the restored clock elapses, it runs again.
    const later = makeWatcher({
      now: () => persisted.nextRunAt + 1,
      stateStore: { load: () => persisted, save: () => undefined },
      dataset: async () => makeDataset({ metrics: [] }),
    });
    await later.watcher.reconcile();
    expect(later.collectCalls()).toBe(1);
  });

  it("does not advance the weekly clock when the pull fails", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const h = makeWatcher({
      now: () => clock,
      dataset: async () => { attempts++; if (attempts === 1) throw new Error("posthog 500"); return makeDataset({ metrics: [] }); },
    });
    await h.watcher.reconcile(); // fails
    await h.watcher.reconcile(); // retries immediately
    expect(attempts).toBe(2);
  });

  it("skips synthesis when the dataset is empty", async () => {
    const h = makeWatcher({ dataset: async () => makeDataset({ metrics: [] }) });
    await h.watcher.reconcile();
    expect(h.synthCalls()).toBe(0);
    expect(h.slackPosts()).toBe(0);
    expect(h.created).toHaveLength(0);
  });

  it("bails out (no tickets) when synthesis throws", async () => {
    const h = makeWatcher({ report: async () => { throw new Error("claude died"); } });
    await h.watcher.reconcile();
    expect(h.slackPosts()).toBe(0);
    expect(h.created).toHaveLength(0);
  });

  it("tolerates a non-Error thrown value (formats it for the log)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const h = makeWatcher({ report: async () => { throw "just a string"; } });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(0);
  });

  it("tolerates a thrown value that JSON.stringify can't serialise", async () => {
    // A BigInt is non-Error and makes JSON.stringify throw → fmtErr falls back to String().
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const h = makeWatcher({ report: async () => { throw 10n; } });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(0);
  });

  it("still files tickets when the Slack post fails", async () => {
    const h = makeWatcher({ slackThrows: true });
    await h.watcher.reconcile();
    expect(h.slackPosts()).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  it("files the highest-confidence insights first, up to maxTicketsPerRun", async () => {
    const h = makeWatcher({
      config: { maxTicketsPerRun: 1, minConfidenceToTicket: "low" },
      report: async () => makeReport({
        insights: [
          makeInsight({ title: "med", confidence: "medium" }),
          makeInsight({ title: "hi", confidence: "high" }),
        ],
      }),
    });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.key)).toEqual(["search-gap/hi"]);
  });

  it("dedupes against existing tickets and counts open ones toward the cap", async () => {
    const h = makeWatcher({
      config: { maxOpenTickets: 2, maxTicketsPerRun: 5, minConfidenceToTicket: "low" },
      report: async () => makeReport({
        insights: [
          makeInsight({ title: "a", confidence: "high" }),
          makeInsight({ title: "b", confidence: "high" }),
          makeInsight({ title: "c", confidence: "high" }),
        ],
      }),
      snapshot: async () => ({ existingKeys: new Set(["search-gap/a"]), openCount: 1 }),
    });
    await h.watcher.reconcile();
    // "a" deduped; cap 2 with 1 open → only 1 more filed ("b").
    expect(h.created.map(c => c.key)).toEqual(["search-gap/b"]);
  });

  it("does not re-file a key created earlier in the same process", async () => {
    let clock = 0;
    const h = makeWatcher({ now: () => clock });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(1);
    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    await h.watcher.reconcile();
    // Same insight surfaced again → deduped by createdKeys, not re-filed.
    expect(h.created).toHaveLength(1);
  });

  it("logs and files nothing when no insight clears the confidence bar", async () => {
    const h = makeWatcher({
      report: async () => makeReport({ insights: [makeInsight({ confidence: "low", ticketable: true })] }),
    });
    await h.watcher.reconcile();
    expect(h.slackPosts()).toBe(1);
    expect(h.created).toHaveLength(0);
  });

  it("skips ticket creation when the snapshot fails", async () => {
    const h = makeWatcher({ snapshot: async () => { throw new Error("linear down"); } });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(0);
  });

  it("continues past an individual createTicket failure", async () => {
    const h = makeWatcher({ createThrows: true });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(0);
    expect(h.watcher.getCreatedCount()).toBe(0);
  });

  it("runOnce bypasses the enabled flag and gate, and honours skip flags", async () => {
    const h = makeWatcher({ config: { enabled: false } });
    const result = await h.watcher.runOnce({ skipSlack: true, skipTickets: true });
    expect(h.synthCalls()).toBe(1);
    expect(h.slackPosts()).toBe(0);
    expect(result.created).toHaveLength(0);
    expect(result.report).not.toBeNull();
  });

  it("runOnce returns an empty result when a cycle is already in flight", async () => {
    let release: (d: UxDataset) => void = () => undefined;
    const gate = new Promise<UxDataset>(res => { release = res; });
    const h = makeWatcher({ dataset: () => gate });
    const first = h.watcher.runOnce();          // parks on the dataset promise
    const second = await h.watcher.runOnce();    // re-entrant → empty
    expect(second).toEqual({ report: null, created: [] });
    release(makeDataset());
    await first;
  });

  it("reconcile is a no-op while a cycle is in flight", async () => {
    let release: (d: UxDataset) => void = () => undefined;
    const gate = new Promise<UxDataset>(res => { release = res; });
    let calls = 0;
    const h = makeWatcher({ dataset: () => { calls++; return gate; } });
    const first = h.watcher.reconcile();
    await h.watcher.reconcile(); // guarded out
    expect(calls).toBe(1);
    release(makeDataset({ metrics: [] }));
    await first;
  });
});

// ─── default HTTP clients (fetch mocked) ─────────────────────────────────────

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("HttpHogQlClient", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("runs the query pack and flattens rows, tolerating a single failed lens", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      if (call === 2) return jsonResponse("boom", false, 500); // second lens fails
      return jsonResponse({ columns: ["label", "value", "users"], results: [["pmp", 3, 1]] });
    });
    const client = new HttpHogQlClient(makeLogger());
    const dataset = await client.collect(makeConfig());
    // 4 lenses, one failed → 3 metrics.
    expect(dataset.metrics).toHaveLength(3);
  });

  it("strips trailing slashes from the host in the request URL", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ columns: ["label", "value"], results: [] }),
    );
    await new HttpHogQlClient(makeLogger()).collect(makeConfig({ host: "https://us.posthog.com/" }));
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe("https://us.posthog.com/api/projects/49303/query/");
  });

  it("defaults columns/results to empty arrays when the payload omits them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    const dataset = await new HttpHogQlClient(makeLogger()).collect(makeConfig());
    expect(dataset.metrics).toEqual([]);
  });

  it("tolerates an error response whose body cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => { throw new Error("body read failed"); },
    } as unknown as Response);
    const dataset = await new HttpHogQlClient(makeLogger()).collect(makeConfig());
    // Every lens fails (each throws HTTP 502) but collect swallows and returns empty.
    expect(dataset.metrics).toEqual([]);
  });
});

describe("HttpUxSlackReporter", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("skips the post when Slack is not configured", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await new HttpUxSlackReporter(makeLogger()).post(makeReport(), makeConfig({ slackBotToken: "" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts to chat.postMessage on the configured channel", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    await new HttpUxSlackReporter(makeLogger()).post(makeReport(), makeConfig());
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse((init as RequestInit).body as string).channel).toBe("C123");
  });

  // The shared sender retries transient failures with backoff, so failures reject only
  // after SLACK_MAX_ATTEMPTS; fake timers flush the backoff sleeps without real delay.
  async function expectPostRejects(fetchImpl: Response, re: RegExp): Promise<void> {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fetchImpl);
    const p = new HttpUxSlackReporter(makeLogger()).post(makeReport(), makeConfig());
    const assertion = expect(p).rejects.toThrow(re);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  }

  it("rejects (after retries) on a non-2xx response", async () => {
    await expectPostRejects(jsonResponse("nope", false, 500), /HTTP 500/);
  });

  it("rejects (after retries) when Slack replies ok:false", async () => {
    await expectPostRejects(jsonResponse({ ok: false, error: "channel_not_found" }), /channel_not_found/);
  });

  it("reports 'unknown' when Slack replies ok:false with no error", async () => {
    await expectPostRejects(jsonResponse({ ok: false }), /unknown/);
  });
});

// ─── default LinearTicketStore (linear.js mocked) ────────────────────────────

describe("LinearTicketStore (via the watcher)", () => {
  beforeEach(() => {
    for (const fn of [
      linear.fetchIssuesByLabel,
      linear.createIssue,
      linear.fetchTeamByKey,
      linear.fetchWorkflowStates,
      linear.fetchUserByEmailOrName,
      linear.resolveOrCreateLabelId,
    ]) {
      vi.mocked(fn).mockReset();
    }
  });

  function watcherWithRealStore(
    config?: Partial<UxInsightsConfig>,
    logger?: Logger,
  ): WatcherHarness["watcher"] {
    return new UxInsightsWatcher({
      config: makeConfig(config),
      tracker,
      logger: logger ?? makeLogger(),
      hogQlClient: { collect: async () => makeDataset() },
      synthesizer: { synthesize: async () => report ?? makeReport() },
      slackReporter: { post: async () => undefined },
      now: () => 0,
    });
  }
  let report: UxReport | undefined;
  afterEach(() => { report = undefined; });

  function recordingLogger(): { logger: Logger; warns: string[] } {
    const warns: string[] = [];
    return {
      warns,
      logger: { info: () => undefined, warn: m => { warns.push(m); }, error: () => undefined },
    };
  }

  it("snapshots existing keys/open count and creates tickets with resolved (memoised) refs", async () => {
    // Two ticketable insights → refs are resolved once and reused on the second createTicket.
    report = makeReport({
      insights: [makeInsight({ title: "first" }), makeInsight({ title: "second" })],
    });
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([
      { description: "<!-- symphony-ux-insight:search-gap/old -->", state: "Done" },
      { description: "no marker", state: "Dev in Progress" },
    ] as never);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "Platform" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "st1", name: "Dev in Progress", type: "started" }]);
    vi.mocked(linear.fetchUserByEmailOrName).mockResolvedValue({ id: "user1" } as never);
    vi.mocked(linear.resolveOrCreateLabelId).mockResolvedValue("label1");
    vi.mocked(linear.createIssue).mockResolvedValue({ identifier: "TEA-42", url: "https://linear.app/x" } as never);

    const result = await watcherWithRealStore().runOnce();
    expect(result.created).toHaveLength(2);
    // Refs resolved exactly once despite two tickets (memoised).
    expect(vi.mocked(linear.fetchTeamByKey)).toHaveBeenCalledTimes(1);
    const createArg = vi.mocked(linear.createIssue).mock.calls[0][1];
    expect(createArg).toMatchObject({ teamId: "team1", stateId: "st1", assigneeId: "user1", labelIds: ["label1"] });
  });

  it("files nothing and warns when the team cannot be resolved", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue(null);
    const { logger, warns } = recordingLogger();
    const result = await watcherWithRealStore(undefined, logger).runOnce();
    expect(result.created).toHaveLength(0);
    expect(warns.some(w => /team not found/.test(w))).toBe(true);
  });

  it("files nothing and warns when the target workflow state is missing", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "P" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "s", name: "Backlog", type: "backlog" }]);
    const { logger, warns } = recordingLogger();
    const result = await watcherWithRealStore(undefined, logger).runOnce();
    expect(result.created).toHaveLength(0);
    expect(warns.some(w => /workflow state/.test(w))).toBe(true);
  });

  it("warns and files unassigned when the assignee email resolves to no user", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "P" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "st1", name: "Dev in Progress", type: "started" }]);
    vi.mocked(linear.fetchUserByEmailOrName).mockResolvedValue(null);
    vi.mocked(linear.resolveOrCreateLabelId).mockResolvedValue("label1");
    vi.mocked(linear.createIssue).mockResolvedValue({ identifier: "TEA-1", url: null } as never);

    await watcherWithRealStore().runOnce();
    const createArg = vi.mocked(linear.createIssue).mock.calls[0][1] as Record<string, unknown>;
    expect(createArg.assigneeId).toBeUndefined();
    expect(createArg.labelIds).toEqual(["label1"]);
  });

  it("skips assignee + label resolution when both are unset", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "P" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "st1", name: "Dev in Progress", type: "started" }]);
    vi.mocked(linear.fetchUserByEmailOrName).mockReset();
    vi.mocked(linear.resolveOrCreateLabelId).mockReset();
    vi.mocked(linear.createIssue).mockResolvedValue({ identifier: "TEA-1", url: null } as never);

    await watcherWithRealStore({ label: "", assigneeEmail: "" }).runOnce();
    const createArg = vi.mocked(linear.createIssue).mock.calls[0][1] as Record<string, unknown>;
    expect(createArg.assigneeId).toBeUndefined();
    expect(createArg.labelIds).toBeUndefined();
    expect(vi.mocked(linear.fetchUserByEmailOrName)).not.toHaveBeenCalled();
    expect(vi.mocked(linear.resolveOrCreateLabelId)).not.toHaveBeenCalled();
  });
});

// ─── ClaudeInsightSynthesizer (child_process.spawn mocked) ───────────────────

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** Let the readline 'line' handlers drain the stdout buffer before the child closes. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("ClaudeInsightSynthesizer", () => {
  afterEach(() => { spawnMock.mockReset(); vi.useRealTimers(); });

  it("feeds the prompt, parses the assistant JSON, and resolves the report", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger()).synthesize(makeDataset(), makeConfig());

    child.stdout.write("not-json noise\n");
    child.stdout.write(assistantLine('```json\n{"summary":"done","insights":[]}\n```') + "\n");
    child.stderr.write("some stderr\n");
    await flush();
    child.emit("close", 0);

    const report = await p;
    expect(report.summary).toBe("done");
    expect(child.stdin.write).toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("rejects on a non-zero exit code", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger()).synthesize(makeDataset(), makeConfig());
    await flush();
    child.emit("close", 1);
    await expect(p).rejects.toThrow(/exited with code 1/);
  });

  it("rejects with 'null' when the process exits via signal (null code)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger()).synthesize(makeDataset(), makeConfig());
    await flush();
    child.emit("close", null);
    await expect(p).rejects.toThrow(/exited with code null/);
  });

  it("rejects when the process errors", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger()).synthesize(makeDataset(), makeConfig());
    child.emit("error", new Error("ENOENT: claude not found"));
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it("rejects when the output has no parseable JSON", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger()).synthesize(makeDataset(), makeConfig());
    child.stdout.write(assistantLine("no json at all here") + "\n");
    await flush();
    child.emit("close", 0);
    await expect(p).rejects.toThrow(/no JSON block/);
  });

  it("kills the process and rejects on timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = new ClaudeInsightSynthesizer(makeLogger())
      .synthesize(makeDataset(), makeConfig({ synthesisTimeoutMs: 1000 }));
    const assertion = expect(p).rejects.toThrow(/timeout after 1000ms/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
