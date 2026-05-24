---
id: L15
name: Cost & Speed Drivers
band: 4
band_name: Performance Economics
when_to_run: Products with meaningful cost (infra > $100/mo) OR user-facing latency requirements. Skip pure prototype / pre-revenue / no-users state.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L14 (AI Cost/Latency) report if available
output_markdown: audit-artifacts/L15-cost-speed-drivers-{YYYY-MM-DD}.md
output_json: audit-artifacts/L15-cost-speed-drivers-{YYYY-MM-DD}.json
source_frameworks:
  - FinOps Foundation framework — https://www.finops.org/framework/
  - Vercel observability + APM patterns
  - Datadog APM dimensions
  - Core Web Vitals (LCP, CLS, INP) — Google
  - SRE four golden signals (latency, traffic, errors, saturation)
  - Tradeoff-inversion thinking (Joe Wang, 2026-05-23)
---

# L15 — Cost & Speed Drivers

## Question this lens answers

*What's driving cost and latency in this product — across infrastructure, third-party services, AI calls, databases, network, frontend rendering — AND where would we DELIBERATELY pay more cost or accept more latency to get more effectiveness?*

The lens is bidirectional. Standard cost audits ask "where can we save?" This lens also asks the **tradeoff-inversion** question: where is the product cheap/fast in ways that limit value, and where would adding cost or latency be the right call? Example: a +500ms wait for a deeper AI response may convert better than the snappy generic one. A +$0.10/month per user on better infra may unlock a 5x reduction in support load.

## Why this lens exists / what other lenses miss

L14 covers AI cost/latency specifically. L15 covers the whole product — infra, DB, network, third-party APIs, frontend rendering, build pipeline. And L15 adds the inversion lens that standard cost-audits universally miss. Most teams optimize cost / latency until they hit "good enough"; few teams ask "where should we deliberately spend more for more value?" This lens forces that question.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ For products with meaningful cost (>$100/mo infra) or user-facing latency requirements.
- ✅ Mandatory — before scale-up phase, before fundraising (unit economics scrutiny), after major architecture change.
- ⏸ Skip — pure prototype with no users / no revenue / no cost.

## Session setup

- Start a **fresh Claude Code session.**
- Read L14 (AI Cost/Latency) report — feeds the AI-portion of L15.
- Inputs:
  - Infrastructure bills (last 3 months) — Vercel, AWS, GCP, Cloudflare, etc.
  - Third-party SaaS bills — Stripe, Twilio, Postmark, Resend, Auth0, etc.
  - APM data — p50/p95/p99 latency per endpoint
  - Lighthouse / Core Web Vitals data for web products
  - Database query logs — slow query log
  - Cost guardrail from `architecture-contract.md` (v2.2)

## Source frameworks

- **FinOps Foundation framework** — Inform, Optimize, Operate phases. https://www.finops.org/framework/
- **SRE four golden signals** — latency, traffic, errors, saturation.
- **Core Web Vitals** — LCP (<2.5s good), CLS (<0.1), INP (<200ms). https://web.dev/vitals
- **APM dimensions (Datadog, NewRelic, Vercel Speed Insights)** — span-level latency attribution.
- **Tradeoff-inversion thinking** — explicit operator framing (Joe Wang, 2026-05-23) — for every cost/speed optimization, ask the inverse: *where would we pay more?*

## Audit method

1. **Cost breakdown by category.** Last 30 days of spend, broken by:
   - Compute / hosting (Vercel, AWS Lambda, EC2, etc.)
   - Database (Postgres, Redis, vector store)
   - AI / LLM calls
   - Third-party SaaS (auth, email, SMS, payments, analytics)
   - Bandwidth / storage / egress
   - Build / CI
   - Observability (logs, traces, monitoring)
   - Domains / DNS
   For each: $/month, $/user (if known), % of total spend, growth rate vs prior 30 days.

2. **Latency breakdown by hot path.** Pick the top 3 user-facing flows (from Build Manifest). For each:
   - p50, p95, p99 per step
   - Where the bulk of latency comes from (DB query? AI call? Network? Render?)
   - Server vs client time
   - For web: Core Web Vitals on top pages

3. **Identify cost drivers (the 80/20).** What's the top 1-3 line items by $? Often surprising — for AI products, often AI > infra. For consumer products, often bandwidth / CDN. For B2B, often auth or analytics.

4. **Identify speed drivers (the 80/20).** For each hot path, what's the slowest 1-3 steps? Database query? AI call? Third-party API? Frontend hydration?

5. **Standard optimization opportunities.** For each driver:
   - Cost: caching, batching, rightsizing, downgrading, switching providers
   - Speed: caching, parallelization, async-ifying, edge-deploying, removing
   For each, estimate $/month saved or ms saved.

6. **Tradeoff-inversion pass (the distinctive section).** For each major area, ask:
   - **Cost**: where would PAYING MORE unlock disproportionate value?
     - Better infra (faster servers, more concurrency) → better user experience → higher conversion?
     - Better-tier AI model → higher accuracy → less support load?
     - Better observability → faster incident response → less downtime cost?
     - Better email delivery (premium ESP) → higher inbox placement → more activation?
   - **Speed**: where would ADDING LATENCY produce better outcomes?
     - Wait an extra 500ms for a deeper, more personalized AI response (vs snappy generic)?
     - Allow longer page load for richer content (vs lean shell + skeleton)?
     - Slower checkout with "double-check your address" step (vs instant)?
     - Slower AI response with visible reasoning steps (vs single-shot, opaque)?

   For each inversion candidate, propose: where, what change, expected effectiveness lift, cost/latency cost.

