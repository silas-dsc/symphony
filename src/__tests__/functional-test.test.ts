import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FT_COMMENT_MARKER, FunctionalTester, designRules, formatEvidence, headline, parseFtResult, renderFtPrompt, viewportsFor,
  type FtRequest,
} from "../functional-test.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "symphony-ft-"));

const req = (over: Partial<FtRequest> = {}): FtRequest => ({
  target: "preview",
  baseUrl: "https://team-dsc-production-preview-web-pr-12.onrender.com",
  issue: { id: "iss-1", identifier: "TEA-1", title: "Bulk unassign", description: "Admins can unassign many learners.", url: "https://linear.app/x/issue/TEA-1" },
  pr: { url: "https://github.com/team-dsc/team-dsc/pull/12", number: 12, branch: "feature/tea-1" },
  changedFiles: ["packages/app/src/routes/dashboard.tsx"],
  mayFix: true,
  reason: "Asked by Silas",
  ...over,
});

const report = (dir: string, body: Record<string, unknown>) => `Done.\n\n\`\`\`ft-result\n${JSON.stringify({ screenshots: [], ...body }).replace(/DIR/g, dir)}\n\`\`\``;

describe("parseFtResult", () => {
  it("derives the verdict from the checks, not the agent's headline", () => {
    const dir = tmp();
    const r = parseFtResult(report(dir, { verdict: "pass", summary: "ok", checks: [{ name: "a", status: "pass" }, { name: "b", status: "fail", evidence: "500" }] }), "r1", dir);
    expect(r.verdict).toBe("fail");
    const p = parseFtResult(report(dir, { checks: [{ name: "a", status: "pass" }, { name: "b", status: "not_checked" }] }), "r1", dir);
    expect(p.verdict).toBe("partial");
  });

  it("keeps only screenshots inside the run folder, else lists the folder", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "01-list-desktop.png"), "x");
    const r = parseFtResult(report(dir, { checks: [{ name: "a", status: "pass" }], screenshots: [{ file: "/etc/passwd", label: "nope" }] }), "r1", dir);
    expect(r.screenshots).toEqual([{ file: path.join(dir, "01-list-desktop.png"), label: "list desktop" }]);
  });

  it("reads design comparisons and drops ones outside the folder", () => {
    const dir = tmp();
    const r = parseFtResult(report(dir, {
      checks: [{ name: "Matches design", status: "pass" }],
      comparisons: [
        { label: "List, mobile", actual: "DIR/01.png", design: "DIR/design-01.png", combined: "DIR/compare-01.png" },
        { label: "evil", actual: "/tmp/a.png", design: "/tmp/b.png", combined: "/tmp/c.png" },
      ],
    }), "r1", dir);
    expect(r.comparisons).toEqual([{ label: "List, mobile", actual: `${dir}/01.png`, design: `${dir}/design-01.png`, combined: `${dir}/compare-01.png` }]);
  });

  it("reports an error when there's no result block", () => {
    const r = parseFtResult("ran out of turns", "r1", tmp());
    expect(r.verdict).toBe("error");
    expect(r.problems[0]).toContain("without a report");
  });
});

describe("prompt", () => {
  const template = fs.readFileSync(path.resolve(__dirname, "../../prompts/FUNCTIONAL_TEST.md"), "utf8");

  it("fills every placeholder", () => {
    const out = renderFtPrompt(template, req(), "r1", "/ws/.symphony-ft/r1", "/ws");
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out).toContain("git push origin feature/tea-1");
    expect(out).toContain("DSFREE");
  });

  it("tests tablet and mobile only for UI changes", () => {
    expect(viewportsFor(["packages/app/src/components/Table.tsx"])).toMatch(/desktop, tablet and mobile/);
    expect(viewportsFor(["packages/functions/src/lib/xero.ts"])).toMatch(/desktop only/);
  });

  it("never lets production push fixes", () => {
    const out = renderFtPrompt(template, req({ target: "production", baseUrl: "https://teamdsc.com.au", pr: null, mayFix: false }), "r1", "/ws/.symphony-ft/r1", "/ws");
    expect(out).toContain("This is production");
    expect(out).toContain("Don't change code or push anything");
    expect(out).not.toContain("git push");
  });

  it("asks for side-by-side design comparisons when the ticket links a design", () => {
    const ws = tmp();
    const withDesign = req({ issue: { ...req().issue!, description: "Design: https://claude.ai/design/abc123" } });
    expect(designRules(withDesign, ws, `${ws}/.symphony-ft/r1`)).toContain("compare-<nn>");
    fs.mkdirSync(path.join(ws, "design"));
    fs.writeFileSync(path.join(ws, "design", "TEA-1.html"), "<html/>");
    expect(designRules(withDesign, ws, `${ws}/.symphony-ft/r1`)).toContain(`file://${path.join(ws, "design", "TEA-1.html")}`);
    expect(designRules(req(), ws, `${ws}/x`)).toContain("skip the design comparison");
  });
});

