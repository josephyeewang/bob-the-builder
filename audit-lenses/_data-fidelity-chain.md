# The Data-Fidelity Chain — Failure Taxonomy & Oracle Catalog

> The reference companion to **L37 — Perpetual Data-Fidelity Crawler**. This file holds the three things L37 draws on every run: (1) the **7-stage chain** every datum passes through and the **failure modes** at each stage, (2) the argument for **why reactive, incident-encoded checks structurally cannot prevent the next bug**, and (3) the **oracle catalog** — the independent cross-checks that let a crawl *falsify* a fidelity hypothesis against a truth that lives outside the value itself. L37 is the runnable procedure; this is the theory it runs on.
>
> **Origin:** the InsiderIntent build (a data-heavy investing-intelligence platform), decision entries D-247 and D-267→D-271. Over ~two dozen sessions the *same classes* of data-fidelity bug kept surfacing — each caught only because a human pushed a logical sanity check or a fresh audit stumbled on it, **never** because a standing check flagged it. The registry of ~23 named invariants (`lib/dq/fidelity.ts` in that project) was doing its job — but its job was structurally reactive. This file exists so the next builder doesn't have to *be* that human.

---

## 1. The chain — every datum passes through 7 stages

Data fidelity is not a property of a table. It is a property of a **pipeline**, and the pipeline has stages, and a value can be perfectly faithful at stage *k* and corrupt at stage *k+1*. Frame the whole thing as a directed chain and every bug lands on exactly one edge:

```
SOURCE → EXTRACT → INTERPRET/UNITS → LINK/RESOLVE → COLLAPSE/AGGREGATE → OUTCOME/DERIVE → SERVE
```

| # | Stage | What it does | The truth it must preserve |
|---|---|---|---|
| S1 | **SOURCE** | acquire the raw feed (filing, API, scrape) | *coverage* — the full universe, the full history, every period |
| S2 | **EXTRACT** | parse raw → fields (XBRL, HTML tables, PDF) | *completeness* — every field the source carries actually lands in a column |
| S3 | **INTERPRET/UNITS** | typecast, scale, classify, normalize | *meaning* — the number means what the source meant (units, sign, kind) |
| S4 | **LINK/RESOLVE** | join to canonical entities (CIK↔ticker↔price) | *correspondence* — the row points at the real-world thing it claims to |
| S5 | **COLLAPSE/AGGREGATE** | dedup, group-by, roll-up, collapse-key | *identity* — distinct entities stay distinct; the group key captures everything that varies |
| S6 | **OUTCOME/DERIVE** | compute features, outcomes, stats (CAR, move_5d, t-stats) | *soundness* — the derivation is causally/statistically valid, no look-ahead, no selection artifact |
| S7 | **SERVE** | materialize/cache the read the product renders | *currency* — what's served matches what was computed; nothing stale, nothing floored |

A datum is **faithful end-to-end** only if it survives all seven edges intact. The registry-of-invariants approach guards a handful of *points*; L37 walks the *edges*.

---

## 2. The failure taxonomy — 7 modes, mapped to the origin bugs

Seven recurring failure **modes** cut across the seven stages. Each origin bug (the raw material the founder handed over) maps to exactly one stage × one mode. This table IS the hypothesis space L37 samples from — every crawl picks a `(stage, mode, surface)` cell it hasn't recently tested.

