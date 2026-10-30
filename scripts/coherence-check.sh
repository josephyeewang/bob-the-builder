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
# Exit code: 0 = no hard problems; 1 = a decision-log gap or duplicate ID (section [1]) OR (section [8]) a pointer in the
#   root AGENTS.md/CLAUDE.md that does not resolve, or a status page whose as-of date trails the decision log.
# Everything else is a review list for the reader and never fails: version strings, cross-refs, retired-term
# residue (section [5]) and the rest.

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

# ── [1] (was class 4): decision-log contiguity (gaps / dupes) + highest ID ─────────────
# Decision IDs that LEAD a markdown table row: '| D-073 |'. References elsewhere
# (e.g. "per D-062") are intentionally ignored so we count entries, not mentions.
echo
echo "── [1] Decision-log contiguity (| D-NNN | rows and ### D-NNN headings) ──"
LOG_FILE="$(printf '%s\n' "${DOCS[@]}" | grep -i 'decision-log' | head -1)"
HIGHEST_ID=""
if [ -z "$LOG_FILE" ]; then
  echo "  (no *decision-log*.md found — skipped)"
else
  # An entry is either a table row '| D-073 |' or a heading '### D-073:' (Bob's own log uses
  # headings; reading only rows made this check report "clean" on a log with 3 duplicate IDs).
  # Duplicates are counted within each form separately: a log may list every entry in a summary
  # table AND give each one a heading, and that is one entry, not two.
  ROW_RE='^\| *D-[0-9]+ *\|'
  HEAD_RE='^#+ +D-[0-9]+\b'
  IDS=()
  while IFS= read -r id; do IDS+=("$id"); done < <(grep -hoE "$ROW_RE|$HEAD_RE" "$LOG_FILE" \
                      | grep -oE 'D-[0-9]+' | sort -u)
  DUPES=$( { grep -oE "$ROW_RE" "$LOG_FILE" | grep -oE 'D-[0-9]+' | sort | uniq -d
             grep -oE "$HEAD_RE" "$LOG_FILE" | grep -oE 'D-[0-9]+' | sort | uniq -d; } | sort -u)
  if [ "${#IDS[@]}" -eq 0 ]; then
    echo "  (no | D-NNN | rows or ### D-NNN headings found — check the entry format)"
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
    # $DUPES is newline-separated (from `uniq -d`); the word-split below is
    # DELIBERATE so the IDs print on one line after the label, matching the MISSING
    # line above. Quoting would change the output, so the intent is declared rather
    # than "fixed". This lone info-level finding had failed the shellcheck job on
    # every run since at least 2026-09-07 — 8 consecutive red runs — which is
    # Rule 33's own point: a permanently red job is a job nobody reads.
    # shellcheck disable=SC2086
    if [ -n "$DUPES" ]; then echo "  ✗ DUPLICATE IDs:" $DUPES; FAIL=1; else echo "  ✓ no duplicate IDs"; fi
  fi
fi

# ── [2] (was class 4b): "synced through D-n" claims vs the actual highest ID ───────────
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

# ── [3] (was class 1): version-string inventory (eyeball cross-doc drift) ──────────────
echo
echo "── [3] Version strings (vN.N) per doc — scan for drift across index docs ──"
for d in "${DOCS[@]}"; do
  vs=$(grep -oE 'v[0-9]+\.[0-9]+' "$d" | sort | uniq -c | sort -rn \
        | awk '{printf "%s(%s) ", $2, $1}')
  [ -n "$vs" ] && printf '  %-34s %s\n' "$(basename "$d"):" "$vs"
done

# ── [4] (was class 3): cross-reference inventory (§ / D / P / C / S refs) ──────────────
echo
echo "── [4] Cross-ref token counts per doc (§ / D-n / P-n) ──"
for d in "${DOCS[@]}"; do
  s=$(grep -oE '§[0-9CA-Za-z][0-9A-Za-z.]*' "$d" | wc -l | tr -d ' ')
  dd=$(grep -oE 'D-[0-9]+' "$d" | wc -l | tr -d ' ')
  pp=$(grep -oE '\bP[0-9]+[a-z]?\b' "$d" | wc -l | tr -d ' ')
  [ "$s$dd$pp" != "000" ] && printf '  %-34s §:%-4s D-:%-4s P:%-4s\n' "$(basename "$d"):" "$s" "$dd" "$pp"
done
echo "  (resolve §/D targets semantically — the script counts, the reader judges)"

# ── [5]: retired-vocabulary residue — REVIEW LIST, not a hard fail ───────
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

# ── [6]: secondary/snapshot docs reading as live ────────────────────────
echo
echo "── [6] Dated/secondary docs — do they carry a snapshot banner? ──"
for d in "${DOCS[@]}"; do
  base=$(basename "$d")
  case "$base" in
    *[Aa]udit*|*[Ss]ession*|*goldmine*|*-20[0-9][0-9]-*)
      # A living doc whose name merely matches (e.g. modes/audit.md, the AUDIT steps) opts out with this marker.
      grep -q '<!-- living doc -->' "$d" && continue
      if ! grep -qiE 'snapshot|point-in-time|not a living doc|📸' "$d"; then
        echo "  ⚠ $base looks dated/secondary but has no snapshot banner"
      fi ;;
  esac
done
echo "  (⚠ = consider a '📸 snapshot — not a living doc' banner, or '<!-- living doc -->' if it is one; not a hard fail)"

