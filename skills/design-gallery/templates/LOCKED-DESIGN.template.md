# PROJECT — Locked UI Design (the outcome of the gallery exploration)

> **THE MOCK FILES ARE CANONICAL — this doc is only a map to them.** Never build or restyle a
> surface from this doc's text: that is exactly how transfer degrades into a ~70% re-creation
> (it happened twice on InsiderIntent — a component library built from "font TBD, ~8-10px radius"
> prose while the mock file sat unread). Read the winning mock's literal CSS, match every value,
> and finish with an adversarial diff of your output against the mock — see the skill's
> `fidelity-protocol.md`.

**Design base:** gallery design **NN** (`<name>`) — `designs/NN-<name>.html`
(+ the interactive playground `designs/MM-playground.html` if one was used to converge parameters).

## The shell
<!-- Describe the STRUCTURE in one block: layout skeleton, nav model, where content lives.
     e.g. "Dashboard, not a webpage: fixed left rail (~200px) + top bar + a main grid of tiled panels." -->
- **Panel rule:** <!-- how surfaces separate from the ground, e.g. "panels raised over a grey gutter" -->
- **Cohesion rule:** <!-- the repeated container, e.g. "every panel is the identical container; only contents differ" -->
- **Density:** <!-- gutters, charts-forward vs prose-forward -->

## The locked palette (single source of truth)
<!-- EXACT hex values only — never "a warm green". If brand and data colors are separated
     (recommended for any data product), state the hard rule explicitly. -->
**Brand accent — chrome ONLY** (nav, buttons, links, focus, section ticks): `#______`
**Signal / data colors — data ONLY** (direction, bands, deltas, charts):
- Good = `#______` · Medium = `#______` · Bad = `#______`

**Hard rule:** the accent is NEVER used on data; data colors are NEVER used on chrome.

**Surfaces — light (default):** ground `#______` · panels `#______` · ink `#______` · hairline `#______`
**Surfaces — dark (the toggle):** <!-- name the reference mock, list values; accent+signals usually stay constant -->

## Typography / rounding / shading — EXACT values from design NN (do not paraphrase; match these)
<!-- Every value verbatim from the mock's CSS. The template that caused the 70% drift said
     "one clean grotesk, final family TBD" — the fix said "Archivo at 700/800/900 (not 600)".
     Be the fix, not the drift. -->
- **Type:** families + WHERE each is used + exact weights. Numerals: tabular?
- **Marquee sizes:** each hero/score/title element with px + weight (e.g. "KPI value 32px/800").
- **Radius:** exact px per element class (e.g. "panels 3px, tags/pills 2px — NOT 8-10px, NOT rounded-full").
- **Base register:** body font-size / line-height from the mock.
- Shadows, borders, chart stroke widths/fills/legends — literal values or "see mock lines N-M".

## Pinned decisions & deliberate exceptions (do NOT re-litigate)
<!-- Every place the PRODUCT intentionally deviates from the mock, and every closed ruling a
     later session might be tempted to "fix" or tidy away. Without this list, fidelity audits
     un-fix approved exceptions and fresh sessions re-open settled debates (both happened).
     e.g. "the page-level graph-paper background STAYS even though gallery pages render white
     (user ruling, <date>)" · "the skin overlay architecture is deliberate, not a kludge". -->
- …

## Build note
This is the design SSOT map. Wired into the app it becomes CSS tokens (one variable per palette +
surface value); a light/dark toggle swaps only the surface set. The transfer itself follows
`fidelity-protocol.md` — including the CI token gate, so drift fails the build instead of
waiting for someone to notice.
