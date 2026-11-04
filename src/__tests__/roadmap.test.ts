import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../orchestrator.js";
import type { Issue } from "../types.js";
import {
  assessRoadmap, formatEntry, identifierFromLink, parseRoadmap, parseRoadmapConfig, pickNext, rankOf,
  type AssessContext, type LinkedIssue,
} from "../roadmap.js";

const L = (n: string) => `https://linear.app/team-dsc/issue/${n}`;

const roadmap = parseRoadmap({
  source: "https://claude.ai/artifact/x",
  items: [
    { title: "Group Admin", link: L("TEA-4193"), status: "build" },
    { title: "Shorter checkout", link: L("PRD-62"), status: "design" },
    { title: "Conference page", link: L("PRD-1"), status: "ready" },
    { title: "Email flows", link: "", status: "ready" },
    { title: "Upgrade paths", link: L("PRD-58"), status: "none", notes: "Launch early 2027" },
    { title: "Review me", link: L("TEA-5007"), status: "build" },
    { title: "Asked a question", link: L("TEA-10"), status: "ready" },
    { title: "Has a card", link: L("TEA-11"), status: "ready" },
    { title: "Shipped", link: L("TEA-12"), status: "ready" },
    { title: "AI search", link: L("TEA-4727"), status: "ready" },
    { title: "Bulk unassign", link: L("TEA-4725"), status: "ready" },
    { title: "Missing", link: L("TEA-99999"), status: "ready" },
  ],
});

function issue(identifier: string, state: string, stateType: string, extra: Partial<LinkedIssue> = {}): [string, LinkedIssue] {
  return [identifier, { id: `id-${identifier}`, identifier, state, stateType, assignee: null, labels: [], ...extra }];
}

const issues = new Map<string, LinkedIssue>([
  issue("TEA-4193", "Human Dev", "started", { assignee: "Silas Palmer" }),
  issue("TEA-5007", "In Review", "started", { assignee: "Nika" }),
  issue("TEA-10", "Todo", "unstarted", { labels: ["waiting-on:evie"] }),
  issue("TEA-11", "Backlog", "backlog"),
  issue("TEA-12", "Done", "completed"),
  issue("TEA-4727", "Backlog", "backlog"),
  issue("TEA-4725", "Todo", "unstarted"),
]);

const ctx: AssessContext = {
  teamKey: "TEA",
  devState: "Dev in Progress",
  pullFromStates: ["Todo", "Backlog"],
  designPerson: "Nika",
  productPerson: "Evie",
  openGateFor: id => (id === "id-TEA-11" ? "Silas" : null),
};

