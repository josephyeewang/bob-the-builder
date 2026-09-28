# Evolution 004 — Silent-Failure Audit (Rule 25 / L31 + L32 deepening)

- **Mode:** EVOLVE · **Classification:** Medium (deepens 2 existing lenses + a cross-cutting rule + multi-file wiring; no new lens, no new subsystem)
- **Version:** v2.31 · **Decision:** D-008 · **Date:** 2026-07-22
- **E3-pre Reference Scan:** skipped — this is not a new subsystem/pattern; the "reference" is the InsiderIntent field learning (a lived retro), not an external tool scan. See `reference-scan.md`.

## Trigger

Sequel to v2.30/Rule 24 (D-007). Rule 24 made Bob's audits **fire** at milestones; but across a run of InsiderIntent sessions, nearly **every** improvement was surfaced by a founder push-back on a plausible-looking result, and each push uncovered a real defect that every green signal (CI, a data-health scan with all checks passing, "the job ran") reported healthy. Firing an audit that doesn't know *what to look for* still misses the defect. Joe: *"I don't want to always be the linchpin to catch these."*

## The defect classes harvested (each → a check)

| Real defect (InsiderIntent) | Green said | The check that catches it |
|---|---|---|
| A collapse key omitting a varying entity blended many distinct records into a few | analysis "ran successfully" | collapse/group key must capture all varying entities; spot-check collapse ratio |
| Two analysis columns 100%/near-100% NULL across the table | health scan all-passing | at-rest null-rate census (a ~0% column is a dead axis) |
| A "no signal / anti-predictive" null drawn from selecting on outcomes (a selection artifact) | a clean table | split-half / out-of-sample before believing the null |
| "Findings are monolithic" (peak-seeking) | top-N table | control for the dominant factor, then re-rank |
| "Too sparse to test" | small n | verify RAW volume first (an upstream collapse/backfill bug fakes sparsity) |
| An identifier of one kind leaked into a column meant for another → a downstream join silently failed | — | malformed-value passthrough guard at the boundary |

## The change (E4 executed)

- **Rule 25 — Green ≠ Correct** (cross-cutting): the *what-to-catch* complement to Rule 24's *when-to-fire*. Proactive forensics; treat every headline adversarially.
- **L31** — step 4b at-rest null-rate census; canonical defects: aggregation-key blend, malformed-value passthrough; check Qs 12b/12c.
- **L32** — §4b Empirical-Validity Forensics (selection-on-outcome / peak-seeking / sparse≠untestable / non-monotonic effects); finding categories; anti-pattern; check 10b.
- Lens count unchanged (36); rules → 25.

## Wiring (E5 Reconcile checklist)

`build-protocol.md` (changelog row + it defines rules inline) · `build-protocol-core.md` (Rule 25 + footer v2.31) · `CLAUDE.md` (Current Version v2.31 + Key Rule) · `audit-lenses/L31…md` · `audit-lenses/L32…md` · `audit-lenses/_execution-principle.md` (L31/L32 execute rows) · `decision-log.md` (D-008) · `skill/SKILL.md` (description) · `audit-lenses/README.md` + top `README.md` (lens one-liners) · this evolution folder. Coherence sweep (`scripts/coherence-check.sh`) run at close.

## Distinctness (anti-sprawl gate)

- **vs Rule 24 (v2.30):** Rule 24 = *when audits fire* (push, enforced, gate-blocking). Rule 25 = *what a data/analysis audit must catch* (the forensic checks). Complementary, not overlapping.
- **vs L31/L32 pre-existing:** deepens them with specific data-forensic checks the general "trace the flow" / "is the method sound" framings didn't name. No new lens.
