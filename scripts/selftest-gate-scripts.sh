#!/usr/bin/env bash
# selftest-gate-scripts.sh — regression tests for the three Phase-Gate scripts (D-016):
#   prove-test-fails.mjs · check-bar.mjs · lane-check.mjs
#
# Rule 28's discipline applied to Bob's own checkers: each check is run against the defect it
# was written for (must catch it) AND against a clean case (must pass it). Everything happens in
# throw-away git repos under a temp folder; nothing in the Bob repo or your projects is touched.
#
# Usage:  bash scripts/selftest-gate-scripts.sh      (exit 0 = all pass)
# Needs:  bash, git, node >= 18.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bob-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# expect <name> <wanted-exit> <grep-pattern-or-empty> -- <command...>
expect() {
  local name="$1" want="$2" pattern="$3"; shift 4
  local out code
  set +e; out="$("$@" 2>&1)"; code=$?; set -e
  if [[ "$code" == "$want" ]] && { [[ -z "$pattern" ]] || grep -qE -- "$pattern" <<<"$out"; }; then
    echo "  PASS  $name"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $name (exit $code, wanted $want; pattern: ${pattern:-none})"; sed 's/^/        | /' <<<"$out"
    FAIL=$((FAIL + 1))
  fi
}

newrepo() {
  local dir="$1"; mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email selftest@example.com
  git -C "$dir" config user.name selftest
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config core.hooksPath /dev/null   # don't run the machine's global hooks in scratch repos
}

# ── 1. prove-test-fails.mjs ──────────────────────────────────────────────────
echo "prove-test-fails.mjs"
R="$TMP/prove"; newrepo "$R"
# A tiny module whose fix (lines 2-4) clamps a negative quantity to zero.
cat > "$R/qty.mjs" <<'EOF'
export function qty(n) {
  if (n < 0) {
    return 0;
  }
  return n;
}
EOF
cat > "$R/good.test.mjs" <<'EOF'
import { qty } from './qty.mjs';
if (qty(-5) !== 0) { console.error('qty(-5) should be 0'); process.exit(1); }
EOF
cat > "$R/weak.test.mjs" <<'EOF'
import { qty } from './qty.mjs';
if (qty(3) !== 3) process.exit(1);   // never exercises the fix
EOF
git -C "$R" add -A && git -C "$R" commit -qm "fix: clamp negative qty"
SHA="$(git -C "$R" rev-parse HEAD)"
P="$HERE/prove-test-fails.mjs"

expect "a real test of the fix is PROVEN" 0 "verdict: +PROVEN" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "node good.test.mjs" --fix qty.mjs:2-4
expect "receipt carries the full commit hash" 0 "commit: +$SHA" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "node good.test.mjs" --fix qty.mjs:2-4
expect "a test that ignores the fix is NOT PROVEN" 1 "stays green with the fix removed" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "node weak.test.mjs" --fix qty.mjs:2-4
expect "a test that fails even with the fix is NOT PROVEN" 1 "fails even with the fix in place" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "exit 1" --fix qty.mjs:2-4
expect "no test command -> refused (closes pullboard's no-test gap)" 2 "every fix item must name the test" -- \
  node "$P" --repo "$R" --commit "$SHA" --fix qty.mjs:2-4
expect "test command not found -> cannot run (not a fake FAIL)" 2 "could not start" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "no-such-command-xyz" --fix qty.mjs:2-4
expect "line range past end of file -> refused" 2 "no lines 2-99" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "node good.test.mjs" --fix qty.mjs:2-99
expect "path escaping the repo -> refused" 2 "inside the repo" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "true" --fix ../x.mjs:1-1
expect "builder's own session -> refused" 2 "builder's session" -- \
  env CLAUDE_SESSION_ID=abc node "$P" --repo "$R" --commit "$SHA" --test "true" --fix qty.mjs:2-4 --builder-session abc
# Works at the named commit, not the working tree: break the fix in a later uncommitted edit.
printf 'export function qty(n) { return n; }\n' > "$R/qty.mjs"
expect "runs at the exact commit, ignoring uncommitted edits" 0 "verdict: +PROVEN" -- \
  node "$P" --repo "$R" --commit "$SHA" --test "node good.test.mjs" --fix qty.mjs:2-4
git -C "$R" checkout -q -- qty.mjs
expect "scratch copies are cleaned up" 0 "" -- \
  bash -c "[ \"\$(git -C '$R' worktree list | wc -l | tr -d ' ')\" = 1 ]"

# ── 2. check-bar.mjs ─────────────────────────────────────────────────────────
echo "check-bar.mjs"
B="$HERE/check-bar.mjs"; RP="$TMP/report.md"
cat > "$RP" <<'EOF'
## Phase 1 Report
### [A] Acceptance Bar
<!-- bar:start -->
- orders import end-to-end
- totals reconcile to the source file
<!-- bar:end -->
bar-sha256: UNSET

