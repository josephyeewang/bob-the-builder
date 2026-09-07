---
name: design-mockups
description: "Generate award-caliber website/homepage design mockups for any project by exploring the design space as IMAGES (Google Nano Banana Pro / Gemini 3 Pro Image), fast and cheap, then narrowing via a theme→variation funnel to a locked direction — before any code is written. Use when the user wants to explore visual directions / art direction for a landing page or homepage, generate many design concepts, build a style gallery, or pick a look before building. Includes a 74-archetype style library, a config-driven batch generator, motion previews (Veo), and consolidated searchable galleries. Pairs with Bob the Builder's design phase."
user-invocable: true
---

# design-mockups — explore the design space as images, then build the winner

A reusable capability for producing Awwwards / One-Page-Love-caliber homepage directions for ANY product. Proven on Explain My Blood Test (Aug 2026): ~250 comps across the full design space for ~$15, funneled to a locked direction.

## The one principle
**Generic is a workflow problem, not a model problem. Explore as IMAGES (cheap, fast, artful), build as CODE (correct, data-wired, motion).** Never ask one tool to do both — that's what produces "AI slop." Image models originate art (texture, palette, type, mood, concept) that CSS can't; code originates correctness that images can't.

## Setup (one time)
1. **Google AI Studio API key** with **billing/prepay enabled** (image gen is a paid feature; Nano Banana Pro ≈ $0.13/image, so a 40-comp sweep ≈ $5). Get it at aistudio.google.com/apikey → add credits.
2. Put the key in an env-style file (e.g. a project `.env.local`) as `GOOGLE_AI_API_KEY=...` (the toolkit reads it without printing it).
3. Copy `config.example.json` → your project as `mockup.config.json`; fill in product_name, product_desc, headline, data_points, content_recipe, and point `api_key_file` at your key file. Set `out_dir`.

## Usage (from the project dir, or set DESIGN_MOCKUP_CONFIG)
```
python ~/.claude/skills/design-mockups/mockup.py archetypes [core|cinematic|modern|all]  # 1 comp per style
python ~/.claude/skills/design-mockups/mockup.py recipe        # your content_recipe across the 12 art-direction STYLES
python ~/.claude/skills/design-mockups/mockup.py custom jobs.json [round]  # [{name,prompt,refs?}] — refs = paths OR gallery NUMBERS (117)
python ~/.claude/skills/design-mockups/mockup.py gallery       # rebuild the consolidated searchable gallery of out_dir
python ~/.claude/skills/design-mockups/mockup.py grouped [out_dir]           # auto-sectioned board (13 style buckets)
python ~/.claude/skills/design-mockups/mockup.py curated curation.json [out_dir]  # user's themes on top (★ green), remainder always appended
python ~/.claude/skills/design-mockups/mockup.py reject 23 45 old-name       # prune: MOVE to out/_deleted — never delete, numbering pool shrinks
```
Every run also writes `_contact.png` + `gallery-ALL.html` (one searchable, NUMBERED board), and — when the batch has a round name — a per-round `{round}-sheet.png` + `{round}-gallery.html` pair. **Gallery numbers are the shared vocabulary**: they're stable (one canonical numbering in `lib/gallery.py`), the user gives feedback by number ("#117 but lighter"), curation section titles cite them ("like #117"), and `refs` resolve from them. curation.json: `[{"title":"THEME 1 — report hero (like #117)","nums":[117,94],"star":true}, ...]`.

## The funnel (how to run a real engagement)
1. **Map the space** — `archetypes all` (74 comps) → one consolidated gallery. Let the user react by name.
2. **Theme → variation** — pick ~12 themes, generate 3 variations each (grouped by theme); user picks ~5 themes; regenerate 5 variations each. (Use `custom` with grouped job lists.)
3. **Lock content, vary style** — once content converges, fix the `content_recipe` and run `recipe` to compare the SAME content across the 12 STYLES.
4. **Feed liked frames back as refs** — the single most reliable taste-lock: pass the user's favorite output PNGs as `refs` so the model style-transfers from them.
4b. **Winners round** — once the user has reacted BY NUMBER on the grouped/curated board, run permutations of each liked theme with per-theme refs by gallery number (`"refs":[94,36,2]` for theme 1, `[73,74,78]` for theme 2, …) via `custom`; then `curated` puts their themes on top with the remainder below.
5. **Motion previews** — `lib/vid.py` turns a chosen comp into a short Veo clip (image→video) to preview the motion feel before building.
6. **Build the winner** — hand the winning comp + a DESIGN.md to a coding agent; reuse the 4K backdrop as a real asset; implement motion with GSAP + Lenis + Motion.dev. Full bridge (spec layer, motion-stack table, honest limits): `references/build-bridge.md`.

