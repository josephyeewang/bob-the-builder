# Evolution 001 — Trace · Process · Present Lenses (L31–L33)

- **Mode:** EVOLVE
- **Classification:** Medium (batch of 3 interdependent lenses — interdependent because they share selection-rubric / aggregation / execution-principle wiring, classified one tier up per the multiple-concurrent-changes rule)
- **Date opened:** 2026-05-29
- **Origin:** Joe's three-part question while reflecting on EMBT audits — gaps in (1) end-to-end user-input-flow tracing, (2) analytical/processing-algorithm quality, (3) audience-appropriate output language.
- **Version target:** v2.21

## What & why

Bob's 30-lens library has three structural gaps, confirmed by tracing each question against the existing lenses (not the changelog):

| # | Gap | Closest existing | Why it doesn't cover it |
|---|---|---|---|
| L31 | Trace a user input flow end-to-end (signup→stored/secured/deduped; credit-pack→redeemed; doc-upload→gender/age→propagated everywhere) | L03 (unidirectional wiring), L05 (privacy) | L03 grades one capability vertically; L05 is PII compliance. Neither traces one field *horizontally across all consumers*. |
| L32 | Analytical depth/method soundness of processing/interpretation/diagnosis/recommendation logic | L11 (AI accuracy) | L11 measures output correctness via evals and is AI-only. Deterministic algorithms uncovered; method *design* soundness uncovered. |
| L33 | In-product output register/jargon-level + house presentation style (e.g. McKinsey structure) | L26 (marketing copy), L18 (i18n) | L26 is marketing surfaces only; L18 is translation readiness. In-product generated output uncovered. |

All three passed the **v2.17 anti-sprawl gate**: each is a distinct validation axis with a named distinctness story (see reference-scan.md), grounded in real frameworks (taint/lineage; SR 11-7 conceptual soundness; ISO 24495 + Minto).

## Scope (in / out)

**In:**
- 3 new lens files following the exact established lens template (frontmatter, question, why-this-exists, when-it-fires, session setup, source_frameworks, audit method, check questions, output schema md+JSON, severity rubric, anti-patterns, stop conditions, cross-lens handoff).
- Wiring into all shared infrastructure so the new lenses are *reachable and consistent*, not orphaned.
- Live count updates 30→33; historical changelog entries left frozen.

**Out (non-goals):**
- No renumbering of L01–L30 (append-only IDs; band is a frontmatter field).
- No new selection *panels* invented beyond adding the new lenses to existing-profile panels where they fit.
- No auto-run; these obey the same Curated/Full-Enchilada selection as every lens.

## Design decisions

- **D-EVO1 — Append-only IDs.** L31 (band 1), L32 (band 3), L33 (band 7). IDs are now creation-order, not band-sorted; `band:` frontmatter handles grouping. Renumbering rejected (blast radius across 30 files + all cross-refs, zero benefit).
- **D-EVO2 — L33 is actionable content, not strategic-veto.** Routed like L26 (real fixes), NOT bucketed with L27/L28 in the v2.19 strategic/non-code bucket. A jargon-laden diagnosis is a fixable defect, not a positioning opinion.
- **D-EVO3 — L32 owns "conceptual soundness" only.** Per SR 11-7's three-pillar split: L32 = conceptual soundness, L11 = outcomes analysis (evals), L16 = ongoing effectiveness. Explicit handoffs prevent overlap-litigation.
- **D-EVO4 — Selection-rubric restraint (anti-sprawl).** New lenses are added to profile panels only where they earn inclusion: L31 → data-heavy / multi-step-flow / regulated profiles; L32 → AI or analytical-engine products (EMBT-like); L33 → consumer / non-technical-audience products. They do NOT bloat the minimal panels (Internal-tool D stays 3 lenses).

## File manifest

**New (3 lenses + 2 planning docs):**
- `audit-lenses/L31-input-data-flow-trace.md`
- `audit-lenses/L32-analytical-method-soundness.md`
- `audit-lenses/L33-output-register-audience-fit.md`
- `evolutions/001-.../reference-scan.md` ✓ (done)
- `evolutions/001-.../spec.md` ✓ (this file)

**Edit (wiring — class-level, single-source-of-truth):**
- `audit-lenses/README.md` — band inventory: L31 under Band 1, L32 under Band 3, L33 under Band 7; "30 lenses" → "33"; Full-Enchilada counts.
- `audit-lenses/_selection-rubric.md` — add new lenses to profile panels per D-EVO4; Full-Enchilada "all 30" → "all 33".
- `audit-lenses/_aggregation.md` — note L32 conceptual-soundness routing; confirm L33 is actionable (not strategic bucket).
- `audit-lenses/_execution-principle.md` — catalog execute/read/human for L31–L33 (v2.17.1 requires every lens be listed); "all 30 lenses" → "all 33".
- `audit-lenses/_audit-memory.md` — Full-Enchilada "all 30" → "all 33" (operational counts only).
- `build-protocol-core.md` — A7 band table (L01–L06 etc.), "30-lens" → "33-lens", footer version.
- `build-protocol.md` — §A7 "30-lens library" → "33"; band list +3; Full-Enchilada count.
- `skill/SKILL.md` — description "30-lens audit library" → "33-lens".
- `README.md` (public) — "30 ready-made audits" → "33" (4 spots); band list.
- `CLAUDE.md` — new v2.21 changelog entry (historical entries frozen).
- `audit-log.md` — log this EVOLVE pass + any deferrals.

**Frozen (do NOT touch — historical record):** all existing CLAUDE.md changelog entries (v2.17/v2.17.1/v2.19); audit-log.md historical sections; illustrative "29 of 30" fresh-session narratives in `_lens-retro.md`/audit-log.md (these describe a past run, not a live count).

## Reconcile / verify (E5)

- Markdown lint: every new lens has all required template sections.
- Cross-ref integrity: every "33" reference consistent; no live "30-lens" left; every new lens ID resolvable from README + rubric.
- Distinctness assertion holds: grep that L31/L32/L33 each declare adjacency to their nearest existing lens.
- audit-log.md updated; CLAUDE.md version = v2.21.
