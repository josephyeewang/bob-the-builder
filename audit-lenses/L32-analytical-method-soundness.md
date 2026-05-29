---
id: L32
name: Analytical Method Soundness
band: 3
band_name: AI Behavior
when_to_run: Any product whose value comes from processing/interpreting data into an output — scoring, diagnosis, recommendation, ranking, insight generation, risk assessment, matching. Covers BOTH AI/LLM logic AND deterministic algorithms (rules engines, scoring functions, heuristics). Skip pure CRUD / passthrough products. Mandatory before launch for any "the product tells you something" value prop.
estimated_duration: 90-180 min — requires reading the algorithm AND reasoning about its design, not just running it
session_pattern: fresh session; reads L02 (Spec Fidelity), L11 (AI Accuracy) and L16 (Effectiveness) if available
output_markdown: audit-artifacts/L32-analytical-method-soundness-{YYYY-MM-DD}.md
output_json: audit-artifacts/L32-analytical-method-soundness-{YYYY-MM-DD}.json
source_frameworks:
  - SR 11-7 Supervisory Guidance on Model Risk Management (Fed/OCC 2011; FDIC 2017) — "conceptual soundness" validation pillar
  - SR 11-7 three-pillar validation (conceptual soundness · ongoing monitoring · outcomes analysis)
  - SR 11-7 "effective challenge" — independent, competent, incentivized scrutiny
  - GARP — SR 11-7 in the age of agentic AI (applicability to LLM/agentic systems)
  - ISO/IEC TR 24027 (bias in AI-assisted decisions) — input/representativeness checks
---

# L32 — Analytical Method Soundness

## Question this lens answers

*For every place the product turns inputs into an interpretation — a score, a diagnosis, a recommendation, a ranking, an insight — is the analytical method itself **sound**? Does it use the right inputs, weight them defensibly, rest on assumptions that hold, handle the edge cases in its own reasoning, and have the depth the value prop implies — or is it a shallow heuristic dressed up as analysis?*

## Why this lens exists / what other lenses miss

L11 (AI Accuracy & Calibration) measures whether an AI call produces **correct output** — via evals, hallucination rate, calibration. That's SR 11-7's *outcomes analysis* pillar: did the answer match ground truth. But L11 is **AI-only**, and it judges the *output*, not the *method*. L16 measures effectiveness at the *outcome-metric* level. None of them ask the **conceptual soundness** question SR 11-7 puts first: *is the analytical design appropriate — right inputs, right weights, valid assumptions, adequate depth — independent of whether any single output happened to be right?*

This is the EMBT class of risk: a "diagnosis" or "recommendation" engine can return outputs that pass a spot-check eval while resting on an unsound method — three inputs considered when the spec implies twelve, equal weighting where the domain demands a hierarchy, a single threshold standing in for a distribution, a default that fires far more often than anyone realizes. A model can be *accurate on the test set and wrong by design.* And critically: **much processing logic is deterministic** (a scoring function, a rules cascade, a matching heuristic) — invisible to L11 entirely, because there's no model call to eval.

SR 11-7 defines a "model" as *any quantitative method, system, or analytical tool that transforms input into estimates, forecasts, or decisions* — algorithms and ML alike. L32 borrows its **conceptual-soundness** validation and its **effective-challenge** stance, scoped down from bank-grade governance to a solo builder's audit: not "stand up a model-risk org," but "challenge the reasoning the way an independent expert would."

## When this lens fires

**Always-in-Full-Enchilada for products with interpretive logic.** Curated panel inclusion criteria:
- ✅ Mandatory — the product's value prop is "it tells you something" (diagnosis, score, recommendation, insight, risk rating, match).
- ✅ Mandatory — any health / finance / safety-adjacent interpretation (an unsound method here is a liability, not a bug).
- ✅ Applies to deterministic algorithms, not just AI — run it even on a no-LLM product if there's a scoring/ranking/decision engine.
- ⏸ Skip — pure CRUD / storage / passthrough with no interpretation step.

## Session setup

- Start a **fresh Claude Code session.** (Method critique is easy to rationalize in the session that wrote the method.)
- Read L02 (what the spec claims the analysis does), L11 (output-accuracy data), L16 (effectiveness) if available.
- Inputs to load:
  - Product Spec / Behavioral Core — the *claimed* analytical depth and the domain logic it promises.
  - The algorithm(s) — prompt(s) for AI logic; the actual functions for deterministic logic (scoring, weighting, thresholds, rules).
  - Domain reference — what does correct analysis in this domain actually require? (clinical guideline, financial model, ranking literature). Bring an outside anchor; the method must be judged against the domain, not against itself.
  - Sample inputs spanning easy / typical / hard / adversarial cases.
- This lens **executes**: run the algorithm across the input spread and inspect *what it actually weighted*, not just the final answer.

## Source frameworks

