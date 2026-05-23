#!/usr/bin/env bash
# install-verify-tools.sh — detect, install, and scaffold the optional
# checks `scripts/verify-changes.sh` consults.
#
# Modes:
#   --check       (default) Report what's missing. No writes.
#   --install     Install npm-installable tools as workspace devDependencies.
#                 Updates package.json + lockfile but does NOT commit.
#   --scaffold    Create starter config files where appropriate. Refuses to
#                 overwrite existing files.
#   --all         --install + --scaffold.
#   --dry-run     With --install / --scaffold, print what would happen but
#                 don't write.
#   --help        This message.
#
# Run from the workspace root (the target repo, not Symphony itself).
#
# Exit codes:
#   0  Everything either already-present or successfully actioned.
#   1  Something the script tried to do failed.
#   2  Bad invocation (unknown flag, not a git repo, etc.).

set -uo pipefail

MODE="check"
DRY_RUN=0
INSTALLED=()
SCAFFOLDED=()
MISSING=()
PRESENT=()

print_help() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check)    MODE="check" ;;
      --install)  MODE="install" ;;
      --scaffold) MODE="scaffold" ;;
      --all)      MODE="all" ;;
      --dry-run)  DRY_RUN=1 ;;
      --help|-h)  print_help; exit 0 ;;
      *) echo "Unknown flag: $1" >&2; print_help; exit 2 ;;
    esac
    shift
  done
}
parse_args "$@"

log()       { printf '%s\n' "$*" >&2; }
say_check() { log "[install-verify-tools] $1"; }
say_act()   { log "[install-verify-tools] $1"; }
record_present()    { PRESENT+=("$1");    log "[install-verify-tools] PRESENT:  $1"; }
record_missing()    { MISSING+=("$1");    log "[install-verify-tools] MISSING:  $1"; }
record_installed()  { INSTALLED+=("$1");  log "[install-verify-tools] INSTALLED: $1"; }
record_scaffolded() { SCAFFOLDED+=("$1"); log "[install-verify-tools] SCAFFOLDED: $1"; }

# ── Sanity checks ───────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  log "git is required but not on PATH"
  exit 2
fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "Not a git repository: $(pwd)"
  exit 2
fi
if [ ! -f package.json ]; then
  log "No package.json in $(pwd) — run this from the workspace root"
  exit 2
fi

# Detect package manager.
if command -v pnpm >/dev/null 2>&1 && { [ -f pnpm-lock.yaml ] || [ -f pnpm-workspace.yaml ]; }; then
  PM=pnpm
elif command -v yarn >/dev/null 2>&1 && [ -f yarn.lock ]; then
  PM=yarn
elif command -v npm >/dev/null 2>&1; then
  PM=npm
else
  log "No supported package manager (pnpm/yarn/npm) found"
  exit 2
fi
say_check "package manager: $PM"

# Detect monorepo shape.
IS_MONOREPO=0
[ -f pnpm-workspace.yaml ] && IS_MONOREPO=1
[ -d packages ] && [ "$IS_MONOREPO" = "0" ] && IS_MONOREPO=1
say_check "monorepo: $IS_MONOREPO"

# Detect Firestore presence.
HAS_FIRESTORE=0
[ -f firestore.rules ] && HAS_FIRESTORE=1
say_check "firestore.rules present: $HAS_FIRESTORE"

# Detect Remix app (for bundle-size scaffold hints).
HAS_REMIX_APP=0
[ -f packages/app/package.json ] && grep -q '"@remix-run/' packages/app/package.json 2>/dev/null && HAS_REMIX_APP=1
say_check "Remix app at packages/app: $HAS_REMIX_APP"

# ── Helpers ─────────────────────────────────────────────────────────────────

# Whether the current root package.json declares a given devDep or dep.
has_root_dep() {
  local dep="$1"
  grep -qE "\"$dep\"[[:space:]]*:" package.json
}

