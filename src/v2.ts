import * as fs from "node:fs";
import * as path from "node:path";
import { AskFlow } from "./ask-flow.js";
import { DeployGuard, type ErrorSource } from "./deploy-guard.js";
import { GcloudFirebaseLogsClient, groupErrors } from "./firebase-logs.js";
import { GateHub } from "./gate-hub.js";
import { buildDraftBlocks } from "./gate-slack.js";
import { GhCliClient } from "./github.js";
import { allowDispatch, assess, formatGovernor, type DispatchCandidate, type GovernorReadout } from "./governor.js";
import { ReviewFlow } from "./review-flow.js";
import { ReportScheduler, fetchDailyActivity, fetchRoadmap, formatDailyDraft, formatWeeklyRoadmap } from "./reports.js";
import { defaultRunLogPath, readRunRecords } from "./run-log.js";
import { addComment } from "./linear.js";
import { FunctionalTester, headline, type FtRequest } from "./functional-test.js";
import { FUNCTIONAL_TEST_ACTION } from "./gates.js";
import { getIssueContext } from "./linear-ops.js";
import { ReleaseFlow, ghReleaseDeps } from "./release-flow.js";
import { ReviewRequests, previewUrlFor } from "./review-requests.js";
import type { Gate } from "./types.js";
import { setIssueState } from "./linear-ops.js";
import {
  assessRoadmap, fetchLinkedIssues, formatEntry, loadRoadmap, parseRoadmapConfig, pickNext, rankOf,
  type RoadmapConfig, type RoadmapEntry,
} from "./roadmap.js";
import { openDm, postMessage } from "./slack-api.js";
import { SlackSocket } from "./slack-socket.js";
import type { Logger, RateLimitInfo, WorkflowConfig } from "./types.js";
import { createIntakeWatchers, type Reconcilable } from "./v2-intake.js";

/**
 * Symphony v2 composition root. The orchestrator owns one of these when
 * `v2.enabled` and calls: `start()`, `reconcile()` every tick,
 * `allowDispatch()` before starting an agent, `maxConcurrent()` for slots,
 * and `stop()`. Everything else lives behind it.
 */
export class SymphonyV2 {
  readonly hub: GateHub;
  private readonly cfg: WorkflowConfig;
  private readonly root: string;
  private readonly log: Logger;
  private readonly socket: SlackSocket | null;
  private readonly review: ReviewFlow | null;
  private readonly asks: AskFlow;
  private readonly guard: DeployGuard | null;
  private readonly reports: ReportScheduler | null;
  private readonly intake: Reconcilable[];
  private readout: GovernorReadout | null = null;
  private drafts = new Map<string, string>();
  private readonly roadmapCfg: RoadmapConfig;
  private roadmap: RoadmapEntry[] = [];
  private roadmapAt = 0;
  private roadmapMissingLogged = false;
  private readonly gh: GhCliClient;
  private readonly tester: FunctionalTester;
  private readonly reviewRequests: ReviewRequests | null;
  private readonly release: ReleaseFlow | null;
  private readonly repo: string;
  private readonly previewTemplate: string | null;

