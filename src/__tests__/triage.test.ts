import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../linear.js", () => ({
  executeGraphQL: vi.fn(),
  fetchTeamByKey: vi.fn(),
  fetchWorkflowStates: vi.fn(),
  addComment: vi.fn(),
}));
import * as linear from "../linear.js";
import {
  LinearTriageTracker,
  TriageWatcher,
  applyTriageDecision,
  findDuplicate,
  scoreTriage,
  titleSimilarity,
  triageConfigWithDefaults,
  type OpenIssueRef,
  type TriageConfig,
  type TriageIssue,
  type TriageSuggestion,
  type TriageTracker,
} from "../triage.js";
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

function cfg(o?: Partial<TriageConfig>): TriageConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-triage-"));
  return triageConfigWithDefaults({ enabled: true, statePath: path.join(dir, "triage.json"), ...o });
}

function issue(o: Partial<TriageIssue>): TriageIssue {
  return {
    id: o.identifier ?? "id1",
    identifier: "TEA-1",
    title: "Something",
    description: "",
    labels: [],
    priority: 0,
    state: "Triage",
    url: null,
    ...o,
  };
}

const REPRO = "Steps to reproduce:\n1. Go to /checkout\n2. Click pay\nExpected: success\nActual: spinner forever";

describe("titleSimilarity / findDuplicate", () => {
  it("is 1 for identical titles ignoring case, punctuation and prefixes", () => {
    expect(titleSimilarity("Login button broken!", "[Slack] login BUTTON broken")).toBe(1);
  });
  it("is low for unrelated titles and 0 for empty", () => {
    expect(titleSimilarity("Login button broken", "Add dark mode to dashboard")).toBe(0);
    expect(titleSimilarity("", "x y")).toBe(0);
  });
  it("finds the best match above 0.6", () => {
    const open: OpenIssueRef[] = [
      { id: "a", identifier: "TEA-10", title: "Certificate download fails for learners", url: null },
      { id: "b", identifier: "TEA-11", title: "Certificate download fails", url: null },
    ];
    const d = findDuplicate({ id: "x", title: "Certificate download fails" }, open);
    expect(d?.original.identifier).toBe("TEA-11");
    expect(findDuplicate({ id: "x", title: "Typo on pricing page" }, open)).toBeNull();
  });
});

