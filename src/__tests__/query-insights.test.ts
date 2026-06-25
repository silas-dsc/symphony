import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, validateConfig } from "../config.js";
import {
  QueryInsightsWatcher,
  buildRankingSql,
  buildTicketDescription,
  buildTicketTitle,
  extractOffenderKey,
  offenderKey,
  type CreatedTicket,
  type OffenderClient,
  type QueryInsightsTicketSnapshot,
  type QueryInsightsTicketStore,
  type QueryOffender,
} from "../query-insights.js";
import type { Logger, QueryInsightsConfig, TrackerConfig } from "../types.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeConfig(overrides?: Partial<QueryInsightsConfig>): QueryInsightsConfig {
  return {
    enabled: true,
    projectId: "team-dsc-au",
    dataset: "query_insights",
    table: "query_stats",
    teamKey: "TEA",
    targetState: "Dev in Progress",
    assigneeEmail: "silas@teamdsc.com.au",
    label: "query-insights",
    lookbackDays: 7,
    minReadOps: 10_000,
    maxOpenTickets: 3,
    maxTicketsPerRun: 3,
    runIntervalMs: 7 * 24 * 60 * 60 * 1000,
    bqTimeoutMs: 60_000,
    ...overrides,
  };
}

const tracker: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "test-key",
  projectSlug: "ALL",
  teamKey: "TEA",
  activeStates: ["Dev in Progress"],
  terminalStates: ["Done"],
};

function makeOffender(overrides?: Partial<QueryOffender>): QueryOffender {
  const totalReadOps = overrides?.totalReadOps ?? 2_000_000;
  const avgLatencyMs = overrides?.avgLatencyMs ?? 7000;
  return {
    callSite: "getCurrentAssignmentsByCourse",
    shape: "course_assignments_current where(courseId)",
    execCount: 55,
    totalReadOps,
    avgLatencyMs,
    p95LatencyMs: 14000,
    avgResults: 40000,
    sampleIndexesUsed: '[{"fields":"courseId"}]',
    score: totalReadOps * avgLatencyMs,
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: Partial<QueryInsightsConfig>;
  offenders: () => Promise<QueryOffender[]>;
  snapshot?: () => Promise<QueryInsightsTicketSnapshot>;
  createThrows?: boolean;
  now?: () => number;
}): {
  watcher: QueryInsightsWatcher;
  created: Array<{ key: string; title: string }>;
  scanCalls: () => number;
} {
  let scanCalls = 0;
  const created: Array<{ key: string; title: string }> = [];

  const offenderClient: OffenderClient = {
    topOffenders: async () => { scanCalls++; return opts.offenders(); },
  };

  const ticketStore: QueryInsightsTicketStore = {
    snapshot: async () =>
      opts.snapshot ? opts.snapshot() : { existingKeys: new Set<string>(), openCount: 0 },
    createTicket: async (offender: QueryOffender, key: string): Promise<CreatedTicket> => {
      if (opts.createThrows) throw new Error("create failed");
      created.push({ key, title: buildTicketTitle(offender) });
      return { identifier: `TEA-${created.length}`, url: `https://linear.app/x/TEA-${created.length}` };
    },
  };

  const watcher = new QueryInsightsWatcher({
    config: makeConfig(opts.config),
    tracker,
    logger: makeLogger(),
    offenderClient,
    ticketStore,
    now: opts.now,
  });

  return { watcher, created, scanCalls: () => scanCalls };
}

describe("query-insights config parsing", () => {
  it("defaults to disabled and inherits team + first active state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-qi-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.queryInsights.enabled).toBe(false);
    expect(workflow.config.queryInsights.dataset).toBe("query_insights");
    expect(workflow.config.queryInsights.table).toBe("query_stats");
    expect(workflow.config.queryInsights.teamKey).toBe("TEA");
    expect(workflow.config.queryInsights.targetState).toBe("Dev in Progress");
    expect(workflow.config.queryInsights.label).toBe("query-insights");
    expect(workflow.config.queryInsights.lookbackDays).toBe(7);
  });

  it("respects opt-in config and explicit overrides", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-qi-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
query_insights:
  enabled: true
  project_id: team-dsc-au
  team_key: OPS
  target_state: Dev in Progress
  assignee_email: silas@teamdsc.com.au
  label: qi
  lookback_days: 14
  min_read_ops: 50000
  max_open_tickets: 5
  max_tickets_per_run: 2
  run_interval_ms: 86400000
  bq_timeout_ms: 30000
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.queryInsights).toEqual({
      enabled: true,
      projectId: "team-dsc-au",
      dataset: "query_insights",
      table: "query_stats",
      teamKey: "OPS",
      targetState: "Dev in Progress",
      assigneeEmail: "silas@teamdsc.com.au",
      label: "qi",
      lookbackDays: 14,
      minReadOps: 50000,
      maxOpenTickets: 5,
      maxTicketsPerRun: 2,
      runIntervalMs: 86400000,
      bqTimeoutMs: 30000,
    });
    expect(validateConfig(workflow.config)).toBeNull();
  });
});

