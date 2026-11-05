import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as linear from "../linear.js";
import * as ops from "../linear-ops.js";
import { GateHub } from "../gate-hub.js";
import { FUNCTIONAL_TEST_ACTION } from "../gates.js";
import { ReviewRequests, previewUrlFor, ticketKeyFrom } from "../review-requests.js";
import { ReleaseFlow, classifyAreas, pickRun, summariseDeploy, type DeployRun, type MergedPr, type ReleaseDeps } from "../release-flow.js";
import type { GitHubClient, PrInfo } from "../github.js";
import type { FtResult } from "../functional-test.js";
import type { Logger, TrackerConfig } from "../types.js";

vi.mock("../linear.js", async () => {
  const actual = await vi.importActual<typeof import("../linear.js")>("../linear.js");
  return { ...actual, addComment: vi.fn(), fetchIssueCommentsDetail: vi.fn(), createIssue: vi.fn() };
});
vi.mock("../linear-ops.js", async () => {
  const actual = await vi.importActual<typeof import("../linear-ops.js")>("../linear-ops.js");
  return { ...actual, addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(), setIssueState: vi.fn(), getIssueContext: vi.fn() };
});

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tracker = { kind: "linear", endpoint: "x", apiKey: "k", projectSlug: "ALL", teamKey: "TEA", activeStates: ["Dev in Progress"], terminalStates: ["Done"] } as TrackerConfig;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
const hub = () => new GateHub({
  operatorKey: "silas",
  people: [{ key: "silas", name: "Silas", slackUserId: null, linearUser: null, maxOpenGates: 10, maxNewGatesPerHour: 6 }],
  designPerson: null, productPerson: null, slackBotToken: null, persistPath: path.join(tmp(), "gates.json"), boardUrl: null,
}, tracker, log);

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  url: "https://github.com/team-dsc/team-dsc/pull/21", number: 21, owner: "team-dsc", repo: "team-dsc", state: "OPEN", isDraft: false,
  headRefName: "feature/tea-77-thing", mergeable: "MERGEABLE", additions: 5, deletions: 1, files: ["packages/app/src/x.tsx"],
  checks: { passing: 2, failing: 0, pending: 0, failingNames: [] }, mergedAt: null, mergeCommitSha: null, nodeId: "N", ...over,
});
const gh = (p: PrInfo): GitHubClient => ({
  getPr: vi.fn(async () => p), mergePr: vi.fn(), createRevertPr: vi.fn(async () => ""), listPrComments: vi.fn(async () => []),
});

beforeEach(() => vi.clearAllMocks());

describe("card side actions", () => {
  it("runs 🧪 from Slack and from a Linear reply without closing the card", async () => {
    const h = hub();
    const ran: string[] = [];
    h.onSideAction(FUNCTIONAL_TEST_ACTION, async (g, by) => { ran.push(`${g.id}:${by}`); });
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([]);
    const g = await h.open({ kind: "code_review", issueId: "iss-1", issueIdentifier: "TEA-1", title: "TEA-1 x", summary: "s", question: "Merge?", meta: { prUrl: pr().url } });
    expect(g.actions.map(a => a.id)).toEqual(["merge", "send_back", FUNCTIONAL_TEST_ACTION]);

    await h.handleSlackAction({ actionId: "x", value: `${g.id}:${FUNCTIONAL_TEST_ACTION}`, userId: "U1", userName: "silas" } as never);
    expect(ran).toHaveLength(1);
    expect(h.store.get(g.id)?.status).toBe("open");

    const reply = { id: "c1", body: "functional test", createdAt: new Date(Date.now() + 1000), author: { name: "Silas", email: null } };
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([reply]);
    await h.reconcileLinearReplies();
    await h.reconcileLinearReplies(); // same reply doesn't run twice
    expect(ran).toHaveLength(2);
    expect(h.store.get(g.id)?.status).toBe("open");
  });
});

