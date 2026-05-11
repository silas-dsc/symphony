import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { Liquid } from "liquidjs";
import type { Issue, AgentResult, WorkflowConfig, RateLimitInfo, AgentEvent, AgentEventCallback, Logger } from "./types.js";
import { ensureWorkspace, runHook } from "./workspace.js";
import {
  selectClaudeModel,
  spawnCodexAgent,
  ERR_RATE_LIMITED,
  ERR_UNAVAILABLE,
  setClaudeBlockedUntil,
  isClaudeBlocked,
  claudeBlockedUntil,
  parseResetTimeMs,
} from "./llm.js";

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export function renderPrompt(template: string, issue: Issue, attempt: number | null, symphonyRoot: string): string {
  return liquid.parseAndRenderSync(template, {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branchName,
      url: issue.url,
      labels: issue.labels,
      blocked_by: issue.blockedBy,
      created_at: issue.createdAt?.toISOString() ?? null,
      updated_at: issue.updatedAt?.toISOString() ?? null,
    },
    attempt,
    symphony: { root: symphonyRoot },
  });
}

// AgentEvent and AgentEventCallback are defined in types.ts and re-exported here
// for backwards compatibility with any external consumers.
export type { AgentEvent, AgentEventCallback } from "./types.js";

interface ClaudeRateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  overageStatus?: string | null;
  overageResetsAt?: number | null;
  isUsingOverage?: boolean;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  result?: string;
  num_turns?: number;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  rate_limit_info?: ClaudeRateLimitInfo;
}

