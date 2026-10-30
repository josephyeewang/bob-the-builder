#!/usr/bin/env bash
# selftest-gate-scripts.sh — regression tests for Bob's mechanical checkers:
#   D-016: prove-test-fails.mjs · check-bar.mjs · lane-check.mjs
#   D-017: hooks/block-no-verify.js · hooks/config-protection.js · coverage-check.py ·
#          spec-audit.py's leftover-placeholder check · templates/run-claim.mjs
#   D-018: hooks/merge-guard.mjs (its own node:test suite, incl. a bob-init scaffold + mutation proof) ·
#          doc-pointers-check.mjs · audit-ledger-check.mjs · templates/loop-check.mjs
#   D-019: bob-upgrade.mjs (/bob UPGRADE, on fixture projects scaffolded from an older Bob) · hooks/warn-only.mjs
#   D-020: bob-upgrade.mjs (own-version detection, green-gate test command, damaged list, pointer target) ·
#          doc-pointers-check.mjs short paths · config-protection.js's required-checks advice · commit-sweep.sh
#
# Rule 28's discipline applied to Bob's own checkers: each check is run against the defect it
# was written for (must catch it) AND against a clean case (must pass it). Everything happens in
# throw-away git repos under a temp folder; nothing in the Bob repo or your projects is touched.
#
# Usage:  bash scripts/selftest-gate-scripts.sh      (exit 0 = all pass)
# Needs:  bash, git, node >= 18, python3.

# The test fixtures below write literal backticks (Markdown code spans) on purpose.
# shellcheck disable=SC2016
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
    echo "  FAIL  $name (exit $code, wanted $want; pattern: ${pattern:-none})"
    # Prefixing every line of a multi-line string reads more clearly with sed.
    # shellcheck disable=SC2001
    sed 's/^/        | /' <<<"$out"
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
# A case variant is the SAME file on a case-insensitive disk (macOS default) and a NEW file on
# Linux, so the right answer depends on the disk: block the existing file, allow a new one.
if [ -e "$CPD/.ESLINTRC.JSON" ]; then
  expect "case variant of an existing config (case-insensitive disk) -> BLOCKED" 2 "BLOCKED" -- edit_hook "$CPD/.ESLINTRC.JSON"
else
  expect "case variant of an existing config (case-sensitive disk: a new file) -> allowed" 0 "" -- edit_hook "$CPD/.ESLINTRC.JSON"
fi
expect "editing an existing ignore list -> BLOCKED" 2 "BLOCKED" -- edit_hook "$CPD/.eslintignore"
expect "creating a lint config for the first time -> allowed" 0 "" -- edit_hook "$CPD/biome.json"
expect "ordinary source file -> allowed" 0 "" -- edit_hook "$CPD/src/app.ts"
expect "tsconfig.json is NOT covered (known gap, documented in 6b)" 0 "" -- edit_hook "$CPD/tsconfig.json"
mkdir -p "$CPD/.claude"; echo '{"required":[]}' > "$CPD/.claude/required-checks.json"
expect "the merge guard's list -> BLOCKED, with the right advice for that file (D-020)" 2 "owner's decision, not Claude's" -- edit_hook "$CPD/.claude/required-checks.json"
expect "... and it says how to reset it" 2 "cp ~/.claude/skills/bob/../templates/required-checks.json .claude/required-checks.json" -- edit_hook "$CPD/.claude/required-checks.json"
no_lint_advice() { ! edit_hook "$CPD/.claude/required-checks.json" 2>&1 | grep -q "Fix the source code"; }
expect "... and never tells Claude to fix the source code" 0 "" -- no_lint_advice

