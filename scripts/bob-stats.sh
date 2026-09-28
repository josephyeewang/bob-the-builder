#!/usr/bin/env bash
# bob-stats.sh — compute fix-commit ratio for a Bob-built project.
#
# Usage (run from the root of a Bob-built project):
#   bash ~/tools/bob-the-builder/scripts/bob-stats.sh
#
# What it does:
#   Counts commits by classifying each subject line as "fix" or "other".
#   Outputs a paste-ready block for the Step [N+2]c PR-back template.
#
# Bob's effectiveness target: fix-commit ratio < 30% (baseline prior to
# Bob: ~70%). This script is the v2.13 fix for finding F15 — the metric
# Bob most wants from users had no automation, so it never got reported.
#
# Classification (conservative; tune to taste):
#   - "fix" commits: subject starts with `fix:` / `fix(` / `bug:` /
#     `bugfix:` / `hotfix:` (case-insensitive), or first word is `fix`.
#   - Everything else: "other" (feature, refactor, docs, chore, etc.)
#
# Limitations:
#   - Conventional-commit-style projects classify cleanly. Free-form
#     subject lines may under-count fixes (e.g., "patch broken auth").
#   - First commit ("Initial commit", scaffold) counts as "other".
#   - Merge commits are excluded.

set -uo pipefail

if [[ ! -d .git ]]; then
  echo "ERROR: not in a git repo. Run this from the root of a Bob-built project." >&2
  exit 1
fi

# Count fix commits and total non-merge commits.
# `git log --no-merges --pretty=format:%s` emits one subject per commit.
TOTAL=$(git log --no-merges --pretty=format:%s | wc -l | tr -d ' ')

if [[ "$TOTAL" -eq 0 ]]; then
  echo "No commits yet. Run this after you've built something." >&2
  exit 0
fi

FIX_COUNT=$(git log --no-merges --pretty=format:%s \
  | grep -ciE '^(fix|bug|bugfix|hotfix)([: (]|$)' \
  || true)

# bc may not be installed; do integer math.
if [[ "$TOTAL" -gt 0 ]]; then
  RATIO=$(( FIX_COUNT * 100 / TOTAL ))
else
  RATIO=0
fi

OTHER=$(( TOTAL - FIX_COUNT ))

# Verdict against Bob's effectiveness target.
if [[ "$RATIO" -lt 30 ]]; then
  VERDICT="✓ below Bob's target of 30%"
elif [[ "$RATIO" -lt 50 ]]; then
  VERDICT="⚠ above Bob's 30% target — worth examining which phases bled fixes"
else
  VERDICT="✗ well above Bob's 30% target — process review warranted"
fi

cat <<EOF

──────────────────────────────────────────────────────────
  Bob the Builder — fix-commit ratio
──────────────────────────────────────────────────────────

  Total commits (excl. merges):   $TOTAL
  Fix commits:                    $FIX_COUNT
  Other commits:                  $OTHER
  Fix-commit ratio:               ${RATIO}%
  Bob's target:                   < 30%
  Verdict:                        $VERDICT

Paste-ready snippet for the Step [N+2]c PR-back template:

  Fix-commit ratio: ${RATIO}% ($FIX_COUNT fix / $TOTAL total). Bob's target: <30%.

Share back (5 min, makes Bob better for the next person):
  - GitHub issue: https://github.com/josephyeewang/bob-the-builder/issues/new
  - Email:        joe@joe.wang  (private channel)

EOF
