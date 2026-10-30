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

For daily use, load `build-protocol-core.md` (compact reference). Load `build-protocol.md` (full reference), `modes/` or `reference/` when you need the full steps, the glossary, profiles or architecture patterns.

## File Structure

```
VERSION                     ← Bob's version, one line (D-032)
skill/SKILL.md              ← The front door: what /bob loads first
build-protocol-core.md      ← Loaded into every session: modes, steps, gates, and a one-line index of the rules
rules.md                    ← Every numbered rule, filed by when it is needed
build-protocol.md           ← Full reference: foundation, the NEW mode, the project checklist, session start, protocol evolution; points to the files below
modes/                      ← The AUDIT, EVOLVE and UPGRADE steps in full (audit.md, evolve.md, upgrade.md)
reference/                  ← Glossary, project profiles, architecture patterns, integration playbooks, anti-patterns, invariants, what Bob covers
audit-lenses/               ← The audit lens library: one file per lens, the list in README.md, panel choice in _selection-rubric.md
templates/                  ← Templates a project copies (phase report, behavioral core, etc.); blueprint-roadmap/ is the Blueprint
scripts/                    ← Bob's checks and tools (scripts/blueprint/ for the Blueprint, scripts/hooks/ for guard hooks)
skills/                     ← The two design skills (design-gallery, design-mockups)
orchestrate/                ← ORCHESTRATE, the multi-session loop (being built; its own README and LANES.md)
decision-log.md, CHANGELOG.md, audit-log.md, evolutions/, retros/, lens-retros/, fixtures/  ← History: why things are the way they are
README.md, SECURITY.md, CONTRIBUTING.md, LICENSE, third_party/, assets/                   ← The public face
CLAUDE.md (imports this file), .github/workflows/scripts-ci.yml                           ← Instructions for Claude; the checks that run on every change
```

## Who changes what (parallel sessions)

When two or more sessions work on Bob at once, each area has one writer. A change another area needs goes to that area's owner, not into its files. `scripts/one-home-check.mjs` skips text whose owner has not fixed it yet; its `SKIP` list says which.

| Area | Owner | Shared files both touch (pull first, keep edits small) |
|---|---|---|
| `orchestrate/`, `templates/blueprint-roadmap/`, `scripts/blueprint/` | ORCHESTRATE lead (lanes in `orchestrate/LANES.md`) | — |
| The NEW mode and startup text: core "MODES" and "MODE: NEW", `build-protocol.md` Part II, the startup steps in `skill/SKILL.md`; `scripts/bob-init.sh`, `spec-audit.py`, `doc-pointers-check.mjs` | ORCHESTRATE lead | — |
| Everything else | Bob upkeep | `VERSION` (one bump per change set; the ORCHESTRATE lanes bump once per milestone), `CHANGELOG.md`, `decision-log.md`, `.github/workflows/scripts-ci.yml` |

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

**Bob's version is the one line in `VERSION`** (D-032); `bob-upgrade.mjs`, `scripts/bob-update-check.sh` and CI read it there. Until D-032 it sat on the core's last line, so every change edited the file every session reads, and parallel sessions collided on it. The dated record of what changed is `CHANGELOG.md`; the reasons are in `decision-log.md`. (This section used to restate the version and fell behind, so it only points; D-020.)

## Release notes

In `CHANGELOG.md`, the one changelog for Bob (D-027; not loaded into sessions).
