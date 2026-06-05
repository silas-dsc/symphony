import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkflow } from "../config.js";
import { renderRetrospectivePrompt, runRetrospective } from "../retrospective.js";
import type { Issue, Logger, RetrospectiveConfig } from "../types.js";

function makeLogger(): Logger & { logs: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> } {
  const logs: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
  return {
    info: (msg, ctx) => { logs.push({ level: "info", msg, ctx }); },
    warn: (msg, ctx) => { logs.push({ level: "warn", msg, ctx }); },
    error: (msg, ctx) => { logs.push({ level: "error", msg, ctx }); },
    logs,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "uuid-1",
    identifier: "TEA-1234",
    title: "Add user invite flow",
    description: null,
    priority: null,
    state: "Done",
    branchName: null,
    url: "https://linear.app/test/issue/TEA-1234",
    labels: ["frontend", "p2"],
    blockedBy: [],
    assignee: null,
    creator: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("retrospective config parsing", () => {
  it("defaults to disabled when not specified", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-retro-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: demo
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.retrospective.enabled).toBe(false);
    expect(workflow.config.retrospective.triggerStates).toEqual(["Done"]);
    expect(workflow.config.retrospective.lessonsPath).toBe(path.join(tmpDir, "lessons", "lessons.jsonl"));
  });

  it("respects opt-in config and resolves a custom lessons path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-retro-cfg-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: demo
retrospective:
  enabled: true
  trigger_states:
    - Done
    - Closed
  lessons_path: my/lessons.jsonl
  max_turns: 10
  timeout_ms: 60000
---

prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);
    expect(workflow.config.retrospective.enabled).toBe(true);
    expect(workflow.config.retrospective.triggerStates).toEqual(["Done", "Closed"]);
    expect(workflow.config.retrospective.lessonsPath).toBe(path.join(tmpDir, "my", "lessons.jsonl"));
    expect(workflow.config.retrospective.maxTurns).toBe(10);
    expect(workflow.config.retrospective.timeoutMs).toBe(60000);
  });
});

describe("renderRetrospectivePrompt", () => {
  it("substitutes ticket and lessons-path variables", () => {
    const issue = makeIssue();
    const out = renderRetrospectivePrompt(
      "ticket={{ issue.identifier }} state={{ issue.state }} path={{ lessons_path }} ws={{ workspace }}",
      {
        issue,
        workspacePath: "/tmp/ws",
        symphonyRoot: "/symphony",
        terminalState: "Done",
        mcpConfigPath: undefined,
        logger: makeLogger(),
        config: {
          enabled: true,
          triggerStates: ["Done"],
          lessonsPath: "/symphony/lessons/lessons.jsonl",
          maxTurns: 15,
          timeoutMs: 300000,
          commitLessons: false,
        },
      }
    );
    expect(out).toContain("ticket=TEA-1234");
    expect(out).toContain("state=Done");
    expect(out).toContain("path=/symphony/lessons/lessons.jsonl");
    expect(out).toContain("ws=/tmp/ws");
  });
});

describe("runRetrospective short-circuits", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-retro-run-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  const baseConfig = (lessonsPath: string): RetrospectiveConfig => ({
    enabled: true,
    triggerStates: ["Done"],
    lessonsPath,
    maxTurns: 1,
    timeoutMs: 1000,
    commitLessons: false,
  });

  it("does nothing when retrospective.enabled is false", async () => {
    const logger = makeLogger();
    const lessonsPath = path.join(tmpRoot, "lessons.jsonl");
    await runRetrospective({
      issue: makeIssue(),
      terminalState: "Done",
      workspacePath: tmpRoot,
      symphonyRoot: tmpRoot,
      mcpConfigPath: undefined,
      logger,
      config: { ...baseConfig(lessonsPath), enabled: false },
    });
    // Lessons file should not be created — runRetrospective returned before
    // touching anything.
    expect(fs.existsSync(lessonsPath)).toBe(false);
    expect(logger.logs).toHaveLength(0);
  });

  it("skips with a log when the workspace is missing", async () => {
    const logger = makeLogger();
    const lessonsPath = path.join(tmpRoot, "lessons.jsonl");
    await runRetrospective({
      issue: makeIssue(),
      terminalState: "Done",
      workspacePath: path.join(tmpRoot, "nonexistent"),
      symphonyRoot: tmpRoot,
      mcpConfigPath: undefined,
      logger,
      config: baseConfig(lessonsPath),
    });
    expect(logger.logs.some(l => l.msg === "Retrospective skipped: workspace missing")).toBe(true);
  });

  it("skips with a log when the prompt file is missing", async () => {
    const logger = makeLogger();
    const lessonsPath = path.join(tmpRoot, "lessons.jsonl");
    // workspace exists; symphonyRoot/prompts/RETROSPECTIVE.md does not.
    await runRetrospective({
      issue: makeIssue(),
      terminalState: "Done",
      workspacePath: tmpRoot,
      symphonyRoot: tmpRoot,
      mcpConfigPath: undefined,
      logger,
      config: baseConfig(lessonsPath),
    });
    expect(logger.logs.some(l => l.msg === "Retrospective skipped: prompt missing")).toBe(true);
  });
});
