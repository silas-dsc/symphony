# Running Symphony v2

v2 runs inside the normal Symphony process on your Mac. Nothing new to host: Slack buttons use **Socket Mode**
(an outbound connection), and Linear replies are read by polling. Everything is off until `v2.enabled: true`.

## 1. One-time setup (~15 min)

**Slack app** (api.slack.com/apps → your Symphony bot app):
1. *Socket Mode* → **On**. Create an app-level token with scope `connections:write` → this is `SLACK_APP_TOKEN` (`xapp-…`).
2. *Interactivity & Shortcuts* → **On** (no request URL needed with Socket Mode).
3. *OAuth & Permissions* → bot scopes: `chat:write`, `im:write`, `channels:history` (plus `groups:history` for
   private channels). Reinstall the app. The bot token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Invite the bot to the report channel (`v2.slack.report_channel`, currently #dsc-website-notifs) and to any Slack intake channel.

**Linear:** make sure the states `In Review`, `Dev in Progress`, `Triage`, `Duplicate` exist (they do in TEA).
Create a saved view per person: *Label is `waiting-on:silas`* (and `waiting-on:nika`, `waiting-on:evie`) —
that's each person's queue.

**PR review:** Symphony reviews every new commit on open team-dsc PRs itself, on this Mac, by running
Claude Code's `/code-review high --fix` (see `v2.pr_review` in WORKFLOW.md). It uses your local `gh`
and git credentials and your Claude login; no GitHub Action or repo secret is needed.

**Self-improvement** (`v2.improve`): Symphony spends no tokens on it. It writes
`.symphony-state/improve-brief.md` (run metrics, alerts, Done tickets still needing a lesson with their
run history, and how earlier process changes scored), holds tickets that fail 3 runs in a row (label
`symphony-hold` + ⏸️ Resume card; removing the label also resumes), DMs costly tickets and failure
spikes, and posts a 🛠️ Merge card for every open `improve/*` PR. The thinking runs as the Claude desktop
Scheduled task **Symphony daily improvement** (`prompts/DAILY_IMPROVE.md`, 5pm): it writes the queued
lessons in one batch, opens an `improve/<date>` PR with up to 3 prompt/workflow edits, and files up to 2
team-dsc tickets. Nothing merges until you click Merge; merged changes are scored two days later.

**Token use:** routine runs (retros in `per_ticket` mode, merge-conflict resolution) use Sonnet 5.5 at low
effort (`CLAUDE_ROUTINE_MODEL` / `CLAUDE_ROUTINE_EFFORT`). PR review runs at `medium`, once a PR is ready
and again only after a push of 150+ changed lines. Rework runs stop at `agent.max_turns_rework` (25).

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
| PR review (local `/code-review medium --fix`) | PR ready + pushes of 150+ lines | yes |
| Daily improvement pass (desktop Scheduled task) | 5pm daily | yes (your desktop session) |
| Loop and cost detectors | every 5 min | none (run log only) |
