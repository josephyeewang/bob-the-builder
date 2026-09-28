---
id: L29
name: Onboarding & Activation
band: 8
band_name: Growth & Adoption
when_to_run: Products with new-user flows. Mandatory before any consumer launch or growth push.
estimated_duration: 60-90 min — requires walking onboarding live
session_pattern: fresh session; reads L07 (Ease), L09 (Wow), L26 (Marketing) if available
output_markdown: audit-artifacts/L29-onboarding-activation-{YYYY-MM-DD}.md
output_json: audit-artifacts/L29-onboarding-activation-{YYYY-MM-DD}.json
source_frameworks:
  - Sean Ellis activation framework + PMF test
  - Brian Balfour / Reforge — three moments: setup → aha → habit
  - Lenny Rachitsky activation benchmarks
  - Reforge aha-moment guide
  - Four-fits of activation (Audience / Promise / Urgency / Knowledge)
---

# L29 — Onboarding & Activation

## Question this lens answers

*From the moment a user lands or signs up, do they reach the "aha moment" quickly, activate at a measurable rate, and retain at meaningfully higher levels than non-activated users?*

## Why this lens exists / what other lenses miss

L07 (Ease) covers whether users can navigate. L09 (Wow) covers emotional peaks. Neither asks "do they actually GET TO VALUE." Activation is the operator-distinctive metric: it predicts retention, monetization, and lifetime value. Lenny benchmarks: median activation 25% (all products), 30% (SaaS). Activated users retain ≥2× non-activated. If your activation milestone doesn't show the 2× lift, the milestone is wrong (not "we have low activation" — "we've defined the wrong moment").

The DLL audit found activation problems: "engagement scoring front-loaded — reads as empty when user has 0 completions"; "first 5 messages try to convey completeness instead of simplicity"; "Try this onboarding steps speced but unwired creates silent disappointment."

## When this lens fires

**Always-in-Full-Enchilada for products with new users.** Curated panel inclusion criteria:
- ✅ Mandatory — before consumer launch or growth push.
- ✅ Strongly recommended — any product with sub-30% activation (industry median).
- ⏸ Skip — pure internal tools without onboarding flows.

## Session setup

- Start a **fresh Claude Code session.**
- Read L07, L09, L26 if available.
- Inputs:
  - Live onboarding flow (sign up with new email and walk it)
  - Welcome email sequence
  - Empty-state designs for first-run screens
  - Activation analytics (current activation rate, breakdown by step)
  - Cohort retention curves (activated vs non-activated)
  - Product Spec activation criteria from Step 1a
- Walk the onboarding live; don't just read code.

## Source frameworks

- **Sean Ellis activation framework** — activation = % new users reaching defined milestone. PMF test: ≥40% "very disappointed" if product disappeared. https://learningloop.io/glossary/sean-ellis-score
- **Brian Balfour / Reforge** — three moments: **setup → aha → habit**. Four fits of activation: Audience, Promise, Urgency, Knowledge. https://www.reforge.com/guides/define-customer-activation-moments
- **Lenny Rachitsky benchmarks** — Median 25% / SaaS 30%; 60th pctile good, 80th great. Activated cohort retains ≥2× unactivated. https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate
- **Reforge aha-moment guide** — Aha = earliest predictive milestone, not the "wow" demo moment. https://www.reforge.com/guides/define-your-aha-moment

## Audit method

1. **Activation milestone definition.**
   - What's the named activation milestone? Is it one event or three? (Should be one.)
   - Is it measurable in analytics?
   - Does it predict retention (≥2× rule)?

