#!/usr/bin/env bash
# bob-update-check.sh — quietly check whether the installed Bob is behind the
# canonical repo, so a non-engineer gets *offered* the latest without having to
# remember to ask. This script only DETECTS and REPORTS — it never pulls.
# The actual update is the divergence-aware sequence in SKILL.md ("update bob").
#
# Usage:
#   bash ~/tools/bob-the-builder/scripts/bob-update-check.sh          # throttled (once/day)
#   bash ~/tools/bob-the-builder/scripts/bob-update-check.sh --force  # ignore throttle
#
# It is invoked silently at the top of every /bob session (SKILL.md Step 0).
# Throttled to one network check per day so it never slows down repeated use
# and degrades gracefully offline.
#
# Output contract: exactly one machine-parseable line on stdout —
#   BOB_UPDATE: status=current
#   BOB_UPDATE: status=behind behind=<N> current=<vX> latest=<vY>
#   BOB_UPDATE: status=dirty behind=<N>
#   BOB_UPDATE: status=diverged ahead=<A> behind=<B>
#   BOB_UPDATE: status=skip          (throttled — checked recently)
#   BOB_UPDATE: status=offline       (no network / fetch failed)
#   BOB_UPDATE: status=noinstall     (not the standard symlink+git layout)
# SKILL.md reads this line and only surfaces something to the user when there's
# an actionable update. Exit code is always 0 — a failed check must never block /bob.

set -uo pipefail

SKILL_LINK="$HOME/.claude/skills/bob"
# Throttle stamp lives OUTSIDE the repo so it never dirties Bob's git tree
# (a stamp inside the repo would trip the "dirty" check below).
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/bob-the-builder"
STAMP="$CACHE_DIR/last-update-check"
TTL_SECONDS=86400   # 24h

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

emit() { echo "BOB_UPDATE: $1"; exit 0; }

# ── Resolve Bob's install directory ──────────────────────────────────────
# Prefer the skill symlink (that's the installed copy /bob actually loads).
# Fall back to this script's own repo for direct runs without a symlink.
bob_root=""
if [[ -L "$SKILL_LINK" ]]; then
  target=$(readlink "$SKILL_LINK")
  if resolved=$(cd "$target/.." 2>/dev/null && pwd -P); then bob_root="$resolved"; fi
fi
if [[ -z "$bob_root" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  if resolved=$(cd "$script_dir/.." 2>/dev/null && pwd -P); then bob_root="$resolved"; fi
fi
[[ -n "$bob_root" && -d "$bob_root/.git" ]] || emit "status=noinstall"

# ── Throttle: skip the network check if we looked recently ───────────────
if [[ "$FORCE" -eq 0 && -f "$STAMP" ]]; then
  now=$(date +%s)
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( now - last < TTL_SECONDS )); then
    emit "status=skip"
  fi
fi

# ── Fetch (bounded so offline machines fail fast, not hang) ──────────────
if ! git -C "$bob_root" \
        -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 \
        fetch -q origin >/dev/null 2>&1; then
  emit "status=offline"
fi

# Record that we successfully checked (only after a real fetch).
mkdir -p "$CACHE_DIR" 2>/dev/null || true
date +%s > "$STAMP" 2>/dev/null || true

# ── Compare local vs upstream (cached refs, no further network) ──────────
ahead=$(git -C "$bob_root" rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)
behind=$(git -C "$bob_root" rev-list --count "HEAD..@{u}" 2>/dev/null || echo 0)
dirty=$(git -C "$bob_root" status --porcelain 2>/dev/null | head -1)

if [[ "$behind" -eq 0 ]]; then
  emit "status=current"
fi
if [[ -n "$dirty" ]]; then
  emit "status=dirty behind=$behind"
fi
if [[ "$ahead" -gt 0 ]]; then
  emit "status=diverged ahead=$ahead behind=$behind"
fi

# Clean and behind → an update is safe to fast-forward. Parse friendly version
# strings from CLAUDE.md (the single source of truth for Bob's version) — the
# one they HAVE (local) and the one available (upstream).
extract_version() {
  # First vN.N(.N) token appearing after the "## Current Version" header.
  awk '/## Current Version/{f=1; next} f && match($0, /v[0-9]+\.[0-9]+(\.[0-9]+)?/){print substr($0, RSTART, RLENGTH); exit}'
}
current_v=$(extract_version < "$bob_root/CLAUDE.md" 2>/dev/null)
latest_v=$(git -C "$bob_root" show "@{u}:CLAUDE.md" 2>/dev/null | extract_version)
[[ -n "$current_v" ]] || current_v="?"
[[ -n "$latest_v" ]] || latest_v="?"

emit "status=behind behind=$behind current=$current_v latest=$latest_v"
