---
id: L30
name: Retention & Compounding Loops
band: 8
band_name: Growth & Adoption
when_to_run: Products with returning-user value (most products). Mandatory before scaling growth investment.
estimated_duration: 60-90 min
session_pattern: fresh session; reads L29 (Onboarding), L20 (Shareability), L16 (Effectiveness) if available
output_markdown: audit-artifacts/L30-retention-compounding-loops-{YYYY-MM-DD}.md
output_json: audit-artifacts/L30-retention-compounding-loops-{YYYY-MM-DD}.json
source_frameworks:
  - Nir Eyal — Hooked model (trigger → action → variable reward → investment)
  - Reforge growth loops (Brian Balfour, Casey Winters, Kevin Kwok)
  - Andrew Chen — The Cold Start Problem (atomic networks, anti-network-effects)
  - Retention curves (L-curve / flat / smile)
  - a16z "Retention is all you need" (AI-native smile curves)
---

# L30 — Retention & Compounding Loops

## Question this lens answers

*Once a user activates, what brings them back tomorrow, next week, next month — and does each session leave investments behind that compound the next session?*

## Why this lens exists / what other lenses miss

L29 catches first-session value. L30 catches loops — what makes the product compound vs decay. Funnel-thinking is linear (acquisition → activation → revenue); loop-thinking is circular (each cycle's output is next cycle's input). Compounding products dominate; non-compounding products require constant top-of-funnel investment.

a16z's "Retention is all you need" highlights smile curves: AI-native products often show users leaving early then coming back as the product's value compounds with their use. That's a new retention pattern engineering tools can't catch.

## When this lens fires

