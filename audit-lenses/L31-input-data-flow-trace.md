---
id: L31
name: Input & Data-Flow Trace
band: 1
band_name: Engineering Foundation
when_to_run: Any product with user input flows that fan out across the system — signup/account, document/file upload, purchases or credits, profile/preference data that downstream features depend on. Skip pure read-only / static products. Mandatory before launch for any product whose value depends on user-supplied data reaching the right places.
estimated_duration: 60-150 min — one flow traced end-to-end at a time; field-level for the critical 3-6 flows
session_pattern: fresh session; reads L02 (Spec Fidelity) and L03 (Critical Capability Quality) if available; hands findings to L05 (Privacy) for any sensitive field
output_markdown: audit-artifacts/L31-input-data-flow-trace-{YYYY-MM-DD}.md
output_json: audit-artifacts/L31-input-data-flow-trace-{YYYY-MM-DD}.json
source_frameworks:
  - Taint tracking / static + dynamic data-flow analysis (entry → processing → sink)
  - Column-level / field-level data lineage (IBM, Acceldata) — prove where each field goes
  - STRIDE per-element Data-Flow Diagram (DFD) decomposition — trust boundaries
  - Static taint analysis for privacy (arXiv 1608.04671)
  - GDPR Art.30 Record of Processing / PCI-DSS data-flow mapping (the "why" for sensitive fields)
  - Bob's own Engineering Principle #2 — "Trace End-to-End: input → output before fixing"
---

# L31 — Input & Data-Flow Trace

## Question this lens answers

*Take a real user input flow — signing up, uploading a document, buying a credit pack, entering profile data — and trace it all the way through. Does every field land where it should, get stored / secured / deduplicated / validated, reach every downstream consumer that ought to use it, and resolve every terminal state (redeemed, expired, refunded, deleted)? Or does some field get captured at the front door and silently dropped before it reaches the features that depend on it?*

## Why this lens exists / what other lenses miss

L02 (Spec Fidelity) asks "does the capability exist?" L03 (Critical Capability Quality) asks "is this *one* capability A-grade?" — both look *vertically*, one capability at a time. Neither follows a single **input or data field horizontally across the whole system** to confirm it is handled at every step and reaches every place that needs it.

This is the failure mode Joe named on EMBT: a medical document upload extracts **age and gender**, but those fields are used at intake and *never threaded through* the scoring / diagnosis / recommendation engines that should weight them. Every individual capability passes its own audit. The *flow* is broken in the seams between them — exactly where no per-capability lens looks.

The pattern generalizes far past health:
- **Signup / account:** is the account actually created, the password hashed, the email **deduplicated** (or can one email register twice?), the verification state persisted, the session issued, the "deleted" path real?
- **Credit pack / purchase:** is the purchase stored, the balance incremented atomically, **redemption** decremented exactly once (no double-spend, no race), expiry honored, refund reversible, and is the whole thing reconcilable?
- **Uploaded data:** is every extracted field validated, stored, **propagated to every consumer the spec implies**, and surfaced back to the user?

This is taint tracking applied to product correctness rather than security: follow the data from its **entry point**, through every **processing** step, to every **sink** — and flag the consumers that should be sinks but aren't. It is also Bob's own Engineering Principle #2 ("Trace End-to-End") finally promoted from a build discipline to an audit lens.

## When this lens fires

**Always-in-Full-Enchilada for data-driven products.** Curated panel inclusion criteria:
- ✅ Mandatory — products where user-supplied data must reach downstream features to deliver value (health, finance, personalization, anything with a profile that feeds scoring/AI).
- ✅ Mandatory — any product with money/credits/quota flows (redemption correctness is a money bug).
- ✅ Strongly recommended — any product with signup/account/upload flows before launch.
- ⏸ Skip — read-only / static / stateless products with no meaningful user input fan-out.

## Session setup

- Start a **fresh Claude Code session.**
- Read L02 (capability census — tells you which flows exist) and L03 (quality grades — tells you which capabilities the flow passes through) if available.
- Inputs to load:
  - Product Spec — the *intended* flows and which features each field should feed.
  - Code — entry points (route handlers, form submit, upload handlers, webhook receivers), the data layer (schema/migrations/ORM models), and every consumer that reads the field.
  - DB schema / migrations — the storage truth.
  - The running app — this lens **executes** (see Execution Principle): submit a real input and watch where it lands.
