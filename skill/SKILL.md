---
name: bob
description: "Build, audit, or evolve a product with the Bob the Builder protocol — Joe's spec→build→audit discipline for a non-engineer product leader directing Claude Code. Use on any mention of 'bob', 'bob the builder', 'build protocol', 'NEW mode', 'AUDIT mode', 'EVOLVE mode', 'UPGRADE mode', or when the user wants to scope/spec/build a new product systematically, assess a partially-built product against a discipline, extend an existing product the same way, or bring a project Bob set up earlier up to date with the current Bob. Covers spec creation with a coverage checklist, design gallery + lock, a pre-build review gate, phase-by-phase build with human gates, reconciliation, adversarial review, behavioral cores for AI products, and a multi-lens audit library (engineering / UX / AI / performance / reach / operational / strategic / growth, incl. data-flow tracing, method soundness, output register, SEO/AEO/GEO, and a standing data-fidelity crawler) that runs real tools, not just code reads."
user-invocable: true
---

# Bob the Builder

## What Bob covers (capability summary — moved out of the trigger description, v2.34)
- **Multi-lens audit library** (the current list and count: `audit-lenses/README.md`) (v2.17, extended through v2.33) across engineering / UX / AI / performance / reach /
  operational / strategic / growth angles. Named lenses: **L31** end-to-end input/data-flow tracing; **L32**
  analytical method soundness across AI and deterministic logic; **L33** in-product output register / audience
  fit; **L34** unified SEO / AEO / GEO discoverability audit — scores whether search, answer, and generative engines
  (ChatGPT / Perplexity / AI Overviews) find, rank, and cite the site, then delivers a three-altitude plan (tactical
  fixes, content to produce, strategic opportunity discovery), synthesized from 46+ industry sources + the Princeton
  GEO paper; **L37** (v2.32) a perpetual, generative data-fidelity crawler — a STANDING scheduled audit that walks
  SOURCE→EXTRACT→INTERPRET→LINK→COLLAPSE→OUTCOME→SERVE, generates falsifiable hypotheses against INDEPENDENT ORACLES
  (order_total ↔ quantity×unit_price, null-rate census, collapse-ratio, coverage-depth, cross-source reconciliation),
  and on every confirmed defect emits a new reactive invariant into the check registry (imagination → memory; the
  perpetual complement to L31's one-shot trace + L32's method soundness).
- **Execution-first principle** (v2.17.1): audits drive Playwright / Schemathesis / Garak / API queries rather than
  only reading code.
- **Self-learning loop** (v2.18, refined v2.19): each audit auto-emits a lens retro; accumulated retros flag which
  lenses to sharpen, under human judgment — Bob never auto-edits its own lenses. v2.19 added post-deploy
  verification and class-level fix enforcement from the first real field retro.
- **Spec-phase Coverage Taxonomy** (v2.25, Step 1b): a fixed 9-category Clear/Partial/Missing checklist harvested
  from GitHub Spec Kit's /clarify that catches structural spec gaps before the build.
- **Scheduled & unattended work** (2026-10, D-015/D-017): any capability that runs on a schedule or without a human
  watching (cron jobs, nightly pipelines, L37) follows `~/.claude/skills/bob/../templates/scheduled-work-protocol.md`
  — LOAD IT before designing or reviewing one — and uses `templates/run-claim.mjs` so a double, crashed or
  simultaneous run is harmless.
- **Guard hooks** (2026-10, D-017): `bob-init` copies two hooks into every new project — `block-no-verify.js` (Claude
  cannot skip the commit checks) and `config-protection.js` (Claude cannot loosen lint settings to go green).
- **Merge guard** (2026-10, D-018): `bob-init` also installs `merge-guard.mjs` — Claude cannot merge a pull request
  past a red required check or push straight to main. The one list of required checks is `.claude/required-checks.json`
  (empty at first = "no CI yet": merges go ahead with a notice). Only the owner edits that list.
- **Process records** (2026-10, D-018): `bob-init` writes `docs/audit-ledger.json` (Rule 30(d) — check it with
  `scripts/audit-ledger-check.mjs --streaks`) and a daily dropped-work check (`scripts/loop-check.mjs` +
  `.github/workflows/loop-check.yml`: stale PRs with no dated hold, open loops with no owner/due date/proof, an intake
  list over its cap, a scheduled job failing twice or silent). Running several sessions at once → use
  `templates/open-loops.md` (one list, one coordinator who alone merges) — `build-protocol.md` §"Parallel sessions".
- **UPGRADE mode** (2026-10-27, D-019): `/bob UPGRADE` brings a project Bob set up earlier up to date —
  `scripts/bob-upgrade.mjs` lists each Bob piece in the project as up to date / Bob has a newer version / missing /
  changed here on purpose (`.bob/differences.md`) / changed here with no reason written down, gives Bob's
  decision-log reason for each change, and applies only what the user approves (backups in `.bob/backups/<date>/`;
  hooks that can stop work arrive warn-only first). `bob-init` records what it installed in `.bob/installed.json`.
- **Three layers** (D-019): the user's global instructions (any task) · Bob (the one method for building software) ·
  the project (its own facts + deliberate differences from Bob). Write a rule once in the lowest layer that covers
  it; point, don't copy — `build-protocol-core.md` §"WHERE RULES LIVE". Bob's own Engineering Principles 1–9 are
  in §"ENGINEERING PRINCIPLES".
- **Mechanical checkers:** `scripts/spec-audit.py` (spec structure + leftover TODO/TBD), `scripts/coverage-check.py`
  (an audit's coverage record adds up), `scripts/doc-pointers-check.mjs` (every pointer in the root AGENTS.md /
  CLAUDE.md resolves; the status page is not stale — run inside `coherence-check.sh`), plus the Phase-Gate scripts;
  all regression-tested by `scripts/selftest-gate-scripts.sh`.

A systematic protocol for building, auditing, and evolving products with Claude Code. Designed for a non-engineer product leader.

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

1. **Read the core protocol first**: `~/.claude/skills/bob/../build-protocol-core.md`. That file is the compact reference and contains the mode menu (NEW / AUDIT / EVOLVE / UPGRADE), complexity assessment, document hierarchy, and rules. (The skill at `~/.claude/skills/bob` is a symlink to wherever the user cloned Bob — `..` from there resolves to the repo root regardless of install location.)

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

Different from "update bob" below: that updates **Bob itself**; UPGRADE updates **the project** in the current folder to match the Bob you have. Follow `build-protocol-core.md` §"MODE: UPGRADE" (U1–U5). In short:

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

## Key rules

Bob's numbered rules live in one file, `~/.claude/skills/bob/../rules.md` (D-028), filed by when each one is needed; the core has a one-line index of all of them. Read `rules.md` group 1 at the start of every session and each later group at the stage it names. The two that most often get skipped are also written into the steps: the Pre-Build Review Gate (Step 6.5, Rule 22) and "done means fresh-eyes clean" (Rule 30).
