---
id: L12
name: AI Right-Sizing & Model Fit
band: 3
band_name: AI Behavior
when_to_run: AI products only. Mandatory before launch and after any model-pricing or model-capability change.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L11 (Accuracy & Calibration) report if available
output_markdown: audit-artifacts/L12-ai-right-sizing-model-fit-{YYYY-MM-DD}.md
output_json: audit-artifacts/L12-ai-right-sizing-model-fit-{YYYY-MM-DD}.json
source_frameworks:
  - "AI vs deterministic" decision frameworks (Monterail, Augment Code)
  - Model cascading & routing (IBM Research, arXiv 2410.10347, RouteLLM)
  - LiteLLM / OpenRouter gateway patterns
  - Anthropic model tiering (Haiku / Sonnet / Opus)
  - Bob's D-003 "Orchestrate, don't reinvent"
---

# L12 — AI Right-Sizing & Model Fit

## Question this lens answers

*For every place AI is used in this product — should it BE AI (vs deterministic code)? AND is it the right model / vendor / configuration for the task?* The lens is bidirectional: it looks for AI where deterministic code would be better, AND for deterministic code where AI would unlock significant value.

## Why this lens exists / what other lenses miss

The default failure mode in AI products is **over-AI-fication** — using LLMs for tasks where regex / lookup tables / state machines would be faster, cheaper, more reliable, and compliance-defensible. The complementary failure is **under-AI-fication** — products that hand-code rules a model could learn from data. Both leak value. Neither is caught by L11 (accuracy) or L14 (cost) alone.

Within "yes, AI is right here," the second layer: which model? An Opus-grade task running on Haiku will fail accuracy; a Haiku-grade task running on Opus burns money. Vendor lock-in compounds the cost: if the primary vendor doubles prices, can you swap in <1 day or does it take 6 weeks?

The DLL audit found a concrete instance: language detection used regex script-ratio (deterministic) instead of spec'd NLP confidence (AI). The spec was right; the implementation was under-AI-fied for the task. This lens names that pattern.

Per D-003: L12 recommends orchestrating LiteLLM / OpenRouter / similar gateways. Bob does not recommend custom router builds.

## When this lens fires

**Always-in-Full-Enchilada for AI products.** Curated panel inclusion criteria:
- ✅ Always — for any product with AI in the architecture.
- ✅ Mandatory — before launch, after any model deprecation announcement, after major vendor pricing change, quarterly for cost drift.
- ⏸ Skip — non-AI products.

## Session setup

- Start a **fresh Claude Code session.**
- Read L11 (Accuracy & Calibration) — accuracy data per call site feeds the right-sizing decision.
- Read L02 (Spec Fidelity) — Behavioral Core claims define the AI's intended role.
- Inputs to load:
  - Every AI call site in the codebase
  - `architecture-contract.md` AI sections (model choice, vendor choice, fallback)
  - Cost/usage data per call site (if available)
  - Any deterministic-vs-AI decision logged in `decision-log.md` or `tool-decisions.md`

## Source frameworks

- **AI vs deterministic decision frameworks** — Monterail https://www.monterail.com/blog/when-to-use-ai-vs-traditional-software-in-business + Augment Code https://www.augmentcode.com/learn/deterministic-vs-non-deterministic-ai-key-differences-for-enterprise-development. Heuristics: if courtroom-defensible / compliance-mandated → deterministic; if ambiguous natural-language → AI; if both apply → hybrid (AI proposes, deterministic enforces).
- **Model cascading & routing** — IBM Research https://research.ibm.com/blog/LLM-routers + arXiv 2410.10347 cascade routing achieves 45-85% cost reduction at 95% quality retention.
- **LiteLLM** — gateway abstraction across providers (Anthropic, OpenAI, Bedrock, etc.). https://github.com/BerriAI/litellm
- **OpenRouter** — managed routing layer with automatic fallback. https://openrouter.ai
- **Anthropic model tiering** — Haiku (small, fast, cheap, simple tasks) / Sonnet (balanced) / Opus (complex reasoning, expensive).
- **Bob D-003** — orchestrate gateway tooling, do not implement custom routing.

## Audit method

1. **Inventory every AI call site.** Same inventory as L11. For each: model name, model size class, vendor, what input, what output, downstream use.

2. **For each call site, run the "should this be AI?" test:**
   - Could this be done with regex / lookup / rules / state machine? If yes, what's the accuracy/maintainability tradeoff?
   - Is the input bounded (a known set of cases) or open-ended (natural language, novel data)?
   - Is the output's correctness verifiable deterministically?
   - Does the task require reasoning over context that varies, or pattern-matching over a stable structure?
   - Verdict per call site: **AI-appropriate** / **Deterministic-would-be-better** / **Hybrid recommended**.

3. **For deterministic-could-replace findings, propose the deterministic alternative.** Concrete: which library, which pattern, what's the expected accuracy delta, what's the cost saving.

4. **Reverse scan — where could AI add value that's currently hand-coded?** Look for hand-rolled NLP, hand-rolled summarization, hand-rolled extraction, hand-rolled classification. For each, propose AI-augmentation with effort estimate.

5. **Model-fit audit per AI call site.**
   - **Capability fit** — is the chosen model strong enough? Use L11 accuracy data. If accuracy <80%, the model may be under-spec'd; if accuracy >97%, the model may be over-spec'd.
   - **Cost fit** — for each call site, is the cost per call appropriate to the value generated? (Critical for high-volume call sites.)
   - **Latency fit** — does the chosen model's latency meet UX requirements? (UI calls should be Sonnet-fast or streamed; batch calls can be slow.)
   - **Reasoning fit** — does the task need extended thinking, tool use, multi-turn? Pick the model that fits the shape.

