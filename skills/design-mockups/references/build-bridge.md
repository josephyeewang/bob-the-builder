# Build bridge — from winning comp to real code

Use the selected comp to guide art direction while keeping implementation and motion review explicit.

## 1. DESIGN.md spec layer (the repeatability piece)
Before building, capture the locked direction as a machine-readable `DESIGN.md`: tokens, type scale, spacing, radius, shadow, motion plan, and **forbidden defaults**. The coding agent reads it every session → consistent, on-brand, non-generic output. This is Engineering Principle 6 (Bob's) in file form: translate from a canonical source, not prose.
- **In a Bob build the winning mock file stays the canonical input**, and `LOCKED-DESIGN.md` (Bob Step 5.5, `design-gallery` skill) is the map to it — its banner forbids building from its text. A `DESIGN.md` token file is an optional extra generated from that mock, never a substitute for it.
- `npx brandmd <url>` — any live site → DESIGN.md + Tailwind tokens *(reported, verify)*.
- `rohitg00/awesome-claude-design` — DESIGN.md prompt packs by aesthetic family; `google-labs-code/design.md` — Google's spec *(both verified)*.
- Apply Anthropic's `<frontend_aesthetics>` system-prompt block during the build so coded parts don't drift to generic.

## 2. Motion stack (the layer no image generator makes)
| Layer | Tool | When |
|---|---|---|
| Scroll feel | **Lenis**  | When smooth scrolling is appropriate and accessible. |
| UI motion | **Motion.dev** (ex-Framer Motion) | All React UI, enter/exit, page transitions. |
| Choreography | **GSAP + ScrollTrigger** (free) | Hero/scroll storytelling: pins, scrubs, SplitText. |
| 3D | **R3F + drei** | One 3D hero when it earns the payload; lazy-load. |
| Authored | **Rive / Spline** | Designer-authored 2D/3D moments. |

**Rule: GSAP for scrub-pinned scroll; Motion.dev for UI transitions. Never cross them.** Arm the agent with a current GSAP skill or it emits outdated setup and leaks memory on unmount. Cheaper 3D fallback: a scroll-scrubbed image sequence (canvas frame swap) can approximate some motion without custom shaders.

## 3. The bridge itself
- **Skip image-to-code converters.** Feed the winning comp + `LOCKED-DESIGN.md` straight to the coding agent: *"clean React/Tailwind, flexbox not absolute, reuse my components, responsive."* The agent reads the repo and reuses real conventions. Inspect any converter output for responsiveness and maintainable layout.
- **Export the winning comp's 4K backdrop as an actual asset** — the art survives as a file instead of being approximated in CSS.
- v0 for fast clean components; Relume to kill the blank page (sitemap→wireframe scaffold).
- Copy-paste component libraries: Aceternity, Magic UI, React Bits, shadcn/ui, 21st.dev.

## 4. Honest limits
- Image comps show layout, palette, texture and concept, not implemented interaction or motion.
  Compare static-frame quality and actual browser behavior separately.
- A listed library does not guarantee a particular visual quality. Bespoke shaders, physics,
  multiplayer and audio-reactive work need explicit scope and appropriate engineering review.
