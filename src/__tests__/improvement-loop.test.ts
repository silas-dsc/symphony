import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ImprovementLoop, allowedFile, detect, judge, metricsFor, parsePassResult,
  type ImproveConfig, type ImproveDeps, type PassResult, type TicketInfo,
} from "../improvement-loop.js";
import type { Lesson } from "../lessons.js";
import type { RunRecord } from "../run-log.js";
import type { GateInput } from "../types.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const H = 3_600_000;
const D = 24 * H;
// 18:00 local on some day, so the daily pass (hour 17) is due.
const NOW = new Date(2026, 10, 6, 18, 0, 0).getTime();

const run = (issue: string, minsAgo: number, success: boolean, over: Partial<RunRecord> = {}): RunRecord => ({
  at: new Date(NOW - minsAgo * 60_000).toISOString(), issue, labels: [], attempt: null, rework: false, provider: "claude",
  model: null, success, error: success ? null : "max turns", durationMs: 60_000, turns: 40, inputTokens: 0, outputTokens: 0, costUsd: 1, ...over,
});

const cfgBase: ImproveConfig = {
  retroPollMs: 0, retroLookbackDays: 7, retrosPerPoll: 2, triggerStates: ["Done"], detectEveryMs: 0,
  loopFailures: 3, loopWindowHours: 6, ticketCostAlertUsd: 15, dailyHourLocal: 17, maxChanges: 3, maxTickets: 2,
  holdLabel: "symphony-hold", statePath: "",
};

function harness(opts: {
  runs?: RunRecord[]; lessons?: Lesson[]; tickets?: Record<string, Partial<TicketInfo>>; pass?: PassResult | null;
  now?: number; cfg?: Partial<ImproveConfig>; paused?: boolean;
} = {}) {
  const calls = { retros: [] as string[], gates: [] as GateInput[], dms: [] as string[], labels: [] as string[], passes: 0, prs: [] as string[], tickets: [] as string[], merged: [] as number[] };
  let now = opts.now ?? NOW;
  const tickets = opts.tickets ?? {};
  let prState: { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: string | null } = { state: "OPEN", mergedAt: null };
  const deps: ImproveDeps = {
    readRuns: () => opts.runs ?? [],
    readLessons: () => opts.lessons ?? [],
    ticket: async id => (tickets[id] ? { id: `uuid-${id}`, identifier: id, title: "T", url: `https://linear.app/${id}`, state: "Done", labels: [], ...tickets[id] } : null),
    retro: async t => { calls.retros.push(t.identifier); },
    openGate: async g => { calls.gates.push(g); },
    dm: async t => { calls.dms.push(t); },
    addLabel: async (id, n) => { calls.labels.push(`+${id}:${n}`); },
    removeLabel: async (id, n) => { calls.labels.push(`-${id}:${n}`); },
    runPass: async () => { calls.passes++; return opts.pass === undefined ? null : opts.pass; },
    openPr: async (branch, title) => { calls.prs.push(`${branch}|${title}`); return { number: 77, url: "https://github.com/silas-dsc/symphony/pull/77" }; },
    prState: async () => prState,
    mergePr: async n => { calls.merged.push(n); },
    closePr: async () => undefined,
    createTicket: async title => { calls.tickets.push(title); return { identifier: "TEA-9", url: null }; },
    paused: () => opts.paused ?? false,
    now: () => now,
  };
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-")), "s.json");
  const loop = new ImprovementLoop({ ...cfgBase, statePath, ...opts.cfg }, deps, log);
  return { loop, calls, deps, setNow: (n: number) => { now = n; }, setPr: (s: typeof prState) => { prState = s; } };
}

const passResult = (over: Partial<PassResult> = {}): PassResult => ({
  branch: "improve/2026-11-06", files: ["prompts/DEVELOPER.md"],
  changes: [{ title: "Cap hook retries", file: "prompts/DEVELOPER.md", why: "loops", evidence: ["TEA-1"], expect: "fewer max-turn fails" }],
  tickets: [], engineering: [], skipped: [], cleanup: vi.fn(async () => undefined), ...over,
});

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

describe("helpers", () => {
  it("judges before/after metrics", () => {
    const base = metricsFor([run("A", 10, true), run("B", 10, false)], NOW - D, NOW);
    expect(base.failRate).toBe(0.5);
    expect(judge(base, { ...base, failRate: 0.8 })).toBe("worse");
    expect(judge(base, { ...base, failRate: 0.2 })).toBe("better");
    expect(judge(base, { ...base, failRate: 0.45 })).toBe("unclear");
  });

  it("only allows prompt/workflow/memory files", () => {
    expect(allowedFile("WORKFLOW.md")).toBe(true);
    expect(allowedFile("prompts/DEVELOPER.md")).toBe(true);
    expect(allowedFile("docs/AGENT_MEMORY.md")).toBe(true);
    expect(allowedFile("src/agent.ts")).toBe(false);
    expect(allowedFile("prompts/x/evil.md")).toBe(false);
  });

  it("parses the result block", () => {
    const r = parsePassResult('done\n```improve-result\n{"changes":[{"title":"x","file":"WORKFLOW.md","why":"w","evidence":[],"expect":"e"}],"tickets":[],"engineering":["cap retries"],"skipped":[]}\n```');
    expect(r?.changes).toHaveLength(1);
    expect(r?.engineering).toEqual(["cap retries"]);
    expect(parsePassResult("no block")).toBeNull();
  });
});

