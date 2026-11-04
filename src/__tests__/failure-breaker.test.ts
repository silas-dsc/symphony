import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FailureBreaker, errorSignature, redactSecrets, refreshAuthEnv } from "../failure-breaker.js";
import { isAuthError } from "../agent.js";
import { Orchestrator, breakerAlertText } from "../orchestrator.js";
import type { AgentResult, Issue, Logger, RunningEntry } from "../types.js";

const AUTH = "agent_reported_error: Failed to authenticate. API Error: 401 OAuth access token is invalid.";
const T0 = 1_000_000;
const COOLDOWN = 10 * 60_000;

function breaker(threshold = 4) {
  return new FailureBreaker({ isAuthError, threshold, cooldownMs: COOLDOWN });
}

describe("FailureBreaker", () => {
  it("trips on the first auth failure and alerts once per episode", () => {
    const b = breaker();
    expect(b.recordFailure("TEA-1", AUTH, T0).justTripped).toBe(true);
    expect(b.isPaused(T0)).toBe(true);
    expect(b.allowDispatch(T0)).toBe(false);
    expect(b.status(T0)).toMatchObject({ kind: "auth", half_open: false });
    // Other tickets failing the same way don't re-alert.
    expect(b.recordFailure("TEA-2", AUTH, T0 + 1).justTripped).toBe(false);
    expect(b.recordFailure("TEA-3", AUTH, T0 + 2).justTripped).toBe(false);
  });

  it("allows exactly one half-open trial after the cooldown", () => {
    const b = breaker();
    b.recordFailure("TEA-1", AUTH, T0);
    const later = T0 + COOLDOWN;
    expect(b.readyForTrial(later)).toBe(true);
    expect(b.allowDispatch(later)).toBe(true);
    expect(b.allowDispatch(later)).toBe(false); // trial in flight
    expect(b.isPaused(later)).toBe(true);
  });

  it("re-trips quietly when the trial fails the same way, and resumes on success", () => {
    const b = breaker();
    b.recordFailure("TEA-1", AUTH, T0);
    b.allowDispatch(T0 + COOLDOWN);
    expect(b.recordFailure("TEA-1", AUTH, T0 + COOLDOWN + 5).justTripped).toBe(false);
    expect(b.isPaused(T0 + COOLDOWN + 10)).toBe(true);

    b.allowDispatch(T0 + 2 * COOLDOWN + 5);
    expect(b.recordSuccess()).toBe(true); // ends the episode → "resumed" message
    expect(b.status()).toBeNull();
    expect(b.allowDispatch()).toBe(true);
    expect(b.recordSuccess()).toBe(false); // nothing to announce
  });

  it("trips on the same non-auth error repeated across tickets", () => {
    const b = breaker(3);
    const err = (n: number) => `hook failed: git clone exited 128 in /tmp/ws/TEA-${n}`;
    expect(b.recordFailure("TEA-1", err(1), T0).justTripped).toBe(false);
    expect(b.recordFailure("TEA-2", err(2), T0).justTripped).toBe(false);
    expect(b.recordFailure("TEA-3", err(3), T0).justTripped).toBe(true);
    expect(b.status(T0)?.kind).toBe("repeated");
  });

  it("does not trip when one ticket keeps failing on its own", () => {
    const b = breaker(3);
    for (let i = 0; i < 6; i++) expect(b.recordFailure("TEA-1", "tests failed: 2 assertions", T0).justTripped).toBe(false);
    expect(b.isPaused(T0)).toBe(false);
  });

  it("a different error resets the streak, and handled errors are ignored", () => {
    const b = breaker(3);
    b.recordFailure("TEA-1", "boom one", T0);
    b.recordFailure("TEA-2", "boom one", T0);
    b.recordFailure("TEA-3", "something else", T0);
    b.recordFailure("TEA-4", "aborted", T0);
    b.recordFailure("TEA-5", "claude_blocked: rate limited", T0);
    expect(b.isPaused(T0)).toBe(false);
  });

  it("a success between failures resets the streak", () => {
    const b = breaker(3);
    b.recordFailure("TEA-1", "boom", T0);
    b.recordFailure("TEA-2", "boom", T0);
    expect(b.recordSuccess()).toBe(false);
    expect(b.recordFailure("TEA-3", "boom", T0).justTripped).toBe(false);
  });
});

