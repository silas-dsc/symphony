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
    };
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
