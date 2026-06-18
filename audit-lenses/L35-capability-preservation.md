---
id: L35
name: Capability Preservation (Guardrail-Neuter Check)
band: 7
band_name: Strategic & Market
when_to_run: Any product whose value rests on a differentiating analytical, creative, or generative capability — especially AI products with safety/compliance/quality guardrails. Skip for products with no differentiating capability to neuter (pure CRUD, thin wrappers).
estimated_duration: 45-75 min — scenario simulation + rule tracing, not static inspection
session_pattern: fresh session; reads the Behavioral Core (the rules), the Product Spec (the differentiating capability), L28 (strategic wedge) if available
output_markdown: audit-artifacts/L35-capability-preservation-{YYYY-MM-DD}.md
output_json: audit-artifacts/L35-capability-preservation-{YYYY-MM-DD}.json
source_frameworks:
  - Rule 15 (Build Protocol v2.26) — Preserve the edge; constraints at the communication layer, not the capability layer
  - Origin case — the InsiderIntent build (the goal-seeking-vs-communication, sharpen-don't-neuter, two-axis-confidence, open-vocabulary, and daily-value corrections)
---

# L35 — Capability Preservation (Guardrail-Neuter Check)

## Question this lens answers

*Do the product's own guardrails, rigor, caution, and example-lists neuter the differentiating capability they're supposed to protect?* A product earns its right to exist with a sharp capability (an analytical edge, a creative engine, a generative insight). Then — correctly — it adds safety rules, compliance caution, statistical rigor, anti-abuse guardrails, and illustrative examples. This lens checks whether that protective layer has quietly **sanded off the very thing the product is for.**

## Why this lens exists / what other lenses miss

Every AI/quality/safety lens (L11–L14, L05, L04) pushes toward *more* guardrails. That is right — but it has a failure mode nothing else catches: **over-application that suppresses the capability.** The most common, most invisible way a sharp product becomes mediocre is not external convergence (that's L28) — it's *self-inflicted*: the team, trying to be safe/rigorous/honest, writes rules that bar the engine from doing the bold thing it was built to do.

This is distinct from its neighbors:
- **L28 (Strategic Edge)** = *strategic/positioning* convergence to market-average (are we still opinionated?). L35 = *functional/build* suppression of the capability by its own rules (does the engine still do the bold thing?). L28 is about identity; L35 is about behavior.
- **L11 (AI Accuracy)** / **L13 (AI Safety)** push for guardrails; L35 is their **counterweight** — it asks whether those guardrails over-reached. L35 should explicitly push back on L11/L13 findings that neuter the edge, the way L28 pushes back on L07/L08.
- **L32 (Analytical Method Soundness)** asks "is the method right?"; L35 asks "do our own safety/rigor rules stop the method from being applied to its full strength?"

The origin pattern (InsiderIntent): a goal-seeking analytical engine had its core "find the sharpest signal" capability repeatedly neutered by — in order — (1) compliance caution written into the *analysis* layer instead of the *communication* layer, (2) defamation caution suppressing the literal core signal, (3) statistical rigor filing every novel n=1 event under "insufficient — ignore," (4) example-lists hardening into closed enums, (5) honesty rules producing correct-but-useless "quiet day, nothing validated" output. Five separate neuterings of one edge. **A human had to catch all five.** This lens exists so the protocol catches them.

## When this lens fires

- ✅ **Strongly recommended** — any product whose value is a differentiating *capability* (analytical, generative, creative, predictive, recommendation, discovery).
- ✅ **Mandatory** — AI products with safety/compliance/quality/anti-abuse guardrails, OR any product where caution and capability are in tension (fintech, health, legal, security, content).
- ✅ **At spec time too (v2.26)** — runs as the "guardrail-neuter simulation" inside the Step-1c Independent Audit Panel, not only post-build.
- ⏸ **Skip** — products with no differentiating capability to protect (thin wrappers, pure CRUD, commodity tools).

## Audit method

Trace the product's guardrails/rigor/examples against its differentiating capability, looking for the four neutering facets (Rule 15). **The core technique is scenario simulation, not rule-reading.**

1. **Name the differentiating capability in one sentence.** What is the bold, sharp thing this product does that justifies it? (e.g., "finds the highest-conviction insider signal," "generates genuinely novel designs," "gives the sharpest legal read.") If you can't name it, that's an L28 finding, not L35 — note and stop.

2. **Build a battery of 12-20 high-value scenarios** — concrete instances where the product *should* deliver its sharpest, most differentiated output (the rare event, the bold call, the novel connection, the non-obvious insight). Span the full range of the capability; include the hardest/boldest cases.

3. **Trace each scenario through the actual guardrails/rules/rigor/templates.** For each: does the sharp output survive, or does some rule suppress/dilute/hedge/bury it? Verdict per scenario: ✅ surfaced sharp / ⚠️ partially neutered / ❌ neutered — and *which rule* does the neutering.

4. **Classify each neutering by facet (Rule 15):**
   - **(a) Layer confusion** — a constraint that belongs at the *communication / legal / safety* layer was written into the *analysis / capability* layer (so the engine is forbidden from *thinking* the bold thing, not just from *saying* it carelessly). Fix: move the constraint to the output/communication layer; let the capability run to the hilt.
   - **(b) Closed vocabulary** — an enumerated example-list (signals, categories, methods, styles) is treated as the complete/closed set, capping the product at "what someone listed." Fix: mark as open/extensible; instruct the engine to seek beyond it. (Distinguish: *governance* lists — safety rules, hard limits — SHOULD be closed.)
   - **(c) Novelty suppression** — validation/quality rigor built for *patterns* suppresses *individual rare/novel/notable instances* (filed under "insufficient data / low confidence / unverified"). Fix: separate "is it notable/worth surfacing?" (often assessable on a single instance) from "is it statistically validated?" (needs volume); surface notable novelty loudly with honest caveats.
   - **(d) Usefulness sacrificed to correctness** — rigor/honesty produces output that is correct but useless/boring/unactionable (the user stops engaging). Fix: a "value contract" — the product must always deliver felt usefulness, with honesty as the *framing*, not as a reason to deliver nothing.

5. **Run the pushback pass on the guardrail lenses.** Pull findings from L11 (Accuracy), L13 (Safety), L05 (Privacy), and any rigor/compliance source. For each, ask: *did this guardrail over-reach into the capability?* Mark over-reaching guardrails "relocate to communication layer" or "scope down" rather than accepting them. (Mirror of L28's pushback on UX lenses.)

6. **The bright-line test for each guardrail.** For every constraint, ask: *"Does this stop the engine from DOING the valuable thing, or only from SAYING it carelessly / to the wrong audience?"* The first is a neuter (fix it); the second is legitimate (keep it).

## Check questions

1. Can you state the differentiating capability in one sentence? Does the product, as ruled, actually deliver it at full strength?
2. Run 12-20 boldest-case scenarios: how many surface SHARP vs. neutered? (Any ❌ on a flagship scenario is Critical.)
3. **Layer test:** is any constraint written into the *capability/analysis* layer that belongs in the *communication/output* layer? (The engine should pursue its goal fully; only delivery is constrained.)
4. **Vocabulary test:** which enumerated lists are implemented (or read) as *closed* sets? Should they be open/extensible? (Separate content-vocabularies-open from governance-lists-closed.)
5. **Novelty test:** does the product surface a genuinely *novel/rare/notable* single instance loudly — or does validation rigor file it under "insufficient/unverified"? Is "notable" separated from "validated"?
6. **Usefulness test:** on a typical (not best) day, is the output *felt as useful*, or is it correct-but-boring/empty? Is there a value contract guaranteeing felt usefulness?
7. Which L11/L13/L05/compliance findings *over-reached* into the capability and should be relocated or scoped down?
8. For each guardrail: does it stop the engine DOING the valuable thing, or only SAYING it carelessly? (DOING = neuter; SAYING = legit.)
9. Where is the product hedging/softening/caveating so much that the signal evaporates into vague mush?
10. If a bold competitor with no guardrails ran the same capability, what would they surface that we suppress — and is our suppression *necessary* or *over-cautious*?

## Output schema

### Markdown report
```markdown
# L35 — Capability Preservation — {YYYY-MM-DD}
## Differentiating capability (one sentence)
## Scenario battery (12-20)
| # | Scenario (boldest-case) | Sharp output it SHOULD give | Verdict (✅/⚠️/❌) | Neutering rule + facet (a/b/c/d) | Fix |
## Neutering findings by facet
### (a) Layer confusion — constraints in the wrong layer
### (b) Closed vocabularies that should be open
### (c) Novelty suppressed by validation rigor
### (d) Usefulness sacrificed to correctness
## Pushback on guardrail lenses (L11/L13/L05/compliance over-reach)
| Source lens & finding | Verdict (relocate/scope-down/keep) | Rationale |
## Top capability-preservation fixes (ranked)
## Findings (numbered, severity-tagged, JSON-mirrored)
```

### JSON sidecar
```json
{
  "lens_id": "L35",
  "lens_name": "Capability Preservation",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "differentiating_capability": "{one sentence}",
  "scenarios_total": 0,
  "scenarios_neutered": 0,
  "neuterings_by_facet": {"layer_confusion": 0, "closed_vocabulary": 0, "novelty_suppression": 0, "usefulness_sacrificed": 0},
  "guardrail_overreach_pushbacks": [],
  "findings": [
    {"id": "L35-F001", "severity": "critical|major|minor|cosmetic",
     "facet": "layer_confusion|closed_vocabulary|novelty_suppression|usefulness_sacrificed",
     "title": "{short}", "scenario": "{the case it neutered}",
     "neutering_rule": "{which rule/constraint did it}",
     "recommendation": "{relocate-to-communication-layer | open-the-vocabulary | separate-notable-from-validated | add-value-contract}"}
  ],
  "top_preservation_fixes": []
}
```

## Severity rubric
- **Critical** — a flagship/boldest-case scenario is fully ❌ neutered by the product's own rules; the differentiating capability does not survive contact with the guardrails. The product is paying for an edge it then forbids itself from using.
- **Major** — multiple ⚠️ partial neuterings of core scenarios; a closed vocabulary caps the capability; novelty is systematically filed under "insufficient"; typical-day output is correct-but-useless.
- **Minor** — over-hedging dilutes sharpness; a guardrail over-reaches but a workaround exists; one example-list reads as closed.
- **Cosmetic** — phrasing softens the edge slightly; easily sharpened.

## Anti-patterns / Bias instructions
- **Do NOT recommend removing legitimate guardrails.** The fix for a neuter is almost always *relocate the constraint to the communication/output layer* or *scope it down*, NOT delete it. Safety, legality, and honesty stay — they just stop suppressing the *capability* and instead govern the *delivery*. The engine thinks boldly; the output speaks responsibly.
- **Do NOT confuse legitimate caution with neutering.** A rule that stops the product from *saying* something defamatory/unsafe/false to the wrong audience is correct. A rule that stops the engine from *finding/computing/considering* the bold thing is a neuter. The bright line is DOING vs. SAYING.
- **Do NOT loosen governance lists.** "Vocabularies are open" applies to *content* (signals, styles, categories, methods) — NOT to safety rules, hard limits, or refusal lists, which must stay closed and binding. State the distinction in every finding.
- **Bias toward the bold output.** When unsure whether output is "too sharp," default to preserving sharpness + adding an honest caveat, not to suppression. This lens, like L28, biases toward the edge.
- **Push back loudly on L11/L13/L05.** If a safety/accuracy/privacy lens recommended a guardrail that neuters the capability, say so explicitly and propose the layer-relocation. Aggregation honors L35's pushback the way it honors L28's.

## Stop conditions (the gap IS the finding)
1. **No differentiating capability exists.** The product is a commodity/wrapper — L35 doesn't apply (and that's an L28/L24 finding). Skip and note.
2. **Capability can't be articulated.** That's the finding — there's nothing to preserve because nothing sharp was defined. Route to L28.
3. **No guardrails exist yet.** Run forward-looking: simulate the boldest scenarios and flag *where* future guardrails are most likely to neuter, so they're written at the communication layer from the start.

## Cross-lens handoff
- **Upstream:** L28 (is there a wedge to preserve?), L11/L13/L05 (the guardrails to pressure-test), L32 (the analytical method), L02 (declared capability).
- **Downstream:** findings feed the Behavioral Core revisions (relocate constraints), the Daily-Value/usefulness requirements, and the open-vocabulary convention.
- **Adjacent ~15% overlap:** L28 (both anti-neuter — L28 strategic/identity, L35 functional/capability); L11/L13 (same guardrails, opposite question — they add, L35 checks for over-reach).
