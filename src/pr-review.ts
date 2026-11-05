import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { promisify } from "node:util";
import { claudeEffortArgs, claudeModelArgs } from "./llm.js";
import { tokenProcesses, trackTokenProcess } from "./usage-budget.js";
import { ensureWorkspace, runHook } from "./workspace.js";
import type { Logger } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Local PR review: Symphony watches open PRs and, for each new head commit,
 * runs Claude Code's own `/code-review <level> --fix <PR>` in a workspace on
 * this Mac, the same as running it by hand. It then:
 *   - verifies and commits the fixes (the agent), pushes them (Symphony, with hooks off),
 *   - posts one comment ending `Verdict: approve|changes` (Symphony's review flow reads it),
 *   - sets a `symphony/review` commit status (pending → success/failure).
 *
 * Replaces the claude-review GitHub Action: same skill and settings as a local
 * session, can fix workflow files, and is paused by the usage budget like any
 * other Claude run. Forks, drafts and Dependabot are skipped. One review at a time.
 */

export interface PrReviewConfig {
  repo: string;
  level: string;
  intervalMs: number;
  maxPerPrPerDay: number;
  /** Review PRs already open when Symphony first starts watching (default: only new commits). */
  reviewExisting: boolean;
  statePath: string;
  workspaceRoot: string;
  hooks: { afterCreate: string | null; beforeRun: string | null; timeoutMs: number };
  timeoutMs: number;
}

export interface OpenPr {
  number: number;
  url: string;
  title: string;
  branch: string;
  headSha: string;
  isDraft: boolean;
  isFork: boolean;
  author: string;
}

interface State {
  initialised: boolean;
  /** PR number → head sha already reviewed (or pushed by the review itself). */
  reviewed: Record<string, string>;
  /** PR number → ISO timestamps of reviews in the last day. */
  runs: Record<string, string[]>;
}

export interface ReviewDeps {
  listOpen: () => Promise<OpenPr[]>;
  /** Check out the PR branch at its head; returns the workspace path. */
  prepare: (pr: OpenPr) => Promise<string>;
  runAgent: (prompt: string, cwd: string) => Promise<string>;
  headOf: (cwd: string) => Promise<string>;
  changedSince: (cwd: string, sha: string) => Promise<string[]>;
  remoteHead: (pr: OpenPr) => Promise<string>;
  push: (cwd: string, branch: string) => Promise<void>;
  comment: (prUrl: string, body: string) => Promise<void>;
  status: (sha: string, state: "pending" | "success" | "failure" | "error", description: string) => Promise<void>;
  now?: () => number;
}

export function shouldReview(pr: OpenPr): boolean {
  return !pr.isDraft && !pr.isFork && !/dependabot/i.test(pr.author);
}

export function renderReviewPrompt(pr: OpenPr, level: string): string {
  return [
    `You are reviewing PR #${pr.number} (${pr.url}). Its branch \`${pr.branch}\` is checked out at ${pr.headSha.slice(0, 7)} and dependencies are installed.`,
    "This is the team-dsc pnpm monorepo: packages/app (React Router, React, Tailwind), packages/functions (Firebase Cloud Functions), Firestore rules.",
    "",
    `1. Use the Skill tool to run the \`code-review\` skill with arguments \`${level} --fix ${pr.number}\`. Follow the skill exactly as in an interactive session, including applying its fixes to the working tree.`,
    "",
    "2. If it changed any files:",
    "   - Run `pnpm typecheck`, `pnpm lint`, and the tests for the files you touched (`pnpm test <paths>`).",
    "   - If a fix breaks any of them, repair it or revert that fix. Never skip, disable or delete a test or check.",
    "   - Commit once with the message `Code review fixes (symphony review)`.",
    "   - Don't push, don't comment on the PR, and don't change git hooks or CI config to get a fix through. Symphony pushes and comments for you.",
    "",
    "3. End your reply with exactly one fenced block tagged `review-comment` holding the PR comment, under 300 words:",
    "   - `Fixed:` then one line per committed fix, with file:line and what you changed (omit if none).",
    "   - `BLOCKER:` or `FIX:` lines with file:line for findings you did NOT fix, and why.",
    "   - Last line exactly `Verdict: approve` if nothing that matters is left unfixed, otherwise `Verdict: changes`.",
    "   Plain words. Don't restate the diff.",
  ].join("\n");
}

export function parseReviewComment(text: string): { body: string; verdict: "approve" | "changes" } | null {
  const m = /```review-comment\s*\n([\s\S]*?)\n```/.exec(text ?? "");
  if (!m) return null;
  const body = m[1].trim();
  const v = /Verdict:\s*(approve|changes)\s*$/i.exec(body);
  return v ? { body, verdict: v[1].toLowerCase() as "approve" | "changes" } : null;
}

export class PrReviewer {
  private state: State = { initialised: false, reviewed: {}, runs: {} };
  private last = 0;
  private busy = false;

  constructor(private readonly cfg: PrReviewConfig, private readonly deps: ReviewDeps, private readonly log: Logger) {
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(cfg.statePath, "utf8")) };
    } catch {
      // fresh
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Called every tick; polls on its own interval and runs at most one review at a time. */
  async reconcile(): Promise<void> {
    const now = this.now();
    if (this.busy || now - this.last < this.cfg.intervalMs || tokenProcesses.isPaused()) return;
    this.last = now;
    this.busy = true;
    try {
      const open = (await this.deps.listOpen()).filter(shouldReview);
      if (!this.state.initialised) {
        this.state.initialised = true;
        if (!this.cfg.reviewExisting) for (const pr of open) this.state.reviewed[pr.number] = pr.headSha;
        this.persist();
        this.log.info("PR review: watching", { open: open.length, backfill: this.cfg.reviewExisting });
        if (!this.cfg.reviewExisting) return;
      }
      // Forget closed PRs.
      const openNums = new Set(open.map(p => String(p.number)));
      for (const k of Object.keys(this.state.reviewed)) if (!openNums.has(k)) delete this.state.reviewed[k];
      const due = open.filter(pr => this.state.reviewed[pr.number] !== pr.headSha && this.underCap(pr, now));
      const next = due.sort((a, b) => b.number - a.number)[0];
      if (next) await this.review(next);
      this.persist();
    } catch (e) {
      this.log.warn("PR review poll failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  private underCap(pr: OpenPr, now: number): boolean {
    const recent = (this.state.runs[pr.number] ?? []).filter(t => now - Date.parse(t) < 86_400_000);
    this.state.runs[pr.number] = recent;
    if (recent.length >= this.cfg.maxPerPrPerDay) {
      if (this.state.reviewed[pr.number] !== pr.headSha) {
        this.log.warn("PR review: daily cap reached, skipping new commit", { pr: pr.number, cap: this.cfg.maxPerPrPerDay });
      }
      return false;
    }
    return true;
  }

  private async review(pr: OpenPr): Promise<void> {
    const started = new Date(this.now()).toISOString();
    this.state.runs[pr.number] = [...(this.state.runs[pr.number] ?? []), started];
    this.state.reviewed[pr.number] = pr.headSha; // don't retry the same commit on failure
    this.log.info("PR review starting", { pr: pr.number, sha: pr.headSha.slice(0, 7), level: this.cfg.level });
    await this.deps.status(pr.headSha, "pending", `Claude /code-review ${this.cfg.level} --fix running`).catch(() => undefined);
    try {
      const ws = await this.deps.prepare(pr);
      const text = await this.deps.runAgent(renderReviewPrompt(pr, this.cfg.level), ws);
      const parsed = parseReviewComment(text);
      const head = await this.deps.headOf(ws);
      let pushedSha: string | null = null;
      if (head !== pr.headSha) {
        if ((await this.deps.remoteHead(pr)) !== pr.headSha) {
          // Someone pushed during the review: drop our fixes; the new commit gets its own review.
          delete this.state.reviewed[pr.number];
          this.log.warn("PR review: branch moved during review, fixes not pushed", { pr: pr.number });
          await this.deps.status(pr.headSha, "error", "Branch changed during review; re-reviewing the new commit").catch(() => undefined);
          return;
        }
        const files = await this.deps.changedSince(ws, pr.headSha);
        if (files.some(f => f.startsWith(".husky/"))) throw new Error("review commit changes git hooks; not pushing");
        await this.deps.push(ws, pr.branch);
        pushedSha = head;
        this.state.reviewed[pr.number] = head; // our own push mustn't trigger another review
      }
      const body = parsed?.body ?? "The review finished without a summary (it may have run out of turns). Symphony will review the next commit.\n\nVerdict: changes";
      const verdict = parsed?.verdict ?? "changes";
      await this.deps.comment(pr.url, `${body}\n\n_Symphony local review: \`/code-review ${this.cfg.level} --fix\`${pushedSha ? `, fixes pushed in ${pushedSha.slice(0, 7)}` : ""}._`);
      const sha = pushedSha ?? pr.headSha;
      await this.deps.status(sha, verdict === "approve" ? "success" : "failure", verdict === "approve" ? "Approved by Claude code review" : "Claude code review asked for changes").catch(() => undefined);
      this.log.info("PR review finished", { pr: pr.number, verdict, pushed: pushedSha?.slice(0, 7) ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn("PR review failed", { pr: pr.number, error: msg });
      await this.deps.status(pr.headSha, "error", `Review failed: ${msg}`.slice(0, 140)).catch(() => undefined);
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // best effort
    }
  }
}

// ─── defaults (gh, git, claude) ───────────────────────────────────────────────

async function run(cmd: string, args: string[], cwd?: string, timeout = 120_000): Promise<string> {
  const { stdout } = await execFileP(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function localReviewDeps(cfg: PrReviewConfig, log: Logger): ReviewDeps {
  return {
    listOpen: async () => {
      const out = await run("gh", ["pr", "list", "-R", cfg.repo, "--state", "open", "--limit", "50",
        "--json", "number,url,title,headRefName,headRefOid,isDraft,isCrossRepository,author"]);
      return (JSON.parse(out) as Array<{ number: number; url: string; title: string; headRefName: string; headRefOid: string; isDraft: boolean; isCrossRepository: boolean; author?: { login?: string } }>)
        .map(p => ({ number: p.number, url: p.url, title: p.title, branch: p.headRefName, headSha: p.headRefOid, isDraft: p.isDraft, isFork: p.isCrossRepository, author: p.author?.login ?? "" }));
    },
    prepare: async pr => {
      const { path: ws, createdNow } = await ensureWorkspace(cfg.workspaceRoot, `review-pr-${pr.number}`);
      const t = cfg.hooks.timeoutMs;
      if (createdNow && cfg.hooks.afterCreate) await runHook(cfg.hooks.afterCreate, ws, t, log);
      await run("git", ["fetch", "origin", pr.branch], ws, t);
      await run("git", ["checkout", "-B", pr.branch, `origin/${pr.branch}`], ws, t);
      await run("git", ["reset", "--hard", pr.headSha], ws, t);
      await run("git", ["clean", "-fd"], ws, t);
      if (cfg.hooks.beforeRun) await runHook(cfg.hooks.beforeRun, ws, t, log);
      // before_run may rebase onto main; review exactly the PR's commit.
      await run("git", ["reset", "--hard", pr.headSha], ws, t);
      return ws;
    },
    runAgent: (prompt, cwd) => new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
      const proc = spawn("claude", [
        "-p", "--strict-mcp-config", ...claudeModelArgs(), ...claudeEffortArgs(),
        "--max-turns", "150", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
      ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      trackTokenProcess(proc, "pr-review");
      proc.stdin.end(prompt);
      let result = "";
      let lastText = "";
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", line => {
        try {
          const ev = JSON.parse(line) as { type?: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
          if (ev.type === "result" && typeof ev.result === "string") result = ev.result;
          if (ev.type === "assistant") {
            const t = (ev.message?.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
            if (t) lastText = t;
          }
        } catch {
          // not JSON
        }
      });
      proc.stderr.on("data", () => { /* drain */ });
      const timer = setTimeout(() => { proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000); }, cfg.timeoutMs);
      proc.on("error", e => { clearTimeout(timer); reject(e); });
      proc.on("close", () => { clearTimeout(timer); rl.close(); resolve(result || lastText); });
    }),
    headOf: async cwd => (await run("git", ["rev-parse", "HEAD"], cwd)).trim(),
    changedSince: async (cwd, sha) => (await run("git", ["diff", "--name-only", sha, "HEAD"], cwd)).split("\n").filter(Boolean),
    remoteHead: async pr => (await run("gh", ["pr", "view", pr.url, "--json", "headRefOid", "-q", ".headRefOid"])).trim(),
    // Hooks off: the agent had write access to .husky in this checkout.
    push: async (cwd, branch) => { await run("git", ["-c", "core.hooksPath=/dev/null", "push", "origin", `HEAD:${branch}`], cwd, 120_000); },
    comment: async (url, body) => { await run("gh", ["pr", "comment", url, "--body", body]); },
    status: async (sha, state, description) => {
      await run("gh", ["api", `repos/${cfg.repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", "context=symphony/review", "-f", `description=${description.slice(0, 140)}`]);
    },
  };
}
