export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface WorkflowDefinition {
  config: WorkflowConfig;
  promptTemplate: string;
  /** Absolute path to the directory containing WORKFLOW.md (and sibling files like UNSLOP.md). */
  symphonyRoot: string;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  server?: ServerConfig;
  autoUpdate: AutoUpdateConfig;
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  /** Set to "ALL" to watch an entire team rather than one project. */
  projectSlug: string;
  /** Required when projectSlug is "ALL" — the Linear team key (e.g. "TEA"). */
  teamKey?: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
  beforeRemove?: string;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface ServerConfig {
  port?: number;
}

export interface AutoUpdateConfig {
  /** When false, Symphony will not poll GitHub for self-updates. */
  enabled: boolean;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Remote name to fetch from (default "origin"). */
  remote: string;
  /** Branch to track; defaults to the current local branch. */
  branch: string | null;
  /** Absolute path to the Symphony git checkout; defaults to the directory containing the running build. */
  repoRoot: string | null;
  /** Build command run after a successful pull (default "npm run build"). */
  buildCommand: string;
  /** Install command run when package-lock.json or package.json changes (default "npm install"). */
  installCommand: string;
}

export interface AgentResult {
  success: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
}

export interface RateLimitInfo {
  status: string;            // "allowed" | "warning" | "blocked" | etc.
  rateLimitType: string;     // "five_hour" | "weekly" | etc.
  resetsAt: number;          // unix seconds
  overageStatus: string | null;
  overageResetsAt: number | null;
  isUsingOverage: boolean;
  observedAt: Date;
}

export interface AgentEvent {
  type: string;
  message?: string;
  tokens?: { input: number; output: number; total: number };
  pid?: number;
  sessionId?: string;
  rateLimit?: RateLimitInfo;
  provider?: string;
}

export interface AgentEventCallback {
  (event: AgentEvent): void;
}

export interface RunningEntry {
  issueId: string;
  issueIdentifier: string;
  issue: Issue;
  startedAt: Date;
  pid: number | null;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
  retryAttempt: number | null;
  rateLimit: RateLimitInfo | null;
  abortController: AbortController;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
  timer: ReturnType<typeof setTimeout>;
}

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalSecondsRunning: number;
  /** Most recently observed rate-limit event from any agent. */
  latestRateLimit: RateLimitInfo | null;
  startedAt: Date;
  teamUrl: string | null;
}

// ─── Status snapshot (consumed by the HTTP /status endpoint and the TUI) ─────

export interface StatusSnapshot {
  generated_at: string;
  process: {
    started_at: string;
    uptime_seconds: number;
  };
  counts: { running: number; retrying: number; max_concurrent: number };
  project: {
    project_slug: string;
    team_key: string | null;
    team_url: string | null;
  };
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
    throughput_tps: number;
  };
  rate_limit: RateLimitSnapshot | null;
  running: RunningSnapshot[];
  retrying: RetrySnapshot[];
}

export interface RateLimitSnapshot {
  status: string;
  rate_limit_type: string;
  resets_at: number;
  resets_in_seconds: number;
  overage_status: string | null;
  is_using_overage: boolean;
  observed_at: string;
}

export interface RunningSnapshot {
  issue_id: string;
  issue_identifier: string;
  issue_title?: string;
  state: string;
  pid: number | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  age_seconds: number;
  last_event_at: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface RetrySnapshot {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  due_in_seconds: number;
  error: string | null;
}

export interface Logger {
  info(msg: string, context?: Record<string, string>): void;
  warn(msg: string, context?: Record<string, string>): void;
  error(msg: string, context?: Record<string, string>): void;
}
