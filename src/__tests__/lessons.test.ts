import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Issue } from "../types.js";
import {
  tokenize,
  readLessons,
  isInstructive,
  selectRelevantLessons,
  renderRelevantLessons,
  relevantLessonsForIssue,
  type Lesson,
} from "../lessons.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss_1",
    identifier: "ABC-1",
    title: "Team admins unable to unassign courses",
    description: "Unassigning a course from a learner throws an error.",
    priority: 1,
    state: "Todo",
    branchName: null,
    url: "https://linear.app/x/issue/ABC-1",
    labels: [],
    blockedBy: [],
    assignee: null,
    creator: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases, drops short tokens and stopwords", () => {
    const toks = tokenize("The Unassign COURSES from a learner");
    expect(toks.has("unassign")).toBe(true);
    expect(toks.has("courses")).toBe(true);
    expect(toks.has("learner")).toBe(true);
    expect(toks.has("the")).toBe(false); // stopword
    expect(toks.has("a")).toBe(false); // too short
  });

  it("returns empty set for empty input", () => {
    expect(tokenize("").size).toBe(0);
  });
});

describe("isInstructive", () => {
  it("is true when there is a real miss", () => {
    expect(isInstructive({ primary_miss: "architect plan wrong direction" })).toBe(true);
  });

  it("is true when there is a proposed change even on a clean ship", () => {
    expect(isInstructive({ primary_miss: "none", proposed_workflow_change: "do X" })).toBe(true);
  });

  it("is false for a clean ship with no proposed change", () => {
    expect(isInstructive({ primary_miss: "none", proposed_workflow_change: "" })).toBe(false);
    expect(isInstructive({})).toBe(false);
  });
});

describe("selectRelevantLessons", () => {
  const relevant: Lesson = {
    ticket: "TEA-4181",
    ticket_url: "https://linear.app/x/issue/TEA-4181/team-admins-unable-to-unassign-courses",
    completed_at: "2026-05-19T00:00:00Z",
    outcome: "shipped_after_rework",
    primary_miss: "architect plan wrong direction",
    miss_root_cause: "missing teamId filter on learner courses query",
    proposed_workflow_change: "Architect should read the unassignment handler first",
    tags: ["architect"],
  };
  const unrelated: Lesson = {
    ticket: "TEA-9000",
    ticket_url: "https://linear.app/x/issue/TEA-9000/dashboard-banner-colour-tweak",
    completed_at: "2026-05-20T00:00:00Z",
    outcome: "shipped_after_rework",
    primary_miss: "wrong banner colour token",
    miss_root_cause: "used hex instead of tailwind token",
    tags: ["developer"],
  };
  const cleanShip: Lesson = {
    ticket: "TEA-4169",
    outcome: "shipped_clean",
    primary_miss: "none",
    miss_root_cause: "courses unassign was precise",
    proposed_workflow_change: "",
    tags: [],
  };

  it("ranks lessons overlapping the issue above unrelated ones", () => {
    const out = selectRelevantLessons([unrelated, relevant, cleanShip], makeIssue());
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].lesson.ticket).toBe("TEA-4181");
  });

  it("excludes non-instructive clean ships even on keyword overlap", () => {
    // cleanShip mentions "courses"/"unassign" but has no miss and no proposed change.
    const out = selectRelevantLessons([cleanShip], makeIssue());
    expect(out).toEqual([]);
  });

  it("returns nothing when the issue has no usable tokens", () => {
    const out = selectRelevantLessons([relevant], makeIssue({ title: "a", description: "" }));
    expect(out).toEqual([]);
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...relevant, ticket: `T-${i}` }));
    expect(selectRelevantLessons(many, makeIssue(), 3).length).toBe(3);
  });

  it("breaks ties by recency", () => {
    const older = { ...relevant, ticket: "OLD", completed_at: "2026-01-01T00:00:00Z" };
    const newer = { ...relevant, ticket: "NEW", completed_at: "2026-05-19T00:00:00Z" };
    const out = selectRelevantLessons([older, newer], makeIssue());
    expect(out[0].lesson.ticket).toBe("NEW");
  });
});

describe("renderRelevantLessons", () => {
  it("returns empty string for no lessons", () => {
    expect(renderRelevantLessons([])).toBe("");
  });

  it("renders compact bullets with ticket, miss, cause and change", () => {
    const md = renderRelevantLessons([
      {
        score: 3,
        lesson: {
          ticket: "TEA-4181",
          outcome: "shipped_after_rework",
          primary_miss: "architect plan wrong direction",
          miss_root_cause: "missing teamId filter",
          proposed_workflow_change: "read the handler first",
        },
      },
    ]);
    expect(md).toContain("**TEA-4181**");
    expect(md).toContain("(shipped_after_rework)");
    expect(md).toContain("architect plan wrong direction");
    expect(md).toContain("missing teamId filter");
    expect(md).toContain("read the handler first");
  });
});

describe("readLessons / relevantLessonsForIssue", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-test-"));
    file = path.join(dir, "lessons.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when the file is missing", () => {
    expect(readLessons(path.join(dir, "nope.jsonl"))).toEqual([]);
    expect(relevantLessonsForIssue(path.join(dir, "nope.jsonl"), makeIssue())).toBe("");
  });

  it("skips malformed lines but keeps valid ones", () => {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ticket: "A", primary_miss: "x" }),
        "{not json",
        "",
        JSON.stringify({ ticket: "B", primary_miss: "y" }),
      ].join("\n"),
    );
    const lessons = readLessons(file);
    expect(lessons.map((l) => l.ticket)).toEqual(["A", "B"]);
  });

  it("renders an injectable block end-to-end", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        ticket: "TEA-4181",
        ticket_url: "https://linear.app/x/issue/TEA-4181/unable-to-unassign-courses",
        completed_at: "2026-05-19T00:00:00Z",
        outcome: "shipped_after_rework",
        primary_miss: "architect plan wrong direction",
        miss_root_cause: "missing teamId filter on learner courses query",
        proposed_workflow_change: "read the unassignment handler first",
        tags: ["architect"],
      }) + "\n",
    );
    const md = relevantLessonsForIssue(file, makeIssue());
    expect(md).toContain("**TEA-4181**");
    expect(md).toContain("teamId filter");
  });
});
