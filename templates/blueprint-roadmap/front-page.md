<!--
  Front page of the Blueprint & Roadmap: the read for deciding.
  Plain English; a builder word appears once, in brackets.

  The flow: answer → goal → the machine → the rules it obeys →
  where we are, dated → what we learned → how we operate →
  how to read the lights → everything else, kept and findable.

  Marks on every section and field:
    [C] core: every product has it.
    [G] grows-with-product: it appears when the product reaches the
        size noted.
    [O] optional.

  GENERATED parts sit between the "generated" and
  "/generated" marker comments and say which fact file they come from.
  They are built from docs/blueprint/ (decided.yaml, blueprint.yaml,
  exit-tests.yaml, rows/*.yaml) and the record. Never type them by
  hand: a hand edit fails "generated means generated", and a re-typed
  owned fact fails scripts/blueprint/fact-twice-check.mjs.

  Everything else is hand-written judgment. Replace each <…>.
  Every heading carries a stable anchor; never rename or remove one.
-->

<a id="s-0"></a>
# <Product name>: Blueprint & Roadmap

<!-- 0 · Header [C] -->
<!-- generated -->
<!-- from: blueprint.yaml (as_of), the decision log, the audit
     ledger, git -->
**<Product name>** · version <vN> · **as of <YYYY-MM-DD>** (stamped
automatically) · adopted by / when: <owner> / <YYYY-MM-DD>

**Audited by <N> fresh reviewers · figures checked against
<code version>**

This page is the one current view.

**Pinned contents bar** (section highlight; a sticky menu on phones):
[Summary](#s-1) · [Since you last read](#s-1b) · [Ideas](#s-1c) ·
[Objectives](#s-2) · [Not doing](#s-2a) · [Market](#s-2b) ·
[Map](#s-3-0) · [Cards](#s-3-n) · [Capabilities](#s-3-c) ·
[Rules](#s-4) · [Status](#s-5a) · [Done](#s-5b) · [Plan](#s-5c) ·
[Waiting on you](#s-5d) · [Learnings](#s-6) · [How it runs](#s-7) ·
[Scoring](#s-8) · [Research](#s-r)

Links to the phone view and to "History & evidence":
[phone view](BLUEPRINT.md) · [History & evidence](history-page.md)
<!-- /generated -->

---

<a id="s-1"></a>
## 1 · Executive summary [C]

<!-- Generated from data, except the risk and the one-line read.
     At most 12 lines or 150 words: one phone screen. -->

<!-- generated -->
<!-- from: decided.yaml (goal), blueprint.yaml (modules, milestones),
     rows/*.yaml, the record, the decision log -->
- **One-line purpose:** <from decided.yaml goal>
- **Runs itself?** <yes / no / partly>
- **Overall health (counts per light):** ● Green <n> · ◐ Amber <n> ·
  ○ Red <n>
- **Latest key result** [G, once there are measured results]:
  <result> `<receipt>`
<!-- /generated -->
- **Biggest risk:** <hand-written, one line> `<receipt>`
<!-- generated -->
- **Target dates for "done":** <stage> by <date from milestones>
- **What limits the pace** [G]: <one line>
- **Recently shipped:** <row> · <row> · <row>
- **How work is run (only if it changed):** <one line>
- **Cost** (what running it costs, per month): <amount>
- **Waiting on you: needed now** (top 3–6): <ask> · <ask> · <ask>
- **Waiting on others: who / what / since:** <who> / <what> / <since>
- **Already decided by you (recent):** <D-n> · <D-n>
- **As-of date + where newer changes are written down:** as of
  <date>; newer changes: <the changelog / the record>
<!-- /generated -->

**The one-line read:** <hand-written: what this all means, in one line>

<a id="s-1b"></a>
## 1b · Since you last read [C]

<!-- generated -->
<!-- from: Appendix M, the technical changelog -->
The last 3–5 changes touching the front page, each one line linked to
the changed section:

- <change, one line> → [<section>](#<anchor>)
<!-- /generated -->

<a id="s-1c"></a>
## 1c · Ideas inbox [C]

<!-- generated -->
<!-- from: the record (the intake list) -->
Ideas the owner filed (from the intake, or a phone note) and findings
not yet placed, shown at once as **"unsorted"** until the lead places
them.

| Idea or finding | Filed by | When | State |
|---|---|---|---|
| <idea> | <who> | <date> | unsorted |
<!-- /generated -->

---

<a id="s-2"></a>
## 2 · Objectives [C]

<!-- generated -->
<!-- from: decided.yaml (goal, objectives) -->
> **Overall goal** callout: <decided.yaml goal>

Numbered objectives:

| ID | Short name | One-line promise | Target, as a number | How it's measured |
|---|---|---|---|---|
| O1 | <name> | <promise> | <number> | <measure> |

<details><summary>Collapsible Detail: O1</summary>

<The target and its measure take in the success metrics, the first-use
"activation" target and the build manifest's measurement map.>

</details>
<!-- /generated -->

- **Constraints that never change** [C, may live in Document info]:
  <constraint> (or: see [Appendix A](history-page.md#app-a))
- **A default speed objective for any product with screens:**
  declared pages respond in ~1 second, with instant feedback. The
  product may set its own number; it feeds the speed budget.

<a id="s-2a"></a>
## 2a · Not doing [C]

<!-- generated -->
<!-- from: decided.yaml (not_doing). The roadmap's "not starting, by
     your ruling" line is generated from the same list. -->
Under the objectives:

| What we are not doing | Why | What would make us revisit it |
|---|---|---|
| <what> | <why> | <revisit if> |
<!-- /generated -->

<a id="s-2b"></a>
## 2b · Who it's for and the market [C; O for personal tools]

<!-- generated -->
<!-- from: decided.yaml (for_whom), blueprint.yaml (competitors) -->
- **Who it's for** (one line): <decided.yaml for_whom>
- **The pain, in one moment:** <one moment>
- **What they use today:** <today's alternatives>
- **Closest competitors** (top 3–6, generated from the competitor
  list):

| ID | Name | What they do | What we take from them |
|---|---|---|---|
| K1 | <name> | <one-liner> | <what we take> |

- **Our edge, in one line:** <edge>
- **The date the market was last checked:** <date>, **amber once
  past its re-check date**
- Links to the Product and Market chapters:
  [Product chapter](../product-spec.md) ·
  [Market chapter](../market.md)
<!-- /generated -->

---

<a id="s-3-0"></a>
## 3.0 · The map: the main architecture diagram [C], the centrepiece

<!-- Layout, box fields and the one-cut rule: map.md. -->
<!-- generated -->
<!-- from: blueprint.yaml (modules, steps, part lights) -->
Modules drawn in their zones or stages. Each box: **mono ID · bold
name · one-line role · light dot and label**, linking to its card.
**Lights are generated.** **Two layouts:** wide for desktop, tall for
phone (see map.md).

```mermaid
<the wide or tall layout from map.md, filled from the module list>
```

Under it, an **"applies to every module" band** [G, once there are
shared rules or services]: shared rules · shared services · loops
back up the chain

**A card legend line:** ● Green · ◐ Amber · ○ Red · `ID` coloured by
plane or zone · ◆n checkpoint

Proposed modules shown as **"Proposed, not adopted"** and never
scored [O].
<!-- /generated -->

**The one-cut rule:** for a process product (one whose work moves
through steps), the map draws the loop as a numbered path through the
modules, each step with exactly one owning module, plus a "serves
every step" column for shared modules; for a pipeline product (one
whose work flows through stages), the stages *are* the path,
unchanged.

<a id="s-3-n"></a>
## 3.n · Module cards [C], fixed fields in a fixed order

One per module; **the header always visible**, **the fields opening
with their answers**, **the depth folded**. Each card follows
module-card.md exactly.

<!-- One card per module, in module-ID order:
     <a id="card-M1"></a> … the card from module-card.md … -->

<a id="s-3-c"></a>
## 3.c · Capability index [C]

<!-- generated -->
<!-- from: blueprint.yaml (capabilities), decided.yaml
     (capabilities_adopted), rows/*.yaml -->
| ID | Capability | Module | Stage of maturity | Roadmap row | Status |
|---|---|---|---|---|---|
| C1 | <name> | M1 | <maturity> | R-M1-1 | <status> |
<!-- /generated -->

It replaces Bob's one-page capability map and its capability
tracking table, so neither is written by hand again.

<a id="s-3-x"></a>
## 3.x · Proposed modules [O]

| Job | What exists today | The decision needed |
|---|---|---|
| <job> | <what exists today> | <the decision needed> |

---

<a id="s-4"></a>
## 4 · Rules it runs by [C]

<!-- generated -->
<!-- from: decided.yaml (rules); where each rule is enforced comes
     from blueprint.yaml. Grouped by theme. -->
<!-- Grouped by theme. Each rule: bold short name · one-sentence
     rule · collapsible Detail. -->
### <Theme>

- **<Bold short name>** (RU1): <one-sentence rule>
  <details><summary>Collapsible Detail</summary>

  Source decision: <D-n> · Where it breaks today: <where> ·
  Pointer to the full text: [<chapter>](../<chapter>.md#RU1)

  </details>
<!-- /generated -->

**Loops back up the chain** [G]: <loop: what flows back, from where to
where>

### How well they hold today [G, once rules are scored]

<!-- generated -->
<!-- from: blueprint.yaml (rule scores) -->
**Roll-up line:** <n> ● Green · <n> ◐ Amber · <n> ○ Red

| Rule or loop | Light | In one line |
|---|---|---|
| <rule> | ◐ Amber | <one line> |

<details><summary>Collapsible score cards</summary>

<One collapsible score card per rule or loop.>

</details>
<!-- /generated -->

---

<a id="s-5a"></a>
## 5a · Stage-by-stage status [C]

<!-- generated -->
<!-- from: the module cards (blueprint.yaml modules + parts),
     rows/*.yaml, exit-tests.yaml. Generated from the cards, never
     hand-written. -->
| Stage | Usable on | Green on (its own test passes and everything it reads from is green) | Reads from | done-test written yet? | Remaining steps | Known gaps after that |
|---|---|---|---|---|---|---|
| <stage> | <date> | <date> | <stages> | <yes/no> | <rows> | <gaps> |

Footnotes: ¹ **"usable"** means <definition>. ² **"green"** means its
own test passes and everything it reads from is green.
<!-- /generated -->

<a id="s-5a-plus"></a>
## 5a+ · How it's made modular + making the modules separate [G, 5+ modules]

<!-- generated -->
<!-- from: blueprint.yaml (modularity goals), rows/*.yaml -->
**Goals table:**

| Goal | What does it today | What the roadmap adds (row, date) | Still missing |
|---|---|---|---|
| <goal> | <today> | <row>, <date> | <missing> |
<!-- /generated -->

> **Approved by [owner], [date] (D-n)** additions box: <addition>

**Separation plan:**

<!-- generated -->
| When | Step | Row |
|---|---|---|
| <when> | <step> | <row> |
<!-- /generated -->

<a id="s-5b"></a>
## 5b · "Done" definition [C]

One or more named stages (e.g. "useful", the gate; "certified",
trailing), each with **legs that can fail** (e.g. runs itself ·
correct · watched · safe to build on):

### <Stage name>

- **Leg:** <leg> · its test: <how it can fail>
- **"Not a leg:"** <exclusion>
- **"No longer a risk:"** <line>
- **"Finish, don't rebuild"** ruling: <ruling> `<D-n>`

<a id="s-5c"></a>
## 5c · The dated plan = the roadmap [C]

<!-- Milestones, rows and the timeline, generated from the milestone
     data (blueprint.yaml, exit-tests.yaml) and the row files
     (rows/*.yaml). Only the "why this date" folds and the priority
     rule are hand-written. -->

<!-- generated -->
**Now / next / later strip:** now: <building this week> · next:
<what's next> · later: <parked item> (trigger: <its trigger>)
<!-- /generated -->

### Milestones in sequence

<!-- generated -->
#### B1 · <milestone name>

- **Exit test** (pass/fail, runnable; kept in its own protected file,
  exit-tests.yaml; it may run only files in `tests/exit/`):
  <passes when>
- **Estimate:** <current value> + one condition (<condition>)
- **Slip history** (drawn as a slip chart): <from> → <to>: <reason>
- **How to undo it** (rollback) [O]: <steps>
- **The experience test** [O] (what a user should be able to do):
  <test>
- **The scenarios that must keep working** [O] (regression
  scenarios): <scenarios>

Rows:

| ID | what | module | value | size | capability | owner | date or trigger | done when | status | receipts |
|---|---|---|---|---|---|---|---|---|---|---|
| R-M1-1 | <short sentence> | M1 | <1–5> | <S/M/L> | C1 | <owner> | <value + one condition> | <meets O1's target> | <status> | <fold> |
<!-- /generated -->

<details><summary>Why this date</summary>

<the reasoning behind the estimate>

</details>

"A milestone ends when its test passes, never because a date arrived."

### The dated plan table

<!-- generated -->
| When | What |
|---|---|
| <when> | <what> |
| | **What's queued next:** <rows> |
| | **What's not starting, by your ruling:** <from Not doing> |
| | **Dates are estimates.** |
<!-- /generated -->

### Timeline

<!-- generated -->
<A Gantt-style strip of milestones with today's line.>
<!-- /generated -->

**Priority rule when time is short:** <e.g. B1 > B2 > B3 > the rest>

### The ranked "next" list

<!-- generated -->
<!-- from: rows/*.yaml (value, size, status) -->
The ready rows ranked by value for their size, inside the priority
rule. The lead takes the top one or writes one line on why not.

1. <row> · value <n> · size <S/M/L>

**Shipped vs planned** (weekly line): <n> shipped of <n> planned
<!-- /generated -->

<a id="s-5d"></a>
## 5d · Waiting on you [C]

<!-- generated -->
<!-- Generated: the first five sub-lists from the record (the one
     home of live asks), the last from the decision log. The GitHub
     phone view can't read the record, so its copy says "as of
     [date]; live list: the
     digest issue or the intake". Fixed sub-lists in fixed order. -->
1. **Needed now** (what's needed: a click, a word or a decision ·
   date · receipt): <ask> · <date> · `<receipt>`
2. **For your review:** <item>
3. **Pre-approved, no longer waiting:** <item>
4. **On hold by you:** <item>
5. **Older open calls:** <item>
6. **Decided, for the record** (ages into the decisions log):
   <D-n, one line>
<!-- /generated -->

<a id="s-5e"></a>
## 5e · Per module [C]

Pointer to each card's **"Next" field** (one home per fact):
[M1 → Next](#card-M1-next) · [M2 → Next](#card-M2-next)

---

<a id="s-6"></a>
## 6 · Learnings [C once there's history; G in depth]

<!-- Table # · What we learned, one row per objective. Each row
     folds to a headline stated as a conclusion. -->
| # | What we learned |
|---|---|
| 1 | **<a headline stated as a conclusion>** (opens below) |

<details><summary><b>1 · <a headline stated as a conclusion></b>
</summary>

| Objective | Old id | Old title |
|---|---|---|
| O1 | <old id> | <old title> |

<A plain summary.>

**"The detail, with sources"**

| Learning | Source |
|---|---|
| <learning> | Measured · Audit · History · Best practice · Live defect |

Also: whether each lesson became a check, **"written only"** vs
**"made impossible"**: <which>

</details>

**Memory row** [G]:

| Kind | In short | What |
|---|---|---|
| **Settled (don't re-argue)** | <in short> | <what> |
| **Open (test next)** | <in short> | <what> |
| **Stop citing (no longer true)** | <in short> | <what> |
| **The pattern (rediscovered, not acted on)** | <in short> | <what> |

<a id="s-7"></a>
## 7 · How the work is run [C]

~10 one-line rules:

1. **Roles:** <who does what: intake, lead, workers, merge check>
2. **Who may change production:** <who>
3. **Approval and pacing rules:** <rule>
4. **The one-current-view rule:** this page is the one current view.
5. **The every-finding-needs-a-home rule:** every finding becomes a
   row or an intake entry.
6. **The deliberate-hold rule:** <rule>
7. **The re-score cadence:** <cadence>
8. **Which Bob mode is running:** <NEW / AUDIT / EVOLVE / UPGRADE>
9. <rule>
10. <rule>

<a id="s-8"></a>
## 8 · How we keep score [C]

- **Light definitions:** ● Green = <…> · ◐ Amber = <…> · ○ Red = <…>
  (chips: visual-devices.md)
- **"A document saying it works is amber at most."**
- **"A module takes the colour of its worst part."**
- **"Lights change only on evidence, never because a date passed."**
- **Cadence:** <how often lights are re-scored>
- **Audit sizing by tier:** <tier → audit size>

---

<a id="s-r"></a>
## R · Research library [C]

<!-- generated -->
<!-- from: blueprint.yaml (research). Never deleted. Each card's fold
     links its own research. -->
Every research report, fact-check, audit and design note:

| Date | One-line finding | Module or row it informs | Link | Superseded by (if replaced) |
|---|---|---|---|---|
| <date> | <finding> | <M1 / R-M1-1> | [<file>](<path>) | <if replaced> |
<!-- /generated -->

**Never deleted.**
