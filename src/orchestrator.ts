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
} from "./types.js";
import { loadWorkflow, validateConfig } from "./config.js";
import { GitHubPreviewWarmer, StaticUrlWarmer } from "./github-preview.js";
import { MergeConflictResolver } from "./merge-conflict.js";
import { DependabotWatcher } from "./dependabot.js";
import * as linear from "./linear.js";
import { isCompletionState, sendBatchedSlackNotification } from "./notifications.js";
import { getWorkspacePath, removeWorkspace } from "./workspace.js";
import { runAgentAttempt } from "./agent.js";
import { claudeBlockedUntil } from "./llm.js";
import { runRetrospective } from "./retrospective.js";
import { commitAndPushLessons } from "./lessons-sync.js";
import { cleanupReworkComments } from "./rework-cleanup.js";

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

    this.state = {
      pollIntervalMs: this.config.polling.intervalMs,
      maxConcurrentAgents: this.config.agent.maxConcurrentAgents,
      running: new Map(),
      trackedIssues: new Map(),
      knownTerminalIssueIds: new Set(),
      claimed: new Set(),
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
  }

  async start(): Promise<void> {
    this.log.info("Symphony starting", { workflow: this.workflowPath });

    const validationError = validateConfig(this.config);
    if (validationError) {
      throw new Error(`Configuration error: ${validationError}`);
    }

    this.startFileWatch();
    await this.startupCleanup();

    // Best-effort team URL lookup so the status UI can link out.
    linear.fetchTeamUrl(this.config.tracker)
      .then(url => { this.state.teamUrl = url; })
      .catch(() => { /* already swallowed inside fetchTeamUrl */ });

    this.scheduleTick(0);
    this.scheduleSlackBatch();

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

    const sorted = this.sortForDispatch(candidates);
    for (const issue of sorted) {
      if (!this.hasSlots()) break;
      if (!this.shouldDispatch(issue)) continue;
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
          return linear.addPickedUpComment(this.config.tracker, issue.id, issue.description ?? "");
        }
      })
      .catch(e => {
        this.log.warn(`Failed to add picked-up comment: ${fmtErr(e)}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
      });
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────────

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
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
    return this.state.running.size < this.state.maxConcurrentAgents;
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
      this.scheduleRetry(issueId, entry.issueIdentifier, nextAttempt, result.error ?? null, delay);
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

    if (this.config.notifications.slack && issue.url && isCompletionState(state)) {
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

  private async flushSlackBatch(): Promise<void> {
    this.slackBatchTimer = null;

    const slack = this.config.notifications.slack;
    if (!slack) {
      this.scheduleSlackBatch();
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
        this.log.warn(`Batched Slack notification failed: ${fmtErr(e)}`);
      }
    }

    this.scheduleSlackBatch();
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

    this.dispatch(issue, retryEntry.attempt);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    this.reconcileStalled();
    await this.reconcileRunningStates();
  }

  private reconcileStalled(): void {
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
