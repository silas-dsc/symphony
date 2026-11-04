import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../linear.js", () => ({
  fetchIssuesByLabel: vi.fn(),
  createIssue: vi.fn(),
  fetchTeamByKey: vi.fn(),
  fetchWorkflowStates: vi.fn(),
  resolveOrCreateLabelId: vi.fn(),
}));
import * as linear from "../linear.js";
import {
  LinearSlackTicketStore,
  SlackIntakeWatcher,
  SlackWebHistoryClient,
  buildSlackTicketDescription,
  buildSlackTicketTitle,
  cleanSlackText,
  extractSlackKeys,
  referencesTicket,
  scoreProblemReport,
  slackIntakeConfigWithDefaults,
  slackMarker,
  type SlackHistoryClient,
  type SlackIntakeConfig,
  type SlackIntakeTicketStore,
  type SlackMessage,
  type SlackTicketDraft,
} from "../slack-intake.js";
import type { Logger, TrackerConfig } from "../types.js";

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const tracker: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "test-key",
  projectSlug: "ALL",
  teamKey: "TEA",
  activeStates: ["Dev in Progress"],
  terminalStates: ["Done"],
};

const NOW = 1_762_250_000_000; // ms
const CH = "C0A07RQJXP1";

function tmpState(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "symphony-slack-")), "state.json");
}

function cfg(overrides?: Partial<SlackIntakeConfig>): SlackIntakeConfig {
  return slackIntakeConfigWithDefaults({ enabled: true, botToken: "xoxb-test", statePath: tmpState(), ...overrides }, {});
}

function ts(offsetSec: number): string {
  return (NOW / 1000 + offsetSec).toFixed(6);
}

function harness(opts: {
  messages: SlackMessage[];
  config?: Partial<SlackIntakeConfig>;
  existing?: Set<string>;
  createThrowsFor?: string;
  now?: () => number;
}) {
  const created: SlackTicketDraft[] = [];
  const historyCalls: Array<{ channel: string; oldest: string }> = [];
  const client: SlackHistoryClient = {
    history: async (channel, oldest) => {
      historyCalls.push({ channel, oldest });
      return opts.messages.filter(m => Number(m.ts) > Number(oldest));
    },
    permalink: async (channel, t) => `https://slack.com/archives/${channel}/p${t.replace(".", "")}`,
  };
  const store: SlackIntakeTicketStore = {
    existingKeys: async () => new Set(opts.existing ?? []),
    createTicket: async d => {
      if (d.ts === opts.createThrowsFor) throw new Error("boom");
      created.push(d);
      return { identifier: `TEA-${created.length}`, url: null };
    },
  };
  const config = cfg(opts.config);
  const watcher = new SlackIntakeWatcher({
    config,
    tracker,
    logger,
    historyClient: client,
    ticketStore: store,
    now: opts.now ?? (() => NOW),
  });
  return { watcher, created, historyCalls, config };
}

