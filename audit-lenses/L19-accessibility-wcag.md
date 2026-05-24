---
id: L19
name: Accessibility (WCAG+)
band: 5
band_name: Reach & Distribution
when_to_run: Products with any UI accessible to users. Mandatory for public-facing products, government / education / healthcare products. EU Accessibility Act applies June 2025.
estimated_duration: 60-120 min — includes axe-core scan + manual keyboard + screen-reader walk
session_pattern: fresh session
output_markdown: audit-artifacts/L19-accessibility-wcag-{YYYY-MM-DD}.md
output_json: audit-artifacts/L19-accessibility-wcag-{YYYY-MM-DD}.json
source_frameworks:
  - WCAG 2.2 — https://www.w3.org/TR/WCAG22/
  - WAI-ARIA Authoring Practices Guide — https://www.w3.org/WAI/ARIA/apg/
  - Section 508 (US) — https://www.section508.gov
  - EU Accessibility Act (EAA) — June 2025
  - COGA Task Force cognitive accessibility guidelines
  - axe-core (Deque) — https://github.com/dequelabs/axe-core
  - Lighthouse accessibility audit
---

# L19 — Accessibility (WCAG+)

## Question this lens answers

*Across the four WCAG principles (Perceivable, Operable, Understandable, Robust) plus cognitive, motor, visual, and auditory dimensions — is this product accessible to users with disabilities, and can it meet WCAG 2.2 AA at minimum?*

## Why this lens exists / what other lenses miss

Accessibility is legally required (Section 508 US gov, EAA EU June 2025, ADA US private sector), strategically valuable (15-20% of global population has a disability), and a wedge differentiator (most products fail). Engineering audits don't catch most a11y issues; visual design audits miss screen-reader / keyboard-only paths. This lens orchestrates axe-core + Lighthouse + manual testing.

WCAG 2.2 added new success criteria (focus-not-obscured, dragging movements, accessible authentication, redundant entry, target size 24×24 AA) that are often overlooked even by teams that nominally "do a11y."

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Mandatory — public-facing products, government / education / healthcare / financial products.
- ✅ Mandatory — products with any EU presence (EAA June 2025).
- ✅ Strongly recommended — any product with broad-reach ambition.
- ⏸ Skip — pure internal tools for closed audience (still recommended, but lower priority).

## Session setup

- Start a **fresh Claude Code session.**
- Tools:
  - **axe-core** — `npm i -g @axe-core/cli`; or use axe DevTools browser extension
  - **Lighthouse** — accessibility audit
  - **NVDA + Firefox** (Windows) OR **VoiceOver + Safari** (macOS) for screen-reader testing
  - Color-contrast analyzer: WebAIM Color Contrast Checker https://webaim.org/resources/contrastchecker/
  - Keyboard only — no mouse for the duration of the audit
- Reading-level analyzer (Hemingway, readable.com) for L19 cognitive sub-audit.

## Source frameworks

- **WCAG 2.2** — POUR principles + 13 guidelines + 87 success criteria (A / AA / AAA). https://www.w3.org/TR/WCAG22/
- **WAI-ARIA Authoring Practices Guide** — implementation patterns for custom widgets. https://www.w3.org/WAI/ARIA/apg/
- **Section 508** — US government accessibility. https://www.section508.gov
- **EU Accessibility Act (EAA)** — effective June 2025; applies to many B2C products including e-commerce, banking, transport.
- **COGA Task Force** — Cognitive accessibility (often the weakest area). https://www.w3.org/WAI/cognitive/
- **axe-core (Deque)** — open-source accessibility engine. https://github.com/dequelabs/axe-core

## Audit method

1. **Determine target level.** WCAG 2.2 AA is the working standard (EAA + most legal frameworks). AAA aspirational. Document target.

2. **Run automated scans.**
   - `axe {url}` or browser extension on top pages
   - Lighthouse accessibility audit
   - Cross-reference findings; automated tools catch ~30-40% of issues.

