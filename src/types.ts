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
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  server?: ServerConfig;
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

export interface AgentResult {
  success: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
}

export interface RunningEntry {
  issueId: string;
  issueIdentifier: string;
  issue: Issue;
  startedAt: Date;
  sessionId: string | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
  retryAttempt: number | null;
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
}

export interface Logger {
  info(msg: string, context?: Record<string, string>): void;
  warn(msg: string, context?: Record<string, string>): void;
  error(msg: string, context?: Record<string, string>): void;
}
