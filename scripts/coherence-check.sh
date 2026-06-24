#!/usr/bin/env bash
# coherence-check.sh — Living-doc coherence sweep (Bob Rule 23, v2.29).
#
# Harvests and flags the mechanical drift classes across a doc set so the human
# never has to hand-grep. The SCRIPT catches the mechanical regressions; the AI/
# human still judges the semantic rest (is a §-ref pointing at the *right* section,
# is a contradiction real). Pull-based gates weren't enough — this is the push.
#
# Usage:
#   scripts/coherence-check.sh [DOCS_DIR]
#     DOCS_DIR  directory of markdown docs (default: ./docs)
#
# Optional config files in DOCS_DIR:
#   .bob-retired-terms   one term per line; flagged if found in a LIVE (non-
#                        changelog, non-decision-log) line. '#' lines are comments.
#
# Exit code: 0 = no hard problems; 1 = contiguity gap/dup OR retired-term residue.
# Version-string and cross-ref inventories are always informational (never fail).

set -uo pipefail
DOCS_DIR="${1:-./docs}"
FAIL=0

if [ ! -d "$DOCS_DIR" ]; then
  echo "coherence-check: '$DOCS_DIR' is not a directory" >&2
  exit 2
fi

# Collect markdown files (top level + one nested level, e.g. ai-architecture/).
# Portable to macOS bash 3.2 (no mapfile/readarray).
DOCS=()
while IFS= read -r f; do DOCS+=("$f"); done < <(find "$DOCS_DIR" -maxdepth 2 -name '*.md' | sort)
if [ "${#DOCS[@]}" -eq 0 ]; then
  echo "coherence-check: no .md files under '$DOCS_DIR'" >&2
  exit 2
fi

echo "════════════════════════════════════════════════════════════════"
echo " BOB COHERENCE SWEEP — $DOCS_DIR  (${#DOCS[@]} docs)"
echo "════════════════════════════════════════════════════════════════"

# ── Class 4: decision-log contiguity (gaps / dupes) + highest ID ─────────────
# Decision IDs that LEAD a markdown table row: '| D-073 |'. References elsewhere
# (e.g. "per D-062") are intentionally ignored so we count entries, not mentions.
echo
echo "── [1] Decision-log contiguity (row-leading | D-NNN | entries) ──"
LOG_FILE="$(printf '%s\n' "${DOCS[@]}" | grep -i 'decision-log' | head -1)"
HIGHEST_ID=""
if [ -z "$LOG_FILE" ]; then
  echo "  (no *decision-log*.md found — skipped)"
