---
name: design-gallery
description: "The design-gallery machinery: explore a product's look-and-feel as a rated gallery of mockups, converge through rounds to a LOCKED design, then transfer it into the real product EXACTLY (no re-creation-from-description drift). Three lanes: HTML mockups for product UI/dashboards where exactness must survive the transfer to code; AI-image comps (via the design-mockups skill) for art direction, heroes, moodboards, brand; code-drawn SVG concept boards for logos/marks. Use when the user wants to explore visual directions for a dashboard/app/website, run a design gallery, audition palettes/parameters live, lock a design, or push a locked design through to the real product. Proven on InsiderIntent (55-mockup gallery → locked design 45 → wired product, D-312) and Explain My Blood Test (~250 image comps → locked direction). Pairs with Bob the Builder Step 5.5."
user-invocable: true
---

# design-gallery — explore as a gallery, lock exactly, transfer exactly

Reusable machinery for the full arc: **breadth → feedback-by-number → remix rounds → live
playground → LOCK → exact transfer**. The arc has two failure modes, both observed in the field
and both designed against here: *generic output* (fixed by exploring wide with real content and
strong reference classes) and *transfer drift* (a locked design re-created from prose at ~70%
fidelity — fixed by the mock-is-canonical discipline in `templates/fidelity-protocol.md`).

## Pick the lane (they combine)
| Lane | For | Machinery |
|---|---|---|
| **HTML mockups** | Product UI, dashboards, data-dense surfaces — anything that must transfer to code EXACTLY | Numbered self-contained `.html` files on REAL product content + the rating board (`templates/gallery-index.html`) + live playground (`templates/playground-controls.html`) |
| **Image comps** | Art direction, homepage/hero, moodboards, brand feel, logo *exploration* | The **design-mockups** skill (Nano Banana funnel, theme→variation, refs-by-number) — invoke it for this lane |
| **SVG logo board** | Converging a mark once direction is known | One HTML file: each concept is a parameterized inline-SVG function, rendered across context tiles (light/dark, sizes, in-context lockups). The winner ships as ONE canonical component — hard-coded colors, **no font dependency** (a type-set mark breaks in favicon/OG/email; draw the glyphs as geometry), exported to favicon/OG from the same SVG |

