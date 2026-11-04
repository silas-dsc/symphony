# Running Symphony v2

v2 runs inside the normal Symphony process on your Mac. Nothing new to host: Slack buttons use **Socket Mode**
(an outbound connection), and Linear replies are read by polling. Everything is off until `v2.enabled: true`.

## 1. One-time setup (~15 min)

**Slack app** (api.slack.com/apps → your Symphony bot app):
1. *Socket Mode* → **On**. Create an app-level token with scope `connections:write` → this is `SLACK_APP_TOKEN` (`xapp-…`).
2. *Interactivity & Shortcuts* → **On** (no request URL needed with Socket Mode).
3. *OAuth & Permissions* → bot scopes: `chat:write`, `im:write`, `channels:history` (plus `groups:history` for
   private channels). Reinstall the app. The bot token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Invite the bot to `#dsc-website` (`/invite @<bot>`), needed for Slack intake and posting the daily update.

**Linear:** make sure the states `In Review`, `Dev in Progress`, `Triage`, `Duplicate` exist (they do in TEA).
Create a saved view per person: *Label is `waiting-on:silas`* (and `waiting-on:nika`, `waiting-on:evie`) —
that's each person's queue.

**GitHub review (team-dsc repo):**
```bash
claude setup-token
```
Add the printed token as repo secret `CLAUDE_CODE_OAUTH_TOKEN` in `team-dsc/team-dsc`, then copy
`templates/github/claude-review.yml` to `team-dsc/.github/workflows/claude-review.yml` and merge it.

**`.env`** in the Symphony folder (next to WORKFLOW.md):
```
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
# Optional — Render error intake + deploy guard:
RENDER_API_KEY=rnd_…
RENDER_OWNER_ID=tea-…
RENDER_SERVICE_IDS=srv-…,srv-…
```
`gh` must be logged in as an account that can merge in `team-dsc/team-dsc` (it already is for Symphony today).

## 2. Turn it on

In `WORKFLOW.md` set `v2.enabled: true`, then restart:
```bash
npm run build && npm run start:watch
```
Check it's alive: `curl -s localhost:7777/status | jq .v2` → shows pace, open cards, auto-deploy on/off.
The local board is at `http://127.0.0.1:7777/board`.

Start with the defaults (review flow, asks, deploy guard, governor, reports on; triage and intakes off). After a
day or two of sensible cards, turn on `v2.triage.enabled`, then `v2.slack_intake.enabled`, then `v2.render_logs.enabled`.

## 3. Day to day

| You get | Where | One tap |
|---|---|---|
| Code review / visual sign-off | Slack DM + Linear comment | **Merge** / **Looks good** / **Send back** (or **Ask Nika**) |
| Agent question | Slack DM | one button per option |
| Triage decision | Slack DM | **Confirm** / **Not a bug** |
| New errors after a merge | Slack DM | **Merge revert** / **Keep** |
| Daily update draft (4pm weekdays) | Slack DM | **Post to #dsc-website** / **Skip** |
| Roadmap report (Mon 9am) | Slack DM | **Post** / **Skip** |

No Slack? Reply on the Linear ticket: `merge`, `looks good`, `send back: <what to change>`, `ask nika`.
"Send back" notes become the agent's `## Fix` brief automatically.

**Kill switch for auto-merge:** `touch .symphony-autodeploy-off` (remove the file to turn it back on).
**Stages off** (plain single agent, e.g. if something misbehaves): `SYMPHONY_STAGES=off` in `.env`.

## 4. After a week

```bash
npm run runs -- --days 7
```
Read the weekly total (API-equivalent $). Set `v2.governor.weekly_budget_usd` to what a normal week costs plus
headroom, so the 20%/day ceiling and 20% weekly reserve kick in. Until then the governor paces on your card
queue and Claude's own rate-limit signals only.

## What runs where

| Piece | When | Tokens |
|---|---|---|
| Build agent + PLAN/VERIFY/REVIEW subagents + Stop hook | per ticket | yes (Claude subscription) |
| Review flow, asks, deploy guard, governor | every poll tick | none |
| Triage, Slack/Render intake | every 4h / 30 min / 6h | none (rules only) |
| Daily / weekly reports | 4pm weekdays / Mon 9am | none (Linear data only) |
| PR review (GitHub Action) | every PR | yes (subscription via OAuth token) |