## Hard-won heuristics (the real IP — apply every time)
- **Reference-class anchoring decides the cluster.** Naming Linear/Stripe/SaaS → generic boilerplate. Naming "luxury" → spa/interior stock. Naming A24 / Obys / fashion-campaign / gallery / fine-art → cinematic art direction. Name the *right* reference class in the prompt.
- **Two independent axes — never collapse them:** CONTENT (what's in the hero) × ART-DIRECTION (how it looks). Cross them in a matrix; hold one constant and vary the other.
- **Theme-first, not image-first.** Decisions are easier as "which of 12 themes" than "which of 100 images." Group variations under their theme.
- **The hero must EMBODY the value prop, not just brand it.** (EMBT: a lone "74/100" score argued *against* the product — the fix was showing R/Y/G status, flags, trend graphs, range bars, insight lines. The hero should demonstrate what's unique.)
- **Materiality beats flat color** (texture/grain/gradient/imagery, never flat divs). **Ban AI-default fonts** (Inter, Roboto, Arial, Space Grotesk) and clichés (purple gradient on white, centered-hero + 3 cards).
- **People, if any, should be genuinely USING the product** (candid interaction), not fashion-posing.
- **One consolidated, NAMED gallery** so feedback is precise ("the panels of X + the palette of Y + the type of Z").
- **Expect iteration.** Don't chase "this is it" early; the user finds combinations by sorting. Never silently drop a direction they liked — keep everything in the board.
- **Negative-constraint vocabulary works** (EMBT redesign, Sep 2026): state what it must be AND what it must never be — "LIGHT and TRUSTWORTHY — never a dark cave", "NOT a generic gray gradient, NOT homey/architectural-digest stock". The NOTs steer as hard as the wants.
- **The hero panel must EXPLAIN, not just display** — "colorful glass metric panels POP OUT (status ring, spectrum bar, trend chart, flagged chips)... NOT just a lone number." A number alone argues against the product.
- **Overshoot-recover is one round, expect it** — "colorful popping panels" overshoots into candy within a round; the documented correction: "COLOR IS A RESTRAINED, TASTEFUL ACCENT... NOT bright primary red/yellow/green, NOT rainbow, NOT candy." Ask loud, then rein in.
- **Prune loud/kitsch archetypes per-project via `reject`** (moved to `_deleted`, never erased — the EMBT blocklist: neo-brutalism, y2k-chrome, vaporwave, synthwave, cyberpunk-neon, memphis-80s, corporate-memphis, claymorphism).
- **Only headline text is legible** in image comps; body copy renders as gibberish — judge layout/mood, not paragraphs. Comps are direction, not a spec.
- **Ops:** batch with backoff/retry (429/5xx); "prepayment credits depleted" = top up billing, not a bug.

## Files
- `mockup.py` — CLI. `lib/gen.py` — config-driven generator (refs accept gallery numbers). `lib/archetypes.py` — 44 core + 16 cinematic + 14 modern archetypes + 12 art-direction STYLES. `lib/gallery.py` — numbering SSOT + contact sheets + consolidated/grouped/curated boards + per-round boards. `lib/vid.py` — Veo motion previews. `config.example.json` — per-project config template. `references/build-bridge.md` — DESIGN.md spec layer, motion stack, comp→code bridge, honest limits.

## Bob the Builder integration
Use inside Bob's **design phase** (before the Pre-Build Review Gate): after the spec, run this capability to explore and lock the homepage/landing direction, then carry the winning comp into the build. Invoke `/design-mockups` or run the CLI from the target project dir. (Kept as a standalone skill so it never dirties the Bob repo's auto-updater.)
