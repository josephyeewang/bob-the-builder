---
id: L22
name: Vendor & Dependency Risk
band: 6
band_name: Operational
when_to_run: Any product with third-party vendor dependencies (most products). Mandatory before fundraising or any contract negotiation.
estimated_duration: 60-90 min
session_pattern: fresh session; reads L06 (Supply Chain) and L12 (AI Right-Sizing) if available
output_markdown: audit-artifacts/L22-vendor-dependency-risk-{YYYY-MM-DD}.md
output_json: audit-artifacts/L22-vendor-dependency-risk-{YYYY-MM-DD}.json
source_frameworks:
  - Bus factor / Single-Point-of-Failure analysis
  - Business continuity planning frameworks
  - Vendor lock-in audits (Joel Spolsky, Martin Fowler)
  - SaaS sunset risk patterns
  - Bob's existing D-003 "orchestrate, don't reinvent" — accept inherited vendor dependency
---

# L22 — Vendor & Dependency Risk

## Question this lens answers

*For every third-party vendor / SaaS / API / OSS library this product depends on: what happens if vendor X goes down for 4 hours, doubles prices, sunsets the product, has a security breach, or refuses to serve us?*

## Why this lens exists / what other lenses miss

L06 covers supply-chain vulnerabilities (CVEs in deps). L22 covers vendor business-risk: lock-in, sunset, pricing power, geo-restrictions, breach exposure. Different category. The "Twitter/X API pricing change" pattern, the "Heroku free-tier sunset," the "OpenAI rate-limit surprise" — these are vendor-business events that aren't security vulns but can take down a product.

For AI products specifically: dependence on a single model vendor (Anthropic / OpenAI) is concentrated risk. If Anthropic's API has an outage, every Anthropic-only product is down. This lens audits the fallback posture.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — any product with external vendors (almost all).
- ✅ Mandatory — before fundraising (investor diligence), before any large vendor contract, after any vendor sunset announcement.
- ⏸ Skip — products with no external vendors (rare).

## Session setup

- Start a **fresh Claude Code session.**
- Read L06 (Supply Chain), L12 (AI Right-Sizing if AI product).
- Inputs:
  - Vendor inventory (every SaaS, API, model provider, hosting, payments, auth, comms, storage)
  - Vendor contracts / TOS (key clauses on SLAs, pricing changes, data ownership, exit)
  - Architecture diagram showing dependencies
  - Last 12 months of vendor outages / incidents impacting the product
- Tools: vendor status page aggregators (statusgator.com), uptime trackers.

## Source frameworks

- **Bus factor / SPOF analysis** — for each component, "how many vendors must work for this to work?" SPOF = 1.
- **Vendor lock-in heuristics** — switching cost in dev-days; data portability; API surface uniqueness.
- **Business continuity planning** — RTO (recovery time objective) and RPO (recovery point objective) per vendor.
- **Bob D-003** — Bob explicitly accepts inherited vendor dependency from "orchestrate, don't reinvent." That's a feature, not a bug — but the consequences require auditing.

## Audit method

1. **Vendor inventory.** Enumerate every external dependency:
   - Hosting (Vercel, AWS, Railway, etc.)
   - Database (Supabase, Neon, RDS)
   - Auth (Clerk, Auth0, NextAuth)
   - AI model providers (Anthropic, OpenAI)
   - Payments (Stripe)
   - Email (Resend, Postmark, SendGrid)
   - SMS (Twilio)
   - Analytics (PostHog, Mixpanel, Segment)
   - Observability (Datadog, Sentry)
   - Search (Algolia, Typesense)
   - CDN (Cloudflare, Vercel)
   - Storage (S3, R2, Vercel Blob)
   - File processing / ML (specialized vendors)
   - OSS libraries with single-maintainer / abandoned status

2. **For each vendor, rate on 6 dimensions:**
   - **Criticality** — what fails if vendor is down? (Just one feature? Whole product?)
   - **Outage exposure** — vendor's historical uptime; SLAs; last 12-month outages affecting the product.
   - **Pricing power** — vendor's ability to raise prices; switching cost in dev-days.
   - **Lock-in depth** — vendor-specific features used; data portability; API uniqueness.
   - **Sunset risk** — vendor business health; recent funding; product roadmap signals.
   - **Compliance / data risk** — where vendor stores data; breach history; DPA in place (L05).

3. **SPOF analysis.** For each user-visible feature, list which vendors must be up for that feature to work. Features with SPOF = 1 are the highest-risk; flag them.

4. **Fallback posture per critical vendor.**
   - For each "criticality: whole product" vendor, is there a documented fallback?
   - Is the fallback tested (or just theoretical)?
   - What's the switch-over time if vendor is gone (RTO)?
   - For AI model providers specifically: is there a gateway abstraction (LiteLLM, OpenRouter) so swapping is a config change vs code change?

5. **Concentration risk audit.**
   - How many critical vendors are owned by the same parent? (e.g., multiple AWS services = AWS as the single risk.)
   - Are any vendors hosted in same region / data center?
   - Are any vendors single-founder / sub-10-employee with no clear acquirer?

