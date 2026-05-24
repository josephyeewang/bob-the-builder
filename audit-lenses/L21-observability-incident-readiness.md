---
id: L21
name: Observability & Incident Readiness
band: 6
band_name: Operational
when_to_run: Any deployed product. Mandatory before production launch. Quarterly drift check.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L01, L04, L10 if available
output_markdown: audit-artifacts/L21-observability-incident-readiness-{YYYY-MM-DD}.md
output_json: audit-artifacts/L21-observability-incident-readiness-{YYYY-MM-DD}.json
source_frameworks:
  - SRE four golden signals (latency, traffic, errors, saturation)
  - OpenTelemetry — https://opentelemetry.io
  - Honeycomb observability principles
  - Google SRE handbook
  - Bob's existing observability plan from architecture-contract.md
---

# L21 — Observability & Incident Readiness

## Question this lens answers

*When something goes wrong in production at 3am, can ops see what's happening, diagnose the cause, scope the blast radius, and roll back — within an acceptable timeline?*

## Why this lens exists / what other lenses miss

Engineering audits verify code correctness. L21 verifies operational readiness — different artifact. A perfectly correct codebase with no observability becomes opaque the moment a real user hits an unexpected state. Incident response time grows from minutes to hours when teams are flying blind.

This is the first lens that judges what happens AFTER the code ships. L01 checks code quality; L21 checks operational quality.

## When this lens fires

**Always-in-Full-Enchilada for deployed products.** Curated panel inclusion criteria:
- ✅ Mandatory — any product deployed to production.
- ✅ Quarterly — drift check (logging/monitoring rots silently as code evolves).
- ⏸ Skip — pre-deploy products, libraries, pure prototypes.

## Session setup

- Start a **fresh Claude Code session.**
- Inputs:
  - `architecture-contract.md` observability plan + rollback posture
  - Log structure / log retention config
  - Monitoring / alerting config (Datadog, New Relic, Honeycomb, Sentry, Vercel, CloudWatch)
  - Runbook docs (if any)
  - Recent incident postmortems (if any)
- Walk the deployment process and rollback process if possible.

## Source frameworks

- **SRE four golden signals** — latency, traffic, errors, saturation. Per Google SRE handbook.
- **OpenTelemetry** — vendor-neutral observability standard (metrics, traces, logs). https://opentelemetry.io
- **Honeycomb observability principles** — high-cardinality + high-dimensionality + ability to ask arbitrary questions.
- **Bob v2.2 + v2.7** — observability plan required in `architecture-contract.md`; cost guardrail check + AI eval re-run at phase gates.

## Audit method

1. **Four golden signals coverage.** For each hot path:
   - **Latency** — measured? p50/p95/p99 tracked? Alerts on degradation?
   - **Traffic** — request rate measured?
   - **Errors** — error rate measured? Per-endpoint?
   - **Saturation** — CPU/memory/DB/queue depth measured?

2. **Log coverage.**
   - Are structured logs (JSON) used vs unstructured strings?
   - Is every request traceable end-to-end via correlation ID?
   - Are auth events, payment events, deletion events logged with appropriate detail for forensic reconstruction?
   - Are PII fields redacted in logs (privacy ↔ observability tension)?
   - Log retention period — appropriate for incident windows (90d typical)?

3. **Distributed tracing coverage.**
   - For multi-service products: is OpenTelemetry / Datadog APM / equivalent capturing traces?
   - Can a single user request be followed end-to-end through frontend → API → DB → external services?

4. **Alerting audit.**
   - For each golden signal, is there an alert?
   - Alert thresholds tuned (not false-positive prone)?
   - Alert routing (who gets paged for what)?
   - SLOs defined? Error budgets tracked?

5. **Incident response readiness.**
   - Runbooks for top 3 expected failure modes (DB down, external API down, deploy bad)?
   - On-call rotation defined?
   - Communication channels defined?
   - Status page (public if customer-facing)?

6. **Rollback posture.**
   - Can a bad deploy be rolled back in <5 min?
   - Are database migrations reversible?
   - Are feature flags available to disable bad code paths without redeploy?

7. **Blast radius scoping.**
   - For a given failure, can ops quickly determine: % users affected? Which users? Which feature?
   - Is there a dashboard or query that answers these?

8. **AI observability (AI products).**
   - Token usage / cost per call site tracked?
   - Per-call eval scores / hallucination flags tracked?
   - Prompt + completion logged (with retention policy that respects privacy)?
   - Drift detection on eval pass-rate over time?

