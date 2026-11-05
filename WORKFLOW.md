---
tracker:
  kind: linear
  project_slug: "ALL"
  team_key: "TEA"
  active_states:
    - Dev in Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 30000
github_preview:
  enabled: false
  repo_owner: team-dsc
  repo_name: team-dsc
  comment_pattern: 'deployed to .*? - Team DSC Production Preview \(Web\) PR #(?<pr>\d+)'
  url_template: 'https://team-dsc-production-preview-web-pr-{{pr}}.onrender.com/health-check'
  comment_poll_limit: 100
  keepalive_interval_ms: 780000
  request_timeout_ms: 30000
keep_alive:
  urls:
    - https://team-dsc-production-preview-web.onrender.com/health-check
  interval_ms: 780000
  request_timeout_ms: 30000
notifications:
  slack:
    bot_token: $SLACK_BOT_TOKEN
    # #dsc-website-notifs (posted via chat.postMessage; the bot must be a member)
    channel: C0BL3E3JENA
    # Batched "DONE:" feed to the channel above. Off: v2's daily draft (Post / Skip) replaces it.
    # The bot token / channel / user_map stay in use by the other reports.
    completion_feed: false
    user_map:
      erin@teamdsc.com.au: U0ARLN893PW
      augustopini@gmail.com: U0APSQ0J23G
      hrindova.nika@gmail.com: U0AN19380DB
      Nika: U0AN19380DB
      jess@teamdsc.com.au: UCYMPSKRN
      Jess Quilty: UCYMPSKRN
      kirsty@teamdsc.com.au: UNM4YHW5U
      Kirsty Jones: UNM4YHW5U
      nicolette@teamdsc.com.au: U06E04DG2G3
      Nicolette Louw: U06E04DG2G3
      jessica@teamdsc.com.au: U06KD7538DV
      Jessica Forrester: U06KD7538DV
      kristen@teamdsc.com.au: U033EP20RPT
      Kristen Shaw: U033EP20RPT
      silas@teamdsc.com.au: U09NHAL0Q2G
      Silas Palmer: U09NHAL0Q2G
      evie@teamdsc.com.au: U0G6GTL1E
      Evie Naufal: U0G6GTL1E
workspace:
  root: ~/code/team-dsc-workspaces
