import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../types.js";

const probe = vi.fn();
vi.mock("../usage-budget.js", async () => {
  const actual = await vi.importActual<typeof import("../usage-budget.js")>("../usage-budget.js");
  return { ...actual, probeUsage: (...a: unknown[]) => probe(...a) };
});

const { Orchestrator } = await import("../orchestrator.js");
const { tokenProcesses } = await import("../usage-budget.js");

const MIN = 60_000;

describe("Orchestrator usage budget", () => {
  afterEach(() => {
    tokenProcesses.resume();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("pauses when the last hour goes over 17%, alerts once, and resumes when back under", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-usage-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: k\n  project_slug: demo\nworkspace:\n  root: ${tmpDir}\n---\n\nPrompt`, "utf8");
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const o = new Orchestrator(workflowPath, log);
    const check = (now: number) => (o as unknown as { checkUsageBudget(n: number): Promise<void> }).checkUsageBudget(now);
    const internals = o as unknown as { nextUsageCheckAt: number };

    const t0 = Date.now();
    const reset = Math.floor((t0 + 4 * 60 * MIN) / 1000);
    const sample = (minutes: number, fiveHour: number) => ({ at: t0 + minutes * MIN, fiveHour, fiveHourResetsAt: reset, sevenDay: 0.4 });

    probe.mockResolvedValueOnce(sample(0, 0.30));
    await check(t0);
    expect(tokenProcesses.isPaused()).toBe(false);
    expect(internals.nextUsageCheckAt).toBe(t0 + 15 * MIN);

    probe.mockResolvedValueOnce(sample(15, 0.55)); // +25% in 15 min
    await check(t0 + 15 * MIN);
    expect(tokenProcesses.isPaused()).toBe(true);
    expect(internals.nextUsageCheckAt).toBe(t0 + 75 * MIN);
    expect(log.warn).toHaveBeenCalledWith("Operator alert (no v2 Slack configured)", expect.objectContaining({ text: expect.stringContaining("25% of the 5-hour Claude limit") }));
    expect(o.getSnapshot().usage_budget).toMatchObject({ five_hour: 0.55, max_share_per_hour: 0.17, paused_until: new Date(t0 + 75 * MIN).toISOString() });

    // Not due yet: no probe.
    await check(t0 + 30 * MIN);
    expect(probe).toHaveBeenCalledTimes(2);

    probe.mockResolvedValueOnce(sample(75, 0.56));
    await check(t0 + 75 * MIN);
    expect(tokenProcesses.isPaused()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith("Operator alert (no v2 Slack configured)", expect.objectContaining({ text: expect.stringContaining("resumed") }));
    (o as unknown as { stop(): void }).stop();
  });

  it("stays off without an OAuth token", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-usage-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: k\n  project_slug: demo\nworkspace:\n  root: ${tmpDir}\n---\n\nPrompt`, "utf8");
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const o = new Orchestrator(workflowPath, log);
    probe.mockClear();
    await (o as unknown as { checkUsageBudget(n: number): Promise<void> }).checkUsageBudget(Date.now());
    expect(probe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Usage budget off"));
  });
});
