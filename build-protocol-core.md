# BUILD PROTOCOL — CORE REFERENCE

> Compact reference for session context. For full templates, appendices, and architecture patterns, read `build-protocol.md`.

---

## MODES

**Streamlined startup (v2.9).** When the user invokes this protocol without specifying a mode, do all of this in ONE turn — never ask preliminary yes/no questions:

1. **Silently detect state.** Check whether `docs/build-manifest.md` exists (returning user vs first-time). Run `git status` if it's a git repo. Skim top-level files (package.json, framework configs, CLAUDE.md, recent commits) to infer what this project is.
2. **Tentatively classify complexity** (Light / Standard / Heavy) from those signals — propose, don't ask. State only the track + one-line reasoning. **Do NOT enumerate the "What Changes" column at startup** (skip Behavioral Core, skip Domain Specs, etc.) — those terms are jargon to a first-time user before mode selection. Surface each change later, only when it actually applies.
3. **Show ONE narration block** containing: what you observed about the project, the tentative complexity with one-line reasoning, and any housekeeping flags worth knowing before picking a mode (e.g., uncommitted work, missing manifest, conflicting docs).
4. **Present the menu and ask the single question: which mode?** Nothing else.

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
>
> **Which one? (A / B / C)** — say "I'm not sure" and I'll ask a few questions to figure out which mode fits.

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

**Execution:**
1. Follow steps in order. Do not skip, merge, or reorder.
2. Stop at every human gate (`→ HG`). Wait for explicit approval.
3. Track current step. Resume from Build Manifest.
4. Reconciliation is non-optional after every build phase.
5. Specs are living documents — update during build when reality diverges.

**Behavioral guardrails:**
6. **No silent refactoring.** List ALL changes. Explain WHY. Confirm no regression.
7. **No behavior drift.** Do NOT change previously built behavior unless current phase REQUIRES it.
8. **Scope lock.** Only build what's in the phase scope. Don't anticipate future phases.
9. **Drift prevention.** All behavior must trace to a spec section. Can't cite it → don't build it.
10. **Idempotency.** Every step safely re-runnable. Check before writing. Update instead of recreate.
11. **Complexity rule.** Prefer simple, explicit code over clever abstractions.
12. **Flag divergences immediately.** Don't silently pick one interpretation.
13. **Two-correction rule.** Same issue corrected twice → recommend `/clear` and fresh session.
14. **Orchestrate, don't reinvent (v2.16).** Before building custom anything, check whether the field has converged on an incumbent OSS tool worth orchestrating instead. Every tool decision in `tool-decisions.md` includes an explicit "Considered orchestrating: [tool]; chose [orchestrate/build] because [reason]" line. See full protocol §3 for the rule.
15. **Preserve the edge — don't let guardrails neuter the capability (v2.26).** A product's own rigor, safety/compliance caution, and example-lists can silently suppress its *differentiating capability*. Four facets, all load-bearing: **(a)** keep constraints at the **communication / legal / safety layer, not the analysis / capability layer** (the engine pursues its goal to the hilt; only *how results are phrased and to whom* is constrained); **(b)** keep content vocabularies **open** — enumerated examples are seeds, not closed enums (governance lists stay binding); **(c)** don't let validation rigor bury genuine **novelty / rarity / notability** — separate "is it notable?" (often computable at n=1) from "is it validated?" (needs the cohort); **(d)** optimize for **usefulness-as-felt**, not just correctness (rigor that produces honest-but-useless output fails the user). Audit with **L35**. *(Origin: the InsiderIntent build — the single most-recurring correction, surfaced ~5×.)*
16. **Proportion rigor to stakes, not just process to complexity (v2.27).** The Light/Standard/Heavy track scales *process* to *product complexity*; it does NOT scale *ambition* to *stakes/maturity*. Add a **Maturity Stage** axis (see Complexity Assessment): `personal-tool · prosumer-beta · commercial-v1 · scale`. Tag every capability with the **earliest maturity stage that justifies it**; anything beyond the current stage is **reserved as a roadmap seam, not specified to depth now** ("reserve the seam, don't build it"). A personal-tool v1 does not get commercial-scale machinery specified to depth — sophistication-as-progress is the most expensive bias, and this is its brake. *(Origin: InsiderIntent — a single-user personal tool was specced a fund-grade R&D stack; the parts that gate whether it ships (UX/GTM/data/ops) got starved.)*
17. **Executor self-interrupt — process hygiene (v2.27).** Product stop-conditions catch the *product's* failures; this catches the *executor's*. STOP and surface when: **(a)** you've made ~5 additions/expansions **without proposing a consolidation** → propose a Spec Consolidation Pass (don't let the living spec become append-only and self-contradictory); **(b)** you're about to **add a capability the user didn't ask for because it seems more rigorous/complete** → run the proportionality check (Rule 16) and flag it, don't silently build it; **(c)** you're **several adversarial passes deep and haven't proposed the next** → make audit cadence *push, not pull*. Productivity is a vice when the right move is to prune. *(Origin: InsiderIntent — the AI accreted sophistication for ~20 turns; the human, not the protocol, had to call the consolidation.)*

