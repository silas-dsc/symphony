import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AutoUpdateConfig, Logger } from "./types.js";

const execFileP = promisify(execFile);

export interface SelfUpdaterOptions {
  config: AutoUpdateConfig;
  logger: Logger;
  /** Invoked once an update has been pulled + built. Should perform graceful shutdown + restart. */
  onRestartRequested: () => void;
}

interface ResolvedContext {
  repoRoot: string;
  branch: string;
  remote: string;
}

/**
 * Periodically polls a git remote for new commits on the tracked branch.
 * On update: fast-forward pulls, runs install (when lockfile/manifest changed)
 * and the build command, then asks the host process to restart via the
 * supplied callback.
 */
export class SelfUpdater {
  private readonly cfg: AutoUpdateConfig;
  private readonly log: Logger;
  private readonly onRestartRequested: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private context: ResolvedContext | null = null;
  /** Reentrancy guard — true while an update cycle is in progress. */
  private cycleInFlight = false;
  /** Set once we've fired the restart callback to avoid loops. */
  private restartRequested = false;

  constructor(opts: SelfUpdaterOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.onRestartRequested = opts.onRestartRequested;
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) {
      this.log.info("Self-update disabled");
      return;
    }

    try {
      this.context = await this.resolveContext();
    } catch (e) {
      this.log.warn(`Self-update disabled: ${errMsg(e)}`);
      return;
    }

    this.log.info("Self-update enabled", {
      repo_root: this.context.repoRoot,
      remote: this.context.remote,
      branch: this.context.branch,
      interval_ms: String(this.cfg.intervalMs),
    });

    this.schedule(this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.restartRequested) return;
    if (this.cycleInFlight) {
      this.schedule(this.cfg.intervalMs);
      return;
    }
    this.cycleInFlight = true;
    try {
      await this.checkAndUpdate();
    } catch (e) {
      this.log.warn(`Self-update tick failed: ${errMsg(e)}`);
    } finally {
      this.cycleInFlight = false;
      if (!this.restartRequested) this.schedule(this.cfg.intervalMs);
    }
  }

  private async checkAndUpdate(): Promise<void> {
    const ctx = this.context;
    if (!ctx) return;

    await this.git(ctx, ["fetch", "--quiet", ctx.remote, ctx.branch]);

    const local = (await this.git(ctx, ["rev-parse", "HEAD"])).stdout.trim();
    const remote = (await this.git(ctx, [
      "rev-parse",
      `${ctx.remote}/${ctx.branch}`,
    ])).stdout.trim();

    if (!local || !remote || local === remote) return;

    // Behind only when remote contains commits we don't have.
    const aheadBehind = (await this.git(ctx, [
      "rev-list",
      "--left-right",
      "--count",
      `${local}...${remote}`,
    ])).stdout.trim();
    const [aheadStr, behindStr] = aheadBehind.split(/\s+/);
    const behind = parseInt(behindStr ?? "0", 10);
    const ahead = parseInt(aheadStr ?? "0", 10);
    if (!Number.isFinite(behind) || behind <= 0) return;

    if (ahead > 0) {
      this.log.warn(`Skipping self-update: local branch has ${ahead} commit(s) not on ${ctx.remote}/${ctx.branch}`);
      return;
    }

    // Refuse to pull over a dirty tree — preserves operator changes.
    const status = (await this.git(ctx, ["status", "--porcelain"])).stdout;
    if (status.trim().length > 0) {
      this.log.warn(`Skipping self-update: working tree dirty in ${ctx.repoRoot}`);
      return;
    }

    this.log.info(`Self-update: pulling ${behind} new commit(s)`, {
      from: local.slice(0, 7),
      to: remote.slice(0, 7),
    });

    // Capture manifest/lockfile state to decide whether install needs to run.
    const manifestBefore = this.snapshotManifests(ctx.repoRoot);

    try {
      await this.git(ctx, ["pull", "--ff-only", ctx.remote, ctx.branch]);
    } catch (e) {
      this.log.error(`Self-update pull failed, keeping current build: ${errMsg(e)}`);
      return;
    }

    const manifestAfter = this.snapshotManifests(ctx.repoRoot);
    const depsChanged = manifestAfter !== manifestBefore;

    if (depsChanged && this.cfg.installCommand) {
      this.log.info(`Self-update: running install (${this.cfg.installCommand})`);
      try {
        await this.runShell(this.cfg.installCommand, ctx.repoRoot);
      } catch (e) {
        this.log.error(`Self-update install failed, keeping current build: ${errMsg(e)}`);
        return;
      }
    }

    if (this.cfg.buildCommand) {
      this.log.info(`Self-update: running build (${this.cfg.buildCommand})`);
      try {
        await this.runShell(this.cfg.buildCommand, ctx.repoRoot);
      } catch (e) {
        this.log.error(`Self-update build failed, keeping current build: ${errMsg(e)}`);
        return;
      }
    }

    this.log.info("Self-update complete, requesting restart");
    this.restartRequested = true;
    this.stop();
    this.onRestartRequested();
  }

  private async resolveContext(): Promise<ResolvedContext> {
    const repoRoot = this.cfg.repoRoot ?? this.detectRepoRoot();
    if (!repoRoot) {
      throw new Error("could not locate Symphony git checkout (no .git directory found)");
    }
    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      throw new Error(`not a git repository: ${repoRoot}`);
    }

    let branch = this.cfg.branch ?? "";
    if (!branch) {
      const head = (await this.gitAt(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (!head || head === "HEAD") {
        throw new Error("detached HEAD; set auto_update.branch in WORKFLOW.md to track a branch");
      }
      branch = head;
    }

    return { repoRoot, branch, remote: this.cfg.remote };
  }

  private detectRepoRoot(): string | null {
    // Walk up from this module's compiled location (dist/self-update.js) until we find .git.
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private snapshotManifests(repoRoot: string): string {
    const parts: string[] = [];
    for (const name of ["package.json", "package-lock.json"]) {
      try {
        const stat = fs.statSync(path.join(repoRoot, name));
        parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }
    return parts.join("|");
  }

  private git(ctx: ResolvedContext, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.gitAt(ctx.repoRoot, args);
  }

  private gitAt(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP("git", args, { cwd, env: process.env, encoding: "utf8" });
  }

  private runShell(command: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile("bash", ["-lc", command], { cwd, env: process.env, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || stdout || "").trim().split("\n").slice(-5).join("\n");
          reject(new Error(`${command} failed: ${err.message}${tail ? `\n${tail}` : ""}`));
          return;
        }
        resolve();
      });
    });
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
