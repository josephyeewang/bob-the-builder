# Evolution 006 — Lens artefact prerequisites (Rule 29)

**Version:** v2.37 · **Date:** 2026-08-21 · **Decision:** D-013

## Problem

Bob gates *lenses* by project profile (`_selection-rubric.md`) but never gated the *checks inside*
a lens. Many checks read backwards from artefacts a project may not have produced yet. Run one
early and it does not fail cleanly — it invents a confident, well-formed finding, and well-formed
findings get acted on.

Observed: L28 run whole against a pre-architecture strategy spec. Wedge, enemy and belief checks
found real gaps. The anti-feature check, which derives refusals from architecture, had no
architecture to read — so it asserted eight refusals ahead of the design that would justify them.

## Change

- **Rule 29** in `build-protocol-core.md` — four prerequisite classes, the report-as-"no inputs"
  discipline, and the requirement that partial-lens runs are recorded as partial.
- **`_selection-rubric.md`** — a check-level prerequisite table beneath the existing panel logic.
- **`L28-strategic-edge-wedge-sharpness.md`** — its four gated checks marked inline with what
  unlocks each, and which checks run at any stage.
- **D-013** in `decision-log.md`.

## Relationship to existing rules

| Rule | Sizes | Axis |
|---|---|---|
| 16 | ambition | capability → maturity stage |
| **29** | **audit** | **check → artefact state** |
| 28 | trust in a check | calibrate + regression-test before relying on it |

Rule 28 says *a check that cries wolf gets ignored*. Rule 29 adds the sharper failure: **a check
that invents gets obeyed.**

## Rollout

No migration. Applies from the next lens run. As the library grows, each new lens should mark its
gated checks in the same table form as L28.
