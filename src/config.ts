import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import yaml from "js-yaml";
import type { WorkflowDefinition, WorkflowConfig } from "./types.js";

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "invalid_config";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly path?: string;
  constructor(code: WorkflowErrorCode, message: string, path?: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.path = path;
  }
}

export function loadWorkflow(workflowPath: string): WorkflowDefinition {
  let content: string;
  try {
    content = fs.readFileSync(workflowPath, "utf-8");
  } catch {
    throw new WorkflowError("missing_workflow_file", `Workflow file not found: ${workflowPath}`, workflowPath);
  }

  let rawConfig: Record<string, unknown> = {};
  let promptTemplate = "";

  if (content.startsWith("---")) {
    const endIndex = content.indexOf("\n---\n", 3);
    if (endIndex === -1) {
      throw new WorkflowError("workflow_parse_error", "Unterminated YAML front matter");
    }
    const frontMatterStr = content.slice(4, endIndex);
    const body = content.slice(endIndex + 5);

    let parsed: unknown;
    try {
      parsed = yaml.load(frontMatterStr);
    } catch (e) {
      throw new WorkflowError("workflow_parse_error", e instanceof Error ? e.message : String(e));
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new WorkflowError("workflow_front_matter_not_a_map", "Front matter must be a YAML map");
    }
    rawConfig = parsed as Record<string, unknown>;
    promptTemplate = body.trim();
  } else {
    promptTemplate = content.trim();
  }

  const baseDir = path.dirname(path.resolve(workflowPath));
  const config = buildConfig(rawConfig, baseDir);

  return { config, promptTemplate, symphonyRoot: baseDir };
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] ?? "";
  }
  return value;
}

function resolvePath(value: string, baseDir: string): string {
  let v = value;
  if (v.startsWith("$")) {
    v = resolveEnvVar(v);
    if (!v) return "";
  }
  if (v.startsWith("~")) {
    v = path.join(os.homedir(), v.slice(1));
  }
  if (!path.isAbsolute(v)) {
    v = path.resolve(baseDir, v);
  }
  return v;
}

