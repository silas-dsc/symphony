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
  HttpRenderLogsClient,
  LinearRenderTicketStore,
  RenderLogsWatcher,
  buildRenderTicketDescription,
  extractRenderErrorKey,
  fetchErrorSignatures,
  groupRenderErrors,
  isRenderNoise,
  normalizeRenderMessage,
  renderErrorKey,
  renderLogsConfigWithDefaults,
  type RenderErrorGroup,
  type RenderLogEntry,
  type RenderLogsClient,
  type RenderLogsConfig,
  type RenderLogsTicketSnapshot,
  type RenderLogsTicketStore,
} from "../render-logs.js";
import type { Logger, TrackerConfig } from "../types.js";

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const tracker: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "test-key",
  projectSlug: "ALL",
  teamKey: "TEA",
  activeStates: ["Dev in Progress"],
  terminalStates: ["Done", "Canceled"],
};

function cfg(o?: Partial<RenderLogsConfig>): RenderLogsConfig {
  return renderLogsConfigWithDefaults(
    { enabled: true, apiKey: "rnd_test", ownerId: "tea-owner", serviceIds: ["srv-abc123def"], minOccurrences: 2, ...o },
    {},
  );
}

function e(message: string, o?: Partial<RenderLogEntry>): RenderLogEntry {
  return { timestamp: "2026-11-04T10:00:00Z", message, service: "srv-abc123def", ...o };
}

const BUG = "TypeError: Cannot read properties of undefined (reading 'email') at /app/server.js:120:9";

function harness(opts: {
  entries: () => Promise<RenderLogEntry[]>;
  config?: Partial<RenderLogsConfig>;
  snapshot?: RenderLogsTicketSnapshot;
  now?: () => number;
}) {
  const created: Array<{ key: string; group: RenderErrorGroup }> = [];
  const windows: Array<[string, string]> = [];
  const logsClient: RenderLogsClient = {
    fetchErrors: async (s, u) => { windows.push([s, u]); return opts.entries(); },
  };
  const ticketStore: RenderLogsTicketStore = {
    snapshot: async () => opts.snapshot ?? { existingKeys: new Set(), openCount: 0 },
    createTicket: async (group, key) => {
      created.push({ key, group });
      return { identifier: `TEA-${created.length}`, url: null };
    },
  };
  const watcher = new RenderLogsWatcher({
    config: cfg(opts.config), tracker, logger, logsClient, ticketStore, now: opts.now ?? (() => Date.parse("2026-11-04T12:00:00Z")),
  });
  return { watcher, created, windows };
}

describe("render-logs helpers", () => {
  it("normalizes timestamps, ids, uuids, numbers and urls", () => {
    const a = normalizeRenderMessage(
      "2026-11-04T10:00:01.123Z Error: user 65f1c2a9b8e7d6c5b4a39281 not found at https://api.x.com/u/1 (req 5f1d7e2a-1111-2222-3333-444455556666)",
    );
    const b = normalizeRenderMessage(
      "2026-11-03T09:12:44Z Error: user 75f1c2a9b8e7d6c5b4a39282 not found at https://api.x.com/u/99 (req 9f1d7e2a-1111-2222-3333-444455556666)",
    );
    expect(a).toBe(b);
    expect(a).not.toMatch(/2026|65f1|https/);
  });

  it("drops infra noise but keeps app errors", () => {
    for (const m of [
      "GET /healthz 500",
      "npm ERR! signal SIGTERM",
      "==> Deploying...",
      "Restarting service",
      "502 Bad Gateway",
      "Error: connect ECONNREFUSED 10.0.0.1:5432",
    ]) expect(isRenderNoise(m)).toBe(true);
    expect(isRenderNoise(BUG)).toBe(false);
  });

  it("groups by service + signature and tracks counts/time span", () => {
    const groups = groupRenderErrors([
      e(BUG, { timestamp: "2026-11-04T10:00:00Z" }),
      e(BUG.replace("120:9", "121:3"), { timestamp: "2026-11-04T11:00:00Z" }),
      e(BUG, { service: "srv-other0001" }),
    ]);
    expect(groups).toHaveLength(2);
    const g = groups.find(x => x.service === "srv-abc123def")!;
    expect(g.count).toBe(2);
    expect(g.firstSeen).toBe("2026-11-04T10:00:00Z");
    expect(g.lastSeen).toBe("2026-11-04T11:00:00Z");
  });

  it("round-trips the dedupe marker", () => {
    const [g] = groupRenderErrors([e(BUG)]);
    const key = renderErrorKey(g);
    const desc = buildRenderTicketDescription(g, key);
    expect(desc).toContain(`<!-- symphony-render-log:${key} -->`);
    expect(extractRenderErrorKey(desc)).toBe(key);
  });

  it("fetchErrorSignatures returns noise-free signature counts for before/after diffing", async () => {
    const client: RenderLogsClient = {
      fetchErrors: async () => [e(BUG), e(BUG), e("502 Bad Gateway"), e("Error: boom 42")],
    };
    const sigs = await fetchErrorSignatures(client, "a", "b");
    expect([...sigs.values()].sort()).toEqual([1, 2]);
    expect([...sigs.keys()].every(k => k.startsWith("srv-abc123def: "))).toBe(true);
  });

  it("defaults read env for secrets", () => {
    const c = renderLogsConfigWithDefaults({}, { RENDER_API_KEY: "k", RENDER_OWNER_ID: "o", RENDER_SERVICE_IDS: "srv-a, srv-b" });
    expect(c).toMatchObject({ apiKey: "k", ownerId: "o", serviceIds: ["srv-a", "srv-b"], label: "render-logs", enabled: false });
  });
});

