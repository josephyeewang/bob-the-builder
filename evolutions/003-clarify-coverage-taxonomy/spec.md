# Evolution 003 — Spec Coverage Taxonomy (Step 1b)

- **Mode:** EVOLVE
- **Classification:** Medium (new *pattern* in the spec phase; reference scan fired → confirmatory, one dominant incumbent)
- **Date opened:** 2026-06-16
- **Origin:** Joe — during a deep comparison of Bob vs. GitHub Spec Kit, the one genuine instrument gap surfaced: Spec Kit's `/clarify` runs a fixed 11-category ambiguity taxonomy (Clear/Partial/Missing), where Bob's Step 1b stress-test is open-ended and can let structural categories slip through.
- **Version target:** v2.25

## What & why

Bob's Step 1 is deep (interview → draft → stress-test → adversarial → stability loop) but its 1b Stress-Test is **open-ended** — 5 focus areas assessed by judgment, with no fixed checklist. Open-ended passes reliably catch the *obvious* gaps and reliably miss the *structural-but-unglamorous* ones: lifecycle/state transitions, identity/uniqueness rules, integration **failure** modes, conflict-resolution rules, terminology consistency, un-quantified vague adjectives ("fast", "intuitive"), and acceptance-criteria testability.

Spec Kit (GitHub's official SDD tool, ~113K★) converged on a **named coverage taxonomy** for exactly this. Adopting it as a checklist *complements* — does not replace — Bob's open-ended stress-test and adversarial pressure. It's the same move Bob's audit lenses make for the build phase (a fixed coverage instrument so a non-engineer doesn't have to invent the checklist each time), applied one phase earlier.

## Scope (in / out)

**In:**
1. A **9-category Spec Coverage Taxonomy** added to Step 1b, each category marked **Clear / Partial / Missing** against the drafted spec (de-duped from Spec Kit's 11 to drop categories Bob's 1a/1a-pre already guarantees).
2. A **targeted-question resolution loop** for Partial/Missing categories that materially affect the build — ≤5 questions, one at a time, each with a **recommended default + reasoning** (accept with "yes"), in keeping with Narrator Mode and the non-coder ergonomics.
3. Resolutions folded into `product-spec.md` and logged to `docs/decision-log.md`.
4. Wiring: `build-protocol.md` Step 1b, `build-protocol-core.md` (Step 1 line + version footer), `CLAUDE.md` (changelog + Current Version), `skill/SKILL.md` (one clause), `decision-log.md` (design decision).

**Out (non-goals):**
- No stable FR-###/SC-### IDs or task-coverage map (already covered by `capability-traceability-matrix.md` + L02 + Reconciliation — adding here = sprawl).
- No new spec-file *section type* or new artifact file (reuse `product-spec.md` + `decision-log.md`).
- No CLI / extension-hook machinery (distribution, not methodology — F35 lesson).
- No change to 1a-pre, 1a, 1c, or 1d. The taxonomy slots into 1b only.
- No renumbering; no new audit lens.

## The 9-category Spec Coverage Taxonomy

| # | Category | What "Missing" looks like | Already partly covered by |
|---|---|---|---|
| 1 | **Functional scope & roles** | core goals or actor distinctions unstated | 1a-pre Q1, non-goals |
| 2 | **Domain & data model** | entities, identity/uniqueness rules, **lifecycle/state transitions**, scale assumptions unstated | data classification (partial) |
| 3 | **Interaction & flow** | critical journeys, **error/empty/loading states**, a11y/i18n notes unstated | scenarios (partial) |
| 4 | **Non-functional targets** | perf/reliability/observability/security/compliance targets unstated or un-quantified | data classification, constraints (partial) |
| 5 | **Integrations & failure modes** | external services named but **failure behavior** (timeout, 429, down) unstated | — (common gap) |
| 6 | **Edge cases & conflict resolution** | negative scenarios, rate limits, **concurrent/conflicting actions** unresolved | stress-test 1b (partial) |
| 7 | **Constraints & rejected alternatives** | hard constraints or explicitly-rejected options unstated | constraints (partial) |
| 8 | **Terminology consistency** | same concept named ≥2 ways; no canonical term | — (common gap) |
| 9 | **Completion signals** | acceptance criteria not testable; vague adjectives un-quantified ("fast", "robust") | success metrics (partial) |

Many categories will already be **Clear** from 1a-pre + 1a — that's expected and fine. The instrument's value is forcing a conscious Clear/Partial/Missing verdict on each, so the *unglamorous* ones can't silently fall through.

## Design decisions

- **D-EVO9 — Checklist complements, never replaces, the open-ended pass.** The Coverage Scan runs *first* in 1b; the existing 5 open-ended focus areas still run after. A fixed taxonomy catches structural omissions; open-ended + adversarial catches the non-obvious. Keep both.
- **D-EVO10 — De-dup to 9, don't import all 11.** Spec Kit's "Misc/Placeholders" folds into category 9; its split of scope vs. roles folds into category 1. Importing verbatim would double-count what 1a-pre already elicits.
- **D-EVO11 — Recommended-default questioning, capped at 5.** Resolution loop reuses Spec Kit's non-coder UX (one Q at a time, recommended answer + accept-with-"yes") because it matches Narrator Mode; capped at 5 so 1b doesn't balloon into a second interview.
- **D-EVO12 — Reuse existing artifacts.** Resolutions go to `product-spec.md` + `decision-log.md`; no new `## Clarifications` section type and no new file. Single-source-of-truth discipline.

## Reconcile / verify (E5)

- Step 1b contains the 9-category taxonomy with explicit Clear/Partial/Missing verdicts + a capped resolution loop.
- Distinctness from L31 / L02 / 1a-pre declared in `reference-scan.md` and honored (no overlap added).
- Version = v2.25 across `build-protocol-core.md` footer + `CLAUDE.md` Current Version; changelog entry added; historical entries frozen.
- No new file type; no renumber; no lens-count change (stays 34).