function buildConfig(raw: Record<string, unknown>, baseDir: string): WorkflowConfig {
  const tracker = ((raw.tracker ?? {}) as Record<string, unknown>);
  const polling = ((raw.polling ?? {}) as Record<string, unknown>);
  const githubPreview = ((raw.github_preview ?? {}) as Record<string, unknown>);
  const keepAlive = ((raw.keep_alive ?? {}) as Record<string, unknown>);
  const notifications = ((raw.notifications ?? {}) as Record<string, unknown>);
  const slack = ((notifications.slack ?? {}) as Record<string, unknown>);
  const workspace = ((raw.workspace ?? {}) as Record<string, unknown>);
  const hooks = ((raw.hooks ?? {}) as Record<string, unknown>);
  const agent = ((raw.agent ?? {}) as Record<string, unknown>);
  const server = raw.server as Record<string, unknown> | undefined;
  const autoUpdate = ((raw.auto_update ?? {}) as Record<string, unknown>);
  const retrospective = ((raw.retrospective ?? {}) as Record<string, unknown>);
  const mergeConflicts = ((raw.merge_conflicts ?? {}) as Record<string, unknown>);
  const dependabot = ((raw.dependabot ?? {}) as Record<string, unknown>);

  const apiKeyRaw = (tracker.api_key as string | undefined) ?? "$LINEAR_API_KEY";
  const apiKey = resolveEnvVar(apiKeyRaw);

  const workspaceRootRaw = (workspace.root as string | undefined) ??
    path.join(os.tmpdir(), "symphony_workspaces");
  const workspaceRoot = resolvePath(workspaceRootRaw, baseDir);

  const maxConcurrentAgentsByState: Record<string, number> = {};
  const rawMap = ((agent.max_concurrent_agents_by_state ?? {}) as Record<string, unknown>);
  for (const [key, val] of Object.entries(rawMap)) {
    if (typeof val === "number" && Number.isInteger(val) && val > 0) {
      maxConcurrentAgentsByState[key.toLowerCase()] = val;
    }
  }

  const slackUserMap: Record<string, string> = {};
  const rawSlackUserMap = ((slack.user_map ?? {}) as Record<string, unknown>);
  for (const [key, val] of Object.entries(rawSlackUserMap)) {
    if (typeof val === "string" && val.trim()) {
      slackUserMap[key] = val.trim();
    }
  }

  const slackWebhookUrlRaw = slack.webhook_url as string | undefined;
  const hasSlackConfig = typeof slackWebhookUrlRaw === "string";
  const slackWebhookUrl = slackWebhookUrlRaw ? resolveEnvVar(slackWebhookUrlRaw).trim() : "";

  const activeStates = (tracker.active_states as string[] | undefined) ?? ["Todo", "In Progress"];
  const trackerTeamKey = tracker.team_key as string | undefined;

  return {
    tracker: {
      kind: "linear",
      endpoint: (tracker.endpoint as string | undefined) ?? "https://api.linear.app/graphql",
      apiKey,
      projectSlug: (tracker.project_slug as string | undefined) ?? "",
      teamKey: trackerTeamKey,
      activeStates,
      terminalStates: (tracker.terminal_states as string[] | undefined) ?? [
        "Closed", "Cancelled", "Canceled", "Duplicate", "Done",
      ],
    },
    polling: {
      intervalMs: (polling.interval_ms as number | undefined) ?? 30000,
    },
    githubPreview: {
      enabled: (githubPreview.enabled as boolean | undefined) ?? false,
      repoOwner: (githubPreview.repo_owner as string | undefined) ?? "",
      repoName: (githubPreview.repo_name as string | undefined) ?? "",
      commentPattern: (githubPreview.comment_pattern as string | undefined) ?? "",
      urlTemplate: (githubPreview.url_template as string | undefined) ?? "",
      commentPollLimit: (githubPreview.comment_poll_limit as number | undefined) ?? 100,
      keepAliveIntervalMs: (githubPreview.keepalive_interval_ms as number | undefined) ?? 180000,
      requestTimeoutMs: (githubPreview.request_timeout_ms as number | undefined) ?? 30000,
    },
    keepAlive: {
      urls: (keepAlive.urls as string[] | undefined) ?? [],
      intervalMs: (keepAlive.interval_ms as number | undefined) ?? 180000,
      requestTimeoutMs: (keepAlive.request_timeout_ms as number | undefined) ?? 30000,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      afterCreate: hooks.after_create as string | undefined,
      beforeRun: hooks.before_run as string | undefined,
      afterRun: hooks.after_run as string | undefined,
      beforeRemove: hooks.before_remove as string | undefined,
      // Default 10 min: after_create hooks commonly clone repos and run package installs
      // (e.g. `nvm install && pnpm install`), which routinely exceed a minute on cold caches.
      timeoutMs: (hooks.timeout_ms as number | undefined) ?? 600000,
    },
    agent: {
      maxConcurrentAgents: (agent.max_concurrent_agents as number | undefined) ?? 10,
      maxTurns: (agent.max_turns as number | undefined) ?? 20,
      maxRetryBackoffMs: (agent.max_retry_backoff_ms as number | undefined) ?? 300000,
      stallTimeoutMs: (agent.stall_timeout_ms as number | undefined) ?? 300000,
      maxConcurrentAgentsByState,
    },
    notifications: {
      slack: hasSlackConfig
        ? {
          webhookUrl: slackWebhookUrl,
          userMap: slackUserMap,
        }
        : null,
    },
    server: server ? { port: server.port as number | undefined } : undefined,
    autoUpdate: {
      enabled: (autoUpdate.enabled as boolean | undefined) ?? true,
      intervalMs: (autoUpdate.interval_ms as number | undefined) ?? 300000,
      remote: (autoUpdate.remote as string | undefined) ?? "origin",
      branch: (autoUpdate.branch as string | undefined) ?? null,
      repoRoot: typeof autoUpdate.repo_root === "string"
        ? resolvePath(autoUpdate.repo_root, baseDir)
        : null,
      buildCommand: (autoUpdate.build_command as string | undefined) ?? "npm run build",
      installCommand: (autoUpdate.install_command as string | undefined) ?? "npm install",
    },
    retrospective: {
      enabled: (retrospective.enabled as boolean | undefined) ?? false,
      triggerStates: (retrospective.trigger_states as string[] | undefined) ?? ["Done"],
      lessonsPath: typeof retrospective.lessons_path === "string"
        ? resolvePath(retrospective.lessons_path, baseDir)
        : path.join(baseDir, "lessons", "lessons.jsonl"),
      maxTurns: (retrospective.max_turns as number | undefined) ?? 15,
      timeoutMs: (retrospective.timeout_ms as number | undefined) ?? 300000,
    },
    mergeConflicts: {
      enabled: (mergeConflicts.enabled as boolean | undefined) ?? false,
      // Default to the github_preview repo so a single repo only needs to be declared once.
      repoOwner: (mergeConflicts.repo_owner as string | undefined)
        ?? (githubPreview.repo_owner as string | undefined) ?? "",
      repoName: (mergeConflicts.repo_name as string | undefined)
        ?? (githubPreview.repo_name as string | undefined) ?? "",
      maxTurns: (mergeConflicts.max_turns as number | undefined) ?? 30,
      timeoutMs: (mergeConflicts.timeout_ms as number | undefined) ?? 1200000,
      maxConcurrent: (mergeConflicts.max_concurrent as number | undefined) ?? 2,
      retryIntervalMs: (mergeConflicts.retry_interval_ms as number | undefined) ?? 600000,
      requestTimeoutMs: (mergeConflicts.request_timeout_ms as number | undefined) ?? 30000,
    },
    dependabot: {
      enabled: (dependabot.enabled as boolean | undefined) ?? false,
      // Default to the github_preview repo so a single repo only needs to be declared once.
      repoOwner: (dependabot.repo_owner as string | undefined)
        ?? (githubPreview.repo_owner as string | undefined) ?? "",
      repoName: (dependabot.repo_name as string | undefined)
        ?? (githubPreview.repo_name as string | undefined) ?? "",
      teamKey: (dependabot.team_key as string | undefined) ?? trackerTeamKey ?? "",
      // Default to the first active state so the created ticket is dispatchable by the poll loop.
      targetState: (dependabot.target_state as string | undefined) ?? activeStates[0] ?? "",
      assigneeEmail: (dependabot.assignee_email as string | undefined) ?? "",
      label: (dependabot.label as string | undefined) ?? "dependabot",
      minSeverity: ((dependabot.min_severity as string | undefined) ?? "low").toLowerCase(),
      maxNewTicketsPerTick: (dependabot.max_new_tickets_per_tick as number | undefined) ?? 3,
      requestTimeoutMs: (dependabot.request_timeout_ms as number | undefined) ?? 30000,
    },
  };
}

