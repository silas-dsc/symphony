import { describe, expect, it } from "vitest";
import { parsePrUrl, summariseChecks, toPrInfo, type RollupEntry } from "../github.js";

describe("parsePrUrl", () => {
  it.each([
    ["https://github.com/team-dsc/team-dsc/pull/123", { owner: "team-dsc", repo: "team-dsc", number: 123 }],
    ["https://github.com/team-dsc/team-dsc/pull/123/files", { owner: "team-dsc", repo: "team-dsc", number: 123 }],
    ["https://github.com/team-dsc/team-dsc/pull/7#issuecomment-1", { owner: "team-dsc", repo: "team-dsc", number: 7 }],
    ["https://github.com/a.b/c_d/pull/9?x=1", { owner: "a.b", repo: "c_d", number: 9 }],
    ["  https://www.github.com/o/r/pull/1  ", { owner: "o", repo: "r", number: 1 }],
    ["https://github.com/o/r/issues/1", null],
    ["https://github.com/o/r/pull/abc", null],
    ["https://github.com/o/r/pull/0", null],
    ["https://gitlab.com/o/r/pull/1", null],
    ["not a url", null],
    ["", null],
  ])("%s", (url, expected) => {
    expect(parsePrUrl(url)).toEqual(expected);
  });
});

describe("summariseChecks", () => {
  const run = (name: string, status: string, conclusion: string | null = null): RollupEntry =>
    ({ __typename: "CheckRun", name, status, conclusion });
  const ctx = (context: string, state: string): RollupEntry =>
    ({ __typename: "StatusContext", context, state });

  it.each<[string, RollupEntry[], { passing: number; failing: number; pending: number; failingNames: string[] }]>([
    ["empty", [], { passing: 0, failing: 0, pending: 0, failingNames: [] }],
    ["success", [run("test", "COMPLETED", "SUCCESS")], { passing: 1, failing: 0, pending: 0, failingNames: [] }],
    ["skipped + neutral count as passing", [run("a", "COMPLETED", "SKIPPED"), run("b", "COMPLETED", "NEUTRAL")],
      { passing: 2, failing: 0, pending: 0, failingNames: [] }],
    ["in progress", [run("build", "IN_PROGRESS")], { passing: 0, failing: 0, pending: 1, failingNames: [] }],
    ["queued", [run("build", "QUEUED")], { passing: 0, failing: 0, pending: 1, failingNames: [] }],
    ["failure", [run("lint", "COMPLETED", "FAILURE")], { passing: 0, failing: 1, pending: 0, failingNames: ["lint"] }],
    ["timed out", [run("e2e", "COMPLETED", "TIMED_OUT")], { passing: 0, failing: 1, pending: 0, failingNames: ["e2e"] }],
    ["cancelled", [run("e2e", "COMPLETED", "CANCELLED")], { passing: 0, failing: 1, pending: 0, failingNames: ["e2e"] }],
    ["action required", [run("sec", "COMPLETED", "ACTION_REQUIRED")],
      { passing: 0, failing: 1, pending: 0, failingNames: ["sec"] }],
    ["status context success", [ctx("render", "SUCCESS")], { passing: 1, failing: 0, pending: 0, failingNames: [] }],
    ["status context pending", [ctx("render", "PENDING")], { passing: 0, failing: 0, pending: 1, failingNames: [] }],
    ["status context expected", [ctx("required", "EXPECTED")], { passing: 0, failing: 0, pending: 1, failingNames: [] }],
    ["status context failure", [ctx("render", "FAILURE")], { passing: 0, failing: 1, pending: 0, failingNames: ["render"] }],
    ["status context error", [ctx("render", "ERROR")], { passing: 0, failing: 1, pending: 0, failingNames: ["render"] }],
    ["lower-case values", [{ name: "x", status: "completed", conclusion: "failure" }],
      { passing: 0, failing: 1, pending: 0, failingNames: ["x"] }],
    ["mixed", [
      run("typecheck", "COMPLETED", "SUCCESS"),
      run("test", "COMPLETED", "FAILURE"),
      run("e2e", "IN_PROGRESS"),
      ctx("render/preview", "ERROR"),
      run("docs", "COMPLETED", "SKIPPED"),
    ], { passing: 2, failing: 2, pending: 1, failingNames: ["test", "render/preview"] }],
  ])("%s", (_label, rollup, expected) => {
    expect(summariseChecks(rollup)).toEqual(expected);
  });

  it("tolerates null / undefined", () => {
    expect(summariseChecks(null)).toEqual({ passing: 0, failing: 0, pending: 0, failingNames: [] });
    expect(summariseChecks(undefined)).toEqual({ passing: 0, failing: 0, pending: 0, failingNames: [] });
  });
});

describe("toPrInfo", () => {
  it("maps gh pr view JSON", () => {
    const info = toPrInfo({
      url: "https://github.com/team-dsc/team-dsc/pull/42",
      number: 42,
      state: "MERGED",
      isDraft: false,
      headRefName: "tea-1-fix",
      mergeable: "UNKNOWN",
      additions: 10,
      deletions: 2,
      files: [{ path: "packages/app/app/routes/index.tsx" }, { path: "README.md" }],
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      mergedAt: "2026-11-01T00:00:00Z",
      mergeCommit: { oid: "abc123" },
      id: "PR_kw123",
    }, "https://github.com/team-dsc/team-dsc/pull/42");
    expect(info).toEqual({
      url: "https://github.com/team-dsc/team-dsc/pull/42",
      number: 42,
      owner: "team-dsc",
      repo: "team-dsc",
      state: "MERGED",
      isDraft: false,
      headRefName: "tea-1-fix",
      mergeable: "UNKNOWN",
      additions: 10,
      deletions: 2,
      files: ["packages/app/app/routes/index.tsx", "README.md"],
      checks: { passing: 1, failing: 0, pending: 0, failingNames: [] },
      mergedAt: "2026-11-01T00:00:00Z",
      mergeCommitSha: "abc123",
      nodeId: "PR_kw123",
    });
  });

  it("defaults missing fields", () => {
    const info = toPrInfo({ mergeable: "CONFLICTING" }, "https://github.com/o/r/pull/5");
    expect(info).toMatchObject({
      number: 5, state: "OPEN", mergeable: "CONFLICTING", files: [], mergedAt: null, mergeCommitSha: null,
    });
  });
});
