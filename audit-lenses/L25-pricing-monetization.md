---
id: L25
name: Pricing & Monetization
band: 7
band_name: Strategic & Market
when_to_run: Products that charge users (today or planned). Mandatory before launching paid tier, after major pricing change, quarterly during growth.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L24 (Competitive) and L28 (Wedge) if available
output_markdown: audit-artifacts/L25-pricing-monetization-{YYYY-MM-DD}.md
output_json: audit-artifacts/L25-pricing-monetization-{YYYY-MM-DD}.json
source_frameworks:
  - Madhavan Ramanujam — Monetizing Innovation (4 failure modes)
  - Patrick Campbell / ProfitWell — value-metric pricing
  - Van Westendorp Price Sensitivity Meter
  - OpenView / High Alpha SaaS pricing benchmarks
  - FTC Click-to-Cancel rule (Oct 2024)
  - April Dunford positioning ↔ pricing alignment
---

# L25 — Pricing & Monetization

## Question this lens answers

*Across 4 dimensions — strategy, discoverability, competitor benchmarking, mechanics — is the pricing structure, page, and flow set up to capture value, communicate clearly, and convert?*

## Why this lens exists / what other lenses miss

Engineering audits ignore pricing. UX audits often stop at "is the pricing page well-designed." Both miss the strategic + mechanical reality: 72% of pricing innovations miss financial expectations (Ramanujam). Pricing models that don't track value (per-seat in a product that delivers value-per-task) cap revenue. Pricing pages that obscure costs torch trust. Cancel flows that violate FTC Click-to-Cancel rules (effective 2024) carry $51,744/violation/consumer fines.

The 4 sub-streams Joe called out:
1. **Strategy** — model, tiers, positioning, value metric
2. **Discoverability** — where pricing lives, clarity, no surprise costs
3. **Competitor benchmarking** — anchored or anchoring
4. **Mechanics** — pricing page UX, signup → payment → upgrade → cancel flows

## When this lens fires

**Always-in-Full-Enchilada for paid products.** Curated panel inclusion criteria:
- ✅ Mandatory — products that charge users today, before launching any paid tier, after major pricing change.
- ✅ Quarterly — during active growth (pricing rots silently; Campbell: <6mo reprice cadence → ~2x ARPU vs annual).
- ⏸ Skip — fully free products with no monetization plan.

## Session setup

- Start a **fresh Claude Code session.**
- Read L24 (Competitive Benchmarking) for pricing-comparison data, L28 (Wedge) for positioning alignment.
- Inputs:
  - Pricing page (live URL)
  - Plans / tier definition
  - Signup → payment flow (walk it as a new user)
  - Upgrade / downgrade / cancel flows (walk each)
  - Billing engine (Stripe / Paddle / custom)
  - Revenue dashboard if available (ARPU, MRR, churn)
- Tools: real test — go through signup with a real card; cancel; check the flow. (Use a test card in dev or new email.)

## Source frameworks

- **Madhavan Ramanujam — Monetizing Innovation** — 4 failure modes: Feature Shock (over-builds), Minivation (under-prices innovation), Hidden Gem (misses big value driver), Undead (launches dead at low traction). 72% of innovations land in one of these.
- **Patrick Campbell / ProfitWell** — value-metric pricing > feature-differentiated pricing (~2x growth multiplier). Reprice every <6 months for ~2x ARPU growth vs annual. Localize currency for 25-50% growth lift.
- **Van Westendorp PSM** — 4 questions (too cheap / cheap / expensive / too expensive) → PMC / PME / IPP / OPP. Indicator of acceptable range.
- **OpenView / High Alpha 2024 benchmarks** — 86% of >$100M SaaS use 3+ pricing dimensions; 61% hybrid pricing; multi-dim shows 34% better LTV/CAC.
- **FTC Click-to-Cancel** (Oct 2024) — cancellation must be as easy as signup. Same medium. No forced human contact unless signup required it. $51,744/violation.
- **April Dunford** — pricing must align with positioning. Premium positioning + value pricing; commodity positioning + low pricing.

## Audit method

