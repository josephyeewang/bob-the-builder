---
id: L33
name: Output Register & Audience Fit
band: 7
band_name: Strategic & Market
when_to_run: Any product that generates user-facing text output — AI responses, diagnoses, recommendations, insights, summaries, reports, notifications, in-app explanations. Especially products serving a non-technical audience or aiming for a specific presentation style. Skip products with no generated prose output. Mandatory before launch for consumer / non-expert audiences.
estimated_duration: 45-90 min
session_pattern: fresh session; reads L02 (target audience), L11/L32 (the analysis behind the output) and L26 (brand voice) if available
output_markdown: audit-artifacts/L33-output-register-audience-fit-{YYYY-MM-DD}.md
output_json: audit-artifacts/L33-output-register-audience-fit-{YYYY-MM-DD}.json
source_frameworks:
  - ISO 24495-1:2023 Plain Language (Relevance · Findability · Understandability · Usability)
  - Minto Pyramid Principle (answer-first, MECE grouping, labeled supporting points) — the "McKinsey structure" house style
  - NN/g Tone-of-Voice 4 dimensions (funny↔serious, formal↔casual, respectful↔irreverent, enthusiastic↔matter-of-fact)
  - Flesch-Kincaid / readability metrics (applied to in-product output)
  - Microsoft Writing Style Guide · Google developer docs style · Diátaxis (house-style anchors)
---

# L33 — Output Register & Audience Fit

## Question this lens answers

*Does the language the product actually puts in front of users — its diagnoses, recommendations, insights, summaries, notifications, explanations — match the audience it's for and the house style it's supposed to follow? Is it pitched at the right register and reading level (no jargon for a non-technical user), and is it structured the way the product intends (e.g. answer-first, labeled takeaways, McKinsey-style) — or is it raw model output in whatever voice the LLM defaulted to?*

## Why this lens exists / what other lenses miss

L26 (Marketing, Copy & Website) audits **marketing surfaces** — homepage, landing, pricing, blog — for clarity, SEO, conversion, contradictions. It explicitly **skips in-product output**. L18 (i18n & Language) audits **translation readiness** (hardcoded strings, plurals, RTL), not register or tone. L27 (Persona Simulation) can *notice* jargon adversarially but doesn't systematically audit every output surface.

So the language users *actually read most* — the generated text the product produces in normal use — falls through the cracks. The EMBT case: a diagnosis written in clinical jargon for a deliberately non-technical audience. That's not a marketing-copy problem (L26 skips it) and not a translation problem (L18) — it's an **output register / audience-fit** problem, and no lens owns it.

There's a second half Joe named: **house presentation style.** Some products want a specific output structure — McKinsey-style answer-first with labeled takeaways and supporting detail after, or a strict "TL;DR → details" shape, or Diátaxis-typed docs. Whether generated output *conforms to the declared house structure* is a real, checkable quality bar that nothing currently checks.

