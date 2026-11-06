import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ImprovementLoop, detect, judge, metricsFor,
  type ImproveConfig, type ImproveDeps, type ImprovePr, type TicketInfo,
} from "../improvement-loop.js";
import type { Lesson } from "../lessons.js";
import type { RunRecord } from "../run-log.js";
import type { GateInput } from "../types.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const H = 3_600_000;
const D = 24 * H;
const NOW = new Date(2026, 10, 6, 18, 0, 0).getTime();

const run = (issue: string, minsAgo: number, success: boolean, over: Partial<RunRecord> = {}): RunRecord => ({
  at: new Date(NOW - minsAgo * 60_000).toISOString(), issue, labels: [], attempt: null, rework: false, provider: "claude",
  model: null, success, error: success ? null : "max turns", durationMs: 60_000, turns: 40, inputTokens: 0, outputTokens: 0, costUsd: 1, ...over,
});

const cfgBase: Omit<ImproveConfig, "statePath" | "briefPath"> = {
  retroMode: "batched", retroPollMs: 0, retroLookbackDays: 7, retrosPerPoll: 2, triggerStates: ["Done"], detectEveryMs: 0,
  prPollMs: 0, loopFailures: 3, loopWindowHours: 6, ticketCostAlertUsd: 15, holdLabel: "symphony-hold",
};

