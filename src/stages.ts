import * as path from "node:path";

/**
 * Symphony v2 stages (PLAN / VERIFY / REVIEW) as Claude Code subagents, plus a
 * Stop hook that won't let the build agent finish while typecheck/lint fail.
 *
 * Symphony picks which stages a ticket needs (`routing.ts`) and tells the main
 * agent in the prompt; the stages themselves run inside the one `claude -p`
 * session via `--agents`, so there are no extra processes to manage. Each stage
 * prompt points at the existing expert prompts in `prompts/` rather than
 * copying them, so meta-improve keeps editing one source of truth.
 */

export interface StageAgent {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

function p(root: string, name: string): string {
  return path.join(root, "prompts", `${name}.md`);
}

export function buildStageAgents(symphonyRoot: string): Record<string, StageAgent> {
  return {
    planner: {
      description:
        "PLAN stage. Use BEFORE writing code on thin, risky or feature tickets: states intent, acceptance points, and the smallest design. Read-only.",
      prompt: [
        "You are the PLAN stage for one Linear ticket. Do not edit files.",
        `Read and apply, in order: ${p(symphonyRoot, "INTENT")}, ${p(symphonyRoot, "REFINE_TICKET")}, ${p(symphonyRoot, "ARCHITECT")}.`,
        `If the ticket links a design, also apply ${p(symphonyRoot, "FIGMA_BA")} against the pinned design file (design/<TEA-id>.html).`,
        "Return, in under 250 words: 1) what the user should see when done, 2) a numbered acceptance list, 3) the files to change and the approach, 4) risks.",
        "If two reasonable approaches differ in user-visible behaviour, data model, or cost, end with a line `APPROACH QUESTION: <one question, two options>` — the main agent will raise it to a human instead of guessing.",
      ].join("\n"),
      tools: ["Read", "Grep", "Glob", "Bash"],
    },
    verifier: {
      description:
        "VERIFY stage. Use AFTER the change is built and BEFORE opening/updating the PR: runs checks, walks the acceptance list, and (for UI) compares the preview to the design.",
      prompt: [
        "You are the VERIFY stage. You check; you do not add features.",
        `Read and apply ${p(symphonyRoot, "TESTER")} and ${p(symphonyRoot, "VERIFY")}.`,
        "Always run: `pnpm typecheck && pnpm lint`, and the unit tests for touched packages.",
        "Walk every acceptance point and mark each PASS / FAIL / NOT CHECKED with the evidence (command output or what you saw).",
        "For UI changes: use the chrome-devtools MCP on the Render PR preview (log in with the test accounts in docs/TEAM_DSC_LOGIN.md if present). Screenshot desktop (1440) and mobile (390). If design/<TEA-id>.html exists, open it at the same widths and screenshot it too; list visible differences.",
        "Return: the PASS/FAIL/NOT CHECKED list, screenshot file paths, and two lines ready to paste: `Checked: …` and `Not checked: …`. Never mark something checked that you inferred.",
      ].join("\n"),
    },
    reviewer: {
      description:
        "REVIEW stage. Use on the finished diff before handing to a human: finds hidden debt and bugs. Read-only; reports findings for the main agent to fix.",
      prompt: [
        "You are the REVIEW stage. Review `git diff origin/main...HEAD`. Do not edit files.",
        `Read and apply ${p(symphonyRoot, "CODE_REVIEW")}, ${p(symphonyRoot, "CODE_QUALITY")} and ${p(symphonyRoot, "SELF_REVIEW")}.`,
        "Apply the extra lenses the main agent names (from prompts/PERFORMANCE.md, ACCESSIBILITY.md, MOBILE_UX.md, CLEAR_WRITING.md).",
        "Flag specifically: new TODO/FIXME, skipped or deleted tests, `any`/loose types, copy-paste, logic changed without a test, dead code, scope creep beyond the ticket.",
        "Return findings as `BLOCKER:` / `FIX:` / `NIT:` lines with file:line, then a verdict: `approve` or `changes`. Keep it under 300 words.",
      ].join("\n"),
      tools: ["Read", "Grep", "Glob", "Bash"],
    },
  };
}

/** Claude Code settings JSON enabling the VERIFY Stop hook. */
export function buildStageSettings(symphonyRoot: string): Record<string, unknown> {
  const hook = path.join(symphonyRoot, "bin", "verify-stop-hook.mjs");
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(hook)}`, timeout: 900 }] }],
    },
  };
}

/** Extra `claude` CLI args for stages. Disable with SYMPHONY_STAGES=off. */
export function buildStageArgs(symphonyRoot: string): string[] {
  if (process.env.SYMPHONY_STAGES === "off") return [];
  return [
    "--agents", JSON.stringify(buildStageAgents(symphonyRoot)),
    "--settings", JSON.stringify(buildStageSettings(symphonyRoot)),
  ];
}
