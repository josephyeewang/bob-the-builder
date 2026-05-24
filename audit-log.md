# Audit Log

> Cross-audit register for Bob the Builder itself. Created to fix v2.13 finding F22 — Bob mandates registering deferred items per A7i, but Bob wasn't doing it for itself. Each audit pass appends an entry; deferred items carry forward until they're either closed in a later release or explicitly re-Rejected.

This is the operational counterpart to `decision-log.md`. The decision log records *intentional non-goals* (Reject verdicts); this log records *deliberate deferrals* (Defer verdicts) so they don't get forgotten.

---

## EVOLVE pass — v2.17 (2026-05-23) — Multi-Lens Audit Library

**Trigger:** Joe's challenge in two parts. (1) Observation: even structured Claude builds miss things, and audits run on those builds also miss things — each audit catches different gaps depending on its angle. (2) Hypothesis: instead of a single A7 audit phase, Bob should ship a *library* of pre-written audit lens prompts attacking the codebase from many angles (hygiene, structure, security, UX, AI accuracy, pricing, virality, mobile, accessibility, wedge sharpness, persona simulation, etc.) — locked-and-loaded so a non-engineer doesn't have to invent them per project.

**Approach:** External research across four parallel agents — (1) industry code/quality audit taxonomies (ISO 25010, OWASP T10/ASVS, STRIDE, CWE25, NIST SSDF, WCAG, GDPR), (2) UX/product audit methods (Nielsen, NN/g, JTBD, Friction Log, Peak-End, Microsoft HAX, Brignull dark patterns), (3) AI-era code review tools (CodeRabbit, Greptile, Bito, Qodo PR-Agent, Sourcery, DeepSource, Cursor Bugbot, Copilot, Diamond, CodeAnt, diffray, Kodus), (4) strategic / growth frameworks (Dunford, Play Bigger, Linear/Saarinen, 37signals, Hanlon, Ramanujam, Campbell, Wiebe, Eyal, Reforge, Andrew Chen). Joe-driven extension: the lens taxonomy must cover operator-distinctive angles engineering audits never touch (pricing mechanics, mobile-first, i18n, virality, wedge sharpness, persona simulation).

### Library shipped: 30 lenses across 8 bands

- **Band 1 Engineering Foundation (6):** L01 Hygiene & Liveness (folds prior A7a-A7j) · L02 Spec Fidelity · L03 Critical Capability Quality · L04 Security & Threat Surface · L05 Data Protection & Privacy · L06 Supply Chain & Configuration
- **Band 2 User Experience (4):** L07 Ease & Cognitive Path · L08 Friction & Trust · L09 Wow & Emotional Peaks · L10 Edge States & Recovery
- **Band 3 AI Behavior (4):** L11 Accuracy & Calibration · L12 Right-Sizing & Model Fit · L13 Interaction (HAX) & Safety · L14 Cost & Latency Efficiency
- **Band 4 Performance Economics (2):** L15 Cost & Speed Drivers (incl. tradeoff inversion — *when to pay more for value*) · L16 Effectiveness & Quality Drivers
- **Band 5 Reach & Distribution (4):** L17 Device & Form Factor · L18 i18n & Language · L19 Accessibility (WCAG+) · L20 Shareability, Virality & Discoverability
- **Band 6 Operational (3):** L21 Observability & Incident Readiness · L22 Vendor & Dependency Risk · L23 Documentation & Onboardability
- **Band 7 Strategic & Market (5):** L24 Competitive Benchmarking · L25 Pricing & Monetization · L26 Marketing, Copy & Website · L27 Persona Simulation · L28 Strategic Edge & Wedge Sharpness
- **Band 8 Growth & Adoption (2):** L29 Onboarding & Activation · L30 Retention & Compounding Loops

