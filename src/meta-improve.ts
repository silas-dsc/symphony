#!/usr/bin/env node
/**
 * One-shot CLI: run the meta-improvement pass over recent lessons.jsonl entries.
 *
 *   npm run meta-improve -- [--window 30d] [--lessons <path>] [--dry-run]
 *
 * Spawns a Claude agent in the Symphony repo with `prompts/META_IMPROVE.md` as
 * its prompt. The agent inspects `lessons/lessons.jsonl`, identifies recurring
 * miss patterns, and proposes prompt edits on a new branch. It does NOT open a
 * PR — the operator reviews the branch and opens the PR by hand.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Liquid } from "liquidjs";

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

interface CliOptions {
  windowMs: number;
  windowLabel: string;
  lessonsPath: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let windowLabel = "30d";
  let lessonsPath = "";
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--window" && i + 1 < argv.length) {
      windowLabel = argv[++i];
    } else if (a === "--lessons" && i + 1 < argv.length) {
      lessonsPath = argv[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`meta-improve: unknown argument: ${a}`);
      printHelp();
      process.exit(2);
    }
  }

  return {
    windowMs: parseWindow(windowLabel),
    windowLabel,
    lessonsPath: lessonsPath || defaultLessonsPath(),
    dryRun,
  };
}

function parseWindow(label: string): number {
  const m = label.match(/^(\d+)([dwh])$/);
  if (!m) throw new Error(`Invalid --window: ${label} (expected e.g. 7d, 30d, 4w, 24h)`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    default: throw new Error(`Invalid window unit: ${m[2]}`);
  }
}

function symphonyRoot(): string {
  // src/meta-improve.ts compiles to dist/meta-improve.js; both live one level
  // below the repo root, so go up one directory either way.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function defaultLessonsPath(): string {
  return path.join(symphonyRoot(), "lessons", "lessons.jsonl");
}

function printHelp(): void {
  console.log(`Usage: meta-improve [--window 30d] [--lessons <path>] [--dry-run]

Options:
  --window <Nd|Nw|Nh>   Time window of lessons to consider (default 30d)
  --lessons <path>      Path to lessons.jsonl (default <symphony>/lessons/lessons.jsonl)
  --dry-run             Don't commit or push; write report to /tmp/ only
  -h, --help            Show this help

Reads the lessons log, spawns Claude with prompts/META_IMPROVE.md, and produces
a branch with proposed prompt edits + META_IMPROVE_REPORT.md. The operator
reviews and opens the PR.`);
}

function filterLessonsByWindow(lessonsPath: string, windowMs: number): { count: number; tmpFile: string } {
  if (!fs.existsSync(lessonsPath)) return { count: 0, tmpFile: "" };

  const cutoffMs = Date.now() - windowMs;
  const lines = fs.readFileSync(lessonsPath, "utf-8").split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: { completed_at?: string };
    try {
      obj = JSON.parse(line);
    } catch {
      // Skip malformed lines silently — the retrospective should not emit them,
      // but we don't want the meta-pass to die on a single bad entry.
      continue;
    }
    if (!obj.completed_at) {
      // Keep entries without timestamps — better to err on the side of including
      // them than to silently drop signal.
      kept.push(line);
      continue;
    }
    const ts = Date.parse(obj.completed_at);
    if (!Number.isNaN(ts) && ts >= cutoffMs) kept.push(line);
  }

  if (kept.length === 0) return { count: 0, tmpFile: "" };

  const tmpFile = path.join(
    fs.realpathSync(path.resolve(symphonyRoot(), ".")),
    `.meta-improve-window-${Date.now()}.jsonl`
  );
  fs.writeFileSync(tmpFile, kept.join("\n") + "\n");
  return { count: kept.length, tmpFile };
}

async function spawnClaudeForMetaPass(prompt: string, dryRun: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || v === "") continue;
      env[k] = v;
    }
    if (dryRun) env.SYMPHONY_META_DRY_RUN = "1";

    const proc = spawn(
      "claude",
      [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      {
        cwd: symphonyRoot(),
        env,
        stdio: ["pipe", "inherit", "inherit"],
      }
    );

    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? 0));
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const filtered = filterLessonsByWindow(opts.lessonsPath, opts.windowMs);
  console.log(`meta-improve: ${filtered.count} lessons in window ${opts.windowLabel}`);

  if (filtered.count === 0) {
    console.log("meta-improve: no lessons in window — nothing to do.");
    return;
  }

  const promptTemplate = fs.readFileSync(
    path.join(symphonyRoot(), "prompts", "META_IMPROVE.md"),
    "utf-8"
  );

  const prompt = liquid.parseAndRenderSync(promptTemplate, {
    lessons_path: filtered.tmpFile,
    window: opts.windowLabel,
  });

  const exitCode = await spawnClaudeForMetaPass(prompt, opts.dryRun);

  // Clean up the temporary windowed file. The lesson archive itself is untouched.
  try {
    if (filtered.tmpFile && fs.existsSync(filtered.tmpFile)) fs.unlinkSync(filtered.tmpFile);
  } catch { /* ignore */ }

  if (exitCode !== 0) {
    console.error(`meta-improve: claude exited with code ${exitCode}`);
    process.exit(exitCode);
  }
}

main().catch((e) => {
  console.error(`meta-improve: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
