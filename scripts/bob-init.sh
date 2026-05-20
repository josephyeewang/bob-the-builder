#!/usr/bin/env bash
# bob-init.sh — scaffold a new project using the Bob the Builder protocol.
#
# Usage:
#   bash ~/tools/bob-the-builder/scripts/bob-init.sh <project-name>
#
# What it does:
#   - Creates the standard folder structure (docs/, contracts/, evals/, scripts/, tests/)
#   - Writes a starter project CLAUDE.md that references Bob (so future sessions auto-load it)
#   - Writes .claude/settings.json with the default hook set (format + typecheck)
#   - Writes .gitignore, .env.example, README.md
#   - git init's the repo with an initial commit
#
# Safe to re-run: skips anything that already exists.

set -euo pipefail

PROJECT_NAME="${1:-}"
if [[ -z "$PROJECT_NAME" ]]; then
  echo "Usage: bash bob-init.sh <project-name>" >&2
  echo "Example: bash bob-init.sh my-new-app" >&2
  exit 1
fi

# Detect Bob's install location from this script's path
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
BOB_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

# Resolve a portable form of Bob's path for the project's CLAUDE.md.
# Prefer ~ form if BOB_ROOT is inside $HOME.
if [[ "$BOB_ROOT" == "$HOME"/* ]]; then
  BOB_PATH_DISPLAY="~${BOB_ROOT#$HOME}"
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
mkdir -p docs/domains docs/reference contracts evals scripts tests src

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
# 3. .claude/settings.json — default hook set
# ──────────────────────────────────────────────────────────────────────
mkdir -p .claude
if [[ ! -f .claude/settings.json ]]; then
  echo "🪝 Writing .claude/settings.json (default hooks)..."
  cat > .claude/settings.json <<'EOF'
{
  "_comment": "Default hook set per Bob the Builder Step 6b. Hooks are 100% enforced; CLAUDE.md rules are ~80% advisory. Customize per project — see ~/tools/bob-the-builder/build-protocol.md §6b for the default rationale.",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "_comment_fire_when": "After Claude edits or writes any file",
        "hooks": [
          {
            "type": "command",
            "command": "echo '[hook] format check — customize this command for your stack (prettier / black / gofmt / etc.)'",
            "_comment_replace_with": "e.g.: cd \"$CLAUDE_PROJECT_DIR\" && npx prettier --write \"$CLAUDE_FILE_PATHS\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "_comment_fire_when": "When Claude finishes a turn — catch build errors before human reviews",
        "hooks": [
          {
            "type": "command",
            "command": "echo '[hook] typecheck/build — customize this command for your stack'",
            "_comment_replace_with": "e.g.: cd \"$CLAUDE_PROJECT_DIR\" && npx tsc --noEmit 2>&1 | head -20"
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
# 7. git init (only if not already a repo)
# ──────────────────────────────────────────────────────────────────────
if [[ ! -d .git ]]; then
  echo "🔧 Initializing git repo..."
  git init -q
  git add .
  git commit -q -m "Bootstrap project with Bob the Builder scaffold"
  echo "✓ git initialized with first commit."
else
  echo "✓ Already a git repo — skipping init."
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
