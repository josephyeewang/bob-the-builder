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
build-protocol-core.md     ← Loaded into every session: modes, steps, gates, and a one-line index of the rules
rules.md                    ← Every numbered rule, filed by when it is needed
templates/                  ← Extractable templates (phase report, behavioral core, etc.)
README.md                   ← Public-facing project overview
```

## Key Rules

Bob's rules live in `rules.md` (D-028), filed by when each is needed; `build-protocol-core.md` has a one-line index. This file does not repeat them. Rules 25 (Green ≠ Correct) and 33 (Bob dogfoods Bob) matter most when changing Bob itself.

## Success metrics (v2.11 — dogfooding Step 1a)

Bob's Step 1a requires every product to declare success metrics. Bob is a product. Here are its.

- **Self-application count** — Bob has been applied to Bob (Bob-on-Bob) across v2.2 → v2.13 (12+ EVOLVE cycles + 3 AUDIT passes on the protocol itself). *Current: 15+ cycles.* Note: self-application is a sanity check that the protocol is internally coherent and re-runnable — it is NOT a claim of effectiveness on external users. Real effectiveness signal requires the PR-back channel (Step [N+2]c). Per A7g's stop condition (v2.13), the honest read on the four metrics below is "structurally unmeasured" — not "passing."
- **Fix-commit ratio in projects using Bob** — target <30% (baseline: prior projects ran 70%). *Current: unmeasured externally; requires per-project manual git-log analysis. See A7g findings (v2.10 changelog).*
- **Deviation count declining over consecutive phases** — Build Manifest tracks this column per phase. *Current: unmeasured at adoption scale.*
- **Audit findings at hardening** — target <10 critical items at Step [N+1]. *Current: unmeasured externally.*
- **Non-engineer can complete a build end-to-end without engineer hand-holding** — qualitative. *Current: Joe (target persona) is the only verified data point.*

**Honest gap:** four of five metrics above are structurally unmeasured because Bob has no telemetry by design. The Step [N+2] PR-back template (v2.11) is the lightweight feedback mechanism — users self-report after building with Bob. Don't expect statistical signal soon; expect a slow trickle of anecdotes.

## Current Version

**See the "Core Reference for Build Protocol vN.N" line near the end of `build-protocol-core.md`** — that one line is the version; `bob-upgrade.mjs` and `scripts/bob-update-check.sh` both read it there. The dated record of what changed is `CHANGELOG.md`; the reasons are in `decision-log.md`. (This section used to restate the version and fell behind — it said v2.31 while Bob was at v2.40 — so it now only points; D-020.)

## Release notes

In `CHANGELOG.md`, the one changelog for Bob (D-027; not loaded into sessions).
