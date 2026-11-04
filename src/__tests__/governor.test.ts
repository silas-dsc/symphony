import { describe, expect, it } from "vitest";
import { allowDispatch, assess, type GovernorConfig, type GovernorInput } from "../governor.js";

const cfg: GovernorConfig = { weeklyBudgetUsd: null, dailyShare: 0.2, reserveShare: 0.2 };
const silas = { key: "silas", name: "Silas", open: 2, maxOpen: 10, openedLastHour: 1, maxPerHour: 6 };
const base: GovernorInput = {
  operatorKey: "silas", people: [silas], rateLimit: null, spendTodayUsd: 0, spendWeekUsd: 0, baseConcurrency: 3,
};
const plain = { priority: 3, description: "Do a thing", labels: [] };
const urgent = { priority: 1, description: "Site down", labels: [] };
const rework = { priority: 3, description: "Spec\n\n## Fix\n\n- change x", labels: [] };

describe("governor", () => {
  it("is normal with room everywhere", () => {
    const r = assess(base, cfg);
    expect(r.mode).toBe("normal");
    expect(r.maxConcurrent).toBe(3);
    expect(allowDispatch(r, plain).ok).toBe(true);
  });

  it("only lets urgent work and rework start when the operator's queue is full", () => {
    const r = assess({ ...base, people: [{ ...silas, open: 10 }] }, cfg);
    expect(r.mode).toBe("urgent_only");
    expect(allowDispatch(r, plain)).toEqual({ ok: false, reason: expect.stringContaining("queue is full") });
    expect(allowDispatch(r, urgent).ok).toBe(true);
    expect(allowDispatch(r, rework).ok).toBe(true);
  });

  it("also trips on the per-hour cap", () => {
    expect(assess({ ...base, people: [{ ...silas, openedLastHour: 6 }] }, cfg).mode).toBe("urgent_only");
  });

  it("slows to one agent when Claude warns, urgent-only when blocked", () => {
    const rl = { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 0, overageStatus: null, overageResetsAt: null, isUsingOverage: false, observedAt: new Date() };
    const slow = assess({ ...base, rateLimit: rl }, cfg);
    expect([slow.mode, slow.maxConcurrent]).toEqual(["slow", 1]);
    const blocked = assess({ ...base, rateLimit: { ...rl, status: "blocked" } }, cfg);
    expect(blocked.mode).toBe("urgent_only");
  });

  it("applies the daily ceiling and weekly reserve once a budget is set", () => {
    const withBudget = { ...cfg, weeklyBudgetUsd: 500 };
    expect(assess({ ...base, spendTodayUsd: 100 }, withBudget).mode).toBe("urgent_only"); // 20% of 500
    expect(assess({ ...base, spendTodayUsd: 80 }, withBudget).mode).toBe("slow");
    expect(assess({ ...base, spendWeekUsd: 400 }, withBudget).mode).toBe("urgent_only"); // 80% used
    expect(assess({ ...base, spendTodayUsd: 10, spendWeekUsd: 100 }, withBudget).mode).toBe("normal");
  });

  it("never dispatches a ticket waiting on a person", () => {
    const r = assess(base, cfg);
    expect(allowDispatch(r, { ...urgent, labels: ["waiting-on:nika"] })).toEqual({ ok: false, reason: "waiting on nika" });
  });
});
