# Evidence meaning — EVOLVE Large

## Outcome and scope

Second field-learning pass over a month of project work, excluding parallel-owned orchestration work. The owner requested further learning after authorizing improvement and deployment of the learning capability. Extend existing audit and build tools; do not add a new audit panel or another lessons database.

## Planned changes

1. Reproduce and repair source-fidelity checks that report success for missing inputs or zero extracted candidates. Preserve the heuristic's limited claim and test real CLI behavior.
2. Extend the existing coverage checker with optional structured task-result evidence: match the expected run and subject, require fresh completed success for a covered unit, and refuse failed/stale/missing reports even when the process exited successfully.
3. Improve existing evaluation, behavior and release templates: applicability and useful-output controls; input authority; reader/writer compatibility across releases and rollback.
4. Extend the existing lenses with semantic round trips, deadline/completion priority, shared upstream dependencies, statistical claim clearance and structural user journeys.
5. Test planted failures and clean controls, run independent correctness/privacy review, reconcile and publish a checked release. No other project or parallel-owned implementation is modified.

## Reference scan and review

The reference scan is this field review of existing implementations and recent decisions; see reference-scan.md. All changes extend established Bob mechanisms with standard-library code. No new dependency, paid service or external architecture is selected. Plan and specification review are covered by the owner's continuing instruction to improve and deploy this learning work; unexpected product/safety scope still requires a separate decision.

## Verification and limits

Synthetic CLI tests for missing source, empty extraction, real omissions and retained candidates; report pass/fail, stale identity, missing report, incomplete run, wrong subject, malformed data and unsafe paths. Existing covered units remain compatible, but are not retrospectively certified as report-validated. Fresh-context review validates integration and source privacy. Semantic correctness still needs real workload execution and independent judgment; a validated receipt cannot supply it by itself.
