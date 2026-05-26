import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "../config.js";
import {
  MergeConflictResolver,
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
  // Let the fire-and-forget startResolution chains settle (ensureWorkspace +
  // the injected runResolution + the inFlight-clearing finally).
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
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

describe("MergeConflictResolver", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-mc-run-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeResolver(opts: {
    config?: Partial<MergeConflictConfig>;
    list: () => Promise<ConflictingPR[]>;
    runResolution: (ctx: ResolveConflictsContext) => Promise<void>;
    now?: () => number;
  }): { resolver: MergeConflictResolver; listCalls: () => number } {
    let listCalls = 0;
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
      runResolution: opts.runResolution,
      now: opts.now,
    });
    return { resolver, listCalls: () => listCalls };
  }

  it("does nothing and never polls when disabled", async () => {
    const { resolver, listCalls } = makeResolver({
      config: { enabled: false },
      list: async () => [makePR(1)],
      runResolution: async () => undefined,
    });
    await resolver.reconcile();
    expect(listCalls()).toBe(0);
    expect(resolver.getTrackedConflictCount()).toBe(0);
  });

  it("dispatches a resolution for a conflicting PR, then untracks it once resolved", async () => {
    const resolved: number[] = [];
    let conflicting: ConflictingPR[] = [makePR(10)];
    const { resolver } = makeResolver({
      list: async () => conflicting,
      runResolution: async (ctx) => { resolved.push(ctx.pr.number); },
    });

    await resolver.reconcile();
    await flush();
    expect(resolved).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(1);
    // The per-PR workspace was created.
    expect(fs.existsSync(path.join(tmpRoot, "conflict-pr-10"))).toBe(true);

    // PR no longer conflicting → cleanup removes tracking and the workspace.
    conflicting = [];
    await resolver.reconcile();
    await flush();
    expect(resolved).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, "conflict-pr-10"))).toBe(false);
  });

  it("throttles re-attempts on a still-conflicting PR by retryIntervalMs", async () => {
    const resolved: number[] = [];
    let nowMs = 0;
    const { resolver } = makeResolver({
      config: { retryIntervalMs: 600_000 },
      list: async () => [makePR(10)],
      runResolution: async (ctx) => { resolved.push(ctx.pr.number); },
      now: () => nowMs,
    });

    await resolver.reconcile();
    await flush();
    expect(resolved).toEqual([10]);

    // Within the cooldown window — no re-dispatch.
    nowMs = 60_000;
    await resolver.reconcile();
    await flush();
    expect(resolved).toEqual([10]);

    // Cooldown elapsed — re-dispatch.
    nowMs = 600_001;
    await resolver.reconcile();
    await flush();
    expect(resolved).toEqual([10, 10]);
  });

  it("never dispatches more than maxConcurrent resolutions at once", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const { resolver } = makeResolver({
      config: { maxConcurrent: 1 },
      list: async () => [makePR(10), makePR(11)],
      runResolution: async (ctx) => {
        started.push(ctx.pr.number);
        await new Promise<void>(resolve => gates.push(resolve));
      },
    });

    await resolver.reconcile();
    await flush();
    // Only one slot, so only the first PR starts; the second is gated out.
    expect(started).toEqual([10]);
    expect(resolver.getTrackedConflictCount()).toBe(1);

    // Release the in-flight resolution so the test doesn't leak a pending promise.
    gates.forEach(release => release());
    await flush();
  });
});
