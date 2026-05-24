---
id: L02
name: Spec Fidelity
band: 1
band_name: Engineering Foundation
when_to_run: Always, when a written Product Spec exists. Mandatory before any launch milestone or major-version bump. Skip only if the project has no written spec (and surface that absence as the finding).
estimated_duration: 30-90 min for a Standard project (10-20 capabilities), 2-3 hours for Heavy (40+ capabilities)
session_pattern: fresh session; reads no prior lens reports (this lens establishes the anchor that later lenses reference)
output_markdown: audit-artifacts/L02-spec-fidelity-{YYYY-MM-DD}.md
output_json: audit-artifacts/L02-spec-fidelity-{YYYY-MM-DD}.json
source_frameworks:
  - DLL "Slice 1-6" audit lens (empirical anchor, 2026-05-23 — produced BUILT/PARTIAL/MISSING capability census across 110 capabilities)
  - Qodo PR-Agent `/review` Ticket Analysis (https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/tools/review.md)
  - ISO 25010:2023 Functional Suitability sub-characteristic (completeness, correctness, appropriateness)
  - Bob's existing Capability Traceability Matrix (CTM) pattern (templates/capability-traceability-matrix.md)
---

# L02 — Spec Fidelity

## Question this lens answers

*Did we build what we said we'd build — every capability declared in the Product Spec, Behavioral Core, and Domain Specs, with the right copy, the right behavior, and no unspecced silent additions?*

## Why this lens exists / what other lenses miss

Engineering-hygiene audits (L01 Hygiene & Liveness, CodeRabbit, Greptile, lint, type-check) answer *"does the code work?"* — they don't answer *"is it what we said we'd build?"* A capability can pass every engineering audit and still be missing from the product, hollow (exists but unwired), or quietly different from the spec. The DLL audit found 13 PARTIAL + 2 MISSING capabilities in the core loop alone, plus 4 unspecced silent behaviors (duplicate detection, memory decay, confidence adjustments, language detection using script-ratio instead of spec'd NLP confidence). None of these are bugs by engineering standards — they're spec-code divergences. This lens makes that divergence explicit.

The complementary failure mode: **spec drift in the other direction** — the spec says X, the build does Y, and the spec was never updated. Spec Fidelity flags both directions, not just "build missed spec."

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — if a Product Spec exists.
- ✅ Mandatory — before any launch milestone, major-version bump, hand-off to investors/partners, or public release.
- ⏸ Skip only if the project has no written Product Spec. **In that case, the absence IS the finding** — write a single-line report: *"L02 not runnable. No Product Spec found. Foundational gap — every downstream lens is judging against an undefined target. Recommend writing the Product Spec before any further audits."*

## Session setup

- Start a **fresh Claude Code session.** Do not run in the same session that just built or remediated capabilities — the writer/reviewer pattern matters here. The writer rationalizes; the reviewer counts.
- Inputs to load in this session:
  - `docs/product-spec.md` (or equivalent — the spec is the anchor)
  - `docs/behavioral-core.md` (AI products only)
  - `docs/architecture-contract.md`
  - `docs/domain-specs/*.md`
  - `docs/build-manifest.md` (for phase-status of each capability)
  - `templates/capability-traceability-matrix.md` if a CTM exists
  - The actual code surfaces — read enough to verify each spec claim, not just the spec
- No tooling install required. This lens is human-reasoning-driven, not tool-orchestrated.
- Do **not** read prior lens reports. L02 is the anchor for downstream lenses; reading other lenses first contaminates the spec-vs-built mental model.

## Source frameworks

- **DLL "Slice 1-6" audit lens** (Joe Wang, 2026-05-23) — empirical anchor. The methodology: read spec end-to-end, slice into 6 thematic groups of ~15-20 capabilities each, methodically check each one against code as BUILT / PARTIAL / MISSING with a one-line note. Produces a full census, not a sample.
- **Qodo PR-Agent `/review` Ticket Analysis** — the only commercial AI review tool that checks PR-vs-ticket fidelity. https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/tools/review.md
- **ISO/IEC 25010:2023 Functional Suitability** — functional completeness, correctness, appropriateness. https://www.iso.org/standard/78176.html
- **Bob's Capability Traceability Matrix** — the structural pattern this lens generalizes. `templates/capability-traceability-matrix.md`.

## Audit method

1. **Inventory every capability claim.** Read the Product Spec, Behavioral Core, Architecture Contract, and Domain Specs end-to-end. Extract every distinct capability claim into a numbered list. A capability is anything the spec says the product *does, has, supports, handles, or guarantees.* Include behavioral claims ("the system never asks the same question twice"), copy claims ("the welcome SMS includes a reassurance about STOP"), and architectural claims ("memory decays after 90 days of inactivity").

   Target census size: 50-150 capabilities for a Standard project. If you produce fewer than 30, you're under-extracting — the spec has more claims than you're capturing. If you produce more than 200, you're double-counting — collapse near-duplicates.