describe("RenderLogsWatcher", () => {
  it("does nothing when disabled", async () => {
    const h = harness({ entries: async () => [e(BUG), e(BUG)], config: { enabled: false } });
    await h.watcher.reconcile();
    expect(h.windows).toHaveLength(0);
  });

  it("files loudest signatures first, applying minOccurrences, noise filter and maxTicketsPerRun", async () => {
    const h = harness({
      entries: async () => [
        e(BUG), e(BUG), e(BUG),
        e("Error: payment intent missing"), e("Error: payment intent missing"),
        e("Error: rare thing"),
        e("502 Bad Gateway"), e("502 Bad Gateway"), e("502 Bad Gateway"), e("502 Bad Gateway"),
        e("Error: third"), e("Error: third"),
      ],
      config: { maxTicketsPerRun: 2 },
    });
    await h.watcher.reconcile();
    expect(h.created.map(c => c.group.count)).toEqual([3, 2]);
    expect(h.created[0].group.sample).toBe(BUG);
    expect(h.windows[0]).toEqual(["2026-11-03T12:00:00.000Z", "2026-11-04T12:00:00.000Z"]);
  });

  it("dedups against open tickets and respects maxOpenTickets", async () => {
    const [g] = groupRenderErrors([e(BUG)]);
    const h = harness({
      entries: async () => [e(BUG), e(BUG), e("Error: other"), e("Error: other"), e("Error: third"), e("Error: third")],
      snapshot: { existingKeys: new Set([renderErrorKey(g)]), openCount: 4 },
      config: { maxOpenTickets: 5 },
    });
    await h.watcher.reconcile();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].group.sample).not.toBe(BUG);
  });

  it("gates on the run interval and retries after a failed scan", async () => {
    let now = 0;
    let fail = true;
    const h = harness({
      entries: async () => { if (fail) throw new Error("render down"); return []; },
      now: () => now,
    });
    await h.watcher.reconcile();
    fail = false;
    await h.watcher.reconcile(); // retried immediately
    expect(h.windows).toHaveLength(2);
    await h.watcher.reconcile(); // gated
    expect(h.windows).toHaveLength(2);
    now += cfg().runIntervalMs;
    await h.watcher.reconcile();
    expect(h.windows).toHaveLength(3);
  });
});

describe("HttpRenderLogsClient", () => {
  it("builds the /v1/logs query and follows hasMore", async () => {
    const urls: URL[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(new URL(url));
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rnd_test");
      const first = urls.length === 1;
      return new Response(
        JSON.stringify({
          hasMore: first,
          nextStartTime: "2026-11-04T00:00:00Z",
          nextEndTime: "2026-11-04T05:00:00Z",
          logs: [
            {
              id: first ? "l1" : "l2",
              message: first ? "Error: a" : "Error: b",
              timestamp: "2026-11-04T06:00:00Z",
              labels: [{ name: "resource", value: "srv-abc123def" }, { name: "level", value: "error" }],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new HttpRenderLogsClient(cfg({ serviceIds: ["srv-a", "srv-b"] }), fetchImpl);
    const rows = await client.fetchErrors("2026-11-03T12:00:00Z", "2026-11-04T12:00:00Z");
    expect(urls[0].origin + urls[0].pathname).toBe("https://api.render.com/v1/logs");
    expect(urls[0].searchParams.get("ownerId")).toBe("tea-owner");
    expect(urls[0].searchParams.getAll("resource")).toEqual(["srv-a", "srv-b"]);
    expect(urls[0].searchParams.get("level")).toBe("error");
    expect(urls[0].searchParams.get("startTime")).toBe("2026-11-03T12:00:00Z");
    expect(urls[1].searchParams.get("endTime")).toBe("2026-11-04T05:00:00Z");
    expect(rows).toEqual([
      { timestamp: "2026-11-04T06:00:00Z", message: "Error: a", service: "srv-abc123def" },
      { timestamp: "2026-11-04T06:00:00Z", message: "Error: b", service: "srv-abc123def" },
    ]);
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(new HttpRenderLogsClient(cfg(), fetchImpl).fetchErrors("a", "b")).rejects.toThrow("401");
  });
});

describe("LinearRenderTicketStore (linear.js mocked)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("counts only open tickets and creates in the target state with the label", async () => {
    vi.mocked(linear.fetchIssuesByLabel).mockResolvedValue([
      { description: "<!-- symphony-render-log:aaaa1111 -->", state: "Dev in Progress" },
      { description: "<!-- symphony-render-log:bbbb2222 -->", state: "Done" },
    ]);
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "Team" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "s-dev", name: "Dev in Progress", type: "started" }]);
    vi.mocked(linear.resolveOrCreateLabelId).mockResolvedValue("lbl-r");
    vi.mocked(linear.createIssue).mockResolvedValue({ id: "i", identifier: "TEA-5", url: null });

    const store = new LinearRenderTicketStore(cfg(), tracker);
    const snap = await store.snapshot();
    expect(snap.openCount).toBe(1);
    expect([...snap.existingKeys]).toEqual(["aaaa1111"]);

    const [g] = groupRenderErrors([e(BUG)]);
    await store.createTicket(g, "k1");
    expect(vi.mocked(linear.createIssue).mock.calls[0][1]).toMatchObject({
      teamId: "team1", stateId: "s-dev", labelIds: ["lbl-r"],
    });
  });

  it("throws when the target state is missing", async () => {
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team1", key: "TEA", name: "Team" });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([]);
    const [g] = groupRenderErrors([e(BUG)]);
    await expect(new LinearRenderTicketStore(cfg(), tracker).createTicket(g, "k")).rejects.toThrow("Dev in Progress");
  });
});
