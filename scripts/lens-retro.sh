#!/usr/bin/env bash
# lens-retro.sh — aggregate audit retros across runs/projects and flag
# lenses that are consistently low-signal or high-swap for human review.
#
# This is the Option B "accumulate + flag" half of the v2.18 Audit
# Self-Learning Loop. The Option A half (auto-emitting one retro per
# audit) is documented in audit-lenses/_lens-retro.md and produced by
# Bob at audit step A7.4.
#
# Usage (run from the Bob repo root):
#   bash scripts/lens-retro.sh                 # scan lens-retros/*.json
#   bash scripts/lens-retro.sh path/to/project # also scan a project's
#                                              # audit-artifacts/audit-retro-*.json
#   bash scripts/lens-retro.sh ~/p1 ~/p2 ...   # multiple project dirs
#   bash scripts/lens-retro.sh --check FILE    # is FILE in the retro format? (exit 1 if not)
#                                              # — run it at audit step A7.4 before saving
#
# Retros found in another shape (a run that invented its own fields) are no longer dropped
# silently: they are counted, and whatever proposals they carry are listed for a human to read
# (2026-10-28 — two of three real retros were being skipped as "not valid", so their proposals
# never reached Bob). Retros in sub-folders of audit-artifacts/ are found too.
#
# What it does:
#   Reads every audit-retro JSON it can find, then for each lens (L01–L30)
#   tallies: how many retros ran it, how many called it Noise, how many
#   swapped it out, how many "should_have_executed" gaps it had, and how
#   many change-requests target it. Lenses crossing review thresholds are
#   printed as REVIEW CANDIDATES, ranked.
#
# IMPORTANT (D-005): this script SURFACES candidates. It never edits a
# lens. A human applies the higher-order filter — convergence across
# retros is signal, not a verdict (the D-004 / F35 lesson). Approved
# edits go through a normal EVOLVE + F47 dogfood.
#
# Review thresholds (tune to taste):
#   - flagged if Noise in >= 40% of retros that ran it, OR
#   - swapped out in >= 40% of retros that ran it, OR
#   - >= 2 change-requests target it, OR
#   - "should_have_executed" in >= 40% of retros that ran it.
#
# Don't act on N=1. The ritual (see _lens-retro.md) says run this once
# >= 3 retros have accumulated — a single retro is one project's opinion.

set -uo pipefail

# The one test for "this is a retro in Bob's format" (artifact_type + a lens_scorecard list).
IS_RETRO='.artifact_type == "audit_retro" and (.lens_scorecard | type) == "array"'

NOISE_PCT=40       # flag if Noise in >= this % of runs
SWAP_PCT=40        # flag if swapped out in >= this % of runs
EXEC_PCT=40        # flag if should_have_executed in >= this % of runs
CR_MIN=2           # flag if >= this many change-requests target the lens
MIN_RETROS=3       # warn (don't act) below this many retros total

if ! command -v jq >/dev/null 2>&1; then
  cat >&2 <<'ERR'
ERROR: jq is required to parse retro JSON.
  macOS:   brew install jq
  Debian:  sudo apt-get install jq
Then re-run this script.
ERR
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  f="${2:-}"
  [[ -f "$f" ]] || { echo "lens-retro --check: no such file: $f" >&2; exit 2; }
  if jq -e "$IS_RETRO" "$f" >/dev/null 2>&1; then
    echo "lens-retro --check: OK — $f is in the retro format"; exit 0
  fi
  echo "lens-retro --check: NOT in the retro format — $f" >&2
  echo "  needs \"artifact_type\": \"audit_retro\" and a \"lens_scorecard\" list (see audit-lenses/_lens-retro.md);" >&2
  echo "  top-level fields found: $(jq -r 'if type == "object" then (keys | join(", ")) else "(top level is a \(type), not an object)" end' "$f" 2>/dev/null || echo "(not JSON)")" >&2
  exit 1
fi

# ── Collect retro files ───────────────────────────────────────────────
# Default source: lens-retros/ in the repo. Extra args are project dirs
# whose audit-artifacts/ we also scan.
FILES=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -d "$REPO_ROOT/lens-retros" ]]; then
  while IFS= read -r f; do FILES+=("$f"); done \
    < <(find "$REPO_ROOT/lens-retros" -maxdepth 1 -name '*.json' -type f 2>/dev/null)
