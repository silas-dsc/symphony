import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import { buildMcpArgs } from "./agent.js";
import { designExportPath, extractDesignLinks } from "./design-links.js";
import { classifyDiff } from "./diff-risk.js";
import * as linear from "./linear.js";
import { uploadToLinear } from "./linear-upload.js";
import { trackTokenProcess } from "./usage-budget.js";
import { ensureWorkspace, runHook } from "./workspace.js";
import type { Logger, TrackerConfig } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Functional tests: a Claude agent drives a real browser (chrome-devtools MCP)
 * against a PR preview or production, checks the ticket's acceptance points,
 * saves screenshots, and (on a preview, when allowed) fixes what it finds and
 * pushes to the PR. Symphony then posts the evidence inline on the ticket.
 *
 * Runs one test at a time: each is a full agent session, so this caps token use.
 */

/** In the marker so GateHub never reads an evidence comment as a reply to a card. */
export const FT_COMMENT_MARKER = "<!-- symphony-gate:functional-test -->";

export interface FtIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
}

export interface FtRequest {
  target: "preview" | "production";
  baseUrl: string;
  issue: FtIssue | null;
  pr: { url: string; number: number; branch: string } | null;
  changedFiles: string[];
  /** Preview only: fix failures, commit and push to the PR branch. */
  mayFix: boolean;
  /** Who/what asked, for the evidence comment ("Silas via Slack", "after deploy"). */
  reason: string;
}

export type FtStatus = "pass" | "fail" | "not_checked";

export interface FtResult {
  runId: string;
  verdict: "pass" | "fail" | "partial" | "error";
  summary: string;
  checks: Array<{ name: string; status: FtStatus; evidence: string }>;
  screenshots: Array<{ file: string; label: string }>;
  /** Built-vs-design pairs; `combined` is one side-by-side image when the agent made it. */
  comparisons: Array<{ label: string; actual: string; design: string; combined: string | null }>;
  fixedCommits: Array<{ sha: string; message: string }>;
  problems: string[];
  leftovers: string[];
}

export interface TesterDeps {
  tracker: TrackerConfig;
  workspaceRoot: string;
  hooks: { afterCreate: string | null; beforeRun: string | null; timeoutMs: number };
  symphonyRoot: string;
  mcpConfigPath: string | undefined;
  repo: string;
  log: Logger;
  maxTurns?: number;
  timeoutMs?: number;
  /** Test seams. */
  runAgent?: (prompt: string, cwd: string) => Promise<string>;
  prepare?: (req: FtRequest) => Promise<string>;
  postIssueComment?: (issueId: string, body: string) => Promise<void>;
  postPrComment?: (prUrl: string, body: string) => Promise<void>;
  upload?: (file: string) => Promise<string>;
}

export class FunctionalTester {
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  constructor(private readonly d: TesterDeps) {}

  /** Number of tests queued or running. */
  pending(): number {
    return this.waiting;
  }

