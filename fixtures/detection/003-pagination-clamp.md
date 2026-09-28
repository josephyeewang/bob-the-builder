# IC-003 — "Every owner" silently meant about one

- **Source:** a production data app (anonymized); the class recurred several more times in the
  same project
- **Class:** `silent-truncation` (paged source caps below the real population)
- **Detection mode:** CODE-READ-ONLY (given the storage-layout fact)
- **Earliest preventable phase:** BUILD
- **Cost:** for months, generated reports existed for fewer than half of the accounts; the
  product promised one per account. Nothing errored — a truncated read is indistinguishable from a
  small table.
- **Baseline test result (2026-09-18): CAUGHT**, with the exact symptom predicted.

## THE PROMPT (hand this over, nothing else)

This function loads every owner that currently has live records, so a nightly job can produce
one generated report per owner. `db` is a client for a hosted database's HTTP API (a REST
layer over Postgres).

```ts
/** Every owner with at least one live record. */
export async function liveOwners(): Promise<string[]> {
  const { data } = await db.from("table_a").select("owner_id").eq("live", true);
  return [...new Set((data ?? []).map((r) => r.owner_id as string))];
}

// caller
const owners = await liveOwners();
console.log(`writing summaries for ${owners.length} owners…`);
for (const o of owners) { await summarizeAndStore(o); }
```

Context you may assume: `table_a` has many thousands of live rows across dozens of
distinct owners, and rows are physically stored grouped by owner (all of one owner's records
sit together).

**QUESTION:** Will this do what its comment claims? List any defect, most severe first, and
state what its visible symptom would be.

## THE ANSWER

**1. The response is capped server-side.** REST layers of this kind commonly return at most a
fixed number of rows per response (here, 1000) regardless of `.limit()` — live-verified in the
original project: asking for more returned exactly the cap. This code pages not at all, so it
sees the first ~1000 of many thousands of rows.

That alone would lose owners. The storage layout makes it catastrophic: because rows are
clustered by owner, the first 1000 rows are **all (or nearly all) one owner's**. The `Set`
then collapses to a list of ~1 owner, not dozens.

**Visible symptom:** the log prints `writing summaries for 1 owners…` instead of dozens. The job
exits 0 every night, writing a summary for one owner and silently none for the rest.

**2. The error is discarded.** `const { data } = ...` ignores the `error` field the client
always returns alongside. On any failure `data` is empty, `?? []` swallows it, and the job logs
`writing summaries for 0 owners…` and exits successfully — the error-vs-missing class
(fixture 001) in the same four lines.

**Fix:** page to exhaustion by keyset on an indexed column (never OFFSET — an OFFSET walk over
a table this size drove billions of sequential row reads elsewhere in the same project), or
query a dedicated distinct-owner view instead of scanning every row; and check `error`
explicitly.

## WHY EVERY GREEN SIGNAL WAS GREEN

- Nothing throws. A short read is a legal read.
- The count is *plausible* if you do not know the true population. **The tell is a suspiciously
  round number** — the original project twice had an ad-hoc count return exactly the cap and
  compared two explanations as though both were complete.
- Downstream is genuinely fine: one report per owner returned, correctly written, correctly
  stored. The defect is in the *denominator*, which nothing downstream can see.

## THE CHECK THAT CATCHES IT

Rule 25 (v2.33): **census LOADED-N against the source's own `count(*)`, per partition,** before
trusting anything computed from a fetch. Here: `select count(*) from table_a where live` →
many thousands against a `data.length` of 1000, or `count(distinct owner_id)` → dozens
against a result of 1.

Ask it as: *"what number does this code believe the population is, and has anyone compared that
to the source's own count?"*

## SCORING A CANDIDATE

- **Full marks:** names the server-side cap, connects it to the clustered storage layout to
  predict ~1 owner (not merely "some are missing"), and flags the discarded `error`.
- **Partial:** identifies the missing pagination but treats the loss as a random subset.
- **Miss:** reads the function as correct, or only suggests adding `.limit(100000)` — which does
  not work and is the exact fix that silently failed in the original project's history.
