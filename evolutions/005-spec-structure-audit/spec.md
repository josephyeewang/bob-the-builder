# Evolution 005 — Rule 28: the SPEC-DOCUMENT silent-failures

**Version:** v2.36 · **Date:** 2026-08-21
**Origin:** the Multycast product-scoping session (Joe Wang)

## The problem

Bob had Rule 25 (data silent-failures) and Rule 26 (engineering silent-failures).
It had **nothing** for the equivalent class in the artefact Step 1 actually produces:
the spec document itself.

Across roughly forty edit rounds on one scoping doc, the founder personally caught:

| What he caught | What every existing check said |
|---|---|
| A pain filed under the wrong theme | valid — cross-refs resolved |
| Two themes whose contents overlapped | valid — counts matched |
| A theme renamed "reusable agents and automations" with no reuse or automation in it | valid |
| **Two rival feature inventories** in one document (§03 and §12) | valid |
| Four concepts silently dropped during section rebuilds | valid |
| Fifteen capabilities described in prose that never became features | valid |
| Three overview bullets that reworded one idea | valid |
| Jargon ("provenance", "corpus") in the sections a non-engineer reads | valid |

Every one passed tag-balance, cross-reference, badge and count checks. Those checks
are **syntactic**. Nothing in Bob was **semantic**, so the human was the linter.

## The fix

**Rule 28** — ten named failure classes, each with a test, each with the concrete
origin from this session. Plus `scripts/spec-audit.py`, wired in three places:

- **Step 1c-audit** (new, MANDATORY) — between adversarial review and the stability loop
- **Step 1e** — the consolidation pass now runs it first
- **Step 6.5a** — Pre-Build Gate lens 1

## The two disciplines that made the script trustworthy

Both were learned the hard way *in the same session*, and both are in the rule:

1. **Regression-test every check against the defect it was written for.** The
   structural-duplication check, as first written, reported **clean** against the very
   document containing two feature inventories — it counted `<tr>` and the duplicate
   used `<li>`. It only got caught because the check was run against the
   pre-deletion file to prove it worked.

2. **Calibrate before trusting.** The reverse-coverage check opened at 40 hits of
   pure noise; the delivery check hard-failed on every organisational heading
   ("Install path" promises "path"). A check that cries wolf gets ignored exactly
   like an over-eager linter — which is a rule the same document already contained
   and the script violated anyway.

## Design note: hard fail vs review prompt

Not every finding can be mechanical. The script separates:

- **Hard fails** — overlap, misfiled membership, undelivered promise on a *claim*
  heading (`X → Y`, not a label), structural duplication, source-fidelity drift.
- **Review prompts** — reverse coverage, phrase repeats. Some prose genuinely is
  context; a human judges.

And it closes by naming what no script can see: altitude drift, jargon, and whether
a list's bold leads reword each other.

## Related

- Rule 25 (data) and Rule 26 (engineering) — this completes the trio.
- Rule 23 / `coherence-check.sh` catches *mechanical* drift across a doc set. Rule 28
  catches *logical* incoherence inside one. They are complementary, not overlapping.
