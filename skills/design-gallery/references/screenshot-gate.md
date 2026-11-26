# The screenshot gate — pass/fail before the user sees a page

**Who runs it.** The agent, on every candidate page from the HTML lane, the motion-mockup lane
(`motion-mockup-lane.md`) and the scroll-story lane (`scroll-story-lane.md`), before the page goes
on the rating board. A page that fails is fixed or dropped; it is not shown "with caveats".
Other tools' checks (a plugin's scroll QA, a rule-based pattern checker) are inputs to this gate,
not substitutes for it. The page's art-direction brief (`../templates/art-direction-brief.md`)
supplies the banned list, the signature idea and the budgets.

## 1. Capture

- Widths **1440, 1024, 768 and 390** px. At each: the top of the page and every scroll stop
  (each section, or each shot in a shot list).
- The same stops again with **reduced motion** on, at least at 1440 and 390.
- Wait for fonts and scroll-triggered motion to settle before each shot; record what you waited for.
- Read the fonts **actually drawn** from the browser (the rendering engine's own report for text
  nodes), not from the stylesheet: a missing file silently falls back to a system face.
- Load once on a **throttled phone profile** (slow mobile network, slowed processor) and record when
  the main content painted (largest contentful paint) and the total bytes transferred.

`../scripts/gate-capture.mjs` does all of this with Playwright (Chromium) and writes the images plus
a `gate-report.json`; it fails by itself on the measurable items (fonts, paint time, weight).
Usage is in its header. Without Playwright, do the same steps with whatever browser tool is
available and say which steps were skipped.

## 2. Fail conditions (any one fails the page)

1. A banned pattern from the brief appears (standard tells or the project's own list).
2. Drawn fonts differ from the locked or briefed fonts.
3. The signature idea is not visible within the first two screens.
4. Two neighbouring sections share the same layout skeleton.
5. More than one section uses a plain fade-up entrance.
6. Any scroll position is empty or stuck, or text is unreadable over motion.
7. The phone view is a shrunk desktop rather than a composed layout.
8. The reduced-motion view loses content.
9. Main content paints later than the brief's budget (default 2.5 s) on the throttled phone
   profile, or page weight exceeds its budget.
10. **Blind test:** a fresh agent that did none of the work is shown only the screenshots and asked
    "which template or AI tool made this?". If it names one with a concrete reason, the page fails.

Items 2 and 9 are measured by the script; the rest need eyes on the images. Write one line per item
(pass / fail + the shot that shows it) so the result can be checked.

## 3. When it keeps failing

Three failed rounds on the same item: stop patching. Explain each attempt and why it failed, then
change approach (a different reference, layout concept, signature idea or asset tier). If still
stuck, say so to the user rather than cycling.
