# Deferred Actions — {Project Name}

> **Standard Tier-1 artifact (v2.27).** A single, durable register of everything promised-but-not-yet-done, so a non-engineer never loses a carry-in between the spec and the build. Parallels `decision-log.md`. Created at Step 1, appended to whenever an item is deferred (an audit finding triaged "later," a capability tagged beyond the current Maturity Stage, a known gap with a revisit trigger). Reviewed at every phase gate and before launch.
>
> **Rule of use:** if you say "we'll come back to X," it goes here *immediately* with a revisit-trigger — never in prose that scrolls away. An empty revisit-trigger is not allowed (that's how items get lost).

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
