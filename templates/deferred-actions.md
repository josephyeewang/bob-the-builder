# Deferred Actions — {Project Name}

> **Standard Tier-1 artifact (v2.27).** A single, durable register of everything promised-but-not-yet-done, so a non-engineer never loses a carry-in between the spec and the build. Parallels `decision-log.md`. Created at Step 1, appended to whenever an item is deferred (an audit finding triaged "later," a capability tagged beyond the current Maturity Stage, a known gap with a revisit trigger). Reviewed at every phase gate and before launch.
>
> **Rule of use:** if you say "we'll come back to X," it goes here *immediately* with a revisit-trigger — never in prose that scrolls away. An empty revisit-trigger is not allowed (that's how items get lost).
>
> **Cap and archive (2026-10-27, D-018).** **Open rows: at most {cap — default 150}.** Closed (done / dropped) rows move to `docs/deferred-actions-archive.md` at each weekly triage, so this file shows only what is live. Over the cap, a change that adds a row must also close, merge or park one in the same change — the cap only ever goes down. **Weekly triage:** every row added or touched since the last pass gets one of *fix now* (a change this week) · *slot into a phase* (named) · *park with a named trigger* · *close with proof*; the date goes on the `Last triage:` line below. A week with no triage line is itself a finding. The daily loop check (`scripts/loop-check.mjs`) flags an open count over the cap; set the number in `.github/loop-check.json` (`"intake": {"cap": N}`). *(Why: in a real build the intake list kept growing even with a cap written down — a cap with no archive and no check only records the growth. Archive + a counted cap + a weekly date keeps the list readable.)*
>
> **Last triage:** {YYYY-MM-DD}

## Schema

| # | Item | Origin | Lands in (doc/phase) | Revisit-trigger | Status |
|---|------|--------|----------------------|-----------------|--------|
| D1 | {what — one line} | {decision-log D-NN / audit-NN / Maturity-Stage defer / coverage gap} | {Architecture / Doc 2 / Phase N / productization} | {the concrete condition or date that should resurface it} | open / done / dropped |

## Categories (optional grouping for large registers)

### Architecture / build carry-ins
*(items that land in the Architecture Contract or a specific build phase)*

### Maturity-Stage deferrals (reserved roadmap seams)
*(capabilities tagged beyond the current stage — reserved, not specified to depth; Rule 16)*

### Forced decisions (un-made decisions blocking later work)
*(the riskiest-assumption test, a legal opinion, a vendor choice, a pricing model — name them so they don't ambush the build)*

### Open questions
*(things genuinely undecided — list them honestly rather than papering over)*

---

*Status legend: **open** = still to do · **done** = completed (keep for the record, strike through) · **dropped** = consciously abandoned (note why; mirror to decision-log if non-trivial).*