Plus three infrastructure files: `_selection-rubric.md` (Bob's panel-proposal logic), `_aggregation.md` (dedup + L28 vetoes + ranking), `_audit-memory.md` (history-aware entry + four options: Same / Complementary / Full Enchilada / Custom).

### Dogfood pass on Bob itself

Per the v2.16 meta-pattern (F47 — *propose new audit step → dogfood on Bob → let meta-findings reshape prose, then ship*), v2.17's lens library was stress-tested against Bob as a "methodology product" (Panel C — L01, L02, L03, L23, L24, L28).

**Meta-findings:**

1. **L28 Wedge applied to Bob:** wedge clearly articulable ("methodology for non-engineer product leaders building with Claude Code"); named enemies present (engineer-first agent-coding tools — Spec Kit, Cursor rules, BMad); anti-feature list non-empty (no telemetry by design per A7g; no sharded rules per D-004; no custom liveness CLI per D-003); convergence drift low per v2.16 dogfood (5 of 9 tools converged on sharded rules — Bob rejected). **No new L28 findings.** Bob's wedge is intact and the lens library reinforces it (orchestrate incumbent tooling rather than build custom audit infrastructure).

2. **L02 Spec Fidelity applied to v2.17 work itself:** all 30 lens files referenced in `audit-lenses/README.md` exist on disk (verified). All three infrastructure files exist. `audit-history.json` schema documented in `_audit-memory.md` but not yet a live artifact — that's expected; it gets created on first real audit run. **No critical L02 findings.**

3. **L23 Documentation:** README.md needs an update to surface the lens library and v2.17. CLAUDE.md "Current Version" block needs bump from v2.16 to v2.17. Both addressed in this release.

4. **L01 Hygiene applied to lens-library writing:** lens files are markdown prose, no code, no liveness check needed. **N/A.**

**Headline meta-finding (informs future EVOLVE):** *the lens library's biggest risk is sprawl, not shortfall.* 30 lenses × ~225 lines each = ~6,750 lines of lens content + 3 infrastructure files = ~7,200 lines added in one EVOLVE. That's load-bearing infrastructure for the foreseeable future, but it crosses Bob's protocol size from one repo of ~3,000 lines to ~10,200 lines. Mitigations baked in: (a) sequential execution + prior-report reading prevents re-litigation; (b) L28 explicit veto mechanism prevents convergence-to-mediocrity; (c) selection rubric defaults to Curated 6-10 lenses per run, not Full Enchilada; (d) audit-memory entry surfaces history so users don't reinvent panel choice each time.

### Changes shipped in v2.17

- **A7 rewritten** from prior A7a-A7j scope-map structure to A7.0 (entry + panel selection), A7.1 (sequential lens execution), A7.2 (aggregation), A7.3 (fix & defer register). Prior A7a-A7j content folded into L01 Hygiene & Liveness lens prompt.
- **30 lens prompt files** at `audit-lenses/L01-L30.md`, each self-contained (purpose, source frameworks cited, audit method, check questions, output schema markdown + JSON, severity rubric, anti-pattern instructions, stop conditions, cross-lens handoff).
- **3 infrastructure files** at `audit-lenses/_{selection-rubric,aggregation,audit-memory}.md`.
- **`audit-lenses/README.md`** — library index, format spec, mode design, provenance (~46 sources cited).
- **`build-protocol.md` A7 section** rewritten (~250 lines → ~130 lines, with detail moved to lens files).
- **`build-protocol-core.md` AUDIT section** updated.
- **Version footers** bumped to v2.17.

### Deferred (revisit triggers named)

- **F48 — audit-history.json as a live artifact.** Currently the schema is documented in `_audit-memory.md` prose; Bob's protocol tells Claude to write to this file at A7.2. No tooling validates or constructs it. **Revisit trigger:** if 3+ external Bob users self-report friction with manual audit-history maintenance, or if Bob ever ships a programmatic helper, formalize the schema with JSON Schema validation. Until then, prose-driven is consistent with D-003.

- **F49 — Lens prompt evolution cadence.** 30 lens files reference dated industry sources. Industry frameworks evolve (OWASP ASVS will roll past 5.0; WCAG to 3.0; new AI safety standards; new pricing frameworks). **Revisit trigger:** annually, or when a major lens-referenced source has a non-trivial release (e.g., WCAG 3.0 ships).

- **F50 — Mobile / device / i18n auditing on Bob itself.** Bob is a markdown methodology — no UI, no mobile, no i18n. L17/L18/L19 are not applicable as long as Bob stays methodology-only. **Revisit trigger:** if Bob ever ships a hosted dashboard, telemetry pipeline, or community marketplace (revisit trigger per D-002).

- **F51 — Aggregation tooling.** Aggregation logic (dedup, L28 vetoes, ranking) is documented in `_aggregation.md` as prose. No script implements it. **Revisit trigger:** if users report inability to mentally aggregate findings across 6+ lenses per run, write a `scripts/aggregate-audit.sh` that consumes the JSON sidecars and produces the summary mechanically. Until then, prose-driven per D-003.

### Convergence with prior decisions

- **D-003 (orchestrate, don't reinvent):** every Tier 1 lens cites incumbent tooling (Knip, Schemathesis, Semgrep, Snyk, Gitleaks, axe-core, Lighthouse, TruLens, RAGAS, promptfoo, Garak, PyRIT, Stripe, etc.). Bob does not implement any audit scanners — Bob orchestrates them.
- **D-004 (single CLAUDE.md, not sharded):** unchanged. Lens prompts live in `audit-lenses/`, not in CLAUDE.md.
- **F47 meta-pattern (propose → dogfood on Bob → reshape prose → ship):** followed for v2.17. This entry is the dogfood evidence.

### Future audit consideration

The v2.17 lens library is itself a candidate for first-party stress-testing through future external Bob users. The PR-back template (v2.13, Step [N+2]c) is the lightweight feedback mechanism — when external users report which Curated panels they swap from, the selection rubric (`_selection-rubric.md`) gets refined. Track swap patterns in `audit-history.json` `user_swaps_from_recommended` field.

---

## EVOLVE pass — v2.16 (2026-05-20) — Reference Scan integration + dogfood findings

**Trigger:** User challenge — *"Bob feels inward-looking / self-sufficient. There are tons of interesting OSS repos with smart patterns; it's not hard for Claude Code to find the top 10 and grab the best of their capabilities. (1) Where in NEW / EVOLVE / AUDIT should this go? (2) Have we done it for Bob itself?"* Honest analysis confirmed the hypothesis: Bob had exactly **one** external-research touchpoint (`A7f Capability Gap` in AUDIT only), and it operated at the strategic-positioning level — never at the mechanism-borrowing level. The "orchestrate, don't reinvent" principle (D-003) existed but was buried in an ADR, not promoted to a load-bearing rule.

**Approach:** Joe authorized "do both" against my proposal (c) — dogfood the proposed new step on Bob itself FIRST, then ship the protocol edits informed by what the dogfood produced. This is the canonical Bob-on-Bob workflow.

### Dogfood pass (A7f-implementation, run on Bob v2.15 vs the 9 tools in D-001)

A research subagent scanned all 9 strategically-Rejected competitors (Plandex, Roo Code, goose, Continue.dev, Spec Kit, Cursor Rules, BMad, Aider, Cline) for borrow-worthy mechanisms. Output: 3 Adopts, 6 Reject/Defer per-tool findings, 3 convergence signals across ≥3 tools, and a meta-finding that **the step must be biased toward Reject** or it silently becomes a noise generator.

The meta-finding directly shaped how the new protocol prose is written (bias-toward-Reject is now a named instruction in NEW Step 3a-pre, EVOLVE E3-pre, and AUDIT A7f-implementation — all three reference this audit-log entry as the dogfood evidence).

**Convergence signals (≥3 tools shared):**
1. Markdown-with-YAML-frontmatter as the unit of reusable AI instruction (Cursor `.mdc`, Continue `.prompt`, Cline `.clinerules`, Roo `.roomodes`, goose `.goosehints`, BMad templates)
2. Per-feature directory pattern: `{feature-id}/` containing spec + plan + tasks + reconciliation (Spec Kit, BMad, Cline, Aider, Plandex)
3. Architect/planner ≠ executor as an explicit model boundary (Aider, Cline, Spec Kit, BMad)

### Changes shipped in v2.16

- **NEW mode Step 3a-pre — Reference Scan (new sub-step).** Mandatory for Standard/Heavy, optional for Light. Scan 5-10 recent OSS repos matching the project profile, harvest mechanisms with Adopt/Defer/Reject verdicts, bias toward Reject. Output: `docs/reference-scan.md`. Adopts must name a concrete insertion point or they become Defers.
- **EVOLVE E3-pre — Scoped Reference Scan (new sub-step).** Fires for Large always, Medium with new subsystems/integrations/patterns. Skip Small and pattern-extending Medium (already vetted at NEW 3a-pre).
- **EVOLVE E3 — Per-evolution folder structure (F33, borrowed from Spec Kit's `specs/{FEATURE-ID}/` idiom).** Medium+ evolutions create `evolutions/{NNN-short-name}/` containing spec-delta + plan + reference-scan + reconciliation note. Solves the "evolution 7 scattered across 4 docs" pain. Small evolutions skip — overhead exceeds value.
- **EVOLVE E3 → E4 — Plan-mode hard gate (F34, borrowed from Cline's Plan/Act model).** Medium+ evolutions must be drafted in Claude Code plan mode; switching to E4 is a named, deliberate transition. Names a gate Bob already implied softly via v2.7 prose; promoting it to a hard boundary directly attacks scope-creep at the highest-risk moment.
- **AUDIT mode A7f split into A7f-capability + A7f-implementation.** A7f-capability is the existing positioning scan, unchanged. A7f-implementation is the new mechanism scan, runs *only* on tools A7f-capability marked Reject, biased toward Reject. The dogfood meta-finding's "≤3 Adopts per 9 tools scanned" guidance is encoded in the prose.
- **Section 3 — "Orchestrate, don't reinvent" promoted to a load-bearing principle.** Previously implicit (D-003 + audit-log F32). Now a named selection rule on top of the 6 Decision Factors, with explicit convergence-check + custom-build-threshold + document-the-choice steps. Mandates `tool-decisions.md` rows include a "Considered orchestrating: [tool]" line every time.
- **Compact reference (build-protocol-core.md) updated:** NEW step 3 sequence now includes 3a-pre; EVOLVE sequence includes E3-pre + per-evolution folder + plan-mode gate; AUDIT A7f description names both sub-audits; rule 14 added for orchestrate-don't-reinvent. Version footer bumped to v2.16.

### Closed in v2.16

| # | Title | Notes |
|---|---|---|
| F33 | Per-evolution folder pattern in EVOLVE E3 (Spec Kit borrow) | Shipped opportunistically — insertion point lined up exactly with the new E3 prose. Validated by dogfood Top Adopt #2. |
| F34 | Plan-mode hard gate at EVOLVE E3 → E4 (Cline borrow) | Shipped opportunistically — directly attacks Joe's existing scope-lock concern. Validated by dogfood Top Adopt #3. |
| F36 | NEW 3a-pre Reference Scan step | The protocol infrastructure Joe asked for, informed by dogfood meta-finding |
| F37 | EVOLVE E3-pre Scoped Reference Scan (size-gated) | Same family as F36 but scoped per-evolution |
| F38 | AUDIT A7f split into capability + implementation | Resolves the "A7f silently lost mechanism-level signal" failure mode |
| F39 | "Orchestrate, don't reinvent" promoted to Section 3 load-bearing principle | Was implicit (D-003, F32); now mandatory on every tool decision |
| F40 | D-001 addendum clarifying strategic-Reject ≠ mechanism-Reject | See decision-log entry |

### Rejected on user review

| # | Title | Verdict | Logged in |
|---|---|---|---|
| F35 | Sharded rules files with frontmatter scope (Cursor `.mdc` borrow) — strongest single Adopt from dogfood (5-of-9 tool convergence) | **Reject** — Joe applied higher-order filter on user review: *"not sure why anyone would deviate from a single rules file."* Convergence across tools ≠ Adopt for Bob's target user. Now the canonical example of the bias-toward-Reject principle: the mechanism scan correctly surfaced it; the human filter correctly rejected it. | D-004 |

### Deferred from v2.16

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F41 | `.claude-ignore` companion file convention (Roo `.rooignore` borrow) | L | Lightweight Adopt; previously gated on F35 but that dependency dissolved when F35 was Rejected. Standalone value: excluding generated artifacts (audit reports, screenshots) from Claude's working context. Defer for now until at least one user reports artifact-pollution friction. | First PR-back citing context pollution from generated files |
| F42 | Frontmatter-tagged templates as named slash commands (Continue `.prompt` borrow) | L | Bob's `templates/` folder could be wrapped with `name`/`description`/`invokable` frontmatter so they become first-class slash commands. Lightweight; defer until at least one user reports template-discovery friction. | First PR-back citing template invocation friction |
| F43 | Explicit handoff prompts in protocol prose (BMad borrow) | L | A7.0 hardening scope map already implies the next-session priming; adding the literal "paste this to start A7b" block would reduce friction. Lightweight prose change, bundle with next AUDIT pass. | Next AUDIT pass |
| F44 | Branched plan versioning (Plandex borrow) | L | No clear pain today; Build Manifest + decision-log carry the equivalent. | First user report of plan-history churn |
| F45 | Recipe YAML for hardening audits (goose borrow) | L | Per D-003, Bob stays markdown-only. Revisit if Bob ever needs to run unattended in CI. | First real ask for Bob to run unattended |

### Informational

| # | Note |
|---|---|
| F46 | Dogfood meta-finding from the v2.16 A7f-implementation scan: **3 Adopts per 9 tools scanned (~33% hit rate) is the realistic high end**. The protocol prose now mandates bias-toward-Reject because, without it, the step degrades into a perpetual maybe-pile. This is the canonical reference for "scan should produce closure, not aspiration." Future scans that produce >50% Adopt rates should be re-run with stricter filtering — reference this finding in the re-run prompt. |
| F47 | The "do (b) first, then (a)" sequencing — dogfood the proposed step before mandating it — is itself a meta-pattern worth naming. When proposing a new audit step in future EVOLVE passes, run the proposed step on Bob first and let the dogfood meta-finding shape the prose. v2.16 is the canonical instance of this pattern; reference when proposing future audit additions. |

---

## EVOLVE pass — v2.15 (2026-05-20) — close v2.14 deferred items

**Trigger:** User challenge — "why not do the deferred items now?" Honest review: F26 was the actual fix for the failure mode v2.14 existed to address (per-phase Liveness catches dead functions the day they ship, not at next audit), F28 was trivial (10-line JSON spec addition), and F27 was reshapeable from a brittle cross-stack script into per-stack protocol prose that's strictly better.

**Changes shipped:**

- **F26 — Per-phase Liveness check (now Tier 1).** Added as step 3 in the Phase Gate enumeration (build-protocol.md §7 and build-protocol-core.md PHASE GATE). Scoped to phase deltas only (git diff vs prior phase tag). Same tool set as A7j but narrowed: only routes/functions/jobs/AI surfaces this phase touched. Stop condition if anything reachable returns 5xx. Skipped (with logged note in Phase Report) only if no runnable target OR phase touched no callable surface.
- **F27 reshaped — Per-stack auth-token recipes.** Added a table in `[N+1]j` covering Clerk, NextAuth/Auth.js, Supabase Auth, Auth0, custom JWT, and Rails/Django/Flask-Login session cookies. Tokens stash to `.env.test`. Pattern is "Claude detects auth provider during inventory, walks user through matching recipe, stashes token once." The original-shape F27 (a script) was rejected per D-003's no-reinvention stance.
- **F28 — `liveness-report.json` machine-readable output.** Both A7j and per-phase Liveness now write structured findings to `audit-artifacts/liveness-report-<timestamp>.json` alongside the markdown verdict table. Schema versioned (`schema_version: "1.0"`). Append-not-overwrite so diff-across-time works. Default `.gitignore` for `audit-artifacts/` unless user opts in.

**Order-of-operations note:** Per-phase Liveness (F26) is the more important of the three. v2.14 with only A7j would have caught the blood-test bug at the next audit; v2.15 catches it at phase verification. The latency between bug-shipped and bug-found shrinks from "weeks" to "minutes."

### Closed in v2.15

| # | Title | Notes |
|---|---|---|
| F26 | Per-phase Liveness check in Nb verification | Now Tier 1 Phase Gate step. Scoped to phase deltas. |
| F27 | Auth-token guidance (reshaped from script to per-stack recipes) | 6-stack table in `[N+1]j` |
| F28 | `liveness-report.json` machine-readable artifact | Versioned schema, append-not-overwrite |

### Deferred from v2.15

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F30 | A7j orchestration script (`bob-liveness.sh`) that detects stack and runs the right tool sweep with one command | L | Per D-003, Bob orchestrates via protocol prose, not custom tooling. Revisit only if external users report tool-orchestration friction as the biggest A7j pain point in PR-backs. | Multiple PR-back reports citing orchestration friction |
| F31 | History diff tooling on `liveness-report.json` (e.g., "since the last audit, 3 new surfaces went red") | L | The JSON shape now supports this; no consumer yet exists. Build when there's a second data point worth diffing. | After A7j has been run ≥3 times on the same project |

### Informational

| # | Note |
|---|---|
| F32 | F27's reshape — from "build a cross-stack script" to "per-stack recipes in protocol prose" — is the canonical example of how D-003 ("orchestrate, don't reinvent") applies to non-tool work too. The script would have been brittle (each auth provider's API surface drifts independently); the prose stays load-bearing because Claude reads it fresh each invocation and uses current docs. Reference this pattern when future deferred items tempt a custom-tool implementation. |

---

## EVOLVE pass — v2.14 (2026-05-20) — A7j Liveness Audit added

**Trigger:** User report — two functions in a downstream Bob-built product (Explain My Blood Test) implemented the previous day were silently broken on manual spot-check. Failure mode: static review and spec-match passed, but functions threw at first runtime invocation. Root cause: no A7 step actually executes code; every existing audit reads source and reasons about it.

**Change shipped:**

- **New audit step:** `[N+1]j Liveness Audit` (canonical playbook in NEW mode) and `A7j Liveness Audit` (scoped reference in AUDIT mode). Inserted after [N+1]e / A7e, before [N+1]f / A7f.
- **A7 categories restructured:** "two categories" → "three categories." Internal correctness now splits into *static* (A7a–A7e, read code) and *live* (A7j, run code).
- **A7.0 scope map updated:** new A7j row; new precondition rule ("if no runnable target, surface 'Liveness unverifiable' as the finding rather than skipping silently").
- **A7i updated:** A7j 5xx / function-throws findings are explicitly tagged as always-critical (they represent code that does not run at all).
- **Compact reference (build-protocol-core.md) updated:** N+1 sequence now includes Liveness; A7 description includes the third category.

**Tool selection (decision rationale captured in D-003):**
- Knip (JS/TS dead exports + inventory) — incumbent; ts-prune is effectively dead
- Vulture + Ruff + deptry (Python) — same job split across three tools because the Python ecosystem split them
- Schemathesis (HTTP fuzz from OpenAPI) — uncontested in its niche
- Playwright (browser flows) — settled vs Cypress in 2025–26
- Vitest / pytest (function-level smoke harness)
- promptfoo (LLM/AI surface smoke)

All have JSON reporters, all CLI-callable by Claude Code without human in the loop.

**Bob's stance:** orchestrate, don't reinvent. A7j is glue + triage + reporting on top of mature OSS tools.

### Closed in v2.14

| # | Title | Notes |
|---|---|---|
| F25 | A7j Liveness Audit added | Resolves blind spot where AUDIT could not catch silently-broken runtime code |

### Deferred from v2.14

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F26 | A7j as per-phase Nb verification step (not just A7) | M | Higher-impact change — would catch dead functions the day they ship, not weeks later. Deferred to keep v2.14 surgical. | Next AUDIT pass on Bob, OR after first real user runs A7j and reports back |
| F27 | A7j auth-token bootstrap helper (script that generates `.env.test` token from project config) | L | Today users have to provide a test-user token manually. Tooling that auto-generates it would be useful but not blocking. | If multiple PR-back reports cite auth-token setup as friction |
| F28 | A7j writes findings into a structured `liveness-report.json` artifact | L | Currently the verdict table is markdown only. A machine-readable artifact would let downstream tools / CI consume A7j output. | When A7j is run more than ~3 times by external users |

### Informational

| # | Note |
|---|---|
| F29 | A7j is the first A7 audit that has a hard precondition (runnable target). Surfacing "Liveness unverifiable" as a *first-class finding* rather than skipping silently is deliberate — it makes the gap visible instead of papering over it, same pattern as A7g's stop condition for missing success metrics (v2.13 F17). |

---

## Audit pass — v2.13 (2026-05-20)

**Auditor:** Fresh Claude Opus session, no involvement in v2.10–v2.12 authoring.
**Scope:** Full A1–A7 (incl. A7f/g/h External Fit & Value audits).
**Total findings:** 24 — 16 Adopt, 5 Defer, 2 Reject, 1 informational.

### Closed in v2.13 (Adopts shipped)

| # | Title | Milestone |
|---|---|---|
| F1 | `update bob` symlink preflight | M2 |
| F2 | bob-init.sh git config preflight | M2 |
| F3 | README prerequisite section | M1 |
| F4 | Install one-liner idempotent | M1 |
| F5 | Supply-chain CI (shellcheck + smoke tests) | M5 |
| F6 | Branch protection (Option A) applied via Rulesets API: no force-push, no deletion on `main`; no update, no deletion on `v*` tags. Signed commits deferred (see checklist below). | M5 + post-ship |
| F7 | CTM template file | M4 |
| F8 | CTM H / H++ hardening column in template | M4 |
| F11 | AGENTS.md scaffold in bob-init | M4 |
| F15 | bob-stats.sh + multi-location PR-back + parallel channel | M6 |
| F16 | CLAUDE.md self-effectiveness rephrase | M3 |
| F17 | A7g stop condition as first-class finding | M3 |
| F18 | README Terminal/git/xcode preflight | M1 |
| F19 | Step 2 worked example extended to all 7 sections | M3 |
| F21 | Step [N+2]d Closing Checkpoint Summary template | M3 |
| F22 | This audit-log.md file | M7 |

### Deferred (revisit at next audit)

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F9 | README "eight separate audits before ship" implies all 8 always run; protocol actually defers most via A7.0 scope map | L | Cosmetic; no signal yet that this misleads real users | If a user reports confusion in a PR-back or issue |
| F10 | README "Fallback — no install" path doesn't set up symlink, doesn't enable `/bob`, doesn't enable `update bob` — silently degraded experience | L | Fallback is a v2.6 escape hatch; primary install path is the recommended one and the README correctly leads with it | If we ever see fallback-mode usage become common |
| F12 | Cursor / Codex / Copilot now have native plan modes that overlap Bob's plan-mode mandate at Step [N]a; positioning may need a rethink | L | Strategic, not tactical. Bob's depth (spec → behavior → arch → domain + audit modes) is the durable differentiation, not plan mode | When one of those tools ships an external-fit-style audit step |
| F20 | Streamlined startup proposes a complexity classification the user can't meaningfully push back on | L | Trade-off accepted: hiding the classification loses signal value, surfacing it creates a small friction the user can't act on | If users ever ask to change it |
| F24 | v2.12 SECURITY.md "user-side pinning" instructions buried in prose; cautious adopters unlikely to find them | L | Pinning is opt-in by design; making it more prominent risks signaling that the default install is unsafe (it isn't) | If a security incident makes pinning a higher-priority default |

### Informational

| # | Note |
|---|---|
| F14 | Verdicts from the v2.10 → v2.11 → v2.12 audit chain all held under re-inspection. Implementation bias did not produce bad Adopts; the failure mode of that chain was *what got missed*, not *what got shipped*. |

### F6 — branch & tag protection (status)

**Applied via Rulesets API (2026-05-20):**

- [x] **Ruleset `main-no-force-push-no-delete`** (id 16664976) — `non_fast_forward` + `deletion` rules on `refs/heads/main`. Bypass: never. Solo-dev direct-to-main commits still allowed; history cannot be rewritten or branch deleted.
- [x] **Ruleset `tag-v-no-update-no-delete`** (id 16664978) — `update` + `deletion` rules on `refs/tags/v*`. Released tags cannot be moved or removed.

**Deferred:**

- [ ] **Require status checks to pass before merging** — not applied. Solo-dev direct-to-main pattern means commits often need to land before CI catches an issue (Joe's CLAUDE.md: "Push is pre-authorized; changes can't be evaluated until live"). CI failures will still surface via the GitHub UI; chose ergonomics over strict gating.
- [ ] **Require pull request reviews** — skipped, incompatible with solo-dev direct-to-main pattern.
- [ ] **Require signed commits** — deferred. Needs Joe to set up GPG/SSH commit signing first; recommended but not zero-effort.

Document any future decision to skip or revisit any of these in `decision-log.md` so it doesn't get re-litigated next audit.

---

## How to use this log

- Every AUDIT pass appends a section at the top with: closed items, deferred items, informational notes, and any user-action checklist.
- Deferred items stay in the log until they're either closed in a release (move to the closed section of that release's entry) or formally Rejected (move to `decision-log.md`).
- Reference the audit-log from A7i prose so future audits actually find this file.
