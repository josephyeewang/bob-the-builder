# Field learning: prevent the next defect before review

Rules 30–32 own the requirements. This is their execution guide, used at AUDIT entry, EVOLVE planning, and when fixing a finding. It extends the existing audit ledger and lens retro; it does not create another lessons database or rewrite rules automatically.

## Before building: give the builder usable evidence

Read the current spec, applicable decisions, previous findings and the capability matrix. Run:

```bash
node "$(realpath ~/.claude/skills/bob/..)/scripts/learning-check.mjs" docs/audit-ledger.json --stage plan
```

Bob itself keeps its ledger at `audit-ledger.json`; use that path when working on Bob. `--class <exact-class>` narrows a known class, but is not a substitute for reading other affected classes. No learning data means **unassessed**, not clean: inspect the relevant prior reports and populate only incidents whose sources you can identify. Do not invent historical counts or bulk backfill unrelated work.

Put these four things in the existing change plan, with links rather than copied rules:

1. **Behavior and boundaries:** the user outcome, supported inputs, authorization boundaries, and what must remain true. Cite current owner decisions; a historical ruling log is not a usable build brief. Resolve contradictory rules before implementation.
2. **Affected paths:** discover actual callers, alternate entry points, stored state, generated consumers and output readers. Record the discovery command and the resulting scope. Include the real action/commit point, not only a helper called by a test.
3. **Prior failures and prevention:** each relevant class, the existing control that missed it, why it missed, and the check the builder will run before handing off. A prevention check must detect a newly introduced instance outside the original incident list.
4. **Finish condition:** the actual user journey and its retained evidence; what is built but not connected; the next activation blocker and owner. Use the existing capability matrix and deferred-actions list. If completed work is waiting for activation, prefer finishing it before starting more in the same area, unless a dependency or owner decision justifies otherwise.

A reviewer recommendation is a proposed repair, not an approved design. Inspect the current behavior and callers before accepting it. A repair introducing a new state, flag, persisted file, permission or subsystem goes back through E2/E3 for the affected design; the existing authorization rules still apply.

## Repair without creating the next finding

Keep the supported scope and severity criteria stable across review rounds. For each repair:

- Name the violated requirement and reproduce the defect through the actual caller.
- List the newly touched callers, state transitions and guarantees. Treat those changes as new work, not merely proof that an old line was edited.
- Re-run the prior round's relevant failing cases **and verified-good behavior**, plus a clean control. A test that rejects every input is not a useful safety fix.
- Check neighboring paths and new instances discovered from the current source. A handwritten list of yesterday's sites is not a class-level census.
- Preserve the reviewed revision, commands, environment assumptions and results. If the code, tool version or relevant assumptions change, refresh affected evidence. An unavailable old test is an explicit evidence gap, not a permanent excuse or an automatic pass.

Use the smallest applicable boundary checks, not another full panel:

| Change | Builder's check before handoff |
|---|---|
| Filtering, sharing or derived outputs | Changing only excluded input must not change the allowed output; include every derived field and actual output producer. |
| State changes and asynchronous work | Pause before and after validation, locking and writing; change the underlying state or selected context; retry/reopen. Verify authority and freshness at the action point. |
| Verifiers, generators or test harnesses | Run one real producer → artifact → real consumer journey; corrupt one relevant field; preserve unrelated valid content; distinguish product failure from verifier failure. |
| Safety guards | State the actor and trust boundary. Prefer enforced permissions, bounded allowed operations and shared checks over endless lists of bad spellings. Prove containment before relying on it; never remove a safety boundary solely because a test is inconvenient. |
| Scheduling or blocking rules | Name the resource/conflict they prevent and current evidence. Recommend narrowing obsolete constraints; retain real locks, user approvals and applicable safety obligations. |

## Grade consequences consistently

Rule 30 remains the severity authority. A Material finding names the scenario, actual or planned supported entry point, failed boundary, and consequential outcome. For security, adversarial actors can be legitimate inputs to the threat model. Corrupt state and clock changes are not automatically out of scope. A safety assumption counts only when independently evidenced in the relevant environment.

Separate product defects, verifier defects, missing evidence, and proposed scope expansion. Missing evidence can still block a required safety or release gate without pretending a product failure has been demonstrated. Latent code becomes a release blocker when the approved change activates it. Never improve a rate by relabeling serious findings, narrowing coverage silently, or treating unverified containment as installed.

There is **no fixed audit-round cap**. Repeated Material rounds trigger diagnosis: existing missed defect, repeat class, repair-induced defect, scope change, inconsistent grading, or unknown. Change the intervention when the cause warrants it; preserve zero unresolved Material. More rounds alone are not prevention.

## Record once; carry the lesson into the next plan

Add the optional `learning` block to the project's existing audit ledger using `templates/learning-record.example.json` as the format example. Preserve `entries`, its schema and all historical audit counts. Keep sensitive incident sources in the private project; publish only generic failure mechanisms.

- One incident ID represents one defect occurrence, even if several reviews mention it. A distinct instance found while auditing a class fix is a new incident; a recheck of the same instance is not.
- Each incident links to its change, stable failure class and pre-handoff check. Distinguish newly discovered, repeat and repair-induced incidents; do not force an uncertain historical attribution.
- Record the prevention mechanism, discovered scope, regression, clean control, new-instance test, independent reviewer and consuming-project adoption evidence. A claimed rung or installed template is not adoption proof.
- Keep unknown adoption open. If a lesson is project-specific, record it there; if Bob already covers it, repair adoption; if Bob lacks the check, propose the generic change through Rule 32 and the existing lens retro. Rejected proposals retain their rationale in the decision log.

Run `--stage close` before claiming a recurring class is prevented. This refuses incomplete closure records and remaining Material findings. It checks record structure and referenced files, **not the truth of their contents or test results**. A fresh reviewer validates the evidence and tries a counterexample; only actual execution demonstrates prevention. Commands in records are displayed, never executed by the checker.

The learning check runs from `audit-ledger-check.mjs` when a learning block exists (`--since` uses close-stage validation; ordinary format checks use plan-stage validation). Legacy ledgers remain readable. The dedicated checker reports missing learning data as unassessed; do not interpret legacy format success as learning coverage.

## Measure upstream improvement honestly

Keep first-pass and follow-up rounds separate, with a stable change ID. Report initial reviews containing Material / initial reviews completed; separately report follow-up reviews containing Material / follow-up reviews completed. State dates, missing inputs, supported scope and grading changes. Never compare a pooled lifetime rate with a recent-period rate as a before/after intervention result.

Use incident provenance to distinguish repair-induced defects from older defects newly discovered. Report unresolved and unclassified evidence alongside classified cases. A selected sample diagnoses mechanisms; it is not a population failure rate. Compare similar work and stakes before and after adoption. Completion of this loop establishes that a control was installed and checked, not that future defects have already declined.

Keep the current coverage record, audit-history and capability matrix as their existing sources of truth. Do not copy their counts into a hand-maintained dashboard. Better outcomes mean fewer defects reaching first review, fewer repairs introducing new defects, and more approved capabilities working end to end—not merely more audits or more rules.
