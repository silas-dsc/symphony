import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Liquid } from "liquidjs";
import type { HooksConfig, Logger, MergeConflictConfig } from "./types.js";
import { ensureWorkspace, removeWorkspace, runHook } from "./workspace.js";

const execFileP = promisify(execFile);
const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export interface ConflictingPR {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  url: string;
}

/** Reads open PRs from GitHub and reports which ones currently have merge conflicts. */
export interface ConflictPrClient {
  listConflictingPullRequests(config: MergeConflictConfig): Promise<ConflictingPR[]>;
}

export interface ResolveConflictsContext {
  pr: ConflictingPR;
  workspacePath: string;
  symphonyRoot: string;
  repo: string;
  config: MergeConflictConfig;
  mcpConfigPath: string | undefined;
  logger: Logger;
}

interface TrackedConflict {
  prNumber: number;
  inFlight: boolean;
  lastAttemptMs: number | null;
}

export interface MergeConflictResolverOptions {
  config: MergeConflictConfig;
  workspaceRoot: string;
  hooks: HooksConfig;
  symphonyRoot: string;
  mcpConfigPath: string | undefined;
  logger: Logger;
  prClient?: ConflictPrClient;
  /** Override the per-PR resolution runner; injected by tests. */
  runResolution?: (ctx: ResolveConflictsContext) => Promise<void>;
  now?: () => number;
}

/**
 * Render the conflict-resolution prompt for a single PR. The resolver
 * sub-agent's prompt is `prompts/RESOLVE_CONFLICTS.md` from the Symphony root,
 * with Liquid variables filled in. Exposed for testing.
 */
export function renderResolveConflictsPrompt(
  promptTemplate: string,
  ctx: ResolveConflictsContext,
): string {
  return liquid.parseAndRenderSync(promptTemplate, {
    pr: {
      number: ctx.pr.number,
      title: ctx.pr.title,
      head_branch: ctx.pr.headBranch,
      base_branch: ctx.pr.baseBranch,
      url: ctx.pr.url,
    },
    repo: ctx.repo,
    workspace: ctx.workspacePath,
    symphony: { root: ctx.symphonyRoot },
  });
}

/**
 * Scans open PRs each tick and dispatches a conflict-resolution sub-agent for
 * every PR that GitHub reports as CONFLICTING. The agent merges the base branch
 * into the PR branch, resolves the conflicts so both intents are preserved, and
 * pushes to the PR branch. It never merges the PR itself.
 *
 * Mirrors GitHubPreviewWarmer: a quick poll + a tracked map. Resolutions run in
 * the background (fire-and-forget) so a 20-minute Claude session never blocks
 * the orchestrator tick. A per-PR `inFlight` flag prevents double-dispatch and
 * `retryIntervalMs` throttles re-attempts on a PR that stays conflicting.
 */
export class MergeConflictResolver {
  private readonly cfg: MergeConflictConfig;
  private readonly workspaceRoot: string;
  private readonly hooks: HooksConfig;
  private readonly symphonyRoot: string;
  private readonly mcpConfigPath: string | undefined;
  private readonly log: Logger;
  private readonly prClient: ConflictPrClient;
  private readonly runResolution: (ctx: ResolveConflictsContext) => Promise<void>;
  private readonly now: () => number;
  private readonly tracked = new Map<number, TrackedConflict>();
  private cycleInFlight = false;