1. **Strategy diagnostic (Ramanujam 4 failure modes).**
   - **Feature Shock** — does the product have features users say "I wouldn't pay extra for"?
   - **Minivation** — is innovation priced like commodity?
   - **Hidden Gem** — is there a high-value capability you're not charging for?
   - **Undead** — has the product launched and failed to gain traction at current price?
   Diagnose which one (if any) applies.

2. **Value metric audit.**
   - What's the single value metric you charge against?
   - Does it scale with the customer's perceived value, or with your cost?
   - Common value metrics: per-seat, per-event, per-result, per-API-call, per-transaction-volume, per-feature, per-storage. Pick wisely.

3. **Tier design audit.**
   - Run Patrick Campbell's 2x2: every feature classified as Key (must-have) / Add-on (premium) / Core (table-stakes) / Trash (unused).
   - How many trash features still being built?
   - Are tiers good/better/best with clear fences pushing right buyer to right tier?

4. **Willingness-to-pay (WTP) audit.**
   - Has WTP been tested? Van Westendorp PSM (4 questions × N≥30 target users)?
   - What's the IPP (indifference price point) and acceptable range?
   - If never tested, that's a finding.

5. **Discoverability audit.**
   - Does pricing appear within 1 click of homepage?
   - Are all costs visible BEFORE the credit-card form (taxes, seats, overages, add-ons)?
   - Any surprise costs surface only at checkout?
   - Currency localized for top 3 non-US markets?

6. **Competitor pricing benchmarking.**
   - Map ladder against 3 closest alternatives.
   - At each tier, what's the buyer getting more/less of, at what unit price?
   - Are you anchoring (driving market price up) or being anchored (forced to match)?

7. **Mechanics audit — signup flow.**
   - Signup → first-charge: ≤3 fields and ≤2 screens?
   - Paywall fires at a moment of demonstrated value, not before?
   - Reverse-trial / free trial / freemium — which model? Does it match activation moment?

8. **Mechanics audit — payment flow.**
   - Stripe Checkout / Elements pattern (or equivalent)?
   - Error states clearly handled (decline, 3DS, insufficient funds)?
   - Idempotency on retries?
   - Receipts sent automatically?

9. **Mechanics audit — upgrade / downgrade / cancel.**
   - Can user upgrade in <3 clicks? Downgrade?
   - **Cancel flow — FTC Click-to-Cancel compliance:** same channel as signup, same number of clicks (or fewer), no human contact required unless signup required one.
   - Refund policy clear and findable?
   - Dunning (failed-payment retry) flow exists?

10. **Free-to-paid conversion audit.**
    - Free tier has natural ceiling that creates upgrade pressure?
    - Or is free tier indefinitely parked (no conversion incentive)?

## Check questions

