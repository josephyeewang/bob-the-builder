# Capability Traceability Matrix

> Mandatory artifact per Build Protocol Step 5a-ii. Maps every capability from the Product Spec to a build phase and tracks its lifecycle through implementation and hardening. Without this matrix, capabilities silently fall through the cracks between specs and code.

## How to use

- Every capability in the Product Spec (Step 1a) MUST have a row here. No implicit capabilities.
- Every row MUST have a phase assignment. Unassigned capabilities are a gap and must be resolved before Step 6.
- Status updates happen at `[N]c: Reconcile` (after each build phase) and at A7i (after each hardening pass).
- At Step [N+1] hardening, every `E`-status row must be verifiable in code.

## Status codes

| Code | Meaning |
|------|---------|
| **E** | Explicitly built in this phase (full implementation) |
| **S** | Stubbed (interface exists, implementation deferred) |
| **F** | Future (not built, assigned to a later phase) |
| **—** | Not applicable to this phase |

## Hardening badges (set in A7i)

| Badge | Meaning |
|-------|---------|
| **H** | Passed internal-correctness hardening (A7a–A7e) |
| **H++** | Passed BOTH internal-correctness (A7a–A7e) AND external-fit (A7f–A7h) hardening |
| _(blank)_ | Not yet hardened or out of scope for hardening |

## Template

```
| # | Capability                          | Phase    | Status | H-status | Notes                          |
|---|-------------------------------------|----------|--------|----------|--------------------------------|
| 1 | [capability name from Product Spec] | Phase N  | E/S/F/— |          | Notes on edge cases or deps   |
```

## Worked example (personal task-management AI)

| # | Capability | Phase | Status | H-status | Notes |
|---|---|---|---|---|---|
| 1 | Inbound SMS → task creation | Phase 3 | E | H | hot path; covered by A7b prompt-injection audit |
| 2 | Auto-confidence threshold + ask-back | Phase 3 | E | H++ | Behavioral Core §1; covered by A7g effectiveness signal |
| 3 | Recurring tasks | Phase 4 | E |  | not yet hardened — H pending Step [N+1] |
| 4 | Calendar export (iCal) | Phase 5 | F |  | deferred per Build Manifest; A7c integration seam will revisit |
| 5 | Multi-user / shared lists | Phase 6 | S |  | API stubbed in Phase 5; UI builds in Phase 6 |
| 6 | Voice input | — | — |  | explicit non-goal v1 (Product Spec §Non-goals) |

## Living document

This matrix changes during build. When a capability is added, removed, or re-assigned between phases, log the change in `decision-log.md` and update the row here. A capability disappearing without a decision-log entry is a `[Spec-Code]` audit finding waiting to happen.
