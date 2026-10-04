# Round 0 — real reference sites from Inspo (DEFAULT for every website gallery)

**What.** Before Round 1, pull ~10 real, shipped websites that fit the brief from **Inspo**
(https://inspomcp.dev — 832 curated sites with desktop + mobile screenshots, real fonts, sizes,
spacing and a DESIGN.md each; free, MIT, connected to Claude Code as the `inspo` MCP server,
user scope). Show them to Joe as a numbered board, get LIKE/MEH/NO by number, then build Round 1
mockups that start from the liked sites' actual type and spacing — not from a style name written
in words.

**Why.** "Reference-class anchoring decides the cluster" (design-mockups heuristic #1), and
"Translate, Don't Paraphrase" (global Principle 6): a real site is a source to port proportions
from; a prose style is a ~70% approximation. Before Inspo, Round 1 could only use references Joe
already knew and named. (Verdict: joe.wang "Verdicts" note, Trying section, 2026-10-03.)

**Joe asked for this to run by default** (2026-10-03: *"incorporate inspo as default bc i wont
remember to activate it"*). Do NOT ask whether to use it. Run it, say in one line that you did.

## When it runs
- **Every** design-gallery run for a website or marketing page, and image-lane (design-mockups)
  runs for a homepage/hero. HTML-lane product dashboards: run it too, but with a smaller pull (5)
  since Inspo is mostly marketing sites.
- **Skip it** (and say so in one line) when:
  - the project is 🔴 client work product (e.g. Swarmer) — the hosted Inspo server receives the
    search text, and it can't be verified that they don't keep it. Use local mode instead only if
    it has been set up (`claude mcp add --scope user inspo-local -- npx -y inspo-mcp`); otherwise skip.
  - the `inspo` tools aren't available in this session (server down / removed) — proceed without,
    note it.
  - Joe has already supplied his own reference sites for this brief — use his, add Inspo only if
    he asks.

## How
1. **Search, never `recommend`.** In the 2026-10-03 test, `recommend(brief)` returned off-target
   sites (a clothing store for a calm editorial personal site); keyword search returned 8 real,
   relevant blogs. Run 2–3 searches with concrete words (page type + tone + type style, e.g.
   "personal blog essays editorial serif", "fintech dashboard dark dense data") and take the best
   ~10 distinct sites.
2. **Trust fonts, sizes and spacing; do NOT trust its colours.** Its colour extraction is a guess
   (Linear came back mustard yellow; it is near-black + violet). Take colour from the screenshot
   by eye or from Joe's palette work, never from Inspo's palette field.
3. **Keep context small.** One `recommend` call was ~41KB with thumbnails and stays in the
   conversation. Prefer targeted searches and pull a site's full DESIGN.md only for sites Joe LIKEs.
4. **Board.** Put the ~10 on the rating board (`templates/gallery-index.html`) as `R01…R10`
   (screenshot + site name + link), same LIKE/MEH/NO + note flow. Credit each site.
5. **Round 1 mix.** Build **half** of Round 1 from LIKEd references (each mockup names its
   reference: "R03 type scale + R07 spacing") and **half** from the usual archetypes/styles.
   Label which is which on the board so the trial can be scored.
6. **Adapt, don't copy.** Port proportions, type scale, spacing rhythm, section order. Never ship
   a near-clone of one site's look on a public site.

## The trial (scores itself — record it, don't ask Joe to remember)
Inspo is in **Trying** until two website galleries have run with Round 0. After Joe's Round 1
rating, append one line to `inspo-trial-log.md` (this folder):

`<date> · <project> · refs liked: X/10 · Round-1 LIKEs: Inspo-based A of N vs archetype B of M`

- **Keep** (→ promote to "Worth it" on joe.wang, drop the trial wording here): across the two
  runs, ≥3 of 10 refs LIKEd each time AND Inspo-based mockups get at least as many LIKEs as
  archetype ones.
- **Drop** (→ `claude mcp remove inspo --scope user`, move to "Looked at, passed", delete this
  step from SKILL.md): ≤1 ref LIKEd in a run, or Inspo-based mockups clearly lose.
- After the second logged run, tell Joe the result and the call in one short paragraph.