describe("ImprovementLoop", () => {
  it("runs retros for Done tickets without a lesson, at most retrosPerPoll", async () => {
    const h = harness({
      runs: [run("A", 100, true), run("B", 100, true), run("C", 100, true), run("D", 100, true), run("E", 100, true)],
      lessons: [{ ticket: "B" }],
      tickets: { A: {}, B: {}, C: { state: "In Review" }, D: {}, E: {} },
      cfg: { dailyHourLocal: 24 },
    });
    await h.loop.reconcile();
    expect(h.calls.retros).toEqual(["A", "D"]);
    await h.loop.reconcile();
    expect(h.calls.retros).toEqual(["A", "D", "E"]);
  });

  it("puts a looping ticket on hold once, and Resume lifts it", async () => {
    const runs = [run("A", 50, false), run("A", 40, false), run("A", 30, false)];
    const h = harness({ runs, tickets: { A: { state: "Dev in Progress", labels: ["symphony-hold"] } }, cfg: { dailyHourLocal: 24, retroPollMs: 1e12 } });
    await h.loop.reconcile();
    await h.loop.reconcile();
    expect(h.calls.labels).toEqual(["+uuid-A:symphony-hold"]);
    expect(h.calls.gates.map(g => g.kind)).toEqual(["ticket_hold"]);
    expect(h.loop.isHeld({ identifier: "A" })).toBe(true);
    await h.loop.onHoldDecision("A", "resume");
    expect(h.calls.labels.at(-1)).toBe("-uuid-A:symphony-hold");
    expect(h.loop.isHeld({ identifier: "A" })).toBe(false);
  });

  it("lifts a hold when someone removes the label in Linear", async () => {
    const tickets: Record<string, Partial<TicketInfo>> = { A: { state: "Dev in Progress", labels: ["symphony-hold"] } };
    const h = harness({ runs: [run("A", 50, false), run("A", 40, false), run("A", 30, false)], tickets, cfg: { dailyHourLocal: 24, retroPollMs: 1e12 } });
    await h.loop.reconcile();
    expect(h.loop.isHeld({ identifier: "A" })).toBe(true);
    tickets.A = { state: "Dev in Progress", labels: [] };
    await h.loop.reconcile();
    expect(h.loop.isHeld({ identifier: "A" })).toBe(false);
    expect(h.loop.isHeld({ identifier: "Z", labels: ["Symphony-Hold"] })).toBe(true);
  });

  it("opens a PR and a Merge card from the daily pass, once a day", async () => {
    const pass = passResult({ tickets: [{ title: "Typecheck OOMs", description: "d", evidence: [] }] });
    const h = harness({ runs: [run("A", 100, true)], pass, cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile();
    await h.loop.reconcile();
    expect(h.calls.passes).toBe(1);
    expect(h.calls.prs[0]).toContain("improve/2026-11-06|Daily improvement");
    expect(h.calls.tickets).toEqual(["Typecheck OOMs"]);
    const card = h.calls.gates.find(g => g.kind === "process_change");
    expect(card?.meta?.prNumber).toBe("77");
    expect(pass.cleanup).toHaveBeenCalled();
    await h.loop.onChangeDecision(77, "merge");
    expect(h.calls.merged).toEqual([77]);
  });

  it("waits for the daily hour and skips quiet days", async () => {
    const early = harness({ runs: [run("A", 10, true)], now: new Date(2026, 10, 6, 9).getTime(), cfg: { retroPollMs: 1e12 } });
    await early.loop.reconcile();
    expect(early.calls.passes).toBe(0);
    const quiet = harness({ runs: [], cfg: { retroPollMs: 1e12 } });
    await quiet.loop.reconcile();
    expect(quiet.calls.passes).toBe(0);
  });

  it("drops a pass that touched files outside prompts/workflow", async () => {
    const h = harness({ runs: [run("A", 100, true)], pass: passResult({ files: ["src/agent.ts"] }), cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile();
    expect(h.calls.prs).toHaveLength(0);
    expect(h.calls.dms[0]).toContain("src/agent.ts");
  });

  it("scores a merged change after two days and warns when it's worse", async () => {
    const before = Array.from({ length: 10 }, (_, i) => run(`T${i}`, 3 * 24 * 60 + 60 + i, i >= 2));
    const after = Array.from({ length: 10 }, (_, i) => run(`U${i}`, 60 + i, i < 2));
    const h = harness({ runs: [...before, ...after], pass: passResult(), now: NOW - 3 * D, cfg: { retroPollMs: 1e12 } });
    await h.loop.reconcile(); // day 1: opens PR #77
    h.setPr({ state: "MERGED", mergedAt: new Date(NOW - 3 * D + H).toISOString() });
    h.setNow(NOW - 2 * D);
    await h.loop.reconcile(); // notices the merge
    h.setNow(NOW);
    await h.loop.reconcile(); // 3 days on: fail rate 20%→80%
    expect(h.calls.dms.some(d => d.includes("PR #77") && d.includes("looks worse"))).toBe(true);
  });

  it("does nothing token-hungry while paused", async () => {
    const h = harness({ runs: [run("A", 100, true)], tickets: { A: {} }, pass: passResult(), paused: true });
    await h.loop.reconcile();
    expect(h.calls.retros).toHaveLength(0);
    expect(h.calls.passes).toBe(0);
  });
});
