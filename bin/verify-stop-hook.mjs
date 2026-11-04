#!/usr/bin/env node
// Symphony VERIFY Stop hook for agent sessions.
//
// Claude Code runs this when the agent tries to finish. If the branch has
// changes and the CI gate fails, exit 2 with the failure on stderr: Claude Code
// feeds that back and the agent keeps working. Gives up after MAX_BLOCKS so a
// genuinely blocked agent can still stop (and report the blocker).
//
// Env: SYMPHONY_VERIFY_CMD (default "pnpm typecheck && pnpm lint"),
//      SYMPHONY_VERIFY_MAX_BLOCKS (default 3).
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BLOCKS = Number(process.env.SYMPHONY_VERIFY_MAX_BLOCKS || 3);
const CMD = process.env.SYMPHONY_VERIFY_CMD || "pnpm typecheck && pnpm lint";

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  // no/invalid stdin → treat as empty
}
const cwd = input.cwd || process.cwd();

function sh(cmd, timeoutMs = 60_000) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf8" });
}

// Only verify when there is something to verify.
let changed = false;
try {
  const dirty = sh("git status --porcelain").trim().length > 0;
  const ahead = Number(sh("git rev-list --count origin/main..HEAD").trim() || "0") > 0;
  changed = dirty || ahead;
} catch {
  process.exit(0); // not a git repo / no origin — nothing to gate
}
if (!changed) process.exit(0);

// Keep the counter inside .git so an agent's `git add -A` can never commit it.
const counterFile = path.resolve(cwd, sh("git rev-parse --git-dir").trim(), "symphony-stop-blocks");
let blocks = 0;
try { blocks = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch { /* first time */ }

try {
  sh(CMD, 12 * 60_000);
  try { fs.rmSync(counterFile); } catch { /* none */ }
  process.exit(0);
} catch (e) {
  if (blocks >= MAX_BLOCKS) process.exit(0);
  try {
    fs.mkdirSync(path.dirname(counterFile), { recursive: true });
    fs.writeFileSync(counterFile, String(blocks + 1));
  } catch { /* best effort */ }
  const out = `${e.stdout || ""}\n${e.stderr || ""}`.trim().split("\n").slice(-40).join("\n");
  process.stderr.write(
    `VERIFY gate failed (\`${CMD}\`), attempt ${blocks + 1}/${MAX_BLOCKS}. Fix these before finishing — ` +
    `don't disable rules or skip checks. If it's a genuine external blocker, say so in the Linear comment and stop.\n\n${out}\n`,
  );
  process.exit(2);
}