6. **Vendor lock-in audit.**
   - Is there a gateway abstraction (LiteLLM, OpenRouter, custom adapter)?
   - Or are model strings hardcoded in N+ places?
   - If primary vendor doubled prices, how many code changes to swap to fallback?
   - Is there a documented fallback chain for rate-limits / outages?
   - For Anthropic-specific features used (caching, extended thinking, computer use), is the fallback documented if model unavailable?

7. **Model-tiering audit.**
   - For each call site, is the model size justified in writing? (Why Opus and not Sonnet? Why Sonnet and not Haiku?)
   - Could ≥30% of calls be downgraded to a cheaper model with negligible quality loss (per L11 accuracy data)?
   - Is there a router/cascade pattern (try small model, escalate on low confidence)?

8. **Structured-output audit.** For each call site that returns structured data (JSON, tool calls), is it using native structured output (JSON mode / tool use) or free-text + parsing? Free-text + parsing is brittle and should be flagged.

## Check questions

1. For each AI call site, was a deterministic alternative explicitly considered and rejected with reason?
2. Is the model choice per call site justified in writing (why Opus not Haiku)?
3. Is there a fallback chain if the primary model is rate-limited or down?
4. Could ≥30% of calls be downgraded to a cheaper model with negligible quality loss per L11 data?
5. Is there a router/gateway abstraction (LiteLLM, OpenRouter, custom), or are model strings hardcoded in 10+ places?
6. If your primary vendor doubled prices tomorrow, how many code changes to swap providers?
7. For each task, do you measure quality-per-dollar (not just quality)?
8. Is there an "escalation" path — small model first, escalate to large only on low confidence?
9. For structured output, are you using JSON mode / tool use instead of free-text + parsing?
10. Are there deterministic-could-replace cases where AI is currently used? (Bidirectional bias check.)
11. Are there hand-coded patterns where AI could add significant value? (Reverse scan.)
12. For Anthropic-specific features used (caching, extended thinking), is fallback documented?
13. Are vendor-specific tool-use schemas portable across providers?
14. Are model versions pinned or floating? (Floating = silent capability drift.)
15. Is there a documented model-deprecation response plan?

## Output schema

### Markdown report

```markdown
# L12 — AI Right-Sizing & Model Fit — {YYYY-MM-DD}

## AI call site inventory + verdicts
| # | Call site | Model | Should-it-be-AI? | Right model? | Cost fit | Latency fit | Verdict |
|---|---|---|---|---|---|---|---|

## Deterministic-could-replace findings
| Call site | Current AI use | Deterministic alternative | Accuracy delta | Cost saving |
|---|---|---|---|---|

## Under-AI-fication findings (reverse scan)
| Hand-coded surface | AI augmentation proposal | Effort | Value unlock |
|---|---|---|---|

## Model-fit gaps
| Call site | Current model | Should be | Why |
|---|---|---|---|

## Vendor lock-in posture
- Gateway abstraction: yes/no — {name}
- Model strings hardcoded in: X places
- Swap effort if vendor lost: X dev-days
- Fallback chain: documented/not

## Tiering opportunities
| Call site | Current | Downgrade candidate? | L11 accuracy at smaller model | Expected savings |
|---|---|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L12",
  "lens_name": "AI Right-Sizing & Model Fit",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "call_sites_analyzed": 0,
  "should_be_deterministic_count": 0,
  "should_be_ai_count": 0,
  "model_overspecced_count": 0,
  "model_underspecced_count": 0,
  "gateway_abstraction_present": false,
  "swap_effort_dev_days": null,
  "fallback_chain_documented": false,
  "findings": [
    {
      "id": "L12-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "should_be_deterministic|should_be_ai|model_overspecced|model_underspecced|no_gateway|vendor_lock_in|no_fallback_chain|free_text_instead_of_structured|cascade_opportunity|floating_model_version|missing_justification",
      "title": "{short}",
      "call_site": "{path:line}",
      "current": "{model/approach}",
      "proposed": "{model/approach}",
      "rationale": "{1-paragraph}",
      "estimated_impact": "{cost/quality/latency delta}",
      "effort_estimate": "low|medium|high"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Vendor lock-in with no gateway: if primary vendor outages, product breaks. AI used where deterministic is mandated (compliance/audit context).
- **Major** — Model significantly over- or under-spec'd on high-volume call site. Free-text parsing where JSON mode would work. No documented fallback chain.
- **Minor** — Tiering opportunity (could downgrade with minor quality cost). Model version floating.
- **Cosmetic** — Documentation gaps in model-choice rationale.

## Anti-patterns / Bias instructions

- **Do NOT recommend "use the latest model."** Recommendations must cite L11 accuracy / cost data for the specific task. "Latest" is not a fit criterion.
- **Do NOT recommend "build a custom routing layer."** D-003. LiteLLM / OpenRouter exist; orchestrate.
- **Do NOT mark "no findings" without doing the reverse scan.** Both directions matter.
- **Do NOT confuse vendor abstraction with vendor independence.** A gateway lets you swap; it doesn't mean the swap is free. Anthropic-specific features (extended thinking, computer use, prompt caching) may not have OpenAI equivalents.
- **Bias toward "what changes if vendor X disappears next week?"** Resilience to vendor change is structural.

## Stop conditions

1. **Not an AI product.** Skip.
2. **L11 has not run.** Right-sizing decisions need accuracy data. Recommend L11 first.

## Cross-lens handoff

- **Upstream:** L11 Accuracy (per-call-site accuracy).
- **Downstream:** L14 Cost & Latency (right-sized models inform cost optimization).
- **Adjacent (~15% overlap):**
  - **L22 Vendor & Dependency Risk** — vendor lock-in overlaps; L12 is AI-specific, L22 is whole-stack.
