# Phase 1B — Ticket refinement

Runs **after** the Intent Analyst sub-agent (Phase 1A) has written `.claude/intent.md`. You use the Intent Brief as your source of truth for Who/Wants/So that — do not re-derive it.

Your output: a refined description on the Linear ticket with explicit Context, Acceptance Criteria, Technical Approach, Test Plan, and Out of Scope. The original description is preserved in a local file (`.claude/original-description.md`), not as a Linear comment.

The refined description is the only thing you write to Linear. You do not post comments.

## Idempotency

You may be invoked multiple times on the same ticket (retries). Before doing anything, check for `.claude/original-description.md`. If it exists, refinement has already been performed — verify the current Linear description has the refined structure (Context / AC / Technical Approach / Test Plan), and if so skip to Phase 2.

## Steps

### 0. Figma artefacts

The parent agent dispatches the Figma Intake sub-agent before you if the ticket has a `figma.com/design/...` URL. Look for `.symphony-figma/tech-spec.md` in the workspace. If present, its Files / Routes / Shared components / Data flow sections become the substance of your Technical Approach, and the per-screen `.md` files supply AC for the Test Plan. Figma intake artefacts live in the workspace only — never posted to Linear or the PR.

If there's no `.symphony-figma/` directory, the ticket has no design — proceed with the codebase-only investigation below.

### 1. Read the Intent Brief and the current description
- Open `.claude/intent.md`. Its Who/Wants/So that is the canonical statement of intent — your refined description must remain consistent with it.
- Read the current Linear description critically against the Intent Brief. Identify gaps: missing repro steps, unstated acceptance criteria, ambiguous scope, no test plan, vague success metric.
- If the description is already implementation-ready, consistent with the Intent Brief, and passes UNSLOP + CLEAR_WRITING — note that in `.claude/workpad.md` and skip the rewrite.

### 2. Investigate the codebase to fill gaps
- Locate the routes, components, functions, and types the change touches.
- Trace dependent code paths.
- Read existing tests to understand current behaviour.
- Note constraints from types, schemas, or Firestore rules.

### 3. Draft the refined description

Use this exact structure:

```md
## Context
<1–3 sentences: what the user/system needs and why this ticket exists>

## Acceptance Criteria
- [ ] Specific, testable outcome
- [ ] Specific, testable outcome
- [ ] Edge case handled
- [ ] Error state handled

## Technical Approach
- Files to change: `<path>`, `<path>`
- New functions/components: `<name>` in `<path>`
- Data flow: <one-line summary>
- Edge cases: <list>
- Dependencies / migrations: <list or "none">

## Test Plan
- **Unit/integration tests** to add or update: `<test file paths>`
- **Manual checks**: `<routes>` as `<role>` (super-admin / admin / learner)
- **Mobile UX checks**: `<pages to verify at 375px>`
- **Regression risks**: <areas to re-verify because they share code>

## Out of Scope
- <Items deferred to follow-up backlog tickets — be explicit about what is NOT being done>
```

### 4. Run the refined description through UNSLOP and CLEAR_WRITING
Open `{{ symphony.root }}/UNSLOP.md` and apply its three principles (MECE, DRY, simple-but-not-shorthand) to your draft. Cut filler. Merge overlapping bullets. Don't cut concrete details (file paths, role names, specific routes).

Then open `{{ symphony.root }}/prompts/CLEAR_WRITING.md` and apply its sentence- and word-level rules: average ≤ 15 words per sentence, active voice, no jargon or filler ("in order to", "at this point in time", "there is/are"), spelled-out acronyms on first use, second person where it suits.

### 5. Preserve the original locally, then update the description

**Get the issue UUID** (Linear's internal ID — not `{{ issue.identifier }}`):
```bash
ISSUE_UUID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issue(id:\"{{ issue.identifier }}\") { id description } }"}' \
  | jq -r '.data.issue.id')
```

**Save the original description to `.claude/original-description.md` first** (non-destructive — must succeed before mutating the description):
```bash
mkdir -p .claude
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ issue(id:\\\"{{ issue.identifier }}\\\") { description } }\"}" \
  | jq -r '.data.issue.description' > .claude/original-description.md
```

**Then update the Linear description** with your refined version:
```bash
python3 <<'PY'
import json, os, subprocess, pathlib
api_key = os.environ["LINEAR_API_KEY"]
uuid    = os.environ["ISSUE_UUID"]
refined = pathlib.Path("/tmp/refined.md").read_text()
q = {"query":"mutation($id:String!,$desc:String!){issueUpdate(id:$id,input:{description:$desc}){success}}",
     "variables":{"id":uuid,"desc":refined}}
r = subprocess.run(["curl","-s","-X","POST","https://api.linear.app/graphql",
                    "-H",f"Authorization: {api_key}","-H","Content-Type: application/json",
                    "-d",json.dumps(q)], capture_output=True, text=True)
print(r.stdout)
PY
```

## Definition of Done

All of the following must be true before moving to Phase 2:

- [ ] `.claude/intent.md` exists (produced by Phase 1A) and the refined description is consistent with it.
- [ ] `.claude/original-description.md` exists with the raw pre-refinement body.
- [ ] The Linear issue description has been replaced with the refined version (or skipped because it already met the bar — noted in `.claude/workpad.md`).
- [ ] The refined description contains all five sections: Context, Acceptance Criteria, Technical Approach, Test Plan, Out of Scope.
- [ ] UNSLOP applied: no MECE overlaps, no DRY violations, no filler.
- [ ] CLEAR_WRITING applied: active voice, sentences ≤ 25 words, plain words from the substitution table, acronyms spelled out on first use.
- [ ] **No Linear comments were posted by this phase.** The only thing this phase writes to Linear is the description itself.
