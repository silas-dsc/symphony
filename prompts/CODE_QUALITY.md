# Code quality pass (inline, on every file you touch)

This is not a separate cleanup step — apply it as you write. Every file you modify must meet these gates before the commit that touches it.

## Hard gates (must pass before commit)

- [ ] `pnpm typecheck` — zero errors (scoped to the touched package via `pnpm --filter`)
- [ ] `pnpm lint` — zero errors (scoped to the touched package via `pnpm --filter`)
- [ ] No new TypeScript `any` introduced. Use proper types, or `unknown` + narrowing.
- [ ] No new unused imports, variables, parameters, or exports.
- [ ] No commented-out code left behind.
- [ ] No `console.log` / `console.debug` (use the project's logger if logging is required).

Scoped run (preferred — fast on a warm cache, and the only thing the diff can break):

```bash
# For each package the diff touches:
pnpm --filter <pkg> typecheck && pnpm --filter <pkg> lint
```

Workspace-wide run (always before push, never skipped — see `VERIFY.md`):

```bash
bash {{ symphony.root }}/scripts/verify-changes.sh
```

Fix every error before committing. Do not commit with `--no-verify`. Do not disable rules to make errors go away — fix the underlying issue.

## Per-file walkthrough (mandatory)

After your last code change in this commit, list every file the diff touches and re-open each one with this checklist in mind. Skimming the file is enough; reading the original lines plus your additions is required.

```bash
git diff --name-only origin/main...HEAD
```

For each file:

- Re-read the diff hunks. Does each change still make sense out of the order you wrote them?
- Is every added symbol referenced from somewhere? `rg -F "<symbol>" packages/<pkg>` should show ≥ 1 usage outside the definition.
- Does the file still read top-to-bottom as one coherent story, or did your edits leave it as a patchwork of unrelated changes?

The walkthrough catches the things lint can't: a function whose purpose drifted, a name that no longer describes what it does, a comment that was true before your change but isn't now.

## Clean code checklist

- [ ] **Names describe intent.** `data`, `info`, `temp`, `obj`, `result` are red flags. Prefer `pendingInvoices`, `userIdsToInvite`, `parsedCsvRow`.
- [ ] **Functions do one thing.** If a function exceeds ~40 lines or 3 levels of nesting, extract.
- [ ] **No magic numbers or strings.** Extract to named constants near use.
- [ ] **No dead code.** If you removed the last caller of a function, delete the function.
- [ ] **Comments explain WHY, not WHAT.** Delete comments that just restate the next line. Keep comments that capture a non-obvious constraint, invariant, or workaround.
- [ ] **No backwards-compat shims** unless the ticket explicitly requires one. Just change the code.

## DRY check

Before adding a new helper:

```bash
# Search for similar existing utilities in the same package
rg "function <similar-name>|const <similar-name>" packages/<pkg>/src
```

- [ ] If you wrote the same 3+ line block twice in this change, extract a helper.
- [ ] If the codebase already has a utility (date formatting, currency, validation, Firestore converters, role checks), use it — don't reinvent.
- [ ] If two components diverged via copy-paste and you're touching one, consider whether to converge them. Only do so if it's directly in your path; otherwise file a backlog ticket.

## Simplicity first

Minimum code that solves the problem. The senior-engineer test: would a reviewer say this diff is overcomplicated? If yes, simplify before committing. See `{{ symphony.root }}/WORKFLOW.md` → Simplicity first.

- [ ] **No features beyond Intent / AC.** Scope creep doesn't slip in via "while I'm here".
- [ ] **No abstractions for single-use code.** A helper with one caller is not a helper — inline it.
- [ ] **No "flexibility" or "configurability" the ticket didn't ask for.** Hard-code values until a second caller demonstrates the need.
- [ ] **No defensive validation for impossible states.** Validate at system boundaries (user input, external API responses, untrusted reads) only. Internal callers the type system already guarantees don't need runtime null-checks.
- [ ] **No "while I'm here" refactors outside the ticket's path.** Refactors that aren't load-bearing for this change bloat the PR and slow review.
- [ ] **If 200 lines could be 50, rewrite it.** Length is not value.

## Surgical changes

Touch only what you must. Every changed line should trace back to a Plan task; if a hunk doesn't, it's scope creep — revert it. See `{{ symphony.root }}/WORKFLOW.md` → Surgical changes.

- [ ] **Don't "improve" adjacent code, comments, or formatting** that isn't in the path of your change.
- [ ] **Match the existing style** of the file you're editing — consistency *inside one file* beats consistency with the rest of the codebase.
- [ ] **Don't refactor what isn't broken.** If an existing pattern works and isn't load-bearing for your change, leave it.
- [ ] **Remove the orphans your edit created** (imports / vars / functions made unused by your change). Do **not** remove pre-existing dead code unless the ticket asks — that's a separate Backlog ticket.

When you spot unrelated tech debt in code you're touching:

1. Fix only what's directly in the path of your change.
2. For anything larger, **file a Linear Backlog ticket** and record it in `.claude/workpad.md`. Do not expand scope into the current PR:

```
Adjacent tech debt noticed (not addressed this PR):
- <file>:<line> — <one-line description> → Linear: <BACKLOG-### or "filing not warranted">
```

## Record in workpad

Append to `.claude/workpad.md` (Notes section) after this pass:

```
Code quality pass on <commit SHA>:
- Files touched: <list>
- Per-file walkthrough: done
- Scoped typecheck / lint: green for packages <list>
- Helpers extracted: <list or "none">
- Dead code removed: <list or "none">
- Backlog tickets filed for adjacent debt: <links or "none">
```

A workpad note without "Per-file walkthrough: done" is treated by the Code Reviewer as a missing gate — they will request you re-run the walkthrough.
