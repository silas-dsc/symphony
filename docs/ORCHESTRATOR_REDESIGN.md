# Symphony v2 — Orchestrator Redesign

Turn Symphony from "one agent per ticket, then you do the rest" into a system that does everything Claude can do
reliably, and sends each human decision **to the right person** as a one-click card. It paces itself to people's
capacity and to Claude's usage limits.

Grounded in: the current code, Linear (team `TEA`), GitHub (`team-dsc/team-dsc`), Slack (`#dsc-website`,
`#dsc-website-notifs`), and comparable systems (Copilot-for-Linear, Devin, Percy/Chromatic, router patterns).

*Rev 2 (2026-11-04): hosted control plane, gates routed to people, Linear/Slack as the queue, design export at
hand-off, checks on PR previews, 4 merged stages, diff-based risk, auto-deploy guardrails, Phase 0.*

---

## 1. Where Symphony is today

**Works well:** auto-files tickets from Dependabot, PostHog, Firebase logs, BigQuery, UX insights. One coding agent
per ticket opens a PR. Merge-conflict auto-fix. Lessons → meta-improve loop. Claude → Codex → Ollama failover.
88% of PRs merge, ~16 min median turnaround, CI almost always green. **Building is not the problem.**

**Where your day goes:**
| Gap | Today |
|---|---|
| No routing | Every ticket gets the same flat agent |
| 8 expert prompts orphaned | `INTENT, ARCHITECT, TESTER, CODE_REVIEW, VERIFY…` exist, wired nowhere |
| No triage | You triage and assign by hand |
| No automated review | Agent flips to `In Review`; Symphony drops it |
| Visual checks stop at the DB | "Not tested: signing in as a learner" — you log in and look |
| **You relay sign-offs** | You chase Nika (design) and Evie (product) in Linear threads |
| No pacing | Fixed 3 agents, regardless of how full your queue is |
| Laptop-only | Off when your Mac sleeps; can't receive Linear/Slack clicks |

---

## 2. Where things run

> **As built (2026-11-04):** no separate Render service was needed. Slack buttons use **Socket Mode** (outbound
> websocket, no public URL) and Linear decisions are read by polling, so gates, review flow, governor, triage,
> intake and reports all run inside the existing Symphony process; reports are deterministic (no tokens) rather
> than cloud routines. Only PR review runs elsewhere (GitHub Action). The table below is the original plan — still
> the path if the workers later move off the Mac. Setup: `docs/RUNNING_V2.md`.

Split by job. Only the part that needs your logins stays on your Mac.

| Part | Runs on | Why |
|---|---|---|
| **Control plane** — gate state, Linear/Slack webhooks, visual-diff board, governor, deploy guard | **Render** (small always-on service, existing account) | Always up, reachable from your phone, receives clicks. Almost no Claude calls → cheap |
| **Scheduled Claude jobs** — daily progress draft, weekly roadmap, triage pass, Slack/Render intake | **Claude Code scheduled cloud routines** | No infra, off your laptop |
| **PR review** | **GitHub Actions** (`claude-code-action`) | Reviews every PR, whoever opened it |
| **Build + visual verify workers** | **Your Mac now** → cloud later | Needs Claude login + gcloud. Moves to cloud once designs are exported (§6) and checks run on previews |

The Mac worker and the control plane talk over a small authenticated API: the worker opens gates; the control plane
records decisions and tells the worker what to do next.

*Remote Control lets you steer a local session from your phone, but it still runs on your Mac — so it doesn't solve
"always on".*

---

## 3. The flow

```
INTAKE ─▶ TRIAGE ─▶ ROUTE (labels) ─▶ PLAN? ─▶ BUILD ─▶ VERIFY ─▶ ROUTE (diff risk) ─▶ REVIEW ─▶ GATE ─▶ deploy ─▶ WATCH
                                                                                          │           │
                                          GOVERNOR paces dispatch to people's open gates ─┘           └─ auto-revert on new errors
                                          and Claude's usage limits
```

---

## 4. Intake