# ── 5. coverage-check.py (D-017) ─────────────────────────────────────────────
echo "coverage-check.py"
CC="$HERE/coverage-check.py"; CR="$TMP/cov"; mkdir -p "$CR"
cat > "$CR/good.json" <<'JSON'
{"units":[
 {"id":"U1","state":"covered","source":"observed","files":["api/orders.ts"],"checks":["owner check on GET /orders/:id"]},
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
mut 'del r["units"][0]["source"]' cov_nosrc
expect "covered with no source -> FAIL" 1 "needs source" -- python3 "$CC" "$CR/cov_nosrc.json"
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

# ── 8. hooks/merge-guard.mjs (D-018) ─────────────────────────────────────────
echo "merge-guard.mjs"
expect "its node:test suite (block/allow table, two stages, scaffolded hook, mutation proof)" 0 "# fail 0" -- \
  node --test --test-reporter=tap "$HERE/hooks/merge-guard.test.mjs"

# ── 9. doc-pointers-check.mjs (D-018) ────────────────────────────────────────
echo "doc-pointers-check.mjs"
DP="$HERE/doc-pointers-check.mjs"; D="$TMP/dp"; mkdir -p "$D/docs"
printf '# Plan\n\n## 1. Scope\n\n## 2. Order of work\n' > "$D/docs/plan.md"
printf '| D-001 | 2026-10-01 | first |\n- **Date:** 2026-10-20\n' > "$D/docs/decision-log.md"
printf '# Manifest\nStatus as of: 2026-10-15\n' > "$D/docs/build-manifest.md"
printf '# Project\n- Plan: `docs/plan.md` — read §2 of docs/plan.md first.\n- Log: `decision-log.md`\n' > "$D/AGENTS.md"
expect "pointers that resolve -> pass" 0 "3 pointer\(s\) checked, 0 broken" -- node "$DP" --root "$D"
printf -- '- Old: docs/retired-plan.md\n' >> "$D/AGENTS.md"
expect "a path that no longer exists -> FAIL" 1 "docs/retired-plan.md, which does not exist" -- node "$DP" --root "$D"
printf 'docs/retired-plan.md\n' > "$D/.bob-optional-pointers"
expect "... unless listed in .bob-optional-pointers" 0 "doc-pointers-check: OK" -- node "$DP" --root "$D"
printf -- '- See §7 of docs/plan.md\n' >> "$D/AGENTS.md"
expect "a renumbered section -> warning only, not a failure (D-020)" 0 "⚠ AGENTS.md cites §7 of docs/plan.md, and no heading there starts with 7" -- node "$DP" --root "$D"
printf -- '- See §4 of docs/gone-log.md\n' > "$D/SECT.md"
expect "a section cited in a file that does not exist -> FAIL" 1 "§4 of docs/gone-log.md, and docs/gone-log.md does not exist" -- node "$DP" --root "$D" --files SECT.md
printf -- '- See §4 of `decision-log.md`\n' > "$D/SECT.md"
expect "a section cited by a bare file name found in docs/ -> the file counts as found" 0 "doc-pointers-check: OK" -- node "$DP" --root "$D" --files SECT.md
# short paths: resolved by a unique match on the end of a real path (D-020)
mkdir -p "$D/supabase/functions/send-email" "$D/a/shared" "$D/b/shared" "$D/node_modules/pkg/send-sms"
: > "$D/supabase/functions/send-email/index.ts"; : > "$D/a/shared/util.ts"; : > "$D/b/shared/util.ts"; : > "$D/node_modules/pkg/send-sms/index.ts"
printf -- '- The handler is in `send-email/index.ts`.\n' > "$D/SHORT.md"
expect "a short path that matches exactly one real file -> found" 0 "1 pointer\(s\) checked, 0 broken" -- node "$DP" --root "$D" --files SHORT.md
printf -- '- The helper is in `shared/util.ts`.\n' > "$D/SHORT.md"
expect "a short path that matches two files -> warning, not failure" 0 "⚠ SHORT.md points at shared/util.ts, which matches 2 files" -- node "$DP" --root "$D" --files SHORT.md
printf -- '- The handler is in `send-fax/index.ts`.\n' > "$D/SHORT.md"
expect "a short path that matches nothing -> FAIL" 1 "SHORT.md points at send-fax/index.ts, which does not exist" -- node "$DP" --root "$D" --files SHORT.md
printf -- '- The handler is in `send-sms/index.ts`.\n' > "$D/SHORT.md"
expect "a match only inside node_modules does not count -> FAIL" 1 "points at send-sms/index.ts, which does not exist" -- node "$DP" --root "$D" --files SHORT.md
rm -rf "$D/SECT.md" "$D/SHORT.md" "$D/supabase" "$D/a" "$D/b" "$D/node_modules"
printf '# Project\n- `nowhere-at-all.md`\n' > "$D/CLAUDE.md"
expect "a bare name found nowhere -> warning only (may live in another install)" 0 "⚠ CLAUDE.md names .nowhere-at-all.md." -- node "$DP" --root "$D"
printf '# Project\n- docs/specs/missing.md\n' > "$D/CLAUDE.md"
expect "CLAUDE.md is checked too (a missing path) -> FAIL" 1 "CLAUDE.md points at docs/specs/missing.md" -- node "$DP" --root "$D"
rm "$D/CLAUDE.md"; printf '# Project\n- Plan: `docs/plan.md`\n' > "$D/AGENTS.md"
expect "status 5 days behind the newest decision (limit 7) -> pass" 0 "doc-pointers-check: OK" -- \
  node "$DP" --root "$D" --status docs/build-manifest.md --log docs/decision-log.md
expect "status 5 days behind with --max-lag 4 -> FAIL" 1 "5 days later; the limit is 4" -- \
  node "$DP" --root "$D" --status docs/build-manifest.md --log docs/decision-log.md --max-lag 4
printf '> **2026-10-30 — a later state entry\n' > "$D/docs/PROJECT-STATE.md"
expect "a newer PROJECT-STATE entry counts (15 days) -> FAIL" 1 "15 days later" -- \
  node "$DP" --root "$D" --status docs/build-manifest.md --log docs/decision-log.md --also docs/PROJECT-STATE.md
printf '# Manifest\n' > "$D/docs/build-manifest.md"
expect "no as-of date -> warning only" 0 "carries no \"Status as of" -- \
  node "$DP" --root "$D" --status docs/build-manifest.md --log docs/decision-log.md
expect "no as-of date with --require-asof -> FAIL" 1 "carries no \"Status as of" -- \
  node "$DP" --root "$D" --status docs/build-manifest.md --log docs/decision-log.md --require-asof
expect "coherence-check.sh runs it on the root file (class 8)" 1 "\[8\] Root instruction file" -- \
  bash -c "printf -- '- Gone: docs/gone.md\n' >> '$D/AGENTS.md'; bash '$HERE/coherence-check.sh' '$D/docs'"
expect "Bob's own root files pass" 0 "doc-pointers-check: OK" -- node "$DP" --root "$HERE/.."
HL="$TMP/headlog"; mkdir -p "$HL"
printf '# Decision Log\n\n### D-001: a\n\n### D-002: b\n\n### D-002: c\n' > "$HL/decision-log.md"
expect "coherence-check.sh: a duplicate ### D-NNN heading -> FAIL" 1 "DUPLICATE IDs: D-002" -- bash "$HERE/coherence-check.sh" "$HL"
printf '# Decision Log\n\n### D-001: a\n\n### D-002: b\n' > "$HL/decision-log.md"
expect "coherence-check.sh: unique ### D-NNN headings -> pass" 0 "no duplicate IDs" -- bash "$HERE/coherence-check.sh" "$HL"
printf '# Decision Log\n\n| ID | Title |\n|---|---|\n| D-001 | a |\n| D-002 | b |\n\n### D-001: a\n\n### D-002: b\n' > "$HL/decision-log.md"
expect "coherence-check.sh: a summary table AND a heading per entry -> pass" 0 "no duplicate IDs" -- bash "$HERE/coherence-check.sh" "$HL"
printf '# Decision Log\n\n| D-001 | a |\n| D-001 | b |\n' > "$HL/decision-log.md"
expect "coherence-check.sh: a duplicate table row -> FAIL" 1 "DUPLICATE IDs: D-001" -- bash "$HERE/coherence-check.sh" "$HL"
printf '# Decision Log\n\n### D-001: a\n' > "$HL/decision-log.md"
printf '# Audit steps\n' > "$HL/audit.md"
expect "coherence-check.sh: an audit-named doc with no banner -> warning" 0 "audit.md looks dated/secondary" -- bash "$HERE/coherence-check.sh" "$HL"
printf '# Audit steps\n<!-- living doc -->\n' > "$HL/audit.md"
expect "coherence-check.sh: the living-doc marker silences that warning" 0 "" -- \
  bash -c "! bash '$HERE/coherence-check.sh' '$HL' | grep -q 'audit.md looks dated'"
rm "$HL/audit.md"
expect "coherence-check.sh: Bob's own doc set is clean" 0 "no mechanical drift" -- bash "$HERE/coherence-check.sh" "$HERE/.."

# ── 10. audit-ledger-check.mjs (D-018) ───────────────────────────────────────
echo "audit-ledger-check.mjs"
AL="$HERE/audit-ledger-check.mjs"; L="$TMP/al"; mkdir -p "$L"
expect "the template itself passes" 0 "audit-ledger-check: OK" -- node "$AL" "$HERE/../templates/audit-ledger.json"
lmut() { # lmut <python-statements on dict l> <name>
  python3 - "$HERE/../templates/audit-ledger.json" "$L/$2.json" "$1" <<'PYM'
import json, sys
l = json.load(open(sys.argv[1]))
e = lambda ran, cls, tier, found, **kw: dict(audit=f"{cls}@{ran}", ran=ran, tier=tier, class_of_work=cls, material_found=found, material_remaining=0, minor=0, cosmetic=0, auditor_context="fresh subagent", **kw)
exec(sys.argv[3])
json.dump(l, open(sys.argv[2], "w"))
PYM
}
lmut 'l["entries"]=[e("2026-10-0%d"%d,"ui",1,0) for d in range(1,6)] + [e("2026-10-01","outputs",1,1), e("2026-10-02","outputs",1,0), e("2026-10-03","outputs",2,3), e("2026-10-04","outputs",1,0,rounds=0)]' good
expect "five clean Tier-1 ui audits -> propose Tier 2" 0 "ui +5  → propose Tier 2" -- node "$AL" "$L/good.json" --streaks
expect "Tier 2 and rounds=0 skipped; a Material stops the streak" 0 "outputs +1   stopped by: outputs@2026-10-01 .*1 Material" -- node "$AL" "$L/good.json" --streaks
lmut 'l["entries"]=[e("2026-10-01","ingestion",1,0)]' badclass
expect "a class outside the vocabulary -> FAIL" 1 'class_of_work "ingestion" is not in the vocabulary' -- node "$AL" "$L/badclass.json"
lmut 'l["entries"]=[e("2026-10-01","ui",1,None)]' nullnew
expect "a null count on a new entry -> FAIL" 1 "new entry has null material_found" -- node "$AL" "$L/nullnew.json"
lmut 'l["format"]["legacy_entry_count"]=1; l["entries"]=[e("2026-10-01","ui",1,None,unrecorded=["material_found"])]' legacy
expect "... allowed on a migrated entry that declares it unrecorded" 0 "audit-ledger-check: OK" -- node "$AL" "$L/legacy.json"
lmut 'l["entries"]=[dict(e("2026-10-01","ui",1,2), material_remaining=3)]' remaining
expect "material_remaining > material_found -> FAIL" 1 "material_remaining > material_found" -- node "$AL" "$L/remaining.json"
lmut 'x=e("2026-10-01","ui",1,0); x["material"]=0; l["entries"]=[x]' oldfield
expect "an old count field name -> FAIL" 1 'old field name "material"' -- node "$AL" "$L/oldfield.json"
lmut 'del l["format"]["class_of_work_vocabulary"]["mixed"]' nomixed
expect "a vocabulary without 'mixed' -> FAIL" 1 'no "mixed" value' -- node "$AL" "$L/nomixed.json"
expect "no ledger at all -> exit 2" 2 "cannot read" -- node "$AL" "$L/none.json"

# ── 11. templates/loop-check.mjs (D-018) ─────────────────────────────────────
echo "loop-check.mjs"
LC="$HERE/../templates/loop-check.mjs"; LR="$TMP/lc"; mkdir -p "$LR/docs" "$LR/.github/workflows"
NOW=2026-10-27T12:00:00Z
echo '[]' > "$LR/prs.json"; echo '{}' > "$LR/runs.json"
LCA=(--root "$LR" --now "$NOW" --prs-file "$LR/prs.json" --runs-file "$LR/runs.json")
expect "an empty project -> nothing flagged" 0 "Nothing flagged" -- node "$LC" "${LCA[@]}"
cat > "$LR/prs.json" <<'J'
[{"number":7,"title":"plan: next steps","updatedAt":"2026-10-20T10:00:00Z","isDraft":false,"labels":[{"name":"HOLD"}]},
 {"number":8,"title":"parked on purpose","updatedAt":"2026-10-01T10:00:00Z","isDraft":false,"labels":[{"name":"hold-until:2026-11-03"}]},
 {"number":9,"title":"typo hold","updatedAt":"2026-10-01T10:00:00Z","isDraft":false,"labels":[{"name":"hold-until:2026-13-45"}]},
 {"number":10,"title":"fresh","updatedAt":"2026-10-27T08:00:00Z","isDraft":false,"labels":[]}]
J
expect "a PR open 7 days with an undated HOLD -> flagged" 1 "#7 plan: next steps — not updated for 7.1 days" -- node "$LC" "${LCA[@]}"
expect "a dated hold in force exempts (and is listed)" 1 "on hold: #8 held until 2026-11-03" -- node "$LC" "${LCA[@]}"
expect "a malformed hold label exempts nothing" 1 '"hold-until:2026-13-45" is not a valid' -- node "$LC" "${LCA[@]}"
expect "--report-only exits 0 even when flagged" 0 "item\(s\) flagged" -- node "$LC" "${LCA[@]}" --report-only
echo '[]' > "$LR/prs.json"
cp "$HERE/../templates/open-loops.md" "$LR/docs/open-loops.md"
cat >> "$LR/docs/open-loops.md" <<'J'
| L-004 | homeless finding | | | | | open |
| L-005 | overdue | coordinator | ship it | 2026-10-01 | | waiting |
| L-005 | duplicate id | coordinator | x | 2026-11-01 | | open |
| L-006 | closed by say-so | coordinator | — | — | done | closed |
| L-007 | odd status | coordinator | x | 2026-11-01 | | in progress |
J
python3 -c "print('| L-008 | ' + 'x'*620 + ' | coordinator | x | 2026-11-01 | | open |')" >> "$LR/docs/open-loops.md"
expect "a row with no owner, next action or due date -> flagged" 1 "L-004: open with no owner" -- node "$LC" "${LCA[@]}"
expect "a row past its due date -> flagged" 1 "L-005: past its due date \(2026-10-01\)" -- node "$LC" "${LCA[@]}"
expect "a duplicate row ID -> flagged" 1 "L-005: duplicate ID" -- node "$LC" "${LCA[@]}"
expect "closed with 'done' as proof -> flagged" 1 "L-006: closed with no closing proof" -- node "$LC" "${LCA[@]}"
expect "a fourth status word -> flagged" 1 'status "in progress"' -- node "$LC" "${LCA[@]}"
expect "a row over 600 bytes -> flagged" 1 "L-008: row is [0-9]+ bytes \(limit 600\)" -- node "$LC" "${LCA[@]}"
rm "$LR/docs/open-loops.md"
printf '| # | Item | Status |\n|---|---|---|\n| D1 | a | open |\n| D2 | b | open |\n| D3 | c | done |\n' > "$LR/docs/deferred-actions.md"
echo '{"intake":{"cap":1}}' > "$LR/.github/loop-check.json"
expect "an intake list over its cap -> flagged" 1 "2 open rows, over the cap of 1" -- node "$LC" "${LCA[@]}"
rm "$LR/.github/loop-check.json" "$LR/docs/deferred-actions.md"
printf 'on:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  x:\n    steps:\n      - run: make nightly || true\n' > "$LR/.github/workflows/nightly.yml"
echo '{"nightly.yml":[{"status":"completed","conclusion":"failure","createdAt":"2026-10-27T03:00:00Z"},{"status":"completed","conclusion":"failure","createdAt":"2026-10-26T03:00:00Z"},{"status":"completed","conclusion":"success","createdAt":"2026-10-25T03:00:00Z"}]}' > "$LR/runs.json"
expect "a scheduled job failing two runs in a row -> flagged" 1 'nightly.yml: the last two finished runs both ended "failure", "failure"' -- node "$LC" "${LCA[@]}"
expect "a job that swallows failures is named" 1 "nightly.yml swallows failures" -- node "$LC" "${LCA[@]}"
echo '{"nightly.yml":[{"status":"completed","conclusion":"success","createdAt":"2026-10-24T03:00:00Z"}]}' > "$LR/runs.json"
expect "a daily job silent for 3+ days -> flagged" 1 "nightly.yml: silent" -- node "$LC" "${LCA[@]}"
echo '{"nightly.yml":[{"status":"completed","conclusion":"failure","createdAt":"2026-10-27T03:00:00Z"},{"status":"completed","conclusion":"success","createdAt":"2026-10-26T03:00:00Z"}]}' > "$LR/runs.json"
expect "one failure then a success -> not flagged (two in a row only)" 0 "Nothing flagged" -- node "$LC" "${LCA[@]}"
echo '{"heartbeats":[{"path":"logs/hb.txt","max_age_hours":30}]}' > "$LR/.github/loop-check.json"
expect "a heartbeat that was never written -> flagged" 1 "heartbeat logs/hb.txt: missing" -- node "$LC" "${LCA[@]}"

# ── 12. bob-upgrade.mjs + hooks/warn-only.mjs (D-019) ────────────────────────
# Fixture projects scaffolded from an OLDER Bob: a throw-away git copy of the parts bob-init and
# bob-upgrade read, whose first commit carries an older config-protection.js; its second commit
# restores the current one (a "D-018" change). Then: a fresh project, a project with pieces
# missing, one with deliberate differences, and one with no install record.
echo "bob-upgrade.mjs"
UG="$TMP/ug"; OB="$UG/bob"; mkdir -p "$OB"
printf '[user]\n\tname = selftest\n\temail = selftest@example.com\n[core]\n\thooksPath = /dev/null\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' > "$UG/gitconfig"
cp -R "$HERE/../scripts" "$HERE/../templates" "$OB/"
cp "$HERE/../build-protocol-core.md" "$HERE/../decision-log.md" "$HERE/../VERSION" "$OB/"
newrepo "$OB"
echo "// an older line from an earlier Bob" >> "$OB/scripts/hooks/config-protection.js"
git -C "$OB" add -A && git -C "$OB" commit -qm "older Bob (D-017)"
OLD="$(git -C "$OB" rev-parse HEAD)"
scaffold() { (cd "$UG" && GIT_CONFIG_GLOBAL="$UG/gitconfig" GIT_CONFIG_NOSYSTEM=1 bash "$OB/scripts/bob-init.sh" "$1" >/dev/null 2>&1); }
ub() { local d="$1"; shift; (cd "$UG/$d" && GIT_CONFIG_GLOBAL="$UG/gitconfig" GIT_CONFIG_NOSYSTEM=1 node "$OB/scripts/bob-upgrade.mjs" --today 2026-01-02 "$@"); }
scaffold older; scaffold purpose; scaffold nomanifest
cp "$HERE/hooks/config-protection.js" "$OB/scripts/hooks/config-protection.js"
git -C "$OB" commit -qam "Config protection also guards the required-checks list — D-018"
scaffold fresh
expect "bob-init writes an install record naming the Bob commit" 0 "\"bob_commit\": \"$OLD\"" -- cat "$UG/older/.bob/installed.json"
expect "a fresh project: everything up to date" 0 "Nothing is out of date" -- ub fresh
expect "bob-upgrade names Bob's version from VERSION (D-032)" 0 "Bob available here: $(head -1 "$HERE/../VERSION")" -- ub fresh
mv "$OB/VERSION" "$OB/VERSION.off"; printf '\n*Core Reference for Build Protocol v9.9 — an older Bob*\n' >> "$OB/build-protocol-core.md"
expect "bob-upgrade: a Bob from before VERSION -> reads the old core line" 0 "Bob available here: v9.9" -- ub fresh
mv "$OB/VERSION.off" "$OB/VERSION"
expect "a fresh project: the commit-time check starts blocking" 0 '"commit_sweep": "block"' -- cat "$UG/fresh/.bob/installed.json"
# 'older': simulate pieces Bob added after this project was set up (gone, and never recorded).
node -e '
  const fs=require("fs"),d=process.argv[1],s=JSON.parse(fs.readFileSync(d+"/.claude/settings.json","utf8"));
  s.hooks.PreToolUse=s.hooks.PreToolUse.filter(e=>!e.hooks.some(h=>/merge-guard|block-no-verify/.test(h.command)));
  fs.writeFileSync(d+"/.claude/settings.json",JSON.stringify(s,null,2));
  const m=JSON.parse(fs.readFileSync(d+"/.bob/installed.json","utf8"));
  for (const k of ["merge-guard","merge-guard-settings-bash","merge-guard-settings-monitor","guard-settings-block-no-verify"]) delete m.pieces[k];
  fs.writeFileSync(d+"/.bob/installed.json",JSON.stringify(m,null,2));' "$UG/older"
rm "$UG/older/.claude/hooks/merge-guard.mjs"
echo "my own file" > "$UG/older/notes.txt"; git -C "$UG/older" add -A; GIT_CONFIG_GLOBAL="$UG/gitconfig" git -C "$UG/older" commit -qm "project work"
expect "older install: Bob's newer hook is named, with the decision behind it" 0 "Why Bob changed it: D-018" -- ub older
expect "older install: the newer item is the right one" 0 "\[guard-config-protection\] .claude/hooks/config-protection.js" -- ub older
expect "older install: pieces new in Bob are listed as missing" 0 "Missing — added to Bob since this project was set up \(4\)" -- ub older
expect "older install: a blocking hook is offered in trial mode first" 0 "Starts in trial mode" -- ub older
expect "older install: the reverse question is asked" 0 "Does this project do something better than Bob\?" -- ub older
expect "the report changes nothing" 0 "^$" -- git -C "$UG/older" status --porcelain
expect "an unknown item is refused" 2 "unknown item" -- ub older --apply no-such-thing
expect "--apply all applies the safe items" 0 "\[guard-settings-block-no-verify\]: added in trial mode" -- ub older --apply all
expect "the replaced file was backed up first" 0 "an older line from an earlier Bob" -- cat "$UG/older/.bob/backups/2026-01-02/.claude/hooks/config-protection.js"
expect "the newer version is now in place" 1 "" -- grep -q "an older line" "$UG/older/.claude/hooks/config-protection.js"
expect "the merge guard is wired (no warn-only mode for it)" 0 'merge-guard.mjs' -- node -e 'const s=require(process.argv[1]);const c=s.hooks.PreToolUse.flatMap(e=>e.hooks).map(h=>h.command).filter(c=>c.includes("merge-guard"));if(c.length!==2||c.some(x=>x.includes("warn-only")))process.exit(1);console.log("merge-guard.mjs")' "$UG/older/.claude/settings.json"
expect "nothing outside Bob's pieces was touched" 0 "^$" -- bash -c "git -C '$UG/older' status --porcelain | grep -vE ' (\.claude/|\.bob/)' || true"
expect "after applying, the report is clean" 0 "Nothing is out of date" -- ub older
WCMD="$(node -e 'const s=require(process.argv[1]);console.log(s.hooks.PreToolUse.flatMap(e=>e.hooks).map(h=>h.command).find(c=>c.includes("block-no-verify")))' "$UG/older/.claude/settings.json")"
NOVERIFY='{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m x"}}'
hookrun() { printf '%s' "$NOVERIFY" | CLAUDE_PROJECT_DIR="$UG/older" bash -c "$1"; }
expect "warn-only: the hook says it would have blocked, and lets it through" 0 "WOULD HAVE BLOCKED" -- hookrun "$WCMD"
expect "--enforce switches it on" 0 "switched on: it now stops" -- ub older --enforce guard-settings-block-no-verify
ECMD="$(node -e 'const s=require(process.argv[1]);console.log(s.hooks.PreToolUse.flatMap(e=>e.hooks).map(h=>h.command).find(c=>c.includes("block-no-verify")))' "$UG/older/.claude/settings.json")"
expect "enforced: the same command is now blocked" 2 "" -- hookrun "$ECMD"
# 'purpose': a deliberate difference is left alone; an unexplained one is reported, and only replaced when named.
echo "# runs at a different hour here" >> "$UG/purpose/.github/workflows/loop-check.yml"
echo "- loop-check-workflow: runs at a different hour, after the nightly import" >> "$UG/purpose/.bob/differences.md"
echo "Extra line added by the project." >> "$UG/purpose/.claude/agents/reviewer.md"
cp "$UG/purpose/.github/workflows/loop-check.yml" "$UG/purpose-loop.yml"
expect "a listed difference is shown with its reason" 0 "Reason recorded: runs at a different hour" -- ub purpose
expect "an unlisted change is flagged as reason-not-written-down" 0 "\[reviewer-agent\]" -- ub purpose
expect "--apply all" 0 "" -- ub purpose --apply all
expect "--apply all left the listed difference alone" 0 "" -- cmp "$UG/purpose-loop.yml" "$UG/purpose/.github/workflows/loop-check.yml"
expect "--apply all left the unexplained change alone too" 0 "" -- grep -q "Extra line added by the project" "$UG/purpose/.claude/agents/reviewer.md"
expect "a listed difference is refused even when named" 0 "left alone — listed in .bob/differences.md" -- ub purpose --apply loop-check-workflow
expect "naming the unexplained one replaces it" 0 "\[reviewer-agent\]: installed Bob's current version" -- ub purpose --apply reviewer-agent
expect "... after backing it up" 0 "" -- grep -q "Extra line added by the project" "$UG/purpose/.bob/backups/2026-01-02/.claude/agents/reviewer.md"
# 'nomanifest': no install record — compared against Bob's history instead.
rm -rf "$UG/nomanifest/.bob"
sed -i.bak 's|^TEST_CMD=.*|TEST_CMD="npm test"|' "$UG/nomanifest/.claude/hooks/green-gate.sh"
echo "// changed by the project" >> "$UG/nomanifest/scripts/loop-check.mjs"
expect "no record: says so" 0 "has no install record" -- ub nomanifest
expect "no record: an old Bob copy is recognised from Bob's history" 0 "matches Bob's copy from commit ${OLD:0:7}" -- ub nomanifest
expect "no record: a project's own test command does not count as a change" 0 "merge-guard-lib, green-gate, reviewer-agent" -- ub nomanifest
expect "no record: an unknown change is 'can't tell'" 0 "can't tell who changed it \(1\)" -- ub nomanifest
echo "# a stray line" >> "$UG/nomanifest/.claude/hooks/green-gate.sh"
expect "naming green-gate updates it" 0 "" -- ub nomanifest --apply green-gate
expect "... keeping the project's own test command" 0 '^TEST_CMD="npm test"$' -- cat "$UG/nomanifest/.claude/hooks/green-gate.sh"
expect "... and recording what it installed" 0 '"green-gate"' -- cat "$UG/nomanifest/.bob/installed.json"
expect "a project that upgrades starts the commit-time check warn-only" 0 '"commit_sweep": "warn"' -- cat "$UG/nomanifest/.bob/installed.json"
# the commit-time check: refused while the documents fail, switched on once they pass.
mkdir -p "$UG/nomanifest/docs"; printf '# Build Manifest\n\nStatus as of: 2026-01-02\n' > "$UG/nomanifest/docs/build-manifest.md"
echo "See \`docs/missing-plan.md\` for the plan." >> "$UG/nomanifest/CLAUDE.md"
expect "a failing document check is reported with its problems" 0 "missing-plan.md" -- ub nomanifest
expect "switching it to blocking is refused while it fails" 0 "NOT switched" -- ub nomanifest --apply commit-sweep
sed -i.bak '/missing-plan/d' "$UG/nomanifest/CLAUDE.md"; for f in product-spec architecture; do echo "# $f" > "$UG/nomanifest/docs/$f.md"; done
expect "once it passes, it can be switched on" 0 "switched on: a commit with serious" -- ub nomanifest --apply commit-sweep
expect "... and the record says so" 0 '"commit_sweep": "block"' -- cat "$UG/nomanifest/.bob/installed.json"

# ── 13. bob-upgrade.mjs, D-020: the project's own version · green gate's test command · damaged list · pointer ─
echo "bob-upgrade.mjs (D-020)"
scaffold ownmg; scaffold ownlc; scaffold gg; scaffold ptr
# 'ownmg': the project runs its OWN merge guard from scripts/, wired in .claude/settings.json; Bob's is absent.
node -e '
  const fs=require("fs"),d=process.argv[1],s=JSON.parse(fs.readFileSync(d+"/.claude/settings.json","utf8"));
  s.hooks.PreToolUse=s.hooks.PreToolUse.filter(e=>!e.hooks.some(h=>/merge-guard/.test(h.command)));
  s.hooks.PreToolUse.push({matcher:"Bash",hooks:[{type:"command",command:"node \"$CLAUDE_PROJECT_DIR/scripts/merge-guard.mjs\""}]});
  fs.writeFileSync(d+"/.claude/settings.json",JSON.stringify(s,null,2));
  const m=JSON.parse(fs.readFileSync(d+"/.bob/installed.json","utf8"));
  for (const k of Object.keys(m.pieces)) if (/merge-guard/.test(k)) delete m.pieces[k];
  fs.writeFileSync(d+"/.bob/installed.json",JSON.stringify(m,null,2));' "$UG/ownmg"
rm -f "$UG/ownmg/.claude/hooks/merge-guard.mjs" "$UG/ownmg/.claude/hooks/lib/merge-guard.mjs" "$UG/ownmg/.claude/required-checks.json"
mkdir -p "$UG/ownmg/scripts"; echo "// this project's own merge guard" > "$UG/ownmg/scripts/merge-guard.mjs"
expect "own merge guard: reported as the project's own version, with its path" 0 "Project has its own version \(scripts/merge-guard.mjs" -- ub ownmg
expect "own merge guard: not called missing" 0 "" -- bash -c "! (cd '$UG/ownmg' && GIT_CONFIG_GLOBAL='$UG/gitconfig' node '$OB/scripts/bob-upgrade.mjs' --today 2026-01-02) | grep -q '^Missing'"
expect "own merge guard: --apply all leaves it alone and says so" 0 "Not applied:" -- ub ownmg --apply all
expect "... Bob's merge guard was not added beside it" 1 "" -- test -e "$UG/ownmg/.claude/hooks/merge-guard.mjs"
expect "... and no second merge-guard entry was wired" 0 "" -- node -e 'const s=require(process.argv[1]);const n=s.hooks.PreToolUse.flatMap(e=>e.hooks).filter(h=>/merge-guard/.test(h.command)).length;process.exit(n===1?0:1)' "$UG/ownmg/.claude/settings.json"
# 'ownlc': the project has its own daily loop check (a TypeScript one).
rm -f "$UG/ownlc/scripts/loop-check.mjs" "$UG/ownlc/.github/workflows/loop-check.yml"
node -e 'const fs=require("fs"),f=process.argv[1]+"/.bob/installed.json",m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.pieces["loop-check-script"];delete m.pieces["loop-check-workflow"];fs.writeFileSync(f,JSON.stringify(m,null,2))' "$UG/ownlc"
echo "// this project's own loop check" > "$UG/ownlc/scripts/loop-check.ts"
expect "own loop check: reported as the project's own version" 0 "Project has its own version \(scripts/loop-check.ts\)" -- ub ownlc
expect "own loop check: --apply all does not install Bob's" 0 "" -- bash -c "ub_() { (cd '$UG/ownlc' && GIT_CONFIG_GLOBAL='$UG/gitconfig' node '$OB/scripts/bob-upgrade.mjs' --today 2026-01-02 --apply all >/dev/null); }; ub_ && test ! -e '$UG/ownlc/scripts/loop-check.mjs'"
# 'gg': the green gate is not switched on and still has Bob's placeholder test command.
node -e '
  const fs=require("fs"),d=process.argv[1],s=JSON.parse(fs.readFileSync(d+"/.claude/settings.json","utf8"));
  delete s.hooks.Stop; fs.writeFileSync(d+"/.claude/settings.json",JSON.stringify(s,null,2));
  const f=d+"/.bob/installed.json",m=JSON.parse(fs.readFileSync(f,"utf8"));delete m.pieces["green-gate-settings"];fs.writeFileSync(f,JSON.stringify(m,null,2));' "$UG/gg"
expect "green gate with the placeholder: 'needs your test command first'" 0 "needs your test command first" -- ub gg
expect "... says how to set it" 0 "find the line that starts TEST_CMD=" -- ub gg
expect "... --apply all does not switch it on" 0 "Not applied:" -- ub gg --apply all
expect "... (no Stop entry was added)" 0 "" -- node -e 'const s=require(process.argv[1]);process.exit(s.hooks.Stop?1:0)' "$UG/gg/.claude/settings.json"
expect "... naming it is refused too" 0 "not switched on — needs your test command first" -- ub gg --apply green-gate-settings
sed -i.bak 's|^TEST_CMD=.*|TEST_CMD="true"|' "$UG/gg/.claude/hooks/green-gate.sh"
expect "with a real test command it can be added (trial mode first)" 0 "\[green-gate-settings\]: added in trial mode" -- ub gg --apply green-gate-settings
cp "$UG/gg/.claude/hooks/green-gate.sh.bak" "$UG/gg/.claude/hooks/green-gate.sh"
expect "--enforce refuses while the placeholder is back" 0 "refused — needs your test command first" -- ub gg --enforce green-gate-settings
expect "... and it stayed in trial mode" 0 "" -- grep -q 'warn-only.mjs.* green-gate.sh' "$UG/gg/.claude/settings.json"
sed -i.bak 's|^TEST_CMD=.*|TEST_CMD="true"|' "$UG/gg/.claude/hooks/green-gate.sh"
expect "--enforce works once the test command is set" 0 "switched on: it now stops" -- ub gg --enforce green-gate-settings
# a damaged required-checks list: offered, never restored by --apply all, restored when named (backed up first).
echo "{ not json" > "$UG/gg/.claude/required-checks.json"
expect "a damaged required-checks list is reported" 0 "Damaged — the merge guard cannot read it" -- ub gg
expect "... with the way to restore it" 0 "--apply required-checks" -- ub gg
expect "... --apply all leaves it alone" 0 "" -- bash -c "(cd '$UG/gg' && GIT_CONFIG_GLOBAL='$UG/gitconfig' node '$OB/scripts/bob-upgrade.mjs' --today 2026-01-02 --apply all >/dev/null) && grep -q 'not json' '$UG/gg/.claude/required-checks.json'"
expect "... naming it restores Bob's starting list" 0 "restored Bob's starting list" -- ub gg --apply required-checks
expect "... which the merge guard can read" 0 "" -- node -e 'const s=require(process.argv[1]);process.exit(Array.isArray(s.required)?0:1)' "$UG/gg/.claude/required-checks.json"
expect "... and the damaged copy was backed up" 0 "not json" -- cat "$UG/gg/.bob/backups/2026-01-02/.claude/required-checks.json"
# 'ptr': CLAUDE.md only imports AGENTS.md — the Bob pointer goes into AGENTS.md.
printf '@AGENTS.md\n' > "$UG/ptr/CLAUDE.md"; printf '# ptr\n\nProject facts only.\n' > "$UG/ptr/AGENTS.md"
expect "pointer: goes into AGENTS.md when CLAUDE.md is only '@AGENTS.md'" 0 "section to AGENTS.md" -- ub ptr --apply bob-pointer
expect "... CLAUDE.md is untouched" 0 "" -- bash -c "[ \"\$(cat '$UG/ptr/CLAUDE.md')\" = '@AGENTS.md' ]"
# cosmetic: one "Present" heading; no repeated "already up to date" lines on --apply all.
expect "report: the two 'Present' groups print as one" 0 "" -- bash -c "[ \"\$(cd '$UG/fresh' && GIT_CONFIG_GLOBAL='$UG/gitconfig' node '$OB/scripts/bob-upgrade.mjs' --today 2026-01-02 | grep -c '^Present (')\" = 1 ]"
expect "--apply all on an up-to-date project: no 'already up to date' lines" 0 "" -- bash -c "! (cd '$UG/fresh' && GIT_CONFIG_GLOBAL='$UG/gitconfig' node '$OB/scripts/bob-upgrade.mjs' --today 2026-01-02 --apply all) | grep -q 'already up to date'"

# ── 14. commit-sweep.sh (D-020): blocking mode judges what is being committed ─
echo "commit-sweep.sh"
CS="$HERE/commit-sweep.sh"; CW="$TMP/cs"; newrepo "$CW"
mkdir -p "$CW/docs" "$CW/.bob"
printf '# Build Manifest\n\nStatus as of: 2026-10-27\n' > "$CW/docs/build-manifest.md"
printf '# Decisions\n\n| D-001 | 2026-10-27 | start |\n' > "$CW/docs/decision-log.md"
printf '# Project\n- Plan: `docs/build-manifest.md`\n' > "$CW/AGENTS.md"
echo '{"commit_sweep": "block"}' > "$CW/.bob/installed.json"
git -C "$CW" add -A && git -C "$CW" commit -qm start
csrun() { (cd "$CW" && bash "$CS"); }
expect "outside a Bob project: nothing" 0 "^$" -- bash -c "cd '$TMP' && bash '$CS'"
expect "clean documents: passes" 0 "" -- csrun
echo "- Half-done: docs/half-done.md" >> "$CW/AGENTS.md"
expect "a broken edit NOT staged (another session's): warns, does not block" 0 "passes on what you are committing" -- csrun
git -C "$CW" add AGENTS.md
expect "the same edit staged: blocks" 1 "failed on what you are committing" -- csrun
git -C "$CW" reset -q AGENTS.md
echo '{"commit_sweep": "warn"}' > "$CW/.bob/installed.json"; git -C "$CW" add -A
expect "warn-only project: prints the problems, never blocks" 0 "set to warn only" -- csrun

# ── lens-retro.sh --check (2026-10-28) ───────────────────────────────────────
echo "lens-retro.sh --check"
LRD="$TMP/lr"; mkdir -p "$LRD"
printf '{"artifact_type":"audit_retro","lens_scorecard":[]}\n' > "$LRD/good.json"
printf '{"date":"2026-10-23","proposed_lens_changes":["x"]}\n' > "$LRD/other.json"
if command -v jq >/dev/null 2>&1; then
  expect "a retro in Bob's format -> OK" 0 "is in the retro format" -- bash "$HERE/lens-retro.sh" --check "$LRD/good.json"
  expect "a retro with invented fields -> FAIL, names its fields" 1 "fields found: date, proposed_lens_changes" -- bash "$HERE/lens-retro.sh" --check "$LRD/other.json"
  mkdir -p "$LRD/proj/audit-artifacts/2026-10-22"; cp "$LRD/other.json" "$LRD/proj/audit-artifacts/2026-10-22/audit-retro.json"
  expect "a retro in a sub-folder, other format -> found and its proposals listed" 0 "Retros in another format \\(1\\)" -- bash "$HERE/lens-retro.sh" "$LRD/proj"
else
  echo "  SKIP  (jq not installed)"
fi

# ── 15. one-home-check.mjs (D-032) ───────────────────────────────────────────
echo "one-home-check.mjs"
OH="$HERE/one-home-check.mjs"; OR="$TMP/onehome"; OS="$TMP/onehome-skip.json"
printf '[{"file":"build-protocol-core.md","heading":"## MODE: NEW","checks":["stubs"]}]\n' > "$OS"
oh_base() {
  rm -rf "$OR"; mkdir -p "$OR/audit-lenses" "$OR/modes" "$OR/scripts" "$OR/reference" "$OR/skill"
  printf '| # | Rule | Enforced by | `rules.md` group |\n|---|---|---|---|\n| 1 | a | `PROSE` | 1 |\n| 2 | b | `SCRIPT` | 2 |\n\nRun `~/.claude/skills/bob/../scripts/foo.sh`. See `~/.claude/skills/bob/../reference/glossary.md` (was Appendix J).\n' > "$OR/build-protocol-core.md"
  printf '## 1. First\n\n<!-- Rule 1 -->\n\n1. a\n\n## 2. Second\n\n<!-- Rule 2 -->\n\n2. b\n' > "$OR/rules.md"
  printf -- '---\nid: L01\n---\n' > "$OR/audit-lenses/L01-a.md"; printf -- '---\nid: L02\n---\n' > "$OR/audit-lenses/L02-b.md"
  printf '| 1. One | L01 | x |\n| 2. Two | L02 | y |\n' > "$OR/audit-lenses/README.md"
  printf 'Panel A: L01-L02\n' > "$OR/audit-lenses/_selection-rubric.md"
  printf '# Audit\n' > "$OR/modes/audit.md"; printf 'x\n' > "$OR/scripts/foo.sh"; printf 'g\n' > "$OR/reference/glossary.md"
}
oh_base
expect "one-home: a clean tree -> OK" 0 "one-home-check: OK" -- node "$OH" --root "$OR"
expect "one-home: Bob's own repo -> OK" 0 "one-home-check: OK" -- node "$OH"
oh_base; printf '| 3 | c | `PROSE` | 1 |\n' >> "$OR/build-protocol-core.md"
expect "one-home: an index row for a rule rules.md lacks -> FAIL" 1 "Rule 3 is in the index but not in rules.md" -- node "$OH" --root "$OR"
oh_base; sed -i.bak 's/| `SCRIPT` | 2 |/| `SCRIPT` | 1 |/' "$OR/build-protocol-core.md"
expect "one-home: an index row naming the wrong group -> FAIL" 1 "Rule 2 says group 1; rules.md files it in group 2" -- node "$OH" --root "$OR"
oh_base; printf -- '---\nid: L03\n---\n' > "$OR/audit-lenses/L03-c.md"; printf '| 3. Three | L03 | z |\n' >> "$OR/audit-lenses/README.md"
expect "one-home: a lens the rubric never names -> FAIL" 1 "L03 is never named, so no panel can include it" -- node "$OH" --root "$OR"
oh_base; printf '| 1. Engineering | L01 | x |\n' >> "$OR/modes/audit.md"
expect "one-home: a second lens band table -> FAIL" 1 "modes/audit.md:2: a lens band table" -- node "$OH" --root "$OR"
oh_base; printf 'Run `node scripts/foo.sh` now.\n' >> "$OR/rules.md"
expect "one-home: a short-form Bob script command -> FAIL" 1 "fails from a project" -- node "$OH" --root "$OR"
oh_base; printf 'Read `~/.claude/skills/bob/../reference/gone.md`.\n' >> "$OR/modes/audit.md"
expect "one-home: a Bob path that does not exist -> FAIL" 1 "names reference/gone.md, which does not exist in Bob" -- node "$OH" --root "$OR"
oh_base; printf 'See Appendix K.\n' >> "$OR/build-protocol-core.md"
expect "one-home: a reference to an appendix pointer -> FAIL" 1 "Appendix K. is a one-line pointer" -- node "$OH" --root "$OR"
oh_base; printf '\n## 3. Third\n\n<!-- Rule 9 -->\n\n9. c\n' >> "$OR/rules.md"
expect "one-home: a rule with no index row -> FAIL" 1 "Rule 9 has no row in the core's index" -- node "$OH" --root "$OR"
oh_base; printf '| 1. One | L01 | x |\n' > "$OR/audit-lenses/README.md"
expect "one-home: a lens missing from the lens README -> FAIL" 1 "L02 is not listed" -- node "$OH" --root "$OR"
oh_base; printf -- '---\nid: L03\n---\n' > "$OR/audit-lenses/L03-c.md"; printf '| 3. Three | L03 | z |\n' >> "$OR/audit-lenses/README.md"
printf 'Panel A: L01–L03\n' > "$OR/audit-lenses/_selection-rubric.md"
expect "one-home: an en-dash range names the lens inside it (L02)" 0 "one-home-check: OK" -- node "$OH" --root "$OR"
oh_base; printf 'Run `scripts/foo.sh <docs-dir>`.\n' >> "$OR/rules.md"
expect "one-home: a bare Bob command with arguments -> FAIL" 1 "scripts/foo.sh …. only works inside Bob" -- node "$OH" --root "$OR"
oh_base; mkdir -p "$OR/templates"; printf '{"note": "Check it with: node ~/.claude/skills/bob/../scripts/foo.sh"}\n' > "$OR/templates/t.json"
expect "one-home: a command in a .json template is judged too" 1 "templates/t.json:1" -- node "$OH" --root "$OR"
oh_base; printf 'Run `node ~/.claude/skills/bob/../scripts/foo.sh`.\n' >> "$OR/rules.md"
expect "one-home: node through the link (node does not follow it) -> FAIL" 1 "fails from a project" -- node "$OH" --root "$OR"
oh_base; printf 'Run `node "$(realpath ~/.claude/skills/bob/..)/scripts/foo.sh"`.\n' >> "$OR/rules.md"
expect "one-home: node with the realpath form -> OK" 0 "one-home-check: OK" -- node "$OH" --root "$OR"
oh_base; printf '```\nbash scripts/foo.sh\n```\n' >> "$OR/modes/audit.md"
expect "one-home: a short-form command inside a fenced block -> FAIL" 1 "modes/audit.md:3: .scripts/foo.sh. only works" -- node "$OH" --root "$OR"
oh_base; printf '## MODE: NEW — Steps\n\nNothing to hide.\n' >> "$OR/build-protocol-core.md"
expect "one-home: a SKIP entry that hides nothing -> FAIL" 1 "no longer hides anything" -- node "$OH" --root "$OR" --skip "$OS"
oh_base; printf '```\nscripts/foo.sh --all\n```\n' >> "$OR/modes/audit.md"
expect "one-home: a bare Bob command inside a fenced block -> FAIL" 1 "modes/audit.md:3: .scripts/foo.sh …. only works" -- node "$OH" --root "$OR"
oh_base; printf '[{"file":"rules.md","heading":"## 2","checks":["Bob paths"]}]\n' > "$TMP/oh-skip2.json"; printf '\n## 20. Later\n\nRun `bash scripts/foo.sh`.\n' >> "$OR/rules.md"
expect "one-home: a SKIP heading does not match a longer heading (## 2 vs ## 20)" 1 "rules.md:.*only works inside Bob" -- node "$OH" --root "$OR" --skip "$TMP/oh-skip2.json"
oh_base; printf 'Bob runs 3 ready-made audits.\n' > "$OR/README.md"
expect "one-home: a README audit count that is wrong -> FAIL" 1 "says 3 audits; there are 2 lens files" -- node "$OH" --root "$OR"
oh_base; printf '## MODE: NEW — Steps\n\nSee Appendix K.\n' >> "$OR/build-protocol-core.md"
expect "one-home: the NEW section's appendix wording is skipped (SKIP list)" 0 "one-home-check: OK" -- node "$OH" --root "$OR" --skip "$OS"
printf 'Run `bash scripts/foo.sh`.\n' >> "$OR/build-protocol-core.md"
expect "one-home: ...but its Bob paths are still judged" 1 "scripts/foo.sh. only works inside Bob" -- node "$OH" --root "$OR" --skip "$OS"

# ── 16. smoke tests: bob-update-check.sh · bob-stats.sh · repo-map.sh (D-032) ─
echo "bob-update-check.sh · bob-stats.sh · repo-map.sh"
expect "bob-update-check: one BOB_UPDATE line, never a failure" 0 "^BOB_UPDATE: status=[a-z]+" -- \
  env HOME="$TMP/uc-home" bash "$HERE/bob-update-check.sh" --force
SR="$TMP/stats"; newrepo "$SR"
git -C "$SR" commit -q --allow-empty -m "feat: a"; git -C "$SR" commit -q --allow-empty -m "fix: b"
expect "bob-stats: counts a labelled fix (1 of 2)" 0 "Labelled fixes: +1 +\\(50%\\)" -- bash -c "cd '$SR' && bash '$HERE/bob-stats.sh'"
mkdir -p "$SR/src"; : > "$SR/src/x.js"
expect "repo-map: writes docs/repo-map.md" 0 "" -- bash -c "cd '$SR' && bash '$HERE/repo-map.sh' >/dev/null && grep -q '^# Repo Map' docs/repo-map.md"

# ── 17. phase-report-check.mjs (D-033, Rule 4) ──────────────────────────────
echo "phase-report-check.mjs"
PR="$HERE/phase-report-check.mjs"; PD="$TMP/pr"; mkdir -p "$PD"
printf '## Phase [N] Report\n### [A] Built\n- [list everything built]\n### [C] Mocked — *include only if anything was stubbed*\n- [list stubs]\n### [A] Spec Deviations\n- [list EVERY difference]\n- [if none, say "None"]\n### [O] Decisions to Log\n- [optional]\n' > "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- the login page\n### [A] Spec Deviations\n- None\n' > "$PD/good.md"
expect "phase-report: a filled report (no [C] or [O] sections) -> OK" 0 "phase-report-check: OK" -- node "$PR" "$PD/good.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- the login page\n' > "$PD/nodev.md"
expect "phase-report: Spec Deviations left out -> REFUSED (Rule 4)" 1 'missing the "spec deviations" section' -- node "$PR" "$PD/nodev.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- [list everything built]\n### Spec Deviations\n- None\n' > "$PD/ph.md"
expect "phase-report: a placeholder line left in -> REFUSED" 1 "still the template's placeholder: - \\[list everything built\\]" -- node "$PR" "$PD/ph.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- x\n### Mocked\n\n### Spec Deviations\n- None\n' > "$PD/c.md"
expect "phase-report: an empty [C] section -> REFUSED, asks for N/A" 1 'write "N/A — <reason>"' -- node "$PR" "$PD/c.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- x\n### Mocked\nN/A — nothing was stubbed\n### Spec Deviations\n- None\n' > "$PD/c2.md"
expect "phase-report: a [C] section marked N/A -> OK" 0 "phase-report-check: OK" -- node "$PR" "$PD/c2.md" --template "$PD/tpl.md"
expect "phase-report: Bob's own blank template -> REFUSED" 1 'the "built" section has nothing of its own' -- node "$PR" "$HERE/../templates/phase-report.md"
expect "phase-report: no report file -> cannot run (exit 2, not a pass)" 2 "not a pass" -- node "$PR" "$PD/missing.md"
printf '# Phase 2\n## 1. Built ✅\n- the login page\n## 2. Spec Deviations\n- None\n' > "$PD/h2.md"
expect "phase-report: level-2, numbered headings with a status mark -> OK" 0 "phase-report-check: OK" -- node "$PR" "$PD/h2.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Built\n- x\n### Mocked\n- *N/A — nothing stubbed* (say so explicitly if skipping).\n### Spec Deviations\n- No divergences found.\n' > "$PD/na.md"
expect "phase-report: an italic N/A line and \"No divergences found\" count -> OK" 0 "phase-report-check: OK" -- node "$PR" "$PD/na.md" --template "$PD/tpl.md"
printf '## Phase 2 Report\n### Acceptance Bar\n- login works\n### Built\n- x\n#### Backend\n- /api/login\n### Spec Deviations\n- None\n### Validation Results\n- all pass\n### Hot Path Results\n- login: PASS\n### Regression Check\n- phase 1 flows: PASS\n### Acceptance Gate — met\n- yes\n### Deploy Verification — N/A (no integrations touched)\n' > "$PD/short.md"
expect "phase-report: a short report with --abbreviated -> OK" 0 "phase-report-check: OK" -- node "$PR" "$PD/short.md" --abbreviated
expect "phase-report: --abbreviated reads its list from the template (Acceptance Bar is on it)" 1 'missing the "acceptance bar" section' -- bash -c "sed '/Acceptance Bar/,/^- login works/d' '$PD/short.md' > '$PD/short2.md' && node '$PR' '$PD/short2.md' --abbreviated"
expect "phase-report: ...the same short report checked in full -> REFUSED" 1 'missing the "implementation decisions" section' -- node "$PR" "$PD/short.md"

# ── 18. autonomy-check.mjs (D-033, Rule 27) ─────────────────────────────────
echo "autonomy-check.mjs"
AC="$HERE/autonomy-check.mjs"
ac_base() {
  AD="$TMP/ac"; rm -rf "$AD"; mkdir -p "$AD/.claude/hooks" "$AD/.claude/agents"
  cat > "$AD/.claude/settings.json" <<'JSON'
{ "permissions": { "defaultMode": "default",
    "ask": ["Bash(git push:*)", "Bash(*deploy*)"],
    "deny": ["Bash(rm -rf:*)", "Bash(git push --force:*)", "Bash(git reset --hard:*)"] },
  "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/green-gate.sh\"" } ] } ] } }
