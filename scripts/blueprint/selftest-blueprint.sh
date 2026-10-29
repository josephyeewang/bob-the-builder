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
product: Weekplan
as_of: "2031-03-02"   # a made-up year, so the test never collides with real dates
summary:
  risk: "The editor row may slip past the first milestone."
  read: "On track for a first saved plan, if the editor lands."
steps:
  - n: "1"
    name: Type the week
    owner: M1
    supports: [M2]
  - n: "2"
    name: Save the plan
    owner: M2
    supports: []
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
    parts:
      - name: Typing
        light: green
        line: "types and saves"
      - name: Dragging
        light: amber
        line: "drag is half built"
    stage:
      usable_on: "2031-03-15"
      green_on: "2031-03-20"
      reads_from: []
      done_test: "yes"
  - id: M2
    name: Store
    plane: Keep
    role: "Keeps every saved plan"
    parts: []
    stage:
      usable_on:
      green_on:
      reads_from: [M1]
      done_test: "no"
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
milestone: B1
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

echo "render-blueprint.mjs — the page builder (phone view and rich page)"
RB="$HERE/render-blueprint.mjs"
NOW="2031-03-02T12:00:00Z"
render() { local d="$1"; shift; node "$RB" "$d" --commit abc1234def --now "$NOW" --out "$d/pages" "$@"; }
product "$TMP/r1"
expect "clean product renders" 0 "wrote docs/blueprint/BLUEPRINT.md" -- render "$TMP/r1"
PV="$TMP/r1/docs/blueprint/BLUEPRINT.md"
expect "phone view header: as of [date], built from [commit]" 0 'As of 2031-03-02, built from `abc1234def`' -- cat "$PV"
expect "phone view draws the map as mermaid text" 0 '^flowchart TB' -- cat "$PV"
expect "phone view folds with <details>" 0 '^<details><summary>8 · More detail</summary>' -- cat "$PV"
expect "summary generated (counts per light, target dates)" 0 'Overall health.*Amber 1 · ○ Red 0 · ◌ Not scored 1' -- cat "$PV"
expect "judgment fields rendered from blueprint.yaml summary" 0 'Biggest risk:\*\* The editor row may slip' -- cat "$PV"
expect "product name comes from blueprint.yaml, not the folder" 0 '^# Weekplan: Blueprint & Roadmap$' -- cat "$PV"
expect "map light = the worst part (green + amber → amber)" 0 '<br/>Where the week is typed<br/>◐ Amber"\]$' -- cat "$PV"
expect "module with no parts is not scored" 0 '<br/>Keeps every saved plan<br/>◌ Not scored"\]$' -- cat "$PV"
expect "map draws the loop path from the steps" 0 '^  n0 -->\|"1 · Type the week"\| n1$' -- cat "$PV"
expect "card head: owns step n" 0 '^### `M1` · \*\*Editor\*\* · Do · ◐ Amber · owns step 1$' -- cat "$PV"
expect "card field 0: step strip, takes in, hands on" 0 '\(a\) The step strip:\*\* ◯ 1 Type the week · ● 2 Save the plan' -- cat "$PV"
expect "card field 0: takes in from the previous step's owner" 0 'Takes in:\*\* Type the week, from `M1`, at step 2' -- cat "$PV"
expect "card field 5: parts table" 0 '^\| Dragging \| ◐ Amber \| drag is half built \|$' -- cat "$PV"
expect "card field 7: usable on / green on from the stage" 0 'Usable on:\*\* Sat 15 Mar 2031 · \*\*Green on:\*\* Thu 20 Mar 2031' -- cat "$PV"
expect "stage table generated" 0 '^\| `M1` Editor \| Sat 15 Mar 2031 \| Thu 20 Mar 2031 \| nothing \| yes \| `R-M1-1` \| Dragging \|$' -- cat "$PV"
expect "rows sit under their milestone" 0 '^<details><summary>Rows under B1 \(1\)</summary>$' -- cat "$PV"
expect "plan generated (milestone, estimate, slip)" 0 'Estimate:\*\* Thu 20 Mar 2031, if the editor row merges' -- cat "$PV"
expect "card 'Next' field generated from the row file" 0 '`Sat 15 Mar 2031:` Drag a task to another day `R-M1-1`' -- cat "$PV"
expect "capability index generated" 0 '^\| `C1` \| Drag to reschedule \| `M1` \| proposed \(adopted\) \| `R-M1-1` \| planned \|$' -- cat "$PV"
expect "rich page and history page written" 0 "" -- test -s "$TMP/r1/pages/index.html" -a -s "$TMP/r1/pages/history.html"
expect "rich page stamp: built from main at [commit], [time]" 0 'built from main at <code>abc1234def</code>, 2031-03-02 12:00 UTC' -- cat "$TMP/r1/pages/index.html" "$TMP/r1/pages/history.html"
expect "fresh stamp (now) keeps the header unred" 0 '<html lang="en" class="fresh">' -- cat "$TMP/r1/pages/index.html"
expect "fresh build: the served HTML has no red notice" 0 "" -- bash -c '! grep -q "<p id=\"stale-note\"" "$1"' _ "$TMP/r1/pages/index.html"
expect "fresh build, scripts off: a neutral freshness note" 0 "<noscript><p class=\"neutral\">Freshness can't be checked here" -- cat "$TMP/r1/pages/index.html"
# byte-identical: render twice, compare every output
cp "$PV" "$TMP/r1-pv1"; cp "$TMP/r1/pages/index.html" "$TMP/r1-ix1"; cp "$TMP/r1/pages/history.html" "$TMP/r1-hi1"
render "$TMP/r1" >/dev/null
expect "same input twice → byte-identical phone view" 0 "" -- cmp "$TMP/r1-pv1" "$PV"
expect "same input twice → byte-identical rich page" 0 "" -- cmp "$TMP/r1-ix1" "$TMP/r1/pages/index.html"
expect "same input twice → byte-identical history page" 0 "" -- cmp "$TMP/r1-hi1" "$TMP/r1/pages/history.html"
expect "no wall clock without --now: two builds a second apart match" 0 "" -- bash -c 'node "$1" "$2" --commit abc1234 --out "$3/a" >/dev/null && sleep 1 && node "$1" "$2" --commit abc1234 --out "$3/b" >/dev/null && cmp "$3/a/index.html" "$3/b/index.html"' _ "$RB" "$TMP/r1" "$TMP/r1nc"
expect "no build time given → header red (fail safe)" 0 '<html lang="en" class="stale">' -- cat "$TMP/r1nc/a/index.html"
# planted: a stamp over 2 hours old turns the header red, on both pages; 1 hour old does not
product "$TMP/r2"; render "$TMP/r2" --built-at "2031-03-02T09:59:00Z" >/dev/null
expect "planted old build stamp (2 h 1 min) → red header on the rich page" 0 '<html lang="en" class="stale">' -- cat "$TMP/r2/pages/index.html"
expect "planted old build stamp → red header on the history page" 0 '<html lang="en" class="stale">' -- cat "$TMP/r2/pages/history.html"
expect "planted old build stamp → the red note is shown" 0 '<p id="stale-note">' -- cat "$TMP/r2/pages/index.html"
render "$TMP/r2" --built-at "2031-03-02T11:00:00Z" >/dev/null
expect "a 1-hour-old stamp stays unred" 0 '<html lang="en" class="fresh">' -- cat "$TMP/r2/pages/index.html"
# planted: markup and a <script> tag in the data render as plain text
product "$TMP/r3"
sed -i.bak 's|^what: .*|what: "<script>alert(1)</script><b>bold</b> \| [x](javascript:alert(2))"|' "$TMP/r3/docs/blueprint/rows/R-M1-1.yaml"
sed -i.bak 's|^    role: .*|    role: "<img src=x onerror=alert(3)> \\" quote `tick` #hash"|' "$TMP/r3/docs/blueprint/blueprint.yaml"
render "$TMP/r3" >/dev/null
for f in pages/index.html pages/history.html docs/blueprint/BLUEPRINT.md; do
  expect "planted <script> and tags in data stay text in $f" 0 "" -- bash -c '! grep -qiE "<script>alert|<img src|<b>bold" "$1"' _ "$TMP/r3/$f"