Keep the five existing watchers. Add, as **cloud routines**:
- **Slack** — reads `#dsc-website`, spots problem reports from Kristen, Jessica, Evie, Nika, Wei that don't already link
  a ticket, drafts one into **Triage**. Dedups against open tickets.
- **Render logs** — mirror of `firebase-logs.ts` (group by signature, drop infra noise).

Clean machine signals (Dependabot, logs, PostHog errors) go straight to the dev lane. Noisy human signals (Slack, UX
insights) go to **Triage**. Email: out of scope.

---

## 5. Triage

A routine 2–3×/day over `Triage`. Rules first, one small Claude call only for unclear tickets:
dedup, priority (customers affected, outage, revenue), labels, lane. The ~10–15% that stay unclear become a
*Triage decision* card for you.

---

## 6. Routing and the 4 stages

**Two routing points** — cheap, logged, decided by code, not left to a big model:
1. **Before building — from labels and source** (already on tickets: `posthog`, `firebase-logs`, `dependabot`, `Bug`,
   `Design needed`…). Decides: is a PLAN needed? Is it a UI change?
2. **After building — from the diff.** Risk from what changed: auth, payments, migrations, Firestore rules, function
   triggers, env/config → **high**; tests/deps/copy only → **low**. The diff is a better risk signal than ticket text.
   Decides review depth and which gate (if any).

**4 stages** (the 8 orphaned prompts, merged — fewer stages, fewer tokens):
| Stage | Built from | Runs when |
|---|---|---|
| **PLAN** | INTENT + REFINE + ARCHITECT + FIGMA_BA | Thin tickets, features, risky changes. May raise an *Approve approach* card |
| **BUILD** | WORKFLOW.md body + TDD + DEBUG | Always |
| **VERIFY** | TESTER + VERIFY + visual check | Always. Blocking: typecheck, lint, tests, acceptance list; UI → visual check |
| **REVIEW** | CODE_REVIEW + CODE_QUALITY + SELF_REVIEW; lenses picked by diff: PERFORMANCE, ACCESSIBILITY, MOBILE_UX, CLEAR_WRITING | Risk above trivial. May send back to BUILD up to 2× before anyone sees it |

**Use Claude Code's own features, not extra plumbing:** stages ship as Claude Code **subagents** in the workspace;
VERIFY is a **Stop hook** that won't let the agent finish until checks pass; REVIEW runs in **GitHub Actions** on the
PR. Symphony picks *which* stages are required; it doesn't run separate processes for each.

**Visual check — run on Render PR previews, not locally.** `github-preview.ts` already knows the preview URL. The
check logs in with test accounts (`docs/TEAM_DSC_LOGIN.md`), screenshots desktop + mobile, and diffs against the design.

**Design export at hand-off:** when a Claude Design artifact is linked on a ticket, its HTML is saved into the app repo
(`design/<TEA-id>.html`). No logged-in browser needed, checks are repeatable, and the design is pinned to what was
agreed. The artifact link stays on the ticket as the source.

**Quality rules (no hidden debt, no broken merges):** VERIFY is blocking. REVIEW flags new TODOs, skipped tests, loose
types, copy-paste, and logic changed without a test. Only low-risk + green + non-UI work skips a human.

---

## 7. Gates — the right person, one click

**Route to the person who decides.** Design → **Nika**. Product/policy → **Evie**. Code, merge, credentials,
triage → **you**. You stop being the relay.

**The queue lives where people already are:**
- **Linear** — a gate is a comment on the ticket (screenshots uploaded via `docs/LINEAR_UPLOAD.md`) plus a
  `waiting-on:<person>` label. A saved view "Waiting on me" is each person's queue.
- **Slack** — a DM or `#dsc-website-notifs` message with **buttons**. One tap records the decision.
- **Web board** — only for visual diffs (side-by-side + overlay), linked from the card. Behind a login.

**Every card says what was checked and what wasn't.** E.g. "Checked: admin flow, mobile layout. Not checked: learner
sign-in." So the human knows exactly where to look.

