# Symphony

An autonomous coding orchestrator. Symphony polls a [Linear](https://linear.app) board, picks up tickets in your configured active states, and spawns a headless [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent per ticket. Each agent clones a fresh workspace, implements the ticket end-to-end (branch → code → tests → PR), and updates Linear as it goes. A live terminal dashboard lets you watch everything in real time.

```
Linear board  ──poll──▶  Symphony orchestrator  ──spawn──▶  Claude Code agent × N
                                │                                    │
                         /status (HTTP)                     workspace + git + PR
                                │
                         symphony-status (TUI)
```

---

## Prerequisites

| Dependency | Min version | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org) | 20 | Runtime |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | latest | Agent runner |
| [GitHub CLI](https://cli.github.com) (`gh`) | 2.x | Agents create PRs |
| [Git](https://git-scm.com) | 2.x | Workspace cloning |
| Linear account | — | Issue source |

### Installing prerequisites

<details>
<summary><strong>macOS</strong></summary>

```bash
# Node.js — via nvm (recommended) or direct installer
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc          # or ~/.bashrc if you use bash
nvm install 20
nvm use 20

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# GitHub CLI
brew install gh

# Authenticate gh (do this once)
gh auth login
```

</details>

<details>
<summary><strong>Windows</strong></summary>

Symphony's workspace hooks run as Bash scripts (`bash -l`). **Windows requires [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install)** (Windows Subsystem for Linux). Run everything inside a WSL terminal.

```bash
# Inside WSL (Ubuntu/Debian):

# Node.js via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# GitHub CLI
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update && sudo apt install gh -y

# Authenticate gh (do this once)
gh auth login
```

> **Tip:** SSH agent forwarding works differently in WSL. If your repo uses SSH remotes, follow [GitHub's WSL SSH guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/working-with-ssh-key-passphrases#auto-launching-ssh-agent-on-git-for-windows).

</details>

---

## Installation

```bash
git clone git@github.com:silas-dsc/symphony.git
cd symphony
npm install
npm run build
```

---

## Configuration

### 1. Environment variables

Copy the example and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | **Yes** | Linear personal API key. Generate at [linear.app/settings/api](https://linear.app/settings/api) → *Personal API keys* |
| `ANTHROPIC_API_KEY` | No | Anthropic API key. If omitted, Claude Code uses browser OAuth instead (see [Claude Code auth](#claude-code-authentication) below) |

### 2. Agent MCP servers (optional but recommended)

Symphony passes `--mcp-config <path>` to each spawned `claude` process so agents have a known, deterministic set of MCP tools regardless of what the cloned target repo declares. By default, Symphony looks for `agent-mcp.json` in the orchestrator directory; override with `SYMPHONY_AGENT_MCP_CONFIG=/abs/path/to/file.json`.

The repo ships an `agent-mcp.json` that wires up the [SuperClaude_Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) MCP server set:

| Server | Purpose | Key required |
|---|---|---|
| [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) | Cross-browser automation & mobile UX verification | — |
| [`@modelcontextprotocol/server-sequential-thinking`](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) | Multi-step structured reasoning | — |
| [`@upstash/context7-mcp`](https://github.com/upstash/context7) | Official library documentation lookup | — |
| [`serena`](https://github.com/oraios/serena) | Semantic code analysis & intelligent editing (LSP-backed) | — |
| [`chrome-devtools-mcp`](https://www.npmjs.com/package/chrome-devtools-mcp) | Chrome DevTools debugging & perf analysis | — |
| [`@21st-dev/magic`](https://21st.dev) | Modern UI component generation | `TWENTYFIRST_API_KEY` |
| [`@morph-llm/morph-fast-apply`](https://morphllm.com) | Fast-apply context-aware code edits | `MORPH_API_KEY` |
| [`tavily`](https://app.tavily.com) (via `mcp-remote`) | Web search & real-time information | `TAVILY_API_KEY` |

Playwright is launched in headless + isolated + `--ignore-https-errors` mode, which is what the agent uses to verify mobile UX (`prompts/MOBILE_UX.md`): screenshots at 375px, accessibility snapshots, console-log capture, form interaction, network-request counting. The `--ignore-https-errors` flag lets the agent navigate to the workspace's `https://localhost:<port>` SSL proxy — required for Firebase Auth and other secure-context features.

**Prerequisites:**
- **Playwright** downloads its own Chromium build on first run. If your machine has restricted network egress, pre-install via `npx playwright install chrome` (or specify `--executable-path` in `agent-mcp.json`).
- **Serena** is launched via [`uvx`](https://docs.astral.sh/uv/). Install `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`) if you want Serena's semantic editing tools; without `uv` the server simply fails to start and the other servers keep working.
- The three API-keyed servers (Magic, Morphllm, Tavily) pick up keys from your `.env` — see `.env.example`. If a key is unset, that server's tools return auth errors at call time; the rest stay available.

To disable an individual server: delete its entry from `agent-mcp.json`. To bypass entirely: delete `agent-mcp.json` and unset `SYMPHONY_AGENT_MCP_CONFIG`. Agents will then run with whatever MCPs are configured user-level in `~/.claude.json`.

### 3. WORKFLOW.md

`WORKFLOW.md` is the single configuration file that controls both the orchestrator and the prompt sent to each agent. It uses YAML front matter for settings, with the rest of the file as a [Liquid](https://liquidjs.com/)-templated prompt.

A minimal example:

```yaml
---
tracker:
  kind: linear
  project_slug: "ALL"       # or a specific project slug; "ALL" = whole team
  team_key: "ENG"           # required when project_slug is "ALL"
  active_states:
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Closed
    - Duplicate

polling:
  interval_ms: 30000        # how often to poll Linear (ms)

github_preview:
  enabled: true
  repo_owner: my-org
  repo_name: my-repo
  comment_pattern: 'deployed to .*? Preview \(Web\) PR #(?<pr>\d+)'
  url_template: 'https://preview-web-pr-{{pr}}.example.com/'
  keepalive_interval_ms: 180000

workspace:
  root: ~/code/workspaces   # where per-ticket clones are created

hooks:
  after_create: |           # runs once after workspace is cloned
    git clone git@github.com:my-org/my-repo.git .
    npm install
  before_remove: |          # runs before a workspace is deleted
    echo "Cleaning up"

agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000

notifications:
  slack:
    webhook_url: $SLACK_COMPLETION_WEBHOOK_URL
    user_map:
      jane@example.com: U01234567
      John Linear: U08976543
---

You are an autonomous coding agent working on {{ issue.identifier }}: {{ issue.title }}
...
```

#### All configuration fields

| Field | Default | Description |
|---|---|---|
| `tracker.kind` | `linear` | Only `linear` is supported |
| `tracker.project_slug` | — | Linear project slug, or `"ALL"` to watch a whole team |
| `tracker.team_key` | — | Linear team key (e.g. `"ENG"`); required when `project_slug` is `"ALL"` |
| `tracker.active_states` | `["Todo","In Progress"]` | States that trigger agent dispatch |
| `tracker.terminal_states` | `["Done","Cancelled",…]` | States that stop a running agent and clean up its workspace |
| `tracker.endpoint` | `https://api.linear.app/graphql` | Linear GraphQL endpoint |
| `tracker.api_key` | `$LINEAR_API_KEY` | Override env-var lookup with a literal key (not recommended) |
| `polling.interval_ms` | `30000` | Poll interval in milliseconds |
| `github_preview.enabled` | `false` | When true, poll GitHub PR comments for preview deployment comments and keep matching preview URLs warm |
| `github_preview.repo_owner` | — | GitHub repo owner to poll with `gh api` |
| `github_preview.repo_name` | — | GitHub repo name to poll with `gh api` |
| `github_preview.comment_pattern` | — | Case-insensitive regex used to detect deployment comments; use the first capture group or a named `pr` group for the PR number |
| `github_preview.url_template` | — | Preview URL template; must include `{{pr}}` so Symphony can build the keepalive URL |
| `github_preview.comment_poll_limit` | `100` | Number of recent GitHub issue comments to inspect on each orchestrator tick |
| `github_preview.keepalive_interval_ms` | `180000` | Interval between keepalive requests while the PR remains open |
| `github_preview.request_timeout_ms` | `30000` | Timeout for both `gh api` calls and preview warm-up requests |
| `workspace.root` | system temp dir | Absolute path (supports `~`) where per-ticket workspaces are created |
| `hooks.after_create` | — | Shell script run once after the workspace directory is created |
| `hooks.before_run` | — | Shell script run before each agent attempt |
| `hooks.after_run` | — | Shell script run after each agent attempt |
| `hooks.before_remove` | — | Shell script run before the workspace is deleted |
| `hooks.timeout_ms` | `600000` | Timeout for any single hook (ms); `after_create` can be slow on cold caches |
| `agent.max_concurrent_agents` | `10` | Total agents running in parallel |
| `agent.max_turns` | `20` | Maximum Claude turns per attempt before the agent is considered stalled |
| `agent.max_retry_backoff_ms` | `300000` | Maximum retry back-off (ms) for failed agents |
| `agent.max_concurrent_agents_by_state` | `{}` | Per-state concurrency cap, e.g. `{ "in progress": 2 }` |
| `notifications.slack.webhook_url` | — | Slack incoming webhook URL. When set, Symphony posts a delivery update after tracked issues move into a completion state |
| `notifications.slack.user_map` | `{}` | Map Linear names or emails to Slack user IDs or raw mention strings so involved people are tagged in completion posts |
| `server.port` | `7777` | Port for the status HTTP server (loopback only) |
| `auto_update.enabled` | `true` | Periodically pull new commits from the Symphony git remote, rebuild, and restart |
| `auto_update.interval_ms` | `300000` | Poll interval (ms) for the self-updater |
| `auto_update.remote` | `origin` | Git remote to fetch from |
| `auto_update.branch` | current branch | Branch to track on the remote; defaults to whichever branch Symphony is checked out on |
| `auto_update.repo_root` | Symphony checkout | Absolute path to the Symphony git working tree (rarely needs overriding) |
| `auto_update.build_command` | `npm run build` | Command run after a successful pull |
| `auto_update.install_command` | `npm install` | Command run when `package.json` or `package-lock.json` changes |
| `retrospective.enabled` | `false` | When true, run a retrospective sub-agent each time a Symphony-tracked ticket reaches a terminal state — appends one structured JSON line to the lessons log |
| `retrospective.trigger_states` | `["Done"]` | Terminal states that trigger a retrospective; case-insensitive |
| `retrospective.lessons_path` | `<symphony>/lessons/lessons.jsonl` | Absolute or relative path to the JSONL file the retrospective appends to |
| `retrospective.commit_lessons` | `true` | After each retrospective, commit `lessons.jsonl` and push it to the tracked branch (reuses `auto_update.remote`/`branch`/`repo_root`). Set `false` to keep the prior manual-commit behaviour |
| `retrospective.max_turns` | `15` | Max Claude turns per retrospective before it's aborted |
| `retrospective.timeout_ms` | `300000` | Hard wall-clock timeout per retrospective run |
| `merge_conflicts.enabled` | `false` | When true, each orchestrator tick scans open PRs and spawns a sub-agent to resolve the conflicts on any GitHub reports as `CONFLICTING` |
| `merge_conflicts.repo_owner` | `github_preview.repo_owner` | GitHub repo owner whose open PRs are scanned; falls back to the `github_preview` owner |
| `merge_conflicts.repo_name` | `github_preview.repo_name` | GitHub repo name whose open PRs are scanned; falls back to the `github_preview` name |
| `merge_conflicts.max_turns` | `30` | Max Claude turns per resolution before it's aborted |
| `merge_conflicts.timeout_ms` | `1200000` | Hard wall-clock timeout per resolution run (20 min) |
| `merge_conflicts.max_concurrent` | `2` | Maximum conflict-resolution sub-agents running at once |
| `merge_conflicts.retry_interval_ms` | `600000` | Minimum delay before re-attempting a PR that is still conflicting after a prior run |
| `merge_conflicts.request_timeout_ms` | `30000` | Timeout for the `gh pr list` call that finds conflicting PRs |
| `dependabot.enabled` | `false` | When true, each orchestrator tick scans the repo's open GitHub Dependabot alerts and files a Linear ticket for each new one, then lets the normal poll loop dispatch an agent to fix it |
| `dependabot.repo_owner` | `github_preview.repo_owner` | GitHub repo owner whose Dependabot alerts are scanned; falls back to the `github_preview` owner |
| `dependabot.repo_name` | `github_preview.repo_name` | GitHub repo name whose Dependabot alerts are scanned; falls back to the `github_preview` name |
| `dependabot.team_key` | `tracker.team_key` | Linear team key the tickets are created under; falls back to the tracker team key |
| `dependabot.target_state` | first `tracker.active_states` entry | Workflow state the ticket is created in — must be one of `tracker.active_states` so the agent picks it up |
| `dependabot.assignee_email` | — | Email (or name) of the Linear user to assign each ticket to; empty leaves it unassigned |
| `dependabot.label` | `dependabot` | Linear label applied to every ticket; also the dedupe key carrier so the same alert isn't filed twice |
| `dependabot.min_severity` | `low` | Only file tickets for alerts at or above this severity: `low`, `medium`, `high`, `critical` |
| `dependabot.max_open_tickets` | `1` | Hard cap on how many Dependabot tickets may be open (in a non-terminal state) at once. The default keeps dependency bumps serialized — the next alert isn't filed until the current ticket is Done/Cancelled |
| `dependabot.request_timeout_ms` | `30000` | Timeout for the `gh api` call that lists Dependabot alerts |

#### Prompt template variables

The text below the YAML front matter is a [Liquid](https://liquidjs.com/) template. Available variables:

| Variable | Type | Description |
|---|---|---|
| `issue.id` | string | Linear internal UUID |
| `issue.identifier` | string | Human identifier, e.g. `ENG-123` |
| `issue.title` | string | Issue title |
| `issue.description` | string \| null | Issue description (Markdown) |
| `issue.state` | string | Current workflow state name |
| `issue.priority` | number \| null | Priority (0 = none, 1 = urgent, 4 = low) |
| `issue.url` | string \| null | Linear issue URL |
| `issue.labels` | string[] | Label names (lowercased) |
| `issue.branchName` | string \| null | Suggested git branch name from Linear |
| `attempt` | number \| null | Retry attempt number (`null` on first attempt) |
| `symphony.root` | string | Absolute path to the Symphony orchestrator directory (where `WORKFLOW.md` lives) |

---

## Claude Code authentication

Claude Code must be authenticated before Symphony can use it. Two options:

### Option A — Browser OAuth (no API key needed)

Run the interactive CLI once and log in:

```bash
claude
# Type /login and follow the browser prompt
```

**macOS:** Credentials are stored in the system Keychain under `Claude Code-credentials`. They persist across reboots automatically.

**Windows (WSL):** Credentials are stored in `~/.claude/.credentials.json` inside WSL. Re-authenticate if you get `Not logged in` errors after a reboot.

### Option B — API key

Add `ANTHROPIC_API_KEY=sk-ant-...` to `.env`. This takes precedence over OAuth credentials and is better suited for server/CI environments.

Get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

---

## Running Symphony

```bash
# Start the orchestrator (reads WORKFLOW.md from the current directory)
node dist/index.js

# Or specify a different workflow file
node dist/index.js /path/to/WORKFLOW.md

# Override the status server port
node dist/index.js --port 8080

# Start under the supervisor wrapper so self-updates are picked up automatically
./bin/symphony-supervisor.sh                 # forwards args to dist/index.js
# or equivalently:
npm run start:watch
```

### Auto-update from GitHub

When `auto_update.enabled` is `true` (the default), Symphony periodically:

1. Runs `git fetch <remote> <branch>` against its own checkout.
2. If new commits exist and the working tree is clean, fast-forward pulls them.
3. Re-runs the install command (only when `package.json` or `package-lock.json` changed) and then the build command.
4. Exits with code **75** to ask the supervisor wrapper to relaunch Symphony on the fresh build.

The in-process self-updater always exits on update — actual restart is performed by `bin/symphony-supervisor.sh`. Run Symphony under the supervisor (or any process manager that re-runs on exit code 75, e.g. systemd with `RestartForceExitStatus=75`) to get hands-off updates. If launched directly with `node dist/index.js`, Symphony will still pull and rebuild but exit instead of restarting.

Self-update is skipped — never destructive — when:
- The working tree has uncommitted changes,
- The local branch is ahead of the remote, or
- HEAD is detached and `auto_update.branch` is not set.

Symphony will:
1. Validate configuration
2. Fetch the Linear team URL for display in the TUI
3. Poll Linear every `polling.interval_ms` milliseconds
4. Spawn a Claude Code agent for each eligible ticket (up to `max_concurrent_agents`)
5. Retry failed agents with exponential back-off
6. Clean up workspaces when tickets reach a terminal state

Stop with `Ctrl-C`. In-flight agents are given 2 seconds to exit cleanly.

---

## Status dashboard

While Symphony is running, open a second terminal:

```bash
node dist/status.js
```

```
┌ SYMPHONY STATUS
Agents: 2/3
Throughput: 142 tps
Runtime: 4m 12s
Tokens: in 84,231 | out 12,450 | total 96,681
Rate Limits: claude (five_hour) | status allowed | resets in 4h 31m | overage n/a
Project: https://linear.app/my-org/team/ENG/all
Next refresh: 1s

├ Running

  ISSUE                                  STAGE          PID      AGE / TURN  TOKENS     SESSION       EVENT
  ───────────────────────────────────────────────────────────────────────────────────────────────────────────
● ENG-42: Add Stripe webhook handling    In Progress    98123    3m 2s / 8   24,300     ab12...ef56   tool_use: Read src/payments/webhook.ts
● ENG-51: Fix login redirect loop        In Progress    98456    1m 18s / 3  8,100      cd34...gh78   tool_use: Bash git status
```

Press `q` or `Ctrl-C` to exit. Options:

```bash
node dist/status.js --port 8080       # connect to a non-default port
node dist/status.js --refresh-ms 500  # faster refresh
```

---

## Architecture overview

```
src/
  index.ts          — entry point; CLI args, logger, starts orchestrator + status server
  orchestrator.ts   — poll loop, dispatch, retry queue, state reconciliation
  agent.ts          — spawns `claude` subprocess, streams JSON events, returns AgentResult
  retrospective.ts  — spawns a one-shot retrospective `claude` process per terminal ticket
  lessons.ts        — ranks past lessons by keyword overlap with a ticket for dispatch-time injection
  lessons-sync.ts   — commits + pushes lessons.jsonl after each retrospective (serialized, rebase-on-push)
  merge-conflict.ts — scans open PRs each tick; spawns a `claude` process to resolve conflicts on each conflicting PR
  dependabot.ts     — scans open Dependabot alerts each tick; files a Linear ticket per new alert for the normal poll loop to pick up
  meta-improve.ts   — CLI that reads lessons.jsonl and proposes prompt edits on a branch
  linear.ts         — GraphQL client for Linear (issues, states, team URL)
  workspace.ts      — creates/removes per-ticket directories; runs hooks via bash -l
  config.ts         — parses WORKFLOW.md (YAML front matter + Liquid prompt template)
  server.ts         — tiny HTTP server on 127.0.0.1:<port> serving GET /status as JSON
  status.ts         — full-screen ANSI TUI; polls /status and re-renders in place
  types.ts          — shared TypeScript interfaces
```

---

## Agent skills

The prompt template in `WORKFLOW.md` instructs the parent agent to coordinate four specialised sub-agents (Intent → Architect → Developer → Tester → Code Reviewer). Each sub-agent loads role-specific skills from `prompts/`:

| Skill | Purpose | File |
|---|---|---|
| Intent gate | Disambiguate the ticket before refinement. | `prompts/INTENT.md` |
| Ticket refinement | Produce Context / AC / Technical Approach / Test Plan / Out of Scope. | `prompts/REFINE_TICKET.md` |
| Figma BA | For tickets with a Figma design: import the design (requesting access with instructions if needed), produce detailed desktop **and** mobile specs (collapsing desktop→mobile where no mobile frame exists), map how the parts connect, quantise styles to the nearest existing Tailwind token, and surface/resolve gaps, assumptions, and improvements. Skipped when the ticket has no Figma URL. | `prompts/FIGMA_BA.md` |
| Architect plan | One commit per task, plus a **Tests to add** section so developer-side tests aren't an afterthought. | `prompts/ARCHITECT.md` |
| Code quality | Per-file walkthrough + scoped `pnpm --filter` lint/typecheck. | `prompts/CODE_QUALITY.md` |
| Codebase shrink | Per-touch checks: delete orphans the diff creates, remove unused deps, extract duplication. Adjacent waste filed as Backlog tickets, not widened into the PR. Periodic full-repo audits use `knip` / `depcheck` / `jscpd`. | `prompts/SHRINK.md` |
| TDD | Failing test first for every bug fix; tests alongside new logic. | `prompts/TDD.md` |
| Performance, Mobile UX | Inline checks on hot-path code and frontend pages. | `prompts/PERFORMANCE.md`, `prompts/MOBILE_UX.md` |
| Structured debugging | Reproduce → isolate → hypothesise → minimum change → verify. Used when a test fails twice or behaviour disagrees with mental model. | `prompts/DEBUG.md` |
| Verify (pre-push gate) | One scripted command (`scripts/verify-changes.sh`) runs in parallel: scoped lint/typecheck, diff-aware unit tests (`vitest --changed` / `jest --changedSince`), `pnpm audit`, SAST via `semgrep`, architectural boundaries via `dependency-cruiser`, orphan/dead-code detection via `knip`, Firestore rules tests when `firestore.rules` was modified, bundle-size budget against `.bundle-budget.json`. Plus synchronous forbidden-token, secret, and untracked-leftover scans. Each parallel check skips gracefully when its tool/config isn't present, so the gate works against repos at any stage of tooling adoption. The agent pastes `VERIFY: pass` into its workpad before pushing. | `prompts/VERIFY.md`, `scripts/verify-changes.sh` |
| Install VERIFY tooling | Detects, installs (npm packages), and scaffolds starter configs for `dependency-cruiser`, `knip`, `@firebase/rules-unit-testing`, `.bundle-budget.json`. Also merges Symphony agent-artefact patterns into the workspace `.gitignore` idempotently. Prints install instructions for `semgrep` (Python tool). `--audit-tracked` mode is a read-only scan of `git ls-files` for stray build/coverage/test-output files, OS junk, oversized binaries — prints `git rm --cached` commands for the operator to triage. Default mode is `--check` (no writes); operators opt in via `--install` / `--scaffold` / `--all`. | `scripts/install-verify-tools.sh` |
| Self-review | Developer-side diff re-read against the five checklists immediately before push. | `prompts/SELF_REVIEW.md` |
| Tester | Independent E2E verification against the Architect's Functional Test Matrix; element-scoped screenshots only; also re-checks VERIFY. | `prompts/TESTER.md` |
| Accessibility audit | For frontend changes: independent WCAG 2.2 AA audit (contrast, keyboard navigation, semantic labels, skip-to-main-content, plain language, status messages) via axe-core + manual checks; barriers route back to the Developer. Skipped when the diff touches no frontend. | `prompts/ACCESSIBILITY.md` |
| Code review | Independent senior-engineer review of the diff, with explicit gates on test coverage, VERIFY freshness, and `docs/AGENT_MEMORY.md` rule compliance. | `prompts/CODE_REVIEW.md` |
| Delivery | One Linear comment + matching PR body. | `prompts/DELIVERY_COMMENT.md` |
| Clear writing | Sentence- and word-level style applied to every prose artefact an agent produces — briefs, plans, ticket descriptions, comments, retros. | `prompts/CLEAR_WRITING.md` |
| Resolve merge conflicts | Orchestrator-triggered (not a phase). For any open PR GitHub reports as conflicting: merge the base branch into the PR branch, resolve so both sides' intent survives (latest/better outcome wins on true contradictions), and push to the PR branch. Never merges the PR. | `prompts/RESOLVE_CONFLICTS.md` |

### Project memory — `docs/AGENT_MEMORY.md`

A persistent, gitable knowledge base every relevant sub-agent reads before investigating the codebase. Records domain vocabulary, roles, architectural decisions, file and naming conventions, common pitfalls, and "things that look like bugs but aren't". The meta-improve pass can append to this file when a retrospective's root cause is "agent didn't know about <rule>" — so the next ticket starts with the rule already known.

Rules the meta-improve pass adds carry an invisible marker comment with a stable id and a `confidence` counter (e.g. `<!-- mem:firestore-loader-limit added=2026-05-01 sources=TEA-4181 confidence=2 -->`). Each retrospective scores the marked rules relevant to its ticket (`reinforced` / `violated` / `stale` via the `memory_feedback` field), and the meta-improve pass uses those tallies to **promote** proven rules, **strengthen** ones agents keep missing, and **retire** stale ones — so memory self-corrects instead of only growing. Markers carry no meaning for an agent acting on the rule; they exist only for this loop.

### Per-ticket lesson retrieval

Before dispatching an agent, Symphony reads `lessons/lessons.jsonl`, ranks past lessons by keyword overlap with the ticket (deterministic token matching — no vector store; the corpus is small enough that it isn't worth one), and injects the most relevant *instructive* misses into the prompt as a **Relevant past lessons** block (`src/lessons.ts`). The parent passes that block to the Architect, so a mistake a related ticket already paid for is on the table at planning time — rather than waiting weeks for the batch meta-improve pass to fold it into a prompt. The agent treats each lesson as a warning to confirm, not a rule to obey blindly. Retrieval is best-effort: a missing or empty lessons file simply omits the block.

## Automatic merge-conflict resolution

When `merge_conflicts.enabled` is `true`, every orchestrator tick scans the configured repo's open pull requests (`gh pr list`) and resolves the conflicts on each one GitHub reports as `CONFLICTING`. It runs on **all** open PRs with conflicts — not just the ticket currently in flight.

For each conflicting PR the resolver clones the repo into a `conflict-pr-<n>` workspace (reusing the `hooks.after_create` clone) and merges the **base** branch into the **PR (head)** branch — re-creating the conflict locally without merging the PR itself. It then classifies the conflict and routes it:

- **Lockfile-only conflicts take a deterministic fast-path — no LLM.** When every conflicted file is a lockfile Symphony knows how to regenerate (`pnpm-lock.yaml` → `pnpm install --lockfile-only`, `package-lock.json` → `npm install --package-lock-only`), it resolves the source manifests (which merged cleanly), regenerates the lockfile, commits, and pushes — saving a full Claude session on the most common, lowest-judgement conflicts.
- **Everything else spawns a one-shot Claude session** (`prompts/RESOLVE_CONFLICTS.md`) that, for each conflicted file, reads all three versions (ancestor / PR side / base side), names the intent of each side, and **merges both intents** so neither change is lost. Only when two intents genuinely contradict does it pick a winner — the side with the better overall outcome, **usually the latest update**, judged from commit recency, the PR's stated goal, and whether the resolution keeps tests passing. Every winner-takes-all call is justified in one sentence and noted in a single PR comment.

Either way it commits and pushes to the **PR branch only** (never force-push, never the base branch) and **never merges, approves, closes, or otherwise state-changes the PR** — a human still reviews and merges.

**It never races the dispatch loop.** Before resolving, it drops any conflicting PR whose branch maps to a Linear ticket currently in an active state (the identifier embedded in the branch name is matched against the active ticket set). Those PRs belong to a running or about-to-run agent that resolves its own conflicts; the resolver only touches PRs whose ticket is past active work (e.g. `In Review`) or has no matching ticket. If the active-ticket lookup fails, it skips dispatch for that cycle rather than risk a duelling push.

Resolutions run in the background (up to `merge_conflicts.max_concurrent` at once) so a long session never blocks the orchestrator tick; a PR that stays conflicting after a run isn't re-attempted until `merge_conflicts.retry_interval_ms` has elapsed, and tracking (plus the workspace) is dropped once the PR is no longer conflicting. Requires the `gh` CLI to be authenticated, same as the GitHub preview warmer.

## Automatic Dependabot triage

When `dependabot.enabled` is `true`, every orchestrator tick reads the configured repo's **open GitHub Dependabot alerts** (`gh api repos/<owner>/<repo>/dependabot/alerts?state=open`) and files a Linear ticket for the most severe *new* alert. It does **not** spawn its own fix agent — it hands the work to Symphony's existing pipeline by creating the ticket directly in an active state, so the normal poll loop dispatches the Intent → Architect → Developer → Tester → Reviewer flow that bumps the dependency, runs `pnpm install`, tests the affected code, fixes any breakage, and opens a PR.

**Only `dependabot.max_open_tickets` Dependabot tickets are ever open at once (default 1).** Each tick the watcher counts Dependabot-labelled tickets in a non-terminal state; once that cap is reached it files nothing, so the next alert isn't picked up until the current ticket reaches a terminal state (Done/Cancelled). This serializes dependency bumps instead of opening a PR per alert simultaneously. Eligible alerts are sorted worst-first, so the single open ticket always targets the highest-severity vulnerability.

Each filed ticket:

1. Is created in team `dependabot.team_key`, in state `dependabot.target_state` (which **must** be one of `tracker.active_states`, or config validation fails — otherwise the ticket would never be dispatched), assigned to `dependabot.assignee_email`, and tagged with the `dependabot.label`.
2. Carries a deterministic, machine-generated description: affected package + ecosystem, manifest path, severity, vulnerable range, first patched version, GHSA/CVE IDs, advisory summary, references, and a pnpm-/monorepo-aware acceptance-criteria checklist. (When no patched version is published yet, the checklist instead asks the agent to assess mitigation or dismissal.)
3. Hides a `<!-- symphony-dependabot:<owner>/<repo>#<alert-number> -->` marker in the description. Before filing anything, the watcher reads back every ticket carrying `dependabot.label` and skips alerts whose key is already present — so the same alert is never filed twice, even across orchestrator restarts. An in-process set covers the same-run fast path.

Alerts below `dependabot.min_severity` are ignored. If the ticket read-back fails (Linear hiccup), the watcher files **nothing** that tick rather than risk duplicates or breaching the open cap, and retries next tick. Once the agent's PR merges, the alert flips to `fixed` on GitHub and stops being reported. Requires the `gh` CLI to be authenticated with access to the repo's Dependabot alerts (a token with `security_events` read, or `repo` scope), same as the other GitHub-backed features.

## Continuous self-improvement

Symphony has a two-stage feedback loop that lets the workflow learn from its own misses without unsupervised prompt drift.

**Stage 1 — per-ticket retrospective (automatic).** When `retrospective.enabled` is `true` and a Symphony-tracked Linear issue reaches a `retrospective.trigger_states` state (default just `Done`), the orchestrator spawns a one-shot Claude session inside the workspace before cleanup. That session reads the Linear comments (Intent Brief → Workpad → QA results → Delivery → human review comments), the git diff, and the GitHub PR thread, then appends one structured JSON line to `lessons/lessons.jsonl`. See `prompts/RETROSPECTIVE.md` for the schema. It also scores any `docs/AGENT_MEMORY.md` rules relevant to the ticket via the `memory_feedback` field, closing the trust loop on past memory edits. The retrospective never modifies code, Linear, or GitHub — it just records.

Once the line is appended, the orchestrator commits `lessons.jsonl` and pushes it to the tracked branch (`retrospective.commit_lessons`, on by default). This needs no manual step and keeps the Symphony working tree clean — which matters because `self-update` refuses to pull over a dirty tree, so an uncommitted lessons file would otherwise stall auto-updates. Concurrent retrospectives are serialized and coalesced into one commit, and a push that races a freshly merged meta-improve PR is rebased and retried automatically.

**Stage 2 — meta-improvement pass (operator-triggered).** Run `npm run meta-improve` to spawn a Claude session in the Symphony repo with `prompts/META_IMPROVE.md`. It reads `lessons/lessons.jsonl` (filtered to a configurable window, default 30 days), clusters lessons by `primary_miss` and `tags`, and identifies up to 3 patterns that meet the actionability threshold (≥ 3 occurrences with agreeing root cause and a clear proposed edit). For each pattern it then:

1. Creates an individual branch `meta-improve/<date>-<slug>` off `main`, applies a narrow (≤ 20-line) edit to one `WORKFLOW.md` or `prompts/*.md` file, pushes, and opens an individual PR.
2. Cherry-picks every pattern's commit into a long-lived `proposed` branch (force-refreshed each run) and opens or updates a combined PR from `proposed → main`.
3. Writes `META_IMPROVE_REPORT.md` on the `proposed` branch summarising what was done and what wasn't.

The pass also reconciles `docs/AGENT_MEMORY.md` rule confidence from the accumulated `memory_feedback` tallies — promoting proven rules, strengthening ones agents keep missing, and retiring stale ones — as one extra memory-maintenance PR (its own branch and meta-review, outside the 3-pattern cap).

**Stage 3 — independent meta-review (automatic).** For every PR opened (individual + combined), the meta-pass dispatches a **Meta-reviewer** sub-agent (`prompts/META_REVIEW.md`) that reads the diff and the motivating lessons with fresh eyes and posts one structured `## 🔍 Meta-review` comment with: verdict (approve / request changes / discuss), risk level, what the edit does, whether it actually addresses the stated pattern, concrete concerns, and a recommended next step. It's advisory — it doesn't submit a formal GitHub review and doesn't merge.

The operator's contract: open the PR list, read each PR's meta-review comment, click merge on the ones they agree with, close the ones they don't. To take everything in one go, merge the combined `proposed → main` PR; the individual PRs close automatically when their commits land in main. The meta-pass never merges, never pushes to `main`, never edits `.ts` files, and never adds new prompts.

```bash
npm run meta-improve                    # last 30 days, default lessons path
npm run meta-improve -- --window 7d     # last week only
npm run meta-improve -- --dry-run       # write report to /tmp, don't push, don't open PRs
```

Once an individual or combined PR is merged, Symphony's existing `auto_update` loop picks up the new prompts on its next poll and restarts. The next batch of retrospectives is the regression test: if the targeted pattern stops appearing in `lessons.jsonl`, the change worked.

The lessons file is git-tracked by default so improvements travel with the repo. If you'd rather keep ticket-level data out of git, add `lessons/lessons.jsonl` to `.gitignore` locally — the meta-pass reads the file path from the workflow config so a local-only file works the same way.

---

## Development

```bash
npm run dev        # run with tsx (no build step, hot-ish reload via restart)
npm run build      # compile TypeScript → dist/
```

The project uses `NodeNext` module resolution. All imports inside `src/` must include the `.js` extension (TypeScript compiles these to `.js` in `dist/`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tracker.api_key is required` | Make sure `.env` exists with `LINEAR_API_KEY=…` and you ran `node dist/index.js` (not `tsx src/index.ts` without dotenv) |
| `Not logged in · Please run /login` | Re-authenticate Claude Code: run `claude`, type `/login` |
| Hook times out | Increase `hooks.timeout_ms` in `WORKFLOW.md`; default is 10 min |
| Status TUI shows `Connection error` | The orchestrator isn't running, or is on a different port (use `--port`) |
| `issue_title` shows as identifier only | The orchestrator was started before a recent update — restart it |
| Agents stall with no events for 5 min | Symphony auto-terminates stalled agents and retries; check logs for the error |

---

## Platform notes

| | macOS | Windows |
|---|---|---|
| **Shell for hooks** | `/bin/bash` login shell | Requires WSL 2 — hooks will fail on native Windows |
| **nvm** | [nvm.sh](https://github.com/nvm-sh/nvm) | [nvm-windows](https://github.com/coreybutler/nvm-windows) (outside WSL) or nvm.sh inside WSL |
| **Claude Code credentials** | macOS Keychain (persist across reboots) | `~/.claude/.credentials.json` in WSL (may need re-auth after reboot) |
| **SSH keys** | `~/.ssh/` + `ssh-agent` via Keychain | Needs explicit `ssh-agent` setup in WSL — see [GitHub docs](https://docs.github.com/en/authentication/connecting-to-github-with-ssh) |
| **gh auth** | `brew install gh && gh auth login` | Install inside WSL as shown in Prerequisites |
| **File paths** | Standard POSIX | Use WSL paths (`/home/user/…`), not Windows paths (`C:\…`) |
