---
name: bob
description: "Build, audit, or evolve a product with the Bob the Builder protocol — a spec→build→audit discipline for a non-engineer product leader directing Claude Code. Use on any mention of 'bob', 'bob the builder', 'build protocol', 'NEW mode', 'AUDIT mode', 'EVOLVE mode', 'UPGRADE mode', or when the user wants to scope/spec/build a new product systematically, assess a partially-built product against a discipline, extend an existing product the same way, or bring a project Bob set up earlier up to date with the current Bob. Covers spec creation with a coverage checklist, design gallery + lock, a pre-build review gate, phase-by-phase build with human gates, reconciliation, adversarial review, behavioral cores for AI products, and a multi-lens audit library (engineering / UX / AI / performance / reach / operational / strategic / growth, incl. data-flow tracing, method soundness, output register, SEO/AEO/GEO, and a standing data-fidelity crawler) that runs real tools, not just code reads."
user-invocable: true
---

# Bob the Builder

## What Bob covers (capability summary — moved out of the trigger description, v2.34)

The full capability summary is in `~/.claude/skills/bob/../reference/what-bob-covers.md` (moved there 2026-10-29, D-032). The core's "Templates & References" section indexes every template and script.

## What to do when this skill is invoked

**Step 0 — silent update check (do this FIRST, before anything else).** Run:

```bash
bash ~/.claude/skills/bob/../scripts/bob-update-check.sh
```

It prints exactly one line, `BOB_UPDATE: status=...`. It is throttled (one network check per day) and degrades silently offline, so it's cheap to run every time. Act on the status:

- **`status=behind`** (line includes `current=` and `latest=`) — an update is available and safe to fast-forward. This is the ONE place at startup you may add a yes/no before the mode menu. Say, in plain language: *"📦 A newer Bob is available (v2.18 → v2.19, 3 updates since you installed). Want me to grab it before we start? Takes about 5 seconds."* If **yes**, run the divergence-aware sequence from the **Updating Bob** section below, paraphrase what changed, then continue to the mode flow. If **no**, continue on the current version and do not ask again this session.
- **`status=dirty`** or **`status=diverged`** — an update exists, but their Bob install has local changes, so do NOT auto-update. Mention it in one quiet line (*"There's a newer Bob, but your copy has local changes — run `bash ~/.claude/skills/bob/../scripts/bob-doctor.sh` when you want to sort it out"*) and continue.
- **`status=current` / `skip` / `offline` / `noinstall`** — say nothing. Proceed straight to the normal startup flow below.

This check must never block the session: if the script errors or is missing, proceed silently. It does NOT count as the "one startup question" — the update offer only appears when genuinely behind, and the mode question is still the only thing the user decides in the common (up-to-date) path.

1. **Find Bob's folder, then read the core protocol first.** Run `realpath ~/.claude/skills/bob/..` in the shell; call the result BOB. Then read `BOB/build-protocol-core.md` by that absolute path, and every other Bob file named below the same way (the file-reading tool can't follow the `..` in `~/.claude/skills/bob/..`; `bash` and `cat` can). That file is the compact reference and contains the mode menu (NEW / AUDIT / EVOLVE / UPGRADE), complexity assessment, document hierarchy, and rules. (The skill at `~/.claude/skills/bob` is a symlink to wherever the user cloned Bob — `..` from there resolves to the repo root regardless of install location.)

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

If the user invokes the skill with an argument (e.g., `/bob NEW`, `/bob AUDIT`, `/bob EVOLVE`, `/bob UPGRADE`), skip the mode menu and jump straight to that mode. If no argument, follow the protocol's default flow (Journey Map for first-time users, mode menu otherwise).

## /bob UPGRADE — bring this project up to date with Bob

Different from "update bob" below: that updates **Bob itself**; UPGRADE updates **the project** in the current folder to match the Bob you have. Follow `~/.claude/skills/bob/../modes/upgrade.md` (U1–U5). In short:

1. Run `node "$(realpath ~/.claude/skills/bob/..)/scripts/bob-upgrade.mjs"` from the project folder. It changes nothing.
2. Retell the report in plain English — per item: what it does for the user, why Bob changed it (D-number + its one-line reason), what applying would change. Ask which to apply (`→ HG`). Do not use `--interactive` yourself (it needs a terminal); pass the user's choices with `--apply <item>,<item>` or `--apply all`.
3. For "changed here, reason not written down": ask keep (add `- <item>: <why>` to `.bob/differences.md`) or take Bob's (the old copy is backed up).
4. Tell the user which hooks arrived warn-only and how to switch them on later (`--enforce <item>`), and whether the commit-time document check blocks yet (`commit-sweep`).
5. Ask the reverse question the report prints — does this project do something better than Bob? — and offer to backwash it into Bob (generic wording, a decision-log entry, no project internals).
6. Commit the project's changed files like any other change.

## Updating Bob

If the user says **"update bob"**, **"/bob update"**, or any equivalent phrasing requesting an update of the Bob protocol itself, run this **divergence-aware** sequence (the prior version used a bare `git pull` which fails silently when Bob's install has local commits or uncommitted edits — surface it loudly instead):

```bash
if [ ! -L ~/.claude/skills/bob ]; then \
  echo "⚠ ~/.claude/skills/bob is not a symlink. 'update bob' expects the README install layout."; \
  echo "  Run: bash ~/.claude/skills/bob/../scripts/bob-doctor.sh   (plain-English diagnosis)"; \
else \
  BOB_DIR="$(cd -P ~/.claude/skills/bob/.. && pwd -P)" && cd "$BOB_DIR" && \
  git fetch -q origin && \
  if ! git rev-parse -q --verify "@{u}" >/dev/null; then echo "⚠ Bob's copy at $BOB_DIR is on branch '$(git branch --show-current)', which has no upstream. Switch it back to main (git checkout main) and run this again."; else \
  AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null) && \
  BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null) && \
  DIRTY=$(git status --porcelain | head -1) && \
  if [ -n "$DIRTY" ]; then echo "⚠ Bob install has uncommitted changes at $BOB_DIR — resolve manually before updating."; \
  elif [ "$AHEAD" -gt 0 ] && [ "$BEHIND" -gt 0 ]; then echo "⚠ Bob install is DIVERGED from origin ($AHEAD ahead, $BEHIND behind) — resolve manually."; \
  elif [ "$BEHIND" -gt 0 ]; then git pull --ff-only && echo "✓ Bob updated ($BEHIND new commits)."; \
  else echo "✓ Bob is already up to date."; fi; fi; \
fi
```

After running, paraphrase the last few commit messages if any were pulled. The skill is a symlink into the Bob repo, so the update takes effect immediately — no re-install or re-symlink needed.

**If the divergence-aware check reports DIVERGED or UNCOMMITTED:** do NOT attempt to "fix" by force-pushing or resetting. Surface the state to the user and let them resolve. The local commits or edits may be intentional.

## Working directory awareness

The user often invokes this skill from a *different* project directory than `bob-the-builder/` itself. That is intentional and expected. The protocol files always resolve through the skill symlink (see the path form in step 1 above). The *target project* — the thing being built / audited / evolved — is the current working directory. Do not confuse the two.

## Key rules

Bob's numbered rules live in one file, `~/.claude/skills/bob/../rules.md` (D-028), filed by when each one is needed; the core has a one-line index of all of them. Read `rules.md` group 1 at the start of every session and each later group at the stage it names. The two that most often get skipped are also written into the steps: the Pre-Build Review Gate (Step 6.5, Rule 22) and "done means fresh-eyes clean" (Rule 30).
