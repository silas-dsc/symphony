#!/usr/bin/env node
/**
 * symphony-ux-insights — one-shot: pull PostHog behavioural data, synthesise
 * UX/product insights with Claude, post the report to Slack, and file a Linear
 * ticket for each new high-confidence actionable insight (TEA-4562).
 *
 * Reads credentials from the environment (loaded from `.env` via dotenv):
 *   POSTHOG_HOST / POSTHOG_PROJECT_ID / POSTHOG_PERSONAL_API_KEY  (shared with the posthog watcher)
 *   SLACK_BOT_TOKEN  (for posting the report)
 *   LINEAR_API_KEY   (for filing tickets)
 *
 * Config comes from the `ux_insights:` block in WORKFLOW.md. This run ignores
 * `ux_insights.enabled` and the weekly interval gate — it always pulls once — but
 * still dedupes against existing tickets and respects the open/per-run caps.
 *
 * Usage:
 *   symphony-ux-insights [WORKFLOW.md] [--dry-run] [--lookback-days N]
 *
 *   --dry-run   pull + synthesise + print the report; do NOT post to Slack or file tickets.
 */
import "dotenv/config";
import * as path from "node:path";
import { loadWorkflow } from "./config.js";
import { UxInsightsWatcher } from "./ux-insights.js";
import type { Logger, UxInsightsConfig } from "./types.js";

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
  lookbackDays?: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dryRun = false;
  let lookbackDays: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--lookback-days" && args[i + 1]) { lookbackDays = parseInt(args[++i], 10); }
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: symphony-ux-insights [WORKFLOW.md] [--dry-run] [--lookback-days N]\n",
      );
      process.exit(0);
    } else if (!a.startsWith("--")) positional.push(a);
  }

  return {
    workflowPath: positional[0] ?? path.join(process.cwd(), "WORKFLOW.md"),
    dryRun,
    lookbackDays,
  };
}

async function main(): Promise<void> {
  const { workflowPath, dryRun, lookbackDays } = parseArgs(process.argv);
  const logger = createLogger();

  const workflow = loadWorkflow(workflowPath);
  const tracker = workflow.config.tracker;
  // The CLI run is explicit, so force-enable and apply any --lookback-days override.
  const cfg: UxInsightsConfig = {
    ...workflow.config.uxInsights,
    enabled: true,
    lookbackDays: lookbackDays ?? workflow.config.uxInsights.lookbackDays,
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
    logger.error("ux_insights.team_key and ux_insights.target_state are required to file tickets (set them, or tracker.team_key + active_states, in WORKFLOW.md). Use --dry-run to pull without posting or filing.");
    process.exit(1);
  }

  const watcher = new UxInsightsWatcher({ config: cfg, tracker, logger });
  const { report, created } = await watcher.runOnce({ skipSlack: dryRun, skipTickets: dryRun });

  if (!report) {
    logger.info("No report produced (no behavioural data in the window, or synthesis failed).");
    return;
  }

  process.stdout.write(`\n${report.summary}\n\n`);
  for (const insight of report.insights) {
    const rec = insight.recommendation ? ` → ${insight.recommendation}` : "";
    process.stdout.write(`• [${insight.confidence}] (${insight.category}) ${insight.title}${rec}\n`);
  }

  if (dryRun) {
    process.stdout.write(`\n(dry run — no Slack post, no Linear tickets created)\n`);
    return;
  }

  if (created.length === 0) {
    logger.info("No new Linear tickets created (nothing above the confidence bar, or all already ticketed).");
  } else {
    logger.info(`Created ${created.length} Linear ticket(s)`);
    for (const t of created) process.stdout.write(`• ${t.identifier}  ${t.url ?? ""}\n`);
  }
}

main().catch(e => {
  process.stderr.write(`symphony-ux-insights failed: ${fmtErr(e)}\n`);
  process.exit(1);
});
