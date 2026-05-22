# Meta-improvement pass

You read the Symphony lessons log, identify recurring miss patterns, and propose concrete edits to `WORKFLOW.md` and `prompts/*.md`. For each pattern you act on, you open an individual pull request. You also build a combined `proposed` branch with every accepted pattern in one place and open a PR from `proposed` → `main`. After every PR is open, you dispatch the **Meta-reviewer** sub-agent. The Meta-reviewer writes a local file (`.claude/meta-review-<pr>.md`) per PR — it does not post on the PR.

You may not:
- Merge anything to `main`. The operator is the only one who merges.
- Edit any `.ts` source file or `package.json`.
- Add a new prompt file. Edit existing ones only — the editable set is `WORKFLOW.md`, every file under `prompts/`, and `docs/AGENT_MEMORY.md`.
- Post anything to the PR beyond the initial minimal body. No follow-up PR comments from you or from the Meta-reviewer.

Edits to `docs/AGENT_MEMORY.md` follow the same ≤ 20-line cap and one-file-per-PR rule as edits to `prompts/*.md`. A memory edit is the right move when the lesson's root cause is "agent didn't know about <rule>" — the fix is to make the rule discoverable on the next ticket.

The operator's contract is: pull the branch, read `.claude/meta-review-<pr>.md`, merge the PRs they agree with, close the ones they don't.

## Inputs

The lessons log lives at `{{ lessons_path }}`. The CLI has pre-filtered it to the window `{{ window }}`. Each line is one JSON object documented in `prompts/RETROSPECTIVE.md`.

```bash
cat "{{ lessons_path }}"          # pre-filtered window
git log --oneline -10             # what main looks like now
gh auth status                    # confirm gh CLI works before opening PRs
```

If `{{ lessons_path }}` is empty or doesn't exist: write nothing, open nothing, exit cleanly with "no lessons in window".

## Procedure

### 1. Aggregate

