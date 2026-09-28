# The Detection Corpus

Real defects from real projects, written so that **a check, a rule, or an auditor can be tested
against them.** Rule 28 has required this since v2.36 — *"regression-test every check you write
against the defect it was written for"* — and until v2.40 there was no harness to do it with.

## The problem it solves

Bob accretes rules. Nothing tells you whether a rule *works* — whether a fresh reader holding it
would actually catch the thing it was written for. Without that, every added rule is
unfalsifiable, and the library grows in the one direction that is cheap (more prose) rather than
the one that pays (enforcement).

A fixture makes the question empirical: **hand the prompt to a fresh context and score the
answer.**

## Fixture format

Each file has five parts, in this order, and the order matters:

1. **Provenance** — source (anonymized in this public corpus), class, cost when it happened.
2. **THE PROMPT** — a self-contained, spoiler-free artifact (code, config, or a described
   system) plus one adversarial question. *No hint of the answer.* This is what gets handed to
   the context under test.
3. **THE ANSWER** — the actual defect and its mechanism.
4. **WHY IT SURVIVED** — what the tests, the live run, and earlier reviewers saw instead. This
   is the most reusable part: it is a catalogue of what "green" looks like when it is lying.
5. **SCORING** — full marks / partial / miss, stated concretely enough that two people grade the
   same answer the same way.

## Running it

Give a fresh context (a new subagent or session, never the one that wrote the check) **only**
part 2. Vary one thing at a time:

- **Baseline:** the prompt alone. Establishes whether the defect needs any codified knowledge.
- **Treatment:** the prompt plus the candidate rule/check/lens.
- Score both against part 5.

If baseline ≈ treatment, the rule adds no detection value — that is a real result, and it means
the intervention belongs somewhere other than a checklist (see Rule 31's ladder). If baseline
fails and treatment passes, the rule earns its place, and the fixture is now its regression
test.

## Measured results (2026-09-18, first run)

Four fixtures, fresh agents, no project context, adversarial question only:

| Fixture | Class | Baseline (no checklist) | Notes |
|---|---|---|---|
| 001 error-vs-missing | commission | **CAUGHT** in ~30s | Also found 2 defects not planted (staleness bound, input/output generation mismatch) |
| 003 pagination-clamp | commission | **CAUGHT** | Predicted the exact symptom ("will print 1 owner, not ~40") and found the swallowed-error defect too |
| 005 queue-starvation | commission | **CAUGHT** | Named the one-running/one-waiting rule exactly; found a second hazard (firing on a non-successful completion) |
| 004 absence-monitor | **omission** | **MISSED** | Produced a plausible adjacent finding instead. Nothing in the artifact is wrong; the defect is a capability that was never built |

001 was additionally run **with** a failure-semantics checklist. Both runs caught it; the
checklist run was more systematic (it enumerated the four read states and found a third
collapsed case) but detected nothing extra.

## Second experiment: does a written rule change what a fresh session DOES?

Detection is only half the question. The other half is retrieval — whether a session that *has*
the rule behaves differently. Tested with a realistic mid-work scenario rather than a code
snippet: *"you traced a zeroed summary view to a shared reader that returns `null` for both 'absent'
and 'read failed'; you fixed the three loaders the bug report named; tests pass. Are you done?"*

| Arm | Result |
|---|---|
| **Control** (no memory) | Said not done. Proposed grepping every caller of the helper, **and** independently proposed the tier-4 fix — *"change what the helper hands back so 'no data' and 'read failed' look different by construction — impossible to accidentally treat as the same thing."* Also raised four things the treatment did not: what the user now sees on failure, a test that forces a real read failure, alerting, and the root cause of the original outage. |
| **Treatment** (symptom→rule lookup loaded) | Same two core moves, plus three things the control could not know: the **site count** ("all 10 loaders", vs the 3 in the report), the **caller-class semantic** (a builder must THROW; only a request path may degrade), and the **tier-1 consequence** (a displayed number needs a fresh-context audit before it counts as done). |

**The honest reading: the rule did not make the reader more competent — it made them more
specific.** Both arms independently reached "grep the class" and "make it unrepresentable,"
which is strong evidence that Rule 31's ladder is what a careful person arrives at anyway once
they stop to think. The control was actually *broader*. What the memory supplied was the part
general competence cannot supply: **project-specific decisions and counts.**

### The design rule this yields

A symptom→rule entry earns its place only if it carries something a competent stranger could not
derive: a **decision** (builder throws, request path degrades), a **measured constant** (this API
clamps at a fixed row count regardless of `.limit()`; this scheduler runs hours late), a **site count**, or
a **receipt command**. Entries that restate general engineering practice ("measure before you
specify", "don't bypass gates") are redundant with the reader's own judgement and dilute the
ones that aren't. **Prune the generic rows; keep the ones with a number, a name, or a decision
in them.**

## What the first run established

**Defects of commission are attention-limited, not knowledge-limited.** Three of three were
caught cold, by readers with no project context and no checklist, in under a minute each — and
each time the reader volunteered *additional* real defects. These defects survived in production
for weeks or months, and through several rounds of fixes, purely because **nobody was asked to
look at that artifact with an adversarial question at the moment it changed.**

**Defects of omission are invisible to reading, by construction.** 004 is the control that
proves the distinction. The artifact is correct. The missing thing is a capability nobody
specified, plus an arithmetic check nobody performed relating two files' constants to each
other. A fresh reader cannot find what is not there; it answers the nearest answerable question
well instead. These need a design-phase enumeration, not an audit.

Use this split when deciding where an intervention goes. It is the difference between "trigger a
read" and "add a question to the spec gate," and getting it wrong wastes the effort entirely.

## Contributing a fixture

Add one whenever an incident is harvested (Rule 32). Minimum bar: someone who was not there can
read part 2 cold and attempt it. If part 2 needs project context to make sense, it is not a
fixture yet — keep reducing until the defect is the only thing left that is interesting.

Fixtures are also the honest place to record a **negative result**. `001` carries one: a
grep-based check for its class was built, measured against a real codebase, and rejected — naive
pattern flags 11 files of ordinary safe-navigation; scoped to builder modules it still yields 45
mostly-legitimate hits, because the defect is a *dataflow* property and grep sees only *syntax*.
Shipping it would have violated Rule 28's own calibration discipline. Recording the rejection
stops the next person re-deriving it.
