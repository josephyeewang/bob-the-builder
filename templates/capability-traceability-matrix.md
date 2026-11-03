# Capability Traceability Matrix

> Mandatory artifact per Build Protocol Step 5a-ii. Maps every capability from the Product Spec to a build phase and tracks its lifecycle through implementation and hardening. Without this matrix, capabilities silently fall through the cracks between specs and code.

## How to use

- Every capability in the Product Spec (Step 1a) MUST have a row here. No implicit capabilities.
- Every row MUST have a phase assignment. Unassigned capabilities are a gap and must be resolved before Step 6.
- Status updates happen at `[N]c: Reconcile` (after each build phase) and at A7.3 (after each hardening pass).
- At Step [N+1] hardening, every `E`-status row must be verifiable in code.
- **The Works column is the capability list (Engineering Principle 11, D-036).** Status says what a phase built, stubbed or left for later; Works says what the product *can actually do*. Name each capability in the owner's words, update Works at every Reconcile, and put the scoreboard in the phase report (Phase Gate 16). Only the first two Works values count as done.

## Status codes (what each phase built, stubbed or left for later)

| Code | Meaning |
|------|---------|
| **E** | Explicitly built in this phase (full implementation) |
| **S** | Stubbed (interface exists, implementation deferred) |
| **F** | Future (not built, assigned to a later phase) |
| **—** | Not applicable to this phase |

## Works (what the product can actually do — Principle 11)

| Value | Meaning | Counts as done? |
|-------|---------|-----------------|
| **live** | Works live: seen working in the real product, with the evidence named | Yes |
| **e2e** | Works end-to-end in tests: a test drives it from the product's real entry point all the way through | Yes |
| **unwired** | Built, not connected: the pieces exist and pass their tests, but nothing in the running product calls them (Phase Gate 17 lists these) | No |
| **partial** | Partly built: some pieces exist, or only unit tests on the pieces prove it | No |
| **none** | Not built | No |
| **—** | An explicit non-goal; left out of the scoreboard | — |

The **Evidence** column names the proof for `live` (what was seen, when) and `e2e` (the test's name). A `live` or `e2e` with no evidence is `partial`.

**Scoreboard** (copy into the phase report, Phase Gate 16): `live N · e2e N · unwired N · partial N · none N — done N of TOTAL`.

## Hardening badges (set in A7.3)

| Badge | Meaning |
|-------|---------|
| **H** | Passed internal-correctness hardening (A7a–A7e) |
| **H++** | Passed BOTH internal-correctness (A7a–A7e) AND external-fit (A7f–A7h) hardening |
| _(blank)_ | Not yet hardened or out of scope for hardening |

## Template

```
| # | Capability                          | Phase    | Status  | Works | Evidence                  | H-status | Notes                        |
|---|-------------------------------------|----------|---------|-------|---------------------------|----------|------------------------------|
| 1 | [capability, in the owner's words]  | Phase N  | E/S/F/— | live/e2e/unwired/partial/none | [what was seen / test name] |          | Notes on edge cases or deps |
```

## Worked example (personal task-management AI)

| # | Capability | Phase | Status | Works | Evidence | H-status | Notes |
|---|---|---|---|---|---|---|---|
| 1 | I text a task and it shows up in my list | Phase 3 | E | live | texted "buy milk tomorrow" on staging, task appeared, 3 Nov | H | hot path; covered by A7b prompt-injection audit |
| 2 | When it isn't sure, it asks me before acting | Phase 3 | E | e2e | `inbound-ambiguous.e2e.test` | H++ | Behavioral Core §1; covered by A7g effectiveness signal |
| 3 | A weekly task comes back each week | Phase 4 | E | unwired | — | | the repeat step is built and unit-tested, but the scheduler never calls it; listed in UNWIRED with row 3 |
| 4 | I can see my tasks in my calendar | Phase 5 | F | none | — | | deferred per Build Manifest; A7c integration seam will revisit |
| 5 | My partner and I share a list | Phase 6 | S | partial | API unit tests only | | API stubbed in Phase 5; UI builds in Phase 6 |
| 6 | Voice input | — | — | — | — | | explicit non-goal v1 (Product Spec §Non-goals) |

Scoreboard: `live 1 · e2e 1 · unwired 1 · partial 1 · none 1 — done 2 of 5`. Row 3 is why the Works column exists: its Status says built, and every unit test passes, but the product can't do it yet.

## Living document

This matrix changes during build. When a capability is added, removed, or re-assigned between phases, log the change in `decision-log.md` and update the row here. A capability disappearing without a decision-log entry is a `[Spec-Code]` audit finding waiting to happen.