hooks:
  after_create: |
    git clone --depth 1 git@github.com:team-dsc/team-dsc.git .

  # Every attempt: idempotent, self-healing setup. Restores anything missing,
  # leaves anything healthy untouched. Agents must NEVER report "missing
  # node_modules" / "dev server down" / "missing .env" as blockers — this hook
  # exists so those conditions auto-resolve on the next attempt.
  before_run: |
    echo "[symphony] convergent setup: $(pwd)"

    # ── Git sync ─────────────────────────────────────────────────────────────
    echo "[symphony] pulling latest origin/main"
    git pull --rebase --autostash origin main

    # ── Node version ──────────────────────────────────────────────────────────
    if [ -f .nvmrc ]; then
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      nvm use >/dev/null 2>&1 || nvm install
    fi

    # ── pnpm on PATH (pinned, Node-compatible) ────────────────────────────────
    # pnpm v11+ requires Node 22.13+. team-dsc's .nvmrc currently pins Node 22,
    # so install pnpm v11 explicitly — v11 supports Node 18+. If an
    # incompatible pnpm is already on PATH (`pnpm --version` crashes on
    # require('node:sqlite') under Node 20), force a reinstall.
    PNPM_REQUIRED_MAJOR=11
    pnpm_needs_install=0
    if ! command -v pnpm >/dev/null 2>&1; then
      pnpm_needs_install=1
    elif ! pnpm --version >/dev/null 2>&1; then
      echo "[symphony] existing pnpm crashes under this Node — reinstalling pinned version"
      pnpm_needs_install=1
    else
      pnpm_major=$(pnpm --version 2>/dev/null | cut -d. -f1)
      if [ "${pnpm_major:-0}" -gt "$PNPM_REQUIRED_MAJOR" ]; then
        echo "[symphony] installed pnpm major=$pnpm_major exceeds pinned $PNPM_REQUIRED_MAJOR — reinstalling"
        pnpm_needs_install=1
      fi
    fi
    if [ "$pnpm_needs_install" = "1" ]; then
      npm install -g "pnpm@${PNPM_REQUIRED_MAJOR}"
    fi

    # ── Dependencies ──────────────────────────────────────────────────────────
    # Root node_modules AND every package's node_modules must exist. Missing any
    # → reinstall. pnpm install is fast on a warm cache, so over-installing is cheap
    # compared to the failure mode of an agent declaring a blocker.
    NEED_INSTALL=0
    [ ! -d node_modules ] && NEED_INSTALL=1
    for pkg in packages/*/; do
      [ -f "$pkg/package.json" ] && [ ! -d "$pkg/node_modules" ] && NEED_INSTALL=1
    done
    if [ "$NEED_INSTALL" = "1" ]; then
      echo "[symphony] installing dependencies (some node_modules missing)"
      # Try a frozen-lockfile install first (fast, deterministic). Fall back to
      # a regular install only when the lockfile is stale. Any other failure
      # (network, corrupted store) propagates — silently continuing leaves the
      # workspace half-installed and the agent dies with module-not-found.
      if ! pnpm install --frozen-lockfile; then
        echo "[symphony] frozen-lockfile install failed — retrying without lockfile pin"
        pnpm install
      fi
    fi

    # ── Env files & certs (copy if missing, never overwrite) ──────────────────
    MASTER="$HOME/Websites/team-dsc"
    for pkg in functional-tests app functions; do
      target="packages/$pkg/.env"
      source="$MASTER/packages/$pkg/.env"
      if [ ! -f "$target" ] && [ -f "$source" ]; then
        echo "[symphony] restoring $target"
        cp "$source" "$target"
      fi
    done
    for cert in localhost.pem localhost-key.pem; do
      if [ ! -f "$cert" ] && [ -f "$MASTER/$cert" ]; then
        echo "[symphony] restoring $cert"
        cp "$MASTER/$cert" "$cert"
      fi
    done

    # ── Ports (allocate if not recorded) ──────────────────────────────────────
    if [ ! -f .symphony-ports ]; then
      ISSUE_ID="${ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-$(basename $PWD)}}"
      TICKET_NUM=$(echo "$ISSUE_ID" | grep -oE '[0-9]+$')
      TICKET_SUFFIX=$(printf '%03d' $((TICKET_NUM % 1000)))
      find_free_port() {
        local port=$1
        while lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; do port=$((port + 1)); done
        echo "$port"
      }
      APP_PORT=$(find_free_port "5${TICKET_SUFFIX}")
      PROXY_PORT=$(find_free_port "3${TICKET_SUFFIX}")
      printf 'APP_PORT=%s\nPROXY_PORT=%s\n' "$APP_PORT" "$PROXY_PORT" > .symphony-ports
      echo "[symphony] allocated APP_PORT=$APP_PORT PROXY_PORT=$PROXY_PORT"
    fi
    APP_PORT=$(grep APP_PORT .symphony-ports | cut -d= -f2)
    PROXY_PORT=$(grep PROXY_PORT .symphony-ports | cut -d= -f2)

    # ── Dev server (start if not listening) ───────────────────────────────────
    if ! lsof -iTCP:"$APP_PORT" -sTCP:LISTEN &>/dev/null; then
      echo "[symphony] starting dev server on $APP_PORT"
      ( cd packages/app && nohup pnpm react-router dev --port "$APP_PORT" \
          >/tmp/symphony-app-$APP_PORT.log 2>&1 & echo $! > /tmp/symphony-app-$APP_PORT.pid ) || true
      # Wait up to 60s for the server to listen — dev compile can be slow
      for i in $(seq 1 60); do
        lsof -iTCP:"$APP_PORT" -sTCP:LISTEN &>/dev/null && break
        sleep 1
      done
    fi

    # ── SSL proxy (start if not listening) ────────────────────────────────────
    if ! lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN &>/dev/null; then
      echo "[symphony] starting SSL proxy on $PROXY_PORT → $APP_PORT"
      nohup local-ssl-proxy --source "$PROXY_PORT" --target "$APP_PORT" \
        --cert localhost.pem --key localhost-key.pem \
        >/tmp/symphony-proxy-$PROXY_PORT.log 2>&1 &
      echo $! > /tmp/symphony-proxy-$PROXY_PORT.pid || true
    fi

    echo "[symphony] setup converged: APP_PORT=$APP_PORT PROXY_PORT=$PROXY_PORT"

  before_remove: |
    echo "Cleaning workspace"
    if [ -f .symphony-ports ]; then
      _app_port=$(grep APP_PORT .symphony-ports | cut -d= -f2)
      _proxy_port=$(grep PROXY_PORT .symphony-ports | cut -d= -f2)
      [ -n "$_app_port" ] && [ -f /tmp/symphony-app-$_app_port.pid ] && kill "$(cat /tmp/symphony-app-$_app_port.pid)" 2>/dev/null || true
      [ -n "$_proxy_port" ] && [ -f /tmp/symphony-proxy-$_proxy_port.pid ] && kill "$(cat /tmp/symphony-proxy-$_proxy_port.pid)" 2>/dev/null || true
    fi
agent:
  max_concurrent_agents: 3
  max_turns: 40
  max_retry_backoff_ms: 300000
retrospective:
  enabled: true
  trigger_states:
    - Done
  lessons_path: lessons/lessons.jsonl
  max_turns: 15
  timeout_ms: 300000
  # After each retrospective, commit lessons.jsonl and push it to the tracked
  # branch (reuses auto_update.remote/branch/repo_root). Keeps the loop closed
  # with no manual commit, and keeps the tree clean so self-update isn't blocked.
  commit_lessons: true
merge_conflicts:
  enabled: true
  # repo_owner / repo_name inherit from github_preview (team-dsc/team-dsc) when omitted.
  max_turns: 30
  timeout_ms: 1200000
  max_concurrent: 2
  retry_interval_ms: 600000
  request_timeout_ms: 30000
dependabot:
  enabled: true
  # repo_owner / repo_name inherit from github_preview (team-dsc/team-dsc) when omitted.
  # team_key inherits from tracker.team_key (TEA); target_state defaults to the
  # first active state (Dev in Progress) so filed tickets are picked up by the poll loop.
  assignee_email: silas@teamdsc.com.au
  min_severity: low
  # Only ever one Dependabot ticket open at a time — the next alert isn't filed
  # until the current ticket reaches a terminal state.
  max_open_tickets: 1
  request_timeout_ms: 30000
query_insights:
  enabled: true
  # GCP project holding the BigQuery query_insights.query_stats table that the
  # team-dsc app streams Firestore execution stats into.
  project_id: team-dsc-au
  # dataset/table default to query_insights/query_stats.
  # team_key inherits from tracker.team_key (TEA); target_state defaults to the
  # first active state (Dev in Progress) so filed tickets are picked up.
  assignee_email: silas@teamdsc.com.au
  # Aggregate the last 7 days; ignore shapes that read < 10k docs in that window.
  lookback_days: 7
  min_read_ops: 10000
  # File up to 3 tickets per weekly run, max 3 open at once.
  max_open_tickets: 3
  max_tickets_per_run: 3
  # The (relatively expensive) BigQuery scan runs about once a week.
  run_interval_ms: 604800000
  bq_timeout_ms: 60000
posthog:
  enabled: true
  # host / project_id / api_key default to the $POSTHOG_HOST, $POSTHOG_PROJECT_ID
  # and $POSTHOG_PERSONAL_API_KEY env vars (host falls back to us.posthog.com), so
  # no secret is written into this committed file. The api key must be a *personal*
  # key (phx_…) — a phc_ project key can't read error-tracking reports.
  # team_key inherits from tracker.team_key (TEA); target_state defaults to the
  # first active state (Dev in Progress) so filed tickets are picked up.
  assignee_email: silas@teamdsc.com.au
  # Pull active error-tracking reports from the last 30 days; ignore the very quiet
  # ones. File up to 5 tickets per daily run, max 5 open at once.
  status: active
  order_by: occurrences
  lookback_days: 30
  min_occurrences: 1
  max_open_tickets: 5
  max_tickets_per_run: 5
  # The report pull runs about once a day.
  run_interval_ms: 86400000
  request_timeout_ms: 30000
ux_insights:
  # UX / product-research agent (TEA-4562). Unlike the posthog error watcher, this
  # mines *behavioural* data — on-site searches, content→conversion referrers,
  # drop-off (page-leave) pages, and rage/dead-click confusion signals — asks Claude
  # to synthesise actionable insights, posts the weekly write-up to Slack, and files
  # a Linear ticket for the high-confidence actionable ones (closing the loop).
  #
  # Start disabled: run `pnpm ux-insights --dry-run` against live data first to tune
  # the query pack (event/property names below depend on the app's tracking) and eyeball
  # the report before letting it post to Slack and file tickets.
  enabled: true
  # host / project_id / api_key share the posthog watcher's $POSTHOG_* env defaults.
  # slack_channel / slack_bot_token default to notifications.slack.* below.
  # team_key inherits from tracker.team_key (TEA); target_state defaults to the
  # first active state (Dev in Progress) so filed tickets are picked up.
  assignee_email: silas@teamdsc.com.au
  # Post the weekly report to #ux (its own channel, not the shared completion feed).
  # The Symphony Slack bot must be a member of this channel or the post is skipped.
  slack_channel: C0BF62QNPST
  # Analyse the last 7 days.
  lookback_days: 7
  # Event/property names the query pack keys off — tune these to the app's tracking.
  search_event_name: search
  search_query_property: query
  conversion_events:
    - signed_up
    - subscribed
    - purchased
  # Cap rows per lens fed to the synthesiser (bounds token cost).
  max_signals_per_category: 20
  # Only high-confidence actionable insights are auto-filed; the Slack report shows all.
  min_confidence_to_ticket: high
  max_open_tickets: 3
  max_tickets_per_run: 3
  # The pull + synthesis runs about once a week. The run is also anchored to a
  # single weekday (report_day_of_week, default 1 = Monday, local time) so it goes
  # out at most once a week even if the service restarts more than once in a week —
  # the run_interval_ms clock is in-memory and resets on restart.
  run_interval_ms: 604800000
  # 0 = Sunday … 6 = Saturday. Default 1 (Monday).
  report_day_of_week: 1
  request_timeout_ms: 30000
  synthesis_max_turns: 20
  synthesis_timeout_ms: 600000
firebase_logs:
  enabled: true
  # Scans Firebase (Cloud) function logs for error-severity entries via the
  # `gcloud logging read` CLI (which must be authenticated with Logs Viewer
  # access to the project). Groups them into distinct signatures, drops the
  # transient/infra noise (deadline/timeout, UNAVAILABLE, rate limits, socket
  # churn), and files a Linear ticket for each new *fixable* application error.
  # project_id defaults to query_insights.project_id (team-dsc-au), then
  # $GCLOUD_PROJECT / $FIREBASE_PROJECT_ID.
  # team_key inherits from tracker.team_key (TEA); target_state defaults to the
  # first active state (Dev in Progress) so filed tickets are picked up.
  assignee_email: silas@teamdsc.com.au
  # Scan ERROR+ over the last 24h; file up to 5 tickets per run, max 5 open at once.
  min_severity: ERROR
  lookback_hours: 24
  min_occurrences: 1
  max_open_tickets: 5
  max_tickets_per_run: 5
  # The log scan runs about every 6 hours.
  run_interval_ms: 21600000
  gcloud_timeout_ms: 60000

# ── Symphony v2 (docs/ORCHESTRATOR_REDESIGN.md, setup: docs/RUNNING_V2.md) ──
# Off until you flip `enabled`. Each sub-feature can be turned off on its own.
v2:
  enabled: true
  team_key: TEA
  operator: silas
  people:
    - { key: silas, name: Silas, slack_user_id: U09NHAL0Q2G, linear_user: silas@teamdsc.com.au, max_open_gates: 10, max_new_gates_per_hour: 6 }
    # Kept low on purpose: their cards come to Silas first with an "Ask <name>" button.
    - { key: nika, name: Nika, slack_user_id: U0AN19380DB, linear_user: Nika, max_open_gates: 2, max_new_gates_per_hour: 2 }
    - { key: evie, name: Evie, slack_user_id: U0G6GTL1E, linear_user: evie@teamdsc.com.au, max_open_gates: 2, max_new_gates_per_hour: 2 }
  design_person: nika
  product_person: evie
  slack:
    bot_token: $SLACK_BOT_TOKEN
    # Socket Mode app token (xapp-…) so buttons work without a public URL.
    app_token: $SLACK_APP_TOKEN
    # Where "Post" sends the daily/weekly update (#dsc-website-notifs; the bot is already a member).
    report_channel: C0BL3E3JENA
  review:
    state: In Review
    rework_state: Dev in Progress
    # Leave unset to let Linear's GitHub integration move tickets on merge.
    # merged_state: Done
    auto_merge: true          # low-risk, green, non-UI only. Kill switch: touch .symphony-autodeploy-off
    max_auto_send_backs: 2
  deploy_guard:
    watch_minutes: 30
    min_new_occurrences: 3
  governor:
    # Set from `npm run runs -- --days 7` after a week (API-equivalent $/week).
    weekly_budget_usd: null
    daily_share: 0.2
    reserve_share: 0.2
  reports:
    daily_hour: 16            # local time, weekdays → DM draft with a Post button
    weekly_day: 1             # Monday
    weekly_hour: 9
  triage:
    enabled: false
    triage_state: Triage
    dev_state: Dev in Progress
    backlog_state: Backlog
    duplicate_state: Duplicate
  # Product roadmap (Evie's "Feature roadmap: What's next?", edited at teamdsc.com.au/dashboard/roadmap).
  # Symphony orders work by it, flags items waiting on people, and starts the first ready one.
  # It reads the live feed (bearer ROADMAP_FEED_TOKEN from .env), caching each read to `file`;
  # if the feed is down it uses that last good copy.
  roadmap:
    enabled: true
    url: https://teamdsc.com.au/api/roadmap
    token: $ROADMAP_FEED_TOKEN
    file: .symphony-roadmap.json
    pull_ready: true          # start the next ready item itself (moves it to Dev in Progress)
    max_in_flight: 1          # roadmap tickets Symphony builds at once
    pull_from_states: [Todo, Backlog]
  # Hourly Claude budget. Every check, Symphony reads the account's 5-hour usage (all Claude use
  # counts, not just Symphony's). If the last hour used more than this share of the 5-hour limit,
  # every Claude process Symphony started is suspended and nothing new starts until it's back under.
  # Needs CLAUDE_CODE_OAUTH_TOKEN in .env.
  usage_budget:
    enabled: true
    max_share_per_hour: 0.17
    check_minutes: 15
  # Local code review (replaces the claude-review GitHub Action): every new commit on an open
  # team-dsc PR (not drafts, forks or Dependabot) gets Claude Code's own `/code-review <level> --fix`
  # in a workspace here. Fixes are verified, committed and pushed; one comment ends in
  # `Verdict: approve|changes`; a `symphony/review` status shows on the commit. Paused by usage_budget.
  pr_review:
    enabled: true
    level: high
    max_per_pr_per_day: 6
    review_existing: false    # true = also review PRs already open when this was switched on
  # PRs that ask for your review (teammates' and bots') → a Slack card with the PR, ticket, preview,
  # Approve on GitHub / Request changes, and 🧪 Functional test. Symphony never merges these.
  review_requests:
    enabled: true
    linear_url: https://linear.app/team-dsc
    max_open: 6
  # After every merge to main: follow the Deployment run (app on Render, functions, secret bindings),
  # compare logs before/after, functional-test production (merges with a ticket), then close the
  # ticket, or open a follow-up ticket in Dev in Progress so Symphony builds the fix.
  # Production tests sign in with FUNCTIONAL_TEST_* accounts from .env and pay only with DSFREE.
  release:
    enabled: true
    workflow: Deployment
    site_url: https://teamdsc.com.au
    watch_minutes: 30
    prod_test: true
    done_state: Done
  slack_intake:
    enabled: false
    channels: C0A07RQJXP1
    # Optional: only these reporters (Kristen, Jessica, Evie, Nika, Wei) — comma-separated Slack ids.
    reporter_user_ids: ""
  render_logs:
    enabled: false
    api_key: $RENDER_API_KEY
    owner_id: $RENDER_OWNER_ID
    service_ids: $RENDER_SERVICE_IDS
    target_state: Triage
---

You are an autonomous engineer working on a single Linear ticket for the **team-dsc** codebase — a TypeScript/React (Remix) web app with a Firebase/Firestore backend, managed as a pnpm monorepo.

The ticket description **is the spec**. Read it as written and implement exactly what it asks. Do not rewrite, reframe, or "refine" the description, and do not paraphrase it into acceptance criteria — build against the words the requester used. Do not update the Linear issue description.

**Ticket:** `{{ issue.identifier }}` — {{ issue.title }}
**Status:** {{ issue.state }}
**URL:** {{ issue.url }}
{% if issue.labels.size > 0 %}**Labels:** {{ issue.labels | join: ", " }}{% endif %}

{% if attempt %}
---
**Continuation (attempt #{{ attempt }}):** The issue is still active. A prior attempt may have already created a branch, commits, or an open PR for this ticket — check `git status`, `git log`, and the existing branch before starting, and continue that work rather than duplicating it.
---
{% endif %}

{% if reassignment_instruction %}
---
**Reviewer rework brief** (the ticket was sent back — this is what to address this attempt):

{{ reassignment_instruction }}
---
{% endif %}

**Description:**
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided. Implement the smallest change consistent with the ticket title.
{% endif %}

{% if design.links.size > 0 %}
---
**Design reference:** {% for link in design.links %}{{ link }}{% unless forloop.last %} · {% endunless %}{% endfor %}

Before building, pin the design: if `{{ design.export_path }}` is not already on your branch or `origin/main`, open the first link with the chrome-devtools MCP and save the design's own HTML (for a Claude Design artifact, the rendered artifact frame — not the claude.ai page around it) to `{{ design.export_path }}` and commit it with the change. Build against that file and compare your result to it on the preview, desktop and mobile.
If the link needs a login you don't have, don't stop: build from the description and put `Visual match vs design (design link needs login)` under **Not checked**.
{% endif %}

---
**Stages for this ticket** (Symphony routed it — {% if route.reasons.size > 0 %}{{ route.reasons | join: "; " }}{% else %}default route{% endif %}):
{% if route.plan %}- **PLAN first:** run the `planner` subagent before writing code and follow its acceptance list. If it ends with `APPROACH QUESTION:`, don't guess — ask (see *Asking a human* below) and stop.
{% endif %}- **BUILD:** make the change (below).
- **VERIFY:** run the `verifier` subagent before opening or updating the PR{% if route.ui %} — this is a UI change, so it must screenshot the Render preview at desktop and mobile{% if design.links.size > 0 %} next to `{{ design.export_path }}`{% endif %} and upload the screenshots for the delivery comment{% endif %}. Use its `Checked:` / `Not checked:` lines in the delivery comment.
- **REVIEW:** run the `reviewer` subagent on the finished diff{% if route.lenses.size > 0 %} with lenses {{ route.lenses | join: ", " }}{% endif %}. Fix every `BLOCKER:` and `FIX:` and re-run it (max 2 rounds) before handing over.
- A Stop hook re-runs `pnpm typecheck && pnpm lint` when you finish; if it fails you'll be told what to fix.

**Asking a human** (only for a real decision: approach choice, product question, a login or credential you need): post one Linear comment that starts with these two lines, then add the label `waiting-on:silas` to the issue and stop. Symphony turns it into a one-click card and re-dispatches you with the answer.
```md
<!-- symphony-agent -->
<!-- symphony-ask:<approve_approach | product_decision | login_credential> -->
**Question:** <one sentence>
- **A:** <option> (recommended)
- **B:** <option>
```

{% if relevant_lessons != "" %}
---
**Relevant past lessons** (retrieved from `lessons/lessons.jsonl` by keyword overlap — treat each as a warning to confirm, not a rule to obey blindly; the codebase may have moved on):

{{ relevant_lessons }}
{% endif %}

---

## How to work

This is an unattended session. Never ask a human to do anything except through *Asking a human* above. Work only inside the provided repository copy (the workspace is already cloned and set up — `node_modules`, `.env` files, dev server, and ports are handled by the environment hooks). Stop only for a genuine external blocker (missing credentials or an external service failing with no local fix). For anything environmental — missing modules, dev server down, missing `.env`, stale lockfile — fix it yourself and continue.

1. **Understand the task** from the description above, then read the code you need to change. `docs/AGENT_MEMORY.md` records domain vocabulary, conventions, and known pitfalls — consult the relevant parts before investigating.
2. **Make the change** on a feature branch (never commit to `main`):
   ```bash
   git checkout -b feature/{{ issue.identifier | downcase }}-<short-slug>
   ```
   If an open PR/branch for this ticket already exists (rework or continuation), reuse it. If a prior PR was closed or merged, branch fresh from `origin/main`.
3. **Keep the change surgical and simple.** Touch only what the ticket needs. No speculative features, no refactors outside the change path, no abstractions for single-use code. Match the style of the file you're editing.
4. **Use pnpm** (never npm/yarn), scoped per package: `pnpm --filter app ...`, `pnpm --filter functions ...`, `pnpm --filter functional-tests ...`.
5. **Before pushing**, make sure the CI gate passes — `pnpm typecheck && pnpm lint` must be clean. Never use `--no-verify`; never disable a rule to silence an error. Commit in small, focused commits following the existing `git log` style.
6. **Open a PR** against `origin/main` labelled `symphony`, with a short body summarising the change and linking the ticket ({{ issue.url }}). Include the same **Checked / Not checked** lines as step 7.
7. **Post one delivery comment** on the Linear issue, in exactly this shape (the first line is an invisible marker — keep it, it lets Symphony tidy the comment up if the ticket comes back):
   ```md
   <!-- symphony-agent -->
   ## ✅ Ready for review

   <one sentence: what the user sees now that they didn't before>

   **Checked:** <only what you actually ran or looked at — e.g. typecheck + lint, unit tests for X, admin flow on the preview, mobile layout>
   **Not checked:** <what you could not verify, and why — e.g. learner sign-in (no learner test account)>

   PR: <PR URL>
   ```
   **Not checked** is mandatory. It tells the reviewer exactly where to look. Write `Nothing — all acceptance points verified` only when that is literally true. Never list something under **Checked** that you inferred rather than ran or saw.
8. **Flip the Linear issue to `In Review`** once the PR is open and the comment is posted.

You have Linear access via the Linear MCP server, or `curl` with `$LINEAR_API_KEY` as a fallback.

### Codebase context
- **Monorepo:** `packages/app` (Remix web app), `packages/functions` (Firebase Cloud Functions), `packages/functional-tests`
- **Language:** TypeScript, strict mode
- **Frontend:** Remix v2, React 18, Tailwind CSS, Radix UI
- **Backend:** Firebase Cloud Functions (Node 20), Firestore, Firebase Auth
- **CI gate:** `pnpm typecheck && pnpm lint` must pass before push

### Guardrails
- Never push to `main` directly; always work on a feature branch and open a PR.
- Always use pnpm, never npm or yarn.
- `pnpm typecheck && pnpm lint` must be clean before every push. Never `--no-verify`.
- Keep the diff scoped to the ticket. If you spot unrelated debt or out-of-scope issues, file a Linear Backlog ticket — never expand this PR.
- If you hit a genuine external blocker, leave the issue in `Dev in Progress` and ask with `symphony-ask:login_credential` (see *Asking a human*), stating exactly what failed and the precise human action needed. Do not flip to `In Review` for a blocker.
