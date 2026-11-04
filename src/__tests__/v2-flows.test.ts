import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as linear from "../linear.js";
import * as ops from "../linear-ops.js";
import { GateHub, formatCardComment, parseReply } from "../gate-hub.js";
import { ReviewFlow, findPreviewUrl, parseDelivery, parseReviewVerdict } from "../review-flow.js";
import { askActions, parseAsk } from "../ask-flow.js";
import { DeployGuard, newSignatures } from "../deploy-guard.js";
import { parseV2Config, validateV2Config } from "../v2-config.js";
import { buildStageArgs } from "../stages.js";
import { AI_COMMENT_MARKER } from "../rework-cleanup.js";
import type { GitHubClient, PrInfo } from "../github.js";
import type { Logger, TrackerConfig } from "../types.js";

vi.mock("../linear.js", async () => {
  const actual = await vi.importActual<typeof import("../linear.js")>("../linear.js");
  return { ...actual, addComment: vi.fn(), fetchIssueCommentsDetail: vi.fn(), fetchIssuePrUrl: vi.fn() };
});
vi.mock("../linear-ops.js", async () => {
  const actual = await vi.importActual<typeof import("../linear-ops.js")>("../linear-ops.js");
  return {
    ...actual,
    addIssueLabel: vi.fn(), removeIssueLabel: vi.fn(), setIssueAssignee: vi.fn(), setIssueState: vi.fn(),
    getIssueContext: vi.fn(), resolveUserId: vi.fn(), fetchIssuesInState: vi.fn(),
  };
});

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tracker = { kind: "linear", endpoint: "x", apiKey: "k", projectSlug: "ALL", teamKey: "TEA", activeStates: ["Dev in Progress"], terminalStates: ["Done"] } as TrackerConfig;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "v2-"));
const comment = (body: string, at = "2026-11-04T01:00:00Z", name = "Silas") => ({ id: Math.random().toString(), body, createdAt: new Date(at), author: { name, email: null } });

function hub(dir = tmp()): GateHub {
  return new GateHub({
    operatorKey: "silas",
    people: [
      { key: "silas", name: "Silas", slackUserId: null, linearUser: null, maxOpenGates: 10, maxNewGatesPerHour: 6 },
      { key: "nika", name: "Nika", slackUserId: null, linearUser: "nika@x", maxOpenGates: 2, maxNewGatesPerHour: 2 },
    ],
    designPerson: "nika", productPerson: null, slackBotToken: null, persistPath: path.join(dir, "gates.json"), boardUrl: null,
  }, tracker, log);
}

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/team-dsc/team-dsc/pull/7", number: 7, owner: "team-dsc", repo: "team-dsc", state: "OPEN", isDraft: false,
    headRefName: "feature/tea-1", mergeable: "MERGEABLE", additions: 10, deletions: 2, files: ["docs/x.md"],
    checks: { passing: 3, failing: 0, pending: 0, failingNames: [] }, mergedAt: null, mergeCommitSha: null, nodeId: "PR_1", ...over,
  };
}

