<!--
  Second page of the Blueprint & Roadmap: "History & evidence".
  The appendices, word for word. Every old anchor resolves; headings
  keep "(was X)" labels when a section is renamed. Marks: [C] core,
  [G] grows-with-product, [O] optional (see front-page.md).

  FROZEN parts (old blocks kept word for word) sit between
  the "frozen" and "/frozen" marker comments, each under the frozen banner
  below. They are never edited and never linked as current.
  GENERATED parts sit between the "generated" and
  "/generated" marker comments and say which fact file they come from; never
  type them by hand.

  Anchors are stable: app-a … app-m, app-z. Never rename or remove
  one; a renamed heading keeps its old anchor and adds "(was X)".
-->

<a id="history"></a>
# <Product name>: History & evidence

> **Not needed for a first read.** The front page is the one current
> view; this page keeps the history and the evidence behind it, so
> every old link still lands. [Back to the front page](front-page.md)

**The frozen banner** (put it above every frozen block):

> **Frozen, as of <YYYY-MM-DD>; not maintained.** Kept word for word
> so old citations still land. The current view is on the
> [front page](front-page.md).

---

<a id="app-a"></a>
## A · Document info [C]

- **Version and adoption:** <vN>, adopted by <owner> on <date>
- **The as-of date and its test:** <as-of date>; the test fails when
  it is more than 7 days behind the newest merged change
- **Update rules and why:** <rule> · why: <why>
- **Constraints that never change:** <constraint>
- **The old header, kept:**

<!-- frozen -->
> **Frozen, as of <YYYY-MM-DD>; not maintained.**

<old header, word for word>
<!-- /frozen -->

- **What this supersedes:** <earlier document or version>
- **Notes on the repo copy:** <where the files live; the phone view
  is generated>
- **Old → new section map** [G, after the first restructure]:

| Old section | New section |
|---|---|
| <old> | [<new>](front-page.md#<anchor>) |

<a id="app-b"></a>
## B · Status log [G, after 2+ updates]

Earlier "where we are" blocks word for word, newest first, each with
the **frozen banner**:

<!-- frozen -->
> **Frozen, as of <YYYY-MM-DD>; not maintained.**

### <YYYY-MM-DD> · <headline>

| Stage | Light | G·A·R parts | Why |
|---|---|---|---|
| <stage> | ◐ Amber | <g>·<a>·<r> | <why> |

- **Done-definition:** <as it stood>
- **Plan by date:** <as it stood>
- **Outstanding:** <as it stood>
- **What changed since:** <as it stood>
<!-- /frozen -->

<a id="app-c"></a>
## C · Detailed scorecard [C basic; G full]

### Finish-line tests (each can fail)

- <test> · fails when <condition>

### Where we stand

**The read in one paragraph:** <paragraph>

Buckets:

- **Fixed this week:** <items>
- **Built with no date:** <items>
- **Owned, not built:** <items>
- **No owner:** <items>
- **The rule the verifier settled:** <rule>

<details><summary>Receipts: what this re-score corrected in earlier
notes</summary>

Each fixed on its own row in the same change:

| Earlier note | Corrected to | Row |
|---|---|---|
| <note> | <correction> | <row> |

</details>

### Matrix

<!-- generated -->
<!-- from: blueprint.yaml (module part lights) -->
"Scored against version <X> at time <Y>"

| Stage | Green | Amber | Red | Light | Change |
|---|---|---|---|---|---|
| <stage> | <n> | <n> | <n> | ◐ Amber | <since last> |
<!-- /generated -->

### Every red problem and its home (test-guarded)

<!-- generated -->
<!-- from: the module cards' "What's outstanding" bullets and
     rows/*.yaml. A row without a home (row or intake ID) or without
     a date or named trigger fails the check. -->
| # | Stage | Problem | Bucket | Home (row) | Date or named trigger |
|---|---|---|---|---|---|
| 1 | <stage> | <problem> | <bucket> | <R-M1-1> | <date or trigger> |
<!-- /generated -->

### Scoring rubric

| Item | Green means | Amber | Red |
|---|---|---|---|
| <item> | <green> | <amber> | <red> |

### One number per module

| Module | Quality measure | Today → target | Speed / freshness | Today → target |
|---|---|---|---|---|
| M1 | <measure> | <today> → <target> | <measure> | <today> → <target> |

- **"What good looks like by <date>":** <description>
- **Weekly scoreboard** incl. balance by objective [G]:
  <week · shipped · by objective>

<a id="app-d"></a>
## D · Map vs what's built [O]

For when the map is a design ahead of the code.

| Module on the map | What's built | Gap |
|---|---|---|
| <module> | <built> | <gap> |

<a id="app-e"></a>
## E · Who may change what [O; G with several builders]

Lanes, single-owner files:

- **Lanes:** <lane → who>
- **Single-owner files:** <file → owner>

<a id="app-f"></a>
## F · Design detail [G]

- **Long-form rules** (**frozen history**):

<!-- frozen -->
> **As of <YYYY-MM-DD>, not maintained; the full text of each rule
> now lives in its chapter.** The chapters are the one live home.

<old long-form rule text, word for word>
<!-- /frozen -->

- **Design sheets:** <sheet>
- **Mechanisms:** <mechanism>
- **Adopt / try / watch / skip:** <item → call>
- **Performance by design:** <notes>
- **Method rulebook** [O, analytical products]: <link>
- **AI operating model** [O, AI products]: <link>
- **Outside-input standards:** <standard>
- **The backbone:** <the core design, one paragraph>

<a id="app-g"></a>
## G · Roadmap detail [G]

- **Where we are against the plan:** <one paragraph>
- **Fix now:** <items>
- **Remaining gaps:** <items>
- **Phases:** <phase list>
- **Operating rhythm:** <daily / weekly rhythm>

<a id="app-g-decisions"></a>
### Decisions log [C]

<!-- generated -->
<!-- from: the decision log. Newest first, in the owner's own words,
     each "replaces D-x" where it amends one. -->
| # | Date | What was decided |
|---|---|---|
| D-2 | <date> | <in the owner's own words> (replaces D-1) |
<!-- /generated -->

<a id="app-h"></a>
## H · Your questions and where they are answered [C]

In the owner's own phrasing, directives included.

| You asked | Answer in brief | Where |
|---|---|---|
| <question> | <answer> | [<section>](front-page.md#<anchor>) |

<a id="app-i"></a>
## I · Plain-English glossary [C]

Each line reads: term → plain meaning, with the technical name in
brackets after the term.

| Term (technical name in brackets) | Plain meaning |
|---|---|
| **<term> (<technical name>)** | <plain meaning> |

<a id="app-j"></a>
## J · Chapters and where the detail lives [C] (was "Where the detail lives")

First the chapters:

<!-- generated -->
<!-- from: blueprint.yaml (chapters) -->
| Chapter | Owns (depth only) | Linked from |
|---|---|---|
| Product | <depth> | <sections> |
| Market | <depth> | <sections> |
| Behavior | <depth> | <sections> |
| Architecture | <depth> | <sections> |
| Module specs | <depth> | <cards> |
| <any other chapter, e.g. "Engine design", "How we work"> | <depth> | <sections> |
<!-- /generated -->

Then the files:

| File | What it holds | Supports |
|---|---|---|
| <path> | <what> | <section> |

Where a file disagrees with this page, the page wins.

<a id="app-k"></a>
## K · Corrections log [C]

| Earlier claim | Corrected |
|---|---|
| <earlier claim> | <corrected value> |

The corrected value is used throughout this page.

<a id="app-l"></a>
## L · Previous scores and plans [G]

Kept so old citations still land, each with its original date and the
frozen banner ("superseded, not rejected"):

<!-- frozen -->
> **Frozen, as of <YYYY-MM-DD>; not maintained. Superseded, not
> rejected.**

<old score or plan, word for word>
<!-- /frozen -->

<a id="app-m"></a>
## M · Technical changelog [C]

> **Builders' notes; the owner can skip.**

<!-- The "since you last read" strip (front page 1b) is generated
     from this table. -->
| Version | What changed |
|---|---|
| <vN> | <change> · audit: <n> material, <n> minor, <n> cosmetic |

<a id="app-z"></a>
## Z · Archive [C]

Struck estimates, superseded blocks and old versions the live page
moved out, by date:

<!-- frozen -->
> **Frozen, as of <YYYY-MM-DD>; not maintained.**

### <YYYY-MM-DD>

<moved-out text, word for word>
<!-- /frozen -->
