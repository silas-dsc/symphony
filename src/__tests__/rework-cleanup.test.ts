import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, Logger, TrackerConfig } from "../types.js";
import * as linear from "../linear.js";
import {
  AI_COMMENT_MARKER,
  REWORK_NOTES_HEADING,
  cleanupReworkComments,
  isAiComment,
  upsertReworkNotes,
} from "../rework-cleanup.js";

vi.mock("../linear.js", async () => {
  const actual = await vi.importActual<typeof import("../linear.js")>("../linear.js");
  return {
    ...actual,
    fetchIssueCommentsDetail: vi.fn(),
    deleteComment: vi.fn(),
    updateIssueDescription: vi.fn(),
  };
});

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTrackerConfig(): TrackerConfig {
  return {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "test-key",
    projectSlug: "demo",
    activeStates: ["Dev in Progress"],
    terminalStates: ["Done"],
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEA-100",
    title: "Test ticket",
    description: "## Context\n\nOriginal description",
    priority: 1,
    state: "Dev in Progress",
    branchName: null,
    url: "https://linear.app/x/issue/TEA-100",
    labels: [],
    blockedBy: [],
    assignee: null,
    creator: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("isAiComment", () => {
  it("detects the marker at start of body", () => {
    expect(isAiComment({
      id: "c1",
      body: `${AI_COMMENT_MARKER}\n## Ready for review`,
      createdAt: new Date(),
      author: null,
    })).toBe(true);
  });

  it("tolerates leading whitespace before the marker", () => {
    expect(isAiComment({
      id: "c1",
      body: `   \n${AI_COMMENT_MARKER}\nbody`,
      createdAt: new Date(),
      author: null,
    })).toBe(true);
  });

  it("returns false for a human comment", () => {
    expect(isAiComment({
      id: "c2",
      body: "Looks good but please fix the redirects",
      createdAt: new Date(),
      author: null,
    })).toBe(false);
  });

  it("returns false when the marker appears mid-body", () => {
    expect(isAiComment({
      id: "c3",
      body: `Quoting bot:\n${AI_COMMENT_MARKER}\n…`,
      createdAt: new Date(),
      author: null,
    })).toBe(false);
  });
});

describe("upsertReworkNotes", () => {
  const SUMMARY = "### Done\n- thing one\n\n### To do\n- thing two";

  it("appends the section to a description that has none", () => {
    const out = upsertReworkNotes("## Context\n\nOriginal stuff", SUMMARY);
    expect(out).toContain("Original stuff");
    expect(out).toContain(REWORK_NOTES_HEADING);
    expect(out).toContain("thing two");
    expect(out.indexOf("Original stuff")).toBeLessThan(out.indexOf(REWORK_NOTES_HEADING));
  });

  it("handles a null/empty description", () => {
    expect(upsertReworkNotes(null, SUMMARY)).toBe(`${REWORK_NOTES_HEADING}\n\n${SUMMARY}`);
    expect(upsertReworkNotes("", SUMMARY)).toBe(`${REWORK_NOTES_HEADING}\n\n${SUMMARY}`);
  });

  it("replaces an existing rework notes section (no duplication)", () => {
    const initial = `## Context\n\nOriginal\n\n${REWORK_NOTES_HEADING}\n\nold notes here`;
    const out = upsertReworkNotes(initial, SUMMARY);
    expect(out).toContain("Original");
    expect(out).toContain("thing two");
    expect(out).not.toContain("old notes here");
    // exactly one occurrence of the heading
    const occurrences = out.split(REWORK_NOTES_HEADING).length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves a heading that follows the rework section", () => {
    const initial = `## Context\n\nC\n\n${REWORK_NOTES_HEADING}\n\nold notes\n\n## Acceptance criteria\n\n- ac one`;
    const out = upsertReworkNotes(initial, SUMMARY);
    expect(out).toContain("## Acceptance criteria");
    expect(out).toContain("- ac one");
    expect(out).not.toContain("old notes");
  });
});

describe("cleanupReworkComments", () => {
  const tracker = makeTrackerConfig();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("no-ops when the ticket has no AI comments", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([
      {
        id: "h1",
        body: "Please fix the redirects",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        author: null,
      },
    ]);

    const issue = makeIssue();
    const result = await cleanupReworkComments(issue, tracker, makeLogger());

    expect(result).toEqual({ deletedCount: 0, descriptionUpdated: false });
    expect(linear.deleteComment).not.toHaveBeenCalled();
    expect(linear.updateIssueDescription).not.toHaveBeenCalled();
  });

  it("no-ops when fetchIssueCommentsDetail throws", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockRejectedValue(new Error("boom"));

    const issue = makeIssue();
    const logger = makeLogger();
    const result = await cleanupReworkComments(issue, tracker, logger);

    expect(result).toEqual({ deletedCount: 0, descriptionUpdated: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("deletes AI comments and updates description from later human comments", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([
      {
        id: "ai1",
        body: `${AI_COMMENT_MARKER}\n## ✅ Ready for review\n\nold delivery`,
        createdAt: new Date("2026-02-01T00:00:00Z"),
        author: null,
      },
      {
        id: "h1",
        body: "The mobile menu still overflows on small viewports",
        createdAt: new Date("2026-02-02T00:00:00Z"),
        author: { name: "Reviewer", email: "r@x" },
      },
      {
        id: "h2",
        body: "Also the redirects don't work for the contact form",
        createdAt: new Date("2026-02-02T01:00:00Z"),
        author: { name: "Reviewer", email: "r@x" },
      },
    ]);
    vi.mocked(linear.deleteComment).mockResolvedValue(undefined);
    vi.mocked(linear.updateIssueDescription).mockResolvedValue(undefined);

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        content: [{ type: "text", text: "### Done\n- (none)\n\n### To do\n- Fix mobile menu overflow\n- Wire up contact form redirects" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    const issue = makeIssue();
    try {
      const result = await cleanupReworkComments(issue, tracker, makeLogger());
      expect(result.deletedCount).toBe(1);
      expect(result.descriptionUpdated).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(linear.deleteComment).toHaveBeenCalledWith(tracker, "ai1");
    expect(linear.updateIssueDescription).toHaveBeenCalledTimes(1);
    const [, , nextDescription] = vi.mocked(linear.updateIssueDescription).mock.calls[0];
    expect(nextDescription).toContain(REWORK_NOTES_HEADING);
    expect(nextDescription).toContain("Fix mobile menu overflow");
    expect(nextDescription).toContain("Wire up contact form redirects");
    // The issue object is mutated so the dispatched agent reads the fresh description.
    expect(issue.description).toBe(nextDescription);
  });

  it("deletes AI comments without updating description when no human comments follow them", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([
      {
        id: "h1",
        body: "Earlier reviewer note (predates last AI comment)",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        author: null,
      },
      {
        id: "ai1",
        body: `${AI_COMMENT_MARKER}\n## ✅ Ready for review\n\ndelivery`,
        createdAt: new Date("2026-02-02T00:00:00Z"),
        author: null,
      },
    ]);
    vi.mocked(linear.deleteComment).mockResolvedValue(undefined);

    const issue = makeIssue();
    const result = await cleanupReworkComments(issue, tracker, makeLogger());
    expect(result).toEqual({ deletedCount: 1, descriptionUpdated: false });
    expect(linear.deleteComment).toHaveBeenCalledWith(tracker, "ai1");
    expect(linear.updateIssueDescription).not.toHaveBeenCalled();
  });

  it("still deletes AI comments when delete fails for one of them", async () => {
    vi.mocked(linear.fetchIssueCommentsDetail).mockResolvedValue([
      {
        id: "ai1",
        body: `${AI_COMMENT_MARKER}\nfirst`,
        createdAt: new Date("2026-02-01T00:00:00Z"),
        author: null,
      },
      {
        id: "ai2",
        body: `${AI_COMMENT_MARKER}\nsecond`,
        createdAt: new Date("2026-02-01T01:00:00Z"),
        author: null,
      },
    ]);
    vi.mocked(linear.deleteComment).mockImplementation(async (_cfg, id) => {
      if (id === "ai1") throw new Error("403 forbidden");
    });

    const issue = makeIssue();
    const logger = makeLogger();
    const result = await cleanupReworkComments(issue, tracker, logger);
    expect(result.deletedCount).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