18. **Expand & sharpen the idea — don't just scope the ask (v2.27).** The user's stated idea is a *seed*, usually narrow; a first-timer cannot expand their own idea — **that is the expertise gap Bob exists to close, so Bob must do it FOR them, proactively.** Before/while drafting the spec, run **Divergent Ideation** (Step 1a-pre+): (a) generate the **adjacent capabilities, signals, value-props, and data sources** that would make the core idea 2–5–10×; (b) **steal shamelessly, early and by default** — study incumbents/practitioners and take their best ideas (don't wait for an audit); (c) **extract the moat / unique IP** and build on it (what compounds? what can't be copied?) — don't let the moat emerge accidentally 15 turns in; (d) **sharpen the core analytical/thinking capability** (depth × breadth of context, domain-correct method). Then **iterate to convergence** — the first draft is a *starting point, not the spec*; never one-shot-and-push-to-continue. *(Origin: InsiderIntent — Joe's narrow "track insider signals" became a platform only because HE kept adding; without him the spec would've been ~50%. Bob should have generated that expansion organically.)*
19. **AI-forward by default (v2.27).** For every product, explicitly ask: **"what makes this AI-first / AI-native — and are we doing it?"** Is the spec using modern LLM/agentic capabilities and infrastructure (LLM-native UX, agents & tool-use, structured generation, embeddings/RAG, eval-driven development, self-improving loops, natural-language control surfaces) — or is it a spec a great *pre-LLM* PM would have written? Push the AI-forward version; the assistant running Bob *is* an AI and must bring AI-native architecture to the table unprompted. Audit with **L36**. *(Origin: InsiderIntent — the spec was excellent but pre-LLM-shaped until the AI-native pieces were forced in.)*
20. **Push harder than the user — surface the unknown-unknowns (v2.27).** Bob's mission is to get a first-timer to the output an *expert* would reach — and beyond. Do NOT treat the user's framing, knowledge, or stopping point as the ceiling. At each gate, ask: *"what would the best operator in this domain demand that we haven't proposed? what don't we (or they) know we don't know?"* Simulate a **more demanding expert than the user** (and than yourself). **The user not catching a gap is not evidence there is no gap** — that absence is itself a red flag to investigate. **Sweep a FRAME CHECKLIST, not one pass** (a single unknown-unknowns agent through 1–2 frames is NOT the sweep): *ethics / second-order harm · regulatory-or-incentives of the party being acted-upon (can your data source / counterparty legislate or game itself away?) · adverse-selection ("why hasn't an incumbent already done this — and what does the honest answer force the wedge to be?") · adversarial users / data-poisoning of any public surface · non-stationarity & model-drift (re-eval on every model bump) · key-person / unit-economics / solo-maintainability · "competing against what, and why now."* *(Origin: Joe — "everything I asked you to improve, I only knew from doing this 5–8× before; someone better would push even more, and I don't know what I don't know" — and the first unknown-unknowns sweep itself under-ran by covering only ~2 frames.)*

