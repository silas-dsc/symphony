#!/usr/bin/env bash
# verify-changes.sh — pre-push verification gate for a Symphony agent.
#
# Runs every check that has to pass before the agent pushes its branch:
#   1. Scoped lint + typecheck + tests for each touched pnpm package.
#   2. Dependency audit (pnpm audit) for prod vulns ≥ high.
#   3. Dependency-graph rules (dependency-cruiser) — architectural boundaries.
#   4. SAST (semgrep --config auto) — XSS, injection, eval, etc.
#   5. Unused exports / files / deps (knip) on the diff.
#   6. Firestore rules tests when firestore.rules was touched.
#   7. Bundle-size budget (against `.bundle-budget.json` if present).
#   8. Forbidden-token scan on the diff (debug noise, casts, skipped tests).
#   9. Secret scan on the diff.
#  10. Untracked-leftover scan inside source trees (*.tmp, *.bak, ...).
#  11. Tracked-artefact scan on the diff — flags accidental additions to
#      build/coverage/test-output dirs, OS junk (.DS_Store), node_modules,
#      and images >100kb outside designated asset directories. For a one-time
#      audit of files already tracked, use
#      `scripts/install-verify-tools.sh --audit-tracked`.
#
# Checks 1–7 run in parallel (capped by VERIFY_PARALLELISM, default nproc).
# Checks 8–11 run synchronously after — they're cheap and the agent benefits
# from them appearing last in the output.
#
# Each parallel check is **graceful**: if the tool or its config isn't
# present, it exits 77 ("skipped") and the script prints a SKIP line instead
# of failing. This means the script works today even if the target repo
# hasn't adopted every tool — and lights up automatically as adoption happens.
#
# Exits 0 on `VERIFY: pass`, 1 on `VERIFY: fail (<reasons>)`. The agent pastes
# the final line verbatim into `.claude/workpad.md`; the Code Reviewer treats a
# missing or stale `VERIFY pass` note as a Blocking finding.
#
# Env vars:
#   VERIFY_BASE_REF        Defaults to origin/main.
#   VERIFY_PARALLELISM     Max concurrent jobs (default: nproc, min 1, max 8).
#   VERIFY_SKIP            Comma-separated check names to skip (e.g. "audit,semgrep").
#   VERIFY_LOG_DIR         Where per-job logs are written (default: /tmp/symphony-verify-<sha>).

set -uo pipefail

BASE_REF="${VERIFY_BASE_REF:-origin/main}"
WORKSPACE_ROOT="$(pwd)"
FAILURES=()
SKIPS=()
HEAD_SHA="unknown"

log()  { printf '%s\n' "$*" >&2; }
fail() { FAILURES+=("$1"); log "[verify] FAIL: $1"; }
skip() { SKIPS+=("$1");    log "[verify] SKIP: $1"; }
pass() { log "[verify] OK:   $1"; }

# Comma-separated skip list → bash assoc lookup.
declare -A SKIP_SET=()
IFS=',' read -ra _skip_list <<< "${VERIFY_SKIP:-}"
for s in "${_skip_list[@]}"; do
  s="${s// /}"
  [ -n "$s" ] && SKIP_SET["$s"]=1
done
is_skipped() { [ -n "${SKIP_SET[$1]:-}" ]; }

# ── 0. Sanity checks ────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  log "[verify] git is required but not on PATH"
  echo "VERIFY: fail (no_git)"
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "[verify] $WORKSPACE_ROOT is not a git repository"
  echo "VERIFY: fail (not_a_repo)"
  exit 1
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  log "[verify] base ref $BASE_REF not found — fetching"
  git fetch origin main >/dev/null 2>&1 || true
  if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
    log "[verify] still cannot resolve $BASE_REF; aborting"
    echo "VERIFY: fail (base_ref_missing)"
    exit 1
  fi
fi

HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
LOG_DIR="${VERIFY_LOG_DIR:-/tmp/symphony-verify-$HEAD_SHA}"
mkdir -p "$LOG_DIR"

# Pick a package manager.
if command -v pnpm >/dev/null 2>&1; then PM=pnpm
elif command -v yarn >/dev/null 2>&1; then PM=yarn
elif command -v npm  >/dev/null 2>&1; then PM=npm
else PM=""; fi

# ── 1. Changed files & touched packages ─────────────────────────────────────
mapfile -t CHANGED < <(
  { git diff --name-only "$BASE_REF...HEAD"; git diff --name-only; git ls-files --others --exclude-standard; } \
    | sort -u | grep -v '^$' || true
)

