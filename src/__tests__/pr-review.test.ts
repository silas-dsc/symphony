import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PrReviewer, parseReviewComment, renderReviewPrompt, shouldReview, type OpenPr, type ReviewDeps } from "../pr-review.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  number: 10, url: "https://github.com/team-dsc/team-dsc/pull/10", title: "Thing", branch: "feature/tea-1",
  headSha: "aaaaaaaa", isDraft: false, isFork: false, author: "silas-dsc", ...over,
});
const done = (verdict = "approve") => `Reviewed.\n\n\`\`\`review-comment\nFixed:\n- src/a.ts:3 null check\n\nVerdict: ${verdict}\n\`\`\``;

function reviewer(open: () => OpenPr[], over: Partial<ReviewDeps> = {}, cfg: { reviewExisting?: boolean; cap?: number; minLines?: number } = {}) {
  const calls = { comments: [] as string[], statuses: [] as string[], pushes: [] as string[], prompts: [] as string[] };
  let head = "aaaaaaaa";
  const deps: ReviewDeps = {
    listOpen: async () => open(),
    prepare: async p => { head = p.headSha; return "/ws"; },
    runAgent: async prompt => { calls.prompts.push(prompt); return done(); },
    headOf: async () => head,
    changedSince: async () => ["src/a.ts"],
    remoteHead: async p => p.headSha,
    push: async (_cwd, branch) => { calls.pushes.push(branch); },
    comment: async (_u, body) => { calls.comments.push(body); },
    status: async (sha, state) => { calls.statuses.push(`${sha}:${state}`); },
    now: () => 1_800_000_000_000,
    ...over,
  };
  const r = new PrReviewer({
    repo: "team-dsc/team-dsc", level: "high", intervalMs: 0, rereviewMinLines: cfg.minLines ?? 0, maxPerPrPerDay: cfg.cap ?? 6, reviewExisting: cfg.reviewExisting ?? false,
    statePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prr-")), "s.json"),
    workspaceRoot: "/x", hooks: { afterCreate: null, beforeRun: null, timeoutMs: 1 }, timeoutMs: 1,
  }, deps, log);
  return { r, calls, setHead: (h: string) => { head = h; } };
}

describe("PR review", () => {
  it("skips drafts, forks and Dependabot", () => {
    expect(shouldReview(pr())).toBe(true);
    expect(shouldReview(pr({ isDraft: true }))).toBe(false);
    expect(shouldReview(pr({ isFork: true }))).toBe(false);
    expect(shouldReview(pr({ author: "app/dependabot" }))).toBe(false);
  });

  it("runs the code-review skill at the configured level with --fix", () => {
    const p = renderReviewPrompt(pr(), "high");
    expect(p).toContain("`code-review` skill with arguments `high --fix 10`");
    expect(p).toContain("Don't push");
  });

  it("parses the comment block and verdict", () => {
    expect(parseReviewComment(done("changes"))).toMatchObject({ verdict: "changes" });
    expect(parseReviewComment("no block")).toBeNull();
  });

  it("doesn't backfill PRs open at start, then reviews each new commit once", async () => {
    let open = [pr()];
    const { r, calls } = reviewer(() => open);
    await r.reconcile();
    expect(calls.prompts).toHaveLength(0);
    open = [pr({ headSha: "bbbbbbbb" })];
    await r.reconcile();
    await r.reconcile();
    expect(calls.prompts).toHaveLength(1);
    expect(calls.statuses).toEqual(["bbbbbbbb:pending", "bbbbbbbb:success"]);
    expect(calls.comments[0]).toContain("Verdict: approve");
    expect(calls.pushes).toHaveLength(0);
  });

  it("pushes fix commits with hooks off and doesn't re-review its own push", async () => {
    let open = [pr()];
    let runs = 0;
    const h = reviewer(() => open, {
      runAgent: async () => { runs++; h.setHead("cccccccc"); return done("approve"); },
    }, { reviewExisting: true });
    await h.r.reconcile();
    expect(h.calls.pushes).toEqual(["feature/tea-1"]);
    expect(h.calls.statuses.at(-1)).toBe("cccccccc:success");
    expect(h.calls.comments[0]).toContain("fixes pushed in ccccccc");
    open = [pr({ headSha: "cccccccc" })];
    await h.r.reconcile();
    expect(runs).toBe(1);
  });

  it("drops fixes when someone pushed during the review", async () => {
    const h = reviewer(() => [pr()], {
      runAgent: async () => { h.setHead("cccccccc"); return done(); },
      remoteHead: async () => "dddddddd",
    }, { reviewExisting: true });
    await h.r.reconcile();
    expect(h.calls.pushes).toHaveLength(0);
    expect(h.calls.statuses.at(-1)).toBe("aaaaaaaa:error");
  });

  it("refuses to push a commit that touches git hooks", async () => {
    const h = reviewer(() => [pr()], {
      runAgent: async () => { h.setHead("cccccccc"); return done(); },
      changedSince: async () => [".husky/pre-push"],
    }, { reviewExisting: true });
    await h.r.reconcile();
    expect(h.calls.pushes).toHaveLength(0);
    expect(h.calls.statuses.at(-1)).toBe("aaaaaaaa:error");
  });

  it("caps reviews per PR per day", async () => {
    let n = 0;
    const { r, calls } = reviewer(() => [pr({ headSha: `sha${n++}` })], {}, { reviewExisting: true, cap: 2 });
    for (let i = 0; i < 4; i++) await r.reconcile();
    expect(calls.prompts).toHaveLength(2);
  });

  it("re-reviews only after a big enough push since the last review", async () => {
    let head = "aaaaaaaa";
    let lines = 20;
    const checks: string[] = [];
    const { r, calls } = reviewer(() => [pr({ headSha: head })], {
      linesChanged: async (_p, from) => { checks.push(from); return lines; },
    }, { reviewExisting: true, minLines: 150 });
    await r.reconcile();
    expect(calls.prompts).toHaveLength(1); // first review once ready
    head = "bbbbbbbb";
    await r.reconcile();
    await r.reconcile(); // same small head: no second compare call
    expect(calls.prompts).toHaveLength(1);
    expect(checks).toEqual(["aaaaaaaa"]);
    head = "cccccccc";
    lines = 200; // cumulative since the last reviewed commit
    await r.reconcile();
    expect(calls.prompts).toHaveLength(2);
    expect(checks.at(-1)).toBe("aaaaaaaa");
  });
});
