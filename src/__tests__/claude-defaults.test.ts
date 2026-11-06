import { afterEach, describe, expect, it } from "vitest";
import { claudeEffortArgs, claudeModelArgs, selectClaudeModel } from "../llm.js";

describe("Claude defaults", () => {
  const saved = { model: process.env.CLAUDE_MODEL, effort: process.env.CLAUDE_EFFORT };
  afterEach(() => {
    for (const [k, v] of [["CLAUDE_MODEL", saved.model], ["CLAUDE_EFFORT", saved.effort]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("defaults every run to Opus 5.5 at medium effort", async () => {
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_EFFORT;
    expect(claudeModelArgs()).toEqual(["--model", "claude-opus-5-5"]);
    expect(claudeEffortArgs()).toEqual(["--effort", "medium"]);
    expect(await selectClaudeModel({ title: "x", description: null })).toBe("claude-opus-5-5");
  });

  it("honours CLAUDE_MODEL / CLAUDE_EFFORT and ignores bad effort values", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5-5";
    process.env.CLAUDE_EFFORT = "high";
    expect(claudeModelArgs()).toEqual(["--model", "claude-sonnet-5-5"]);
    expect(claudeEffortArgs()).toEqual(["--effort", "high"]);
    process.env.CLAUDE_EFFORT = "turbo";
    expect(claudeEffortArgs()).toEqual(["--effort", "medium"]);
    process.env.CLAUDE_MODEL = "auto";
    expect(claudeModelArgs()).toEqual(["--model", "claude-opus-5-5"]);
  });

  it("runs routine jobs on Sonnet 5.5 at low effort, overridable, regardless of CLAUDE_MODEL", () => {
    process.env.CLAUDE_MODEL = "claude-opus-5-5";
    delete process.env.CLAUDE_ROUTINE_MODEL;
    delete process.env.CLAUDE_ROUTINE_EFFORT;
    expect(claudeModelArgs("routine")).toEqual(["--model", "claude-sonnet-5-5"]);
    expect(claudeEffortArgs("routine")).toEqual(["--effort", "low"]);
    process.env.CLAUDE_ROUTINE_MODEL = "claude-haiku-5-5";
    process.env.CLAUDE_ROUTINE_EFFORT = "medium";
    expect(claudeModelArgs("routine")).toEqual(["--model", "claude-haiku-5-5"]);
    expect(claudeEffortArgs("routine")).toEqual(["--effort", "medium"]);
    delete process.env.CLAUDE_ROUTINE_MODEL;
    delete process.env.CLAUDE_ROUTINE_EFFORT;
  });
});
