---
id: L11
name: AI Accuracy & Calibration
band: 3
band_name: AI Behavior
when_to_run: AI products only — anywhere a model produces output users (or downstream code) rely on. Skip for non-AI products. Mandatory before any AI launch or significant prompt/model change.
estimated_duration: 1-3 hours — requires actually running evals, not just reading them
session_pattern: fresh session; reads L02 (Spec Fidelity for behavioral claims) if available
output_markdown: audit-artifacts/L11-ai-accuracy-calibration-{YYYY-MM-DD}.md
output_json: audit-artifacts/L11-ai-accuracy-calibration-{YYYY-MM-DD}.json
source_frameworks:
  - TruLens RAG Triad (https://www.trulens.org/getting_started/core_concepts/rag_triad/)
  - RAGAS metrics (https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)
  - Arize Phoenix evaluator traces (https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)
  - LangSmith eval dimensions (https://www.langchain.com/articles/llm-evaluation-metrics)
  - promptfoo assertions (https://www.promptfoo.dev/docs/configuration/expected-outputs/)
  - ECE / calibration (arXiv 2501.19047) (https://arxiv.org/html/2501.19047v2)
  - Bob's existing evals/behavioral-core.yaml pattern (templates/eval-set.md)
---

# L11 — AI Accuracy & Calibration

## Question this lens answers

*How often does each AI call site actually produce correct output, and when the model expresses confidence, does observed accuracy match? Are there evals, and do they run on every change?*

## Why this lens exists / what other lenses miss

L01 Hygiene catches dead code. L02 Spec Fidelity catches behavioral claims that don't match code. Neither answers *"does the AI actually work?"* Engineering-hygiene tools (CodeRabbit, Greptile, lint, type-check) treat an AI call as a function call — they verify it executes, not that it produces correct output. An AI product can pass every engineering audit, ship to production, and silently hallucinate 30% of the time. The DLL audit caught a related class — language detection uses regex script-ratio instead of spec'd NLP confidence — but didn't grade hallucination rate, calibration error, or eval coverage. This lens does.

The complementary failure mode: **confidence miscalibration.** A model that says "I'm 90% sure" but is actually right 60% of the time is dangerous — it makes users (and downstream code) trust outputs that shouldn't be trusted. Calibration is invisible without an Expected Calibration Error (ECE) check.

This lens orchestrates established eval frameworks (TruLens, RAGAS, Phoenix, LangSmith, promptfoo). Bob does not reinvent — Bob orchestrates. See D-003.

## When this lens fires

**Always-in-Full-Enchilada for AI products.** Curated panel inclusion criteria:
- ✅ Always — if the product makes ≥1 AI call where output affects user-visible behavior or downstream code execution.
- ✅ Mandatory — before any AI launch, model change, prompt rewrite, or temperature/top-p change.
- ✅ Strongly recommended — quarterly drift check, even with no prompt changes (foundation models update; behavior drifts).
- ⏸ Skip — non-AI products, or AI products where all calls are pure formatting (e.g., text-to-text with no factual claims, no decisions, no extractions).

## Session setup

- Start a **fresh Claude Code session.** Eval results are easy to rationalize in the same session that built the prompts.
- Read prior reports — specifically L02 (Spec Fidelity) for behavioral claims from the Behavioral Core. These are what evals should be testing.
- Install/verify tooling:
  - **promptfoo** — `npm i -g promptfoo` (or pip equivalent) — for assertion-based eval runs.
  - Optional: **TruLens** (`pip install trulens-eval`), **RAGAS** (`pip install ragas`), **Phoenix** (`pip install arize-phoenix`), **LangSmith** (cloud — `pip install langsmith` + API key).
- Inputs to load:
  - `evals/behavioral-core.yaml` (Bob's canonical eval set per templates/eval-set.md)
  - Any RAG retrieval logs if applicable
  - Production logs / traces for sample real prompts (10-20 representative inputs)
  - Behavioral Core doc (the source of truth for what evals should cover)

## Source frameworks

- **TruLens RAG Triad** — reference-free feedback functions for RAG: `context_relevance`, `groundedness`, `answer_relevance`. https://www.trulens.org/getting_started/core_concepts/rag_triad/
- **RAGAS metrics** — `faithfulness`, `answer_relevancy`, `context_precision`, `context_recall`, `factual_correctness`. https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/
- **Arize Phoenix** — span/trace/session/experiment-scoped evaluators with pre-built templates (relevance, Q&A correctness, toxicity, hallucination). https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces
- **LangSmith** — correctness, conciseness, helpfulness, coherence, harmfulness; reference-based + reference-free. https://www.langchain.com/articles/llm-evaluation-metrics
- **promptfoo assertions** — deterministic (`equals`, `contains`, `regex`, `is-json`, `levenshtein`, `bleu`, `rouge`) + model-graded (`llm-rubric`, `g-eval`, `factuality`, `model-graded-closedqa`). https://www.promptfoo.dev/docs/configuration/expected-outputs/
- **Expected Calibration Error (ECE)** — bin confidence vs accuracy; Brier score / LogLoss as alternatives. https://arxiv.org/html/2501.19047v2

## Audit method

1. **Inventory AI call sites.** Grep the codebase for every place an AI model is invoked (`anthropic.messages.create`, `openai.chat.completions.create`, `model.generate`, equivalents). For each, capture: model name, what input it gets, what output it produces, whether the output is structured (JSON / tool-use) or free-text, whether output affects user-visible behavior or downstream code.

2. **Build the eval coverage matrix.** For each AI call site, identify which evals (in `evals/behavioral-core.yaml` or equivalent) test it. Mark coverage as:
   - **Covered** — at least 3 eval cases test this call site with diverse inputs.
   - **Thin** — 1-2 eval cases.
   - **Untested** — no eval cases reference this call site.

3. **Run the existing evals.** Execute `evals/behavioral-core.yaml` (or equivalent) via promptfoo. Capture pass rate per case. For RAG call sites, additionally compute the TruLens triad (context_relevance, groundedness, answer_relevance) on a sample of 20-50 real prompts.

4. **Compute calibration if the model expresses confidence.** For any AI output that includes a confidence score (numeric, or categorical like "high/medium/low"), bin observed accuracy by confidence bucket and compute ECE. Example: if outputs marked "high confidence" are right 85% of the time, that's well-calibrated. If they're right 60%, ECE is high and the product is over-trusting model self-reports.

5. **Estimate hallucination rate per task type.** For factual outputs (RAG answers, extractions, structured data), spot-check 10-30 production samples against ground truth. Compute hallucination rate. If no ground truth exists, that's the finding — write it down and stop on hallucination measurement.

6. **Check golden set freshness and growth.** Is the golden eval set checked into the repo? When was it last updated? Has it grown with production failure cases (regression set), or has it stayed static? Stale golden sets create false confidence.

7. **Check eval-in-CI status.** Do evals run on every prompt change / model change / PR? Or are they manual? Manual evals are unreliable evals.

8. **Check judge calibration if using LLM-as-judge.** If any eval relies on LLM-as-judge (model-graded assertions), has the judge prompt itself been evaluated against human ratings? If yes, what's the human-judge agreement rate? If no, judge calibration is unknown and eval results are noisier than they appear.

## Check questions

1. Is there a golden set of ≥30 input/expected-output pairs checked into the repo? Where?
2. For each AI call site, is it covered by ≥3 eval cases with diverse inputs (not just happy-path)?
3. For RAG call sites, do you measure all three TruLens triad dimensions (context relevance, groundedness, answer relevance) — not just one?
4. Do evals run in CI on every prompt change / model change / PR, with a pass-threshold gate? Or are they manual?
5. When the model expresses confidence (numeric or categorical), does observed accuracy at that bucket match? (ECE check.)
6. Is hallucination rate baseline measured per task type, and tracked over time?
7. Is there at least one deterministic assertion (regex, JSON schema validation) per AI output — not only LLM-as-judge?
8. Are LLM-as-judge prompts themselves evaluated against human ratings for agreement?
9. When production failures are found, are they added to the regression eval set?
10. Do you measure both reference-based (correctness vs ground truth) AND reference-free (groundedness vs retrieved context) signals?
11. Is there a "drift" eval that re-runs the golden set weekly to catch silent model/data degradation?
12. For structured outputs (JSON, tool use), does eval verify the schema validates AND the values are sensible — or only the schema?
13. For multi-turn AI flows, are conversations evaluated, not just single turns?
14. For each AI call site, is there a documented "what counts as wrong" definition? Without it, evals are subjective.
15. What's the worst recent production failure mode, and is it now in the eval set as a regression case?

## Output schema

### Markdown report

```markdown
# L11 — AI Accuracy & Calibration — {YYYY-MM-DD}

## AI call site inventory
| # | Call site | Model | Input shape | Output shape | User-visible? | Eval coverage |
|---|---|---|---|---|---|---|
| 1 | src/ai/route.ts:42 | claude-sonnet-4-6 | task text | JSON {route, confidence} | downstream | Covered (5 cases) |

## Eval suite status
- **Golden set size:** N cases
- **Last update:** YYYY-MM-DD
- **Production failures added since last update:** X
- **Pass rate on last full run:** Y%
- **In CI?** Yes / No
- **Pass-threshold gate?** Yes (≥Z%) / No

## TruLens RAG Triad (if RAG)
| Sample | Context relevance | Groundedness | Answer relevance |
|---|---|---|---|
| 1 | 0.87 | 0.92 | 0.81 |
| ... | | | |
| **p50** | 0.85 | 0.90 | 0.78 |
| **p10 (worst)** | 0.42 | 0.61 | 0.39 |

## Calibration (ECE)
| Confidence bucket | N samples | Observed accuracy | Calibration gap |
|---|---|---|---|
| High (>0.8) | 100 | 0.72 | -0.08 (over-confident) |
| Medium (0.5-0.8) | 80 | 0.65 | +0.00 (well-calibrated) |
| Low (<0.5) | 50 | 0.20 | -0.30 (over-confident) |
| **ECE total** | | | 0.12 |

## Hallucination rate baseline (factual outputs)
| Task type | N samples checked | Hallucination rate | Ground truth source |
|---|---|---|---|
| Extraction | 30 | 6.7% | manual labels |
| RAG QA | 25 | 12% | source docs |

## Judge calibration (if LLM-as-judge used)
| Judge prompt | N human ratings | Agreement rate | Adequate? |
|---|---|---|---|
| factuality | 50 | 0.82 | Yes (>0.75 threshold) |

## Top 3 highest-leverage findings
1. ...

## Findings
{Full numbered list, severity-tagged, JSON-mirrored.}

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L11",
  "lens_name": "AI Accuracy & Calibration",
  "run_date": "YYYY-MM-DD",
  "project": "{project name}",
  "schema_version": "1.0",
  "ai_call_sites_found": 0,
  "eval_coverage": {
    "covered": 0,
    "thin": 0,
    "untested": 0
  },
  "golden_set": {
    "size": 0,
    "last_update": "YYYY-MM-DD",
    "in_ci": true,
    "pass_threshold_gate": true,
    "current_pass_rate": 0.0
  },
  "rag_triad": {
    "context_relevance_p50": null,
    "groundedness_p50": null,
    "answer_relevance_p50": null
  },
  "calibration": {
    "ece": null,
    "buckets": []
  },
  "hallucination_rates": [],
  "judge_calibration": [],
  "findings": [
    {
      "id": "L11-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "untested_call_site|stale_golden_set|no_ci_gate|miscalibration|hallucination_above_threshold|judge_uncalibrated|no_regression_loop|missing_triad_dimension|no_ground_truth",
      "title": "{short}",
      "call_site": "{path:line}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence; cite framework/tool to orchestrate}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — An AI call site with user-visible factual output and NO evals. The product is shipping AI claims with no measurement of correctness. Also: ECE >0.15 on user-trusted confidence labels (the model is systematically over-confident or under-confident enough that users / downstream code are making wrong decisions based on it). Also: hallucination rate >15% on user-facing factual outputs.
- **Major** — Eval coverage is "thin" (1-2 cases) on a high-frequency call site. OR evals exist but are not in CI (drift risk). OR LLM-as-judge is used without judge-vs-human calibration check. OR RAG product missing 1+ of the TruLens triad dimensions.
- **Minor** — Eval set hasn't been updated in >90 days despite production failures occurring. OR no regression-loop documented (production failures don't become eval cases). OR golden set lacks edge cases (only happy-path).
- **Cosmetic** — Eval pass-threshold gate missing but evals run on PR (just no enforcement). OR eval naming inconsistent.

## Anti-patterns / Bias instructions

- **Do NOT score eval *absence* as Cosmetic.** If a user-visible AI call site has no evals, that's Critical. The DLL spec audit found wrong-mechanism implementations (regex instead of NLP) that would have been caught by eval; calling it Cosmetic understates the risk.
- **Do NOT fabricate eval results.** If you don't have access to run evals (no API key, no eval framework installed), say so explicitly as a stop condition. Do not estimate pass rates from "reading the prompt looks good."
- **Do NOT recommend "build a custom eval framework."** D-003 — orchestrate, don't reinvent. Cite promptfoo / TruLens / RAGAS / Phoenix / LangSmith as the framework to adopt. Custom eval frameworks are almost always a bad call for non-research products.
- **Do NOT conflate eval pass rate with accuracy.** A 90% pass rate on a 10-case eval is noisier than it sounds — confidence intervals on small samples are wide. Recommend N ≥ 30 per task type before reporting accuracy with confidence.
- **Do NOT skip the calibration check** just because the model doesn't explicitly emit a confidence score. Implicit confidence (use of hedging language like "I think," "likely," "definitely") is also calibratable — and matters for downstream UX even if no numeric value exists.
- **Bias toward "show your work."** Eval result tables should cite the model version, eval framework, golden set version, and date. Stale eval reports are worse than no eval reports — they create false confidence.

## Stop conditions (the gap IS the finding)

1. **No AI in this product.** L11 doesn't apply. Skip and note.
2. **AI exists but no evals at all.** That's THE finding. Write: *"L11 surfaces zero eval coverage on {N} AI call sites. Critical gap — accuracy cannot be measured, regressions cannot be caught, model changes are operating blind. Recommend writing minimum-viable eval set (10-20 cases per call site) via promptfoo before any further AI changes."* Do not invent eval results.
3. **Evals exist but cannot be run in this session.** (No API keys, no runtime, no test environment.) Report what's documented in the eval files + flag that live evaluation could not be performed. Recommend re-running L11 in an environment that can execute the evals.
4. **No ground truth for hallucination measurement.** Document the ground-truth gap as itself a finding. Recommend creating a minimum-viable ground-truth set (30 samples with verified correct answers) before further factual-output features.

## Cross-lens handoff

- **Upstream (lenses that should run BEFORE L11):**
  - **L02 Spec Fidelity** — provides the Behavioral Core's behavioral claims that evals should test.
  - **L01 Hygiene & Liveness** — confirms AI call sites are actually wired and reachable (not dead).
- **Downstream (lenses that USE L11's output):**
  - **L12 AI Right-Sizing & Model Fit** — accuracy data feeds the "is this the right model?" question. A model getting 95% with smaller-cheaper is over-spec'd; one getting 60% is under-spec'd.
  - **L13 AI Interaction (HAX) & Safety** — calibration data feeds how the UI should communicate AI confidence to users.
  - **L14 AI Cost & Latency Efficiency** — accuracy/cost tradeoffs need both signals.
  - **L16 Effectiveness & Quality Drivers** — eval pass rate is one input to product effectiveness.
- **Adjacent lenses with intentional ~15% overlap:**
  - **L02 Spec Fidelity** — both check whether AI behaviors match spec, but L02 reads code, L11 runs evals. Different artifacts, same question. Aggregation dedups.
