import * as fs from "node:fs";
import type {
  Issue,
  WorkflowConfig,
  RunningEntry,
  RetryEntry,
  OrchestratorState,
  AgentResult,
  Logger,
} from "./types.js";
import { loadWorkflow, validateConfig } from "./config.js";
import * as linear from "./linear.js";
import { removeWorkspace } from "./workspace.js";
import { runAgentAttempt } from "./agent.js";

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export class Orchestrator {
  private workflowPath: string;
  private config: WorkflowConfig;
  private promptTemplate: string;
  private state: OrchestratorState;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private log: Logger;

  constructor(workflowPath: string, logger: Logger) {
    this.workflowPath = workflowPath;
    this.log = logger;

    const workflow = loadWorkflow(workflowPath);
    this.config = workflow.config;
    this.promptTemplate = workflow.promptTemplate;

    this.state = {
      pollIntervalMs: this.config.polling.intervalMs,
      maxConcurrentAgents: this.config.agent.maxConcurrentAgents,
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalSecondsRunning: 0,
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
    this.scheduleTick(0);

    this.log.info("Symphony started", {
      project: this.config.tracker.projectSlug,
      poll_interval_ms: String(this.state.pollIntervalMs),
    });
  }

  stop(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
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

  getSnapshot() {
    const now = Date.now();
    const running = Array.from(this.state.running.values()).map(e => ({
      issue_id: e.issueId,
      issue_identifier: e.issueIdentifier,
      state: e.issue.state,
      session_id: e.sessionId,
      turn_count: e.turnCount,
      last_event: e.lastEvent,
      last_message: e.lastMessage,
      started_at: e.startedAt.toISOString(),
      last_event_at: e.lastEventAt?.toISOString() ?? null,
      tokens: { input_tokens: e.inputTokens, output_tokens: e.outputTokens, total_tokens: e.totalTokens },
    }));

    const retrying = Array.from(this.state.retryAttempts.values()).map(e => ({
      issue_id: e.issueId,
      issue_identifier: e.identifier,
      attempt: e.attempt,
      due_at: new Date(e.dueAtMs).toISOString(),
      error: e.error,
    }));

    const activeSeconds = Array.from(this.state.running.values())
      .reduce((sum, e) => sum + (now - e.startedAt.getTime()) / 1000, 0);

    return {
      generated_at: new Date().toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.state.totalInputTokens,
        output_tokens: this.state.totalOutputTokens,
        total_tokens: this.state.totalTokens,
        seconds_running: this.state.totalSecondsRunning + activeSeconds,
      },
    };
  }

  // ─── File watch ────────────────────────────────────────────────────────────

  private startFileWatch(): void {
    try {
      this.watcher = fs.watch(this.workflowPath, () => this.reloadWorkflow());
    } catch (e) {
      this.log.warn(`Failed to watch ${this.workflowPath}: ${e}`);
    }
  }

  private reloadWorkflow(): void {
    try {
      const workflow = loadWorkflow(this.workflowPath);
      this.config = workflow.config;
      this.promptTemplate = workflow.promptTemplate;
      this.state.pollIntervalMs = this.config.polling.intervalMs;
      this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;
      this.log.info("WORKFLOW.md reloaded");
    } catch (e) {
      this.log.error(`Failed to reload WORKFLOW.md, keeping last good config: ${e}`);
    }
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────────

  private scheduleTick(delayMs: number): void {
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    await this.reconcile();

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
      candidates: String(candidates.length),
      running: String(this.state.running.size),
      retrying: String(this.state.retryAttempts.size),
    });

    const sorted = this.sortForDispatch(candidates);
    for (const issue of sorted) {
      if (!this.hasSlots()) break;
      if (this.shouldDispatch(issue)) {
        this.dispatch(issue, null);
      }
    }

    this.scheduleTick(this.state.pollIntervalMs);
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
    const activeLower = this.config.tracker.activeStates.map(s => s.toLowerCase());
    const terminalLower = this.config.tracker.terminalStates.map(s => s.toLowerCase());

    if (!activeLower.includes(stateLower)) return false;
    if (terminalLower.includes(stateLower)) return false;
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
        b => b.state && !terminalLower.includes(b.state.toLowerCase())
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

    const entry: RunningEntry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issue,
      startedAt: new Date(),
      sessionId: null,
      lastEvent: null,
      lastEventAt: null,
      lastMessage: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
      retryAttempt: attempt,
      abortController,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retryAttempts.delete(issue.id);

    this.log.info(`Dispatching agent`, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: String(attempt ?? 0),
    });

    const config = this.config;
    const promptTemplate = this.promptTemplate;

    runAgentAttempt(
      issue,
      attempt,
      config,
      promptTemplate,
      abortController,
      (type, message, tokens) => {
        const e = this.state.running.get(issue.id);
        if (!e) return;
        e.lastEvent = type;
        e.lastEventAt = new Date();
        if (message) e.lastMessage = message;
        if (tokens) {
          e.inputTokens = tokens.input;
          e.outputTokens = tokens.output;
          e.totalTokens = tokens.total;
        }
      }
    )
      .then(result => this.handleWorkerExit(issue.id, result))
      .catch(e => {
        this.log.error(`Agent crashed for ${issue.identifier}: ${String(e)}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
        this.handleWorkerExit(issue.id, {
          success: false,
          error: String(e),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 0,
        });
      });
  }

  private handleWorkerExit(issueId: string, result: AgentResult): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const durationSeconds = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.totalSecondsRunning += durationSeconds;
    this.state.totalInputTokens += result.inputTokens;
    this.state.totalOutputTokens += result.outputTokens;
    this.state.totalTokens += result.totalTokens;
    this.state.running.delete(issueId);

    if (result.success) {
      this.state.completed.add(issueId);
      this.log.info(`Agent completed`, {
        issue_id: issueId,
        issue_identifier: entry.issueIdentifier,
        turn_count: String(result.turnCount),
        duration_s: durationSeconds.toFixed(1),
      });
      // Short continuation retry — re-check if issue still needs work
      this.scheduleRetry(issueId, entry.issueIdentifier, 1, null, 1000);
    } else {
      const nextAttempt = (entry.retryAttempt ?? 0) + 1;
      const delay = Math.min(
        10000 * Math.pow(2, nextAttempt - 1),
        this.config.agent.maxRetryBackoffMs
      );
      this.log.warn(`Agent failed, retrying in ${(delay / 1000).toFixed(0)}s`, {
        issue_id: issueId,
        issue_identifier: entry.issueIdentifier,
        error: result.error ?? "unknown",
        next_attempt: String(nextAttempt),
      });
      this.scheduleRetry(issueId, entry.issueIdentifier, nextAttempt, result.error ?? null, delay);
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
    const stallMs = 300000;
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

    const terminalLower = this.config.tracker.terminalStates.map(s => s.toLowerCase());
    const activeLower = this.config.tracker.activeStates.map(s => s.toLowerCase());

    for (const { id, state } of refreshed) {
      const entry = this.state.running.get(id);
      if (!entry) continue;

      const stateLower = state.toLowerCase();
      if (terminalLower.includes(stateLower)) {
        this.log.info(`Issue reached terminal state, stopping agent`, {
          issue_id: id,
          issue_identifier: entry.issueIdentifier,
          state,
        });
        entry.abortController.abort();
        this.state.running.delete(id);
        this.state.claimed.delete(id);
        removeWorkspace(
          this.config.workspace.root,
          entry.issueIdentifier,
          this.config.hooks.beforeRemove,
          this.config.hooks.timeoutMs
        ).catch(e => this.log.warn(`Workspace cleanup failed: ${String(e)}`));
      } else if (!activeLower.includes(stateLower)) {
        this.log.info(`Issue moved to non-active state, stopping agent`, {
          issue_id: id,
          issue_identifier: entry.issueIdentifier,
          state,
        });
        entry.abortController.abort();
        this.state.running.delete(id);
        this.state.claimed.delete(id);
      } else {
        entry.issue = { ...entry.issue, state };
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
          this.config.hooks.timeoutMs
        );
        cleaned++;
      }

      if (cleaned > 0) {
        this.log.info(`Startup cleanup: removed ${cleaned} stale workspaces`);
      }
    } catch (e) {
      this.log.warn(`Startup cleanup failed (non-fatal): ${String(e)}`);
    }
  }
}
