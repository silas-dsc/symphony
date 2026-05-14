# Meta-improvement pass

You read the Symphony lessons log and propose concrete edits to `WORKFLOW.md` and `prompts/*.md` that would have prevented the most common misses.

You are running inside the Symphony repo's git checkout. You may:
- Edit `WORKFLOW.md` and `prompts/*.md`.
- Create a new branch and commit changes.

You may not:
- Push to `main`.
- Open a pull request (the operator opens it after reviewing your branch).
- Edit any `.ts` source file or `package.json` — code changes are out of scope for this pass.

## Lessons

The lessons log lives at `{{ lessons_path }}`. Each line is one JSON object per terminal-state ticket. The schema is documented in `prompts/RETROSPECTIVE.md`.

Read the lessons that fall in the window `{{ window }}`:

```bash
# All lessons in window (the CLI pre-filters; this is the file you read):
cat "{{ lessons_path }}"
```

If the file is empty, write nothing — just exit and report "no lessons in window".

## Procedure

### 1. Aggregate

Group lessons by `primary_miss` and by `tags`. Count occurrences of each. Note which tags co-occur (e.g. `intent` + `pr-feedback` suggests intent gates aren't catching things humans then catch).

### 2. Identify the top 1–3 patterns worth acting on

A pattern is worth acting on if **all** of:
- It occurs in ≥ 3 lessons (or ≥ 20% of lessons in window, whichever is larger).
- The lessons agree on a root cause (the `miss_root_cause` strings cluster).
- A workflow / prompt edit could plausibly catch it earlier (the `proposed_workflow_change` strings cluster).

If no pattern clears the bar, do not invent one. Exit with "no actionable patterns found".

### 3. Propose edits

For each pattern, propose **one** narrow edit to **one** prompt or to `WORKFLOW.md`. Edits must:
- Be ≤ 20 lines added/changed per pattern. Bigger means you're rewriting, not improving.
- Add new instructions, examples, or guardrails — do not delete existing guardrails unless the lessons specifically show them causing harm.
- Be testable: a sub-agent reading the updated prompt should behave differently on the failing ticket class.
- Stay UNSLOP-clean — apply `UNSLOP.md` principles.

For each edit, write a short justification: which lessons motivated it, what the edit changes about agent behaviour, and how a future retrospective would notice it worked.

### 4. Apply edits and commit

```bash
git checkout -b meta-improve/$(date -u +%Y-%m-%d)
# (use Edit tool to apply the changes)
git add -A
git commit -m "Meta-improve: <one-line summary of the dominant pattern>"
```

Push the branch:

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
```

### 5. Write a META_IMPROVE_REPORT.md

In the branch root, write `META_IMPROVE_REPORT.md` with:

```md
# Meta-improvement report — <date>

## Window
<lessons.jsonl window covered, count of lessons read>

## Patterns identified
1. **<pattern label>** (<N> lessons; tags: <list>)
   - Root cause: <one line>
   - Lessons: <comma-separated ticket identifiers>
   - Proposed edit: <file>: <one-line description of what changed>
   - How this would have prevented the miss: <one sentence>

## Edits applied
| File | Lines | Pattern |
|---|---|---|
| prompts/X.md | +12 / -3 | <label> |

## Patterns observed but not acted on
- <pattern>: <why not — below threshold, no clear edit, etc.>

## Operator next steps
1. Review the diff: `git diff main...HEAD`
2. If you agree, open a PR.
3. After merge, the auto-update loop deploys the new prompts; check the next batch of retrospectives for the pattern label.
```

Stage and commit the report in the same branch.

## Rules

- **Human gate is not negotiable.** Your job ends at "branch pushed, report written". Do not open a PR. Do not merge. Do not edit `main` directly.
- **No new prompts.** Edit existing files only. Adding a new prompt is a larger architectural change that the operator should propose by hand.
- **No code changes.** If a lesson implies a TypeScript-level fix (e.g. orchestrator hook bug), record it in the report under "Operator next steps — engineering work" and do not edit `.ts` files.
- **Idempotent on dry runs.** If `--dry-run` is set in env (`SYMPHONY_META_DRY_RUN=1`), do not commit or push — just write `META_IMPROVE_REPORT.md` to `/tmp/` and report the path.

## Definition of Done

- [ ] Lessons read and patterns counted.
- [ ] Either: branch created with ≤ 3 narrow prompt edits + report, OR a clean exit with "no actionable patterns found".
- [ ] No PR created, no merge to main.
- [ ] No `.ts` files modified.
