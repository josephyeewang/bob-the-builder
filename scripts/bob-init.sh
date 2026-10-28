#!/usr/bin/env bash
# bob-init.sh — scaffold a new project using the Bob the Builder protocol.
#
# Usage:
#   bash ~/.claude/skills/bob/../scripts/bob-init.sh <project-name>
#
# What it does:
#   - Creates the standard folder structure (docs/, contracts/, evals/, scripts/, tests/)
#   - Rule 28's spec audit is invoked via the skill symlink from any project:
#     python3 ~/.claude/skills/bob/../scripts/spec-audit.py docs/product-spec.md
#   - Writes a starter project CLAUDE.md that references Bob (so future sessions auto-load it)
#   - Writes .claude/settings.json with the default hook set (format + green-gate +
#     three guards: block-no-verify, config-protection and merge-guard, copied into .claude/hooks/)
#   - Writes .claude/required-checks.json (the merge guard's one list — empty = "no CI yet" stage)
#   - Writes docs/audit-ledger.json (Rule 30(d)), .bob-optional-pointers (Rule 23(c)),
#     scripts/loop-check.mjs + .github/workflows/loop-check.yml (the daily dropped-work check)
#   - Writes .gitignore, .env.example, README.md
#   - Records what it installed, and from which Bob commit, in .bob/installed.json, plus an empty
#     .bob/differences.md (D-019) — so `/bob UPGRADE` (scripts/bob-upgrade.mjs) can later tell
#     Bob's improvements from this project's deliberate changes
#   - git init's the repo with an initial commit
#
# Safe to re-run: skips anything that already exists.
# BOB_INIT_REFERENCE=1 (used only by bob-upgrade.mjs to build a throw-away copy of Bob's current
# scaffold): stops before the install record, git init and the pre-commit hook.

set -euo pipefail

PROJECT_NAME="${1:-}"
if [[ -z "$PROJECT_NAME" ]]; then
  echo "Usage: bash bob-init.sh <project-name>" >&2
  echo "Example: bash bob-init.sh my-new-app" >&2
  exit 1
fi

# Reject anything that isn't a single safe directory name.
# Allowed: letters, digits, hyphens, underscores, dots (but not as leading char).
# Rejects: path separators, traversal (..), leading dot/dash, spaces, shell metachars.
if [[ ! "$PROJECT_NAME" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]]; then
  echo "Error: invalid project name: '$PROJECT_NAME'" >&2
  echo "       Use only letters, digits, '-', '_', '.' (no leading dot/dash, no '/', no spaces)." >&2
  echo "       Example: my-new-app" >&2
  exit 1
fi