**Card types:**
| Card | For | Shows | Buttons |
|---|---|---|---|
| Approve approach | You / Evie | 2–3 sentence plan + one question | Approve · Redirect |
| Visual sign-off | Nika | Preview beside design + diff, desktop + mobile | Looks good · Request change |
| Code review | You | Diff link + review findings + checks | Merge · Send back |
| Merge + deploy | You | Checks, test summary, screenshot | Deploy |
| Login / credential | You | What to enter where + link | Done |
| Product decision | Evie | Question + options | Decide · Ask Silas |
| Triage decision | You | Ticket + suggested priority/lane | Confirm · Not a bug |

**Safe one-click links:** a link from Slack/Linear opens the card; the button press makes the change. A link preview
bot opening the URL can never approve anything.

---

## 8. Auto-deploy guardrails

Low-risk, green, non-UI PRs auto-merge and deploy (decision 2). Guarded by:
- **Any time** (decision 8) — so the watch below is the main safety net.
- **Watch after deploy** — for N minutes, compare Render, Firebase and PostHog error rates with before. New error
  signature → **open a revert PR and alert you**.
- **Kill switch** — one toggle on the board turns all auto-deploy off.

---

## 9. Governor — pace to people first, then Claude's limits

**People (main limit).** Each person has a cap. You: **≤ 10 open gates, ≤ 6 new per hour**. Nika and Evie: as low as
possible (start at 2 open each) — and a gate goes to them only when you can't clear it yourself. When someone's queue is full, Symphony stops *starting* work that will need them, and finishes work
already in flight. Urgent/outage tickets skip the queue.

**Claude usage (second limit).** On a subscription, the real limit is Claude's 5-hour and weekly caps, not a token
count — and Symphony already records those signals. Keep **20% of the week in reserve**; aim for **≤ 20% per day** as a
ceiling.
- **Getting close:** use cheaper models (existing Codex/Ollama failover), skip optional lenses, run fewer agents.
- **Reserve reached:** urgent work and gate follow-ups only.

**Measure first:** Phase 0 logs cost and time per ticket for a week, then the dials get set from real numbers.

---

## 10. Reports (cloud routines)

- **Daily progress draft** — from Linear activity, in your format (`Working on:` / `Waiting on:` / done + links).
  Arrives as a Slack DM each afternoon with a **Post** button. You edit or post as is.
- **Weekly roadmap** — each in-progress Platform project: % done, shipped, blocked, and **suggested next high-value
  work** from UX insights, error volume and customer impact.

---

## 11. Keep / merge / drop

- **Keep:** intake watchers, dedup markers, lessons/retrospective/meta-improve, merge-conflict fix, model failover,
  status TUI, `DONE:` digest.
- **Merge:** 8 orphaned prompts → 4 stages (§6).
- **Replace:** flat one-agent pipeline → two-point routing + stages; loopback-only server → hosted control plane.
- **Add:** Slack/Render intake, triage, gates routed to people, design export, preview-based visual check, auto-deploy
  guardrails, governor, reports.
- **Fix:** the rework brief is only re-read on retries, not when a ticket is moved back from `In Review`.

---

## 12. Build order

| Phase | Ships |
|---|---|
| **0 — quick wins** | Fix rework-brief bug · log cost/time per ticket · "checked / not checked" in every delivery comment · design-export convention (ticket template + `design/` folder) |
| **1 — gates where people are** | Control plane on Render (gate store, auth, API, Slack buttons, visual board) · gates as Linear comments + `waiting-on:` labels + saved views · routing to Nika/Evie/you · visual check on PR previews against exported design · daily progress draft routine |
| **2 — routing + stages** | Label routing · diff risk · 4 stages as subagents + Stop hook · REVIEW in GitHub Actions · auto-deploy with guardrails |
| **3 — triage + intake** | Triage routine · Slack and Render intake routines |
| **4 — governor** | Per-person caps · Claude-limit pacing (using Phase 0 data) |
| **5 — roadmap report** | Weekly routine |