function fakeGh(p: PrInfo, comments: Array<{ body: string; createdAt: string }> = []): GitHubClient & { merged: string[] } {
  const merged: string[] = [];
  return {
    merged,
    getPr: vi.fn(async () => p),
    mergePr: vi.fn(async (u: string) => { merged.push(u); }),
    createRevertPr: vi.fn(async () => "https://github.com/team-dsc/team-dsc/pull/99"),
    listPrComments: vi.fn(async () => comments),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("gate hub", () => {
  it("routes design gates to the operator first with an Ask Nika option, and forwards on reply", async () => {
    const h = hub();
    vi.mocked(ops.getIssueContext).mockResolvedValue({ assigneeId: "u-silas" } as ops.IssueContext);
    vi.mocked(ops.resolveUserId).mockResolvedValue("u-nika");
    const g = await h.open({ kind: "visual_signoff", issueId: "i1", issueIdentifier: "TEA-1", title: "TEA-1 Page", summary: "s" });
    expect([g.assignee, g.forwardTo]).toEqual(["silas", "nika"]);
    expect(ops.addIssueLabel).toHaveBeenCalledWith(tracker, "i1", "waiting-on:silas");
    const card = vi.mocked(linear.addComment).mock.calls[0][2];
    expect(card.startsWith(AI_COMMENT_MARKER)).toBe(true);
    expect(card).toContain("`ask nika`");

    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([comment("ask nika", new Date(Date.now() + 1000).toISOString())]);
    await h.reconcileLinearReplies();
    expect(h.store.get(g.id)?.assignee).toBe("nika");
    expect(ops.setIssueAssignee).toHaveBeenCalledWith(tracker, "i1", "u-nika");
    expect(h.load("nika").open).toBe(1);
  });

  it("does not open a second card of the same kind for an issue", async () => {
    const h = hub();
    const a = await h.open({ kind: "code_review", issueId: "i2", title: "t", summary: "s" });
    const b = await h.open({ kind: "code_review", issueId: "i2", title: "t", summary: "s" });
    expect(a.id).toBe(b.id);
  });

  it("parses approve / send back replies with notes, ignoring agent comments", () => {
    const g = hub().store.open({ kind: "code_review", title: "t", summary: "s" });
    expect(parseReply(g, "LGTM")).toEqual({ actionId: "merge", note: null });
    expect(parseReply(g, "send back: the button is misaligned\non mobile")).toEqual({ actionId: "send_back", note: "the button is misaligned\non mobile" });
    expect(parseReply(g, `${AI_COMMENT_MARKER}\nmerge`)).toBeNull();
    expect(parseReply(g, "thinking about it")).toBeNull();
    expect(formatCardComment(g, "Silas", null)).toContain("Reply `merge` or `send back: <what to change>`");
  });
});

describe("review flow helpers", () => {
  const delivery = comment([
    AI_COMMENT_MARKER, "## ✅ Ready for review", "", "Learners now see their due date.", "",
    "**Checked:** typecheck + lint, admin flow", "**Not checked:** learner sign-in (no test account)", "",
    "![desktop](https://uploads.linear.app/a.png)", "PR: https://github.com/x/y/pull/1",
  ].join("\n"));

  it("extracts the delivery summary, checks and screenshots", () => {
    expect(parseDelivery([delivery])).toEqual({
      summary: "Learners now see their due date.",
      checked: "typecheck + lint, admin flow",
      notChecked: "learner sign-in (no test account)",
      images: [{ label: "desktop", url: "https://uploads.linear.app/a.png" }],
    });
  });

  it("reads the AI review verdict and the Render preview URL", () => {
    expect(parseReviewVerdict([{ body: "BLOCKER: a.ts:3 null deref\nFIX: b.ts:9 add test\nVerdict: changes" }]))
      .toEqual({ verdict: "changes", findings: ["BLOCKER: a.ts:3 null deref", "FIX: b.ts:9 add test"] });
    expect(findPreviewUrl([{ body: "deployed to https://team-dsc-production-preview-web-pr-7.onrender.com/health-check - ok" }]))
      .toBe("https://team-dsc-production-preview-web-pr-7.onrender.com");
  });
});

describe("review flow", () => {
  const cfg = (dir: string) => ({
    teamKey: "TEA", reviewState: "In Review", reworkState: "Dev in Progress", mergedState: null, autoMerge: true,
    killSwitchPath: path.join(dir, "off"), maxAutoSendBacks: 2, statePath: path.join(dir, "rf.json"),
  });
  const issue = { id: "i1", identifier: "TEA-1", title: "Fix docs", url: "https://linear.app/t/TEA-1", description: "", priority: 3, labels: [] };
  const agentComment = comment(`${AI_COMMENT_MARKER}\n## ✅ Ready for review\n\nDone.`);

  beforeEach(() => {
    vi.mocked(ops.fetchIssuesInState).mockResolvedValue([issue]);
    vi.mocked(linear.fetchIssuePrUrl).mockResolvedValue(pr().url);
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([agentComment]);
  });

  it("auto-merges a low-risk, green, non-UI PR and starts the deploy watch", async () => {
    const dir = tmp();
    const gh = fakeGh(pr());
    const merged = vi.fn();
    await new ReviewFlow(cfg(dir), tracker, hub(dir), gh, log, merged).reconcile();
    expect(gh.merged).toEqual([pr().url]);
    expect(merged).toHaveBeenCalledWith(expect.objectContaining({ identifier: "TEA-1" }));
  });

  it("respects the kill switch: opens a code review card instead", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "off"), "");
    const h = hub(dir);
    const gh = fakeGh(pr());
    await new ReviewFlow(cfg(dir), tracker, h, gh, log, vi.fn()).reconcile();
    expect(gh.merged).toEqual([]);
    expect(h.store.openGates().map(g => g.kind)).toEqual(["code_review"]);
  });

  it("sends failing CI back automatically, then escalates to a human after the limit", async () => {
    const dir = tmp();
    const h = hub(dir);
    const failing = pr({ checks: { passing: 1, failing: 1, pending: 0, failingNames: ["typecheck"] } });
    const flow = new ReviewFlow(cfg(dir), tracker, h, fakeGh(failing), log, vi.fn());
    await flow.reconcile();
    await flow.reconcile();
    expect(ops.setIssueState).toHaveBeenCalledTimes(2);
    expect(vi.mocked(linear.addComment).mock.calls[0][2]).toContain("CI failing: typecheck");
    await flow.reconcile();
    expect(h.store.openGates()[0].summary).toContain("CI still failing after 2 auto-fix tries");
  });

  it("opens a visual sign-off for UI changes, and merges on approve", async () => {
    const dir = tmp();
    const h = hub(dir);
    const gh = fakeGh(pr({ files: ["packages/app/app/routes/learn.tsx"] }));
    await new ReviewFlow(cfg(dir), tracker, h, gh, log, vi.fn()).reconcile();
    const gate = h.store.openGates()[0];
    expect(gate.kind).toBe("visual_signoff");
    await h.store.resolve(gate.id, "looks_good", null, "Silas");
    expect(gh.merged).toEqual([pr().url]);
  });

  it("ignores tickets Symphony didn't build", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([comment("human only")]);
    const gh = fakeGh(pr());
    await new ReviewFlow(cfg(tmp()), tracker, hub(), gh, log, vi.fn()).reconcile();
    expect(gh.getPr).not.toHaveBeenCalled();
  });
});

