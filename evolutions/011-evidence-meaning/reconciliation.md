# Reconciliation

## Delivered behavior

Two existing checkers now refuse unsupported success: unavailable requested specification/source input and task coverage backed by a failed, stale, incomplete or mismatched report. Legacy coverage remains compatible and explicitly does not establish report verification. Source checks state their lexical limits. Report producers must still derive their verdict from actual assertions.

Existing templates and lenses now carry workload applicability, usefulness controls, original-source read depth, inferred-field authority, meaning-preserving round trips, compatible rollback, primary-completion reserves, upstream independence and validated confidence claims. No new panel, duplicate lesson store or fixed audit-round cap was introduced.

## Verification

- 36 Python tests pass: 17 specification-audit tests and 19 coverage-check tests, with real CLI negative cases and clean controls. Python compilation passes.
- All 31 prior learning-check regressions pass.
- Independent review found one Material missing-input false pass and one Minor input-handling crash. Both were repaired and independently rechecked: zero Material, Minor or Cosmetic remaining. Initial findings are preserved in the ledger. The reviewer also checked 14 legacy state/mode cases.
- Rule tags, single-source references, failure-mode index, document coherence, specification structure and whitespace checks pass. Two initially mistyped checker filenames were corrected to the existing shell entry points; only the successful actual runs are counted here.
- No separate type-check or application build exists for these standard-library scripts. The legacy shell self-test is reserved for hosted CI because its scratch setup changes the Git hooks path, forbidden by the local session safety rule. All hosted checks must finish successfully before merge.

## Scope and delivery limits

This is a selected month-window field review, not an exhaustive transcript census or a measured decline in defect rates. Private source details remain in ignored local research. No other project or parallel-owned implementation changed. Bob's installed source receives the release after reviewed merge; existing project snapshots need their next current-Bob session or deliberate upgrade. Publishing cannot certify adoption or analytical truth.
