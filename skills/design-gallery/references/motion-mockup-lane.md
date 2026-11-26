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
   count / parallax / drift, or a move from the vocabulary below), start and end composition,
   on-screen copy, and the asset it needs. Each entry also names **which inspiration reference**
   it draws on (a brief reference number such as R03, or a gallery number) and **which engine**
   drives it (GSAP + ScrollTrigger, Motion, Lenis, CSS scroll-driven animation, three.js or a
   hand-written shader). The shot list is the unit of feedback and of later edits.
2. **Use real or approved fictional content.** A results journey is mocked on a believable
   fictional data set, including its awkward cases (long labels, a bad result, a missing value).
3. **Build each entry as one self-contained `.html`** numbered like every other gallery entry,
   so the rating board and refs-by-number work unchanged. Load current animation guidance from
   the assistant's installed animation skills when available; if none is installed, read the
   library's current official documentation rather than relying on memory, and say which was used.
4. **Motion is code by default.** The agent writes the movement itself: scroll scenes,
   timelines, SVG and canvas drawing, shaders, type, CSS scroll-driven animation. Generated
   stills or video are an optional path, only for a shot that truly needs photographic material
   code cannot draw; then use the image-sequence recipe below and record the prompt, start/end
   images and seed in the shot list so one shot can be regenerated. If a generator is
   unavailable, unbudgeted or unproven, say so and stay in code; never present a placeholder as
   the intended footage.
5. **Record it.** For every entry capture a scroll-through video plus stills at each shot, on a
   desktop and a phone viewport and with reduced motion on. The user reviews the clip; the
   live page is there for those who want to scroll it themselves.

## Motion vocabulary (the brief picks from this)

The art-direction brief names the moves a page may use; each shot uses one. Every move needs a
reduced-motion version that keeps its content.

| Move | Fits when | Performance / reduced-motion note |
|---|---|---|
| Pinned scroll scene | One idea needs several beats while the frame holds still | Keep pinned length short on phones; reduced motion: the beats as stacked stills |
| Scrubbed timeline | Scroll should feel like controlling time (assembly, before/after) | Animate transform and opacity only; reduced motion: the end state |
| Split-text reveal | A headline is the signature, at most once or twice per page | Split into words, not letters, on long copy; reduced motion: text shown at once |
| Layout morph (Flip) | Something visibly turns into something else (a card into a detail view) | Measure once, animate transforms; reduced motion: a cut |
| View transition | Moving between states or pages should feel continuous | Native in current browsers, no library; reduced motion: an instant change |
| Parallax depth layers | A scene needs depth from a few flat layers | Two or three layers at most; none on low-power phones; reduced motion: flat |
| Procedural shader / noise background | Ambient texture that drawn shapes cannot give | Load after first paint, pause off-screen, cap frame rate; reduced motion: a still frame |
| SVG path drawing | A line, route or signature mark should appear as it is drawn | Cheap; reduced motion: the finished path |
| Data-driven number / chart animation | Real figures should arrive with emphasis | Animate from real data only, never invented values; reduced motion: final values |
| Cursor-reactive element | One playful or tactile focal point on desktop | No hover-only meaning; phones and reduced motion: static |

## Optional path — scroll-scrubbed image sequence

Only for a shot that needs photographic or filmed material. Generate or choose a start and an end
still, make a short clip between them, split it into frames with ffmpeg
(`ffmpeg -i clip.mp4 -vf fps=30,scale=1600:-2 frames/%04d.webp` or a similar modern format), and
draw the frame matching the scroll position onto a canvas. Frame sequences track scroll more
closely than seeking a video file. Keep the count modest (typically 60–150 frames), ship a
smaller and lighter set for phones, show the first frame as a plain image so the page paints
fast, load the rest after first paint, and give reduced-motion visitors one still.

## Tiers (keep breadth cheap)

- **Tier A — many directions.** A storyboard strip (one still per shot) plus a short clip of the
  single most important move. Rate these by number.
- **Tier B — the top two or three.** The full working scroll page with every shot built.
- A playground is still worth it at Tier B: expose speed, easing, zoom depth and ambient
  intensity as live controls instead of building near-duplicate entries.

## Checks before showing an entry

Run the screenshot gate (`screenshot-gate.md`) on every entry: it covers dead or stuck scroll,
readability over motion, the composed phone view, reduced motion and weight. In addition, state
plainly anything that is a stand-in (placeholder footage or imagery, sample numbers).

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
3. The fidelity protocol applies to motion too (its rule 4): the built page is compared with
   the mockup's recorded clip shot by shot.

## Relation to the scroll-story lane

The scroll-story lane (optional plugin) plans and builds ONE marketing page inside an existing
lock and enforces differences between successive builds. This lane produces MANY comparable
directions before a lock, for any surface. Its planning ideas (feeling curve, one signature
move, scroll QA) are worth borrowing here; its between-build difference gate is not, because a
gallery intentionally varies one thing at a time.