# ── [7]: code / SSOT drift (Rule 24, v2.30) — the .md-only sweep's blind spot ──
# Docs aren't the only source of truth: machine-readable contracts (contracts/*.ts,
# *.sql, *.json) and schema files drift from the spec too (e.g. a stale "§2.4" comment
# or a missing field the spec says the type "carries"). The script can't verify
# "the type matches the spec" semantically — but it CAN scan code for the same
# retired-terms + surface its doc-section (§) references for the reader to reconcile.
echo
echo "── [7] Code / contract SSOT scan (contracts/ + *.ts/*.sql) — reconcile against the spec ──"
CODE_DIR="$(dirname "$DOCS_DIR")/contracts"
[ -d "$CODE_DIR" ] || CODE_DIR="$DOCS_DIR/../contracts"
if [ ! -d "$CODE_DIR" ]; then
  echo "  (no sibling contracts/ dir found — skipped; pass a project with machine-readable contracts to enable)"
else
  CODE_FILES=()
  while IFS= read -r f; do CODE_FILES+=("$f"); done < <(find "$CODE_DIR" -maxdepth 2 \( -name '*.ts' -o -name '*.sql' -o -name '*.js' -o -name '*.py' -o -name '*.json' \) | sort)
  if [ "${#CODE_FILES[@]}" -eq 0 ]; then
    echo "  (contracts/ has no .ts/.sql/.js/.py/.json files)"
  else
    echo "  scanning ${#CODE_FILES[@]} contract/code file(s)…"
    # 7a — retired-term residue in code (reuse the same list)
    if [ -f "$RETIRED_CFG" ]; then
      while IFS= read -r term; do
        [ -z "$term" ] && continue; case "$term" in \#*) continue;; esac
        hits=$(grep -niE -- "$term" "${CODE_FILES[@]}" 2>/dev/null | grep -viE -- "$RETIRE_CTX")
        [ -n "$hits" ] && { echo "  · retired term '$term' in code:"; echo "$hits" | sed 's/^/      /' | cut -c1-150; }
      done < "$RETIRED_CFG"
    fi
    # 7b — doc-section (§) refs inside code comments: list for the reader to reconcile
    SREFS=$(grep -rhoE '§[0-9][0-9A-Za-z.]*( invariant [0-9]+)?' "${CODE_FILES[@]}" 2>/dev/null | sort | uniq -c | sort -rn | awk '{printf "%s ", $2}')
    [ -n "$SREFS" ] && echo "  · §-refs in code (verify each still resolves to a real spec section): $SREFS"
    echo "  ⚠ REMINDER (Rule 24 Anti-Forgetting Gate): the script can't verify a contract MATCHES the spec —"
    echo "    at each phase/gate, reconcile contracts/ against the spec it implements (the event.ts class of drift)."
  fi
fi

# ── [8]: the always-read root file — pointers resolve; the status page is not stale (Rule 23(c), D-018) ──
# Every class above reads DOCS_DIR only, and the one file loaded into EVERY session (AGENTS.md / CLAUDE.md at the
# repo root) sits outside it — so the most-read file was the one file no check looked at. In a real build a status
# block there claimed a decision range months out of date while this sweep flagged the same claim
# in docs/ every week. doc-pointers-check.mjs is the one implementation; this only runs it.
echo
echo "── [8] Root instruction file (AGENTS.md / CLAUDE.md): pointers resolve; status page as-of date ──"
SWEEP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(git -C "$DOCS_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT_DIR" ]; then
  if [ "$(basename "$(cd "$DOCS_DIR" && pwd)")" = "docs" ]; then ROOT_DIR="$(cd "$DOCS_DIR/.." && pwd)"; else ROOT_DIR="$(cd "$DOCS_DIR" && pwd)"; fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  ⚠ skipped — needs Node (18 or newer); the root file's pointers were NOT checked"
elif [ ! -f "$SWEEP_DIR/doc-pointers-check.mjs" ]; then
  echo "  ⚠ skipped — doc-pointers-check.mjs not found next to this script; the root file's pointers were NOT checked"
else
  PTR_ARGS=(--root "$ROOT_DIR")
  STATUS_FILE=""
  for c in "$DOCS_DIR/build-manifest.md" "$DOCS_DIR/STATUS.md" "$DOCS_DIR/status.md"; do
    [ -f "$c" ] && { STATUS_FILE="$c"; break; }
  done
  if [ -n "$STATUS_FILE" ] && [ -n "$LOG_FILE" ]; then
    PTR_ARGS+=(--status "$(cd "$(dirname "$STATUS_FILE")" && pwd)/$(basename "$STATUS_FILE")" --log "$(cd "$(dirname "$LOG_FILE")" && pwd)/$(basename "$LOG_FILE")")
    [ -f "$DOCS_DIR/PROJECT-STATE.md" ] && PTR_ARGS+=(--also "$(cd "$DOCS_DIR" && pwd)/PROJECT-STATE.md")
  fi
  if PTR_OUT="$(node "$SWEEP_DIR/doc-pointers-check.mjs" "${PTR_ARGS[@]}" 2>&1)"; then
    printf '%s\n' "$PTR_OUT" | sed 's/^/  /'
  else
    printf '%s\n' "$PTR_OUT" | sed 's/^/  /'
    FAIL=1
  fi
fi

echo
echo "════════════════════════════════════════════════════════════════"
if [ "$FAIL" -ne 0 ]; then
  echo " RESULT: ✗ hard problems found (contiguity, retired-term residue, or a broken root-file pointer / stale status)."
else
  echo " RESULT: ✓ no mechanical drift. Review ⚠ items + judge §/D targets + reconcile contracts semantically."
fi
echo "════════════════════════════════════════════════════════════════"
exit "$FAIL"