describe("review requests", () => {
  it("finds ticket keys and preview URLs", () => {
    expect(ticketKeyFrom("fix(checkout): stop double charge (TEA-5031)")).toBe("TEA-5031");
    expect(ticketKeyFrom("no key", "feature/tea-77-thing")).toBe("TEA-77");
    expect(ticketKeyFrom("Bump react")).toBeNull();
    expect(previewUrlFor("https://web-pr-{{pr}}.onrender.com/health-check", 21)).toBe("https://web-pr-21.onrender.com");
  });

  it("opens one card per requested PR, approves on GitHub (never merges), and drops stale cards", async () => {
    const h = hub();
    const reviews: string[] = [];
    let requested = [{ url: pr().url, number: 21, title: "Add thing", author: "nika" }];
    const client = gh(pr());
    const rr = new ReviewRequests(
      { repo: "team-dsc/team-dsc", previewTemplate: "https://web-pr-{{pr}}.onrender.com", linearWorkspaceUrl: "https://linear.app/team-dsc", intervalMs: 0, maxOpen: 6 },
      h, client, log, async () => requested, async (url, kind) => { reviews.push(`${kind}:${url}`); },
    );
    await rr.reconcile(1);
    await rr.reconcile(2);
    const cards = h.store.openGates().filter(g => g.kind === "pr_review");
    expect(cards).toHaveLength(1);
    expect(cards[0].links?.map(l => l.label)).toEqual(["PR #21", "Diff", "TEA-77", "Preview"]);
    expect(cards[0].meta).toMatchObject({ ticket: "TEA-77", previewUrl: "https://web-pr-21.onrender.com" });

    await h.store.resolve(cards[0].id, "approve", null, "Silas");
    expect(reviews).toEqual([`approve:${pr().url}`]);
    expect(client.mergePr).not.toHaveBeenCalled();

    requested = [{ url: "https://github.com/team-dsc/team-dsc/pull/22", number: 22, title: "Other", author: "wei" }];
    vi.mocked(client.getPr).mockResolvedValue(pr({ url: requested[0].url, number: 22 }));
    await rr.reconcile(3);
    requested = [];
    await rr.reconcile(4);
    expect(h.store.openGates().filter(g => g.kind === "pr_review")).toHaveLength(0);
  });
});

