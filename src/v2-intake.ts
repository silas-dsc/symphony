import type { ErrorSource } from "./deploy-guard.js";
import type { GateHub } from "./gate-hub.js";
import { HttpRenderLogsClient, RenderLogsWatcher, fetchErrorSignatures, renderLogsConfigWithDefaults, type RenderLogsConfig } from "./render-logs.js";
import { SlackIntakeWatcher, slackIntakeConfigWithDefaults, type SlackIntakeConfig } from "./slack-intake.js";
import { TriageWatcher, applyTriageDecision, triageConfigWithDefaults, type TriageConfig } from "./triage.js";
import type { Logger, WorkflowConfig } from "./types.js";

/**
 * Wires the v2 intake (Slack, Render logs) and triage watchers from the
 * `v2.slack_intake` / `v2.render_logs` / `v2.triage` blocks (snake_case keys,
 * `$ENV` values allowed). Unclear triage items become one-click cards.
 */

export interface Reconcilable {
  name: string;
  reconcile(): Promise<unknown>;
}

type Raw = Record<string, unknown>;

/** snake_case → camelCase, resolving `$ENV` strings. Arrays may be a comma list. */
function camel(raw: Raw, arrays: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    let val: unknown = typeof v === "string" && v.startsWith("$") ? process.env[v.slice(1)] ?? "" : v;
    if (arrays.includes(key) && typeof val === "string") val = val.split(",").map(s => s.trim()).filter(Boolean);
    out[key] = val;
  }
  return out;
}

const PRIORITY_NAME: Record<number, string> = { 0: "None", 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };

export function triageConfig(cfg: WorkflowConfig, state: (n: string) => string): TriageConfig {
  return triageConfigWithDefaults({ teamKey: cfg.v2.teamKey, statePath: state("triage.json"), ...(camel(cfg.v2.triage) as Partial<TriageConfig>) });
}

export function slackIntakeConfig(cfg: WorkflowConfig, state: (n: string) => string): SlackIntakeConfig {
  return slackIntakeConfigWithDefaults({
    teamKey: cfg.v2.teamKey,
    statePath: state("slack-intake.json"),
    botToken: cfg.v2.slack.botToken,
    ...(camel(cfg.v2.slackIntake, ["channels", "reporterUserIds"]) as Partial<SlackIntakeConfig>),
  });
}

export function renderConfig(cfg: WorkflowConfig): RenderLogsConfig {
  return renderLogsConfigWithDefaults({ teamKey: cfg.v2.teamKey, ...(camel(cfg.v2.renderLogs, ["serviceIds"]) as Partial<RenderLogsConfig>) });
}

export function createIntakeWatchers(cfg: WorkflowConfig, hub: GateHub, state: (n: string) => string, log: Logger): Reconcilable[] {
  const out: Reconcilable[] = [];

  const slack = slackIntakeConfig(cfg, state);
  if (slack.enabled) out.push(Object.assign(new SlackIntakeWatcher({ config: slack, tracker: cfg.tracker, logger: log }), { name: "slack intake" }));

  const render = renderConfig(cfg);
  if (render.enabled) out.push(Object.assign(new RenderLogsWatcher({ config: render, tracker: cfg.tracker, logger: log }), { name: "render logs" }));

  const triage = triageConfig(cfg, state);
  if (triage.enabled) {
    hub.onKind("triage_decision", async r => {
      const { gate, decision } = r;
      if (!gate.issueId) return;
      if (decision.actionId === "confirm") {
        await applyTriageDecision(cfg.tracker, gate.issueId, {
          priority: gate.meta?.priority ? Number(gate.meta.priority) : undefined,
          state: gate.meta?.state || undefined,
        });
      } else if (decision.actionKind === "reject") {
        await applyTriageDecision(cfg.tracker, gate.issueId, { state: "Canceled" });
      }
    });
    out.push(Object.assign(new TriageWatcher({
      config: triage,
      tracker: cfg.tracker,
      logger: log,
      onUnclear: async (issue, s) => {
        await hub.open({
          kind: "triage_decision",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          title: `${issue.identifier} ${issue.title}`.slice(0, 120),
          summary: `Suggested: ${PRIORITY_NAME[s.priority] ?? s.priority} priority → ${s.state ?? "leave in Triage"}.\nWhy unsure: ${s.reasons.join("; ") || "not enough detail"}.`,
          question: "Use the suggestion?",
          links: issue.url ? [{ label: issue.identifier, url: issue.url }] : [],
          meta: { priority: String(s.priority), state: s.state ?? "" },
        });
      },
    }), { name: "triage" }));
  }
  return out;
}

/** Render error signatures for the deploy guard, when Render credentials are set. */
export function renderErrorSource(cfg: WorkflowConfig, _log: Logger): ErrorSource | null {
  const render = renderConfig(cfg);
  if (!render.apiKey || !render.ownerId || render.serviceIds.length === 0) return null;
  const client = new HttpRenderLogsClient(render);
  return (sinceIso, untilIso) => fetchErrorSignatures(client, sinceIso, untilIso);
}
