#!/usr/bin/env node
/**
 * symphony-posthog — one-shot: pull PostHog error-tracking reports and file a
 * Linear ticket for each new one.
 *
 * Reads credentials from the environment (loaded from `.env` via dotenv):
 *   POSTHOG_HOST              e.g. https://us.posthog.com
 *   POSTHOG_PROJECT_ID        e.g. 49303
 *   POSTHOG_PERSONAL_API_KEY  a personal API key (phx_…), used as a Bearer token
 *   LINEAR_API_KEY            for creating the tickets
 *
 * Linear team/state/label come from WORKFLOW.md (the `posthog:` block, falling
 * back to `tracker:`). This run ignores `posthog.enabled` and the daily
 * interval gate — it always pulls once — but still dedupes against existing
 * tickets and respects max_open_tickets / max_tickets_per_run.
 *
 * Usage:
 *   symphony-posthog [WORKFLOW.md] [--dry-run] [--status active|resolved|suppressed|all]
 *
 *   --dry-run   pull and print the reports; do NOT create any Linear tickets.
 */
import "dotenv/config";
import * as path from "node:path";
import { loadWorkflow } from "./config.js";
import { HttpPostHogReportsClient, PostHogWatcher } from "./posthog.js";
import type { Logger, PostHogConfig } from "./types.js";

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
  status?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dryRun = false;
  let status: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--status" && args[i + 1]) { status = args[++i].toLowerCase(); }
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: symphony-posthog [WORKFLOW.md] [--dry-run] [--status active|resolved|suppressed|all]\n",
      );
      process.exit(0);
    } else if (!a.startsWith("--")) positional.push(a);
  }

  return {
    workflowPath: positional[0] ?? path.join(process.cwd(), "WORKFLOW.md"),
    dryRun,
    status,
  };
}

async function main(): Promise<void> {
  const { workflowPath, dryRun, status } = parseArgs(process.argv);
  const logger = createLogger();

  const workflow = loadWorkflow(workflowPath);
  const tracker = workflow.config.tracker;
  // The CLI run is explicit, so force-enable and apply any --status override.
  const cfg: PostHogConfig = {
    ...workflow.config.posthog,
    enabled: true,
    status: status ?? workflow.config.posthog.status,
  };

  const missing: string[] = [];
  if (!cfg.host) missing.push("POSTHOG_HOST");
  if (!cfg.projectId) missing.push("POSTHOG_PROJECT_ID");
  if (!cfg.apiKey) missing.push("POSTHOG_PERSONAL_API_KEY");
  if (!dryRun && !tracker.apiKey) missing.push("LINEAR_API_KEY");
  if (missing.length > 0) {
    logger.error(`Missing required credentials: ${missing.join(", ")}. Set them in .env or the environment.`);
    process.exit(1);
  }
  if (!dryRun && (!cfg.teamKey || !cfg.targetState)) {
    logger.error("posthog.team_key and posthog.target_state are required to create tickets (set them, or tracker.team_key + active_states, in WORKFLOW.md). Use --dry-run to pull without filing.");
    process.exit(1);
  }

  if (dryRun) {
    const client = new HttpPostHogReportsClient(logger);
    const reports = await client.listReports(cfg);
    const eligible = reports
      .filter(r => r.occurrences >= cfg.minOccurrences)
      .sort((a, b) => b.occurrences - a.occurrences);
    logger.info(`Pulled ${reports.length} PostHog report(s); ${eligible.length} above the occurrence floor`, {
      project_id: cfg.projectId,
      status: cfg.status,
      min_occurrences: cfg.minOccurrences,
    });
    for (const r of eligible) {
      process.stdout.write(
        `• [${r.occurrences}×] ${r.name}  (${r.status})  ${r.url}\n`,
      );
    }
    process.stdout.write(`\n(dry run — no Linear tickets created)\n`);
    return;
  }

  const watcher = new PostHogWatcher({ config: cfg, tracker, logger });
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
  process.stderr.write(`symphony-posthog failed: ${fmtErr(e)}\n`);
  process.exit(1);
});