describe("scoreTriage", () => {
  it("Urgent for outages, login, payments, data loss", () => {
    for (const t of ["Site is down", "Learners can't log in", "Payment failed for every order", "500 on checkout", "Data loss after save"]) {
      expect(scoreTriage(issue({ title: t })).priority).toBe(1);
    }
  });
  it("High for customer-reported bugs", () => {
    expect(scoreTriage(issue({ title: "Booking form error", labels: ["Bug"] })).priority).toBe(2);
    expect(scoreTriage(issue({ title: "Booking form error", labels: ["slack-intake"] })).priority).toBe(2);
    expect(scoreTriage(issue({ title: "A client saw a broken image" })).priority).toBe(2);
  });
  it("Low for cosmetic / copy, Normal by default", () => {
    expect(scoreTriage(issue({ title: "Typo in footer" })).priority).toBe(4);
    expect(scoreTriage(issue({ title: "Refactor util module" })).priority).toBe(3);
  });
  it("machine-signal labels go to dev with high confidence", () => {
    const s = scoreTriage(issue({ title: "[Render Logs] x", labels: ["render-logs"] }));
    expect(s.lane).toBe("dev");
    expect(s.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it("bug with repro steps → dev, confident", () => {
    const s = scoreTriage(issue({ title: "Checkout spinner never stops", description: `Payment page broken.\n${REPRO}`, labels: ["Bug"] }));
    expect(s.lane).toBe("dev");
    expect(s.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it("features and Design needed → backlog", () => {
    expect(scoreTriage(issue({ title: "Course filter", labels: ["Design needed"], description: "Need a mockup for the new filter UI" })).lane).toBe("backlog");
    const s = scoreTriage(issue({ title: "Feature request: export bookings to CSV", description: "It would be nice to export bookings as a CSV from the admin" }));
    expect(s.lane).toBe("backlog");
    expect(s.confidence).toBeGreaterThanOrEqual(0.7);
  });
  it("short / no-repro / mixed tickets are below threshold", () => {
    expect(scoreTriage(issue({ title: "search broken", description: "pls fix" })).confidence).toBeLessThan(0.7);
    expect(scoreTriage(issue({ title: "Hmm", description: "" })).lane).toBeNull();
    const mixed = scoreTriage(issue({
      title: "Search errors and could we add filters",
      description: "Search throws an error sometimes. Also would be nice to have a date filter on the results.",
    }));
    expect(mixed.confidence).toBeLessThan(0.7);
    expect(mixed.reasons.join(" ")).toMatch(/mixed/);
  });
  it("a slack-intake draft description alone does not count as repro steps", () => {
    const s = scoreTriage(issue({
      title: "Booking form is broken",
      labels: ["slack-intake"],
      description:
        "<!-- symphony-slack:C1:1.0 -->\n_Drafted by Symphony from a Slack problem report. Triage: confirm it's a real problem, find out how to reproduce it, set priority._\n\n## Report\n> The booking form is broken, customer said it errors",
    }));
    expect(s.confidence).toBeLessThan(0.7);
  });
});

function fakeTracker(triage: TriageIssue[], open: OpenIssueRef[] = []) {
  const updates: Array<{ id: string; priority?: number; state?: string }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const dupes: Array<[string, string]> = [];
  const tt: TriageTracker = {
    fetchTriageIssues: async () => triage,
    fetchOpenIssues: async () => [...open],
    updateIssue: async (id, u) => { updates.push({ id, ...u }); },
    markDuplicate: async (id, orig) => { dupes.push([id, orig]); },
    addComment: async (id, body) => { comments.push({ id, body }); },
  };
  return { tt, updates, comments, dupes };
}

describe("TriageWatcher", () => {
  it("does nothing when disabled", async () => {
    const f = fakeTracker([issue({ title: "Site is down" })]);
    const fetchSpy = vi.spyOn(f.tt, "fetchTriageIssues");
    const w = new TriageWatcher({ config: cfg({ enabled: false }), tracker, logger, triageTracker: f.tt });
    await w.reconcile();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks duplicates (state + relation + comment linking the original)", async () => {
    const f = fakeTracker(
      [issue({ id: "n1", identifier: "TEA-50", title: "Certificate download fails" })],
      [{ id: "o1", identifier: "TEA-10", title: "Certificate download fails", url: "https://linear.app/x/TEA-10" }],
    );
    const w = new TriageWatcher({ config: cfg(), tracker, logger, triageTracker: f.tt });
    const r = await w.runOnce();
    expect(r?.duplicates).toEqual(["TEA-50"]);
    expect(f.updates).toEqual([{ id: "n1", state: "Duplicate" }]);
    expect(f.dupes).toEqual([["n1", "o1"]]);
    expect(f.comments[0].body).toContain("[TEA-10](https://linear.app/x/TEA-10)");
  });

  it("still marks duplicate when the relation call fails", async () => {
    const f = fakeTracker(
      [issue({ id: "n1", title: "Certificate download fails" })],
      [{ id: "o1", identifier: "TEA-10", title: "Certificate download fails", url: null }],
    );
    f.tt.markDuplicate = async () => { throw new Error("nope"); };
    const r = await new TriageWatcher({ config: cfg(), tracker, logger, triageTracker: f.tt }).runOnce();
    expect(r?.duplicates).toHaveLength(1);
    expect(f.comments).toHaveLength(1);
  });

  it("moves confident issues with priority + lane and keeps a human-set priority", async () => {
    const f = fakeTracker([
      issue({ id: "a", identifier: "TEA-1", title: "[Firebase Logs] api: TypeError", labels: ["firebase-logs"] }),
      issue({ id: "b", identifier: "TEA-2", title: "Course filter design", labels: ["Design needed"], description: "Need a mockup for the new filter UI please", priority: 2 }),
    ]);
    const r = await new TriageWatcher({ config: cfg(), tracker, logger, triageTracker: f.tt }).runOnce();
    expect(r?.moved).toEqual([
      { identifier: "TEA-1", priority: 3, state: "Dev in Progress" },
      { identifier: "TEA-2", priority: 2, state: "Backlog" },
    ]);
    expect(f.comments).toHaveLength(2);
  });

  it("asks once about unclear issues and remembers them in the state file", async () => {
    const unclear = issue({ id: "u1", identifier: "TEA-7", title: "search broken", description: "pls fix" });
    const f = fakeTracker([unclear]);
    const asked: Array<[string, TriageSuggestion]> = [];
    const config = cfg();
    const mk = () =>
      new TriageWatcher({ config, tracker, logger, triageTracker: f.tt, onUnclear: (i, s) => { asked.push([i.identifier, s]); } });

    await mk().runOnce();
    expect(asked).toHaveLength(1);
    expect(asked[0][1]).toMatchObject({ lane: "dev", state: "Dev in Progress" });
    expect(asked[0][1].reasons.length).toBeGreaterThan(0);
    expect(f.updates).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(config.statePath, "utf-8")).asked).toEqual(["u1"]);

    await mk().runOnce(); // fresh watcher, same state file
    expect(asked).toHaveLength(1);
  });

  it("does not remember an issue when onUnclear throws", async () => {
    const f = fakeTracker([issue({ id: "u1", title: "hmm", description: "" })]);
    let calls = 0;
    const config = cfg();
    const w = new TriageWatcher({ config, tracker, logger, triageTracker: f.tt, onUnclear: () => { calls++; throw new Error("x"); } });
    await w.runOnce();
    await w.runOnce();
    expect(calls).toBe(2);
  });

  it("respects maxPerRun and the run interval", async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      issue({ id: `m${i}`, identifier: `TEA-${i}`, title: `Dependabot bump pkg${i} alpha${i} beta${i}`, labels: ["dependabot"] }),
    );
    const f = fakeTracker(many);
    let now = 0;
    const config = cfg({ maxPerRun: 2 });
    const w = new TriageWatcher({ config, tracker, logger, triageTracker: f.tt, now: () => now });
    await w.reconcile();
    expect(f.updates).toHaveLength(2);
    await w.reconcile();
    expect(f.updates).toHaveLength(2);
    now += config.runIntervalMs;
    await w.reconcile();
    expect(f.updates).toHaveLength(4);
  });
});

describe("Linear plumbing (linear.js mocked)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("applyTriageDecision resolves the issue's team + state id and calls issueUpdate", async () => {
    vi.mocked(linear.executeGraphQL).mockImplementation(async (_c, query) => {
      if (query.includes("TriageIssueTeam")) return { issue: { id: "i1", team: { id: "team1", key: "TEA" } } };
      if (query.includes("issueUpdate")) return { issueUpdate: { success: true } };
      throw new Error("unexpected");
    });
    vi.mocked(linear.fetchWorkflowStates).mockResolvedValue([{ id: "s-back", name: "Backlog", type: "backlog" }]);
    await applyTriageDecision(tracker, "i1", { priority: 2, state: "Backlog" });
    const call = vi.mocked(linear.executeGraphQL).mock.calls.find(c => c[1].includes("issueUpdate"))!;
    expect(call[2]).toEqual({ id: "i1", input: { priority: 2, stateId: "s-back" } });
  });

  it("applyTriageDecision accepts a TriageTracker", async () => {
    const f = fakeTracker([]);
    await applyTriageDecision(f.tt, "i9", { priority: 1, state: "Dev in Progress" });
    expect(f.updates).toEqual([{ id: "i9", priority: 1, state: "Dev in Progress" }]);
  });

  it("LinearTriageTracker maps triage issues and creates duplicate relations", async () => {
    vi.mocked(linear.executeGraphQL).mockImplementation(async (_c, query) => {
      if (query.includes("TriageIssues")) {
        return {
          issues: {
            nodes: [{
              id: "i1", identifier: "TEA-1", title: "T", description: null, priority: 0, url: "u",
              state: { name: "Triage" }, labels: { nodes: [{ name: "Bug" }] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("issueRelationCreate")) return { issueRelationCreate: { success: true } };
      throw new Error("unexpected");
    });
    const lt = new LinearTriageTracker(cfg(), tracker);
    expect(await lt.fetchTriageIssues()).toEqual([
      { id: "i1", identifier: "TEA-1", title: "T", description: "", labels: ["Bug"], priority: 0, state: "Triage", url: "u" },
    ]);
    await lt.markDuplicate("i1", "o1");
    const rel = vi.mocked(linear.executeGraphQL).mock.calls.find(c => c[1].includes("issueRelationCreate"))!;
    expect(rel[2]).toEqual({ input: { issueId: "i1", relatedIssueId: "o1", type: "duplicate" } });
  });
});
