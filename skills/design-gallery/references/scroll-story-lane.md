# Lane 4 — Landing-page scroll story (via the `scroll-craft` plugin)

**What this lane is for.** Marketing pages only: a product homepage, a launch page, joe.wang
hero/section rewrites. Pages where the visitor's *scroll* is the storytelling device — the wheel
scrubs a film, a frame pins while copy advances, numbers land, type assembles. It is NOT for
product UI, dashboards, reports, or anything behind login (those stay in the HTML-mockup lane).

**What it adds that the other three lanes don't.** The HTML/image/SVG lanes decide how a page
LOOKS. This lane decides what a page DOES to the visitor over time:
- a **feeling curve** — one emotion per section, with one engineered peak (two adjacent
  sections with the same feeling = filler; cut one);
- a **page grammar** — the page's organising logic, chosen from ~8 mutually exclusive families
  (filmic one-shot, chaptered editorial, live surface, typographic poster…), each naming what
  it *forbids*;
- a **device kit** — `scrub` / `pin` / `pan` / `reveal` / `kinetic` / `parallax` / `count` /
  `flow` / `drift` — with the rule "≥4 device families per page, never the same one twice in a
  row";
- one **signature move** the page does that no page the user has seen does;
- an **anti-sameness gate** — build N must differ from builds 1..N-1 on ≥4 of 6 axes
  (`templates/FINGERPRINTS.md` in the plugin);
- a **scroll QA pass** — headless Chrome screenshots every scroll position on desktop + phone +
  reduced-motion and reports dead scroll, faded copy, per-line contrast failures, stuck video.

**Where it lives.** Installed as a Claude Code plugin, not copied here — it is 3 weeks old
(Sept 2026) and shipping weekly, so it versions upstream:
`claude plugin marketplace add nateherkai/scroll-craft` → `claude plugin install nateherk-design`
→ invoke with `/nateherk-design:scroll-craft`. Source: https://github.com/nateherkai/scroll-craft
(MIT, Nate Herk). Its own references — `devices.md`, `feel.md`, `uniqueness.md`, `verify.md`,
`hero-depth.md` — are the method; read them from the plugin cache when running the lane.

## How it sequences with the rest of design-gallery

1. **Direction first, in the image lane.** Find the look cheaply (design-mockups). Lock palette,
   type, and brand rules in `LOCKED-DESIGN.md` as usual.
2. **Then run the scroll-story lane for the marketing page.** The lock is an INPUT to scroll-
   craft's brief (Step 0, question 6 "aesthetic family" + assets): hand it the locked tokens and
   fonts. It plans the curve, grammar, devices, and signature move *inside* that look.
3. **Its QA pass runs before the transfer diff.** Dead-scroll / contrast / phone composition
   findings get fixed in the page, then the normal fidelity-protocol adversarial diff runs.

## Overrides — what to change from Nate's defaults for Joe's setup

| Nate's default | Joe's setup | Why |
|---|---|---|
| Asset generation through **kie.ai** (paid API key) | Generate stills/clips with the **design-mockups** skill (Nano Banana / Veo) and hand the files to scroll-craft as "assets you already have" (brief question 8) | Already paid for, already in the gallery numbering; no second image vendor |
| "Nate's standing hero preference" — dimensional layered hero is mandatory | Treat as an OPTION, not a requirement. The **locked design wins**; a flat typographic hero is fine if the lock says so | The lock is canonical (fidelity-protocol rule 1) |
| Its own `engine/scrollcraft.js` + `.css` copied into the page | Fine for a static marketing page (vanilla, no build step). For a Next.js homepage, port the *acts* to the app's motion stack (`build-bridge.md`: GSAP + Lenis + Motion.dev) and keep the engine out of the product bundle | One motion stack per product |
| Consumer / food / drink brand voice baked in | Answer the 8-question brief in the product's voice; ignore the worked examples' register | Register drift shows up in copy |

**Hard rule carried over from the transfer discipline:** scroll-craft *originates* design — it
will happily invent a look. Never run it before a lock exists for the surface, and never let its
output redefine tokens. If it proposes a palette or type change, that goes back to the gallery
as a numbered mockup, not straight into the page.

## Toolchain the lane needs (one-time, per machine)
Node ≥ 20, a full `ffmpeg` build (`brew install ffmpeg`), and `playwright-core` (installed by
the plugin's `scripts/doctor.mjs` check). Run `node <plugin>/scripts/doctor.mjs` first; it
reports what is missing.

## Status / maturity (as of 2026-09-12)
2,372★ in 3 weeks (creator-amplified), one author, 15 commits, v0.3.0. The METHOD is sound and
fills a real gap; the ENGINE is young. Re-check in Nov 2026 — if still single-author and the
QA harness has known-wrong-site bugs (`verify.md` §"photograph the wrong site"), keep the method
and port acts to GSAP by hand.