**Phase 0 — done (2026-11-04):**
- **Rework brief:** the real bug was that, without `ANTHROPIC_API_KEY` (subscription setup), the reviewer's comments
  were never summarised into `## Fix` — and the agent comments were deleted anyway, so the agent never saw why the
  ticket came back. Now falls back to the reviewer's words verbatim. Also stops a doubled `## Fix` heading.
  (The `symphony-reassigned-from-review` marker path is dead — nothing writes it; Phase 1 gate "Send back" will.)
- **Cost/time log:** every attempt appends to `.symphony-runs.jsonl` (ticket, labels, provider, model, minutes,
  turns, tokens, `total_cost_usd`, rework). `npm run runs -- --days 7` prints per-day and per-label totals.
- **Checked / Not checked:** now a required part of the delivery comment in `WORKFLOW.md` (and `DELIVERY_COMMENT.md`).
- **Design pinning:** Symphony spots Claude Design / Figma links in the ticket; the prompt tells the agent to save the
  design to `design/<TEA-id>.html` in the app repo and compare against it. If the link needs a login, it goes under
  *Not checked*.

**Phases 1–5 — built (2026-11-04), off by default (`v2.enabled`):**
| Phase | Module(s) |
|---|---|
| 1 Gates | `gate-hub.ts` (Slack DM + Linear card + `waiting-on:` label, operator-first with "Ask Nika/Evie", Linear reply parsing), `gate-slack.ts`, `slack-socket.ts`, `slack-api.ts`, `gates.ts`, board in `server.ts` |
| 1 Asks | `ask-flow.ts` — agent posts `symphony-ask:<kind>` + options → one button per option |
| 1 Reports | `reports.ts` — daily draft (DM, Post button) + weekly roadmap with suggested next work |
| 2 Routing + stages | `routing.ts` (labels → PLAN?/UI?/lenses), `stages.ts` (planner/verifier/reviewer subagents via `--agents`), `bin/verify-stop-hook.mjs`, `templates/github/claude-review.yml` |
| 2 Review + deploy | `review-flow.ts` (CI/AI-review auto send-back ×2 → diff risk via `diff-risk.ts` → auto-merge or card), `github.ts`, `deploy-guard.ts` (new error signatures after merge → revert PR + card), kill switch file |
| 3 Triage + intake | `triage.ts`, `slack-intake.ts`, `render-logs.ts`, wired in `v2-intake.ts` |
| 4 Governor | `governor.ts` — per-person caps, Claude rate-limit signals, daily ceiling / weekly reserve from the run log |
| 5 Roadmap | weekly report in `reports.ts` |
Composition root: `v2.ts`; config: `v2-config.ts` + `v2:` in WORKFLOW.md.

**Known limits:** deploy guard assumes merge ≈ deploy; any `package.json` change is high risk (Dependabot PRs always
get a card); Render `level=error` tagging and Linear PR-attachment "merged" fields unverified against live data.

---

## 13. Decisions

**Locked (2026-11-04):**
1. **Gate home:** Linear + Slack buttons; web board for visual diffs.
2. **Auto-merge + deploy:** low-risk, green, non-UI PRs — with the §8 guardrails.
3. **Caps:** you ≤ 10 open gates, ≤ 6/hour; ≤ 20%/day; 20% weekly reserve.
4. **Design reference:** Claude Design HTML artifact, linked on the ticket, **exported at hand-off**.
5. **Email intake:** out.

6. **Claude account for hosted parts:** your subscription (governor paces to its 5-hour/weekly caps).
7. **Nika's and Evie's caps:** as low as possible. Cards go by **Slack DM + Linear assignment**. Each card first
   asks *"Can Silas answer this?"* — if the gate is one you can clear (e.g. obvious visual match, policy already
   decided on a past ticket), it comes to you instead.
8. **Deploy window:** any hour, any day. Post-deploy watch + auto-revert + kill switch still apply.
9. **Design export:** Symphony saves the HTML when it sees a Claude Design link on the ticket.
