---
id: L16
name: Effectiveness & Quality Drivers
band: 4
band_name: Performance Economics
when_to_run: Products with users and any measurable outcome (activation, retention, conversion, task-completion, NPS). Skip pre-user products.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L11, L15, L29, L30 if available
output_markdown: audit-artifacts/L16-effectiveness-quality-drivers-{YYYY-MM-DD}.md
output_json: audit-artifacts/L16-effectiveness-quality-drivers-{YYYY-MM-DD}.json
source_frameworks:
  - Sean Ellis / Lenny Rachitsky activation benchmarks
  - Reforge / Brian Balfour growth-loop frameworks
  - Pareto principle (80/20)
  - Bob's existing A7g Effectiveness Signals audit
  - North Star Metric methodology (Amplitude)
---

# L16 — Effectiveness & Quality Drivers

## Question this lens answers

*What's actually driving the outcomes users care about — and where's the leverage and the leakage?* The lens hunts for: (a) the few things doing most of the work (Pareto winners worth doubling down on), (b) the silent leaks (places value is created but lost), (c) the over-invested areas (high effort, low effectiveness).

## Why this lens exists / what other lenses miss

L15 measures cost and speed (inputs). L16 measures effectiveness (outputs). Most products instrument enough analytics to tell you what's working *at all* but not enough to tell you what's working *disproportionately*. The Pareto pattern almost always exists — 20% of features drive 80% of value; 20% of users drive 80% of revenue; 20% of incidents cause 80% of pain — but it's invisible without targeted measurement.

L16 also extends Bob's existing A7g (Effectiveness Signals, v2.10) by adding the *leakage* lens: where is the product creating value the user can't capture? DLL examples: Activity ledger exists but is invisible (value created, not seen); engagement scoring front-loaded (reads empty when user has 0 completions — value miscalibrated to context).

## When this lens fires

**Always-in-Full-Enchilada for live products.** Curated panel inclusion criteria:
- ✅ Products with users and measurable outcomes.
- ✅ Mandatory — before major feature investment decisions, before fundraising, quarterly product reviews.
- ⏸ Skip — pre-launch / pre-user products (no signal yet — re-run after activation).

## Session setup

