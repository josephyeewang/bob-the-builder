---
id: L14
name: AI Cost & Latency Efficiency
band: 3
band_name: AI Behavior
when_to_run: AI products only, especially those with >$100/mo AI spend or user-facing latency requirements
estimated_duration: 60-120 min
session_pattern: fresh session; reads L11, L12 reports if available
output_markdown: audit-artifacts/L14-ai-cost-latency-efficiency-{YYYY-MM-DD}.md
output_json: audit-artifacts/L14-ai-cost-latency-efficiency-{YYYY-MM-DD}.json
source_frameworks:
  - Anthropic prompt caching — https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  - Model cascading & routing (IBM Research, arXiv 2410.10347)
  - Anthropic message batches API — 50% discount
  - PremAI 8-strategy cost optimization guide
  - Bob's existing cost guardrail check (v2.2)
---

# L14 — AI Cost & Latency Efficiency

## Question this lens answers

*Per AI call site: is the cost-per-call and time-to-output reasonable for the value delivered? Where are tokens / latency / dollars being wasted?*

## Why this lens exists / what other lenses miss

L11 measures accuracy. L12 measures fit (right model for the task). L14 measures *efficiency* — for the AI we have, are we using it well? Common waste patterns: prompts that bloat 3x larger than needed; no caching (90% cost-savings opportunity per Anthropic docs); no batching for non-interactive calls (50% discount via batch API); free-text parsing when JSON mode would work; long context-windows padded with retrieved content that doesn't help.

Per Anthropic + industry data: enabling prompt caching alone typically cuts cost 50-90% and reduces latency 50-85% on systems with stable system prompts. That's the single biggest lever.

## When this lens fires

**Always-in-Full-Enchilada for AI products.** Curated panel inclusion criteria:
- ✅ Always — any AI product.
- ✅ Mandatory — when AI spend >$100/month or expected user-facing latency requirements.
- ⏸ Skip — non-AI products.

## Session setup

- Start a **fresh Claude Code session.**
- Read L11 (Accuracy) and L12 (Right-Sizing).
- Inputs to load:
  - Every AI call site
  - Anthropic / OpenAI usage dashboards if available (per-endpoint cost, token counts, latency p50/p95/p99)
  - Production logs for representative prompts
  - System prompt text per call site
  - Cost guardrail definition from `architecture-contract.md` (v2.2 mandate)

## Source frameworks

- **Anthropic prompt caching** — up to 90% cost / 85% latency reduction on repeated prefixes; 1024+ token minimum on Sonnet/Opus, 2048+ on Haiku; 5-min TTL default. https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- **Model cascading** — 45-85% cost savings (IBM Research, arXiv 2410.10347).
- **Anthropic message batches API** — 50% discount for async batch processing.
- **PremAI 8 strategies** — caching, routing, batching, streaming, context pruning, distillation, fine-tuning small models, semantic caching.
- **Bob v2.2 cost guardrail check** — already in protocol per `build-protocol-core.md` §VERIFICATION.

## Audit method

1. **Per-call-site cost inventory.** For each AI call site, capture: average input tokens, average output tokens, model, cost per call (compute from tokens × pricing), calls per day/week, total monthly cost.

2. **Prompt caching audit.**
   - Is prompt caching enabled in client config (`cache_control: {"type": "ephemeral"}` for Anthropic)?
   - Is the static system prompt FIRST in the message array (cacheable prefix)? Or after dynamic content (uncacheable)?
   - Is the cached prefix ≥1024 tokens (Sonnet/Opus) or ≥2048 (Haiku)?
   - What's the measured cache hit rate? (Should be >50% for a system that benefits.)
   - Is the cache TTL (5-min default) appropriate for usage patterns?