done
expect "planted <script> is escaped, visible text, on the rich page" 0 '&lt;script&gt;alert\(1\)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt;' -- cat "$TMP/r3/pages/index.html"
expect "the rich page holds exactly one script, the builder's own" 0 '^1$' -- bash -c 'grep -o "<script" "$1" | wc -l | tr -d " "' _ "$TMP/r3/pages/index.html"
expect "the page's own script is pinned by the page's security policy" 0 "script-src 'sha256-" -- cat "$TMP/r3/pages/index.html"
expect "planted markup is escaped in the phone view" 0 '&lt;script&gt;alert\(1\)&lt;/script&gt;' -- cat "$TMP/r3/docs/blueprint/BLUEPRINT.md"
expect "planted quote and tag stay inside the mermaid label" 0 'n0\["<code>M1</code> · <b>Editor</b><br/>#lt;img src=x onerror=alert\(3\)#gt; #quot; quote #96;tick#96; #35;hash<br/>' -- cat "$TMP/r3/docs/blueprint/BLUEPRINT.md"
expect "no outside scripts, fonts or stylesheets" 0 "" -- bash -c '! grep -qiE "<(script|link|img)[^>]+(src|href)=|@import|url\(" "$1" "$2"' _ "$TMP/r1/pages/index.html" "$TMP/r1/pages/history.html"
expect "dark mode tokens come from visual-devices.md" 0 'prefers-color-scheme: dark' -- cat "$TMP/r1/pages/index.html"
# planted: invalid data → exit 2, nothing written
product "$TMP/r4"; sed -i.bak '/done_when:/d' "$TMP/r4/docs/blueprint/rows/R-M1-1.yaml"
expect "planted invalid data (row missing done-when) → exit 2" 2 'missing "done_when"' -- render "$TMP/r4"
expect "invalid data writes no phone view" 0 "" -- test ! -e "$TMP/r4/docs/blueprint/BLUEPRINT.md"
product "$TMP/r6"; sed -i.bak 's/light: amber/light: red/' "$TMP/r6/docs/blueprint/blueprint.yaml"; render "$TMP/r6" >/dev/null
expect "planted red part → the module turns red" 0 '<br/>Where the week is typed<br/>○ Red"\]$' -- cat "$TMP/r6/docs/blueprint/BLUEPRINT.md"
product "$TMP/r7"; sed -i.bak 's/light: amber/light: purple/' "$TMP/r7/docs/blueprint/blueprint.yaml"
expect "planted unknown light word → exit 2" 2 'light "purple" is not one of green, amber, red' -- render "$TMP/r7"
product "$TMP/r8"; sed -i.bak '/^product:/d' "$TMP/r8/docs/blueprint/blueprint.yaml"
expect "planted missing product name → exit 2" 2 'missing "product"' -- render "$TMP/r8"
product "$TMP/r9"; sed -i.bak '/^  read:/d' "$TMP/r9/docs/blueprint/blueprint.yaml"
expect "planted summary missing its one-line read → exit 2" 2 'summary: missing "read"' -- render "$TMP/r9"
product "$TMP/r10"; sed -i.bak 's/usable_on: "2031-03-15"/usable_on: "15 March"/' "$TMP/r10/docs/blueprint/blueprint.yaml"
expect "planted stage date not YYYY-MM-DD → exit 2" 2 '"usable_on" must be a date' -- render "$TMP/r10"
product "$TMP/r11"; sed -i.bak 's/^milestone: B1/milestone:/' "$TMP/r11/docs/blueprint/rows/R-M1-1.yaml"; render "$TMP/r11" >/dev/null
expect "a row under no milestone is still shown" 0 '^#### Rows under no milestone$' -- cat "$TMP/r11/docs/blueprint/BLUEPRINT.md"
product "$TMP/f1"; sed -i.bak 's/usable_on: "2031-03-15"/usable_on: "2031-03-16"/' "$TMP/f1/docs/blueprint/blueprint.yaml"
printf 'Usable from 2031-03-16.\n' >> "$TMP/f1/docs/domains/M1.md"
expect "a stage date (owned only by modules[].stage) re-typed in a chapter fails the fact-twice check" 1 'date "2031-03-16"' -- node "$CHECK" "$TMP/f1"
product "$TMP/r5"; printf 'extra: &anchor x\n' >> "$TMP/r5/docs/blueprint/blueprint.yaml"
expect "planted unsupported YAML → exit 2" 2 "anchors" -- render "$TMP/r5"
expect "a bad --now is a setup error" 2 "must be an ISO time" -- node "$RB" "$TMP/r1" --now yesterday --out "$TMP/r1/pages"
expect "the template itself renders" 0 "wrote docs/blueprint/BLUEPRINT.md" -- node "$RB" "$TMP/tpl" --commit 0000000 --now "$NOW" --out "$TMP/tpl/pages"
expect "the rendered fixture still passes the fact-twice check" 0 "no owned fact typed twice" -- node "$CHECK" "$TMP/r1"

echo ""
echo "selftest-blueprint: $PASS passed, $FAIL failed"
[[ "$FAIL" == 0 ]]
