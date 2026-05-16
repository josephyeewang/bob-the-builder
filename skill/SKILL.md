---
name: bob
description: "Use when the user wants to build, audit, or evolve a product using the Bob the Builder protocol. Triggers: any mention of 'bob', 'bob the builder', 'build protocol', 'NEW mode', 'AUDIT mode', 'EVOLVE mode', or requests to scope/spec/build a new product systematically, assess an existing partially-built product against a discipline, or extend an existing product with the same protocol. Optimized for a non-engineer product leader using Claude Code for implementation. Covers spec creation, phase-by-phase build with human gates, reconciliation, adversarial review, and behavioral cores for AI products."
user-invocable: true
---

# Bob the Builder

A systematic protocol for building, auditing, and evolving products with Claude Code. Designed for a non-engineer product leader.

## What to do when this skill is invoked

1. **Read the core protocol first**: `/Users/jowang/Desktop/bob-the-builder/build-protocol-core.md`. That file is the compact reference and contains the mode menu (NEW / AUDIT / EVOLVE), complexity assessment, document hierarchy, and rules.

2. **Then follow the protocol's own instructions.** It tells you what to do next — including when to load the full reference at `/Users/jowang/Desktop/bob-the-builder/build-protocol.md` for templates, appendices, and architecture patterns.

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

## Working directory awareness

The user often invokes this skill from a *different* project directory than `bob-the-builder/` itself. That is intentional and expected. The protocol files always live at the absolute paths above. The *target project* — the thing being built / audited / evolved — is the current working directory. Do not confuse the two.

## Key rules (also enforced inside the protocol)

- Follow steps in order. Stop at every human gate (`→ HG`).
- Specs are living documents — update them during build, not just at the beginning.
- Reconciliation after every phase is non-optional.
- No silent refactoring. No behavior drift. No scope creep.
- When compacting, always preserve: current mode, current step, and any pending decisions.
