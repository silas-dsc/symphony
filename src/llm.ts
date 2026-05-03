import { spawn } from "node:child_process";
import type { AgentResult, AgentEventCallback } from "./types.js";

// ── Model name constants (each overridable via env) ───────────────────────────

export const CLAUDE_HAIKU_MODEL  = process.env.CLAUDE_HAIKU_MODEL  ?? "claude-haiku-4-5";
export const CLAUDE_SONNET_MODEL = process.env.CLAUDE_SONNET_MODEL ?? "claude-sonnet-4-5";
export const CLAUDE_OPUS_MODEL   = process.env.CLAUDE_OPUS_MODEL   ?? "claude-opus-4-5";

// Sentinel error strings used by spawnClaude to signal the caller to failover.
export const ERR_RATE_LIMITED = "rate_limited";
export const ERR_UNAVAILABLE  = "provider_unavailable";

// ── Model selection via Haiku ─────────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are a task complexity classifier. Given a software issue, choose the appropriate Claude model tier.

Tiers:
- haiku   — Simple, routine: small bug fixes, minor UI tweaks, typo corrections, trivial tests, simple config changes
- sonnet  — Moderate: medium-sized features, refactoring across a few files, API integrations, schema changes
- opus    — Complex, open-ended: system architecture, large migrations, deep multi-system debugging, greenfield design

Issue title: {{title}}
Issue description (excerpt): {{description}}

Reply with exactly one word (haiku / sonnet / opus):`;

/**
 * Asks Claude Haiku to classify the task and return the most appropriate
 * model name. Falls back to Sonnet if the API key is missing or the call fails.
 *
 * Controlled by CLAUDE_MODEL env var:
 *   "auto"  (default) — ask Haiku each time
 *   any other value   — use that model name directly, skip classification
 */
export async function selectClaudeModel(
  issue: { title: string; description: string | null },
): Promise<string> {
  const override = process.env.CLAUDE_MODEL;
  if (override && override !== "auto") return override;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return CLAUDE_SONNET_MODEL;  // no key → default to Sonnet

  const description = (issue.description ?? "").slice(0, 600);
  const userContent = CLASSIFIER_PROMPT
    .replace("{{title}}", issue.title)
    .replace("{{description}}", description);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_HAIKU_MODEL,
        max_tokens: 10,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return CLAUDE_SONNET_MODEL;

    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const answer = (data.content?.[0]?.text ?? "").trim().toLowerCase();

    if (answer.startsWith("haiku")) return CLAUDE_HAIKU_MODEL;
    if (answer.startsWith("opus"))  return CLAUDE_OPUS_MODEL;
    return CLAUDE_SONNET_MODEL;
  } catch {
    return CLAUDE_SONNET_MODEL;
  }
}

// ── Codex CLI provider ────────────────────────────────────────────────────────

/**
 * Runs the Codex CLI as a drop-in agentic fallback.
 * Assumes `codex` is on PATH and handles its own auth.
 * Pass `provider` to use a specific codex provider (e.g. "ollama-qwen35-9b").
 * Optionally reads CODEX_ENDPOINT to set OPENAI_BASE_URL for proxies.
 */
export async function spawnCodexAgent(
  prompt: string,
  cwd: string,
  abortController: AbortController,
  onEvent: AgentEventCallback,
  provider?: string,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && v !== "") childEnv[k] = v;
    }

    const codexEndpoint = process.env.CODEX_ENDPOINT;
    if (codexEndpoint) childEnv.OPENAI_BASE_URL = codexEndpoint;

    const providerArgs = provider ? ["-p", provider] : [];

    // `codex --approval-policy full-auto` runs without human confirmation prompts.
    const proc = spawn(
      "codex",
      [...providerArgs, "--approval-policy", "full-auto", "--quiet", prompt],
      { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );

    const providerLabel = provider ?? "codex";
    if (proc.pid) onEvent({ type: "process_spawned", pid: proc.pid, provider: providerLabel });

    let hasOutput = false;
    const stderrBuf: string[] = [];

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) hasOutput = true;
      onEvent({ type: "notification", message: text.slice(0, 300), provider: providerLabel });
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) stderrBuf.push(s.slice(0, 300));
    });

    const onAbort = (): void => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      abortController.signal.removeEventListener("abort", onAbort);

      if (abortController.signal.aborted) {
        resolve({ success: false, error: "aborted", inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 });
        return;
      }

      const success = code === 0 && hasOutput;
      if (success) {
        onEvent({ type: "turn_completed", provider: providerLabel });
        resolve({ success: true, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 1 });
      } else {
        const err = stderrBuf.join("; ") || `codex exit ${code}`;
        onEvent({ type: "turn_failed", message: err, provider: providerLabel });
        resolve({ success: false, error: err, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 });
      }
    });

    proc.on("error", (e) => {
      abortController.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