# Install a workspace-root devDependency. Caller records on success; this
# function handles dry-run so callers don't have to branch.
install_root_dep() {
  local dep="$1"
  if [ "$DRY_RUN" = "1" ]; then
    say_act "DRY-RUN: would install $dep as workspace devDependency"
    return 0
  fi
  case "$PM" in
    pnpm) pnpm add -D -w "$dep" ;;
    yarn) yarn add -D -W "$dep" ;;
    npm)  npm install --save-dev "$dep" ;;
  esac
}

# Write a file only if it doesn't exist. Returns 0 on write, 1 on refusal.
write_if_absent() {
  local target="$1" content="$2"
  if [ -e "$target" ]; then
    say_act "REFUSE: $target already exists — leaving it alone"
    return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say_act "DRY-RUN: would scaffold $target"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  printf '%s' "$content" > "$target"
  return 0
}

want_install()  { [ "$MODE" = "install" ]  || [ "$MODE" = "all" ]; }
want_scaffold() { [ "$MODE" = "scaffold" ] || [ "$MODE" = "all" ]; }

# ── 1. dependency-cruiser ───────────────────────────────────────────────────
TOOL=dependency-cruiser
if has_root_dep "$TOOL"; then
  record_present "$TOOL (npm dep present)"
else
  record_missing "$TOOL (npm dep)"
  if want_install; then
    install_root_dep "$TOOL" && record_installed "$TOOL"
  fi
fi

DEPCRUISE_CFG=""
for c in .dependency-cruiser.cjs .dependency-cruiser.js .dependency-cruiser.mjs .dependency-cruiser.json; do
  [ -f "$c" ] && DEPCRUISE_CFG="$c" && break
done
if [ -n "$DEPCRUISE_CFG" ]; then
  record_present "$TOOL config ($DEPCRUISE_CFG)"
else
  record_missing "$TOOL config (.dependency-cruiser.cjs)"
  if want_scaffold; then
    boundary_rule=""
    if [ "$IS_MONOREPO" = "1" ] && [ -d packages/app ] && [ -d packages/functions ]; then
      boundary_rule='
    {
      // Example: prevent packages/app from reaching into packages/functions internals.
      // Edit to match your real boundaries before relying on this rule.
      name: "app-not-into-functions-internals",
      severity: "error",
      from: { path: "^packages/app/" },
      to: { path: "^packages/functions/src/" },
    },'
    fi
    cfg_content="/* eslint-disable */