describe("evidence", () => {
  it("formats checks, fixes, comparisons and screenshots, with the gate-safe marker", () => {
    const r = { runId: "r1", verdict: "fail" as const, summary: "One check failed.", checks: [{ name: "Unassign 3 learners", status: "fail" as const, evidence: "button hidden on mobile" }],
      screenshots: [], comparisons: [], fixedCommits: [{ sha: "abcdef1234", message: "Fix: stack table on mobile" }], problems: ["Table overflows on mobile"], leftovers: [] };
    const md = formatEvidence(req(), r, [{ label: "list mobile", url: "https://uploads.linear.app/a.png" }], [
      { label: "List, mobile", combined: "https://uploads.linear.app/c.png", actual: null, design: null },
      { label: "List, desktop", combined: null, actual: "https://u/a.png", design: "https://u/d.png" },
    ]);
    expect(md.startsWith(FT_COMMENT_MARKER)).toBe(true);
    expect(md).toContain("❌ Functional test on PR #12 preview failed (0/1 checks)");
    expect(md).toContain("`abcdef1` Fix: stack table on mobile");
    expect(md).toContain("![List, mobile: built vs design](https://uploads.linear.app/c.png)");
    expect(md).toContain("| ![built](https://u/a.png) | ![design](https://u/d.png) |");
    expect(md).toContain("![list mobile](https://uploads.linear.app/a.png)");
  });
});

describe("FunctionalTester", () => {
  it("runs one test at a time and posts evidence to the ticket and the PR", async () => {
    const ws = tmp();
    let running = 0;
    let maxRunning = 0;
    const issueComments: string[] = [];
    const prComments: string[] = [];
    const tester = new FunctionalTester({
      tracker: {} as never, workspaceRoot: ws, hooks: { afterCreate: null, beforeRun: null, timeoutMs: 1000 },
      symphonyRoot: path.resolve(__dirname, "../.."), mcpConfigPath: undefined, repo: "o/r",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      prepare: async () => ws,
      runAgent: async (prompt) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const dir = /screenshot with `take_screenshot` and `filePath` set to `([^`]+)\/</.exec(prompt)![1];
        fs.writeFileSync(path.join(dir, "01-list-desktop.png"), "png");
        await new Promise(r => setTimeout(r, 20));
        running--;
        return report(dir, { summary: "All good.", checks: [{ name: "List loads", status: "pass" }] });
      },
      upload: async f => `https://uploads.linear.app/${path.basename(f)}`,
      postIssueComment: async (_id, body) => { issueComments.push(body); },
      postPrComment: async (_url, body) => { prComments.push(body); },
    });
    const [a, b] = await Promise.all([tester.run(req()), tester.run(req())]);
    expect(maxRunning).toBe(1);
    expect(a.verdict).toBe("pass");
    expect(b.verdict).toBe("pass");
    expect(issueComments[0]).toContain("![list desktop](https://uploads.linear.app/01-list-desktop.png)");
    expect(prComments[0]).toContain("Screenshots and details: https://linear.app/x/issue/TEA-1");
    expect(headline(req(), a)).toBe("✅ Functional test on PR #12 preview passed (1/1 checks)");
  });
});
