---
name: design-gallery
description: "The design-gallery machinery: explore a product's look-and-feel as a rated gallery of mockups, converge through rounds to a LOCKED design, then transfer it into the real product EXACTLY (no re-creation-from-description drift). Four lanes: HTML mockups for product UI/dashboards where exactness must survive the transfer to code; AI-image comps (via the design-mockups skill) for art direction, heroes, moodboards, brand; code-drawn SVG concept boards for logos/marks; a landing-page scroll-story lane (via the scroll-craft plugin) for marketing pages where scroll is the storytelling device. Includes the agent/chat-surface primitives checklist. Use when the user wants to explore visual directions for a dashboard/app/website, run a design gallery, audition palettes/parameters live, lock a design, or push a locked design through to the real product. Bob Step 5.5."
user-invocable: true
---

# design-gallery — explore as a gallery, lock exactly, transfer exactly

Reusable machinery for **breadth → feedback-by-number → remix rounds → live playground → LOCK
→ exact transfer**. Explore distinct directions with representative content, then prevent transfer
drift by treating the winning mock file as canonical (`templates/fidelity-protocol.md`).

## Standalone execution

When invoked to create or refine designs, create the requested gallery and inspect its outputs;
do not only narrate these steps. Keep generated designs, feedback and locks in the target project,
never in the installed skill. Pause at the explicit pick/lock checkpoints and respect the user's
rules for publishing, external services and paid work.

This module works without Bob or a particular assistant. Resolve resources relative to this
SKILL.md. Set DESIGN_GALLERY_DIR to that resolved absolute folder for the command examples;
never assume an assistant-specific home path. See DEPENDENCIES.md for tools and optional lanes.

## Pick the lane (they combine)
| Lane | For | Machinery |
|---|---|---|
| **HTML mockups** | Product UI, dashboards, data-dense surfaces — anything that must transfer to code EXACTLY | Numbered self-contained `.html` files on REAL product content + the rating board (`templates/gallery-index.html`) + live playground (`templates/playground-controls.html`) |
| **Image comps** | Art direction, homepage/hero, moodboards, brand feel, logo *exploration* | The optional **design-mockups** module (theme→variation, refs-by-number), or a user-approved image tool; if unavailable, use supplied images or continue in HTML and state the omitted generation |
| **SVG logo board** | Converging a mark once direction is known | One HTML file: each concept is a parameterized inline-SVG function, rendered across context tiles (light/dark, sizes, in-context lockups). The winner ships as ONE canonical component — hard-coded colors, **no font dependency** (a type-set mark breaks in favicon/OG/email; draw the glyphs as geometry), exported to favicon/OG from the same SVG. **Full procedure + scripts: `logo-kit/LOGO-LANE.md`** — brief → 8–12 one-line concepts → build 3 in SVG black-first → audit + render-and-look loop → concept sheet, then STOP for a pick → kit (favicon/app-icon/web-icon set, mono/reversed variants) |
| **Scroll story** | Marketing pages ONLY (homepage, launch page, a personal site) where the visitor's scroll tells the story — feeling curve, page grammar, scroll devices, one signature move, scroll QA | The optional **scroll-craft** plugin, run AFTER the lock, with project-specific integration guidance in `references/scroll-story-lane.md` |