fi

for proj in "$@"; do
  if [[ -d "$proj/audit-artifacts" ]]; then
    while IFS= read -r f; do FILES+=("$f"); done \
      < <(find "$proj/audit-artifacts" -name 'audit-retro*.json' -type f 2>/dev/null)
  elif [[ -d "$proj" ]]; then
    while IFS= read -r f; do FILES+=("$f"); done \
      < <(find "$proj" -maxdepth 2 -name 'audit-retro-*.json' -type f 2>/dev/null)
  else
    echo "WARN: '$proj' is not a directory — skipping." >&2
  fi
done

# De-dup file list (read-loop keeps bash 3.2 compatibility; no mapfile).
if [[ ${#FILES[@]} -gt 0 ]]; then
  _dedup=()
  while IFS= read -r f; do _dedup+=("$f"); done \
    < <(printf '%s\n' "${FILES[@]}" | sort -u)
  FILES=("${_dedup[@]}")
fi

RETRO_COUNT=${#FILES[@]}

if [[ "$RETRO_COUNT" -eq 0 ]]; then
  cat >&2 <<EOF
No retro JSON found.
  Looked in:   $REPO_ROOT/lens-retros/*.json
  Plus any project dirs passed as args.
Drop audit-retro-*.json files into lens-retros/ (see _lens-retro.md), or
pass a Bob-built project directory as an argument.
EOF
  exit 0
fi

# Sort each file: in Bob's retro format (VALID) or in another shape (OTHER).
VALID=(); OTHER=()
for f in "${FILES[@]}"; do
  if jq -e "$IS_RETRO" "$f" >/dev/null 2>&1; then
    VALID+=("$f")
  else
    OTHER+=("$f")
  fi
done
VALID_COUNT=${#VALID[@]}

# Retros in another shape: count them and list the proposals they carry, so nothing they
# propose is lost just because the run used its own field names.
print_other() {
  [[ ${#OTHER[@]} -eq 0 ]] && return 0
  echo ""
  echo "  Retros in another format (${#OTHER[@]}) — not tallied above; their proposals, for a human to read:"
  for f in "${OTHER[@]}"; do
    echo "  ◦ $f"
    jq -r '
      def items(f): if (f | type) == "array" then f elif f == null then [] else [f] end;
      if type != "object" then ["(top level is not an object — cannot read its proposals)"] else
      (items(.change_requests) + items(.proposed_lens_changes) + items(.changes_proposed_not_applied)) end
      | map(if type == "string" then . else (.what // .change // .summary // tostring) end)
      | .[:8] | if length == 0 then "      (no proposals found in it)" else (.[] | "      • " + (.[:220])) end
    ' "$f" 2>/dev/null || echo "      (not readable JSON)"
  done
  echo "  Fix the format at the source: run 'bash ~/.claude/skills/bob/../scripts/lens-retro.sh --check <file>' at audit step A7.4."
}

if [[ "$VALID_COUNT" -eq 0 ]]; then
  echo "No retros in Bob's retro format found." >&2
  print_other
  exit 0
fi

# ── Aggregate with jq across all valid files ──────────────────────────
# Emit one report row per lens that appears in any scorecard.
REPORT=$(jq -rs --argjson noise "$NOISE_PCT" --argjson swap "$SWAP_PCT" \
  --argjson execp "$EXEC_PCT" --argjson crmin "$CR_MIN" '
  # Flatten all retros into per-lens event streams.
  (map(.lens_scorecard // []) | add // []) as $cards
  | (map(.selection_rubric_accuracy.swaps // []) | add // []) as $swaps
  | (map(.change_requests // []) | add // []) as $crs
  | ($cards | map(.lens) | unique) as $lenses
  | $lenses
  | map(
      . as $L
      | ($cards | map(select(.lens == $L))) as $rows
      | ($rows | length) as $ran
      | ($rows | map(select(.signal_verdict == "noise")) | length) as $noiseN
      | ($rows | map(select(.signal_verdict == "gold")) | length) as $goldN
      | ($rows | map(select(.executed_vs_read == "should_have_executed")) | length) as $execN
      | ($swaps | map(select(.out == $L)) | length) as $swapN
      | ($crs | map(select(.target == $L)) | length) as $crN
      | {
          lens: $L,
          ran: $ran,
          noiseN: $noiseN,
          goldN: $goldN,
          execGapN: $execN,
          swapN: $swapN,
          crN: $crN,
          noisePct: (if $ran>0 then ($noiseN*100/$ran|floor) else 0 end),
          swapPct:  (if $ran>0 then ($swapN*100/$ran|floor) else 0 end),
          execPct:  (if $ran>0 then ($execN*100/$ran|floor) else 0 end),
          flagged: (
            ($ran>0 and ($noiseN*100/$ran) >= $noise)
            or ($ran>0 and ($swapN*100/$ran) >= $swap)
            or ($crN >= $crmin)
            or ($ran>0 and ($execN*100/$ran) >= $execp)
          ),
          # crude review score for ranking flagged lenses
          score: ($noiseN*3 + $swapN*2 + $crN*2 + $execN)
        }
    )
  # Print flagged first (by score desc), then the rest (by lens asc).
  | (map(select(.flagged)) | sort_by(-.score))
    + (map(select(.flagged | not)) | sort_by(.lens))
  | .[]
  | "\(if .flagged then "⚠ REVIEW" else "  ok    " end)  \(.lens)  ran:\(.ran)  noise:\(.noiseN)(\(.noisePct)%)  gold:\(.goldN)  swap-out:\(.swapN)(\(.swapPct)%)  exec-gap:\(.execGapN)  change-reqs:\(.crN)"
' "${VALID[@]}")

# Coverage-gap roll-up: missed problems and their proposed fix type.
GAPS=$(jq -rs '
  (map(.coverage_gaps // []) | add // [])
  | map("  • [\(.fix_type // "?") → \(.target_lens // "?")] \(.missed_problem // "?")")
  | if length==0 then "  (none reported)" else (.[] ) end
' "${VALID[@]}")

# Top change-requests across all retros, by severity then rank.
CRS=$(jq -rs '
  (map(.change_requests // []) | add // [])
  | sort_by((if .severity=="high" then 0 elif .severity=="med" then 1 else 2 end), (.rank // 99))
  | .[:10]
  | map("  • [\(.severity // "?")] \(.type // "?") → \(.target // "?"): \(.what // "?")")
  | if length==0 then "  (none reported)" else (.[]) end
' "${VALID[@]}")

PROJECTS=$(jq -rs '[.[].project] | unique | join(", ")' "${VALID[@]}")

# ── Output ────────────────────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────────────
  Bob the Builder — Lens Retro aggregation
──────────────────────────────────────────────────────────────────────

  Retros aggregated:  $VALID_COUNT  (projects: $PROJECTS)
  Thresholds:         noise≥${NOISE_PCT}%  swap-out≥${SWAP_PCT}%  exec-gap≥${EXEC_PCT}%  change-reqs≥${CR_MIN}

EOF

if [[ "$VALID_COUNT" -lt "$MIN_RETROS" ]]; then
  echo "  NOTE: only $VALID_COUNT retro(s) — below the $MIN_RETROS-retro floor."
  echo "        Treat everything below as one-project opinion, not a pattern."
  echo "        (See the 'When to run the ritual' rule in _lens-retro.md.)"
  echo ""
fi

cat <<EOF
  Per-lens review board:
$REPORT

  Coverage gaps reported (problems NO lens caught):
$GAPS

  Top change-requests (severity, then rank):
$CRS
EOF

print_other

cat <<EOF

──────────────────────────────────────────────────────────────────────
  Next: for each ⚠ REVIEW lens, read the underlying retros, let Bob
  propose a specific edit, then YOU decide (→ HG). Convergence across
  retros is signal, NOT a verdict (D-004 / F35). Bob never auto-edits a
  lens — approved edits go through EVOLVE + F47 dogfood (D-005).
  Full ritual: audit-lenses/_lens-retro.md  §B.
──────────────────────────────────────────────────────────────────────

EOF