3. **Keyboard-only walk.** Disconnect mouse / put hand behind back. Navigate the primary user flow using only keyboard:
   - Tab moves focus visibly
   - Focus order matches visual order
   - All interactive elements reachable
   - No keyboard traps (modal escapes, dropdown closes)
   - Skip links present for repeated nav
   - Visible focus ring at all times

4. **Screen-reader walk.** Open NVDA+Firefox or VoiceOver+Safari. Walk primary user flow:
   - Each interactive element has accessible name (label, aria-label, aria-labelledby)
   - Role / state announced correctly
   - Dynamic updates announced (live regions)
   - Images have meaningful alt text
   - Form errors announced
   - Heading structure makes sense as outline

5. **Color contrast audit.** For every text + background combo:
   - Normal text ≥4.5:1 (WCAG 1.4.3 AA)
   - Large text (18pt+ or 14pt+ bold) ≥3:1
   - UI components / graphics ≥3:1 (1.4.11)
   - Check disabled states, placeholder text, icon-only buttons.

6. **Zoom + reflow audit.**
   - Zoom to 200% — content still usable?
   - Zoom to 400% reflow (WCAG 1.4.10) on 320px width — no horizontal scroll, content usable?

7. **Custom widget audit.** For every custom component (combobox, tabs, dialog, menu, tree, listbox), verify against WAI-ARIA APG patterns. Custom widgets are the largest a11y gap source.

8. **WCAG 2.2 new criteria.**
   - **2.4.11 Focus Not Obscured (AA)** — focus indicator not fully hidden by sticky elements
   - **2.5.7 Dragging Movements (AA)** — drag interactions have non-drag alternative
   - **2.5.8 Target Size Minimum (AA)** — 24×24 CSS px
   - **3.2.6 Consistent Help (A)** — help mechanism in consistent location
   - **3.3.7 Redundant Entry (A)** — info user previously entered auto-populates
   - **3.3.8 / 3.3.9 Accessible Authentication (AA/AAA)** — no cognitive function test required

9. **Cognitive accessibility audit (often weakest).**
   - Reading level ≤Grade 8 for general audiences (Hemingway test)
   - Plain language (no jargon, defined acronyms)
   - Consistent patterns (same word for same thing across product)
   - Memory load (recall vs recognition)
   - Time limits (extensible or removable)

10. **Motor accessibility audit.** Large hit targets (44×44 AAA / 24×24 AA), no precision required, no time-pressured interactions, alternatives to gestures.

11. **Auditory accessibility.** Captions on video / audio? Transcripts on podcasts? Audio descriptions on visual-only content?

12. **Accessibility statement check.** Required by Section 508 / EAA. Present? Working feedback channel?

## Check questions

1. Has axe-core / Lighthouse run? Any Critical or Serious violations?
2. Can primary user flow be completed keyboard-only with visible focus ring at every step?
3. Has screen-reader walk been done? Roles, names, states, live regions all announced?
4. Does every image have meaningful `alt` (or `alt=""` decorative)?
5. Are form inputs programmatically labeled (not just placeholder)?
6. Is text contrast ≥4.5:1 normal, ≥3:1 large; UI components ≥3:1?
7. At 200% zoom and 400% reflow, content usable without horizontal scroll on 320px?
8. Custom widgets implemented per ARIA APG?
9. Any flow rely solely on color, sound, or motion? `prefers-reduced-motion` honored?
10. WCAG 2.2: focus not obscured by sticky elements? Non-drag alternative to drag? Tap targets ≥24×24 AA?
11. WCAG 2.2: SSO / passkey / "remember me" offered instead of pure cognitive auth?
12. Reading level pass Grade 8?
13. Are prerecorded videos captioned? Podcasts transcripted?
14. Accessibility statement present? Feedback channel working?
15. Heading hierarchy strict (no H2 without H1, no skipped levels)?

## Output schema

### Markdown report

