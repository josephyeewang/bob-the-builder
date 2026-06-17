# Reference Scan — Evolution 003 (E3-pre, per v2.16)

> Scoped scan. One incumbent source dominates the surface (GitHub Spec Kit's `/clarify`), so the scan is narrow and confirmatory rather than broad. Bias-toward-Reject held; the Adopt names its exact insertion point.

## Why this scan fired

EVOLVE adds a **structured coverage instrument** to the spec phase — a new *pattern* (not a new subsystem), which trips the Medium reference-scan trigger. The question being answered: does Bob's Step 1b stress-test reliably catch *structural* spec gaps, and has the field converged on a better instrument for that than Bob's current open-ended 5-area pass?

## The field, mapped

Spec-Driven Development (SDD) is a crowded 2026 category — GitHub Spec Kit (~113K★, official), BMAD-METHOD (~47K★), AWS Kiro, GSD (~61K★), OpenSpec, Tessl. Bob already reference-scanned this category in **v2.16 (F33/F34/F35)** and harvested the `evolutions/{NNN}/` folder idiom from Spec Kit while rejecting its sharded-rules idiom. This scan re-opens *one* surface not previously mined: Spec Kit's **`/clarify` command**.

### What Spec Kit `/clarify` actually does (read in full, `templates/commands/clarify.md`)

1. **A fixed ambiguity taxonomy** — 11 named categories (Functional Scope · Domain & Data Model · Interaction & UX Flow · Non-Functional Quality · Integration & External Deps · Edge Cases & Failure Handling · Constraints & Tradeoffs · Terminology & Consistency · Completion Signals · Misc/Placeholders). Each category is marked **Clear / Partial / Missing** in a coverage map.
2. **Targeted question budget** — at most 5 questions, prioritized by (Impact × Uncertainty), only when the answer materially changes architecture / data model / tasks / tests / UX / ops / compliance.
3. **Non-coder-friendly interaction** — one question at a time; each presented with a **Recommended answer + reasoning** up top, then a 2-5 option table; user can reply with a letter, "yes" to accept the recommendation, or a ≤5-word freeform answer.
4. **Incremental write-back** — each accepted answer is appended to a `## Clarifications` section and immediately applied to the relevant spec section; saved after each answer.

## What Bob already has (de-dup pass)

Bob's Step 1 already covers, via 1a-pre interview + 1a draft: customer, problem, alternatives, non-goals, user scenarios, success metrics, activation, data classification, economics, constraints. Step 1b stress-tests 5 open-ended areas (logical gaps, scope clarity, scenario coverage, constraint realism, missing economics). 1c adversarial + 1d stability loop harden it further.

So Bob is **strong on depth and adversarial pressure** but has **no fixed coverage checklist** — 1b is open-ended, so structural categories can silently fall through (e.g., lifecycle/state transitions, identity/uniqueness rules, integration *failure* modes, conflict-resolution rules, terminology consistency, vague-adjective quantification, acceptance-criteria testability). These are exactly the gaps a named taxonomy catches and an open-ended pass misses.

## Adopt / Defer / Reject

| Source | What it gives | Verdict | Insertion point |
|---|---|---|---|
| **Spec Kit `/clarify` taxonomy (11 categories, Clear/Partial/Missing)** | A fixed coverage instrument that guarantees structural spec categories are each consciously assessed | **ADOPT** | Step 1b — new "Coverage Scan" run before the existing open-ended stress-test; de-duped to a 9-category Bob taxonomy |
| **Targeted-question budget + recommended-default interaction** | Non-coder-friendly resolution of Partial/Missing categories (≤5 Qs, one at a time, recommended answer + accept-with-"yes") | **ADOPT** | Step 1b — resolution loop for Partial/Missing categories materially affecting the build |
| **Incremental write-back to a `## Clarifications` spec section** | Durable, atomic capture of each resolution in the spec file | **ADOPT (light)** | Step 1b — resolutions logged to `docs/decision-log.md` (Bob's existing artifact) + folded into `product-spec.md`; no new section type needed |
| **Spec Kit `/analyze` cross-artifact ID coverage (FR-###/SC-### → task map)** | Stable-ID traceability + zero-task detection | **REJECT (already covered)** | Bob has `templates/capability-traceability-matrix.md` + L02 Spec-Fidelity + Reconciliation; adding IDs here would be sprawl |
| **Spec Kit extension-hook YAML / CLI scaffolding** | Pluggable pre/post hooks, `specify` CLI | **REJECT** | Distribution machinery, not methodology; out of scope for a personal Claude-Code skill (the v2.16 F35 lesson) |

## Distinctness (anti-sprawl gate, per v2.17 meta-finding)

The Coverage Taxonomy is a **spec-phase instrument** — it asks *"does the spec SAY enough?"* It is orthogonal to:
- **L31 Input & Data-Flow Trace** — traces one input *through built code* (a hardening-phase lens, post-build).
- **L02 Spec Fidelity** — checks *built code matches the spec* (post-build).
- **Bob 1a-pre interview** — *elicits* the vision (pre-draft); the taxonomy *audits the drafted spec for structural coverage* (post-draft).

No renumber, no new subsystem, no new file type. One graft into an existing step + one decision-log entry.
