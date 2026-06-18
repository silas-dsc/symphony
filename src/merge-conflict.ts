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

/** Lockfiles we can regenerate deterministically, mapped to the command that rewrites them. */
export const LOCKFILE_REGEN: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install --lockfile-only",
  "package-lock.json": "npm install --package-lock-only",
};

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
  /**
   * Returns the lowercased Linear identifiers of issues currently in an active
   * state. Conflicting PRs whose branch maps to one of these are left for the
   * owning agent to resolve, so the resolver never races the main dispatch loop.
   * When omitted, every conflicting PR is eligible.
   */
  getActiveBranchKeys?: () => Promise<Set<string>>;
  /** Set up the merge and return the list of conflicted paths; injected by tests. */
  classifyConflicts?: (cwd: string, pr: ConflictingPR, timeoutMs: number, log: Logger) => Promise<string[]>;
  /** Resolve a lockfile-only conflict deterministically and push; injected by tests. */
  resolveLockfiles?: (cwd: string, headBranch: string, files: string[], timeoutMs: number, log: Logger) => Promise<void>;
  /** Abort an in-progress merge to reset the workspace; injected by tests. */
  abortMerge?: (cwd: string) => Promise<void>;
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
  private readonly getActiveBranchKeys: (() => Promise<Set<string>>) | undefined;
  private readonly classifyConflicts: (cwd: string, pr: ConflictingPR, timeoutMs: number, log: Logger) => Promise<string[]>;
  private readonly resolveLockfiles: (cwd: string, headBranch: string, files: string[], timeoutMs: number, log: Logger) => Promise<void>;
  private readonly abortMerge: (cwd: string) => Promise<void>;
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
    this.getActiveBranchKeys = opts.getActiveBranchKeys;
    this.classifyConflicts = opts.classifyConflicts ?? classifyConflicts;
    this.resolveLockfiles = opts.resolveLockfiles ?? resolveLockfilesAndPush;
    this.abortMerge = opts.abortMerge ?? gitAbortMerge;
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

      const dispatchable = await this.filterActivelyWorked(conflicting);
      if (dispatchable !== null) this.dispatchConflicting(dispatchable);
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * Drop PRs whose branch maps to a ticket currently in an active state — the
   * owning agent resolves those itself, and racing it risks duelling pushes to
   * the same branch. Returns the PRs safe to resolve, or `null` (skip dispatch
   * this cycle) when the active-ticket lookup fails, so we err on not racing.
   */
  private async filterActivelyWorked(conflicting: ConflictingPR[]): Promise<ConflictingPR[] | null> {
    if (!this.getActiveBranchKeys) return conflicting;

    let activeKeys: Set<string>;
    try {
      activeKeys = await this.getActiveBranchKeys();
    } catch (e) {
      this.log.warn(`Active-ticket lookup failed; skipping conflict dispatch this cycle: ${fmtErr(e)}`);
      return null;
    }

    const dispatchable: ConflictingPR[] = [];
    let skipped = 0;
    for (const pr of conflicting) {
      if (branchMatchesActiveKey(pr.headBranch, activeKeys)) skipped++;
      else dispatchable.push(pr);
    }
    if (skipped > 0) {
      this.log.info("Skipped conflicting PRs whose ticket is still being worked", { skipped: String(skipped) });
    }
    return dispatchable;
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

      // Classify the conflict deterministically. A failure here (e.g. a git
      // setup hiccup) isn't fatal — fall back to the full agent path, which
      // re-runs its own setup with more resilience.
      let conflicted: string[] | null = null;
      try {
        conflicted = await this.classifyConflicts(wsPath, pr, this.hooks.timeoutMs, this.log);
      } catch (e) {
        this.log.warn(`Conflict classification failed; deferring to agent: ${fmtErr(e)}`, { pr_number: String(pr.number) });
        await this.abortMerge(wsPath);
      }

      if (conflicted !== null) {
        if (conflicted.length === 0) {
          // GitHub's mergeability data was stale, or a prior run already fixed it.
          await this.abortMerge(wsPath);
          this.log.info("No conflicts present; nothing to resolve", { pr_number: String(pr.number) });
          return;
        }

        if (isLockfileOnly(conflicted)) {
          try {
            this.log.info("Lockfile-only conflict; resolving deterministically", {
              pr_number: String(pr.number),
              files: conflicted.join(", "),
            });
            await this.resolveLockfiles(wsPath, pr.headBranch, conflicted, this.hooks.timeoutMs, this.log);
            this.log.info("Resolved via lockfile fast-path", {
              pr_number: String(pr.number),
              duration_s: ((this.now() - startedAt) / 1000).toFixed(1),
            });
            return;
          } catch (e) {
            this.log.warn(`Lockfile fast-path failed; deferring to agent: ${fmtErr(e)}`, { pr_number: String(pr.number) });
            await this.abortMerge(wsPath);
          }
        } else {
          // General conflict: reset so the agent does its own clean setup.
          await this.abortMerge(wsPath);
        }
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

/** True when the branch embeds one of the active-ticket keys (e.g. `tea-4020`) as a whole token. */
export function branchMatchesActiveKey(branch: string, keys: Set<string>): boolean {
  const b = branch.toLowerCase();
  for (const key of keys) {
    if (!key) continue;
    let from = 0;
    for (;;) {
      const idx = b.indexOf(key, from);
      if (idx === -1) break;
      const before = idx === 0 ? "" : b[idx - 1];
      const after = b[idx + key.length] ?? "";
      // A leading alphanumeric (xtea-1) or a trailing digit (tea-402 vs tea-4020)
      // means this isn't the same identifier.
      const beforeOk = before === "" || !/[a-z0-9]/.test(before);
      const afterOk = after === "" || !/[0-9]/.test(after);
      if (beforeOk && afterOk) return true;
      from = idx + 1;
    }
  }
  return false;
}

/** True when every conflicted path is a lockfile we know how to regenerate. */
export function isLockfileOnly(files: string[]): boolean {
  return files.length > 0 && files.every(f => Object.hasOwn(LOCKFILE_REGEN, path.basename(f)));
}

function regenCommands(files: string[]): string[] {
  const cmds = new Set<string>();
  for (const f of files) {
    const cmd = LOCKFILE_REGEN[path.basename(f)];
    if (cmd) cmds.add(cmd);
  }
  return [...cmds];
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/** Best-effort: abort an in-progress merge. No-op if there's nothing to abort. */
async function gitAbortMerge(cwd: string): Promise<void> {
  await git(cwd, ["merge", "--abort"], 30_000).catch(() => undefined);
}

/**
 * Default classifier: deepen the clone, check out the PR branch, and merge the
 * base branch in (re-creating the conflict). Leaves the repo mid-merge and
 * returns the conflicted paths. An empty result means the branches merge
 * cleanly — the caller aborts and skips.
 */
export async function classifyConflicts(cwd: string, pr: ConflictingPR, timeoutMs: number, _log: Logger): Promise<string[]> {
  // A shallow clone breaks merge-base detection; deepen it first.
  await git(cwd, ["fetch", "--unshallow"], timeoutMs)
    .catch(() => git(cwd, ["fetch", "--all", "--tags", "--prune"], timeoutMs).catch(() => undefined));
  await git(cwd, ["fetch", "origin", pr.headBranch, pr.baseBranch], timeoutMs);
  await git(cwd, ["checkout", "-B", pr.headBranch, `origin/${pr.headBranch}`], timeoutMs);
  await git(cwd, ["reset", "--hard", `origin/${pr.headBranch}`], timeoutMs);
  // A conflicting merge exits non-zero — that's the expected path, not an error.
  await git(cwd, ["merge", "--no-commit", "--no-ff", `origin/${pr.baseBranch}`], timeoutMs).catch(() => undefined);

  const out = await git(cwd, ["diff", "--name-only", "--diff-filter=U"], timeoutMs);
  return out.split("\n").map(s => s.trim()).filter(Boolean);
}

/**
 * Default lockfile fast-path: with the merge already set up by the classifier
 * and only lockfiles in conflict, resolve each lockfile to a valid file, then
 * regenerate it from the (cleanly merged) manifests and push. No LLM involved.
 */
export async function resolveLockfilesAndPush(
  cwd: string,
  headBranch: string,
  files: string[],
  timeoutMs: number,
  log: Logger,
): Promise<void> {
  // Resolve the unmerged lockfile paths to a valid file so the package manager
  // can read them; the regen step below rewrites them against the merged manifest.
  for (const file of files) {
    await git(cwd, ["checkout", "--theirs", "--", file], timeoutMs)
      .catch(() => git(cwd, ["checkout", "--ours", "--", file], timeoutMs));
    await git(cwd, ["add", "--", file], timeoutMs);
  }

  // Regenerate via a login shell so nvm/pnpm/npm are on PATH, like the hooks.
  for (const cmd of regenCommands(files)) {
    await runHook(cmd, cwd, timeoutMs, log);
  }

  for (const file of files) {
    await git(cwd, ["add", "--", file], timeoutMs);
  }

  const stillUnmerged = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"], timeoutMs)).trim();
  if (stillUnmerged) throw new Error(`unmerged paths remain after lockfile regen: ${stillUnmerged}`);

  await git(cwd, ["commit", "--no-edit"], timeoutMs);
  await git(cwd, ["push", "origin", headBranch], timeoutMs);
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
