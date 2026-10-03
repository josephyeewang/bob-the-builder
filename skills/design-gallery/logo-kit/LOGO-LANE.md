# Logo lane — process, checks and scripts

The full procedure for the **SVG logo board** lane. Harvested 2026-10-03 from
[kaankiziltug/logo-design-skill](https://github.com/kaankiziltug/logo-design-skill) @ `0ecf52e` (v1.4.4, MIT —
see `LICENSE` in this folder). Taken: the phase discipline, the concept checkpoint, red flags, craft pass, testing
checklist, discovery brief, SVG construction notes, and five dependency-free scripts. **Not taken:** its 1,432-logo
reference library (other companies' trademarks; MIT does not cover them), the library search/catalog scripts, the
heavy presentation-board generator, and the HTML preview sheet (the gallery's own SVG board does that job).
`assets/library/stats.json` is kept — aggregate complexity numbers only, no logos — so `svg_audit.py` can flag an
over-complex mark.

All scripts are plain Python 3, no installs. Rendering uses whatever is present (cairosvg, rsvg-convert, Inkscape,
headless Chrome, or macOS Quick Look). Paths below are relative to this `logo-kit/` folder.

## Where it sits in the gallery

**Generate wide in the image lane, converge in code** (unchanged). Image comps (design-mockups) explore feel;
this lane builds 3 real vector concepts, proves them, and ships one mark. The winner still becomes ONE canonical
component with hard-coded colours and no font dependency.

## Phases

1. **Brief.** Name (exact spelling), what it does, audience, 3–5 adjectives, competitors, where it must work.
   Fast track: ≤5 questions in one message (`references/discovery-brief.md` §2), or state assumptions and go.
2. **Research.** Collect competitor marks; list the category's **clichés** explicitly (fintech: blue, upward
   arrows, shields, globes) — off-limits unless given a genuinely fresh form. Word map (`discovery-brief.md` §6).
3. **Concepts.** 8–12 one-sentence ideas across at least two mark types (wordmark, monogram, symbol, combination…).
   Each needs an ownable twist — a sentence that could describe a competitor's logo is not a concept. Build only
   the **three strongest and most different**.
4. **Build in SVG, black first.** Describe the construction in words, then write it (`references/svg-construction.md`).
   `viewBox="0 0 256 256"` for symbols; lockups keep height 256. Exact angles, consistent strokes, real holes for
   negative space. **No live `<text>` in a finished mark.** Save every iteration (`-v1`, `-v2`), never overwrite.
5. **Test and refine — at least two loops.**
   ```bash
   python3 scripts/svg_audit.py a.svg b.svg c.svg
   python3 scripts/render_png.py a.svg b.svg c.svg --out-dir renders --size 512   # then LOOK at the PNGs
   ```
   Drawing in SVG code is drawing blind — always render and look. Then the **craft pass** (where AI-drawn marks
   fall short): (1) *letter test* — every modified letter still reads as itself at a glance; (2) *junctions* — no
   notches, slivers or lumps where strokes meet; (3) *peer test* — beside 3–4 well-regarded marks at the same
   size, it looks equally resolved; (4) *literalness* — a cup for coffee is not a concept. Full list:
   `references/testing-checklist.md`. The audit catches structure (live text, near-miss angles, tiny details);
   it does **not** catch ugly geometry — that is the render-and-look step's job.
6. **Show the concepts, then STOP.**
   ```bash
   python3 scripts/concept_sheet.py a.svg b.svg c.svg --lockups a-lockup.svg b-lockup.svg c-lockup.svg \
     --names "A" "B" "C" --notes "one-line idea A" "…" "…" --recommend 1 --greyscale -o concepts.png
   ```
   Greyscale first (colour starts taste debates). Show the image, one line per concept, a recommendation with one
   honest risk each, then offer the kit and **wait**. Build nothing else until the user picks a direction.
7. **Kit (only after a yes).** Final geometry + optical corrections + a simplified small-size cut; 1–2 colours that
   still work in one colour and reversed; lockups (horizontal, stacked, symbol-only); then export:
   ```bash
   python3 scripts/export_variants.py final-symbol.svg --title "Brand logo" --mono "#HEX" --icon-bg "#HEX" \
     --web-icons --favicon-source final-symbol-small.svg      # favicon.ico, PNG icon set, webmanifest, <head> snippet
   python3 scripts/export_variants.py final-horizontal.svg --title "Brand logo" --only black white mono --mono "#HEX" --png 1200
   ```
   Record the locked mark in the gallery's `LOCKED-DESIGN` doc like any other lock.

## Red flags — fix before showing anything

- Clip-art literalism or a category cliché with no twist.
- Initials in an unmodified stock font; a default geometric sans with nothing ownable.
- More than three colours without a reason; gradients or shadows rescuing a weak form.
- Details smaller than ~1/48 of the mark, hairlines, gaps that close at small sizes.
- Near-miss angles, lumpy curves from too many points, inconsistent stroke weights.
- Live `<text>`, embedded images, filters or masks in a "final" file.
- A concept that needs a paragraph to understand.
- Anything that looks like an existing logo.

## Honesty

Say it plainly to the user: no trademark clearance is implied (recommend a trademark-database and reverse-image
search before launch); font licences must allow logo use; and never claim a test that wasn't run or a render that
wasn't looked at.
