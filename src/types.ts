export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssuePerson {
  name: string;
  email: string | null;
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
  assignee: IssuePerson | null;
  creator: IssuePerson | null;
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
  githubPreview: GitHubPreviewConfig;
  keepAlive: KeepAliveConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  notifications: NotificationsConfig;
  server?: ServerConfig;
  autoUpdate: AutoUpdateConfig;
  retrospective: RetrospectiveConfig;
  mergeConflicts: MergeConflictConfig;
  dependabot: DependabotConfig;
  queryInsights: QueryInsightsConfig;
  posthog: PostHogConfig;
}

export interface PostHogConfig {
  /** When true, Symphony pulls PostHog error-tracking reports ~daily and files a Linear ticket for each new one. */
  enabled: boolean;
  /** PostHog host, e.g. "https://us.posthog.com" (defaults to $POSTHOG_HOST, then us.posthog.com). */
  host: string;
  /** Numeric PostHog project id, e.g. "49303" (defaults to $POSTHOG_PROJECT_ID). */
  projectId: string;
  /** PostHog personal API key (phx_…) used as a Bearer token (defaults to $POSTHOG_PERSONAL_API_KEY). */
  apiKey: string;
  /** Linear team key the tickets are created under (defaults to tracker.team_key). */
  teamKey: string;
  /** Workflow state name the ticket is created in — must be one of tracker.active_states so the agent picks it up. */
  targetState: string;
  /** Email (or name) of the Linear user to assign the ticket to. Empty = unassigned. */
  assigneeEmail: string;
  /** Linear label applied to every ticket; also used to dedupe so the same report isn't filed twice. */
  label: string;
  /** Which PostHog issue status to pull: "active" | "resolved" | "suppressed" | "all". */
  status: string;
  /** ErrorTrackingQuery ordering: "occurrences" | "last_seen" | "first_seen" | "users" | "sessions". */
  orderBy: string;
  /** How many days back the report query spans. */
  lookbackDays: number;
  /** Floor on occurrences — reports below this are too quiet to ticket. */
  minOccurrences: number;
  /** Hard cap on how many PostHog tickets may be open (non-terminal) at once. */
  maxOpenTickets: number;
  /** Max tickets to file in a single run. */
  maxTicketsPerRun: number;
  /** How often the report pull runs, in ms. Defaults to ~1 day. */
  runIntervalMs: number;
  /** Timeout for the PostHog query API call, in ms. */
  requestTimeoutMs: number;
}

export interface QueryInsightsConfig {
  /** When true, Symphony scans the BigQuery offender table ~weekly and files Linear tickets for the worst query shapes. */
  enabled: boolean;
  /** GCP project holding the BigQuery dataset. */
  projectId: string;
  /** BigQuery dataset name (default "query_insights"). */
  dataset: string;
  /** BigQuery table name (default "query_stats"). */
  table: string;
  /** Linear team key the tickets are created under (defaults to tracker.team_key). */
  teamKey: string;
  /** Workflow state name the ticket is created in — must be one of tracker.active_states so the agent picks it up. */
  targetState: string;
  /** Email (or name) of the Linear user to assign the ticket to. Empty = unassigned. */
  assigneeEmail: string;
  /** Linear label applied to every ticket; also used to dedupe so the same shape isn't filed twice. */
  label: string;
  /** How many days of stats the ranking query aggregates over. */
  lookbackDays: number;
  /** Floor on SUM(readOps) per shape — below this, a shape is too cheap to ticket. */
  minReadOps: number;
  /** Hard cap on how many query-insights tickets may be open (non-terminal) at once. */
  maxOpenTickets: number;
  /** Max tickets to file in a single weekly run. */
  maxTicketsPerRun: number;
  /** How often the (expensive) BigQuery scan runs, in ms. Defaults to ~7 days. */
  runIntervalMs: number;
  /** Timeout for the `bq query` call, in ms. */
  bqTimeoutMs: number;
}

