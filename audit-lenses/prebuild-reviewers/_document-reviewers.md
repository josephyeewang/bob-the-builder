# Document reviewers: shared rules

<!-- Adapted from EveryInc/compound-engineering-plugin@ee46dde75a40e297bd8eac4055a410a771d3ac1d (skills/ce-doc-review/references/subagent-template.md and persona-selection.md), MIT, Copyright (c) 2025 Every. Licence: third_party/compound-engineering/LICENSE. Changes: the JSON output contract and P0–P3 scale replaced by Bob's Material / Minor / Cosmetic buckets and the Trigger-Path-Outcome-Reach test; orchestrator slots replaced by what the Bob caller passes; a plain-English summary added; wording shortened. -->

> Adapted from EveryInc/compound-engineering-plugin@ee46dde (ce-doc-review), MIT.

Five reviewers read a project's **documents** (spec, architecture, build plan) before any code is written. Each
owns one question and leaves the rest to the others:

| Reviewer | Its one question | File |
|---|---|---|
| Coherence | Does the document disagree with itself? | `coherence.md` |
| Feasibility | Can it be built as written, from what really exists? | `feasibility.md` |
| Scope guardian | Is it the right size, and does every added part earn its place? | `scope-guardian.md` |
| Product lens | Is this the right thing to build at all? | `product-lens.md` |
| Adversarial | Would its assumptions and decisions survive reality? | `adversarial.md` |

**Where they fit.** They are optional extra seats at the Pre-Build Review Gate (Step 6.5a) and at any later
spec or plan change. They sit **alongside** the gate's six topics and two fixed reviewers
(`design-critic.md`, `implementation-readiness.md`), never in place of them. Coherence is the natural seat
for the gate's topic (1), internal consistency, after the two mechanical checkers have run; the checkers find
mismatched names and numbers, Coherence finds two passages that cannot both be true.

**How to launch.** One fresh helper per reviewer, never the session that wrote the documents; read-only
(Read, Grep, Glob). The caller's brief gives:

1. the files (and line ranges) to review;
2. **Document kind**: `spec` (what and why: product spec, requirements) or `plan` (how: architecture, build
   plan, a phase plan). Trust it; do not re-classify;
3. **Settled upstream**: the approved spec a plan was written from, or `none`. Questions settled there are not
   re-argued on the plan;
4. this file and the reviewer's own file.

## What counts as a finding

Judge each concern by what happens **if the work ships as written**. Keep it only if you can state all four:

- **Trigger**: the situation that sets it off;
- **Path**: the passage (file:line) that leads there;
- **Outcome**: what goes wrong — a wrong result, lost money or data, a security hole, or rework;
- **Reach**: who is hit.

A remedy that only makes the work more thorough, robust or explicit is not a finding. Lost or misdirected money,
a security breach or corrupted stored data always justifies a finding when you can trace it from an input the
work accepts, even if the document never mentions the risk; an unbuilt part with unstated behaviour does not
count as protection.

**Confidence.** Report only what you can honestly anchor:

- **Certain**: provable from the text; you can quote what conflicts or what blocks it.
- **Likely**: will probably bite; full proof needs facts not in the documents; you checked twice.
- **Advisory**: real but minor at the current scale; still needs a quote. Shown as a note, no decision forced.
- Anything less: do not report it.

**Do not report**: wording, formatting or list-style preferences; another reviewer's question (see the table);
something the documents settle elsewhere (search first); sections marked deferred, out of scope or open
questions; problems the work neither touches, newly runs nor exposes; "what if things change" with no sign of
it in the documents.

## Severity: Bob's three buckets

- **Material**: would change a decision, a displayed number or data completeness, or makes the work fail or
  need substantial rework. Blocks the gate.
- **Minor**: a worthwhile local correction. Fix if cheap, otherwise log with a revisit trigger.
- **Cosmetic**: log only.

How confident you are, or how easy the fix is, does not change the bucket. Severity comes from the outcome.

## Output

For each finding, in this shape:

```markdown
### [Material | Minor | Cosmetic] <a short name for the thing affected, e.g. "R3 refund window">
- What goes wrong: <the consequence first, 2–4 sentences, as a reader or builder would meet it>
- Where: <file:line>, <file:line>
- Evidence: "<quote, 30 words or fewer in all>"
- Trigger / Path / Outcome / Reach: <one line each, Material only>
- Fix: <the change, and why it removes the cause>
- Confidence: <Certain | Likely | Advisory>
```

Name the thing, not just its number ("R3 refund window", not "R3"), so the reader can decide without opening
the file and two reviewers' findings on the same thing can be matched.

End with **"In plain English"** for a product owner who does not write code: one line per Material and Minor
finding — *what could go wrong, in everyday words → what to decide or change* — with no file paths and no
jargon. Count Cosmetics rather than list them. If there is no Material finding, say so in the first line.