**Always-in-Full-Enchilada for products with returning-user value.** Curated panel inclusion criteria:
- ✅ Mandatory — before scaling growth investment (you'll just leak the funnel into a non-compounding product).
- ✅ Strongly recommended — any product where retention matters (most products).
- ⏸ Skip — pure one-shot transactional products with no return-user value.

## Session setup

- Start a **fresh Claude Code session.**
- Read L29, L20, L16 if available.
- Inputs:
  - Retention cohort data — D1, D7, D30, D90 retention curves
  - Returning-user behavior data
  - Referral / share data (overlaps L20)
  - Notification / re-engagement campaigns
  - Churn / cancel data + reasons
  - Product Spec retention metrics from Step 1a

## Source frameworks

- **Nir Eyal — Hooked** — Trigger (external → internal) → Action → Variable Reward → Investment. Investment stores value that loads the next trigger. https://amplitude.com/blog/the-hook-model
- **Reforge Growth Loops (Balfour, Winters, Kwok)** — Loops > funnels; output of one cycle = input to next. Compounding requires reinvestment. https://www.reforge.com/blog/growth-loops
- **Andrew Chen — The Cold Start Problem** — three network-effect types (Acquisition, Engagement, Economic). Atomic network = first stable engaged cluster. https://a16z.com/books/the-cold-start-problem/
- **Retention curves** — L-curve (failing) / flat (PMF) / smile (deepening value, common in AI-native).
- **a16z — AI retention benchmarks** — https://a16z.com/ai-retention-benchmarks/

## Audit method

1. **Hook model completeness per primary action.**
   - **External trigger** — what brings user back (email, notification, calendar, habit, peer mention)?
   - **Internal trigger** — what emotion / situation? ("bored," "anxious," "lonely," "stuck on X")
   - **Action** — what minimum-viable behavior?
   - **Variable reward** — tribe (social) / hunt (resources) / self (mastery)?
   - **Investment** — what does user leave behind (data, content, social ties, settings)?
   Each step intact = closed hook. Open hook = funnel pretending.

2. **Retention curve shape.**
   - D1 / D7 / D30 / D90 cohort retention
   - L-curve (asymptotic to zero — failing), flat (asymptotic above zero — PMF), smile (returning churn-cohort — compounding value)
   - Cohort half-life — time for cohort to halve

3. **Growth loop inventory.**
   - Acquisition loops — paid, viral, content, sales — which exist?
   - Engagement loops — what brings active users back?
   - Economic loops — does the unit economics improve at scale?
   - For each loop: drawn end-to-end with all 4 steps (input → action → output → input)?

4. **Network effect audit (Chen's 3 types).**
   - **Acquisition** — viral coefficient measured? K-factor?
   - **Engagement** — does density correlate with usage? More users = better for existing users?
   - **Economic** — do unit economics improve with scale?
   Most products claim network effects; few have measurable evidence.

5. **Atomic network identification.**
   - Smallest self-sustaining unit?
   - Have you built one yet, or are you pre-atomic?
   - For multi-sided products: both sides at sufficient density?

6. **Embeddability / virality loop audit (overlaps L20).**
   - Does product leave traces (links, watermarks, exports)?
   - Measured contribution to acquisition?

7. **Content loop audit.**
   - Does usage produce indexable content (UGC, public pages, SEO surfaces)?
   - % of organic traffic from user-generated pages?

8. **Churn-prevention surface audit.**
   - Last 90 days: where did churned users disengage?
   - Is there a "pause" option vs only "cancel"?
   - Downgrade-instead-of-cancel offered?
   - Win-back campaign for dormant users?

9. **Smile-curve check (AI-native products).**
   - Are returning churned users a measurable cohort?
   - Is value compounding with use (more data → better personalization → stickier)?

10. **Retention budget audit.**
    - Is growth investment going to top-of-funnel before retention curve flattens?
    - If retention is L-shaped, acquisition is wasted.

## Check questions

1. What internal trigger (emotion/situation) does product hook into? Named?
2. Draw the primary loop end-to-end: trigger → action → reward → investment → next trigger. Closes?
3. What does user *leave behind* that makes next session better?
4. Variable reward category — tribe / hunt / self? Actually variable, or predictable?
5. Retention curve shape at D30/D90 — L / flat / smile?
6. Cohort half-life? Growing or shrinking by cohort?
7. Network effects — which of Chen's 3 do you have *evidence* of (not theory)?
8. Atomic network built? Smallest self-sustaining unit identified?
9. Does product leave traces in the wild (links, watermarks, exports) — measured?
10. Does usage produce content (UGC → SEO → acquisition)?
11. Referral mechanics: invite friction, incentive symmetry, k-factor?
12. Where do churned users disengage? Top 3 with %?
13. Pause / downgrade / win-back surfaces exist?
14. For AI products: returning-churn cohort measurable (smile-curve signal)?
15. Is growth investment matched to retention shape? (L-shape = stop spending)
16. **Day-30 measurement plan (v2.19):** for any retention/loop finding that matures only with time, has a concrete measurement plan been produced — exact cohort definition, the exact query (D1/D7/D30 retention, k-factor attribution), the comparison window, and the go/no-go threshold? (A deferred "measure later" finding decays unless it ships with the runnable query.)

## Output schema

### Markdown report

```markdown
# L30 — Retention & Compounding Loops — {YYYY-MM-DD}

## Hook model per primary action
| Action | External trigger | Internal trigger | Variable reward type | Investment |
|---|---|---|---|---|

## Retention curve
| Cohort | D1 | D7 | D30 | D90 | Shape |
|---|---|---|---|---|---|

## Growth loops inventory
| Loop type | Loop drawn? | Closing? | Measured input → output ratio |
|---|---|---|---|

## Network effects (Chen 3 types)
| Type | Claimed | Evidence | Measurement |
|---|---|---|---|
| Acquisition | yes/no | k-factor | |
| Engagement | yes/no | density-usage correlation | |
| Economic | yes/no | unit economics by scale | |

## Atomic network
- Identified: yes/no
- Built: yes/no
- Definition: {what's the smallest self-sustaining unit}

## Embeddability + content loops
- Product leaves traces: {watermark / link / export}
- % organic acquisition from these: X%

## Churn-prevention surfaces
- Pause: yes/no
- Downgrade vs cancel: yes/no
- Win-back campaign: yes/no with conversion rate

## Smile-curve check (AI-native)
- Returning-churn cohort: X% of D30 churn returns by D90
- Value compounds with use: yes/no

## Growth-investment / retention-shape match
- Retention shape: L / flat / smile
- Investment level: high / medium / low
- Match: appropriate / mismatched

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L30",
  "lens_name": "Retention & Compounding Loops",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "hook_model_complete_loops": 0,
  "retention_shape": "l|flat|smile|unknown",
  "d7_retention": null,
  "d30_retention": null,
  "d90_retention": null,
  "cohort_half_life_days": null,
  "growth_loops_drawn": 0,
  "network_effects_evidenced": 0,
  "atomic_network_built": false,
  "embeddability_present": false,
  "content_loop_present": false,
  "k_factor_measured": null,
  "churn_prevention_surfaces": {
    "pause": false,
    "downgrade": false,
    "win_back": false
  },
  "growth_investment_retention_match": null,
  "findings": [
    {
      "id": "L30-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "hook_incomplete|l_curve_retention|no_growth_loop|no_network_effect_evidence|pre_atomic_network|no_embeddability|no_content_loop|no_referral|missing_pause|missing_win_back|investment_mismatch|funnel_pretending_to_be_loop",
      "title": "{short}",
      "evidence": "{specific data point / surface / loop}",
      "impact_on_retention": "{estimated}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — L-curve retention (going to zero) at D30. Growth investment ongoing despite L-curve. No closed loop — funnel pretending to be loop. Hook model has 0-1 of 4 steps.
- **Major** — Flat retention but very low asymptote (~5-10%). No measurable network effect on a product claiming network effects. Pre-atomic network with growth push.
- **Minor** — Hook model 3 of 4 steps. Embeddability missing on share-able product. Referral mechanics suboptimal.
- **Cosmetic** — Polish on win-back campaigns.

## Anti-patterns / Bias instructions

- **Do NOT recommend "improve retention" without naming which loop is broken.** Generic recommendations are useless. Identify the loop step that's failing.
- **Do NOT recommend more notifications as retention fix.** Notification spam reduces retention by reducing trust (L08). Hook model investment > notification volume.
- **Do NOT claim network effects without measurement.** If you can't show k-factor or density-usage correlation, you have aspiration, not network effect.
- **Bias toward "what would still be true if you stopped marketing tomorrow?"** Compounding products grow without ongoing top-of-funnel; non-compounding don't.

## Stop conditions

1. **Pre-launch / no D7+ cohort.** Cannot measure retention curves; skip with note.
2. **Pure one-shot transactional product.** Not applicable; skip.

## Cross-lens handoff

- **Upstream:** L29 Onboarding (activation feeds retention curves), L20 Shareability (loops overlap), L16 Effectiveness.
- **Downstream:** L25 Pricing (LTV calculation requires retention shape).
- **Adjacent (~15% overlap):**
  - **L20 Shareability** — viral loops overlap; L20 = touchpoint, L30 = full loop.
  - **L16 Effectiveness** — retention is a primary effectiveness metric.
  - **L29 Onboarding** — activation cliff predicts retention shape.