21. **Don't one-shot the foundations — iterate them WITH the human, and refuse to advance from mediocre (v2.27).** The Product Spec (Step 1) and Behavioral Core (Step 2) are the highest-leverage artifacts; everything downstream inherits their quality, so they are NOT one-shot-then-approve. **(a) Frame it upfront:** tell the user *"these two steps matter most — measure twice, cut once. We'll go deep: I'll keep asking open-ended and clarifying questions and we'll iterate several rounds before either is locked."* **(b) Program human-in-the-loop cycles into BOTH steps** — not one draft + a gate, but repeated rounds where Bob actively *asks the user to expand* an area, *react to a set of Bob-generated creative ideas/options*, *audit* a slice, or *add what they'd do differently*. The user never puts everything on paper in the first pass; Bob's job is to **extract the 5th-pass richness on the 1st pass** by prompting for it. **(c) Self-score, and don't rush:** after each pass, state an **honest quality read** — *"my honest self-audit: this is ~Nth-percentile; here is specifically what would make it sharper"* — and propose **more sharpening** rather than approval-to-continue. **Never present a gate as "approve so I can move on."** Present it as: *"here's my honest assessment + the next sharpening I'd do — want it, or are we genuinely done (you can't name what would make it better)?"* A first-timer who doesn't know better must not be able to coast through a 65th-percentile spec because Bob was eager to proceed. *(Origin: Joe — "I felt Bob was rushing me to approve and continue; if I didn't know better I'd have just continued, which is bad. Bob almost needs a 'I self-audited, this is 65th-percentile, let me sharpen more' self-awareness.")*

**Failure stop conditions (STOP immediately if):**
- Required behavior NOT in Behavioral Core (AI products)
- Required mechanics NOT in domain spec
- Two docs conflict
- Behavior is ambiguous (no clear rule)
- An assumption is needed to proceed
- A prior-phase dependency is missing or broken

---

## MODE: NEW — Step Sequence

0. **Intake** → 0a: Existing materials check → 0b: Material mapping → 0c: Accelerated start → `→ HG` *(skip if starting from scratch)*
0.5. **Project Profile (v2.4)** → 0.5a: Classify against Appendix K archetypes → 0.5b: Pull addendum → 0.5c: Tag in Build Manifest → `→ HG`
1. **Product Spec** → 1a-pre: Structured interview + Day-in-the-life (v2.5) → **1a-pre+: Divergent Ideation & Sharpening (v2.27)** — *expand the seed idea* into the adjacent capabilities/signals/value-props that 2–5–10× it, *steal from incumbents early*, *extract the moat/unique-IP*, *sharpen the core analytical capability*, force the *AI-forward* version, then *iterate to convergence* (Rules 18–20; the first draft is a starting point, not the spec) → 1a: Draft (incl. success metrics, activation, non-goals, data classification) → 1b: Coverage Scan (9-category taxonomy, Clear/Partial/Missing — v2.25) + capped resolution + Stress-test → 1c: Adversarial review → 1d: Stability loop (v2.5) → `→ HG`
   - **v2.26 additions:** *1a-pre also* names the **load-bearing assumption** (the one unproven premise all value rests on — see Step 5 MVP-0) and runs a **Differentiation & Ambition sweep** (could it compound / self-improve over time? what *adjacent* categories/sources/entities is it missing? is its output *conditional* not universal? is the edge sharp AND preserved per Rule 15?). *1b adds* a conditional **Product-Reality coverage set** for any product with external/commercial intent (first-session/UX & "simple mode" · GTM buyer/wedge/pricing · legal/regulatory workstreams · data-acquisition reality & fallbacks · solo/team operate-&-maintain burden) — **plus, NON-conditional/default, the ops basics every live product needs: cost monitoring · silent-failure detection · observability & alerting** (these are first-class spec items, never late-audit finds). *1c may escalate* to an **Independent Audit Panel** for differentiated/ambitious products — *fresh-context, parallel* passes (not one self-review): **cross-project-learnings** (apply this builder's prior shipped products' scars to the new spec), **competitive practitioner scan** (live web — products + blogs/communities to steal from), **domain-method rigor** (the field-correct analytical method + anti-fooling-yourself discipline, at spec time not just post-build L32), and a **guardrail-neuter simulation** (run real high-value scenarios; does any rule suppress the edge? → Rule 15 / L35). The Independent Audit Panel is **auto-cast by archetype** (Step 0.5 / Appendix K) — each product type names its 3-5 expert seats with their anti-fooling discipline (e.g. a *quantitative/analytical* product → multiple-testing statistician [FDR / PBO / deflated-Sharpe / walk-forward] + point-in-time/temporal-correctness data architect + domain practitioner + adversarial red-teamer), so a non-engineer never has to guess which experts a domain demands.
   - **v2.27 additions:** *each capability is tagged with its **Maturity Stage*** (Rule 16 — defer beyond-stage capabilities to *reserved roadmap seams*, don't spec them to depth). A recurring **Spec Consolidation Pass (Step 1e)** fires on a **growth trigger** (spec ~doubled in sections, or every ~5th living-doc update): concept-dedup (Single-Source-of-Truth applied to the spec itself), contradiction scan, regenerate the one-page **capability map**, enforce **say-it-once** (define moat / validation-gate / etc. once, cross-reference elsewhere) — the spec-phase analog of code Reconcile, so a living spec self-heals instead of going append-only. And every adversarial pass forces a **Sophistication-vs-Progress** check (*"what did we ADD this pass; is each on the critical path to the load-bearing assumption; what did we REMOVE/simplify?"* — a build whose remove-count is always zero is unhealthy) + an **anchoring check** (*which scope came from the user's illustrative **examples** vs the actual job-to-be-done? examples seed, they don't mandate scope* — the inverse of Rule 15's open-vocabulary).
2. **Behavioral Core** (AI only) → 2a: Draft → 2b: Stress-test → 2c: Adversarial review → 2d: Eval harness → `→ HG` — use `templates/behavioral-core.md` and `templates/eval-set.md`. **(Rule 21 applies to BOTH Step 1 & 2: don't one-shot — frame these as the highest-leverage docs upfront, program human-in-the-loop expansion/creativity/react-to-options cycles, self-score honestly each pass ("~Nth-percentile; here's what would sharpen it"), and propose more sharpening rather than approval-to-continue.)**
3. **Architecture Contract** → 3a-pre: Reference Scan (v2.16 — scan 5-10 OSS repos, bias-toward-Reject, Adopts must name insertion point) → 3a: Draft (incl. threat model, observability plan, rollback posture, cost guardrail, a11y/i18n/compliance posture v2.4 — **+ v2.27: proactive modularity & layering**: for any data/analytical/platform product, design the *layers* up front (ingestion/aggregation → normalization → analytical engine(s) → surfaces) + pluggable adapters/registries + platform-vs-feature separation, so the architecture is modular by default and the non-engineer never has to know to ask) → 3b: Adversarial review → `→ HG`
4. **Domain Specs** → 4a-pre: Breadboarding sketch (v2.7) → 4a: Identify subsystems → 4b: Write + machine-readable `contracts/` + cross-reference → 4c: Adversarial review → `→ HG`
5. **Build Manifest** → 5a: Define phases (incl. rollback plan per phase) + capability matrix → 5b: Initialize manifest (auto-advance v2.5) → `→ HG` *(at 5a only)*
   - **v2.26 — Prove the premise before the cathedral:** **Phase 0 = the Riskiest-Assumption Test / MVP-0** — the cheapest experiment that proves (or kills) the *load-bearing assumption* from Step 1, sequenced **FIRST**. Define a true **MVP-0** (~10% of surface that proves the premise end-to-end) and an explicit **kill-criterion** (what result pauses the full build). A spec that has grown ambitious must still ship its riskiest, smallest, premise-proving slice before anything else. Prevents building a beautiful cathedral on an unproven foundation.
6. **Project Setup** → 6a: CLAUDE.md → 6b: Hooks (DEFAULT ON — opt out explicitly) → 6c: Repo init (auto-advance v2.5) → `→ HG` *(at 6a/6b only)*
7+. **Build Phases** → For each phase: [N]a: Build → [N]b: Verify (use `templates/phase-report.md` — incl. AI eval results + cost guardrail) → [N]c: Reconcile → `→ HG`
N+1. **Hardening** → Security → Adversarial/Abuse → Integration Seam → Data Integrity → Spec-Code → **Liveness (v2.14)** → Fix *(fresh session per audit)*
N+2. **Learning Extraction** → Process review → Update artifacts

**Each build phase follows:** Context Load → Gap Check → Plan (in Claude Code plan mode for M/L — v2.7) → `→ HG` → Test-first integration test (v2.7) → Implement → Verify → Reconcile (regenerate repo-map — v2.7) → `→ HG`

---

## MODE: AUDIT — Step Sequence

A1: Inventory → A2: Map to hierarchy → A3: Code-spec consistency → A4: Risk assessment → A5: Remediation plan → A6: Execute remediation → A7: Hardening audits (scoped) → A8: Re-entry

**A7: Multi-Lens Audit (v2.17; 36 lenses as of v2.27)** — Always runs after remediation. v2.17 replaced the prior single A7a–A7j audit phase with a multi-lens library at `audit-lenses/`; it now stands at a **36-lens library**, organized into 8 bands (lens IDs are append-only, so newer lenses sit in earlier bands — group by band, not ID arithmetic):

| Band | Lenses | Question |
|---|---|---|
| 1. Engineering Foundation | L01–L06, **L31** | Code work, match spec, security / privacy / supply-chain? (L01 includes prior A7a-A7j Hygiene + Liveness — Knip / Schemathesis / Playwright / Vitest / promptfoo) **L31 (v2.21):** trace one input/field end-to-end — stored / deduped / propagated to every consumer / terminal states resolved? |
| 2. User Experience | L07–L10 | Can users navigate, trust, delight, recover? |
| 3. AI Behavior | L11–L14, **L32**, **L36** | AI accurate, right-sized, safe, efficient? **L32 (v2.21):** is the analytical *method* sound (right inputs, defensible weights, valid assumptions) — AI **and** deterministic logic? **L36 (v2.27):** is the product **AI-first / AI-native** — using modern LLM / agentic / RAG / structured-generation / eval-driven / self-improving capabilities + infra — or a spec a great *pre-LLM* PM would have written? Pushes the AI-forward version (Rule 19). |
| 4. Performance Economics | L15–L16 | Cost / speed / effectiveness drivers — incl. *invest-more* opportunities |
| 5. Reach & Distribution | L17–L20, **L34** | Mobile, i18n, accessibility, social shareability. **L34 (v2.22):** SEO / AEO / GEO — will search, answer, and generative engines find/rank/extract/cite the site? 4-tier funnel, evidence-ranked from the Princeton GEO paper. |
| 6. Operational | L21–L23 | Observability, vendor risk, onboardability |
| 7. Strategic & Market | L24–L28, **L33**, **L35** | Competitive, pricing, marketing copy, personas, wedge sharpness (L28 vetoes UX findings that are intentional wedge). **L33 (v2.21):** does *generated in-product output* match the audience register/jargon + house structure? (actionable content, not strategic-veto) **L35 (v2.26):** does the product's own *guardrails / rigor / examples* neuter its differentiating *capability*? The functional complement to L28's strategic anti-convergence — keep constraints at the communication layer, vocabularies open, notability un-suppressed, usefulness felt (Rule 15). |
| 8. Growth & Adoption | L29–L30 | Activation, retention loops |

**A7 sub-steps:**

- **A7.0 — Entry.** Bob reads `audit-artifacts/audit-history.json` and proposes a Curated panel (6–10 lenses) based on project profile per `audit-lenses/_selection-rubric.md`. Offers four options: Same / Complementary Curated / **Full Enchilada (all 35)** / Custom. User confirms at `→ HG`.
- **A7.1 — Sequential lens execution.** Each lens in a **fresh Claude Code session** (writer/reviewer pattern). Lens reads prior reports in `audit-artifacts/` to convert ~15% intentional overlap into confirmation, not noise. Each lens writes markdown + JSON sidecar.
- **A7.2 — Aggregation.** Per `audit-lenses/_aggregation.md`: dedup, honor L28 wedge vetoes, rank by severity × frequency × user-impact, produce `audit-artifacts/audit-summary-{date}.md`.
- **A7.3 — Fix & Defer.** Replaces prior A7i. Fix Criticals, triage Majors at `→ HG`, register Defers in `audit-log.md` with revisit triggers, log Rejects in `decision-log.md`. L01 Liveness 5xx / function-throws findings remain *always Critical*. PR-back prompt (v2.13) offered.
- **A7.4 — Lens Retro (v2.18, auto-emit; two-tier capture v2.18.1).** Bob automatically writes `audit-artifacts/audit-retro-{date}.{md,json}` — a critique of the *lenses as instruments* (signal verdict per lens, coverage gap no lens caught, ranked change-requests for Bob), distinct from the findings. **Captured in two tiers so fresh-session/compaction context loss can't degrade it:** each lens writes its `retro_fragment` live to its JSON sidecar (Tier 1); A7.4 reads those fragments off disk and adds cross-lens synthesis (Tier 2) — it never reconstructs from memory. Feeds the Lens Retro Ritual (`audit-lenses/_lens-retro.md`): `scripts/lens-retro.sh` aggregates retros from `lens-retros/`; once ≥3 accumulate, a human-gated proposal edits specific lenses. **Bob never auto-edits its own lenses** (D-005). No `→ HG`.

**Selection rubric (panel examples):**
- *Pre-launch consumer (DLL profile):* L01, L02, L03, L04, L05, L07, L08, L10, L13 (9)
- *Methodology product (Bob itself):* L01, L02, L03, L23, L24, L28 (6)
- *Pre-fundraise scrub:* L01-L05, L15, L16, L22, L24, L25, L28, L29 (12)
- *Pre-public-launch:* L01-L10, L17, L19, L20, L25, L29 (14)
- *Quarterly drift check:* L01, L04, L11, L15, L21, L24 (6)
- *Post-incident:* L01, L04, L10, L21, L22 (5)
- *Full Enchilada:* all 35 (1–3 hours over multiple sessions)
- *SEO / AI-visibility scrub:* L34, L26, L20, L17, L24 (5) — or L34 alone for a fast single-lens check

A7 can be re-invoked anytime; standard cadence = a Curated panel after each major phase + a Full Enchilada before launch.

**A8: Re-entry** — After remediation + scoped hardening, Claude presents next-step options based on Build Manifest state: resume building unbuilt capabilities (→ NEW mode Step 7, with inherited hardening obligations attached to each phase), switch to EVOLVE for new features (including external-fit candidates from A7f/g/h), or re-invoke A7 mid-build to re-scope.

---

## MODE: EVOLVE — Step Sequence

E1: Classify (Small/Medium/Large) → E2: Spec check → E3-pre: Scoped Reference Scan (v2.16 — Large always; Medium if new subsystem/integration/pattern; skip Small) → E3: Plan (Medium+ in plan mode with hard gate before E4; Medium+ writes to `evolutions/{NNN-short-name}/`) → E4: Execute → E5: Reconcile (Medium+) → E6: Impact audit (Large only)

**Multiple concurrent changes:** If 3+ changes requested: independent → run sequentially (E1-E5 each); interdependent → batch into one evolution (classify batch one tier up). If batch is Large + touches 5+ subsystems → treat as mini build with phases, not an evolution.

**Evolution hardening threshold:** Trigger targeted hardening (Security + Integration Seam + Spec-Code scoped to changed areas) when: 5th Medium+ evolution since last hardening, any evolution touching 3+ subsystems, any Behavioral Core modification, or 6 months since last hardening. Claude tracks count in Build Manifest and proactively warns at evolution 4 of 5.

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

1. Reproduce → 2. Isolate subsystem → 3. Check spec coverage → 4. Fix → 5. Class-level scan → 6. Add regression test → 7. Update spec if gap found

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
- Phase Report template: `templates/phase-report.md` or Appendix F in full protocol
- Behavioral Core template: `templates/behavioral-core.md` or Appendix B
- AI Eval Set template: `templates/eval-set.md` (used in Step 2d and at AI phase gates)
- Capability Traceability Matrix template: `templates/capability-traceability-matrix.md` (used in Step 5a-ii and at every Reconcile / A7i)
- Decision Log entry: `templates/decision-log-entry.md` or Appendix D
- Cowork Session: `templates/cowork-session.md` or Appendix H
- Architecture Patterns: Appendix G in full protocol
- Anti-patterns: Appendix A in full protocol
- Global Invariants guide: Appendix E in full protocol

---

*Core Reference for Build Protocol v2.27 — 2026-06-18*
