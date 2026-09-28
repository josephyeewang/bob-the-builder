# The Failure-Mode Index

**Why this file exists.** The lens library is indexed by *discipline* — 37 lenses in 8 bands
(engineering / UX / AI / performance / reach / operational / strategic / growth). That answers
"what should an engineering audit look at?" It cannot answer **"which failure modes has nobody
here ever claimed?"** — so gaps stay invisible until a census finds them years later. One did,
on 2026-09-18, and found five families with no owner at all, every one of which had repeated
real incidents in a Bob-built project.

This index is the other axis. One row per failure mode. Each row names the **owning check**, the
**fixture** that proves the check fires, and — when there is no owner — says **NONE** in bold, so
the gap is a visible fact rather than a discovery.

## How to use it

- **Harvesting an incident (Rule 32):** find or add the row. If `Owner` is NONE, that is a
  framework gap — file it, don't silently absorb it into a nearby lens.
- **Adding a check:** add the fixture in the same commit. Rule 28 already requires that a check
  be regression-tested against the defect it was written for; this is where that is recorded.
- **Auditing:** a family whose `Fixture` column is empty is an *unproven* check. Treat its clean
  result as "not yet demonstrated," never as a pass. (Rule 29's discipline, applied to Bob.)

## Severity vocabulary note

Lenses emit **Critical / Major / Minor / Cosmetic**. Rule 30 and Phase Gate item 10 gate on
**Material / Minor / Cosmetic**. Until those are reconciled, map **Critical + Major → Material**
when reporting to a gate. Recorded here because the mismatch is otherwise invented fresh by
every reader.

---

## A. Data correctness

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| A1 | A read ERROR treated as "no data" — the failure becomes an empty value | Rule 31 tier ladder; L13:125 (write path, AI only) | `fixtures/detection/001-error-vs-missing.md` | The read path had no owner before v2.40. **The dominant class of the 2026-09 wave (~40 recurrences).** |
| A2 | Silent truncation of a paged source | Rule 25 (v2.33 LOADED-N vs `count(*)`); O5, O13; L37 q8 | `fixtures/detection/003-pagination-clamp.md` | Strong and mechanical — but scoped to the data lane. An ordinary paged HTTP API in app code is still unowned. |
| A3 | A collapse/group/dedup key omitting a varying entity | Rule 25; L31 canonical defects | — | |
| A4 | A dedup key derived from POSITION rather than asserted identity | **NONE** | — | A sizeable share of one source's rows were duplicates for months; every count inflated. |
| A5 | A number wrong because a type changed at a boundary (string↔number, `""`→0) | L31:100 (malformed-value passthrough — adjacent only) | — | Widen L31:100 rather than add a check. |
| A6 | Point-in-time identity: a name/code resolved against *today's* catalog | **NONE** | — | A product SKU renamed mid-history: the canonical-key invariant time-versioned the SKU and not the product name. |
| A7 | Selection-conditioned universe (the test population selected by the thing tested) | L32 §4b; O10 | — | |

## B. "Green" that isn't

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| B1 | CI/scan/job-succeeded read as correctness | Rule 25; L37 premise | — | Bob's deepest coverage. |
| B2 | A sub-build fails while its enclosing step reports success | **NONE** | — | Several sub-builds failed inside a green step, two days running. |
| B3 | A guard that silently no-ops (unwritable marker, type mismatch, wrong column) | **NONE** | — | |
| B4 | A guard that blocks or blinds the thing it guards | **NONE** | — | A failing guard skipped the validation gate it stood next to, for two weeks. |
| B5 | A vacuous test/receipt (asserts a property of the stub, not the code) | Rule 28 meta-discipline (documents only) | `fixtures/detection/002-tree-kill.md` | 11 instances in one window; the receipt's blind spot was the defect's location. |
| B5a | A fixture written from the **same source** as the code — passes for the reason the code is wrong | **NONE** | `fixtures/detection/008-fixture-from-the-same-wrong-source.md` | Ask what *independent* authority the test appeals to. For external systems the authority is the emitting **source**, never its docs. |
| B6 | A capability merged but never run / never wired to a caller | Rule 24(b)(1) CTM-diff (capability); L02 | — | 8 instances. A four-round audit passed code no caller invokes. |
| B7 | A consolidation dropping a runnable entrypoint | Rule 26 (imports only) | — | The `if __name__=="__main__"` case is in the founder's CLAUDE.md, not in Bob. |

## C. Running-system behaviour over time

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| C1 | A scheduled job silently stops running | **NONE** (O12 catches the symptom) | — | `grep -ri heartbeat` returns nothing in the whole repo. Natural home: L21. |
| C2 | Absence-detection whose grace window exceeds the longest legitimate gap | **NONE** | `fixtures/detection/004-absence-monitor.md` | The one fixture a fresh reader *failed* — a defect of omission. |
| C3 | A watcher living in its patient's failure domain | **NONE** | — | A scheduled watcher of schedules dies with them. |
| C4 | A verdict from an incomplete observation window | O10 (data); Rule 29 (audit verdicts) | — | The **operational** form — "it's dead" before the known-late window closes — is unowned. Two phantoms in two days. |
| C5 | Shared-queue starvation / eviction | **NONE** | `fixtures/detection/005-queue-starvation.md` | The fix for starvation re-created starvation through another door. |
| C6 | Work parked on a calendar date that could ride an event | **NONE — and Bob does this itself** | — | Bob's own cadences: `days_since_last_run`, "quarterly", "revisit in 6 months". The right pattern already exists in Bob for deferrals ("named revisit triggers"); generalise it. |
| C7 | Budget below measured fixed cost / a bound that cannot fit its own work | **NONE** | — | A time-budget cut below the job's fixed setup cost guaranteed a zero-progress run every week. |
| C8 | A trailing `\|\| true` that cannot catch a step timeout | **NONE** | — | |

## D. Change propagation

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| D1 | Instance fix sold as a class fix | bp:470, 1412, 1958 (**strongest coverage in Bob**) | — | Still recurred ~10× — see Rule 31: the enumeration source must be the grep, never the incident trace. |
| D2 | Two copies of the same logic drifting apart | **NONE** | `fixtures/detection/002-tree-kill.md` (adjacent) | Rule 28 covers structural duplication in *documents* only. The cure is in Rule 26; nothing detects the condition. |
| D3 | A fix that is right where it acts and wrong one level out | **NONE** | — | The stated mechanism behind 26% of PRs being fixes-for-fixes. |
| D4 | A rule added but not backfilled over pre-rule rows | **NONE** | — | Dozens of rows violated the adapter's own rule because the rule postdated them. |
| D5 | A guard applied to one lane, never swept to its sibling | **NONE** | — | |
| D6 | A dependency major changing wire behaviour (not just types) | L06:257 (advice only) | — | Three wire changes where the triage predicted one. |
| D7 | A test that breaks on a future date | **NONE** | — | The exemplar is already in `_data-fidelity-chain.md:39` with no check attached. |

## E. Concurrency and coordination

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| E1 | Read-modify-write race / double-spend | L31 §6 + q7; G13; `_execution-principle.md:59` | — | Well covered for money and jobs. |
| E2 | A cache/lease race at a calendar boundary (day-keyed rows) | **NONE** | — | Two racers either side of 00:00 UTC address different rows and both win. |
| E3 | Parallel agents/sessions clobbering a shared tree | **NONE** — Bob's position is avoidance | — | Four shared-index incidents in one project. See Rule 27's flag in Evolution 008. |
| E4 | A signal/kill that does not reach the real worker | **NONE** | `fixtures/detection/002-tree-kill.md` | |
| E5 | A handler re-arming a signal the launcher deliberately ignored | **NONE** | `fixtures/detection/006-nohup-trap.md` | |

## F. Process and epistemics

| # | Failure mode | Owner | Fixture | Notes |
|---|---|---|---|---|
| F1 | A claim asserted from memory or inherited from another session, never receipted | **NONE** | `fixtures/detection/007-receipts-class.md` | Cost: 12h × 4 sessions, two void remedies, a support ticket nearly filed. |
| F2 | A register/memory row carrying a count never re-measured | **NONE** | — | A remembered row count was several times the real one when finally re-measured, a year later. |
| F3 | An index/pointer stale, so the rule it points at never loads | **NONE** | — | Cost a full session's plan. |
| F3a | A document written to be **retrieved at symptom time** has no inbound reference from anything loaded by default | **NONE** | — | *"It will be found by whoever already knows it exists — which is the population that does not need it."* Caught on this evolution's own census document, by its own thesis. Ask: **what loads by default, and does it point here?** A guidance doc with no inbound link is written, not retrievable — the same distinction as a rule that is filed but never consulted. |
| F4 | A safety gate bypassed "just this once" with a manual equivalent | bp:1235 (setup-side push-back only) | — | No audit-side counterpart, no bypass register. |
| F5 | A spec written without measuring what it commits someone to | **NONE** | — | Distinct from "reproduce before you fix": this binds one step earlier. |
| F6 | An audit whose own oracle cannot see the rows the finding is about | **NONE** | — | The store audit compared the live view against the live view. |
| F7 | A design/prose claim that the code does not support | Rule 28 (spec docs); 26% of one PR census | — | Cheapest high-yield pass there is; needs no runtime knowledge. |

---

## Scoreboard (2026-09-18)

*Machine-verified by `scripts/failure-mode-check.sh` — do not hand-edit these numbers; the
script fails if they drift from a fresh count. (They already did once: this scoreboard was
hand-written as 14/27/7 and was wrong on three of four lines within the hour.)*

- Rows: **43**
- With a named owner: **15**
- **NONE: 28**
- With a fixture: **10**

That ratio is the honest state of the library against the failure modes one real project hit in
twelve days. It is not a reason to add 27 lenses — most of these are one check inside an
existing lens, and several (C6, E3, F3) are things Bob does wrong *itself*. It is a reason to
stop adding content until the enforcement ratio moves.