  constructor(opts: MergeConflictResolverOptions) {
    this.cfg = opts.config;
    this.workspaceRoot = opts.workspaceRoot;
    this.hooks = opts.hooks;
    this.symphonyRoot = opts.symphonyRoot;
    this.mcpConfigPath = opts.mcpConfigPath;
    this.log = opts.logger;
    this.prClient = opts.prClient ?? new GhCliConflictPrClient();
    this.runResolution = opts.runResolution ?? runResolveConflicts;
    this.now = opts.now ?? Date.now;
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    // Skip if a previous poll is still listing PRs. In-flight resolutions are
    // tracked per-PR and outlive this guard — they keep running in the
    // background regardless.
    if (this.cycleInFlight) return;

    this.cycleInFlight = true;
    try {
      let conflicting: ConflictingPR[];
      try {
        conflicting = await this.prClient.listConflictingPullRequests(this.cfg);
      } catch (e) {
        this.log.warn(`Conflict PR poll failed: ${fmtErr(e)}`);
        return;
      }

      const conflictingByNumber = new Map(conflicting.map(pr => [pr.number, pr]));
      await this.cleanupResolved(conflictingByNumber);
      this.dispatchConflicting(conflicting);
    } finally {
      this.cycleInFlight = false;
    }
  }

  getTrackedConflictCount(): number {
    return this.tracked.size;
  }

  /**
   * Drop tracking — and remove the per-PR workspace — for any PR that is no
   * longer conflicting (resolved or closed). Skip PRs whose resolution is still
   * in flight so we don't delete a workspace out from under a running agent.
   */
  private async cleanupResolved(conflictingByNumber: Map<number, ConflictingPR>): Promise<void> {
    for (const [prNumber, entry] of this.tracked) {
      if (conflictingByNumber.has(prNumber)) continue;
      if (entry.inFlight) continue;
      this.tracked.delete(prNumber);
      try {
        await removeWorkspace(this.workspaceRoot, workspaceKey(prNumber), undefined, this.hooks.timeoutMs, this.log);
      } catch (e) {
        this.log.warn(`Conflict workspace cleanup failed for #${prNumber}: ${fmtErr(e)}`, { pr_number: String(prNumber) });
      }
      this.log.info("Stopped tracking PR conflict", { pr_number: String(prNumber), reason: "no_longer_conflicting" });
    }
  }

  private dispatchConflicting(conflicting: ConflictingPR[]): void {
    for (const pr of conflicting) {
      if (this.activeCount() >= this.cfg.maxConcurrent) break;

      const entry = this.tracked.get(pr.number) ?? { prNumber: pr.number, inFlight: false, lastAttemptMs: null };
      this.tracked.set(pr.number, entry);

      if (entry.inFlight) continue;
      if (entry.lastAttemptMs !== null && this.now() - entry.lastAttemptMs < this.cfg.retryIntervalMs) continue;

      entry.inFlight = true;
      // Fire-and-forget: a resolution can take many minutes, so it must not block
      // the tick. inFlight gates re-dispatch; the finally below clears it.
      void this.startResolution(pr, entry);
    }
  }

  private activeCount(): number {
    let n = 0;
    for (const entry of this.tracked.values()) if (entry.inFlight) n++;
    return n;
  }

  private async startResolution(pr: ConflictingPR, entry: TrackedConflict): Promise<void> {
    const startedAt = this.now();
    this.log.info("Resolving PR merge conflict", {
      pr_number: String(pr.number),
      head_branch: pr.headBranch,
      base_branch: pr.baseBranch,
    });

    try {
      const { path: wsPath, createdNow } = await ensureWorkspace(this.workspaceRoot, workspaceKey(pr.number));
      if (createdNow && this.hooks.afterCreate) {
        await runHook(this.hooks.afterCreate, wsPath, this.hooks.timeoutMs, this.log);
      }

      await this.runResolution({
        pr,
        workspacePath: wsPath,
        symphonyRoot: this.symphonyRoot,
        repo: `${this.cfg.repoOwner}/${this.cfg.repoName}`,
        config: this.cfg,
        mcpConfigPath: this.mcpConfigPath,
        logger: this.log,
      });

      this.log.info("Conflict resolution finished", {
        pr_number: String(pr.number),
        duration_s: ((this.now() - startedAt) / 1000).toFixed(1),
      });
    } catch (e) {
      this.log.warn(`Conflict resolution failed (non-fatal): ${fmtErr(e)}`, { pr_number: String(pr.number) });
    } finally {
      entry.inFlight = false;
      entry.lastAttemptMs = this.now();
    }
  }
}

