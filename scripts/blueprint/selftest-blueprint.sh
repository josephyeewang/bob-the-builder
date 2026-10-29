#!/usr/bin/env bash
# selftest-blueprint.sh — proves each Blueprint check catches the defect it was written for, and passes clean text
# (Rule 28's discipline, as in selftest-gate-scripts.sh). Everything runs on a generic made-up product in a temp
# folder; nothing in the Bob repo or your projects is touched.
#
# Usage:  bash scripts/blueprint/selftest-blueprint.sh      (exit 0 = all pass)
# Needs:  bash, node >= 18.

# The fixtures below write literal backticks (Markdown code spans) on purpose.
# shellcheck disable=SC2016
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bob-blueprint-selftest.XXXXXX")"
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
    # shellcheck disable=SC2001
    sed 's/^/        | /' <<<"$out"
    FAIL=$((FAIL + 1))
  fi
}

# A clean made-up product: fact files plus chapters full of text that must NOT fail.
product() {
  local d="$1"
  mkdir -p "$d/docs/blueprint/rows" "$d/docs/blueprint/cards" "$d/docs/blueprint/history" "$d/docs/domains"
  cat > "$d/docs/blueprint/decided.yaml" <<'EOF'
goal: "Help a small team plan its week in five minutes."
for_whom: "Small teams without a project manager."
objectives:
  - id: O1
    name: Fast
    promise: "Planning the week takes under five minutes."
    target: "5 minutes"
    measured_by: "median time from opening to saved plan"
not_doing:
  - what: "Time tracking"
    why: "Not the pain"
    revisit_if: "Three customers ask"
rules:
  - id: RU1
    name: Never guess
    text: "Never show an estimate the team did not enter."
capabilities_adopted: [C1]
EOF
  cat > "$d/docs/blueprint/blueprint.yaml" <<'EOF'
as_of: "2031-03-02"   # a made-up year, so the test never collides with real dates
chapters:
  - name: Product
    path: docs/product-spec.md
  - name: Market
    path: docs/market.md
  - name: Module specs
    path: docs/domains/
milestones:
  - id: B1
    name: First plan saved
    estimate: "2031-03-20"
    condition: "if the editor row merges"
    slips:
      - date: "2031-03-01"
        from: "2031-03-12"
        to: "2031-03-20"
        reason: "editor took longer"
modules:
  - id: M1
    name: Editor
    plane: Do
    role: "Where the week is typed"
capabilities:
  - id: C1
    name: Drag to reschedule
    module: M1
    maturity: proposed
    row: R-M1-1
competitors:
  - id: K1
    name: BigBoard
    group: boards
    one_liner: "A shared wall of cards for large teams."
    last_checked: "2031-02-20"
    recheck_by: "2031-05-20"
research: []
handwritten: []
EOF
  cat > "$d/docs/blueprint/exit-tests.yaml" <<'EOF'
exit_tests:
  - milestone: B1
    test: tests/exit/b1.sh
    passes_when: "a plan is saved and reopened unchanged"
EOF
  cat > "$d/docs/blueprint/rows/R-M1-1.yaml" <<'EOF'
id: R-M1-1
what: "Drag a task to another day"
module: M1
capability: C1
owner: lead
date: "2031-03-15"
trigger:
done_when: "meets O1's target"
status: planned
receipts: []
EOF
  cat > "$d/docs/product-spec.md" <<'EOF'
> **Chapter of the Blueprint** (as of 2031-03-02): short facts live there; this page holds depth.

# Product

The first milestone is B1; its date is on the roadmap, not here.
We decided this on 2030-11-04, long before the plan existed (older than any date the data holds).
See the research note `research/2031-03-01-interviews.md` and [the board](https://example.com/2031-03-20/plan).

> "Never show an estimate the team did not enter." — the rule as the founder wrote it, quoted.

The founder put it as “Planning the week takes under five minutes.” in the first interview.

<!-- frozen -->
Old plan, kept as written: B1 was due 2031-03-12.
<!-- /frozen -->

<!-- generated -->
| Capability | Module |
|---|---|
| Drag to reschedule | M1 |
<!-- /generated -->

Dates use the form <YYYY-MM-DD> in the data files.

> The founder's note from the kick-off: B1 by 2031-03-20, no later.

Chapter of the Blueprint, re-checked 2031-03-02 (an unquoted banner line).
Drafts sit in the folder plans/2031-03-20 until they merge.
The [interview notes](notes/plan.md#2031-03-20) and the [shared plan](https://example.com/plan?due=2031-03-20) say more.
A bare link works too: https://example.com/board?due=2031-03-20
EOF
  cat > "$d/docs/market.md" <<'EOF'
> **Chapter of the Blueprint**: short facts live there; this page holds depth.

# Market

BigBoard is the closest competitor; its one-liner is in the fact list (K1).
EOF
  echo "# Editor (M1)" > "$d/docs/domains/M1.md"
  echo "History: B1 moved on 2031-03-01." > "$d/docs/blueprint/history/2031-03.md"
}

# plant <name> <file-relative-to-product> <line> : a copy of the clean product with one line appended
plant() {
  local name="$1" file="$2" line="$3" d="$TMP/$1"
  product "$d"
  printf '%s\n' "$line" >> "$d/$file"
  echo "$d"
}

CHECK="$HERE/fact-twice-check.mjs"
echo "fact-twice-check.mjs — owned fact written once"
product "$TMP/clean"
expect "clean product passes (banner, quotes, frozen, generated, old date, file names, links, placeholder)" 0 "no owned fact typed twice" -- node "$CHECK" "$TMP/clean"
expect "planted ISO date fails"              1 'date "2031-03-20"'        -- node "$CHECK" "$(plant iso docs/product-spec.md 'B1 should land on 2031-03-20.')"
expect "planted stale copy of a moved date fails" 1 'date "2031-03-12"'   -- node "$CHECK" "$(plant stale docs/product-spec.md 'B1 lands 2031-03-12.')"
expect "planted day-month-year date fails"   1 '"20 Mar 2031"'             -- node "$CHECK" "$(plant dmy docs/market.md 'We ship on 20 Mar 2031.')"
expect "planted month-day-year date fails"   1 '"March 20, 2031"'          -- node "$CHECK" "$(plant mdy docs/market.md 'We ship on March 20, 2031.')"
expect "planted year-less date fails"        1 '"15 Mar" \(2031-03-15\)'   -- node "$CHECK" "$(plant yearless docs/domains/M1.md 'Dragging lands ~Sat 15 Mar.')"
expect "planted rule sentence fails"         1 'rule RU1 re-typed'         -- node "$CHECK" "$(plant rule docs/product-spec.md 'Rule: never show an estimate the team did not enter.')"
expect "planted objective promise fails"     1 "objective O1's promise"    -- node "$CHECK" "$(plant promise docs/product-spec.md 'Our goal: planning the week takes under **five minutes**.')"
expect "planted competitor one-liner fails"  1 "competitor K1's one-liner" -- node "$CHECK" "$(plant comp docs/market.md 'BigBoard: a shared wall of cards for large teams')"
expect "planted capability-list row fails"   1 'capability C1 re-typed'    -- node "$CHECK" "$(plant cap docs/product-spec.md '| Drag to reschedule | M1 | proposed |')"
expect "planted date in a card fails"        1 'cards/M1.md:1: date'       -- node "$CHECK" "$(plant card docs/blueprint/cards/M1.md 'Usable on 2031-03-20.')"
# A date inside the banner line must NOT fail, even when it equals an owned date (the brief's "must not fail" case).
expect "planted banner date does not fail"   0 "no owned fact typed twice" -- node "$CHECK" "$(plant banner docs/market.md '> **Chapter of the Blueprint** (B1 due 2031-03-20)')"
expect "unquoted banner date does not fail"  0 "no owned fact typed twice" -- node "$CHECK" "$(plant banner2 docs/market.md 'Chapter of the Blueprint, checked 2031-03-20.')"
mkdir -p "$TMP/nodata"
expect "no fact files is a setup error"      2 "missing docs/blueprint/blueprint.yaml" -- node "$CHECK" "$TMP/nodata"
product "$TMP/badyaml"; printf 'extra: &anchor x\n' >> "$TMP/badyaml/docs/blueprint/blueprint.yaml"
expect "unsupported YAML is a setup error, with its line" 2 "blueprint.yaml:[0-9]+: anchors" -- node "$CHECK" "$TMP/badyaml"

echo "schema-check.mjs — the fact files keep their shape"
SC="$HERE/schema-check.mjs"
expect "clean product has its shape" 0 "every fact file has its shape" -- node "$SC" "$TMP/clean"
mkdir -p "$TMP/tpl/docs"; cp -R "$HERE/../../templates/blueprint-roadmap" "$TMP/tpl/docs/blueprint"
expect "the template itself has its shape" 0 "every fact file has its shape" -- node "$SC" "$TMP/tpl"
expect "the template passes the fact-twice check" 0 "no owned fact typed twice" -- node "$CHECK" "$TMP/tpl"
product "$TMP/s1"; sed -i.bak '/done_when:/d' "$TMP/s1/docs/blueprint/rows/R-M1-1.yaml"
expect "planted row missing its done-when fails" 1 'R-M1-1.yaml: missing "done_when"' -- node "$SC" "$TMP/s1"
product "$TMP/s2"; sed -i.bak '/last_checked:/d' "$TMP/s2/docs/blueprint/blueprint.yaml"
expect "planted competitor missing its last-checked date fails" 1 'competitors\[0\] \(K1\): missing "last_checked"' -- node "$SC" "$TMP/s2"
product "$TMP/s3"; sed -i.bak 's/estimate: "2031-03-20"/estimate: "20 March"/' "$TMP/s3/docs/blueprint/blueprint.yaml"
expect "planted date not written YYYY-MM-DD fails" 1 '"estimate" must be a date' -- node "$SC" "$TMP/s3"
product "$TMP/s4"; printf 'colour: red\n' >> "$TMP/s4/docs/blueprint/rows/R-M1-1.yaml"
expect "planted unknown field fails" 1 'unknown field "colour"' -- node "$SC" "$TMP/s4"
product "$TMP/s5"; mv "$TMP/s5/docs/blueprint/rows/R-M1-1.yaml" "$TMP/s5/docs/blueprint/rows/R-M1-2.yaml"
expect "planted row whose id differs from its file name fails" 1 'must match its file name' -- node "$SC" "$TMP/s5"
product "$TMP/s6"; sed -i.bak -e 's/^date: .*/date:/' "$TMP/s6/docs/blueprint/rows/R-M1-1.yaml"
expect "planted row with neither date nor trigger fails" 1 'needs a date or a named trigger' -- node "$SC" "$TMP/s6"

echo "yaml-lite.mjs — the strict reader"
YL="$HERE/yaml-lite.mjs"
yl() { node --input-type=module -e "import {parseYaml} from '$YL'; console.log(JSON.stringify(parseYaml(process.argv[1], 't.yaml')))" "$1"; }
expect "lists of maps, flow lists, quotes, comments" 0 '^\{"a":\[\{"id":"x","n":"1 # not a comment"\},\{"id":"y","n":null\}\],"b":\["p","q r"\],"c":\[\]\}$' -- yl $'a:\n  - id: x   # comment\n    n: "1 # not a comment"\n  - id: y\n    n:\nb: [p, "q r"]\nc: []'
expect "block text keeps its lines" 0 '"t":"one\\ntwo\\n"' -- yl $'t: |\n  one\n  two\n'
expect "a tab for indentation is refused" 1 "t.yaml:2: tab" -- yl $'a:\n\tb: 1'
expect "a flow map is refused"            1 "flow maps"     -- yl 'a: {b: 1}'
expect "a duplicate key is refused"       1 'duplicate key "a"' -- yl $'a: 1\na: 2'

echo ""
echo "selftest-blueprint: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