  constructor(cfg: WorkflowConfig, symphonyRoot: string, log: Logger) {
    this.cfg = cfg;
    this.root = symphonyRoot;
    this.log = log;
    const v2 = cfg.v2;
    fs.mkdirSync(v2.stateDir, { recursive: true });
    const state = (name: string) => path.join(v2.stateDir, name);

    this.hub = new GateHub({
      operatorKey: v2.operatorKey,
      people: v2.people,
      designPerson: v2.designPerson,
      productPerson: v2.productPerson,
      slackBotToken: v2.slack.botToken || null,
      persistPath: state("gates.json"),
      boardUrl: null,
    }, cfg.tracker, log);
    this.hub.onDraft((kind, id, by) => this.onDraft(kind, id, by));
    this.hub.onKind("triage_decision", async () => { /* intake module registers its own handler */ });

    this.socket = v2.slack.appToken
      ? new SlackSocket(v2.slack.appToken, log, a => this.hub.handleSlackAction(a))
      : null;

    const gh = new GhCliClient(log);
    this.gh = gh;
    const gp = cfg.githubPreview;
    this.repo = gp.repoOwner && gp.repoName ? `${gp.repoOwner}/${gp.repoName}` : "team-dsc/team-dsc";
    this.previewTemplate = gp.urlTemplate || null;
    this.guard = v2.deployGuard.enabled
      ? new DeployGuard({ watchMinutes: v2.deployGuard.watchMinutes, minNewOccurrences: v2.deployGuard.minNewOccurrences, statePath: state("deploy-guard.json") },
          cfg.tracker, this.errorSources(), gh, this.hub, log)
      : null;
    this.review = v2.review.enabled
      ? new ReviewFlow({
          teamKey: v2.teamKey,
          reviewState: v2.review.state,
          reworkState: v2.review.reworkState,
          mergedState: v2.review.mergedState,
          autoMerge: v2.review.autoMerge,
          killSwitchPath: path.join(symphonyRoot, ".symphony-autodeploy-off"),
          maxAutoSendBacks: v2.review.maxAutoSendBacks,
          statePath: state("review-flow.json"),
        }, cfg.tracker, this.hub, gh, log, m => this.guard?.track(m.issueId, m.identifier, m.pr))
      : null;
    this.asks = new AskFlow(v2.teamKey, cfg.tracker, this.hub, log);
    this.reports = v2.reports.enabled
      ? new ReportScheduler({
          dailyHourLocal: v2.reports.dailyHourLocal,
          weeklyDay: v2.reports.weeklyDay,
          weeklyHourLocal: v2.reports.weeklyHourLocal,
          statePath: state("reports.json"),
          runDaily: () => this.runDaily(),
          runWeekly: () => this.runWeekly(),
          log,
        })
      : null;
    this.intake = createIntakeWatchers(cfg, this.hub, state, log);
    this.roadmapCfg = parseRoadmapConfig(v2.roadmap, symphonyRoot);

    // Functional tests (card button, re-tests after fixes, production after release).
    const mcp = path.join(symphonyRoot, "agent-mcp.json");
    this.tester = new FunctionalTester({
      tracker: cfg.tracker,
      workspaceRoot: cfg.workspace.root,
      hooks: { afterCreate: cfg.hooks.afterCreate ?? null, beforeRun: cfg.hooks.beforeRun ?? null, timeoutMs: cfg.hooks.timeoutMs },
      symphonyRoot,
      mcpConfigPath: fs.existsSync(mcp) ? mcp : undefined,
      repo: this.repo,
      log,
    });
    this.hub.onSideAction(FUNCTIONAL_TEST_ACTION, (gate, by) => this.functionalTestFromCard(gate, by));

    const rr = v2.reviewRequests;
    this.reviewRequests = rr.enabled === false ? null : new ReviewRequests({
      repo: this.repo,
      previewTemplate: this.previewTemplate,
      linearWorkspaceUrl: typeof rr.linear_url === "string" ? rr.linear_url : null,
      intervalMs: (typeof rr.interval_minutes === "number" ? rr.interval_minutes : 5) * 60_000,
      maxOpen: typeof rr.max_open === "number" ? rr.max_open : 6,
    }, this.hub, gh, log);

    const rel = v2.release;
    if (rel.enabled === true) {
      const relCfg = {
        repo: this.repo,
        workflow: typeof rel.workflow === "string" ? rel.workflow : "Deployment",
        siteUrl: typeof rel.site_url === "string" ? rel.site_url : "https://teamdsc.com.au",
        watchMinutes: typeof rel.watch_minutes === "number" ? rel.watch_minutes : v2.deployGuard.watchMinutes,
        prodTest: rel.prod_test !== false,
        doneState: typeof rel.done_state === "string" ? rel.done_state : "Done",
        followUpState: typeof rel.follow_up_state === "string" ? rel.follow_up_state : (cfg.tracker.activeStates[0] ?? "Dev in Progress"),
        statePath: state("release-flow.json"),
        pollMs: 2 * 60_000,
        deployTimeoutMs: 120 * 60_000,
      };
      this.release = new ReleaseFlow(relCfg, cfg.tracker, {
        ...ghReleaseDeps(relCfg),
        errorSources: this.errorSources(),
        runTest: relCfg.prodTest ? req => this.tester.run(req) : null,
        comment: async (r, issueId, body) => {
          if (issueId) await addComment(cfg.tracker, issueId, body);
          else await gh.commentPr(r.pr.url, body);
        },
        dm: text => this.hub.dm(text),
      }, log);
    } else {
      this.release = null;
    }
  }

