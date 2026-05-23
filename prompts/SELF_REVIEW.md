# Phase 3 final gate — Self-review before push

Run this immediately before `git push` for the first time on the feature branch, and again before pushing any rework commit. It's the developer-side counterpart to the Code Reviewer (Phase 4.5): the Code Reviewer reads the diff with fresh eyes, but you wrote it — you can catch a different class of misses by rereading your own work deliberately.

The automated gate is `bash {{ symphony.root }}/scripts/verify-changes.sh` (see `VERIFY.md`). This file is the **human** pass that runs alongside it. Both must be green before push.

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
5. **Project memory** — `{{ symphony.root }}/docs/AGENT_MEMORY.md` rules respected?

Do not skim. Rereading your own code with fresh eyes is the single most effective bug catcher available to you.

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
- [ ] A test promised in the Plan's **Tests to add** section that isn't in the diff.
- [ ] A behavioural change with no developer-side test, and no `TDD skip` note in `.claude/workpad.md`.
- [ ] A hunk in the diff that doesn't trace back to a Plan task or AC (scope creep — see `prompts/CODE_QUALITY.md` → Surgical changes).
- [ ] An abstraction, parameter, or "flexibility" added for a single call-site (premature — inline it; see Simplicity first).
- [ ] Adjacent formatting / comment / style edits that aren't load-bearing for the change (Surgical changes — revert the cosmetic hunks).

Most of these are caught by `verify-changes.sh` too — but the script is a syntactic scan; you can spot semantic versions (a variable named `result` that should be `pendingInvoices`, a function whose name no longer matches its body) that no regex will.

## Re-run the gates after any fix

If you find and fix anything during self-review, re-run **both** the automated and the manual passes:

```bash
bash {{ symphony.root }}/scripts/verify-changes.sh
pnpm --filter <pkg> test -- --run   # if you touched testable code
```

Then re-do the visual checks for any pages you re-touched.

## Definition of Done

- [ ] Every file in the diff re-read with the five checklists in mind.
- [ ] All red flags above checked and clean.
- [ ] Every AC from the refined ticket truly delivered (re-confirm by reading the AC list out loud against the diff).
- [ ] `verify-changes.sh` exits `VERIFY: pass` on the current HEAD.
- [ ] Latest commit in workpad's notes section has a fresh `Self-review on <SHA>` line.

Only after every box above is ticked: `git push`. Phase 4 (Tester) and Phase 4.5 (Code Reviewer) come next.

## Record in workpad

Append to `.claude/workpad.md`:

```
Self-review on <commit SHA>:
- Files reviewed: <count>
- Red flags found and fixed: <list or "none">
- AC re-confirmed against diff: yes
- VERIFY: pass
```
