# Bob Field Retro — a data product's recurring-job arc (2026-09-19 → 22)

> Incident intake per Rule 32 (v2.40): what the field taught, filed as failure-mode CLASSES and method
> lessons. Written by the sessions that did the work (a builder and a fresh-context integrator/auditor),
> then harvested by a fresh-context agent against Bob's Rules 1–33 and the failure-mode index so only what
> is NOT already in Bob is proposed here. Nothing here edits a rule or the index directly — the maintainer
> folds it in. Anonymized: all product, data-source, third-party-service and architecture detail has been removed.

## What happened

A long-running scheduled analytics job on a Bob-built data product was slow and frequently failed or was
cancelled. Two sessions — one building, one integrating and auditing every change fresh-context — spent
three days on it. Every change was audited before merge; a large share of first-pass audits found a
MATERIAL defect; many catches were "the check ran against the wrong subject"; several plausible first
readings were refuted by a measurement before they became recorded findings. End state: the job
substantially faster, consecutive clean runs, every step attributed by a pre-registered pass/fail line and
a receipt on the next run. Then the founder paused the work for the product roadmap.

## The meta-finding

**"The database is just slow sometimes" was several distinct, measurable mechanisms — and none was
visible from the job's own log.** Earlier looks had each measured the symptom (a slow step, a depleted
disk budget) rather than what was feeding it. Each mechanism was found by a different instrument:

| Mechanism (generic) | Instrument that found it | What the job log showed instead |
|---|---|---|
| One unindexed, frequently-called lookup accounted for most of the disk reads, draining the hosting provider's burst budget so every later read ran slow | The database's own per-statement statistics, ranked by disk reads — one query | "everything is slow after step X" |
| Client timeouts abandoned the connection but not the server-side statement, so retries stacked duplicate scans | A lightweight SQL sampler run on a fixed interval for the whole job → a time series of what the server was doing | "parallel scans" (the caller was sequential) |
| Each count was a full scan because the cache was smaller than the table and the index did not cover the filtered columns | The database's query-plan-with-actual-buffers output | "this step takes a long time" |

## Failure-mode classes proposed for the index (not already rows)

| Failure mode | The tell / the fixture that would prove a detector |
|---|---|
| **Verified on the wrong SUBJECT** — a PASS that meant nothing because the check ran on a different machine, a stale checkout, a different file format, a shorter input, a different library major version, or matched prose text as if it were code | A suspiciously perfect result; a fact you already knew that the result contradicts. Fixture: a check seeded with one KNOWN fact it must reproduce, run in the wrong environment → must fail |
| **A failure value that equals a legitimate empty value** — "read failed" and "no rows" render identically; a caller's default-to-zero mints a fake zero; a timed-out range check renders a green card | Audit question per surface: "what does a FAILURE render as?"; compare rendered output from old and new code against the same data at the same moment. Fixture: all read paths dead → the surface must say UNKNOWN, never 0 |
| **Timeout-retry stacking** — a client timeout does not cancel the server statement; N calls × retries = stacked work; a fallback path retried after a direct timeout is the same work on a slower path | Server-side statement timeout; ONE attempt; the fallback refuses after a direct failure. Fixture: a read patched to time out → exactly one attempt, zero fallback requests |
| **The watcher harms the patient** — a health check whose own probes are expensive, unbounded, retried reads inside the job it monitors | Distinct from "watcher dies with patient": the health step's reads must be bounded and cheap, measured before the workload |
| **Vacuous result recorded per item** — an all-empty upstream response written as "every item is dead" (reference item included) | 100% of asked items empty, reference item included → an outage, not N facts. Fixture: a zero-answer pass must write nothing |
| **The population asked was pre-selected dead** — "the primary source is failing" was really the same unanswerable items re-asked every pass; the primary's successes printed nothing, only fallback uses did | A primary's success must be as visible as a fallback's (per-source tally, a reference-probe line). Census the ASKED set before blaming the answerer |
| **Correctness resting on an unstated neighbouring mechanism** — a guard that is "harmless only while" some other component happens to prevent the bad case, stated nowhere | The phrase "harmless only while…". Fixture: remove the neighbour; the guard must fail loudly |
| **Completed-but-void run** — every step ran, the job reported success, the result is void because an allowed-to-fail step failed instantly | A third state beside died-early and cancelled; every bound needs a READER (a verify step) |
| **A register whose write resets the fields that make it a register** — an upsert resets attempt count and first-seen time on every conflict | attempts = 1 on every row; first-seen == last-seen everywhere |
| **A count capped by its own probe limit** — a query limit saturated the printed count; the check would have said the same at any true value | A printed count equal to a limit in the same script |
| **A manual run of a shared job has a cost outside its own job** — hand-triggered runs held a shared write lock through customer-facing windows, starving user-facing scheduled work and spending its retry allowance on lock-blocked attempts | A manual-run window rule (or guards that wait on the lock instead of standing down); retry caps must not count lock-blocked attempts; a daily "the user-facing output went out" check |
| **Cancelling is not releasing** — a cancel request may never reach a stuck worker; cleanup hooks may not run on cancellation; a lock reaper may remove the record without ending the underlying sessions | Every cancel followed by a before/after receipt on the lock and a "no live sessions remain" check |
| **A sick worker looks like a slow backend** — every network-heavy step slower by a fixed per-request penalty while a direct-path step got faster | Compare every step with the previous run; read database-side counters (an idle database = the problem is client-side); time the service from elsewhere; re-run on a fresh worker and read the FIRST step |