Rule of thumb: image lane to FIND a direction cheaply; HTML lane the moment the surface is a
real product UI (image comps can't be transferred exactly — HTML mockups ARE the spec).

Two more proven uses of the HTML lane beyond look-and-feel: **dataviz concept labs** (N ways to
visualize one analytical idea, interactive, on real-shaped data — InsiderIntent ran 8-concept and
2-lab explorations this way) and **strategy/positioning galleries** (N written directions side by
side for the user to pick — same board, prose instead of pixels).

**Sequencing (the expensive lesson):** run the gallery BEFORE building any real UI. InsiderIntent's
first UI was built with no gallery — a full editorial-serif pass the user rejected on sight,
redirected mid-review, and paid for twice (D-091). One gallery round costs less than one thrown-away
build round. That is why this sits at Bob Step 5.5, ahead of the first line of product code.

## The HTML-lane funnel (proven shape: ~4 rounds, 45-55 files)
1. **Round 1 — breadth.** 12-24 numbered mockups (`designs/01-….html` …), each a full page of the
   REAL product with real-shaped content (actual metrics, actual table rows, honest empty states)
   in a distinct style. Self-contained files: inline CSS, Google-Fonts links, `:root` custom
   properties for every color (this is what makes the playground and the transfer possible).
   Include the user's own past favorites and named references as styles.
2. **Rating pass.** Build the board from `templates/gallery-index.html` (edit only its CONFIG
   block): live iframe thumbnails, LIKE/MEH/NO + a note per design, localStorage persistence,
   and a "Copy my feedback" export the user pastes back. Feedback is BY NUMBER — that precision
   is what steers round two. Combinations are the norm ("panels of 12 + palette of 07").
3. **Rounds 2-3 — remix and hybridize.** Remix liked directions (light + dark reads), cross the
   liked ingredients pairwise, polish the front-runner 2-3 ways. Newest round goes at the TOP of
   the board; never remove earlier designs (the user re-sorts; a killed direction gets un-killed).
4. **Round 4 — the playground.** Take the chosen base, split BRAND accent from DATA colors
   (for any data product: accent = chrome only, R/Y/G = data only — fixes the red-means-both
   collision), and paste `templates/playground-controls.html` into a copy: swatch rows live-set
   the CSS variables so the user auditions 15 accents × 9 triads on the real design in minutes.
   One playground beats twenty static variants. "Copy palette" emits the lock string.
5. **Micro-variant rounds (when diffs get subtle).** Whole-page boards stop working once
   variants differ in one element — the user "can't tell the differences without scrolling both
   the whole way" (three comparison UIs were rejected before this one worked). Switch to the
   **feature-lab pattern**: isolate the ONE varying element, show 4-5 variants side by side,
   CROP each to the differing region, and label what differs on each. Offer options, never a
   single answer — "I like X but more Y" gets 4-5 variations of X in the same file, with the
   prior round kept visible for comparison (an under-provisioned axis takes 4 rounds instead
   of 1; a color choice once burned 4 rounds / 15+ options).
6. **LOCK.** Write `LOCKED-DESIGN.md` from `templates/LOCKED-DESIGN.template.md` — exact values
   only, opening with the mock-is-canonical banner, closing with the **pinned decisions &
   deliberate exceptions** list. **Validate the lock on the DENSEST surface first** — a look
   that sings on a hero can fail on the data-heavy report (a full style port was reverted from
   one surface but kept on another, leaving two visual languages coexisting); mock the hardest
   surface before locking globally. Set the playground's defaults to the locked choice so the
   file reopens showing the decision.

## The transfer (where it always broke — now mechanical)
Follow `templates/fidelity-protocol.md` for every build/restyle task after the lock. The five
rules, compressed: **(1)** read the mock FILE, never build from prose (delegation passes literal
values + file paths, never summaries); **(2)** mock sample content never ports as defaults or
hardcoded scales — every displayed figure traces to real data, missing series are omitted not
faked; **(3)** components built ≠ design done — count page consumption; **(4)** finish with an
adversarial diff, value-level AND a rendered screenshot of the real page vs the mock; **(5)** add
the CI token gate (off-lock radii + raw palette literals fail the build) and rewrite stale design
self-descriptions (a "clean modern fintech, white" comment surviving a dark Swiss lock is a
counterfeit spec that mis-briefs every future session).

## Hard-won heuristics
- **Real content beats lorem.** Mockups carrying the product's true numbers, table rows, and
  edge states get decisive feedback; pretty-but-empty comps get "looks nice."
- **Tokenize from mockup one.** Every color through `:root` variables — playgrounds, palette
  swaps, and the eventual token transfer all fall out of this one discipline.
- **Separate brand from data color early** (data products). The accent-vs-signal split was the
  single highest-leverage design decision of the InsiderIntent arc.
- **Numbers are the shared vocabulary.** Files, board cards, and feedback all speak "#45";
  curation sections cite prior numbers ("like #117"); image-lane refs resolve from them.
- **Keep everything on the board.** Curate by reordering/starring, never by deleting.
- **A live parameter playground is the convergence accelerator** — build it as soon as the
  structural base is chosen; palette/type/radius decisions collapse from rounds into minutes.
- **The lock is values, not vibes.** "Clean grotesk, ~8-10px, font TBD" produced the 70% drift;
  "Archivo 700/800/900, panels 3px, tags 2px, NOT rounded-full" produced an exact product.
- **The loop shape: one big autonomous pass, then the user picks from boards.** Not
  surgical-note ping-pong — do a full pass, render every ambiguous axis as an inline
  mini-gallery of 3-4 options, and let the user scroll once and answer "badge B, pill B, nav A"
  (the user's own redirect of a drifting iteration loop).
- **Codify rejections as standing hard rules.** "No offset block shadows", "priority is the
  PILL, not a colored edge", "mono font banned in report UI" — each user rejection becomes a
  written rule in the lock doc, or it WILL be re-tried by a later session (each of these was).
- **Logos: generate wide in the image lane, converge in code.** The SVG board renders every
  candidate at favicon size and on dark BEFORE choosing; the shipped mark is one component with
  hard-coded colors (a mark that re-tokenizes per theme stops being a mark).

## Files
- `templates/gallery-index.html` — the rating board (edit the CONFIG block only)
- `templates/playground-controls.html` — the live-parameter bar (paste into a mockup copy)
- `templates/LOCKED-DESIGN.template.md` — the lock doc
- `templates/fidelity-protocol.md` — the transfer discipline + CI gate snippet + checklist
- Image lane: `skills/design-mockups/` (own SKILL.md; includes `references/build-bridge.md`
  for the comp→code handoff, motion stack, and DESIGN.md spec layer)

## Bob the Builder integration
This is **Step 5.5 (Design Gallery & Lock)** in NEW mode — after the Build Manifest, before the
Pre-Build Review Gate — for any product with a user-facing surface. The lock artifacts
(`design-gallery/` + `LOCKED-DESIGN.md`) enter the doc set the 6.5a machine audit reviews, and
the fidelity protocol governs every visual build phase after it. In EVOLVE mode, run the funnel
standalone for a redesign, then re-enter at the transfer step. (Kept as a skill folder so the
machinery versions with Bob itself.)