1. Which of Ramanujam's 4 failure modes is the largest risk for THIS product right now?
2. What's the single value metric? Does it scale with perceived value?
3. Has WTP been tested with Van Westendorp on N≥30 target users?
4. Run Campbell 2x2 — how many trash features still being built?
5. Are tiers good/better/best with clear fences?
6. Does pricing appear within 1 click of homepage, all costs visible before credit-card form?
7. Map ladder vs 3 closest alternatives — anchoring or anchored?
8. Is signup → first-charge ≤3 fields and ≤2 screens?
9. Does paywall fire at moment of demonstrated value?
10. FTC Click-to-Cancel compliance: same channel as signup, same number of clicks?
11. Does upgrade / downgrade / refund / dunning flow exist as code (not just in founder's head)?
12. Which conversion model — reverse-trial / free trial / freemium — and does it map to activation moment?
13. When did you last reprice? (<6 months = ~2x ARPU growth.)
14. Currency localized for top 3 non-US markets?
15. Does pricing align with positioning (premium = value pricing; commodity = low pricing)?

## Output schema

### Markdown report

```markdown
# L25 — Pricing & Monetization — {YYYY-MM-DD}

## Strategy diagnostic (Ramanujam 4 failure modes)
- Feature Shock risk: {assessment}
- Minivation risk: {assessment}
- Hidden Gem risk: {assessment}
- Undead risk: {assessment}
- **Primary risk:** {one}

## Value metric audit
- Current value metric: {what}
- Scales with: cost / value
- Recommendation: {if needs change}

## Tier design (Campbell 2x2)
| Feature | Key / Add-on / Core / Trash | Currently in tier |
|---|---|---|

## WTP audit
- Van Westendorp PSM run: yes/no
- N: X target users
- IPP: $X
- Acceptable range: $X - $Y

## Discoverability
| Question | Status |
|---|---|
| Pricing within 1 click of home? | yes/no |
| All costs before credit card? | yes/no |
| Currency localized? | yes/no for top 3 markets |

## Competitor pricing
| Tier | Us | Comp A | Comp B | Comp C | Anchoring |
|---|---|---|---|---|---|

## Mechanics — signup
- Fields: N
- Screens: N
- Paywall moment: {where}
- Model: reverse-trial / free trial / freemium

## Mechanics — payment
- Stripe Checkout / custom?
- Error states handled: yes/partial/no
- Idempotency on retries: yes/no
- Receipts auto-sent: yes/no

## Mechanics — upgrade / downgrade / cancel
- Upgrade clicks: N
- Downgrade clicks: N
- **Click-to-Cancel compliance**: yes/violation
- Refund policy findable: yes/no
- Dunning flow: yes/no

## Free-to-paid conversion
- Natural ceiling in free tier: yes/no
- Activation moment → paywall alignment: strong/weak

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L25",
  "lens_name": "Pricing & Monetization",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "ramanujam_primary_risk": "feature_shock|minivation|hidden_gem|undead|none",
  "value_metric_scales_with_value": null,
  "wtp_tested": false,
  "tier_count": 0,
  "trash_features_count": 0,
  "discoverability": {
    "pricing_within_1_click": false,
    "all_costs_before_card": false,
    "currency_localized": false
  },
  "mechanics": {
    "signup_fields": 0,
    "signup_screens": 0,
    "click_to_cancel_compliant": false,
    "dunning_flow_exists": false
  },
  "last_reprice_months_ago": null,
  "findings": [
    {
      "id": "L25-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "ramanujam_failure_mode|wrong_value_metric|wtp_untested|trash_features|tier_overlap|pricing_hidden|surprise_costs|currency_not_localized|signup_too_long|paywall_too_early|click_to_cancel_violation|no_refund_policy|no_dunning|free_tier_no_ceiling|pricing_positioning_mismatch|reprice_overdue",
      "title": "{short}",
      "evidence": "{specific page / flow / data}",
      "revenue_impact": "{1-sentence}",
      "legal_exposure": "low|medium|high",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Click-to-Cancel violation (legal exposure). Pricing model fundamentally wrong (wrong value metric, won't scale). No WTP testing ever done on paid product.
- **Major** — Surprise costs after credit-card. Tier overlap (middle tier dumping ground). Free tier no ceiling. No dunning flow. >6 months since last reprice.
- **Minor** — Currency not localized. Signup >3 fields. Paywall slightly mistimed.
- **Cosmetic** — Pricing page polish.

## Anti-patterns / Bias instructions

- **Do NOT recommend "lower prices to compete."** Low pricing is usually a positioning failure, not a pricing failure. Fix positioning (L28) first.
- **Do NOT recommend dark patterns to improve cancel flow numbers.** Roach motel cancel flow = L08 dark pattern + L25 legal exposure.
- **Do NOT confuse activation with monetization.** Free users activating ≠ paid users converting. Different funnels, different optimizations.
- **Bias toward "what would a real prospective buyer do at each step?"** Test by walking your own signup as if you'd never seen the product.

## Stop conditions

1. **No monetization plan, no paid users, no intent to charge.** Skip.

## Cross-lens handoff

- **Upstream:** L24 Competitive Benchmarking, L28 Wedge.
- **Downstream:** L26 Marketing (pricing page is marketing).
- **Adjacent (~15% overlap):**
  - **L08 Friction** — cancel flow / dark patterns overlap.
  - **L24** — pricing comparison overlap.
