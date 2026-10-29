# BUILD PROTOCOL — CORE REFERENCE

> Loaded into every session: modes, steps, gates, and a one-line index of the rules. The rules' full text is in `rules.md`; templates, appendices and architecture patterns are in `build-protocol.md` and `templates/`.

---

## MODES

**Streamlined startup (v2.9).** When the user invokes this protocol without specifying a mode, do all of this in ONE turn — never ask preliminary yes/no questions:

1. **Silently detect state.** Check whether `docs/build-manifest.md` exists (returning user vs first-time). Run `git status` if it's a git repo. Skim top-level files (package.json, framework configs, CLAUDE.md, recent commits) to infer what this project is. If `.bob/installed.json` exists and its `bob_commit` differs from Bob's current commit, or a Bob project has no such file, add one line to the narration block: *"Bob has improved since this project was set up — UPGRADE (D) shows what changed."* Don't run the upgrade check at startup.
2. **Tentatively classify complexity** (Light / Standard / Heavy) from those signals — propose, don't ask. State only the track + one-line reasoning. **Do NOT enumerate the "What Changes" column at startup** (skip Behavioral Core, skip Domain Specs, etc.) — those terms are jargon to a first-time user before mode selection. Surface each change later, only when it actually applies.
3. **Show ONE narration block** containing: what you observed about the project, the tentative complexity with one-line reasoning, and any housekeeping flags worth knowing before picking a mode (e.g., uncommitted work, missing manifest, conflicting docs).
4. **Present the menu and ask the single question: which mode?** Nothing else.

**Announce up front (NEW mode):** when NEW mode is selected, tell the user in one plain line that **there is a deliberate Pre-Build Review Gate (Step 6.5) before any code is written** — a machine audit of the whole plan plus a human review-and-tweak checkpoint — so they know a real stop-and-review is coming and won't feel rushed from spec into build (Rule 22).

**Defaults that are NEVER asked about:**
- **Narrator Mode is ON.** Don't announce it as a status line, don't ask to confirm. Just be in it. User can disable at any point with "terse mode."
- **Journey Map** (§11.4 of full protocol) is shown only AFTER mode selection — and only when the chosen mode is NEW for a first-time user. It's not a precondition for picking a mode.
- **First-time vs. returning detection** is silent (filesystem check), never a question.

Present this menu:

> | Mode | What it does | When to use | Roughly how long |
> |---|---|---|---|
> | **A) NEW** | Build a brand-new product from scratch. ~7 spec steps + build phases + hardening. | You're starting from zero or a fresh idea. | 4-12 sessions over 1-4 weeks |
> | **B) AUDIT** | Assess an existing, partially-built product. Maps what you have to the 5-document hierarchy, finds gaps, proposes a remediation plan. | You inherited code, or you've been building without a process and want to formalize. | 1-3 sessions |
> | **C) EVOLVE** | Add features or change an existing product. Classified Small / Medium / Large — bigger changes apply more of the build discipline. | You have a working product and want to extend it. | 1 session (Small) to 1+ week (Large) |
> | **D) UPGRADE** | Bring a project Bob set up earlier up to date with the current Bob — its hooks, reviewer, checks and templates. Shows each change and Bob's reason; applies only what you approve; leaves your deliberate differences alone. | Bob has improved since this project started, or `/bob` says the project is behind. | 5–15 minutes |
>
> **Which one? (A / B / C / D)** — say "I'm not sure" and I'll ask a few questions to figure out which mode fits.

## COMPLEXITY ASSESSMENT

Before starting, assess project complexity:

| Track | Criteria | What Changes |
|-------|----------|-------------|
| **Light** | 1-3 subsystems, no AI, no multi-user, single surface | Skip Behavioral Core, skip Domain Specs if <3 subsystems, simplified Phase Report ([A] sections only), adversarial reviews at hardening only |
| **Standard** | 3-8 subsystems, AI OR multi-user OR 3+ integrations | Full protocol (default) |
| **Heavy** | Complex AI + multi-user + 5+ integrations + compliance | Full protocol + mandatory deploy verification every phase + mandatory second-model review at spec and hardening gates |

**Mid-build reclassification:** If escalating to Heavy mid-build: (1) future phases follow Heavy requirements immediately, (2) run one-time catch-up audit on completed phases for the Standard→Heavy delta (deploy verification, second-model spec review), (3) log reclassification in Build Manifest. Do NOT re-run completed phases.

**Maturity Stage (v2.27 — a SECOND axis, orthogonal to the track).** The track above sizes *process rigor* to *complexity*. Independently classify **stakes/maturity**: `personal-tool · prosumer-beta · commercial-v1 · scale`. **The track sizes process; the stage sizes ambition** (Rule 16). Tag each capability with the **earliest stage that justifies it**; anything beyond the current stage is **reserved as a roadmap seam, not specified to depth now**. A v1 personal-tool spec that reads like a funded team's platform is the signal this axis was skipped — and that's the most expensive, most common over-build. Re-check the stage at each adversarial pass (ambition creeps upward turn over turn).

---

## DOCUMENT HIERARCHY

| # | Document | Answers | Required? |
|---|----------|---------|-----------|
| 1 | **Product Spec** | WHAT it does | Always |
| 2 | **Behavioral Core** | HOW it thinks | If AI makes decisions |
| 3 | **Architecture Contract** | HOW it's built | Always (code products) |
| 4 | **Domain Specs** | DETAILS per subsystem | If 3+ subsystems |
| 5 | **Build Manifest** | WHERE we are | Always |

**Priority when docs conflict:** Product Spec > Behavioral Core > Architecture Contract > Domain Specs > Build Manifest. Exception: if behavior is defined in both Product Spec and Behavioral Core, Behavioral Core wins.

---

## RULES FOR CLAUDE CODE

