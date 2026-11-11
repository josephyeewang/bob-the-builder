# Lane 4 — Landing-page scroll story (via the `scroll-craft` plugin)

**What this lane is for.** Marketing pages only: a product homepage, a launch page, a personal
site's hero/section rewrites. Pages where the visitor's *scroll* is the storytelling device — the wheel
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

**Where it lives.** A separately installed optional plugin; source:
https://github.com/nateherkai/scroll-craft. Resolve it through the current assistant's tool/skill
registry. Read the installed version's workflow and references before using this integration;
this module does not bundle its implementation or assume it is connected.

## How it sequences with the rest of design-gallery

1. **Direction first, in the image lane.** Find the look cheaply (design-mockups). Lock palette,
   type, and brand rules in `LOCKED-DESIGN.md` as usual.
2. **Then run the scroll-story lane for the marketing page.** The lock is an INPUT to scroll-
   craft's brief (Step 0, question 6 "aesthetic family" + assets): hand it the locked tokens and
   fonts. It plans the curve, grammar, devices, and signature move *inside* that look.
3. **Its QA pass runs before the transfer diff.** Dead-scroll / contrast / phone composition
   findings get fixed in the page, then the normal fidelity-protocol adversarial diff runs.

## Project choices for the optional integration

| Plugin default | Project choice | Why |
|---|---|---|
| Asset generation through **kie.ai** (paid API key) | Use approved existing assets; optionally use Design Mockups when installed and budgeted, then hand those files to the plugin | Reuse approved assets first; generation needs its own budget and data approval |
| "Nate's standing hero preference" — dimensional layered hero is mandatory | Treat as an OPTION, not a requirement. The **locked design wins**; a flat typographic hero is fine if the lock says so | The lock is canonical (fidelity-protocol rule 1) |
| Its own `engine/scrollcraft.js` + `.css` copied into the page | Fine for a static marketing page (vanilla, no build step). For a Next.js homepage, port the *acts* to the app's existing motion stack (the optional Design Mockups build bridge lists examples) and keep the engine out of the product bundle | One motion stack per product |
| Consumer / food / drink brand voice baked in | Answer the 8-question brief in the product's voice; ignore the worked examples' register | Register drift shows up in copy |

**Hard rule carried over from the transfer discipline:** scroll-craft *originates* design — it
will happily invent a look. Never run it before a lock exists for the surface, and never let its
output redefine tokens. If it proposes a palette or type change, that goes back to the gallery
as a numbered mockup, not straight into the page.

## Toolchain for the optional plugin

The plugin is a separate installation, not bundled here. Its documented integration uses Node
≥20, ffmpeg and playwright-core. Inspect the installed version's requirements and doctor script
before running it: a doctor may install dependencies. Use the user's approved package setup for
the host OS. Do not install a plugin, browser or system package merely because this reference
names it. If unavailable, keep the locked direction and use the project's existing motion tools;
state that plugin-specific QA was not run.

## Version boundary

The original integration was written against scroll-craft v0.3.0. That capability note is void
for another version: recheck the installed plugin's workflow and QA targets before relying on it.
No installation, current runtime compatibility or successful plugin QA is implied by this module.
