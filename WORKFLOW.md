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
workspace:
  root: ~/code/team-dsc-workspaces
hooks:
  after_create: |
    git clone --depth 1 git@github.com:team-dsc/team-dsc.git .
    # Use the project's Node version
    if [ -f .nvmrc ]; then
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      nvm install
      nvm use
    fi
    npm install -g pnpm@latest 2>/dev/null || true
    pnpm install
    # copy .env from master dir to current dir
    cp ~/Websites/team-dsc/packages/functional-tests/.env ./packages/functional-tests/.env
    cp ~/Websites/team-dsc/packages/app/.env ./packages/app/.env
    cp ~/Websites/team-dsc/packages/functions/.env ./packages/functions/.env
    # copy SSL certs
    cp ~/Websites/team-dsc/localhost.pem ./localhost.pem
    cp ~/Websites/team-dsc/localhost-key.pem ./localhost-key.pem
    # Derive port suffix from last 3 digits of ticket number (e.g. TEA-84052 → 052)
    ISSUE_ID="${ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-$(basename $PWD)}}"
    TICKET_NUM=$(echo "$ISSUE_ID" | grep -oE '[0-9]+$')
    TICKET_SUFFIX=$(printf '%03d' $((TICKET_NUM % 1000)))
    # Find a free port starting from the derived base, incrementing if already in use
    find_free_port() {
      local port=$1
      while lsof -iTCP:"$port" -sTCP:LISTEN &>/dev/null; do
        port=$((port + 1))
      done
      echo "$port"
    }
    APP_PORT=$(find_free_port "5${TICKET_SUFFIX}")
    PROXY_PORT=$(find_free_port "3${TICKET_SUFFIX}")
    # Persist ports so before_remove and the agent can reference them
    printf 'APP_PORT=%s\nPROXY_PORT=%s\n' "$APP_PORT" "$PROXY_PORT" > .symphony-ports
    # Start dev server and SSL proxy
    cd ./packages/app && pnpm react-router dev --port $APP_PORT &
    echo $! > .symphony-app.pid
    local-ssl-proxy --source "$PROXY_PORT" --target "$APP_PORT" --cert localhost.pem --key localhost-key.pem &
    echo $! > .symphony-proxy.pid

  before_remove: |
    echo "Cleaning workspace"
    # Kill dev server and SSL proxy
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
- Do not repeat completed investigation or implementation from prior attempts.
- Check the existing `## Codex Workpad` comment in Linear first to understand what was already done.
---
{% endif %}

**Description:**
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

---

## Instructions

This is an unattended orchestration session. Never ask a human to perform follow-up actions.

Only stop early for a true blocker: missing required auth, secrets, or permissions that cannot be resolved in-session.

Your final message must report completed actions and any blockers only — no "next steps for user" sections.

Work only inside the provided repository copy. Do not touch any path outside the workspace.

---

## Codebase context

- **Monorepo layout:** `packages/app` (Remix web app), `packages/functions` (Firebase Cloud Functions), `packages/functional-tests`
- **Package manager:** pnpm (do NOT use npm/yarn)
- **Language:** TypeScript throughout; strict mode enabled
- **Frontend:** Remix v2, React 18, Tailwind CSS, Radix UI
- **Backend:** Firebase Cloud Functions (Node 20), Firestore, Firebase Auth
- **Testing:** Jest + Testing Library; run `pnpm typecheck` for type checks
- **Linting:** Biome + ESLint; run `pnpm lint` before committing
- **CI gate:** `pnpm typecheck && pnpm lint` must pass before pushing

---

## Prerequisites

You need Linear access to update ticket status and post comments. Use whichever is available:
1. **Linear MCP server** (if configured in your Claude settings)
2. **`curl` with `LINEAR_API_KEY`** environment variable (always available)

If neither is available, stop and record a blocker in the workpad.

---

## Application login

