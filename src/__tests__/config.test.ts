import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "../config.js";

describe("loadWorkflow notifications", () => {
  const originalToken = process.env.TEST_SLACK_BOT_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.TEST_SLACK_BOT_TOKEN;
    } else {
      process.env.TEST_SLACK_BOT_TOKEN = originalToken;
    }
  });

  it("resolves Slack bot token env vars and user maps", () => {
    process.env.TEST_SLACK_BOT_TOKEN = "xoxb-test-token";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-config-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");

    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
notifications:
  slack:
    bot_token: $TEST_SLACK_BOT_TOKEN
    channel: C0TESTCHAN
    user_map:
      alice@example.com: U123
      Bob Example: U456
---

Prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);

    expect(workflow.config.notifications.slack).toEqual({
      botToken: "xoxb-test-token",
      channel: "C0TESTCHAN",
      userMap: {
        "alice@example.com": "U123",
        "Bob Example": "U456",
      },
    });
  });
});