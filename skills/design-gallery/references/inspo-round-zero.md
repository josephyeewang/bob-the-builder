# Round 0 — real reference sites from Inspo (DEFAULT for every website gallery)

**What.** Before Round 1, pull ~10 real, shipped websites that fit the brief from **Inspo**
(https://inspomcp.dev — a public reference catalogue with screenshots, typography/spacing data
and design summaries). This integration is optional: check current availability, service terms
and the approved data route; installation does not establish a connection. Show them to the user as a numbered board, get LIKE/MEH/NO by number, then build Round 1
mockups that start from the liked sites' actual type and spacing — not from a style name written
in words.

**Why.** "Reference-class anchoring decides the cluster" (design-mockups heuristic #1), and
"Translate, Don't Paraphrase" (Engineering Principle 6): a real site is a source to port proportions
from; a prose style can lose those details. Before Inspo, Round 1 could only use references the user
already knew and named.

When approved reference tools are available, run Round 0 by default and say so in one line.
Installation does not authorize adding connectors, sending confidential material or changing tool
configuration. If unavailable, use supplied references or proceed without this optional round and
state the omission.

## When it runs
- **Every** design-gallery run for a website or marketing page, and image-lane (design-mockups)
  runs for a homepage/hero. HTML-lane product dashboards: run it too, but with a smaller pull (5)
  since Inspo is mostly marketing sites.
- **Skip it** (and say so in one line) when:
  - the project contains confidential material and the external data route is not approved.
    Hosted reference tools receive search text; use an already approved local tool or public,
    nonsensitive terms only. Otherwise skip.
  - the `inspo` tools aren't available in this session (server down / removed) — proceed without,
    note it.
  - The user has already supplied their own reference sites for this brief — use theirs, add Inspo only if
    they ask.

## How
1. **Use focused searches.** Query concrete page type, tone and typography terms with the approved
   tools. Review relevance rather than accepting an automated recommendation as a design decision.
2. **Verify extracted values.** Check fonts, sizes and spacing against the selected site; confirm
   colours from its actual screenshot/source rather than trusting an inferred palette.
3. **Keep context focused.** Retrieve summaries/screenshots for discovery; pull detailed design
   values only for references the user selects. Do not send confidential briefs to public tools.
4. **Board.** Put the ~10 on the rating board (`templates/gallery-index.html`) as `R01…R10`
   (screenshot + site name + link), same LIKE/MEH/NO + note flow. Credit each site.
5. **Round 1 mix.** Build **half** of Round 1 from LIKEd references (each mockup names its
   reference: "R03 type scale + R07 spacing") and **half** from the usual archetypes/styles.
   Label which is which on the board so the trial can be scored.
6. **Adapt, don't copy.** Port proportions, type scale, spacing rhythm, section order. Never ship
   a near-clone of one site's look on a public site.

## Optional project trial

If the project is evaluating reference discovery, agree on the comparison and review point first.
After the Round 1 rating, append one line to the project's `docs/design/inspo-trial-log.md` using
this folder's template. Historical trials from other users do not establish this project's status.
Never write project results to the installed skill or change its shared instructions.

`<date> · <project> · refs liked: X/10 · Round-1 LIKEs: Inspo-based A of N vs archetype B of M`

Record the denominators; these counts describe the project's feedback, not a universal quality
score. At the agreed review point, recommend keep/change/stop based on the evidence and the user's
judgment; record the decision in the project. Do not remove connectors or edit installed skills as
a side effect of the trial.
