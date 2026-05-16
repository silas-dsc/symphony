# Phase 5 — Self-review (final gate before `In Review`)

Before flipping the Linear issue to `In Review`, run a self-review pass against your own diff. The goal is to catch issues that look obvious in code review but you missed while writing.

## Read your own diff

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

For each file in the diff, re-evaluate against the four quality checklists:

1. **Code quality** — `{{ symphony.root }}/prompts/CODE_QUALITY.md`
2. **Performance** — `{{ symphony.root }}/prompts/PERFORMANCE.md` (hot-path files)
3. **Mobile UX** — `{{ symphony.root }}/prompts/MOBILE_UX.md` (frontend pages)
4. **Refined ticket AC** — every acceptance criterion truly delivered, not just attempted?

Do not skim. Re-reading your own code with fresh eyes is the single most effective bug catcher available to you.

## Red flags to look for

- [ ] A `TODO` or `FIXME` you added and didn't address.
- [ ] A `console.log` / `console.debug` you forgot to remove.
- [ ] A type cast `as any` or `as unknown as X` introduced in this PR.
- [ ] A test marked `.skip` or `.only`, or commented out.
- [ ] An imported but unused symbol.
- [ ] An unhandled `Promise` (no `await`, no `.catch`).
- [ ] A new dependency added to `package.json` that isn't actually used by the diff.
- [ ] A file with only whitespace changes (revert if so).
- [ ] A snapshot test updated without verifying the new snapshot is correct.
- [ ] Hard-coded values where a config / env / constant exists.
- [ ] Secrets or PII accidentally committed (`rg -i "password|secret|api_key|token" -- $(git diff --name-only origin/main...HEAD)`).

## Re-run the gates after any fix

If you find and fix anything during self-review:

```bash
pnpm typecheck && pnpm lint
pnpm --filter <package> test   # if you touched testable code
```

Then re-do the visual checks for any pages you re-touched.

## Definition of Done

- [ ] Every file in the diff re-read with the four checklists in mind.
- [ ] All red flags above checked and clean.
- [ ] Every AC from the refined ticket truly delivered (re-confirm by reading the AC list out loud against the diff).
- [ ] `pnpm typecheck && pnpm lint` green on the final commit.
- [ ] No actionable PR comments outstanding (see PR feedback sweep in WORKFLOW.md).
- [ ] Visual evidence and test output already attached to the Linear ticket.

Only after every box above is ticked: move the issue to `In Review`.

## Record in workpad

```
Self-review on <commit SHA>:
- Files reviewed: <count>
- Red flags found and fixed: <list or "none">
- AC re-confirmed against diff: yes
- Final lint/typecheck: green
```
