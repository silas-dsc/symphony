import { describe, it, expect } from "vitest";
import { formatFailoverError, isRateLimitText, renderPrompt } from "../agent.js";
import type { Issue } from "../types.js";

describe("isRateLimitText", () => {
  it("matches Claude's 'you've hit your limit' phrasing", () => {
    expect(isRateLimitText("You've hit your limit, please retry later")).toBe(true);
    expect(isRateLimitText("you have hit the rate limit")).toBe(true);
  });

  it("normalises Unicode apostrophes", () => {
    expect(isRateLimitText("You’ve hit your limit")).toBe(true);
  });

  it("matches Claude extra-usage exhaustion phrasing", () => {
    expect(isRateLimitText("You're out of extra usage")).toBe(true);
    expect(isRateLimitText("You are out of extra usage until tomorrow")).toBe(true);
    expect(isRateLimitText("agent_reported_error: You’re out of extra usage")).toBe(true);
  });

  it("matches usage-limit phrasing", () => {
    expect(isRateLimitText("You've hit your usage limit. Try again later.")).toBe(true);
    expect(isRateLimitText("ERROR: You've hit your usage limit")).toBe(true);
  });

  it("matches 'rate limit', 'rate_limit', 'overloaded'", () => {
    expect(isRateLimitText("API rate limit exceeded")).toBe(true);
    expect(isRateLimitText("error: rate_limit_exceeded")).toBe(true);
    expect(isRateLimitText("server overloaded")).toBe(true);
  });

  it("matches HTTP 429/529 only with context", () => {
    expect(isRateLimitText("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRateLimitText("status: 529")).toBe(true);
    expect(isRateLimitText("error 429")).toBe(true);
  });

  it("does not false-positive on bare 429/529", () => {
    expect(isRateLimitText("see file.ts line 429 for details")).toBe(false);
    expect(isRateLimitText("PR #529 merged")).toBe(false);
    expect(isRateLimitText("found 429 items")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isRateLimitText("everything fine")).toBe(false);
    expect(isRateLimitText("")).toBe(false);
  });
});

describe("renderPrompt", () => {
  const issue: Issue = {
    id: "iss_1",
    identifier: "ABC-123",
    title: "Fix the thing",
    description: "Detailed description",
    priority: 1,
    state: "Todo",
    branchName: "abc-123-fix",
    url: "https://linear.app/x/issue/ABC-123",
    labels: ["bug"],
    blockedBy: [],
    assignee: null,
    creator: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  };

  it("renders issue fields and symphony root", () => {
    const tpl = "Work on {{ issue.identifier }} ({{ issue.title }}) at {{ symphony.root }}";
    const out = renderPrompt(tpl, issue, null, "/srv/symphony");
    expect(out).toBe("Work on ABC-123 (Fix the thing) at /srv/symphony");
  });

  it("renders attempt number", () => {
    const out = renderPrompt("attempt={{ attempt }}", issue, 3, "/x");
    expect(out).toBe("attempt=3");
  });
});

describe("formatFailoverError", () => {
  it("shows Codex rate limits when Claude is blocked", () => {
    expect(formatFailoverError("codex", "rate_limited", true)).toBe("claude_blocked: codex rate-limited");
  });

  it("keeps generic failures under all_providers_failed when Claude is available", () => {
    expect(formatFailoverError("codex", "boom", false)).toBe("all_providers_failed: codex failed: boom");
  });
});