| Mode | Definition | Primary stage | Origin bug (InsiderIntent) | How "green" hid it |
|---|---|---|---|---|
| **Coverage / dead-axis** | a field/source is null, floored, or absent for a whole slice — a *dead axis*, not a "no signal" result | S1, S2 | `move_5d` 100% null on 411k rows; `position_type` 100% `long` on 285k Form-4 rows (the whole put/call/short "Signal Symmetry" story silently dead); congress corpus floored at 2024-01 (Pelosi's legendary trades not even ingested → a false "Congress has no signal") | the job *ran*; the scored feature simply read null and produced nothing on that axis |
| **Extraction loss** | the source carries a field the parser never captures, or mangles | S2 | Form-4 Table-II derivatives never parsed; congress option-kind stripped to "Common Stock" upstream | parser exited 0; the missing column was simply never there to check |
| **Interpretation / units** | right value, wrong meaning — scale, sign, or kind mis-cast | S3 | 13F dollar values ×1000-inflated for a whole filing-year (a `normalize13FValue` cutoff hardcoded to 2024-01-01 when the SEC whole-dollar rule took effect **2023-01-03**) → Berkshire AAPL stored as **$177 TRILLION** | the value-sanity check **structurally excluded 13F**; a unit test **hardcoded the same wrong cutoff** — green while *encoding* the bug |
| **Linkage / resolution** | row joins to the wrong entity, or a malformed value passes a boundary | S4 | a CIK (all-numeric string) leaked into the `ticker` column → never joins to prices | the write succeeded; a numeric string is a valid string |
| **Silent truncation** | a read is clamped/paginated and returns a fraction, silently | S4 | `allFilers()` did an unpaginated `.select()` → PostgREST's ~1000-row clamp returned **1–2 of 25 filers** → the daily derivation lane processed **8% of the universe** | the query returned 200 OK with rows; nobody counted them against the known universe |
| **Collapse / blend** | a group/dedup/collapse key omits an entity that varies → distinct rows merge into one with an arbitrary survivor | S5 | an action-collapse key omitting `issuer` → a 13F filer's whole multi-ticker portfolio blended into **one row** with an averaged CAR across unrelated tickers (793 rows → 47) | the group-by ran; a 10:1 collapse looks like healthy dedup unless you expected ~1:1 |
| **Method / selection artifact** | the derivation is statistically or causally invalid | S6 | "track record is anti-predictive" (a regression-to-mean **selection artifact** from conditioning on realized outcome); naive iid t-stats inflated ~2–3× by issuer pseudo-replication + overlapping windows | the stat computed cleanly and returned a plausible, *wrong*, headline |
| **Staleness / drift** | data or a pipeline lags a code/rule change, or a derivation silently stops | S3, S7 | 34 congress PUT rows stored as bullish `long` because ingested **one day before** the instrument classifier shipped; dead pipelines; a reconcile query that grew past the DB statement timeout and **hard-failed two production crons**; served reads floored/stale | the historical rows were never re-run; the cron "succeeded" until it timed out |

**The tell that unifies them:** in every case *the value parsed, the job exited 0, and CI was green* — yet the value was semantically wrong, incomplete, mis-scaled, mis-joined, blended, or drawn from an invalid method. **Green verifies syntactic success; it says nothing about meaning.**

---

## 3. Why reactive, incident-encoded checks structurally cannot prevent the next bug

The existing defense in the origin project was a registry of ~23 named invariants — one per bug that *already happened*. This is necessary but structurally insufficient, for five compounding reasons. L37 exists to attack each one.

1. **Reactive-by-construction — the first instance always escapes.** An incident-encoded check can only fire on a class of bug that has *already bitten once* (that's how it got encoded). By definition it cannot catch the *next, unseen* class. The registry is a graveyard of past incidents, not a radar for future ones. → L37 is **generative**: it forms *new* hypotheses each run rather than only re-running known checks.

2. **No full-chain census — every new surface is an unmonitored edge.** Every new field, source, join, or derivation added after the registry was written is an *unmonitored* surface until something breaks on it. The surface grows monotonically; the checks don't. `position_type` and `move_5d` were dead for months because nothing was *watching every column's null-rate as a standing census*. → L37 keeps a **coverage ledger** and rotates across the *whole* surface so new edges get crawled before they bite.

3. **No independent oracle — "valid" means "it parsed," never "it matches an external truth."** A value-sanity check that asks "is this a plausible number?" is checking the value *against itself*. $177 trillion only looks wrong if you cross it against `shares × price` or a market-cap ceiling — an **oracle outside the value**. The registry had no oracles; it had range asserts, and the 13F range assert was even *excluded* for 13F. → L37's core move is **independent-oracle cross-checks** (§4).

4. **"No signal" is taken at face value.** "Congress has no signal" and "track record is anti-predictive" were both *artifacts* — a floored corpus and a selection bias — not facts. A reactive registry has no mandate to *distrust a negative result*; it only checks for positive corruption. → L37 **adversarially re-tests every "no signal / too sparse / anti-predictive" claim** (raw-volume verification, split-half, bias-free re-test) as a first-class hypothesis type.

5. **The human is the generative hypothesis source.** The load-bearing part of the old loop was *a person* asking "wait, that can't be right." That doesn't scale, it's non-continuous, and it makes fidelity depend on one linchpin's attention. → L37 **moves hypothesis-generation into a standing job** and feeds every confirmed defect *back* into the reactive registry, so the two layers compound instead of the human bridging them.

**The relationship, stated once:** the reactive registry (incident-encoded invariants) is the **memory**; L37 is the **imagination**. Memory replays known failures cheaply on every commit. Imagination hunts unknown ones on a schedule and, on every confirmed hit, *writes a new memory* (§5). Neither replaces the other. A project with only the registry is blind to the next class; a project with only L37 pays to re-derive known bugs. Run both.

---

## 4. The Oracle Catalog — independent cross-checks

An **oracle** is a source of truth that lives *outside the value being checked*, so it can *falsify* the value rather than merely confirm it parses. This is the heart of L37: a fidelity hypothesis ("this field may be mis-scaled") is only worth forming if there's an oracle that can *kill* it. Each entry gives the oracle, the formula/method, the stage/mode it guards, and the origin bug it would have caught.

| # | Oracle | Method / formula | Guards (stage · mode) | Would have caught |
|---|---|---|---|---|
| **O1** | **Value ↔ constituents identity** | for any aggregate value, recompute from parts and compare: `\|value − Σ(shares × price)\| / value < ε`. For 13F: reported market value vs `shares_held × period_end_price`. | S3 · interpretation/units | the ×1000 13F inflation ($177T vs a few $B in `shares×price`) — off by exactly 1000× |
| **O2** | **Implied-price sanity band** | back out an implied unit price from the row (`value / quantity`) and assert it sits in a plausible band vs the market price for that security/date (e.g. within 1–2 orders of magnitude). | S3 · interpretation/units; S4 · linkage | the ×1000 scale bug (implied price 1000× the real quote); a CIK-in-ticker (no price at all → implied price undefined) |
| **O3** | **Null-rate census vs expected** | for **every** column, standing: `count(col IS NOT NULL)/count(*)`, tracked over time, compared to a declared expectation. **~0% where the spec expects data = a DEAD axis**, not "no signal." Flag any column whose populated-rate crosses a floor or *drops* between runs. | S2 · coverage/dead-axis | `move_5d` 100% null; `position_type` 100% `long`; any silently-dead scored feature |
| **O4** | **Collapse-ratio audit** | for every group-by/dedup/collapse, compare `rows_in` vs `distinct(entities_out)` and inspect the **key against the set of columns that vary**. A collapse of ~10:1 where you expected ~1:1, or a key missing an entity present in the varying set, is a **blend bug**. | S5 · collapse/blend | the `(owner, day, direction)` key omitting `issuer` → 793→47 portfolio blend with averaged CAR |
| **O5** | **Coverage-depth vs source truth** | census `min/max(date)` and per-period row volume of a stored source against the *source's own* published counts (EDGAR full-text search totals, a filer's own filing index, an API's `total`). A stored `min(date)` **later** than the source's earliest, or a per-period count **below** the source's, is a floor/truncation. | S1 · coverage; S4 · silent truncation | congress corpus floored at 2024-01 (source has years more); `allFilers()` returning 1–2 of 25 (universe count known) |
| **O6** | **Cross-source fact reconciliation** | the same fact from ≥2 independent sources must agree within tolerance (a filer's AUM from 13F vs a data vendor; a ticker↔CIK map from SEC vs the price feed; shares outstanding from two filings). Disagreement past tolerance = one source is wrong. | S4 · linkage/resolution | the CIK-in-ticker leak (SEC CIK↔ticker map disagrees with what's stored); mis-joins generally |
| **O7** | **Extraction-completeness diff** | count *distinct field types / line kinds* present in the **raw** source vs present in the **parsed** table. A kind in the raw that never appears parsed = extraction loss. (e.g. count Table-II derivative rows in raw Form-4 XML vs derivative rows stored.) | S2 · extraction loss | Form-4 Table-II derivatives never parsed; option-kind stripped to "Common Stock" |
| **O8** | **Distribution / drift monitor** | per column, track the distribution (histogram, quantiles, category mix) run-over-run; alert on a step-change. A field that was 40% puts and is now 0% puts, or a value column whose median jumped 1000×, flags an upstream change (a classifier ship, a units regression). | S3 · staleness/drift; S3 · units | the classifier-ship boundary (34 PUTs mis-stored `long`); a units regression showing as a median step |
| **O9** | **Code-vs-data temporal consistency** | for any field whose meaning depends on a code/rule change (a classifier, a normalization cutoff, a SEC rule date), assert **no rows exist whose `knowledge_time` predates the classifier's ship date carry the *old* interpretation** — i.e. re-derive or flag rows ingested before the logic that should have shaped them. | S3 · staleness/drift | the 34 congress PUTs ingested one day before the classifier shipped; the 2023-01-03 SEC-rule vs 2024-01-01 hardcoded cutoff |
| **O10** | **Selection-bias / negative-result re-test** | never accept "no signal / anti-predictive / too sparse" at face value. For a **negative** result: (a) verify **raw volume** first (is the corpus actually there? — usually a pipeline/floor bug, O5); (b) re-test **bias-free** — split-half or out-of-sample instead of conditioning on realized outcome; (c) for sparsity, count raw rows before believing "untestable." | S6 · method/selection; S1 · coverage | "track record is anti-predictive" (regression-to-mean selection artifact); "congress has no signal" (really a floored corpus) |
| **O11** | **Pseudo-replication / clustering check** | before trusting any t-stat/Sharpe, check the independence assumption: are observations clustered (same issuer, overlapping windows)? Recompute with clustered/HAC errors or a block bootstrap and compare. A naive-to-clustered t-stat ratio ≫1 means the headline is inflated. | S6 · method | the ~2–3× inflated iid t-stats from issuer pseudo-replication + overlapping event windows |
| **O12** | **Served ↔ computed reconciliation** | the materialized/served read must equal the freshly-computed value for a sample of keys, and its `computed_at` must be within the freshness SLA. A served value that differs from a recompute, or whose `computed_at` is stale, is a serve-layer drift/floor. | S7 · staleness/drift | stale/floored served reads; a dead materialization pipeline (the D-247 "materialize web reads" class) |
| **O13** | **Row-count conservation across a transform** | for transforms that should preserve or predictably change cardinality, assert `rows_out` matches the expected function of `rows_in` (1:1 map → equal; explode → ≥; filter → declared predicate count). An unexplained drop = a silent filter/clamp/join-miss. | S4 · silent truncation; S4 · linkage | `allFilers()` clamp; any join that silently drops unmatched rows |

**Oracle-selection heuristic for a crawl:** pick the oracle whose *truth-source is most independent* of the pipeline that produced the value. O1/O2 (recompute from parts, market price) and O5/O6 (the source's own counts, a second source) are the strongest because they can't be corrupted by the same bug that corrupted the value. A "sanity range" that lives in the same codebase (the failed 13F range assert) is the *weakest* oracle — it's the one that was already there and still missed.

---

## 5. The self-learning emit — how a confirmed crawl finding feeds the reactive layer

The chain and the oracle catalog are static reference. The *loop* is what makes L37 compound: **every confirmed new defect the crawl finds must emit two artifacts**, closing imagination → memory.

- **(a) A new reactive invariant** — a named, cheap, deterministic check for the *specific* class just found, written in the shape of the project's incident-encoded registry (e.g. add `assert13FValueMatchesSharesTimesPrice` to `lib/dq/fidelity.ts`). This is the memory-write: the next commit replays it for free. The crawl found it once; the registry now catches it forever.
- **(b) A lens retro fragment** — per `_lens-retro.md` Tier 1: which oracle fired, whether the hypothesis was generative-new vs a re-confirm, false positives, and (crucially) **the new hypothesis *template* the finding suggests** — so the *class* of angle propagates to other projects, not just this instance. (e.g. "units bugs cluster at regulatory-rule-change dates → add a standing O9 sweep keyed on every known rule-effective date.")

This is the mechanism that dissolves the "human as linchpin" problem: the human used to *be* both the imagination (new hypotheses) and the wire (turning a caught bug into a standing check). L37 automates the imagination; the (a)/(b) emit automates the wire. The human's remaining job is judgment on the *retro* — which templates to promote library-wide — which is exactly the D-005 "Bob never auto-edits its own lenses" boundary, preserved.

---

## 6. Cross-reference — where this sits in the lens library

- **L31 (Input & Data-Flow Trace)** — a **one-shot, horizontal TRACE** of a specific input flow field-by-field, run before launch. It proves *today's* critical flows are wired. It does **not** run perpetually, does **not** rotate coverage, and does **not** generate new hypotheses. L37 is the *standing* generalization of the same instinct: L31 traces the flows you name; L37 crawls the flows (and fields, and joins, and derivations) you *didn't think to name*, forever.
- **L32 (Analytical Method Soundness)** — judges whether a **derivation** (stage S6) is statistically/causally valid, as a point-in-time review. L37 *borrows* L32's discipline for its S6/method oracles (O10/O11) but applies it continuously and as one stage of seven — L37 owns the whole chain, L32 owns the depth of the method node.
- **The reactive registry** (`lib/dq/fidelity.ts` and its analogues) — the memory L37 writes back to (§5). L37 is not a replacement; it's the generative front-end that keeps the registry growing ahead of incidents instead of behind them.
