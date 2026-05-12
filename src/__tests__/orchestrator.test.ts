import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, Logger, OrchestratorState } from "../types.js";
import { Orchestrator } from "../orchestrator.js";
import * as linear from "../linear.js";
import * as workspace from "../workspace.js";

vi.mock("../linear.js", async () => {
  const actual = await vi.importActual<typeof import("../linear.js")>("../linear.js");
  return {
    ...actual,
    hasSlackNotificationComment: vi.fn(),
    addSlackNotificationComment: vi.fn(),
    fetchIssuesByStates: vi.fn(),
    fetchIssuesByIds: vi.fn(),
    fetchIssueStatesByIds: vi.fn(),
  };
});

vi.mock("../workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../workspace.js")>("../workspace.js");
  return {
    ...actual,
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
  };
});

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("Orchestrator Slack completion notifications", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(linear.hasSlackNotificationComment).mockResolvedValue(false);
    vi.mocked(linear.addSlackNotificationComment).mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_SLACK_WEBHOOK_URL;
  });

  it("posts a Slack message when a ticket appears directly in a terminal state", async () => {
    process.env.TEST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/COMPLETE";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-orchestrator-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
workspace:
  root: ${tmpDir}
notifications:
  slack:
    webhook_url: $TEST_SLACK_WEBHOOK_URL
    user_map:
      owner@example.com: UOWNER
      Reporter Example: UREPORTER
---

Prompt body`, "utf8");

    const issue: Issue = {
      id: "issue-2",
      identifier: "ABC-124",
      title: "Send Slack updates for completed tickets even if no run started",
      description: "Make direct transitions to Done visible in Slack.",
      priority: 1,
      state: "Done",
      branchName: null,
      url: "https://linear.app/example/issue/ABC-124",
      labels: ["ops"],
      blockedBy: [],
      assignee: { name: "Owner Example", email: "owner@example.com" },
      creator: { name: "Reporter Example", email: "reporter@example.com" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };

    vi.mocked(linear.fetchIssuesByStates).mockResolvedValue([
      { id: issue.id, identifier: issue.identifier },
    ]);
    vi.mocked(linear.fetchIssuesByIds).mockResolvedValue([issue]);

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const orchestrator = new Orchestrator(workflowPath, makeLogger());

    await (orchestrator as unknown as {
      reconcileTerminalIssues(): Promise<void>;
    }).reconcileTerminalIssues();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.test/services/COMPLETE");

    const payload = JSON.parse(String(init.body)) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(payload.text).toContain("ABC-124 completed");
    expect(JSON.stringify(payload.blocks)).toContain("Make direct transitions to Done visible in Slack");
    expect(JSON.stringify(payload.blocks)).toContain("<@UOWNER>");
    expect(JSON.stringify(payload.blocks)).toContain("<@UREPORTER>");
    expect(vi.mocked(linear.hasSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(vi.mocked(linear.addSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(vi.mocked(workspace.removeWorkspace)).toHaveBeenCalledWith(
      tmpDir,
      issue.identifier,
      undefined,
      600000,
      expect.any(Object),
    );
  });

  it("posts a Slack message when a tracked issue moves to a completion state", async () => {
    process.env.TEST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/COMPLETE";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-orchestrator-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
workspace:
  root: ${tmpDir}
notifications:
  slack:
    webhook_url: $TEST_SLACK_WEBHOOK_URL
    user_map:
      owner@example.com: UOWNER
      Reporter Example: UREPORTER
---

Prompt body`, "utf8");

    const issue: Issue = {
      id: "issue-1",
      identifier: "ABC-123",
      title: "Improve team visibility when Linear tickets are completed",
      description: "Ship a Slack completion summary so non-technical stakeholders know what landed.",
      priority: 1,
      state: "In Progress",
      branchName: null,
      url: "https://linear.app/example/issue/ABC-123",
      labels: ["ops", "visibility"],
      blockedBy: [],
      assignee: { name: "Owner Example", email: "owner@example.com" },
      creator: { name: "Reporter Example", email: "reporter@example.com" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };

    vi.mocked(linear.fetchIssueStatesByIds).mockResolvedValue([
      { id: issue.id, identifier: issue.identifier, state: "Done" },
    ]);

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const orchestrator = new Orchestrator(workflowPath, makeLogger());
    const state = (orchestrator as unknown as { state: OrchestratorState }).state;
    state.trackedIssues.set(issue.id, {
      issue,
      completionSummary: "Added a plain-English summary, stakeholder context, Slack mentions, and the Linear link to completion notifications.",
    });

    await (orchestrator as unknown as {
      reconcileTrackedStates(activeIds: Set<string>): Promise<void>;
    }).reconcileTrackedStates(new Set());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.test/services/COMPLETE");

    const payload = JSON.parse(String(init.body)) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(payload.text).toContain("ABC-123 completed");
    expect(JSON.stringify(payload.blocks)).toContain("plain-English summary");
    expect(JSON.stringify(payload.blocks)).toContain("non-technical stakeholders know what landed");
    expect(JSON.stringify(payload.blocks)).toContain("<@UOWNER>");
    expect(JSON.stringify(payload.blocks)).toContain("<@UREPORTER>");
    expect(JSON.stringify(payload.blocks)).toContain("https://linear.app/example/issue/ABC-123");
    expect(vi.mocked(linear.hasSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(vi.mocked(linear.addSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(vi.mocked(workspace.removeWorkspace)).toHaveBeenCalledWith(
      tmpDir,
      issue.identifier,
      undefined,
      600000,
      expect.any(Object),
    );
    expect(state.trackedIssues.has(issue.id)).toBe(false);
  });

  it("skips Slack when the Linear completion comment already exists", async () => {
    process.env.TEST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/COMPLETE";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-orchestrator-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
workspace:
  root: ${tmpDir}
notifications:
  slack:
    webhook_url: $TEST_SLACK_WEBHOOK_URL
    user_map:
      owner@example.com: UOWNER
---

Prompt body`, "utf8");

    const issue: Issue = {
      id: "issue-3",
      identifier: "ABC-125",
      title: "Avoid duplicate Slack completion notifications",
      description: "Use a Linear comment as the dedupe marker.",
      priority: 1,
      state: "Done",
      branchName: null,
      url: "https://linear.app/example/issue/ABC-125",
      labels: ["ops"],
      blockedBy: [],
      assignee: { name: "Owner Example", email: "owner@example.com" },
      creator: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };

    vi.mocked(linear.hasSlackNotificationComment).mockResolvedValue(true);
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const orchestrator = new Orchestrator(workflowPath, makeLogger());

    await (orchestrator as unknown as {
      handleTerminalIssue(
        issueId: string,
        issue: Issue,
        state: string,
        completionSummary: string | null,
        abortRunningEntry: boolean,
      ): Promise<void>;
    }).handleTerminalIssue(issue.id, issue, issue.state, null, false);

    expect(vi.mocked(linear.hasSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(linear.addSlackNotificationComment)).not.toHaveBeenCalled();
    expect(vi.mocked(workspace.removeWorkspace)).toHaveBeenCalledWith(
      tmpDir,
      issue.identifier,
      undefined,
      600000,
      expect.any(Object),
    );
  });

  it("still sends Slack for a terminal ticket after startup cleanup on restart", async () => {
    process.env.TEST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/COMPLETE";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-orchestrator-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
workspace:
  root: ${tmpDir}
notifications:
  slack:
    webhook_url: $TEST_SLACK_WEBHOOK_URL
    user_map:
      owner@example.com: UOWNER
      Reporter Example: UREPORTER
---

Prompt body`, "utf8");

    const issue: Issue = {
      id: "issue-4",
      identifier: "ABC-126",
      title: "Notify after restart for unmarked completed tickets",
      description: "A restart should not suppress the first completion notification.",
      priority: 1,
      state: "Done",
      branchName: null,
      url: "https://linear.app/example/issue/ABC-126",
      labels: ["ops"],
      blockedBy: [],
      assignee: { name: "Owner Example", email: "owner@example.com" },
      creator: { name: "Reporter Example", email: "reporter@example.com" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    };

    vi.mocked(linear.fetchIssuesByStates).mockResolvedValue([
      { id: issue.id, identifier: issue.identifier },
    ]);
    vi.mocked(linear.fetchIssuesByIds).mockResolvedValue([issue]);

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const orchestrator = new Orchestrator(workflowPath, makeLogger());
    const state = (orchestrator as unknown as { state: OrchestratorState }).state;

    await (orchestrator as unknown as {
      startupCleanup(): Promise<void>;
    }).startupCleanup();

    expect(state.knownTerminalIssueIds.has(issue.id)).toBe(false);

    await (orchestrator as unknown as {
      reconcileTerminalIssues(): Promise<void>;
    }).reconcileTerminalIssues();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(linear.addSlackNotificationComment)).toHaveBeenCalledWith(
      expect.any(Object),
      issue.id,
    );
    expect(state.knownTerminalIssueIds.has(issue.id)).toBe(true);
  });
});