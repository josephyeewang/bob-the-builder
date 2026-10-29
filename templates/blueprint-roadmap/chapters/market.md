> **Chapter of the Blueprint:** short facts live there; this page holds depth.

<!--
  Copy to docs/market.md (the path blueprint.yaml names for
  "Market"). This chapter holds DEPTH only. Short facts have one home
  in docs/blueprint/ and are linked or generated, never re-typed:
    • each competitor's ID, name, group, one-liner and dates →
      blueprint.yaml (competitors); section 2b shows the closest 3–6
      automatically
    • who it's for and the pain → decided.yaml (section 2b)
  The raw evidence sits in the research library (section R). Every
  "we should take this" item becomes a roadmap or intake row.
  scripts/blueprint/fact-twice-check.mjs fails a re-typed one-liner.

  GENERATED parts sit between the "generated" and
  "/generated" marker comments; never type them by hand.

  Small product: the Product and Market chapters may be one file with
  two headings ("# Product" and "# Market"), so a personal tool isn't
  handed a 20-section page.
-->

<a id="market"></a>
# Market

Above the cards, this chapter keeps the landscape, the comparison
table, the "why not just ask a general AI" baseline, what we take,
positioning, the coverage map and the watch list. The closest
competitors in one line each:
[section 2b](blueprint/front-page.md#s-2b).

<a id="landscape"></a>
## The landscape map (groups)

<!-- Every competitor sits in one group; the group names come from
     blueprint.yaml (competitors: group). -->

| Group | Who is in it | What the group does well |
|---|---|---|
| <group> | <K1, K2> | <what the group does well> |

<a id="comparison"></a>
## The comparison table

<!-- generated -->
<!-- from: the competitor cards below (fields 1, 4, 5, 6) and
     blueprint.yaml (competitors), where possible -->
| ID | Name | What they do | Where they beat us today | Where we are different | Coverage |
|---|---|---|---|---|---|
| K1 | <name> | <one-liner> | <field 4> | <field 5> | <field 6> |
<!-- /generated -->

<a id="general-ai"></a>
## Why not just ask a general AI

<!-- The baseline: what someone gets by asking a general AI assistant
     the same question today, and where that falls short for this
     pain. -->
- **What a general AI does well here:** <answer>
- **Where it falls short:** <answer>
- **What we add on top:** <answer>

<a id="take"></a>
## The gap and what we take

<!-- One line per attractive part, each with its home. -->
| What we take | From | Home (intake or roadmap row) |
|---|---|---|
| <attractive part> | <K1> | <R-M1-1 / IN-n> |

<a id="positioning"></a>
## Positioning

<!-- Lead with the pain solved, not with what is rare. A competitor
     serving the same pain proves the pain is real; it is never a
     reason to play down the core. -->
- **The pain we solve:** <link to section 2b; depth here>
- **For whom:** <depth>
- **Why us:** <depth>

<a id="coverage"></a>
## The coverage map

| | <market or platform 1> | <market or platform 2> | <pricing tier> |
|---|---|---|---|
| Us | <yes / no / planned> | <…> | <…> |
| K1 | <…> | <…> | <…> |

<a id="watch"></a>
## The watch list

<!-- generated -->
<!-- from: blueprint.yaml (competitors: last_checked, recheck_by).
     A line past its re-check date shows ◐ Amber. -->
| ID | Name | Last checked | Re-check by | Light |
|---|---|---|---|---|
| K1 | <name> | <date> | <date> | ● Green |
<!-- /generated -->

<a id="cards"></a>
## Competitor cards

<!-- One card per competitor in the fact list, each following
     docs/blueprint/competitor-card.md exactly (Head, fields 1–9). -->

<the K1 card, from competitor-card.md>
