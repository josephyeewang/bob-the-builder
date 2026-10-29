#!/usr/bin/env bash
# commit-sweep.sh — Bob's commit-time document check (Rule 23/24, D-019, D-020). The ONE implementation: the
# per-repo pre-commit hook bob-init writes and the documented global-hook chain both just call this, from the repo root.
#
#   • Outside a Bob project (no docs/build-manifest.md): does nothing, exit 0.
#   • Runs coherence-check.sh on docs/ (and, through it, the root AGENTS.md / CLAUDE.md pointer check).
#   • WARNING ONLY unless .bob/installed.json says "commit_sweep": "block" — then a failure stops the commit (exit 1).
#
# WHAT IS CHECKED IN BLOCKING MODE (D-020). The sweep reads the files on disk. With several Claude sessions working in
# one folder, the disk can hold another session's half-finished, UNSTAGED edits — and those must not stop someone
# else's commit. So when the check fails on disk, it is run once more on a copy of exactly what is being committed
# (the staged files, `git checkout-index`), and the commit is stopped only if THAT copy fails too. If only the disk
# fails, the problems are printed as a warning and the commit goes ahead. A passing check costs nothing extra; the
# second run happens only on a failure.
# Known limit, stated: a problem that exists only in the staged copy while the disk is clean (someone fixed it but
# did not stage the fix) passes. Rare, and the next commit catches it.
#
# Exit: 0 = commit may go ahead · 1 = blocking mode and what is being committed fails the check.
set -uo pipefail
[ -f docs/build-manifest.md ] || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP="$HERE/coherence-check.sh"
[ -x "$SWEEP" ] || { echo "⚠ Bob's document check is missing next to commit-sweep.sh ($SWEEP) — not checked."; exit 0; }

BLOCK=0
if [ -f .bob/installed.json ] && grep -Eq '"commit_sweep"[[:space:]]*:[[:space:]]*"block"' .bob/installed.json; then BLOCK=1; fi

OUT="$(mktemp "${TMPDIR:-/tmp}/bob-commit-sweep.XXXXXX")"
SNAP=""
# shellcheck disable=SC2329  # called by the EXIT trap on the next line
cleanup() { rm -f "$OUT"; [ -n "$SNAP" ] && rm -rf "$SNAP"; }
trap cleanup EXIT

"$SWEEP" docs >"$OUT" 2>&1 && exit 0

if [ "$BLOCK" -eq 0 ]; then
  grep -E '✗|RESULT' "$OUT" | head -15
  echo "⚠ Bob's document check found the problems above. This project is set to warn only, so the commit goes ahead."
  echo "  To have it stop commits: fix them, then run /bob UPGRADE (node \"\$(realpath ~/.claude/skills/bob/..)/scripts/bob-upgrade.mjs\" --apply commit-sweep)."
  exit 0
fi

# Blocking mode, and the files on disk fail: check what is actually being committed. Shortcut: with no unstaged
# change to any tracked file and no untracked document under docs/, the disk IS what is being committed (minus
# untracked files elsewhere, which can only help a pointer resolve) — so the second run could not pass; skip it.
NEED_RECHECK=1
if git diff --quiet 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard -- docs 2>/dev/null | head -1)" ]; then NEED_RECHECK=0; fi
SNAP="$(mktemp -d "${TMPDIR:-/tmp}/bob-commit-staged.XXXXXX")"
if [ "$NEED_RECHECK" -eq 1 ] && git checkout-index -a --prefix="$SNAP/" 2>/dev/null && [ -f "$SNAP/docs/build-manifest.md" ]; then
  if (cd "$SNAP" && "$SWEEP" docs >"$OUT.staged" 2>&1); then
    rm -f "$OUT.staged"
    grep -E '✗|RESULT' "$OUT" | head -15
    echo "⚠ Bob's document check fails on the files in this folder, but passes on what you are committing."
    echo "  The problems are in changes that are not part of this commit (perhaps another session's work in progress),"
    echo "  so the commit goes ahead. They will stop the commit that includes them."
    exit 0
  fi
  cat "$OUT.staged"; rm -f "$OUT.staged"
else
  cat "$OUT"   # nothing unstaged (or the staged files could not be copied): the disk is what is committed
fi
echo "✗ Bob's document check failed on what you are committing (a gap in the decision log, a retired term, a broken"
echo "  file pointer, or a stale status date — see above). Fix it and commit again."
echo "  If you are sure it is wrong, the owner can skip it once in the Terminal app: git commit --no-verify"
exit 1
