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
  const workspace = ((raw.workspace ?? {}) as Record<string, unknown>);
  const hooks = ((raw.hooks ?? {}) as Record<string, unknown>);
  const agent = ((raw.agent ?? {}) as Record<string, unknown>);
  const server = raw.server as Record<string, unknown> | undefined;

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

  return {
    tracker: {
      kind: "linear",
      endpoint: (tracker.endpoint as string | undefined) ?? "https://api.linear.app/graphql",
      apiKey,
      projectSlug: (tracker.project_slug as string | undefined) ?? "",
      teamKey: (tracker.team_key as string | undefined),
      activeStates: (tracker.active_states as string[] | undefined) ?? ["Todo", "In Progress"],
      terminalStates: (tracker.terminal_states as string[] | undefined) ?? [
        "Closed", "Cancelled", "Canceled", "Duplicate", "Done",
      ],
    },
    polling: {
      intervalMs: (polling.interval_ms as number | undefined) ?? 30000,
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
    server: server ? { port: server.port as number | undefined } : undefined,
  };
}

export function validateConfig(config: WorkflowConfig): string | null {
  if (!config.tracker.kind) return "tracker.kind is required";
  if (config.tracker.kind !== "linear") return `Unsupported tracker kind: ${config.tracker.kind}`;
  if (!config.tracker.apiKey) return "tracker.api_key is required (set LINEAR_API_KEY env var or tracker.api_key in WORKFLOW.md)";
  if (!config.tracker.projectSlug) return "tracker.project_slug is required (use \"ALL\" to watch a whole team)";
  if (config.tracker.projectSlug === "ALL" && !config.tracker.teamKey) {
    return "tracker.team_key is required when tracker.project_slug is \"ALL\"";
  }
  if (!config.workspace.root) return "workspace.root could not be resolved";
  if (config.agent.maxTurns <= 0) return "agent.max_turns must be > 0";
  if (config.agent.stallTimeoutMs <= 0) return "agent.stall_timeout_ms must be > 0";
  return null;
}