# Detect Bob's install location from this script's path
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
BOB_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Resolve a portable form of Bob's path for the project's CLAUDE.md.
# Prefer ~ form if BOB_ROOT is inside $HOME.
if [[ "$BOB_ROOT" == "$HOME"/* ]]; then
  BOB_PATH_DISPLAY="~${BOB_ROOT#"$HOME"}"
else
  BOB_PATH_DISPLAY="$BOB_ROOT"
fi

PROJECT_DIR="$PWD/$PROJECT_NAME"

if [[ -d "$PROJECT_DIR" ]]; then
  echo "⚠️  Directory already exists: $PROJECT_DIR"
  echo "    Continuing — will only create missing pieces."
else
  echo "📁 Creating project directory: $PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"

# ──────────────────────────────────────────────────────────────────────
# 1. Folder structure
# ──────────────────────────────────────────────────────────────────────
echo "📂 Creating folder structure..."
mkdir -p docs/domains docs/reference contracts evals scripts tests src .github/workflows

# ──────────────────────────────────────────────────────────────────────
# 2. Project CLAUDE.md (the critical file — references Bob so sessions auto-resume)
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f CLAUDE.md ]]; then
  echo "📝 Writing CLAUDE.md (with Bob protocol reference)..."
  cat > CLAUDE.md <<EOF
# $PROJECT_NAME

## Build protocol

This project uses the **Bob the Builder** protocol.

- **Full reference:** \`$BOB_PATH_DISPLAY/build-protocol.md\` (~2,600 lines — templates, appendices, architecture patterns)
- **Compact reference:** \`$BOB_PATH_DISPLAY/build-protocol-core.md\` (load this at session start)
- **Current state:** \`docs/build-manifest.md\`
- **Session start:** read this file → read \`build-protocol-core.md\` → read \`docs/build-manifest.md\` → resume.

Narrator Mode is on by default. Say "terse mode" to switch.

## What this project is

[2-3 sentences. Filled in during Step 1 (Product Spec).]

## Current phase

See \`docs/build-manifest.md\` for the current phase and progress.

## Architecture rules

[Filled in after Step 3 (Architecture Contract). Compact extraction of the rules Claude needs every session.]

## Never-do rules

These are mechanically enforced where possible (via hooks + linters) and load-bearing always. Negative rules are unambiguous — the failure mode is clear.

- Never commit \`.env\` files or any file containing real secrets
- Never call external APIs without rate limiting
- Never write to user-data tables without RLS policies (or equivalent multi-tenant isolation)
- Never bypass the provider abstraction in \`lib/providers/\` (once it exists)
- Never deploy without running type-check + integration tests
- Never use \`any\` type — use \`unknown\` and narrow

[Add project-specific never-do rules here during Step 3 (Architecture Contract).]

## Red flags (stop conditions)

[Filled in after Step 3. Conditions that should make Claude stop entirely — distinct from never-do rules (inline constraints), red flags are halt-the-build conditions.]

## Build / deploy / test commands

[Filled in during Step 6 setup. The commands the human will run most often.]

## Compaction instructions

When compacting, always preserve: current build phase, list of modified files, pending decisions, and test commands.

## Pointers to full specs (progressive disclosure)

- Read \`docs/repo-map.md\` at session start for the compressed view of the codebase.
- Read \`docs/product-spec.md\` for full product context.
- Read \`docs/behavioral-core.md\` if working on AI behavior (if this is an AI product).
- Read \`docs/architecture.md\` for tech stack and constraints.
- Read \`docs/breadboard.md\` for the user-flow sketch (Shape Up breadboard from Step 4a-pre).
- Read \`docs/domains/<subsystem>.md\` before working on a specific subsystem.
EOF
else
  echo "✓ CLAUDE.md already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 2b. AGENTS.md — cross-tool agent instruction file (v2.13)
# Thin pointer to CLAUDE.md so projects built with Bob remain portable
# to non-Claude agents (OpenAI Codex CLI, Cursor, Aider, etc.) that
# read AGENTS.md as their convention.
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f AGENTS.md ]]; then
  echo "📝 Writing AGENTS.md (cross-tool agent pointer)..."
  cat > AGENTS.md <<EOF
# $PROJECT_NAME — Agent Instructions

This project uses the **Bob the Builder** protocol. The canonical agent instructions live in **\`CLAUDE.md\`** — read that first.

\`AGENTS.md\` exists so non-Claude agents (OpenAI Codex CLI, Cursor, Aider, and others that read the AGENTS.md convention) can find their entry point. The content is in \`CLAUDE.md\`; this file is a pointer, not a parallel source of truth.

If you are an agent running on this repo:

1. Read \`CLAUDE.md\` for project context, architecture rules, never-do rules, and pointers to specs.
2. Read \`docs/build-manifest.md\` for current phase and progress.
3. Follow the Bob the Builder protocol at \`$BOB_PATH_DISPLAY/build-protocol.md\` (compact reference: \`build-protocol-core.md\`).

Updates to project conventions go in \`CLAUDE.md\`. Don't edit this file to add new rules — they'll get lost.
EOF
else
  echo "✓ AGENTS.md already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 3. .claude/settings.json — default hook set
# ──────────────────────────────────────────────────────────────────────
mkdir -p .claude
if [[ ! -f .claude/settings.json ]]; then
  echo "🪝 Writing .claude/settings.json (default hooks)..."
  cat > .claude/settings.json <<EOF
{
  "_comment": "Default hooks + permissions per Bob the Builder Step 6b + Rule 27 (Supervised Autonomy). Hooks are 100% enforced; CLAUDE.md rules are ~80% advisory. Customize per project — see ${BOB_PATH_DISPLAY}/build-protocol.md §6b + the 'Supervised Autonomy' section.",
  "_autonomy_note": "SUPERVISED AUTONOMY (Rule 27) — run BUILD PHASES milestone-gated. ⚠️ TRAP: defaultMode:'auto' is IGNORED in this project settings file — turn auto ON via Shift+Tab (⏵⏵ auto mode on) OR in ~/.claude/settings.json, per-session, on a fresh branch. Turn it OFF (Shift+Tab to Manual) when you return to foundations/spec. The REAL destructive-class guardrail in auto mode is Claude Code's built-in CLASSIFIER (blocks force-push, prod deploy/migrate, mass-delete, secret-exfil, git reset --hard, IaC destroy). The 'deny' rules below are belt-and-suspenders only — they are PREFIX/substring matches, NOT semantic, so they do NOT catch every deletion (e.g. find -delete, > redirect, a python rmtree). 'ask' rules = milestone checkpoints. HARD RULE: never expose PROD credentials to an autonomous run (the real Replit-DB-wipe lesson — separate prod/dev). Auto pauses after 3-in-a-row / 20-total classifier blocks (and ABORTS in headless -p).",
  "permissions": {
    "defaultMode": "default",
    "ask": [
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
      "Bash(psql:*)", "Bash(mysql:*)", "Bash(mongosh:*)",
      "Bash(*deploy*)", "Bash(*migrate*)"
    ],
    "deny": [
      "Bash(rm -rf:*)", "Bash(rm -fr:*)",
      "Bash(git push --force:*)", "Bash(git reset --hard:*)", "Bash(git clean:*)",
      "Bash(find:* -delete*)",
      "Read(.env)", "Read(**/*credentials*)", "Read(**/.ssh/**)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "_comment_fire_when": "Before Claude runs any shell command. Blocks skipping the commit checks: git commit/push --no-verify (or -n), git -c core.hooksPath=..., and git config writing core.hooksPath. From ECC (MIT) — see .claude/hooks/block-no-verify.js. You can still bypass by hand in your own Terminal; this only stops Claude.",
        "hooks": [
          {
            "type": "command",
            "command": "node \"\$CLAUDE_PROJECT_DIR/.claude/hooks/block-no-verify.js\" >/dev/null"
          }
        ]
      },
      {
        "matcher": "Bash",
        "_comment_fire_when": "Before Claude runs any shell command that could merge a pull request or push to main. The merge guard (D-018): refuses gh pr merge / a merge through the GitHub API unless every check named in .claude/required-checks.json passes, and refuses a direct push to main once that list names any check. While the list is empty (no CI yet) merges and pushes go ahead with a one-line notice. No off switch; fails closed if the guard, Node, gh or the list is missing. See .claude/hooks/lib/merge-guard.mjs.",
        "hooks": [
          {
            "type": "command",
            "timeout": 120,
            "command": "INPUT=\$(cat); if printf '%s' \"\$INPUT\" | grep -Eiq 'merg|push|send-pack|refs/heads|contents|graphql|updateref|commitonbranch|createref|deleteref|sync'; then G=\"\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/merge-guard.mjs\"; [ -f \"\$G\" ] || G=\"\$(git rev-parse --show-toplevel 2>/dev/null)/.claude/hooks/merge-guard.mjs\"; [ -f \"\$G\" ] || { echo 'BLOCKED (merge guard): .claude/hooks/merge-guard.mjs not found, so the merge or push cannot be checked' >&2; exit 2; }; command -v node >/dev/null 2>&1 || { echo 'BLOCKED (merge guard): Node is not installed, so the merge or push cannot be checked (install Node 18 or newer)' >&2; exit 2; }; printf '%s' \"\$INPUT\" | node \"\$G\" || exit 2; fi"
          }
        ]
      },
      {
        "matcher": "Monitor",
        "_comment_fire_when": "The same merge guard on the Monitor tool (a watch command can merge too). Only the guard runs here.",
        "hooks": [
          {
            "type": "command",
            "timeout": 120,
            "command": "INPUT=\$(cat); if printf '%s' \"\$INPUT\" | grep -Eiq 'merg|push|send-pack|refs/heads|contents|graphql|updateref|commitonbranch|createref|deleteref|sync'; then G=\"\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/merge-guard.mjs\"; [ -f \"\$G\" ] || G=\"\$(git rev-parse --show-toplevel 2>/dev/null)/.claude/hooks/merge-guard.mjs\"; [ -f \"\$G\" ] || { echo 'BLOCKED (merge guard): .claude/hooks/merge-guard.mjs not found, so the merge or push cannot be checked' >&2; exit 2; }; command -v node >/dev/null 2>&1 || { echo 'BLOCKED (merge guard): Node is not installed, so the merge or push cannot be checked (install Node 18 or newer)' >&2; exit 2; }; printf '%s' \"\$INPUT\" | node \"\$G\" || exit 2; fi"
          }
        ]
      },
      {
        "matcher": "Edit|MultiEdit|Write",
        "_comment_fire_when": "Before Claude edits a file. Blocks edits to EXISTING lint/format settings (eslint, prettier, biome, ruff, stylelint, markdownlint + their ignore files) so Claude fixes the code instead of loosening the rules to get the green-gate to pass. Creating a new settings file is allowed. Does NOT cover tsconfig.json. From ECC (MIT) — see .claude/hooks/config-protection.js. To change a lint rule on purpose, edit it yourself or remove this entry for that session.",
        "hooks": [
          {
            "type": "command",
            "command": "node \"\$CLAUDE_PROJECT_DIR/.claude/hooks/config-protection.js\" >/dev/null"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "_comment_fire_when": "After Claude edits or writes any file",
        "hooks": [
          {
            "type": "command",
            "command": "echo '[hook] format check — customize this command for your stack (prettier / black / gofmt / etc.)'",
            "_comment_replace_with": "e.g.: cd \"\$CLAUDE_PROJECT_DIR\" && npx prettier --write \"\$CLAUDE_FILE_PATHS\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "_comment_fire_when": "The 'don't-stop-until-green' gate (Rule 27). Runs .claude/hooks/green-gate.sh: full-suite typecheck+build+test; exit 2 forces Claude to keep fixing until green. It is GUARDED against the infinite-loop footgun (stop_hook_active + a hard bounded-retry counter — surfaces to you after N attempts instead of looping). EDIT the script: set TEST_CMD for your stack.",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"\$CLAUDE_PROJECT_DIR/.claude/hooks/green-gate.sh\""
          }
        ]
      }
    ]
  }
}
EOF
else
  echo "✓ .claude/settings.json already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 3b. .claude/agents/reviewer.md — the per-milestone fresh-context reviewer (Rule 27)
# ──────────────────────────────────────────────────────────────────────
mkdir -p .claude/agents
if [[ ! -f .claude/agents/reviewer.md ]]; then
  echo "🔍 Writing .claude/agents/reviewer.md (milestone reviewer subagent)..."
  cat > .claude/agents/reviewer.md <<'EOF'
---
name: reviewer
description: Fresh-context milestone reviewer (Bob Rule 27). Invoke at EVERY build-phase boundary — before the human gate — to check the diff against the plan for correctness, drift, and silent failures.
tools: Read, Grep, Glob, Bash
model: inherit
omitClaudeMd: true
---
You are a critical, independent reviewer. You did NOT write this code and you do NOT see the author's reasoning — only the diff and the phase's done-criteria. Independence is the point (a diff-only reviewer catches ~60× more false-passes than one that sees the author's rationale): assume the author is wrong and find what they missed. (`model: inherit` keeps you on the builder's model — never a cheaper one; `omitClaudeMd: true` (Claude Code >= 2.1.271) starts you without the project's CLAUDE.md so you read the work as a newcomer. Bash stays because you must run the tests yourself.)

At each milestone:
1. Read the phase's done-criteria (Build Manifest / plan) and the diff (`git diff`).
2. RUN the tests/build yourself — never trust a "done" claim (Green ≠ Correct; 45–76% of agent "done" claims are false-success, and LLM "is it done?" judgments are near-random — the diff and a real run are the truth).
3. **Diff the TEST files specifically** — flag any deleted, weakened, or newly-added-to-pass tests (the "rewrote the tests to go green" failure mode). Green means the code agrees with itself, not that it matches the spec. Also flag any change to `tsconfig.json` or other type/lint settings — the config-protection hook does not cover tsconfig.
4. Also check: state-diff sanity (does the diff actually implement the claimed work, or is the tree ~unchanged?), drift from spec, untested/unhandled paths, anything irreversible or outward-facing that slipped in.
5. **Failing-test receipt for every fix item** (Phase Gate 11): each fix item must name a test command — an item with none is an automatic BLOCK. For each, run `node ~/.claude/skills/bob/../scripts/prove-test-fails.mjs --commit <sha> --test "<cmd>" --fix <file>:<from>-<to>` (fix lines removed -> test must FAIL; restored -> must PASS) and include the receipt. You are a different session from the builder; that is what makes the receipt count.
6. **Done-criteria unchanged** (Phase Gate 12): run `node ~/.claude/skills/bob/../scripts/check-bar.mjs <phase-report.md>`; a changed bar without a dated "bar changed because" line is a BLOCK.
7. Verdict: PASS (ready for the human diff-review) or BLOCK (with the specific issues). Never rubber-stamp.

You review; you do NOT edit. The human still owns the final diff review and any irreversible action.
EOF
else
  echo "✓ .claude/agents/reviewer.md already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 3c. .claude/hooks/green-gate.sh — the GUARDED don't-stop-until-green gate (Rule 27)
# ──────────────────────────────────────────────────────────────────────
mkdir -p .claude/hooks
if [[ ! -f .claude/hooks/green-gate.sh ]]; then
  echo "🚦 Writing .claude/hooks/green-gate.sh (guarded green-gate)..."
  cat > .claude/hooks/green-gate.sh <<'GATEEOF'
#!/usr/bin/env bash
# Bob green-gate (Rule 27): "don't-stop-until-green" — a Stop hook that forces Claude to
# keep fixing until the build/tests pass. GUARDED against the infinite-loop footgun.
# CUSTOMIZE: set TEST_CMD below to your stack's full-suite command.
set -uo pipefail
INPUT="$(cat)"

# ── Loop guard A: honor stop_hook_active if the harness sets it (avoid re-entrant loops) ──
if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then exit 0; fi

# ── Loop guard B (HARD, docs-independent): bounded retry counter per session ──
# stop_hook_active is absent from current docs and has propagation bugs, so we ALSO cap retries.
SESSION="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
SESSION="${SESSION:-default}"
COUNT_FILE="/tmp/bob-greengate-${SESSION}"
MAX_ATTEMPTS=8
n="$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))"
printf '%s' "$n" > "$COUNT_FILE"
if [ "$n" -gt "$MAX_ATTEMPTS" ]; then
  echo "[green-gate] $MAX_ATTEMPTS attempts without green — surfacing to the human instead of looping." >&2
  rm -f "$COUNT_FILE"
  exit 0   # let Claude stop; a human is needed
fi

# ── The gate: run the FULL suite (this is also your regression / anti-forgetting check) ──
# CUSTOMIZE THIS LINE for your stack (e.g. npm / pnpm / uv / cargo / go / xcodebuild):
TEST_CMD="echo 'EDIT .claude/hooks/green-gate.sh: set TEST_CMD (e.g. npm run typecheck && npm run build && npm test)'; false"
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if OUT="$(bash -c "$TEST_CMD" 2>&1)"; then
  rm -f "$COUNT_FILE"
  exit 0   # green → allow stopping
fi

# ── Not green → block (exit 2) with the trimmed failure as the fix instruction ──
{
  echo "[green-gate] build/tests NOT green (attempt $n/$MAX_ATTEMPTS). Fix these before finishing the phase:"
  printf '%s\n' "$OUT" | tail -50
} >&2
exit 2
GATEEOF
  chmod +x .claude/hooks/green-gate.sh
else
  echo "✓ .claude/hooks/green-gate.sh already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 3d. Guard hooks: block-no-verify + config-protection (D-017, from ECC, MIT)
#     and the merge guard (D-018). Copied INTO the project (not pointed at
# Bob's install) so they travel with the repo, work for anyone who clones it,
# and keep working if Bob moves. Need Node.
# ──────────────────────────────────────────────────────────────────────
mkdir -p .claude/hooks/lib
for f in block-no-verify.js config-protection.js lib/shell-scan.js merge-guard.mjs lib/merge-guard.mjs; do
  if [[ ! -f ".claude/hooks/$f" ]]; then
    cp "$BOB_ROOT/scripts/hooks/$f" ".claude/hooks/$f"
  fi
done
chmod +x .claude/hooks/block-no-verify.js .claude/hooks/config-protection.js .claude/hooks/merge-guard.mjs
if [[ ! -f .claude/required-checks.json ]]; then
  cp "$BOB_ROOT/templates/required-checks.json" .claude/required-checks.json
fi
echo "🛡  Guard hooks in .claude/hooks/: block-no-verify.js (no skipping commit checks), config-protection.js (no loosening lint settings), merge-guard.mjs (no merging past a red check)."
echo "   The merge guard starts in its \"no CI yet\" stage: .claude/required-checks.json lists no checks, so merges and pushes go ahead with a notice. Name your CI checks there once CI exists."
if ! command -v node >/dev/null 2>&1; then
  echo "   ⚠ Node is not installed (https://nodejs.org, version 18 or newer). Until it is, block-no-verify and config-protection do not run,"
  echo "     and the merge guard REFUSES every merge and every push to main (it fails closed rather than wave things through)."
fi

# ──────────────────────────────────────────────────────────────────────
# 3e. Process records (D-018): the audit ledger (Rule 30(d)), the optional-
#     pointer list (Rule 23(c)), and the daily dropped-work check.
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f docs/audit-ledger.json ]]; then
  echo "📒 Writing docs/audit-ledger.json (Rule 30(d) — every audit, what it found)..."
  sed "s/{project-name}/$PROJECT_NAME/" "$BOB_ROOT/templates/audit-ledger.json" > docs/audit-ledger.json
fi
if [[ ! -f .bob-optional-pointers ]]; then
  cat > .bob-optional-pointers <<'EOF'
# Paths CLAUDE.md / AGENTS.md may name before (or without) the file existing.
# Read by Bob's coherence sweep (class [8]); every OTHER path those files name must exist.
docs/behavioral-core.md
docs/breadboard.md
docs/repo-map.md
EOF
fi
if [[ ! -f scripts/loop-check.mjs ]]; then
  cp "$BOB_ROOT/templates/loop-check.mjs" scripts/loop-check.mjs
fi
if [[ ! -f .github/workflows/loop-check.yml ]]; then
  echo "🔁 Writing .github/workflows/loop-check.yml (daily dropped-work check — runs once the repo is on GitHub)..."
  cp "$BOB_ROOT/templates/loop-check.yml" .github/workflows/loop-check.yml
fi

# ──────────────────────────────────────────────────────────────────────
# 4. .gitignore
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f .gitignore ]]; then
  echo "📝 Writing .gitignore..."
  cat > .gitignore <<'EOF'
.DS_Store
*.swp
*~

# ── SECRETS (never commit real secrets) ──
.env
.env.local
.env.*.local
!.env.example

# ── DEPS / BUILD ──
node_modules/
dist/
build/
.next/
.vercel/
__pycache__/
*.pyc
.venv/
venv/

# ── LOGS ──
*.log
npm-debug.log*

# ── EDITORS ──
.vscode/
.idea/
EOF
else
  echo "✓ .gitignore already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 5. .env.example
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f .env.example ]]; then
  echo "📝 Writing .env.example (placeholder)..."
  cat > .env.example <<'EOF'
# Environment variables — copy this file to .env.local and fill in actual values.
# Never commit .env.local — it's gitignored.

# Example:
# DATABASE_URL=postgresql://...
# ANTHROPIC_API_KEY=sk-ant-...
# STRIPE_SECRET_KEY=sk_live_...
EOF
else
  echo "✓ .env.example already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 6. README.md (minimal placeholder)
# ──────────────────────────────────────────────────────────────────────
if [[ ! -f README.md ]]; then
  echo "📝 Writing README.md placeholder..."
  cat > README.md <<EOF
# $PROJECT_NAME

[One-paragraph product description. Filled in during Step 1 (Product Spec).]

## Status

Built using the [Bob the Builder](https://github.com/josephyeewang/bob-the-builder) protocol. Current phase: see \`docs/build-manifest.md\`.
EOF
else
  echo "✓ README.md already exists — leaving it alone."
fi

# ──────────────────────────────────────────────────────────────────────
# 6b. Install record (D-019): what Bob installed + from which Bob commit,
#     so /bob UPGRADE can later diff. Needs Node; without it, UPGRADE
#     infers the same thing by comparing files.
# ──────────────────────────────────────────────────────────────────────
if [[ "${BOB_INIT_REFERENCE:-}" == "1" ]]; then
  exit 0   # throw-away reference copy for bob-upgrade.mjs — nothing below applies
fi
if [[ ! -f .bob/installed.json ]]; then
  if command -v node >/dev/null 2>&1; then
    node "$BOB_ROOT/scripts/bob-upgrade.mjs" --record-install --project "$PROJECT_DIR" \
      || echo "   ⚠ Could not write .bob/installed.json — /bob UPGRADE will compare files instead."
  else
    echo "   ⚠ Node is not installed, so .bob/installed.json was not written — /bob UPGRADE will compare files instead."
  fi
fi

# ──────────────────────────────────────────────────────────────────────
# 7. git init (only if not already a repo)
# ──────────────────────────────────────────────────────────────────────
if [[ ! -d .git ]]; then
  # Preflight: git needs user.name + user.email configured to commit.
  # On a freshly installed machine these are blank; fail clearly with
  # the exact two paste-ready commands instead of a cryptic git error.
  if ! git config --get user.email >/dev/null 2>&1 || ! git config --get user.name >/dev/null 2>&1; then
    echo ""
    echo "⚠ git is not configured yet (needs user.name and user.email)."
    echo "  Paste these two commands into Terminal — replace with your real name and email:"
    echo ""
    echo "    git config --global user.name \"Your Name\""
    echo "    git config --global user.email \"you@example.com\""
    echo ""
    echo "  Then re-run this script. (Project directory and files are already created; re-running is safe.)"
    exit 1
  fi
  echo "🔧 Initializing git repo..."
  git init -q
  git add .
  git commit -q -m "Bootstrap project with Bob the Builder scaffold"
  echo "✓ git initialized with first commit."
else
  echo "✓ Already a git repo — skipping init."
fi

# ──────────────────────────────────────────────────────────────────────
# 7b. Coherence pre-commit hook (Rule 23/24 — push, not pull)
# ──────────────────────────────────────────────────────────────────────
# Runs the mechanical coherence sweep on every commit, so living-doc + contract
# drift is caught automatically (the non-engineer never has to remember to run
# it). Hard-fails only on a decision-log contiguity gap / retired-term / contract
# drift. ⚠ Respects a global core.hooksPath — a per-repo .git/hooks/pre-commit is
# IGNORED when one is set (common: a global gitleaks hook). In that case we CHAIN
# into the global hook, guarded so it no-ops in every non-Bob repo.
# D-019: it BLOCKS only where .bob/installed.json says "commit_sweep": "block" (bob-init writes that
# for a new project; /bob UPGRADE switches an existing project once its documents pass); anywhere
# else it prints the problems and lets the commit through. D-020: the logic lives in ONE script,
# scripts/commit-sweep.sh (blocking mode judges the STAGED files, so another session's unstaged edits
# can't stop a commit); this block only finds it, and says so loudly when Bob is missing.
BOB_HOOK_GUARD='# Bob coherence sweep (Rule 23/24) — no-ops outside a Bob project'
GLOBAL_HOOKS="$(git config --get core.hooksPath || true)"
COHERENCE_BLOCK="$(cat <<EOF

$BOB_HOOK_GUARD
__BOB_CS="$BOB_ROOT/scripts/commit-sweep.sh"
[ -x "\$__BOB_CS" ] || __BOB_CS="\$HOME/.claude/skills/bob/../scripts/commit-sweep.sh"
if [ -f docs/build-manifest.md ]; then
  if [ -x "\$__BOB_CS" ]; then
    "\$__BOB_CS" || exit 1
  elif [ -f .bob/installed.json ] && grep -Eq '"commit_sweep"[[:space:]]*:[[:space:]]*"block"' .bob/installed.json; then
    echo "⚠⚠ Bob's document check did NOT run: Bob was not found on this computer (looked for ~/.claude/skills/bob)."
    echo "   This project is set to stop commits with document problems, so this commit went through UNCHECKED."
    echo "   Fix: install Bob, or re-link it in the Terminal app: ln -s <your Bob folder>/skill ~/.claude/skills/bob"
  fi
fi
EOF
)"
if [[ -n "$GLOBAL_HOOKS" ]]; then
  GLOBAL_HOOKS_EXPANDED="${GLOBAL_HOOKS/#\~/$HOME}"
  GLOBAL_PC="$GLOBAL_HOOKS_EXPANDED/pre-commit"
  if [[ -f "$GLOBAL_PC" ]] && grep -q "Bob coherence sweep" "$GLOBAL_PC" 2>/dev/null; then
    echo "✓ Coherence sweep already chained into the global hook ($GLOBAL_PC)."
  else
    echo "🪝 A global core.hooksPath is set ($GLOBAL_HOOKS) — per-repo hooks are ignored."
    echo "   ACTION: chain the coherence sweep into $GLOBAL_PC by appending this (it no-ops outside Bob projects):"
    echo "─────────────────────────────────────────────────────────────────"
    echo "$COHERENCE_BLOCK"
    echo "─────────────────────────────────────────────────────────────────"
    echo "   (Bob does not auto-edit your global/shared hook — paste it in once, before the final 'exit 0'.)"
  fi
elif [[ -d .git ]] && [[ ! -f .git/hooks/pre-commit ]]; then
  echo "🪝 Installing coherence pre-commit hook (Rule 24)..."
  printf '#!/usr/bin/env bash\n%s\n' "$COHERENCE_BLOCK" > .git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
  echo "✓ pre-commit hook installed (bypass with --no-verify)."
fi

# ──────────────────────────────────────────────────────────────────────
# Done
# ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Project scaffolded: $PROJECT_DIR"
echo ""
echo "Next steps:"
echo "  1. cd \"$PROJECT_DIR\""
echo "  2. Open Claude Code in this folder"
echo "  3. Tell Claude:  \"We're using Bob the Builder. Read CLAUDE.md and start MODE: NEW. The product I want to build: [your idea]\""
echo ""
echo "Claude will resume the protocol from here. The CLAUDE.md references Bob, so subsequent sessions auto-load it."
