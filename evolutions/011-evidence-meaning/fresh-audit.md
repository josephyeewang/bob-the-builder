# Fresh independent evidence audit

Date: 2026-11-13. Reviewer did none of the implementation. Review covers the pending evidence-meaning changes, their tests, workflow and evolution documents. Parallel-owned areas and private source projects were not inspected. Examples and probes use synthetic orders and generic task results.

## Initial findings

### Material: 1

**M1 — Missing requested spec members can still produce success.** In `scripts/spec-audit.py`, the spec-loading expression filters missing files before the audit. Actual CLI reproduction: supply one readable spec containing `Saved orders remain searchable.`, another nonexistent spec path, and a source containing `**Saved orders**`. The process returns 0 and prints PASS without identifying the missing member. This predates the patch but is the same missing-input false-pass class being repaired; it changes reported coverage completeness. Validate every explicitly requested spec path, report unavailable inputs, and preserve hard-failure precedence when readable content independently fails.

### Minor: 1

**m1 — Unreadable spec inputs crash instead of reporting cannot-judge.** An explicitly requested directory or non-UTF-8 spec raises a traceback and exits 1. This is a closed failure, but contradicts the readable-input exit contract and loses the distinction between unavailable evidence and a detected structural problem. Handle alongside M1 and test both cases.

### Cosmetic: 0

## Checks actually run

- New workflow's two unittest commands: 12 source-audit tests and 19 coverage tests passed before repair.
- Independent actual-CLI probes: clean task report passes; passing verdict with nonzero exit, boolean exit code, timestamp stale after timezone conversion, and embedded NUL report path all fail without traceback.
- Compared legacy coverage CLI exit behavior against the committed checker for all seven unit states, both normal and draft modes: all 14 cases match.
- Examined report-opening restrictions, size limit, regular-file check, identity matching, completion requirements, timestamp handling and legacy warning. Existing tests cover linked paths, FIFO, malformed JSON, oversized reports and nested valid reports.
- Read all added/changed prose, tests and workflow in scope. Claims distinguish lexical heuristics and report consistency from semantic truth. Found no newly added private project names, identifying product internals, field results or machine paths. Context already present in older unchanged lines is outside this added-content privacy conclusion.
- `git diff --check` passed.

## Limits and status

Initial review found M1 and m1; the builder repaired both and the independent recheck below closes them. Tests establish the stated checker contracts, not truth of a producer's reported verdict or effectiveness of the new written methods in deployed products. No implementation fixes or commits were made by this reviewer.


## Repair recheck — round 2

Remaining findings: **Material 0 / Minor 0 / Cosmetic 0**. Initial counts remain recorded above rather than erased.

The builder now reads every requested spec once, marks missing/unreadable/empty inputs unavailable, and avoids declaring source omissions against an incomplete spec set. The same checked content supplies placeholder detection. Independently inspected the repair and reran both workflow commands: **17 spec tests and 19 coverage tests passed**.

Additional actual-CLI checks confirmed: readable plus missing member → 2; all missing → 2; invalid UTF-8 → 2; directory → 2; readable plus empty member → 2; readable plus invalid UTF-8 → 2; known placeholder failure plus missing member → 1. None prints PASS or a traceback. A source candidate absent from a partial spec set remains cannot-judge, rather than a confirmed omission. M1 and m1 are closed.

The coverage tests use fixed past timestamps and a far-future rejection case. They pass on the release date and ordinary later CI dates; historical-clock execution before the fixture date is not supported by those fixtures. This does not block current release verification.
