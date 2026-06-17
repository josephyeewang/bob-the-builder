---
name: bob
description: "Use when the user wants to build, audit, or evolve a product using the Bob the Builder protocol. Triggers: any mention of 'bob', 'bob the builder', 'build protocol', 'NEW mode', 'AUDIT mode', 'EVOLVE mode', or requests to scope/spec/build a new product systematically, assess an existing partially-built product against a discipline, or extend an existing product with the same protocol. Optimized for a non-engineer product leader using Claude Code for implementation. Covers spec creation, phase-by-phase build with human gates, reconciliation, adversarial review, behavioral cores for AI products, and a 34-lens audit library (v2.17, extended through v2.22) covering engineering / UX / AI / performance / reach / operational / strategic / growth angles — including end-to-end input/data-flow tracing (L31), analytical method soundness across AI and deterministic logic (L32), in-product output register/audience-fit (L33), and a unified SEO / AEO / GEO discoverability audit (L34) that scores whether search, answer, and generative engines (ChatGPT / Perplexity / AI Overviews) find, rank, and cite the site and then delivers a three-altitude action plan — tactical fixes, content to produce, and strategic opportunity discovery (what to create next) — synthesized from 46+ industry sources plus the Princeton GEO paper — with an explicit execution-first principle (v2.17.1) that drives Playwright / Schemathesis / Garak / API queries rather than only reading code, and a self-learning loop (v2.18) where each audit auto-emits a lens retro that — once accumulated — flags which lenses to sharpen, under human judgment (Bob never auto-edits its own lenses), refined in v2.19 with post-deploy verification and class-level fix enforcement drawn from the first real field retro, and a spec-phase Coverage Taxonomy (v2.25, Step 1b) — a fixed 9-category Clear/Partial/Missing checklist harvested from GitHub Spec Kit's /clarify that catches structural spec gaps before the build."
user-invocable: true
---

# Bob the Builder

A systematic protocol for building, auditing, and evolving products with Claude Code. Designed for a non-engineer product leader.

## What to do when this skill is invoked

**Step 0 — silent update check (do this FIRST, before anything else).** Run:

```bash
bash ~/.claude/skills/bob/../scripts/bob-update-check.sh
```

It prints exactly one line, `BOB_UPDATE: status=...`. It is throttled (one network check per day) and degrades silently offline, so it's cheap to run every time. Act on the status:

- **`status=behind`** (line includes `current=` and `latest=`) — an update is available and safe to fast-forward. This is the ONE place at startup you may add a yes/no before the mode menu. Say, in plain language: *"📦 A newer Bob is available (v2.18 → v2.19, 3 updates since you installed). Want me to grab it before we start? Takes about 5 seconds."* If **yes**, run the divergence-aware sequence from the **Updating Bob** section below, paraphrase what changed, then continue to the mode flow. If **no**, continue on the current version and do not ask again this session.
- **`status=dirty`** or **`status=diverged`** — an update exists, but their Bob install has local changes, so do NOT auto-update. Mention it in one quiet line (*"There's a newer Bob, but your copy has local changes — run `bash ~/tools/bob-the-builder/scripts/bob-doctor.sh` when you want to sort it out"*) and continue.
- **`status=current` / `skip` / `offline` / `noinstall`** — say nothing. Proceed straight to the normal startup flow below.

This check must never block the session: if the script errors or is missing, proceed silently. It does NOT count as the "one startup question" — the update offer only appears when genuinely behind, and the mode question is still the only thing the user decides in the common (up-to-date) path.

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
if [ ! -L ~/.claude/skills/bob ]; then \
  echo "⚠ ~/.claude/skills/bob is not a symlink. 'update bob' expects the README install layout."; \
  echo "  Run: bash ~/tools/bob-the-builder/scripts/bob-doctor.sh   (plain-English diagnosis)"; \
else \
  BOB_DIR="$(dirname "$(readlink ~/.claude/skills/bob)")" && cd "$BOB_DIR" && \
  git fetch -q origin && \
  AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null) && \
  BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null) && \
  DIRTY=$(git status --porcelain | head -1) && \
  if [ -n "$DIRTY" ]; then echo "⚠ Bob install has uncommitted changes at $BOB_DIR — resolve manually before updating."; \
  elif [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then echo "⚠ Bob install is DIVERGED from origin ($AHEAD ahead, $BEHIND behind) — resolve manually."; \
  elif [ "$BEHIND" -gt 0 ]; then git pull --ff-only && echo "✓ Bob updated ($BEHIND new commits)."; \
  else echo "✓ Bob is already up to date."; fi; \
fi
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
