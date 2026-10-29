<!--
  Module card: fixed fields, fixed order (Head, then 0 to 8).
  One card per module, on the front page under 3.n. A card missing a
  field, or with one out of order, fails "fixed-field shape".

  The header is always visible; the fields open with their answers;
  the depth is folded (field 8).

  GENERATED parts sit between the "generated" and
  "/generated" marker comments and say which fact file they come from. Never
  type them by hand: field 0 (all five parts), the light, the line
  count, field 7 "Next" and field 8's capability list and "chapter
  keeps up" light are built from docs/blueprint/.
  A short fact (a date, a target, a rule) is never re-typed here:
  scripts/blueprint/fact-twice-check.mjs scans docs/blueprint/cards/.
-->

<a id="card-M1"></a>
<!-- Head -->
<!-- generated -->
<!-- from: blueprint.yaml (modules: id, name, plane; part lights;
     steps), the line counter -->
### `M1` · **<Module name>** · <plane or zone> · ◐ Amber · owns step <n> · <lines> lines
<!-- /generated -->

<!-- Head fields: ID · name · plane (or zone) chip · light chip ·
     "owns step n" chip · lines. ID coloured by plane or zone,
     the same colour as its band on the map; the light is generated
     from the part lights; the line count is generated. -->

<a id="card-M1-0"></a>
#### 0 · Where it sits in the loop

<!-- Always visible, never folded. All five generated from the
     step and module lists. -->
<!-- generated -->
<!-- from: blueprint.yaml (steps, modules) -->
- **(a) The step strip:** ● ● ○ · · ·
  <small circles for the loop's steps (for a pipeline product, its
  stages): this module's own steps filled in its plane colour, the
  steps it supports outlined, the rest grey, each linking to its row
  of the step table. A shared module shows the steps it supports
  outlined, captioned "shared: no step of its own".>
- **(b) Takes in:** <what>, from <module>, at step <n>
- **(c) Hands on:** <what>, to <module>, at step <n>
- **(d) Checkpoints held:** ◆<n> <the act's name>, or "none"
- **(e) Where you touch it:** <where>, or "never"
<!-- /generated -->

<a id="card-M1-1"></a>
#### 1 · What it's for

- **Purpose:** <one line>
- **Who relies on it:** <who>
- **The target, as a number:** <e.g. "we receive at least 99% of
  what the source itself counts">
- **Pillars served:** <objective IDs, primary first: O1, O3>. A
  capability that serves none is gold-plating.

<a id="card-M1-2"></a>
#### 2 · What it does today

<!-- Facts about what runs now, each with a receipt. -->

- <fact about what runs now> `<receipt>`
- <fact about what runs now> `<receipt>`

**Hands on: <X> to [<next module>](../BLUEPRINT.md#card-M2)**

<a id="card-M1-3"></a>
#### 3 · Must-have

**<One bold sentence: the module's done-test. The phase "Definition
of Done" lands here.>**

<a id="card-M1-4"></a>
#### 4 · What's outstanding

<!-- One bullet per gap. Every bullet is a homed red problem
     (test-guarded): it needs a home and a date or named trigger. -->
- **<Bold headline problem>** · <explanation> · **Target:** <a date,
  or "no date yet: reason", or "waiting on the owner: X"> ·
  `<receipt>`

<!-- Ends with "Accepted, not a gap:" lines. -->
**Accepted, not a gap:** <line>

<a id="card-M1-5"></a>
#### 5 · Health

<!-- generated -->
<!-- from: blueprint.yaml (part lights) -->
**Light + part counts:** ○ Red · 0 green, 4 amber, 1 red
<!-- /generated -->

<One sentence on why.>

**Parts table:**

<!-- generated -->
| Part | Light | In one line |
|---|---|---|
| <part> | ◐ Amber | <one line> |
<!-- /generated -->

<a id="card-M1-6"></a>
#### 6 · Modularity [G, 5+ modules]

The fixed prompts, each with a **Target:**

1. **What it hands on, and the check on it:** <answer> · **Target:**
   <date or trigger>
2. **How tangled it is:** <answer> · **Target:** <date or trigger>
3. **Adding or swapping stays local:** <answer> · **Target:** <date
   or trigger>
4. **Running, testing and undoing it alone:** <answer> · **Target:**
   <date or trigger>
5. **Fixes flow only where needed:** <answer> · **Target:** <date or
   trigger>
6. **Proving a change stays local:** <answer> · **Target:** <date or
   trigger>

<a id="card-M1-next"></a>
<a id="card-M1-7"></a>
#### 7 · Next

<!-- Generated from the roadmap data, so it never repeats Part 5 by
     hand. -->
<!-- generated -->
<!-- from: blueprint.yaml (milestones), rows/*.yaml for this module -->
- **Usable on:** <date> + <conditions> + "the likeliest reason it
  slips": <reason>
- **Green on:** <date> + the upstream dependency: <module or row>
- Dated steps, each with a receipt:
  - `<Sun 25 Oct>:` <step> `<row>`
  - `Done <23 Oct>:` <step> `<row>`
  - `After that · No date yet:` <step> `<row>`
<!-- /generated -->

<a id="card-M1-8"></a>
#### 8 · More detail (fold)

<details><summary>More detail</summary>

**The latest score card**

| Must do | Why red |
|---|---|
| <must do> | <why red> |

| Part | Light | Why, in plain words |
|---|---|---|
| <part> | ◐ Amber | <why> <sub>`<receipt>`</sub> |

| Planned, with dates | Outstanding | Done since [last score] |
|---|---|---|
| <row> | <gap> | <row> |

**The original design sheet**, word for word:

| Objective | Target | Receives / hands on | Checks |
|---|---|---|---|
| <objective> | <target> | <receives> / <hands on> | <check> (exists / partial / missing) |

| Levers | Assumptions | Gap today |
|---|---|---|
| <levers> | <assumptions> | <gap> |

**Research and evidence links:** [<report>](<path>)

**Decisions that shaped it:** <D-n, one line>

**The module's detail spec (its chapter), linked:**
[docs/domains/M1.md](../../domains/M1.md)

<!-- generated -->
<!-- from: blueprint.yaml (capabilities where module = this one),
     git (merged changes vs the chapter's last review date) -->
**Capabilities this module delivers:** C1 · <name> · <maturity>

**"Chapter keeps up" light:** ● Green / ◐ Amber. Amber when the
module has merged changes since its chapter was last reviewed; a
signal, never a gate.
<!-- /generated -->

</details>