function harness(opts: {
  runs?: RunRecord[]; lessons?: Lesson[]; tickets?: Record<string, Partial<TicketInfo>>; prs?: ImprovePr[];
  now?: number; cfg?: Partial<ImproveConfig>; paused?: boolean;
} = {}) {
  const calls = { retros: [] as string[], gates: [] as GateInput[], dms: [] as string[], labels: [] as string[], merged: [] as number[], closed: [] as number[] };
  let now = opts.now ?? NOW;
  const tickets = opts.tickets ?? {};
  let prs = opts.prs ?? [];
  let lessons = opts.lessons ?? [];
  let prState: { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null } = { state: "OPEN", mergedAt: null };
  const deps: ImproveDeps = {
    readRuns: () => opts.runs ?? [],
    readLessons: () => lessons,
    ticket: async id => (tickets[id] ? { id: `uuid-${id}`, identifier: id, title: `Title ${id}`, url: `https://linear.app/${id}`, state: "Done", labels: [], ...tickets[id] } : null),
    retro: async t => { calls.retros.push(t.identifier); },
    openGate: async g => { calls.gates.push(g); },
    dm: async t => { calls.dms.push(t); },
    addLabel: async (id, n) => { calls.labels.push(`+${id}:${n}`); },
    removeLabel: async (id, n) => { calls.labels.push(`-${id}:${n}`); },
    listImprovePrs: async () => prs,
    prState: async () => prState,
    mergePr: async n => { calls.merged.push(n); },
    closePr: async n => { calls.closed.push(n); },
    paused: () => opts.paused ?? false,
    now: () => now,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
  const briefPath = path.join(dir, "brief.md");
  const loop = new ImprovementLoop({ ...cfgBase, statePath: path.join(dir, "s.json"), briefPath, ...opts.cfg }, deps, log);
  return {
    loop, calls, briefPath,
    brief: () => fs.readFileSync(briefPath, "utf8"),
    setNow: (n: number) => { now = n; },
    setPr: (s: typeof prState) => { prState = s; },
    setPrs: (p: ImprovePr[]) => { prs = p; },
    setLessons: (l: Lesson[]) => { lessons = l; },
  };
}

describe("detect", () => {
  it("flags a trailing failure streak, not one broken by a success", () => {
    const f = detect([run("A", 50, false), run("A", 40, false), run("A", 30, false), run("B", 50, false), run("B", 40, true), run("B", 30, false)], NOW, cfgBase);
    expect(f.filter(x => x.kind === "loop").map(x => x.ticket)).toEqual(["A"]);
    expect(f[0].text).toContain("failed 3 runs in a row (max turns");
  });

  it("ignores failures from before a resume", () => {
    const runs = [run("A", 50, false), run("A", 40, false), run("A", 30, false)];
    expect(detect(runs, NOW, cfgBase, { A: new Date(NOW - 35 * 60_000).toISOString() })).toHaveLength(0);
  });

  it("flags costly tickets and broad failure spikes", () => {
    const runs = [
      ...Array.from({ length: 16 }, (_, i) => run("C", 600 + i, true)),
      ...["D", "E", "F", "G", "H", "I", "J"].map((t, i) => run(t, 20 + i, false)),
      run("K", 10, true), run("L", 9, true), run("M", 8, true),
    ];
    const kinds = detect(runs, NOW, cfgBase).map(f => f.kind);
    expect(kinds).toContain("cost");
    expect(kinds).toContain("systemic");
  });
});

describe("judge", () => {
  it("compares before/after metrics", () => {
    const base = metricsFor([run("A", 10, true), run("B", 10, false)], NOW - D, NOW);
    expect(base.failRate).toBe(0.5);
    expect(judge(base, { ...base, failRate: 0.8 })).toBe("worse");
    expect(judge(base, { ...base, failRate: 0.2 })).toBe("better");
    expect(judge(base, { ...base, failRate: 0.45 })).toBe("unclear");
  });
});

describe("ImprovementLoop", () => {
  it("queues Done tickets without a lesson in the brief, with no agent runs", async () => {
    const h = harness({
      runs: [run("A", 100, true), run("B", 100, true), run("C", 100, false)],
      lessons: [{ ticket: "B" }],
      tickets: { A: {}, B: {}, C: { state: "In Review" } },
    });
    await h.loop.reconcile();
    expect(h.calls.retros).toHaveLength(0);
    const brief = h.brief();
    expect(brief).toContain("## Tickets that need a lesson (1)");
    expect(brief).toContain("### A: Title A");
    expect(brief).not.toContain("### B:");
    expect(brief).not.toContain("### C:");
    // Once the daily task writes A's lesson, it leaves the queue.
    h.setLessons([{ ticket: "A" }, { ticket: "B" }]);
    await h.loop.reconcile();
    expect(h.brief()).toContain("## Tickets that need a lesson (0)");
  });

  it("runs one retro agent per ticket in per_ticket mode, capped per poll", async () => {
    const h = harness({
      runs: ["A", "B", "C"].map(t => run(t, 100, true)),
      tickets: { A: {}, B: {}, C: {} },
      cfg: { retroMode: "per_ticket" },
    });
    await h.loop.reconcile();
    expect(h.calls.retros).toEqual(["A", "B"]);
  });

  it("puts a looping ticket on hold once, and Resume lifts it", async () => {
    const runs = [run("A", 50, false), run("A", 40, false), run("A", 30, false)];
    const h = harness({ runs, tickets: { A: { state: "Dev in Progress", labels: ["symphony-hold"] } }, cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile();
    await h.loop.reconcile();
    expect(h.calls.labels).toEqual(["+uuid-A:symphony-hold"]);
    expect(h.calls.gates.map(g => g.kind)).toEqual(["ticket_hold"]);
    expect(h.loop.isHeld({ identifier: "A" })).toBe(true);
    expect(h.brief()).toContain("Tickets on hold:");
    await h.loop.onHoldDecision("A", "resume");
    expect(h.calls.labels.at(-1)).toBe("-uuid-A:symphony-hold");
    expect(h.loop.isHeld({ identifier: "A" })).toBe(false);
  });

  it("lifts a hold when someone removes the label in Linear", async () => {
    const tickets: Record<string, Partial<TicketInfo>> = { A: { state: "Dev in Progress", labels: ["symphony-hold"] } };
    const h = harness({ runs: [run("A", 50, false), run("A", 40, false), run("A", 30, false)], tickets, cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile();
    expect(h.loop.isHeld({ identifier: "A" })).toBe(true);
    tickets.A = { state: "Dev in Progress", labels: [] };
    await h.loop.reconcile();
    expect(h.loop.isHeld({ identifier: "A" })).toBe(false);
    expect(h.loop.isHeld({ identifier: "Z", labels: ["Symphony-Hold"] })).toBe(true);
  });

  it("posts one Merge card per new improve/* PR and acts on the decision", async () => {
    const pr = { number: 77, url: "https://github.com/silas-dsc/symphony/pull/77", title: "Daily improvement 2026-11-06: cap hook retries", branch: "improve/2026-11-06" };
    const h = harness({ runs: [run("A", 100, true)], prs: [pr], cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile();
    await h.loop.reconcile();
    const cards = h.calls.gates.filter(g => g.kind === "process_change");
    expect(cards).toHaveLength(1);
    expect(cards[0].meta?.prNumber).toBe("77");
    expect(h.brief()).toContain("PR #77 (open, awaiting review)");
    await h.loop.onChangeDecision(77, "merge");
    expect(h.calls.merged).toEqual([77]);
  });

  it("scores a merged change after two days and warns when it's worse", async () => {
    const before = Array.from({ length: 10 }, (_, i) => run(`T${i}`, 3 * 24 * 60 + 60 + i, i >= 2));
    const after = Array.from({ length: 10 }, (_, i) => run(`U${i}`, 60 + i, i < 2));
    const pr = { number: 77, url: "u", title: "t", branch: "improve/x" };
    const h = harness({ runs: [...before, ...after], prs: [pr], now: NOW - 3 * D, cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile(); // baseline: 20% failing
    h.setPrs([]);
    h.setPr({ state: "MERGED", mergedAt: new Date(NOW - 3 * D + H).toISOString() });
    h.setNow(NOW - 2 * D);
    await h.loop.reconcile(); // notices the merge
    h.setNow(NOW);
    await h.loop.reconcile(); // 3 days on: 80% failing
    expect(h.calls.dms.some(d => d.includes("PR #77") && d.includes("looks worse"))).toBe(true);
    expect(h.brief()).toContain("PR #77 \"t\" merged");
    expect(h.brief()).toContain("**worse**");
  });

  it("doesn't start per-ticket retros while paused", async () => {
    const h = harness({ runs: [run("A", 100, true)], tickets: { A: {} }, paused: true, cfg: { retroMode: "per_ticket" } });
    await h.loop.reconcile();
    expect(h.calls.retros).toHaveLength(0);
  });
});
