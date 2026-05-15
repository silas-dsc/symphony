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
  enabled: true
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
    webhook_url: $SLACK_COMPLETION_WEBHOOK_URL
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

    # ── pnpm on PATH ──────────────────────────────────────────────────────────
    command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@latest

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
      pnpm install --frozen-lockfile 2>/dev/null || pnpm install
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
          >/tmp/symphony-app-$APP_PORT.log 2>&1 & echo $! > "$OLDPWD/.symphony-app.pid" )
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
      echo $! > .symphony-proxy.pid
    fi

    echo "[symphony] setup converged: APP_PORT=$APP_PORT PROXY_PORT=$PROXY_PORT"

  before_remove: |
    echo "Cleaning workspace"
    if [ -f .symphony-app.pid ]; then kill "$(cat .symphony-app.pid)" 2>/dev/null || true; fi
    if [ -f .symphony-proxy.pid ]; then kill "$(cat .symphony-proxy.pid)" 2>/dev/null || true; fi
agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000
---

You are working autonomously on a Linear ticket for the **team-dsc** codebase — a TypeScript/React (Remix) web application with a Firebase/Firestore backend, managed as a pnpm monorepo.

**Ticket:** `{{ issue.identifier }}` — {{ issue.title }}
**Status:** {{ issue.state }}
**URL:** {{ issue.url }}
{% if issue.labels.size > 0 %}**Labels:** {{ issue.labels | join: ", " }}{% endif %}

