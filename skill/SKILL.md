---
name: bob
description: "Use when the user wants to build, audit, or evolve a product using the Bob the Builder protocol. Triggers: any mention of 'bob', 'bob the builder', 'build protocol', 'NEW mode', 'AUDIT mode', 'EVOLVE mode', or requests to scope/spec/build a new product systematically, assess an existing partially-built product against a discipline, or extend an existing product with the same protocol. Optimized for a non-engineer product leader using Claude Code for implementation. Covers spec creation, phase-by-phase build with human gates, reconciliation, adversarial review, and behavioral cores for AI products."
user-invocable: true
---

# Bob the Builder

A systematic protocol for building, auditing, and evolving products with Claude Code. Designed for a non-engineer product leader.

## What to do when this skill is invoked

1. **Read the core protocol first**: `~/.claude/skills/bob/../build-protocol-core.md`. That file is the compact reference and contains the mode menu (NEW / AUDIT / EVOLVE), complexity assessment, document hierarchy, and rules. (The skill at `~/.claude/skills/bob` is a symlink to wherever the user cloned Bob — `..` from there resolves to the repo root regardless of install location.)

2. **Then follow the protocol's own instructions.** It tells you what to do next — including when to load the full reference at `~/.claude/skills/bob/../build-protocol.md` for templates, appendices, and architecture patterns.

3. **Streamlined startup (v2.9) — ONLY ONE question at startup: which mode.** Do all of this in ONE turn — never as preliminary yes/no questions:
   - Silently detect state (manifest exists? git status? what kind of project is this?)
   - Tentatively classify complexity (Light / Standard / Heavy) — propose, don't ask
   - Show ONE narration block with project sensing + tentative complexity + housekeeping flags
   - Present the mode menu and ask: **which mode?** That's it.

4. **Narrator Mode is silently ON.** Do NOT announce it. Do NOT ask the user to confirm. Do NOT ask "narrator on or terse?" Just be in narrator mode. User can opt out with "terse mode" any time.

5. **Never ask "is this the first time?"** — it's a filesystem check (`docs/build-manifest.md` exists?). Silent.

6. **Journey Map** is shown only AFTER mode selection, and only if mode is NEW for a first-time user. Not a gating confirmation.

## Argument handling

If the user invokes the skill with an argument (e.g., `/bob NEW`, `/bob AUDIT`, `/bob EVOLVE`), skip the mode menu and jump straight to that mode. If no argument, follow the protocol's default flow (Journey Map for first-time users, mode menu otherwise).

## Updating Bob

If the user says **"update bob"**, **"/bob update"**, or any equivalent phrasing requesting an update of the Bob protocol itself, run this **divergence-aware** sequence (the prior version used a bare `git pull` which fails silently when Bob's install has local commits or uncommitted edits — surface it loudly instead):

```bash
BOB_DIR="$(dirname "$(readlink ~/.claude/skills/bob)")" && cd "$BOB_DIR" && \
  git fetch -q origin && \
  AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null) && \
  BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null) && \
  DIRTY=$(git status --porcelain | head -1) && \
  if [ -n "$DIRTY" ]; then echo "⚠ Bob install has uncommitted changes at $BOB_DIR — resolve manually before updating."; \
  elif [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then echo "⚠ Bob install is DIVERGED from origin ($AHEAD ahead, $BEHIND behind) — resolve manually."; \
  elif [ "$BEHIND" -gt 0 ]; then git pull --ff-only && echo "✓ Bob updated ($BEHIND new commits)."; \
  else echo "✓ Bob is already up to date."; fi
```

After running, paraphrase the last few commit messages if any were pulled. The skill is a symlink into the Bob repo, so the update takes effect immediately — no re-install or re-symlink needed.

**If the divergence-aware check reports DIVERGED or UNCOMMITTED:** do NOT attempt to "fix" by force-pushing or resetting. Surface the state to the user and let them resolve. The local commits or edits may be intentional.

## Working directory awareness

The user often invokes this skill from a *different* project directory than `bob-the-builder/` itself. That is intentional and expected. The protocol files always resolve through the skill symlink (see the path form in step 1 above). The *target project* — the thing being built / audited / evolved — is the current working directory. Do not confuse the two.

## Key rules (also enforced inside the protocol)

- Follow steps in order. Stop at every human gate (`→ HG`).
- Specs are living documents — update them during build, not just at the beginning.
- Reconciliation after every phase is non-optional.
- No silent refactoring. No behavior drift. No scope creep.
- When compacting, always preserve: current mode, current step, and any pending decisions.