  async start(): Promise<void> {
    if (this.socket) {
      this.socket.start().catch(e => this.log.error("Slack Socket Mode failed to start", { error: errMsg(e) }));
    } else {
      this.log.warn("v2: no slack.app_token — Slack buttons are off; reply on the Linear ticket to resolve cards");
    }
    this.log.info("Symphony v2 started", {
      review: !!this.review, deploy_guard: !!this.guard, reports: !!this.reports, intake: this.intake.length,
    });
  }

  stop(): void {
    this.socket?.stop();
  }

  /** Called every orchestrator tick. Each step is isolated so one failure never blocks the rest. */
  async reconcile(rateLimit: RateLimitInfo | null): Promise<void> {
    this.readout = this.assessGovernor(rateLimit);
    const steps: Array<[string, () => Promise<void>]> = [
      ["linear replies", () => this.hub.reconcileLinearReplies()],
      ["asks", () => this.asks.reconcile()],
      ["review", () => this.review?.reconcile() ?? Promise.resolve()],
      ["deploy guard", () => this.guard?.reconcile() ?? Promise.resolve()],
      ["reports", () => this.reports?.reconcile() ?? Promise.resolve()],
      ["roadmap", () => this.reconcileRoadmap()],
      ["review requests", () => this.reviewRequests?.reconcile() ?? Promise.resolve()],
      ["release", () => this.release?.reconcile() ?? Promise.resolve()],
      ...this.intake.map(w => [w.name, () => w.reconcile()] as [string, () => Promise<void>]),
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        this.log.warn(`v2 ${name} failed`, { error: errMsg(e) });
      }
    }
  }

  allowDispatch(issue: DispatchCandidate): { ok: boolean; reason: string | null } {
    if (!this.cfg.v2.governor.enabled) {
      // Still never start a ticket that is waiting on a person.
      return allowDispatch({ ...(this.readout ?? emptyReadout()), mode: "normal" }, issue);
    }
    return allowDispatch(this.readout ?? emptyReadout(), issue);
  }

  maxConcurrent(base: number): number {
    if (!this.cfg.v2.governor.enabled || !this.readout) return base;
    return Math.min(base, this.readout.maxConcurrent);
  }

  status(): Record<string, unknown> {
    return {
      governor: this.readout ? formatGovernor(this.readout) : null,
      open_gates: this.hub.store.openGates().map(g => ({ id: g.id, kind: g.kind, issue: g.issueIdentifier, for: g.assignee, since: g.createdAt })),
      deploy_watches: this.guard?.pending() ?? 0,
      auto_deploy: this.review ? (this.review.killSwitchOn() ? "off (kill switch)" : this.cfg.v2.review.autoMerge ? "on" : "off") : "off",
      roadmap: this.roadmapCfg.enabled ? this.roadmap.filter(e => e.verdict !== "done").map(formatEntry) : null,
      functional_tests_queued: this.tester.pending(),
      releases: this.release?.active().map(r => `PR #${r.pr.number}${r.ticketKey ? ` (${r.ticketKey})` : ""}: ${r.phase}${r.problems.length ? `, ${r.problems.length} problem(s)` : ""}`) ?? null,
    };
  }

  // ─── functional tests from cards ─────────────────────────────────────────

  /** 🧪 on a review card: test the PR preview, fix what's broken, re-test after the fix deploys. */
  private async functionalTestFromCard(gate: Gate, by: string): Promise<void> {
    const prUrl = gate.meta?.prUrl;
    if (!prUrl) {
      await this.hub.dm(`🧪 Can't test "${gate.title}": the card has no PR.`);
      return;
    }
    const pr = await this.gh.getPr(prUrl);
    if (pr.state !== "OPEN") {
      await this.hub.dm(`🧪 PR #${pr.number} is ${pr.state.toLowerCase()}, so there's nothing to test on its preview.`);
      return;
    }
    const baseUrl = gate.meta?.previewUrl ?? previewUrlFor(this.previewTemplate, pr.number);
    if (!baseUrl) {
      await this.hub.dm(`🧪 No preview URL for PR #${pr.number} (set github_preview.url_template).`);
      return;
    }
    const key = gate.issueId ?? gate.meta?.ticket ?? null;
    const ctx = key ? await getIssueContext(this.cfg.tracker, key).catch(() => null) : null;
    const req: FtRequest = {
      target: "preview",
      baseUrl,
      issue: ctx ? { id: ctx.id, identifier: ctx.identifier, title: ctx.title, description: ctx.description, url: ctx.url } : null,
      pr: { url: pr.url, number: pr.number, branch: pr.headRefName },
      changedFiles: pr.files,
      mayFix: true,
      reason: `Asked by ${by}`,
    };
    const queued = this.tester.pending();
    await this.hub.dm(`🧪 Functional test ${queued ? `queued (${queued} ahead)` : "started"}: PR #${pr.number} on ${baseUrl}. Evidence goes on ${ctx ? ctx.identifier : "the PR"}.`);
    void this.tester.run(req).then(async res => {
      const where = ctx?.url ?? pr.url;
      await this.hub.dm(`${headline(req, res)}: ${gate.title}\n${res.summary}\n${where}`);
      if (res.fixedCommits.length > 0) await this.retestAfterFix(req, res.fixedCommits.at(-1)?.sha ?? "");
    });
  }

  /** Wait until the preview serves the fix (or ~12 min if it can't say), then test once more without fixing. */
  private async retestAfterFix(req: FtRequest, sha: string): Promise<void> {
    const deadline = Date.now() + 30 * 60_000;
    let readable = false;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 60_000));
      try {
        const res = await fetch(`${req.baseUrl}/api/version?ts=${Date.now()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if ((res.headers.get("content-type") ?? "").includes("json")) {
          readable = true;
          const release = String(((await res.json()) as { release?: string }).release ?? "");
          if (sha && release && (release.startsWith(sha) || sha.startsWith(release))) break;
        } else if (!readable && Date.now() > deadline - 18 * 60_000) {
          break; // can't tell which commit is live; ~12 min is usually enough for a preview
        }
      } catch {
        // preview restarting
      }
    }
    const res = await this.tester.run({ ...req, mayFix: false, reason: "Re-test after the fixes reached the preview" });
    await this.hub.dm(`${headline(req, res)} (re-test after fixes): PR #${req.pr?.number}\n${req.issue?.url ?? req.pr?.url ?? ""}`);
  }

  /** Position on the product roadmap (1 = top), for the issue or its parent; null when not on it. */
  roadmapRank(identifier: string, parentIdentifier?: string | null): number | null {
    return this.roadmapCfg.enabled ? rankOf(this.roadmap, identifier, parentIdentifier) : null;
  }

  // ─── roadmap ─────────────────────────────────────────────────────────────

  /**
   * Re-read the roadmap snapshot, check each linked ticket in Linear, and start
   * the first ready item if we're under the in-flight cap. Items waiting on a
   * person are flagged (in /status and in the "starting" DM) and skipped.
   */
  private async reconcileRoadmap(): Promise<void> {
    const rc = this.roadmapCfg;
    if (!rc.enabled || Date.now() - this.roadmapAt < rc.refreshMs) return;
    this.roadmapAt = Date.now();
    const file = loadRoadmap(rc.file);
    if (!file) {
      if (!this.roadmapMissingLogged) this.log.warn("v2 roadmap: snapshot file not found; dispatch order unchanged", { file: rc.file });
      this.roadmapMissingLogged = true;
      this.roadmap = [];
      return;
    }
    this.roadmapMissingLogged = false;
    const ids = file.items.map(i => i.identifier).filter((x): x is string => !!x);
    const issues = await fetchLinkedIssues(this.cfg.tracker, this.cfg.v2.teamKey, ids);
    const devState = this.cfg.tracker.activeStates[0] ?? "Dev in Progress";
    const name = (key: string | null) => (key ? this.hub.person(key)?.name ?? key : null);
    this.roadmap = assessRoadmap(file.items, issues, {
      teamKey: this.cfg.v2.teamKey,
      devState,
      pullFromStates: rc.pullFromStates,
      designPerson: name(this.cfg.v2.designPerson),
      productPerson: name(this.cfg.v2.productPerson),
      openGateFor: id => {
        const g = this.hub.store.openGates().find(x => x.issueId === id);
        return g ? name(g.assignee ?? this.cfg.v2.operatorKey) : null;
      },
    });
    if (!rc.pullReady) return;

    const { next, skipped } = pickNext(this.roadmap, rc.maxInFlight);
    if (!next?.issueId) return;
    const moved = await setIssueState(this.cfg.tracker, next.issueId, devState);
    if (!moved) return;
    next.verdict = "building";
    this.log.info("v2 roadmap: starting next item", { rank: next.rank, issue: next.identifier, skipped: skipped.length });

    const skippedLines = skipped.map(e => `• ${formatEntry(e)}`);
    const where = file.source ? ` <${file.source}|roadmap>` : " roadmap";
    const dm = [`▶️ Starting #${next.rank} on the${where}: *${next.title}* (${next.identifier}).`]
      .concat(skippedLines.length ? ["Skipped, waiting on people:", ...skippedLines] : [])
      .join("\n");
    await this.notifyOperator(dm).catch(e => this.log.warn("v2 roadmap: DM failed", { error: errMsg(e) }));
    const comment = [`Symphony started this: it's #${next.rank} on the product roadmap and the first item ready for dev.`]
      .concat(skipped.length ? ["", "Skipped higher items that are waiting on people:", ...skipped.map(e => `- ${formatEntry(e)}`)] : [])
      .join("\n");
    await addComment(this.cfg.tracker, next.issueId, comment).catch(e => this.log.warn("v2 roadmap: comment failed", { error: errMsg(e) }));
  }

  // ─── governor ────────────────────────────────────────────────────────────

  private assessGovernor(rateLimit: RateLimitInfo | null): GovernorReadout {
    const records = readRunRecords(defaultRunLogPath(this.root));
    const today = new Date().toDateString();
    const weekAgo = Date.now() - 7 * 86_400_000;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    for (const r of records) {
      const t = Date.parse(r.at);
      if (t >= weekAgo) spendWeekUsd += r.costUsd ?? 0;
      if (new Date(t).toDateString() === today) spendTodayUsd += r.costUsd ?? 0;
    }
    return assess({
      operatorKey: this.cfg.v2.operatorKey,
      people: this.cfg.v2.people.map(p => ({ key: p.key, name: p.name, maxOpen: p.maxOpenGates, maxPerHour: p.maxNewGatesPerHour, ...this.hub.load(p.key) })),
      rateLimit,
      spendTodayUsd,
      spendWeekUsd,
      baseConcurrency: this.cfg.agent.maxConcurrentAgents,
    }, this.cfg.v2.governor);
  }

  // ─── reports ─────────────────────────────────────────────────────────────

  private async runDaily(): Promise<void> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const activity = await fetchDailyActivity(this.cfg.tracker, this.cfg.v2.teamKey, since.toISOString());
    const text = formatDailyDraft(activity, {
      openGates: this.hub.store.openGates().length,
      governorNote: this.readout && this.readout.mode !== "normal" ? formatGovernor(this.readout).split("\n")[0] : undefined,
    });
    await this.sendDraft("daily", text);
  }

  private async runWeekly(): Promise<void> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [roadmap, week] = await Promise.all([
      fetchRoadmap(this.cfg.tracker, this.cfg.v2.teamKey),
      fetchDailyActivity(this.cfg.tracker, this.cfg.v2.teamKey, weekAgo),
    ]);
    await this.sendDraft("weekly", formatWeeklyRoadmap(roadmap, { shippedThisWeek: week.done.length }));
  }

  /** Plain DM to the operator (alerts). Returns false when Slack isn't configured. */
  async notifyOperator(text: string): Promise<boolean> {
    const operator = this.hub.person(this.cfg.v2.operatorKey);
    const token = this.cfg.v2.slack.botToken;
    if (!token || !operator?.slackUserId) return false;
    const dm = await openDm(token, operator.slackUserId);
    await postMessage(token, dm, text);
    return true;
  }

  /** DM the operator a draft with Post / Skip buttons. */
  private async sendDraft(kind: string, text: string): Promise<void> {
    const operator = this.hub.person(this.cfg.v2.operatorKey);
    const token = this.cfg.v2.slack.botToken;
    if (!token || !operator?.slackUserId) {
      this.log.info(`v2 ${kind} draft (no Slack DM configured)`, { text });
      return;
    }
    const id = `${kind}-${new Date().toISOString().slice(0, 10)}`;
    this.drafts.set(id, text);
    const dm = await openDm(token, operator.slackUserId);
    const card = buildDraftBlocks(text, id);
    await postMessage(token, dm, card.text, card.blocks);
  }

  private async onDraft(kind: "post" | "skip", id: string, by: string): Promise<void> {
    const text = this.drafts.get(id);
    this.drafts.delete(id);
    if (kind === "skip" || !text) return;
    await postMessage(this.cfg.v2.slack.botToken, this.cfg.v2.slack.reportChannel, text);
    this.log.info("v2 draft posted", { id, by });
  }

  // ─── deploy-guard error sources ──────────────────────────────────────────

  private errorSources(): ErrorSource[] {
    const sources: ErrorSource[] = [];
    const fl = this.cfg.firebaseLogs;
    if (fl.projectId) {
      const client = new GcloudFirebaseLogsClient(this.log);
      sources.push(async (sinceIso, untilIso) => {
        const hours = Math.ceil((Date.now() - Date.parse(sinceIso)) / 3_600_000) + 1;
        const entries = await client.fetchErrorLogs({ ...fl, lookbackHours: hours });
        const inWindow = entries.filter(e => e.timestamp && e.timestamp >= sinceIso && e.timestamp < untilIso);
        return new Map(groupErrors(inWindow).map(g => [`firebase:${g.functionName}:${g.signature}`, g.count]));
      });
    }
    const render = renderErrorSource(this.cfg, this.log);
    if (render) sources.push(render);
    return sources;
  }
}

// Filled in by v2-intake.ts (Render API client lives with the Render intake watcher).
import { renderErrorSource } from "./v2-intake.js";

function emptyReadout(): GovernorReadout {
  return { mode: "normal", maxConcurrent: 99, reasons: [], people: [], spendTodayUsd: 0, spendWeekUsd: 0, weeklyBudgetUsd: null };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