JSON
  printf 'MAX_ATTEMPTS=8\nif [ "$n" -gt "$MAX_ATTEMPTS" ]; then exit 0; fi\nTEST_CMD="npm test"\n' > "$AD/.claude/hooks/green-gate.sh"
  printf -- '---\nname: reviewer\ntools: Read, Grep, Glob, Bash\n---\nReview.\n' > "$AD/.claude/agents/reviewer.md"
}
ac_base
expect "autonomy: deny/ask rules, bounded gate, read-only reviewer -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"defaultMode": "default"/"defaultMode": "auto"/' "$AD/.claude/settings.json"
expect "autonomy: defaultMode auto in the project file -> REFUSED (it is ignored)" 1 "Claude Code ignores in a project file" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"Bash(git reset --hard:\*)"/"Bash(ls:*)"/' "$AD/.claude/settings.json"
expect "autonomy: no deny rule for git reset --hard -> REFUSED" 1 'no rule for "git reset --hard"' -- node "$AC" "$AD"
ac_base; printf 'if grep -q stop_hook_active; then exit 0; fi\nTEST_CMD="npm test"\n' > "$AD/.claude/hooks/green-gate.sh"
expect "autonomy: a gate guarded only by stop_hook_active -> REFUSED" 1 "numeric retry limit it checks" -- node "$AC" "$AD"
ac_base; printf -- '---\nname: reviewer\ntools: Read, Edit, Bash\n---\n' > "$AD/.claude/agents/reviewer.md"
expect "autonomy: a reviewer that can Edit -> REFUSED" 1 "must not edit" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"permissions"/"env": { "PROD_DB_URL": "x" }, "permissions"/' "$AD/.claude/settings.json"
expect "autonomy: a production key in settings.env -> REFUSED" 1 "never give an autonomous run production" -- node "$AC" "$AD"
ac_base; sed -i.bak 's#"command": "bash#"command": "bash ~/.claude/hooks/notify.sh" } , { "type": "command", "command": "bash#' "$AD/.claude/settings.json"
expect "autonomy: an extra personal Stop hook in ~/.claude -> still OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf 'MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"\nif [ "$n" -gt "$MAX_ATTEMPTS" ]; then exit 0; fi\nTEST_CMD="npm test"\n' > "$AD/.claude/hooks/green-gate.sh"
expect "autonomy: an overridable retry limit (\${MAX:-8}) -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"permissions"/"env": { "PRODUCT_TOUR": "1", "ENABLE_LIVE_PREVIEW": "1" }, "permissions"/' "$AD/.claude/settings.json"
expect "autonomy: env keys that only contain PROD or LIVE inside a word -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"Bash(\*deploy\*)"/"Bash(vercel:*)"/' "$AD/.claude/settings.json"
expect "autonomy: deploy gated as vercel:* -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf -- '---\nname: reviewer\n---\nReview.\n' > "$AD/.claude/agents/reviewer.md"
expect "autonomy: a reviewer with no tools line (inherits Edit) -> REFUSED" 1 "has no tools: line" -- node "$AC" "$AD"
ac_base; printf -- '---\nname: reviewer\ntools:\n  - Read\n  - Edit\n---\n' > "$AD/.claude/agents/reviewer.md"
expect "autonomy: a reviewer whose tools list (YAML form) has Edit -> REFUSED" 1 "can use Edit" -- node "$AC" "$AD"
ac_base; sed -i.bak 's#"bash \\"$CLAUDE_PROJECT_DIR/.claude/hooks/green-gate.sh\\""#"\\"$CLAUDE_PROJECT_DIR\\"/.claude/hooks/green-gate.sh"#' "$AD/.claude/settings.json"
expect "autonomy: the docs' hook quoting \"\$CLAUDE_PROJECT_DIR\"/… -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf 'const MAX_ATTEMPTS = 8;\nif (n > MAX_ATTEMPTS) process.exit(0);\nconst TEST_CMD = "npm test";\n' > "$AD/.claude/hooks/green-gate.sh"
expect "autonomy: a retry limit written JavaScript-style (const X = 8; n > X) -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf 'max_attempts=8\n(( n >= max_attempts )) && exit 0\nTEST_CMD="npm test"\n' > "$AD/.claude/hooks/green-gate.sh"
expect "autonomy: a lower-case limit used without \$ -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; sed -i.bak 's/"deny": \[[^]]*\]/"deny": ["Bash(rm:*)", "Bash(git push:*)", "Bash(git reset:*)"]/; s/"Bash(git push:\*)", "Bash(\*deploy\*)"/"Bash(*deploy*)"/' "$AD/.claude/settings.json"
expect "autonomy: stricter deny rules (rm:*, git push:*, git reset:*) cover the basics -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf -- '---\r\nname: reviewer\r\ntools: Read, Grep\r\n---\r\n' > "$AD/.claude/agents/reviewer.md"
expect "autonomy: a reviewer file with Windows line endings -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
ac_base; printf -- '---\nname: reviewer\ndisallowedTools: Edit, Write, MultiEdit, NotebookEdit\n---\n' > "$AD/.claude/agents/reviewer.md"
expect "autonomy: a reviewer that disallows every editing tool -> OK" 0 "autonomy-check: OK" -- node "$AC" "$AD"
mkdir -p "$TMP/ac-none"
mkdir -p "$TMP/ac-bare/.claude"; printf '{"permissions":{}}\n' > "$TMP/ac-bare/.claude/settings.json"
expect "autonomy: settings but no Stop hook and no reviewer -> not set up (exit 2, not six failures)" 2 "not set up for supervised autonomy" -- node "$AC" "$TMP/ac-bare"
expect "autonomy: no settings file -> cannot run (exit 2, not a pass)" 2 "Not a pass" -- node "$AC" "$TMP/ac-none"
AI="$TMP/ac-init"; mkdir -p "$AI"; printf '[user]\n\tname = selftest\n\temail = selftest@example.com\n[commit]\n\tgpgsign = false\n' > "$TMP/ac-gitconfig"
(cd "$AI" && GIT_CONFIG_GLOBAL="$TMP/ac-gitconfig" GIT_CONFIG_NOSYSTEM=1 bash "$HERE/bob-init.sh" p >/dev/null 2>&1)
expect "autonomy: a fresh bob-init project -> only the unset test command is refused" 1 "\\[5\\] .*placeholder test command" -- node "$AC" "$AI/p"
expect "autonomy: ...and nothing else in it is refused" 0 "" -- bash -c "node '$AC' '$AI/p' | grep -c '✗' | grep -qx 1"

