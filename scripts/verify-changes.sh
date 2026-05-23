#!/usr/bin/env bash
# verify-changes.sh — pre-push verification gate for a Symphony agent.
#
# Runs every check that has to pass before the agent pushes its branch:
#   1. Scoped lint + typecheck for each touched pnpm package (workspace-wide
#      fallback for non-`packages/` changes).
#   2. Unit tests for each touched package that has a `test` script.
#   3. Forbidden-token scan on the diff (debug noise, casts, skipped tests).
#   4. Secret scan on the diff.
#   5. Untracked-leftover scan inside source trees.
#
# Exits 0 on `VERIFY: pass`, 1 on `VERIFY: fail (<reasons>)`. The agent pastes
# the final line verbatim into `.claude/workpad.md`; the Code Reviewer treats a
# missing or stale `VERIFY pass` note as a Blocking finding.
#
# Designed to run from the workspace root (the cloned target repo, not the
# Symphony orchestrator). Detects pnpm and falls through to npm/yarn for
# non-pnpm repos so the script is usable across projects that adopt it.

set -uo pipefail

BASE_REF="${VERIFY_BASE_REF:-origin/main}"
WORKSPACE_ROOT="$(pwd)"
FAILURES=()

log()  { printf '%s\n' "$*" >&2; }
fail() { FAILURES+=("$1"); log "[verify] FAIL: $1"; }
pass() { log "[verify] OK:   $1"; }

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

# Pick a package manager — pnpm preferred (Symphony's target repos use it),
# otherwise fall back so the script remains useful elsewhere.
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
for f in "${CHANGED[@]}"; do
  if [[ "$f" == packages/*/* ]]; then
    pkg="${f#packages/}"; pkg="${pkg%%/*}"
    TOUCHED_PACKAGES["$pkg"]=1
  else
    NON_PACKAGE_CHANGE=1
  fi
done

# ── 2. Scoped lint + typecheck ──────────────────────────────────────────────
run_pkg_script() {
  local pkg="$1" script="$2"
  if [ "$PM" = "pnpm" ]; then
    if pnpm --filter "$pkg" run --if-present "$script" 2>&1 | tee "/tmp/verify-${pkg}-${script}.log"; then
      pass "$pkg:$script"
      return 0
    else
      fail "$pkg:$script (see /tmp/verify-${pkg}-${script}.log)"
      return 1
    fi
  fi
  # Non-pnpm fallback: run from package dir if it has package.json.
  if [ -f "packages/$pkg/package.json" ] && grep -q "\"$script\"" "packages/$pkg/package.json"; then
    if ( cd "packages/$pkg" && $PM run "$script" ) 2>&1 | tee "/tmp/verify-${pkg}-${script}.log"; then
      pass "$pkg:$script"; return 0
    else
      fail "$pkg:$script (see /tmp/verify-${pkg}-${script}.log)"; return 1
    fi
  fi
  log "[verify] $pkg has no $script script — skipping"
  return 0
}

run_root_script() {
  local script="$1"
  if [ -z "$PM" ]; then
    log "[verify] no package manager detected — skipping $script"
    return 0
  fi
  if ! grep -q "\"$script\"" package.json 2>/dev/null; then
    log "[verify] root package.json has no $script script — skipping"
    return 0
  fi
  if $PM run "$script" 2>&1 | tee "/tmp/verify-root-${script}.log"; then
    pass "root:$script"
    return 0
  else
    fail "root:$script (see /tmp/verify-root-${script}.log)"
    return 1
  fi
}

if [ "${#TOUCHED_PACKAGES[@]}" -gt 0 ]; then
  for pkg in "${!TOUCHED_PACKAGES[@]}"; do
    run_pkg_script "$pkg" typecheck || true
    run_pkg_script "$pkg" lint || true
    run_pkg_script "$pkg" test || true
  done
fi

if [ "$NON_PACKAGE_CHANGE" -eq 1 ]; then
  # Anything outside packages/ (root configs, scripts, top-level src/) gets a
  # workspace-wide pass. Cheap on a warm cache, catches cross-package breakage.
  run_root_script typecheck || true
  run_root_script lint || true
fi

# ── 3. Forbidden-token scan on the diff ─────────────────────────────────────
# Excludes:
#   - docs / lockfiles / snapshots — false positives, not source.
#   - scripts/verify-changes.sh — this file is the scanner itself; it must
#     contain the literal tokens it searches for. Audit it in code review.
DIFF_PATHSPEC=(':!*.md' ':!*.lock' ':!*.snap' ':!scripts/verify-changes.sh')
DIFF_OUT="$(git diff "$BASE_REF...HEAD" -- "${DIFF_PATHSPEC[@]}" 2>/dev/null || true)"
DIFF_OUT+=$'\n'"$(git diff -- "${DIFF_PATHSPEC[@]}" 2>/dev/null || true)"

scan_added_lines() {
  # Print only lines added in the diff (excluding +++ headers).
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

# Strip empty lines from accumulated hits.
secret_hits="$(printf '%s\n' "$secret_hits" | grep -v '^$' || true)"

if [ -n "$secret_hits" ]; then
  # Allow .env.example because it intentionally documents placeholder shape.
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

# ── 6. Verdict ──────────────────────────────────────────────────────────────
HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "VERIFY: pass (sha=$HEAD_SHA, packages=${#TOUCHED_PACKAGES[@]}, files=${#CHANGED[@]})"
  exit 0
fi

reasons="$(IFS=,; printf '%s' "${FAILURES[*]}")"
echo "VERIFY: fail (sha=$HEAD_SHA, reasons=$reasons)"
exit 1