## Check questions

1. For each hot path, are all 4 golden signals measured?
2. Are logs structured (JSON), traceable via correlation ID, and PII-redacted?
3. Are auth/payment/deletion events logged with forensic detail?
4. Are distributed traces capturing end-to-end requests?
5. Is there an alert per golden signal per critical surface, tuned to actionability?
6. Are SLOs defined and error budgets tracked?
7. Are there runbooks for the top 3 expected failure modes?
8. Is there an on-call rotation? Communication channels? Public status page if needed?
9. Can a bad deploy be rolled back in <5 min?
10. Are DB migrations reversible? Feature flags available?
11. For a given failure, can blast radius be scoped within 15 min (% users, which users, which feature)?
12. For AI products: token usage, eval scores, prompt+completion logged?
13. Is there a recent incident postmortem with action items completed?
14. Is the observability stack costing >10% of total infra spend (signal of over-instrumentation)?
15. Has a "fire drill" been run in the last 6 months (simulated outage)?

## Output schema

### Markdown report

```markdown
# L21 — Observability & Incident Readiness — {YYYY-MM-DD}

## Four golden signals coverage per hot path
| Hot path | Latency | Traffic | Errors | Saturation |
|---|---|---|---|---|

## Log coverage
- Structured? yes/no
- Correlation ID end-to-end? yes/no
- Auth/payment/deletion logged forensically? yes/no/partial
- PII redacted? yes/no
- Retention period: N days

## Trace coverage
| Surface | Traced? | Tool |
|---|---|---|

## Alerting
| Signal | Alert configured | Threshold | Routing | Last false positive |
|---|---|---|---|---|

## SLOs
| SLO | Target | Current | Error budget remaining |
|---|---|---|---|

## Runbooks (top expected failures)
| Failure mode | Runbook present | Last updated | Last tested |
|---|---|---|---|

## Rollback posture
- Bad-deploy rollback time: X min
- DB migration reversibility: yes/no/partial
- Feature flag coverage: %

## Blast radius scoping
| Question | Answerable in <15 min? |
|---|---|

## AI observability (if applicable)
{coverage}

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L21",
  "lens_name": "Observability & Incident Readiness",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "golden_signals_coverage_pct": 0,
  "structured_logs": false,
  "correlation_id_e2e": false,
  "tracing_present": false,
  "alerts_count": 0,
  "slos_defined": false,
  "runbooks_count": 0,
  "rollback_time_minutes": null,
  "feature_flag_coverage_pct": 0,
  "ai_observability_coverage": null,
  "last_fire_drill_date": null,
  "findings": [
    {
      "id": "L21-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "missing_golden_signal|unstructured_logs|no_correlation_id|missing_trace|no_alert|alert_noisy|no_slo|missing_runbook|slow_rollback|no_feature_flags|cannot_scope_blast_radius|missing_ai_observability|no_fire_drill|over_instrumented",
      "title": "{short}",
      "evidence": "{specific surface / signal / config}",
      "operational_impact": "{1-sentence}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Production without basic golden-signal monitoring. No alert on error rate. Rollback time unknown or >30 min. No incident response process.
- **Major** — Logs unstructured. No distributed tracing on multi-service product. SLOs undefined. No runbook for any failure mode.
- **Minor** — Alert thresholds noisy. AI observability partial. Trace coverage <100%.
- **Cosmetic** — Dashboard polish; documentation freshness.

## Anti-patterns / Bias instructions

- **Do NOT over-instrument.** Observability costs money. Goldilocks the spend — enough signal to debug, not so much that the bill exceeds the value.
- **Do NOT confuse log volume with observability.** 10TB/day of logs is not "good observability" if you can't ask a question and get an answer.
- **Do NOT recommend "build a custom dashboard."** D-003. Datadog / Honeycomb / Grafana / Sentry exist.
- **Bias toward "what do you need at 3am during an incident?"** Build for the worst case, not the happy path.

## Stop conditions

1. **Pre-deploy product.** Skip; recommend establishing observability plan before launch.
2. **No production environment.** L21 not applicable yet.

## Cross-lens handoff

- **Upstream:** L01 (reachable surfaces), L04 (security logging), L10 (user-visible errors should be ops-visible too).
- **Downstream:** L22 (vendor reliability informs alerting needs).
- **Adjacent (~15% overlap):**
  - **L04** — logging overlaps; L21 is ops-focused, L04 is security-focused.
  - **L15 Cost** — observability cost overlaps; over-instrumentation is L15 finding.
