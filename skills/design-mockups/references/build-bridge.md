# Build bridge — from winning comp to real code

Distilled from `explain-my-blood-test/_mockups/METHODOLOGY.md` §5–§9 (EMBT, Aug 2026).

## 1. DESIGN.md spec layer (the repeatability piece)
Before building, capture the locked direction as a machine-readable `DESIGN.md`: tokens, type scale, spacing, radius, shadow, motion plan, and **forbidden defaults**. The coding agent reads it every session → consistent, on-brand, non-generic output. This is Joe's Principle #6 in file form: translate from a canonical source, not prose.
- `npx brandmd <url>` — any live site → DESIGN.md + Tailwind tokens *(reported, verify)*.
- `rohitg00/awesome-claude-design` — DESIGN.md prompt packs by aesthetic family; `google-labs-code/design.md` — Google's spec *(both verified)*.
- Apply Anthropic's `<frontend_aesthetics>` system-prompt block during the build so coded parts don't drift to generic.

## 2. Motion stack (the layer no image generator makes)
| Layer | Tool | When |
|---|---|---|
| Scroll feel | **Lenis** (~3KB) | Always — table stakes. |
| UI motion | **Motion.dev** (ex-Framer Motion) | All React UI, enter/exit, page transitions. |
| Choreography | **GSAP + ScrollTrigger** (free) | Hero/scroll storytelling: pins, scrubs, SplitText. |
| 3D | **R3F + drei** | One 3D hero when it earns the payload; lazy-load. |
| Authored | **Rive / Spline** | Designer-authored 2D/3D moments. |

**Rule: GSAP for scrub-pinned scroll; Motion.dev for UI transitions. Never cross them.** Arm the agent with a current GSAP skill or it emits outdated setup and leaks memory on unmount. Cheaper 3D fallback: a scroll-scrubbed image sequence (canvas frame swap) ≈ 80% of the feel, zero shaders.

## 3. The bridge itself
- **Skip image-to-code converters.** Feed the winning comp + DESIGN.md straight to the coding agent: *"clean React/Tailwind, flexbox not absolute, reuse my components, responsive."* The agent reads the repo and reuses real conventions. (Avoid Anima — absolute-positioned 400-line bloat.)
- **Export the winning comp's 4K backdrop as an actual asset** — the art survives as a file instead of being approximated in CSS.
- v0 for fast clean components; Relume to kill the blank page (sitemap→wireframe scaffold).
- Copy-paste component libraries: Aceternity, Magic UI, React Bits, shadcn/ui, 21st.dev.

## 4. Honest limits
- **Image comps show DIRECTION (layout/type/palette/texture/concept) — NOT motion.** The award-site "wow" is ~70% motion/WebGL, which only exists after the code build. Two-part litmus: (a) do the comps rival the tier's *static frames*? (b) does the build stack reproduce their *motion*?
- **~85% of the tier is achievable** with React/Tailwind/GSAP/Motion.dev/Lenis/R3F. The last **15%** (bespoke GLSL, physics, real-time multiplayer, audio-reactive) needs dedicated WebGL engineering — scope per project, never promise by default.
