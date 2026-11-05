import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  UsageBudget, increments, parseBudgetConfig, parseUsageHeaders, probeUsage, tokenProcesses, trackTokenProcess,
  type UsageSample,
} from "../usage-budget.js";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const RESET = Math.floor((T0 + 3 * 60 * MIN) / 1000); // window resets 3h after T0

const s = (minutes: number, fiveHour: number, resetsAt = RESET): UsageSample =>
  ({ at: T0 + minutes * MIN, fiveHour, fiveHourResetsAt: resetsAt, sevenDay: null });

describe("usage maths", () => {
  it("counts only increases, and a new window from zero", () => {
    const next = RESET + 5 * 3600;
    expect(increments([s(0, 0.5), s(15, 0.6), s(30, 0.55), s(45, 0.04, next)]))
      .toEqual([{ at: T0 + 15 * MIN, amount: expect.closeTo(0.1) }, { at: T0 + 45 * MIN, amount: 0.04 }]);
  });

  it("stays under budget with steady use", () => {
    const b = new UsageBudget(0.17);
    [s(0, 0.20), s(15, 0.24), s(30, 0.28), s(45, 0.32), s(60, 0.36)].forEach(x => b.record(x));
    expect(b.spentLastHour(T0 + 60 * MIN)).toBeCloseTo(0.16);
    expect(b.resumeAt(T0 + 60 * MIN)).toBeNull();
  });

  it("pauses when the trailing hour goes over, until the oldest usage ages out", () => {
    const b = new UsageBudget(0.17);
    [s(0, 0.10), s(15, 0.16), s(30, 0.22), s(45, 0.30)].forEach(x => b.record(x));
    // 6 + 6 + 8 = 20% in the last hour. Dropping the 15-min increment (6%) leaves 14% → resume at 15 + 60 min.
    expect(b.spentLastHour(T0 + 45 * MIN)).toBeCloseTo(0.20);
    expect(b.resumeAt(T0 + 45 * MIN)).toBe(T0 + 75 * MIN);
  });

  it("resumes no later than the 5-hour reset", () => {
    const soonReset = Math.floor((T0 + 50 * MIN) / 1000);
    const b = new UsageBudget(0.17);
    [s(0, 0.10, soonReset), s(30, 0.40, soonReset)].forEach(x => b.record(x));
    expect(b.resumeAt(T0 + 30 * MIN)).toBe(soonReset * 1000);
  });

  it("waits for the reset when the window is used up", () => {
    const b = new UsageBudget(0.17);
    b.record(s(0, 1));
    expect(b.resumeAt(T0)).toBe(RESET * 1000);
  });

  it("drops samples older than the baseline hour", () => {
    const b = new UsageBudget(0.17);
    for (let m = 0; m <= 180; m += 15) b.record(s(m, 0.01 * m / 15));
    expect(b.spentLastHour(T0 + 180 * MIN)).toBeCloseTo(0.04);
  });
});

describe("measuring", () => {
  it("parses the unified rate-limit headers", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.94",
      "anthropic-ratelimit-unified-5h-reset": "1793841000",
      "anthropic-ratelimit-unified-7d-utilization": "0.42",
    });
    expect(parseUsageHeaders(h, 5)).toEqual({ at: 5, fiveHour: 0.94, fiveHourResetsAt: 1793841000, sevenDay: 0.42 });
    expect(parseUsageHeaders(new Headers(), 5)).toBeNull();
  });

  it("probes with a 1-token OAuth request", async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response("{}", { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-reset": "100" } });
    }) as unknown as typeof fetch;
    const sample = await probeUsage("tok", fake);
    expect(sample?.fiveHour).toBe(0.5);
    expect(JSON.parse(String(seen?.body)).max_tokens).toBe(1);
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("parses config with a 17%/15 min default", () => {
    expect(parseBudgetConfig({})).toEqual({ enabled: true, maxPerHour: 0.17, checkMs: 15 * MIN });
    expect(parseBudgetConfig({ enabled: false, max_share_per_hour: 0.1, check_minutes: 5 })).toEqual({ enabled: false, maxPerHour: 0.1, checkMs: 5 * MIN });
  });
});

describe("suspending token-using processes", () => {
  const stat = (pid: number) => execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();

  it("suspends tracked processes, suspends new ones while paused, and resumes them", async () => {
    const a = spawn("sleep", ["30"]);
    trackTokenProcess(a, "a");
    try {
      expect(tokenProcesses.pause(Date.now() + MIN)).toContain("a");
      expect(tokenProcesses.isPaused()).toBe(true);
      const b = spawn("sleep", ["30"]);
      trackTokenProcess(b, "b");
      try {
        await new Promise(r => setTimeout(r, 100));
        expect(stat(a.pid!)).toMatch(/^T/);
        expect(stat(b.pid!)).toMatch(/^T/);
        expect(tokenProcesses.resume().sort()).toEqual(["a", "b"]);
        await new Promise(r => setTimeout(r, 100));
        expect(stat(a.pid!)).not.toMatch(/^T/);
        expect(tokenProcesses.isPaused()).toBe(false);
      } finally {
        b.kill("SIGKILL");
      }
    } finally {
      tokenProcesses.resume();
      a.kill("SIGKILL");
    }
  });
});

describe("persistence", () => {
  it("remembers the last hour across restarts, so a climb spanning a restart still pauses", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ub-")), "usage.json");
    const before = new UsageBudget(0.17, file);
    before.record(s(0, 0.49));
    before.record(s(15, 0.60));
    const after = new UsageBudget(0.17, file); // "restart"
    after.record(s(30, 0.74));
    expect(after.spentLastHour(T0 + 30 * MIN)).toBeCloseTo(0.25);
    expect(after.resumeAt(T0 + 30 * MIN)).not.toBeNull();
  });
});
