---
id: L17
name: Device & Form Factor
band: 5
band_name: Reach & Distribution
when_to_run: Any product with a UI surface that users access from devices. Mandatory if product is web-based or has any chance of being accessed on mobile.
estimated_duration: 60-120 min — requires actual device testing or device emulators
session_pattern: fresh session; reads L07 (Ease) and L19 (Accessibility) reports if available
output_markdown: audit-artifacts/L17-device-form-factor-{YYYY-MM-DD}.md
output_json: audit-artifacts/L17-device-form-factor-{YYYY-MM-DD}.json
source_frameworks:
  - Google Mobile-First Indexing best practices — https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing
  - Lighthouse mobile audit categories
  - Core Web Vitals (LCP, CLS, INP) — Google
  - Apple HIG touch targets (44pt) + Material (48dp) + WCAG 2.5.5 (44 CSS px AAA / 2.5.8 24×24 AA)
  - "Joe.wang anecdote" — built for desktop, 100% of users tried it on mobile and it was garbage. Empirical anchor for mobile-blind product builds.
---

# L17 — Device & Form Factor

## Question this lens answers

*Does the product actually work on the devices users will use — particularly mobile, even if you didn't design for it?*

## Why this lens exists / what other lenses miss

The DEFAULT failure mode in product builds: design on desktop, ship on web, discover that 70%+ of traffic comes from mobile, where the product is unusable. The joe.wang anecdote is the empirical anchor: *"I made it entirely for desktop but when I sent it to people 100% of them looked at it on mobile and it was absolute garbage on mobile, and I never thought about that once."* This pattern is universal in shipped products that didn't audit for device.

Adjacent failures: tablet layouts that just stretch the phone view, foldables ignored, TV / large-screen unsupported, voice-only paths broken, accidental hover-only interactions that fail on touch.

This lens enumerates the device matrix, walks the product on each, and surfaces gaps.

## When this lens fires

**Always-in-Full-Enchilada for products with UI surfaces.** Curated panel inclusion criteria:
- ✅ Always — any web product, any product accessible from a browser.
- ✅ Mandatory — before any consumer launch, any marketing push, any time the user audience expands beyond the original target device.
- ⏸ Skip — pure CLI / backend / API products with no UI.

## Session setup

- Start a **fresh Claude Code session.**
- Read L07 (Ease) and L19 (Accessibility) — touch-target overlap.
- Tools and devices:
  - Chrome DevTools Device Mode — for emulated devices
  - **BrowserStack** (or LambdaTest) for real-device cloud testing — for production audits, real devices > emulators
  - **Lighthouse** — `npx lighthouse {url} --emulated-form-factor=mobile --quiet --chrome-flags="--headless"`
  - Physical iPhone + Android device if available — emulators miss things real devices catch (rotation, accidental edge taps)
  - Real network throttling (Slow 3G in DevTools)

## Source frameworks

- **Google Mobile-First Indexing** — https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing
- **Lighthouse mobile audit** — Performance / Accessibility / Best Practices / SEO / PWA categories.
- **Core Web Vitals** — LCP <2.5s, CLS <0.1, INP <200ms. https://web.dev/vitals
- **Touch target standards** — Apple HIG 44pt × 44pt; Material Design 48dp × 48dp; WCAG 2.5.5 AAA 44 CSS px, WCAG 2.5.8 AA 24×24 CSS px. https://tetralogical.com/blog/2022/12/20/foundations-target-size/
- **Mobile breakage patterns** — viewport meta, horizontal scroll, fixed-width images, hover-only interactions, fonts <16px causing iOS zoom, modals overflowing.

## Audit method

1. **Build the device matrix.** What devices/form factors will real users use?
   - Mobile phones (iPhone, Android — multiple sizes from 320px to 430px width)
   - Tablets (iPad portrait + landscape, Android tablets)
   - Foldables (Galaxy Z Fold — narrow when folded, large when unfolded)
   - Laptops (1280×800 to 1920×1080)
   - Desktops (1920×1080 to 4K)
   - Optional: TVs (1920×1080 at 3m viewing distance — different requirements)
   - Optional: Voice (no screen — does the product have a voice path?)

2. **Mobile-first audit (highest priority).**
   - Open product on a 375×667 (iPhone SE) viewport.
   - Walk the primary user journey.
   - Note every issue: horizontal scroll, clipped modal, tiny tap target, overflowing image, broken layout, font-too-small-iOS-zooms, hover-only interaction, drag that doesn't work touch.

3. **Lighthouse mobile run.** `npx lighthouse {url} --emulated-form-factor=mobile`. Capture:
   - Performance score (target ≥90)
   - LCP / CLS / INP (Core Web Vitals)
   - Accessibility score (target ≥95)
   - Best Practices score (target ≥95)
   - SEO score (target ≥95)

4. **Touch target audit.** For every interactive element, measure size at mobile breakpoint. Flag any <44×44 CSS px (WCAG 2.5.5 AAA / Apple HIG). Flag any <24×24 (WCAG 2.5.8 AA — minimum standard).

5. **Viewport + meta audit.**
   - `<meta name="viewport" content="width=device-width, initial-scale=1">` present?
   - `100dvh` used instead of `100vh`?
   - iOS safe-area insets respected (`env(safe-area-inset-*)`)?
   - Body text ≥16px to avoid iOS input zoom-in on focus?

6. **Interaction modality audit.**
   - Any primary action depend on hover?
   - Any action depend on right-click / long-press / precise pointer?
   - Drag interactions have non-drag alternatives?
   - Multi-touch / gesture interactions documented + have alternatives?

