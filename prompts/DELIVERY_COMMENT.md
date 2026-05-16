# Phase 5 — Delivery comment

When the Tester reports all scenarios pass, the Code Reviewer's local report has verdict `approve`, and `pnpm typecheck && pnpm lint` are green, post **exactly one** comment on the Linear issue and use the **same body** as the PR body. Then flip the ticket to `In Review`. No further comments after this.

A reviewer must be able to evaluate the change from this comment alone in under 30 seconds. Anything that requires them to scroll, expand, or open another tab is a failure of this comment.

## The only template

Both the Linear delivery comment and the GitHub PR body use this body **verbatim** — same words, same shape, same length.

```md
## ✅ Ready for review

<one-sentence high-level summary of the user-visible change>

- <callout 1 — one short sentence>
- <callout 2 — one short sentence>
- <callout 3 — one short sentence>

![<short caption>](<asset URL of the single primary screenshot>)

PR: <github PR URL>
Preview: <render preview URL>
Linear: <linear issue URL>
```

## Hard rules

- **One sentence summary, three callouts, one screenshot, three links. Nothing else.** No "What changed", "How to test", "Notes", "Risk", phase mentions, sub-agent mentions, workpad references, or process scaffolding. Reviewers do not care.
- **Three callouts, three short sentences max.** Each bullet is one short sentence about something the reviewer needs to know — user-visible behaviour change, a follow-up flagged, a deliberate trade-off. Fewer than three is fine if there is genuinely less to say; never more than three.
- **One screenshot.** Pick the single image that best represents the change — almost always the success state of the primary changed section. Multi-state scenarios (loading / empty / error) live in `.claude/qa-results.md` for whoever wants to look; not here.
- **Three links at the bottom, in this order: PR, Preview, Linear.** Nothing below them. If the preview comment hasn't appeared after a 5-minute wait, write `Preview: building…` and proceed.
- **No emoji** other than the `✅` in the heading.
- **No back-and-forth.** Every agent-to-agent artefact (intent brief, plan, test matrix, QA results, code review findings, workpad notes) stays in `.claude/` in the workspace. The only public surfaces are this comment and the matching PR body.

## How to assemble the body

1. Read `.claude/qa-results.md` — pick the primary scenario (the one that most directly demonstrates the change) and the single screenshot file that best represents its success state.
2. Upload that screenshot to Linear via `{{ symphony.root }}/docs/LINEAR_UPLOAD.md` and capture the asset URL.
3. Write the one-sentence summary from the user's perspective. Not "refactored helper", not "improved type safety". What does the user see that they couldn't before?
4. Pick the top three callouts. Skip anything the reviewer can read off the diff. Prefer: a deliberate trade-off, a follow-up filed, an edge-case behaviour they should know about, a non-obvious cross-cutting change.
5. Render the template once. Post it as the Linear comment **and** as the PR body (`gh pr edit <PR_URL> --body "$BODY"`). Do not re-word between them.

## Finding the preview URL

The render preview deployment service posts a comment on the PR matching the pattern in `WORKFLOW.md` → `github_preview.comment_pattern`. If none exists yet, wait up to 5 minutes. Beyond that, use `Preview: building…` and ship — the orchestrator keeps the preview warm once it appears.

## Flip the ticket

After posting the comment and updating the PR body:

```bash
python3 - <<'PY'
import json, os, subprocess
api = os.environ["LINEAR_API_KEY"]
issue_uuid = os.environ["ISSUE_UUID"]
q = {"query":"query($id:String!){issue(id:$id){team{states{nodes{id name}}}}}","variables":{"id":issue_uuid}}
r = subprocess.run(["curl","-s","-X","POST","https://api.linear.app/graphql",
                    "-H",f"Authorization: {api}","-H","Content-Type: application/json",
                    "-d",json.dumps(q)], capture_output=True, text=True)
states = json.loads(r.stdout)["data"]["issue"]["team"]["states"]["nodes"]
state_id = next(s["id"] for s in states if s["name"] == "In Review")
m = {"query":"mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}",
     "variables":{"id":issue_uuid,"s":state_id}}
print(subprocess.run(["curl","-s","-X","POST","https://api.linear.app/graphql",
                      "-H",f"Authorization: {api}","-H","Content-Type: application/json",
                      "-d",json.dumps(m)], capture_output=True, text=True).stdout)
PY
```

## Definition of Done

- [ ] Exactly one `## ✅ Ready for review` comment on Linear.
- [ ] PR body matches that comment byte-for-byte.
- [ ] Body contains: one summary sentence, three callouts, one screenshot, three links — and nothing else.
- [ ] PR / Preview / Linear URLs all present (or `Preview: building…` if waited 5 minutes).
- [ ] Linear issue state = `In Review`.
- [ ] No other Linear comments or PR comments were posted by this phase.
