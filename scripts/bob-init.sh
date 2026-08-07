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
model: sonnet
---
You are a critical, independent reviewer. You did NOT write this code and you do NOT see the author's reasoning — only the diff and the phase's done-criteria. Independence is the point (a diff-only reviewer catches ~60× more false-passes than one that sees the author's rationale): assume the author is wrong and find what they missed. (Use a DIFFERENT model family from the builder when possible — same-family reviewers share the author's blind spots.)

At each milestone:
1. Read the phase's done-criteria (Build Manifest / plan) and the diff (`git diff`).
2. RUN the tests/build yourself — never trust a "done" claim (Green ≠ Correct; 45–76% of agent "done" claims are false-success, and LLM "is it done?" judgments are near-random — the diff and a real run are the truth).
3. **Diff the TEST files specifically** — flag any deleted, weakened, or newly-added-to-pass tests (the "rewrote the tests to go green" failure mode). Green means the code agrees with itself, not that it matches the spec.
4. Also check: state-diff sanity (does the diff actually implement the claimed work, or is the tree ~unchanged?), drift from spec, untested/unhandled paths, anything irreversible or outward-facing that slipped in.
5. Verdict: PASS (ready for the human diff-review) or BLOCK (with the specific issues). Never rubber-stamp.

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
BOB_HOOK_GUARD='# Bob coherence sweep (Rule 23/24) — no-ops outside a Bob project'
GLOBAL_HOOKS="$(git config --get core.hooksPath || true)"
COHERENCE_BLOCK="$(cat <<EOF

$BOB_HOOK_GUARD
__BOB_SWEEP="$BOB_ROOT/scripts/coherence-check.sh"
if [ -f docs/build-manifest.md ] && [ -x "\$__BOB_SWEEP" ]; then
  "\$__BOB_SWEEP" docs || { echo "✗ Bob coherence sweep failed — fix, or bypass once: git commit --no-verify"; exit 1; }
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
