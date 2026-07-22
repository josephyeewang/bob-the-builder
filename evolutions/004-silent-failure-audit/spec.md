# Evolution 004 — Silent-Failure Audit (Rule 25 / L31 + L32 deepening)

- **Mode:** EVOLVE · **Classification:** Medium (deepens 2 existing lenses + a cross-cutting rule + multi-file wiring; no new lens, no new subsystem)
- **Version:** v2.31 · **Decision:** D-008 · **Date:** 2026-07-22
- **E3-pre Reference Scan:** skipped — this is not a new subsystem/pattern; the "reference" is the InsiderIntent D-267→271 field learning (a lived retro), not an external tool scan. See `reference-scan.md`.

## Trigger

Sequel to v2.30/Rule 24 (D-007). Rule 24 made Bob's audits **fire** at milestones; but across InsiderIntent D-267→271, nearly **every** improvement was surfaced by a founder push-back on a plausible-looking result, and each push uncovered a real defect that every green signal (CI, `fidelity:scan` 23/23, "the job ran") reported healthy. Firing an audit that doesn't know *what to look for* still misses the defect. Joe: *"I don't want to always be the linchpin to catch these."*

## The defect classes harvested (each → a check)

| Real defect (InsiderIntent) | Green said | The check that catches it |
|---|---|---|
| Issuer-blind collapse key blended 13F portfolios (793→47) | lab "ran successfully" | collapse/group key must capture all varying entities; spot-check collapse ratio |
| `move_5d`, `position_type` 100%/near-100% NULL on 285k rows | scan 23/23 | at-rest null-rate census (a ~0% column is a dead axis) |
| "Track-record is anti-predictive" (a selection artifact) | a clean table | split-half / out-of-sample before believing a persistence null |
| "Findings are monolithic" (peak-seeking) | top-20 table | residualize the dominant factor, then re-rank |
| "13F too sparse to test lead-lag" | n<40 | verify RAW volume first (an upstream collapse/backfill bug fakes sparsity) |
| CIK leaked into a `ticker` column → no price join | — | malformed-value passthrough guard at the boundary |

## The change (E4 executed)

- **Rule 25 — Green ≠ Correct** (cross-cutting): the *what-to-catch* complement to Rule 24's *when-to-fire*. Proactive forensics; treat every headline adversarially.
- **L31** — step 4b at-rest null-rate census; canonical defects: aggregation-key blend, malformed-value passthrough; check Qs 12b/12c.
- **L32** — §4b Empirical-Validity Forensics (selection-on-outcome / peak-seeking / sparse≠untestable / crowding-non-monotonicity); finding categories; anti-pattern; check 10b.
- Lens count unchanged (36); rules → 25.

## Wiring (E5 Reconcile checklist)

`build-protocol.md` (changelog row + it defines rules inline) · `build-protocol-core.md` (Rule 25 + footer v2.31) · `CLAUDE.md` (Current Version v2.31 + Key Rule) · `audit-lenses/L31…md` · `audit-lenses/L32…md` · `audit-lenses/_execution-principle.md` (L31/L32 execute rows) · `decision-log.md` (D-008) · `skill/SKILL.md` (description) · `audit-lenses/README.md` + top `README.md` (lens one-liners) · this evolution folder. Coherence sweep (`scripts/coherence-check.sh`) run at close.

## Distinctness (anti-sprawl gate)

- **vs Rule 24 (v2.30):** Rule 24 = *when audits fire* (push, enforced, gate-blocking). Rule 25 = *what a data/analysis audit must catch* (the forensic checks). Complementary, not overlapping.
- **vs L31/L32 pre-existing:** deepens them with specific data-forensic checks the general "trace the flow" / "is the method sound" framings didn't name. No new lens.