2. **Retention lift validation.**
   - Pull cohort data — D7, D30 retention for activated vs not.
   - Activated should retain ≥2× non-activated.
   - <2× → milestone is wrong (the event isn't actually what predicts value-realization).

3. **TTFV measurement.**
   - Time-to-first-value: median minutes from signup to milestone
   - Click count from signup → milestone
   - p50 / p90 / worst-decile

4. **Funnel step-by-step audit.**
   - Walk signup → milestone. List every step.
   - At each step: drop-off % from prior step
   - Where's the biggest drop-off cliff?

5. **Empty-state audit.**
   - First screen post-signup: does it demonstrate value or demand setup work?
   - Setup work = penalty for being new
   - Strong empty states show what's possible + offer the path

6. **Aha-discoverability audit.**
   - Is aha buried behind tutorial/tooltips, or surfaces naturally?
   - If you removed all tooltips/tours, would user still reach aha?
   - Forced tooltips = product doing the talking through a megaphone, not designing flow

7. **Welcome email audit.**
   - Sequence length: how many emails, what cadence?
   - Each email's CTA: clear, single, actionable?
   - Open / click rates if available
   - Dead-end CTAs (reset password loops, expired invites)?

8. **First-run path audit.**
   - How many decisions does user make before seeing value? (Target ≤3.)
   - Top 3 abandonment points with %?
   - Where do users get stuck or ask for help?

9. **Promise/aha gap audit (Reforge Four Fits).**
   - **Audience** — does promised audience match actual visitors?
   - **Promise** — does landing-page claim match first-run experience?
   - **Urgency** — is the user in pain when they arrive, or browsing?
   - **Knowledge** — does user know enough to use the product, or are you teaching too much?
   Mismatches kill activation.

10. **Segmentation audit.**
    - Are activation rates segmented by acquisition source?
    - Different sources have different setup expectations and activation rates.
    - Top vs bottom decile — what's the worst 10% of signups doing?

## Check questions

1. What's the named activation milestone? Single event?
2. Activated users retain at what multiple of non-activated? (<2× → milestone wrong)
3. TTFV from signup → milestone: median minutes? Clicks? p90?
4. What % of signups hit milestone in session 1? Day 7? Day 30?
5. Empty state on first screen: demonstrates value or demands setup?
6. If you removed all tooltips/tours, would user still reach aha?
7. Welcome email sequence: how many emails, what CTAs, what open/click rates?
8. First-run: how many decisions before value? (Target ≤3.)
9. Top 3 abandonment points with %?
10. Promise/aha gap: landing-page headline vs actual aha — same?
11. Is activation segmented by acquisition source?
12. What's the worst 10% of signups doing?
13. Are there dead-end welcome CTAs?
14. Sean Ellis PMF test ever run? Score?
15. What's the single highest-leverage activation improvement?
16. **Day-30 measurement plan (v2.19):** for any finding that can't be evaluated until post-fix data accrues, has a concrete measurement plan been produced — exact event names, the exact HogQL/SQL query to run, the comparison window, and the go/no-go threshold? ("Wait 30 days then check PostHog" is not a finding; the runnable query is.)

## Output schema

### Markdown report

```markdown
# L29 — Onboarding & Activation — {YYYY-MM-DD}

## Activation milestone
- Named: {event}
- Measurable: yes/no
- Retention lift (activated vs not): X×
- Verdict: correct / wrong-milestone

## TTFV
- Median minutes: X
- Clicks from signup → milestone: X
- p90: X

## Funnel
| Step | Drop-off % from prior | Where users go |
|---|---|---|

## Empty state
- First screen: demonstrates / demands
- Strong empty states present: yes/partial/no

## Aha-discoverability
- Reachable without tooltips/tours: yes/no
- Tutorial / tour reliance: low/medium/high

## Welcome email
| Email | Cadence (day) | CTA | Open % | Click % |
|---|---|---|---|---|

## First-run decision count
- Decisions before value: N
- Target: ≤3
- Abandonment points: {list with %}

## Reforge Four Fits
| Fit | Status | Findings |
|---|---|---|
| Audience | | |
| Promise | | |
| Urgency | | |
| Knowledge | | |

## Segmentation
| Acquisition source | Activation rate | Notes |
|---|---|---|

## Worst-decile signup behavior
{1-paragraph}

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L29",
  "lens_name": "Onboarding & Activation",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "activation_milestone_defined": false,
  "activation_milestone_measurable": false,
  "retention_lift_activated_vs_not": null,
  "milestone_predictive": null,
  "ttfv_median_minutes": null,
  "ttfv_p90_minutes": null,
  "clicks_to_value": null,
  "activation_rate_current": null,
  "activation_rate_benchmark_target": null,
  "first_run_decision_count": null,
  "promise_aha_alignment": null,
  "findings": [
    {
      "id": "L29-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "no_milestone|wrong_milestone|slow_ttfv|too_many_decisions|empty_state_demands_setup|tooltip_reliance|broken_welcome_email|promise_aha_gap|audience_mismatch|urgency_low|knowledge_gap|no_segmentation|dead_end_cta",
      "title": "{short}",
      "evidence": "{specific step / screen / email}",
      "impact_on_activation": "{estimated}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — No defined activation milestone. Milestone defined but doesn't predict retention (<2× lift). Activation rate <10% (well below industry median).
- **Major** — Milestone wrong (low retention lift suggests rethinking). TTFV >median × 3. Empty state demands setup. >5 decisions before value. Promise/aha gap.
- **Minor** — Tooltip reliance. Welcome email cadence off. Sub-median activation rate.
- **Cosmetic** — Polish in onboarding copy.

## Anti-patterns / Bias instructions

- **Do NOT recommend adding tutorials as the activation fix.** Tutorials are an onboarding crutch; great products surface value through the interface, not through teaching.
- **Do NOT confuse activation with onboarding completion.** Completing onboarding ≠ activating. The activation milestone is the moment value is realized, often after onboarding ends.
- **Do NOT optimize the funnel before the milestone is right.** A 20% drop at step 3 in a wrong-milestone funnel is wasted work.
- **Bias toward "what would a user pay attention to in the first 60 seconds?"** That's the activation window.

## Stop conditions

1. **Pre-launch / no users.** Cannot measure; skip and re-run after activation.
2. **No analytics instrumentation.** Document gap; recommend instrumenting before re-running.

## Cross-lens handoff

- **Upstream:** L07 Ease, L09 Wow, L26 Marketing (landing-page promise).
- **Downstream:** L30 Retention (activation feeds retention curves).
- **Adjacent (~15% overlap):**
  - **L09 Wow** — onboarding peaks overlap.
  - **L16 Effectiveness** — activation is the primary effectiveness metric.
  - **L26 Marketing** — promise-aha alignment.