**The rules live in one file: `~/.claude/skills/bob/../rules.md` (D-028).** This index has one line per rule: its number (a permanent label), its own title, how it is enforced (tags defined at the top of `rules.md`), and the group of `rules.md` that holds its full text. **Read group 1 at the start of every session. At the start of each later stage, read that stage's group in full before working:** group 2 before NEW Steps 0–5.5 or an EVOLVE spec change · group 3 before Step 6.5 · group 4 at the start of every build phase · group 5 before reporting anything as done · group 6 before an audit or any lens run (including the 6.5a and phase-boundary panels) · group 7 when a problem recurs or the field reports one · group 8 before changing Bob. Rows 1–13 give the rule in short; rows 14–33 give its title only, which is not the rule.

| # | Rule | Enforced by | `rules.md` group |
|---|---|---|---|
| 1 | Follow steps in order. Do not skip, merge, or reorder. | `PROSE` | 1 |
| 2 | Stop at every human gate (`→ HG`). Wait for explicit approval. | `PROSE` | 1 |
| 3 | Track current step. Resume from Build Manifest. | `PROSE` | 1 |
| 4 | Reconciliation is non-optional after every build phase. | `PROSE` | 4 |
| 5 | Specs are living documents — update during build when reality diverges. | `PROSE` | 1 |
| 6 | **No silent refactoring.** List ALL changes. Explain WHY. Confirm no regression. | `PROSE` | 4 |
| 7 | **No behavior drift.** Do NOT change previously built behavior unless current phase REQUIRES it. | `PROSE` | 4 |
| 8 | **Scope lock.** Only build what's in the phase scope. Don't anticipate future phases. | `PROSE` | 4 |
| 9 | **Drift prevention.** All behavior must trace to a spec section. Can't cite it → don't build it. | `PROSE` | 4 |
| 10 | **Idempotency.** Every step safely re-runnable. Check before writing. Update instead of recreate. | `PROSE` | 4 |
| 11 | **Complexity rule.** Prefer simple, explicit code over clever abstractions. | `PROSE` | 4 |
| 12 | **Flag divergences immediately.** Don't silently pick one interpretation. | `PROSE` | 1 |
| 13 | **Two-correction rule.** Same issue corrected twice → recommend `/clear` and fresh session. | `PROSE` | 1 |
| 14 | Orchestrate, don't reinvent (v2.16). | `PROSE` | 2 |
| 15 | Preserve the edge — don't let guardrails neuter the capability (v2.26). | `PROSE` | 2 |
| 16 | Proportion rigor to stakes, not just process to complexity (v2.27). | `PROSE` | 2 |
| 17 | Executor self-interrupt — process hygiene (v2.27). | `PROSE` | 1 |
| 18 | Expand & sharpen the idea — don't just scope the ask (v2.27). | `PROSE` | 2 |
| 19 | AI-forward by default (v2.27). | `PROSE` | 2 |
| 20 | Push harder than the user — surface the unknown-unknowns (v2.27). | `PROSE` | 2 |
| 21 | Don't one-shot the foundations — iterate them WITH the human, and refuse to advance from mediocre (v2.27). | `PROSE` | 2 |
| 22 | Never cross from design into build without the Pre-Build Review Gate (v2.28). | `PROSE` | 3 |
| 23 | Living-doc coherence is a *triggered, mechanical* sweep — not a manual audit the human has to call (v2.29). | `SCRIPT` | 2 |
| 24 | The Build-Integrity Loop — milestone audits are push, not pull; the build never forgets an earlier step or decision (v2.30). | `PROSE` | 4 |
| 25 | Green ≠ Correct — the silent-failure forensics a data/analysis audit must actually perform (v2.31). | `PROSE` | 5 |
| 26 | Keep the machine hermetic & refactor by invariant — the ENGINEERING silent-failures (v2.33). | `PROSE` | 4 |
| 27 | Supervised Autonomy — collapse per-step gates to milestone gates on the BUILD phases only (v2.34). | `PROSE` | 4 |
| 28 | Structurally valid ≠ logically coherent — the SPEC-DOCUMENT silent-failures (v2.36). | `SCRIPT` | 2 |
| 29 | A check with no inputs is not a passing check — gate lenses by ARTEFACT STATE (v2.37). | `PROSE` | 6 |
| 30 | Done means fresh-eyes clean — a Tier-1 milestone is not complete until a context that did NOT build it has audited it and found zero MATERIAL findings (v2.39). | `PROSE` (clause d `SCRIPT`) | 5 |
| 31 | The intervention ladder — when a class RECURS, escalate a tier; never just re-state the rule (v2.40). | `PROSE` | 7 |
| 32 | Incident intake — Bob learns from the field, not only from itself (v2.40). | `SCRIPT` (in part) | 7 |
| 33 | Bob dogfoods Bob — an unenforced rule is a wish (v2.40). | `PROSE` (one clause `SCRIPT`) | 8 |

**Failure stop conditions (STOP immediately if):**
- Required behavior NOT in Behavioral Core (AI products)
- Required mechanics NOT in domain spec
- Two docs conflict
- Behavior is ambiguous (no clear rule)
- An assumption is needed to proceed
- A prior-phase dependency is missing or broken

*(The fuller list, with what to do when stopping, is in `rules.md` group 1.)*

**When compacting, always preserve:** current mode, current step, and any pending decisions.

---

## MODE: NEW — Step Sequence

