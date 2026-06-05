import { execFile } from "node:child_process";
import * as path from "node:path";
import type { Logger } from "./types.js";

export interface CommitLessonsOptions {
  /** Absolute path to the Symphony git checkout. */
  repoRoot: string;
  /** Absolute path to lessons.jsonl. Must live inside repoRoot to be committed. */
  lessonsPath: string;
  /** Branch to push to. Empty string → resolve the current branch. */
  branch: string;
  /** Remote name, e.g. "origin". */
  remote: string;
  /** Ticket identifier, used only for the commit message. */
  issueIdentifier: string;
  logger?: Logger;
  /** Push attempts before giving up (network/transient errors). Default 4. */
  maxPushAttempts?: number;
  /** Sleep implementation, injectable for tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LessonsSyncResult {
  committed: boolean;
  pushed: boolean;
  /** Why nothing (further) happened — for logging. */
  reason?:
    | "no_changes"
    | "outside_repo"
    | "no_branch"
    | "commit_failed"
    | "rebase_failed"
    | "push_failed";
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: process.env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile sets err on non-zero exit; err.code is the numeric exit code
        // for a started process, or a string (e.g. "ENOENT") if git is missing.
        const rawCode = err ? (err as NodeJS.ErrnoException).code : 0;
        const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Serialize all syncs in-process: concurrent ticket completions must not race
// on the git index or duel on push. Because `git add` stages whatever the file
// currently holds, batched appends coalesce — the first sync commits every
// pending line and later syncs find nothing to commit.
let syncChain: Promise<unknown> = Promise.resolve();

/**
 * Commit lessons.jsonl and push it to the tracked branch. Best-effort and
 * never throws: a failure here must not block workspace cleanup or the
 * orchestrator. Serialized across concurrent callers.
 *
 * Keeping the lessons file committed also keeps the Symphony working tree
 * clean, which is what lets `self-update` (which refuses to pull over a dirty
 * tree) keep deploying.
 */
export function commitAndPushLessons(opts: CommitLessonsOptions): Promise<LessonsSyncResult> {
  const run = (): Promise<LessonsSyncResult> => doCommitAndPush(opts);
  // Chain regardless of whether the previous sync resolved or rejected.
  const result = syncChain.then(run, run);
  syncChain = result.catch(() => undefined);
  return result;
}

async function doCommitAndPush(opts: CommitLessonsOptions): Promise<LessonsSyncResult> {
  const { repoRoot, lessonsPath, remote, issueIdentifier, logger } = opts;
  const maxAttempts = opts.maxPushAttempts ?? 4;
  const sleep = opts.sleep ?? defaultSleep;

  const rel = path.relative(repoRoot, lessonsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    logger?.info("lessons-sync skipped: lessons file is outside the repo", { lessonsPath, repoRoot });
    return { committed: false, pushed: false, reason: "outside_repo" };
  }

  // Stage only the lessons file. Ignore `git add` failure — if the file is
  // gitignored, the diff check below sees nothing staged and we no-op cleanly.
  await git(repoRoot, ["add", "--", rel]);

  // `diff --cached --quiet` exits 0 when nothing is staged, 1 when there is.
  const staged = await git(repoRoot, ["diff", "--cached", "--quiet", "--", rel]);
  if (staged.code === 0) {
    return { committed: false, pushed: false, reason: "no_changes" };
  }

  const commit = await git(repoRoot, [
    "commit",
    "-m",
    `lessons: ${issueIdentifier} retrospective`,
    "--",
    rel,
  ]);
  if (commit.code !== 0) {
    logger?.warn("lessons-sync: commit failed", { stderr: commit.stderr.slice(0, 300) });
    return { committed: false, pushed: false, reason: "commit_failed" };
  }
  logger?.info("lessons-sync: committed lesson", { issue: issueIdentifier });

  const branch = await resolveBranch(repoRoot, opts.branch);
  if (!branch) {
    logger?.warn("lessons-sync: cannot resolve branch (detached HEAD?); committed but not pushed");
    return { committed: true, pushed: false, reason: "no_branch" };
  }

  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const push = await git(repoRoot, ["push", remote, `HEAD:${branch}`]);
    if (push.code === 0) {
      logger?.info("lessons-sync: pushed", { issue: issueIdentifier, branch });
      return { committed: true, pushed: true };
    }

    const stderr = push.stderr.toLowerCase();
    const nonFastForward =
      stderr.includes("non-fast-forward") ||
      stderr.includes("fetch first") ||
      stderr.includes("[rejected]");

    if (nonFastForward) {
      // Remote moved (e.g. an operator merged a meta-improve PR). Rebase our
      // lesson commit on top and retry the push immediately. Meta-improve never
      // touches lessons.jsonl, so this rebase is expected to be conflict-free.
      const rebase = await git(repoRoot, ["pull", "--rebase", "--autostash", remote, branch]);
      if (rebase.code !== 0) {
        await git(repoRoot, ["rebase", "--abort"]); // best-effort; harmless if no rebase in progress
        logger?.warn("lessons-sync: rebase failed; commit kept locally, will retry next sync", {
          stderr: rebase.stderr.slice(0, 300),
        });
        return { committed: true, pushed: false, reason: "rebase_failed" };
      }
      continue; // retry push now that we're caught up
    }

    // Transient/network error — back off and retry.
    logger?.warn(`lessons-sync: push attempt ${attempt} failed`, { stderr: push.stderr.slice(0, 300) });
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay *= 2;
    }
  }

  return { committed: true, pushed: false, reason: "push_failed" };
}

async function resolveBranch(repoRoot: string, configured: string): Promise<string> {
  if (configured) return configured;
  const head = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.stdout.trim();
  return branch && branch !== "HEAD" ? branch : "";
}
