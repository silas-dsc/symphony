import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, validateConfig } from "../config.js";
import {
  PostHogWatcher,
  buildTicketDescription,
  buildTicketTitle,
  extractReportKey,
  reportKey,
  type CreatedTicket,
  type PostHogReport,
  type PostHogReportsClient,
  type PostHogTicketSnapshot,
  type PostHogTicketStore,
} from "../posthog.js";
import type { Logger, PostHogConfig, TrackerConfig } from "../types.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeConfig(overrides?: Partial<PostHogConfig>): PostHogConfig {
  return {
    enabled: true,
    host: "https://us.posthog.com",
    projectId: "49303",
    apiKey: "phx_test",
    teamKey: "TEA",
    targetState: "Dev in Progress",
    assigneeEmail: "silas@teamdsc.com.au",
    label: "posthog",
    status: "active",
    orderBy: "occurrences",
    lookbackDays: 30,
    minOccurrences: 1,
    maxOpenTickets: 5,
    maxTicketsPerRun: 5,
    runIntervalMs: 24 * 60 * 60 * 1000,
    requestTimeoutMs: 30_000,
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

function makeReport(overrides?: Partial<PostHogReport>): PostHogReport {
  return {
    id: "01890-abc",
    name: "TypeError: cannot read properties of undefined",
    description: "at renderEvent (events.tsx:42)",
    status: "active",
    occurrences: 1200,
    sessions: 300,
    users: 210,
    firstSeen: "2026-06-01T00:00:00Z",
    lastSeen: "2026-06-27T00:00:00Z",
    url: "https://us.posthog.com/project/49303/error_tracking/01890-abc",
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: Partial<PostHogConfig>;
  reports: () => Promise<PostHogReport[]>;
  snapshot?: () => Promise<PostHogTicketSnapshot>;
  createThrows?: boolean;
  now?: () => number;
}): {
  watcher: PostHogWatcher;
  created: Array<{ key: string; title: string }>;
  pullCalls: () => number;
} {
  let pullCalls = 0;
  const created: Array<{ key: string; title: string }> = [];

  const reportsClient: PostHogReportsClient = {
    listReports: async () => { pullCalls++; return opts.reports(); },
  };

  const ticketStore: PostHogTicketStore = {
    snapshot: async () =>
      opts.snapshot ? opts.snapshot() : { existingKeys: new Set<string>(), openCount: 0 },
    createTicket: async (report: PostHogReport, key: string): Promise<CreatedTicket> => {
      if (opts.createThrows) throw new Error("create failed");
      created.push({ key, title: buildTicketTitle(report) });
      return { identifier: `TEA-${created.length}`, url: `https://linear.app/x/TEA-${created.length}` };
    },
  };

  const watcher = new PostHogWatcher({
    config: makeConfig(opts.config),
    tracker,
    logger: makeLogger(),
    reportsClient,
    ticketStore,
    now: opts.now,
  });

  return { watcher, created, pullCalls: () => pullCalls };
}

describe("posthog config parsing", () => {
  it("defaults to disabled and inherits team + first active state, with env-backed creds", () => {
    const prev = { ...process.env };
    process.env.POSTHOG_HOST = "https://eu.posthog.com";
    process.env.POSTHOG_PROJECT_ID = "777";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_envkey";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ph-cfg-"));
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
      expect(workflow.config.posthog.enabled).toBe(false);
      expect(workflow.config.posthog.host).toBe("https://eu.posthog.com");
      expect(workflow.config.posthog.projectId).toBe("777");
      expect(workflow.config.posthog.apiKey).toBe("phx_envkey");
      expect(workflow.config.posthog.teamKey).toBe("TEA");
      expect(workflow.config.posthog.targetState).toBe("Dev in Progress");
      expect(workflow.config.posthog.label).toBe("posthog");
      expect(workflow.config.posthog.status).toBe("active");
    } finally {
      process.env = prev;
    }
  });

  it("falls back to us.posthog.com when POSTHOG_HOST is unset", () => {
    const prev = { ...process.env };
    delete process.env.POSTHOG_HOST;
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ph-cfg-"));
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
      expect(workflow.config.posthog.host).toBe("https://us.posthog.com");
    } finally {
      process.env = prev;
    }
  });

  it("rejects an enabled config missing the project id", () => {
    const prev = { ...process.env };
    delete process.env.POSTHOG_PROJECT_ID;
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ph-cfg-"));
      const workflowPath = path.join(tmpDir, "WORKFLOW.md");
      fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
posthog:
  enabled: true
---

prompt body`, "utf8");
      const workflow = loadWorkflow(workflowPath);
      expect(validateConfig(workflow.config)).toMatch(/project_id/);
    } finally {
      process.env = prev;
    }
  });

  it("rejects a target_state that is not an active state", () => {
    const prev = { ...process.env };
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ph-cfg-"));
      const workflowPath = path.join(tmpDir, "WORKFLOW.md");
      fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
posthog:
  enabled: true
  target_state: Backlog
---

prompt body`, "utf8");
      const workflow = loadWorkflow(workflowPath);
      expect(validateConfig(workflow.config)).toMatch(/target_state/);
    } finally {
      process.env = prev;
    }
  });

  it("rejects an invalid status", () => {
    const prev = { ...process.env };
    process.env.POSTHOG_PROJECT_ID = "49303";
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_k";
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ph-cfg-"));
      const workflowPath = path.join(tmpDir, "WORKFLOW.md");
      fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
posthog:
  enabled: true
  status: nonsense
---

prompt body`, "utf8");
      const workflow = loadWorkflow(workflowPath);
      expect(validateConfig(workflow.config)).toMatch(/status/);
    } finally {
      process.env = prev;
    }
  });
});

describe("posthog helpers", () => {
  it("round-trips the dedupe marker and builds an actionable ticket", () => {
    const report = makeReport();
    const key = reportKey(report);
    expect(key).toBe("01890-abc");

    const desc = buildTicketDescription(report, key);
    expect(extractReportKey(desc)).toBe(key);
    expect(desc).toContain("Reproduce the exception");
    expect(desc).toContain(report.url);
    expect(buildTicketTitle(report)).toContain("1,200 occurrences");
  });
});

describe("PostHogWatcher", () => {
  it("does nothing and never pulls when disabled", async () => {
    const { watcher, created, pullCalls } = makeWatcher({
      config: { enabled: false },
      reports: async () => [makeReport()],
    });
    await watcher.reconcile();
    expect(pullCalls()).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("files tickets for the loudest reports up to maxTicketsPerRun", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxTicketsPerRun: 2 },
      reports: async () => [
        makeReport({ id: "a", occurrences: 50 }),
        makeReport({ id: "b", occurrences: 500 }),
        makeReport({ id: "c", occurrences: 300 }),
      ],
    });
    await watcher.reconcile();
    // Sorted by occurrences desc → b, then c.
    expect(created.map(c => c.key)).toEqual(["b", "c"]);
  });

  it("drops reports below the occurrence floor", async () => {
    const { watcher, created } = makeWatcher({
      config: { minOccurrences: 100 },
      reports: async () => [
        makeReport({ id: "a", occurrences: 5 }),
        makeReport({ id: "b", occurrences: 250 }),
      ],
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["b"]);
  });

  it("dedupes against existing tickets and counts open ones toward the cap", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 2, maxTicketsPerRun: 5 },
      reports: async () => [
        makeReport({ id: "a", occurrences: 300 }),
        makeReport({ id: "b", occurrences: 200 }),
        makeReport({ id: "c", occurrences: 100 }),
      ],
      snapshot: async () => ({ existingKeys: new Set(["a"]), openCount: 1 }),
    });
    await watcher.reconcile();
    // "a" deduped; cap is 2 with 1 already open → only 1 more filed.
    expect(created.map(c => c.key)).toEqual(["b"]);
  });

  it("runs the pull at most once per run interval (daily gate)", async () => {
    let clock = 1_000_000;
    const { watcher, pullCalls } = makeWatcher({
      now: () => clock,
      reports: async () => [],
    });
    await watcher.reconcile();
    expect(pullCalls()).toBe(1);

    await watcher.reconcile();
    expect(pullCalls()).toBe(1);

    clock += 24 * 60 * 60 * 1000 + 1;
    await watcher.reconcile();
    expect(pullCalls()).toBe(2);
  });

  it("does not advance the daily clock when the pull fails (retries next tick)", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const watcher = new PostHogWatcher({
      config: makeConfig(),
      tracker,
      logger: makeLogger(),
      now: () => clock,
      reportsClient: {
        listReports: async () => {
          attempts++;
          if (attempts === 1) throw new Error("posthog 500");
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

  it("runOnce ignores the enabled flag and the interval gate", async () => {
    const { watcher, created } = makeWatcher({
      config: { enabled: false },
      reports: async () => [makeReport({ id: "x", occurrences: 10 })],
    });
    const result = await watcher.runOnce();
    expect(created.map(c => c.key)).toEqual(["x"]);
    expect(result).toHaveLength(1);
  });
});