// .dependency-cruiser.cjs — scaffolded by install-verify-tools.sh
// Declare architectural boundaries the codebase must respect. Edit before
// relying on these rules in CI — the starter rules are minimal.
//
// Docs: https://github.com/sverweij/dependency-cruiser
module.exports = {
  forbidden: [
    {
      name: \"no-circular\",
      severity: \"error\",
      comment: \"Modules cannot depend on each other in a cycle.\",
      from: {},
      to: { circular: true },
    },
    {
      name: \"no-orphans\",
      severity: \"warn\",
      comment: \"Files reachable from no entry point are likely dead code.\",
      from: {
        orphan: true,
        pathNot: [
          \"(^|/)\\\\.[^/]+\\\\.(js|cjs|mjs|ts|json)\$\",
          \"\\\\.d\\\\.ts\$\",
          \"(^|/)tsconfig\\\\.json\$\",
        ],
      },
      to: {},
    },$boundary_rule
  ],
  options: {
    doNotFollow: { path: \"node_modules\" },
    tsConfig: { fileName: \"tsconfig.json\" },
    enhancedResolveOptions: {
      exportsFields: [\"exports\"],
      conditionNames: [\"import\", \"require\", \"node\", \"default\"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
"
    if write_if_absent ".dependency-cruiser.cjs" "$cfg_content"; then
      record_scaffolded ".dependency-cruiser.cjs"
    fi
  fi
fi

# ── 2. knip ────────────────────────────────────────────────────────────────
TOOL=knip
if has_root_dep "$TOOL"; then
  record_present "$TOOL (npm dep present)"
else
  record_missing "$TOOL (npm dep)"
  if want_install; then
    install_root_dep "$TOOL" && record_installed "$TOOL"
  fi
fi

KNIP_CFG=""
for c in knip.json knip.jsonc knip.config.ts knip.config.js knip.config.mjs; do
  [ -f "$c" ] && KNIP_CFG="$c" && break
done
if [ -n "$KNIP_CFG" ]; then
  record_present "$TOOL config ($KNIP_CFG)"
else
  record_missing "$TOOL config (knip.json)"
  if want_scaffold; then
    # Compose a minimal config that knip can auto-extend from. Operator should
    # run `pnpm exec knip --init` later for a fuller derived config.
    if [ "$IS_MONOREPO" = "1" ]; then
      knip_cfg='{
  "$schema": "https://unpkg.com/knip@latest/schema.json",
  "workspaces": {
    ".": {
      "entry": ["scripts/**/*.{js,ts}"],
      "project": ["scripts/**/*.{js,ts}"]
    },
    "packages/*": {
      "entry": ["src/index.{ts,tsx}", "src/main.{ts,tsx}"],
      "project": ["src/**/*.{ts,tsx,js,jsx}"]
    }
  }
}
'
    else
      knip_cfg='{
  "$schema": "https://unpkg.com/knip@latest/schema.json",
  "entry": ["src/index.{ts,tsx}", "src/main.{ts,tsx}"],
  "project": ["src/**/*.{ts,tsx,js,jsx}"]
}
'
    fi
    if write_if_absent "knip.json" "$knip_cfg"; then
      record_scaffolded "knip.json"
      say_act "TIP: run \`$PM exec knip --reporter compact\` to see what it surfaces; tune entry/project before relying on it in VERIFY."
    fi
  fi
fi

# ── 3. @firebase/rules-unit-testing ─────────────────────────────────────────
if [ "$HAS_FIRESTORE" = "1" ]; then
  TOOL="@firebase/rules-unit-testing"
  if has_root_dep "$TOOL" || (
    [ -d packages ] && find packages -maxdepth 3 -name package.json -exec grep -lE "\"@firebase/rules-unit-testing\"[[:space:]]*:" {} + 2>/dev/null | head -1 >/dev/null
  ); then
    record_present "$TOOL (npm dep present)"
  else
    record_missing "$TOOL (npm dep)"
    if want_install; then
      install_root_dep "$TOOL" && record_installed "$TOOL"
    fi
  fi

  if [ -d firestore-tests ]; then
    record_present "firestore-tests/ directory"
  else
    record_missing "firestore-tests/ directory + sample rules test"
    if want_scaffold; then
      sample='import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";

// Scaffolded by install-verify-tools.sh. Replace this example with real
// rules tests that exercise every role the application supports.
//
// Run via:
//   firebase emulators:exec --only firestore "pnpm exec vitest --run firestore-tests"

const PROJECT_ID = "demo-rules-test";
let env: Awaited<ReturnType<typeof initializeTestEnvironment>>;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

describe("firestore.rules — example", () => {
  it("rejects unauthenticated reads from a protected collection", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(db.collection("protected").doc("x").get());
  });

  it("allows authenticated reads from their own user document", async () => {
    const uid = "u1";
    const db = env.authenticatedContext(uid).firestore();
    await assertSucceeds(db.collection("users").doc(uid).get());
  });
});
'
      if write_if_absent "firestore-tests/example.test.ts" "$sample"; then
        record_scaffolded "firestore-tests/example.test.ts"
        say_act "TIP: add a root npm script like \`\"firestore:test\": \"firebase emulators:exec --only firestore 'pnpm exec vitest --run firestore-tests'\"\` so VERIFY can pick it up."
      fi
    fi
  fi
fi

# ── 4. Bundle-size budget ──────────────────────────────────────────────────
if [ -f .bundle-budget.json ]; then
  record_present ".bundle-budget.json"
else
  record_missing ".bundle-budget.json"
  if want_scaffold; then
    if [ "$HAS_REMIX_APP" = "1" ]; then
      budget='{
  "$schema": "https://json.schemastore.org/package",
  "// note": "Map built-file-path → max-byte-size. Run the build before VERIFY consults this.",
  "// usage": "Add real entries below. The script ignores lines starting with //.",
  "packages/app/build/client/assets/root.js": 250000,
  "packages/app/build/client/assets/entry.client.js": 200000
}
'
    else
      budget='{
  "$schema": "https://json.schemastore.org/package",
  "// note": "Map built-file-path → max-byte-size. Run a build before VERIFY consults this.",
  "// example": "\"dist/index.js\": 100000"
}
'
    fi
    if write_if_absent ".bundle-budget.json" "$budget"; then
      record_scaffolded ".bundle-budget.json"
    fi
  fi
fi

# ── 5. semgrep (system tool — printed instructions only) ──────────────────
TOOL=semgrep
if command -v semgrep >/dev/null 2>&1; then
  record_present "$TOOL (on PATH: $(command -v semgrep))"
else
  record_missing "$TOOL (system binary)"
  say_act "$TOOL is a Python tool. Install via your OS package manager:"
  say_act "  macOS:        brew install semgrep"
  say_act "  Linux:        pipx install semgrep  (or)  python3 -m pip install --user semgrep"
  say_act "  Docker:       docker run --rm -v \$(pwd):/src returntocorp/semgrep semgrep --config auto /src"
  say_act "Not auto-installed because intrusion into the host Python environment is undesirable."
fi

# ── 6. axe-core (no install — Tester loads from CDN at test time) ──────────
record_present "axe-core (loaded from CDN by Tester at test time — no install needed)"

# ── 7. pnpm audit (built into pnpm — no install) ───────────────────────────
if [ "$PM" = "pnpm" ]; then
  record_present "pnpm audit (built into pnpm)"
else
  say_act "Note: dependency audit via 'pnpm audit' assumes pnpm. VERIFY skips this check for $PM."
fi

# ── 8. vitest --changed / jest --changedSince ──────────────────────────────
# Both are runner flags, not separate tools. Detection happens at VERIFY time
# from each package's package.json. Surface a hint if neither is in any
# touched package.
HAS_TEST_RUNNER=0
if grep -qE "\"(vitest|jest)\"[[:space:]]*:" package.json 2>/dev/null; then
  HAS_TEST_RUNNER=1
fi
if [ "$IS_MONOREPO" = "1" ] && [ "$HAS_TEST_RUNNER" = "0" ]; then
  if find packages -maxdepth 3 -name package.json -exec grep -lE "\"(vitest|jest)\"[[:space:]]*:" {} + 2>/dev/null | head -1 >/dev/null; then
    HAS_TEST_RUNNER=1
  fi
fi
if [ "$HAS_TEST_RUNNER" = "1" ]; then
  record_present "vitest/jest (diff-aware tests supported)"
else
  record_missing "vitest or jest in any package (diff-aware tests will skip)"
fi

# ── Verdict ────────────────────────────────────────────────────────────────
present_count="${#PRESENT[@]}"
missing_count="${#MISSING[@]}"
installed_count="${#INSTALLED[@]}"
scaffolded_count="${#SCAFFOLDED[@]}"

case "$MODE" in
  check)
    echo "INSTALL-VERIFY-TOOLS: check (present=$present_count, missing=$missing_count)"
    if [ "$missing_count" -gt 0 ]; then
      echo "    Re-run with --install --scaffold (or --all) to adopt." >&2
      echo "    Items still missing:" >&2
      for m in "${MISSING[@]}"; do echo "      - $m" >&2; done
    fi
    ;;
  install|scaffold|all)
    echo "INSTALL-VERIFY-TOOLS: $MODE (installed=$installed_count, scaffolded=$scaffolded_count, missing=$missing_count, present=$present_count)"
    if [ "$installed_count" -gt 0 ] || [ "$scaffolded_count" -gt 0 ]; then
      echo "    Review the modified files (git diff), tune scaffolds, then commit. Suggested message:" >&2
      echo "      'Adopt agent VERIFY tooling: ${INSTALLED[*]} ${SCAFFOLDED[*]}'" >&2
    fi
    ;;
esac
exit 0