- Start a **fresh Claude Code session.**
- Read L11 (AI accuracy), L15 (cost/speed), L29 (onboarding), L30 (retention) if available.
- Inputs:
  - Product analytics (events, funnels, cohorts) — Amplitude, Mixpanel, PostHog, Segment, custom
  - Customer support tickets / feedback logs
  - User survey data (CSAT, NPS, qualitative quotes)
  - Product Spec success metrics from Step 1a (Bob's standard)
  - Build Manifest feature-by-feature usage data if available

## Source frameworks

- **Sean Ellis activation framework** — activation = % of users reaching a defined milestone.
- **Lenny Rachitsky activation benchmarks** — median 25% all products, 30% SaaS; 60th pctile = good, 80th pctile = great.
- **Reforge growth loops** — input → action → reward → investment → next input. Each "investment" should reduce friction for next loop.
- **Pareto principle** — 80/20 rule applied to features, users, incidents.
- **North Star Metric (Amplitude)** — single metric capturing "real value delivered."
- **Bob A7g** — effectiveness signals audit. https://github.com/.../build-protocol.md §A7g

## Audit method

1. **Pull declared success metrics.** From Product Spec Step 1a. List each metric with target + current value. If no success metrics defined → that IS the finding (run A7g's stop condition).

2. **Pareto on features.** Pull feature-usage data. Sort features by % of active users who use them. Identify:
   - **Top 20% of features** — these do most of the work. Are they getting proportionate investment?
   - **Bottom 50% of features** — used by <5% of users. Are they justified by strategic value, or candidates for sunset?

3. **Pareto on users.** Pull cohort/segment data. Identify the top 20% of users by:
   - Revenue contribution
   - Engagement (sessions / actions)
   - Retention contribution
   What characterizes them? Are they your stated target persona, or someone else?

4. **Leverage audit — disproportionate winners.** For each "top 20" feature/persona, ask:
   - What's making it work?
   - Could that pattern be replicated to another area?
   - Is it currently amplified (marketed, surfaced, onboarded to), or hidden?

5. **Leakage audit — value created but lost.** Walk the product looking for places where:
   - Work happens but user can't see it (DLL: silent auto-recovery, invisible memory decay protection)
   - Outcomes happen but aren't celebrated (first-task completion → cold "Got it.")
   - Insights exist in data but never surface to users (analytics dashboards for the team, no equivalent for the user)
   - Cross-feature connections that would compound value but aren't wired

6. **Over-investment audit.** For each feature in the bottom 50%, estimate:
   - Build effort spent
   - Maintenance effort recurring
   - Usage
   - Strategic value (is it a wedge / differentiator, or just exists?)
   Candidates for sunset or de-emphasis.

7. **Quality drivers per outcome metric.** For each success metric (activation rate, retention, conversion, NPS):
   - What's the top 3 factors driving the metric?
   - What's the top 3 factors HURTING the metric?
   - Where could a 10% improvement on a driver move the needle most?

8. **Effectiveness leak in support tickets.** Read 20-50 recent support tickets / feedback items. Categorize. Top 3 categories indicate effectiveness leaks. (Not bugs — gaps where the product creates frustration even when working correctly.)

## Check questions

1. Are success metrics declared in Product Spec Step 1a?
2. Are they currently measured (not just declared)?
3. For each metric: current value, target, gap, trend?
4. Is there feature-usage data per feature?
5. Top 20% of features by usage — what are they? Getting proportionate investment?
6. Bottom 50% of features — justified by strategy or sunset candidates?
7. Top 20% of users by value — who are they? Match target persona?
8. Where in the product is value created but invisible (silent benefits)?
9. Where in the product are outcomes achieved but not celebrated (cold confirmation)?
10. Where are insights present in data but absent from user-facing UI?
11. What's the single highest-leverage improvement to the primary success metric?
12. What's the single largest leakage point?
13. What's the single largest over-investment?
14. Are support tickets analyzed for category patterns (not just resolved individually)?
15. Is there a North Star Metric, and does the team align on it?

## Output schema

### Markdown report

```markdown
# L16 — Effectiveness & Quality Drivers — {YYYY-MM-DD}

## Declared success metrics (from Product Spec Step 1a)
| Metric | Target | Current | Gap | Trend | Source |
|---|---|---|---|---|---|

## Feature Pareto
| Tier | Features | % users using | Effort allocation |
|---|---|---|---|
| Top 20% | [...] | 60%+ | ? |
| Mid 30% | [...] | 5-60% | |
| Bottom 50% | [...] | <5% | |

## User Pareto
| Tier | Characteristics | % of revenue/engagement | Matches stated target persona? |
|---|---|---|---|

## Leverage findings (winners to amplify)
| # | Winner | Why it works | Amplification proposal |
|---|---|---|---|

## Leakage findings (value created but lost)
| # | Where value is created | Where it's lost | Recommendation |
|---|---|---|---|

## Over-investment findings
| Feature | Build/maint effort | Usage | Sunset candidate? |
|---|---|---|---|

## Per-metric quality drivers
| Metric | Top 3 driving factors | Top 3 hurting factors | Highest-leverage 10% improvement |
|---|---|---|---|

## Support ticket category analysis (last N tickets)
| Category | # tickets | % of total | Suggests... |
|---|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L16",
  "lens_name": "Effectiveness & Quality Drivers",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "success_metrics_declared": false,
  "success_metrics_measured": false,
  "metric_gap_count": 0,
  "feature_pareto": {
    "top_20_pct_features": [],
    "bottom_50_pct_features": []
  },
  "user_pareto": {},
  "leverage_findings_count": 0,
  "leakage_findings_count": 0,
  "over_investment_findings_count": 0,
  "north_star_metric_defined": false,
  "findings": [
    {
      "id": "L16-F001",
      "severity": "critical|major|minor|cosmetic",
      "direction": "amplify|fix|sunset",
      "category": "metric_undeclared|metric_unmeasured|leverage_underamplified|value_silent|value_uncelebrated|insight_unsurfaced|over_invested_feature|under_invested_winner|support_ticket_pattern|persona_mismatch",
      "title": "{short}",
      "evidence": "{specific feature / metric / behavior}",
      "estimated_impact": "{e.g., +5% activation if amplified}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Success metrics not declared OR not measured (A7g stop condition applies). North Star Metric undefined and team disagrees on what success means.
- **Major** — Top winner feature getting under-invested. Major leakage point identified (e.g., DLL Activity ledger invisible). Top-20-user-segment is *not* target persona (positioning mismatch).
- **Minor** — Bottom-50% features without sunset plan. Support ticket pattern unaddressed.
- **Cosmetic** — Measurement / dashboard improvements.

## Anti-patterns / Bias instructions

- **Do NOT confuse 'feature exists' with 'feature is effective.'** Usage and outcomes are separate. A feature used by 80% with no outcome lift is a vanity metric.
- **Do NOT recommend sunset without checking strategic value.** Some bottom-50% features are wedge-defining (L28) and should stay even at low usage.
- **Do NOT skip the leakage section.** Leakage is the highest-leverage category because the value is already being created — making it visible is cheap.
- **Bias toward "what would move the primary success metric by 5%?"** A 5% lift on a real metric > a 50% lift on a vanity metric.

## Stop conditions

1. **No success metrics declared in Product Spec.** That's the finding. Stop. Recommend completing Product Spec Step 1a before further audits.
2. **No analytics instrumentation.** Cannot measure effectiveness. Recommend instrumentation, defer L16.
3. **Pre-launch / no users.** No signal yet. Skip and re-run after activation.

## Cross-lens handoff

- **Upstream:** L11 Accuracy, L15 Cost/Speed.
- **Downstream:** L29 Onboarding, L30 Retention, L28 Wedge (all use effectiveness data to calibrate).
- **Adjacent (~15% overlap):**
  - **L29 Onboarding** — activation metric belongs to both; L29 owns the journey, L16 owns the metric drivers.
  - **L09 Wow** — uncelebrated outcomes are both a leakage finding (L16) and a missed peak (L09).
