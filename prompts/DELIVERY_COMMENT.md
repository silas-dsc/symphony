# Phase 5 — Delivery comment

When the Tester reports all scenarios pass and the PR is open with `pnpm typecheck && pnpm lint` green, post **exactly one** summary comment on the Linear issue, then flip the ticket to `In Review`. No further comments after this.

Reviewers should be able to evaluate the ticket from this comment alone in under 60 seconds. Anything that requires them to scroll up, expand the workpad, or open another tab is a failure of this comment.

## Template (verbatim structure)

```md
## ✅ Ready for review

**What changed**
- <one-line bullet per material user-facing change>
- <bullet>

**How to test**
1. <user action — concrete, paste-into-head executable>
2. <user action>
3. <expected observable result>

<embed the element-scoped screenshots from the Tester's QA results — one per scenario state. Caption each with the scenario name.>

---
PR: <PR URL>
Staging: <staging preview URL>
```

## Hard rules

- **20 lines max**, excluding the image markdown blocks.
- **No mentions of phases, sub-agents, workpad, or process scaffolding.** The reviewer doesn't care that the Architect ran first.
- **"What changed" is user-facing only.** Not "refactored helper". Not "improved type safety". If the user can't see it, it doesn't belong here.
- **"How to test" is 3–6 numbered steps.** A reviewer should be able to execute the test in under 60 seconds. If the test is longer than that, the ticket is too big — flag it in a workpad note rather than expanding the comment.
- **Screenshots are element-scoped** (already enforced in Phase 4 — do not re-screenshot).
- **Links live at the bottom.** Nothing below the links.
- **No emoji** other than the single ✅ in the heading.

## How to find the staging URL

The PR comment from the preview deployment service contains it. Look for a comment matching the pattern in `WORKFLOW.md` → `github_preview.comment_pattern`. If none yet, the preview is still building — wait up to 5 minutes, then proceed with the PR URL only and add a one-line `Staging: building…` placeholder. The orchestrator will keep the preview warm once it appears.

## Collapse the workpad

Before flipping, edit the `## AI Workpad` comment so its body is wrapped in:

```md
<details>
<summary>AI Workpad — internal notes</summary>

(existing workpad body)

</details>
```

This makes the Delivery comment the first visible artefact when a reviewer opens the ticket.

## Flip the ticket

After the Delivery comment is posted and the workpad is collapsed:

```bash
# Move issue to In Review using the Linear state ID for the team
python3 - <<'PY'
import json, os, subprocess
api = os.environ["LINEAR_API_KEY"]
issue_uuid = os.environ["ISSUE_UUID"]
# Resolve In Review state id for the issue's team
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

- [ ] Single `## ✅ Ready for review` comment posted.
- [ ] Comment body ≤ 20 lines (excluding image markdown).
- [ ] PR URL present.
- [ ] Staging URL present (or `building…` placeholder, only if the preview comment hasn't appeared after a 5-minute wait).
- [ ] Element-scoped screenshots embedded.
- [ ] `## AI Workpad` comment wrapped in `<details>`.
- [ ] Linear issue state = `In Review`.