7. **Tablet + foldable check.** Switch to 768-1024 widths. Does the layout actually use the space or just stretch the phone view? Are there tablet-specific affordances (side-by-side, multi-column)?

8. **Slow network audit.** Throttle to Slow 3G. Walk hot path. Does the product remain usable? Is there a perceived-performance optimization (skeleton, partial-load) or does it block?

9. **Content parity check.** Is the mobile experience materially missing content vs desktop? Mobile-first indexing means Google ranks based on mobile; if mobile is incomplete, SEO suffers.

## Check questions

1. Does every interactive page render with viewport meta and pass mobile-friendly test?
2. Is content parity 100% — same H1/copy/structured data served to mobile and desktop?
3. Run Lighthouse mobile: each category ≥ target? Core Web Vitals "Good"?
4. Are all tap targets ≥44×44 CSS px with ≥8px spacing? Any <24×24 (AA fail)?
5. Does any primary action depend on hover, right-click, long-press, or precise pointer?
6. At 320px width, any horizontal scroll, clipped modal, fixed-width image overflowing?
7. Do modals respect `100dvh` and iOS safe-area insets?
8. Is body text ≥16px to avoid iOS input zoom?
9. Do form inputs use correct `type=`/`inputmode=`/`autocomplete=` for mobile keyboards?
10. Tablet (768-1024): does layout actually use the space?
11. Foldable narrow-mode tested?
12. Slow 3G — does product remain usable?
13. Are images responsive (`srcset`, `sizes`, modern formats)?
14. Is touch scrolling smooth (no jank, no overscroll-blocking)?
15. For products with voice-input claims: does the voice path actually work, including with no-mic-permission fallback?

## Output schema

### Markdown report

```markdown
# L17 — Device & Form Factor — {YYYY-MM-DD}

## Device matrix tested
| Device class | Tested | Pass / fail / partial |
|---|---|---|

## Mobile (375×667) journey walk
| Step | Issue | Severity |
|---|---|---|

## Lighthouse mobile scores
| Category | Score | Target | Pass? |
|---|---|---|---|
| Performance | 87 | 90 | ⚠ |
| Accessibility | 96 | 95 | ✓ |
| Best Practices | 92 | 95 | ⚠ |
| SEO | 98 | 95 | ✓ |
| Core Web Vitals LCP | 2.8s | <2.5s | ⚠ |
| CLS | 0.08 | <0.1 | ✓ |
| INP | 240ms | <200ms | ⚠ |

## Touch target findings
| Element | Size | Location | Recommendation |
|---|---|---|---|

## Viewport + meta findings
{list}

## Interaction modality findings
{list}

## Tablet + foldable findings
{list}

## Slow network findings
{list}

## Content parity
| Surface | Desktop has | Mobile has | Gap |
|---|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L17",
  "lens_name": "Device & Form Factor",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "device_matrix_tested": [],
  "lighthouse_mobile": {
    "performance": 0,
    "accessibility": 0,
    "best_practices": 0,
    "seo": 0,
    "lcp_ms": 0,
    "cls": 0,
    "inp_ms": 0
  },
  "touch_target_violations_aa": 0,
  "touch_target_violations_aaa": 0,
  "hover_only_interactions": 0,
  "viewport_meta_correct": true,
  "ios_safe_area_respected": true,
  "content_parity_pct": 100,
  "findings": [
    {
      "id": "L17-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "mobile_unusable|tap_target_below_aa|hover_only_interaction|missing_viewport_meta|horizontal_scroll|clipped_modal|font_below_16px|input_no_inputmode|content_parity_gap|lighthouse_below_target|core_web_vitals_below_threshold|tablet_just_stretched|slow_network_broken|drag_no_alternative",
      "title": "{short}",
      "device_class": "phone|tablet|foldable|desktop|tv|voice",
      "viewport_width": null,
      "evidence": "{specific UI / breakpoint / value}",
      "user_impact": "{1-sentence}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Product unusable on mobile (primary journey broken, can't complete core task). Missing viewport meta tag. Lighthouse Performance <50.
- **Major** — Tap targets failing WCAG 2.5.8 AA (<24×24). Primary action hover-only. Core Web Vitals failing thresholds. Major content parity gap (mobile missing significant features).
- **Minor** — Tap targets failing 2.5.5 AAA but passing AA. Tablet just stretches phone view (missed opportunity, not failure). Lighthouse Performance 70-89.
- **Cosmetic** — Polish opportunities (typography tuning, spacing on specific viewports).

## Anti-patterns / Bias instructions

- **Do NOT audit only with desktop emulator.** Mobile emulators miss: scroll behavior, real touch latency, real network variability, rotation, edge tap issues. Real device or BrowserStack required for production audits.
- **Do NOT mark "mobile-responsive" as passing without journey walk.** Responsive layout ≠ usable on mobile. The joe.wang anecdote IS this: technically responsive, practically garbage.
- **Do NOT recommend "build a native app" as fix.** That's a strategic decision, not an audit recommendation. L17 surfaces specific gaps in the existing UI.
- **Bias toward "what would a first-time user on iPhone SE 375px width experience?"** Smallest realistic viewport surfaces most gaps.

## Stop conditions

1. **No UI surface.** Skip (CLI / backend / API products).
2. **Cannot access real device or emulator.** Document gap; static review only.

## Cross-lens handoff

- **Upstream:** L07 Ease (touch targets ↔ cognitive path).
- **Downstream:** L19 Accessibility (touch targets ↔ motor accessibility), L20 Shareability (mobile share affordances).
- **Adjacent (~15% overlap):**
  - **L19** — touch-target standards overlap (WCAG = HIG = Material in this dimension).
  - **L15** — Lighthouse Performance feeds latency/cost driver analysis.
