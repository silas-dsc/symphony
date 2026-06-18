import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "../config.js";
import {
  MergeConflictResolver,
  branchMatchesActiveKey,
  isLockfileOnly,
  renderResolveConflictsPrompt,
  type ConflictPrClient,
  type ConflictingPR,
  type ResolveConflictsContext,
} from "../merge-conflict.js";
import type { HooksConfig, Logger, MergeConflictConfig } from "../types.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeConfig(overrides?: Partial<MergeConflictConfig>): MergeConflictConfig {
  return {
    enabled: true,
    repoOwner: "team-dsc",
    repoName: "team-dsc",
    maxTurns: 30,
    timeoutMs: 1_200_000,
    maxConcurrent: 2,
    retryIntervalMs: 600_000,
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

const noHooks: HooksConfig = { timeoutMs: 1000 };

function makePR(number: number, overrides?: Partial<ConflictingPR>): ConflictingPR {
  return {
    number,
    title: `PR ${number}`,
    headBranch: `feature/pr-${number}`,
    baseBranch: "main",
    url: `https://github.com/team-dsc/team-dsc/pull/${number}`,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  // Let the fire-and-forget startResolution chains settle. All I/O boundaries
  // are injected in these tests, so a handful of microtask turns is enough.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("merge_conflicts config parsing", () => {
  it("defaults to disabled and inherits the github_preview repo", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-mc-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: demo
github_preview:
  repo_owner: acme
  repo_name: widgets
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.mergeConflicts.enabled).toBe(false);
    expect(workflow.config.mergeConflicts.repoOwner).toBe("acme");
    expect(workflow.config.mergeConflicts.repoName).toBe("widgets");
    expect(workflow.config.mergeConflicts.maxConcurrent).toBe(2);
    expect(workflow.config.mergeConflicts.maxTurns).toBe(30);
  });

  it("respects opt-in config and an explicit repo override", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-mc-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: demo
github_preview:
  repo_owner: acme
  repo_name: widgets
merge_conflicts:
  enabled: true
  repo_owner: other-org
  repo_name: other-repo
  max_turns: 12
  timeout_ms: 60000
  max_concurrent: 1
  retry_interval_ms: 120000
  request_timeout_ms: 5000
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.mergeConflicts).toEqual({
      enabled: true,
      repoOwner: "other-org",
      repoName: "other-repo",
      maxTurns: 12,
      timeoutMs: 60000,
      maxConcurrent: 1,
      retryIntervalMs: 120000,
      requestTimeoutMs: 5000,
    });
  });
});

describe("renderResolveConflictsPrompt", () => {
  it("substitutes PR, repo, and workspace variables", () => {
    const out = renderResolveConflictsPrompt(
      "pr=#{{ pr.number }} head={{ pr.head_branch }} base={{ pr.base_branch }} repo={{ repo }} ws={{ workspace }} root={{ symphony.root }}",
      {
        pr: makePR(42, { headBranch: "feature/tea-42", baseBranch: "main" }),
        workspacePath: "/tmp/ws",
        symphonyRoot: "/symphony",
        repo: "team-dsc/team-dsc",
        config: makeConfig(),
        mcpConfigPath: undefined,
        logger: makeLogger(),
      },
    );
    expect(out).toBe("pr=#42 head=feature/tea-42 base=main repo=team-dsc/team-dsc ws=/tmp/ws root=/symphony");
  });
});

describe("branchMatchesActiveKey", () => {
  it("matches a ticket key embedded as a whole token", () => {
    const keys = new Set(["tea-4020"]);
    expect(branchMatchesActiveKey("feature/tea-4020-bulk-download", keys)).toBe(true);
    expect(branchMatchesActiveKey("silas/TEA-4020", keys)).toBe(true);
    expect(branchMatchesActiveKey("tea-4020", keys)).toBe(true);
  });

  it("does not match a different number or a key glued to other text", () => {
    expect(branchMatchesActiveKey("feature/tea-402-foo", new Set(["tea-4020"]))).toBe(false);
    expect(branchMatchesActiveKey("feature/tea-40200", new Set(["tea-4020"]))).toBe(false);
    expect(branchMatchesActiveKey("feature/xtea-4020", new Set(["tea-4020"]))).toBe(false);
    expect(branchMatchesActiveKey("feature/unrelated", new Set(["tea-4020"]))).toBe(false);
  });
});

describe("isLockfileOnly", () => {
  it("is true only when every path is a known lockfile", () => {
    expect(isLockfileOnly(["pnpm-lock.yaml"])).toBe(true);
    expect(isLockfileOnly(["packages/app/pnpm-lock.yaml", "package-lock.json"])).toBe(true);
    expect(isLockfileOnly(["pnpm-lock.yaml", "src/index.ts"])).toBe(false);
    expect(isLockfileOnly(["yarn.lock"])).toBe(false);
    expect(isLockfileOnly([])).toBe(false);
  });
});

