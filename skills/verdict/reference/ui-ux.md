# UI UX and visual review

Run for every user-facing tool, including dashboards, CLIs, editors and closed-source apps. This is part of relevant usability; popularity/user sentiment stays in qualitative assessment. For headless code, state why no surface applies. If a surface may exist but cannot be reached, mark unknown/uninspected rather than no UI.

Inspect three things separately:
- **Task and interaction:** can a person understand where to start, complete the main job, recover from errors, and keep context? Look at navigation, feedback, empty/loading/error states, keyboard/focus and meaningful small-screen behavior. CLI output/error messages count as interface.
- **Visual execution:** hierarchy, typography, spacing, alignment/density, color/contrast, charts/data presentation, iconography/assets and motion where observable. Say precisely what the design makes easier to see/read/do. Avoid “polished” without an example or taste-only ranking.
- **Transferable execution:** particular components, interactions, design tokens, styles, assets, layout/composition, state transitions or visualizations worth reusing. Map observations to exact files and support dependencies when source exists. For interactive reuse, trace entered values through state and callback payloads to the real action: configurable props, a visible retry button or a timed animation alone do not establish that answers survive or an action works.

Use actual rendered screenshots or permitted live interaction when available. Capture representative main and relevant alternate states at desktop/small-screen sizes; don't invent unobserved behavior. A screenshot supports appearance, not keyboard behavior, responsiveness across widths or performance. A browser interaction supports only what was exercised. A promotional image shows advertised design; source-only review shows implementation intent. Label these evidence kinds and their limits. If a safe renderer isn't available, inspect existing images/demos/source and report the gap; do not turn unavailable runtime into “no visual value.”

For each strong opportunity give:
1. Today's target behavior or the inspected gap (or explicit unknown).
2. The visible/task improvement, with a concrete before/after example.
3. Source screenshot/interaction/state plus component/style/asset files, or explain source unavailable.
4. What to preserve exactly (values/assets/state behavior), adaptations needed and destination.
5. Verification needed after transfer: screenshot comparison plus the relevant interactions/states, and accessibility checks when applicable.

Visual taste need not match the source wholesale: a great chart, toolbar or error state can be valuable inside an unsuitable product. Look beyond headline screens and repo category. Distinguish importing code, copying permitted visual assets and learning a visual idea. Fonts/images/icons can have different terms than the code; verify their notices before copying. Do not infer a screenshot came from inspected source without checking its provenance.

The report's relevant-usability section always includes a short UI/UX and visuals conclusion, evidence inspected, useful/rejected opportunities and unknowns. The sidecar visual_review records applicability (user-facing/headless/unknown), conclusion, evidence [{kind, ref}], opportunities (component IDs) and limitations. Headless requires a reason. Source/promotional evidence cannot be described as rendered/interaction-tested.

