import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendRunRecord, readRunRecords, summariseRuns, formatSummary, type RunRecord } from "../run-log.js";

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    at: "2026-11-03T10:00:00.000Z",
    issue: "TEA-1",
    labels: ["Bug"],
    attempt: null,
    rework: false,
    provider: "claude",
    model: "claude-sonnet",
    success: true,
    error: null,
    durationMs: 6 * 60_000,
    turns: 20,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 1.25,
    ...overrides,
  };
}

describe("run log", () => {
  it("round-trips records and skips torn lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runlog-"));
    const file = path.join(dir, "runs.jsonl");
    appendRunRecord(file, rec());
    fs.appendFileSync(file, "{not json\n");
    appendRunRecord(file, rec({ issue: "TEA-2" }));
    expect(readRunRecords(file).map(r => r.issue)).toEqual(["TEA-1", "TEA-2"]);
  });

  it("returns [] for a missing file and never throws on a bad append path", () => {
    expect(readRunRecords("/nonexistent/x.jsonl")).toEqual([]);
    expect(() => appendRunRecord("/nonexistent/dir/x.jsonl", rec())).not.toThrow();
  });

  it("summarises by day and label, counting distinct tickets and rework share", () => {
    const s = summariseRuns([
      rec(),
      rec({ attempt: 1, success: false, costUsd: 0.75, rework: true }),
      rec({ at: "2026-11-04T09:00:00.000Z", issue: "TEA-2", labels: [], costUsd: null }),
      rec({ at: "2026-10-01T00:00:00.000Z", issue: "TEA-OLD" }),
    ], Date.parse("2026-11-01T00:00:00Z"));

    expect(s.total).toEqual({ runs: 3, tickets: 2, failed: 1, minutes: 18, costUsd: 2 });
    expect(s.byDay.map(d => [d.day, d.runs])).toEqual([["2026-11-03", 2], ["2026-11-04", 1]]);
    expect(s.byLabel[0]).toMatchObject({ label: "Bug", runs: 2, tickets: 1, costUsd: 2 });
    expect(s.byLabel[1]).toMatchObject({ label: "(none)", runs: 1, costUsd: 0 });
    expect(s.reworkShare).toBe(0.33);
    expect(formatSummary(s, 7)).toContain("rework 33% of runs");
  });
});
