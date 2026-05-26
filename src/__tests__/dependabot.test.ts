import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, validateConfig } from "../config.js";
import {
  DependabotWatcher,
  buildDependabotTicketTitle,
  buildDependabotTicketDescription,
  dependabotAlertKey,
  extractAlertKey,
  severityRank,
  type CreatedTicket,
  type DependabotAlert,
  type DependabotAlertClient,
  type DependabotTicketSnapshot,
  type DependabotTicketStore,
} from "../dependabot.js";
import type { DependabotConfig, Logger, TrackerConfig } from "../types.js";

function makeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeConfig(overrides?: Partial<DependabotConfig>): DependabotConfig {
  return {
    enabled: true,
    repoOwner: "team-dsc",
    repoName: "team-dsc",
    teamKey: "TEA",
    targetState: "Dev in Progress",
    assigneeEmail: "silas@teamdsc.com.au",
    label: "dependabot",
    minSeverity: "low",
    maxOpenTickets: 1,
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

function makeAlert(number: number, overrides?: Partial<DependabotAlert>): DependabotAlert {
  return {
    number,
    state: "open",
    ecosystem: "npm",
    packageName: "lodash",
    manifestPath: "package.json",
    scope: "runtime",
    severity: "high",
    summary: "Prototype pollution in lodash",
    description: "A long advisory description.",
    ghsaId: "GHSA-xxxx-xxxx-xxxx",
    cveId: "CVE-2020-8203",
    vulnerableRange: "< 4.17.19",
    firstPatchedVersion: "4.17.19",
    references: ["https://example.com/advisory"],
    htmlUrl: `https://github.com/team-dsc/team-dsc/security/dependabot/${number}`,
    ...overrides,
  };
}

function makeWatcher(opts: {
  config?: Partial<DependabotConfig>;
  alerts: () => Promise<DependabotAlert[]>;
  snapshot?: () => Promise<DependabotTicketSnapshot>;
  onCreate?: (alert: DependabotAlert, key: string) => void;
  createThrows?: boolean;
}): {
  watcher: DependabotWatcher;
  created: Array<{ key: string; title: string; description: string }>;
  alertCalls: () => number;
} {
  let alertCalls = 0;
  const created: Array<{ key: string; title: string; description: string }> = [];

  const alertClient: DependabotAlertClient = {
    listOpenAlerts: async () => { alertCalls++; return opts.alerts(); },
  };

  const ticketStore: DependabotTicketStore = {
    snapshot: async () =>
      opts.snapshot ? opts.snapshot() : { existingKeys: new Set<string>(), openCount: 0 },
    createTicket: async (alert: DependabotAlert, key: string): Promise<CreatedTicket> => {
      if (opts.createThrows) throw new Error("create failed");
      opts.onCreate?.(alert, key);
      created.push({
        key,
        title: buildDependabotTicketTitle(alert),
        description: buildDependabotTicketDescription(alert, key),
      });
      return { identifier: `TEA-${alert.number}`, url: `https://linear.app/x/TEA-${alert.number}` };
    },
  };

  const watcher = new DependabotWatcher({
    config: makeConfig(opts.config),
    tracker,
    logger: makeLogger(),
    alertClient,
    ticketStore,
  });

  return { watcher, created, alertCalls: () => alertCalls };
}

describe("dependabot config parsing", () => {
  it("defaults to disabled and inherits repo, team, and first active state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-db-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
github_preview:
  repo_owner: acme
  repo_name: widgets
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.dependabot.enabled).toBe(false);
    expect(workflow.config.dependabot.repoOwner).toBe("acme");
    expect(workflow.config.dependabot.repoName).toBe("widgets");
    expect(workflow.config.dependabot.teamKey).toBe("TEA");
    expect(workflow.config.dependabot.targetState).toBe("Dev in Progress");
    expect(workflow.config.dependabot.label).toBe("dependabot");
    expect(workflow.config.dependabot.minSeverity).toBe("low");
    expect(workflow.config.dependabot.maxOpenTickets).toBe(1);
  });

  it("respects opt-in config and explicit overrides", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-db-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
dependabot:
  enabled: true
  repo_owner: other-org
  repo_name: other-repo
  team_key: OPS
  target_state: Dev in Progress
  assignee_email: silas@teamdsc.com.au
  label: deps
  min_severity: high
  max_open_tickets: 2
  request_timeout_ms: 5000
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.dependabot).toEqual({
      enabled: true,
      repoOwner: "other-org",
      repoName: "other-repo",
      teamKey: "OPS",
      targetState: "Dev in Progress",
      assigneeEmail: "silas@teamdsc.com.au",
      label: "deps",
      minSeverity: "high",
      maxOpenTickets: 2,
      requestTimeoutMs: 5000,
    });
    expect(validateConfig(workflow.config)).toBeNull();
  });

  it("rejects a target_state that is not an active state", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-db-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: ALL
  team_key: TEA
  active_states:
    - Dev in Progress
dependabot:
  enabled: true
  repo_owner: acme
  repo_name: widgets
  target_state: Backlog
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(validateConfig(workflow.config)).toMatch(/target_state/);
  });
});

