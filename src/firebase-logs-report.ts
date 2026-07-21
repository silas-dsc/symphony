#!/usr/bin/env node
/**
 * symphony-firebase-logs — one-shot: scan Firebase (Cloud) function logs for
 * errors and file a Linear ticket for each new *fixable* error signature.
 *
 * Reads the GCP project from WORKFLOW.md (the `firebase_logs:` block, falling
 * back to `query_insights.project_id`, then $GCLOUD_PROJECT / $FIREBASE_PROJECT_ID)
 * and uses the `gcloud` CLI (which must be authenticated with Logs Viewer access)
 * to read the logs. Linear team/state/label come from WORKFLOW.md; LINEAR_API_KEY
 * from the environment. This run ignores `firebase_logs.enabled` and the interval
 * gate — it always scans once — but still dedupes against existing tickets and
 * respects max_open_tickets / max_tickets_per_run.
 *
 * Usage:
 *   symphony-firebase-logs [WORKFLOW.md] [--dry-run] [--hours N] [--severity ERROR|WARNING|CRITICAL]
 *
 *   --dry-run   scan and print the grouped errors; do NOT create any Linear tickets.
 */
import "dotenv/config";
import * as path from "node:path";
import { loadWorkflow } from "./config.js";
import {
  FirebaseLogsWatcher,
  GcloudFirebaseLogsClient,
  groupErrors,
  isFixableError,
  severityRank,
} from "./firebase-logs.js";
import type { FirebaseLogsConfig, Logger } from "./types.js";

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function createLogger(): Logger {
  function log(level: string, msg: string, context?: Record<string, unknown>): void {
    const line: Record<string, unknown> = { level, message: msg, timestamp: new Date().toISOString() };
    if (context && Object.keys(context).length > 0) line.context = context;
    const out = JSON.stringify(line);
    if (level === "error" || level === "warn") process.stderr.write(out + "\n");
    else process.stdout.write(out + "\n");
  }
  return {
    info: (m, c) => log("info", m, c),
    warn: (m, c) => log("warn", m, c),
    error: (m, c) => log("error", m, c),
  };
}

interface Args {
  workflowPath: string;
  dryRun: boolean;
  hours?: number;
  severity?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dryRun = false;
  let hours: number | undefined;
  let severity: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--hours" && args[i + 1]) { hours = parseInt(args[++i], 10); }
    else if (a === "--severity" && args[i + 1]) { severity = args[++i].toUpperCase(); }
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: symphony-firebase-logs [WORKFLOW.md] [--dry-run] [--hours N] [--severity ERROR|WARNING|CRITICAL]\n",
      );
      process.exit(0);
    } else if (!a.startsWith("--")) positional.push(a);
  }

  return {
    workflowPath: positional[0] ?? path.join(process.cwd(), "WORKFLOW.md"),
    dryRun,
    hours,
    severity,
  };
}

async function main(): Promise<void> {
  const { workflowPath, dryRun, hours, severity } = parseArgs(process.argv);
  const logger = createLogger();

  const workflow = loadWorkflow(workflowPath);
  const tracker = workflow.config.tracker;
  // The CLI run is explicit, so force-enable and apply any --hours / --severity override.
  const cfg: FirebaseLogsConfig = {
    ...workflow.config.firebaseLogs,
    enabled: true,
    lookbackHours: hours ?? workflow.config.firebaseLogs.lookbackHours,
    minSeverity: severity ?? workflow.config.firebaseLogs.minSeverity,
  };

  if (!cfg.projectId) {
    logger.error("No GCP project id resolved. Set firebase_logs.project_id (or query_insights.project_id) in WORKFLOW.md, or $GCLOUD_PROJECT / $FIREBASE_PROJECT_ID.");
    process.exit(1);
  }
  if (!dryRun && !tracker.apiKey) {
    logger.error("LINEAR_API_KEY is required to create tickets. Set it in .env, or use --dry-run to scan without filing.");
    process.exit(1);
  }
  if (!dryRun && (!cfg.teamKey || !cfg.targetState)) {
    logger.error("firebase_logs.team_key and firebase_logs.target_state are required to create tickets (set them, or tracker.team_key + active_states, in WORKFLOW.md). Use --dry-run to scan without filing.");
    process.exit(1);
  }

  if (dryRun) {
    const client = new GcloudFirebaseLogsClient(logger);
    const entries = await client.fetchErrorLogs(cfg);
    const groups = groupErrors(entries)
      .filter(g => isFixableError(g.sample) && g.count >= cfg.minOccurrences)
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count);
    logger.info(`Scanned ${entries.length} log entrie(s); ${groups.length} fixable error signature(s) above the occurrence floor`, {
      project_id: cfg.projectId,
      severity: cfg.minSeverity,
      lookback_hours: cfg.lookbackHours,
      min_occurrences: cfg.minOccurrences,
    });
    for (const g of groups) {
      const firstLine = (g.sample.split("\n")[0] ?? g.signature).trim();
      process.stdout.write(`• [${g.severity} ${g.count}×] ${g.functionName}: ${firstLine}\n`);
    }
    process.stdout.write(`\n(dry run — no Linear tickets created)\n`);
    return;
  }

  const watcher = new FirebaseLogsWatcher({ config: cfg, tracker, logger });
  const created = await watcher.runOnce();

  if (created.length === 0) {
    logger.info("No new Linear tickets created (nothing new above threshold, or all already ticketed).");
  } else {
    logger.info(`Created ${created.length} Linear ticket(s)`);
    for (const t of created) {
      process.stdout.write(`• ${t.identifier}  ${t.url ?? ""}\n`);
    }
  }
}

main().catch(e => {
  process.stderr.write(`symphony-firebase-logs failed: ${fmtErr(e)}\n`);
  process.exit(1);
});