describe("query-insights helpers", () => {
  it("round-trips the dedupe marker and builds an actionable ticket", () => {
    const offender = makeOffender();
    const key = offenderKey(offender);
    expect(key).toBe("getCurrentAssignmentsByCourse|course_assignments_current where(courseId)");

    const desc = buildTicketDescription(offender, key);
    expect(extractOffenderKey(desc)).toBe(key);
    expect(desc).toContain(".select(");
    expect(desc).toContain("composite index");
    expect(buildTicketTitle(offender)).toContain("getCurrentAssignmentsByCourse");
  });

  it("builds ranking SQL with window, floor, and absolute-cost ordering", () => {
    const sql = buildRankingSql(makeConfig({ lookbackDays: 7, minReadOps: 10000 }));
    expect(sql).toContain("`team-dsc-au.query_insights.query_stats`");
    expect(sql).toContain("INTERVAL 7 DAY");
    expect(sql).toContain("HAVING totalReadOps >= 10000");
    expect(sql).toContain("ORDER BY SUM(readOps) * AVG(latencyMs) DESC");
  });
});

describe("QueryInsightsWatcher", () => {
  it("does nothing and never scans when disabled", async () => {
    const { watcher, created, scanCalls } = makeWatcher({
      config: { enabled: false },
      offenders: async () => [makeOffender()],
    });
    await watcher.reconcile();
    expect(scanCalls()).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("files tickets for the worst offenders up to maxTicketsPerRun", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxTicketsPerRun: 2 },
      offenders: async () => [
        makeOffender({ callSite: "a", shape: "s1", totalReadOps: 3_000_000 }),
        makeOffender({ callSite: "b", shape: "s2", totalReadOps: 2_000_000 }),
        makeOffender({ callSite: "c", shape: "s3", totalReadOps: 1_000_000 }),
      ],
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["a|s1", "b|s2"]);
  });

  it("dedupes against existing tickets and counts open ones toward the cap", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 2, maxTicketsPerRun: 5 },
      offenders: async () => [
        makeOffender({ callSite: "a", shape: "s1" }),
        makeOffender({ callSite: "b", shape: "s2" }),
        makeOffender({ callSite: "c", shape: "s3" }),
      ],
      snapshot: async () => ({ existingKeys: new Set(["a|s1"]), openCount: 1 }),
    });
    await watcher.reconcile();
    // "a|s1" deduped; cap is 2 with 1 already open → only 1 more filed.
    expect(created.map(c => c.key)).toEqual(["b|s2"]);
  });

  it("runs the scan at most once per run interval (weekly gate)", async () => {
    let clock = 1_000_000;
    const { watcher, scanCalls } = makeWatcher({
      now: () => clock,
      offenders: async () => [],
    });
    await watcher.reconcile();
    expect(scanCalls()).toBe(1);

    // Immediately again — gated, no scan.
    await watcher.reconcile();
    expect(scanCalls()).toBe(1);

    // Advance past the interval — scans again.
    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    await watcher.reconcile();
    expect(scanCalls()).toBe(2);
  });

  it("does not advance the weekly clock when the scan fails (retries next tick)", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const watcher = new QueryInsightsWatcher({
      config: makeConfig(),
      tracker,
      logger: makeLogger(),
      now: () => clock,
      offenderClient: {
        topOffenders: async () => {
          attempts++;
          if (attempts === 1) throw new Error("bq timeout");
          return [];
        },
      },
      ticketStore: {
        snapshot: async () => ({ existingKeys: new Set<string>(), openCount: 0 }),
        createTicket: async () => ({ identifier: "TEA-1", url: null }),
      },
    });

    await watcher.reconcile(); // fails
    await watcher.reconcile(); // retries immediately (clock not advanced)
    expect(attempts).toBe(2);
  });
});
