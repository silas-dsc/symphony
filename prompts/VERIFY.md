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

The script runs ten checks in total. Seven of them run in parallel (capped at `VERIFY_PARALLELISM`, default `nproc`); the cheap scanners run synchronously after.

**Parallel checks:**
1. **Scoped lint** — `pnpm --filter <pkg> lint` for every touched package.
2. **Scoped typecheck** — `pnpm --filter <pkg> typecheck` for every touched package.
3. **Diff-aware tests** — `vitest --changed $BASE_REF` or `jest --changedSince=$BASE_REF` for every touched package (auto-detected from `package.json` dependencies). Falls back to the package's `test` script if neither is present.
4. **Dependency audit** — `pnpm audit --prod --audit-level high`. Catches known-vulnerable transitive deps.
5. **SAST** — `semgrep --config auto` on touched source files. Catches XSS via `dangerouslySetInnerHTML`, eval, injection, prototype pollution, etc. Skipped if `semgrep` isn't on `PATH`.
6. **Architectural boundaries** — `dependency-cruiser` validated against `.dependency-cruiser.{js,cjs,mjs,json}` if a config exists. Catches "package A imports package B internals when it shouldn't" violations.
7. **Unused exports / orphan files** — `knip --reporter json`, filtered to findings that intersect the touched files. Pre-existing dead code in untouched files is not flagged — only orphans the current diff created.
8. **Firestore rules tests** — runs only when `firestore.rules` was modified, via the repo's `firestore:test` / `rules:test` / `test:rules` script, or vitest against `firestore-tests/`.
9. **Bundle-size budget** — checks each `target → byte-limit` pair in `.bundle-budget.json` against the corresponding built file's size. Doesn't build itself — expects a build artefact already on disk. Skipped if no budget file is present.

**Synchronous checks:**
10. **Forbidden-token scan** on the diff: `TODO`, `FIXME`, `XXX`, `console.log`, `console.debug`, `debugger`, `as any`, `as unknown as`, `.only(`, `.skip(`, `xit(`, `xdescribe(`. Excludes `.md`, `.lock`, `.snap`, and `scripts/verify-changes.sh` itself.
11. **Secret scan** on the diff: `-----BEGIN ... PRIVATE KEY-----`, `sk-...`, `AKIA[0-9A-Z]{16}`, `(password|secret|api_key|token) = "..."`. Allows matches in `.env.example` since it documents placeholder shapes.
12. **Untracked-leftover scan**: `*.tmp`, `*.bak`, `*.log`, `*.swp`, `*.orig`, `*.rej`, `*~` inside the working tree.

### Graceful skips

Each parallel check is **graceful**: if the underlying tool or its config file isn't present, the check exits with code 77 ("skipped") and the script reports `SKIP: <name>` instead of failing. This means the script works against repos that haven't yet adopted every tool — and lights up automatically as adoption happens. A check explicitly skipped via `VERIFY_SKIP=audit,semgrep` also surfaces as a SKIP.

The verdict line counts skips separately so the agent knows when it should push the operator to wire up a missing tool:

```
VERIFY: pass (sha=abc1234, packages=2, files=8, ran=9, skipped=3)
```

If `skipped` is non-zero on a PR that touches `packages/app/**`, the agent should note which tools are missing in `.claude/workpad.md` under `## Tooling gaps` and (optionally) file a Linear Backlog ticket to adopt them. Doing this once per missing tool, not once per ticket.

### Adopting a missing tool

For each `SKIP` line, the agent can run the detection script to confirm which tool is missing and print the install path:

```bash
bash {{ symphony.root }}/scripts/install-verify-tools.sh --check
```

Output is a list of `PRESENT:` / `MISSING:` lines plus a verdict count. To actually adopt — install npm packages, scaffold configs — the **operator** runs `--install --scaffold` (or `--all`). The agent does **not** run install mode itself: adoption is an operator decision that touches `package.json` and adds new gates the team has to live with. The agent surfaces the gap; the operator adopts.

### Per-check logs

Each parallel check writes its full output to `/tmp/symphony-verify-<sha>/<check>.log`. The script prints the last 30 lines of each failing log inline so the agent doesn't need to grep, but the full logs persist for deeper investigation.

### Environment knobs

| Env var | Default | Purpose |
|---|---|---|
| `VERIFY_BASE_REF` | `origin/main` | Diff base for "what changed" detection. |
| `VERIFY_PARALLELISM` | `nproc` (clamped to 1–8) | Concurrent jobs. Lower on memory-constrained machines. |
| `VERIFY_SKIP` | `""` | Comma-separated check names to skip (e.g. `audit,semgrep`). Use sparingly — the gate exists for a reason. |
| `VERIFY_LOG_DIR` | `/tmp/symphony-verify-<sha>` | Where per-check logs go. |
| `SEMGREP_TIMEOUT` | `60` | Per-rule timeout for SAST scan. |
| `BUDGET_FILE` | `.bundle-budget.json` | Bundle-budget definition file. |

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