2. **For each capability, verify against code.** Open the relevant code and check. Mark each as:
   - **BUILT** — exists in code, wired into a user-reachable path, matches the spec's intent.
   - **PARTIAL** — exists but incomplete (e.g., capability is half-implemented, wired only in one direction, has a known TODO, or matches spec but with degraded behavior).
   - **MISSING** — spec claims it; code does not contain it.
   - **DRIFT** — exists, but differs from spec in a non-trivial way (different mechanism, different copy, different default).

3. **Inventory unspecced silent behaviors.** Scan the codebase for capabilities the *code* implements that the *spec* does not mention. Common patterns: silent duplicate detection, auto-recovery from session loss, implicit verbosity adjustment, retry logic, fallback behaviors. For each, mark as:
   - **UNSPECCED (intentional)** — likely a load-bearing implementation detail that should be added to the spec.
   - **UNSPECCED (accidental)** — silent behavior that may surprise users; needs explicit spec coverage or removal.

4. **Inventory copy claims separately.** Any spec text that quotes specific user-visible strings (welcome SMS copy, error messages, button labels, email subject lines, system prompts for AI products) gets verified literal-character-by-literal-character. Copy DRIFT is a category of its own — it's the cheapest to find and the most user-visible.

5. **Score the highest-leverage gaps.** Identify the top 3 BUILT/PARTIAL/MISSING/DRIFT findings ranked by user-impact × persistence × strategic-importance. Top-3 is enough; do not rank all findings — that produces noise.

## Check questions

1. Does a written Product Spec exist? If no — stop, surface that as the finding.
2. Have you extracted ≥30 distinct capability claims? If fewer, you're under-extracting.
3. For every capability, can you cite the *exact file path and line* where it's implemented (or confirm it's MISSING)?
4. For PARTIAL capabilities, is there a TODO/known-issue marker in code, or is the partiality silent?
5. For MISSING capabilities, is each one in the Build Manifest as a planned future phase, or is it forgotten?
6. For DRIFT findings, is the spec wrong or is the code wrong? (Often the spec — but name which one is the source of truth.)
7. Have you scanned for **unspecced silent behaviors**? Open the main pipeline files and ask "is every behavior here covered by spec?"
8. Have you verified literal copy text for every user-visible string the spec quotes?
9. Are there capabilities that exist in code, work correctly, but are *never reachable* from any user path? (Wired-but-orphaned — overlaps with L01 Liveness but Spec Fidelity catches the *intent* gap, L01 catches the *execution* gap.)
10. For AI products: does every behavior in the Behavioral Core have a corresponding eval case in `evals/behavioral-core.yaml`? If a behavior has no eval, it's untested even if implemented.
11. Are there capabilities in the spec that, on inspection, you don't believe the team actually intends to build — but they're still in the spec? (Aspirational spec drift — the spec should be pruned, not the code added.)
12. Top 3 highest-leverage gaps named?

## Output schema

### Markdown report (`audit-artifacts/L02-spec-fidelity-{YYYY-MM-DD}.md`)

```markdown
# L02 — Spec Fidelity — {YYYY-MM-DD}

## Census summary
- Total capabilities extracted: N
- BUILT: X (Y%)
- PARTIAL: X (Y%)
- MISSING: X (Y%)
- DRIFT: X (Y%)
- UNSPECCED behaviors found: X

## Capability matrix
| # | Capability (one-line) | Source doc + section | Status | Evidence (path:line) | Notes |
|---|---|---|---|---|---|
| 1 | [claim] | product-spec.md §3.2 | BUILT | src/intake.ts:42 | matches spec |
| 2 | [claim] | behavioral-core.md §1 | PARTIAL | src/ai/route.ts:18 | only handles 2 of 3 tri-band routes |
| 3 | [claim] | product-spec.md §2.1 | MISSING | — | scheduled Phase 4 per build-manifest |
| 4 | [claim] | product-spec.md §4.3 | DRIFT | src/lang/detect.ts:12 | spec says NLP confidence; code uses regex script-ratio |

## Copy claims
| # | Spec text (literal) | Code text (literal) | Match? | Path |
|---|---|---|---|---|
| 1 | "STOP at any time. We won't text again." | "Reply STOP to opt out." | DRIFT | src/copy/sms.ts:8 |

## Unspecced silent behaviors
| # | Behavior | Code location | Intentional? | Recommendation |
|---|---|---|---|---|
| 1 | Duplicate task auto-collapse | src/intake.ts:67 | intentional | Add to product-spec.md §3.2 |

## Top 3 highest-leverage findings
1. **{Finding title}** — Severity: {Critical/Major/Minor}. {1-paragraph rationale + recommended action.}
2. ...
3. ...

## Stop conditions encountered
{Any cases where the lens could not produce signal — name them honestly.}
```