# ── 19. run-commands-check.mjs (D-033, Rule 26) ─────────────────────────────
echo "run-commands-check.mjs"
RC="$HERE/run-commands-check.mjs"; RD="$TMP/rc"; mkdir -p "$RD/.github/workflows" "$RD/jobs" "$RD/web" "$RD/scripts"
printf '{"scripts":{"build":"next build","seed":"tsx scripts/seed.ts","nightly":"python3 jobs/nightly.py","pip":"python -m pip install x"}}\n' > "$RD/package.json"
: > "$RD/scripts/seed.ts"; : > "$RD/web/build.sh"
printf 'import sys\n\ndef main():\n    print(1)\n\nif __name__ == "__main__":\n    main()\n' > "$RD/jobs/nightly.py"
printf 'jobs:\n  t:\n    steps:\n      - name: web\n        working-directory: web\n        # a comment between the folder and the command\n        run: |\n          bash ./build.sh\n          node $HOME/x.mjs\n' > "$RD/.github/workflows/ci.yml"
expect "run-commands: every run target exists (incl. a step's working-directory) -> OK" 0 "run-commands-check: OK — 3 run command" -- node "$RC" "$RD"
printf 'from jobs.nightly import main\n__all__ = ["main"]\n' > "$RD/jobs/old.py"
printf '{"scripts":{"shim":"python3 jobs/old.py","gone":"node scripts/gone.mjs"}}\n' > "$RD/package.json"
expect "run-commands: a moved script -> REFUSED" 1 'runs scripts/gone.mjs, which does not exist' -- node "$RC" "$RD"
expect "run-commands: a shim that dropped its run block -> REFUSED" 1 'runs jobs/old.py, which has no .if __name__' -- node "$RC" "$RD"
mkdir -p "$TMP/rc-none"
expect "run-commands: no run commands -> cannot run (exit 2, not a pass)" 2 "not a pass" -- node "$RC" "$TMP/rc-none"
R2="$TMP/rc2"; mkdir -p "$R2"/client/scripts "$R2"/backend "$R2"/web/scripts "$R2"/alembic "$R2"/.github/workflows "$R2"/pkg
: > "$R2/client/scripts/build.js"; : > "$R2/backend/manage.py"; : > "$R2/web/scripts/ci.sh"; : > "$R2/alembic/env.py"; : > "$R2/pkg/__init__.py"; printf 'dist\n' > "$R2/.gitignore"
printf '{"scripts":{"build":"cd client && node scripts/build.js","start":"node dist/server.js","dev":"vite","mig":"python -m alembic upgrade head"}}\n' > "$R2/package.json"
printf 'defaults:\n  run:\n    working-directory: web\njobs:\n  t:\n    steps:\n      - run: bash scripts/ci.sh\n  m:\n    steps:\n      - working-directory: ${{ matrix.dir }}\n        run: node x.mjs\n      - run: |\n          cd ../backend\n          python manage.py migrate\n' > "$R2/.github/workflows/a.yml"
expect "run-commands: cd in a command or block, build output, workflow defaults, matrix folders, installed tools -> OK" 0 "run-commands-check: OK" -- node "$RC" "$R2"
printf 'all:\n\tnode gone.mjs\n' > "$R2/Makefile"; printf '{"scripts":{"pk":"python -m pkg.missing"}}\n' > "$R2/package.json"
expect "run-commands: a missing project module and a Makefile target -> REFUSED, each once" 1 "REFUSED — 2 run command" -- node "$RC" "$R2"
R3="$TMP/rc3"; mkdir -p "$R3"/backend "$R3"/web/scripts "$R3"/src "$R3"/.github/workflows
: > "$R3/backend/manage.py"; : > "$R3/web/scripts/check.mjs"; : > "$R3/src/x.ts"
cat > "$R3/package.json" <<'JSON'
{"scripts":{"a":"pnpm --filter web exec node scripts/seed.mjs","b":"npm --prefix apps/web exec -- node scripts/seed.mjs","c":"node --import tsx ./src/x.ts","d":"echo \"usage: node cli.js\"","e":"node scripts\\build.js"}}
JSON
printf 'test:\n\tcd backend && \\\n\t  python manage.py test\n' > "$R3/Makefile"
cat > "$R3/.github/workflows/w.yml" <<'YML'
on: push
jobs:
    build:
        defaults:
            run:
                working-directory: web
        steps:
            - uses: actions/checkout@v4
              with:
                  path: tools
            - run: node scripts/check.mjs
            - run: node ../tools/bin/lint.mjs
            - run: |
                curl -sL https://example.com/install.sh -o install.sh && bash install.sh
                cat > smoke.py <<'PY'
                print(1)
                PY
                python smoke.py
                bash -c "cd sub && ./run.sh"
            - shell: pwsh
              run: python .\run.py
