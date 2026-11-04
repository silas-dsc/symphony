import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderPrompt } from "../agent.js";
import type { Issue } from "../types.js";

// Render the real WORKFLOW.md body so template mistakes (strict Liquid vars)
// fail here rather than at dispatch time.
const workflow = fs.readFileSync(path.resolve(__dirname, "../../WORKFLOW.md"), "utf8");
const body = workflow.replace(/^---\n[\s\S]*?\n---\n/, "");

function issue(description: string): Issue {
  return {
    id: "1", identifier: "TEA-9", title: "Title", description, priority: 1, state: "Dev in Progress",
    branchName: null, url: "https://linear.app/x/issue/TEA-9", labels: [], blockedBy: [],
    assignee: null, creator: null, createdAt: null, updatedAt: null,
  };
}

describe("WORKFLOW.md prompt", () => {
  it("adds the design-pinning block when the ticket links a design", () => {
    const out = renderPrompt(body, issue("Design: https://claude.ai/design/abc"), null, "/sym");
    expect(out).toContain("**Design reference:** https://claude.ai/design/abc");
    expect(out).toContain("`design/TEA-9.html`");
    expect(out).toContain("Visual match vs design (design link needs login)");
  });

  it("omits the design block otherwise, and always asks for Checked / Not checked", () => {
    const out = renderPrompt(body, issue("Fix the typo"), null, "/sym");
    expect(out).not.toContain("Design reference");
    expect(out).toContain("**Checked:**");
    expect(out).toContain("**Not checked:**");
    expect(out).toContain("<!-- symphony-agent -->");
  });
});
