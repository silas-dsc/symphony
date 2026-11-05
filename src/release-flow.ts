import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import type { ErrorSource } from "./deploy-guard.js";
import { newSignatures } from "./deploy-guard.js";
import type { FtIssue, FtRequest, FtResult } from "./functional-test.js";
import { headline } from "./functional-test.js";
import * as linear from "./linear.js";
import { getIssueContext, setIssueState } from "./linear-ops.js";
import { ticketKeyFrom } from "./review-requests.js";
import type { Logger, TrackerConfig } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Release flow: every PR merged to main goes through
 *
 *   deploying → the "Deployment" GitHub Actions run for (or after) the merge:
 *               app job (Render deploy + live-commit check), functions job,
 *               function secret-binding check
 *   watching  → N minutes after deploy, compare Render/Firebase error
 *               signatures with the window before the merge
 *   testing   → functional test on production (test accounts, DSFREE, clean-up)
 *   done      → no problems: close the ticket. Problems: open a follow-up
 *               ticket (sub-issue, in the dev state) so Symphony builds the fix.
 *
 * Each phase posts what it found on the ticket (or the PR when there's none).
 */

export interface ReleaseConfig {
  repo: string;
  workflow: string;
  siteUrl: string;
  watchMinutes: number;
  prodTest: boolean;
  doneState: string;
  followUpState: string;
  statePath: string;
  pollMs: number;
  /** Give up waiting for a deploy run after this long. */
  deployTimeoutMs: number;
}

export interface MergedPr {
  url: string;
  number: number;
  title: string;
  branch: string;
  mergedAt: string;
  mergeSha: string;
  files: string[];
}

export interface DeployRun {
  id: number;
  headSha: string;
  status: string;
  conclusion: string;
  createdAt: string;
  url: string;
}

export interface RunJob {
  name: string;
  conclusion: string;
  steps: Array<{ name: string; conclusion: string }>;
}

type Phase = "deploying" | "watching" | "testing" | "done";

export interface Release {
  pr: MergedPr;
  ticketKey: string | null;
  areas: { app: boolean; functions: boolean; rules: boolean };
  phase: Phase;
  deployedAt: string | null;
  problems: string[];
  notes: string[];
}

interface State {
  cursor: string | null;
  seen: number[];
  releases: Release[];
}

export interface ReleaseDeps {
  listMerged: (sinceIso: string) => Promise<MergedPr[]>;
  listRuns: () => Promise<DeployRun[]>;
  runJobs: (runId: number) => Promise<RunJob[]>;
  /** Commit production serves (from /api/version), or null if it can't tell. */
  liveRelease: () => Promise<string | null>;
  /** True if `sha` is in `head`'s history. */
  contains: (sha: string, head: string) => Promise<boolean>;
  errorSources: ErrorSource[];
  runTest: ((req: FtRequest) => Promise<FtResult>) | null;
  comment: (r: Release, issueId: string | null, body: string) => Promise<void>;
  dm: (text: string) => Promise<void>;
  now?: () => number;
}

export function classifyAreas(files: string[]): Release["areas"] {
  return {
    app: files.some(f => f.startsWith("packages/app/") || f === "package.json" || f === "pnpm-lock.yaml" || f === "pnpm-workspace.yaml"),
    functions: files.some(f => f.startsWith("packages/functions/") || f.startsWith("packages/stripe-data-pipeline-loader/")),
    rules: files.some(f => f === "firestore.rules" || f === "storage.rules"),
  };
}

/** The first finished, non-cancelled Deployment run that started at/after the merge (a later run includes it). */
export function pickRun(runs: DeployRun[], mergedAt: string): { run: DeployRun | null; waiting: boolean } {
  const after = runs
    .filter(r => Date.parse(r.createdAt) >= Date.parse(mergedAt) - 60_000)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const done = after.find(r => r.status === "completed" && r.conclusion !== "cancelled");
  if (done) return { run: done, waiting: false };
  return { run: null, waiting: after.some(r => r.status !== "completed") };
}

const ok = (c: string | undefined) => c === "success";

/** Lines + problems for the deploy phase, from the run's jobs. */
export function summariseDeploy(areas: Release["areas"], run: DeployRun, jobs: RunJob[]): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const job = (re: RegExp) => jobs.find(j => re.test(j.name));
  const step = (j: RunJob | undefined, re: RegExp) => j?.steps.find(s => re.test(s.name));
  if (areas.functions || areas.rules) {
    const fj = job(/firebase|functions/i);
    if (!fj) problems.push(`Functions deploy job not found in ${run.url}`);
    else if (ok(fj.conclusion)) lines.push("✅ Firebase functions deployed");
    else problems.push(`Functions deploy ${fj.conclusion || "didn't finish"}: ${run.url}`);
    if (areas.functions) {
      const sc = step(fj, /secret binding/i);
      if (!sc || sc.conclusion === "skipped") lines.push("⬜ Function secret bindings not checked by this run");
      else if (ok(sc.conclusion)) lines.push("✅ Every function's declared secrets are bound");
      else problems.push(`Function secrets missing after deploy (see "Check function secret bindings" in ${run.url})`);
    }
  }
  if (areas.app) {
    const aj = job(/render|deploy app/i);
    const verify = step(aj, /serves this commit/i);
    if (aj && !ok(aj.conclusion)) problems.push(`App deploy to Render ${aj.conclusion || "didn't finish"}: ${run.url}`);
    else if (verify && ok(verify.conclusion)) lines.push("✅ App deployed to Render and serving this commit");
    else lines.push("⬜ App deploy not run from GitHub Actions; checking the live commit instead");
  }
  return { lines, problems };
}

