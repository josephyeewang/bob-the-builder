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

v2.17 — 2026-05-23

v2.17 replaces Bob's single A7 audit phase with a **multi-lens audit library**: 30 ready-made audit prompts across 8 bands, locked-and-loaded so a non-engineer doesn't have to invent audits per project. The user picks Curated (6-10 lenses, Bob proposes by project profile) or Full Enchilada (all 30, milestone scrubs); Bob's audit memory surfaces history + four options (Same / Complementary / Full / Custom) at every AUDIT entry. Lens library inventory (band by band):

- **Engineering Foundation (L01-L06):** Hygiene & Liveness (folds prior A7a-A7j) · Spec Fidelity · Critical Capability Quality · Security & Threat Surface · Data Protection & Privacy · Supply Chain & Configuration
- **User Experience (L07-L10):** Ease & Cognitive Path · Friction & Trust · Wow & Emotional Peaks · Edge States & Recovery
- **AI Behavior (L11-L14):** Accuracy & Calibration · Right-Sizing & Model Fit · Interaction (HAX) & Safety · Cost & Latency Efficiency
- **Performance Economics (L15-L16):** Cost & Speed Drivers (incl. tradeoff inversion — *where to invest more for value*) · Effectiveness & Quality Drivers
- **Reach & Distribution (L17-L20):** Device & Form Factor · i18n & Language · Accessibility (WCAG+) · Shareability, Virality & Discoverability
- **Operational (L21-L23):** Observability & Incident Readiness · Vendor & Dependency Risk · Documentation & Onboardability
- **Strategic & Market (L24-L28):** Competitive Benchmarking · Pricing & Monetization · Marketing/Copy/Website · Persona Simulation · Strategic Edge & Wedge Sharpness (the anti-convergence lens — vetoes earlier UX findings that are intentional wedge, not bug)
- **Growth & Adoption (L29-L30):** Onboarding & Activation · Retention & Compounding Loops

Provenance: we surveyed 12 commercial AI code-review tools (CodeRabbit, Greptile, Bito, Qodo PR-Agent, Sourcery, DeepSource, Cursor Bugbot, GitHub Copilot Code Review, Graphite Diamond, CodeAnt, diffray, Kodus), 14 industry audit taxonomies (ISO 25010:2023, OWASP T10:2025, OWASP ASVS 5.0, STRIDE, CWE Top 25, NIST SSDF, WCAG 2.2, GDPR Art.30, Microsoft SDL, SonarQube, Snyk, GitLab Secure, CodeQL, OWASP LLM Top 10:2025), 13 UX / product audit methods (Nielsen, NN/g, Cognitive Walkthrough, Norman, JTBD, Friction Log, Peak-End, Aha Moment, Edge States, HAX, Brignull Dark Patterns, Content audits, Conversational UX), and strategic / growth frameworks (Dunford, Play Bigger, Linear/Saarinen, 37signals, Hanlon, Ramanujam, Campbell, Wiebe, Eyal, Reforge, Andrew Chen, a16z retention benchmarks). Three lenses are Bob-distinctive contributions: L01 Liveness, L02 Spec Fidelity, L03 Critical Capability Quality — no surveyed tool generalizes any of them.

Per F47 meta-pattern: v2.17 dogfooded the lens library on Bob itself (Panel C — Methodology product: L01, L02, L03, L23, L24, L28). Headline meta-finding: *the lens library's biggest risk is sprawl, not shortfall.* Mitigations baked in: sequential execution + prior-report reading + L28 wedge veto + selection rubric defaulting to Curated 6-10 lenses per run. Deferred items F48-F51 logged in `audit-log.md` with named revisit triggers.

---

v2.16 (2026-05-20) integrated **external research into Bob's own logic** and dogfooded the integration on Bob itself. Before v2.16, Bob had exactly one external-research touchpoint (`A7f Capability Gap` in AUDIT only, at strategic-positioning level — never at mechanism-borrow level). Result: Bob was inward-looking by structure, even though "orchestrate, don't reinvent" was an implicit principle.

Five changes:

1. **NEW Step 3a-pre — Reference Scan (new sub-step).** Mandatory for Standard/Heavy. Scan 5-10 OSS repos matching the project profile before locking the stack, harvest mechanisms with Adopt/Defer/Reject verdicts, bias toward Reject. Output: `docs/reference-scan.md`.
2. **EVOLVE E3-pre — Scoped Reference Scan (size-gated).** Fires for Large always, Medium with new subsystems/integrations/patterns. Skip Small. Also: Medium+ evolutions now write to `evolutions/{NNN-short-name}/` folders (Spec Kit idiom — F33) and switch from Claude Code plan mode to E4 via a named hard gate (Cline idiom — F34).
3. **AUDIT A7f split** into `A7f-capability` (existing positioning scan) + `A7f-implementation` (new mechanism-borrow scan, runs only on tools A7f-capability marked Reject). The split resolves the failure mode where strategic Reject silently lost mechanism-level signal.
4. **Section 3 — "Orchestrate, don't reinvent" promoted to a load-bearing principle.** Previously implicit (D-003 + audit-log F32). Now a named selection rule on top of the 6 Decision Factors, with explicit convergence-check + custom-build-threshold steps. Mandates `tool-decisions.md` rows include a "Considered orchestrating: [tool]" line.
5. **Dogfood pass:** the first A7f-implementation run was on Bob itself, against the 9 strategically-Rejected tools in D-001. Produced 3 Adopts, 6 Reject/Defer, 3 convergence signals, and a meta-finding ("bias toward Reject or this step becomes noise") that is now baked into the prose for all three new scan steps. F33 + F34 shipped opportunistically; **F35 (sharded rules files — the strongest single Adopt at 5-of-9 tool convergence) was Rejected on user review per D-004** — Joe applied the higher-order filter that convergence across tools is signal, not verdict. F35 is now the canonical anchor for the bias-toward-Reject principle: the mechanism scan correctly surfaced it; the human correctly rejected it.

Meta-pattern named in audit-log F47: *propose new audit step → dogfood it on Bob → let the meta-finding shape the prose, then ship.* v2.16 is the canonical instance; reference when proposing future audit additions.

---

v2.15 closes the three v2.14 deferred items:

1. **Per-phase Liveness check** (F26) — new Tier 1 phase-gate step. Every new/modified callable surface (routes, exported functions, jobs, AI call sites) gets smoked at the end of every phase, scoped to deltas only. Catches dead-on-arrival code the day it ships, not weeks later at hardening. Stop condition if anything reachable returns 5xx or throws.
2. **Per-stack auth-token recipes** (F27, reshaped) — `[N+1]j` now includes a per-stack table (Clerk, NextAuth, Supabase, Auth0, custom JWT, session cookies). No more "Claude figures it out fresh every project." A script was considered and rejected per D-003.
3. **`liveness-report.json` artifact** (F28) — A7j and per-phase Liveness now write structured findings to `audit-artifacts/liveness-report-*.json` alongside the markdown verdict table. Schema versioned. Enables CI consumption and diff-across-time.

v2.14 added **A7j Liveness Audit** ([N+1]j in NEW mode) — the first A7 audit that executes code rather than reading it. Addresses the "function looks correct in source but is silently dead at runtime" failure mode. Orchestrates incumbent tools: Knip, Vulture/Ruff/deptry, Schemathesis, Playwright, Vitest/pytest, promptfoo. Bob does not reinvent — Bob orchestrates.