- Tooling (orchestrate, don't reinvent):
  - DB client / `psql` / Prisma Studio / Supabase table view — confirm what's actually stored.
  - Browser DevTools + Playwright — drive the real flow end-to-end.
  - `grep` / language server "find references" — find every reader of a field.
  - Optional static taint tools (CodeQL dataflow queries, Semgrep taint mode) where available.

## Source frameworks

- **Taint tracking / data-flow analysis** — trace untrusted/user input from entry point through processing to sinks; the sink set reveals where data is consumed and where it's silently dropped.
- **Column-level data lineage** (IBM, Acceldata) — field-level "where is this specific value stored and how was it processed," not table/feature granularity.
- **STRIDE per-element DFD** — decompose the flow into external entities → processes → data stores, and mark every **trust boundary** the data crosses (each boundary is a validation/auth checkpoint).
- **Static taint analysis for privacy** — arXiv 1608.04671.
- **GDPR Art.30 RoPA / PCI-DSS data-flow mapping** — the regulatory "why" for sensitive-field completeness; hand the actual privacy verdict to L05.
- **Engineering Principle #2 (Trace End-to-End)** — Bob's own build rule, now an audit.

## Audit method

1. **Enumerate the input flows.** From the Product Spec + entry-point grep, list every distinct user input flow (signup, login, upload, purchase, redeem, profile edit, settings, etc.). Pick the **critical 3-6** by user-impact / money-impact / value-impact. Trace those field-level; list the rest for a later pass.

2. **Per flow, draw the intended flow (DFD).** Entry point → validation → storage → each downstream consumer → terminal state(s). Mark trust boundaries (auth, input sanitization, payment). This is the *spec* of where the data should go.

3. **Build the field-propagation matrix.** For each meaningful field the flow captures (e.g. `email`, `password`, `age`, `gender`, `creditBalance`, `uploadedDocText`), list **every consumer the spec implies should use it**, then check the code for whether it actually does:

   | Field | Captured at | Stored? | Validated? | Consumer A (expected) | Consumer B (expected) | … | Gap |
   |---|---|---|---|---|---|---|---|
   | age | upload parse | ✅ profiles.age | ✅ | scoring engine ✅ | recommendation ❌ DROPPED | | propagation gap |

4. **Execute the flow, don't just read it.** Submit a real input through the running app. Then query the DB / inspect each consumer to confirm the field actually arrived and is the right value — not just that a write *appears* to exist in source. (Source can lie: the field is in the payload, the insert omits it.)

5. **Check the lifecycle / terminal states per flow.** Every flow has end-states that must each be handled:
   - **Account:** created · verified · logged-in · password-reset · **deduplicated** (same email twice?) · suspended · **deleted** (real delete or orphaned rows?).
   - **Credits/money:** purchased · balance updated atomically · **redeemed exactly once** (race / double-spend?) · expired · refunded (reversible & reconcilable?) · negative-balance guarded?
   - **Upload:** received · parsed · validated · stored · propagated · re-downloadable · deletable.
   Each unhandled terminal state is a finding.

6. **Hunt the four canonical flow defects:**
   - **Propagation gap** — field captured & stored but never reaches a consumer the spec implies (the EMBT age/gender case).
   - **Dedup/uniqueness gap** — no uniqueness constraint where one is required (duplicate accounts, double-applied credits).
   - **Atomicity/race gap** — read-modify-write on balance/quota without a transaction or constraint (double-spend, lost update).
   - **Orphan/leak gap** — delete/cancel path leaves rows, files, or references behind (data outlives its terminal state).

7. **Confirm validation at every trust boundary.** Each boundary the data crosses (entry, storage, cross-service) should validate type/range/authorization. A field that's validated at intake but trusted blindly by a downstream consumer is a finding.

8. **Rank by blast radius.** A dropped field on a core value path (diagnosis quality) or a money race (double-redeem) outranks a cosmetic propagation gap. Rank top 3 by user/money-impact × likelihood.

## Check questions

1. Have you listed every user input flow and picked the critical 3-6 to trace field-level?
2. For each critical flow, have you drawn the intended DFD with trust boundaries marked?
3. For each meaningful field, have you built the propagation matrix and checked every *expected* consumer against the code?
4. Did you **execute** the flow (submit real input → query the DB / consumers) rather than only reading source?
5. Account flow: is the dedup/uniqueness constraint real (try registering the same email twice)?
6. Account flow: does "delete account" actually delete (no orphaned rows/files/sessions)?
7. Money/credit flow: is redemption atomic and exactly-once under concurrency (no double-spend)?
8. Money/credit flow: are expiry, refund, and negative-balance all handled?
9. Upload flow: is every extracted field propagated to every consumer the spec implies (the age/gender test)?
10. Is each field validated at every trust boundary it crosses, not just at intake?
11. For any sensitive field (PII/PHI/payment), have you handed the storage/security specifics to L05?
12. Are there silent drops — fields present in the request payload but absent from the insert/update?
13. Are there orphan/leak gaps where a terminal state leaves data behind?
14. What's the single highest-blast-radius flow defect?

## Output schema

### Markdown report

```markdown
# L31 — Input & Data-Flow Trace — {YYYY-MM-DD}

## Flows traced
| # | Flow | Critical? | Fields traced | Terminal states checked |
|---|---|---|---|---|

## Field-propagation matrix (per critical flow)
### Flow: {name}
| Field | Captured at | Stored (location) | Validated? | Expected consumers | Reached? | Gap |
|---|---|---|---|---|---|---|

## Lifecycle / terminal-state coverage
| Flow | State | Handled? | Evidence | Finding? |
|---|---|---|---|---|

## Canonical flow defects found
| # | Type (propagation/dedup/atomicity/orphan) | Flow | Field | Evidence (path:line + DB check) | Impact |
|---|---|---|---|---|---|

## Top 3 highest-blast-radius findings
1. ...

## Findings (full, severity-tagged)

## Handed to L05 (sensitive fields)
| Field | Flow | Why flagged |
|---|---|---|

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L31",
  "lens_name": "Input & Data-Flow Trace",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "flows_traced": 0,
  "fields_traced": 0,
  "propagation_gaps": 0,
  "dedup_gaps": 0,
  "atomicity_gaps": 0,
  "orphan_gaps": 0,
  "terminal_states_unhandled": 0,
  "executed_against_running_app": false,
  "findings": [
    {
      "id": "L31-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "propagation_gap|dedup_gap|atomicity_race|orphan_leak|unhandled_terminal_state|missing_validation_boundary|silent_field_drop",
      "title": "{short}",
      "flow": "{flow name}",
      "field": "{field name or n/a}",
      "expected_consumer": "{where it should have reached}",
      "evidence": "{path:line + DB/exec observation}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}",
      "handed_to": "L05|null"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Money/credit atomicity race or double-spend. A core-value field dropped before reaching the engine that defines product quality (EMBT age/gender → diagnosis). Account dedup absent on a public signup (duplicate-identity / takeover surface). "Delete" that doesn't delete regulated data.
- **Major** — Propagation gap on a non-core but spec-implied consumer. Missing validation at a downstream trust boundary. Unhandled refund/expiry on a money flow. Orphaned rows/files on cancel.
- **Minor** — Propagation gap on a low-impact consumer. Terminal state handled but without user visibility. Validation present but weaker than spec.
- **Cosmetic** — Redundant re-validation; trace documentation gaps.

## Anti-patterns / Bias instructions

- **Do NOT trace from source alone.** Source shows intent; the DB and the running consumers show truth. Submit the input and verify where it lands. A field in the payload is not a field in the database.
- **Do NOT confuse "the capability works" with "the field arrived."** L03 already graded the capability. L31's job is the *seam between* capabilities — the field that's fine on both ends but lost in transit.
- **Do NOT trace more than 6 flows field-level in one run.** Beyond that, fidelity drops. Pick the critical flows; list the rest for next cycle (and say so — no silent truncation).
- **Do NOT re-audit privacy here.** Flag sensitive fields and hand them to L05; L31 owns *completeness of propagation*, L05 owns *protection*.
- **Bias toward "what does the spec promise this field would do, and does it?"** A field that's captured because it *looks* useful but the spec never said it feeds anything isn't a gap — it's scope. The gap is the spec-implied consumer that never got wired.

## Stop conditions (the gap IS the finding)

1. **No user input flows.** Read-only/static product. Skip and note.
2. **Cannot execute the flow** (no running env, no DB access). Trace statically, report what could not be verified live, and recommend re-running L31 in an environment where the flow can be exercised — do NOT claim a field arrived without observing it.
3. **No spec for intended consumers.** If the spec never says where a field should go, L31 can't judge propagation completeness. Flag as an L02 spec-gap and trace only the flows with a clear intended fan-out.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (which flows/consumers should exist), L03 Critical Capability Quality (per-capability grades).
- **Downstream:**
  - **L05 Data Protection & Privacy** — every sensitive field L31 traces is handed to L05 for storage/encryption/retention review.
  - **L32 Analytical Method Soundness** — if a field reaches an analytical engine, L32 then judges whether it's *weighted soundly*; L31 only confirms it arrived.
  - **L10 UX Edge States** — unhandled terminal states are also recovery-UX findings.
  - **L21 Observability** — atomicity/race gaps need instrumentation to catch in prod.
- **Adjacent (~15% overlap):**
  - **L03** — both touch capability wiring, but L03 grades one capability's quality; L31 traces one field across many. Aggregation dedups on the seam vs. the node.
  - **L04 Security** — taint analysis overlaps; L04 owns injection/exploit sinks, L31 owns correctness/completeness sinks.