{% if attempt %}
---
**Continuation context (attempt #{{ attempt }}):**
- The issue is still in an active state. Resume from the current workspace state.
- Do not repeat completed work — check the `## AI Workpad` comment in Linear and resume from the first unticked phase checkbox.
- The ticket may already have been refined in a prior attempt. Check for an `## Original ticket description (preserved)` comment before re-refining.
---
{% endif %}

**Description:**
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

---

This is an unattended session. Never ask a human to perform any action. Stop only for a true external blocker (see "What is and is not a blocker" below). Your final message must report completed actions and blockers only — no "next steps for user" sections. Work only inside the provided repository copy.

### What is and is not a blocker

**Never a blocker — fix it yourself, do not stop:**

| Symptom | Fix |
|---|---|
| `Cannot find module …` / missing `node_modules` | `pnpm install` from the workspace root. The `before_run` hook also does this, but you can rerun it at any time. |
| Dev server not listening on `APP_PORT` | Restart per the Phase 4 procedure. Wait up to 60s for compile. |
| SSL proxy not listening on `PROXY_PORT` | Restart with `local-ssl-proxy --source "$PROXY_PORT" --target "$APP_PORT" --cert localhost.pem --key localhost-key.pem &` |
| Missing `.env` files | Copy from `~/Websites/team-dsc/packages/<pkg>/.env`. |
| Missing `localhost.pem` / `localhost-key.pem` | Copy from `~/Websites/team-dsc/`. |
| Missing `.symphony-ports` | Re-derive from the ticket number — see the `before_run` hook in this file for the exact logic. |
| `pnpm typecheck` or `pnpm lint` failing | Fix the underlying issue. Never `--no-verify`. Never disable a rule to make an error go away. |
| Stale lockfile causing install failures | `pnpm install` without `--frozen-lockfile`. |
| Tests failing locally that you didn't touch | Investigate — often a flaky test or stale snapshot. Fix or document the flake; never silently skip. |
| Permission denied on a script | `chmod +x <script>` and continue. |
| Linear MCP unavailable | Fall back to `curl` with `$LINEAR_API_KEY`. |
| Playwright MCP unavailable | Investigate (see [MOBILE_UX.md](./prompts/MOBILE_UX.md)) — only document a gap if you've genuinely tried and failed to probe with `browser_evaluate`. |
| `git pull` rejected | Resolve conflicts. Rebase, don't force-push. |

**Valid blockers — only these warrant the escape hatch:**

- Missing `$LINEAR_API_KEY` AND no working Linear MCP (cannot read or write to Linear at all).
- Missing `$ANTHROPIC_API_KEY` if the agent itself is failing to start (you won't see this — the orchestrator will).
- A required external service (Firebase project, Storyblok space) returning auth errors that no credential in `packages/*/.env` resolves.
- The repository itself is in a corrupted state that `git reset --hard origin/main` would discard real work — investigate before destroying state.

Anything else: **fix it and continue.**

---

## How this workflow works

You move through **five phases** in order. Each phase has a **Definition of Done** that you must record in the AI Workpad before moving to the next. Do not skip phases. Do not parallelise across phases.

Each phase loads a dedicated prompt fragment from `{{ symphony.root }}/prompts/` — read that file when you enter the phase. The fragment is the source of truth for that phase; this document only orchestrates.

```
Phase 0  State check          (no prompt — quick gate)
Phase 1  Triage & Refine      prompts/REFINE_TICKET.md
                              prompts/FIGMA_INTAKE.md           ← if ticket has figma.com URL(s)
Phase 2  Plan & Branch        (this document, below)
Phase 3  Implement            prompts/CODE_QUALITY.md           ← applied inline as you code
                              (sub-agents per screen if Figma intake ran)
Phase 4  Harden               prompts/PERFORMANCE.md
                              prompts/MOBILE_UX.md
Phase 5  Verify & Ship        prompts/SELF_REVIEW.md            ← final gate
```

Reference docs (read on demand, not eagerly):
- `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md` — route → role map, test credentials
- `{{ symphony.root }}/docs/STORYBLOK.md` — Storyblok Management API
- `{{ symphony.root }}/docs/LINEAR_UPLOAD.md` — attaching screenshots/files to Linear comments
- `{{ symphony.root }}/UNSLOP.md` — editing principles for any document you rewrite

---

## Codebase context

- **Monorepo:** `packages/app` (Remix web app), `packages/functions` (Firebase Cloud Functions), `packages/functional-tests`
- **Package manager:** pnpm (never npm or yarn)
- **Language:** TypeScript, strict mode
- **Frontend:** Remix v2, React 18, Tailwind CSS, Radix UI
- **Backend:** Firebase Cloud Functions (Node 20), Firestore, Firebase Auth
- **Testing:** Jest + Testing Library
- **CI gate:** `pnpm typecheck && pnpm lint` must pass before push

---

## Phase 0 — State check

You need Linear access. Use the Linear MCP server if configured; otherwise use `curl` with `$LINEAR_API_KEY`. If neither is available, stop and record a blocker.

1. Fetch the issue by identifier.
2. Route based on state:
   - `Dev in Progress` → continue to Phase 1.
   - `In Review` → PR attached and validated; wait for human decision. **Stop.**
   - `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate` → terminal. **Stop.**
   - Any other state → out of scope. **Stop.**
3. Check for an existing PR on this issue's branch. If closed or merged → treat as a fresh start; create a new branch from `origin/main`.

---

## Phase 1 — Triage & Refine

**Load:** `{{ symphony.root }}/prompts/REFINE_TICKET.md` and follow it end-to-end.

Outcome: the Linear ticket has a refined description with Context, Acceptance Criteria, Technical Approach, Test Plan, and Out-of-Scope sections. The original description is preserved as a Linear comment.

### Definition of Done
- [ ] `## Original ticket description (preserved)` comment exists on the Linear issue.
- [ ] Issue description has been replaced with the refined version (or skipped because it already met the bar — recorded in workpad).
- [ ] Workpad records the preservation comment URL.
- [ ] Workpad's "Acceptance Criteria" section mirrors the refined AC list.

---

## Phase 2 — Plan & Branch

### Workpad setup

1. Search existing issue comments for `## AI Workpad`.
2. If found → reuse (update in place). If not → create one. **One workpad per issue, never duplicate.**
3. Format:

````md
## AI Workpad

```text
<hostname>:<abs-workdir>@<short-sha>
```

### Phase status
- [ ] Phase 0: State checked
- [ ] Phase 1: Ticket refined and preserved (link: <comment URL>)
- [ ] Phase 2: Plan and branch ready
- [ ] Phase 3: Implementation complete (lint + typecheck green)
- [ ] Phase 4: Harden pass complete (perf + mobile UX)
- [ ] Phase 5: Self-review and verification complete

### Refined ticket
- Preserved original: <Linear comment URL>
- Refined at: <ISO timestamp>

### Plan
- [ ] 1. Task
  - [ ] 1.1 Sub-task

### Acceptance Criteria
- [ ] (mirror the refined AC list from Phase 1)

### Validation
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] Targeted tests: <paths>
- [ ] Visual verification (mobile + desktop)

### Notes
- <progress note with timestamp>

### Confusions
- <only include when something was genuinely unclear>
````

### Branch setup

1. `git status` and `git log --oneline -5` — verify clean state.
2. `git pull origin main --rebase` — record result in workpad Notes.
3. `git checkout -b feature/{{ issue.identifier | downcase }}-<short-slug>`

### Definition of Done
- [ ] Workpad exists with phase checkboxes, plan, AC, validation list.
- [ ] Feature branch created from latest `origin/main`.
- [ ] Plan covers every AC item.

---

## Phase 3 — Implement

**Load:** `{{ symphony.root }}/prompts/CODE_QUALITY.md` and apply it **inline as you write**, not as a separate cleanup pass.

### Multi-screen tickets (Figma intake produced `.symphony-figma/screens/`)

If Phase 1 ran FIGMA_INTAKE.md and produced per-screen specs, implement **one screen per sub-agent, sequentially**, in the Implementation order from `tech-spec.md`.

For each screen:

1. Spawn a sub-agent via the Agent tool (`subagent_type: "general-purpose"`) with a prompt containing:
   - The full body of `.symphony-figma/tech-spec.md` (shared context).
   - The full body of `.symphony-figma/screens/<id>.md` (this screen's spec).
   - The list of files the sub-agent is allowed to modify (derived from tech-spec → Files).
   - Instruction: "Implement this screen. Apply `{{ symphony.root }}/prompts/CODE_QUALITY.md`. Run `pnpm typecheck && pnpm lint` before returning. Report what you changed."
2. Wait for the sub-agent to complete.
3. Run `pnpm typecheck && pnpm lint` yourself to verify (sub-agents can claim success they didn't deliver).
4. Tick the screen off in the workpad and proceed to the next.
5. Do **not** run multiple sub-agents in parallel — they may touch the same shared component and conflict.

After all sub-agents complete, continue to the rest of Phase 3 (commit discipline, etc.) as the parent — you handle the integration, the commit, and the push.

### Single-change tickets

Work through your plan one task at a time, ticking workpad checkboxes as you go.

### Per-package commands
- `pnpm --filter app ...` — scope to the Remix app
- `pnpm --filter functions ...` — scope to Cloud Functions
- `pnpm --filter functional-tests ...` — scope to functional tests

### Commit discipline
- Before **every** commit: `pnpm typecheck && pnpm lint`. Fix all errors. Never use `--no-verify`.
- Commit messages follow the existing style in `git log`. Small, focused commits.
- Never push to `main` directly.

### Tech-debt-on-touch
Every file you modify gets the code quality gates from `CODE_QUALITY.md` applied. This is mandatory, not optional. If you find unrelated debt in code you're touching, fix only what is directly in the path of your change — file a Linear Backlog ticket for the rest.

### Definition of Done
- [ ] Every plan task ticked.
- [ ] `pnpm typecheck && pnpm lint` green on the latest commit.
- [ ] CODE_QUALITY.md "Record in workpad" block filled in.
- [ ] No commented-out code, `TODO`s, `console.log`s, or `as any` casts in the diff.

---

## Phase 4 — Harden

Two passes, both required if the diff touches the relevant surface area. Skip a pass only if it's genuinely inapplicable (e.g. no frontend changes → skip MOBILE_UX) — record the skip and its reason in the workpad.

### 4a — Performance, efficiency, reliability

**Load:** `{{ symphony.root }}/prompts/PERFORMANCE.md`

Apply to every file you touched that runs in a hot path (loaders, request handlers, Cloud Functions, batch jobs, components rendered on initial load). Skip pure helpers and types.

### 4b — Mobile UX/UI

**Load:** `{{ symphony.root }}/prompts/MOBILE_UX.md`

Apply to every page or component you modified, and every page that consumes a component you modified. Verify at 375px first, then desktop.

The SSL dev server is already running:
```bash
cat .symphony-ports
# APP_PORT=5xxx   → raw dev server (http)
# PROXY_PORT=3xxx → SSL proxy (https) — browse to https://localhost:<PROXY_PORT>
```

If pages fail to load, work through these recovery steps **in order** before declaring a blocker:

1. **Wait and retry.** The dev server compiles on-the-fly. Wait 10s and reload. Retry up to 5 times.
2. **Restart the dev server:**
   ```bash
   if [ -f .symphony-app.pid ]; then kill "$(cat .symphony-app.pid)" 2>/dev/null || true; fi
   APP_PORT=$(grep APP_PORT .symphony-ports | cut -d= -f2)
   (cd ./packages/app && pnpm react-router dev --port "$APP_PORT" &)
   echo $! > .symphony-app.pid
   ```
3. **Scan for live ports** if `.symphony-ports` is missing or stale:
   ```bash
   lsof -iTCP -sTCP:LISTEN -nP | grep -E ':(3|5)[0-9]{3}\s'
   ```
4. **Check credentials.** See `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md` for the route → role map.
5. **Examine server logs** for compilation errors; fix minor code bugs inline and restart.

### Definition of Done
- [ ] PERFORMANCE.md "Record in workpad" block filled in (or skip documented).
- [ ] MOBILE_UX.md "Record in workpad" block filled in (or skip documented).
- [ ] Screenshots at 375px and desktop attached to the Linear ticket via the upload flow in `{{ symphony.root }}/docs/LINEAR_UPLOAD.md`.

---

## Phase 5 — Verify & Ship

### 5a — Automated tests

For any logic change, verify through unit and/or integration tests:

1. Locate existing tests for the changed modules:
   ```bash
   find packages -name '*.test.ts' -o -name '*.spec.ts' | xargs grep -l '<changed-module>' 2>/dev/null
   ```
2. If no relevant tests exist, create them in the same package following Jest + Testing Library conventions already in the codebase.
3. Run the tests:
   ```bash
   pnpm --filter <package> test
   # or from root
   pnpm test
   ```
4. Fix any failures until all pass with zero errors.
5. Attach the full passing test output as a Linear comment.

### 5b — PR

1. Push and create a PR: `gh pr create --title "..." --body "..."`. The body must reference the refined AC.
2. Add the `symphony` label: `gh pr edit <number> --add-label symphony`.
3. Attach the PR URL to the Linear issue.

### 5c — README sweep

Update `README.md` to reflect any changes during this job:
- Add any new behaviour, configuration, or concepts.
- Remove or correct any outdated information.
- Apply `{{ symphony.root }}/UNSLOP.md` principles to the updated `README.md`.

### 5d — PR feedback sweep

1. `gh pr view --comments`
2. `gh api repos/team-dsc/team-dsc/pulls/<pr>/comments` (inline review comments)
3. `gh pr view --json reviews` (review states)
4. Address every actionable comment (code change or explicit justified pushback).
5. Update workpad checklist with each feedback item.
6. Re-run `pnpm typecheck && pnpm lint` after addressing feedback.
7. Repeat until no actionable comments remain.

### 5e — Self-review

**Load:** `{{ symphony.root }}/prompts/SELF_REVIEW.md` and run it end-to-end.

This is the final gate. Re-read your own diff against all four quality checklists (code quality, performance, mobile UX, refined AC). Fix anything you find. Re-run lint/typecheck/visual checks if you re-touch code.

### 5f — Flip to In Review

Only when **every** Definition of Done from every phase is ticked, all PR comments are resolved, and self-review is clean: move the Linear issue to `In Review`.

---

## Rework flow

If a prior PR was rejected and the issue is back in `Dev in Progress`:

1. Read all issue comments to identify what to do differently.
2. Close the existing PR.
3. Delete the existing `## AI Workpad` comment.
4. Keep the `## Original ticket description (preserved)` comment — do not re-preserve.
5. Create a fresh branch from `origin/main`.
6. Restart from Phase 1, but skip the preservation step (already done).

---

## Blocked-access escape hatch

Re-read **"What is and is not a blocker"** at the top of this file before invoking the escape hatch. Most reported "blockers" are environment issues with documented self-heal steps. If you find yourself about to write "Human action required: run X", run X yourself first.

If you have a genuinely external blocker (per the table above), move the issue to `In Review` and add a workpad section containing:

- **What is missing / what failed** — specific error messages or missing resource.
- **Every recovery approach attempted**, in order, with exact commands and observed results.
- **Evidence of deep investigation** — log excerpts, port scans, credential checks, any code changes attempted.
- **Exact human action needed** to unblock, with no ambiguity.

---

## Guardrails

- Never push to `main` directly.
- Always use pnpm, never npm or yarn.
- Run `pnpm typecheck && pnpm lint` before every commit. Never `--no-verify`.
- One workpad comment per issue — update in place.
- One `## Original ticket description (preserved)` comment per issue — never re-create on retries.
- Do not move to `In Review` until every phase's Definition of Done is ticked, all PR comments resolved, and self-review is clean.
- When out-of-scope issues are found, file a Linear Backlog ticket — never expand the current PR.
    command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@latest

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
      pnpm install --frozen-lockfile 2>/dev/null || pnpm install
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
          >/tmp/symphony-app-$APP_PORT.log 2>&1 & echo $! > "$OLDPWD/.symphony-app.pid" )
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
      echo $! > .symphony-proxy.pid
    fi

    echo "[symphony] setup converged: APP_PORT=$APP_PORT PROXY_PORT=$PROXY_PORT"

  before_remove: |
    echo "Cleaning workspace"
    if [ -f .symphony-app.pid ]; then kill "$(cat .symphony-app.pid)" 2>/dev/null || true; fi
    if [ -f .symphony-proxy.pid ]; then kill "$(cat .symphony-proxy.pid)" 2>/dev/null || true; fi
agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000
---

You are working autonomously on a Linear ticket for the **team-dsc** codebase — a TypeScript/React (Remix) web application with a Firebase/Firestore backend, managed as a pnpm monorepo.

**Ticket:** `{{ issue.identifier }}` — {{ issue.title }}
**Status:** {{ issue.state }}
**URL:** {{ issue.url }}
{% if issue.labels.size > 0 %}**Labels:** {{ issue.labels | join: ", " }}{% endif %}

{% if attempt %}
---
**Continuation context (attempt #{{ attempt }}):**
- The issue is still in an active state. Resume from the current workspace state.
- Do not repeat completed work — check the `## AI Workpad` comment in Linear and resume from the first unticked phase checkbox.
- The ticket may already have been refined in a prior attempt. Check for an `## Original ticket description (preserved)` comment before re-refining.
---
{% endif %}

**Description:**
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

---

This is an unattended session. Never ask a human to perform any action. Stop only for a true external blocker (see "What is and is not a blocker" below). Your final message must report completed actions and blockers only — no "next steps for user" sections. Work only inside the provided repository copy.

### What is and is not a blocker

**Never a blocker — fix it yourself, do not stop:**

| Symptom | Fix |
|---|---|
| `Cannot find module …` / missing `node_modules` | `pnpm install` from the workspace root. The `before_run` hook also does this, but you can rerun it at any time. |
| Dev server not listening on `APP_PORT` | Restart per the Phase 4 procedure. Wait up to 60s for compile. |
| SSL proxy not listening on `PROXY_PORT` | Restart with `local-ssl-proxy --source "$PROXY_PORT" --target "$APP_PORT" --cert localhost.pem --key localhost-key.pem &` |
| Missing `.env` files | Copy from `~/Websites/team-dsc/packages/<pkg>/.env`. |
| Missing `localhost.pem` / `localhost-key.pem` | Copy from `~/Websites/team-dsc/`. |
| Missing `.symphony-ports` | Re-derive from the ticket number — see the `before_run` hook in this file for the exact logic. |
| `pnpm typecheck` or `pnpm lint` failing | Fix the underlying issue. Never `--no-verify`. Never disable a rule to make an error go away. |
| Stale lockfile causing install failures | `pnpm install` without `--frozen-lockfile`. |
| Tests failing locally that you didn't touch | Investigate — often a flaky test or stale snapshot. Fix or document the flake; never silently skip. |
| Permission denied on a script | `chmod +x <script>` and continue. |
| Linear MCP unavailable | Fall back to `curl` with `$LINEAR_API_KEY`. |
| Playwright MCP unavailable | Investigate (see [MOBILE_UX.md](./prompts/MOBILE_UX.md)) — only document a gap if you've genuinely tried and failed to probe with `browser_evaluate`. |
| `git pull` rejected | Resolve conflicts. Rebase, don't force-push. |

**Valid blockers — only these warrant the escape hatch:**

- Missing `$LINEAR_API_KEY` AND no working Linear MCP (cannot read or write to Linear at all).
- Missing `$ANTHROPIC_API_KEY` if the agent itself is failing to start (you won't see this — the orchestrator will).
- A required external service (Firebase project, Storyblok space) returning auth errors that no credential in `packages/*/.env` resolves.
- The repository itself is in a corrupted state that `git reset --hard origin/main` would discard real work — investigate before destroying state.

Anything else: **fix it and continue.**

---

## How this workflow works

You move through **five phases** in order. Each phase has a **Definition of Done** that you must record in the AI Workpad before moving to the next. Do not skip phases. Do not parallelise across phases.

Each phase loads a dedicated prompt fragment from `{{ symphony.root }}/prompts/` — read that file when you enter the phase. The fragment is the source of truth for that phase; this document only orchestrates.

```
Phase 0  State check          (no prompt — quick gate)
Phase 1  Triage & Refine      prompts/REFINE_TICKET.md
                              prompts/FIGMA_INTAKE.md           ← if ticket has figma.com URL(s)
Phase 2  Plan & Branch        (this document, below)
Phase 3  Implement            prompts/CODE_QUALITY.md           ← applied inline as you code
                              (sub-agents per screen if Figma intake ran)
Phase 4  Harden               prompts/PERFORMANCE.md
                              prompts/MOBILE_UX.md
Phase 5  Verify & Ship        prompts/SELF_REVIEW.md            ← final gate
```

Reference docs (read on demand, not eagerly):
- `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md` — route → role map, test credentials
- `{{ symphony.root }}/docs/STORYBLOK.md` — Storyblok Management API
- `{{ symphony.root }}/docs/LINEAR_UPLOAD.md` — attaching screenshots/files to Linear comments
- `{{ symphony.root }}/UNSLOP.md` — editing principles for any document you rewrite

---

## Codebase context

- **Monorepo:** `packages/app` (Remix web app), `packages/functions` (Firebase Cloud Functions), `packages/functional-tests`
- **Package manager:** pnpm (never npm or yarn)
- **Language:** TypeScript, strict mode
- **Frontend:** Remix v2, React 18, Tailwind CSS, Radix UI
- **Backend:** Firebase Cloud Functions (Node 20), Firestore, Firebase Auth
- **Testing:** Jest + Testing Library
- **CI gate:** `pnpm typecheck && pnpm lint` must pass before push

---

## Phase 0 — State check

You need Linear access. Use the Linear MCP server if configured; otherwise use `curl` with `$LINEAR_API_KEY`. If neither is available, stop and record a blocker.

1. Fetch the issue by identifier.
2. Route based on state:
   - `Dev in Progress` → continue to Phase 1.
   - `In Review` → PR attached and validated; wait for human decision. **Stop.**
   - `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate` → terminal. **Stop.**
   - Any other state → out of scope. **Stop.**
3. Check for an existing PR on this issue's branch. If closed or merged → treat as a fresh start; create a new branch from `origin/main`.

---

## Phase 1 — Triage & Refine

**Load:** `{{ symphony.root }}/prompts/REFINE_TICKET.md` and follow it end-to-end.

Outcome: the Linear ticket has a refined description with Context, Acceptance Criteria, Technical Approach, Test Plan, and Out-of-Scope sections. The original description is preserved as a Linear comment.

### Definition of Done
- [ ] `## Original ticket description (preserved)` comment exists on the Linear issue.
- [ ] Issue description has been replaced with the refined version (or skipped because it already met the bar — recorded in workpad).
- [ ] Workpad records the preservation comment URL.
- [ ] Workpad's "Acceptance Criteria" section mirrors the refined AC list.

---

## Phase 2 — Plan & Branch

### Workpad setup

1. Search existing issue comments for `## AI Workpad`.
2. If found → reuse (update in place). If not → create one. **One workpad per issue, never duplicate.**
3. Format:

```md
## AI Workpad

\`\`\`text
<hostname>:<abs-workdir>@<short-sha>
\`\`\`

### Phase status
- [ ] Phase 0: State checked
- [ ] Phase 1: Ticket refined and preserved (link: <comment URL>)
- [ ] Phase 2: Plan and branch ready
- [ ] Phase 3: Implementation complete (lint + typecheck green)
- [ ] Phase 4: Harden pass complete (perf + mobile UX)
- [ ] Phase 5: Self-review and verification complete

### Refined ticket
- Preserved original: <Linear comment URL>
- Refined at: <ISO timestamp>

### Plan
- [ ] 1. Task
  - [ ] 1.1 Sub-task

### Acceptance Criteria
- [ ] (mirror the refined AC list from Phase 1)

### Validation
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] Targeted tests: <paths>
- [ ] Visual verification (mobile + desktop)

### Notes
- <progress note with timestamp>

### Confusions
- <only include when something was genuinely unclear>
```

### Branch setup

1. `git status` and `git log --oneline -5` — verify clean state.
2. `git pull origin main --rebase` — record result in workpad Notes.
3. `git checkout -b feature/{{ issue.identifier | downcase }}-<short-slug>`

### Definition of Done
- [ ] Workpad exists with phase checkboxes, plan, AC, validation list.
- [ ] Feature branch created from latest `origin/main`.
- [ ] Plan covers every AC item.

---

## Phase 3 — Implement

**Load:** `{{ symphony.root }}/prompts/CODE_QUALITY.md` and apply it **inline as you write**, not as a separate cleanup pass.

### Multi-screen tickets (Figma intake produced `.symphony-figma/screens/`)

If Phase 1 ran FIGMA_INTAKE.md and produced per-screen specs, implement **one screen per sub-agent, sequentially**, in the Implementation order from `tech-spec.md`.

For each screen:

1. Spawn a sub-agent via the Agent tool (`subagent_type: "general-purpose"`) with a prompt containing:
   - The full body of `.symphony-figma/tech-spec.md` (shared context).
   - The full body of `.symphony-figma/screens/<id>.md` (this screen's spec).
   - The list of files the sub-agent is allowed to modify (derived from tech-spec → Files).
   - Instruction: "Implement this screen. Apply `{{ symphony.root }}/prompts/CODE_QUALITY.md`. Run `pnpm typecheck && pnpm lint` before returning. Report what you changed."
2. Wait for the sub-agent to complete.
3. Run `pnpm typecheck && pnpm lint` yourself to verify (sub-agents can claim success they didn't deliver).
4. Tick the screen off in the workpad and proceed to the next.
5. Do **not** run multiple sub-agents in parallel — they may touch the same shared component and conflict.

After all sub-agents complete, continue to the rest of Phase 3 (commit discipline, etc.) as the parent — you handle the integration, the commit, and the push.

### Single-change tickets

Work through your plan one task at a time, ticking workpad checkboxes as you go.

### Per-package commands
- `pnpm --filter app ...` — scope to the Remix app
- `pnpm --filter functions ...` — scope to Cloud Functions
- `pnpm --filter functional-tests ...` — scope to functional tests

### Commit discipline
- Before **every** commit: `pnpm typecheck && pnpm lint`. Fix all errors. Never use `--no-verify`.
- Commit messages follow the existing style in `git log`. Small, focused commits.
- Never push to `main` directly.

### Tech-debt-on-touch
Every file you modify gets the code quality gates from `CODE_QUALITY.md` applied. This is mandatory, not optional. If you find unrelated debt in code you're touching, fix only what is directly in the path of your change — file a Linear Backlog ticket for the rest.

### Definition of Done
- [ ] Every plan task ticked.
- [ ] `pnpm typecheck && pnpm lint` green on the latest commit.
- [ ] CODE_QUALITY.md "Record in workpad" block filled in.
- [ ] No commented-out code, `TODO`s, `console.log`s, or `as any` casts in the diff.

---

## Phase 4 — Harden

Two passes, both required if the diff touches the relevant surface area. Skip a pass only if it's genuinely inapplicable (e.g. no frontend changes → skip MOBILE_UX) — record the skip and its reason in the workpad.

### 4a — Performance, efficiency, reliability

**Load:** `{{ symphony.root }}/prompts/PERFORMANCE.md`

Apply to every file you touched that runs in a hot path (loaders, request handlers, Cloud Functions, batch jobs, components rendered on initial load). Skip pure helpers and types.

### 4b — Mobile UX/UI

**Load:** `{{ symphony.root }}/prompts/MOBILE_UX.md`

Apply to every page or component you modified, and every page that consumes a component you modified. Verify at 375px first, then desktop.

The SSL dev server is already running:
```bash
cat .symphony-ports
# APP_PORT=5xxx   → raw dev server (http)
# PROXY_PORT=3xxx → SSL proxy (https) — browse to https://localhost:<PROXY_PORT>
```

If pages fail to load, work through these recovery steps **in order** before declaring a blocker:

1. **Wait and retry.** The dev server compiles on-the-fly. Wait 10s and reload. Retry up to 5 times.
2. **Restart the dev server:**
   ```bash
   if [ -f .symphony-app.pid ]; then kill "$(cat .symphony-app.pid)" 2>/dev/null || true; fi
   APP_PORT=$(grep APP_PORT .symphony-ports | cut -d= -f2)
   (cd ./packages/app && pnpm react-router dev --port "$APP_PORT" &)
   echo $! > .symphony-app.pid
   ```
3. **Scan for live ports** if `.symphony-ports` is missing or stale:
   ```bash
   lsof -iTCP -sTCP:LISTEN -nP | grep -E ':(3|5)[0-9]{3}\s'
   ```
4. **Check credentials.** See `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md` for the route → role map.
5. **Examine server logs** for compilation errors; fix minor code bugs inline and restart.

### Definition of Done
- [ ] PERFORMANCE.md "Record in workpad" block filled in (or skip documented).
- [ ] MOBILE_UX.md "Record in workpad" block filled in (or skip documented).
- [ ] Screenshots at 375px and desktop attached to the Linear ticket via the upload flow in `{{ symphony.root }}/docs/LINEAR_UPLOAD.md`.

---

## Phase 5 — Verify & Ship

### 5a — Automated tests

For any logic change, verify through unit and/or integration tests:

1. Locate existing tests for the changed modules:
   ```bash
   find packages -name '*.test.ts' -o -name '*.spec.ts' | xargs grep -l '<changed-module>' 2>/dev/null
   ```
2. If no relevant tests exist, create them in the same package following Jest + Testing Library conventions already in the codebase.
3. Run the tests:
   ```bash
   pnpm --filter <package> test
   # or from root
   pnpm test
   ```
4. Fix any failures until all pass with zero errors.
5. Attach the full passing test output as a Linear comment.

### 5b — PR

1. Push and create a PR: `gh pr create --title "..." --body "..."`. The body must reference the refined AC.
2. Add the `symphony` label: `gh pr edit <number> --add-label symphony`.
3. Attach the PR URL to the Linear issue.

### 5c — README sweep

Update `README.md` to reflect any changes during this job:
- Add any new behaviour, configuration, or concepts.
- Remove or correct any outdated information.
- Apply `{{ symphony.root }}/UNSLOP.md` principles to the updated `README.md`.

### 5d — PR feedback sweep

1. `gh pr view --comments`
2. `gh api repos/team-dsc/team-dsc/pulls/<pr>/comments` (inline review comments)
3. `gh pr view --json reviews` (review states)
4. Address every actionable comment (code change or explicit justified pushback).
5. Update workpad checklist with each feedback item.
6. Re-run `pnpm typecheck && pnpm lint` after addressing feedback.
7. Repeat until no actionable comments remain.

### 5e — Self-review

**Load:** `{{ symphony.root }}/prompts/SELF_REVIEW.md` and run it end-to-end.

This is the final gate. Re-read your own diff against all four quality checklists (code quality, performance, mobile UX, refined AC). Fix anything you find. Re-run lint/typecheck/visual checks if you re-touch code.

### 5f — Flip to In Review

Only when **every** Definition of Done from every phase is ticked, all PR comments are resolved, and self-review is clean: move the Linear issue to `In Review`.

---

## Rework flow

If a prior PR was rejected and the issue is back in `Dev in Progress`:

1. Read all issue comments to identify what to do differently.
2. Close the existing PR.
3. Delete the existing `## AI Workpad` comment.
4. Keep the `## Original ticket description (preserved)` comment — do not re-preserve.
5. Create a fresh branch from `origin/main`.
6. Restart from Phase 1, but skip the preservation step (already done).

---

## Blocked-access escape hatch

Re-read **"What is and is not a blocker"** at the top of this file before invoking the escape hatch. Most reported "blockers" are environment issues with documented self-heal steps. If you find yourself about to write "Human action required: run X", run X yourself first.

If you have a genuinely external blocker (per the table above), move the issue to `In Review` and add a workpad section containing:

- **What is missing / what failed** — specific error messages or missing resource.
- **Every recovery approach attempted**, in order, with exact commands and observed results.
- **Evidence of deep investigation** — log excerpts, port scans, credential checks, any code changes attempted.
- **Exact human action needed** to unblock, with no ambiguity.

---

## Guardrails

- Never push to `main` directly.
- Always use pnpm, never npm or yarn.
- Run `pnpm typecheck && pnpm lint` before every commit. Never `--no-verify`.
- One workpad comment per issue — update in place.
- One `## Original ticket description (preserved)` comment per issue — never re-create on retries.
- Do not move to `In Review` until every phase's Definition of Done is ticked, all PR comments resolved, and self-review is clean.
- When out-of-scope issues are found, file a Linear Backlog ticket — never expand the current PR.