if [ "${#CHANGED[@]}" -eq 0 ]; then
  log "[verify] no changes detected vs $BASE_REF"
  echo "VERIFY: pass (no_changes)"
  exit 0
fi

log "[verify] changed files: ${#CHANGED[@]}"
for f in "${CHANGED[@]}"; do log "  $f"; done

declare -A TOUCHED_PACKAGES=()
NON_PACKAGE_CHANGE=0
FIRESTORE_RULES_TOUCHED=0
PACKAGE_JSON_TOUCHED=0
APP_BUILD_INPUT_TOUCHED=0
for f in "${CHANGED[@]}"; do
  if [[ "$f" == packages/*/* ]]; then
    pkg="${f#packages/}"; pkg="${pkg%%/*}"
    TOUCHED_PACKAGES["$pkg"]=1
  else
    NON_PACKAGE_CHANGE=1
  fi
  [[ "$f" == "firestore.rules" || "$f" == *firestore.rules ]] && FIRESTORE_RULES_TOUCHED=1
  [[ "$f" == *package.json ]] && PACKAGE_JSON_TOUCHED=1
  [[ "$f" == packages/app/* && "$f" != packages/app/*test* && "$f" != packages/app/*.md ]] && APP_BUILD_INPUT_TOUCHED=1
done

# ── 2. Parallel job runner ──────────────────────────────────────────────────
# Each check is a function that writes its output to "$LOG_DIR/<name>.log" and
# writes its exit code to "$LOG_DIR/<name>.exit". Exit codes:
#   0   pass
#   77  skipped (tool/config not present, or explicitly skipped)
#   any other → fail
#
# We use `wait -n` for bounded concurrency. Bash ≥ 4.3 required (Symphony's
# target Node 20 environments all have ≥ 4.4).

MAX_JOBS="${VERIFY_PARALLELISM:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
[ "$MAX_JOBS" -lt 1 ] && MAX_JOBS=1
[ "$MAX_JOBS" -gt 8 ] && MAX_JOBS=8
log "[verify] parallelism: $MAX_JOBS"

JOB_NAMES=()
running=0
job_wrap() {
  local name="$1"; shift
  ( "$@" > "$LOG_DIR/$name.log" 2>&1; echo "$?" > "$LOG_DIR/$name.exit" ) &
}
enqueue() {
  local name="$1"; shift
  if is_skipped "$name" || is_skipped "$(printf '%s' "$name" | cut -d: -f1)"; then
    echo "explicitly skipped via VERIFY_SKIP" > "$LOG_DIR/$name.log"
    echo "77" > "$LOG_DIR/$name.exit"
    JOB_NAMES+=("$name")
    return
  fi
  JOB_NAMES+=("$name")
  while [ "$running" -ge "$MAX_JOBS" ]; do
    wait -n 2>/dev/null || true
    running=$((running - 1))
  done
  job_wrap "$name" "$@"
  running=$((running + 1))
}

# ── 2a. Check functions ─────────────────────────────────────────────────────
# Each function returns 0/77/non-zero per the contract above. They MUST NOT
# write to FAILURES/SKIPS arrays (they run in subshells and can't anyway).

# Helper: detect whether a package.json declares a given dependency.
has_dep() {
  local pj="$1" dep="$2"
  [ -f "$pj" ] || return 1
  grep -qE "\"$dep\"[[:space:]]*:" "$pj"
}

check_pkg_script() {
  local pkg="$1" script="$2"
  if [ "$PM" = "pnpm" ]; then
    if ! pnpm --filter "$pkg" run --if-present "$script"; then
      return 1
    fi
    return 0
  fi
  if [ -f "packages/$pkg/package.json" ] && grep -q "\"$script\"" "packages/$pkg/package.json"; then
    ( cd "packages/$pkg" && $PM run "$script" )
    return $?
  fi
  return 77
}

check_root_script() {
  local script="$1"
  [ -z "$PM" ] && return 77
  grep -q "\"$script\"" package.json 2>/dev/null || return 77
  $PM run "$script"
}

# Diff-aware test run. Vitest supports --changed natively; Jest supports
# --changedSince. If neither is detected, fall back to the package's `test`
# script verbatim.
check_pkg_test_changed() {
  local pkg="$1" pj="packages/$1/package.json"
  [ -f "$pj" ] || return 77
  if has_dep "$pj" "vitest"; then
    pnpm --filter "$pkg" exec vitest --run --changed "$BASE_REF"
    return $?
  fi
  if has_dep "$pj" "jest"; then
    pnpm --filter "$pkg" exec jest --changedSince="$BASE_REF" --passWithNoTests
    return $?
  fi
  # No detected runner — defer to package's test script (may run full suite).
  check_pkg_script "$pkg" test
}

# pnpm audit: production deps only, fail on high+ vulnerabilities. Workspace-
# wide because deps are hoisted; running per-package would double-report.
check_audit() {
  [ "$PM" = "pnpm" ] || return 77
  pnpm audit --prod --audit-level high
}

# Dependency-cruiser: architectural boundaries. Needs a config file in the
# repo root (.dependency-cruiser.{js,cjs,mjs,json}).
check_depcruise() {
  command -v node >/dev/null 2>&1 || return 77
  local cfg=""
  for c in .dependency-cruiser.js .dependency-cruiser.cjs .dependency-cruiser.mjs .dependency-cruiser.json; do
    [ -f "$c" ] && cfg="$c" && break
  done
  [ -n "$cfg" ] || return 77
  if pnpm exec --no -- dependency-cruiser --version >/dev/null 2>&1; then
    pnpm exec dependency-cruiser --validate "$cfg" --no-progress -- src packages 2>&1
    return $?
  fi
  return 77
}

# Semgrep: SAST. Uses --config auto for a curated public ruleset. Slow on
# first run (downloads rules). Set SEMGREP_TIMEOUT to override default 60s.
check_semgrep() {
  command -v semgrep >/dev/null 2>&1 || return 77
  local timeout="${SEMGREP_TIMEOUT:-60}"
  # Only scan the touched files — cheaper and the result is what we care about.
  local files=()
  mapfile -t files < <(
    git diff --name-only --diff-filter=AM "$BASE_REF...HEAD" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.py'
  )
  [ "${#files[@]}" -eq 0 ] && return 77
  semgrep --config auto --error --timeout "$timeout" --quiet --no-rewrite-rule-ids "${files[@]}"
}

# Knip: unused exports / files / deps. Runs against the whole repo because
# orphans only manifest at the import-graph level; per-package would miss
# cross-package orphans. Output filtered to only what the current diff
# touched, so the script doesn't fail on pre-existing dead code.
check_knip() {
  [ "$PM" = "pnpm" ] || return 77
  pnpm exec --no -- knip --version >/dev/null 2>&1 || return 77
  # Knip uses exit code 1 when issues are found. We want to allow pre-existing
  # dead code but flag what THIS diff orphaned. Strategy: run with --reporter
  # json, then intersect findings with the changed-file set.
  local out
  out="$(pnpm exec knip --no-progress --reporter json 2>/dev/null || true)"
  [ -z "$out" ] && return 77
  # Treat as fail iff a file orphan or unused-export points at one of the
  # files this diff touched (i.e. the diff created the orphan).
  local changed_pattern
  changed_pattern="$(IFS='|'; printf '%s' "${CHANGED[*]}" | sed 's/[.[\*^$()+?{|/]/\\&/g')"
  [ -z "$changed_pattern" ] && return 0
  local hits
  hits="$(printf '%s' "$out" | grep -E "($changed_pattern)" || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    return 1
  fi
  return 0
}

# Firestore rules tests. Only runs when firestore.rules was touched. Expects
# either a `firestore:test` / `rules:test` / `test:rules` script at the root,
# or a test file at `firestore-tests/` or matching `*rules*.test.{ts,js}`.
check_firestore_rules() {
  [ "$FIRESTORE_RULES_TOUCHED" -eq 1 ] || return 77
  for s in firestore:test rules:test test:rules; do
    if grep -q "\"$s\"" package.json 2>/dev/null; then
      $PM run "$s"
      return $?
    fi
  done
  if [ -d firestore-tests ]; then
    pnpm exec vitest --run firestore-tests
    return $?
  fi
  return 77
}

# Bundle-size budget. Expects a `.bundle-budget.json` describing per-route or
# per-bundle byte limits, and a build script the agent has already run. We
# don't trigger a fresh build here — too slow for a pre-push gate. Operators
# can wire a CI job that builds and then invokes:
#     BUDGET_FILE=.bundle-budget.json bash scripts/verify-changes.sh
check_bundle_size() {
  local budget_file="${BUDGET_FILE:-.bundle-budget.json}"
  [ -f "$budget_file" ] || return 77
  command -v node >/dev/null 2>&1 || return 77
  node - "$budget_file" <<'NODE' || return $?
const fs = require("fs");
const path = require("path");
const budget = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let failed = 0;
for (const [target, limit] of Object.entries(budget)) {
  if (!fs.existsSync(target)) {
    console.warn(`bundle-budget: ${target} not built — run the build before VERIFY (skipping)`);
    continue;
  }
  const size = fs.statSync(target).size;
  if (size > limit) {
    console.error(`bundle-budget: ${target} = ${size}B > limit ${limit}B`);
    failed = 1;
  } else {
    console.log(`bundle-budget: ${target} = ${size}B (limit ${limit}B)`);
  }
}
process.exit(failed);
NODE
}

# ── 2b. Queue the parallel checks ───────────────────────────────────────────

for pkg in "${!TOUCHED_PACKAGES[@]}"; do
  enqueue "$pkg:typecheck" check_pkg_script "$pkg" typecheck
  enqueue "$pkg:lint"      check_pkg_script "$pkg" lint
  enqueue "$pkg:test"      check_pkg_test_changed "$pkg"
done

if [ "$NON_PACKAGE_CHANGE" -eq 1 ]; then
  enqueue "root:typecheck" check_root_script typecheck
  enqueue "root:lint"      check_root_script lint
fi

enqueue audit       check_audit
enqueue depcruise   check_depcruise
enqueue semgrep     check_semgrep
enqueue knip        check_knip
enqueue fb-rules    check_firestore_rules
enqueue bundle-size check_bundle_size

# Wait for all queued jobs.
wait || true

# ── 2c. Collect parallel job results ────────────────────────────────────────
for name in "${JOB_NAMES[@]}"; do
  exit_code="$(cat "$LOG_DIR/$name.exit" 2>/dev/null || echo 1)"
  case "$exit_code" in
    0)  pass "$name" ;;
    77) skip "$name" ;;
    *)  fail "$name (exit=$exit_code, log=$LOG_DIR/$name.log)"
        sed 's/^/    /' "$LOG_DIR/$name.log" | tail -n 30 | log "$(cat)" >/dev/null
        # Print last 30 lines of the failing log so the agent can see why.
        log "$(tail -n 30 "$LOG_DIR/$name.log" 2>/dev/null | sed 's/^/    /')"
        ;;
  esac
done

# ── 3. Forbidden-token scan on the diff (sync) ──────────────────────────────
# Excludes:
#   - docs / lockfiles / snapshots — false positives, not source.
#   - scripts/verify-changes.sh — this file is the scanner itself; it must
#     contain the literal tokens it searches for. Audit it in code review.
DIFF_PATHSPEC=(':!*.md' ':!*.lock' ':!*.snap' ':!scripts/verify-changes.sh')
DIFF_OUT="$(git diff "$BASE_REF...HEAD" -- "${DIFF_PATHSPEC[@]}" 2>/dev/null || true)"
DIFF_OUT+=$'\n'"$(git diff -- "${DIFF_PATHSPEC[@]}" 2>/dev/null || true)"

scan_added_lines() {
  printf '%s\n' "$DIFF_OUT" | awk '/^\+\+\+ /{next} /^\+/{print substr($0,2)}'
}
ADDED="$(scan_added_lines)"

check_token() {
  local label="$1" pattern="$2"
  local hits
  hits="$(printf '%s\n' "$ADDED" | grep -nE "$pattern" || true)"
  if [ -n "$hits" ]; then
    fail "forbidden_token:$label"
    log "$hits" | sed 's/^/    /'
  else
    pass "forbidden_token:$label"
  fi
}

check_token "console.log"       '(^|[^a-zA-Z_])console\.(log|debug)\('
check_token "debugger"          '(^|[^a-zA-Z_])debugger([^a-zA-Z_]|$)'
check_token "as any"            '\bas[[:space:]]+any\b'
check_token "as unknown as"     '\bas[[:space:]]+unknown[[:space:]]+as\b'
check_token ".only("            '\.only\('
check_token ".skip("            '\.skip\('
check_token "xit/xdescribe"     '\b(xit|xdescribe)\('
check_token "TODO/FIXME/XXX"    '(^|[^a-zA-Z_])(TODO|FIXME|XXX)([^a-zA-Z_]|:|$)'

# ── 4. Secret scan on the diff ──────────────────────────────────────────────
secret_hits=""
secret_hits+="$(printf '%s\n' "$ADDED" | grep -nE -- '-----BEGIN [A-Z ]+PRIVATE KEY-----' || true)"
secret_hits+=$'\n'"$(printf '%s\n' "$ADDED" | grep -nE 'sk-[A-Za-z0-9_-]{20,}' || true)"
secret_hits+=$'\n'"$(printf '%s\n' "$ADDED" | grep -nE 'AKIA[0-9A-Z]{16}' || true)"
secret_hits+=$'\n'"$(printf '%s\n' "$ADDED" | grep -nE '(password|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*["'\''][^"'\''[:space:]]{8,}["'\'']' || true)"

secret_hits="$(printf '%s\n' "$secret_hits" | grep -v '^$' || true)"

if [ -n "$secret_hits" ]; then
  filtered="$(printf '%s\n' "$secret_hits" | grep -v '\.env\.example' || true)"
  if [ -n "$filtered" ]; then
    fail "secret_scan"
    printf '%s\n' "$filtered" | sed 's/^/    /'
  else
    pass "secret_scan (only .env.example matches — ignored)"
  fi
else
  pass "secret_scan"
fi

# ── 5. Untracked-leftover scan ──────────────────────────────────────────────
leftovers="$(git ls-files --others --exclude-standard | grep -E '\.(tmp|bak|log|swp|orig|rej)$|~$' || true)"
if [ -n "$leftovers" ]; then
  fail "untracked_leftovers"
  printf '%s\n' "$leftovers" | sed 's/^/    /'
else
  pass "untracked_leftovers"
fi

# ── 6. Tracked-artefact scan on the diff ────────────────────────────────────
# Catches things the agent or a tool accidentally added to the repo that look
# like build/test outputs or stray binaries. The historical-cleanup pass for
# files already tracked lives in `install-verify-tools.sh --audit-tracked`;
# this scan is the per-PR gate that stops new ones from landing.
ADDED_PATHS="$(git diff --name-only --diff-filter=A "$BASE_REF...HEAD" 2>/dev/null || true)"
ADDED_PATHS+=$'\n'"$(git diff --name-only --diff-filter=A 2>/dev/null || true)"
ADDED_PATHS+=$'\n'"$(git ls-files --others --exclude-standard 2>/dev/null || true)"
ADDED_PATHS="$(printf '%s\n' "$ADDED_PATHS" | sort -u | grep -v '^$' || true)"

artefact_hits=""
if [ -n "$ADDED_PATHS" ]; then
  # Build/test/coverage output directories — these should never be tracked.
  artefact_hits+="$(printf '%s\n' "$ADDED_PATHS" | grep -E '(^|/)(dist|build|coverage|playwright-report|test-results|out|\.next|\.nuxt)/' || true)"
  # OS / editor junk.
  artefact_hits+=$'\n'"$(printf '%s\n' "$ADDED_PATHS" | grep -E '(^|/)(\.DS_Store|Thumbs\.db|desktop\.ini)$' || true)"
  # node_modules accidentally added.
  artefact_hits+=$'\n'"$(printf '%s\n' "$ADDED_PATHS" | grep -E '(^|/)node_modules/' || true)"
  # Images >100kb added outside asset/snapshot dirs. The asset_ok regex matches
  # the path patterns the team treats as canonical homes for binary assets.
  ASSET_OK_RE='(^|/)(public|assets|images|static|fonts|media|icons|__image_snapshots__|__screenshots__)/'
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.webp|*.tiff|*.bmp) ;; *) continue ;; esac
    if echo "$f" | grep -qE "$ASSET_OK_RE"; then continue; fi
    [ ! -f "$f" ] && continue
    sz=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$sz" -gt 102400 ]; then
      artefact_hits+=$'\n'"$f  (image >100kb outside asset dir, ${sz}B)"
    fi
  done <<< "$ADDED_PATHS"
fi

artefact_hits="$(printf '%s\n' "$artefact_hits" | grep -v '^$' || true)"
if [ -n "$artefact_hits" ]; then
  fail "tracked_artefacts"
  printf '%s\n' "$artefact_hits" | sed 's/^/    /'
  log "    → If any of these are intentional, justify in workpad and rerun. Otherwise:"
  log "    →   git rm --cached <path>"
  log "    → and add the pattern to .gitignore."
else
  pass "tracked_artefacts"
fi

# ── 7. Verdict ──────────────────────────────────────────────────────────────
TOTAL_RUN=$(( ${#JOB_NAMES[@]} + 12 ))   # parallel jobs + synchronous checks
SKIP_COUNT="${#SKIPS[@]}"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "VERIFY: pass (sha=$HEAD_SHA, packages=${#TOUCHED_PACKAGES[@]}, files=${#CHANGED[@]}, ran=$((TOTAL_RUN - SKIP_COUNT)), skipped=$SKIP_COUNT)"
  exit 0
fi

reasons="$(IFS=,; printf '%s' "${FAILURES[*]}")"
echo "VERIFY: fail (sha=$HEAD_SHA, reasons=$reasons, logs=$LOG_DIR)"
exit 1
