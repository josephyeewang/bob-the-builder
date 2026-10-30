# Phase Report Template

> Claude MUST use this template when presenting results at every `[N]b: Verify` step. Section markers indicate when each section is required.

> Section markers: **[A]** = Always required — omission is a failure condition. **[C]** = Conditional — required only when the stated condition applies; write "N/A — [reason]" when skipping. **[O]** = On-demand — include when relevant; omit entirely when not applicable.

---

## Phase [N] Report

### [A] Acceptance Bar (frozen at phase start — Phase Gate 12)
*Write the phase's done-criteria between the two markers **before** building, then run `node "$(realpath ~/.claude/skills/bob/..)/scripts/check-bar.mjs" --stamp <this-file>` to record the fingerprint. At the gate, `node "$(realpath ~/.claude/skills/bob/..)/scripts/check-bar.mjs" <this-file>` refuses if the criteria changed without an explanation. To move the bar on purpose, edit the criteria and run `node "$(realpath ~/.claude/skills/bob/..)/scripts/check-bar.mjs" --change "<why>" <this-file>` — it appends a dated line below the fingerprint. Never edit the fingerprint by hand.*

<!-- bar:start -->
- [done-criterion 1 — testable]
- [done-criterion 2 — testable]
<!-- bar:end -->
bar-sha256: UNSET

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

### [C] Failing-Test Receipts (Phase Gate 11) — *required for every fix or bug item in the phase*
- Every fix item names its test command. An item with no test command = gate fails.
- Paste one receipt per item from `node "$(realpath ~/.claude/skills/bob/..)/scripts/prove-test-fails.mjs" --commit <sha> --test "<cmd>" --fix <file>:<from>-<to>`, **run by a session other than the builder's** (the milestone reviewer or a new session).
  | Fix item | Test command | Receipt verdict (PROVEN / NOT PROVEN) | Commit | Run by (session) |
  |----------|--------------|----------------------------------------|--------|------------------|
- *N/A — no fix items this phase* (say so explicitly if skipping).

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
- **Rollback plan verified:** [Yes/No — confirm the flag/env-var/revert path defined in Build Manifest actually works]

### [C] AI Eval Results — *required if phase touched AI behavior (prompts, decision logic, routing, summarization, tone)*
- Eval set version: [git SHA of `evals/behavioral-core.yaml`]
- Results table:
  | Category | Total | Pass | Fail | Pass Rate | Δ vs Prior Phase |
  |----------|-------|------|------|-----------|------------------|
  | [list each category from eval set] | | | | | |
  | **Overall** | | | | | |
- Failures (list each: eval ID, what failed, severity, fix-now vs defer rationale)
- **A drop in pass-rate vs prior phase is a stop condition.** If overall or any category dropped → fix before advancing or document why the drop is acceptable.

### [C] Cost Guardrail Check — *required if Architecture Contract defines a per-request cost budget*
- Measured cost per request (or per-user-per-day, matching the budget unit): [$N.NN]
- Budget ceiling: [$N.NN]
- Within budget: [Yes / No — if No, this is a stop condition]

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
- Integration seams checked: [list each seam between this phase and prior phases — contract match? nulls handled? types compatible?]
- Rate limits & caps: [list every new endpoint/action and its rate limit. If none defined → FLAG as gap]
- Abuse vectors: [list at least 2 ways a malicious/careless user could exploit what was just built + mitigation]
- Error propagation: [trace at least 1 failure path across a subsystem boundary — what happens?]
- Auth/permission gaps: [list every new endpoint/action and confirm auth + authz checks exist]
- Prior seam spot-check: [pick 1 integration seam from a prior phase — still correct after this phase's changes?]

### [C] Class-Level Pattern Scan — *required if any bug was found during this phase*
- Pattern identified: [description]
- Codebase scan results: [N instances found, N fixed]
- Remaining instances: [0 / list any deferred with rationale]

### [C] Experience Test — *include only if phase has user-facing output*
- Expected experience: [from Build Manifest experience test field]
- Actual output: [show the real message, UI, or workflow the user would see]
- Assessment: [Does it feel right? Warm/robotic? Helpful/generic? Premium/cheap?]
- `→ HG decision:` Human evaluates whether the experience meets the bar. "Feels wrong" is a valid NO-GO.

### [A] Test Cases (minimum 3)
- [test 1: input → expected → actual → PASS/FAIL]
- [test 2: input → expected → actual → PASS/FAIL]
- [test 3: input → expected → actual → PASS/FAIL]

### [A] Regression Scenarios *(from Build Manifest — specific, named scenarios)*
- [scenario name from prior phase]: [expected outcome → actual → PASS/FAIL]
- [scenario name from prior phase]: [expected outcome → actual → PASS/FAIL]

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
- Future phases affected? [Yes/No — list which ones]
- Propagation enforcement satisfied? [Yes — all changes propagated / No — list what remains]
- **Deviation trend:** [This phase: N deviations. Prior phase: N. Trend: improving/stable/worsening]

### [A] Module Inventory *(omission is a failure condition)*
- Files created: [list]
- Files modified: [list]
- API routes added: [list]
- DB migrations: [list schema changes]
- Dependencies added: [list new packages]

### [O] Decisions to Log
- [list entries for decision-log.md, if any]