describe("MergeConflictResolver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-mc-run-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  interface Spies {
    /** Head branches sent to the Claude agent path. */
    resolved: number[];
    /** Head branches that took the deterministic lockfile fast-path. */
    lockfileHeads: string[];
  }

  function makeResolver(opts: {
    config?: Partial<MergeConflictConfig>;
    list: () => Promise<ConflictingPR[]>;
    classify?: (pr: ConflictingPR) => Promise<string[]>;
    runResolution?: (ctx: ResolveConflictsContext) => Promise<void>;
    getActiveBranchKeys?: () => Promise<Set<string>>;
    now?: () => number;
  }): { resolver: MergeConflictResolver; spies: Spies; listCalls: () => number } {
    let listCalls = 0;
    const spies: Spies = { resolved: [], lockfileHeads: [] };
    const prClient: ConflictPrClient = {
      listConflictingPullRequests: async () => { listCalls++; return opts.list(); },
    };
    const resolver = new MergeConflictResolver({
      config: makeConfig(opts.config),
      workspaceRoot: tmpRoot,
      hooks: noHooks,
      symphonyRoot: tmpRoot,
      mcpConfigPath: undefined,
      logger: makeLogger(),
      prClient,
      getActiveBranchKeys: opts.getActiveBranchKeys,
      // Default classify reports a general (non-lockfile) conflict → agent path.
      classifyConflicts: async (_cwd, pr) => (opts.classify ? opts.classify(pr) : ["src/foo.ts"]),
      resolveLockfiles: async (_cwd, head) => { spies.lockfileHeads.push(head); },
      abortMerge: async () => { /* no-op */ },
      runResolution: opts.runResolution ?? (async (ctx) => { spies.resolved.push(ctx.pr.number); }),
      now: opts.now,
    });
    return { resolver, spies, listCalls: () => listCalls };
  }

  it("does nothing and never polls when disabled", async () => {
    const { resolver, listCalls } = makeResolver({
      config: { enabled: false },
      list: async () => [makePR(1)],
    });
    await resolver.reconcile();
    expect(listCalls()).toBe(0);
    expect(resolver.getTrackedConflictCount()).toBe(0);
  });

  it("dispatches the agent for a general conflict, then untracks once resolved", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => conflicting,
      classify: async () => ["src/foo.ts", "src/bar.ts"],
    });
    let conflicting: ConflictingPR[] = [makePR(10)];

    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(1);
    expect(fs.existsSync(path.join(tmpRoot, "conflict-pr-10"))).toBe(true);

    conflicting = [];
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, "conflict-pr-10"))).toBe(false);
  });

  it("takes the deterministic lockfile fast-path and skips the agent", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => [makePR(11, { headBranch: "feature/pr-11" })],
      classify: async () => ["pnpm-lock.yaml"],
    });

    await resolver.reconcile();
    await flush();
    expect(spies.lockfileHeads).toEqual(["feature/pr-11"]);
    expect(spies.resolved).toEqual([]);
  });

  it("skips entirely when the classifier finds no real conflict", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => [makePR(12)],
      classify: async () => [],
    });
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([]);
  });

  it("falls back to the agent when classification throws", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => [makePR(13)],
      classify: async () => { throw new Error("git boom"); },
    });
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([13]);
  });

  it("leaves PRs whose ticket is still actively worked to the owning agent", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => [
        makePR(20, { headBranch: "silas/tea-100-active" }),
        makePR(21, { headBranch: "silas/tea-200-stale" }),
      ],
      classify: async () => ["src/foo.ts"],
      getActiveBranchKeys: async () => new Set(["tea-100"]),
    });
    await resolver.reconcile();
    await flush();
    // PR 20's ticket is active → skipped; PR 21 → resolved.
    expect(spies.resolved).toEqual([21]);
  });

  it("skips dispatch for the cycle when the active-ticket lookup fails", async () => {
    const { resolver, spies } = makeResolver({
      list: async () => [makePR(22)],
      classify: async () => ["src/foo.ts"],
      getActiveBranchKeys: async () => { throw new Error("linear down"); },
    });
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([]);
  });

  it("throttles re-attempts on a still-conflicting PR by retryIntervalMs", async () => {
    const { resolver, spies } = makeResolver({
      config: { retryIntervalMs: 600_000 },
      list: async () => [makePR(10)],
      classify: async () => ["src/foo.ts"],
      now: () => nowMs,
    });
    let nowMs = 0;

    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([10]);

    nowMs = 60_000;
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([10]);

    nowMs = 600_001;
    await resolver.reconcile();
    await flush();
    expect(spies.resolved).toEqual([10, 10]);
  });

  it("never dispatches more than maxConcurrent resolutions at once", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const { resolver } = makeResolver({
      config: { maxConcurrent: 1 },
      list: async () => [makePR(10), makePR(11)],
      classify: async () => ["src/foo.ts"],
      runResolution: async (ctx) => {
        started.push(ctx.pr.number);
        await new Promise<void>(resolve => gates.push(resolve));
      },
    });

    await resolver.reconcile();
    await flush();
    expect(started).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(1);

    gates.forEach(release => release());
    await flush();
  });
});
