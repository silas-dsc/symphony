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

The repo ships an `agent-mcp.json` that wires up [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) in headless + isolated + `--ignore-https-errors` mode. This is what the agent uses to verify mobile UX (`prompts/MOBILE_UX.md`): screenshots at 375px, accessibility snapshots, console-log capture, form interaction, network-request counting. The `--ignore-https-errors` flag lets the agent navigate to the workspace's `https://localhost:<port>` SSL proxy — required for Firebase Auth and other secure-context features.

**Prerequisite:** Playwright downloads its own Chromium build on first run. If your machine has restricted network egress, pre-install via `npx playwright install chrome` (or specify `--executable-path` in `agent-mcp.json`).

To disable: delete `agent-mcp.json` and unset `SYMPHONY_AGENT_MCP_CONFIG`. Agents will then run with whatever MCPs are configured user-level in `~/.claude.json`.

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
| `retrospective.max_turns` | `15` | Max Claude turns per retrospective before it's aborted |
| `retrospective.timeout_ms` | `300000` | Hard wall-clock timeout per retrospective run |

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
  meta-improve.ts   — CLI that reads lessons.jsonl and proposes prompt edits on a branch
  linear.ts         — GraphQL client for Linear (issues, states, team URL)
  workspace.ts      — creates/removes per-ticket directories; runs hooks via bash -l
  config.ts         — parses WORKFLOW.md (YAML front matter + Liquid prompt template)
  server.ts         — tiny HTTP server on 127.0.0.1:<port> serving GET /status as JSON
  status.ts         — full-screen ANSI TUI; polls /status and re-renders in place
  types.ts          — shared TypeScript interfaces
```

---

## Continuous self-improvement

Symphony has a two-stage feedback loop that lets the workflow learn from its own misses without unsupervised prompt drift.

**Stage 1 — per-ticket retrospective (automatic).** When `retrospective.enabled` is `true` and a Symphony-tracked Linear issue reaches a `retrospective.trigger_states` state (default just `Done`), the orchestrator spawns a one-shot Claude session inside the workspace before cleanup. That session reads the Linear comments (Intent Brief → Workpad → QA results → Delivery → human review comments), the git diff, and the GitHub PR thread, then appends one structured JSON line to `lessons/lessons.jsonl`. See `prompts/RETROSPECTIVE.md` for the schema. The retrospective never modifies code, Linear, or GitHub — it just records.

**Stage 2 — meta-improvement pass (operator-triggered).** Run `npm run meta-improve` to spawn a Claude session in the Symphony repo with `prompts/META_IMPROVE.md`. It reads `lessons/lessons.jsonl` (filtered to a configurable window, default 30 days), clusters lessons by `primary_miss` and `tags`, identifies the top 1–3 patterns that meet the actionability threshold (≥ 3 occurrences with agreeing root cause and a clear proposed edit), and proposes narrow edits to `WORKFLOW.md` and `prompts/*.md` on a new branch. It writes a `META_IMPROVE_REPORT.md` and pushes the branch. **The operator reviews the branch and opens the PR** — meta-improvement does not push to `main`, does not open a PR, and does not edit `.ts` files.

```bash
npm run meta-improve                    # last 30 days, default lessons path
npm run meta-improve -- --window 7d     # last week only
npm run meta-improve -- --dry-run       # write report to /tmp, don't commit or push
```

Once the meta-improvement PR is merged, Symphony's existing `auto_update` loop picks up the new prompts on its next poll and restarts. The next batch of retrospectives is the regression test: if the targeted pattern stops appearing in `lessons.jsonl`, the change worked.

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