export class ReleaseFlow {
  private state: State = { cursor: null, seen: [], releases: [] };
  private last = 0;
  private busy = false;
  private testing = new Set<number>();

  constructor(
    private readonly cfg: ReleaseConfig,
    private readonly tracker: TrackerConfig,
    private readonly deps: ReleaseDeps,
    private readonly log: Logger,
  ) {
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(cfg.statePath, "utf8")) };
    } catch {
      // fresh
    }
  }

  active(): Release[] {
    return this.state.releases.filter(r => r.phase !== "done" || !r.notes.includes("concluded"));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async reconcile(): Promise<void> {
    const now = this.now();
    if (this.busy || now - this.last < this.cfg.pollMs) return;
    this.busy = true;
    this.last = now;
    try {
      await this.discover(now);
      // Includes releases that just reached "done" but haven't been concluded yet.
      for (const r of this.state.releases.filter(x => x.phase !== "done" || !x.notes.includes("concluded"))) {
        try {
          await this.advance(r);
        } catch (e) {
          this.log.warn("Release flow step failed", { pr: r.pr.number, phase: r.phase, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Keep a short history only.
      this.state.releases = this.state.releases.filter(r => r.phase !== "done" || now - Date.parse(r.pr.mergedAt) < 7 * 86_400_000);
      this.persist();
    } finally {
      this.busy = false;
    }
  }

  private async discover(now: number): Promise<void> {
    // First run starts from now: don't replay old merges.
    const since = this.state.cursor ?? new Date(now).toISOString();
    const merged = await this.deps.listMerged(since);
    for (const pr of merged.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))) {
      if (this.state.seen.includes(pr.number)) continue;
      this.state.seen.push(pr.number);
      const areas = classifyAreas(pr.files);
      const release: Release = {
        pr, ticketKey: ticketKeyFrom(pr.title, pr.branch), areas,
        phase: areas.app || areas.functions || areas.rules ? "deploying" : "done",
        deployedAt: null, problems: [], notes: [],
      };
      this.state.releases.push(release);
      this.log.info("Release flow: tracking merged PR", { pr: pr.number, ticket: release.ticketKey ?? "none", ...areas });
    }
    this.state.seen = this.state.seen.slice(-300);
    this.state.cursor = new Date(now - 5 * 60_000).toISOString(); // overlap a little; `seen` de-dupes
  }

  private async advance(r: Release): Promise<void> {
    if (r.phase === "deploying") await this.checkDeploy(r);
    if (r.phase === "watching") await this.checkLogs(r);
    if (r.phase === "testing") await this.startTest(r);
    if (r.phase === "done") await this.conclude(r);
  }

  private async issue(r: Release): Promise<FtIssue | null> {
    if (!r.ticketKey) return null;
    const ctx = await getIssueContext(this.tracker, r.ticketKey).catch(() => null);
    return ctx ? { id: ctx.id, identifier: ctx.identifier, title: ctx.title, description: ctx.description, url: ctx.url } : null;
  }

  private async post(r: Release, body: string): Promise<void> {
    const issue = await this.issue(r);
    await this.deps.comment(r, issue?.id ?? null, body);
  }

  private async checkDeploy(r: Release): Promise<void> {
    const { run, waiting } = pickRun(await this.deps.listRuns(), r.pr.mergedAt);
    if (!run) {
      if (!waiting && this.now() - Date.parse(r.pr.mergedAt) > this.cfg.deployTimeoutMs) {
        r.problems.push(`No "${this.cfg.workflow}" run deployed this merge within ${Math.round(this.cfg.deployTimeoutMs / 60_000)} min.`);
        await this.post(r, `🚀 **Deploy of PR #${r.pr.number}**\n\n- ❌ ${r.problems.at(-1)}`);
        r.phase = "watching";
        r.deployedAt = new Date(this.now()).toISOString();
      }
      return;
    }
    const { lines, problems } = summariseDeploy(r.areas, run, await this.deps.runJobs(run.id));
    // App: when Actions didn't verify the live commit, ask production directly.
    if (r.areas.app && !lines.some(l => l.includes("serving this commit")) && !problems.some(p => p.startsWith("App deploy"))) {
      const live = await this.deps.liveRelease().catch(() => null);
      if (!live) {
        if (this.now() - Date.parse(r.pr.mergedAt) < 25 * 60_000) return; // give Render auto-deploy time
        lines.push("⬜ Couldn't read which commit production serves (/api/version)");
      } else if (await this.deps.contains(r.pr.mergeSha, live).catch(() => false)) {
        lines.push(`✅ Production serves \`${live.slice(0, 7)}\`, which includes this merge`);
      } else if (this.now() - Date.parse(r.pr.mergedAt) < 40 * 60_000) {
        return; // still deploying
      } else {
        problems.push(`Production still serves \`${live.slice(0, 7)}\`, 40 min after the merge; the app deploy didn't land.`);
      }
    }
    r.problems.push(...problems);
    r.deployedAt = new Date(this.now()).toISOString();
    r.phase = "watching";
    await this.post(r, [`🚀 **Deploy of PR #${r.pr.number}** ([run](${run.url}))`, "", ...lines, ...problems.map(p => `- ❌ ${p}`)].join("\n").replace(/^(✅|⬜)/gm, "- $1"));
  }

  private async checkLogs(r: Release): Promise<void> {
    const windowMs = this.cfg.watchMinutes * 60_000;
    const deployed = Date.parse(r.deployedAt ?? r.pr.mergedAt);
    if (this.now() < deployed + windowMs) return;
    const iso = (t: number) => new Date(t).toISOString();
    const merged = Date.parse(r.pr.mergedAt);
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    let sources = 0;
    for (const source of this.deps.errorSources) {
      try {
        for (const [s, n] of await source(iso(merged - windowMs), iso(merged))) before.set(s, (before.get(s) ?? 0) + n);
        for (const [s, n] of await source(iso(deployed), iso(deployed + windowMs))) after.set(s, (after.get(s) ?? 0) + n);
        sources++;
      } catch (e) {
        r.notes.push(`A log source failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const fresh = newSignatures(before, after, 3);
    const lines = sources === 0
      ? ["⬜ No log source configured or reachable (Render/Firebase)"]
      : [
          `${fresh.length ? "❌" : "✅"} ${this.cfg.watchMinutes} min after deploy: ${total(after)} errors (${total(before)} in the ${this.cfg.watchMinutes} min before the merge), ${fresh.length} new error type(s)`,
          ...fresh.slice(0, 5).map(([s, n]) => `  - ${n}× \`${s.slice(0, 160)}\``),
        ];
    if (fresh.length) r.problems.push(`New production errors after release: ${fresh.slice(0, 3).map(([s]) => s.slice(0, 100)).join("; ")}`);
    // Production tests cost a full agent run, so only for merges with a ticket to test against and post to.
    r.phase = this.cfg.prodTest && this.deps.runTest && r.ticketKey && (r.areas.app || r.areas.functions) ? "testing" : "done";
    await this.post(r, [`📈 **Logs after PR #${r.pr.number}**`, "", ...lines.map(l => (l.startsWith("  ") ? l : `- ${l}`))].join("\n"));
  }

  private async startTest(r: Release): Promise<void> {
    if (this.testing.has(r.pr.number) || !this.deps.runTest) return;
    this.testing.add(r.pr.number);
    const issue = await this.issue(r);
    void this.deps.runTest({
      target: "production",
      baseUrl: this.cfg.siteUrl,
      issue,
      pr: null,
      changedFiles: r.pr.files,
      mayFix: false,
      reason: `After PR #${r.pr.number} was deployed`,
    }).then(res => {
      if (res.verdict === "fail" || res.verdict === "error") {
        r.problems.push(`Production functional test ${res.verdict === "fail" ? "failed" : "couldn't run"}: ${res.problems.slice(0, 3).join("; ") || res.summary}`);
      } else if (res.verdict === "partial") {
        r.notes.push("Some production checks couldn't be done; see the test comment.");
      }
      r.notes.push(headline({ target: "production" } as FtRequest, res));
      r.phase = "done";
      this.persist();
    }).catch(e => {
      r.problems.push(`Production functional test crashed: ${e instanceof Error ? e.message : String(e)}`);
      r.phase = "done";
      this.persist();
    }).finally(() => this.testing.delete(r.pr.number));
  }

  /** Close the ticket, or open a follow-up for Symphony to fix. Runs once (sets notes marker). */
  private async conclude(r: Release): Promise<void> {
    if (r.notes.includes("concluded")) return;
    r.notes.push("concluded");
    if (!(r.areas.app || r.areas.functions || r.areas.rules)) return;
    const ctx = r.ticketKey ? await getIssueContext(this.tracker, r.ticketKey).catch(() => null) : null;
    if (r.problems.length === 0) {
      if (ctx) {
        try {
          await setIssueState(this.tracker, ctx.id, this.cfg.doneState);
        } catch (e) {
          this.log.warn("Release flow: couldn't close ticket", { ticket: ctx.identifier, error: e instanceof Error ? e.message : String(e) });
        }
        await this.deps.comment(r, ctx.id, `✅ **Released.** Deployed, logs clean${this.cfg.prodTest ? ", production test passed" : ""}. Closing.`);
      }
      this.log.info("Release flow: released clean", { pr: r.pr.number, ticket: r.ticketKey ?? "none" });
      return;
    }
    const brief = [
      `Problems found after ${r.pr.url} (${r.ticketKey ?? "no ticket"}) was released:`,
      "",
      ...r.problems.map(p => `- ${p}`),
      "",
      "Evidence (deploy run, logs, production test screenshots) is in the comments on the original ticket.",
      "Fix the cause, add a test that would have caught it, and open a PR.",
    ].join("\n");
    if (ctx) {
      const dev = ctx.states.find(s => s.name.toLowerCase() === this.cfg.followUpState.toLowerCase());
      const follow = await linear.createIssue(this.tracker, {
        teamId: ctx.teamId,
        title: `Fix after release: ${ctx.title}`.slice(0, 200),
        description: brief,
        ...(dev ? { stateId: dev.id } : {}),
        parentId: ctx.id,
      });
      await this.deps.comment(r, ctx.id, `⚠️ **Problems after release.** Follow-up: ${follow.identifier}${follow.url ? ` (${follow.url})` : ""}\n\n${r.problems.map(p => `- ${p}`).join("\n")}`);
      await this.deps.dm(`⚠️ Problems after releasing PR #${r.pr.number} (${r.ticketKey}). Symphony opened ${follow.identifier} to fix them: ${follow.url ?? ""}`);
      this.log.warn("Release flow: problems, follow-up opened", { pr: r.pr.number, follow_up: follow.identifier });
    } else {
      await this.deps.comment(r, null, `⚠️ **Problems after release**\n\n${r.problems.map(p => `- ${p}`).join("\n")}`);
      await this.deps.dm(`⚠️ Problems after releasing PR #${r.pr.number} (no ticket): ${r.problems[0]} ${r.pr.url}`);
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

// ─── default GitHub / site access ─────────────────────────────────────────────

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export function ghReleaseDeps(cfg: ReleaseConfig): Pick<ReleaseDeps, "listMerged" | "listRuns" | "runJobs" | "liveRelease" | "contains"> {
  return {
    listMerged: async since => {
      const out = await gh(["pr", "list", "-R", cfg.repo, "--state", "merged", "--base", "main", "--search", `merged:>=${since.slice(0, 19)}Z`,
        "--json", "url,number,title,headRefName,mergedAt,mergeCommit,files", "--limit", "30"]);
      return (JSON.parse(out) as Array<{ url: string; number: number; title: string; headRefName: string; mergedAt: string; mergeCommit?: { oid?: string }; files?: Array<{ path: string }> }>)
        .map(p => ({ url: p.url, number: p.number, title: p.title, branch: p.headRefName, mergedAt: p.mergedAt, mergeSha: p.mergeCommit?.oid ?? "", files: (p.files ?? []).map(f => f.path) }));
    },
    listRuns: async () => {
      const out = await gh(["run", "list", "-R", cfg.repo, "--workflow", cfg.workflow, "--branch", "main", "--limit", "15",
        "--json", "databaseId,headSha,status,conclusion,createdAt,url"]);
      return (JSON.parse(out) as Array<{ databaseId: number; headSha: string; status: string; conclusion: string; createdAt: string; url: string }>)
        .map(r => ({ id: r.databaseId, headSha: r.headSha, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, url: r.url }));
    },
    runJobs: async id => {
      const out = await gh(["run", "view", String(id), "-R", cfg.repo, "--json", "jobs"]);
      return ((JSON.parse(out) as { jobs?: RunJob[] }).jobs ?? []).map(j => ({ name: j.name, conclusion: j.conclusion, steps: (j.steps ?? []).map(s => ({ name: s.name, conclusion: s.conclusion })) }));
    },
    liveRelease: async () => {
      const res = await fetch(`${cfg.siteUrl.replace(/\/$/, "")}/api/version?ts=${Date.now()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
      const body = (await res.json()) as { release?: string };
      return body.release && /^[0-9a-f]{7,40}$/.test(body.release) ? body.release : null;
    },
    contains: async (sha, head) => {
      if (head.startsWith(sha) || sha.startsWith(head)) return true;
      const out = await gh(["api", `repos/${cfg.repo}/compare/${sha}...${head}`, "--jq", ".status"]);
      return ["ahead", "identical"].includes(out.trim());
    },
  };
}
