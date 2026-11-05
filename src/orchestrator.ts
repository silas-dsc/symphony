import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Issue,
  WorkflowConfig,
  RunningEntry,
  OrchestratorState,
  AgentResult,
  Logger,
  StatusSnapshot,
  RateLimitSnapshot,
  RunningSnapshot,
  RetrySnapshot,
  PendingSlackNotification,
} from "./types.js";
import { loadWorkflow, validateConfig } from "./config.js";
import { GitHubPreviewWarmer, StaticUrlWarmer } from "./github-preview.js";
import { MergeConflictResolver } from "./merge-conflict.js";
import { DependabotWatcher } from "./dependabot.js";
import { QueryInsightsWatcher } from "./query-insights.js";
import { PostHogWatcher } from "./posthog.js";
import { UxInsightsWatcher } from "./ux-insights.js";
import { FirebaseLogsWatcher } from "./firebase-logs.js";
import * as linear from "./linear.js";
import { isCompletionState, sendBatchedSlackNotification } from "./notifications.js";
import { getWorkspacePath, removeWorkspace } from "./workspace.js";
import { runAgentAttempt, isAuthError, CLAUDE_LOGIN_INSTRUCTIONS } from "./agent.js";
import { claudeBlockedUntil } from "./llm.js";
import { runRetrospective } from "./retrospective.js";
import { commitAndPushLessons } from "./lessons-sync.js";
import { cleanupReworkComments } from "./rework-cleanup.js";
import { SymphonyV2 } from "./v2.js";
import { FailureBreaker, refreshAuthEnv, redactSecrets, type TripKind } from "./failure-breaker.js";
import { parse as parseDotenv } from "dotenv";
import { UsageBudget, parseBudgetConfig, probeUsage, tokenProcesses, type BudgetConfig } from "./usage-budget.js";

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

interface DerivedConfig {
  activeStatesLower: string[];
  terminalStatesLower: string[];
}

const SHUTDOWN_GRACE_MS = 30_000;
const RELOAD_DEBOUNCE_MS = 250;

export class Orchestrator {
  private workflowPath: string;
  private config: WorkflowConfig;
  private promptTemplate: string;
  private symphonyRoot: string;
  private derived: DerivedConfig;
  private state: OrchestratorState;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private slackBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private previewWarmer: GitHubPreviewWarmer | null = null;
  private staticWarmer: StaticUrlWarmer | null = null;
  private mergeConflictResolver: MergeConflictResolver | null = null;
  private dependabotWatcher: DependabotWatcher | null = null;
  private queryInsightsWatcher: QueryInsightsWatcher | null = null;
  private posthogWatcher: PostHogWatcher | null = null;
  private uxInsightsWatcher: UxInsightsWatcher | null = null;
  private firebaseLogsWatcher: FirebaseLogsWatcher | null = null;
  private v2: SymphonyV2 | null = null;
  /** Pauses dispatch when every run fails the same way (e.g. Claude auth). */
  private breaker = new FailureBreaker({ isAuthError });
  /** Hourly share of the Claude 5-hour limit; over it, token-using processes are suspended. */
  private budgetCfg: BudgetConfig;
  private budget: UsageBudget;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private nextUsageCheckAt = 0;
  private usageCheckRunning = false;
  private usageProbeUnavailableLogged = false;
  private log: Logger;

  constructor(workflowPath: string, logger: Logger) {
    this.workflowPath = workflowPath;
    this.log = logger;

    const workflow = loadWorkflow(workflowPath);
    this.config = workflow.config;
    this.promptTemplate = workflow.promptTemplate;
    this.symphonyRoot = workflow.symphonyRoot;
    this.derived = computeDerived(this.config);
    this.previewWarmer = this.createPreviewWarmer();
    this.staticWarmer = this.createStaticWarmer();
    this.mergeConflictResolver = this.createMergeConflictResolver();
    this.dependabotWatcher = this.createDependabotWatcher();
    this.queryInsightsWatcher = this.createQueryInsightsWatcher();
    this.posthogWatcher = this.createPostHogWatcher();
    this.uxInsightsWatcher = this.createUxInsightsWatcher();
    this.firebaseLogsWatcher = this.createFirebaseLogsWatcher();
    this.v2 = this.config.v2.enabled ? new SymphonyV2(this.config, this.symphonyRoot, this.log) : null;
    this.budgetCfg = parseBudgetConfig(this.config.v2.usageBudget ?? {});
    this.budget = new UsageBudget(this.budgetCfg.maxPerHour);

    this.state = {
      pollIntervalMs: this.config.polling.intervalMs,
      maxConcurrentAgents: this.config.agent.maxConcurrentAgents,
      running: new Map(),
      trackedIssues: new Map(),
      knownTerminalIssueIds: new Set(),
      claimed: new Set(),
      pickedUpPrLinked: new Set(),
      retryAttempts: new Map(),
      pendingSlackNotifications: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalSecondsRunning: 0,
      latestRateLimit: null,
      startedAt: new Date(),
      teamUrl: null,
    };

    // Restore any Slack notifications that were queued but never delivered
    // before the last shutdown/restart, so they aren't silently lost.
    this.loadPersistedPendingSlack();
  }

  async start(): Promise<void> {
    this.log.info("Symphony starting", { workflow: this.workflowPath });

    const validationError = validateConfig(this.config);
    if (validationError) {
      throw new Error(`Configuration error: ${validationError}`);
    }

    this.startFileWatch();
    await this.startupCleanup();
    await this.v2?.start();

    // Best-effort team URL lookup so the status UI can link out.
    linear.fetchTeamUrl(this.config.tracker)
      .then(url => { this.state.teamUrl = url; })
      .catch(() => { /* already swallowed inside fetchTeamUrl */ });

    this.scheduleTick(0);
    this.scheduleSlackBatch();
    // Own timer, not the tick: a tick can be stuck awaiting a suspended process.
    if (this.budgetCfg.enabled) {
      void this.checkUsageBudget();
      this.usageTimer = setInterval(() => void this.checkUsageBudget(), 60_000);
    }

    this.log.info("Symphony started", {
      project: this.config.tracker.projectSlug,
      poll_interval_ms: this.state.pollIntervalMs,
    });
  }