const VALID_SEVERITIES = new Set(["low", "medium", "moderate", "high", "critical"]);

export function validateConfig(config: WorkflowConfig): string | null {
  if (!config.tracker.kind) return "tracker.kind is required";
  if (config.tracker.kind !== "linear") return `Unsupported tracker kind: ${config.tracker.kind}`;
  if (!config.tracker.apiKey) return "tracker.api_key is required (set LINEAR_API_KEY env var or tracker.api_key in WORKFLOW.md)";
  if (!config.tracker.projectSlug) return "tracker.project_slug is required (use \"ALL\" to watch a whole team)";
  if (config.tracker.projectSlug === "ALL" && !config.tracker.teamKey) {
    return "tracker.team_key is required when tracker.project_slug is \"ALL\"";
  }
  if (config.githubPreview.enabled) {
    if (!config.githubPreview.repoOwner) return "github_preview.repo_owner is required when github_preview.enabled is true";
    if (!config.githubPreview.repoName) return "github_preview.repo_name is required when github_preview.enabled is true";
    if (!config.githubPreview.commentPattern) return "github_preview.comment_pattern is required when github_preview.enabled is true";
    if (!config.githubPreview.urlTemplate) return "github_preview.url_template is required when github_preview.enabled is true";
    if (!config.githubPreview.urlTemplate.includes("{{pr}}")) return "github_preview.url_template must include {{pr}}";
    if (!Number.isInteger(config.githubPreview.commentPollLimit) || config.githubPreview.commentPollLimit <= 0) {
      return "github_preview.comment_poll_limit must be a positive integer";
    }
    if (config.githubPreview.keepAliveIntervalMs <= 0) return "github_preview.keepalive_interval_ms must be > 0";
    if (config.githubPreview.requestTimeoutMs <= 0) return "github_preview.request_timeout_ms must be > 0";
    try {
      new RegExp(config.githubPreview.commentPattern, "i");
    } catch (e) {
      return `github_preview.comment_pattern is not a valid regex: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (config.mergeConflicts.enabled) {
    if (!config.mergeConflicts.repoOwner) return "merge_conflicts.repo_owner is required when merge_conflicts.enabled is true (or set github_preview.repo_owner)";
    if (!config.mergeConflicts.repoName) return "merge_conflicts.repo_name is required when merge_conflicts.enabled is true (or set github_preview.repo_name)";
    if (config.mergeConflicts.maxTurns <= 0) return "merge_conflicts.max_turns must be > 0";
    if (config.mergeConflicts.timeoutMs <= 0) return "merge_conflicts.timeout_ms must be > 0";
    if (config.mergeConflicts.maxConcurrent <= 0) return "merge_conflicts.max_concurrent must be > 0";
    if (config.mergeConflicts.retryIntervalMs <= 0) return "merge_conflicts.retry_interval_ms must be > 0";
    if (config.mergeConflicts.requestTimeoutMs <= 0) return "merge_conflicts.request_timeout_ms must be > 0";
  }
  if (config.dependabot.enabled) {
    const d = config.dependabot;
    if (!d.repoOwner) return "dependabot.repo_owner is required when dependabot.enabled is true (or set github_preview.repo_owner)";
    if (!d.repoName) return "dependabot.repo_name is required when dependabot.enabled is true (or set github_preview.repo_name)";
    if (!d.teamKey) return "dependabot.team_key is required when dependabot.enabled is true (or set tracker.team_key)";
    if (!d.targetState) return "dependabot.target_state is required when dependabot.enabled is true";
    const activeLower = config.tracker.activeStates.map(s => s.toLowerCase());
    if (!activeLower.includes(d.targetState.toLowerCase())) {
      return `dependabot.target_state (${d.targetState}) must be one of tracker.active_states, otherwise the created ticket will never be dispatched`;
    }
    if (!VALID_SEVERITIES.has(d.minSeverity)) return "dependabot.min_severity must be one of: low, medium, high, critical";
    if (!Number.isInteger(d.maxNewTicketsPerTick) || d.maxNewTicketsPerTick <= 0) return "dependabot.max_new_tickets_per_tick must be a positive integer";
    if (d.requestTimeoutMs <= 0) return "dependabot.request_timeout_ms must be > 0";
  }
  if (!config.workspace.root) return "workspace.root could not be resolved";
  if (config.agent.maxTurns <= 0) return "agent.max_turns must be > 0";
  if (config.agent.stallTimeoutMs <= 0) return "agent.stall_timeout_ms must be > 0";
  if (config.notifications.slack && !config.notifications.slack.webhookUrl) {
    return "notifications.slack.webhook_url is required when Slack notifications are configured";
  }
  return null;
}
