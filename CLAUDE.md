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

v2.16 — 2026-05-20

v2.16 integrates **external research into Bob's own logic** and dogfoods the integration on Bob itself. Before v2.16, Bob had exactly one external-research touchpoint (`A7f Capability Gap` in AUDIT only, at strategic-positioning level — never at mechanism-borrow level). Result: Bob was inward-looking by structure, even though "orchestrate, don't reinvent" was an implicit principle.

Five changes:

1. **NEW Step 3a-pre — Reference Scan (new sub-step).** Mandatory for Standard/Heavy. Scan 5-10 OSS repos matching the project profile before locking the stack, harvest mechanisms with Adopt/Defer/Reject verdicts, bias toward Reject. Output: `docs/reference-scan.md`.
2. **EVOLVE E3-pre — Scoped Reference Scan (size-gated).** Fires for Large always, Medium with new subsystems/integrations/patterns. Skip Small. Also: Medium+ evolutions now write to `evolutions/{NNN-short-name}/` folders (Spec Kit idiom — F33) and switch from Claude Code plan mode to E4 via a named hard gate (Cline idiom — F34).
3. **AUDIT A7f split** into `A7f-capability` (existing positioning scan) + `A7f-implementation` (new mechanism-borrow scan, runs only on tools A7f-capability marked Reject). The split resolves the failure mode where strategic Reject silently lost mechanism-level signal.
4. **Section 3 — "Orchestrate, don't reinvent" promoted to a load-bearing principle.** Previously implicit (D-003 + audit-log F32). Now a named selection rule on top of the 6 Decision Factors, with explicit convergence-check + custom-build-threshold steps. Mandates `tool-decisions.md` rows include a "Considered orchestrating: [tool]" line.
5. **Dogfood pass:** the first A7f-implementation run was on Bob itself, against the 9 strategically-Rejected tools in D-001. Produced 3 Adopts, 6 Reject/Defer, 3 convergence signals, and a meta-finding ("bias toward Reject or this step becomes noise") that is now baked into the prose for all three new scan steps. F33 + F34 shipped opportunistically; F35 (sharded rules files) deferred for a discrete EVOLVE pass.

Meta-pattern named in audit-log F47: *propose new audit step → dogfood it on Bob → let the meta-finding shape the prose, then ship.* v2.16 is the canonical instance; reference when proposing future audit additions.

---

v2.15 closes the three v2.14 deferred items:

1. **Per-phase Liveness check** (F26) — new Tier 1 phase-gate step. Every new/modified callable surface (routes, exported functions, jobs, AI call sites) gets smoked at the end of every phase, scoped to deltas only. Catches dead-on-arrival code the day it ships, not weeks later at hardening. Stop condition if anything reachable returns 5xx or throws.
2. **Per-stack auth-token recipes** (F27, reshaped) — `[N+1]j` now includes a per-stack table (Clerk, NextAuth, Supabase, Auth0, custom JWT, session cookies). No more "Claude figures it out fresh every project." A script was considered and rejected per D-003.
3. **`liveness-report.json` artifact** (F28) — A7j and per-phase Liveness now write structured findings to `audit-artifacts/liveness-report-*.json` alongside the markdown verdict table. Schema versioned. Enables CI consumption and diff-across-time.

v2.14 added **A7j Liveness Audit** ([N+1]j in NEW mode) — the first A7 audit that executes code rather than reading it. Addresses the "function looks correct in source but is silently dead at runtime" failure mode. Orchestrates incumbent tools: Knip, Vulture/Ruff/deptry, Schemathesis, Playwright, Vitest/pytest, promptfoo. Bob does not reinvent — Bob orchestrates.
