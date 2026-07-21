import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, validateConfig } from "../config.js";
import {
  FirebaseLogsWatcher,
  buildLogFilter,
  buildTicketDescription,
  buildTicketTitle,
  errorGroupKey,
  extractErrorKey,
  groupErrors,
  isFixableError,
  normalizeMessage,
  type CreatedTicket,
  type FirebaseErrorGroup,
  type FirebaseLogEntry,
  type FirebaseLogsClient,
  type FirebaseLogsTicketSnapshot,
  type FirebaseLogsTicketStore,
} from "../firebase-logs.js";
import type { FirebaseLogsConfig, Logger, TrackerConfig } from "../types.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeConfig(overrides?: Partial<FirebaseLogsConfig>): FirebaseLogsConfig {
  return {
    enabled: true,
    projectId: "team-dsc-au",
    teamKey: "TEA",
    targetState: "Dev in Progress",
    assigneeEmail: "silas@teamdsc.com.au",
    label: "firebase-logs",
    minSeverity: "ERROR",
    lookbackHours: 24,
    minOccurrences: 1,
    maxLogEntries: 1000,
    maxOpenTickets: 5,
    maxTicketsPerRun: 5,
    runIntervalMs: 6 * 60 * 60 * 1000,
    gcloudTimeoutMs: 60_000,
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

function entry(overrides?: Partial<FirebaseLogEntry>): FirebaseLogEntry {
  return {
    functionName: "api",
    severity: "ERROR",
    message: "TypeError: Cannot read properties of undefined (reading 'id')\n    at handler (index.js:42:10)",
    timestamp: "2026-07-20T10:00:00Z",
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: Partial<FirebaseLogsConfig>;
  entries: () => Promise<FirebaseLogEntry[]>;
  snapshot?: () => Promise<FirebaseLogsTicketSnapshot>;
  createThrows?: boolean;
  now?: () => number;
}): {
  watcher: FirebaseLogsWatcher;
  created: Array<{ key: string; title: string }>;
  scans: () => number;
} {
  let scans = 0;
  const created: Array<{ key: string; title: string }> = [];

  const logsClient: FirebaseLogsClient = {
    fetchErrorLogs: async () => { scans++; return opts.entries(); },
  };

  const ticketStore: FirebaseLogsTicketStore = {
    snapshot: async () =>
      opts.snapshot ? opts.snapshot() : { existingKeys: new Set<string>(), openCount: 0 },
    createTicket: async (group: FirebaseErrorGroup, key: string): Promise<CreatedTicket> => {
      if (opts.createThrows) throw new Error("create failed");
      created.push({ key, title: buildTicketTitle(group) });
      return { identifier: `TEA-${created.length}`, url: `https://linear.app/x/TEA-${created.length}` };
    },
  };

  const watcher = new FirebaseLogsWatcher({
    config: makeConfig(opts.config),
    tracker,
    logger: makeLogger(),
    logsClient,
    ticketStore,
    now: opts.now,
  });

  return { watcher, created, scans: () => scans };
}

describe("firebase_logs config parsing", () => {
  it("defaults to disabled and inherits team + first active state + query_insights project", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-fb-cfg-"));
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
  project_id: team-dsc-au
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.firebaseLogs.enabled).toBe(false);
    expect(workflow.config.firebaseLogs.projectId).toBe("team-dsc-au");
    expect(workflow.config.firebaseLogs.teamKey).toBe("TEA");
    expect(workflow.config.firebaseLogs.targetState).toBe("Dev in Progress");
    expect(workflow.config.firebaseLogs.label).toBe("firebase-logs");
    expect(workflow.config.firebaseLogs.minSeverity).toBe("ERROR");
  });

  it("rejects an enabled config with no resolvable project id", () => {
    const prev = { ...process.env };
    delete process.env.GCLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-fb-cfg-"));
      const workflowPath = path.join(tmpDir, "WORKFLOW.md");
      fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
firebase_logs:
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-fb-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
firebase_logs:
  enabled: true
  project_id: team-dsc-au
  target_state: Backlog
---

prompt body`, "utf8");
    const workflow = loadWorkflow(workflowPath);
    expect(validateConfig(workflow.config)).toMatch(/target_state/);
  });

  it("rejects an invalid severity", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-fb-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
firebase_logs:
  enabled: true
  project_id: team-dsc-au
  min_severity: chatty
---

prompt body`, "utf8");
    const workflow = loadWorkflow(workflowPath);
    expect(validateConfig(workflow.config)).toMatch(/min_severity/);
  });
});