L33 owns both: **register/jargon fit to audience** (ISO 24495 + readability + NN/g tone) and **structural conformance to house style** (Minto + the product's own format spec). It is routed as **actionable content**, like L26 — a jargon-laden diagnosis is a fixable defect, not a positioning opinion (so it does NOT go in the strategic-veto bucket with L27/L28).

## When this lens fires

**Always-in-Full-Enchilada for products with generated text output.** Curated panel inclusion criteria:
- ✅ Mandatory — products serving a non-technical / consumer audience where jargon mismatch directly damages trust and comprehension.
- ✅ Mandatory — products with a declared output house style (answer-first, structured reports, a brand voice the output must carry).
- ✅ Recommended — any AI product whose primary output is prose the user reads and acts on.
- ⏸ Skip — products with no generated prose output (pure data UI, dashboards with no narrative, dev tools with only structured output).

## Session setup

- Start a **fresh Claude Code session.**
- Read L02 (the declared target audience + reading level), L11/L32 (the analysis the output is communicating — so you don't critique the substance, only its expression), L26 (brand voice, for consistency across in-product and marketing).
- Inputs to load:
  - Product Spec — **declared target audience** (technical level, domain familiarity) and any **declared output style/format** (the house standard). If neither is declared, that's the first finding.
  - The output-generating code — prompts/templates that produce user-facing text; any post-processing/formatting.
  - **Real generated samples** — 10-30 actual outputs across easy/typical/hard inputs (generate them from the running product; don't judge the prompt, judge the output).
- Tooling (orchestrate, don't reinvent):
  - `textstat` / Hemingway / readable.com — Flesch-Kincaid + reading-grade on real outputs.
  - A jargon/term list for the domain — to flag undefined domain terms.
  - The running product — **execute**: produce the outputs you grade, don't infer them from the prompt.

## Source frameworks

- **ISO 24495-1:2023 Plain Language** — four principles: **Relevance** (audience-appropriate, nothing superfluous), **Findability** (structure lets readers locate what they need), **Understandability** (wording/structure clear for the intended reader), **Usability** (reader can act on it). The audience-anchored definition of "clear."
- **Minto Pyramid Principle** — answer/conclusion first, then MECE-grouped supporting points, each labeled; the canonical "McKinsey structure" Joe named (front-loaded takeaways, descriptions after).
- **NN/g Tone-of-Voice 4 dimensions** — funny↔serious, formal↔casual, respectful↔irreverent, enthusiastic↔matter-of-fact; makes "register" a measurable target instead of a vibe.
- **Flesch-Kincaid / reading-grade metrics** — quantify reading level of real output against the audience target.
- **Microsoft Writing Style Guide / Google dev-docs style / Diátaxis** — reference house-style systems when the product hasn't declared its own.

## Audit method

1. **Establish the two targets.** From the spec: (a) **audience register target** — who reads this and at what level? (e.g. "anxious non-medical patient, ~8th-grade reading level, zero clinical vocabulary assumed"), and (b) **house-style target** — declared output structure/voice, if any (e.g. "answer-first, ≤3 labeled takeaways, detail below the fold"). If either is undeclared → finding (you can't audit fit without a target).

2. **Collect real outputs.** Generate 10-30 actual outputs from the running product across easy/typical/hard/edge inputs. Grade *these*, not the prompt — the prompt's intent and the output's reality often diverge.

3. **Readability check.** Run Flesch-Kincaid / reading-grade on each sample. Compare against the audience target. Flag every output above the target grade. (A non-technical-audience product whose diagnoses read at grade 14 is a Critical.)

4. **Jargon / register audit.** Per sample, scan for:
   - Undefined domain terms the target audience wouldn't know (clinical, legal, financial, technical jargon).
   - Register mismatch on the NN/g dimensions — too formal/clinical/cold for an anxious consumer, or too casual for an expert audience.
   - Unexplained acronyms, internal terminology leaking to users, raw enum/status values shown as prose.
   - Hedging/AI-tells that erode authority where confidence is warranted (or false confidence where hedging is warranted — cross-ref L11 calibration).

5. **House-structure conformance (Minto).** Per sample, check against the declared style:
   - **Answer-first?** Does the output lead with the conclusion/takeaway, or bury it after preamble?
   - **Labeled / scannable?** Are takeaways front-loaded and labeled, with supporting detail after — or is it an undifferentiated wall of text?
   - **MECE / non-redundant?** Are points mutually exclusive and collectively exhaustive, or overlapping and gappy?
   - **Consistent shape across outputs?** Does every output of the same type follow the same skeleton, or does structure drift sample to sample?

6. **Plain-language 4-principle pass (ISO 24495).** Per sample: Relevant (no superfluous content for this reader)? Findable (can they locate the key point fast)? Understandable (wording clear for them)? Usable (can they act on it)?

7. **Cross-surface voice consistency.** Compare in-product output voice to L26's marketing voice. Tone *variance* by context is fine (a notification ≠ a report); *voice* variance (sounds like a different author/product) is a finding.

8. **The empty/error/edge output check.** Audit the *non-happy-path* text too — empty states, error messages, "we couldn't analyze this" outputs. These are where register and house-style most often regress to raw/technical defaults.

9. **Rank by reach × mismatch.** The output users see most often, pitched most wrongly for them, ranks first. Top 3 by frequency × severity-of-mismatch.

## Check questions

1. Is the **audience register target** declared (who reads this, what level)? Is the **house-style target** declared?
2. Did you grade **real generated outputs** (10-30 samples), not the prompt?
3. Readability: does each output's reading grade match the audience target? Any above-grade outliers?
4. Jargon: any undefined domain terms / acronyms / internal terminology leaking to a non-expert audience?
5. Register: do outputs sit on the right side of the NN/g tone dimensions for this audience (e.g. warm not clinical for an anxious user)?
6. House structure: is output **answer-first** with **labeled, front-loaded takeaways** (if that's the declared style)?
7. Is structure **consistent** across outputs of the same type, or does it drift?
8. ISO 24495: is each output Relevant / Findable / Understandable / Usable for the intended reader?
9. Does in-product output voice stay consistent with L26 marketing voice (variance by context OK, voice drift not)?
10. Did you audit empty / error / edge-case output text, not just the happy path?
11. For any confidence/hedging language, does it match the actual calibration (cross-ref L11)?
12. What's the single highest reach × mismatch finding?

## Output schema

### Markdown report

```markdown
# L33 — Output Register & Audience Fit — {YYYY-MM-DD}

## Targets
- Audience register target: {who / level / vocabulary assumptions}
- House-style target: {declared structure/voice, or "UNDECLARED — finding"}

## Output samples graded
| # | Output type | Input case | Reading grade | Register fit | Structure conforms? |
|---|---|---|---|---|---|

## Readability
| Output type | Target grade | Median actual | Worst | Pass? |
|---|---|---|---|---|

## Jargon / register findings
| # | Sample | Term/pattern | Why it misfits audience | Fix |
|---|---|---|---|---|

## House-structure conformance (Minto)
| Sample | Answer-first | Labeled takeaways | MECE | Consistent shape | Verdict |
|---|---|---|---|---|---|

## ISO 24495 plain-language pass
| Sample | Relevant | Findable | Understandable | Usable |
|---|---|---|---|---|

## Voice consistency vs L26
| Surface | In-product voice | Marketing voice | Coherent? |
|---|---|---|---|

## Edge/empty/error output
| State | Text | Register/structure regressed? |
|---|---|---|

## Top 3 highest reach × mismatch findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L33",
  "lens_name": "Output Register & Audience Fit",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "audience_target_declared": false,
  "house_style_declared": false,
  "samples_graded": 0,
  "samples_above_target_grade": 0,
  "jargon_findings": 0,
  "register_mismatch_findings": 0,
  "structure_nonconformance_findings": 0,
  "median_reading_grade": null,
  "target_reading_grade": null,
  "voice_consistent_with_marketing": null,
  "executed_against_running_product": false,
  "findings": [
    {
      "id": "L33-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "no_audience_target|no_house_style|reading_grade_too_high|undefined_jargon|register_mismatch|leaked_internal_terminology|not_answer_first|unlabeled_wall_of_text|structure_drift|not_mece|voice_inconsistent|edge_output_regressed|miscalibrated_hedging",
      "title": "{short}",
      "output_type": "{diagnosis|recommendation|summary|notification|error|...}",
      "sample_evidence": "{quoted snippet}",
      "audience": "{intended reader}",
      "user_impact": "{1-sentence}",
      "recommendation": "{specific rewrite or structural change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Core, high-frequency output (the diagnosis/recommendation that IS the product) pitched at the wrong register for the declared audience — jargon-dense for a non-technical user, or reading-grade far above target. No audience target declared on a consumer product (the team doesn't know who it's writing for).
- **Major** — Declared house style ignored on a primary output (raw wall-of-text where answer-first labeled takeaways were specified). Undefined domain jargon on a frequent output. Structure drifts sample-to-sample so the product feels inconsistent. Miscalibrated confidence language on a trusted output.
- **Minor** — Register slightly off on a lower-frequency surface. Edge/error text regressed while happy-path is fine. Voice mildly inconsistent with marketing.
- **Cosmetic** — Phrasing polish; minor structural tidy on outputs that already fit.

## Anti-patterns / Bias instructions

- **Do NOT audit the prompt instead of the output.** Prompts state intent; outputs are reality. Generate real samples and grade those — a well-intentioned prompt routinely yields mismatched output.
- **Do NOT critique the substance — only the expression.** Whether the diagnosis is *correct* is L11/L32. L33 asks only whether it's *expressed* at the right register and structure. Stay in your lane or you'll double-count.
- **Do NOT overrule a deliberate register.** Some products want clinical precision *for* an expert audience; some want playful for consumers. Judge against the **declared** target, not a generic "simpler is always better." A formal register for a formal audience is correct.
- **Do NOT treat this as a strategic/wedge opinion.** L33 findings are actionable content fixes (route like L26), NOT strategic-veto-bucket items (L27/L28). A jargon-laden output is a defect, not a positioning stance.
- **Do NOT skip the edge/empty/error outputs.** That's where raw model voice and technical defaults leak through most — and where an anxious user is most fragile.
- **Bias toward "would the intended reader understand and act on this on first read, without a glossary?"** That's the ISO 24495 usability bar.

## Stop conditions (the gap IS the finding)

1. **No generated text output.** Pure data UI / structured-only product. Skip and note.
2. **No declared audience or house style.** L33 can still flag obvious jargon/reading-grade issues against a reasonable default, but **cannot** certify fit without a target — surface "audience/style undeclared" as the headline finding and recommend declaring it in the Product Spec (Step 1a) before re-running.
3. **Cannot generate real outputs** (no running product). Audit the prompts/templates statically, flag that real-output grading could not be performed, and recommend re-running against the live product.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (declared audience + style), L11 AI Accuracy / L32 Analytical Soundness (the substance being expressed — so L33 stays on expression), L26 Marketing (brand voice baseline).
- **Downstream:**
  - **L07 UX Ease & Cognitive Path** — output structure/findability affects cognitive load.
  - **L09 UX Wow** — a well-pitched, well-structured output is a peak candidate.
  - **L13 AI Interaction & Safety** — register of safety/disclaimer language.
- **Adjacent (~15% overlap):**
  - **L26 Marketing Copy** — both touch voice/clarity; L26 = *marketing surfaces*, L33 = *in-product generated output*. Explicitly non-overlapping by surface; voice-consistency is the deliberate seam.
  - **L18 i18n** — both touch "language," but L18 = translation readiness, L33 = register/structure in the source language.
  - **L27 Persona Simulation** — L27 may surface register issues adversarially; L33 audits them systematically. Aggregation dedups.
