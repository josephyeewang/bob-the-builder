# PAGE — Art-direction brief (one page; required input to Round 0)

> Write this WITH the user before any reference pull or mockup, one brief per page or surface.
> Round 0 (`references/inspo-round-zero.md`) searches from it, every mockup is judged against it,
> and the screenshot gate (`references/screenshot-gate.md`) fails a page that breaks it.
> Telling a model "make it not generic" does not work; naming the exact patterns to avoid does.

## 1. Who is looking
<!-- ONE concrete sentence: who, on what device, where, in what mood, wanting what.
     e.g. "A tired first-time visitor on a phone in the evening, deciding in ten seconds whether this is worth trusting." -->

## 2. References (5–8, rated LIKE by the user)
<!-- Each row: what to TAKE (type scale, spacing rhythm, section order, one motion move) and what NOT
     to take (its colours, its logo-like devices, its copy voice). At least ONE must come from outside
     websites: a film, a magazine, a book cover, a building, a poster, packaging. -->
| # | Reference (link or file) | Take | Don't take |
|---|---|---|---|
| R01 | | | |
| R02 | | | |
| R03 | | | |
| R04 | | | |
| R05 (non-web) | | | |

## 3. Banned patterns
**Standard tells** (on by default; strike one only with a written reason):
- Centred hero headline + three feature cards underneath
- Purple-to-blue (or any default "AI") gradient
- Identical rounded cards in an even grid
- Emoji used as icons
- A default UI font chosen by habit (Inter and its look-alikes) rather than by the brief
- The same fade-up entrance on every section
- Decorative frosted glass
- Gradient-filled text
- Template chrome used without reason: capital "eyebrow" labels over every heading, numbered
  kickers ("01 / 02"), arrows on every link, "A · B · C" lists
- A popular animated component library's signature effect as the page's visible signature
  (glowing beams, tilt cards, marquee logos) — see SKILL.md "Working heuristics"

**This project's own** (patterns the user has rejected, or tells this product's current look already carries):
- …

## 4. The signature idea (ONE per page)
<!-- One sentence. Test: could it sit unchanged on any other company's site? If yes, it is not a
     signature — rewrite it until it could only belong here. -->
- Signature: …
- Other-site test passed because: …

## 5. Motion
- **Path:** code-generated motion (default — the agent writes scroll scenes, timelines, SVG/canvas,
  shaders, CSS scroll-driven animation) ☐ · generated image/video sequence for shot(s) ___ only,
  because they need photographic material code cannot draw ☐
- **Moves allowed on this page** (pick 2–4 from the vocabulary in `../references/motion-mockup-lane.md`): …
- **Engine for the mockups:** GSAP + ScrollTrigger ☐ Motion ☐ Lenis ☐ CSS scroll-driven ☐
  three.js / shader ☐ (the production engine is chosen after the pick)

## 6. Budgets
- **Performance:** main content painted within ___ s on a throttled phone profile (default 2.5 s);
  page weight under ___ KB on first load; heavy motion loads after first paint.
- **Phone:** what the phone version does differently (composed, not shrunk): …
- **Reduced motion:** what replaces each moving moment (a still, an ordered list, a cut): …

## 7. Rule order and visual language
- **Precedence:** the LOCK (once it exists) > this brief > any taste skill or style catalogue.
  When installed design skills disagree (for example one requires a layered hero, another allows
  a flat one), this brief decides, and the lock decides over the brief. Taste skills are inputs
  to the brief, not rivals to it.
- **Does this marketing page share the product's visual language?** ☐ Yes (default) — same
  palette, type and components; the signature idea lives in motion and type, not in a separate
  brand ☐ No — how far it may diverge, and why: …
  A project document describing the product's own register ("preserve the established design")
  must not silently decide this for a marketing page; this line states the answer.
