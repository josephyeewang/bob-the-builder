---
name: design-mockups
description: "Generate award-caliber website/homepage design mockups for any project by exploring the design space as IMAGES (Google Nano Banana Pro / Gemini 3 Pro Image), fast and cheap, then narrowing via a theme→variation funnel to a locked direction — before any code is written. Use when the user wants to explore visual directions / art direction for a landing page or homepage, generate many design concepts, build a style gallery, or pick a look before building. Includes a 74-archetype style library, a config-driven batch generator, motion previews (Veo), and consolidated searchable galleries. Pairs with Bob the Builder's design phase."
user-invocable: true
---

# design-mockups — explore the design space as images, then build the winner

A reusable workflow for exploring homepage directions as images, comparing them in a numbered
gallery, and carrying a selected direction into implementation.

## The one principle
**Generic is a workflow problem, not a model problem. Explore as IMAGES (art direction), build as CODE (correct, data-wired, motion).** Never ask one tool to do both — that's what produces "AI slop." Image models originate art (texture, palette, type, mood, concept) that CSS can't; code originates correctness that images can't.

## Standalone execution

When invoked to explore designs, create the requested jobs, run approved generation or gallery
commands and inspect their outputs; do not only describe the funnel. Keep project configuration
and output in the target project, never in this installed module. Confirm scope and budget before
paid generation, and do not upload confidential references without permission. If generation is
unavailable, organize supplied images and state the limitation.

This module works without Bob or a particular assistant. Resolve this SKILL.md folder and set
DESIGN_MOCKUPS_DIR to that absolute path for the examples. See DEPENDENCIES.md for local tools,
provider boundaries and optional companions. Design Gallery is useful for reference discovery and
code transfer but is not required to generate or organize images.

## Setup (one time)
0. **Python 3 with Pillow.** Use the project's Python environment, or create a virtual environment and install Pillow there. Local gallery commands need no provider account or generation credits.
1. **Only for generated images/video:** a Google AI Studio account and approved credential/billing setup for the configured model. Check current availability and pricing before proposing a budget; existing-image gallery commands remain local.
2. Use the user's approved secret-setup process. The runtime accepts the variable named by `api_key_env`, or an optional user-managed `api_key_file`. Never read, echo, commit or include secret values in a download.
3. The supplied configuration and feedback examples are fictional illustrations. Copy `config.example.json` into the target project as `mockup.config.json`; fill in product_name, product_desc, headline, data_points and content_recipe. Set out_dir inside that project. Prefer the configured environment variable; use api_key_file only if the user chose that runtime method. Keep local configuration out of public exports.

## Usage (from the project dir, or set DESIGN_MOCKUP_CONFIG)
```
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" archetypes [core|cinematic|modern|all]  # 1 comp per style
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" recipe        # your content_recipe across the 12 art-direction STYLES
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" custom jobs.json [round]  # [{name,prompt,refs?}] — refs = paths OR gallery NUMBERS (117)
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" gallery       # rebuild the consolidated searchable gallery of out_dir
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" grouped [out_dir]           # auto-sectioned board (13 style buckets)
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" curated curation.json [out_dir]  # user's themes on top (★ green), remainder always appended
python3 "$DESIGN_MOCKUPS_DIR/mockup.py" reject 23 45 old-name       # prune: MOVE to out/_deleted — never delete, numbering pool shrinks
```
Every run also writes `_contact.png` + `gallery-ALL.html` (one searchable, NUMBERED board), and — when the batch has a round name — a per-round `{round}-sheet.png` + `{round}-gallery.html` pair. **Gallery numbers are the shared vocabulary**: they're stable (one canonical numbering in `lib/gallery.py`), the user gives feedback by number ("#117 but lighter"), curation section titles cite them ("like #117"), and `refs` resolve from them. curation.json: `[{"title":"THEME 1 — report hero (like #117)","nums":[117,94],"star":true}, ...]`.

