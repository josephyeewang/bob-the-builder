# IC-008 — A test asserting a string the upstream never emits

- **Source:** a production data app (anonymized); found while auditing a prior fix PR
- **Class:** `vacuous-verifier` — specifically the variant where **the fixture and the code were
  written from the same wrong source**, so the test passes for exactly the reason the code is wrong
- **Detection mode:** CODE-READ-ONLY — and only by reading **upstream's source**, not ours
- **Earliest preventable phase:** BUILD
- **Notable:** the defect was in a *fix*, and the block's own title certified the coverage it faked

## THE PROMPT (hand this over, nothing else)

A service talks to an open-source REST gateway in front of its database. Transient failures
should be retried; permanent ones should not. A recent fix widened the transient matcher after a
production incident, and shipped with a test.

```ts
// src/retry.ts
export function isTransient(msg: string): boolean {
  return /schema cache/i.test(msg)
    || /could not connect/i.test(msg)     // the gateway's sibling 503s (codes E000/E001)
    || /timeout/i.test(msg);
}
```

```ts
// tests/retry.test.ts
describe("the rest of the original transient set is untouched", () => {
  // …other cases…
  it("retries the gateway's connection-error class", () => {
    expect(
      isTransient("Could not connect with the database due to an internal error")
    ).toBe(true);
  });
});
```

The fix's commit message explains the motivation: *"The gateway's sibling 503s E000/E001
('Could not connect with the database…') were unmatched — a one-shot lane claim would stand a
run down."*

Type-check passes. The test passes. CI is green. A reviewer asking "is this behaviour tested?"
gets yes.

**QUESTION:** Does this fix do what it claims? Justify your answer with something other than the
test result.

## THE ANSWER

**The gateway never sends that string.** Its actual messages, read from its own source (the
module that defines its error types):

- code E000 — `"Database connection error."`
- code E001 — `"Database client error. Retrying the connection."`

Neither contains "could not connect." The string in the code — *"Could not connect with the
database…"* — is the **Description column of the gateway's documentation table of error codes**,
i.e. prose *about* the error, not the error. Confirmed by a code search of the upstream
repository for the exact phrase, which returns only the docs file.

So the matcher does not match the class it was written for. The incident it was meant to prevent
— a one-shot lane claim standing a production run down on a transient 503 — remains live.

**Why the test cannot reveal this.** The fixture was written from the same documentation page as
the pattern. The test therefore asserts that the regex matches the string the regex was built
from. It is a tautology wearing the costume of a regression test: **it passes for precisely the
reason the code is wrong.** No amount of running it produces information.

Compounding it, the enclosing `describe` block is titled *"the rest of the original transient
set is untouched"* — so the suite's own narrative certifies the coverage the assertion fakes. A
reviewer scanning titles reads "original set covered."

## THE GENERALISATION

**A fixture derived from the same source as the code under test carries zero independent
information.** The only way to break the circle is to check a *different* authority — here, the
upstream's source rather than the upstream's docs.

This is why the check is not "is there a test?" but **"what independent authority does this test
appeal to, and is it the same one the code came from?"** For anything matching an external
system's output — error strings, status codes, envelope shapes, wire types — the authority is
the emitting source, not its documentation, not its changelog, and not our notes about it.

## WHY EVERY GREEN SIGNAL WAS GREEN

- CI green (tautologically).
- The fix is *directionally* right: E000/E001 genuinely are transient and genuinely were
  unmatched. The motivation was correct; only the string was wrong.
- The block title asserted coverage.
- It was itself an audit-driven fix, so it arrived carrying the credibility of a fix.

## SCORING A CANDIDATE

- **Full marks:** identifies that the **fixture is unverifiable against the upstream** — that the
  asserted string does not exist in what the gateway emits — and names an independent authority
  to check (the upstream source, or a captured real error payload).
- **Partial:** notices the block title over-claims, or proposes matching on error *codes*
  instead of message text (a good fix) without establishing that the current string is fictional.
- **Miss:** "this regex looks fragile / narrow." **Fragility is not the catch. The catch is that
  the string does not exist.**