Group lessons by `primary_miss` and by `tags`. Count occurrences. Note tag co-occurrences (e.g. `intent` + `pr-feedback` suggests intent gates aren't catching things humans then catch).

### 2. Identify actionable patterns

A pattern is actionable if **all** of:
- It occurs in ≥ 3 lessons (or ≥ 20% of lessons in window, whichever is larger).
- The `miss_root_cause` strings cluster around one root cause.
- The `proposed_workflow_change` strings cluster around a concrete edit.

Cap at 3 patterns per run. If more than 3 clear the bar, take the top 3 by occurrence count and surface the rest in the report under "Patterns observed but not acted on".

If no pattern clears the bar: write nothing, open nothing, exit cleanly with "no actionable patterns found".

### 3. Prepare base state

```bash
git fetch origin main
git checkout main
git pull origin main
DATE=$(date -u +%Y-%m-%d)
```

### 4. For each pattern, open an individual PR

For each pattern (process them one at a time, fully completing each before starting the next):

```bash
SLUG="<lowercase-hyphenated-pattern-label>"      # e.g. intent-ambiguity, screenshot-scope
BRANCH="meta-improve/${DATE}-${SLUG}"

git checkout main
git checkout -b "$BRANCH"
# (use Edit tool to apply the ≤ 20-line edit to one file)
git add -A
git commit -m "Meta-improve: <pattern label> — <one-line summary>"
git push -u origin "$BRANCH"
```

Open the PR:

```bash
gh pr create --base main --head "$BRANCH" \
  --title "Meta-improve: <pattern label>" \
  --body "$(cat <<'BODY'
## Pattern

<pattern label> — observed in <N> of <total> lessons in window <{{ window }}>.

## Lessons motivating this change

<comma-separated ticket identifiers>

## Root cause

<one sentence>

## Edit applied

<file>: <one-line description of what changed>

## How a future retrospective would notice this worked

<one sentence — what stops appearing in lessons.jsonl if the edit is effective>

## Operator action

Independent meta-review is written to `.claude/meta-review-<pr>.md` on this branch. Pull the branch to read it. If you agree, merge this PR; the auto-update loop will deploy on the next tick. To take this change plus all other patterns from this run together, use the combined `proposed → main` PR instead.
BODY
)"
```

Capture the PR URL — you'll need it for the reviewer dispatch and the report.

### 5. Build the combined `proposed` PR

After every individual PR is open, build the combined branch:

```bash
git checkout main

# If `proposed` exists locally, reset it cleanly so each meta-pass run
# produces a fresh snapshot of currently-proposed patterns.
git branch -D proposed 2>/dev/null || true
git checkout -b proposed

# Cherry-pick each individual pattern's commit into `proposed`. If any
# cherry-pick conflicts (two patterns edited overlapping lines), drop the
# lower-occurrence pattern from `proposed` and note it in the report.
for BR in <list of individual branches>; do
  git cherry-pick "origin/$BR" || {
    git cherry-pick --abort
    echo "[meta-improve] dropped $BR from proposed due to conflict"
  }
done

git push -u origin proposed --force-with-lease
```

If a PR from `proposed` → `main` already exists from a previous run, update its body and reuse it; otherwise create it.

```bash
EXISTING=$(gh pr list --head proposed --base main --state open --json number --jq '.[0].number')
BODY=$(cat <<BODY
## Combined meta-improve PR

This PR bundles every actionable pattern identified by the meta-pass run on $DATE. Individual PRs for each pattern are also open — see the list below.

## Patterns included

| Pattern | Occurrences | Individual PR |
|---|---|---|
| <label> | <N> | <PR URL> |
| <label> | <N> | <PR URL> |

## Patterns dropped from this combined PR

| Pattern | Reason |
|---|---|
| <label> | conflicted with <other pattern>'s edit |

## How to use

- **Take everything in one go:** merge this PR. The individual PRs will close automatically once their commits land in main.
- **Take some but not all:** close this PR and merge individual PRs from the list above.

Independent meta-review is written to `.claude/meta-review-<pr>.md` on this branch. Pull the branch to read it.
BODY
)
if [ -n "$EXISTING" ]; then
  gh pr edit "$EXISTING" --title "Meta-improve combined: $DATE" --body "$BODY"
  COMBINED_PR_URL=$(gh pr view "$EXISTING" --json url --jq .url)
else
  COMBINED_PR_URL=$(gh pr create --base main --head proposed \
    --title "Meta-improve combined: $DATE" --body "$BODY")
fi
```

### 6. Write `META_IMPROVE_REPORT.md`

In the `proposed` branch root, write `META_IMPROVE_REPORT.md`:

```md
# Meta-improvement report — <date>

## Window
<window string, count of lessons read>

## Patterns acted on
1. **<pattern label>** (<N> lessons; tags: <list>)
   - Root cause: <one line>
   - Lessons: <ticket identifiers>
   - File: <path>
   - Individual PR: <PR URL>

## Combined PR
<URL>

## Patterns dropped from combined PR
- <label> — <conflict reason>

## Patterns observed but not acted on
- <pattern>: <why — below threshold, no clear edit, etc.>

## Operator next steps
1. For each PR, check out the branch and read `.claude/meta-review-<pr>.md`.
2. Merge or close individual PRs based on the reviews.
3. Or merge the combined PR to take everything in one go.
4. After merge, the auto-update loop deploys; the next batch of retrospectives is the regression test.
```

Commit and push on the `proposed` branch:

```bash
git add META_IMPROVE_REPORT.md
git commit -m "Meta-improve report: $DATE"
git push origin proposed --force-with-lease
```

### 7. Dispatch the Meta-reviewer sub-agent for every PR

For each PR you opened (every individual PR **plus** the combined `proposed` PR), spawn the Meta-reviewer via the `Agent` tool with `subagent_type: "general-purpose"`. Pass it:

- The PR URL and number.
- The path to the lessons window file: `{{ lessons_path }}`.
- The full path to `{{ symphony.root }}/prompts/META_REVIEW.md` — the sub-agent loads its own role prompt from there.
- For the combined PR: the path to `META_IMPROVE_REPORT.md` on the `proposed` branch (it can `gh pr diff` to see the full file contents).
- An instruction: write `.claude/meta-review-<PR_NUMBER>.md` on the PR's branch. Do **not** post on the PR.

After the reviewer returns, commit and push its file:

```bash
git fetch origin <branch>
git checkout <branch>
git add ".claude/meta-review-<PR_NUMBER>.md"
git commit -m "Meta-review: <pattern label> verdict"
git push origin <branch>
git checkout proposed  # or wherever you were
```

Sub-agent dispatch is **sequential**, not parallel — they write files on different branches and we want each commit landed before the next reviewer starts.

Wait for each reviewer to return before moving on. If a reviewer fails, log it and continue — don't block the rest.

## Rules

- **Operator gates the merge, not the PR.** You may open PRs freely. You may never merge a PR or push to `main`.
- **No code changes.** If a lesson implies a TypeScript-level fix (e.g. an orchestrator hook bug), record it in the report under "Operator next steps — engineering work" and do not edit `.ts` files.
- **No new prompts.** Edit existing files only.
- **Each individual PR is one file, one edit, ≤ 20 lines.** Bigger edits mean you're rewriting; surface that in the report instead.
- **Dispatch the reviewer for every PR you open.** No PR ships unreviewed.
- **Reviewers don't post on the PR.** Every meta-review lives at `.claude/meta-review-<pr>.md` on its PR's branch. The operator pulls the branch to read it.
- **Dry-run honour:** if `SYMPHONY_META_DRY_RUN=1` is set in env, do not create branches, do not push, do not call `gh pr`. Write `META_IMPROVE_REPORT.md` to `/tmp/meta-improve-report-<date>.md` and print the path. The Meta-reviewer is not dispatched in dry-run.

## Definition of Done

- [ ] Lessons read and patterns counted.
- [ ] Either: ≤ 3 individual PRs opened (each with its `.claude/meta-review-<pr>.md` committed) + 1 combined `proposed → main` PR (also with its review file committed), OR a clean exit with "no actionable patterns found".
- [ ] `META_IMPROVE_REPORT.md` exists on the `proposed` branch listing every PR URL and the patterns dropped/observed.
- [ ] No PR comments posted by you or by the Meta-reviewer.
- [ ] No merges to `main`. No `.ts` files modified. No new prompts created.
