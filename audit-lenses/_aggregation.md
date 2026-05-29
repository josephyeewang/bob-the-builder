# Aggregation Template — How Findings Across Lenses Get Combined

> After all selected lenses run sequentially, Bob aggregates findings into a single ranked report. This document defines the aggregation logic.

## Why aggregation matters

Each lens produces its own markdown + JSON report. Without aggregation, the user faces 6-30 separate reports with no priority ranking — paralyzing. Aggregation:
1. **Dedups** findings that surfaced from multiple lenses (intentional ~15% overlap is now confirmation signal)
2. **Honors L28 vetoes** ("L28 says do not fix L08-F003 — it's wedge, not bug")
3. **Ranks** by severity × frequency × user-impact
4. **Surfaces top 10** for immediate action
5. **Logs deferrals** in `audit-log.md` for future audits

## Aggregation algorithm

```
1. Read every L{NN}-{slug}-{date}.json from this audit run
2. Build master findings list
3. Apply L28 vetoes — remove findings where L28 has marked "do_not_fix_wedge"
4. Dedup — identify findings that overlap by:
   - Same code location AND same category → merge with both lens IDs cited
   - Same surface AND similar wording → merge
   - Each merged finding cites all source lenses (e.g., "L01-F003, L04-F012")
5. Score each finding:
   - Severity weight: critical=10, major=5, minor=2, cosmetic=1
   - Frequency multiplier: 1.5× if surfaced by ≥3 lenses (convergence signal)
   - User-impact multiplier: 1.3× if affects critical capability or high-frequency surface
6. Rank by total score descending
7. Top 10 → action queue
8. Critical findings → fix list (mandatory before launch / next milestone)
9. Major findings → triage list (user decides fix / defer per item)
10. Minor + Cosmetic → backlog (logged in audit-log.md; revisit triggers documented)
11. **Strategic / non-code findings → separate bucket (v2.19).** Findings from the strategic lenses (L24 Competitive, L25 Pricing, L27 Persona, L28 Wedge) are product/positioning decisions, not code fixes. Route them to a separate "Strategic" bucket; they do NOT rank in the Critical/Major *code-fix* queues or the top-10 action queue, so a strategic opinion can't rank-pollute the must-fix-before-launch list. (Exception: if a strategic lens surfaces a genuine code/security/data finding, that one goes in the normal queue.) Origin: an EMBT retro flagged that L24/L27/L28 produced near-zero in-run code closures yet competed against real Criticals in the ranking.
```

### Band ≠ bucket — routing the v2.21 lenses (L31 / L32 / L33)

The strategic bucket (step 11) is defined by its **explicit lens list**, NOT by band. Three lenses produce **actionable** findings and rank in the normal code-fix queues regardless of where they sit:

- **L31 Input & Data-Flow Trace** (Band 1) — concrete propagation / dedup / atomicity / orphan defects. Normal queue (a dropped field or a double-spend is a real bug). Dedups against L03 on the *seam* vs. the *node*.
- **L32 Analytical Method Soundness** (Band 3) — owns SR 11-7 **conceptual soundness**; L11 owns **outcomes analysis (evals)**. When both flag the same analytical site, merge the finding but **keep both pillars cited** — a site can be eval-passing yet method-unsound (or vice versa), so neither subsumes the other. Normal queue.
- **L33 Output Register & Audience Fit** (Band 7, beside L26) — actionable content fixes (rewrite a jargon-laden diagnosis to the declared register). Routes like **L26**, into the normal queue, **NOT** the strategic bucket. A register/jargon mismatch for a declared audience is a defect, not a wedge/positioning call. Dedups against L27 when a persona surfaced the same register issue.

## Aggregated report template

File: `audit-artifacts/audit-summary-{YYYY-MM-DD}.md`
JSON: `audit-artifacts/audit-summary-{YYYY-MM-DD}.json`

