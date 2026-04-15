# Phase Report Template

> Section markers: **[A]** = Always required — omission is a failure condition. **[C]** = Conditional — required only when the stated condition applies; write "N/A — [reason]" when skipping. **[O]** = On-demand — include when relevant; omit entirely when not applicable.

---

## Phase [N] Report

### [O] Gap Check Result
- Behavioral Coverage: [Complete / Missing / Partial — cite spec modules]
- Domain Spec Coverage: [Complete / Missing / Partial — cite sections]
- Conflicts Found: [None / List each with file references]
- Spec Patches Applied Before Build: [None / List each]
*Abbreviate to "Clean — no gaps, no conflicts, no patches" if all clear.*

### [A] Built
- [list everything built — files created, endpoints added, features implemented]

### [C] Mocked / Stubbed — *include only if anything was stubbed*
- [list anything not fully implemented, with rationale]

### [A] Implementation Decisions
- [list key technical decisions made during build]
- [for each: what was decided and why]

### [A] Assumptions Made
- [list any assumptions — if none, say "None"]
- [assumptions are yellow flags — each one is a potential future divergence]

### [A] Spec Deviations
- [list EVERY difference from specs — schema, API, behavior, UI]
- [for each: what changed, why, whether to accept or revert]
- [if none, say "None"]
- **Deviation count this phase: [N]** *(tracked in Build Manifest deviation tracker)*

### [C] Behavior Changes to Existing Systems — *include only if modifying previously built systems*
- [list any changes to previously built systems]
- [for each: what changed, which spec section requires it, regression impact]

### [A] Validation Results
- Build/type-check: [PASS / FAIL]
- Unit tests: [PASS / FAIL — count]
- Integration tests: [PASS / FAIL — count]
- Phase validation criteria: [list each criterion and PASS/FAIL]

### [A] Hot Path Results
- [For each project-wide hot path defined in Build Manifest:]
  - [Hot path name]: [input → expected → actual → PASS/FAIL]
- **Hot path failure is a stop condition.** Do NOT proceed if any hot path fails.

### [A] Regression Check
- [list prior-phase flows tested and PASS/FAIL for each]

### [C] Deploy Verification — *required if phase touches external integrations, webhooks, auth, or deployment config*
- Deployed to: [staging URL / preview environment]
- Integration points tested: [list each with PASS/FAIL]
- Webhook delivery confirmed: [Yes/No/N/A]
- Auth flow end-to-end: [PASS/FAIL/N/A]

### [A] Acceptance Gate
- Exit criteria met: [Yes/No — cite each criterion]
- Scope boundary respected: [Yes/No — list anything that must NOT have been built]

### [A] Global Invariant Check *(use project's invariant checklist from Architecture Contract)*
- [ ] [Invariant 1] — [PASS/FAIL]
- [ ] [Invariant 2] — [PASS/FAIL]
- [ ] ...
- If ANY invariant is violated → FIX immediately. Do NOT proceed to next phase.

### [C] Provider/Abstraction Enforcement — *include only if project uses provider abstractions*
- grep for provider-specific imports outside abstraction layer: [results — must be empty]
- grep for direct external calls bypassing abstraction: [results — must be empty]
- If ANY violation is found → FIX before proceeding. Do NOT defer.

### [C] Cross-Cutting Concern Scan — *required for phases with integration points or new endpoints*
- Integration seams checked: [list each seam — contract match? nulls handled? types compatible?]
- Rate limits & caps: [list every new endpoint/action and its rate limit. If none → FLAG as gap]
- Abuse vectors: [list at least 2 exploit scenarios + mitigation]
- Error propagation: [trace at least 1 failure path across a subsystem boundary]
- Auth/permission gaps: [list every new endpoint/action and confirm auth + authz exist]
- Prior seam spot-check: [pick 1 prior seam — still correct?]

### [C] Class-Level Pattern Scan — *required if any bug was found during this phase*
- Pattern identified: [description]
- Codebase scan results: [N instances found, N fixed]
- Remaining instances: [0 / list any deferred with rationale]

### [C] Experience Test — *include only if phase has user-facing output*
- Expected experience: [from Build Manifest]
- Actual output: [show real message, UI, or workflow]
- Assessment: [warm/robotic? helpful/generic? premium/cheap?]
- `→ HG decision:` "Feels wrong" is a valid NO-GO.

### [A] Test Cases (minimum 3)
- [test 1: input → expected → actual → PASS/FAIL]
- [test 2: input → expected → actual → PASS/FAIL]
- [test 3: input → expected → actual → PASS/FAIL]

### [A] Regression Scenarios *(from Build Manifest — specific, named scenarios)*
- [scenario name]: [expected → actual → PASS/FAIL]
- [scenario name]: [expected → actual → PASS/FAIL]

### [A] Propagation *(MANDATORY if specs were modified)*
- Were any specs modified in this phase? [Yes/No — list files]
- If yes: which future phases depend on modified specs? [list each]
- Are those phases impacted? [Yes/No — explain for each]
- Were impacted phases flagged in Build Manifest? [Yes/No]
- **If specs were modified and this section says "None" → FAILURE CONDITION**

### [A] Pulse Check
- Phase complete? [Yes/No]
- Still aligned with Product Spec? [Yes/No]
- Drift detected? [Yes/No — describe]
- Future phases affected? [Yes/No — list]
- Propagation enforcement satisfied? [Yes / No — list what remains]
- **Deviation trend:** [This phase: N. Prior phase: N. Trend: improving/stable/worsening]

### [A] Module Inventory *(omission is a failure condition)*
- Files created: [list]
- Files modified: [list]
- API routes added: [list]
- DB migrations: [list schema changes]
- Dependencies added: [list new packages]

### [O] Decisions to Log
- [list entries for decision-log.md, if any]
