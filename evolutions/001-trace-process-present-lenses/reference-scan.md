# Reference Scan — Evolution 001 (E3-pre, per v2.16)

> Scoped reference scan for three new audit lenses. Bias-toward-Reject on reinventing anything the field has converged on. Each Adopt must name the insertion point (which lens, which section).

## Why this scan fired

Medium+ evolution introducing **new analytical patterns** (data-flow tracing, method-soundness validation, register/audience analysis). Each new lens needs a real `source_frameworks` block — every existing L01–L30 lens cites established sources, and inventing frameworks would violate "orchestrate, don't reinvent" (§3, D-003).

## L31 — Input / Data-Flow Trace

| Source | What it gives us | Verdict | Insertion point |
|---|---|---|---|
| **Taint tracking / static & dynamic data-flow analysis** (Apiiro; arXiv 1608.04671 privacy taint analysis) | The core method: trace untrusted input from its **entry point → through every processing step → to its sinks**. Reveals where a field is consumed vs. silently dropped. This is *exactly* the EMBT gender/age "extracted but not propagated" case. | **ADOPT** | L31 audit method (the trace spine) + source_frameworks |
| **Column-level / field-level data lineage** (IBM, Acceldata) | Lineage at the *individual field* granularity ("prove where this specific PII field is stored and how it was processed") — not table/capability granularity. Directly models "does `age` reach the recommendation engine?" | **ADOPT** | L31 audit method (field-propagation matrix) |
| **STRIDE per-element Data-Flow Diagram decomposition** | The DFD as the structuring device — enumerate external entities, processes, data stores, trust boundaries the input crosses. | **ADOPT** | L31 audit method step 1 (draw the flow) |
| **GDPR Art.30 RoPA / PCI-DSS data-flow mapping** | Regulatory framing for *why* sensitive-field flow completeness matters. | **ADOPT (light)** | L31 source_frameworks; defer heavy compliance to L05 |
| Enterprise automated-lineage platforms (Collibra, etc.) | Heavyweight tooling. | **REJECT** | Bob orchestrates / traces a flow manually per-audit; no platform dependency. |

**Distinctness vs L03 / L05 (anti-sprawl gate):** L03 grades one capability's quality across 5 dimensions (vertical depth, one capability). L05 is privacy *compliance* on PII at rest/in transit. L31 is the orthogonal **horizontal** axis: one input/field traced *across many* capabilities to confirm every eventuality is handled and the data reaches every place it should — regardless of sensitivity. L03's "unidirectional wiring" check gestures at it but only per-capability. **Genuinely new.**

## L32 — Analytical Method Soundness

| Source | What it gives us | Verdict | Insertion point |
|---|---|---|---|
| **SR 11-7 Supervisory Guidance on Model Risk Management** (Fed/OCC 2011; FDIC 2017) | The spine. Defines a "model" as *any quantitative method, system, or analytical tool that transforms input into estimates/forecasts/decisions* — explicitly **algorithms AND ML**, i.e. covers deterministic edge functions *and* AI. Its **conceptual soundness** validation pillar = "is the method's design/logic/assumptions appropriate" = precisely this lens. Demands documented assumptions + limitations. | **ADOPT** | L32 audit method + severity rubric + source_frameworks |
| **SR 11-7 three-validation-pillar split** (conceptual soundness · ongoing monitoring · outcomes analysis/benchmarking) | Clean division of labor: **L32 owns conceptual soundness**; L11 owns outcomes analysis (evals); L16 owns ongoing effectiveness. Resolves the overlap cleanly. | **ADOPT** | L32 cross-lens handoff |
| **SR 11-7 "effective challenge"** (independent party with incentive + competence to find flaws) | The adversarial stance the lens takes toward the algorithm's logic. | **ADOPT** | L32 audit method (challenge the reasoning) |
| **GARP — SR 11-7 in the age of agentic AI** | Confirms the framework now applies to LLM/agentic systems; useful for the AI-applicability note. | **ADOPT (light)** | L32 source_frameworks |
| Full bank-grade MRM governance (model inventory, board oversight, 3 lines of defense org structure) | Org/governance machinery irrelevant to a solo builder. | **REJECT / scope-down** | Borrow the *validation* logic, not the org structure. |

**Distinctness vs L11 / L16 (anti-sprawl gate):** L11 measures *output correctness* via evals/hallucination/calibration (the "outcomes analysis" pillar) and is **AI-only**. L16 measures effectiveness at the outcome-metric level. L32 critiques the **conceptual soundness of the analytical method itself** (right inputs considered? weighted defensibly? assumptions valid? depth adequate vs shallow heuristic? reasoning edge cases?) and **spans deterministic algorithms L11 explicitly excludes**. Different SR 11-7 validation pillar. **Genuinely new.**

## L33 — Output Register & Audience Fit

| Source | What it gives us | Verdict | Insertion point |
|---|---|---|---|
| **ISO 24495-1:2023 Plain Language** (4 principles: Relevance · Findability · Understandability · Usability) | The spine. "Communication in which wording, structure and design are so clear that intended readers can easily find, understand, and use what they need." Audience-anchored by definition. | **ADOPT** | L33 audit method + check questions + source_frameworks |
| **Minto Pyramid Principle** (answer-first, grouped/labeled supporting points, MECE) | The McKinsey house-style dimension Joe named explicitly: front-loaded takeaways, labeled bullets, detail-after. | **ADOPT** | L33 audit method (house-structure check) + source_frameworks |
| **NN/g Tone-of-Voice 4 dimensions** (funny↔serious, formal↔casual, respectful↔irreverent, enthusiastic↔matter-of-fact) | Makes "register" measurable instead of vibes; lets a target register be declared and audited against. | **ADOPT** | L33 audit method (register scoring) |
| **Flesch-Kincaid / readability metrics** | Reused from L26 but applied to **in-product output**, a distinct surface. Executable (textstat / Hemingway). | **ADOPT** | L33 audit method (readability on output) |
| **Microsoft Writing Style Guide / Google dev docs style / Diátaxis** | House-style reference points for a declared style target. | **ADOPT (light)** | L33 source_frameworks |

**Distinctness vs L26 / L18 / L27 (anti-sprawl gate):** L26 audits **marketing surfaces only** (homepage/blog/pricing — SEO, conversion, contradictions) and explicitly skips in-product output. L18 is translation *readiness* (i18n infrastructure), not register. L27 surfaces it adversarially but unsystematically. L33 audits **all in-product user-facing output the product generates** (AI diagnoses, recommendations, insights, notifications) for audience-appropriate register/jargon + declared house structure. L26 stays narrow. **Genuinely new** — and routed as *actionable content* (like L26), NOT into the strategic-veto bucket (unlike L27/L28).

## Meta-finding (per v2.16/v2.17 dogfood pattern)

The scan confirms all three lenses borrow established, named methods rather than inventing — and each has a clean distinctness story against its nearest existing lens. The anti-sprawl risk is real (33 lenses now); mitigated by: selection rubric keeps these OFF the default Curated panels except where the project profile triggers them (see spec §Wiring).