describe("slack-intake helpers", () => {
  it("scores problem reports above chatter", () => {
    expect(scoreProblemReport("The checkout page is broken, customers getting an error").score).toBeGreaterThanOrEqual(4);
    expect(scoreProblemReport("Lunch at 12?").score).toBe(0);
    expect(scoreProblemReport("Great work on the release team").score).toBe(0);
    expect(scoreProblemReport("Learner said she can't download her certificate").matches).toContain("customer said");
  });

  it("detects existing ticket references", () => {
    expect(referencesTicket("see https://linear.app/teamdsc/issue/TEA-12")).toBe(true);
    expect(referencesTicket("tracked in TEA-4540")).toBe(true);
    expect(referencesTicket("login is broken")).toBe(false);
  });

  it("cleans slack mrkdwn", () => {
    expect(cleanSlackText("<@U123> see <https://x.com|the page> &amp; <https://y.com>")).toBe(
      "@U123 see the page & https://y.com",
    );
  });

  it("builds a title from the first sentence, max 80 chars", () => {
    expect(buildSlackTicketTitle("Login is broken for some users. Started this morning.")).toBe("Login is broken for some users.");
    const long = "a".repeat(200);
    expect(buildSlackTicketTitle(long)).toHaveLength(80);
    expect(buildSlackTicketTitle("first line no period\nsecond line")).toBe("first line no period");
  });

  it("round-trips the dedupe marker and includes quote, reporter and permalink", () => {
    const d: SlackTicketDraft = {
      channel: CH,
      ts: "1762250000.000100",
      user: "U999",
      text: "Payments failing\nfor everyone",
      permalink: "https://slack.com/archives/x/p1",
      score: 4,
      matches: ["failed"],
    };
    const desc = buildSlackTicketDescription(d);
    expect(desc.startsWith(slackMarker(CH, d.ts))).toBe(true);
    expect(extractSlackKeys(desc)).toEqual([`${CH}:1762250000.000100`]);
    expect(desc).toContain("> Payments failing\n> for everyone");
    expect(desc).toContain("U999");
    expect(desc).toContain("https://slack.com/archives/x/p1");
  });

  it("defaults: Triage, slack-intake label, 30 min, env bot token", () => {
    const c = slackIntakeConfigWithDefaults({}, { SLACK_BOT_TOKEN: "xoxb-env" });
    expect(c).toMatchObject({
      enabled: false,
      targetState: "Triage",
      label: "slack-intake",
      runIntervalMs: 30 * 60 * 1000,
      channels: [CH],
      botToken: "xoxb-env",
    });
  });
});

describe("SlackIntakeWatcher", () => {
  const problem = (offset: number, extra?: Partial<SlackMessage>): SlackMessage => ({
    ts: ts(offset),
    user: "UKRISTEN",
    text: "The booking form is broken, customer said it shows an error on submit.",
    ...extra,
  });

  it("does nothing when disabled", async () => {
    const h = harness({ messages: [problem(-10)], config: { enabled: false } });
    await h.watcher.reconcile();
    expect(h.historyCalls).toHaveLength(0);
  });

  it("files problem reports and skips bots, subtypes, thread replies, ticket refs and chatter", async () => {
    const h = harness({
      messages: [
        problem(-50),
        problem(-40, { botId: "B1" }),
        problem(-35, { subtype: "channel_join" }),
        problem(-30, { threadTs: ts(-50) }),
        problem(-25, { text: "This is broken again, see TEA-123 error" }),
        problem(-20, { text: "Morning all! Coffee anyone?" }),
        problem(-15, { threadTs: ts(-15), text: "Learners can't log in — getting an error" }), // thread parent: ok
      ],
    });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.ts)).toEqual([ts(-50), ts(-15)]);
    expect(h.created[0].permalink).toContain("slack.com/archives");
    expect(h.created[0].user).toBe("UKRISTEN");
  });

  it("filters by reporter ids when configured", async () => {
    const h = harness({
      messages: [problem(-20), problem(-10, { user: "URANDOM" })],
      config: { reporterUserIds: ["UKRISTEN"] },
    });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.user)).toEqual(["UKRISTEN"]);
  });

  it("dedups against existing markers", async () => {
    const h = harness({ messages: [problem(-20), problem(-10)], existing: new Set([`${CH}:${ts(-20)}`]) });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.ts)).toEqual([ts(-10)]);
  });

  it("persists the cursor so messages are only read once, and gates on the run interval", async () => {
    let now = NOW;
    const h = harness({ messages: [problem(-20)], now: () => now });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(1);
    const saved = JSON.parse(fs.readFileSync(h.config.statePath, "utf-8"));
    expect(saved.cursors[CH]).toBe(ts(-20));

    await h.watcher.reconcile(); // interval gate
    expect(h.historyCalls).toHaveLength(1);

    now += h.config.runIntervalMs;
    await h.watcher.reconcile();
    expect(h.historyCalls).toHaveLength(2);
    expect(h.historyCalls[1].oldest).toBe(ts(-20));
    expect(h.created).toHaveLength(1);
  });

  it("first run starts one interval back (no history backfill)", async () => {
    const h = harness({ messages: [problem(-3 * 60 * 60), problem(-60)] });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.ts)).toEqual([ts(-60)]);
  });

  it("respects maxTicketsPerRun and leaves the cursor before the unfiled message", async () => {
    const h = harness({ messages: [problem(-30), problem(-20), problem(-10)], config: { maxTicketsPerRun: 2 } });
    const created = await h.watcher.runOnce();
    expect(created).toHaveLength(2);
    const saved = JSON.parse(fs.readFileSync(h.config.statePath, "utf-8"));
    expect(saved.cursors[CH]).toBe(ts(-20));
  });

  it("does not advance the cursor past a failed create", async () => {
    const h = harness({ messages: [problem(-30), problem(-20)], createThrowsFor: ts(-30) });
    await h.watcher.runOnce();
    expect(h.created).toHaveLength(0);
    const saved = JSON.parse(fs.readFileSync(h.config.statePath, "utf-8"));
    expect(Number(saved.cursors[CH])).toBeLessThan(Number(ts(-30)));
  });
});

