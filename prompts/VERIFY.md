# Verify — pre-push verification gate

This is the **single gate** every change passes through before the branch is pushed and before the ticket is flipped to `In Review`. It exists to stop the Developer from claiming completion on stale evidence. Past tickets failed when:

- Lint or typecheck regressed in a file the agent hadn't re-opened.
- A commented-out test, a `console.log`, or an `as any` slipped past the diff.
- Unit tests in the touched package were red but the agent only ran the E2E matrix.
- A secret was accidentally committed in an `.env` file or a config snippet.

The fix is mechanical: a single script runs every check, prints a structured summary, and exits non-zero on any failure. The agent does not declare "lint and typecheck green" from memory — it pastes the script's exit line.

## When to run

- **Before every commit** that touches code: as a fast sanity check.
- **Before `git push`**: as the gate. If it doesn't exit 0, you do not push.
- **Before flipping the Linear ticket to `In Review`**: as the final gate. Re-run because Phase 5 may have edited the README or addressed PR feedback after the previous run.

## The command

```bash
bash {{ symphony.root }}/scripts/verify-changes.sh
```

The script:

1. Computes the set of changed files via `git diff --name-only origin/main...HEAD` (plus working-tree changes).
2. Derives the set of touched packages (`packages/<pkg>`) and runs **scoped** lint and typecheck for each via `pnpm --filter <pkg>`. A non-`packages/` change falls back to a workspace-wide `pnpm typecheck && pnpm lint`.
3. For each touched package that has a `test` script, runs `pnpm --filter <pkg> test -- --run` (or the package's equivalent non-watch mode).
4. Scans the diff for forbidden tokens introduced by this branch: `TODO`, `FIXME`, `XXX`, `console.log`, `console.debug`, `debugger`, `as any`, `as unknown as`, `.only(`, `.skip(`, `xit(`, `xdescribe(`.
5. Scans the diff for likely secrets (`-----BEGIN`, `sk-`, `AKIA[0-9A-Z]{16}`, `password\s*=\s*['"][^'"]+['"]`, etc.) and refuses to pass if any matches sit inside `packages/*/.env` or any file other than `.env.example`.
6. Confirms the working tree has no untracked files inside `src/` or `packages/*/src/` that look like accidental leftovers (`*.tmp`, `*.bak`, `*.log`, `*.swp`).
7. Prints a one-line `VERIFY: pass` or `VERIFY: fail (<reasons>)` and exits 0/1.

## When it fails

Read the script's output. Each failure block names the failing check, the files involved, and the command to reproduce. Fix the underlying issue — never disable a rule, never `// eslint-disable-next-line` past a real bug, never `--no-verify` a commit. Re-run the script. Repeat until it exits 0.

If a lint or test failure is genuinely in a file you did **not** touch and pre-dates your branch, treat it as a pre-existing flake: capture the evidence (`git log -p -- <file>` showing the last meaningful change and the date) in `.claude/workpad.md` under a `## Pre-existing failures` heading, and rebase on `origin/main` to confirm — if it's reproducible on `main` alone, file a Linear Backlog ticket and continue. If it's only on your branch, it's yours to fix.

## What to record

After a clean run, append to `.claude/workpad.md`:

```
VERIFY pass on <commit SHA>:
- Changed packages: <list>
- Scoped lint/typecheck: green
- Unit tests for touched packages: <pass count>/<total>
- Forbidden-token scan: clean
- Secret scan: clean
```

The Code Reviewer reads this in Phase 4.5 — a missing or stale `VERIFY pass` line is itself a Blocking finding.

## Hard rules

- **Never push without a fresh `VERIFY: pass`.** "Fresh" means the SHA the script ran on equals `HEAD`. Re-run after every commit that touches code.
- **Never edit the script to make a check pass.** Fix the code.
- **Never claim VERIFY pass in `.claude/workpad.md` without pasting the script's actual final line.**
- **The script is the source of truth.** If something feels green but the script disagrees, the script is right.
