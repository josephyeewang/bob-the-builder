# IC-001 — A failed read that looks like "no data"

- **Source:** a production data app (anonymized); a chain of five fix PRs over two days
- **Class:** `silent-empty-on-error`
- **Detection mode:** CODE-READ-ONLY (no test failed; no run went red; every page rendered)
- **Earliest preventable phase:** SPEC/DESIGN
- **Cost:** five PRs over two days, each finding the previous one stopped short

## THE PROMPT (what a candidate auditor is given — no spoilers)

You are auditing a product that precomputes expensive answers into a `served_view` table
overnight, so that web requests only read stored rows. Here is the shared reader and two of
its callers. Find any defect that would put a wrong number in front of a user.

```ts
// the shared reader
async function readServedLatest<T>(kind: string): Promise<T | null> {
  const { data, error } = await db.from("served_view").select("payload")
    .eq("kind", kind).order("built_at", { ascending: false }).limit(1);
  if (error) return null;
  return (data?.[0]?.payload ?? null) as T | null;
}

// caller A — a web request rendering a summary table
const rows = (await readServedLatest<Row[]>("table_a")) ?? [];
return rows;

// caller B — the nightly job that builds and PERSISTS a derived summary
const related = (await readServedLatest<Row[]>("table_a")) ?? [];
const summary = buildSummary(related);   // per-entity overlap counts feed each card
await writeServed("table_b", today, summary);
```

## THE ANSWER

`readServedLatest` collapses **two different facts into one value**: "the read failed"
(`error`) and "there is no row yet" (`data` empty) both return `null`. Every caller then
applies `?? []`, so a transient database error is indistinguishable from an empty universe.

- In **caller A** that is merely wrong for one request — acceptable, even desirable.
- In **caller B** it is a durable data corruption: a mid-build read error produces a
  **freshly-built, green, complete-looking `table_b` in which every overlap count is 0**,
  and it serves until the next successful build. Nothing errors. Nothing alerts. The summary
  looks authoritative because it *is* today's summary.

The deeper defect is that the codebase had exactly **one** error posture for a function with
**two classes of caller**. A read has four states (available / stale / missing / errored) and
callers come in two kinds (a request that may degrade, a builder that must refuse) — eight
cases, of which the design specified one.

## WHY IT SURVIVED FOUR FIXES

- **Fix 1** fixed the request-path loaders the incident trace named. An audit then found
  **as many again** with identical fall-through that the trace hadn't touched.
- **Fix 2** fixed the builders — and an audit found **three surviving sites**.
- **Fix 3** fixed those three — and an audit found a writer where the zeroed counts
  reach an **AI-written summary** ("no overlap found") and persist until the next weekly build.
- **Fix 4** guarded that writer — and an audit found its **twin**: a second copy of the
  same persist loop, called by a different script minutes earlier in the same workflow.
- **Fix 5** stopped fixing sites and **deleted the duplication**, collapsing both loops into one
  guarded function. That is when the class actually closed.

## THE CHECKS THAT CATCH IT

1. **Failure-semantics matrix (design time).** For every shared dependency, fill a table:
   rows = {errored, missing, stale, truncated}, columns = {request path, builder/writer}.
   Every cell states the required behaviour. An unfilled cell is an unspecified behaviour,
   which means it will be decided by whoever writes the first `?? []`.
2. **Grep the collapse (build/audit time).**
   `grep -rn "catch(() *=> *\[\])\|?? \[\]\|catch {}\|return null" <shared readers>` — for each
   hit ask: *does an error here become a value that a later step will persist or display?*
3. **The persisted-artifact question (audit time).** For every row a pipeline writes, ask:
   *could this row have been produced by a failed input read, and would it look any different
   if it had been?* If the answer is "no different," the builder needs a throw, not a default.
4. **Census, not instance (build time).** A fix for this class is not done when the named sites
   are fixed. It is done when `grep` for the *pattern* returns only fixed sites — and it is
   only structurally done when duplicated copies of the logic are collapsed, because the next
   copy will re-introduce it.

## SCORING A CANDIDATE AUDITOR

- **Full marks:** names the error/missing conflation AND distinguishes caller B from caller A.
- **Partial:** notices `?? []` is lossy but treats both callers the same.
- **Miss:** reports the code as fine, or only flags style/typing.