function workspaceKey(prNumber: number): string {
  return `conflict-pr-${prNumber}`;
}

/**
 * Default per-PR runner: render the RESOLVE_CONFLICTS prompt and spawn a one-shot
 * `claude` session in the cloned workspace. Best-effort — failures propagate to
 * the caller, which logs and moves on.
 */
export async function runResolveConflicts(ctx: ResolveConflictsContext): Promise<void> {
  if (!fs.existsSync(ctx.workspacePath)) {
    throw new Error(`workspace missing: ${ctx.workspacePath}`);
  }

  const promptPath = path.join(ctx.symphonyRoot, "prompts", "RESOLVE_CONFLICTS.md");
  if (!fs.existsSync(promptPath)) {
    throw new Error(`prompt missing: ${promptPath}`);
  }

  const template = fs.readFileSync(promptPath, "utf-8");
  const prompt = renderResolveConflictsPrompt(template, ctx);
  await spawnResolveConflictsClaude(prompt, ctx);
}

function spawnResolveConflictsClaude(prompt: string, ctx: ResolveConflictsContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || v === "") continue;
      childEnv[k] = v;
    }
    childEnv.SYMPHONY_CONFLICT_PR_NUMBER = String(ctx.pr.number);
    childEnv.SYMPHONY_CONFLICT_HEAD_BRANCH = ctx.pr.headBranch;
    childEnv.SYMPHONY_CONFLICT_BASE_BRANCH = ctx.pr.baseBranch;
    childEnv.SYMPHONY_CONFLICT_REPO = ctx.repo;

    const mcpArgs = ctx.mcpConfigPath ? ["--mcp-config", ctx.mcpConfigPath] : [];

    const proc = spawn(
      "claude",
      [
        "-p",
        ...mcpArgs,
        "--max-turns", String(ctx.config.maxTurns),
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      {
        cwd: ctx.workspacePath,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", () => { /* drain stdout to keep the pipe flowing; events aren't needed */ });
    proc.stderr.on("data", () => { /* drain */ });

    const timeoutMs = ctx.config.timeoutMs;
    const timer = setTimeout(() => {
      ctx.logger.warn("Conflict resolution timed out, killing claude", {
        pr_number: String(ctx.pr.number),
        timeout_ms: timeoutMs,
      });
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000);
      settle(() => reject(new Error(`conflict resolution timeout after ${timeoutMs}ms`)));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      rl.close();
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(`claude exited with code ${code ?? "null"}`));
      });
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      settle(() => reject(e));
    });
  });
}

interface GhPrPayload {
  number?: number;
  title?: string;
  headRefName?: string;
  baseRefName?: string;
  mergeable?: string;
  url?: string;
}

class GhCliConflictPrClient implements ConflictPrClient {
  async listConflictingPullRequests(config: MergeConflictConfig): Promise<ConflictingPR[]> {
    const { stdout } = await execFileP(
      "gh",
      [
        "pr", "list",
        "--repo", `${config.repoOwner}/${config.repoName}`,
        "--state", "open",
        "--limit", "100",
        "--json", "number,title,headRefName,baseRefName,mergeable,url",
      ],
      { env: process.env, encoding: "utf8", timeout: config.requestTimeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );

    const payload = JSON.parse(stdout) as GhPrPayload[];
    if (!Array.isArray(payload)) return [];

    // GitHub reports "CONFLICTING" only once it has computed mergeability;
    // "UNKNOWN" means it hasn't yet, so we skip and re-check next tick.
    return payload
      .filter(pr =>
        pr.mergeable === "CONFLICTING" &&
        typeof pr.number === "number" &&
        typeof pr.headRefName === "string" &&
        typeof pr.baseRefName === "string",
      )
      .map(pr => ({
        number: pr.number as number,
        title: pr.title ?? "",
        headBranch: pr.headRefName as string,
        baseBranch: pr.baseRefName as string,
        url: pr.url ?? "",
      }));
  }
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