3. **Token bloat audit.** For each call site:
   - Take the system prompt; try removing 30% of it (verbose framing, redundant examples, restated rules). Re-run evals (L11's harness). Did quality drop?
   - If quality held, bloat exists. Document the prunable section.

4. **Batching audit.** For non-interactive calls (background jobs, batch processing, scheduled tasks):
   - Are they using the batch API (50% off)?
   - If not — what's the latency requirement? Could they switch?

5. **Streaming audit.** For user-facing calls:
   - Is streaming enabled where time-to-first-token (TTFT) matters?
   - Measured TTFT vs full-response latency?

6. **Cascade audit.** For each call site:
   - Could a cheaper model handle a fraction of cases (small-first, escalate-on-low-confidence)?
   - Implementation status of cascade routing?

7. **Context window audit.** For RAG calls:
   - How many retrieved chunks per query? How many actually contribute to the output?
   - Try dropping the bottom-K chunks; re-run evals. If quality holds, those chunks are pure cost.

8. **Latency budgets per call site.**
   - p50 / p95 / p99 latency.
   - User-facing budget per call (what's tolerable?).
   - Gap analysis.

9. **Circuit breaker check.** Is there a kill switch / cost-per-minute alarm if usage spikes (LLM10 protection + cost runaway)?

## Check questions

1. Is prompt caching enabled, and what's the measured hit rate per endpoint? (target >50%)
2. Is the static system prompt the FIRST block in every call (not after dynamic content)?
3. Are prompts ≥1024 tokens for cache eligibility, or are tiny prompts left uncached?
4. Are non-interactive calls batching via batch API (50% off)?
5. Is streaming enabled for any UI where time-to-first-token matters?
6. Have you measured p50/p95/p99 latency per endpoint, with regression alerts?
7. Is there per-prompt token-bloat audit (have you tried removing 30% and measured quality)?
8. Is semantic caching in place for repeat/similar queries (downstream layer)?
9. Is context window padded with retrieved chunks that don't improve output?
10. Do you have $/request, $/user/day dashboards, and alerts on cost spikes?
11. Is there a kill switch / circuit breaker if cost-per-minute exceeds threshold?
12. For agents with >3 steps, is prompt caching mandatory?
13. Are model versions pinned (price control) or floating (price drift risk)?
14. Are tool-call schemas as compact as possible (verbose schemas = wasted tokens per call)?
15. Is there a "downgrade to cheaper model" toggle for cost-spike scenarios?

## Output schema

### Markdown report

```markdown
# L14 — AI Cost & Latency Efficiency — {YYYY-MM-DD}

## Per-call-site cost + latency
| Call site | Model | Avg in tokens | Avg out tokens | $/call | calls/day | $/month | p50 latency | p95 latency |
|---|---|---|---|---|---|---|---|---|

## Caching status
| Call site | Cache enabled | Cached prefix tokens | Hit rate | Cost saved $/mo |
|---|---|---|---|---|

## Token bloat findings
| Call site | Current prompt tokens | Tested-prunable tokens | Quality delta | $/mo savings |
|---|---|---|---|---|

## Batching opportunities
| Call site | Latency requirement | Batch-eligible? | $/mo savings |
|---|---|---|---|

## Streaming status (user-facing)
| Call site | Streaming enabled | TTFT | User-perceived improvement |
|---|---|---|---|

## Cascade opportunities
| Call site | Current | Small-first model | Cascade savings est. |
|---|---|---|---|

## Context window audit (RAG only)
| Call site | Chunks/query | Bottom-K prunable? | $/mo savings |
|---|---|---|---|

## Circuit breaker / cost controls
- Per-user cap: ${X}/day
- Per-session cap: {Y} tokens
- Cost-per-minute alarm: yes/no @ ${Z}
- Kill switch: yes/no

## Top 3 highest-leverage findings (cost or latency)
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L14",
  "lens_name": "AI Cost & Latency Efficiency",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "call_sites_analyzed": 0,
  "total_monthly_cost_usd": 0,
  "caching": {
    "sites_with_caching": 0,
    "sites_without_caching": 0,
    "measured_hit_rate_p50": 0.0,
    "estimated_savings_unlocked": 0
  },
  "token_bloat_savings_usd_per_month": 0,
  "batching_eligible_unmigrated": 0,
  "streaming_eligible_unmigrated": 0,
  "cascade_opportunities": 0,
  "circuit_breaker_present": false,
  "findings": [
    {
      "id": "L14-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "caching_not_enabled|caching_misordered|token_bloat|no_batching|no_streaming|no_cascade|context_padding|no_circuit_breaker|no_cost_alarm|verbose_tool_schema|floating_model_version|high_p95_latency",
      "title": "{short}",
      "call_site": "{path:line}",
      "current_cost_per_month": 0,
      "estimated_savings": 0,
      "estimated_latency_improvement_ms": null,
      "effort_estimate": "low|medium|high",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — No circuit breaker on cost (vulnerable to runaway). Caching not enabled on a system with >$1k/mo spend and stable system prompts (typically 50-90% wasted).
- **Major** — Cache hit rate <30% despite cacheable structure. Non-interactive calls running synchronously instead of batch. Token bloat >30% identified.
- **Minor** — Streaming missing where TTFT matters. Cascade opportunity unmigrated. Context-window padding.
- **Cosmetic** — Documentation gaps in cost dashboards.

## Anti-patterns / Bias instructions

- **Do NOT optimize for cost at the expense of accuracy.** Every cost recommendation must be paired with an accuracy check (re-run L11 evals).
- **Do NOT recommend caching without verifying prompt structure.** Caching requires the static prefix to be FIRST in the message array. Caching enabled with prefix mis-ordered = no actual savings.
- **Do NOT recommend "switch to cheaper model."** L12's job. L14's job is "use the current model better."
- **Bias toward "what's the largest dollar number on this report?"** Prioritize savings by absolute $/month, not by % savings on small line items.

## Stop conditions

1. **Not an AI product.** Skip.
2. **No cost/usage data available.** Document the gap; recommend setting up dashboards before re-running.

## Cross-lens handoff

- **Upstream:** L11 Accuracy, L12 Right-Sizing.
- **Downstream:** L15 Cost & Speed Drivers (whole-product economics layer).
- **Adjacent (~15% overlap):**
  - **L15 Cost & Speed Drivers** — L14 is AI-specific, L15 is whole-product. Same skill, different scope.
