#!/usr/bin/env bash
# failure-mode-check.sh — the enforcer for Rule 32 (incident intake) and part of Rule 33.
#
# WHY THIS EXISTS. Evolution 008 found that every rule which held reliably had been mechanised
# into a test, a hook, or CI; every rule that failed repeatedly lived only in prose. Rules 31-33
# were themselves written as prose, which is the same mistake one level up. This script is the
# first enforcer: it makes the failure-mode index's bookkeeping mechanical rather than
# remembered.
#
# It checks four things, all of which have burned a real project:
#   1. Every fixture referenced by the index actually exists      (claim-without-artifact)
#   2. Every fixture on disk is referenced by the index           (built-not-wired)
#   3. The index's own scoreboard matches a fresh count           (stale-register-counts)
#   4. The unowned (NONE) count is reported, every run            (make the gap a visible fact)
#
# Check 3 is the point. A hand-maintained count in a register is the exact defect that let
# "~275 rows need repair" stand for a year when the real number was 38. This script refuses to
# let its own scoreboard drift.
#
# Usage:  bash scripts/failure-mode-check.sh [--quiet]
# Exit:   0 = consistent · 1 = a defect in the bookkeeping
#
# A NOTE THE SCRIPT EARNED. Its row pattern was originally `[A-F][0-9]+`, so when a row with a
# letter suffix (B5a) was added, the counter silently skipped it and reported OK — a checker
# passing because its pattern could not see the thing it was counting. That is B5a's own class,
# committed inside the check written to catch it, within the hour. The pattern now admits an
# optional suffix. The general lesson, which applies to every check in this repo: after adding a
# row/case/shape, confirm the checker's COUNT moved. A check that cannot see a case reports
# success, and success is the most expensive wrong answer available.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/audit-lenses/_failure-mode-index.md"
FIXTURE_DIR="$ROOT/fixtures/detection"
QUIET="${1:-}"
FAIL=0

say() { [ "$QUIET" = "--quiet" ] || echo "$@"; }
fail() { echo "failure-mode-check: $*" >&2; FAIL=1; }

[ -f "$INDEX" ] || { fail "index not found: $INDEX"; exit 1; }
[ -d "$FIXTURE_DIR" ] || { fail "fixture dir not found: $FIXTURE_DIR"; exit 1; }

# --- 1. every referenced fixture exists -------------------------------------------------
# Index rows cite fixtures as `fixtures/detection/NNN-slug.md`.
REFERENCED="$(grep -oE 'fixtures/detection/[0-9]{3}-[a-z0-9-]+\.md' "$INDEX" | sort -u)"
for ref in $REFERENCED; do
  [ -f "$ROOT/$ref" ] || fail "index cites a fixture that does not exist: $ref"
done

# --- 2. every fixture on disk is referenced ---------------------------------------------
# An unreferenced fixture is a check nobody can find — the built-not-wired class.
for f in "$FIXTURE_DIR"/[0-9][0-9][0-9]-*.md; do
  [ -e "$f" ] || continue
  base="fixtures/detection/$(basename "$f")"
  echo "$REFERENCED" | grep -qF "$base" || fail "fixture exists but no index row cites it: $base"
done

# --- 3. the scoreboard must match a fresh count ------------------------------------------
# Count only real data rows: a table row whose first cell is an ID like A1 / C7 / F3.
ROWS=$(grep -cE '^\| [A-F][0-9]+[a-z]? \|' "$INDEX")
NONE=$(grep -E '^\| [A-F][0-9]+[a-z]? \|' "$INDEX" | grep -c 'NONE')
OWNED=$((ROWS - NONE))
FIXTURED=$(grep -E '^\| [A-F][0-9]+[a-z]? \|' "$INDEX" | grep -c 'fixtures/detection/')

# The written scoreboard lives in a "Scoreboard" section as `- Rows: **N**` etc.
read_claim() { grep -oE "^- $1: \*\*[0-9]+\*\*" "$INDEX" | grep -oE '[0-9]+' | head -1; }
C_ROWS="$(read_claim 'Rows')"
C_OWNED="$(read_claim 'With a named owner')"
C_NONE="$(read_claim '\*\*NONE\*\*' || true)"
[ -n "${C_NONE:-}" ] || C_NONE="$(grep -oE '^- \*\*NONE: [0-9]+\*\*' "$INDEX" | grep -oE '[0-9]+' | head -1)"
C_FIX="$(read_claim 'With a fixture')"

check_num() { # name, claimed, actual
  if [ -z "${2:-}" ]; then fail "scoreboard is missing its '$1' line"; return; fi
  if [ "$2" != "$3" ]; then fail "scoreboard '$1' says $2 but a fresh count is $3 — re-measure, do not re-assert"; fi
}
check_num "Rows"              "${C_ROWS:-}"  "$ROWS"
check_num "With a named owner" "${C_OWNED:-}" "$OWNED"
check_num "NONE"              "${C_NONE:-}"  "$NONE"
check_num "With a fixture"    "${C_FIX:-}"   "$FIXTURED"

# --- 4. always report the gap ------------------------------------------------------------
say "failure-mode index: $ROWS modes · $OWNED owned · $NONE UNOWNED · $FIXTURED with a fixture"
if [ "$NONE" -gt 0 ] && [ "$QUIET" != "--quiet" ]; then
  say ""
  say "  $NONE failure modes have no owning check. That is a visible fact, not a failure —"
  say "  but per Rule 32, an incident landing on a NONE row is a FRAMEWORK GAP and must be"
  say "  filed as one, never absorbed into the nearest existing lens."
fi

if [ "$FAIL" -ne 0 ]; then
  echo "failure-mode-check: FAILED" >&2
  exit 1
fi
say "failure-mode-check: OK"
