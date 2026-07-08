# Phase 1B — Ticket refinement

Runs **after** the Intent Analyst sub-agent (Phase 1A) has written `.claude/intent.md`. You use the Intent Brief as your source of truth for Who/Wants/So that — do not re-derive it.

Your output: a refined description on the Linear ticket with explicit Context, Acceptance Criteria, Technical Approach, Test Plan, and Out of Scope — **appended above the user's original request, which stays verbatim in the description**. You never overwrite the user's words.

The refined description is the only thing you write to Linear. You do not post comments.

## Append, don't rewrite — the source-of-truth rule

The single largest recurring failure in this workflow was the front-end (Intent → Refiner) silently reframing the ask, so every downstream phase built against a drifted spec (bulk-vs-single, automation scoped out, design ticket coded as a build, silent-vs-loud failure, …). The fix is structural:

- Your refined structure goes **on top**. The user's original request is reproduced **verbatim** at the bottom under `## Original request`, unedited.
- The verbatim original is the **source of truth**. Your Context/AC/Technical Approach are a *derived reading* of it. Downstream agents (Architect, Developer, Tester) are told: if a refined AC conflicts with the original wording, the original wins.
- Treat your refinement as a hypothesis about intent, not a replacement for it. When you're inferring rather than restating, that inference belongs in `.claude/intent.md` Ambiguities — not silently baked into an AC that erases the original phrasing.

## Idempotency

You may be invoked multiple times on the same ticket (retries). Before doing anything, check for `.claude/original-description.md`. If it exists, refinement has already been performed — verify the current Linear description has the refined structure (Context / AC / Technical Approach / Test Plan), and if so skip to Phase 2.

## Steps

### 0. Figma artefacts

The parent agent dispatches the Figma BA sub-agent before you if the ticket has a `figma.com/design/...` URL. Look for `.symphony-figma/tech-spec.md` in the workspace. If present, its Files / Routes / Shared components / Data flow / Design system deltas sections become the substance of your Technical Approach, and the per-screen `.md` files supply AC for the Test Plan. Also read `.symphony-figma/gaps.md`: surface its headline improvements and any "needs a decision" items in the refined description (a short "Decisions for sign-off" subsection) so a human can sign off before Phase 3 builds on them. Figma BA artefacts live in the workspace only — never posted to Linear or the PR.

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

### Functional test plan
Terse, numbered, click-by-click steps a human (or the Tester) follows to prove each AC by hand. One block per AC. State the exact role, route, element, input, expected result, and any log line to check.

- **AC1 — <outcome>** (role: super-admin)
  1. Log in as super-admin; go to `/admin/users`.
  2. Click **Invite**; type `x@y.com` into the Email field; click **Send**.
  3. See: toast "Invite sent to x@y.com"; new row in the invites table, status "Pending".
  4. Logs: server log shows `invite.created email=x@y.com`; no `ERROR` lines.
- **AC2 — empty email rejected** (role: super-admin)
  1. Repeat steps 1–2 with the Email field blank; click **Send**.
  2. See: inline error "Email is required" under the field; no toast; invites table unchanged.

### Automated coverage
- **Unit/integration tests** to add or update: `<test file paths>`
- **Mobile UX checks**: `<pages to verify at 375px>`
- **Regression risks**: <areas to re-verify because they share code>

## Out of Scope
- <Items deferred to follow-up backlog tickets — be explicit about what is NOT being done>

---
## Original request
_Verbatim, unedited. This is the source of truth. If any Acceptance Criterion above conflicts with the wording here, the original wins — flag the conflict in `.claude/intent.md` Ambiguities._

> <the raw pre-refinement description, reproduced exactly — every line prefixed with `> `>
```

The `## Original request` block is **mandatory** and must reproduce `.claude/original-description.md` byte-for-byte (blockquoted). Do not summarise, tidy, or "clarify" it — that defeats the purpose.

**Functional test plan rules** (the dot-point steps above):
- One block per AC, headed `**AC<n> — <outcome>** (role: <super-admin / admin / learner>)`.
- Steps are **user actions only** — "Click **Save**", "type `…`", "toggle X off". Never "POST /api/…" or "set state". The reader does not know the implementation.
- Every block ends with a **See:** line stating what a human observes — exact toast text, route change, visible element, empty/filled state.
- Add a **Logs:** line whenever the AC has a server-side or async effect: the literal log line to grep for, and "no `ERROR` lines". Omit it for pure-UI changes.
- Name exact routes, element labels, and input values. "Click the button" / "check it works" are not steps.
- Keep it terse: short imperative sentences, no filler. 2–5 steps per block is typical.
- Cover the happy path plus one error/edge block per AC that implies a failure mode.

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

**Then update the Linear description** — your refined sections on top, the verbatim original blockquoted below. The write composes the two so the user's words are never lost:
```bash
python3 <<'PY'
import json, os, subprocess, pathlib
api_key  = os.environ["LINEAR_API_KEY"]
uuid     = os.environ["ISSUE_UUID"]
# Your refined sections (Context / AC / Technical Approach / Test Plan / Out of Scope)
# WITHOUT the "## Original request" block — that is appended here from the saved raw body.
refined  = pathlib.Path("/tmp/refined.md").read_text().rstrip()
original = pathlib.Path(".claude/original-description.md").read_text().strip()
# Blockquote the original verbatim — every line prefixed with "> ", blanks preserved.
quoted   = "\n".join(("> " + ln) if ln.strip() else ">" for ln in original.splitlines())
composite = (
    refined
    + "\n\n---\n## Original request\n"
    + "_Verbatim, unedited. Source of truth — if a refined AC conflicts with the wording "
      "here, the original wins._\n\n"
    + quoted + "\n"
)
q = {"query":"mutation($id:String!,$desc:String!){issueUpdate(id:$id,input:{description:$desc}){success}}",
     "variables":{"id":uuid,"desc":composite}}
r = subprocess.run(["curl","-s","-X","POST","https://api.linear.app/graphql",
                    "-H",f"Authorization: {api_key}","-H","Content-Type: application/json",
                    "-d",json.dumps(q)], capture_output=True, text=True)
print(r.stdout)
PY
```

`/tmp/refined.md` holds only your derived sections; the script appends the `## Original request` block from `.claude/original-description.md`, so the original can never be paraphrased away by accident.

## Definition of Done

All of the following must be true before moving to Phase 2:

- [ ] `.claude/intent.md` exists (produced by Phase 1A) and the refined description is consistent with it.
- [ ] `.claude/original-description.md` exists with the raw pre-refinement body.
- [ ] The Linear issue description now leads with the refined version and ends with a verbatim `## Original request` blockquote (or the whole rewrite was skipped because the ask already met the bar — noted in `.claude/workpad.md`; even then, ensure `## Original request` is present).
- [ ] The `## Original request` block reproduces `.claude/original-description.md` byte-for-byte (blockquoted, not summarised).
- [ ] The refined description contains all five sections: Context, Acceptance Criteria, Technical Approach, Test Plan, Out of Scope.
- [ ] The Test Plan opens with a **Functional test plan**: one terse, numbered click-by-click block per AC, each with a **See:** line and a **Logs:** line where the AC has a server-side or async effect.
- [ ] UNSLOP applied: no MECE overlaps, no DRY violations, no filler.
- [ ] CLEAR_WRITING applied: active voice, sentences ≤ 25 words, plain words from the substitution table, acronyms spelled out on first use.
- [ ] **No Linear comments were posted by this phase.** The only thing this phase writes to Linear is the description itself.