export interface DependabotConfig {
  /** When true, Symphony scans GitHub Dependabot alerts each tick and files a Linear ticket for each new one. */
  enabled: boolean;
  /** GitHub repo owner whose Dependabot alerts are scanned (defaults to github_preview.repo_owner). */
  repoOwner: string;
  /** GitHub repo name whose Dependabot alerts are scanned (defaults to github_preview.repo_name). */
  repoName: string;
  /** Linear team key the tickets are created under (defaults to tracker.team_key). */
  teamKey: string;
  /** Workflow state name the ticket is created in — must be one of tracker.active_states so the agent picks it up. */
  targetState: string;
  /** Email (or name) of the Linear user to assign the ticket to. Empty = unassigned. */
  assigneeEmail: string;
  /** Linear label applied to every ticket; also used to dedupe so the same alert isn't filed twice. */
  label: string;
  /** Only file tickets for alerts at or above this severity: low | medium | high | critical. */
  minSeverity: string;
  /** Hard cap on how many Dependabot tickets may be open (non-terminal) at once. Defaults to 1. */
  maxOpenTickets: number;
  /** Timeout for the `gh api` call that lists Dependabot alerts, in ms. */
  requestTimeoutMs: number;
}

export interface MergeConflictConfig {
  /** When true, Symphony scans open PRs each tick and resolves the conflicts on any that are CONFLICTING. */
  enabled: boolean;
  /** GitHub repo owner whose open PRs are scanned (defaults to github_preview.repo_owner). */
  repoOwner: string;
  /** GitHub repo name whose open PRs are scanned (defaults to github_preview.repo_name). */
  repoName: string;
  /** Max turns the resolver Claude session is allowed before aborting. */
  maxTurns: number;
  /** Hard timeout for a single conflict-resolution run, in ms. */
  timeoutMs: number;
  /** Max number of conflict-resolution agents running concurrently. */
  maxConcurrent: number;
  /** Minimum delay before re-attempting a PR that is still conflicting after a prior run, in ms. */
  retryIntervalMs: number;
  /** Timeout for the `gh` call that lists open PRs, in ms. */
  requestTimeoutMs: number;
}

export interface RetrospectiveConfig {
  /** When true, run a retrospective sub-agent each time a Symphony-tracked ticket reaches a terminal state. */
  enabled: boolean;
  /** Terminal states that should trigger a retrospective. Lowercased before comparison. */
  triggerStates: string[];
  /** Absolute path to the lessons.jsonl file the retrospective appends to. */
  lessonsPath: string;
  /** When true, commit lessons.jsonl and push it to the tracked branch after each retrospective. */
  commitLessons: boolean;
  /** Max turns the retrospective Claude session is allowed before aborting. */
  maxTurns: number;
  /** Hard timeout for a single retrospective run, in ms. */
  timeoutMs: number;
}

export interface KeepAliveConfig {
  urls: string[];
  intervalMs: number;
  requestTimeoutMs: number;
}

export interface NotificationsConfig {
  slack: SlackNotificationsConfig | null;
}

export interface SlackNotificationsConfig {
  webhookUrl: string;
  userMap: Record<string, string>;
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

export interface GitHubPreviewConfig {
  enabled: boolean;
  repoOwner: string;
  repoName: string;
  commentPattern: string;
  urlTemplate: string;
  commentPollLimit: number;
  keepAliveIntervalMs: number;
  requestTimeoutMs: number;
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
  stallTimeoutMs: number;
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
  completionSummary?: string;
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
  /** Promise that resolves when the agent run settles. Tracked so shutdown can await. */
  done: Promise<void>;
}

export interface TrackedIssueEntry {
  issue: Issue;
  completionSummary: string | null;
}

export interface PendingSlackNotification {
  issueId: string;
  issue: Issue;
  state: string;
  completionSummary: string | null;
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
  trackedIssues: Map<string, TrackedIssueEntry>;
  knownTerminalIssueIds: Set<string>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  pendingSlackNotifications: PendingSlackNotification[];
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
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}