### JSON sidecar (`audit-artifacts/L02-spec-fidelity-{YYYY-MM-DD}.json`)

```json
{
  "lens_id": "L02",
  "lens_name": "Spec Fidelity",
  "run_date": "YYYY-MM-DD",
  "project": "{project name}",
  "schema_version": "1.0",
  "census": {
    "total_capabilities": 0,
    "built": 0,
    "partial": 0,
    "missing": 0,
    "drift": 0,
    "unspecced": 0
  },
  "findings": [
    {
      "id": "L02-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "missing|partial|drift|unspecced|copy_drift|aspirational",
      "title": "{short title}",
      "capability": "{capability name from matrix}",
      "spec_source": "{doc + section}",
      "code_evidence": "{path:line or '—' if missing}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}"
    }
  ],
  "top_findings": ["L02-F001", "L02-F007", "L02-F003"],
  "stop_conditions": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Capability is MISSING and the spec explicitly promises it to users (e.g., DLL's `undo` was in the welcome SMS but not implemented — every user is told a feature exists that doesn't). Also: DRIFT in copy that creates legal exposure (privacy claims, compliance claims, refund promises, opt-out paths).
- **Major** — Capability is PARTIAL but reaches users (e.g., binary routing where spec says tri-band). Also: UNSPECCED behavior that affects user trust (e.g., silent auto-collapse without notification).
- **Minor** — DRIFT in copy that's not user-promised behavior (e.g., spec quote slightly different from button label). Also: UNSPECCED intentional behavior that should be in the spec for completeness.
- **Cosmetic** — Documentation-only inconsistency where neither user nor developer is affected (e.g., spec uses "task" and code uses "item" but they refer to the same thing and no user-visible string is wrong).

## Anti-patterns / Bias instructions

- **Do NOT score every gap as Critical.** A 50-finding report where 30 are Critical is calibration failure. Critical should be ≤10% of findings in a typical run.
- **Do NOT invent capabilities the spec doesn't claim.** If the spec is silent on something, that's a UNSPECCED finding, not a MISSING finding. The distinction matters — MISSING means promised-but-absent; UNSPECCED means present-but-undeclared.
- **Do NOT skim.** Spec Fidelity is the one lens where you must literally read every paragraph of the spec end-to-end. Skimming produces false BUILTs (you marked something built because you saw a related function name, not because you verified the behavior).
- **Do NOT re-litigate L01 findings.** If L01 flagged a function as dead-on-arrival, that's a Liveness finding, not a Spec Fidelity finding. Spec Fidelity asks "does the spec claim this?" not "does it run?" — different question.
- **Do NOT push remediation in this lens's output.** Findings get logged; the fix-vs-defer decision happens at the aggregation step (`_aggregation.md`) with the human in the loop. Surface; do not prescribe.
- **Bias toward strict reading of the spec.** When in doubt about whether a capability matches its spec claim, mark DRIFT and let the human adjudicate. Lenient reading produces silent rot.

## Stop conditions (the gap IS the finding)

1. **No Product Spec exists.** Write a single-paragraph report stating this is a foundational gap. Stop. Recommend writing the spec before any further audits.
2. **Product Spec exists but contains <5 capability claims.** Under-developed spec. Write the finding, recommend a spec-stress-test pass (Bob NEW mode Step 1b), and stop.
3. **Code is too large to fully verify in one session.** If the codebase has 1000+ files and a full pass would take >4 hours, split the audit by domain (one Spec Fidelity run per domain spec). Do not produce a partial census silently — name the scoping decision in the report header.
4. **Capabilities cannot be located in code despite the spec claim, AND there's no Build Manifest entry indicating it's planned.** That's a MISSING finding, not a stop condition — but flag it for the user explicitly because it suggests the build is more divergent from the spec than the team realizes.

## Cross-lens handoff

- **Upstream (lenses that should run BEFORE L02):** None. L02 is the anchor for the engineering-foundation band.
- **Downstream (lenses that USE L02's output):**
  - **L03 Critical Capability Quality** — takes L02's BUILT list, picks the 30-50 most critical, and grades each one A/B/C. L02 says "exists"; L03 says "exists how well."
  - **L21 Observability & Incident Readiness** — verifies that every BUILT capability is observable in prod (logs, metrics, traces).
  - **L24 Competitive Benchmarking** — cross-references the capability census against competitor feature lists.
- **Adjacent lenses with intentional ~15% overlap:**
  - **L01 Hygiene & Liveness** — overlaps on the "dead code" question. L01 catches *unreachable*; L02 catches *unspecced or specced-but-missing.* Both can flag the same function; aggregation deduplicates.
  - **L26 Marketing, Copy & Website** — overlaps on copy-claim verification. L02 verifies internal-spec-vs-code copy; L26 verifies marketing-surface copy vs the product itself. Different surfaces, same skill.
