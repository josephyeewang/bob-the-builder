# APPENDIX E: GLOBAL INVARIANTS PATTERN

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Project-specific invariants that MUST hold true at the end of EVERY build phase. Verified in the Phase Report's Global Invariant Check section — this is not optional.*

Global invariants are architectural rules that, if violated, cause cascading problems. They are checked at every `[N]b: Verify` step and reported in every Phase Report.

**How to define them:** During Step 3 (Architecture Contract) or Step 4 (Domain Specs), identify the 5-15 rules that must ALWAYS be true. Write them as a numbered checklist in the Architecture Contract. Claude MUST verify ALL of them at the end of EVERY phase.

**Enforcement:** If ANY invariant is violated → FIX immediately → DO NOT proceed to next phase. Invariant violations are never deferred.

**Example invariants (adapt to your project):**

For a multi-surface AI product:
```
- [ ] AI never writes to DB directly — all state transitions go through logic layer
- [ ] All inbound messages normalized before processing (no raw provider payloads in core logic)
- [ ] All outbound messages generated as canonical actions before delivery
- [ ] No provider-specific code outside abstraction layers
- [ ] No direct DB access from UI components
- [ ] All capability/model outputs schema-validated before use
- [ ] No cross-layer import violations
- [ ] All timestamps stored in UTC
- [ ] Idempotency enforced on all write paths
```

For a data pipeline / analysis tool:
```
- [ ] All external data validated/sanitized before entering pipeline
- [ ] No hardcoded credentials or API keys in source files
- [ ] All scoring formulas match the documented specification
- [ ] Output format matches schema (no silent field additions or removals)
- [ ] All calculations use consistent units (no implicit conversions)
```

**Enforcement:** If ANY invariant is violated at phase end → fix immediately. Do NOT proceed to next phase.
