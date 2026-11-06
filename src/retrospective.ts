import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Liquid } from "liquidjs";
import type { Issue, Logger, RetrospectiveConfig } from "./types.js";
import { trackTokenProcess } from "./usage-budget.js";
import { claudeEffortArgs, claudeModelArgs } from "./llm.js";
import { readLessons } from "./lessons.js";

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export interface RetrospectiveContext {
  issue: Issue;
  workspacePath: string;
  symphonyRoot: string;
  terminalState: string;
  config: RetrospectiveConfig;
  mcpConfigPath: string | undefined;
  logger: Logger;
  /** One line per agent run for this ticket (from the run log), so the retro sees retries and cost. */
  runHistory?: string;
  /**
   * Run even when the workspace is gone (Linear, the PR and run history suffice). Only the
   * improvement loop sets this: it picks tickets itself, a few at a time. The orchestrator's
   * terminal-state path sees every Done ticket in Linear's history at startup, so it must keep
   * skipping tickets without a workspace.
   */
  allowMissingWorkspace?: boolean;
}

/** Tickets with a retrospective in progress, so two triggers for one ticket don't both run. */
const inFlight = new Set<string>();
/** Hard cap on retrospectives running at once, whatever triggers them. */
export const MAX_CONCURRENT_RETROS = 2;

/** True when lessons.jsonl already has an entry for this ticket. */
export function hasLesson(lessonsPath: string, identifier: string): boolean {
  return readLessons(lessonsPath).some(l => l.ticket === identifier);
}

/**
 * Render the retrospective prompt for a terminal-state issue.
 *
 * The retrospective sub-agent's prompt is `prompts/RETROSPECTIVE.md` from the
 * Symphony root, with Liquid variables filled in. Exposed for testing.
 */
export function renderRetrospectivePrompt(
  promptTemplate: string,
  ctx: RetrospectiveContext,
): string {
  return liquid.parseAndRenderSync(promptTemplate, {
    issue: {
      id: ctx.issue.id,
      identifier: ctx.issue.identifier,
      title: ctx.issue.title,
      url: ctx.issue.url,
      state: ctx.terminalState,
      labels: ctx.issue.labels,
    },
    workspace: ctx.workspacePath,
    workspace_available: fs.existsSync(ctx.workspacePath),
    run_history: ctx.runHistory ?? "",
    lessons_path: ctx.config.lessonsPath,
    symphony: { root: ctx.symphonyRoot },
  });
}

/**
 * Run the retrospective sub-agent for a ticket that just reached a terminal
 * state. Best-effort: failures are logged and swallowed — never block workspace
 * cleanup or other orchestrator work on a retrospective.
 *
 * Returns once the Claude process exits or `timeoutMs` elapses (whichever first).
 */
export async function runRetrospective(ctx: RetrospectiveContext): Promise<void> {
  if (!ctx.config.enabled) return;
  const key = ctx.issue.identifier;
  if (!ctx.allowMissingWorkspace && !fs.existsSync(ctx.workspacePath)) {
    ctx.logger.info("Retrospective skipped: workspace missing", { issue_identifier: key, workspace: ctx.workspacePath });
    return;
  }
  if (inFlight.has(key) || hasLesson(ctx.config.lessonsPath, key)) return;
  if (inFlight.size >= MAX_CONCURRENT_RETROS) {
    ctx.logger.info("Retrospective skipped: too many running", { issue_identifier: key, running: inFlight.size });
    return;
  }
  inFlight.add(key);
  try {
    await runOnce(ctx);
  } finally {
    inFlight.delete(key);
  }
}

async function runOnce(ctx: RetrospectiveContext): Promise<void> {
  // A missing workspace (cleaned up, or the ticket finished through review long
  // after the agent did) no longer skips the retro: Linear, the PR and the run
  // history still tell most of the story. The agent runs in an empty folder.
  let cwd = ctx.workspacePath;
  let scratch: string | null = null;
  if (!fs.existsSync(cwd)) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), `symphony-retro-${ctx.issue.identifier}-`));
    cwd = scratch;
  }
  try {
    await runIn(ctx, cwd);
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function runIn(ctx: RetrospectiveContext, cwd: string): Promise<void> {

  const promptPath = path.join(ctx.symphonyRoot, "prompts", "RETROSPECTIVE.md");
  if (!fs.existsSync(promptPath)) {
    ctx.logger.warn("Retrospective skipped: prompt missing", { prompt_path: promptPath });
    return;
  }

  ensureLessonsDirectory(ctx.config.lessonsPath, ctx.logger);

  let prompt: string;
  try {
    const template = fs.readFileSync(promptPath, "utf-8");
    prompt = renderRetrospectivePrompt(template, ctx);
  } catch (e) {
    ctx.logger.warn("Retrospective prompt render failed", {
      issue_identifier: ctx.issue.identifier,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const startedAt = Date.now();
  ctx.logger.info("Starting retrospective", {
    issue_identifier: ctx.issue.identifier,
    terminal_state: ctx.terminalState,
  });

  try {
    await spawnRetrospectiveClaude(prompt, ctx, cwd);
    ctx.logger.info("Retrospective completed", {
      issue_identifier: ctx.issue.identifier,
      duration_s: ((Date.now() - startedAt) / 1000).toFixed(1),
    });
  } catch (e) {
    ctx.logger.warn("Retrospective failed (non-fatal)", {
      issue_identifier: ctx.issue.identifier,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function ensureLessonsDirectory(lessonsPath: string, logger: Logger): void {
  const dir = path.dirname(lessonsPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logger.warn("Could not ensure lessons directory", {
      dir,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function spawnRetrospectiveClaude(prompt: string, ctx: RetrospectiveContext, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || v === "") continue;
      childEnv[k] = v;
    }
    childEnv.SYMPHONY_RETROSPECTIVE_TICKET = ctx.issue.identifier;
    childEnv.SYMPHONY_RETROSPECTIVE_LESSONS_PATH = ctx.config.lessonsPath;

    const mcpArgs = ctx.mcpConfigPath ? ["--mcp-config", ctx.mcpConfigPath] : [];

    const proc = spawn(
      "claude",
      [
        "-p",
        "--strict-mcp-config", // never load the operator's personal MCP servers
        ...claudeModelArgs(), ...claudeEffortArgs(),
        ...mcpArgs,
        "--max-turns", String(ctx.config.maxTurns),
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
    trackTokenProcess(proc, "retrospective");

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", () => { /* drain stdout to keep the pipe flowing; we don't need the events */ });

    proc.stderr.on("data", () => { /* drain */ });

    const timeoutMs = ctx.config.timeoutMs;
    const timer = setTimeout(() => {
      ctx.logger.warn("Retrospective timed out, killing claude", {
        issue_identifier: ctx.issue.identifier,
        timeout_ms: timeoutMs,
      });
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000);
      settle(() => reject(new Error(`retrospective timeout after ${timeoutMs}ms`)));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      rl.close();
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(`claude exited with code ${code ?? "null"}`));
      });
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      settle(() => reject(e));
    });
  });
}