describe("dependabot helpers", () => {
  it("ranks severities and round-trips the dedupe marker", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("moderate")).toBe(severityRank("medium"));

    const key = dependabotAlertKey("team-dsc", "team-dsc", 7);
    expect(key).toBe("team-dsc/team-dsc#7");
    const desc = buildDependabotTicketDescription(makeAlert(7), key);
    expect(extractAlertKey(desc)).toBe(key);
  });

  it("builds an actionable title and description", () => {
    const alert = makeAlert(3);
    expect(buildDependabotTicketTitle(alert)).toContain("lodash");
    expect(buildDependabotTicketTitle(alert)).toContain("high");

    const desc = buildDependabotTicketDescription(alert, "team-dsc/team-dsc#3");
    expect(desc).toContain("4.17.19");
    expect(desc).toContain("pnpm install");
    expect(desc).toContain("GHSA-xxxx-xxxx-xxxx");
  });

  it("gives different acceptance criteria when no patch is available", () => {
    const desc = buildDependabotTicketDescription(
      makeAlert(4, { firstPatchedVersion: null }),
      "team-dsc/team-dsc#4",
    );
    expect(desc).toContain("none published yet");
    expect(desc).toMatch(/mitigation|dismiss/i);
  });
});

describe("DependabotWatcher", () => {
  it("does nothing and never polls when disabled", async () => {
    const { watcher, created, alertCalls } = makeWatcher({
      config: { enabled: false },
      alerts: async () => [makeAlert(1)],
    });
    await watcher.reconcile();
    expect(alertCalls()).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("files a ticket only for the most severe new alert (one open at a time)", async () => {
    const { watcher, created } = makeWatcher({
      alerts: async () => [
        makeAlert(1, { severity: "low" }),
        makeAlert(2, { severity: "critical", packageName: "axios" }),
        makeAlert(3, { severity: "high" }),
      ],
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["team-dsc/team-dsc#2"]);
    expect(watcher.getCreatedCount()).toBe(1);
  });

  it("files nothing while a Dependabot ticket is already open", async () => {
    const { watcher, created } = makeWatcher({
      alerts: async () => [makeAlert(1), makeAlert(2)],
      snapshot: async () => ({ existingKeys: new Set<string>(), openCount: 1 }),
    });
    await watcher.reconcile();
    expect(created).toHaveLength(0);
  });

  it("counts already-open tickets toward the cap", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 2 },
      alerts: async () => [makeAlert(1), makeAlert(2), makeAlert(3)],
      snapshot: async () => ({ existingKeys: new Set<string>(), openCount: 1 }),
    });
    await watcher.reconcile();
    expect(created).toHaveLength(1);
  });

  it("dedupes against existing Linear tickets", async () => {
    const { watcher, created } = makeWatcher({
      alerts: async () => [makeAlert(1), makeAlert(2)],
      snapshot: async () => ({ existingKeys: new Set(["team-dsc/team-dsc#1"]), openCount: 0 }),
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["team-dsc/team-dsc#2"]);
  });

  it("does not re-file a ticket it already created this run", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 10 },
      alerts: async () => [makeAlert(1)],
    });
    await watcher.reconcile();
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["team-dsc/team-dsc#1"]);
  });

  it("skips alerts below the minimum severity and files worst-first", async () => {
    const { watcher, created } = makeWatcher({
      config: { minSeverity: "high", maxOpenTickets: 10 },
      alerts: async () => [
        makeAlert(1, { severity: "low" }),
        makeAlert(2, { severity: "moderate" }),
        makeAlert(3, { severity: "high" }),
        makeAlert(4, { severity: "critical" }),
      ],
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["team-dsc/team-dsc#4", "team-dsc/team-dsc#3"]);
  });

  it("ignores alerts that are not open", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 10 },
      alerts: async () => [
        makeAlert(1, { state: "dismissed" }),
        makeAlert(2, { state: "fixed" }),
        makeAlert(3, { state: "open" }),
      ],
    });
    await watcher.reconcile();
    expect(created.map(c => c.key)).toEqual(["team-dsc/team-dsc#3"]);
  });

  it("caps the number of tickets it files at maxOpenTickets", async () => {
    const { watcher, created } = makeWatcher({
      config: { maxOpenTickets: 2 },
      alerts: async () => [makeAlert(1), makeAlert(2), makeAlert(3)],
    });
    await watcher.reconcile();
    expect(created).toHaveLength(2);
  });

  it("skips creation for the whole tick if the ticket snapshot fails", async () => {
    const { watcher, created } = makeWatcher({
      alerts: async () => [makeAlert(1)],
      snapshot: async () => { throw new Error("linear down"); },
    });
    await watcher.reconcile();
    expect(created).toHaveLength(0);
    // A later tick with a healthy snapshot files the ticket.
    const recovered = makeWatcher({ alerts: async () => [makeAlert(1)] });
    await recovered.watcher.reconcile();
    expect(recovered.created.map(c => c.key)).toEqual(["team-dsc/team-dsc#1"]);
  });
});
