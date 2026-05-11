#!/usr/bin/env node
import "dotenv/config";
import * as path from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { startStatusServer, type StatusServer } from "./server.js";
import { SelfUpdater } from "./self-update.js";
import type { Logger } from "./types.js";

const DEFAULT_STATUS_PORT = 7777;
/** Exit code used to tell the supervisor wrapper to restart Symphony. */
const RESTART_EXIT_CODE = 75;

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function createLogger(): Logger {
  function log(level: string, msg: string, context?: Record<string, unknown>): void {
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
  const { workflowPath, port: portArg } = parseArgs(process.argv);
  const logger = createLogger();

  logger.info("Initializing Symphony", { workflow_path: workflowPath });

  let orchestrator: Orchestrator;
  try {
    orchestrator = new Orchestrator(workflowPath, logger);
  } catch (e) {
    logger.error(`Failed to load WORKFLOW.md: ${fmtErr(e)}`);
    process.exit(1);
  }

  // Port precedence: CLI flag > workflow config > default 7777.
  const cfgPort = orchestrator.getConfigSnapshot().server?.port;
  const port = portArg ?? cfgPort ?? DEFAULT_STATUS_PORT;

  let statusServer: StatusServer | null = null;
  let selfUpdater: SelfUpdater | null = null;
  let stopping = false;

  const shutdown = async (exitCode: number = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutdown requested", { exit_code: String(exitCode) });

    selfUpdater?.stop();

    if (statusServer) {
      try {
        await statusServer.close();
      } catch (e) {
        logger.warn(`Status server close failed: ${fmtErr(e)}`);
      }
    }

    try {
      await orchestrator.shutdown();
    } catch (e) {
      logger.warn(`Orchestrator shutdown failed: ${fmtErr(e)}`);
    }

    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  try {
    await orchestrator.start();
  } catch (e) {
    logger.error(`Symphony failed to start: ${fmtErr(e)}`);
    process.exit(1);
  }

  // Status HTTP server (loopback only). Failure here shouldn't bring down the orchestrator.
  try {
    statusServer = await startStatusServer(orchestrator, port, logger);
  } catch (e) {
    logger.warn(`Status server failed to start on port ${port}: ${fmtErr(e)}`);
  }

  // Self-updater: periodically pull new commits, rebuild, then exit with
  // RESTART_EXIT_CODE so the supervisor wrapper relaunches us on fresh code.
  selfUpdater = new SelfUpdater({
    config: orchestrator.getConfigSnapshot().autoUpdate,
    logger,
    onRestartRequested: () => void shutdown(RESTART_EXIT_CODE),
  });
  selfUpdater.start().catch(e => logger.warn(`Self-updater failed to start: ${String(e)}`));

  // Print a human-friendly status line every 60s
  setInterval(() => {
    const snap = orchestrator.getSnapshot();
    logger.info("Status snapshot", {
      running: snap.counts.running,
      retrying: snap.counts.retrying,
      total_tokens: snap.totals.total_tokens,
    });
  }, 60_000);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
