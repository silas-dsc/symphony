import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "../config.js";

describe("loadWorkflow notifications", () => {
  const originalWebhook = process.env.TEST_SLACK_WEBHOOK_URL;

  afterEach(() => {
    if (originalWebhook === undefined) {
      delete process.env.TEST_SLACK_WEBHOOK_URL;
    } else {
      process.env.TEST_SLACK_WEBHOOK_URL = originalWebhook;
    }
  });

  it("resolves Slack webhook env vars and user maps", () => {
    process.env.TEST_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/ABC";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-config-"));
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");

    fs.writeFileSync(workflowPath, `---
tracker:
  kind: linear
  api_key: test-linear-key
  project_slug: demo
notifications:
  slack:
    webhook_url: $TEST_SLACK_WEBHOOK_URL
    user_map:
      alice@example.com: U123
      Bob Example: U456
---

Prompt body`, "utf8");

    const workflow = loadWorkflow(workflowPath);

    expect(workflow.config.notifications.slack).toEqual({
      webhookUrl: "https://hooks.slack.test/services/ABC",
      userMap: {
        "alice@example.com": "U123",
        "Bob Example": "U456",
      },
    });
  });
});