  /** Synchronous: stops timers, aborts running agents. Does NOT wait for them to settle. */
  stop(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.slackBatchTimer) {
      clearTimeout(this.slackBatchTimer);
      this.slackBatchTimer = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
    // Suspended processes can't handle SIGTERM; wake them so shutdown is clean.
    tokenProcesses.resume();
    this.v2?.stop();
    for (const entry of this.state.running.values()) {
      entry.abortController.abort();
    }
    for (const entry of this.state.retryAttempts.values()) {
      clearTimeout(entry.timer);
    }
    this.log.info("Symphony stopped");
  }

  /**
   * Graceful shutdown: stops timers, aborts agents, then awaits all in-flight
   * agent promises with a hard timeout. Resolves once everything is settled or
   * the timeout fires.
   */
  async shutdown(timeoutMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
    const pending = Array.from(this.state.running.values()).map(e => e.done);
    this.stop();

    // Drain any queued Slack notifications before exiting so a restart (e.g.
    // the self-updater) doesn't lose them. flushSlackBatch handles its own
    // errors and re-queues + persists on failure, so this won't throw; pass
    // reschedule:false since we're shutting the timers down.
    await this.flushSlackBatch({ reschedule: false });

    if (pending.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const settled = Promise.allSettled(pending).then(() => "settled" as const);

    const which = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (which === "timeout") {
      this.log.warn("Shutdown timed out waiting for agents", { pending: pending.length, timeout_ms: timeoutMs });
    }
  }

  /** Symphony v2 (gates, governor…) when enabled. */
  getV2(): SymphonyV2 | null {
    return this.v2;
  }

  getConfigSnapshot(): WorkflowConfig {
    return this.config;
  }

  getSnapshot(): StatusSnapshot {
    const now = Date.now();

    const running: RunningSnapshot[] = Array.from(this.state.running.values()).map(e => ({
      issue_id: e.issueId,
      issue_identifier: e.issueIdentifier,
      issue_title: e.issue.title,
      state: e.issue.state,
      pid: e.pid,
      session_id: e.sessionId,
      turn_count: e.turnCount,
      last_event: e.lastEvent,
      last_message: e.lastMessage,
      started_at: e.startedAt.toISOString(),
      age_seconds: (now - e.startedAt.getTime()) / 1000,
      last_event_at: e.lastEventAt?.toISOString() ?? null,
      tokens: { input_tokens: e.inputTokens, output_tokens: e.outputTokens, total_tokens: e.totalTokens },
    }));

    const retrying: RetrySnapshot[] = Array.from(this.state.retryAttempts.values()).map(e => ({
      issue_id: e.issueId,
      issue_identifier: e.identifier,
      attempt: e.attempt,
      due_at: new Date(e.dueAtMs).toISOString(),
      due_in_seconds: Math.max(0, (e.dueAtMs - now) / 1000),
      error: e.error,
    }));

    const activeSeconds = Array.from(this.state.running.values())
      .reduce((sum, e) => sum + (now - e.startedAt.getTime()) / 1000, 0);
    const totalSeconds = this.state.totalSecondsRunning + activeSeconds;
    const throughput = totalSeconds > 0 ? this.state.totalTokens / totalSeconds : 0;

    let rateLimit: RateLimitSnapshot | null = null;
    if (this.state.latestRateLimit) {
      const r = this.state.latestRateLimit;
      rateLimit = {
        status: r.status,
        rate_limit_type: r.rateLimitType,
        resets_at: r.resetsAt,
        resets_in_seconds: Math.max(0, r.resetsAt - Math.floor(now / 1000)),
        overage_status: r.overageStatus,
        is_using_overage: r.isUsingOverage,
        observed_at: r.observedAt.toISOString(),
      };
    }

    return {
      generated_at: new Date().toISOString(),
      process: {
        started_at: this.state.startedAt.toISOString(),
        uptime_seconds: (now - this.state.startedAt.getTime()) / 1000,
      },
      counts: {
        running: running.length,
        retrying: retrying.length,
        max_concurrent: this.state.maxConcurrentAgents,
      },
      project: {
        project_slug: this.config.tracker.projectSlug,
        team_key: this.config.tracker.teamKey ?? null,
        team_url: this.state.teamUrl,
      },
      totals: {
        input_tokens: this.state.totalInputTokens,
        output_tokens: this.state.totalOutputTokens,
        total_tokens: this.state.totalTokens,
        seconds_running: totalSeconds,
        throughput_tps: throughput,
      },
      rate_limit: rateLimit,
      dispatch_paused: this.breaker.status(),
      usage_budget: this.usageBudgetStatus(),
      running,
      retrying,
    };
  }

  // ─── File watch ────────────────────────────────────────────────────────────

  private startFileWatch(): void {
    try {
      // Debounce: editors often emit multiple events per save (vim writes the
      // file, IntelliJ does write-rename-replace, etc.), and a fast double-fire
      // would race the validate-then-swap below.
      this.watcher = fs.watch(this.workflowPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reloadWorkflow();
        }, RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on("error", (e) => {
        this.log.warn(`Workflow watcher error: ${fmtErr(e)}`);
      });
    } catch (e) {
      this.log.warn(`Failed to watch ${this.workflowPath}: ${fmtErr(e)}`);
    }
  }

  private reloadWorkflow(): void {
    let workflow;
    try {
      workflow = loadWorkflow(this.workflowPath);
    } catch (e) {
      this.log.error(`Failed to reload WORKFLOW.md, keeping last good config: ${fmtErr(e)}`);
      return;
    }

    const validationError = validateConfig(workflow.config);
    if (validationError) {
      this.log.error(`WORKFLOW.md reload rejected (invalid config), keeping last good: ${validationError}`);
      return;
    }

    this.config = workflow.config;
    this.promptTemplate = workflow.promptTemplate;
    this.symphonyRoot = workflow.symphonyRoot;
    this.derived = computeDerived(this.config);
    this.previewWarmer = this.createPreviewWarmer();
    this.staticWarmer = this.createStaticWarmer();
    this.mergeConflictResolver = this.createMergeConflictResolver();
    this.dependabotWatcher = this.createDependabotWatcher();
    this.queryInsightsWatcher = this.createQueryInsightsWatcher();
    this.posthogWatcher = this.createPostHogWatcher();
    this.uxInsightsWatcher = this.createUxInsightsWatcher();
    this.firebaseLogsWatcher = this.createFirebaseLogsWatcher();
    this.state.pollIntervalMs = this.config.polling.intervalMs;
    this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;
    this.log.info("WORKFLOW.md reloaded");
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────────

  private scheduleTick(delayMs: number): void {
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    await this.reconcile();

    if (tokenProcesses.isPaused()) {
      // Over the hourly usage budget: skip every step that can spawn Claude
      // (conflict resolver, insight watchers, v2 triage/intake, dispatch).
      this.scheduleTick(this.state.pollIntervalMs);
      return;
    }

    if (this.previewWarmer) {
      await this.previewWarmer.reconcile();
    }

    if (this.staticWarmer) {
      await this.staticWarmer.reconcile();
    }

    if (this.mergeConflictResolver) {
      await this.mergeConflictResolver.reconcile();
    }

    if (this.dependabotWatcher) {
      await this.dependabotWatcher.reconcile();
    }

    if (this.queryInsightsWatcher) {
      // Internally gated to run ~weekly; cheap no-op on every other tick.
      await this.queryInsightsWatcher.reconcile();
    }

    if (this.posthogWatcher) {
      // Internally gated to run ~daily; cheap no-op on every other tick.
      await this.posthogWatcher.reconcile();
    }

    if (this.uxInsightsWatcher) {
      // Internally gated to run ~weekly; cheap no-op on every other tick.
      await this.uxInsightsWatcher.reconcile();
    }

    if (this.firebaseLogsWatcher) {
      // Internally gated to run every few hours; cheap no-op on every other tick.
      await this.firebaseLogsWatcher.reconcile();
    }

    if (this.v2) {
      // Gates, review flow, deploy guard, triage/intake, reports, governor readout.
      await this.v2.reconcile(this.state.latestRateLimit);
    }

    const validationError = validateConfig(this.config);
    if (validationError) {
      this.log.error(`Config validation failed, skipping dispatch: ${validationError}`);
      this.scheduleTick(this.state.pollIntervalMs);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await linear.fetchCandidateIssues(this.config.tracker);
    } catch (e) {
      this.log.error(`Failed to fetch Linear issues: ${fmtErr(e)}`);
      this.scheduleTick(this.state.pollIntervalMs);
      return;
    }

    this.log.info(`Polled Linear`, {
      candidates: candidates.length,
      running: this.state.running.size,
      retrying: this.state.retryAttempts.size,
    });

    const activeIds = new Set(candidates.map(issue => issue.id));
    for (const issue of candidates) {
      const tracked = this.state.trackedIssues.get(issue.id);
      this.state.trackedIssues.set(issue.id, {
        issue,
        completionSummary: tracked?.completionSummary ?? null,
      });
      this.state.knownTerminalIssueIds.delete(issue.id);
    }

    await this.reconcileTrackedStates(activeIds);
    await this.reconcileTerminalIssues();
    this.backfillPickedUpPrLinks();

    if (this.breaker.readyForTrial()) this.refreshAuthFromDotenv();

    const sorted = this.sortForDispatch(candidates);
    for (const issue of sorted) {
      if (!this.hasSlots()) break;
      if (!this.shouldDispatch(issue)) continue;
      if (this.v2) {
        // Governor: held tickets show in /status (v2.governor); not logged every tick.
        if (!this.v2.allowDispatch(issue).ok) continue;
      }
      // Paused after systemic failures (shows in /status as dispatch_paused).
      if (!this.breaker.allowDispatch()) break;
      try {
        await cleanupReworkComments(issue, this.config.tracker, this.log);
      } catch (e) {
        this.log.warn(`Rework cleanup threw: ${fmtErr(e)}`, {
          issue_identifier: issue.identifier,
        });
      }
      this.dispatch(issue, null);
    }

    this.scheduleTick(this.state.pollIntervalMs);
  }

  // ─── Ticket workflow rules ─────────────────────────────────────────────────

  /** Rule 1: Copy original description when first picking up a ticket. Runs async. */
  private addPickedUpCommentAsync(issue: Issue): void {
    linear.hasPickedUpComment(this.config.tracker, issue.id)
      .then(hasComment => {
        if (!hasComment) {
          return linear.addPickedUpComment(this.config.tracker, issue.id);
        }
      })
      .catch(e => {
        this.log.warn(`Failed to add picked-up comment: ${fmtErr(e)}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
      });
  }

  /**
   * Rule 1 (cont.): backfill the PR link onto each running ticket's picked-up
   * comment once GitHub attaches the PR to the Linear issue. Runs async per tick;
   * once linked, the issue is skipped. Best-effort — failures are logged, not fatal.
   */
  private backfillPickedUpPrLinks(): void {
    // Bound the "done" set to currently-running issues so it can't grow forever.
    for (const id of this.state.pickedUpPrLinked) {
      if (!this.state.running.has(id)) this.state.pickedUpPrLinked.delete(id);
    }

    for (const entry of this.state.running.values()) {
      const issue = entry.issue;
      if (this.state.pickedUpPrLinked.has(issue.id)) continue;

      linear.backfillPickedUpPrLink(this.config.tracker, issue.id)
        .then(linked => {
          if (linked) this.state.pickedUpPrLinked.add(issue.id);
        })
        .catch(e => {
          this.log.warn(`Failed to backfill PR link on picked-up comment: ${fmtErr(e)}`, {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
          });
        });
    }
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Urgent tickets first (Linear priority 1, e.g. critical security fixes), then
   * the product roadmap's order, then everything else by priority and age.
   */
  private sortForDispatch(issues: Issue[]): Issue[] {
    const rank = (i: Issue) => this.v2?.roadmapRank(i.identifier, i.parentIdentifier) ?? Infinity;
    return [...issues].sort((a, b) => {
      const ua = a.priority === 1 ? 0 : 1;
      const ub = b.priority === 1 ? 0 : 1;
      if (ua !== ub) return ua - ub;
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const ta = a.createdAt?.getTime() ?? 0;
      const tb = b.createdAt?.getTime() ?? 0;
      if (ta !== tb) return ta - tb;
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const stateLower = issue.state.toLowerCase();

    if (!this.derived.activeStatesLower.includes(stateLower)) return false;
    if (this.derived.terminalStatesLower.includes(stateLower)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    const perStateCap = this.config.agent.maxConcurrentAgentsByState[stateLower];
    if (perStateCap !== undefined) {
      const runningInState = Array.from(this.state.running.values())
        .filter(e => e.issue.state.toLowerCase() === stateLower).length;
      if (runningInState >= perStateCap) return false;
    }

    if (stateLower === "todo") {
      const hasNonTerminalBlocker = issue.blockedBy.some(
        b => b.state && !this.derived.terminalStatesLower.includes(b.state.toLowerCase())
      );
      if (hasNonTerminalBlocker) return false;
    }

    return true;
  }

  private hasSlots(): boolean {
    const max = this.v2 ? this.v2.maxConcurrent(this.state.maxConcurrentAgents) : this.state.maxConcurrentAgents;
    return this.state.running.size < max;
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    const abortController = new AbortController();

    const config = this.config;
    const promptTemplate = this.promptTemplate;
    const symphonyRoot = this.symphonyRoot;
    const logger = this.log;

    // Rule 1: Copy original description when first picking up a ticket
    if (attempt === null) {
      this.addPickedUpCommentAsync(issue);
    }

    const done = runAgentAttempt(
      issue,
      attempt,
      config,
      promptTemplate,
      symphonyRoot,
      abortController,
      (event) => {
        const e = this.state.running.get(issue.id);
        if (!e) return;
        e.lastEvent = event.type;
        e.lastEventAt = new Date();
        if (event.message) e.lastMessage = event.message;
        if (event.message) {
          const tracked = this.state.trackedIssues.get(issue.id);
          if (tracked) tracked.completionSummary = event.message;
        }
        if (event.tokens) {
          e.inputTokens = event.tokens.input;
          e.outputTokens = event.tokens.output;
          e.totalTokens = event.tokens.total;
        }
        if (event.pid !== undefined) e.pid = event.pid;
        if (event.sessionId) e.sessionId = event.sessionId;
        if (event.rateLimit) {
          e.rateLimit = event.rateLimit;
          this.state.latestRateLimit = event.rateLimit;
        }
      },
      logger,
    )
      .then(result => this.handleWorkerExit(issue.id, result))
      .catch(e => {
        this.log.error(`Agent crashed for ${issue.identifier}: ${fmtErr(e)}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
        this.handleWorkerExit(issue.id, {
          success: false,
          error: fmtErr(e),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 0,
        });
      });

    const entry: RunningEntry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issue,
      startedAt: new Date(),
      pid: null,
      sessionId: null,
      lastEvent: null,
      lastEventAt: null,
      lastMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      retryAttempt: attempt,
      rateLimit: null,
      abortController,
      done,
    };

    const tracked = this.state.trackedIssues.get(issue.id);
    this.state.trackedIssues.set(issue.id, {
      issue,
      completionSummary: tracked?.completionSummary ?? null,
    });
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retryAttempts.delete(issue.id);

    this.log.info(`Dispatching agent`, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: attempt ?? 0,
    });
  }

  private handleWorkerExit(issueId: string, result: AgentResult): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const tracked = this.state.trackedIssues.get(issueId);
    if (tracked && result.completionSummary?.trim()) {
      tracked.completionSummary = result.completionSummary.trim();
    }

    const durationSeconds = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.totalSecondsRunning += durationSeconds;
    this.state.totalInputTokens += result.inputTokens;
    this.state.totalOutputTokens += result.outputTokens;
    this.state.totalTokens += result.totalTokens;
    this.state.running.delete(issueId);

    if (result.success) {
      if (this.breaker.recordSuccess()) {
        this.log.info("Agent runs succeeding again; dispatch resumed", { issue_identifier: entry.issueIdentifier });
        this.alertOperator(`✅ Symphony resumed: ${entry.issueIdentifier} ran successfully, so new work is starting again.`);
      }
      // Release the claim and let the next poll re-evaluate the issue. If it's
      // still in an active state, the next tick (≤ pollIntervalMs away) will
      // pick it up naturally — no separate "continuation retry" needed.
      this.state.claimed.delete(issueId);
      this.log.info(`Agent completed`, {
        issue_id: issueId,
        issue_identifier: entry.issueIdentifier,
        turn_count: result.turnCount,
        duration_s: durationSeconds.toFixed(1),
      });
    } else {
      const nextAttempt = (entry.retryAttempt ?? 0) + 1;
      // When Claude is blocked and no fallback provider worked, wait until Claude
      // becomes available again rather than spinning through max-backoff retries.
      const claudeBlockMs = claudeBlockedUntil();
      const delay = claudeBlockMs > Date.now() && result.error?.startsWith("claude_blocked")
        ? Math.min(claudeBlockMs - Date.now() + 5_000, this.config.agent.maxRetryBackoffMs)
        : Math.min(10000 * Math.pow(2, nextAttempt - 1), this.config.agent.maxRetryBackoffMs);
      this.log.warn(`Agent failed, retrying in ${(delay / 1000).toFixed(0)}s`, {
        issue_id: issueId,
        issue_identifier: entry.issueIdentifier,
        error: result.error ?? "unknown",
        next_attempt: nextAttempt,
      });
      // Surface re-login instructions on auth failures — retries are futile
      // until the operator re-authenticates the spawned `claude` CLI.
      if (isAuthError(result.error ?? "")) {
        this.log.error(CLAUDE_LOGIN_INSTRUCTIONS, {
          issue_id: issueId,
          issue_identifier: entry.issueIdentifier,
        });
      }
      const outcome = this.breaker.recordFailure(entry.issueIdentifier, result.error ?? "unknown");
      if (outcome.justTripped) this.onBreakerTripped();
      this.scheduleRetry(issueId, entry.issueIdentifier, nextAttempt, result.error ?? null, delay);
    }
  }

