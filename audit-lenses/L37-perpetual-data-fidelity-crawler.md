---
id: L37
name: Perpetual Data-Fidelity Crawler
band: 1
band_name: Engineering Foundation
when_to_run: Any data-heavy product where value depends on ingested/derived data being correct — pipelines, ETL, scoring/analytics engines, anything that ingests an external source and derives features/outcomes/served reads. Unlike most lenses this is NOT a one-shot pre-launch pass — it is a STANDING, SCHEDULED job that runs perpetually post-launch (a rotating N-hypotheses-per-run crawler), and also seeds at spec/build time. Skip pure passthrough / no-derivation products.
estimated_duration: 45-90 min for a manual pass (N=5-10 hypotheses); as a standing job, ~15-30 min of compute per scheduled run
session_pattern: fresh session per run; reads the coverage ledger (audit-artifacts/L37-coverage-ledger.json) FIRST to pick an un-crawled slice; reads _data-fidelity-chain.md (the taxonomy + oracle catalog) and _execution-principle.md; biases toward EXECUTING oracle queries against the live DB/source, not reading code
output_markdown: audit-artifacts/L37-perpetual-data-fidelity-crawler-{YYYY-MM-DD}.md
output_json: audit-artifacts/L37-perpetual-data-fidelity-crawler-{YYYY-MM-DD}.json
source_frameworks:
  - Independent-oracle testing (metamorphic / cross-reference testing) — falsify a value against a truth outside itself, not against a same-codebase range assert
  - Data-observability / data-quality-as-monitoring (Monte Carlo / Great Expectations "expectations" + freshness/volume/distribution/schema pillars) — but generative, not a fixed expectation suite
  - Property-based / metamorphic testing (Hypothesis, QuickCheck) — generate falsifiable properties rather than re-run fixed assertions
  - Column-level data lineage + null-rate census (extends L31's step 4b to a STANDING, rotating census)
  - SR 11-7 ongoing-monitoring pillar + selection-bias / pseudo-replication discipline (borrowed from L32 for the S6/method oracles)
  - Bob Engineering Principle #7 — "Green ≠ Correct: run a proactive correctness audit yourself, treat every headline adversarially"
  - Companion reference — audit-lenses/_data-fidelity-chain.md (the 7-stage chain, 7-mode taxonomy, and 13-oracle catalog this lens runs on)
  - Origin case — InsiderIntent D-247, D-267→D-271 (a ~two-dozen-session recurrence of the same fidelity-bug classes, each caught only because a human pushed)
---

# L37 — Perpetual Data-Fidelity Crawler

## Question this lens answers

*Is there a STANDING, GENERATIVE process that continually crawls the whole data-fidelity chain — SOURCE → EXTRACT → INTERPRET/UNITS → LINK/RESOLVE → COLLAPSE/AGGREGATE → OUTCOME/DERIVE → SERVE — and, for a rotating slice of the surface, forms a falsifiable fidelity hypothesis ("this field may be dead / mis-scaled / mis-joined / truncated / stale / blended / a selection artifact") and tests it against an **independent oracle** — before that class of bug bites and a human has to catch it? Or does fidelity depend on a graveyard of incident-encoded checks (each guarding a bug that ALREADY happened) plus one person's attention?*

## Why this lens exists / what other lenses miss

Every data product accumulates a registry of "data-quality invariants" — one named check per bug that already bit. That registry is **reactive by construction**: an incident-encoded check can only fire on a class that has *already happened once* (that's how it got encoded), so it structurally cannot catch the **next, unseen** class. Meanwhile the surface — new fields, sources, joins, derivations, served reads — grows monotonically, and every new surface is an *unmonitored* edge until something breaks on it. The result is a product that is green in CI, "23/23" on its fidelity scan, and *still* silently wrong — because **green verifies syntactic success, never semantic correctness**.

This is the exact recurrence the origin project lived (InsiderIntent, D-267→D-271): 13F dollar values ×1000-inflated for a whole year (Berkshire AAPL stored as **$177 TRILLION**) while the value-sanity check *structurally excluded 13F* and a unit test *hardcoded the wrong cutoff*; `allFilers()` silently returning 1–2 of 25 filers (an 8%-of-universe pipeline); `position_type` 100% `long` on 285k rows (the whole put/call/short story dead); a congress corpus floored at 2024-01 producing a false "Congress has no signal"; an issuer-blind collapse key blending a fund's whole portfolio into one row. **Every one was caught only because the founder pushed a sanity check or a fresh audit stumbled on it — never because a standing check flagged it.** The human was the linchpin.

L37 attacks the five structural causes directly (full argument in `_data-fidelity-chain.md §3`): it is **generative** (forms *new* hypotheses each run, not just re-runs known checks), keeps a **full-chain census** via a rotating **coverage ledger** (so new surfaces get crawled before they bite), tests against **independent oracles** (a value is only "valid" if it survives a truth outside itself — market price, shares×price, the source's own counts — not a same-codebase range assert), **adversarially re-tests every "no signal / too sparse / anti-predictive" claim** (which are usually selection artifacts or floored corpora, not facts), and **moves hypothesis-generation off the human** into a standing job that feeds every confirmed defect back into the reactive registry. It is the *imagination* to the registry's *memory*.

**Distinct from its neighbors — this is the key boundary:**
- **vs L31 (Input & Data-Flow Trace):** L31 is a **one-shot, horizontal TRACE** of the specific input flows you *name*, run once before launch, to prove today's critical flows are wired. L37 is the **standing, generative, perpetual** generalization — it crawls the fields, joins, and derivations you *didn't think to name*, forever, and rotates so coverage compounds. L31 proves the flows you know; L37 hunts the failure modes you don't.
- **vs L32 (Analytical Method Soundness):** L32 is a **point-in-time** judgment of whether one *derivation* (the S6/OUTCOME node) is statistically/causally valid. L37 borrows L32's discipline for its method oracles (O10 selection-bias, O11 pseudo-replication) but applies it **continuously** and as just **one of seven** chain stages — L37 owns the whole chain end-to-end; L32 owns the depth of the method node.
- **vs the reactive fidelity registry:** L37 does **not** replace it — it *feeds* it. Every confirmed L37 finding auto-emits a new reactive invariant (§ self-learning). Registry = cheap replay of known failures on every commit; L37 = scheduled hunt for unknown ones. Run both.

## When this lens fires

- ✅ **Mandatory as a STANDING JOB** — any product that ingests an external source and derives features/outcomes/served reads. This is the one lens meant to run **perpetually post-launch**, not just at audit time. Schedule it (see Audit method § the harness).
- ✅ **At spec/build time** — seed the chain map + the first coverage-ledger entries + the initial oracle set so fidelity monitoring is a first-class spec item, not a late-audit find (the ops-basics principle, Rule 1c).
- ✅ **Immediately after** adding any new source, field, join, derivation, or served read — that new surface is an un-crawled edge; register it in the ledger.
- ✅ **On any "no signal / too sparse / anti-predictive / it's fine" claim** about data — L37 owns the adversarial re-test (O10).
- ⏸ **Skip** — pure passthrough products with no extraction, interpretation, joining, aggregation, or derivation (rare for a data product; note why).

## Audit method (a runnable, generative, perpetual crawl)

L37 is a **loop with memory**. Each run does N hypotheses, logs to a coverage ledger, pages on confirmed defects, and emits a new reactive check per defect. The steps:

### 0. Load state — read the coverage ledger FIRST
Read `audit-artifacts/L37-coverage-ledger.json` (create it on first run). It records, per `(stage, mode, surface)` cell: last-crawled date, oracle used, verdict, and any confirmed finding. **This is what makes coverage compound and stops the crawl re-running the same slice forever while new surfaces rot.** Also read `_data-fidelity-chain.md` (the taxonomy + the 13-oracle catalog) and `_execution-principle.md`.

### 1. Enumerate the surface (the census)
Mechanically list the current surface, so you can detect *new* un-crawled edges:
- **Fields:** every column in every table (query the schema).
- **Sources:** every external feed / adapter.
- **Joins/links:** every foreign-key / entity-resolution edge (CIK↔ticker↔price, etc.).
- **Collapses:** every group-by / dedup / roll-up / materialization key.
- **Derivations:** every computed feature / outcome / stat.
- **Served reads:** every materialized/cached read the product renders.
Diff this against the ledger. **Any surface not in the ledger is a priority slice** (a new unmonitored edge — cause #2 in `_data-fidelity-chain.md §3`).

### 2. Select the rotating slice (coverage that compounds)
Pick N=5–10 `(stage, mode, surface)` cells to crawl this run, prioritising:
1. **New surfaces** (in §1's diff, not in the ledger) — highest priority.
2. **Stale surfaces** (longest since last crawl).
3. **High-blast-radius surfaces** (feed a core value path / a headline stat / a served read).
4. **Never treat "recently green" as "done"** — re-visit on a decay schedule; a surface can rot after a passing crawl (a classifier ships, a source changes).

### 3. GENERATE a falsifiable hypothesis per cell (the generative core)
For each selected cell, *write down a specific, falsifiable fidelity hypothesis* — not "check the data," but a named claim an oracle can kill. Use the taxonomy (`_data-fidelity-chain.md §2`) as the hypothesis grammar:
- coverage → *"`field X` is a dead axis — ~0% populated / floored / absent for a slice."*
- units → *"`value Y` is mis-scaled by a constant (units regression at a rule-change date)."*
- extraction → *"a field-kind in the raw source (e.g. derivative rows, option-kind) never lands in the parsed table."*
- linkage → *"`row` joins to the wrong entity, or a malformed value (a numeric id in a symbol column) passes the boundary."*
- truncation → *"a read is clamped/paginated and returns a fraction of the known universe."*
- collapse → *"a group/dedup key omits an entity that varies → distinct rows blend into one."*
- method → *"this stat is a selection artifact / its independence assumption is violated."*
- staleness → *"rows ingested before `logic Z` shipped carry the old interpretation" / "the served read ≠ the recompute."*
**Be generative — every run is a MIX of old and new (the core requirement, not a nice-to-have):** each pass MUST combine (a) *proven* hypotheses re-run (memory / drift re-test), (b) *never-tried* hypotheses (new templates / new surfaces — imagination), and (c) *old oracles re-targeted through a NEW conditioning slice* (the "same test, new angle" — an oracle clean over the whole population is routinely BROKEN on a sub-slice: microcap, a recent window, options-only, a single sector). Self-generate the batch each run so the *targeting varies* — never re-run an identical fixed suite. Propose at least one hypothesis *template not previously tried on this surface* per run. Fan out sub-agents to enumerate the angle-space if the surface is large. *Reference implementation:* InsiderIntent `scripts/fidelity-crawl.ts` — a generative crawler over an ORACLE × SOURCE × CONDITIONER space with a coverage ledger that draws a fresh proven+novel mix each run (+ a ModelGateway seam for LLM-proposed CONSTRAINED specs — the model proposes tests, the deterministic core computes results, per NEVER-11).

### 4. TEST each hypothesis against an INDEPENDENT ORACLE (execute, don't reason)
Pick from the oracle catalog (`_data-fidelity-chain.md §4`) the oracle whose **truth-source is most independent** of the pipeline that produced the value, and **run it against the live DB / source** — execution evidence over code-reading:

| If the hypothesis is… | Fire oracle |
|---|---|
| mis-scaled / units | **O1** value = Σ(shares×price); **O2** implied-price band vs market; **O8** distribution step-change |
| dead axis / coverage | **O3** null-rate census vs expected; **O5** coverage-depth (min/max date, per-period volume) vs source's own counts |
| extraction loss | **O7** raw-field-kinds vs parsed-field-kinds diff |
| mis-join / malformed | **O2** implied-price undefined; **O6** cross-source fact reconciliation; **O13** row-count conservation |
| silent truncation | **O5**/**O13** stored count vs known-universe count |
| collapse/blend | **O4** collapse-ratio (rows_in vs distinct entities_out) + key-vs-varying-columns |
| method/selection | **O10** raw-volume + split-half/out-of-sample re-test; **O11** clustered/bootstrap t-stat vs naive |
| staleness/drift | **O9** code-vs-data temporal consistency (rows pre-dating the logic); **O12** served ↔ recompute; **O8** drift |

**The independence rule:** a "sanity range" that lives in the same codebase is the *weakest* oracle (it's what already missed the 13F bug). Prefer recompute-from-parts (O1), market price (O2), and the source's own counts (O5/O6) — a bug can't corrupt those the way it corrupted the value.

### 5. Adjudicate + the negative-result discipline
- **Confirmed defect** → record it, page (below), and go to step 6.
- **Refuted** → the value survived the oracle; log the cell as crawled-clean in the ledger with the oracle + date.
- **A "no signal / too sparse / anti-predictive / it's fine" input claim is NEVER accepted at face value** — it triggers O10 mandatorily: verify raw volume first (usually a floor/pipeline bug, O5), then re-test bias-free (split-half / out-of-sample), then count raw rows before believing "untestable." (This is where "Congress has no signal" and "track record is anti-predictive" were both unmasked as artifacts.)

### 6. SELF-LEARN — emit two artifacts per confirmed defect (imagination → memory)
Every confirmed defect **must** emit both (`_data-fidelity-chain.md §5`):
- **(a) a new reactive invariant** — a named, cheap, deterministic check for the specific class, written in the shape of the project's incident-encoded registry (e.g. add `assert13FValueMatchesSharesTimesPrice` to `lib/dq/fidelity.ts`). The crawl found it once; the registry now catches it forever, for free, on every commit.
- **(b) a lens-retro fragment** (per `_lens-retro.md` Tier 1) — which oracle fired, generative-new vs re-confirm, false positives, and **the new hypothesis *template*** the finding suggests (so the *class* of angle propagates library-wide, e.g. "units bugs cluster at regulatory rule-change dates → add a standing O9 sweep keyed on every known rule-effective date"). Humans adjudicate which templates to promote (D-005: Bob never auto-edits its own lenses).

### 7. Update the ledger + rank
Write every crawled cell (clean or defect) back to `L37-coverage-ledger.json`. Rank confirmed defects by **blast radius** (feeds a core value path / a served headline) × **silence** (how long it would keep lying undetected).

### The harness (how it runs PERPETUALLY)
L37 is designed to be a **scheduled standing job**, not only a manual pass. Cadence/model:
- **A standing job** (Vercel Cron → queue → worker, or the project's scheduler) runs L37 on a cadence (e.g. nightly, or per-pipeline-run). Each invocation does **N hypotheses** (§2–§5), so the whole surface is covered over a rotating window rather than all at once — coverage **compounds** via the ledger.
- **It logs every run** to the coverage ledger (the durable memory of what's been crawled, when, with what verdict).
- **It pages on confirmed defects** (Sentry / Slack / the project's alert lane) — a confirmed fidelity defect is an incident, not a warning.
- **It auto-opens the (a)/(b) emit** as a draft PR / ticket for the new reactive invariant + the retro fragment (human merges — D-005).
- **Degrade gracefully:** if the DB/source is unreachable, log "could not verify live" for that cell (do NOT mark it clean — an un-run oracle is not a passed oracle), and retry next cycle.
- **Flush incrementally** (A7.1 resilience): write each confirmed cell to the ledger as it resolves, so a mid-run drop loses at most one cell.

## Check questions

1. Does the coverage ledger exist, and did you read it FIRST to pick an un-crawled/stale slice (not re-run a recently-green one)?
2. Did you census the current surface (fields/sources/joins/collapses/derivations/served-reads) and diff it against the ledger to find **new unmonitored edges**?
3. For each slice, did you write a **specific, falsifiable** fidelity hypothesis (not "check the data")?
4. Did you propose at least one hypothesis **template not previously tried** on this surface (the generative mandate)?
5. Did you test each hypothesis against an **independent oracle** — and pick the one whose truth-source is *most independent* of the pipeline (recompute/market/source-counts over same-codebase range asserts)?
6. Did you **execute** the oracle against the live DB/source, not reason from code?
7. For every column: did you census the **null-rate** (O3)? Any ~0% **dead axis** the spec expects downstream?
8. For every stored source: does `min/max(date)` and per-period volume match the **source's own** counts (O5)? Any floor/truncation?
9. For every group-by/collapse: does the key capture everything that varies, and is the **collapse ratio** as expected (O4)? Any blend?
10. For every aggregate value: does it reconcile to `Σ(shares×price)` / an implied-price band (O1/O2)? Any mis-scale?
11. Did any **"no signal / too sparse / anti-predictive / it's fine"** claim get the O10 adversarial re-test (raw volume → split-half → out-of-sample), not a face-value pass?
12. For any headline stat: did you check independence (clustering / overlapping windows) with a clustered/bootstrap re-estimate (O11)?
13. For meaning-dependent fields: did you check **code-vs-data temporal consistency** (O9) — rows ingested before the logic that should shape them?
14. Does the **served** read equal the **recompute**, within the freshness SLA (O12)?
15. For every confirmed defect: did you emit **(a)** a new reactive invariant AND **(b)** a retro fragment with a reusable hypothesis template?
16. Did you write every crawled cell (clean or defect) back to the ledger, and is L37 **scheduled** to run perpetually — not just this once?

## Output schema

### Markdown report
```markdown
# L37 — Perpetual Data-Fidelity Crawler — {YYYY-MM-DD}
## Run summary
| Run # | Slices crawled (N) | New surfaces found | Confirmed defects | Refuted (clean) | Could-not-verify-live |
## Surface census & ledger diff
| Surface (field/source/join/collapse/derivation/served) | In ledger? | Last crawled | Selected this run? | Why |
## Hypotheses tested (the generative core)
| # | Stage | Mode | Surface | Hypothesis (falsifiable) | Oracle | Executed? | Verdict |
## Confirmed defects
| # | Stage · Mode | Surface | Oracle evidence (query + result) | Blast radius | Silence (how long undetected) |
## Negative-result re-tests (O10)
| Claim re-tested | Raw-volume check | Bias-free re-test | Verdict (real / artifact) |
## Self-learning emit (per confirmed defect)
| Defect | (a) New reactive invariant (name + where) | (b) Retro-fragment hypothesis template |
## Coverage ledger — updated
## Top findings (ranked by blast radius × silence)
## Findings (full, severity-tagged, JSON-mirrored)
```

### JSON sidecar
```json
{
  "lens_id": "L37",
  "lens_name": "Perpetual Data-Fidelity Crawler",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "run_number": 0,
  "slices_crawled": 0,
  "new_surfaces_found": 0,
  "hypotheses_tested": 0,
  "generative_new_templates": 0,
  "confirmed_defects": 0,
  "refuted_clean": 0,
  "could_not_verify_live": 0,
  "executed_against_live_data": false,
  "negative_claims_retested": 0,
  "coverage_ledger_path": "audit-artifacts/L37-coverage-ledger.json",
  "findings": [
    {
      "id": "L37-F001",
      "severity": "critical|major|minor|cosmetic",
      "stage": "source|extract|interpret_units|link_resolve|collapse_aggregate|outcome_derive|serve",
      "mode": "coverage_dead_axis|extraction_loss|interpretation_units|linkage_resolution|silent_truncation|collapse_blend|method_selection|staleness_drift",
      "surface": "{field/source/join/collapse/derivation/served-read}",
      "hypothesis": "{the falsifiable claim}",
      "oracle": "O1|O2|O3|O4|O5|O6|O7|O8|O9|O10|O11|O12|O13",
      "oracle_evidence": "{query + observed result — the external-truth comparison}",
      "blast_radius": "{what downstream is corrupted}",
      "silence": "{how long it would keep lying undetected}",
      "emitted_reactive_invariant": "{name + where it was added}",
      "retro_template": "{the reusable hypothesis template}",
      "recommendation": "{1-sentence}"
    }
  ],
  "coverage_ledger_updates": [],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)
- **Critical** — a confirmed defect corrupting a core value path or a served headline that has been (or would keep) silently lying: a whole-slice mis-scale (the ×1000 13F class), a dead axis a scored feature reads (the `position_type` class), a universe-truncating pipeline (the `allFilers()` class), a portfolio-blending collapse, or a headline stat that's a selection artifact. Also: NO standing L37 job exists on a data product (the linchpin-is-a-human state).
- **Major** — a confirmed defect on a non-core surface; a new unmonitored surface with no ledger entry and no oracle; a "no signal" claim shipped without the O10 re-test; a confirmed defect that did NOT emit its reactive invariant (imagination didn't feed memory).
- **Minor** — a slice long overdue for a crawl; an oracle available but weaker-than-ideal (same-codebase range vs an external truth); a distribution drift not yet alerting.
- **Cosmetic** — ledger hygiene; a hypothesis phrased non-falsifiably; documentation of the crawl.

## Anti-patterns / Bias instructions
- **Do NOT re-run the registry and call it a crawl.** Re-running known incident-encoded checks is the *reactive* layer's job. L37's mandate is **generative** — form hypotheses the registry doesn't have yet. If a run produced no new hypothesis template, it under-delivered.
- **Do NOT validate a value against itself.** "It's a plausible number" is not fidelity. Every hypothesis needs an **external oracle** that can *falsify* it (recompute from parts, market price, the source's own counts, a second source). A same-codebase range assert is the oracle that already missed.
- **Do NOT accept "no signal / too sparse / anti-predictive / it's fine."** These are the highest-yield artifacts. Raw-volume first, then bias-free re-test (O10). Face-value acceptance is a critical anti-pattern here.
- **Do NOT reason from code when you can query the data.** A null-rate, a collapse ratio, a min-date, an implied price — all are one query away. Execution evidence > inference (the Execution Principle).
- **Do NOT mark an un-run oracle as clean.** If you couldn't reach the DB/source, log "could not verify live" — an unexecuted oracle is not a passed oracle. (Delegate-verifiable-calls: never trust ledger text over a live check.)
- **Do NOT let coverage stall.** Rotate. A surface green three runs ago can rot (a classifier ships, a source changes). The ledger's decay schedule, not "we checked it once," decides.
- **Do NOT skip the self-learning emit.** A confirmed defect that doesn't write back a reactive invariant leaves the human as the wire. The emit is the point.

## Stop conditions
1. **Not a data product** (pure passthrough, no extraction/interpretation/join/aggregate/derivation). Note why and skip — but confirm there really is *no* derivation before skipping.
2. **No live DB/source access** — run statically against schema + code, form the hypotheses, and explicitly flag every oracle as *un-executed / could-not-verify-live*; recommend re-running where the data can be queried. Do NOT claim a slice is clean without running its oracle.
3. **First run on a mature product** — the surface is huge and the ledger is empty. Do NOT try to crawl everything at once; seed the ledger with the full surface, crawl the top-N by blast radius this run, and let the rotating schedule compound. Say so — no silent truncation of the surface.

## Cross-lens handoff
- **Upstream:** L02 (which fields/derivations the spec expects — the "expected" in the null-rate census), L31 (the flows already traced — L37 picks up the fields/joins L31 named and crawls the ones it didn't), L32 (the method discipline L37 borrows for O10/O11).
- **Downstream:**
  - **The reactive fidelity registry** — every confirmed L37 finding emits a new named invariant (the (a) emit).
  - **L21 (Observability & Incident Readiness)** — the standing L37 job IS a data-observability incident lane; hand it the paging/alerting wiring.
  - **L32 (Analytical Method Soundness)** — any S6/OUTCOME defect L37 surfaces (a selection artifact, an inflated t-stat) hands to L32 for the deep method review.
  - **The lens library** (via `_lens-retro.md`) — the (b) retro templates propagate the new hypothesis *classes* library-wide, under human judgment.
- **Adjacent (~15% overlap):**
  - **L31** — both trace data; L31 is one-shot/named-flows/horizontal, L37 is perpetual/rotating/generative across the whole surface. The overlap (a field L31 traced) becomes L37's confirmation signal.
  - **L32** — both touch the method node; L32 owns depth-at-a-point, L37 owns breadth-over-time and only borrows the discipline for one of seven stages.
