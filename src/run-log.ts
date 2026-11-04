#!/usr/bin/env node
/**
 * Per-run cost/time log (Phase 0 measurement).
 *
 * Every agent attempt appends one JSON line to `<symphony root>/.symphony-runs.jsonl`
 * (override with $SYMPHONY_RUN_LOG). After a week of data, `npm run runs` prints
 * per-day and per-label totals — the numbers the capacity governor's dials are
 * set from.
 *
 * `costUsd` comes from Claude's own `total_cost_usd`. On a subscription this is
 * the API-equivalent estimate, not a bill — but it is the best usage proxy we
 * get, and it moves with the 5-hour / weekly caps.
 *
 * Usage:
 *   symphony-runs [--days N] [--log PATH]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface RunRecord {
  /** ISO time the attempt finished. */
  at: string;
  issue: string;
  labels: string[];
  /** null = first dispatch; n = retry n. */
  attempt: number | null;
  /** True when the ticket came back from review (description has a `## Fix` section). */
  rework: boolean;
  provider: string;
  model: string | null;
  success: boolean;
  error: string | null;
  durationMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export function defaultRunLogPath(symphonyRoot: string): string {
  return process.env.SYMPHONY_RUN_LOG || path.join(symphonyRoot, ".symphony-runs.jsonl");
}

/** Best-effort append — measurement must never break a run. */
export function appendRunRecord(logPath: string, record: RunRecord): void {
  try {
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
  } catch {
    // ignore
  }
}

export function readRunRecords(logPath: string): RunRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export interface RunTotals {
  runs: number;
  tickets: number;
  failed: number;
  minutes: number;
  costUsd: number;
}

export interface RunSummary {
  total: RunTotals;
  byDay: Array<{ day: string } & RunTotals>;
  byLabel: Array<{ label: string } & RunTotals>;
  /** Share of runs that were rework (sent back from review). */
  reworkShare: number;
}

function emptyTotals(): RunTotals {
  return { runs: 0, tickets: 0, failed: 0, minutes: 0, costUsd: 0 };
}

function addTo(t: RunTotals & { _issues?: Set<string> }, r: RunRecord): void {
  t.runs += 1;
  if (!r.success) t.failed += 1;
  t.minutes += r.durationMs / 60_000;
  t.costUsd += r.costUsd ?? 0;
  (t._issues ??= new Set()).add(r.issue);
  t.tickets = t._issues.size;
}

function strip<T extends RunTotals>(t: T & { _issues?: Set<string> }): T {
  const { _issues: _ignored, ...rest } = t;
  return { ...rest, minutes: round(rest.minutes, 1), costUsd: round(rest.costUsd, 2) } as unknown as T;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Summarise records since `sinceMs` (epoch ms). Days are UTC dates. */
export function summariseRuns(records: RunRecord[], sinceMs = 0): RunSummary {
  const inWindow = records.filter(r => Date.parse(r.at) >= sinceMs);
  const total: RunTotals & { _issues?: Set<string> } = emptyTotals();
  const days = new Map<string, RunTotals & { _issues?: Set<string> }>();
  const labels = new Map<string, RunTotals & { _issues?: Set<string> }>();
  let rework = 0;

  for (const r of inWindow) {
    addTo(total, r);
    if (r.rework) rework += 1;
    const day = r.at.slice(0, 10);
    if (!days.has(day)) days.set(day, emptyTotals());
    addTo(days.get(day)!, r);
    for (const label of r.labels.length ? r.labels : ["(none)"]) {
      if (!labels.has(label)) labels.set(label, emptyTotals());
      addTo(labels.get(label)!, r);
    }
  }

  return {
    total: strip(total),
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, t]) => ({ day, ...strip(t) })),
    byLabel: [...labels.entries()]
      .map(([label, t]) => ({ label, ...strip(t) }))
      .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs),
    reworkShare: inWindow.length ? round(rework / inWindow.length, 2) : 0,
  };
}

export function formatSummary(s: RunSummary, days: number): string {
  const row = (name: string, t: RunTotals) =>
    `${name.padEnd(18)} ${String(t.runs).padStart(4)} runs  ${String(t.tickets).padStart(3)} tickets  ` +
    `${String(t.failed).padStart(3)} failed  ${t.minutes.toFixed(1).padStart(7)} min  $${t.costUsd.toFixed(2).padStart(7)}`;
  const lines = [
    `Last ${days} day(s) — rework ${(s.reworkShare * 100).toFixed(0)}% of runs`,
    row("TOTAL", s.total),
    "",
    "By day:",
    ...s.byDay.map(d => row(d.day, d)),
    "",
    "By label:",
    ...s.byLabel.map(l => row(l.label.slice(0, 18), l)),
  ];
  return lines.join("\n");
}

function main(argv: string[]): void {
  let days = 7;
  let logPath = defaultRunLogPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = Number(argv[++i]) || days;
    else if (argv[i] === "--log") logPath = argv[++i] ?? logPath;
  }
  const records = readRunRecords(logPath);
  if (records.length === 0) {
    console.log(`No runs logged yet at ${logPath}`);
    return;
  }
  console.log(formatSummary(summariseRuns(records, Date.now() - days * 86_400_000), days));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
