# Lane 5 — Motion mockups (moving, scroll-driven directions BEFORE a lock)

**What this lane is for.** Exploring directions where movement IS the design: cinematic
scroll journeys, camera zooms between scenes, ambient background motion, a guided visual tour
through a product's results. A still frame cannot be judged for these, so each gallery entry is
a small working page the user scrolls. Unlike the scroll-story lane, this lane runs **before**
the lock and may be used for **product surfaces** (for example a results walkthrough behind
login), not only marketing pages.

**What it deliberately does not decide.** The production stack. A motion mockup is a standalone
HTML file that loads its animation libraries from a CDN. Nothing is added to the product's
dependencies, and the mockup's library choice does not bind the build. Choosing the production
engine is a separate step after a direction is picked.

## How an entry is made

1. **Write a shot list first** (`shots.json` beside the mockup): one entry per scene with its
   purpose, the feeling it should produce, the scroll device (scrub / pin / zoom / reveal /
   count / parallax / drift), start and end composition, on-screen copy, and the asset it needs.
   The shot list is the unit of feedback and of later edits.
2. **Use real or approved fictional content.** A results journey is mocked on a believable
   fictional data set, including its awkward cases (long labels, a bad result, a missing value).
3. **Build each entry as one self-contained `.html`** numbered like every other gallery entry,
   so the rating board and refs-by-number work unchanged. Load current animation guidance from
   the assistant's installed animation skills when available; if none is installed, read the
   library's current official documentation rather than relying on memory, and say which was used.
4. **Assets, cheapest first.** (a) code-drawn: SVG, canvas, shaders, type; (b) generated stills
   with layered depth; (c) generated video scrubbed by scroll, as pre-extracted frames. Use (c)
   only for a shot that (a) and (b) cannot carry, and record the prompt, start/end images and
   seed in the shot list so a single shot can be regenerated. If a generator is unavailable or
   unproven, say so and stay in (a)/(b); never present a placeholder as the intended footage.
5. **Record it.** For every entry capture a scroll-through video plus stills at each shot, on a
   desktop and a phone viewport and with reduced motion on. The user reviews the clip; the
   live page is there for those who want to scroll it themselves.

## Tiers (keep breadth cheap)

- **Tier A — many directions.** A storyboard strip (one still per shot) plus a short clip of the
  single most important move. Rate these by number.
- **Tier B — the top two or three.** The full working scroll page with every shot built.
- A playground is still worth it at Tier B: expose speed, easing, zoom depth and ambient
  intensity as live controls instead of building near-duplicate entries.

## Checks before showing an entry

- Every scroll position shows something intentional (no dead scroll, no stuck frame).
- Copy stays readable over moving backgrounds at every position.
- Reduced-motion users get the content in a still, ordered form.
- The phone viewport is composed, not merely shrunk; note its weight (total asset bytes).
- State plainly anything that is a stand-in (placeholder footage, fake anatomy, sample numbers).

## Feedback and edits

Feedback is per shot ("shot 3: zoom too fast", "shot 5: background too busy"). Change only that
shot and re-record; keep earlier versions' numbers so comparisons stay possible.

## From a picked direction to the lock and the build

1. The picked entry's shot list, timings, tokens (type, colour, spacing) and assets go into
   `LOCKED-DESIGN.md` as exact values. Motion values are part of the lock: durations, easings,
   scroll distances per shot.
2. Then choose the production engine, with the picked mockup as the acceptance reference. The
   mockup's own code may be reused if it meets the product's performance and accessibility
   needs; that is a build decision, not an assumption.
3. The fidelity protocol applies to motion too: compare the built page against the mockup's
   recorded clip shot by shot, on desktop and phone.

## Relation to the scroll-story lane

The scroll-story lane (optional plugin) plans and builds ONE marketing page inside an existing
lock and enforces differences between successive builds. This lane produces MANY comparable
directions before a lock, for any surface. Its planning ideas (feeling curve, one signature
move, scroll QA) are worth borrowing here; its between-build difference gate is not, because a
gallery intentionally varies one thing at a time.