- **SR 11-7 conceptual soundness** — evaluate the *quality of model design and construction*: are the inputs, assumptions, and methodology appropriate and well-supported? Documentation must let an outsider understand how it operates, its **limitations**, and its **key assumptions**.
- **SR 11-7 three-pillar validation** — conceptual soundness (L32) · ongoing monitoring (L16) · outcomes analysis/benchmarking (L11). L32 explicitly owns the first.
- **SR 11-7 effective challenge** — critical analysis by parties with the competence and incentive to find weaknesses; the adversarial posture L32 adopts toward the method.
- **GARP — SR 11-7 for agentic AI** — confirms the framework extends to LLM-driven decisioning.
- **ISO/IEC TR 24027** — input representativeness / bias in AI-assisted decisions; informs the "right inputs" checks.

## Audit method

1. **Inventory the analytical sites.** Grep + spec-read for every place inputs become an interpretation: AI decision prompts, scoring functions, ranking/sort logic, rules cascades, threshold checks, recommendation generators, risk/eligibility calculators. For each, capture: inputs consumed, method type (AI / deterministic / hybrid), output, and what decision it drives.

2. **State the claimed depth.** From the spec/value prop, write one sentence per site: what analysis does the product *claim* to do here? ("Weighs symptoms, history, age, and risk factors into a calibrated likelihood.") This is the bar.

3. **Reconstruct the actual method.** Read the code/prompt and write what it *actually* does, mechanically. ("Sums 3 boolean symptom flags; ignores age, history, risk factors; returns one of 3 buckets by fixed cutoff.") The gap between step 2 and step 3 is the headline.