export async function runAgentAttempt(
  issue: Issue,
  attempt: number | null,
  config: WorkflowConfig,
  promptTemplate: string,
  symphonyRoot: string,
  abortController: AbortController,
  onEvent: AgentEventCallback,
  logger?: Logger,
): Promise<AgentResult> {
  const { path: wsPath, createdNow } = await ensureWorkspace(
    config.workspace.root,
    issue.identifier
  );

  if (createdNow && config.hooks.afterCreate) {
    await runHook(config.hooks.afterCreate, wsPath, config.hooks.timeoutMs, logger);
  }

  if (config.hooks.beforeRun) {
    await runHook(config.hooks.beforeRun, wsPath, config.hooks.timeoutMs, logger);
  }

  let prompt: string;
  try {
    prompt = renderPrompt(promptTemplate, issue, attempt, symphonyRoot);
  } catch (e) {
    throw new Error(`Template render error for ${issue.identifier}: ${e}`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let turnCount = 0;
  let success = false;
  let errorMsg: string | undefined;

  const selectedModel = isClaudeBlocked()
    ? undefined
    : await selectClaudeModel(issue).catch(() => undefined);
  if (selectedModel) {
    onEvent({ type: "notification", message: `[symphony] model selected: ${selectedModel}` });
  }

  const mcpConfigPath = resolveAgentMcpConfig(symphonyRoot);
  if (mcpConfigPath) {
    onEvent({ type: "notification", message: `[symphony] mcp config: ${mcpConfigPath}` });
  }

  try {
    onEvent({ type: "session_started" });
    const result = await spawnWithFailover(prompt, wsPath, config.agent.maxTurns, abortController, onEvent, selectedModel, mcpConfigPath);
    success = result.success;
    errorMsg = result.error;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    turnCount = result.turnCount;
  } catch (e) {
    if (!abortController.signal.aborted) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (config.hooks.afterRun) {
      try {
        await runHook(config.hooks.afterRun, wsPath, config.hooks.timeoutMs, logger);
      } catch (e) {
        logger?.warn(`after_run hook failed`, { identifier: issue.identifier, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return {
    success,
    error: errorMsg,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    turnCount,
  };
}

/**
 * Try Claude first; if it is rate-limited or unavailable, fall through to
 * Codex and then to a local LLM (if LOCAL_LLM_ENDPOINT is set).
 */
async function spawnWithFailover(
  prompt: string,
  cwd: string,
  maxTurns: number,
  abortController: AbortController,
  onEvent: AgentEventCallback,
  model: string | undefined,
  mcpConfigPath: string | undefined,
): Promise<AgentResult> {
  // ── Claude ──────────────────────────────────────────────────────────────────
  // Skip Claude entirely if it is known to be rate-limited right now.
  if (!isClaudeBlocked()) {
    let claudeResult: AgentResult | undefined;
    try {
      claudeResult = await spawnClaude(prompt, cwd, maxTurns, abortController, onEvent, model, mcpConfigPath);
    } catch {
      claudeResult = { success: false, error: ERR_UNAVAILABLE, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };
    }

    if (abortController.signal.aborted) return claudeResult ?? { success: false, error: "aborted", inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };

    const isRateLimited = claudeResult?.error === ERR_RATE_LIMITED;
    const isUnavailable = claudeResult?.error === ERR_UNAVAILABLE;

    if (!isRateLimited && !isUnavailable) return claudeResult ?? { success: false, error: "unknown", inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };

    onEvent({ type: "notification", message: `[symphony] Claude ${isRateLimited ? "rate-limited" : "unavailable"} — trying fallback providers` });
  } else {
    const until = new Date(claudeBlockedUntil()).toISOString();
    onEvent({ type: "notification", message: `[symphony] Claude blocked until ${until} — using fallback` });
  }

  // ── Codex fallback ─────────────────────────────────────────────────────────
  // Only pass --oss --local-provider if LOCAL_LLM_PROVIDER is explicitly set.
  // Without it, codex runs normally against its own default backend (Claude).
  const localProvider = process.env.LOCAL_LLM_PROVIDER || undefined;
  try {
    onEvent({ type: "notification", message: `[symphony] Trying local LLM fallback (${localProvider})`, provider: localProvider });
    const localResult = await spawnCodexAgent(prompt, cwd, abortController, onEvent, localProvider);
    if (localResult.success) return localResult;
    // If Claude was blocked and local LLM also failed, return a specific error so
    // the orchestrator can delay the next retry until Claude becomes available
    // rather than spinning every 300 s against a wall that won't move.
    if (isClaudeBlocked()) {
      return { success: false, error: `claude_blocked: ${localResult.error ?? "unknown"}`, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };
    }
    return { success: false, error: `all_providers_failed: ${localResult.error ?? "unknown"}`, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };
  } catch (e) {
    if (isClaudeBlocked()) {
      return { success: false, error: `claude_blocked: ${String(e).slice(0, 200)}`, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };
    }
    return { success: false, error: `all_providers_failed: ${String(e).slice(0, 200)}`, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };
  }
}

export function isRateLimitText(text: string): boolean {
  const t = text.toLowerCase()
    // Normalise Unicode apostrophes/quotes to ASCII so matches are robust
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'");
  if (
    t.includes("hit your limit") ||
    t.includes("you've hit") ||
    t.includes("you have hit") ||
    t.includes("rate limit") ||
    t.includes("rate_limit") ||
    t.includes("overloaded")
  ) return true;
  // Match HTTP 429/529 only when adjacent to an HTTP/status context, so e.g.
  // "line 429" or "PR #529" in agent output don't trigger a false failover.
  if (/\b(?:http|status|code|error)[\s/:]*(?:429|529)\b/i.test(text)) return true;
  return false;
}

/**
 * Resolve the path to the agent's MCP config (e.g. for chrome-devtools-mcp).
 * Prefers $SYMPHONY_AGENT_MCP_CONFIG when set, else `<symphonyRoot>/agent-mcp.json`.
 * Returns undefined if no file is found, so the agent runs with the user's default MCPs only.
 */
function resolveAgentMcpConfig(symphonyRoot: string): string | undefined {
  const explicit = process.env.SYMPHONY_AGENT_MCP_CONFIG;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const defaultPath = path.join(symphonyRoot, "agent-mcp.json");
  return fs.existsSync(defaultPath) ? defaultPath : undefined;
}

async function spawnClaude(
  prompt: string,
  cwd: string,
  maxTurns: number,
  abortController: AbortController,
  onEvent: AgentEventCallback,
  model: string | undefined,
  mcpConfigPath: string | undefined,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    // Build a clean env for the spawned `claude`. An empty `ANTHROPIC_API_KEY=""`
    // (common when a parent shell exports the var without a value) tells Claude
    // CLI to use API-key auth and overrides the OAuth credentials, which then
    // fails with "Not logged in". Strip empties so OAuth wins.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || v === "") continue;
      childEnv[k] = v;
    }

    const modelArgs = model ? ["--model", model] : [];
    const mcpArgs = mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [];

    const proc = spawn(
      "claude",
      [
        "-p",
        ...modelArgs,
        ...mcpArgs,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      {
        cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    if (proc.pid) onEvent({ type: "process_spawned", pid: proc.pid });

    // Write prompt to stdin, then close
    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    let inputTokens = 0;
    let outputTokens = 0;
    let turnCount = 0;
    let success = false;
    let resultError: string | undefined;
    let isRateLimited = false;
    const stderrBuf: string[] = [];

    proc.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) stderrBuf.push(s.slice(0, 500));
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(line) as ClaudeStreamEvent;
      } catch {
        return;
      }

      // Capture session id from the init event so the orchestrator/UI can correlate.
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        onEvent({ type: "session_init", sessionId: event.session_id });
      }

      // Surface Claude's rate-limit telemetry to the orchestrator.
      if (event.type === "rate_limit_event" && event.rate_limit_info) {
        const r = event.rate_limit_info;
        const rateLimit: RateLimitInfo = {
          status: r.status ?? "unknown",
          rateLimitType: r.rateLimitType ?? "unknown",
          resetsAt: r.resetsAt ?? 0,
          overageStatus: r.overageStatus ?? null,
          overageResetsAt: r.overageResetsAt ?? null,
          isUsingOverage: !!r.isUsingOverage,
          observedAt: new Date(),
        };
        if (r.status === "blocked") {
          isRateLimited = true;
          // Use the precise reset timestamp from the event if available.
          if (r.resetsAt) setClaudeBlockedUntil(r.resetsAt * 1000);
        }
        onEvent({ type: "rate_limit", rateLimit });
      }

      if (event.type === "assistant" && event.message) {
        turnCount++;

        const usage = event.message.usage;
        if (usage) {
          const inp = usage.input_tokens ?? 0;
          const out = usage.output_tokens ?? 0;
          // Claude's stream-json reports cumulative session totals on each
          // assistant event, so we take max rather than sum. If a future
          // stream-json schema reports per-turn deltas, this will silently
          // collapse to "max single turn" — verify against the final `result`
          // event's totals (also handled below).
          inputTokens = Math.max(inputTokens, inp);
          outputTokens = Math.max(outputTokens, out);
          onEvent({ type: "notification", tokens: { input: inp, output: out, total: inp + out } });
        }

        const content = event.message.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            onEvent({ type: "notification", message: block.text.slice(0, 300) });
          }
        }
      }

      if (event.type === "result") {
        turnCount = event.num_turns ?? turnCount;

        // Aggregate token totals from final result if present
        const u = event.usage;
        if (u) {
          inputTokens = Math.max(inputTokens, u.input_tokens ?? 0);
          outputTokens = Math.max(outputTokens, u.output_tokens ?? 0);
        }

        if (event.subtype === "success" && !event.is_error) {
          success = true;
          onEvent({ type: "turn_completed" });
        } else {
          // Some failure modes set `is_error: true` while still reporting subtype "success"
          // (e.g. session ended cleanly but the agent self-reported an error). Surface a
          // useful label rather than the literal string "success".
          if (event.subtype && event.subtype !== "success") {
            resultError = event.subtype;
          } else if (event.is_error) {
            const resultText = event.result ? String(event.result) : "";
            resultError = resultText
              ? `agent_reported_error: ${resultText.slice(0, 300)}`
              : "agent_reported_error";
            // Claude reports rate-limit hits as agent errors with text like
            // "You've hit your limit" or "rate limit" — catch them here so
            // spawnWithFailover can route to the next provider.
            if (isRateLimitText(resultText)) {
              isRateLimited = true;
              // Parse and record the reset time so future attempts skip Claude.
              const resetMs = parseResetTimeMs(resultText) ?? (Date.now() + 2 * 60 * 60 * 1000);
              setClaudeBlockedUntil(resetMs);
            }
          } else {
            resultError = "unknown";
          }
          onEvent({ type: "turn_failed", message: resultError });
        }
      }
    });

    const onAbort = (): void => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      abortController.signal.removeEventListener("abort", onAbort);
      rl.close();

      if (abortController.signal.aborted) {
        resolve({ success: false, error: "aborted", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, turnCount });
        return;
      }

      if (success) {
        resolve({ success: true, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, turnCount });
      } else {
        // Check stderr for rate-limit signals even if not detected via events.
        const stderrJoined = stderrBuf.join(" ");
        if (!isRateLimited && isRateLimitText(stderrJoined)) {
          isRateLimited = true;
        }

        if (isRateLimited) {
          resolve({ success: false, error: ERR_RATE_LIMITED, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, turnCount });
          return;
        }

        const errDetail = resultError ?? (stderrBuf.length ? stderrBuf.join("; ") : `exit code ${code}`);
        resolve({ success: false, error: errDetail, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, turnCount });
      }
    });

    proc.on("error", (e) => {
      abortController.signal.removeEventListener("abort", onAbort);
      // ENOENT means the `claude` binary isn't installed — treat as unavailable so failover triggers.
      const isEnoent = (e as NodeJS.ErrnoException).code === "ENOENT";
      if (isEnoent) {
        resolve({ success: false, error: ERR_UNAVAILABLE, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 });
      } else {
        reject(e);
      }
    });
  });
}