describe("failure-breaker helpers", () => {
  it("errorSignature matches the same failure on different tickets", () => {
    expect(errorSignature("clone failed for TEA-5051 at /a/b/TEA-5051 (exit 128)"))
      .toBe(errorSignature("clone failed for TEA-5052 at /a/b/TEA-5052 (exit 1)"));
  });

  it("redactSecrets hides token-shaped strings", () => {
    const out = redactSecrets("bad sk-ant-oat01-AbC_123 and xoxb-1-2-3 and ghp_abcDEF");
    expect(out).not.toMatch(/AbC_123|xoxb-1-2-3|abcDEF/);
    expect(out).toContain("sk-ant-[redacted]");
  });

  it("refreshAuthEnv copies only changed auth keys and reports names, not values", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "old", OTHER: "keep" };
    const changed = refreshAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: "new", OTHER: "x", ANTHROPIC_API_KEY: "" }, env);
    expect(changed).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "new", OTHER: "keep" });
    expect(refreshAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: "new" }, env)).toEqual([]);
  });

  it("breakerAlertText explains the auth fix without needing a restart", () => {
    const text = breakerAlertText("auth", "Failed to authenticate", 10);
    expect(text).toContain("paused");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(text).toContain("No restart needed");
    expect(text).toContain("~10 min");
  });
});

describe("Orchestrator pause on systemic failures", () => {
  function setup() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-breaker-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
workspace:
  root: ${tmpDir}
---

Prompt body`, "utf8");
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const orchestrator = new Orchestrator(workflowPath, log);
    const internals = orchestrator as unknown as {
      state: { running: Map<string, RunningEntry>; retryAttempts: Map<string, { timer: ReturnType<typeof setTimeout> }> };
      handleWorkerExit(id: string, r: AgentResult): void;
    };
    const run = (n: number) => {
      const issue = { id: `id-${n}`, identifier: `TEA-${n}`, title: "t", state: "Todo" } as Issue;
      internals.state.running.set(issue.id, {
        issueId: issue.id, issueIdentifier: issue.identifier, issue, startedAt: new Date(), retryAttempt: null,
      } as RunningEntry);
      return issue.id;
    };
    const cleanup = () => { for (const r of internals.state.retryAttempts.values()) clearTimeout(r.timer); };
    return { orchestrator, internals, run, cleanup, log };
  }

  const result = (success: boolean, error?: string): AgentResult =>
    ({ success, error, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 1 });

  it("pauses on an auth failure, reports it in the snapshot, and resumes after a success", () => {
    const { orchestrator, internals, run, cleanup, log } = setup();
    try {
      internals.handleWorkerExit(run(1), result(false, AUTH));
      const paused = orchestrator.getSnapshot().dispatch_paused;
      expect(paused).toMatchObject({ kind: "auth", half_open: false });
      expect(log.error).toHaveBeenCalledWith("Dispatch paused: agent runs are failing systemically", expect.anything());
      // No v2 Slack here, so the alert is logged instead of DM'd.
      expect(log.warn).toHaveBeenCalledWith("Operator alert (no v2 Slack configured)", expect.objectContaining({ text: expect.stringContaining("paused") }));

      internals.handleWorkerExit(run(2), result(true));
      expect(orchestrator.getSnapshot().dispatch_paused).toBeNull();
      expect(log.warn).toHaveBeenCalledWith("Operator alert (no v2 Slack configured)", expect.objectContaining({ text: expect.stringContaining("resumed") }));
    } finally {
      cleanup();
    }
  });
});
