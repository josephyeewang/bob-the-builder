#!/usr/bin/env bash
# selftest-gate-scripts.sh — regression tests for Bob's mechanical checkers:
#   D-016: prove-test-fails.mjs · check-bar.mjs · lane-check.mjs
#   D-017: hooks/block-no-verify.js · hooks/config-protection.js · coverage-check.py ·
#          spec-audit.py's leftover-placeholder check · templates/run-claim.mjs
#
# Rule 28's discipline applied to Bob's own checkers: each check is run against the defect it
# was written for (must catch it) AND against a clean case (must pass it). Everything happens in
# throw-away git repos under a temp folder; nothing in the Bob repo or your projects is touched.
#
# Usage:  bash scripts/selftest-gate-scripts.sh      (exit 0 = all pass)
# Needs:  bash, git, node >= 18, python3.

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

# ── 4. Guard hooks (D-017, from ECC) ─────────────────────────────────────────
# Cases from the 2026-10-27 bake-off (9 must block, 5 must pass) + Bob's core.hooksPath addition.
# ECC's own suites (819 + 16 tests) were also run against these exact files; see D-017.
echo "hooks/block-no-verify.js"
NV="$HERE/hooks/block-no-verify.js"
bash_hook() { node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$1" | node "$NV" >/dev/null; }
while IFS='|' read -r want cmd; do
  [[ -z "$want" ]] && continue
  code=0; [[ "$want" == BLOCK ]] && code=2
  expect "$want: $cmd" "$code" "" -- bash_hook "$cmd"
done <<'CASES'
BLOCK|git commit --no-verify -m "wip"
BLOCK|git commit -n -m "wip"
BLOCK|git -c core.hooksPath=/dev/null commit -m "wip"
BLOCK|git push --no-verify
BLOCK|cd repo && git commit -am fix --no-verify
BLOCK|bash -c 'git commit --no-verify -m x'
BLOCK|git -C /tmp/x commit --no-verify -m x
BLOCK|GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x
BLOCK|git config core.hooksPath /dev/null && git commit -m x
BLOCK|git config --global core.hooksPath /dev/null
BLOCK|git config --global --unset core.hooksPath
BLOCK|git config set core.hooksPath /tmp/x
BLOCK|bash -c 'git -C repo config core.HooksPath ""'
BLOCK|git config --local include.path ../other.cfg
ALLOW|git commit -m "docs: explain why we never use --no-verify"
ALLOW|git log --grep=no-verify
ALLOW|echo "--no-verify is banned"
ALLOW|git commit -m "normal commit"
ALLOW|git status
ALLOW|git config --get core.hooksPath
ALLOW|git config core.hooksPath
ALLOW|git config user.name "Sam Lee"
CASES
expect "block message reaches Claude on stderr" 2 "Git hooks must not be bypassed" -- bash_hook "git commit --no-verify -m x"

echo "hooks/config-protection.js"
CP="$HERE/hooks/config-protection.js"; CPD="$TMP/cp"; mkdir -p "$CPD"
echo '{}' > "$CPD/.eslintrc.json"; : > "$CPD/.eslintignore"; echo '{}' > "$CPD/tsconfig.json"
edit_hook() { node -e 'process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:process.argv[1]}}))' "$1" | node "$CP" >/dev/null; }
expect "editing an existing lint config -> BLOCKED" 2 "BLOCKED: Modifying .eslintrc.json" -- edit_hook "$CPD/.eslintrc.json"
expect "case variant of an existing config -> BLOCKED" 2 "BLOCKED" -- edit_hook "$CPD/.ESLINTRC.JSON"
expect "editing an existing ignore list -> BLOCKED" 2 "BLOCKED" -- edit_hook "$CPD/.eslintignore"
expect "creating a lint config for the first time -> allowed" 0 "" -- edit_hook "$CPD/biome.json"
expect "ordinary source file -> allowed" 0 "" -- edit_hook "$CPD/src/app.ts"
expect "tsconfig.json is NOT covered (known gap, documented in 6b)" 0 "" -- edit_hook "$CPD/tsconfig.json"

# ── 5. coverage-check.py (D-017) ─────────────────────────────────────────────
echo "coverage-check.py"
CC="$HERE/coverage-check.py"; CR="$TMP/cov"; mkdir -p "$CR"
cat > "$CR/good.json" <<'JSON'
{"units":[
 {"id":"U1","state":"covered","files":["api/orders.ts"],"checks":["owner check on GET /orders/:id"]},
 {"id":"U2","state":"deferred","reason":"budget ran out after wave 2"},
 {"id":"U3","state":"blocked","files":["infra/proxy.conf"],"checks":["header pass-through"],"missing_fact":"does the hosting proxy strip X-Forwarded-For?"},
 {"id":"U4","state":"out_of_scope","reason":"marketing site is a separate repo"}],
 "findings":[{"id":"F1","verdict":"needs_checking","missing_fact":"proxy header policy","safe_check":"owner reads the proxy setting"},
             {"id":"F2","verdict":"confirmed","severity":"Major"}],
 "statement":{"planned":4,"covered":1,"candidate":0,"blocked":1,"deferred":1,"out_of_scope":1}}
JSON
expect "a sound record -> OK" 0 "4 units, 0 problem" -- python3 "$CC" "$CR/good.json"
mut() { python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); exec(sys.argv[2]); json.dump(r,open(sys.argv[3],"w"))' "$CR/good.json" "$1" "$CR/$2.json"; }
mut 'r["units"][0]["files"]=[]' cov_noev
expect "covered with no files -> FAIL" 1 "'covered' needs both" -- python3 "$CC" "$CR/cov_noev.json"
mut 'r["units"][1]["reason"]=""' def_noreason
expect "deferred with no reason -> FAIL" 1 "'deferred' needs a reason" -- python3 "$CC" "$CR/def_noreason.json"
mut 'r["units"][1]["checks"]=["half-read the router"]' def_ev
expect "deferred hiding partial evidence -> FAIL" 1 "partial work belongs in 'blocked'" -- python3 "$CC" "$CR/def_ev.json"
mut 'r["units"][2]["missing_fact"]=""' blk
expect "blocked without the missing fact -> FAIL" 1 "must name the missing fact" -- python3 "$CC" "$CR/blk.json"
mut 'r["units"][1]["state"]="planned"; r["units"][1]["reason"]=""; r["statement"]["deferred"]=0' left
expect "unit left 'planned' at close -> FAIL" 1 "still 'planned' at close" -- python3 "$CC" "$CR/left.json"
expect "...but allowed mid-run with --draft" 0 "0 problem" -- python3 "$CC" "$CR/left.json" --draft
mut 'r["findings"][0]["severity"]="Minor"' nc_sev
expect "'needs checking' with a severity -> FAIL" 1 "must carry no severity" -- python3 "$CC" "$CR/nc_sev.json"
mut 'r["statement"]["covered"]=4' stmt
expect "statement counts that don't add up -> FAIL" 1 "covered = 4, the units say 1" -- python3 "$CC" "$CR/stmt.json"
mut 'del r["statement"]' nostmt
expect "no closing statement -> FAIL" 1 "no closing statement" -- python3 "$CC" "$CR/nostmt.json"
mut 'r["units"][1]["id"]="U1"' dup
expect "repeated unit id -> FAIL" 1 "id used twice" -- python3 "$CC" "$CR/dup.json"
expect "unreadable file -> exit 2" 2 "cannot read" -- python3 "$CC" "$CR/none.json"

# ── 6. spec-audit.py leftover-placeholder check (D-017) ──────────────────────
echo "spec-audit.py (check 8)"
SA="$HERE/spec-audit.py"; SP="$TMP/spec.md"
cat > "$SP" <<'SPEC'
# Spec
## Scope
- Orders import from the shop's CSV export.
- The retry budget is TBD pending benchmarks.
- Use `TODO` comments sparingly in code.
SPEC
expect "TBD inside a sentence + quoted TODO -> not flagged" 0 "ok  none" -- python3 "$SA" "$SP"
cat >> "$SP" <<'SPEC'
- TBD: who can see another user's orders
| Refunds | TODO |
- Max file size ???
```
TODO in a code block is fine
```
SPEC
expect "TBD opening a line -> flagged" 1 "spec.md:6: - TBD" -- python3 "$SA" "$SP"
expect "TODO opening a table cell -> flagged" 1 "spec.md:7:" -- python3 "$SA" "$SP"
expect "??? anywhere -> flagged" 1 "spec.md:8:" -- python3 "$SA" "$SP"
expect "fenced code is skipped (exactly 3 hits)" 1 "3 leftover placeholder" -- python3 "$SA" "$SP"

# ── 7. templates/run-claim.mjs (D-017, from ai-employees) ───────────────────
echo "run-claim.mjs"
RC="$HERE/../templates/run-claim.mjs"; mkdir -p "$TMP/rc"
expect "its own self-test (crash expiry, resume, simultaneous fire)" 0 "selftest PASS" -- node "$RC" --selftest
expect "first claim for a period -> go" 0 '"allowed":true' -- node "$RC" claim --job nightly --period 2026-10-27 --budget-minutes 5 --root "$TMP/rc"
expect "second claim, same period, while live -> stop (exit 3)" 3 "another claim is active" -- node "$RC" claim --job nightly --period 2026-10-27 --budget-minutes 5 --root "$TMP/rc"
expect "a refused run is not shown the owner's token" 1 "" -- bash -c "node '$RC' claim --job nightly --period 2026-10-27 --budget-minutes 5 --root '$TMP/rc' | grep -q token"
expect "claim without a period -> refused" 1 "needs --period" -- node "$RC" claim --job nightly --budget-minutes 5 --root "$TMP/rc"

echo
echo "selftest-gate-scripts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
