#!/usr/bin/env bash
# bob-doctor.sh — verify Bob's install on this machine.
#
# Usage:
#   bash ~/tools/bob-the-builder/scripts/bob-doctor.sh
#   (or just: bash bob-doctor.sh — if you're inside the install directory)
#
# What it checks:
#   1. Skill symlink ~/.claude/skills/bob exists and resolves to a real directory
#   2. SKILL.md is readable at the resolved path
#   3. build-protocol.md and build-protocol-core.md are readable via the SKILL.md's path form
#   4. The install directory is a git repo with a valid remote
#   5. The repo is on a known branch, no divergence, no uncommitted changes blocking updates
#
# Exits 0 if everything is healthy; 1 if anything needs attention.
# All output is plain English so a non-engineer can act on it.

set -uo pipefail

SKILL_LINK="$HOME/.claude/skills/bob"
problems=0
warnings=0

note()    { echo "  ✓ $1"; }
warn()    { echo "  ⚠ $1"; warnings=$((warnings + 1)); }
fail()    { echo "  ✗ $1"; problems=$((problems + 1)); }

echo "Bob the Builder — install health check"
echo ""

# 1. Skill symlink presence
echo "1. Skill symlink (~/.claude/skills/bob)"
if [[ -L "$SKILL_LINK" ]]; then
  target=$(readlink "$SKILL_LINK")
  note "symlink exists → $target"
  if [[ ! -d "$target" ]]; then
    fail "symlink target does not exist (dangling). Re-run the install one-liner from the README, or fix the symlink manually."
    target=""
  fi
elif [[ -e "$SKILL_LINK" ]]; then
  warn "$SKILL_LINK exists but is not a symlink. The README assumes a symlink; this may work but updates will be harder."
  target="$SKILL_LINK"
else
  fail "symlink missing. Bob is not installed as a skill on this machine. Run the README install one-liner."
  target=""
fi

# 2. SKILL.md readable
echo ""
echo "2. SKILL.md"
if [[ -n "$target" && -r "$target/SKILL.md" ]]; then
  note "readable at $target/SKILL.md"
else
  fail "SKILL.md not readable at the resolved path. Bob will not load in Claude Code."
fi

# 3. Protocol files via portable path form
echo ""
echo "3. Protocol files (via SKILL.md's portable path form)"
core_path="$SKILL_LINK/../build-protocol-core.md"
full_path="$SKILL_LINK/../build-protocol.md"
if [[ -r "$core_path" ]]; then
  note "build-protocol-core.md readable"
else
  fail "build-protocol-core.md not readable at $core_path"
fi
if [[ -r "$full_path" ]]; then
  note "build-protocol.md readable"
else
  fail "build-protocol.md not readable at $full_path"
fi

# 4. Git repo state
echo ""
echo "4. Git repo state"
if [[ -n "$target" ]]; then
  bob_root="$(cd "$target/.." 2>/dev/null && pwd -P)"
else
  bob_root=""
fi
if [[ -n "$bob_root" && -d "$bob_root/.git" ]]; then
  note "git repo at $bob_root"
  remote=$(git -C "$bob_root" remote get-url origin 2>/dev/null)
  if [[ "$remote" == *"bob-the-builder"* ]]; then
    note "origin remote: $remote"
  else
    warn "origin remote does not look like Bob's canonical repo: $remote"
  fi

  branch=$(git -C "$bob_root" rev-parse --abbrev-ref HEAD)
  note "current branch: $branch"

  # Divergence check (uses cached refs — fast, no network)
  ahead=$(git -C "$bob_root" rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)
  behind=$(git -C "$bob_root" rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)
  if [[ "$ahead" -gt 0 && "$behind" -gt 0 ]]; then
    warn "DIVERGED from origin ($ahead ahead, $behind behind). 'update bob' will refuse to pull until you resolve this."
  elif [[ "$ahead" -gt 0 ]]; then
    note "$ahead local commit(s) not pushed (fine for personal forks)"
  elif [[ "$behind" -gt 0 ]]; then
    warn "$behind commit(s) behind origin. Run 'update bob' or 'git pull --ff-only' to catch up."
  else
    note "up to date with origin (based on cached refs)"
  fi

  dirty=$(git -C "$bob_root" status --porcelain | head -1)
  if [[ -n "$dirty" ]]; then
    warn "uncommitted changes in the Bob install directory. 'update bob' will refuse to pull until clean."
  else
    note "working tree clean"
  fi
else
  warn "Bob install is not a git repo. 'update bob' won't work; you'll need to re-install for updates."
fi

# 5. Summary
echo ""
echo "─────────────────────────────────────────"
if [[ "$problems" -eq 0 && "$warnings" -eq 0 ]]; then
  echo "✓ Healthy. Bob should work end-to-end."
  exit 0
elif [[ "$problems" -eq 0 ]]; then
  echo "✓ Functional, with $warnings warning(s) above. Bob will work; address warnings when convenient."
  exit 0
else
  echo "✗ $problems problem(s), $warnings warning(s). Bob may not work correctly. Address the ✗ items above."
  exit 1
fi
