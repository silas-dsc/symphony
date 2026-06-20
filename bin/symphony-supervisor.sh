#!/usr/bin/env bash
# Symphony supervisor: launches `node dist/index.js` and re-launches it whenever
# Symphony exits with code 75 (the in-process self-updater's "restart" signal).
# Any other exit code is propagated to the caller. SIGINT/SIGTERM are forwarded
# to the child and end the loop.
#
# Usage: bin/symphony-supervisor.sh [args passed through to symphony]

set -u

# Resolve the Symphony repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Build from source before the first launch so a fresh checkout (dist/ is
# gitignored, never committed) always runs current code. The self-updater
# rebuilds on its own after each pull, so this only guards the initial boot.
# Fail loud if the build breaks — never fall back to a stale/absent dist.
if [[ -x "$REPO_ROOT/node_modules/.bin/tsc" ]]; then
  echo "[symphony-supervisor] building (tsc)" >&2
  "$REPO_ROOT/node_modules/.bin/tsc" || { echo "[symphony-supervisor] build failed; aborting" >&2; exit 1; }
else
  echo "[symphony-supervisor] tsc not found — run 'pnpm install' first" >&2
  exit 1
fi

RESTART_EXIT_CODE=75
child_pid=""
terminating=0

forward_signal() {
  local sig="$1"
  terminating=1
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "-$sig" "$child_pid" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT'  INT

while true; do
  node "$REPO_ROOT/dist/index.js" "$@" &
  child_pid=$!
  wait "$child_pid"
  code=$?
  child_pid=""

  if (( terminating == 1 )); then
    exit "$code"
  fi

  if (( code == RESTART_EXIT_CODE )); then
    echo "[symphony-supervisor] restart requested by self-updater; relaunching" >&2
    continue
  fi

  exit "$code"
done
