import { describe, it, expect, beforeEach } from "vitest";
import {
  parseResetTimeMs,
  setClaudeBlockedUntil,
  isClaudeBlocked,
  claudeBlockedUntil,
  resetClaudeBlock,
} from "../llm.js";

describe("parseResetTimeMs", () => {
  it("parses pm reset time in a named timezone", () => {
    const ms = parseResetTimeMs("You've hit your limit · resets 5:30pm (Australia/Melbourne)");
    expect(ms).not.toBeNull();
    expect(ms! > Date.now()).toBe(true);
  });

  it("parses am reset time", () => {
    const ms = parseResetTimeMs("resets 7:15am (UTC)");
    expect(ms).not.toBeNull();
  });

  it("returns null when no reset pattern", () => {
    expect(parseResetTimeMs("some unrelated error")).toBeNull();
    expect(parseResetTimeMs("rate limit hit, try later")).toBeNull();
  });

  it("returns null for unparseable timezones", () => {
    expect(parseResetTimeMs("resets 5:30pm (NotARealTZ)")).toBeNull();
  });
});

describe("claude block state", () => {
  beforeEach(() => resetClaudeBlock());

  it("starts unblocked", () => {
    expect(isClaudeBlocked()).toBe(false);
    expect(claudeBlockedUntil()).toBe(0);
  });

  it("blocks until a future timestamp", () => {
    const until = Date.now() + 60_000;
    setClaudeBlockedUntil(until);
    expect(isClaudeBlocked()).toBe(true);
    expect(claudeBlockedUntil()).toBe(until);
  });

  it("ignores earlier timestamps", () => {
    const later = Date.now() + 60_000;
    const earlier = Date.now() + 1_000;
    setClaudeBlockedUntil(later);
    setClaudeBlockedUntil(earlier);
    expect(claudeBlockedUntil()).toBe(later);
  });

  it("treats past timestamps as not blocked", () => {
    setClaudeBlockedUntil(Date.now() - 1000);
    expect(isClaudeBlocked()).toBe(false);
  });
});
