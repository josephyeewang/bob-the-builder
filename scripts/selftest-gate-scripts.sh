#!/usr/bin/env bash
# selftest-gate-scripts.sh — regression tests for Bob's mechanical checkers:
#   D-016: prove-test-fails.mjs · check-bar.mjs · lane-check.mjs
#   D-017: hooks/block-no-verify.js · hooks/config-protection.js · coverage-check.py ·
#          spec-audit.py's leftover-placeholder check · templates/run-claim.mjs
#   D-018: hooks/merge-guard.mjs (its own node:test suite, incl. a bob-init scaffold + mutation proof) ·
#          doc-pointers-check.mjs · audit-ledger-check.mjs · templates/loop-check.mjs
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
expect "a renumbered section -> FAIL" 1 "§7 of docs/plan.md, and docs/plan.md has no section 7" -- node "$DP" --root "$D"
printf '# Project\n- `nowhere-at-all.md`\n' > "$D/CLAUDE.md"
expect "a bare name found nowhere -> warning only (may live in another install)" 1 "⚠ CLAUDE.md names .nowhere-at-all.md." -- node "$DP" --root "$D"
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

echo
echo "selftest-gate-scripts: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