  /** Queue a test; resolves once it has run and its evidence is posted. */
  run(req: FtRequest): Promise<FtResult> {
    this.waiting++;
    const job = this.queue.then(() => this.runNow(req)).finally(() => { this.waiting--; });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runNow(req: FtRequest): Promise<FtResult> {
    const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
    const label = req.pr ? `PR #${req.pr.number}` : req.target;
    this.d.log.info("Functional test starting", { target: req.target, pr: req.pr?.number ?? null, issue: req.issue?.identifier ?? null, run: runId });
    let result: FtResult;
    try {
      const ws = await (this.d.prepare ?? (r => this.prepareWorkspace(r)))(req);
      const shots = path.join(ws, ".symphony-ft", runId);
      fs.mkdirSync(shots, { recursive: true });
      const prompt = renderFtPrompt(fs.readFileSync(path.join(this.d.symphonyRoot, "prompts", "FUNCTIONAL_TEST.md"), "utf8"), req, runId, shots);
      const text = await (this.d.runAgent ?? ((p, cwd) => this.spawnAgent(p, cwd)))(prompt, ws);
      result = parseFtResult(text, runId, shots);
    } catch (e) {
      result = errorResult(runId, `Functional test couldn't run: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.d.log.info("Functional test finished", { target: req.target, label, verdict: result.verdict, checks: result.checks.length, run: runId });
    await this.postEvidence(req, result).catch(e => this.d.log.warn("Posting functional test evidence failed", { error: e instanceof Error ? e.message : String(e) }));
    return result;
  }

  private async postEvidence(req: FtRequest, result: FtResult): Promise<void> {
    if (req.issue) {
      const upload = this.d.upload ?? (f => uploadToLinear(this.d.tracker, f));
      const tryUpload = async (file: string): Promise<string | null> => {
        if (!file || !fs.existsSync(file)) return null;
        try {
          return await upload(file);
        } catch (e) {
          this.d.log.warn("Screenshot upload failed", { file: path.basename(file), error: e instanceof Error ? e.message : String(e) });
          return null;
        }
      };
      const comparisons: Array<{ label: string; combined: string | null; actual: string | null; design: string | null }> = [];
      const used = new Set<string>();
      for (const c of result.comparisons.slice(0, 6)) {
        const combined = c.combined ? await tryUpload(c.combined) : null;
        const actual = combined ? null : await tryUpload(c.actual);
        const design = combined ? null : await tryUpload(c.design);
        [c.combined, c.actual, c.design].forEach(f => f && used.add(path.resolve(f)));
        if (combined || actual || design) comparisons.push({ label: c.label, combined, actual, design });
      }
      const images: Array<{ label: string; url: string }> = [];
      for (const s of result.screenshots.filter(x => !used.has(path.resolve(x.file)) && !/\/(compare|design)-/.test(x.file)).slice(0, 12)) {
        const url = await tryUpload(s.file);
        if (url) images.push({ label: s.label, url });
      }
      const post = this.d.postIssueComment ?? ((id, body) => linear.addComment(this.d.tracker, id, body));
      await post(req.issue.id, formatEvidence(req, result, images, comparisons));
    }
    if (req.pr && req.target === "preview") {
      const post = this.d.postPrComment ?? ((url, body) => gh(["pr", "comment", url, "--body", body]).then(() => undefined));
      await post(req.pr.url, formatPrSummary(req, result));
    }
  }

  private async prepareWorkspace(req: FtRequest): Promise<string> {
    const key = req.pr ? `ft-pr-${req.pr.number}` : "ft-prod";
    const { path: ws, createdNow } = await ensureWorkspace(this.d.workspaceRoot, key);
    const t = this.d.hooks.timeoutMs;
    if (createdNow && this.d.hooks.afterCreate) await runHook(this.d.hooks.afterCreate, ws, t, this.d.log);
    await git(ws, ["fetch", "origin", req.pr ? req.pr.branch : "main"], t);
    if (req.pr) {
      await git(ws, ["checkout", "-B", req.pr.branch, `origin/${req.pr.branch}`], t);
      await git(ws, ["reset", "--hard", `origin/${req.pr.branch}`], t);
    } else {
      await git(ws, ["checkout", "--detach", "origin/main"], t);
    }
    // Screenshots live in the workspace; never let a fix commit pick them up.
    const exclude = path.join(ws, ".git", "info", "exclude");
    if (fs.existsSync(path.dirname(exclude)) && !(fs.existsSync(exclude) && fs.readFileSync(exclude, "utf8").includes(".symphony-ft"))) {
      fs.appendFileSync(exclude, "\n.symphony-ft/\n");
    }
    // Fixing needs dependencies for typecheck/lint; browsing doesn't.
    if (req.mayFix && this.d.hooks.beforeRun) await runHook(this.d.hooks.beforeRun, ws, t, this.d.log);
    return ws;
  }

  /** One-shot `claude -p` session; returns the final result text. */
  private spawnAgent(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
      const proc = spawn("claude", [
        "-p",
        ...buildMcpArgs(this.d.mcpConfigPath),
        "--max-turns", String(this.d.maxTurns ?? 60),
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      trackTokenProcess(proc, "functional-test");
      proc.stdin.end(prompt);
      let finalText = "";
      let lastAssistant = "";
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", line => {
        try {
          const ev = JSON.parse(line) as { type?: string; result?: string; message?: { content?: Array<{ type: string; text?: string }> } };
          if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
          if (ev.type === "assistant") {
            const t = (ev.message?.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
            if (t) lastAssistant = t;
          }
        } catch {
          // not JSON
        }
      });
      proc.stderr.on("data", () => { /* drain */ });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 3000);
      }, this.d.timeoutMs ?? 45 * 60_000);
      proc.on("error", e => { clearTimeout(timer); reject(e); });
      proc.on("close", () => {
        clearTimeout(timer);
        rl.close();
        // Max-turns or a timeout ends without a result; the last message may still hold the report.
        resolve(finalText || lastAssistant);
      });
    });
  }
}

// ─── prompt ───────────────────────────────────────────────────────────────────

/** Desktop only unless the change touches UI, then desktop + tablet + mobile. */
export function viewportsFor(changedFiles: string[]): string {
  if (changedFiles.length === 0) return "desktop, tablet and mobile (changed files unknown)";
  return classifyDiff(changedFiles, { additions: 0, deletions: 0 }).ui
    ? "desktop, tablet and mobile (this change touches the UI)"
    : "desktop only (no UI files changed)";
}

export function designRules(req: FtRequest, workspace: string, screenshotDir: string): string {
  const links = extractDesignLinks(req.issue?.description);
  if (!req.issue || links.length === 0) return "No design is linked to this ticket, so skip the design comparison.";
  const pinned = path.join(workspace, designExportPath(req.issue.identifier));
  return [
    `This ticket links a design: ${links.join(" · ")}.`,
    fs.existsSync(pinned)
      ? `A pinned copy is in this workspace. Open \`file://${pinned}\` rather than the link.`
      : "Open the first link. If it needs a login you don't have, say so and skip the comparison.",
    `For each main screen you test, screenshot the design at the same width to \`${screenshotDir}/design-<nn>-<name>-<width>.png\`.`,
    `Then make one side-by-side image per pair: write \`${screenshotDir}/compare-<nn>.html\` showing the built screenshot on the left (captioned "Built") and the design on the right (captioned "Design"), each 50% wide, top-aligned. Open it with \`file://\` and take a full-page screenshot to \`${screenshotDir}/compare-<nn>-<name>-<width>.png\`.`,
    "List each pair under `comparisons`. Add a check per screen named `Matches design (<screen>, <width>)` whose evidence lists the visible differences.",
  ].join(" ");
}

export function renderFtPrompt(template: string, req: FtRequest, runId: string, screenshotDir: string, workspace = path.resolve(screenshotDir, "..", "..")): string {
  const prod = req.target === "production";
  const vars: Record<string, string> = {
    target_label: prod ? "production (live site)" : `PR #${req.pr?.number ?? "?"} preview`,
    base_url: req.baseUrl,
    issue_ref: req.issue ? `${req.issue.identifier} ${req.issue.title}${req.issue.url ? ` (${req.issue.url})` : ""}` : "none linked",
    pr_ref: req.pr ? `${req.pr.url} (branch \`${req.pr.branch}\`)` : "none",
    changed_files: req.changedFiles.length ? req.changedFiles.slice(0, 40).join(", ") : "unknown",
    issue_text: req.issue?.description?.trim() || (req.issue ? req.issue.title : "No ticket: test what the changed files affect."),
    screenshot_dir: screenshotDir,
    run_id: runId,
    viewports: viewportsFor(req.changedFiles),
    design_rules: designRules(req, workspace, screenshotDir),
    target_rules: prod
      ? "- **This is production.** Real customers use it. Keep to test accounts and test data, and clean up as described above."
      : "- This is a PR preview. It may share production data, so the same rules apply.",
    fix_rules: req.mayFix && req.pr
      ? [
          `If a check fails because of this PR's code, fix it in this workspace (branch \`${req.pr.branch}\`).`,
          "Then run `pnpm typecheck && pnpm lint` and the unit tests for the packages you touched.",
          `Commit with \`Fix: <what> (functional test)\` and \`git push origin ${req.pr.branch}\`.`,
          "Make one round of fixes at most. Don't re-test after pushing: the preview needs to redeploy, and Symphony will re-test it.",
          "If a failure isn't caused by this PR, don't fix it. Report it under `problems`.",
        ].join(" ")
      : "Don't change code or push anything. Report failures under `problems` with steps to reproduce.",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

// ─── result ───────────────────────────────────────────────────────────────────

function errorResult(runId: string, summary: string): FtResult {
  return { runId, verdict: "error", summary, checks: [], screenshots: [], comparisons: [], fixedCommits: [], problems: [summary], leftovers: [] };
}

const STATUSES = new Set<FtStatus>(["pass", "fail", "not_checked"]);

export function parseFtResult(text: string, runId: string, screenshotDir: string): FtResult {
  const m = /```ft-result\s*\n([\s\S]*?)\n```/.exec(text ?? "");
  const listed = (): Array<{ file: string; label: string }> =>
    fs.existsSync(screenshotDir)
      ? fs.readdirSync(screenshotDir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()
          .map(f => ({ file: path.join(screenshotDir, f), label: f.replace(/^\d+-/, "").replace(/\.\w+$/, "").replace(/-/g, " ") }))
      : [];
  if (!m) {
    const r = errorResult(runId, "The test agent finished without a report (it may have run out of turns).");
    return { ...r, screenshots: listed() };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return { ...errorResult(runId, "The test agent's report wasn't valid JSON."), screenshots: listed() };
  }
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const checks = arr(raw.checks).map(c => c as Record<string, unknown>).map(c => ({
    name: str(c.name) || "(unnamed check)",
    status: (STATUSES.has(c.status as FtStatus) ? c.status : "not_checked") as FtStatus,
    evidence: str(c.evidence),
  }));
  // Only accept screenshots inside this run's folder (the agent's paths are data, not trusted).
  const inDir = (f: string) => path.resolve(f).startsWith(path.resolve(screenshotDir) + path.sep);
  let screenshots = arr(raw.screenshots).map(s => s as Record<string, unknown>)
    .map(s => ({ file: str(s.file), label: str(s.label) || path.basename(str(s.file)) }))
    .filter(s => s.file && inDir(s.file));
  if (screenshots.length === 0) screenshots = listed();
  const failed = checks.some(c => c.status === "fail");
  const unchecked = checks.some(c => c.status === "not_checked");
  // Trust the checks over the agent's headline verdict.
  const verdict: FtResult["verdict"] = checks.length === 0 ? "error" : failed ? "fail" : unchecked ? "partial" : "pass";
  return {
    runId,
    verdict,
    summary: str(raw.summary),
    checks,
    screenshots,
    comparisons: arr(raw.comparisons).map(c => c as Record<string, unknown>)
      .map(c => ({ label: str(c.label) || "Built vs design", actual: str(c.actual), design: str(c.design), combined: str(c.combined) || null }))
      .filter(c => (c.actual && inDir(c.actual) && c.design && inDir(c.design)) || (c.combined !== null && inDir(c.combined)))
      .map(c => ({ ...c, combined: c.combined && inDir(c.combined) ? c.combined : null })),
    fixedCommits: arr(raw.fixed_commits).map(c => c as Record<string, unknown>).map(c => ({ sha: str(c.sha), message: str(c.message) })).filter(c => c.sha),
    problems: arr(raw.problems).map(str).filter(Boolean),
    leftovers: arr(raw.leftovers).map(str).filter(Boolean),
  };
}

const ICON: Record<FtResult["verdict"], string> = { pass: "✅", fail: "❌", partial: "🟡", error: "⚠️" };
const CHECK_ICON: Record<FtStatus, string> = { pass: "✅", fail: "❌", not_checked: "⬜" };

export function headline(req: FtRequest, r: FtResult): string {
  const where = req.target === "production" ? "production" : `PR #${req.pr?.number ?? "?"} preview`;
  const passed = r.checks.filter(c => c.status === "pass").length;
  const word = { pass: "passed", fail: "failed", partial: "partly checked", error: "couldn't run" }[r.verdict];
  return `${ICON[r.verdict]} Functional test on ${where} ${word}${r.checks.length ? ` (${passed}/${r.checks.length} checks)` : ""}`;
}

export function formatEvidence(
  req: FtRequest,
  r: FtResult,
  images: Array<{ label: string; url: string }>,
  comparisons: Array<{ label: string; combined: string | null; actual: string | null; design: string | null }> = [],
): string {
  const lines = [FT_COMMENT_MARKER, `### 🧪 ${headline(req, r)}`, `_${req.reason} · ${req.baseUrl} · run ${r.runId}_`, ""];
  if (r.summary) lines.push(r.summary, "");
  for (const c of r.checks) lines.push(`- ${CHECK_ICON[c.status]} **${c.name}**${c.evidence ? `: ${c.evidence}` : ""}`);
  if (r.problems.length) lines.push("", "**Problems**", ...r.problems.map(p => `- ${p}`));
  if (r.fixedCommits.length) {
    lines.push("", `**Fixed and pushed to the PR**`, ...r.fixedCommits.map(c => `- \`${c.sha.slice(0, 7)}\` ${c.message}`), "_Symphony re-tests once the preview has the fix._");
  }
  if (r.leftovers.length) lines.push("", "**Test data left behind**", ...r.leftovers.map(l => `- ${l}`));
  const alt = (t: string) => t.replace(/[[\]]/g, "");
  if (comparisons.length) {
    lines.push("", "**Built vs design**");
    for (const c of comparisons) {
      if (c.combined) lines.push("", `_${c.label}_ (left: built · right: design)`, `![${alt(c.label)}: built vs design](${c.combined})`);
      else lines.push("", `_${c.label}_`, "| Built | Design |", "|---|---|", `| ${c.actual ? `![built](${c.actual})` : "—"} | ${c.design ? `![design](${c.design})` : "—"} |`);
    }
  }
  if (images.length) lines.push("", "**Screenshots**", ...images.map(i => `![${alt(i.label)}](${i.url})`));
  return lines.join("\n");
}

export function formatPrSummary(req: FtRequest, r: FtResult): string {
  const lines = [`**${headline(req, r)}**`, ""];
  if (r.summary) lines.push(r.summary, "");
  for (const c of r.checks) lines.push(`- ${CHECK_ICON[c.status]} ${c.name}`);
  if (r.fixedCommits.length) lines.push("", `Pushed fixes: ${r.fixedCommits.map(c => c.sha.slice(0, 7)).join(", ")}`);
  if (req.issue?.url) lines.push("", `Screenshots and details: ${req.issue.url}`);
  lines.push("", "_Symphony functional test_");
  return lines.join("\n");
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<void> {
  await execFileP("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