If you hit a `Not logged in` / `Please run /login` error from the team-dsc
app, its dev server, or its functional tests, do **not** treat it as a
blocker.

```bash
# In the workspace root
cat packages/functional-tests/.env | grep -E '^(SUPER_ADMIN_EMAIL|SUPER_ADMIN_PASSWORD)='
```

Use `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` to log in via the
relevant flow (Firebase Auth in the app, the test harness's login helper
in functional tests, etc.).

The super-admin account can **impersonate any other user**, which is
useful when reproducing role-specific bugs or running functional checks
that need a particular user context — switch into the relevant user via
the impersonation UI rather than fabricating new test accounts.

For github-based workflow, and other CI-based tests, `packages/functional-tests/.env` is not available, but `FUNCTIONAL_TEST_SUPER_ADMIN_EMAIL` and 
`FUNCTIONAL_TEST_SUPER_ADMIN_PASSWORD` can be mapped to the .env vars.
See `.github/workflows/functionalTests.yml` for an example of this.

---

## Default posture

- Determine ticket state first, then follow the matching flow below.
- Keep a single persistent `## Codex Workpad` comment as the source of truth for all progress.
- Plan before implementing. Reproduce the issue before fixing it.
- Keep ticket metadata (state, PR link) current throughout.
- For user-facing changes, include UI walkthrough acceptance criteria.
- When meaningful out-of-scope issues are found, file a separate Linear Backlog ticket — do not expand scope.
- Operate autonomously end-to-end unless blocked by missing secrets/permissions.

---

## Status map

- `Dev in Progress` → the only active state Symphony will pick up; continue from existing workpad comment, or create one if missing.
- `Human Review` → PR is attached and validated; wait for human decision.
- `Done` → terminal; do nothing and shut down.
- Any other state → out of scope; do not modify. Stop.

---

## Step 0: Determine current state and route

1. Fetch the issue by identifier using Linear (MCP or curl).
2. Read its current state and route accordingly.
3. If state is not `Dev in Progress` → do nothing and exit.
4. Check whether an existing PR for this branch is open, merged, or closed.
   - If closed/merged → treat as a fresh start: new branch from `origin/main`.
5. Find or create the `## Codex Workpad` comment, then begin work.

---

## Step 1: Workpad setup

1. Search existing issue comments for `## Codex Workpad`.
2. If found → reuse (update in place). If not → create one.
3. Keep a single persistent workpad — never create duplicates.
4. Format:

```md
## Codex Workpad

\`\`\`text
<hostname>:<abs-workdir>@<short-sha>
\`\`\`

### Plan
- [ ] 1. Task
  - [ ] 1.1 Sub-task

### Acceptance Criteria
- [ ] Criterion

### Validation
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] <targeted test or manual check>

### Notes
- <progress note with timestamp>

### Confusions
- <only include when something was genuinely unclear>
```

---

## Step 2: Execution

1. Confirm state is `Dev in Progress`; if not, stop.
2. Verify git state (`git status`, `git log --oneline -5`).
3. Run `git pull origin main --rebase` and record result in workpad Notes.
4. Create/checkout a feature branch: `git checkout -b feature/{{ issue.identifier | downcase }}-<short-slug>`.
5. Implement the plan, keeping the workpad checklist current.
6. Before every commit: run `pnpm typecheck && pnpm lint` — fix all errors.
7. Use `pnpm --filter app ...` or `pnpm --filter functions ...` to scope commands to a package.
8. Commit with clear messages following the existing style in `git log`.
9. Push and create a PR: `gh pr create --title "..." --body "..."`.
10. Add the `symphony` label to the PR: `gh pr edit <number> --add-label symphony`.
11. Attach the PR URL to the Linear issue.
12. Complete the full verification checklist (see **Step 3: Verification**) and attach evidence to the Linear ticket.
13. Run the full PR feedback sweep (see below).
14. Move the issue to `Human Review` only when all acceptance criteria and validation checks pass.

---