YML
expect "run-commands: monorepo filters, continued Makefile lines, 4-space jobs, files made at run time, nested shells, echo, Windows paths -> OK" 0 "run-commands-check: OK — 3 run command" -- node "$RC" "$R3"
mkdir -p "$TMP/rc-vite"; printf '{"scripts":{"dev":"vite","build":"vite build"}}\n' > "$TMP/rc-vite/package.json"
expect "run-commands: an app whose scripts only call tools (vite) -> OK, not 'cannot run'" 0 "nothing here runs a project file directly" -- node "$RC" "$TMP/rc-vite"
expect "run-commands: Bob's own CI commands point at real files" 0 "run-commands-check: OK" -- node "$RC" "$HERE/.."

# ── 20. recurrence-check.mjs (D-033, Rule 31) ───────────────────────────────
echo "recurrence-check.mjs"
RQ="$HERE/recurrence-check.mjs"; QR="$TMP/rq"; newrepo "$QR"
git -C "$QR" commit -q --allow-empty -m "init"
expect "recurrence: no Class: lines yet -> cannot judge (exit 2, not a pass)" 2 'carries a "Class:" line yet' -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "fix: empty read" -m "Class: read error as missing
Rung: 1"
expect "recurrence: a class fixed once -> OK" 0 "1 class\\(es\\) named in fix commits, 0 recurring" -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "fix: empty read again" -m "Class: Read-error-as-missing
Rung: 2"
expect "recurrence: fixed twice, newest at rung 2 -> REFUSED" 1 'class "read-error-as-missing" has been fixed 2 times' -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "fix: four-state result type" -m "closed at rung 4: the type cannot hold the bad state" -m "Class: read-error-as-missing"
expect "recurrence: newest fix closed at rung 4 -> OK" 0 "1 recurring, each closed at rung 3 or 4" -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "docs: how to write the lines" -m 'For example:
```
Class: read-error-as-missing
Rung: 1
```' -m "See Rule 31."
expect "recurrence: a Class: line quoted in a docs commit is not a fix -> still OK" 0 "1 recurring, each closed at rung 3 or 4" -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "fix: retry the read" -m "Class: slow-read
Rung: 1" -m "Co-Authored-By: Someone <someone@example.com>"
git -C "$QR" commit -q --allow-empty -m "fix: retry the read again" -m "Class: slow-read
Rung: 2" -m "Co-Authored-By: Someone <someone@example.com>"
expect "recurrence: Class/Rung lines above a Co-Authored-By line are read -> REFUSED (slow-read twice, rung 2)" 1 'class "slow-read" has been fixed 2 times' -- node "$RQ" "$QR"
git -C "$QR" commit -q --allow-empty -m "fix: make the slow read impossible" -m "Class: slow-read
Rung: 4"
git -C "$QR" commit -q --allow-empty -m "fix: two at once" -m "Class: stale-cache, read-error-as-missing
Rung: 1"
expect "recurrence: a comma list names two classes; the repeat one at rung 1 -> REFUSED" 1 'class "read-error-as-missing" has been fixed 4 times' -- node "$RQ" "$QR"
expect "recurrence: not a git repo -> cannot run (exit 2)" 2 "not a git repository" -- node "$RQ" "$TMP/rc-none"