  /**
   * Every `check_minutes` (and when a pause is due to end): read the account's
   * 5-hour usage, and suspend or resume every token-using process to keep the
   * trailing hour under `max_share_per_hour` of the 5-hour limit.
   */
  private async checkUsageBudget(now = Date.now()): Promise<void> {
    if (!this.budgetCfg.enabled || this.usageCheckRunning || now < this.nextUsageCheckAt) return;
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) {
      if (!this.usageProbeUnavailableLogged) {
        this.log.warn("Usage budget off: needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) to read Claude usage");
        this.usageProbeUnavailableLogged = true;
      }
      this.nextUsageCheckAt = now + this.budgetCfg.checkMs;
      return;
    }
    this.usageCheckRunning = true;
    try {
      const sample = await probeUsage(token).catch(e => {
        this.log.warn(`Usage check failed: ${fmtErr(e)}`);
        return null;
      });
      if (!sample) {
        // Keep the current state; try again next interval (or in 5 min while paused).
        this.nextUsageCheckAt = now + (tokenProcesses.isPaused() ? 5 * 60_000 : this.budgetCfg.checkMs);
        return;
      }
      this.budget.record(sample);
      const resumeAt = this.budget.resumeAt(sample.at);
      const spent = this.budget.spentLastHour(sample.at);
      if (resumeAt) {
        const first = !tokenProcesses.isPaused();
        const suspended = tokenProcesses.pause(resumeAt);
        this.nextUsageCheckAt = resumeAt;
        if (first) {
          this.log.warn("Usage budget exceeded: pausing token-using processes", {
            spent_last_hour: pct(spent), budget: pct(this.budgetCfg.maxPerHour), five_hour: pct(sample.fiveHour),
            suspended, resume_at: new Date(resumeAt).toISOString(),
          });
          this.alertOperator(
            `⏸️ Symphony paused: ${pct(spent)} of the 5-hour Claude limit was used in the last hour (budget ${pct(this.budgetCfg.maxPerHour)}, all your Claude use counts). ` +
            `5-hour window is at ${pct(sample.fiveHour)}. ${suspended.length} running process(es) suspended, nothing new will start. ` +
            `Expected to resume around ${clock(resumeAt)}.`,
          );
        }
      } else {
        this.nextUsageCheckAt = now + this.budgetCfg.checkMs;
        if (tokenProcesses.isPaused()) {
          const resumed = tokenProcesses.resume();
          // Suspended agents were silent; don't let the stall detector kill them now.
          for (const e of this.state.running.values()) e.lastEventAt = new Date();
          this.log.info("Usage back under budget: resuming", { resumed, spent_last_hour: pct(spent), five_hour: pct(sample.fiveHour) });
          this.alertOperator(`▶️ Symphony resumed: last-hour Claude use is ${pct(spent)} (budget ${pct(this.budgetCfg.maxPerHour)}); 5-hour window at ${pct(sample.fiveHour)}.`);
          this.scheduleTick(0);
        }
      }
    } finally {
      this.usageCheckRunning = false;
    }
  }

  private usageBudgetStatus(): Record<string, unknown> | null {
    if (!this.budgetCfg.enabled) return null;
    const latest = this.budget.latest();
    const pausedUntil = tokenProcesses.pausedUntil();
    return {
      max_share_per_hour: this.budgetCfg.maxPerHour,
      spent_last_hour: latest ? Number(this.budget.spentLastHour(Date.now()).toFixed(3)) : null,
      five_hour: latest?.fiveHour ?? null,
      five_hour_resets_at: latest ? new Date(latest.fiveHourResetsAt * 1000).toISOString() : null,
      seven_day: latest?.sevenDay ?? null,
      checked_at: latest ? new Date(latest.at).toISOString() : null,
      paused_until: pausedUntil ? new Date(pausedUntil).toISOString() : null,
      token_processes: tokenProcesses.count(),
    };
  }

  private onBreakerTripped(): void {
    const status = this.breaker.status();
    if (!status) return;
    const minutes = Math.round((Date.parse(status.next_trial_at ?? "") - Date.now()) / 60_000);
    this.log.error("Dispatch paused: agent runs are failing systemically", { kind: status.kind, reason: status.reason });
    this.alertOperator(breakerAlertText(status.kind, status.reason, Number.isFinite(minutes) ? minutes : 10));
  }

  /** Best-effort Slack DM to the v2 operator; always logged. */
  private alertOperator(text: string): void {
    const safe = redactSecrets(text);
    if (!this.v2) {
      this.log.warn("Operator alert (no v2 Slack configured)", { text: safe });
      return;
    }
    this.v2.notifyOperator(safe)
      .then(sent => { if (!sent) this.log.warn("Operator alert (no Slack DM configured)", { text: safe }); })
      .catch(e => this.log.warn(`Operator alert failed to send: ${fmtErr(e)}`, { text: safe }));
  }

  /** Pick up credentials fixed in .env since startup (dotenv only loads it once). Logs key names, never values. */
  private refreshAuthFromDotenv(): void {
    try {
      const envPath = path.resolve(process.cwd(), ".env");
      if (!fs.existsSync(envPath)) return;
      const changed = refreshAuthEnv(parseDotenv(fs.readFileSync(envPath)));
      if (changed.length > 0) this.log.info("Reloaded Claude credentials from .env", { keys: changed });
    } catch (e) {
      this.log.warn(`Could not re-read .env: ${fmtErr(e)}`);
    }
  }

  private async reconcileTrackedStates(activeIds: Set<string>): Promise<void> {
    const idsToRefresh = Array.from(this.state.trackedIssues.keys()).filter(
      id => !activeIds.has(id) && !this.state.running.has(id)
    );
    if (idsToRefresh.length === 0) return;

    let refreshed: Array<{ id: string; identifier: string; state: string }>;
    try {
      refreshed = await linear.fetchIssueStatesByIds(this.config.tracker, idsToRefresh);
    } catch (e) {
      this.log.error(`Tracked issue refresh failed: ${fmtErr(e)}`);
      return;
    }

    for (const { id, state } of refreshed) {
      const tracked = this.state.trackedIssues.get(id);
      if (!tracked) continue;

      const stateLower = state.toLowerCase();
      if (this.derived.terminalStatesLower.includes(stateLower)) {
        await this.handleTerminalIssue(id, tracked.issue, state, tracked.completionSummary, false);
      } else if (!this.derived.activeStatesLower.includes(stateLower)) {
        this.clearRetry(id);
        this.state.claimed.delete(id);
        this.state.trackedIssues.delete(id);
      } else {
        tracked.issue = { ...tracked.issue, state };
      }
    }
  }

  private clearRetry(issueId: string): void {
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;
    clearTimeout(retryEntry.timer);
    this.state.retryAttempts.delete(issueId);
  }

  private async reconcileTerminalIssues(): Promise<void> {
    let terminalIssues: Array<{ id: string; identifier: string }>;
    try {
      terminalIssues = await linear.fetchIssuesByStates(
        this.config.tracker,
        this.config.tracker.terminalStates,
      );
    } catch (e) {
      this.log.error(`Terminal issue refresh failed: ${fmtErr(e)}`);
      return;
    }

    const currentTerminalIds = new Set(terminalIssues.map(issue => issue.id));
    const newTerminalIds = terminalIssues
      .filter(issue => !this.state.knownTerminalIssueIds.has(issue.id))
      .map(issue => issue.id);

    for (const issueId of newTerminalIds) {
      if (this.state.running.has(issueId) || this.state.trackedIssues.has(issueId)) continue;
      let [issue] = [] as Issue[];
      try {
        [issue] = await linear.fetchIssuesByIds(this.config.tracker, [issueId]);
      } catch (e) {
        this.log.warn(`Terminal issue detail fetch failed: ${fmtErr(e)}`, { issue_id: issueId });
        continue;
      }
      if (!issue) continue;
      await this.handleTerminalIssue(issue.id, issue, issue.state, null, false);
      currentTerminalIds.add(issue.id);
    }

    this.state.knownTerminalIssueIds = currentTerminalIds;
  }

  private async handleTerminalIssue(
    issueId: string,
    issue: Issue,
    state: string,
    completionSummary: string | null,
    abortRunningEntry: boolean,
  ): Promise<void> {
    this.log.info(`Issue reached terminal state, stopping agent`, {
      issue_id: issueId,
      issue_identifier: issue.identifier,
      state,
    });

    if (abortRunningEntry) {
      const runningEntry = this.state.running.get(issueId);
      runningEntry?.abortController.abort();
      this.state.running.delete(issueId);
    }

    this.state.knownTerminalIssueIds.add(issueId);
    this.clearRetry(issueId);
    this.state.claimed.delete(issueId);
    this.state.trackedIssues.delete(issueId);

    if (this.config.notifications.slack?.completionFeed && issue.url && isCompletionState(state)) {
      try {
        const alreadySent = await linear.hasSlackNotificationComment(this.config.tracker, issueId);
        if (alreadySent) {
          this.log.info("Skipping duplicate Slack completion notification", {
            issue_id: issueId,
            issue_identifier: issue.identifier,
            state,
          });
        } else {
          this.state.pendingSlackNotifications.push({ issueId, issue, state, completionSummary });
          this.persistPendingSlack();
          this.log.info("Queued Slack completion notification", {
            issue_id: issueId,
            issue_identifier: issue.identifier,
            state,
          });
        }
      } catch (e) {
        this.log.warn(`Slack notification check failed: ${fmtErr(e)}`, {
          issue_id: issueId,
          issue_identifier: issue.identifier,
          state,
        });
      }
    }

    void this.retrospectThenCleanup(issue, state);
  }

  /**
   * Best-effort retrospective sub-agent → workspace cleanup. Runs in the
   * background so it doesn't block the orchestrator tick loop. Sequenced so
   * the workspace exists while the retrospective runs and is removed after.
   */
  private async retrospectThenCleanup(issue: Issue, state: string): Promise<void> {
    const retro = this.config.retrospective;
    const triggerStatesLower = retro.triggerStates.map(s => s.toLowerCase());
    const shouldRetrospect = retro.enabled && triggerStatesLower.includes(state.toLowerCase());

    if (shouldRetrospect) {
      try {
        await runRetrospective({
          issue,
          terminalState: state,
          workspacePath: getWorkspacePath(this.config.workspace.root, issue.identifier),
          symphonyRoot: this.symphonyRoot,
          config: retro,
          mcpConfigPath: resolveAgentMcpConfigPath(this.symphonyRoot),
          logger: this.log,
        });
      } catch (e) {
        this.log.warn(`Retrospective threw: ${fmtErr(e)}`, {
          issue_identifier: issue.identifier,
        });
      }

      // Commit + push the appended lesson so it reaches the remote and the
      // working tree stays clean for self-update. Runs even if the retrospective
      // above threw — a partial append still wants committing, and a no-op
      // commit is harmless. Reuses the auto-update remote/branch/repo.
      if (retro.commitLessons) {
        try {
          const res = await commitAndPushLessons({
            repoRoot: this.config.autoUpdate.repoRoot ?? this.symphonyRoot,
            lessonsPath: retro.lessonsPath,
            branch: this.config.autoUpdate.branch ?? "",
            remote: this.config.autoUpdate.remote,
            issueIdentifier: issue.identifier,
            logger: this.log,
          });
          if (res.committed && !res.pushed) {
            this.log.warn("Lesson committed but not pushed", {
              issue_identifier: issue.identifier,
              reason: res.reason,
            });
          }
        } catch (e) {
          this.log.warn(`Lessons sync threw: ${fmtErr(e)}`, {
            issue_identifier: issue.identifier,
          });
        }
      }
    }

    try {
      await removeWorkspace(
        this.config.workspace.root,
        issue.identifier,
        this.config.hooks.beforeRemove,
        this.config.hooks.timeoutMs,
        this.log,
      );
    } catch (e) {
      this.log.warn(`Workspace cleanup failed: ${fmtErr(e)}`);
    }
  }

  // ─── Slack batch ───────────────────────────────────────────────────────────

  private scheduleSlackBatch(): void {
    this.slackBatchTimer = setTimeout(() => void this.flushSlackBatch(), 15 * 60 * 1000);
  }

  private async flushSlackBatch(opts: { reschedule?: boolean } = {}): Promise<void> {
    const reschedule = opts.reschedule ?? true;
    this.slackBatchTimer = null;

    const slack = this.config.notifications.slack;
    if (!slack || !slack.completionFeed) {
      if (reschedule) this.scheduleSlackBatch();
      return;
    }

    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const pending = this.state.pendingSlackNotifications;
    this.state.pendingSlackNotifications = [];

    const items = pending.filter(n =>
      !n.issue.updatedAt || n.issue.updatedAt.getTime() > twentyFourHoursAgo
    );

    this.log.info("Flushing Slack batch", {
      queued: pending.length,
      after_filter: items.length,
      dropped: pending.length - items.length,
    });

    if (items.length > 0) {
      try {
        await sendBatchedSlackNotification(items, slack, this.log);
        for (const item of items) {
          await linear.addSlackNotificationComment(this.config.tracker, item.issueId).catch(e =>
            this.log.warn(`Failed to mark Slack notification comment: ${fmtErr(e)}`, { issue_id: item.issueId })
          );
        }
      } catch (e) {
        // Re-queue the failed batch (in front of anything queued during the
        // send) so the next flush retries instead of silently dropping it.
        // The 24h filter above still expires anything genuinely stale.
        this.state.pendingSlackNotifications.unshift(...items);
        this.log.warn(`Batched Slack notification failed, re-queued ${items.length} for retry: ${fmtErr(e)}`);
      }
    }

    // Persist whatever remains queued (empty on success, the failed batch on
    // failure) so a restart before the next flush doesn't lose it.
    this.persistPendingSlack();

    if (reschedule) this.scheduleSlackBatch();
  }

  private slackQueuePath(): string {
    return path.join(this.symphonyRoot, ".symphony-slack-queue.json");
  }

  /** Persist the pending Slack queue to disk (best-effort). */
  private persistPendingSlack(): void {
    try {
      fs.writeFileSync(
        this.slackQueuePath(),
        JSON.stringify(this.state.pendingSlackNotifications),
        "utf-8",
      );
    } catch (e) {
      this.log.warn(`Failed to persist Slack queue: ${fmtErr(e)}`);
    }
  }

  /** Reload a persisted Slack queue on startup, reviving serialized Date fields. */
  private loadPersistedPendingSlack(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.slackQueuePath(), "utf-8");
    } catch {
      return; // No queue file yet — nothing to restore.
    }
    try {
      const parsed = JSON.parse(raw) as PendingSlackNotification[];
      for (const n of parsed) {
        const updatedAt = (n.issue as { updatedAt?: unknown }).updatedAt;
        if (typeof updatedAt === "string") {
          (n.issue as { updatedAt?: Date }).updatedAt = new Date(updatedAt);
        }
      }
      this.state.pendingSlackNotifications = parsed;
      if (parsed.length > 0) {
        this.log.info("Restored pending Slack notifications from disk", {
          count: parsed.length,
          identifiers: parsed.map(n => n.issue.identifier).join(", "),
        });
      }
    } catch (e) {
      this.log.warn(`Failed to parse persisted Slack queue, ignoring: ${fmtErr(e)}`);
    }
  }

  // ─── Retry queue ───────────────────────────────────────────────────────────

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error: string | null,
    delayMs: number
  ): void {
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => void this.onRetryTimer(issueId), delayMs);

    this.state.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt,
      dueAtMs: Date.now() + delayMs,
      error,
      timer,
    });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;
    this.state.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await linear.fetchCandidateIssues(this.config.tracker);
    } catch (e) {
      this.log.error(`Retry poll failed for ${retryEntry.identifier}: ${fmtErr(e)}`);
      this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, "retry poll failed", 30000);
      return;
    }

    const issue = candidates.find(c => c.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      this.log.info(`Releasing claim: issue no longer active`, { issue_identifier: retryEntry.identifier });
      return;
    }

    // An agent that asked a human (waiting-on label) must not be retried until answered.
    if (this.v2 && !this.v2.allowDispatch(issue).ok) {
      this.state.claimed.delete(issueId);
      return;
    }

    if (!this.hasSlots()) {
      this.scheduleRetry(
        issueId,
        retryEntry.identifier,
        retryEntry.attempt + 1,
        "no available orchestrator slots",
        30000
      );
      return;
    }

    // Paused: wait without burning an attempt; the half-open trial will decide.
    if (this.breaker.readyForTrial()) this.refreshAuthFromDotenv();
    if (tokenProcesses.isPaused() || !this.breaker.allowDispatch()) {
      this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt, retryEntry.error, 60_000);
      return;
    }

    this.dispatch(issue, retryEntry.attempt);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    this.reconcileStalled();
    await this.reconcileRunningStates();
  }

  private reconcileStalled(): void {
    // Suspended agents emit nothing; that's the budget pause, not a stall.
    if (tokenProcesses.isPaused()) return;
    const stallMs = this.config.agent.stallTimeoutMs;
    const now = Date.now();

    for (const [issueId, entry] of this.state.running) {
      const lastActivity = entry.lastEventAt ?? entry.startedAt;
      if (now - lastActivity.getTime() > stallMs) {
        this.log.warn(`Stalled agent, terminating`, {
          issue_id: issueId,
          issue_identifier: entry.issueIdentifier,
          stall_seconds: ((now - lastActivity.getTime()) / 1000).toFixed(0),
        });
        entry.abortController.abort();
      }
    }
  }

  private async reconcileRunningStates(): Promise<void> {
    const runningIds = Array.from(this.state.running.keys());
    if (runningIds.length === 0) return;

    let refreshed: Array<{ id: string; identifier: string; state: string }>;
    try {
      refreshed = await linear.fetchIssueStatesByIds(this.config.tracker, runningIds);
    } catch (e) {
      this.log.error(`State refresh failed, keeping workers running: ${fmtErr(e)}`);
      return;
    }

    for (const { id, state } of refreshed) {
      const entry = this.state.running.get(id);
      if (!entry) continue;

      const stateLower = state.toLowerCase();
      if (this.derived.terminalStatesLower.includes(stateLower)) {
        const tracked = this.state.trackedIssues.get(id);
        await this.handleTerminalIssue(
          id,
          tracked?.issue ?? entry.issue,
          state,
          tracked?.completionSummary ?? entry.lastMessage,
          true,
        );
      } else if (!this.derived.activeStatesLower.includes(stateLower)) {
        this.log.info(`Issue moved to non-active state, stopping agent`, {
          issue_id: id,
          issue_identifier: entry.issueIdentifier,
          state,
        });
        entry.abortController.abort();
        this.state.running.delete(id);
        this.state.claimed.delete(id);
        this.state.trackedIssues.delete(id);
      } else {
        entry.issue = { ...entry.issue, state };
        const tracked = this.state.trackedIssues.get(id);
        if (tracked) tracked.issue = { ...tracked.issue, state };
      }
    }
  }

  // ─── Startup cleanup ───────────────────────────────────────────────────────

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await linear.fetchIssuesByStates(
        this.config.tracker,
        this.config.tracker.terminalStates
      );

      let cleaned = 0;
      for (const issue of terminalIssues) {
        await removeWorkspace(
          this.config.workspace.root,
          issue.identifier,
          this.config.hooks.beforeRemove,
          this.config.hooks.timeoutMs,
          this.log,
        );
        cleaned++;
      }

      if (cleaned > 0) {
        this.log.info(`Startup cleanup: removed ${cleaned} stale workspaces`);
      }
    } catch (e) {
      this.log.warn(`Startup cleanup failed (non-fatal): ${fmtErr(e)}`);
    }
  }

  private createPreviewWarmer(): GitHubPreviewWarmer | null {
    if (!this.config.githubPreview.enabled) return null;
    return new GitHubPreviewWarmer({
      config: this.config.githubPreview,
      logger: this.log,
    });
  }

  private createStaticWarmer(): StaticUrlWarmer | null {
    if (this.config.keepAlive.urls.length === 0) return null;
    return new StaticUrlWarmer(this.config.keepAlive, this.log);
  }

  private createMergeConflictResolver(): MergeConflictResolver | null {
    if (!this.config.mergeConflicts.enabled) return null;
    return new MergeConflictResolver({
      config: this.config.mergeConflicts,
      workspaceRoot: this.config.workspace.root,
      hooks: this.config.hooks,
      symphonyRoot: this.symphonyRoot,
      mcpConfigPath: resolveAgentMcpConfigPath(this.symphonyRoot),
      logger: this.log,
      // Skip PRs whose ticket is still in an active state — the owning agent
      // resolves those, so the resolver never races the dispatch loop.
      getActiveBranchKeys: async () => {
        const issues = await linear.fetchCandidateIssues(this.config.tracker);
        return new Set(issues.map(i => i.identifier.toLowerCase()));
      },
    });
  }

  private createDependabotWatcher(): DependabotWatcher | null {
    if (!this.config.dependabot.enabled) return null;
    return new DependabotWatcher({
      config: this.config.dependabot,
      tracker: this.config.tracker,
      logger: this.log,
    });
  }

  private createQueryInsightsWatcher(): QueryInsightsWatcher | null {
    if (!this.config.queryInsights.enabled) return null;
    return new QueryInsightsWatcher({
      config: this.config.queryInsights,
      tracker: this.config.tracker,
      logger: this.log,
    });
  }

  private createPostHogWatcher(): PostHogWatcher | null {
    if (!this.config.posthog.enabled) return null;
    return new PostHogWatcher({
      config: this.config.posthog,
      tracker: this.config.tracker,
      logger: this.log,
    });
  }

  private createUxInsightsWatcher(): UxInsightsWatcher | null {
    if (!this.config.uxInsights.enabled) return null;
    return new UxInsightsWatcher({
      config: this.config.uxInsights,
      tracker: this.config.tracker,
      logger: this.log,
    });
  }

  private createFirebaseLogsWatcher(): FirebaseLogsWatcher | null {
    if (!this.config.firebaseLogs.enabled) return null;
    return new FirebaseLogsWatcher({
      config: this.config.firebaseLogs,
      tracker: this.config.tracker,
      logger: this.log,
    });
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

export function breakerAlertText(kind: TripKind, reason: string, minutesToTrial: number): string {
  const fix = kind === "auth"
    ? "Fix: put a working CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY in Symphony's .env. " +
      "No restart needed: Symphony re-reads them before the next trial run."
    : "Check the Symphony terminal for the cause. Retries are held, not lost.";
  return [
    `⏸️ Symphony paused new work: every agent run is failing with the same error.`,
    `> ${reason}`,
    fix,
    `It will try one ticket again in ~${Math.max(1, minutesToTrial)} min and resume by itself once that succeeds. You'll get one message when it does.`,
  ].join("\n");
}

function computeDerived(config: WorkflowConfig): DerivedConfig {
  return {
    activeStatesLower: config.tracker.activeStates.map(s => s.toLowerCase()),
    terminalStatesLower: config.tracker.terminalStates.map(s => s.toLowerCase()),
  };
}

/**
 * Resolve the agent-shared MCP config path. Mirrors agent.ts's
 * resolveAgentMcpConfig — kept private there because it's an implementation
 * detail of the agent module; duplicated here (small, stable shape) so the
 * retrospective can share the same MCP server set without us re-exporting.
 */
function resolveAgentMcpConfigPath(symphonyRoot: string): string | undefined {
  const explicit = process.env.SYMPHONY_AGENT_MCP_CONFIG;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const defaultPath = path.join(symphonyRoot, "agent-mcp.json");
  return fs.existsSync(defaultPath) ? defaultPath : undefined;
}
