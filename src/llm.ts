import { spawn } from "node:child_process";
import type { AgentResult, AgentEventCallback } from "./types.js";

// ── Model name constants (each overridable via env) ───────────────────────────

export const CLAUDE_HAIKU_MODEL  = process.env.CLAUDE_HAIKU_MODEL  ?? "claude-haiku-4-5";
export const CLAUDE_SONNET_MODEL = process.env.CLAUDE_SONNET_MODEL ?? "claude-sonnet-4-5";
export const CLAUDE_OPUS_MODEL   = process.env.CLAUDE_OPUS_MODEL   ?? "claude-opus-4-5";
export const CODEX_MODEL         = process.env.CODEX_MODEL         ?? "gpt-5";

// Sentinel error strings used by spawnClaude to signal the caller to failover.
export const ERR_RATE_LIMITED = "rate_limited";
export const ERR_UNAVAILABLE  = "provider_unavailable";

// ── Claude block state ────────────────────────────────────────────────────────

let claudeBlockedUntilMs = 0;

/** Mark Claude as rate-limited until `ms` (epoch ms). Ignored if already earlier. */
export function setClaudeBlockedUntil(ms: number): void {
  if (ms > claudeBlockedUntilMs) {
    claudeBlockedUntilMs = ms;
  }
}

/** Test-only: clear the block. */
export function resetClaudeBlock(): void {
  claudeBlockedUntilMs = 0;
}

/** Returns true if Claude is currently known to be rate-limited. */
export function isClaudeBlocked(): boolean {
  return Date.now() < claudeBlockedUntilMs;
}

/** Returns the epoch ms timestamp until which Claude is blocked (0 = not blocked). */
export function claudeBlockedUntil(): number {
  return claudeBlockedUntilMs;
}

/**
 * Parse a reset time from Claude's rate-limit error text, e.g.
 * "You've hit your limit · resets 5:30pm (Australia/Melbourne)"
 * Returns epoch ms, or null if unparseable.
 */
export function parseResetTimeMs(text: string): number | null {
  const m = text.match(/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+\(([^)]+)\)/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  const tz = m[4];

  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  try {
    const now = new Date();

    // Get today's date in the target timezone.
    const todayParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
    }).formatToParts(now);
    const gp = (type: string) => parseInt(todayParts.find(p => p.type === type)!.value, 10);
    const year = gp("year"), month = gp("month"), day = gp("day");

    // Treat the target wall-clock time as a "UTC" number to use as an offset anchor.
    const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

    // Find what the timezone actually displays for that same numeric instant.
    const displayParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(targetAsUtcMs));
    const dp = (type: string) => parseInt(displayParts.find(p => p.type === type)!.value, 10);
    const dispAsUtcMs = Date.UTC(dp("year"), dp("month") - 1, dp("day"), dp("hour") % 24, dp("minute"), 0);

    // The real UTC timestamp = guess + (target_display - actual_display).
    let resetMs = targetAsUtcMs + (targetAsUtcMs - dispAsUtcMs);

    // If that moment has already passed, push to the same time tomorrow.
    if (resetMs <= now.getTime()) resetMs += 24 * 60 * 60 * 1000;
    return resetMs;
  } catch {
    return null;
  }
}

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
 * If `provider` is set (via LOCAL_LLM_PROVIDER env), passes
 * --oss --local-provider <provider> to use a local model (e.g. ollama).
 * Without it, codex runs against the hosted Codex backend using CODEX_MODEL.
 * Optionally reads CODEX_ENDPOINT to set OPENAI_BASE_URL for proxies.
 */
export function buildCodexExecArgs(provider?: string): {
  args: string[];
  providerLabel: string;
  modelLabel: string;
} {
  if (provider) {
    const localModel = process.env.LOCAL_LLM_MODEL ?? "qwen3.5";
    return {
      args: ["exec", "--oss", "--local-provider", provider, "-m", localModel, "--dangerously-bypass-approvals-and-sandbox"],
      providerLabel: provider,
      modelLabel: localModel,
    };
  }

  return {
    args: ["exec", "-m", CODEX_MODEL, "--dangerously-bypass-approvals-and-sandbox"],
    providerLabel: "codex",
    modelLabel: CODEX_MODEL,
  };
}

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

    const { args, providerLabel } = buildCodexExecArgs(provider);

    // `--dangerously-bypass-approvals-and-sandbox` runs without confirmation prompts.
    const proc = spawn(
      "codex",
      [...args, prompt],
      { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );

    if (proc.pid) onEvent({ type: "process_spawned", pid: proc.pid, provider: providerLabel });

    let hasOutput = false;
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) hasOutput = true;
      if (text.trim()) stdoutBuf.push(text.trim());
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
        resolve({
          success: true,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 1,
          completionSummary: stdoutBuf.join("\n").trim().slice(0, 4000) || undefined,
        });
      } else {
        const err = stderrBuf.join("; ") || `codex exit ${code}`;
        onEvent({ type: "turn_failed", message: err, provider: providerLabel });
        resolve({
          success: false,
          error: err,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 0,
          completionSummary: stdoutBuf.join("\n").trim().slice(0, 4000) || undefined,
        });
      }
    });

    proc.on("error", (e) => {
      abortController.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