7. **Cost guardrail compliance.** Does Architecture Contract define a per-user / per-request cost budget? Is it currently met? Where's the largest variance?

## Check questions

1. Has spend been broken down by category for the last 30 days?
2. What are the top 3 cost line items? Top 3 latency drivers per hot path?
3. For each cost driver, what's the standard optimization (caching, batching, rightsizing)?
4. For each speed driver, what's the standard optimization (parallelize, async, edge, remove)?
5. **Inversion**: where would PAYING MORE produce more effectiveness? (At least 3 candidates.)
6. **Inversion**: where would ADDING LATENCY produce better outcomes? (At least 3 candidates.)
7. Is there a cost guardrail in `architecture-contract.md`? Is it currently met?
8. Are p50/p95/p99 latencies tracked per endpoint, with regression alerts?
9. Are Core Web Vitals (LCP, CLS, INP) measured in production for web products?
10. Is there a cost spike alarm (>2x normal in 1 hour)?
11. Are unit economics calculated ($/user/month)? Trending direction?
12. Are there cost-allocation tags so spend can be attributed to features?
13. Are any expensive features serving <5% of users? (Pareto unfairness — small minority driving large cost.)
14. Is there a "billing in degraded mode" plan (e.g., downgrade to cheaper provider if cost spikes)?
15. Has a recent "what if we paid more here" thought experiment been done?

## Output schema

### Markdown report

```markdown
# L15 — Cost & Speed Drivers — {YYYY-MM-DD}

## Cost breakdown by category (last 30 days)
| Category | $/month | % of total | $/user (if known) | Growth vs prior month |
|---|---|---|---|---|
| AI / LLM | $1,200 | 35% | $0.40 | +12% |
| Database | $400 | 12% | $0.13 | +3% |
| ... |

## Latency breakdown by hot path
| Hot path | Step | p50 | p95 | p99 | Driver |
|---|---|---|---|---|---|

## Top cost drivers
1. ...

## Top latency drivers
1. ...

## Standard optimization opportunities
| Driver | Optimization | $/month saved | ms saved | Effort |
|---|---|---|---|---|

## Tradeoff-inversion candidates (PAY MORE / WAIT LONGER for effectiveness)
| Where | Current state | Proposed inversion | Effectiveness lift | Cost / latency cost |
|---|---|---|---|---|
| AI accuracy | Sonnet @ $0.01/call | Opus @ $0.05/call | +12% accuracy → -30% support load | +$0.04/call but breakeven at... |
| Checkout flow | Instant submit | 1.5s "verify address" interstitial | -X% wrong-address shipments | +1.5s latency |

## Cost guardrail compliance
- Defined: yes/no
- Current usage: ${X}/{Y} budget
- Variance: {amount}

## Unit economics
- $/user/month: $X
- Trending: up/flat/down
- Sustainability: positive / break-even / negative

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L15",
  "lens_name": "Cost & Speed Drivers",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "monthly_spend_usd": 0,
  "cost_categories": {},
  "top_cost_drivers": [],
  "top_latency_drivers": [],
  "standard_optimizations": [],
  "tradeoff_inversion_candidates": [],
  "cost_guardrail_defined": false,
  "cost_guardrail_met": null,
  "dollars_per_user_per_month": null,
  "findings": [
    {
      "id": "L15-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "high_cost_no_caching|high_cost_oversized|high_latency_db|high_latency_serial|no_cost_guardrail|no_cost_alarm|unit_economics_negative|inversion_opportunity_accuracy|inversion_opportunity_latency_for_quality|inversion_opportunity_better_infra|pareto_unfair|stale_cost_tracking",
      "direction": "save|invest",
      "title": "{short}",
      "estimated_monthly_impact_usd": 0,
      "estimated_effectiveness_impact": "{e.g., +15% conversion}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Unit economics negative and trending worse. Cost spike with no alarm. Single line item is >40% of total spend with optimization available.
- **Major** — Top-3 cost driver with clear 30%+ optimization unsigned. Hot path p95 >5s with clear cause. Unit economics break-even but flat (no margin runway).
- **Minor** — Cost driver in top-10 with optimization opportunity. Latency improvement opportunity <500ms.
- **Cosmetic** — Documentation / dashboarding gaps.
- **Inversion-direction findings** (separate category) — opportunities to invest more in cost/latency for effectiveness; rate by expected effectiveness lift vs investment.

## Anti-patterns / Bias instructions

- **Do NOT only look for cost cuts.** The inversion pass is mandatory. Reports without inversion candidates are incomplete.
- **Do NOT recommend a cost cut without modeling the effectiveness impact.** A cheaper provider that hurts reliability is a false saving.
- **Do NOT optimize for cost when the team is pre-product-market-fit.** Early products should pay more for speed of iteration; cost optimization belongs after PMF.
- **Bias toward "what's the ROI of each $ saved or spent?"** Not just "what's the cheapest option."

## Stop conditions

1. **No cost/billing data available.** Document gap; recommend instrumentation.
2. **No APM / latency tracking.** Document gap; recommend instrumentation.

## Cross-lens handoff

- **Upstream:** L14 AI Cost & Latency (AI-specific deep dive).
- **Downstream:** L16 Effectiveness (the inversion candidates need effectiveness-impact measurement).
- **Adjacent (~15% overlap):**
  - **L14** — same skill, AI-only scope.
  - **L21 Observability** — cost dashboarding and APM overlap with observability.
  - **L25 Pricing** — cost economics feeds pricing strategy.
