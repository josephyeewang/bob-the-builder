# Evaluation sidecar fields

Use evaluation-record.json for the root shape. Strings must contain real evidence, not placeholders. Paths to local receipts/bundles can be absolute or relative to the JSON file. Inspect receipts; an existing file alone cannot establish truth or independent review.

New records include opportunity_schema_version: 1 and request_mode: adopt/scan/learn/recheck. Legacy schema_version:2 records without that extension remain valid and are labeled missing follow-through in the generated index. No silent migration. alternative_search.scope_reason explains depth; focused learn/recheck can have no queries when the reason is explicit. Adoption/scan still records genuine search or partial access limits.

New evaluations also use context_schema_version: 1 and checked_on (evaluation date, YYYY-MM-DD). Older records remain compatible and produce missing-context coverage warnings. project_context.pains is a list of sourced observations: id, project, problem, basis (user-stated/observed/inferred), source, observed_on (source date or unknown), status (open/resolved/unknown); optional next_check. Empty observations require project_context.limitations. Project documents/user sources remain authoritative; this record is a snapshot, not permission to change them. Keep differing sources/statuses and recheck conflicts. Never present inference as the user's experience. Full method: relevance.md.

product_angle contains claimed_angle, delivered_behavior, conclusion, evidence (source references, or limitations), opportunities (component IDs) and optional limitations. Use component kind positioning for useful audience/framing/use-case/packaging ideas. Reuse decisions/before-after fields are unchanged; don't infer demand from copy or public sentiment.

For request_mode recheck, add recheck: previous_checked_on (date or unknown), previous_revision (or explicit unknown), changes, decision_effect, evidence (current/prior source references or limitations). checked_on/source_revision describe the current assessment. Preserve prior Markdown History; don't silently overwrite past decisions.

context_evidence: inspected project-purpose/status/delivery-path references. coverage.inspected/omitted: meaningful areas and their paths/reasons. alternative_search.queries/results: actual search record; an empty result list is valid. source_revision: full commit/version (or closed-source service/date); partial source access records complete=false and source_access_limits.

Each usefulness.components entry:
- id: unique stable component name; kind: implementation/architecture/UI/idea/prompt/test/positioning
- source_evidence: inspected paths/lines, source URLs or behavioral receipts
- decision and reason: one of code-vs-ours.md's decisions, plus its evidence-backed reason
- benefit; destination (named project/path), or destination_unknown_reason
- for new useful opportunities: projects (explicit project labels, or empty with destination_unknown_reason), tags (plain behavior words), before (observed current behavior, or before_unknown_reason), after (concrete improvement), adaptation_burden, next_action, prerequisite (specific condition; say none if genuinely none). These drive generated recall and project queues without a second editable status store.
- supporting_files: inspected imports/helpers/tests/styles/notices; or supporting_files_reason if inapplicable
- idea_only_reason for idea reuse; our_evidence for OURS IS BETTER
- capture: state not-needed/blocked/captured; reason for blocked; captured requires path to bundle, source_url, revision matching the evaluation and source_files listing selected component paths present in the manifest
- integration: state not-integrated/integrated/verified; mapping_receipt for integrated; verified additionally requires behavior_receipt, safety_receipt and attribution_receipt

security.checks: each check's tool/method/version, source revision, examined inputs, outcome and limits. security.unknowns: unresolved coverage/behavior. security.findings: objects with severity material/minor/cosmetic, evidence, trigger, consequence, components (IDs, or '*'), repair, verification (the proving test), resolved boolean and remaining_risk. If resolved=true, include verification_receipt. Findings block the affected integration while unresolved material risk remains. Check the IDs against actual source/callers: a defect inside a useful captured part must name that part, even if a separate rejected component also describes the path. A prose warning or valid checker result does not prove the integration block reaches it. Required fields apply to observed findings, not invented findings when none were observed.

qualitative.sources: source URL/reference, firsthand/secondhand/vendor/interpretation, relevant account and date/version where applicable. No sources requires limitations. The conclusion is independent; do not average it into code/security findings.

runtime.status: passed/failed/not-tested; executed claims require receipt. A receipt describes the isolation, command, input, result and limits without secret values. Adopt requires a successful safe runtime and independent_review_receipt. publishing, paid_use or setup_change true also requires independent review. Integrated parts require independent review even for a whole-tool skip.

The checker validates consistency, file hashes and receipt presence. It does not prove source authenticity, permission, coverage completeness, semantic correctness, safe isolation or reviewer independence. Those remain evaluator and fresh-review duties. Correctness of component counts comes from the actual inventory, never a target quota.

visual_review is required for new evaluations: applicability user-facing/headless/unknown; reason for headless/unknown; independent relevant-usability conclusion about UI/UX/visuals; evidence [{kind: screenshot/interaction/source/promotional, ref: exact artifact/path/URL}]; opportunities (component IDs); limitations for unavailable/unobserved states. Evidence kinds describe observation scope, not quality scores. Headless is not a fallback for inaccessible UI. See ui-ux.md.

## Application and trial follow-through extension

New evaluations use optional `application_schema_version: 1`; older records without it remain valid and no application or trial status is inferred. These records require an actual `checked_on` date. Every useful component adds:
- `application_type`: `current` (a named present need), `reusable` (a transferable capability without requiring an active project), or `future` (a product/workflow hypothesis, not established demand).
- `recommendation_timing`: `act-now`, `preserve`, or `defer`. Usefulness does not imply immediate priority or authorization.
- `revisit_trigger`: a concrete condition/date for reconsideration; literal `none` is allowed only with `act-now`.
- For `future`, `future_scenario` is an object with nonempty `user`, `task`, and `enabling_value`: who could use it, what they would do, and what the part enables. Inspect the substance; nonempty text does not prove a concrete scenario.

Reusable/future opportunities can leave `projects` empty with `destination_unknown_reason`; never invent a project label to satisfy recall. Keep the existing benefit, source, before/after, adaptation and safety requirements. Generated views preserve application fields, checked date and unknown destination context; old records remain labeled unknown rather than retrospectively classified.

For this extension, `whole_tool_decision: try` requires root `trial`: `state` (`proposed`/`active`/`completed`), `task`, observable `keep_criteria`, observable `drop_criteria`, and actual `review_on` date. `active` also requires actual `started_on`; `completed` requires `started_on`, `ended_on`, observed `result`, and a new whole-tool decision beyond `try`. End cannot precede start. Proposed/active trial states require decision `try`. A non-try evaluation may omit trial or retain a completed trial as evidence. Proposed is a plan, active needs real execution evidence, and completed needs observed results; neither file presence nor a valid date proves those states. No separate trial database or automatic execution is created.

New pain observations use `user-stated`. The legacy `joe-stated` token remains a supported statement-basis alias so existing private records and history do not need rewriting; both require an actual supporting source.