describe("release flow", () => {
  const merged = (over: Partial<MergedPr> = {}): MergedPr => ({
    url: "https://github.com/team-dsc/team-dsc/pull/30", number: 30, title: "Bulk unassign (TEA-4725)", branch: "feature/tea-4725",
    mergedAt: "2026-11-05T01:00:00Z", mergeSha: "aaaaaaa1111", files: ["packages/app/src/routes/x.tsx", "packages/functions/src/y.ts"], ...over,
  });
  const run = (over: Partial<DeployRun> = {}): DeployRun => ({ id: 5, headSha: "aaaaaaa1111", status: "completed", conclusion: "success", createdAt: "2026-11-05T01:00:20Z", url: "https://gh/run/5", ...over });
  const greenJobs = [
    { name: "Deploy app to Render", conclusion: "success", steps: [{ name: "Deploy and wait until live", conclusion: "success" }, { name: "Verify production serves this commit", conclusion: "success" }] },
    { name: "Deploy to Firebase Functions", conclusion: "success", steps: [{ name: "Deploy Functions (Production)", conclusion: "success" }, { name: "Check function secret bindings", conclusion: "success" }] },
  ];

  it("classifies areas and picks the run that deployed the merge", () => {
    expect(classifyAreas(["packages/app/a.tsx"])).toEqual({ app: true, functions: false, rules: false });
    expect(classifyAreas(["docs/a.md"])).toEqual({ app: false, functions: false, rules: false });
    const m = "2026-11-05T01:00:00Z";
    expect(pickRun([run({ createdAt: "2026-11-05T00:50:00Z" })], m).run).toBeNull();
    expect(pickRun([run({ status: "in_progress", conclusion: "" })], m)).toEqual({ run: null, waiting: true });
    expect(pickRun([run({ id: 1, conclusion: "cancelled" }), run({ id: 2, createdAt: "2026-11-05T01:05:00Z" })], m).run?.id).toBe(2);
  });

  it("flags missing secrets and failed app deploys", () => {
    const jobs = [
      { name: "Deploy app to Render", conclusion: "failure", steps: [] },
      { name: "Deploy to Firebase Functions", conclusion: "success", steps: [{ name: "Check function secret bindings", conclusion: "failure" }] },
    ];
    const s = summariseDeploy({ app: true, functions: true, rules: false }, run(), jobs);
    expect(s.problems.join("\n")).toMatch(/App deploy to Render failure/);
    expect(s.problems.join("\n")).toMatch(/Function secrets missing/);
  });

  function flow(deps: Partial<ReleaseDeps>, clock: { t: number }, prodTest = true) {
    const comments: Array<{ issueId: string | null; body: string }> = [];
    const dms: string[] = [];
    const f = new ReleaseFlow({
      repo: "team-dsc/team-dsc", workflow: "Deployment", siteUrl: "https://teamdsc.com.au", watchMinutes: 30, prodTest,
      doneState: "Done", followUpState: "Dev in Progress", statePath: path.join(tmp(), "rel.json"), pollMs: 0, deployTimeoutMs: 120 * 60_000,
    }, tracker, {
      listMerged: async () => [merged()],
      listRuns: async () => [run()],
      runJobs: async () => greenJobs,
      liveRelease: async () => null,
      contains: async () => true,
      errorSources: [async () => new Map([["known error", 2]])],
      runTest: null,
      comment: async (_r, issueId, body) => { comments.push({ issueId, body }); },
      dm: async t => { dms.push(t); },
      now: () => clock.t,
      ...deps,
    }, log);
    return { f, comments, dms };
  }

  const ctx = { id: "iss-4725", identifier: "TEA-4725", title: "Bulk unassign", url: "u", description: "d", priority: null, state: "Done", teamId: "team", states: [{ id: "s-dev", name: "Dev in Progress" }, { id: "s-done", name: "Done" }], labels: [], assigneeId: null };

  it("deploys, checks logs, tests production, then closes a clean release", async () => {
    vi.mocked(ops.getIssueContext).mockResolvedValue(ctx);
    const clock = { t: Date.parse("2026-11-05T01:00:00Z") - 60_000 };
    const ft: FtResult = { runId: "r", verdict: "pass", summary: "ok", checks: [{ name: "a", status: "pass", evidence: "" }], screenshots: [], comparisons: [], fixedCommits: [], problems: [], leftovers: [] };
    const runTest = vi.fn(async () => ft);
    const { f, comments } = flow({ runTest, listMerged: async () => (clock.t < Date.parse("2026-11-05T01:00:00Z") ? [] : [merged()]) }, clock);

    await f.reconcile(); // first run: cursor only, nothing merged yet
    clock.t = Date.parse("2026-11-05T01:10:00Z");
    await f.reconcile(); // tracks PR 30 and reads its deploy run
    expect(comments[0].body).toContain("🚀 **Deploy of PR #30**");
    expect(comments[0].body).toContain("✅ App deployed to Render and serving this commit");
    expect(comments[0].body).toContain("✅ Every function's declared secrets are bound");

    clock.t += 31 * 60_000;
    await f.reconcile(); // logs → testing
    expect(comments[1].body).toContain("0 new error type(s)");
    await vi.waitFor(() => expect(runTest).toHaveBeenCalledWith(expect.objectContaining({ target: "production", mayFix: false, baseUrl: "https://teamdsc.com.au" })));
    await new Promise(r => setTimeout(r, 0));
    await f.reconcile(); // done → close
    expect(ops.setIssueState).toHaveBeenCalledWith(tracker, "iss-4725", "Done");
    expect(comments.at(-1)?.body).toContain("✅ **Released.**");
    expect(f.active()).toHaveLength(0);
  });

  it("opens a follow-up ticket for Symphony when production has new errors", async () => {
    vi.mocked(ops.getIssueContext).mockResolvedValue(ctx);
    vi.mocked(linear.createIssue).mockResolvedValue({ id: "new", identifier: "TEA-9000", url: "https://linear.app/x/TEA-9000" });
    const clock = { t: Date.parse("2026-11-05T00:59:00Z") };
    let call = 0;
    const errorSources = [async () => (call++ % 2 === 0 ? new Map<string, number>() : new Map([["TypeError: x is undefined", 9]]))];
    const { f, dms } = flow({ errorSources, listMerged: async () => (clock.t < Date.parse("2026-11-05T01:00:00Z") ? [] : [merged()]) }, clock, false);
    await f.reconcile();
    clock.t = Date.parse("2026-11-05T01:10:00Z");
    await f.reconcile();
    clock.t += 31 * 60_000;
    await f.reconcile(); // logs (new errors) → done (prod test off)
    await f.reconcile(); // conclude
    expect(linear.createIssue).toHaveBeenCalledWith(tracker, expect.objectContaining({ teamId: "team", parentId: "iss-4725", stateId: "s-dev", title: "Fix after release: Bulk unassign" }));
    expect(ops.setIssueState).not.toHaveBeenCalled();
    expect(dms[0]).toContain("TEA-9000");
  });

  it("ignores merges with nothing to deploy", async () => {
    const clock = { t: Date.parse("2026-11-05T00:59:00Z") };
    const { f, comments } = flow({ listMerged: async () => (clock.t < Date.parse("2026-11-05T01:00:00Z") ? [] : [merged({ files: ["docs/readme.md"] })]) }, clock);
    await f.reconcile();
    clock.t = Date.parse("2026-11-05T01:10:00Z");
    await f.reconcile();
    await f.reconcile();
    expect(comments).toHaveLength(0);
    expect(f.active()).toHaveLength(0);
  });
});