else
  IDS=()
  while IFS= read -r id; do IDS+=("$id"); done < <(grep -oE '^\| *D-[0-9]+ *\|' "$LOG_FILE" \
                      | grep -oE 'D-[0-9]+' | sort -u)
  DUPES=$(grep -oE '^\| *D-[0-9]+ *\|' "$LOG_FILE" | grep -oE 'D-[0-9]+' \
          | sort | uniq -d)
  if [ "${#IDS[@]}" -eq 0 ]; then
    echo "  (no row-leading | D-NNN | entries found — check the table format)"
  else
    LO=$(printf '%s\n' "${IDS[@]}" | sed 's/D-//' | sort -n | head -1)
    HI=$(printf '%s\n' "${IDS[@]}" | sed 's/D-//' | sort -n | tail -1)
    HIGHEST_ID="D-$HI"
    MISSING=""
    for ((n=10#$LO; n<=10#$HI; n++)); do
      pad=$(printf 'D-%03d' "$n")
      printf '%s\n' "${IDS[@]}" | grep -qx "$pad" || MISSING+=" $pad"
    done
    echo "  range: D-$LO … D-$HI   (${#IDS[@]} unique entries)"
    if [ -n "$MISSING" ]; then echo "  ✗ MISSING:$MISSING"; FAIL=1; else echo "  ✓ contiguous, no gaps"; fi
    if [ -n "$DUPES" ]; then echo "  ✗ DUPLICATE IDs:" $DUPES; FAIL=1; else echo "  ✓ no duplicate IDs"; fi
  fi
fi

# ── Class 4b: "synced through D-n" claims vs the actual highest ID ───────────
echo
echo "── [2] 'synced through D-n' / 'D-001…D-n' claims vs highest ($HIGHEST_ID) ──"
HITS=$(grep -rniE 'synced through \**D-[0-9]+|D-001[…\.]+ *\**D-[0-9]+' "${DOCS[@]}" 2>/dev/null)
if [ -z "$HITS" ]; then
  echo "  (no 'synced through D-n' claims found)"
else
  echo "$HITS" | while IFS= read -r line; do
    claimed=$(echo "$line" | grep -oE 'D-[0-9]+' | tail -1)
    if [ -n "$HIGHEST_ID" ] && [ "$claimed" != "$HIGHEST_ID" ]; then
      echo "  ⚠ claims $claimed but highest logged is $HIGHEST_ID → ${line%%:*}:$(echo "$line"|cut -d: -f2)"
    fi
  done
  echo "  (⚠ = lag to eyeball; not a hard fail — a claim may intentionally trail by one)"
fi

# ── Class 1: version-string inventory (eyeball cross-doc drift) ──────────────
echo
echo "── [3] Version strings (vN.N) per doc — scan for drift across index docs ──"
for d in "${DOCS[@]}"; do
  vs=$(grep -oE 'v[0-9]+\.[0-9]+' "$d" | sort | uniq -c | sort -rn \
        | awk '{printf "%s(%s) ", $2, $1}')
  [ -n "$vs" ] && printf '  %-34s %s\n' "$(basename "$d"):" "$vs"
done

# ── Class 3: cross-reference inventory (§ / D / P / C / S refs) ──────────────
echo
echo "── [4] Cross-ref token counts per doc (§ / D-n / P-n) ──"
for d in "${DOCS[@]}"; do
  s=$(grep -oE '§[0-9CA-Za-z][0-9A-Za-z.]*' "$d" | wc -l | tr -d ' ')
  dd=$(grep -oE 'D-[0-9]+' "$d" | wc -l | tr -d ' ')
  pp=$(grep -oE '\bP[0-9]+[a-z]?\b' "$d" | wc -l | tr -d ' ')
  [ "$s$dd$pp" != "000" ] && printf '  %-34s §:%-4s D-:%-4s P:%-4s\n' "$(basename "$d"):" "$s" "$dd" "$pp"
done
echo "  (resolve §/D targets semantically — the script counts, the reader judges)"

# ── Class 5: retired-vocabulary residue — REVIEW LIST, not a hard fail ───────
# Pure-grep can't distinguish genuine residue from a line that *names* a retired
# term precisely to retire it ("corrects the earlier 'agent-first' over-rotation").
# So this is a filtered candidate list for the reader to judge — never sets FAIL.
# It skips: the decision log, any snapshot-bannered doc, and retirement-context
# lines (changelog/"earlier"/"replaces"/"walked back"/"not X"/version markers).
echo
echo "── [5] Retired-term residue — REVIEW CANDIDATES (judge each; not a hard fail) ──"
RETIRED_CFG="$DOCS_DIR/.bob-retired-terms"
RETIRE_CTX='prior|earlier|former|replaces?|replaced|walk(ed|s)? back|over-rotation|re-?frame|re-?sequenc|corrects?|retired?|superseded|no longer|instead of|dropped|\bwas \b|not [\x27"]|→|->|v[0-9]+\.[0-9]+'
if [ ! -f "$RETIRED_CFG" ]; then
  echo "  (no $DOCS_DIR/.bob-retired-terms file — create one to enable; one term/line)"
else
  ANY=0
  for d in "${DOCS[@]}"; do
    base=$(basename "$d")
    case "$base" in *decision-log*) continue;; esac
    grep -qiE 'snapshot|📸|not a living doc|point-in-time' "$d" && continue   # skip snapshot docs
    while IFS= read -r term; do
      [ -z "$term" ] && continue
      case "$term" in \#*) continue;; esac
      hits=$(grep -niE -- "$term" "$d" 2>/dev/null | grep -viE -- "$RETIRE_CTX")
      if [ -n "$hits" ]; then
        ANY=1
        echo "  · '$term' in $base:"
        echo "$hits" | sed 's/^/      /' | cut -c1-150
      fi
    done < "$RETIRED_CFG"
  done
  [ "$ANY" -eq 0 ] && echo "  ✓ no retired-term residue survives the filter (snapshot/retirement-context excluded)"
fi

# ── Class 6: secondary/snapshot docs reading as live ────────────────────────
echo
echo "── [6] Dated/secondary docs — do they carry a snapshot banner? ──"
for d in "${DOCS[@]}"; do
  base=$(basename "$d")
  case "$base" in
    *[Aa]udit*|*[Ss]ession*|*goldmine*|*-20[0-9][0-9]-*)
      if ! grep -qiE 'snapshot|point-in-time|not a living doc|📸' "$d"; then
        echo "  ⚠ $base looks dated/secondary but has no snapshot banner"
      fi ;;
  esac
done
echo "  (⚠ = consider a '📸 snapshot — not a living doc' banner; not a hard fail)"

echo
echo "════════════════════════════════════════════════════════════════"
if [ "$FAIL" -ne 0 ]; then
  echo " RESULT: ✗ hard problems found (contiguity and/or retired-term residue)."
else
  echo " RESULT: ✓ no mechanical drift. Review ⚠ items + judge §/D targets semantically."
fi
echo "════════════════════════════════════════════════════════════════"
exit "$FAIL"