describe("firebase_logs helpers", () => {
  it("normalizes volatile bits out of a message so the same bug groups together", () => {
    const a = normalizeMessage("Failed to load user 12345 from https://x/y?z=1 with id 'abc-9'");
    const b = normalizeMessage("Failed to load user 98 from https://q/r?z=7 with id 'zzz-1'");
    expect(a).toBe(b);
    expect(a).toContain("<url>");
    expect(a).toContain("<str>");
    expect(a).toContain("<n>");
  });

  it("classifies application bugs as fixable and transient infra noise as not", () => {
    expect(isFixableError("TypeError: cannot read properties of undefined")).toBe(true);
    expect(isFixableError("ReferenceError: foo is not defined")).toBe(true);
    expect(isFixableError("Error: 4 DEADLINE_EXCEEDED: Deadline exceeded")).toBe(false);
    expect(isFixableError("Error: 14 UNAVAILABLE: The service is currently unavailable")).toBe(false);
    expect(isFixableError("write ECONNRESET")).toBe(false);
    expect(isFixableError("Function execution took 60001 ms, finished with status: 'timeout'")).toBe(false);
    expect(isFixableError("")).toBe(false);
  });

  it("groups by function + signature, tallies counts, and tracks the time span", () => {
    const groups = groupErrors([
      entry({ functionName: "api", message: "TypeError: bad id 1", timestamp: "2026-07-20T10:00:00Z" }),
      entry({ functionName: "api", message: "TypeError: bad id 2", timestamp: "2026-07-20T12:00:00Z" }),
      entry({ functionName: "worker", message: "TypeError: bad id 3", timestamp: "2026-07-20T11:00:00Z" }),
    ]);
    const api = groups.find(g => g.functionName === "api");
    expect(api?.count).toBe(2);
    expect(api?.firstSeen).toBe("2026-07-20T10:00:00Z");
    expect(api?.lastSeen).toBe("2026-07-20T12:00:00Z");
    expect(groups).toHaveLength(2);
  });

  it("round-trips the dedupe marker and builds an actionable ticket", () => {
    const [group] = groupErrors([entry()]);
    const key = errorGroupKey(group);
    const desc = buildTicketDescription(group, key);
    expect(extractErrorKey(desc)).toBe(key);
    expect(desc).toContain("Reproduce the error");
    expect(desc).toContain("api");
    expect(buildTicketTitle(group)).toContain("[Firebase Logs]");
  });

  it("builds a filter covering both function generations at the configured severity", () => {
    const filter = buildLogFilter(makeConfig({ minSeverity: "WARNING" }));
    expect(filter).toContain("severity>=WARNING");
    expect(filter).toContain('resource.type="cloud_function"');
    expect(filter).toContain('resource.type="cloud_run_revision"');
  });
});

describe("FirebaseLogsWatcher", () => {
  it("does nothing and never scans when disabled", async () => {
    const { watcher, created, scans } = makeWatcher({
      config: { enabled: false },
      entries: async () => [entry()],
    });
    await watcher.reconcile();
    expect(scans()).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("files tickets for fixable errors, skipping transient noise", async () => {
    const { watcher, created } = makeWatcher({
      entries: async () => [
        entry({ functionName: "api", message: "TypeError: boom", timestamp: "t1" }),
        entry({ functionName: "billing", message: "Error: 14 UNAVAILABLE: service down", timestamp: "t2" }),
      ],
    });
    await watcher.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0].title).toContain("api");
  });

  it("sorts worst-first (severity then count) and honours maxTicketsPerRun", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxTicketsPerRun: 2 },
      entries: async () => [
        entry({ functionName: "a", severity: "ERROR", message: "TypeError: a" }),
        entry({ functionName: "b", severity: "CRITICAL", message: "TypeError: b" }),
        entry({ functionName: "c", severity: "ERROR", message: "TypeError: c" }),
        entry({ functionName: "c", severity: "ERROR", message: "TypeError: c" }),
      ],
    });
    await watcher.reconcile();
    // CRITICAL b first; then among ERROR, c (count 2) before a (count 1).
    expect(created.map(c => c.title.includes("b:") ? "b" : c.title.includes("c:") ? "c" : "a")).toEqual(["b", "c"]);
  });

  it("drops signatures below the occurrence floor", async () => {
    const { watcher, created } = makeWatcher({
      config: { minOccurrences: 2 },
      entries: async () => [
        entry({ functionName: "a", message: "TypeError: once" }),
        entry({ functionName: "b", message: "TypeError: twice" }),
        entry({ functionName: "b", message: "TypeError: twice" }),
      ],
    });
    await watcher.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0].title).toContain("b");
  });

  it("dedupes against existing tickets and counts open ones toward the cap", async () => {
    const [existingGroup] = groupErrors([entry({ functionName: "api", message: "TypeError: known" })]);
    const existingKey = errorGroupKey(existingGroup);
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 2, maxTicketsPerRun: 5 },
      entries: async () => [
        entry({ functionName: "api", message: "TypeError: known" }),
        entry({ functionName: "svc", message: "TypeError: fresh one" }),
        entry({ functionName: "svc2", message: "TypeError: fresh two" }),
      ],
      snapshot: async () => ({ existingKeys: new Set([existingKey]), openCount: 1 }),
    });
    await watcher.reconcile();
    // "known" deduped; cap is 2 with 1 already open → only 1 more filed.
    expect(created).toHaveLength(1);
  });

  it("runs the scan at most once per run interval", async () => {
    let clock = 1_000_000;
    const { watcher, scans } = makeWatcher({
      now: () => clock,
      entries: async () => [],
    });
    await watcher.reconcile();
    expect(scans()).toBe(1);

    await watcher.reconcile();
    expect(scans()).toBe(1);

    clock += 6 * 60 * 60 * 1000 + 1;
    await watcher.reconcile();
    expect(scans()).toBe(2);
  });

  it("does not advance the interval clock when the scan fails (retries next tick)", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    const watcher = new FirebaseLogsWatcher({
      config: makeConfig(),
      tracker,
      logger: makeLogger(),
      now: () => clock,
      logsClient: {
        fetchErrorLogs: async () => {
          attempts++;
          if (attempts === 1) throw new Error("gcloud 401");
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
      entries: async () => [entry({ functionName: "x", message: "TypeError: x" })],
    });
    const result = await watcher.runOnce();
    expect(created).toHaveLength(1);
    expect(result).toHaveLength(1);
  });
});
