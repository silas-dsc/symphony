import * as path from "node:path";
import type { PersonConfig } from "./gate-hub.js";
import type { GovernorConfig } from "./governor.js";

/**
 * `v2:` block in WORKFLOW.md — Symphony v2 (docs/ORCHESTRATOR_REDESIGN.md).
 * Everything is off unless `v2.enabled: true`; each sub-feature has its own
 * `enabled` so it can be turned on one at a time.
 */

export interface V2Config {
  enabled: boolean;
  teamKey: string;
  /** Person key of the operator (gets every card first). */
  operatorKey: string;
  people: PersonConfig[];
  designPerson: string | null;
  productPerson: string | null;
  /** Folder for v2 runtime state (gates, flow state, report clock). */
  stateDir: string;
  slack: {
    botToken: string;
    /** Socket Mode app-level token (xapp-…). Without it, cards still go out but buttons won't respond — reply on Linear instead. */
    appToken: string;
    /** Channel the daily update is posted to when you tap Post. */
    reportChannel: string;
  };
  review: {
    enabled: boolean;
    state: string;
    reworkState: string;
    mergedState: string | null;
    autoMerge: boolean;
    maxAutoSendBacks: number;
  };
  deployGuard: {
    enabled: boolean;
    watchMinutes: number;
    minNewOccurrences: number;
  };
  governor: GovernorConfig & { enabled: boolean };
  reports: {
    enabled: boolean;
    dailyHourLocal: number;
    weeklyDay: number;
    weeklyHourLocal: number;
  };
  /** Raw sub-blocks parsed by their own modules (triage.ts, slack-intake.ts, render-logs.ts). */
  triage: Record<string, unknown>;
  slackIntake: Record<string, unknown>;
  renderLogs: Record<string, unknown>;
}

export interface V2ParseContext {
  baseDir: string;
  fallbackBotToken: string;
  fallbackChannel: string;
  fallbackTeamKey: string;
  resolveEnvVar: (v: string) => string;
  resolvePath: (v: string, baseDir: string) => string;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

export function parseV2Config(raw: Raw, ctx: V2ParseContext): V2Config {
  const env = (v: unknown, d = ""): string => (typeof v === "string" ? ctx.resolveEnvVar(v).trim() : d);
  const slack = obj(raw.slack);
  const review = obj(raw.review);
  const guard = obj(raw.deploy_guard);
  const gov = obj(raw.governor);
  const reports = obj(raw.reports);

  const peopleRaw = Array.isArray(raw.people) ? (raw.people as unknown[]) : [];
  const people: PersonConfig[] = peopleRaw.map(p => obj(p)).map(p => ({
    key: String(p.key ?? "").toLowerCase(),
    name: String(p.name ?? p.key ?? ""),
    slackUserId: env(p.slack_user_id) || null,
    linearUser: env(p.linear_user) || null,
    maxOpenGates: num(p.max_open_gates, 10),
    maxNewGatesPerHour: num(p.max_new_gates_per_hour, 6),
  }));
  const operatorKey = String(raw.operator ?? people[0]?.key ?? "operator").toLowerCase();
  if (!people.some(p => p.key === operatorKey)) {
    people.unshift({ key: operatorKey, name: operatorKey, slackUserId: null, linearUser: null, maxOpenGates: 10, maxNewGatesPerHour: 6 });
  }

  return {
    enabled: bool(raw.enabled, false),
    teamKey: env(raw.team_key) || ctx.fallbackTeamKey,
    operatorKey,
    people,
    designPerson: raw.design_person ? String(raw.design_person).toLowerCase() : null,
    productPerson: raw.product_person ? String(raw.product_person).toLowerCase() : null,
    stateDir: typeof raw.state_dir === "string" ? ctx.resolvePath(raw.state_dir, ctx.baseDir) : path.join(ctx.baseDir, ".symphony-state"),
    slack: {
      botToken: env(slack.bot_token) || ctx.fallbackBotToken,
      appToken: env(slack.app_token, ""),
      reportChannel: env(slack.report_channel) || ctx.fallbackChannel,
    },
    review: {
      enabled: bool(review.enabled, true),
      state: String(review.state ?? "In Review"),
      reworkState: String(review.rework_state ?? "Dev in Progress"),
      mergedState: typeof review.merged_state === "string" && review.merged_state ? review.merged_state : null,
      autoMerge: bool(review.auto_merge, true),
      maxAutoSendBacks: num(review.max_auto_send_backs, 2),
    },
    deployGuard: {
      enabled: bool(guard.enabled, true),
      watchMinutes: num(guard.watch_minutes, 30),
      minNewOccurrences: num(guard.min_new_occurrences, 3),
    },
    governor: {
      enabled: bool(gov.enabled, true),
      weeklyBudgetUsd: typeof gov.weekly_budget_usd === "number" ? gov.weekly_budget_usd : null,
      dailyShare: num(gov.daily_share, 0.2),
      reserveShare: num(gov.reserve_share, 0.2),
    },
    reports: {
      enabled: bool(reports.enabled, true),
      dailyHourLocal: num(reports.daily_hour, 16),
      weeklyDay: num(reports.weekly_day, 1),
      weeklyHourLocal: num(reports.weekly_hour, 9),
    },
    triage: obj(raw.triage),
    slackIntake: obj(raw.slack_intake),
    renderLogs: obj(raw.render_logs),
  };
}

export function validateV2Config(c: V2Config): string | null {
  if (!c.teamKey) return "v2.team_key is required (or set tracker.team_key)";
  if (c.people.some(p => !p.key)) return "v2.people entries need a key";
  for (const k of [c.designPerson, c.productPerson]) {
    if (k && !c.people.some(p => p.key === k)) return `v2: person "${k}" is not in v2.people`;
  }
  for (const p of c.people) {
    if (!Number.isInteger(p.maxOpenGates) || p.maxOpenGates <= 0) return `v2.people.${p.key}.max_open_gates must be a positive integer`;
    if (!Number.isInteger(p.maxNewGatesPerHour) || p.maxNewGatesPerHour <= 0) return `v2.people.${p.key}.max_new_gates_per_hour must be a positive integer`;
  }
  const g = c.governor;
  if (g.dailyShare <= 0 || g.dailyShare > 1 || g.reserveShare < 0 || g.reserveShare >= 1) return "v2.governor shares must be fractions (e.g. 0.2)";
  if (c.reports.dailyHourLocal < 0 || c.reports.dailyHourLocal > 23) return "v2.reports.daily_hour must be 0–23";
  return null;
}
