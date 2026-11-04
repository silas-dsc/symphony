import type { RateLimitInfo } from "./types.js";

/**
 * Capacity governor: decides whether Symphony may START new work.
 *
 * People first (the main limit): if the operator's gate queue is full, new
 * tickets would only pile more cards on them, so only urgent work and rework
 * (which clears existing cards) may start. Claude's usage second: rate-limit
 * signals from the CLI, plus — once Phase 0 data gives a weekly figure —
 * a daily ceiling and a weekly reserve kept for emergencies.
 *
 * Pure: the caller gathers the numbers; this returns a readout + a verdict.
 */

export interface GovernorConfig {
  /** API-equivalent $ per week the subscription comfortably covers (from `npm run runs`). null = unknown. */
  weeklyBudgetUsd: number | null;
  /** Ceiling share of the weekly budget per day (0.2 = 20%). */
  dailyShare: number;
  /** Share of the weekly budget kept in reserve for urgent work (0.2 = 20%). */
  reserveShare: number;
}

export interface PersonLoad {
  key: string;
  name: string;
  open: number;
  maxOpen: number;
  openedLastHour: number;
  maxPerHour: number;
}

export interface GovernorInput {
  operatorKey: string;
  people: PersonLoad[];
  rateLimit: RateLimitInfo | null;
  spendTodayUsd: number;
  spendWeekUsd: number;
  /** Configured max concurrent agents. */
  baseConcurrency: number;
  now?: Date;
}

export type GovernorMode = "normal" | "slow" | "urgent_only";

export interface GovernorReadout {
  mode: GovernorMode;
  /** Effective max concurrent agents. */
  maxConcurrent: number;
  /** Plain-English reasons for anything but "normal". */
  reasons: string[];
  people: Array<PersonLoad & { full: boolean }>;
  spendTodayUsd: number;
  spendWeekUsd: number;
  weeklyBudgetUsd: number | null;
}

export interface DispatchCandidate {
  priority: number | null;
  description: string | null;
  labels: string[];
}

export const URGENT_PRIORITY = 1;

export function isFull(p: PersonLoad): boolean {
  return p.open >= p.maxOpen || p.openedLastHour >= p.maxPerHour;
}

export function assess(input: GovernorInput, cfg: GovernorConfig): GovernorReadout {
  const reasons: string[] = [];
  let mode: GovernorMode = "normal";
  let maxConcurrent = input.baseConcurrency;
  const people = input.people.map(p => ({ ...p, full: isFull(p) }));

  const operator = people.find(p => p.key === input.operatorKey);
  if (operator?.full) {
    mode = "urgent_only";
    reasons.push(`${operator.name}'s queue is full (${operator.open}/${operator.maxOpen} open, ${operator.openedLastHour}/${operator.maxPerHour} this hour)`);
  }

  const rl = input.rateLimit;
  if (rl && rl.status !== "allowed") {
    const resets = rl.resetsAt ? new Date(rl.resetsAt * 1000).toISOString().slice(11, 16) : "?";
    if (rl.status === "blocked" || rl.status === "rejected") {
      mode = "urgent_only";
      maxConcurrent = 1;
      reasons.push(`Claude ${rl.rateLimitType} limit reached (resets ${resets} UTC)`);
    } else {
      if (mode === "normal") mode = "slow";
      maxConcurrent = 1;
      reasons.push(`Claude ${rl.rateLimitType} limit close (${rl.status})`);
    }
  }

  if (cfg.weeklyBudgetUsd && cfg.weeklyBudgetUsd > 0) {
    const weekCap = cfg.weeklyBudgetUsd * (1 - cfg.reserveShare);
    const dayCap = cfg.weeklyBudgetUsd * cfg.dailyShare;
    if (input.spendWeekUsd >= weekCap) {
      mode = "urgent_only";
      reasons.push(`weekly reserve reached ($${input.spendWeekUsd.toFixed(0)} of $${cfg.weeklyBudgetUsd.toFixed(0)})`);
    } else if (input.spendTodayUsd >= dayCap) {
      mode = "urgent_only";
      reasons.push(`today's ceiling reached ($${input.spendTodayUsd.toFixed(0)} of $${dayCap.toFixed(0)})`);
    } else if (input.spendTodayUsd >= dayCap * 0.75 && mode === "normal") {
      mode = "slow";
      maxConcurrent = Math.min(maxConcurrent, 1);
      reasons.push(`75% of today's ceiling used`);
    }
  }

  return {
    mode,
    maxConcurrent: Math.max(1, maxConcurrent),
    reasons,
    people,
    spendTodayUsd: input.spendTodayUsd,
    spendWeekUsd: input.spendWeekUsd,
    weeklyBudgetUsd: cfg.weeklyBudgetUsd,
  };
}

/** Rework = the ticket came back with a `## Fix` brief; finishing it clears a card. */
export function isRework(c: DispatchCandidate): boolean {
  return /^## Fix\s*$/m.test(c.description ?? "");
}

export function waitingOn(labels: string[]): string | null {
  const l = labels.find(x => x.toLowerCase().startsWith("waiting-on:"));
  return l ? l.slice("waiting-on:".length) : null;
}

export function allowDispatch(readout: GovernorReadout, c: DispatchCandidate): { ok: boolean; reason: string | null } {
  const waiting = waitingOn(c.labels);
  if (waiting) return { ok: false, reason: `waiting on ${waiting}` };
  if (readout.mode !== "urgent_only") return { ok: true, reason: null };
  if (c.priority === URGENT_PRIORITY) return { ok: true, reason: null };
  if (isRework(c)) return { ok: true, reason: null };
  return { ok: false, reason: readout.reasons[0] ?? "governor: urgent only" };
}

export function formatGovernor(r: GovernorReadout): string {
  const head = r.mode === "normal" ? "Pace: normal" : r.mode === "slow" ? "Pace: slowed" : "Pace: urgent work only";
  const people = r.people.map(p => `${p.name} ${p.open}/${p.maxOpen}${p.full ? " (full)" : ""}`).join(" · ");
  const spend = r.weeklyBudgetUsd
    ? ` · Claude today $${r.spendTodayUsd.toFixed(0)} / week $${r.spendWeekUsd.toFixed(0)} of $${r.weeklyBudgetUsd.toFixed(0)}`
    : ` · Claude today $${r.spendTodayUsd.toFixed(0)} (est.)`;
  return `${head}${r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}\nCards: ${people}${spend}`;
}
