import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { Liquid } from "liquidjs";
import type { Issue, AgentResult, WorkflowConfig } from "./types.js";
import { ensureWorkspace, runHook } from "./workspace.js";

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
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
  });
}

export interface AgentEventCallback {
  (type: string, message?: string, tokens?: { input: number; output: number; total: number }): void;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  result?: string;
  num_turns?: number;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function runAgentAttempt(
  issue: Issue,
  attempt: number | null,
  config: WorkflowConfig,
  promptTemplate: string,
  abortController: AbortController,
  onEvent: AgentEventCallback
): Promise<AgentResult> {
  const { path: wsPath, createdNow } = await ensureWorkspace(
    config.workspace.root,
    issue.identifier
  );

  if (createdNow && config.hooks.afterCreate) {
    await runHook(config.hooks.afterCreate, wsPath, config.hooks.timeoutMs);
  }

  if (config.hooks.beforeRun) {
    await runHook(config.hooks.beforeRun, wsPath, config.hooks.timeoutMs);
  }

  let prompt: string;
  try {
    prompt = renderPrompt(promptTemplate, issue, attempt);
  } catch (e) {
    throw new Error(`Template render error for ${issue.identifier}: ${e}`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let turnCount = 0;
  let success = false;
  let errorMsg: string | undefined;

  try {
    onEvent("session_started");
    const result = await spawnClaude(prompt, wsPath, config.agent.maxTurns, abortController, onEvent);
    success = result.success;
    errorMsg = result.error;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    turnCount = result.turnCount;
  } catch (e) {
    if (!abortController.signal.aborted) {
      errorMsg = String(e);
    }
  } finally {
    if (config.hooks.afterRun) {
      try {
        await runHook(config.hooks.afterRun, wsPath, config.hooks.timeoutMs);
      } catch (e) {
        console.warn(`[symphony] after_run hook failed for ${issue.identifier}: ${e}`);
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

async function spawnClaude(
  prompt: string,
  cwd: string,
  _maxTurns: number,
  abortController: AbortController,
  onEvent: AgentEventCallback
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

    const proc = spawn(
      "claude",
      [
        "-p",
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

    // Write prompt to stdin, then close
    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    let inputTokens = 0;
    let outputTokens = 0;
    let turnCount = 0;
    let success = false;
    let resultError: string | undefined;
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

      if (event.type === "assistant" && event.message) {
        turnCount++;

        const usage = event.message.usage;
        if (usage) {
          const inp = usage.input_tokens ?? 0;
          const out = usage.output_tokens ?? 0;
          inputTokens = Math.max(inputTokens, inp);
          outputTokens = Math.max(outputTokens, out);
          onEvent("notification", undefined, { input: inp, output: out, total: inp + out });
        }

        const content = event.message.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            onEvent("notification", block.text.slice(0, 300));
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
          onEvent("turn_completed");
        } else {
          // Some failure modes set `is_error: true` while still reporting subtype "success"
          // (e.g. session ended cleanly but the agent self-reported an error). Surface a
          // useful label rather than the literal string "success".
          if (event.subtype && event.subtype !== "success") {
            resultError = event.subtype;
          } else if (event.is_error) {
            resultError = event.result
              ? `agent_reported_error: ${String(event.result).slice(0, 300)}`
              : "agent_reported_error";
          } else {
            resultError = "unknown";
          }
          onEvent("turn_failed", resultError);
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
        const errDetail = resultError ?? (stderrBuf.length ? stderrBuf.join("; ") : `exit code ${code}`);
        resolve({ success: false, error: errDetail, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, turnCount });
      }
    });

    proc.on("error", (e) => {
      abortController.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