```markdown
# Audit Summary — {YYYY-MM-DD}

## Run metadata
- Mode: {Curated / Full Enchilada / Custom}
- Lenses run: {L01, L02, ...}
- Lenses skipped: {L11, ...} (with one-line rationale)
- Run duration: X hours over Y sessions
- Project: {name}
- Project profile: {keywords}
- Last audit: {date} ({N} days ago)
- Findings resolved since last audit: X (out of Y open)
- New findings this run: Z

## Top 10 findings (ranked)
| Rank | ID | Lenses | Severity | Title | User impact | Recommendation |
|---|---|---|---|---|---|---|
| 1 | L01-F003 + L04-F012 | L01, L04 | Critical | Missing authn on /api/admin | Trivial unauth admin access | Add JWT middleware to /api/admin/* |
| 2 | L02-F001 | L02 | Critical | `undo` SMS command unimplemented despite spec promise | Users typing "undo" create literal task | Implement undo OR remove from welcome SMS |
| ... |

## Critical findings (mandatory fix before launch)
{list — all Critical-severity findings}

## Major findings (triage queue)
{list — all Major-severity findings, user decides fix / defer per item}

## Strategic / non-code findings (separate bucket — v2.19)
{Findings from L24 Competitive / L25 Pricing / L27 Persona / L28 Wedge — product & positioning decisions, NOT code fixes. Presented for a strategy session, kept out of the Critical/Major code-fix ranking so they don't dilute the must-fix counts.}
| Lens | Finding | Recommendation | Your call (Adopt / Defer / Reject) |
|---|---|---|---|

## L28 Wedge vetoes (intentional — do not fix)
| Source finding | L28 rationale |
|---|---|
| L08-F004 "keyboard-only onboarding feels hostile" | Keyboard-first is identity; tutorial yes, removal no |

## Convergence signals (findings surfaced by ≥3 lenses)
| Finding | Lenses | Implication |
|---|---|---|

**Named cross-lens meta-patterns (v2.19).** When ≥2 lenses independently note instances of the same *latent* pattern (not the same finding), name the pattern explicitly rather than leaving N scattered findings — the named class is more actionable than its instances. Canonical example surfaced by the EMBT retro: **"state-change blindness"** — the product is *stateful at the data layer but stateless at the UX layer* (it remembers your data but doesn't recognize or greet the returning user). L07 (cognitive path), L09 (peaks), and L29 (activation) each tend to catch one instance; aggregation should promote the pattern itself. Watch for this and similar latent classes (e.g., "UI that lies" — copy claiming capabilities the build doesn't have).

## Findings by lens (drill-down)
- **L01 Hygiene & Liveness:** X findings (link to L01-{date}.md)
- **L02 Spec Fidelity:** X findings
- ...

## Stop conditions encountered
| Lens | Stop condition | Recommendation |
|---|---|---|

## Resolved-since-last-audit
| Finding | Status | Resolution |
|---|---|---|

## New deferrals (logged in audit-log.md)
| Finding | Defer reason | Revisit trigger |
|---|---|---|

## New Reject decisions (logged in decision-log.md)
| Finding | Reject reason | Reference for future audits |
|---|---|---|

## Next steps
- Immediate: {fix top N criticals before next milestone}
- Short-term: {triage top majors with user}
- Quarterly: {next audit timing recommendation}
- Decision logs to write: {N}
```

## JSON aggregation schema

```json
{
  "audit_run_id": "{uuid}",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "mode": "curated|full_enchilada|custom",
  "lenses_run": ["L01", "L02", ...],
  "lenses_skipped": [{"lens": "L11", "reason": "..."}, ...],
  "duration_hours": 0,
  "session_count": 0,
  "project": "{name}",
  "project_profile": {},
  "last_audit_date": "YYYY-MM-DD",
  "last_audit_run_id": "{uuid}",
  "days_since_last_audit": 0,
  "resolved_since_last_audit": 0,
  "new_findings_this_run": 0,
  "findings_master_list": [
    {
      "aggregate_id": "AGG-001",
      "source_lens_ids": ["L01-F003", "L04-F012"],
      "merged_from_count": 2,
      "severity": "critical|major|minor|cosmetic",
      "title": "{short}",
      "convergence_signal": false,
      "wedge_vetoed": false,
      "score": 13.0,
      "recommendation": "..."
    }
  ],
  "top_10_finding_ids": ["AGG-001", ...],
  "critical_finding_ids": [],
  "major_finding_ids": [],
  "wedge_vetoes": [],
  "convergence_signals": [],
  "stop_conditions": [],
  "deferrals_logged": [],
  "decisions_logged": []
}
```

## Aggregation guarantees

1. **Every individual lens finding is reachable** — either in the master list (with aggregate ID) or marked resolved / vetoed / out-of-scope. No silent drops.
2. **L28 vetoes are explicit** — never silently remove an L07/L08/L09 finding because L28 said wedge; always show the veto rationale.
3. **Convergence is upweighted** — findings surfaced by 3+ lenses get a 1.5× multiplier (the intentional overlap pays off here).
4. **Stop conditions count** — if a lens couldn't run, that's surfaced in the aggregate (not silently dropped as "0 findings").
5. **Deferrals get revisit triggers** — every deferred finding has a named condition under which it should be re-examined.
6. **Decisions get permanence** — Reject verdicts go to `decision-log.md` so they aren't re-litigated by future audits.

## What the user sees

The user does NOT read 30 markdown reports. They read:
1. The aggregated summary (top 10 + critical list + major triage)
2. Individual lens reports only when drilling into a specific finding (linked from summary)

The aggregation is the user-facing artifact. The lens reports are the source-of-truth drill-down.

## Confirmation gate before fixes

After aggregation:
- Bob presents top 10 + critical list
- `→ HG`: user reviews, marks each item as Fix / Defer / Reject
- Fix items go to a remediation queue (similar to Bob's existing A7i fix register)
- Defer items go to `audit-log.md` with revisit triggers
- Reject items go to `decision-log.md` with rationale

This gate is non-skippable. The aggregation does not auto-route findings to fix queues.