# ── 21. rule-tags-check.mjs (D-033, Rule 33) ────────────────────────────────
echo "rule-tags-check.mjs"
RT="$HERE/rule-tags-check.mjs"
rt_base() {
  TR="$TMP/rt"; rm -rf "$TR"; mkdir -p "$TR/scripts" "$TR/.github/workflows"
  printf '| 1 | First | `SCRIPT` | 1 |\n| 2 | Second | `PROSE` | 1 |\n' > "$TR/build-protocol-core.md"
  printf '## 1. Group\n\n<!-- Rule 1 -->\n\n1. **First.** Checked by `scripts/x.mjs`.\n\n<!-- Rule 2 -->\n\n2. **Second.**\n' > "$TR/rules.md"
  : > "$TR/scripts/x.mjs"; : > "$TR/scripts/selftest-gate-scripts.sh"
  printf 'jobs:\n  t:\n    steps:\n      - run: node scripts/x.mjs\n' > "$TR/.github/workflows/ci.yml"
}
rt_base
expect "rule-tags: a SCRIPT rule whose script exists and runs in CI -> OK" 0 "1 of 2 rules have no script at all" -- node "$RT" --root "$TR"
rt_base; printf 'jobs: {}\n' > "$TR/.github/workflows/ci.yml"
expect "rule-tags: a script nothing runs -> FAIL" 1 "neither CI nor the self-test ever runs it" -- node "$RT" --root "$TR"
rt_base; printf 'jobs:\n  t:\n    steps:\n      # node scripts/x.mjs is checked elsewhere\n      - run: echo hi\n' > "$TR/.github/workflows/ci.yml"
expect "rule-tags: a script named only in a comment -> FAIL" 1 "neither CI nor the self-test ever runs it" -- node "$RT" --root "$TR"
rt_base; printf 'jobs:\n  t:\n    steps:\n      - run: node scripts/foo-x.mjs\n' > "$TR/.github/workflows/ci.yml"
expect "rule-tags: running a different script (foo-x.mjs) does not count for x.mjs -> FAIL" 1 "neither CI nor the self-test ever runs it" -- node "$RT" --root "$TR"
rt_base; rm "$TR/scripts/x.mjs"
expect "rule-tags: a named script that does not exist -> FAIL" 1 "scripts/x.mjs, which does not exist" -- node "$RT" --root "$TR"
rt_base; printf '## 1. Group\n\n<!-- Rule 1 -->\n\n1. **First.**\n\n<!-- Rule 2 -->\n\n2. **Second.**\n' > "$TR/rules.md"
expect "rule-tags: a SCRIPT tag whose rule names no script -> FAIL" 1 "names no script" -- node "$RT" --root "$TR"
expect "rule-tags: Bob's own tags are all true" 0 "rule-tags-check: OK" -- node "$RT"

# ── 22. bob-doctor.sh: the two design skills (D-033) ─────────────────────────
echo "bob-doctor.sh"
DH="$TMP/doc-home"; mkdir -p "$DH/.claude/skills"; ln -s "$(cd "$HERE/.." && pwd -P)/skill" "$DH/.claude/skills/bob"
expect "bob-doctor: design skills not linked -> a warning with the line to paste" 0 "design-gallery is not installed.*ln -s" -- env HOME="$DH" bash "$HERE/bob-doctor.sh"
ln -s "$(cd "$HERE/.." && pwd -P)/skills/design-gallery" "$DH/.claude/skills/design-gallery"
expect "bob-doctor: a linked design skill -> reported as linked" 0 "design-gallery linked" -- env HOME="$DH" bash "$HERE/bob-doctor.sh"

echo
echo "selftest-gate-scripts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
