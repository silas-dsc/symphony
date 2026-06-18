# Codebase-shrink pass

Applied during Phase 3 alongside `CODE_QUALITY.md`. The goal is to leave the codebase smaller than you found it whenever your change makes that possible — without expanding scope into a refactor PR.

This is **not** a general cleanup mandate. It's a check that the diff you're shipping doesn't leave waste behind. Three patterns repeatedly bloat the codebase:

- A function whose last caller you just removed but didn't delete.
- A npm dependency you added for a previous attempt that's no longer imported.
- A 5-line block you wrote that already exists as a helper elsewhere in the package.

Catching these per-touch is cheap. Letting them accumulate over 50 tickets is how a codebase ends up with 30% dead code.

## The four shrink checks (mandatory on every Phase 3 commit)

### 1. Did your change orphan a symbol?

For every removed call or import in the diff, search the codebase for remaining references:

```bash
# For each removed function/component/constant name in your diff:
rg -F --type ts --type tsx "<symbolName>" packages/<pkg>/src
```

If zero references remain (other than the symbol's own definition), delete the symbol. Don't leave it "in case someone wants it later" — git remembers; the editor doesn't need to.

If the symbol is an exported function whose last external caller you removed, also remove the `export` (or the whole function if no internal callers either).

### 2. Did your change make a dependency unused?

If you modified `package.json` (added or removed deps), or if you removed the last import of a package:

```bash
# Quick local check — search every source file for the import.
rg "from ['\"]<package-name>" --type ts --type tsx --type js --type jsx
```

If the search returns zero, remove the dep from `package.json`. Run `pnpm install` to update the lockfile. The Code Reviewer (Phase 4.5) treats orphaned deps in the diff as Blocking.

For a more thorough check, run `pnpm exec --no -- depcheck` (if installed in the repo). If `depcheck` reports your newly-added package as unused, that's the gate failing — you imported it once and then refactored that import out.

### 3. Did you copy a 3+ line block from elsewhere?

For any non-trivial block of new code (≥ 3 lines doing distinct work), search for a similar existing utility:

```bash
# Distinctive substring of the new block.
rg -F "<unique substring from your new code>" packages/<pkg>/src
```

If you find a near-duplicate elsewhere:
- **Extract a shared helper** if the two callsites have the same concern (same domain object, same intent).
- **Refuse to extract** only when (a) the two blocks have meaningfully different concerns, (b) extraction would force a circular dependency, or (c) the team's project memory says the duplication is intentional.

Document the refusal in `.claude/workpad.md` if you chose not to extract — the Code Reviewer reads this.

### 4. Did your change reduce a function to a single caller?

If you touched a function/component that is now called from exactly one place in the codebase:

```bash
rg -F "<funcName>(" packages/<pkg>/src
```

Consider inlining. Inline only if the result is **shorter and clearer** — a function with one caller is sometimes named precisely so the caller is self-documenting. Use judgement; don't inline as a reflex.

## What's NOT in scope

If you find unrelated dead code or duplication outside the path of your change:

- File a Linear Backlog ticket describing the candidate. Link the file and line range.
- Don't widen the PR. Shrink-on-touch is for waste your change creates or directly exposes, not for general spring-cleaning.

Exception: if the unrelated dead code is in a file you've already modified for a legitimate reason, you may also delete the dead code in the same commit. Don't go hunting in adjacent files.

## Codebase-wide audit (operator-triggered, not per-ticket)

For periodic full-repo audits — typically run by the operator monthly or after a big feature batch — the heavy tools come out:

```bash
pnpm exec knip           # unused files, exports, types, deps (best-in-class)
pnpm exec ts-prune       # fallback if knip isn't configured
pnpm exec depcheck       # unused npm deps
pnpm exec jscpd           # duplicate-code finder
```

These are too slow and too noisy to run in `VERIFY` (knip alone takes 30+ seconds on a medium monorepo and surfaces dozens of pre-existing orphans). Their findings should become Linear Backlog tickets, not blocking gates on individual tickets.

The Symphony operator can run these directly in the workspace:

```bash
cd ~/code/team-dsc-workspaces/<some-workspace>
pnpm exec knip --reporter compact > /tmp/knip-report.txt
```

Then triage the report and file backlog tickets for the worth-fixing entries.

## Record in workpad

Append to `.claude/workpad.md` (Notes section) after the shrink pass:

```
Shrink pass on <commit SHA>:
- Symbols orphaned and deleted: <list or "none">
- Dependencies removed: <list or "none">
- Duplication extracted (or refusal justified): <description>
- Single-caller inlines: <list or "none">
- Backlog tickets filed for adjacent waste: <links or "none">
```

A workpad without a Shrink pass note is treated by the Code Reviewer as a missing gate.

## Definition of Done

- [ ] Every removed import/call: verified no remaining references (or the new orphan is deleted in the same commit).
- [ ] If `package.json` changed: no orphaned deps in the diff (depcheck or manual `rg` confirms).
- [ ] If you wrote a 3+ line block: searched for duplicates; helper extracted, or refusal documented in workpad.
- [ ] Single-caller inlining considered for any function whose call count you reduced to one.
- [ ] No expansion of scope into unrelated cleanup; backlog ticket filed if applicable.
- [ ] Shrink pass note in `.claude/workpad.md`.