## The funnel (how to run a real engagement)
1. **Map the space** — `archetypes all` (74 comps) → one consolidated gallery. Let the user react by name.
2. **Theme → variation** — pick ~12 themes, generate 3 variations each (grouped by theme); user picks ~5 themes; regenerate 5 variations each. (Use `custom` with grouped job lists.)
3. **Lock content, vary style** — once content converges, fix the `content_recipe` and run `recipe` to compare the SAME content across the 12 STYLES.
4. **Feed liked frames back as refs** — the single most reliable taste-lock: pass the user's favorite output PNGs as `refs` so the model style-transfers from them.
4b. **Winners round** — once the user has reacted BY NUMBER on the grouped/curated board, run permutations of each liked theme with per-theme refs by gallery number (`"refs":[94,36,2]` for theme 1, `[73,74,78]` for theme 2, …) via `custom`; then `curated` puts their themes on top with the remainder below.
5. **Motion previews** — `lib/vid.py` turns a chosen comp into a short Veo clip (image→video) to preview the motion feel before building.
6. **Build the winner** — hand the winning comp (the canonical input) + its `LOCKED-DESIGN.md` map (`references/build-bridge.md` §1) to a coding agent; reuse the 4K backdrop as a real asset; implement motion with GSAP + Lenis + Motion.dev. Full bridge (spec layer, motion-stack table, honest limits): `references/build-bridge.md`.

## Working heuristics
- **Reference-class anchoring decides the cluster.** Naming Linear/Stripe/SaaS → generic boilerplate. Naming "luxury" → spa/interior stock. Naming A24 / Obys / fashion-campaign / gallery / fine-art → cinematic art direction. Name the *right* reference class in the prompt. For a homepage/hero, use supplied references first. If Design Gallery and approved reference tools are available, use its Round 0 (`references/inspo-round-zero.md` in that module) and pass LIKEd screenshots as refs. Otherwise collect approved public references with available tools or state the omission; do not assume a sibling directory or connected service.
- **Two independent axes — never collapse them:** CONTENT (what's in the hero) × ART-DIRECTION (how it looks). Cross them in a matrix; hold one constant and vary the other.
- **Theme-first, not image-first.** Decisions are easier as "which of 12 themes" than "which of 100 images." Group variations under their theme.
- **The hero must embody the value proposition.** Show the product doing its job, with enough context to explain why its output matters; a decorative score alone may not communicate that.
- **Materiality beats flat color** (texture/grain/gradient/imagery, never flat divs). **Ban AI-default fonts** (Inter, Roboto, Arial, Space Grotesk) and clichés (purple gradient on white, centered-hero + 3 cards).
- **People, if any, should be genuinely USING the product** (candid interaction), not fashion-posing.
- **One consolidated, NAMED gallery** so feedback is precise ("the panels of X + the palette of Y + the type of Z").
- **Expect iteration.** Don't chase "this is it" early; the user finds combinations by sorting. Never silently drop a direction they liked — keep everything in the board.
- **State positive and negative constraints.** Describe what the direction must express and the clichés it must avoid; use the current project brief rather than a previous product's taste decisions.
- **The hero panel must explain, not just display.** Show relationships, context and next actions where relevant; use clearly fictional example figures until real data is intentionally wired.
- **Refine intensity through comparisons.** If an expressive direction is too loud, compare restrained variants while keeping the chosen structure visible.
- **Prune per project with `reject`.** Move rejected renders to `_deleted` rather than erasing them, and rebuild the board before citing its updated numbering.
- **Only headline text is legible** in image comps; body copy renders as gibberish — judge layout/mood, not paragraphs. Comps are direction, not a spec.
- **Ops:** batch with backoff/retry (429/5xx); "prepayment credits depleted" = top up billing, not a bug.

## Files
- `mockup.py` — CLI. `lib/gen.py` — config-driven generator (refs accept gallery numbers). `lib/archetypes.py` — 44 core + 16 cinematic + 14 modern archetypes + 12 art-direction STYLES. `lib/gallery.py` — numbering SSOT + contact sheets + consolidated/grouped/curated boards + per-round boards. `lib/vid.py` — Veo motion previews. `config.example.json` — per-project config template. `references/build-bridge.md` — DESIGN.md spec layer, motion stack, comp→code bridge, honest limits.

## Bob the Builder integration
Use inside Bob's **design phase** (before the Pre-Build Review Gate): after the spec, run this capability to explore and lock the homepage/landing direction, then carry the winning comp into the build. Invoke `/design-mockups` or run the CLI from the target project dir. (Kept as a standalone skill so it never dirties the Bob repo's auto-updater.)
