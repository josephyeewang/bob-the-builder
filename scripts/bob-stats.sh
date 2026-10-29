#!/usr/bin/env bash
# bob-stats.sh — estimate the fix-commit ratio for a Bob-built project.
#
# Usage (run from the root of a Bob-built project):
#   bash ~/.claude/skills/bob/../scripts/bob-stats.sh [--since YYYY-MM-DD] [--until YYYY-MM-DD]
#
# What it does:
#   Reads each non-merge commit subject and reports three numbers:
#     - labelled fixes:  the subject starts with a fix type (`fix:`, `fix(…):`, `bug:`, `bugfix:`,
#                        `hotfix:`, `revert`), optionally after a bracketed tag like `[product]`
#     - likely fixes:    labelled fixes PLUS subjects that use a fix word anywhere (fix/fixed,
#                        bug, broken, wrong, regression, repair, restore, retract, revert, typo, …)
#     - fixes of fixes:  likely fixes whose subject points at an earlier change (#NNN) that was
#                        itself a likely fix, or says follow-up / again / re-fix / still
#   and gives a verdict on the LIKELY ratio. Outputs a paste-ready block for the Step [N+2]c
#   PR-back template.
#
# Bob's effectiveness target: fix-commit ratio < 30% (baseline prior to Bob: ~70%).
#
# HONEST LIMIT (2026-10-28). Commit subjects are a weak signal. Projects that describe a fix in
# plain words ("the guard never checked for it", "the step recorded failures as passes") under a
# non-fix type are still under-counted. The first version of this script counted only `fix:`
# prefixes and reported one project at 14% "✓ below target" while a hand census of the same
# project's merged changes found 40% were fixes and 26% were fixes of fixes. So: the numbers here
# are a FLOOR, the verdict never says "below target" when labelled and likely counts disagree
# widely, and the real measurement is a hand classification of a sample of merged changes.

set -uo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: not in a git repo. Run this from the root of a Bob-built project." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required." >&2
  exit 1
fi

RANGE=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since|--until)
      [[ -n "${2:-}" ]] || { echo "ERROR: $1 needs a date, e.g. $1 2026-09-01" >&2; exit 2; }
      RANGE+=("$1=$2"); shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

git log --no-merges ${RANGE[@]+"${RANGE[@]}"} --pretty=format:%s | python3 -I -c '
import re, sys
subjects = [l.rstrip("\n") for l in sys.stdin if l.strip()]
total = len(subjects)
if total == 0:
    print("No commits in range. Run this after you have built something.", file=sys.stderr)
    sys.exit(0)

TAG = r"^(\[[^\]]*\]\s*|(?-i:[A-Z]{2,})\s+)*"     # optional leading tags: [product], LAB, MAIN (capitals only)
LABEL = re.compile(TAG + r"(fix|bug|bugfix|hotfix|revert)\b", re.I)
WORD = re.compile(r"\b(fix|fixe[sd]|fixing|bugs?|hotfix|broken|breaks?|wrong|incorrect(ly)?|regression|"
                  r"repair(s|ed)?|restor(e|es|ed)|retract(s|ed)?|revert(s|ed)?|typo|mistaken(ly)?|"
                  r"crash(es|ed)?|silently)\b", re.I)
AGAIN = re.compile(r"\b(follow-?up|again|re-?fix|second fix|still (broken|wrong|failing)|fix(es)? the fix)\b", re.I)
OWN = re.compile(r"\(#(\d+)\)\s*$")                 # a squash-merge subject ends with its own (#NNN)
REF = re.compile(r"#(\d+)")

labelled = [bool(LABEL.search(s)) for s in subjects]
likely = [l or bool(WORD.search(s)) for s, l in zip(subjects, labelled)]
own_num = [OWN.search(s).group(1) if OWN.search(s) else None for s in subjects]
fix_nums = {n for n, f in zip(own_num, likely) if n and f}
fof = 0
for s, f, n in zip(subjects, likely, own_num):
    if not f:
        continue
    refs = {r for r in REF.findall(s) if r != n}
    if AGAIN.search(s) or (refs & fix_nums):
        fof += 1

L, K = sum(labelled), sum(likely)
pl, pk, pf = L * 100 // total, K * 100 // total, (fof * 100 // K) if K else 0
if pk >= 50:
    verdict = "✗ well above Bob'"'"'s 30% target — process review warranted"
elif pk >= 30:
    verdict = "⚠ above Bob'"'"'s 30% target — worth examining which phases bled fixes"
elif pk - pl >= 10:
    verdict = "? unclear — labelled and likely counts disagree; classify a sample by hand before trusting either"
elif pk >= 20:
    verdict = "⚠ near the 30% target — this is a floor, so the real ratio may be above it; classify a sample by hand"
else:
    verdict = "✓ likely below Bob'"'"'s 30% target (a floor — see the note below)"

print(f"""
──────────────────────────────────────────────────────────
  Bob the Builder — fix-commit ratio (estimate)
──────────────────────────────────────────────────────────

  Commits (excl. merges):         {total}
  Labelled fixes:                 {L}  ({pl}%)
  Likely fixes:                   {K}  ({pk}%)
  Fixes of earlier fixes:         {fof}  ({pf}% of likely fixes)
  Bob'"'"'s target:                   < 30%
  Verdict:                        {verdict}

  Note: commit subjects under-count fixes written in plain words. Treat these as a floor.
  For a real number, hand-classify a sample of merged changes (fix / fix-of-fix / other).

Paste-ready snippet for the Step [N+2]c PR-back template:

  Fix-commit ratio (estimate): {pk}% likely ({K}/{total}), {pl}% labelled; fixes of fixes: {fof}. Bob'"'"'s target: <30%.

Share back (5 min, makes Bob better for the next person):
  - GitHub issue: https://github.com/josephyeewang/bob-the-builder/issues/new
  - Email:        joe@joe.wang  (private channel)
""")
'