## Method lessons proposed as one Rule (≈ "Measure the mechanism before attributing" — v2.41 candidate)

1. **Pre-register before dispatch, controls first, one change per measurement run.** Write the pass/fail lines and the falsifier BEFORE the run; read the CONTROLS (steps nothing touched) before the movers; when a falsifier fires, retract the projection in those words. Two fixes in one run = two pre-registered claims with mirror falsifiers. A categorical receipt (a string) beats a timing drawn from a noisy band.
2. **Tank vs leak.** "Looked into it several times and still open" means every look measured the symptom. Rank the database's own statement statistics by disk reads before any capacity debate; make it a routine ops read.
3. **Instrument the run, not the code:** a memory reading per phase (a process over its RAM limit makes pure-compute phases much slower — read memory before attributing time); an interval SQL sampler for the database side; the query plan with buffers for the statement. A plan-with-timing run ships no rows — never compare it to a figure that includes delivery. Per-statement statistics cannot time a cursor-streamed read; wall-clock it.
4. **A hypothesis is not a finding** until the measurement that separates it from the alternative has run — several first readings in this arc were plausible, mechanism-shaped, and wrong; each fell to one query.
5. **Seed every check with one known fact** it must reproduce, and name the environment the check ran in and the one the answer must hold in. Prove a test's RED reason (the exact defect text), not just its RED; a "0 hits" search must first find N known lines.
6. **Ceilings and timeouts come from a measurement pinned by a test that names it** (e.g. an assertion whose message cites the dated measurement and says "change it with a new measurement"). A guessed value would have rendered real sources UNKNOWN.
7. **Wall-clock ≠ working time.** A run whose steps sum to a fraction of its duration is a queueing problem on a different list.
8. **Threshold SHAPE, not number:** a rate loosens with growth, an absolute tightens; repeated rounds of tuning is the symptom. A predicted alarm is a different object from an unexplained one — record the date before the first red.
9. **A scheduled falsifier can be triggered by hand.** Say what waiting for the schedule buys (e.g. a colder cache) before choosing it; usually nothing later runs won't show.
10. **Merge into the living document, never append**: the arc's numbers went into the plan's own existing tables and correction register; the only new block is a resume list inside the section that owns scheduling, each row with an owner and a falsifier.

## Process insights (the 3-session model)

- Integrator + builder + fresh-context auditors: a large share of first-pass audits found MATERIAL defects, more on follow-up passes, many wrong-subject catches, none reached production; per-change audit latency of minutes was the cost. Keep it.
- Every flag needs its own value pin on a fixture that straddles the boundary the flag decides; "tests pass with the flag deleted" means the test never saw it.
- A database delete or schema change waits for the integrator's go — the go is the second pair of eyes on the SELECTION CONDITION, not the count.
- Diff against main before every merge request: stale branches can carry an old whole file that silently reverts a merged fix with CI green (a diff far larger than the feature is the tell).
- Parallel changes appending to the same list collide — insert in sorted order. Shared memory files across sessions: append at the end, re-read before editing. Table-row edits get a mechanical cell-count check (an unescaped pipe character split a row).
- Worktree hygiene: some bundlers refuse a symlinked dependency folder — install dependencies per worktree; a worktree created from inside another worktree nests under it; long background waits may be cut off — use a monitor.
- A change reported as merged whose merge commit is not actually on main — the "stale-branch revert" class at the level of the branch itself; verify ancestry against main for every "merged" that matters.

## Where the full record lives

In the product's private repository, not here.
