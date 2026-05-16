# Code quality pass (inline, on every file you touch)

This is not a separate cleanup step — apply it as you write. Every file you modify must meet these gates before the commit that touches it.

## Hard gates (must pass before commit)

- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm lint` — zero errors
- [ ] No new TypeScript `any` introduced. Use proper types, or `unknown` + narrowing.
- [ ] No new unused imports, variables, parameters, or exports.
- [ ] No commented-out code left behind.
- [ ] No `console.log` / `console.debug` (use the project's logger if logging is required).

Run from the workspace root:
```bash
pnpm typecheck && pnpm lint
```

Fix every error before committing. Do not commit with `--no-verify`. Do not disable rules to make errors go away — fix the underlying issue.

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

## Trim scope

- [ ] No speculative abstractions for features that don't exist yet.
- [ ] No defensive validation for states that internal callers cannot produce. Validate at system boundaries (user input, external API responses) only.
- [ ] No "while I'm here" refactors outside the ticket's path. Refactors that aren't load-bearing for this change bloat the PR and slow review.

## When you find unrelated tech debt

If you spot real issues in code you're touching but they're outside the ticket scope:

1. Fix only what's directly in the path of your change.
2. For larger debt, **file a Linear Backlog ticket** and link it from `.claude/workpad.md`. Do not expand scope into the current PR.

## Record in workpad

Append to `.claude/workpad.md` (Notes section) after this pass:

```
Code quality pass on <commit SHA>:
- Files touched: <list>
- typecheck / lint: green
- Helpers extracted: <list or "none">
- Dead code removed: <list or "none">
- Backlog tickets filed for adjacent debt: <links or "none">
```