### [A] Built
- notes that mention "bar changed because" elsewhere must not count as a change record
EOF
expect "unstamped bar -> refused at the gate" 1 "never stamped" -- node "$B" "$RP"
expect "stamp at phase start" 0 "stamped" -- node "$B" --stamp "$RP"
expect "second stamp -> refused" 1 "already stamped" -- node "$B" --stamp "$RP"
expect "unchanged bar -> OK" 0 "OK .*unchanged since phase start" -- node "$B" "$RP"
# Whitespace-only edits are not a change.
sed -i.bak 's/^- orders import end-to-end$/- orders import end-to-end   /' "$RP" && rm -f "$RP.bak"
expect "trailing-space edit is not a change" 0 "OK" -- node "$B" "$RP"
# The defect it exists for: a done-criterion quietly weakened mid-phase.
sed -i.bak 's/totals reconcile to the source file/totals look about right/' "$RP" && rm -f "$RP.bak"
expect "silently moved bar -> REFUSED" 1 "REFUSED .*changed since" -- node "$B" "$RP"
expect "--change with no reason -> refused" 2 "needs a reason" -- node "$B" --change "" "$RP"
expect "--change records a dated explanation" 0 "bar changed because source file has rounding" -- \
  node "$B" --change "source file has rounding; exact match impossible" "$RP"
expect "explained change -> OK" 0 "OK .*1 explained change" -- node "$B" "$RP"
printf '%s\n' "- 2026-10-27 bar changed because  → bar-sha256: $(printf 'a%.0s' {1..64})" > "$TMP/line"
awk -v l="$(cat "$TMP/line")" '/^bar-sha256:/{print; print l; next}1' "$RP" > "$RP.new" && mv "$RP.new" "$RP"
expect "change line with no reason -> refused" 1 "REFUSED" -- node "$B" "$RP"

# ── 3. lane-check.mjs ────────────────────────────────────────────────────────
echo "lane-check.mjs"
L="$HERE/lane-check.mjs"; LR="$TMP/lanes"; newrepo "$LR"; mkdir -p "$LR/docs"
cat > "$LR/docs/lanes.md" <<'EOF'
# Lanes
| lane   | branch prefixes | owns                                         |
|--------|-----------------|----------------------------------------------|
| web    | web/, ui/       | apps/web/, packages/ui/                      |
| api    | api/            | services/api/, contracts/api.yaml            |
| data   | data/           | pipelines/**/*.sql, services/api/schema.sql  |
| shared | -               | docs/, README.md, *.lock                     |
EOF
run_lane() { (cd "$LR" && node "$L" "$@"); }
expect "in-lane files -> OK" 0 "OK" -- run_lane --branch web/login --files apps/web/a.tsx packages/ui/b.tsx docs/x.md
expect "out-of-lane file -> WARN, exit 0" 0 "services/api/x.ts \(api's\)" -- run_lane --branch web/login --files apps/web/a.tsx services/api/x.ts
expect "out-of-lane file -> ENFORCE, exit 1" 1 "Blocked" -- run_lane --enforce --branch web/login --files services/api/x.ts
expect "single-owner file beats folder owner" 1 "services/api/schema.sql \(data's\)" -- run_lane --enforce --branch api/v2 --files services/api/schema.sql
expect "glob owner matches nested path" 0 "OK" -- run_lane --enforce --branch data/x --files pipelines/daily/orders.sql
expect "shared paths open to every lane" 0 "OK" -- run_lane --enforce --branch api/v2 --files README.md package.lock docs/a/b.md
expect "unowned file is the coordinator's" 1 "scripts/x.sh \(coordinator's\)" -- run_lane --enforce --branch api/v2 --files scripts/x.sh
expect "branch with no lane prefix = coordinator" 0 "coordinator" -- run_lane --enforce --branch main --files services/api/x.ts
expect "longest branch prefix wins" 0 "OK" -- run_lane --enforce --branch ui/x --files packages/ui/a.ts
# Staged files (the pre-commit path), on a real branch.
git -C "$LR" checkout -q -b web/feature
mkdir -p "$LR/apps/web" "$LR/services/api"; echo a > "$LR/apps/web/a.ts"; echo b > "$LR/services/api/b.ts"
git -C "$LR" add apps services
expect "reads staged files + current branch" 1 "services/api/b.ts \(api's\)" -- run_lane --enforce
printf 'lane\tbranch prefixes\towns\nweb\tweb/\tapps/web/\n' > "$TMP/lanes.tsv"
expect "TSV register works" 1 "services/api/b.ts \(coordinator's\)" -- run_lane --enforce --register "$TMP/lanes.tsv"
expect "missing register in WARN mode -> note, exit 0" 0 "no lane register" -- run_lane --register "$TMP/none.md"
expect "missing register in ENFORCE mode -> exit 2" 2 "no lane register" -- run_lane --enforce --register "$TMP/none.md"

echo
echo "selftest-gate-scripts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
