import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitAndPushLessons } from "../lessons-sync.js";

function g(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("commitAndPushLessons", () => {
  let tmp: string;
  let remote: string;
  let work: string;
  let lessonsPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-sync-"));
    remote = path.join(tmp, "remote.git");
    work = path.join(tmp, "work");

    g(tmp, ["init", "--bare", "--initial-branch=main", remote]);
    g(tmp, ["clone", remote, work]);
    g(work, ["config", "user.email", "test@example.com"]);
    g(work, ["config", "user.name", "Test"]);
    g(work, ["config", "commit.gpgsign", "false"]);

    fs.mkdirSync(path.join(work, "lessons"));
    lessonsPath = path.join(work, "lessons", "lessons.jsonl");
    fs.writeFileSync(lessonsPath, "");
    g(work, ["add", "-A"]);
    g(work, ["commit", "-m", "init"]);
    g(work, ["branch", "-M", "main"]);
    g(work, ["push", "-u", "origin", "main"]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function appendLesson(ticket: string): void {
    fs.appendFileSync(lessonsPath, JSON.stringify({ ticket, primary_miss: "x" }) + "\n");
  }

  it("commits and pushes an appended lesson to the tracked branch", async () => {
    appendLesson("T-1");
    const res = await commitAndPushLessons({
      repoRoot: work,
      lessonsPath,
      branch: "main",
      remote: "origin",
      issueIdentifier: "T-1",
    });

    expect(res).toEqual({ committed: true, pushed: true });
    // The commit reached the remote.
    expect(g(remote, ["log", "--oneline"])).toContain("lessons: T-1 retrospective");
    // Working tree is clean afterwards (so self-update isn't blocked).
    expect(g(work, ["status", "--porcelain"])).toBe("");
  });

  it("is a no-op when the lessons file has not changed", async () => {
    appendLesson("T-1");
    await commitAndPushLessons({ repoRoot: work, lessonsPath, branch: "main", remote: "origin", issueIdentifier: "T-1" });

    const before = g(remote, ["rev-parse", "HEAD"]);
    const res = await commitAndPushLessons({ repoRoot: work, lessonsPath, branch: "main", remote: "origin", issueIdentifier: "T-2" });

    expect(res).toEqual({ committed: false, pushed: false, reason: "no_changes" });
    expect(g(remote, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("skips files outside the repo without committing", async () => {
    const outside = path.join(tmp, "stray.jsonl");
    fs.writeFileSync(outside, "{}\n");
    const res = await commitAndPushLessons({
      repoRoot: work,
      lessonsPath: outside,
      branch: "main",
      remote: "origin",
      issueIdentifier: "T-1",
    });
    expect(res).toEqual({ committed: false, pushed: false, reason: "outside_repo" });
  });

  it("resolves the current branch when none is given", async () => {
    appendLesson("T-9");
    const res = await commitAndPushLessons({
      repoRoot: work,
      lessonsPath,
      branch: "",
      remote: "origin",
      issueIdentifier: "T-9",
    });
    expect(res.pushed).toBe(true);
    expect(g(remote, ["log", "--oneline"])).toContain("lessons: T-9 retrospective");
  });

  it("rebases and still pushes when the remote moved (non-fast-forward)", async () => {
    // Simulate an operator merging an unrelated change to the remote main
    // (e.g. a meta-improve prompt edit) via a second clone.
    const other = path.join(tmp, "other");
    g(tmp, ["clone", remote, other]);
    g(other, ["config", "user.email", "op@example.com"]);
    g(other, ["config", "user.name", "Op"]);
    fs.writeFileSync(path.join(other, "PROMPT.md"), "edit\n");
    g(other, ["add", "-A"]);
    g(other, ["commit", "-m", "meta-improve: prompt edit"]);
    g(other, ["push", "origin", "main"]);

    // Our local repo is now behind. Appending + syncing must rebase then push.
    appendLesson("T-5");
    const res = await commitAndPushLessons({
      repoRoot: work,
      lessonsPath,
      branch: "main",
      remote: "origin",
      issueIdentifier: "T-5",
    });

    expect(res).toEqual({ committed: true, pushed: true });
    const log = g(remote, ["log", "--oneline"]);
    expect(log).toContain("lessons: T-5 retrospective");
    expect(log).toContain("meta-improve: prompt edit");
    expect(g(work, ["status", "--porcelain"])).toBe("");
  });

  it("coalesces concurrent syncs without error and leaves a clean tree", async () => {
    appendLesson("T-1");
    appendLesson("T-2");
    const [a, b] = await Promise.all([
      commitAndPushLessons({ repoRoot: work, lessonsPath, branch: "main", remote: "origin", issueIdentifier: "T-1" }),
      commitAndPushLessons({ repoRoot: work, lessonsPath, branch: "main", remote: "origin", issueIdentifier: "T-2" }),
    ]);

    // Exactly one of them does the commit; the other finds nothing to do.
    const committed = [a, b].filter((r) => r.committed).length;
    expect(committed).toBe(1);
    expect(g(work, ["status", "--porcelain"])).toBe("");

    // Both lines made it to the remote.
    const remoteFile = execFileSync("git", ["show", "HEAD:lessons/lessons.jsonl"], { cwd: remote, encoding: "utf8" });
    expect(remoteFile).toContain("T-1");
    expect(remoteFile).toContain("T-2");
  });
});
