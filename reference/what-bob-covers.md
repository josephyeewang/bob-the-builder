# What Bob covers (capability summary)
<!-- living doc -->

> Moved word for word from `skill/SKILL.md` on 2026-10-29 (D-032), so the startup file every session reads keeps a pointer instead of a second list of what the core already indexes.

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
  `node "$(realpath ~/.claude/skills/bob/..)/scripts/audit-ledger-check.mjs" --streaks`) and a daily dropped-work check (`scripts/loop-check.mjs` +
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
