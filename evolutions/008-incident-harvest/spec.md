# Evolution 008 — Incident Harvest: close the loop from a production defect to a check

- **Mode:** EVOLVE · **Classification:** Heavy (3 new rules · a new index mechanism · a fixture corpus · self-dogfooding; no new lens)
- **Version:** v2.40 · **Decision:** D-014 · **Date:** 2026-09-18
- **E3-pre Reference Scan:** skipped, same justification as Evolution 004 — the reference is a lived field retro, not an external framework. Source: a production data app, September 2026.

## Trigger

The founder asked why a two-week defect wave happened in a product built and audited under
this protocol — *"it's so bizarre that we just spent hundreds of hours trying to fix stuff that
we theoretically had already scoped out and never had detected."*

A six-agent census of that window produced the numbers. They are worth stating plainly because
they set the bar any change here has to clear.

| Measure | Value | Source |
|---|---|---|
| Defects recorded in the decision log | **68** in 12 days | decision-log census |
| Further defects caught in review on six PRs alone | **86** | PR-body round-by-round census |
| Merged PRs in the window | 179 (plus 352 commits — ~half the work bypassed PRs) | `gh pr list` |
| PRs that were FIXES for defects | **71 (40%)** | PR census |
| PRs that were fixes for a PREVIOUS fix | **~46 (26%)** | chains run three deep |
| Defects found by fresh-context audit | **30 of 68 (44%)** | decision-log census |
| Defects found by any automation (CI + monitors) | **8 of 68 (12%)** | decision-log census |
| Review defects a unit/integration test would have caught | **3 of 86 (3.5%)** | six-PR census |
| Defects where every status signal was green while output was wrong | **26 of 68 (38%)** | decision-log census |
| Fresh-context audit hit rate | **100%** (14-for-14 in-window) | `audit-protocol.md`, decision log |

## The finding that invalidates the obvious fix

The instinctive response to a defect wave is to write the lesson into the checklist. **That was
already done, and it failed.**

The dominant class — a read ERROR treated as "no data," so a failure silently becomes an empty
value that a builder then persists — had a standing rule **written down before the window**, in
the project's own memory index:

> *"STANDING: a read error is not the same as missing data (no silent fallback on error, in every data loader)."*

The class then recurred **~40 times**, through six successive PRs, each fixing the sites it knew about and each
subsequent audit finding more. The auditor who finally characterised it said it best:

> *"the fixes are right where they act and wrong one level out."*

Two controlled experiments confirm knowledge was never the bottleneck:

1. **Checklist vs no checklist.** The same defect (the shared reader above, with two callers)
   was handed to two fresh agents — one with a failure-semantics checklist, one with nothing but
   an adversarial question. **Both found it.** The checklist version was more systematic; it
   detected nothing the unaided reader missed.
2. **Four real defects, fresh readers, no project context.** Three of four were caught in under
   a minute, each time *with additional real defects the prompt had not planted*. The fourth —
   a monitoring capability that was never built — was missed, because there is nothing to read
   in code that does not exist.

**Conclusion: for defects of commission, attention is the scarce resource, not knowledge.**
Adding lens content buys approximately nothing. What was missing was (a) a reason for anyone to
look at that code at that moment, and (b) an escalation past "write the rule again" once a class
proved it recurs.

### The capstone measurement

A separate census of ~130 recorded **process** failures (the AI's own mistakes, not the code's)
across the project's five rule surfaces settles the question:

| | count | share |
|---|---:|---:|
| A correct, written, project-local rule **already existed** and was not followed | **~95** | **73%** |
| A rule existed but was **too narrow** for the instance | ~20 | 15% |
| **Genuinely no rule existed** | ~15 | 12% |

Three distinct non-compliance mechanisms, each with quoted evidence:

1. **Filed, but not consulted at symptom time.** A two-day investigation re-derived a finding
   the same two sessions had written down two weeks earlier. Their own conclusion: *"Not a
   memory failure — it was correctly filed and correctly triggered; neither of us re-read the
   register when the symptom appeared. **A register only works if consulting it is a reflex at
   symptom time, not just at planning time.**"* And its twin: *"the note was right and I filed
   it instead of using it."*
2. **Loaded, then overridden by momentum.** *"built at hour ~22 under run-now momentum against
   my own fresh-eyes charter"*; *"Two gates were bypassed in good faith by three sessions this
   shift — and each time the gate was right."* The project's own generalisation, never turned on
   its own rule system: ***"conventions fail exactly when someone is busy."***
