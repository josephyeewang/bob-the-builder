# Debugging protocol: the method and the record

<!-- Adapted from obra/superpowers@22f0b463e7a5e579904dd6211a520321035526f7 (skills/systematic-debugging/SKILL.md, root-cause-tracing.md, defense-in-depth.md, condition-based-waiting.md), MIT, Copyright (c) 2025 Jesse Vincent. Licence: third_party/superpowers/LICENSE. Changes: hung on the steps of Bob's Debugging Protocol (build-protocol.md §10) instead of four separate phases; reworded for a non-engineer owner; examples made generic and shortened; a fill-in record added so each bug leaves evidence; the pollution finder is scripts/find-polluter.sh. -->

> Adapted from obra/superpowers@22f0b46 (systematic-debugging), MIT.

**What this is.** Bob's Debugging Protocol (`build-protocol.md` §10, one line in the core) owns *which* steps a
bug goes through and in what order. This file is the *how* for the steps where guessing usually creeps in, plus
a record to fill in. It adds no new step. When the two disagree, §10 wins; fix this file.

**Use it** for any bug, failed test, broken build or "that's odd" — and above all when a quick fix looks
obvious, time is short, or one fix has already failed. A bug that looks simple still has a cause; finding it is
quicker than guessing twice.

**Copy it** (recommended) to the project's bug notes (for example `docs/bugs/<yyyy-mm-dd>-<short-name>.md`) and
fill in the record at the end as you go, so the next person can see what was checked.

## The one rule

**No fix until the cause is found and reproduced.** A change made to "see if it helps" is a fix — unless it is
the one small change that tests the cause written down in 2d. If step 2 has no written cause, nothing may be
changed yet except logging.

## Step 1 — Reproduce (§10 step 1)

1. **Read the whole error.** Every line of the message and the stack trace (the list of code lines the error
   passed through); note file, line and error code.
   The answer is often in the part that was skimmed.
2. **Make it happen on demand.** Write the exact input, the expected output and the actual output. If it does
   not happen every time, gather more data (step 2a) — do not guess.
3. **Compare with the last good run** (Engineering Principle 8a). What did it use: versions, settings, inputs,
   machine? A change that landed just before the failure is a suspect, not a cause, until the last good run
   shows it differed. Something new that never had a good run: compare with its nearest working twin instead
   (the same command under another program, the same page in another browser; see 2c).

## Step 2 — Isolate (§10 step 2)

**2a. When several parts hand data to each other** (a workflow calls a script calls a tool; a page calls a
service calls a database), find *which hand-off* breaks before reading any one part closely. Add one log line
at each boundary — what came in, what went out, which settings were visible — and run once:

```text
boundary 1  workflow -> script    : setting X visible? yes
boundary 2  script   -> tool      : setting X visible? NO   <- it breaks here
```

Then investigate only that part.

**2b. When the error shows up deep inside** (a file written in the wrong folder, a call with an empty value),
trace backwards. Do not fix where it appears:

| Ask | Write down |
|---|---|
| What line directly caused this? | the call and its arguments |
| What called it, with which value? | one level up |
| Where did that value come from? | keep going up |
| Is this where the wrong value is first made? | if yes, this is the source; if no, go up again |

If you cannot follow it by reading, log just *before* the risky operation: the value, the current folder, the
relevant settings and the full call stack (which code called which). In tests, print to the error output
(`console.error`, `stderr`); a test logger may swallow it.

**2c. Compare with something that works.** Find similar code in the same project that works, or the reference
you are copying, and read it completely. List every difference, however small — including what each one needs
around it (settings, environment, which program runs it) — and do not decide in advance that one "can't matter".

**2d. One cause at a time.** Write it as *"I think X is the cause because Y."* Test it with the smallest change
that can prove it right or wrong, one variable at a time. Wrong → write a new cause; do not stack a second change
on the first. If you do not understand something, say so and find out; do not pretend.

**Test pollution.** If a file or folder appears during a test run and no one knows which test made it, run
`bash ~/.claude/skills/bob/../scripts/find-polluter.sh <thing-that-appears> 'src/**/*.test.ts'` from the project
folder (keep the quotes; name the folder your tests live in, so it does not also search installed packages). It
runs the test files one at a time with `npm test <file>` and stops at the first one after which the thing exists.
Before running it:

- **Delete the thing first.** While it exists the script skips every test and still ends "all tests clean".
- **npm projects only**, and check that `npm test <one file>` runs just that file. Otherwise every run fails
  quietly, or the whole suite runs each time and the first file gets blamed.