describe("roadmap parsing", () => {
  it("reads the roadmap page's state JSON in order", () => {
    expect(roadmap.source).toBe("https://claude.ai/artifact/x");
    expect(roadmap.items.map(i => i.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(roadmap.items[0]).toMatchObject({ title: "Group Admin", identifier: "TEA-4193", status: "build" });
    expect(roadmap.items[3].identifier).toBeNull();
  });

  it("extracts identifiers from Linear links", () => {
    expect(identifierFromLink("https://linear.app/team-dsc/issue/TEA-4193/add-group-admins")).toBe("TEA-4193");
    expect(identifierFromLink("https://linear.app/team-dsc/issue/prd-62")).toBe("PRD-62");
    expect(identifierFromLink("")).toBeNull();
  });

  it("treats unknown statuses as not started", () => {
    expect(parseRoadmap({ items: [{ title: "x", status: "weird" }] }).items[0].status).toBe("none");
  });

  it("parses config with safe defaults", () => {
    const c = parseRoadmapConfig({ enabled: true }, "/root");
    expect(c).toMatchObject({ enabled: true, file: "/root/.symphony-roadmap.json", pullReady: true, maxInFlight: 1, pullFromStates: ["Todo", "Backlog"] });
    expect(parseRoadmapConfig({}, "/root").enabled).toBe(false);
  });
});

describe("assessRoadmap", () => {
  const entries = assessRoadmap(roadmap.items, issues, ctx);
  const by = (rank: number) => entries[rank - 1];

  it("flags work a person is doing or reviewing", () => {
    expect(by(1)).toMatchObject({ verdict: "waiting", waitingOn: "Silas Palmer", why: "Human Dev" });
    expect(by(6)).toMatchObject({ verdict: "waiting", waitingOn: "Nika", why: "In Review" });
  });

  it("flags items product hasn't finished, naming design vs product", () => {
    expect(by(2)).toMatchObject({ verdict: "waiting", waitingOn: "Nika", why: "In design" });
    expect(by(5)).toMatchObject({ verdict: "waiting", waitingOn: "Evie", why: "Not started by product (Launch early 2027)" });
  });

  it("flags ready items with no dev ticket", () => {
    expect(by(3)).toMatchObject({ verdict: "waiting", waitingOn: "Evie" });
    expect(by(3).why).toContain("isn't a TEA ticket");
    expect(by(4).why).toBe("Ready for dev but has no Linear ticket");
    expect(by(12).why).toContain("not found");
  });

  it("flags waiting-on labels and open cards", () => {
    expect(by(7)).toMatchObject({ verdict: "waiting", waitingOn: "evie", why: "Waiting on an answer" });
    expect(by(8)).toMatchObject({ verdict: "waiting", waitingOn: "Silas", why: "Waiting on a Symphony card" });
  });

  it("marks done and ready-to-start items", () => {
    expect(by(9).verdict).toBe("done");
    expect(by(10)).toMatchObject({ verdict: "next", issueId: "id-TEA-4727" });
    expect(by(11).verdict).toBe("next");
  });

  it("picks the first ready item and lists what it skipped", () => {
    const { next, skipped } = pickNext(entries, 1);
    expect(next?.identifier).toBe("TEA-4727");
    expect(skipped.map(e => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("starts nothing while the in-flight cap is reached", () => {
    const building = assessRoadmap(roadmap.items, new Map([...issues, issue("TEA-4725", "Dev in Progress", "started")]), ctx);
    expect(building[10].verdict).toBe("building");
    expect(pickNext(building, 1).next).toBeNull();
    expect(pickNext(building, 2).next?.identifier).toBe("TEA-4727");
  });

  it("ranks an issue or its sub-issues by position", () => {
    expect(rankOf(entries, "TEA-4727")).toBe(10);
    expect(rankOf(entries, "TEA-4984", "TEA-4193")).toBe(1);
    expect(rankOf(entries, "TEA-1")).toBeNull();
  });

  it("formats readable status lines", () => {
    expect(formatEntry(by(1))).toBe("#1 Group Admin (TEA-4193): waiting on Silas Palmer: Human Dev");
    expect(formatEntry(by(10))).toBe("#10 AI search (TEA-4727): ready to start (Backlog)");
  });
});

describe("dispatch order", () => {
  it("puts urgent tickets first, then roadmap order, then the rest by priority", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-roadmap-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: k\n  project_slug: demo\nworkspace:\n  root: ${tmpDir}\n---\n\nPrompt`, "utf8");
    const o = new Orchestrator(workflowPath, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const ranks: Record<string, number> = { "TEA-1": 1, "TEA-9": 9 };
    (o as unknown as { v2: unknown }).v2 = {
      roadmapRank: (id: string, parent?: string | null) => ranks[id] ?? (parent ? ranks[parent] : undefined) ?? null,
    };
    const mk = (identifier: string, priority: number, parentIdentifier: string | null = null) =>
      ({ identifier, priority, parentIdentifier, createdAt: new Date(0) }) as Issue;
    const sorted = (o as unknown as { sortForDispatch(i: Issue[]): Issue[] }).sortForDispatch([
      mk("TEA-50", 2), mk("TEA-9", 3), mk("TEA-60", 1), mk("TEA-2", 4, "TEA-1"), mk("TEA-70", 3),
    ]);
    expect(sorted.map(i => i.identifier)).toEqual(["TEA-60", "TEA-2", "TEA-9", "TEA-50", "TEA-70"]);
  });
});

describe("extractRoadmapJson", () => {
  it("reads the state script from a saved roadmap page, or plain JSON", async () => {
    const { extractRoadmapJson } = await import("../roadmap.js");
    const html = `<html><script type="application/json" id="state">{"items":[{"title":"A","link":"","status":"ready","notes":""}]}</script></html>`;
    expect(extractRoadmapJson(html)).toEqual({ items: [{ title: "A", link: "", status: "ready", notes: "" }] });
    expect(extractRoadmapJson(`{"items":[]}`)).toEqual({ items: [] });
  });
});
