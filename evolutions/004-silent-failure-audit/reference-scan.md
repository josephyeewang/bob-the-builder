# Reference Scan — Evolution 004

**Skipped as an external tool/library scan (E3-pre rule: Medium fires the scan only for a new subsystem/integration/pattern).** This evolution is not a new subsystem; it hardens two existing lenses with checks harvested from a *lived field retro*, which is the stronger reference than an external framework.

## The reference IS the field learning

Source: InsiderIntent D-267→271 (a real NEW-mode build dogfooding Bob). The defect classes + their catching-checks are documented in the target project's own decision log and audit docs, and mirror established practice:

- **Selection-on-outcome / regression-to-the-mean** → split-half & out-of-sample validation (standard in quantitative finance / ML model validation; already the spine of L32's SR 11-7 anchor — this adds the *specific* artifact + test).
- **Peak-seeking vs mode-seeking** → residualization / partial-effect analysis (subgroup discovery, bump-hunting).
- **Data lineage null-rate profiling** → column-level data-quality profiling (already in L31's source frameworks; this promotes it from "prove where a field goes" to "prove it's non-null at rest").
- **Aggregation-key completeness** → dimensional-modeling grain discipline (a group-by key must include every dimension that varies).

No new external dependency; the checks are runnable with the DB/query tools L31/L32 already drive.