## Step 3 — Spec coverage (§10 step 3)

As §10. Nothing to add.

## Step 4 — Fix (§10 step 4)

1. **Draft the regression test now**, so you watch it fail for the reason in 2d; §10 step 6 completes it. No
   test framework: a one-off script that exits non-zero. If the faulty version is gone, rebuild it from the
   report, and say so in the record.
2. **One change, at the source** found in 2b. No "while I'm here" clean-ups in the same change.
3. **Watch the test pass**, then run the full suite.
4. **Make it impossible, not just fixed (layers).** When the bug was a bad value travelling through several
   parts, also check it at each part it passes, so a different route or a later refactor cannot bring it back:

   | Layer | Checks | Example |
   |---|---|---|
   | Entry | refuse plainly bad input where it enters | an empty or missing folder path is an error |
   | Use | the value makes sense for this job | the folder is not the project's own source folder |
   | Surroundings | dangerous actions refused in the wrong context | in tests, refuse to write outside the temp folder |
   | Evidence | a log line before the risky action | value, folder and call stack |

   Test each layer: get past the first and check that the next one catches it. For a fix to instructions or
   docs (a command written wrongly), the layers are a test that runs each written command with the program
   that will really run it, and a note of why it is written that way.

**Flaky tests that wait a guessed time.** A test that sleeps "long enough" passes on a fast machine and fails
under load. Wait for the thing itself, with a time limit and a clear message:

```js
async function waitFor(check, what, limitMs = 5000) {
  const start = Date.now();
  for (;;) {
    const v = check();               // read fresh state every time; check must not be async
    if (v) return v;
    if (Date.now() - start > limitMs) throw new Error(`gave up waiting for ${what} after ${limitMs}ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}
```

A fixed wait is right only when timing is the thing under test (a debounce, a tick interval). Then wait for the
start condition first, base the delay on the known interval, and say why in a comment.

## Steps 5 to 7 — Class scan, neighbours, regression test, spec (§10 steps 5–7)

As §10. At step 6, extend the test drafted in step 4 to cover the other places step 5 found.

## When fixes keep failing

§10's three strikes apply. When the third fix has failed, look at the pattern before changing approach: if each
fix uncovered a new problem somewhere else, or needed a large rewrite to land, the design is likely wrong, not
the last guess — say so when you change approach.

If a careful investigation really finds the cause outside your control (timing, an outside service), record
what was checked, handle it (retry, time limit, a clear message) and add logging for next time. Most "no
cause" verdicts are unfinished investigations, so the record must show what was checked.

## Warning signs: go back to step 1

| Thought | What it means |
|---|---|
| "Quick fix now, investigate later" | Later never comes; the guess becomes the pattern |
| "Just try changing X" | A fix without a cause |
| "Several changes, then run the tests" | You will not know which one worked |
| "I'll check it by hand instead of a test" | The fix won't stay fixed |
| "It's probably X" / "I don't fully understand, but this might work" | A cause not yet tested (2d) |
| "I checked it with another tool" (`ls`, by eye) | Check with the program that will really run it |
| "One more try" after three failures | Three strikes; change approach and question the design |
| The owner asks "is that actually happening?", "will it show us…?" or says "stop guessing" | You assumed without evidence; gather it (2a) |

## The record (fill in per bug)

```markdown
# Bug: <one line>
- Found: <date>, by <who/what>; seen in <where>
- Last good run: <date/commit>, used <versions, settings, inputs> (or "none, new"; nearest working twin: …)

## 1 Reproduce
- Input: … · Expected: … · Actual: …
- Happens every time? <yes / n of m>
- Error read in full; key line: <file:line, message>

## 2 Isolate
- Boundaries checked (2a): <boundary → result> …
- Trace (2b): <symptom> ← <caller, value> ← … ← <source>
- Differences from a working case (2c): …
- Cause: "I think <X> is the cause because <Y>"; tested by <smallest change>; result <right / wrong>

## 3 Spec coverage: <covered / gap, and where patched>
## 4 Fix
- Failing test: <name>, failed for the expected reason? <yes/no>
- Change: <one line> · Layers added: <entry / use / surroundings / evidence>
## 5 Class scan: <pattern searched; N other instances; fixed>
## 5b Neighbours read: <callers; code on the same data>
## 6 Regression test: <name>, passes; full suite <N passed, 0 failed>
## 7 Spec updated: <yes, where / not needed>
- Attempts: <n>; strikes: <0–3>
```