```markdown
# L19 — Accessibility (WCAG 2.2 AA) — {YYYY-MM-DD}

## Target conformance level
WCAG 2.2 AA (working standard)

## Automated scan results
| Tool | Critical | Serious | Moderate | Minor |
|---|---|---|---|---|
| axe-core | 0 | 3 | 12 | 24 |
| Lighthouse | 96/100 |

## Keyboard-only walk
| Step | Reachable? | Focus visible? | Issue |
|---|---|---|---|

## Screen-reader walk
| Step | Name announced? | Role correct? | State updated? | Issue |
|---|---|---|---|---|

## Color contrast findings
| Element | Contrast | Required | Pass? |
|---|---|---|---|

## Zoom + reflow findings
{list}

## Custom widget audit (ARIA APG)
| Widget | Pattern reference | Compliance |
|---|---|---|

## WCAG 2.2 new SC
| SC | Status |
|---|---|
| 2.4.11 Focus Not Obscured | ✓/⚠/✗ |
| 2.5.7 Dragging Movements | |
| 2.5.8 Target Size Minimum | |
| 3.2.6 Consistent Help | |
| 3.3.7 Redundant Entry | |
| 3.3.8 Accessible Authentication | |

## Cognitive accessibility
| Dimension | Status |
|---|---|

## Motor accessibility
{findings}

## Auditory accessibility
{findings}

## Accessibility statement
- Present: yes/no
- Feedback channel working: yes/no

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged with WCAG SC reference)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L19",
  "lens_name": "Accessibility (WCAG+)",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "target_level": "AA",
  "automated_scan": {
    "axe_critical": 0,
    "axe_serious": 0,
    "axe_moderate": 0,
    "axe_minor": 0,
    "lighthouse_a11y_score": 0
  },
  "keyboard_walk_passes": true,
  "screen_reader_walk_passes": true,
  "color_contrast_violations": 0,
  "wcag22_new_sc_status": {},
  "cognitive_reading_level": null,
  "accessibility_statement_present": false,
  "findings": [
    {
      "id": "L19-F001",
      "severity": "critical|serious|moderate|minor",
      "wcag_sc": "1.4.3|2.4.11|2.5.8|...",
      "wcag_level": "A|AA|AAA",
      "category": "missing_alt|missing_label|low_contrast|keyboard_trap|no_focus_visible|aria_misuse|drag_no_alternative|focus_obscured|tap_target_too_small|cognitive_complex|no_captions|missing_accessibility_statement",
      "title": "{short}",
      "evidence": "{element selector / page}",
      "user_impact": "{which disability dimension}",
      "recommendation": "{specific fix with ARIA / WCAG citation}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (WCAG conformance + impact)

- **Critical** — Any A-level criterion failure. Keyboard trap, missing alt on meaningful images, missing labels on form inputs, color-only conveyance of meaning.
- **Serious** — AA-level criterion failure with primary user flow impact. Below-threshold color contrast on body text; primary action focus-not-obscured fail; tap target below 24×24.
- **Moderate** — AA criterion failure on secondary surface; AAA failure on primary surface.
- **Minor** — Cosmetic accessibility improvements; AAA failures on secondary surfaces.

## Anti-patterns / Bias instructions

- **Do NOT rely on automated scans alone.** axe-core catches ~30-40% of issues. Manual keyboard + screen-reader walk is mandatory.
- **Do NOT treat overlay accessibility tools (AccessiBe, UserWay) as fixes.** They mask issues, don't fix them — and have been the subject of lawsuits.
- **Do NOT recommend "add aria-label everywhere."** ARIA is the second tool after native HTML semantics. `<button>` beats `<div aria-label="button">`.
- **Bias toward "what does a screen-reader user hear?"** That's the most common audit blind spot.

## Stop conditions

1. **No UI surface.** Skip.
2. **Cannot install/run screen reader.** Document gap; partial audit possible via automated tools + keyboard.

## Cross-lens handoff

- **Upstream:** L07 Ease, L17 Device.
- **Downstream:** L26 Marketing (accessibility statement is content).
- **Adjacent (~15% overlap):**
  - **L17** — touch-target standards overlap.
  - **L18** — language declaration overlaps with screen-reader pronunciation.