describe("ask flow", () => {
  it("turns options into buttons, recommended first", () => {
    const ask = parseAsk(`${AI_COMMENT_MARKER}\n<!-- symphony-ask:approve_approach -->\n**Question:** Store due dates where?\n- **A:** New field on assignment (recommended)\n- **B:** Separate collection`)!;
    expect(ask.question).toBe("Store due dates where?");
    const actions = askActions(ask);
    expect(actions.map(a => a.label)).toEqual(["A: New field on assignment", "B: Separate collection", "Something else"]);
    expect(actions[0].primary).toBe(true);
    expect(askActions({ kind: "login_credential", question: "q", options: [] }).map(a => a.id)).toEqual(["done", "cant"]);
  });
});

describe("deploy guard", () => {
  it("flags only signatures that are new and frequent", () => {
    const before = new Map([["a", 5]]);
    const after = new Map([["a", 9], ["b", 4], ["c", 1]]);
    expect(newSignatures(before, after, 3)).toEqual([["b", 4]]);
  });

  it("opens a revert PR and a card when a merge introduced errors", async () => {
    const dir = tmp();
    const h = hub(dir);
    const gh = fakeGh(pr());
    const source = vi.fn(async (since: string) =>
      (Date.parse(since) < Date.parse("2026-11-04T10:00:00Z") ? new Map<string, number>() : new Map([["render: TypeError x", 7]])));
    const guard = new DeployGuard({ watchMinutes: 30, minNewOccurrences: 3, statePath: path.join(dir, "dg.json") }, tracker, [source], gh, h, log);
    guard.track("i1", "TEA-1", pr({ mergedAt: "2026-11-04T10:00:00Z" }));
    await guard.reconcile(Date.parse("2026-11-04T10:31:00Z"));
    expect(gh.createRevertPr).toHaveBeenCalled();
    const gate = h.store.openGates()[0];
    expect(gate.kind).toBe("merge_deploy");
    await h.store.resolve(gate.id, "merge_revert");
    expect(gh.merged).toEqual(["https://github.com/team-dsc/team-dsc/pull/99"]);
    expect(guard.pending()).toBe(0);
  });
});

describe("v2 config + stages", () => {
  const ctx = { baseDir: "/sym", fallbackBotToken: "xoxb", fallbackChannel: "C1", fallbackTeamKey: "TEA", resolveEnvVar: (v: string) => (v === "$NIKA" ? "U-N" : v), resolvePath: (v: string) => v };

  it("parses people, routing and defaults", () => {
    const c = parseV2Config({
      enabled: true, operator: "silas", design_person: "nika",
      people: [{ key: "silas", name: "Silas" }, { key: "nika", name: "Nika", slack_user_id: "$NIKA", max_open_gates: 2, max_new_gates_per_hour: 2 }],
    }, ctx);
    expect(c.people[1]).toMatchObject({ slackUserId: "U-N", maxOpenGates: 2 });
    expect(c.slack.botToken).toBe("xoxb");
    expect([c.review.autoMerge, c.review.mergedState, c.governor.weeklyBudgetUsd]).toEqual([true, null, null]);
    expect(validateV2Config(c)).toBeNull();
    expect(validateV2Config({ ...c, productPerson: "evie" })).toContain("evie");
  });

  it("passes stage subagents and the Stop hook to claude, unless disabled", () => {
    const args = buildStageArgs("/sym");
    const agents = JSON.parse(args[args.indexOf("--agents") + 1]);
    expect(Object.keys(agents)).toEqual(["planner", "verifier", "reviewer"]);
    expect(args[args.indexOf("--settings") + 1]).toContain("verify-stop-hook.mjs");
    process.env.SYMPHONY_STAGES = "off";
    expect(buildStageArgs("/sym")).toEqual([]);
    delete process.env.SYMPHONY_STAGES;
  });
});