describe("SlackWebHistoryClient", () => {
  it("paginates conversations.history and maps fields", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-t");
      const page2 = url.includes("cursor=c2");
      return new Response(
        JSON.stringify({
          ok: true,
          messages: page2
            ? [{ ts: "2.0", text: "b", bot_id: "B1" }]
            : [{ ts: "1.0", user: "U1", text: "a", thread_ts: "1.0", subtype: undefined }],
          has_more: !page2,
          response_metadata: { next_cursor: page2 ? "" : "c2" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new SlackWebHistoryClient("xoxb-t", fetchImpl);
    const msgs = await client.history(CH, "0.5");
    expect(calls[0]).toContain("conversations.history");
    expect(calls[0]).toContain("oldest=0.5");
    expect(msgs).toEqual([
      { ts: "1.0", user: "U1", text: "a", threadTs: "1.0", botId: undefined, subtype: undefined },
      { ts: "2.0", user: undefined, text: "b", threadTs: undefined, botId: "B1", subtype: undefined },
    ]);
  });

  it("throws on ok:false and returns null permalinks on failure", async () => {
    const fetchImpl = (async (url: string) =>
      new Response(JSON.stringify(url.includes("getPermalink") ? { ok: false } : { ok: false, error: "not_in_channel" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new SlackWebHistoryClient("x", fetchImpl);
    await expect(client.history(CH, "0")).rejects.toThrow("not_in_channel");
    expect(await client.permalink(CH, "1.0")).toBeNull();
  });
});

describe("LinearSlackTicketStore (linear.js mocked)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads markers from labelled issues and creates in Triage with the label", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([
      { description: `${slackMarker(CH, "1.000001")}\nbody`, state: "Done" },
      { description: "no marker", state: "Triage" },
    ]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "Team" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([
      { id: "s-triage", name: "Triage", type: "triage" },
      { id: "s-dev", name: "Dev in Progress", type: "started" },
    ]);
    vi.mocked(linear.resolveOrCreateLabelId).mockResolvedValue("lbl1");
    vi.mocked(linear.createIssue).mockResolvedValue({ id: "i1", identifier: "TEA-9", url: "u" });

    const store = new LinearSlackTicketStore(cfg(), tracker);
    expect([...(await store.existingKeys())]).toEqual([`${CH}:1.000001`]);
    expect(linear.fetchIssuesByLabel).toHaveBeenCalledWith(tracker, "TEA", "slack-intake");

    const t = await store.createTicket({
      channel: CH, ts: "2.000000", user: "U1", text: "Search is broken. Help", permalink: null, score: 2, matches: [],
    });
    expect(t.identifier).toBe("TEA-9");
    const input = vi.mocked(linear.createIssue).mock.calls[0][1];
    expect(input).toMatchObject({ teamId: "team1", stateId: "s-triage", labelIds: ["lbl1"], title: "Search is broken." });
    expect(input.description).toContain("symphony-slack:");
  });
});
