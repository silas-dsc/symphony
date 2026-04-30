#!/usr/bin/env node
import "dotenv/config";
import * as path from "node:path";
import { Orchestrator } from "./orchestrator.js";
import type { Logger } from "./types.js";

function createLogger(): Logger {
  function log(level: string, msg: string, context?: Record<string, string>): void {
    const line: Record<string, unknown> = {
      level,
      message: msg,
      timestamp: new Date().toISOString(),
    };
    if (context && Object.keys(context).length > 0) line.context = context;
    const output = JSON.stringify(line);
    if (level === "error" || level === "warn") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  }
  return {
    info: (msg, ctx) => log("info", msg, ctx),
    warn: (msg, ctx) => log("warn", msg, ctx),
    error: (msg, ctx) => log("error", msg, ctx),
  };
}

function parseArgs(argv: string[]): { workflowPath: string; port?: number } {
  const args = argv.slice(2);

  let port: number | undefined;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
  }

  const logsIdx = args.indexOf("--logs-root");
  const filteredArgs = args.filter((a, i) => {
    if (a === "--port" || a === "--logs-root") return false;
    if (i > 0 && (args[i - 1] === "--port" || args[i - 1] === "--logs-root")) return false;
    return true;
  });

  const workflowPath = filteredArgs.find(a => !a.startsWith("--")) ??
    path.join(process.cwd(), "WORKFLOW.md");

  return { workflowPath, port };
}

async function main(): Promise<void> {
  const { workflowPath } = parseArgs(process.argv);
  const logger = createLogger();

  logger.info("Initializing Symphony", { workflow_path: workflowPath });

  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator(workflowPath, logger);
  } catch (e) {
    logger.error(`Failed to load WORKFLOW.md: ${String(e)}`);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutdown requested");
    orchestrator.stop();
    // Give in-flight agents a moment to clean up
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await orchestrator.start();
  } catch (e) {
    logger.error(`Symphony failed to start: ${String(e)}`);
    process.exit(1);
  }

  // Print a human-friendly status line every 60s
  setInterval(() => {
    const snap = orchestrator.getSnapshot();
    logger.info("Status snapshot", {
      running: String(snap.counts.running),
      retrying: String(snap.counts.retrying),
      total_tokens: String(snap.codex_totals.total_tokens),
    });
  }, 60_000);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