6. **Cost trajectory audit.**
   - Has any vendor doubled prices in the last 24 months?
   - Is any vendor on a known-aggressive pricing trajectory (Twitter/X API, Stripe Treasury)?
   - Is the product's gross margin sensitive to any one vendor's pricing changes?

7. **Geo / regulatory restriction audit.**
   - Any vendor restricted in markets the product wants to enter (China, Russia, EU data localization)?
   - Any vendor's data residency conflict with product's compliance needs (HIPAA, GDPR)?

8. **Vendor health / sunset signals.**
   - Recent funding rounds, layoffs, leadership departures?
   - Roadmap signals — last shipped feature, support responsiveness, deprecation history?
   - Community sentiment (Twitter, Reddit, HN)?

## Check questions

1. Is there a comprehensive vendor inventory?
2. For each vendor: criticality, SLA, last 12-month uptime, pricing trajectory?
3. Which features have SPOF = 1 (single vendor must be up)?
4. For each "whole product" vendor, is there a documented + tested fallback?
5. What's the switch-over time (RTO) per critical vendor?
6. For AI model providers: is there a gateway abstraction? Fallback chain documented?
7. Concentration risk — multiple critical vendors under same parent?
8. Has any vendor doubled prices in 24 months? Pricing trajectory worries?
9. Any vendor sub-10-employee / single-founder / no clear acquirer?
10. Any vendor restricted in target markets (geo)?
11. Any vendor's data residency conflict compliance posture?
12. DPA in place with every PII-handling vendor (overlaps L05)?
13. Is product gross margin sensitive to any one vendor's pricing change?
14. Are vendor health signals monitored (funding, layoffs, deprecation)?
15. Has a "what if X disappears tomorrow" tabletop exercise been done in last 12 months?

## Output schema

### Markdown report

```markdown
# L22 — Vendor & Dependency Risk — {YYYY-MM-DD}

## Vendor inventory + risk scoring
| Vendor | Category | Criticality | SLA | Last 12m uptime | Pricing power | Lock-in depth | Sunset risk | Compliance |
|---|---|---|---|---|---|---|---|---|

## SPOF analysis
| Feature | Vendors required | SPOF? |
|---|---|---|

## Fallback posture
| Critical vendor | Fallback documented | Fallback tested | RTO |
|---|---|---|---|

## Concentration risk
{list — same-parent vendors, same-region vendors, single-founder vendors}

## Cost trajectory
| Vendor | Last 24m price change | 12m forward forecast |
|---|---|---|

## Geo / regulatory
| Vendor | Restricted markets | Data residency conflict |
|---|---|---|

## Vendor health signals
| Vendor | Funding | Layoffs | Roadmap activity | Sentiment |
|---|---|---|---|---|

## Top 3 highest-leverage findings (by risk)
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L22",
  "lens_name": "Vendor & Dependency Risk",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "vendors_count": 0,
  "spof_features_count": 0,
  "documented_fallbacks_count": 0,
  "tested_fallbacks_count": 0,
  "concentration_risk": [],
  "price_spike_vendors": [],
  "sunset_risk_vendors": [],
  "geo_restricted_vendors": [],
  "tabletop_exercise_done": false,
  "findings": [
    {
      "id": "L22-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "spof|no_fallback|untested_fallback|concentration_risk|pricing_spike_exposure|sunset_risk|geo_restricted|missing_dpa|vendor_health_red_flag|lock_in_deep|no_tabletop_done",
      "vendor": "{name}",
      "title": "{short}",
      "current_risk": "{e.g., 'product down if Anthropic API outages'}",
      "mitigation": "{specific change with effort estimate}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — SPOF on whole-product vendor with no fallback. Vendor with recent layoffs, leadership departure, or stalled product. Vendor pricing in a known-aggressive trajectory affecting product margin >20%.
- **Major** — Critical vendor with fallback documented but untested. Concentration risk (multiple critical vendors under same parent). Vendor lock-in >30 dev-days to swap.
- **Minor** — Vendor in stable category with diversification opportunity. Cost trajectory uncertain.
- **Cosmetic** — Vendor relationship documentation gaps.

## Anti-patterns / Bias instructions

- **Do NOT recommend multi-cloud as the default fix.** Multi-cloud is expensive and complex. Most products are better off with one cloud + a tested rollback plan than two clouds badly.
- **Do NOT confuse "we have a fallback" with "the fallback works."** Untested fallbacks routinely fail at the worst time.
- **Do NOT recommend ripping out a vendor purely because of concentration risk.** Concentration is acceptable if RTO + business impact analysis is done; risk-as-fact is a finding, not a recommendation.
- **Bias toward "what's the actual probability × impact?"** A 0.01% probability event with $100M impact = $10k expected loss. A 10% probability event with $50k impact = $5k expected loss. Prioritize by expected loss.

## Stop conditions

1. **No external vendors.** Skip.

## Cross-lens handoff

- **Upstream:** L06 Supply Chain (OSS dep CVEs), L12 AI Right-Sizing (AI vendor specific).
- **Downstream:** L21 Observability (vendor health monitoring), L25 Pricing (vendor cost feeds pricing).
- **Adjacent (~15% overlap):**
  - **L06** — OSS deps overlap; L06 is vuln-focused, L22 is business-focused.
  - **L05 Privacy** — vendor DPA overlap.