Rule of thumb: image lane to FIND a direction cheaply; HTML lane the moment the surface is a
real product UI (image comps can't be transferred exactly — HTML mockups ARE the spec).
Scroll-story lane only for a marketing page, only after its lock exists — it originates design
and must never redefine tokens. Agent/chat surfaces: walk `references/agent-ui-primitives.md`
before mocking so every state (thinking, streaming, awaiting approval, failed) is on the board.

The HTML lane also supports dataviz concept labs (several visualizations of one analytical idea)
and strategy/positioning galleries (written directions side by side). Use fictional or approved
content and label illustrative figures.

Run the gallery before building production UI so the user can choose a direction before the
implementation depends on it. In Bob this is Step 5.5; the same ordering works independently.

## The HTML-lane funnel (adapt round sizes to the brief and budget)
0. **Round 0 — real reference sites (DEFAULT, don't ask).** For any website/marketing page
   (and, smaller, for dashboards), pull ~10 real shipped sites that fit the brief from **Inspo**
   (`inspo` MCP server — search, never `recommend`; trust its fonts/sizes/spacing, never its
   colours), rate them by number, then build half of Round 1 from the LIKEd sites' real type and
   spacing. Skip for confidential work without an approved data route, or if the tools are missing — say so in one line. Full
   procedure, skip rules and the self-scoring trial: `references/inspo-round-zero.md`.
1. **Round 1 — breadth.** 12-24 numbered mockups (`designs/01-….html` …), each a full page of the
   REAL product with real-shaped content (actual metrics, actual table rows, honest empty states)
   in a distinct style. Self-contained files: inline CSS, Google-Fonts links, `:root` custom
   properties for every color (this is what makes the playground and the transfer possible).
   Include the user's own past favorites, named references, and the Round 0 LIKEs as styles.
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
5. **Micro-variant rounds (when diffs get subtle).** Switch from full-page boards to a
   feature lab: isolate the varying element, crop to its region, show several alternatives side
   by side and label the differences. Keep previous candidates visible for comparison. Let the
   user combine preferred ingredients rather than asking them to remember separate pages.
6. **LOCK.** Write `LOCKED-DESIGN.md` from `templates/LOCKED-DESIGN.template.md` — exact values
   only, opening with the mock-is-canonical banner, closing with the **pinned decisions &
   deliberate exceptions** list. **Validate the lock on the DENSEST surface first** — a look
   that works on a hero may fail on a dense report. Mock the hardest surface before locking globally. Set the playground's defaults to the locked choice so the
   file reopens showing the decision.

## The transfer (make the transfer mechanical)
Follow `templates/fidelity-protocol.md` for every build/restyle task after the lock. The five
rules, compressed: **(1)** read the mock FILE, never build from prose (delegation passes literal
values + file paths, never summaries); **(2)** mock sample content never ports as defaults or
hardcoded scales — every displayed figure traces to real data, missing series are omitted not
faked; **(3)** components built ≠ design done — count page consumption; **(4)** finish with an
adversarial diff, value-level AND a rendered screenshot of the real page vs the mock; **(5)** add
the CI token gate (off-lock radii + raw palette literals fail the build) and rewrite stale design
self-descriptions (a "clean modern fintech, white" comment surviving a dark Swiss lock is a
counterfeit spec that mis-briefs every future session).

## Working heuristics
- **Real content beats lorem.** Mockups carrying the product's true numbers, table rows, and
  edge states get decisive feedback; pretty-but-empty comps get "looks nice."
- **Tokenize from mockup one.** Every color through `:root` variables — playgrounds, palette
  swaps, and the eventual token transfer all fall out of this one discipline.
- **Separate brand from data color early** (data products). The accent-vs-signal split keeps
  brand decoration distinct from the meaning of a result.
- **Numbers are the shared vocabulary.** Files, board cards, and feedback all speak "#45";
  curation sections cite prior numbers ("like #117"); image-lane refs resolve from them.
- **Keep everything on the board.** Curate by reordering/starring, never by deleting.
- **A live parameter playground is the convergence accelerator** — build it as soon as the
  structural base is chosen; palette/type/radius decisions collapse from rounds into minutes.
- **The lock is values, not vibes.** Record actual type families, weights, spacing and radii
  from the selected mock. A range or an unresolved font choice is not a finished lock.
- **Offer comparisons at the right scale.** Render ambiguous choices as a small inline gallery
  and let the user select or combine them before another production change.
- **Codify rejections as standing project rules.** Keep the user's approved constraints in the
  project's lock so later iterations do not silently reopen settled decisions.
- **Logos: generate wide in the image lane, converge in code.** The SVG board renders every
  candidate at favicon size and on dark BEFORE choosing, and no mark is done until
  `logo-kit/scripts/preview_sheet.py` has been run and looked at (one-colour, reversed, app icon,
  16–32 px — see LOGO-LANE step 5); the shipped mark is one component with
  hard-coded colors (a mark that re-tokenizes per theme stops being a mark).

## Files
- `templates/gallery-index.html` — the rating board (edit the CONFIG block only)
- `templates/playground-controls.html` — the live-parameter bar (paste into a mockup copy)
- `templates/LOCKED-DESIGN.template.md` — the lock doc
- `templates/fidelity-protocol.md` — the transfer discipline + CI gate snippet + checklist
- `references/scroll-story-lane.md` — lane 4: when to use scroll-craft, how it sequences with
  the lock, optional asset/motion integrations (design-mockups when available, hero preference optional)
- `references/inspo-round-zero.md` — Round 0: real reference sites from Inspo (default for every
  website gallery), skip rules, and the trial; results logged in the project's `docs/design/inspo-trial-log.md` (header: `references/inspo-trial-log.md`)
- `references/agent-ui-primitives.md` — the 24-piece checklist for agent/chat surfaces (from
  beautiful-ui); mock every state, re-tokenize before shipping
- `logo-kit/LOGO-LANE.md` — lane 3 procedure: phases, concept checkpoint, craft pass, red flags;
  `logo-kit/scripts/` (svg_audit, render_png, concept_sheet, preview_sheet, export_variants — plain
  Python, no installs); `logo-kit/references/critique.md` (logo scorecard); `logo-kit/tests/` (two
  self-tests); harvested from kaankiziltug/logo-design-skill (MIT, `logo-kit/LICENSE`)
- Optional image lane: the separately installed `design-mockups` module (own SKILL.md; includes `references/build-bridge.md`
  for the comp→code handoff, motion stack, and DESIGN.md spec layer)

## Bob the Builder integration
This is **Step 5.5 (Design Gallery & Lock)** in NEW mode — after the Build Manifest, before the
Pre-Build Review Gate — for any product with a user-facing surface. The lock artifacts
(`design-gallery/` + `LOCKED-DESIGN.md`) enter the doc set the 6.5a machine audit reviews, and
the fidelity protocol governs every visual build phase after it. In EVOLVE mode, run the funnel
standalone for a redesign, then re-enter at the transfer step. (Kept as a skill folder so the
machinery versions with Bob itself.)