3. **The index line was stale, so the rule never loaded.** *"The index is what loads each
   session, so a whole session's plan was built around a constraint removed on 08-24."*

**And the discriminator that decides which rules survive contact with a busy session:**

> Every rule that held reliably had been mechanised into a test, a hook, or a CI check — the
> hermetic weekday fixture that caught the phantom, the served-error census test, the
> workflow-step-ref lint, the design-token gate, the decision-ID pre-commit guard. **Every rule
> that failed repeatedly lived only in prose.**

This is the whole evolution in one line. Bob currently has **2 of 30 rules** with a runnable
enforcer. That ratio, not the rule count, is the thing to move.

### The thesis replaying itself, live, during this packet

While this evolution was being written, the project's integrator reported an instance from their
own merge — independent lane, independent reasoning, same shape:

> The decision log already says *"a step's budget and its wall-clock bound are ONE coupled decision."* Two
> days later I merged a supervisor grace period, justified in a comment, that was **less than half**
> the worst case of the release path it guards — two constants in two files that must agree, with nothing
> binding them. **The rule existed, was written by this project, and the defect shipped anyway.**

Their prescribed remedy, arrived at without seeing Rule 31:

> *"the remedy is not a third copy of the rule, it's **making the two numbers one** — derive the
> grace from the release bound, with a test that fails when they drift."*

That is tier 4 of the ladder, reached independently, on a defect one level up from the ones in
the census. It is the strongest corroboration available: a rule the project itself authored,
recurring within 48 hours, with the practitioner's own instinct being *escalate the
representation*, not *restate the rule*.

A second instance from the same message widens the detection-mode point: an audit of a helper
written to **standardise** lane handling found it *less* safe than the hand-rolled code it
replaced — it could die holding the lock and never release it. No test would have caught it; it
needed someone tracing every exit path against "what happens to the lease here." Filed under D2
(twin paths) and B7 (consolidation drops a property) in the failure-mode index, and worth
naming as its own idea: **a consolidation can regress the very property it consolidates**, which
is the fourth known way a consolidation silently loses capability.

## What actually closed the class

Not a rule, and not a grep. Two structural moves:

1. **The failure state was made unrepresentable.** The reader's return type went from
   `T | null` — which *permits* the conflation — to a four-state discriminated union
   (`available | stale | missing | error`). Every caller is now forced by the compiler to name
   the state it handles; 18 explicit handlings exist today.
2. **The duplication was deleted.** The final PR stopped patching sites and collapsed a
   duplicated persist loop into one guarded function, so there was no second copy to
   re-introduce the bug. The class stopped recurring after that, and only after that.

A grep-based check was built and **measured, then rejected**: the naive pattern flags 11 files
of ordinary safe-navigation; scoping it to builder modules still yields 45 mostly-legitimate
hits, because the defect is a *dataflow* property (failure → default → persisted) and grep sees
only *syntax*. Shipping it would have violated Rule 28's own calibration discipline — a check
that cries wolf gets ignored. **Recorded as a negative result rather than shipped.**

## Why Bob did not catch any of this

Four mechanical reasons, each verified against the repo rather than inferred.

**1. Bob's audit triggers are document and phase events; these defects are born from
code-structure events.** Rule 24(a)'s trigger map fires on: a living-doc version bump, a phase
boundary, a substantive spec edit, a named gate. Every defect in the window was introduced
mid-phase inside an ordinary small change — a shared reader gaining a second caller of a
different class, a guard written for one lane and never swept to its sibling, a config
derivation copied to a ninth site, a second copy of a loop, a migration altering an object
another migration created. None crosses a phase boundary, so no Bob audit ever fires.

**2. Bob learns only from its own audit runs, never from the project's incidents.**
`_lens-retro.md` critiques lenses *after a Bob audit*; L37 emits a reactive invariant *per
crawl finding*. Both intakes begin inside a Bob session. There is no path from "a production
incident happened" to "a check now exists." This is precisely why the families Bob covers best
are the ones that surfaced during Bob-authored sessions, while five families with real,
repeated incidents in this project never reached the framework at all.

**3. Coverage is indexed by discipline, never by failure mode.** 37 lenses sit in 8 bands
(engineering / UX / AI / …). Nothing in the library can answer "which failure modes have no
owner?" — so the gaps below stayed invisible.

