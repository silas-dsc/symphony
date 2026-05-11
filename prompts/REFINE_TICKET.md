# Phase 1 — Ticket refinement

You run this **before any branch is created or any code is written**. The goal: turn the raw ticket into an implementation-ready spec with explicit acceptance criteria, technical approach, and test plan. Skipping this phase is the single biggest cause of off-target PRs.

## Idempotency

You may be invoked multiple times on the same ticket (retries). Before doing anything, check for an existing Linear comment whose body starts with `## Original ticket description (preserved)`. If it exists, refinement has already been performed — verify the current description has the refined structure (Context / AC / Technical Approach / Test Plan), and if so skip to Phase 2.

## Steps

### 0. Figma URL detection

If the ticket description contains a `figma.com/design/...` URL, **stop and run `{{ symphony.root }}/prompts/FIGMA_INTAKE.md` end-to-end first**. Its outputs (Technical Approach, Test Plan, per-screen ACs, tech spec) become the substance of the refined description below — you'll fill in Context and Out-of-Scope, but the implementation-relevant sections are produced by FIGMA_INTAKE.

If the ticket has multiple Figma URLs, run FIGMA_INTAKE once per URL into separate `.symphony-figma/<short-name>/` subdirectories and consolidate their tech specs into one Technical Approach section.

If the ticket has no Figma URL, continue with step 1 below as normal.

### 1. Read the current description critically
Identify gaps: missing repro steps, unstated acceptance criteria, ambiguous scope, no test plan, vague success metric. If the description is already implementation-ready and passes UNSLOP, record that in the workpad and skip the rewrite.

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

### 4. Run the refined description through UNSLOP
Open `{{ symphony.root }}/UNSLOP.md` and apply its three principles (MECE, DRY, simple-but-not-shorthand) to your draft. Cut filler. Merge overlapping bullets. Don't cut concrete details (file paths, role names, specific routes).

### 5. Preserve the original, then update the description

**Get the issue UUID** (Linear's internal ID — not `{{ issue.identifier }}`):
```bash
ISSUE_UUID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issue(id:\"{{ issue.identifier }}\") { id description } }"}' \
  | jq -r '.data.issue.id')
```

**Post the original description as a comment first** (non-destructive — must succeed before mutating the description):
```bash
ORIGINAL=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ issue(id:\\\"{{ issue.identifier }}\\\") { description } }\"}" \
  | jq -r '.data.issue.description')

# Write the preservation comment via a Python heredoc to avoid quoting hell
python3 <<'PY'
import json, os, subprocess
api_key = os.environ["LINEAR_API_KEY"]
uuid    = os.environ["ISSUE_UUID"]
body    = "## Original ticket description (preserved)\n\n" + os.environ["ORIGINAL"]
q = {"query":"mutation($body:String!,$issueId:String!){commentCreate(input:{body:$body,issueId:$issueId}){success comment{id url}}}",
     "variables":{"body":body,"issueId":uuid}}
r = subprocess.run(["curl","-s","-X","POST","https://api.linear.app/graphql",
                    "-H",f"Authorization: {api_key}","-H","Content-Type: application/json",
                    "-d",json.dumps(q)], capture_output=True, text=True)
print(r.stdout)
PY
```

**Then update the description** with your refined version (same Python pattern — write the refined markdown to a file and inject):
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

### 6. Link the preservation comment in the workpad
Record the URL of the original-description comment under the workpad's "Refined ticket" section.

## Definition of Done

All of the following must be true before moving to Phase 2:

- [ ] An `## Original ticket description (preserved)` comment exists on the Linear issue.
- [ ] The Linear issue description has been replaced with the refined version (or skipped because it already met the bar — recorded in workpad).
- [ ] The refined description contains all five sections: Context, Acceptance Criteria, Technical Approach, Test Plan, Out of Scope.
- [ ] UNSLOP applied: no MECE overlaps, no DRY violations, no filler.
- [ ] Workpad records the preservation comment URL.
