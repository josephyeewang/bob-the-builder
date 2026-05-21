# Bob the Builder — Build Protocol for Claude Code

## What This Is

A systematic framework for building, auditing, and evolving products with Claude Code. Optimized for a non-engineer product leader who is strong at conceptual scoping and relies on AI for implementation.

## How to Use

Tell Claude Code to read `build-protocol.md`. For first-time users, Claude will show a Journey Map (the full path from idea to launch) before asking which mode applies:

- **NEW** — Build a new product from scratch
- **AUDIT** — Assess an existing product
- **EVOLVE** — Add features or make changes

**Narrator Mode (v2.3) is silently ON by default.** Claude announces what's about to happen at every step, explains jargon inline, and summarizes progress after each completion. Claude does NOT announce that narrator mode is on at session start — it's the default, just be in it. Say "terse mode" anytime to switch to a quieter pace.

**Streamlined startup (v2.9).** When the skill is invoked, Claude asks exactly ONE question — *which mode (NEW / AUDIT / EVOLVE)*. Everything else (first-time detection, project sensing, complexity classification, housekeeping flags) is silent or proposed in a single narration block. No "is this the first time?" / "narrator on or terse?" / "does this map look right?" gates.

For daily use, load `build-protocol-core.md` (compact reference). Load `build-protocol.md` (full reference) when you need templates, appendices, or architecture patterns.

## File Structure

```
build-protocol.md          ← Full reference (all sections, templates, appendices)
build-protocol-core.md     ← Compact reference (~200 lines) for session context
templates/                  ← Extractable templates (phase report, behavioral core, etc.)
README.md                   ← Public-facing project overview
```

## Key Rules

- Follow steps in order. Stop at every human gate (`→ HG`).
- Specs are living documents — update them during build, not just at the beginning.
- Reconciliation after every phase is non-optional.
- No silent refactoring. No behavior drift. No scope creep.
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

v2.15 — 2026-05-20

v2.15 closes the three v2.14 deferred items:

1. **Per-phase Liveness check** (F26) — new Tier 1 phase-gate step. Every new/modified callable surface (routes, exported functions, jobs, AI call sites) gets smoked at the end of every phase, scoped to deltas only. Catches dead-on-arrival code the day it ships, not weeks later at hardening. Stop condition if anything reachable returns 5xx or throws.
2. **Per-stack auth-token recipes** (F27, reshaped) — `[N+1]j` now includes a per-stack table (Clerk, NextAuth, Supabase, Auth0, custom JWT, session cookies). No more "Claude figures it out fresh every project." A script was considered and rejected per D-003.
3. **`liveness-report.json` artifact** (F28) — A7j and per-phase Liveness now write structured findings to `audit-artifacts/liveness-report-*.json` alongside the markdown verdict table. Schema versioned. Enables CI consumption and diff-across-time.

v2.14 added **A7j Liveness Audit** ([N+1]j in NEW mode) — the first A7 audit that executes code rather than reading it. Addresses the "function looks correct in source but is silently dead at runtime" failure mode. Orchestrates incumbent tools: Knip, Vulture/Ruff/deptry, Schemathesis, Playwright, Vitest/pytest, promptfoo. Bob does not reinvent — Bob orchestrates.