**4. Bob does not run its own checks on itself, and currently fails three of them.** Verified
2026-09-18: `decision-log.md` contains **three duplicate decision IDs** (D-002, D-006, D-007) —
which `coherence-check.sh` hard-fails on; the lens count drifts across Bob's own docs
("34 lens" ×1, "36 lens" ×9, "37 lens" ×2); and **`audit-ledger.json` does not exist anywhere in
the repo** (`bob-init` references it zero times) although Rule 24 gate-blocks on it, Rule 30(d)
records to it, and Phase Gate item 10 calls an unrun ledger entry a stop condition. The
pre-commit hook that would catch the first two is scaffolded by `bob-init` **for downstream
projects only**.

Sharper still, found while writing this packet: `coherence-check.sh` **cannot be run on Bob at
all.** From the Bob repo root it exits immediately with `coherence-check: './docs' is not a
directory` — it assumes the downstream-project layout. So the dogfooding gap is not "nobody
wired the hook"; it is that **the checker is structurally unable to inspect the repo that
authored it.** Rule 33 is not satisfied until the script has been pointed at Bob and has
reported Bob's three known defects.

That fourth point is the same defect class as the project's own worst incidents — *the guard
that does not watch itself* (a weekly coverage monitor dead in CI behind `continue-on-error`
since ≥09-06; an audit whose oracle filtered out exactly the rows its finding was about; Bob's
own mechanical checks found never to have been firing while five agent audits masked it).

## The uncovered families

From a 15-family probe of the library, five have **no owner anywhere** — no rule, no lens, no
oracle — and each has real incidents in this project:

| Family | Real incidents |
|---|---|
| **Twin code paths drifting** | the duplicated persist loop; an inline copy of a widget still making a retired claim; a second page carrying a byte-for-byte copy of a fixed component |
| **A scheduled job silently stopping** | a research lane unrun for weeks inside a green job; a weekly job with zero green runs for two weeks; a notification job delivering nothing across repeated runs while each counted as "covered" |
| **Time-dependent tests** | a hardcoded date that would have turned CI red repo-wide at midnight; a unit test hardcoding the same wrong cutoff as the bug it covered |
| **Work parked on a calendar instead of an event** | a fix parked for a "fresh-eyes Saturday" that a fresh agent could satisfy immediately; Bob's own cadences are the anti-pattern (`days_since_last_run`, "quarterly", "revisit in 6 months") |
| **Parallel agents clobbering** | three shared-checkout sweeps, one of which pushed another session's untested 190-line resolver to main; four decision-ID collisions. Bob's stated position is avoidance ("sequential, not parallel"), which this project could not follow |

## The change

**Rule 31 — The intervention ladder.** When a defect class recurs after a fix, do not re-state
the rule. Escalate one tier: (1) write it down → (2) mechanical check, *calibrated or not
shipped* → (3) fresh-context audit → (4) make it unrepresentable (type it away, or delete the
duplication). A class that has recurred twice may not be closed at tier 1 or 2. Record the tier
in the fix's own PR/commit.

**Rule 32 — Incident intake.** Every production incident, in any project, exits through a
three-line harvest: *failure mode · the one mechanically-checkable question that would have
caught it · which lens/rule owns that question — or NONE.* A `NONE` is a framework gap and is
filed as such. This is the missing edge that makes Bob learn from the field instead of only
from itself.

**Rule 33 — Bob dogfoods Bob.** `coherence-check.sh` runs on the Bob repo itself in CI, not
only in scaffolded downstream projects; `audit-ledger.json` ships as a real template and
`bob-init` creates it; every rule carries an enforceability tag (HOOK / SCRIPT / GATE / PROSE)
so a fresh reader can tell which rules actually bite. Today 2 of 30 rules have a runnable
enforcer and the protocol does not say which two.

**The failure-mode index** (`audit-lenses/_failure-mode-index.md`) — coverage indexed by failure
mode rather than discipline, each row naming its owning check and its fixture, so an unowned
family is visible at a glance instead of being discovered by a census two years later.

**The detection corpus** (`fixtures/detection/`) — real defects, each with a spoiler-free prompt,
the answer, and a scoring rubric, so any change to Bob's audit capability can be regression-
tested against defects that actually happened. This is the harness Rule 28 already demands
("regression-test every check you write against the defect it was written for") and that the
repo has never had.

## What is deliberately NOT changed

- **No new lens.** The census says content was not the gap.
- **No grep-based check for the dominant class.** Measured, noisy, rejected (above).
- **Rule 27's "sequential, not parallel" stance is left standing but flagged.** This project ran
  three parallel sessions successfully for two weeks using conventions Bob does not have
  (lane ownership, a lock on shared database writes, worktree-per-session, single-owner SSOT files, PR-only
  merges through one integrator). That is evidence Bob's avoidance posture is now too strong,
  but rewriting Rule 27 needs its own evolution and its own evidence.