## Step 3: Verification (required before Human Review)

### Automated tests

For any logic change, verify through unit and/or integration tests:

1. Locate existing test files for changed modules:
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
4. Fix any failures and re-run until all pass with zero errors.
5. Attach the full passing test output as a comment on the Linear ticket.

### Visual verification via local dev server

All user-facing changes **must** be verified visually. A local SSL dev server is started automatically during workspace setup. Find its URL:

```bash
cat .symphony-ports
# APP_PORT=5xxx   → raw dev server (http)
# PROXY_PORT=3xxx → SSL proxy (https) — browse to https://localhost:<PROXY_PORT>
```

Open every changed page and every page that depends on the changes. Work through the following recovery steps **in order** before declaring a blocker:

1. **Wait and retry.** The dev server compiles on-the-fly. Wait 10 s and reload. Retry up to 5 times.
2. **Restart the dev server** if pages still fail:
   ```bash
   if [ -f .symphony-app.pid ]; then kill "$(cat .symphony-app.pid)" 2>/dev/null || true; fi
   PORTS=$(cat .symphony-ports 2>/dev/null); APP_PORT=$(echo "$PORTS" | grep APP_PORT | cut -d= -f2)
   cd ./packages/app && pnpm react-router dev --port "$APP_PORT" &
   echo $! > ../../.symphony-app.pid
   cd ../.. 
   ```
3. **Scan for live ports** if `.symphony-ports` is missing or stale:
   ```bash
   lsof -iTCP -sTCP:LISTEN -nP | grep -E ':(3|5)[0-9]{3}\s'
   ```
4. **Check credentials.** If the app shows a login wall, retrieve the super-admin credentials:
   ```bash
   cat packages/functional-tests/.env | grep -E '^(SUPER_ADMIN_EMAIL|SUPER_ADMIN_PASSWORD)='
   ```
5. **Examine server logs** for compilation errors; fix minor code bugs inline and restart the server.

Once the site is accessible, capture evidence:

- **Screenshot** every changed page and every page that depends on the changes.
- **Screen recording** if the change is interactive or involves a multi-step flow.
- Attach all screenshots/recordings as a comment on the Linear ticket.

Do **not** move to `Human Review` without attached visual evidence.

---

## PR feedback sweep (required before Human Review)

1. Read all PR comments: `gh pr view --comments`
2. Read inline review comments: `gh api repos/team-dsc/team-dsc/pulls/<pr>/comments`
3. Read review states: `gh pr view --json reviews`
4. Address every actionable comment (code change or explicit justified pushback).
5. Update workpad checklist with each feedback item.
6. Re-run validation after addressing feedback.
7. Repeat until no outstanding actionable comments remain.

---

## Rework flow

1. Read all issue comments and identify what to do differently.
2. Close the existing PR.
3. Delete the existing `## Codex Workpad` comment.
4. Create fresh branch from `origin/main`.
5. Start over from Step 1.

---

## Blocked-access escape hatch

Use only for true external blockers (missing required auth/secrets after exhausting fallbacks).

- GitHub is never a valid blocker — try alternate auth modes first.
- Before declaring any verification step blocked, exhaust **every** recovery option listed in **Step 3: Verification**.
- If genuinely blocked: move to `Human Review`, add a workpad section containing all of the following:
  - **What is missing / what failed** — specific error messages or missing resource.
  - **Every recovery approach attempted**, in order, with the exact commands run and observed results.
  - **Evidence of deep investigation** — log excerpts, port scans, credential checks, any code changes attempted.
  - **Exact human action needed** to unblock, with no ambiguity.

---

## Guardrails

- Never push to `main` directly.
- Always use pnpm, never npm or yarn.
- Run `pnpm typecheck && pnpm lint` before every push.
- One workpad comment per issue — update in place, never create extras.
- Do not move to `Human Review` until all validation passes and no actionable PR comments remain.
- If state is `Done`, do nothing and exit.