0. **Intake** → 0a: Existing materials check → 0b: Material mapping → 0c: Accelerated start → `→ HG` *(skip if starting from scratch)*
0.5. **Project Profile (v2.4)** → 0.5a: Classify against Appendix K archetypes → 0.5b: Pull addendum → 0.5c: Tag in Build Manifest → `→ HG`
1. **Product Spec** → 1a-pre: Structured interview + Day-in-the-life (v2.5) → **1a-pre+: Divergent Ideation & Sharpening (v2.27)** — *expand the seed idea* into the adjacent capabilities/signals/value-props that 2–5–10× it, *steal from incumbents early*, *extract the moat/unique-IP*, *sharpen the core analytical capability*, force the *AI-forward* version, then *iterate to convergence* (Rules 18–20; the first draft is a starting point, not the spec) → 1a: Draft (incl. success metrics, activation, non-goals, data classification) → 1b: Coverage Scan (9-category taxonomy, Clear/Partial/Missing — v2.25) + capped resolution + Stress-test → 1c: Adversarial review → **1c-audit: Structure audit (v2.36, Rule 28 — `spec-audit.py`)** → 1d: Stability loop (v2.5) → `→ HG`
   - **v2.26 additions:** *1a-pre also* names the **load-bearing assumption** (the one unproven premise all value rests on — see Step 5 MVP-0) and runs a **Differentiation & Ambition sweep** (could it compound / self-improve over time? what *adjacent* categories/sources/entities is it missing? is its output *conditional* not universal? is the edge sharp AND preserved per Rule 15?). *1b adds* a conditional **Product-Reality coverage set** for any product with external/commercial intent (first-session/UX & "simple mode" · GTM buyer/wedge/pricing · legal/regulatory workstreams · data-acquisition reality & fallbacks · solo/team operate-&-maintain burden) — **plus, NON-conditional/default, the ops basics every live product needs: cost monitoring · silent-failure detection · observability & alerting** (these are first-class spec items, never late-audit finds). *1c may escalate* to an **Independent Audit Panel** for differentiated/ambitious products — *fresh-context, parallel* passes (not one self-review): **cross-project-learnings** (apply this builder's prior shipped products' scars to the new spec), **competitive practitioner scan** (live web — products + blogs/communities to steal from), **domain-method rigor** (the field-correct analytical method + anti-fooling-yourself discipline, at spec time not just post-build L32), and a **guardrail-neuter simulation** (run real high-value scenarios; does any rule suppress the edge? → Rule 15 / L35). The Independent Audit Panel is **auto-cast by archetype** (Step 0.5 / Appendix K) — each product type names its 3-5 expert seats with their anti-fooling discipline (e.g. a *quantitative/analytical* product → multiple-testing statistician [FDR / PBO / deflated-Sharpe / walk-forward] + point-in-time/temporal-correctness data architect + domain practitioner + adversarial red-teamer), so a non-engineer never has to guess which experts a domain demands.
   - **v2.27 additions:** *each capability is tagged with its **Maturity Stage*** (Rule 16 — defer beyond-stage capabilities to *reserved roadmap seams*, don't spec them to depth). A recurring **Spec Consolidation Pass (Step 1e)** — which **runs the Rule 28 structure audit (`~/.claude/skills/bob/../scripts/spec-audit.py`) first**, since consolidation is exactly when bucket overlap and rival inventories surface — fires on a **growth trigger** (spec ~doubled in sections, or every ~5th living-doc update): concept-dedup (Single-Source-of-Truth applied to the spec itself), contradiction scan, regenerate the one-page **capability map**, enforce **say-it-once** (define moat / validation-gate / etc. once, cross-reference elsewhere) — the spec-phase analog of code Reconcile, so a living spec self-heals instead of going append-only. And every adversarial pass forces a **Sophistication-vs-Progress** check (*"what did we ADD this pass; is each on the critical path to the load-bearing assumption; what did we REMOVE/simplify?"* — a build whose remove-count is always zero is unhealthy) + an **anchoring check** (*which scope came from the user's illustrative **examples** vs the actual job-to-be-done? examples seed, they don't mandate scope* — the inverse of Rule 15's open-vocabulary).