4. **Conceptual-soundness review across 6 dimensions** (SR 11-7-derived), per site:
   - **Input completeness** — are the inputs the domain requires actually consumed? (Cross-check L31: a field that never arrived can't be weighted.) Missing inputs = the most common unsound-method finding.
   - **Weighting / structure defensibility** — is the combination logic justified, or arbitrary? Equal weights where the domain has a clear hierarchy? A magic constant with no provenance?
   - **Assumption validity** — what does the method assume (independence, linearity, a population, a distribution, a "normal" case)? Do those hold for the real input population?
   - **Depth vs. shallow proxy** — is this genuine analysis, or a keyword/threshold heuristic costumed as one? (Regex script-ratio standing in for NLP confidence is the DLL archetype.)
   - **Reasoning edge cases** — how does the method behave on missing inputs, contradictory inputs, out-of-range values, the empty case, the extreme case? Does it degrade sensibly or produce confident nonsense?
   - **Defaults & fallbacks** — what does it output when it can't really decide? Is the default safe, visible, and rare — or does it fire silently and often (the "everyone scores 'moderate'" failure)?

5. **Probe the input spread.** Run easy/typical/hard/adversarial inputs and inspect intermediate values (the actual weights, the chosen branch, the triggered default) — not just the final answer. Look for: outputs that don't move when an important input changes (a dead input), outputs that collapse to one value (a degenerate method), defaults firing on typical inputs.

6. **Effective-challenge pass.** Adopt the stance of an independent domain expert paid to find the flaw: *"Why this method? What would a competent practitioner in this domain do differently? What's the strongest argument this analysis is wrong-by-design?"* Write the strongest refutation you can, then judge whether the method survives it.

7. **Limitations & assumptions documentation check.** Are the method's assumptions and limitations written down anywhere (spec, code comments, model card)? An undocumented method can't be maintained, challenged, or safely changed — that itself is a finding (SR 11-7 documentation requirement).

8. **Rank by decision-stakes × unsoundness.** A shallow method behind a high-stakes decision (health diagnosis, credit eligibility) outranks a defensible-but-improvable method behind a low-stakes one. Top 3 by stakes × severity-of-flaw.

## Check questions

1. Have you inventoried every analytical site (AI **and** deterministic)?
2. Per site, have you written the *claimed* depth (step 2) and the *actual* method (step 3), and named the gap?
3. **Input completeness:** does the method consume every input the domain/spec requires? Any dead inputs (present but never affect output)?
4. **Weighting:** is the combination logic defensible, or are there arbitrary weights / magic constants with no provenance?
5. **Assumptions:** what does the method assume, and do those assumptions hold for the real input population?
6. **Depth:** is this real analysis or a shallow proxy (keyword/threshold/regex) costumed as analysis?
7. **Edge cases in the reasoning:** missing / contradictory / out-of-range / empty / extreme inputs — sensible degradation or confident nonsense?
8. **Defaults:** when the method can't decide, is the fallback safe, visible, and rare — or silent and frequent?
9. Did you probe the input spread and inspect *intermediate* values (weights, branches, defaults), not just final outputs?
10. Did you run an effective-challenge pass (strongest argument the method is wrong-by-design) and judge survival?
11. Are the method's assumptions and limitations documented anywhere?
12. For AI sites: does L11 cover output accuracy, so L32 can stay on method design? (Avoid double-counting.)
13. For deterministic sites: is L32 the *only* lens looking at this (L11 skips it)? If so, this is the sole correctness check — weight accordingly.
14. What's the single highest decision-stakes × unsoundness finding?

## Output schema

### Markdown report

```markdown
# L32 — Analytical Method Soundness — {YYYY-MM-DD}

## Analytical site inventory
| # | Site | Method type (AI/det/hybrid) | Inputs consumed | Drives decision | Stakes |
|---|---|---|---|---|---|

## Claimed-vs-actual method (per site)
| Site | Claimed depth | Actual method | Gap |
|---|---|---|---|

## Conceptual-soundness scorecard (per site)
| Site | Input completeness | Weighting | Assumptions | Depth | Edge cases | Defaults | Verdict |
|---|---|---|---|---|---|---|---|

## Effective-challenge results
| Site | Strongest refutation | Method survives? |
|---|---|---|

## Dead-input / degenerate-output / silent-default findings
| # | Site | Symptom (probe evidence) | Why unsound |
|---|---|---|---|

## Top 3 highest stakes × unsoundness findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L32",
  "lens_name": "Analytical Method Soundness",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "analytical_sites_found": 0,
  "sites_ai": 0,
  "sites_deterministic": 0,
  "claimed_vs_actual_gaps": 0,
  "dead_inputs": 0,
  "degenerate_outputs": 0,
  "silent_frequent_defaults": 0,
  "undocumented_methods": 0,
  "executed_input_spread": false,
  "findings": [
    {
      "id": "L32-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "missing_input|dead_input|arbitrary_weighting|invalid_assumption|shallow_proxy|reasoning_edge_case|unsafe_or_frequent_default|degenerate_output|undocumented_method|claimed_actual_gap",
      "title": "{short}",
      "site": "{path:line or prompt id}",
      "method_type": "ai|deterministic|hybrid",
      "stakes": "high|medium|low",
      "evidence": "{probe result / code observation}",
      "domain_anchor": "{what correct analysis requires}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — High-stakes interpretation (health/finance/safety) resting on a shallow proxy or missing a domain-required input. A default that fires on typical inputs and masquerades as analysis. A deterministic decision engine that L11 doesn't cover and whose method is unsound. Confident output on edge cases that should degrade or abstain.
- **Major** — Arbitrary weighting / magic constants on a meaningful decision. An invalid assumption that holds for the demo population but not the real one. A dead input the spec implies should matter. Undocumented assumptions on a method others must maintain.
- **Minor** — Defensible method with a specific depth-improvement path. Edge case handled but suboptimally. Documentation thin but present.
- **Cosmetic** — Sound method; naming/structure/readability of the analytical code.

## Anti-patterns / Bias instructions

- **Do NOT re-run L11's eval job.** L32 is not "is the output correct" — it's "is the method sound." If you find yourself measuring accuracy, that's L11. Stay on design: inputs, weights, assumptions, depth, edges, defaults.
- **Do NOT skip deterministic logic because it isn't AI.** The opposite — deterministic analytical logic is L32's *unique* territory; L11 ignores it entirely. A scoring function is a "model" under SR 11-7.
- **Do NOT judge the method against itself.** Bring an outside domain anchor (guideline, literature, expert heuristic). "The code does what the code does" is not soundness.
- **Do NOT confuse complexity with soundness, or simplicity with shallowness.** A simple method can be perfectly sound for its stakes; an elaborate one can be elaborately wrong. Judge fit-to-domain, not sophistication.
- **Do NOT pass judgment on a method you only read.** Probe the input spread and watch the intermediate values — a dead input or a silent default is invisible from the source alone.
- **Bias toward "would a competent practitioner in this domain stand behind this method?"** That's the effective-challenge bar. If the honest answer needs a real expert, say so and route to L27 (domain-expert persona) / human review — don't fake domain authority.

## Stop conditions (the gap IS the finding)

1. **No interpretation step.** Pure CRUD/passthrough. Skip and note.
2. **No domain anchor available.** If you can't establish what correct analysis requires in this domain (no guideline, no expert input), L32 can assess internal consistency and the 6 dimensions but **cannot** certify domain soundness — say so explicitly and route the domain-correctness question to L27 / human expert.
3. **Cannot execute the method** (no runtime / inputs). Do the claimed-vs-actual + static soundness review, flag that intermediate-value probing could not be performed, and recommend re-running where the method can be exercised.
4. **Method is undocumented and unreadable.** If neither code nor spec reveals the actual method, that opacity is itself a Critical finding (un-challengeable, un-maintainable) — stop and report it.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (claimed depth), L31 Input/Data-Flow Trace (which inputs actually arrive — a missing input can't be weighted), L11 AI Accuracy (output-side signal).
- **Downstream:**
  - **L11 AI Accuracy** — if L32 finds a redesigned method, L11 re-measures output accuracy after the fix.
  - **L16 Effectiveness** — method soundness feeds the ongoing-monitoring pillar.
  - **L13 AI Interaction & Safety** — an unsound method that's also user-trusted needs UI calibration / disclaimers.
  - **L27 Persona Simulation** — domain-correctness questions L32 can't certify route to the domain-expert persona.
- **Adjacent (~15% overlap):**
  - **L11** — both touch AI quality, but L11 = outcomes analysis (output correct?), L32 = conceptual soundness (method sound?). Distinct SR 11-7 pillars. Aggregation dedups on pillar.
  - **L03** — L03 grades capability *robustness*; L32 grades analytical *design*. A capability can be A-grade robust around an unsound core.
