# Bob the Builder — Build Protocol for Claude Code

## What This Is

A systematic framework for building, auditing, and evolving products with Claude Code. Optimized for a non-engineer product leader who is strong at conceptual scoping and relies on AI for implementation.

## How to Use

Say `/bob` (or "bob") in Claude Code; the skill (`skill/SKILL.md`) loads `build-protocol-core.md` first and asks one question, which mode. First-time users see the Journey Map (the full path from idea to launch) after choosing NEW. The modes:

- **NEW** — Build a new product from scratch
- **AUDIT** — Assess an existing product
- **EVOLVE** — Add features or make changes
- **UPGRADE** — Bring a project Bob set up earlier up to date with the current Bob (`scripts/bob-upgrade.mjs`, D-019)

**Narrator Mode (v2.3) is silently ON by default.** Claude announces what's about to happen at every step, explains jargon inline, and summarizes progress after each completion. Claude does NOT announce that narrator mode is on at session start — it's the default, just be in it. Say "terse mode" anytime to switch to a quieter pace.

**Streamlined startup (v2.9).** When the skill is invoked, Claude asks exactly ONE question — *which mode (NEW / AUDIT / EVOLVE / UPGRADE)*. Everything else (first-time detection, project sensing, complexity classification, housekeeping flags) is silent or proposed in a single narration block. No "is this the first time?" / "narrator on or terse?" / "does this map look right?" gates.

For daily use, load `build-protocol-core.md` (compact reference). Load `build-protocol.md` (full reference) when you need templates, appendices, or architecture patterns.

## File Structure

```
build-protocol.md          ← Full reference (all sections, templates, appendices)
build-protocol-core.md     ← Shorter reference loaded into sessions (not small: ~440 lines)
templates/                  ← Extractable templates (phase report, behavioral core, etc.)
README.md                   ← Public-facing project overview
```

## Key Rules

- Follow steps in order. Stop at every human gate (`→ HG`).
- Specs are living documents — update them during build, not just at the beginning.
- Reconciliation after every phase is non-optional.
- No silent refactoring. No behavior drift. No scope creep.
- **Green ≠ Correct (Rule 25, v2.31 — cross-cutting).** CI passing, a health scan at "N/N", and "the job ran" verify *known-incident classes + syntactic success* — NOT semantic correctness, data completeness, or analytical soundness. Before trusting or reporting any data/analysis/pipeline result, run the forensics yourself and treat every plausible headline adversarially: census input null-rates (a ~0% field is a DEAD axis, not a "no signal"); confirm every collapse/dedup/group key captures all varying entities (spot-check the collapse ratio); distrust "no signal / anti-predictive" from selecting-on-realized-outcome (→ split-half); distrust "too sparse / untestable" (→ verify RAW volume — often an upstream collapse/backfill bug); residualize the dominant factor before declaring "one driver"; compute actual numbers before shipping anything outward-facing. Deepened in **L31** (dead-column / aggregation-blend / at-rest null census) and **L32** (empirical-validity forensics §4b). Origin: a data product build — nearly every user push uncovered a real defect all the green checks missed; the non-engineer shouldn't have to be the linchpin.
- When compacting, always preserve: current mode, current step, and any pending decisions.

## Success metrics (v2.11 — dogfooding Step 1a)

Bob's Step 1a requires every product to declare success metrics. Bob is a product. Here are its.

- **Self-application count** — Bob has been applied to Bob (Bob-on-Bob) across v2.2 → v2.13 (12+ EVOLVE cycles + 3 AUDIT passes on the protocol itself). *Current: 15+ cycles.* Note: self-application is a sanity check that the protocol is internally coherent and re-runnable — it is NOT a claim of effectiveness on external users. Real effectiveness signal requires the PR-back channel (Step [N+2]c). Per A7g's stop condition (v2.13), the honest read on the four metrics below is "structurally unmeasured" — not "passing."
- **Fix-commit ratio in projects using Bob** — target <30% (baseline: prior projects ran 70%). *Current: unmeasured externally; requires per-project manual git-log analysis. See A7g findings (v2.10 changelog).*
- **Deviation count declining over consecutive phases** — Build Manifest tracks this column per phase. *Current: unmeasured at adoption scale.*
- **Audit findings at hardening** — target <10 critical items at Step [N+1]. *Current: unmeasured externally.*
- **Non-engineer can complete a build end-to-end without engineer hand-holding** — qualitative. *Current: Joe (target persona) is the only verified data point.*

**Honest gap:** four of five metrics above are structurally unmeasured because Bob has no telemetry by design. The Step [N+2] PR-back template (v2.11) is the lightweight feedback mechanism — users self-report after building with Bob. Don't expect statistical signal soon; expect a slow trickle of anecdotes.

## Current Version

**See the "Core Reference for Build Protocol vN.N" line near the end of `build-protocol-core.md`** — that one line is the version; `bob-upgrade.mjs` and `scripts/bob-update-check.sh` both read it there. The dated record of what changed is the changelog in `build-protocol.md` and `decision-log.md`. (This section used to restate the version and fell behind — it said v2.31 while Bob was at v2.40 — so it now only points; D-020.)

## Older release notes

Moved to `CHANGELOG.md` (frozen, not kept up to date; not loaded into sessions).
