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
cp "$HERE/../build-protocol-core.md" "$HERE/../decision-log.md" "$OB/"
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

echo
echo "selftest-gate-scripts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
