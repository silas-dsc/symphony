import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../linear.js", () => ({
  executeGraphQL: vi.fn(),
  fetchTeamByKey: vi.fn(),
}));
import * as linear from "../linear.js";

import {
  QUIET_DAY,
  ReportScheduler,
  buildRoadmap,
  compareNotStarted,
  fetchDailyActivity,
  fetchRoadmap,
  formatDailyDraft,
  formatProjectLine,
  formatTargetDate,
  formatWeeklyRoadmap,
  isoWeekKey,
  parseWaitingLabels,
  progressBar,
  suggestNext,
  type DailyActivity,
  type RawIssue,
  type ReportIssue,
  type Roadmap,
  type RoadmapProject,
} from "../reports.js";
import type { Logger, TrackerConfig } from "../types.js";

const tracker: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "test-key",
  projectSlug: "ALL",
  teamKey: "TEA",
  activeStates: ["Dev in Progress"],
  terminalStates: ["Done"],
};

function makeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return { info: () => undefined, warn: () => undefined, error: (m: string) => void errors.push(m), errors };
}

function issue(overrides: Partial<ReportIssue> = {}): ReportIssue {
  return {
    id: "id-1",
    identifier: "TEA-1",
    title: "Fix the thing",
    url: "https://linear.app/t/issue/TEA-1",
    assignee: "Silas",
    project: "Platform",
    stateName: "Dev in Progress",
    stateType: "started",
    priority: 3,
    labels: [],
    createdAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function raw(overrides: Partial<RawIssue> & { stateName?: string; stateType?: string; labelNames?: string[] } = {}): RawIssue {
  const { stateName = "Dev in Progress", stateType = "started", labelNames = [], ...rest } = overrides;
  return {
    id: rest.identifier ?? "TEA-1",
    identifier: "TEA-1",
    title: "Title",
    url: `https://linear.app/t/issue/${rest.identifier ?? "TEA-1"}`,
    priority: 3,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-04T10:00:00Z",
    completedAt: null,
    state: { name: stateName, type: stateType },
    assignee: { name: "silas", displayName: "Silas" },
    project: { id: "p1", name: "Platform" },
    labels: { nodes: labelNames.map(name => ({ name, parent: null })) },
    attachments: { nodes: [] },
    ...rest,
  };
}

// ─── Daily draft ──────────────────────────────────────────────────────────────

describe("formatDailyDraft", () => {
  const empty: DailyActivity = { since: "2026-11-03T00:00:00Z", done: [], inReview: [], inProgress: [], waiting: [] };

  it("returns the quiet-day line when everything is empty", () => {
    expect(formatDailyDraft(empty, { openGates: 2 })).toBe(QUIET_DAY);
    expect(QUIET_DAY).toBe("Quiet day — nothing shipped.");
  });

  it("renders Done / Working on / Waiting on and omits empty sections", () => {
    const text = formatDailyDraft(
      {
        ...empty,
        done: [issue({ identifier: "TEA-123", title: "Ship login", url: "https://l/TEA-123" })],
        inReview: [issue({ identifier: "TEA-5", title: "Review me", url: "https://l/TEA-5" })],
        waiting: [
          {
            ...issue({ identifier: "TEA-9", title: "Hero banner", url: "https://l/TEA-9" }),
            waitingOn: ["Nika"],
            reason: "visual check",
          },
        ],
      },
      { openGates: 3, governorNote: "Usage at 40% of the week." },
    );
    expect(text).toBe(
      [
        "*Done:*",
        "• TEA-123 <https://l/TEA-123|Ship login>",
        "",
        "*Working on:*",
        "• TEA-5 <https://l/TEA-5|Review me> (in review)",
        "",
        "*Waiting on:*",
        "• TEA-9 <https://l/TEA-9|Hero banner> — Nika (visual check)",
        "",
        "_3 gates open._",
        "_Usage at 40% of the week._",
      ].join("\n"),
    );
  });

  it("caps sections at 6 bullets with +N more and shortens long titles", () => {
    const done = Array.from({ length: 9 }, (_, i) =>
      issue({ identifier: `TEA-${i}`, title: "x".repeat(100), url: `https://l/${i}` }),
    );
    const text = formatDailyDraft({ ...empty, done }, { openGates: 0 });
    const bullets = text.split("\n").filter(l => l.startsWith("• "));
    expect(bullets).toHaveLength(6);
    expect(text).toContain("+3 more");
    expect(text).not.toContain("Working on");
    expect(text).not.toContain("gate");
    expect(bullets[0]).toContain("…>");
    expect(bullets[0]!.length).toBeLessThan(100);
  });

  it("uses singular 'gate' for one open gate", () => {
    const text = formatDailyDraft({ ...empty, inProgress: [issue()] }, { openGates: 1 });
    expect(text).toContain("_1 gate open._");
  });
});

describe("parseWaitingLabels", () => {
  it("reads flat and grouped labels", () => {
    expect(parseWaitingLabels([{ name: "waiting-on:Nika:visual check" }])).toEqual({ who: ["Nika"], reason: "visual check" });
    expect(parseWaitingLabels([{ name: "Waiting-on:Evie" }, { name: "Bug" }])).toEqual({ who: ["Evie"] });
    expect(parseWaitingLabels([{ name: "Silas", parent: { name: "waiting-on" } }])).toEqual({ who: ["Silas"] });
    expect(parseWaitingLabels([{ name: "Bug" }])).toEqual({ who: [] });
  });
});

describe("fetchDailyActivity", () => {
  beforeEach(() => vi.mocked(linear.executeGraphQL).mockReset());

  it("queries the team since the given time and groups the results", async () => {
    const since = "2026-11-03T16:00:00Z";
    vi.mocked(linear.executeGraphQL)
      .mockResolvedValueOnce({
        issues: {
          nodes: [
            raw({ identifier: "TEA-1", stateName: "Done", stateType: "completed", completedAt: "2026-11-04T09:00:00Z" }),
            raw({ identifier: "TEA-2", stateName: "Done", stateType: "completed", completedAt: "2026-11-01T09:00:00Z" }),
            raw({ identifier: "TEA-3", stateName: "Ready to Deploy", stateType: "started" }),
            raw({
              identifier: "TEA-4",
              stateName: "In Review",
              stateType: "started",
              attachments: { nodes: [{ sourceType: "github", metadata: { status: "merged" } }] },
            }),
          ],
          pageInfo: { hasNextPage: true, endCursor: "c1" },
        },
      })
      .mockResolvedValueOnce({
        issues: {
          nodes: [
            raw({ identifier: "TEA-5", stateName: "In Review", stateType: "started" }),
            raw({ identifier: "TEA-6", stateName: "Human Dev", stateType: "started", assignee: null }),
            raw({ identifier: "TEA-7", stateName: "Design in Progress", stateType: "started", project: null }),
            raw({ identifier: "TEA-8", stateName: "Dev in Progress", stateType: "started", labelNames: ["waiting-on:Nika:visual check"] }),
            raw({ identifier: "TEA-9", stateName: "Todo", stateType: "unstarted" }),
            raw({ identifier: "TEA-10", stateName: "Canceled", stateType: "canceled", labelNames: ["waiting-on:Evie"] }),
            raw({ identifier: "TEA-1", stateName: "Done", stateType: "completed", completedAt: "2026-11-04T09:00:00Z" }),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const activity = await fetchDailyActivity(tracker, "TEA", since);

    const calls = vi.mocked(linear.executeGraphQL).mock.calls;
    expect(calls).toHaveLength(2);
    const vars = calls[0]![2] as { filter: Record<string, unknown>; first: number };
    expect(vars.filter.team).toEqual({ key: { eq: "TEA" } });
    expect(JSON.stringify(vars.filter)).toContain(`"updatedAt":{"gte":"${since}"}`);
    expect(calls[1]![2]).toMatchObject({ after: "c1" });

    const ids = (xs: ReportIssue[]) => xs.map(i => i.identifier);
    expect(ids(activity.done)).toEqual(["TEA-1", "TEA-3", "TEA-4"]);
    expect(ids(activity.inReview)).toEqual(["TEA-5"]);
    expect(ids(activity.inProgress)).toEqual(["TEA-6", "TEA-7"]);
    expect(ids(activity.waiting)).toEqual(["TEA-8"]);
    expect(activity.waiting[0]).toMatchObject({ waitingOn: ["Nika"], reason: "visual check" });

    const tea6 = activity.inProgress[0]!;
    expect(tea6.assignee).toBeNull();
    expect(tea6.project).toBe("Platform");
    expect(activity.inProgress[1]!.project).toBeNull();
    expect(activity.done[0]).toMatchObject({ assignee: "Silas", project: "Platform", url: "https://linear.app/t/issue/TEA-1" });
  });
});

// ─── Roadmap ──────────────────────────────────────────────────────────────────

function project(overrides: Partial<RoadmapProject> = {}): RoadmapProject {
  return {
    id: "p1",
    name: "Checkout",
    url: "https://l/p1",
    state: "started",
    progress: 0.62,
    targetDate: "2026-12-12",
    lead: "Silas",
    counts: { completed: 5, started: 3, unstarted: 2, backlog: 1, canceled: 0 },
    blocked: 1,
    topNext: [],
    ...overrides,
  };
}

describe("roadmap formatting helpers", () => {
  it("draws a 6-cell bar", () => {
    expect(progressBar(0.62)).toBe("▓▓▓▓░░");
    expect(progressBar(0)).toBe("░░░░░░");
    expect(progressBar(1.4)).toBe("▓▓▓▓▓▓");
  });

  it("formats target dates", () => {
    expect(formatTargetDate("2026-12-12")).toBe("12 Dec");
    expect(formatTargetDate("2027-01-05")).toBe("5 Jan");
  });

  it("formats a project line", () => {
    expect(formatProjectLine(project())).toBe(
      "▓▓▓▓░░ 62% — <https://l/p1|Checkout> (target 12 Dec) · 3 in progress · 1 blocked",
    );
    expect(
      formatProjectLine(project({ targetDate: null, blocked: 0, counts: { completed: 0, started: 0, unstarted: 0, backlog: 0, canceled: 0 } })),
    ).toBe("▓▓▓▓░░ 62% — <https://l/p1|Checkout>");
  });

  it("orders not-started issues by priority, then ux-insights/Bug, then oldest", () => {
    const list = [
      issue({ identifier: "A", priority: 0 }),
      issue({ identifier: "B", priority: 3, createdAt: "2026-09-01T00:00:00Z" }),
      issue({ identifier: "C", priority: 3, labels: ["Bug"], createdAt: "2026-10-20T00:00:00Z" }),
      issue({ identifier: "D", priority: 1 }),
      issue({ identifier: "E", priority: 3, createdAt: "2026-08-01T00:00:00Z" }),
    ];
    expect(list.sort(compareNotStarted).map(i => i.identifier)).toEqual(["D", "C", "E", "B", "A"]);
  });
});

describe("suggestNext / formatWeeklyRoadmap", () => {
  const roadmap: Roadmap = {
    teamKey: "TEA",
    projects: [
      project({
        id: "p1",
        name: "Checkout",
        progress: 0.9,
        topNext: [
          issue({ identifier: "TEA-11", title: "Last checkout fix", url: "https://l/11", priority: 3 }),
          issue({ identifier: "TEA-12", title: "Checkout copy", url: "https://l/12", priority: 4 }),
          issue({ identifier: "TEA-13", title: "Checkout polish", url: "https://l/13", priority: 4 }),
        ],
      }),
      project({
        id: "p2",
        name: "Search",
        progress: 0.2,
        topNext: [
          issue({ identifier: "TEA-21", title: "Search outage", url: "https://l/21", priority: 1 }),
          issue({ identifier: "TEA-22", title: "No results", url: "https://l/22", priority: 3, labels: ["customer-reported"] }),
        ],
      }),
      project({
        id: "p3",
        name: "Later",
        state: "planned",
        progress: 0,
        topNext: [issue({ identifier: "TEA-31", priority: 1 })],
      }),
    ],
  };

  it("ranks across in-progress projects with one-clause reasons, max 2 per project", () => {
    const s = suggestNext(roadmap);
    expect(s.map(x => x.issue.identifier)).toEqual(["TEA-21", "TEA-11", "TEA-22", "TEA-12"]);
    expect(s[0]!.reason).toBe("urgent");
    expect(s[1]!.reason).toBe("helps finish Checkout (90% done)");
    expect(s[2]!.reason).toBe("customer-reported");
    expect(s.some(x => x.issue.identifier === "TEA-31")).toBe(false); // planned project
  });

  it("renders the weekly message", () => {
    const text = formatWeeklyRoadmap(roadmap, { shippedThisWeek: 7, errorTicketsOpen: 2 });
    const lines = text.split("\n");
    expect(lines[0]).toBe("*Weekly roadmap*");
    expect(lines[1]).toBe("Shipped this week: 7 · open error tickets: 2");
    expect(text).toContain("▓▓▓▓▓░ 90% — <https://l/p1|Checkout> (target 12 Dec) · 3 in progress · 1 blocked");
    expect(text).toContain("[planned]");
    expect(text).toContain("*Suggested next:*");
    expect(text).toContain("• TEA-21 <https://l/21|Search outage> — urgent");
  });

  it("handles no projects", () => {
    const text = formatWeeklyRoadmap({ teamKey: "TEA", projects: [] }, { shippedThisWeek: 0 });
    expect(text).toContain("No active projects.");
    expect(text).not.toContain("Suggested next");
    expect(text).not.toContain("error tickets");
  });
});

describe("fetchRoadmap", () => {
  beforeEach(() => {
    vi.mocked(linear.executeGraphQL).mockReset();
    vi.mocked(linear.fetchTeamByKey).mockReset();
  });

  it("loads started/planned projects and their issues, counts states and picks top 3", async () => {
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team-1", key: "TEA", name: "Platform" });
    vi.mocked(linear.executeGraphQL)
      .mockResolvedValueOnce({
        team: {
          projects: {
            nodes: [
              { id: "p1", name: "Checkout", url: "https://l/p1", progress: 0.5, targetDate: "2026-12-12", status: { name: "In Progress", type: "started" }, lead: { name: "silas", displayName: "Silas" } },
              { id: "p2", name: "Old", url: "https://l/p2", progress: 1, targetDate: null, status: { name: "Completed", type: "completed" }, lead: null },
              { id: "p3", name: "Next", url: "https://l/p3", progress: 0, targetDate: null, status: { name: "Planned", type: "planned" }, lead: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({
        issues: {
          nodes: [
            raw({ identifier: "TEA-1", stateType: "completed", stateName: "Done", project: { id: "p1" } }),
            raw({ identifier: "TEA-2", stateType: "started", project: { id: "p1" } }),
            raw({ identifier: "TEA-3", stateType: "started", project: { id: "p1" }, labelNames: ["waiting-on:Nika"] }),
            raw({ identifier: "TEA-4", stateType: "canceled", stateName: "Canceled", project: { id: "p1" } }),
            raw({ identifier: "TEA-5", stateType: "unstarted", stateName: "Todo", priority: 4, project: { id: "p1" } }),
            raw({ identifier: "TEA-6", stateType: "backlog", stateName: "Backlog", priority: 2, project: { id: "p1" } }),
            raw({ identifier: "TEA-7", stateType: "unstarted", stateName: "Todo", priority: 4, labelNames: ["ux-insights"], project: { id: "p1" } }),
            raw({ identifier: "TEA-8", stateType: "backlog", stateName: "Backlog", priority: 0, project: { id: "p1" } }),
            raw({ identifier: "TEA-9", stateType: "unstarted", stateName: "Todo", priority: 3, project: { id: "p3" } }),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const roadmap = await fetchRoadmap(tracker, "TEA");

    expect(linear.fetchTeamByKey).toHaveBeenCalledWith(tracker, "TEA");
    const calls = vi.mocked(linear.executeGraphQL).mock.calls;
    expect(calls[0]![2]).toMatchObject({ teamId: "team-1" });
    expect(calls[1]![2]).toMatchObject({ filter: { project: { id: { in: ["p1", "p3"] } } } });

    expect(roadmap.projects.map(p => p.name)).toEqual(["Checkout", "Next"]);
    const p1 = roadmap.projects[0]!;
    expect(p1).toMatchObject({ state: "started", progress: 0.5, lead: "Silas", targetDate: "2026-12-12", blocked: 1 });
    expect(p1.counts).toEqual({ completed: 1, started: 2, unstarted: 2, backlog: 2, canceled: 1 });
    expect(p1.topNext.map(i => i.identifier)).toEqual(["TEA-6", "TEA-7", "TEA-5"]);
    expect(p1.topNext[0]!.project).toBe("Checkout");
    expect(roadmap.projects[1]!.topNext.map(i => i.identifier)).toEqual(["TEA-9"]);
  });

  it("skips the issues query when no project is active", async () => {
    vi.mocked(linear.fetchTeamByKey).mockResolvedValue({ id: "team-1", key: "TEA", name: "Platform" });
    vi.mocked(linear.executeGraphQL).mockResolvedValueOnce({
      team: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    });
    expect(await fetchRoadmap(tracker, "TEA")).toEqual({ teamKey: "TEA", projects: [] });
    expect(linear.executeGraphQL).toHaveBeenCalledTimes(1);
  });

  it("buildRoadmap sorts started before planned, closest to done first", () => {
    const r = buildRoadmap(
      "TEA",
      [
        { id: "a", name: "A", url: "u", progress: 0.3, status: { name: "s", type: "started" } },
        { id: "b", name: "B", url: "u", progress: 0.9, status: { name: "p", type: "planned" } },
        { id: "c", name: "C", url: "u", progress: 0.8, status: { name: "s", type: "started" } },
      ],
      [],
    );
    expect(r.projects.map(p => p.name)).toEqual(["C", "A", "B"]);
  });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

describe("ReportScheduler", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-"));
    statePath = path.join(dir, "nested", "reports-state.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Local-time dates. Nov 2026: Mon 2, Tue 3, Sat 7, Sun 8, Mon 9.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

  function make(clock: { now: Date }, overrides: { runDaily?: () => Promise<void>; runWeekly?: () => Promise<void> } = {}) {
    const counts = { daily: 0, weekly: 0 };
    const log = makeLogger();
    const scheduler = new ReportScheduler({
      statePath,
      now: () => clock.now,
      runDaily: overrides.runDaily ?? (async () => void counts.daily++),
      runWeekly: overrides.runWeekly ?? (async () => void counts.weekly++),
      log,
    });
    return { scheduler, counts, log };
  }

  it("uses the expected weekdays in fixtures", () => {
    expect(at(2, 0).getDay()).toBe(1);
    expect(at(7, 0).getDay()).toBe(6);
    expect(at(8, 0).getDay()).toBe(0);
  });

  it("runs the daily job once per day, only after its hour", async () => {
    const clock = { now: at(3, 15, 59) };
    const { scheduler, counts } = make(clock);
    await scheduler.reconcile();
    expect(counts.daily).toBe(0);

    clock.now = at(3, 16, 0);
    await scheduler.reconcile();
    clock.now = at(3, 17, 30);
    await scheduler.reconcile();
    expect(counts.daily).toBe(1);

    clock.now = at(4, 16, 5);
    await scheduler.reconcile();
    expect(counts.daily).toBe(2);
  });

  it("persists the last run so a restart does not run again", async () => {
    const clock = { now: at(3, 16, 30) };
    const first = make(clock);
    await first.scheduler.reconcile();
    expect(first.counts.daily).toBe(1);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({ lastDaily: "2026-11-03" });

    const second = make(clock);
    await second.scheduler.reconcile();
    expect(second.counts.daily).toBe(0);
  });

  it("skips Saturday and Sunday for the daily job", async () => {
    const clock = { now: at(7, 17) };
    const { scheduler, counts } = make(clock);
    await scheduler.reconcile();
    clock.now = at(8, 17);
    await scheduler.reconcile();
    expect(counts.daily).toBe(0);
  });

  it("runs the weekly job only on its weekday after its hour, once per week", async () => {
    const clock = { now: at(3, 10) }; // Tuesday
    const { scheduler, counts } = make(clock);
    await scheduler.reconcile();
    expect(counts.weekly).toBe(0);

    clock.now = at(9, 8, 59); // Monday, before 9
    await scheduler.reconcile();
    expect(counts.weekly).toBe(0);

    clock.now = at(9, 9, 0);
    await scheduler.reconcile();
    clock.now = at(9, 12, 0);
    await scheduler.reconcile();
    expect(counts.weekly).toBe(1);

    clock.now = at(16, 9, 30); // next Monday
    await scheduler.reconcile();
    expect(counts.weekly).toBe(2);
  });

  it("logs and swallows errors; one failing job does not block the other", async () => {
    const clock = { now: at(9, 16, 30) }; // Monday after both hours
    let daily = 0;
    const { scheduler, log } = make(clock, {
      runWeekly: async () => {
        throw new Error("boom");
      },
      runDaily: async () => void daily++,
    });
    await expect(scheduler.reconcile()).resolves.toBeUndefined();
    expect(daily).toBe(1);
    expect(log.errors.some(e => e.includes("boom"))).toBe(true);

    // Not retried in the same period.
    await scheduler.reconcile();
    expect(daily).toBe(1);
  });

  it("computes ISO week keys", () => {
    expect(isoWeekKey(new Date(2026, 10, 2))).toBe("2026-W45");
    expect(isoWeekKey(new Date(2026, 10, 8))).toBe("2026-W45");
    expect(isoWeekKey(new Date(2027, 0, 1))).toBe("2026-W53");
  });
});