2. **Behavioral Core** (AI only) → 2a: Draft → 2b: Stress-test → 2c: Adversarial review → 2d: Eval harness → `→ HG` — use `templates/behavioral-core.md` and `templates/eval-set.md`. **(Rule 21 applies to BOTH Step 1 & 2: don't one-shot — frame these as the highest-leverage docs upfront, program human-in-the-loop expansion/creativity/react-to-options cycles, self-score honestly each pass ("~Nth-percentile; here's what would sharpen it"), and propose more sharpening rather than approval-to-continue.)**
3. **Architecture Contract** → 3a-pre: Reference Scan (v2.16 — scan 5-10 OSS repos, bias-toward-Reject, Adopts must name insertion point) → 3a: Draft (incl. threat model, observability plan, rollback posture, cost guardrail, a11y/i18n/compliance posture v2.4 — **+ v2.27: proactive modularity & layering**: for any data/analytical/platform product, design the *layers* up front (ingestion/aggregation → normalization → analytical engine(s) → surfaces) + pluggable adapters/registries + platform-vs-feature separation, so the architecture is modular by default and the non-engineer never has to know to ask) → 3b: Adversarial review → `→ HG`
4. **Domain Specs** → 4a-pre: Breadboarding sketch (v2.7) → 4a: Identify subsystems → 4b: Write + machine-readable `contracts/` + cross-reference → 4c: Adversarial review → `→ HG`
5. **Build Manifest** → 5a: Define phases (incl. rollback plan per phase) + capability matrix → 5b: Initialize manifest (auto-advance v2.5) → `→ HG` *(at 5a only)*
   - **v2.26 — Prove the premise before the cathedral:** **Phase 0 = the Riskiest-Assumption Test / MVP-0** — the cheapest experiment that proves (or kills) the *load-bearing assumption* from Step 1, sequenced **FIRST**. Define a true **MVP-0** (~10% of surface that proves the premise end-to-end) and an explicit **kill-criterion** (what result pauses the full build). A spec that has grown ambitious must still ship its riskiest, smallest, premise-proving slice before anything else. Prevents building a beautiful cathedral on an unproven foundation.
5.5. **Design Gallery & Lock (v2.38 — any product with a user-facing surface; skip for pure APIs/CLIs).** Run the **`design-gallery` skill** (`skills/design-gallery/`): explore the look-and-feel as a rated gallery of mockups on REAL product content (HTML lane for product UI/dashboards where exactness must survive the transfer to code; the `design-mockups` image lane for art direction/heroes/brand; the SVG board for logos) → converge through feedback-by-number rounds + a live parameter playground → write **`LOCKED-DESIGN.md`** (exact values only, opening with the mock-is-canonical banner) → `→ HG` (the user picks the direction and the lock; Bob never locks a design alone). The lock artifacts join the doc set 6.5a audits, and **every visual build phase after the lock follows the skill's `fidelity-protocol.md`** — mock file first (never prose), mock content ≠ chrome, component consumption counted, adversarial value+screenshot diff to finish, CI token gate. *(Origin: a data product build — a locked design was twice re-created from prose at ~70% fidelity because a summary stood in for the mock file at hand-offs; this step makes the exact transfer mechanical.)*
6. **Project Setup** → 6a: AGENTS.md (CLAUDE.md = `@AGENTS.md`, D-025) → 6b: Hooks (DEFAULT ON — opt out explicitly) → 6c: Repo init (auto-advance v2.5) → `→ HG` *(at 6a/6b only)*
6.5. **🛑 PRE-BUILD REVIEW GATE (v2.28 — MANDATORY, the single most important gate; NEVER skip — Rule 22).** The transition from *design* (all spec docs) to *build* (first line of product code) is the highest-stakes, least-reversible boundary in the whole protocol — yet it's the one most easily skated past when the pace picks up. **Stop here, deliberately, every time.** Two parts, in order:
   - **6.5a — Machine audit (fresh-context, multi-lens).** Run an independent audit panel over the COMPLETE document set + plan *before* any code — do NOT wait for the post-build hardening audits (those are too late to catch a bad foundation). Minimum lenses, cast by archetype (Appendix K) but always including: **(1) internal consistency & drift** — run both checkers first: `scripts/coherence-check.sh <docs-dir>` (drift ACROSS the doc set, Rule 23) and the Rule 28 structure audit `~/.claude/skills/bob/../scripts/spec-audit.py` (incoherence WITHIN each doc) — (names/IDs/versions/dropped-concepts/contradictions across all docs — the consumer-app drift regression class), **(2) foundation-first sequencing** (is the build order laying a clean foundation, or rushing to a visible surface / MVP-for-its-own-sake?), **(3) completeness/table-stakes-in-the-plan** (auth/billing/security/privacy/ops present in the plan even if built later), **(4) data-quality/integrity** (for any data product: is ingest/processing pressure-tested + self-checking, not assumed-correct?), **(5) domain-expert POV** (the archetype's expert seats), and **(6) AI-nativity** (L36) if AI-forward. **Plus two FIXED reviewers every time, alongside — never replacing — the six (D-016):** `audit-lenses/prebuild-reviewers/design-critic.md` and `audit-lenses/prebuild-reviewers/implementation-readiness.md` (zero design decisions left to the builder, checked at full detail for the **next phase only** — a roadmap is not a task list). All reviewers are fresh subagents, read-only (Read/Grep/Glob), `model: inherit`, `omitClaudeMd: true`. Aggregate → a written findings doc + a triaged fix list; the author sorts each finding fix / contest / escalate / decline per `_aggregation.md` § "Sorting reviewer findings" before the human sees it. Apply the clear-win fixes; surface the judgment-calls (escalations first).
   - **6.5b — Human recap & sign-off (`→ HG`, HARD).** Bob presents a **plain-language recap for the non-engineer**: what the product *is*, what will be built and in what order (the phase plan), the key decisions made (and any reversed), the open decisions needing the user, and the machine-audit's top findings + what was changed. Then Bob explicitly invites: *"This is your review-and-tweak gate before we write code — anything to change, cut, add, or resequence?"* **Do NOT proceed to Step 7 until the user has actively reviewed and approved.** Approval must be affirmative, not assumed from silence or from a generic "continue."
7+. **Build Phases** → For each phase: [N]a: Build → [N]b: Verify (use `templates/phase-report.md` — incl. AI eval results + cost guardrail) → [N]c: Reconcile → `→ HG`
N+1. **Hardening** → Security → Adversarial/Abuse → Integration Seam → Data Integrity → Spec-Code → **Liveness (v2.14)** → Fix *(fresh session per audit)*
N+2. **Learning Extraction** → Process review → Update artifacts

**Each build phase follows:** Context Load → Gap Check → Plan (in Claude Code plan mode for M/L — v2.7) → `→ HG` → Test-first integration test (v2.7) → Implement → Verify → Reconcile (regenerate repo-map — v2.7) → `→ HG`

---

## MODE: AUDIT — Step Sequence

A1: Inventory → A2: Map to hierarchy → A3: Code-spec consistency → A4: Risk assessment → A5: Remediation plan → A6: Execute remediation → A7: Hardening audits (scoped) → A8: Re-entry

**A7: Multi-Lens Audit (v2.17; current list and count in `audit-lenses/README.md`)** — Always runs after remediation. v2.17 replaced the prior single A7a–A7j audit phase with a multi-lens library at `audit-lenses/`; it is now a **multi-lens library**, organized into 8 bands (lens IDs are append-only, so newer lenses sit in earlier bands — group by band, not ID arithmetic):

| Band | Lenses | Question |
|---|---|---|
| 1. Engineering Foundation | L01–L06, **L31**, **L37** | Code work, match spec, security / privacy / supply-chain? (L01 includes prior A7a-A7j Hygiene + Liveness — Knip / Schemathesis / Playwright / Vitest / promptfoo) **L31 (v2.21):** trace one input/field end-to-end — stored / deduped / propagated to every consumer / terminal states resolved? **L37 (v2.32):** the STANDING, generative data-fidelity crawler — perpetually rotates the whole SOURCE→…→SERVE chain, tests falsifiable hypotheses vs INDEPENDENT oracles, and emits a new reactive invariant per confirmed defect (the perpetual complement to L31's one-shot trace). |
| 2. User Experience | L07–L10 | Can users navigate, trust, delight, recover? |
| 3. AI Behavior | L11–L14, **L32**, **L36** | AI accurate, right-sized, safe, efficient? **L32 (v2.21):** is the analytical *method* sound (right inputs, defensible weights, valid assumptions) — AI **and** deterministic logic? **L36 (v2.27):** is the product **AI-first / AI-native** — using modern LLM / agentic / RAG / structured-generation / eval-driven / self-improving capabilities + infra — or a spec a great *pre-LLM* PM would have written? Pushes the AI-forward version (Rule 19). |
| 4. Performance Economics | L15–L16 | Cost / speed / effectiveness drivers — incl. *invest-more* opportunities |
| 5. Reach & Distribution | L17–L20, **L34** | Mobile, i18n, accessibility, social shareability. **L34 (v2.22):** SEO / AEO / GEO — will search, answer, and generative engines find/rank/extract/cite the site? 4-tier funnel, evidence-ranked from the Princeton GEO paper. |
| 6. Operational | L21–L23 | Observability, vendor risk, onboardability |
| 7. Strategic & Market | L24–L28, **L33**, **L35** | Competitive, pricing, marketing copy, personas, wedge sharpness (L28 vetoes UX findings that are intentional wedge). **L33 (v2.21):** does *generated in-product output* match the audience register/jargon + house structure? (actionable content, not strategic-veto) **L35 (v2.26):** does the product's own *guardrails / rigor / examples* neuter its differentiating *capability*? The functional complement to L28's strategic anti-convergence — keep constraints at the communication layer, vocabularies open, notability un-suppressed, usefulness felt (Rule 15). |
| 8. Growth & Adoption | L29–L30 | Activation, retention loops |

**A7 sub-steps:**

- **A7.0 — Entry.** Bob reads `audit-artifacts/audit-history.json` and proposes a Curated panel (6–10 lenses) based on project profile per `audit-lenses/_selection-rubric.md`. Offers four options: Same / Complementary Curated / **Full Enchilada (every lens)** / Custom. User confirms at `→ HG`.
- **A7.1 — Sequential lens execution.** Each lens in a **fresh Claude Code session** (writer/reviewer pattern). Lens reads prior reports in `audit-artifacts/` to convert ~15% intentional overlap into confirmation, not noise. Each lens writes markdown + JSON sidecar, and its last step appends a `retro_fragment` to the sidecar (`audit-lenses/_lens-retro.md` Tier 1). The lens files' own output sections don't repeat this, so start every lens with the entry prompt in `build-protocol.md` §A7.1, which asks for it.
- **A7.2 — Aggregation.** Per `audit-lenses/_aggregation.md`: dedup, honor L28 wedge vetoes, rank by severity × frequency × user-impact, produce `audit-artifacts/audit-summary-{date}.md`.
- **A7.3 — Fix & Defer.** Replaces prior A7i. Fix Criticals, triage Majors at `→ HG`, register Defers in `audit-log.md` with revisit triggers, log Rejects in `decision-log.md`. L01 Liveness 5xx / function-throws findings remain *always Critical*. PR-back prompt (v2.13) offered.
- **A7.4 — Lens Retro (v2.18, auto-emit; two-tier capture v2.18.1).** Bob automatically writes `audit-artifacts/audit-retro-{date}.{md,json}` — a critique of the *lenses as instruments* (signal verdict per lens, coverage gap no lens caught, ranked change-requests for Bob), distinct from the findings. **Captured in two tiers so fresh-session/compaction context loss can't degrade it:** each lens writes its `retro_fragment` live to its JSON sidecar (Tier 1); A7.4 reads those fragments off disk and adds cross-lens synthesis (Tier 2) — it never reconstructs from memory. Feeds the Lens Retro Ritual (`audit-lenses/_lens-retro.md`): `scripts/lens-retro.sh` aggregates retros from `lens-retros/`; once ≥3 accumulate, a human-gated proposal edits specific lenses. **Bob never auto-edits its own lenses** (D-005). Before saving the retro, run `bash ~/.claude/skills/bob/../scripts/lens-retro.sh --check <retro.json>` — a retro in another shape is not tallied (2026-10-28: two of three real retros had invented their own fields). No `→ HG`.

**Selection rubric (panel examples):**
- *Pre-launch consumer (consumer-app profile):* L01, L02, L03, L04, L05, L07, L08, L10, L13 (9)
- *Methodology product (Bob itself):* L01, L02, L03, L23, L24, L28 (6)
- *Pre-fundraise scrub:* L01-L05, L15, L16, L22, L24, L25, L28, L29 (12)
- *Pre-public-launch:* L01-L10, L17, L19, L20, L25, L29 (14)
- *Quarterly drift check:* L01, L04, L11, L15, L21, L24 (6)
- *Post-incident:* L01, L04, L10, L21, L22 (5)
- *Full Enchilada:* every lens (1–3 hours over multiple sessions)
- *SEO / AI-visibility scrub:* L34, L26, L20, L17, L24 (5) — or L34 alone for a fast single-lens check

A7 can be re-invoked anytime; standard cadence = a Curated panel after each major phase + a Full Enchilada before launch. **As of v2.30 (Rule 24) this cadence is ENFORCED, not advisory** — the Curated panel + the Anti-Forgetting Gate auto-fire at each phase boundary and gate-block advancement (tracked in `audit-ledger.json`); the human no longer has to remember to call them.

**A8: Re-entry** — After remediation + scoped hardening, Claude presents next-step options based on Build Manifest state: resume building unbuilt capabilities (→ NEW mode Step 7, with inherited hardening obligations attached to each phase), switch to EVOLVE for new features (including external-fit candidates from A7f/g/h), or re-invoke A7 mid-build to re-scope.

---

## MODE: EVOLVE — Step Sequence

E1: Classify (Small/Medium/Large) → E2: Spec check → E3-pre: Scoped Reference Scan (v2.16 — Large always; Medium if new subsystem/integration/pattern; skip Small) → E3: Plan (Medium+ in plan mode with hard gate before E4; Medium+ writes to `evolutions/{NNN-short-name}/`) → E4: Execute → E5: Reconcile (Medium+) → E6: Impact audit (Large only)

**Multiple concurrent changes:** If 3+ changes requested: independent → run sequentially (E1-E5 each); interdependent → batch into one evolution (classify batch one tier up). If batch is Large + touches 5+ subsystems → treat as mini build with phases, not an evolution.

**Evolution hardening threshold:** Trigger targeted hardening (Security + Integration Seam + Spec-Code scoped to changed areas) when: 5th Medium+ evolution since last hardening, any evolution touching 3+ subsystems, any Behavioral Core modification, or 6 months since last hardening. Claude tracks count in Build Manifest and proactively warns at evolution 4 of 5.

## MODE: UPGRADE — Step Sequence (D-019)

Brings a project Bob set up earlier up to date with the current Bob. Run from the **project** folder. The script only reads until the user approves; it never touches a file outside the set Bob installs (hooks, their `.claude/settings.json` entries, the reviewer, the daily dropped-work check, the lists Bob creates once, the Bob pointer in CLAUDE.md) plus its own `.bob/` folder.

U1: **Report** — `node "$(realpath ~/.claude/skills/bob/..)/scripts/bob-upgrade.mjs"` (changes nothing). Retell it in plain English: for each item, what it does for the user, **why Bob changed it** (the D-number and one line from `decision-log.md`), and what applying it would change. Groups: Bob has a newer version · missing (new in Bob) · **the project has its own version** (a same-job tool of its own, found by name in its hook settings or script folders — left alone; list it in `.bob/differences.md` if deliberate, D-020) · **waiting for your test command** (the green gate is never switched on while its test command is Bob's placeholder, D-020) · **damaged** (a required-checks list the merge guard can't read — offered as a named reset, D-020) · changed here on purpose (`.bob/differences.md` — left alone) · changed here, reason not written down. → U2: **Decide** `→ HG` — all safe updates, some, or none; for every "changed here, reason not written down": keep it (add one line with the reason to `.bob/differences.md`) or take Bob's. → U3: **Apply** — `--apply all` or `--apply <item>,<item>`. Every replaced file is copied to `.bob/backups/<date>/` first. A hook that can stop work arrives **warn-only** (it says what it would have blocked and blocks nothing); the merge guard has no warn-only mode (D-018) and starts in its "no CI yet" stage instead. Commit the result like any change. → U4: **Switch on** — after the user has seen the warn-only hooks behave, `--enforce <item>`. The commit-time document check (`commit-sweep`) stays warn-only in an existing project until its documents pass, then `--apply commit-sweep` makes it block. → U5: **Backwash** — ask "does this project do something better than Bob?" for each line in `.bob/differences.md` and anything else the project invented. If yes: write it in general terms (no project names, numbers or internals — Bob is public), add a decision-log entry in Bob, change Bob, then run UPGRADE here again and delete the line from `.bob/differences.md`.

**Install record.** `bob-init` writes `.bob/installed.json` (what Bob installed, from which Bob commit) and an empty `.bob/differences.md`. A project with no record still works: each file is compared with Bob's current version and every past version in Bob's history. Bob's current version of each piece is whatever `bob-init` writes today — the upgrade script runs it in a throw-away folder, so `bob-init` stays the one source.

---

## WHERE RULES LIVE (three layers — D-019)

A person working with Bob usually has rules in three places. **Write each rule once, in the lowest layer that covers every case it applies to, and point to it from everywhere else — never copy it.**

1. **Your own global instructions** (for Claude Code, `~/.claude/CLAUDE.md` plus any hooks): rules for **any** task — how you like to be spoken to, what "done" means, safety rails. A rule that also governs research, data analysis or writing stays here even when Bob has a build version of it.
2. **Bob** — the one current method for **building software**: the steps, gates, reviewers, templates, hooks and checks. Projects point to Bob; they don't copy it. Bob is self-contained: it never relies on rules that only exist in someone's private global file.
3. **The project** (its `CLAUDE.md` / `AGENTS.md`) — only facts about this project, plus its **deliberate differences from Bob**, each listed with its reason in `.bob/differences.md`.

**The loop.** When a project finds a better way, generalize it into Bob (the backwash — UPGRADE step U5). When Bob improves, `/bob UPGRADE` brings each project up to date. A copied rule drifts; a pointer can't.

---

## PHASE GATE (required before every phase transition)

1. **Build check:** Compiles, types check. Machine-readable `contracts/` validate.
2. **Test check:** Unit tests pass. Integration tests pass (hot path exercised). Deployment tests if external integrations.
3. **Liveness check on phase deltas (v2.15):** Every new/modified route, exported function, job, and AI call site introduced this phase is smoked end-to-end (Knip + curl/fetch + Vitest + promptfoo, scoped to deltas). Any reachable surface that 5xx's or throws on first call = stop condition. Skipped only if no runnable target OR phase touched no callable surface (logged either way).
4. **Hot path check:** Project-wide hot paths pass. Failure = stop condition.
5. **AI eval check (v2.2):** If phase touched AI behavior, re-run `evals/behavioral-core.yaml`. Pass-rate drop vs prior phase = stop condition.
6. **Cost guardrail check (v2.2):** If cost budget defined in Architecture Contract, measure actual cost. Exceeding budget = stop condition.
7. **Regression check:** All prior-phase flows still work.
8. **Global invariants:** All pass.
9. **Spec consistency:** No drift detected.
10. **Fresh-eyes clean on Tier-1 deliverables (v2.39, Rule 30):** For any phase whose output is Tier 1 (numbers/data someone acts on), a fresh-context auditor that did NOT build it has run and reports **zero Material findings**; the result is logged in `docs/audit-ledger.json` (Rule 30(d) fields; `audit-ledger-check.mjs` passes). A zero-finding audit was re-run once from a different angle; any content edited after the audit voided it (Rule 30(f)). Unrun, or Material findings open = stop condition. Tier 2/3 phases record their tier and skip.
11. **Failing-test receipt per fix item (2026-10, D-016 — `SCRIPT`):** every fix/bug item in the phase **names the test command that proves it** — an item with no test command cannot pass this gate (a note alone is not proof). A session **different from the builder's** runs `node scripts/prove-test-fails.mjs --commit <sha> --test "<cmd>" --fix <file>:<from>-<to>` and pastes the receipt into the phase report. The script works in a scratch copy at that exact commit: removes the fix lines → the test must FAIL; restores them → it must PASS. A test that stays green with the fix removed does not test the fix. Code-free phases record "no fix items" and skip.
12. **Done-criteria unchanged since the phase began (2026-10, D-016 — `SCRIPT`):** `node scripts/check-bar.mjs <phase-report.md>` passes — the fingerprint recorded at phase start still matches the done-criteria, or every change carries a dated "bar changed because…" line. Moving the finish line mid-phase without saying why = stop condition.

---

## ENGINEERING PRINCIPLES (D-019)

Bob's own named principles. Lenses and rules cite them by these numbers, so the numbers are stable.

1. **Single source of truth.** One definition per concept — code, config, numbers, documents. Check before adding; a second copy is a future disagreement. The cure for a duplicate is deleting it (Rule 31 tier 4); Rule 28 covers duplication inside documents.
2. **Trace end to end.** Before fixing, follow the data from input to output and find where expected ≠ actual. Don't patch the symptom. (Debugging Protocol step 2; L31 turns it into an audit.)
3. **Class-level fixes.** A bug in one place → grep the pattern and fix every instance; the grep is the list, not the incident's trace (Verification Additions; Rule 31).
4. **Verify every change.** Never commit broken code: type-check + build on every turn, and "don't stop until green" (Step 6b hooks; Rule 27).
5. **Changed function inputs → update every caller in the same change.** List callers before coding, update each in the same commit, check every screen that shows a changed output (Rule 26).
6. **Translate, don't paraphrase.** Turning a design into code means copying the design file's exact values, never a written description of it (Step 5.5; `skills/design-gallery/templates/fidelity-protocol.md`).
7. **Green ≠ Correct.** Passing checks prove known problems are absent, not that the result is right. Run the correctness forensics yourself, before anyone asks (Rule 25 for data, Rule 26 for engineering, Rule 28 for documents; L31, L32, L37).
8. **Reproduce before you fix; refactors keep behavior, not just names.** (a) The obvious cause is often a red herring — reproduce first and check what the last good run used (Debugging Protocol step 1). (b) A refactor must keep the runnable entry point, not just the importable names (Rule 26).
9. **A "the tool can't do that" note expires; a "we chose not to" note doesn't.** When parking work, say which kind it is. A priority call needs no version. A claim about what a library or service can't do must name the version it was checked against, and is void on the next upgrade. "Revisit if it matters" with no trigger is a permanent close in disguise — give it a trigger. When you find a note that is wrong and load-bearing, correct it in the same change that proved it wrong.

---

## VERIFICATION ADDITIONS (v2.0+)

**Class-level pattern scan:** When any bug is found, grep entire codebase for same pattern. Fix ALL instances before proceeding.

**Deploy & verify:** Mandatory if phase touches external integrations, webhooks, auth, or deployment config. Deploy to staging, test real requests. Verify the phase's rollback plan actually works.

**Hot path testing:** 1-3 project-wide critical paths defined in Build Manifest, tested at EVERY phase gate.

**AI eval re-run (v2.2):** If phase touched AI behavior (prompts, decision logic, routing, summarization, tone), re-run `evals/behavioral-core.yaml`. A drop in pass-rate vs prior phase is a stop condition.

**Cost guardrail check (v2.2):** If Architecture Contract defines a per-request cost budget, measure actual cost during phase verification. Exceeding the budget is a stop condition.

**Deviation tracking:** Count spec deviations per phase. If not declining over 3 phases → process review.

---

## DEBUGGING PROTOCOL

1. Reproduce (check what the last good run used before blaming a recent change — Principle 8a) → 2. Isolate subsystem (trace end to end — Principle 2) → 3. Check spec coverage → 4. Fix → 5. Class-level scan → 5b. Read two neighbouring code paths (callers + code on the same data) for collateral damage → 6. Add regression test → 7. Update spec if gap found

Three strikes: same fix fails 3x → STOP. Change approach entirely.

---

## MINIMUM VIABLE PROCESS

| Tier 1 — Never Skip | Tier 2 — Skip With Caution | Tier 3 — Skip First |
|---------------------|---------------------------|-------------------|
| Reconciliation, Regression check, Scope lock, Class-level scan, Hot path test, AI eval re-run (AI products), Contract validation (code products) | Cross-cutting scan, Global invariants, Full Phase Report, Propagation, Cost guardrail | Adversarial reviews (spec phase, incl. 4c), Experience test, Second-model review |

If Tier 2-3 skipped during build → MUST run at hardening.

---

## SESSION BUDGET HEURISTICS

- **Spec steps (0-5):** 1-2 sessions (Light), 2-4 (Standard), 4-6 (Heavy). One spec step per session usually fits.
- **S-complexity phases:** ~1 session (build + verify + reconcile)
- **M-complexity phases:** 1-2 sessions. Fresh session if verify reveals significant issues.
- **L-complexity phases:** 2-3 sessions. Consider splitting: build in session 1, verify + reconcile in session 2.
- **Hardening audits:** 1 fresh session per audit (a/b/c/d/e). MUST be fresh sessions (writer/reviewer pattern).
- **If a phase takes 3+ sessions:** it's likely too large — split it in the Build Manifest.

---

## SESSION START PROTOCOL

1. Read CLAUDE.md silently.
2. Check `docs/build-manifest.md`:
   - **NO → first-time user / fresh project.** Follow the Streamlined Startup in the MODES section above (silent detection → one narration block → single mode question). Show the Journey Map only AFTER NEW mode is selected.
   - **YES → returning user.** Read it, identify current phase and status. Read relevant project memory. State a Pulse Report: "We're at Step [X]. Last session completed [Y]. Next up is [Z]. Progress: [bar]." Narrator Mode is silently ON — do not announce it.
3. If resuming a build phase: re-read the relevant domain spec.
4. If you keep handoff notes across sessions/machines (e.g., a synced folder pattern), check for one and surface any open questions first.

---

## TEMPLATES & REFERENCES

- **Narration Protocol (v2.3 + v2.5):** §11 in full protocol — Preamble Template, Checkpoint Summary (incl. "💎 Why this matters"), Journey Map, 10 narration rules. **§11.7 Quality Bar Templates** define what "done" looks like per artifact with strong/weak examples. **§11.8** mandates value narration. **§11.9 Confusion-Catch Phrases** lists specific signals + response template. Narrator Mode ON by default for NEW mode.
- **Glossary (v2.3):** Appendix J in full protocol — plain-English definitions for all jargon.
- **Project Profiles (v2.4):** Appendix K in full protocol — archetype lookup (K1-K15) for tailoring the protocol to your product type. Pulled in by Step 0.5.
- **Architecture Patterns (v2.4 additions):** G11 RAG Pipeline · G12 Agent / Tool-Use Loop · G13 Background Job Architecture · G14 Mobile App · G15 Browser Extension · G16 Real-time / Collaborative · G17 Voice / Audio Pipeline · G18 Marketplace.
- **Integration Playbooks (v2.7):** Appendix L — 11 service-specific playbooks (Stripe, Supabase Auth, Resend, Twilio, Anthropic SDK, OpenAI, pgvector, Inngest, Sentry, PostHog, Vercel AI Gateway). Reference at Step 3a (tool choice) and at the Build Phase that wires the integration in.
- **Skill Leverage Map (v2.7):** §10.5 — when to invoke which Claude Code skill (vercel:*, claude-api, security-review). Bob owns methodology; skills own current tactical detail.
- **Scaffold script (v2.7):** `scripts/bob-init.sh <project-name>` — invoked at Step 6c. Generates folder structure, project CLAUDE.md (with Bob reference), .claude/settings.json with default hooks, .gitignore, .env.example, and runs git init.
- **Repo map (v2.7):** `scripts/repo-map.sh` — regenerated at every Reconcile step. Compressed view of repo Claude reads at session start.
- Phase Report template: `templates/phase-report.md`
- Behavioral Core template: `templates/behavioral-core.md`
- AI Eval Set template: `templates/eval-set.md` (used in Step 2d and at AI phase gates)
- Capability Traceability Matrix template: `templates/capability-traceability-matrix.md` (used in Step 5a-ii and at every Reconcile / A7i)
- Decision Log entry: `templates/decision-log-entry.md`
- Cowork Session: `templates/cowork-session.md`
- **Scheduled / unattended work (D-015, D-017):** `templates/scheduled-work-protocol.md` — **load it whenever the product has anything that runs on a schedule or without a human watching** (cron, nightly pipelines, background jobs, L37). Ships with `templates/run-claim.mjs` (copy into the project; makes a double, crashed or simultaneous run harmless — `node run-claim.mjs --selftest`).
- **Audit coverage record checker (D-017):** `scripts/coverage-check.py` — run on every lens's coverage record before the report is written (`audit-lenses/_evidence-accounting.md` §1).
- **Guard hooks (D-017):** `scripts/hooks/block-no-verify.js` + `scripts/hooks/config-protection.js` (from ECC, MIT) — `bob-init` copies them into `.claude/hooks/` as PreToolUse hooks (Step 6b items 4–5).
- **Merge guard (D-018):** `scripts/hooks/merge-guard.mjs` + `templates/required-checks.json` — `bob-init` copies it into `.claude/hooks/` and writes `.claude/required-checks.json` (Step 6b item 6). Refuses a merge with a red required check and a direct push to main; empty list = "no CI yet" stage. Tests: `node --test scripts/hooks/merge-guard.test.mjs`.
- **Root-file pointer + status-date check (D-018):** `scripts/doc-pointers-check.mjs` — run by `coherence-check.sh` class [8] (Rule 23(c)).
- **Audit ledger (D-018):** `templates/audit-ledger.json` (bob-init → `docs/audit-ledger.json`) + `scripts/audit-ledger-check.mjs [--streaks]` (Rule 30(d)).
- **Daily dropped-work check (D-018):** `templates/loop-check.mjs` + `templates/loop-check.yml` (bob-init → `scripts/` + `.github/workflows/`) — stale PRs without a dated hold, open loops with no owner/due date/proof, an intake list over its cap, a scheduled job failing twice or silent, a missing heartbeat.
- **Parallel sessions (D-018):** `templates/open-loops.md` — the one open-items list with one coordinator; rules in `build-protocol.md` §"Parallel sessions".
- **UPGRADE (D-019):** `scripts/bob-upgrade.mjs` (run from the project folder; report by default, `--apply`, `--interactive`, `--enforce`) + `scripts/hooks/warn-only.mjs` (runs a hook warn-only) + `templates/bob-differences.md` (bob-init → `.bob/differences.md`). `bob-init` records what it installed in `.bob/installed.json`. Steps: §"MODE: UPGRADE". The commit-time document check is `scripts/commit-sweep.sh` (D-020: one script for every hook that runs it; in blocking mode it judges the staged files).
- Architecture Patterns: Appendix G in full protocol
- Anti-patterns: Appendix A in full protocol
- Global Invariants guide: Appendix E in full protocol

---

*Core Reference for Build Protocol v2.46 — 2026-10-29 (v2.40 2026-09-18; D-016…D-021 additions 2026-10-27, D-022…D-026 2026-10-28, D-027…D-029 2026-10-29; see `decision-log.md`)*

*Release notes for every version: `CHANGELOG.md` (the one changelog, D-027).*
