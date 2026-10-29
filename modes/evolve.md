# PART IV: MODE — EVOLVE

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Adding features, changing behavior, fixing design-level bugs, or refactoring an existing product.*

### When to Use
- Adding a feature to a product that already follows this process
- Changing existing behavior (not just a bug fix — a design change)
- Refactoring that touches multiple subsystems
- Any change where you'd normally just type "what if we did X" into Claude Code

### Step E1: Classify the Change

| Size | Criteria | Process Steps |
|------|----------|---------------|
| **Small** | 1-3 files, no new concepts, no spec impact | E2 → E3 → E4 |
| **Medium** | 3-10 files, new behavior within existing subsystem, spec update needed | E2 → E3 → E4 → E5 |
| **Large** | New subsystem, architectural change, cross-cutting concern, or Behavioral Core change | E2 → E3 → E4 → E5 → E6 |

If unsure, classify one size up. Under-processing a Large change as Medium is how inconsistencies accumulate.

**Multiple concurrent changes:**

If the user requests 3+ changes simultaneously:
1. **Assess independence:** Are the changes independent (touch different subsystems, no shared data model changes) or interdependent (one change affects another)?
2. **Independent changes:** Run each as a separate sequential E1-E5/E6 flow. Complete one fully before starting the next. Order by: dependencies first, then highest-risk first.
3. **Interdependent changes:** Batch into a single evolution with combined scope. Classify the batch (the batch size is usually one tier above the largest individual change).
4. **If the batch would be Large AND touches 5+ subsystems:** This is no longer an evolution — it's a mini build. Create a Build Manifest with phases (like NEW mode Step 5) and execute as build phases with full [N]a/[N]b/[N]c cycles.

### Step E2: Spec Check

Before building anything:
- Read the relevant domain spec(s) for the area you're changing
- Read the Product Spec section that governs this capability
- Read the Behavioral Core (if this changes AI behavior)
- Read recent entries in decision-log.md (has a related decision already been made?)
- Determine: Does this change require spec updates? Which ones?

`→ HG (Medium/Large):` Present which specs are affected and what changes are anticipated

### Step E3: Plan

**E3-pre: Scoped Reference Scan (v2.16 — gated by size)**

Fires when:
- **Large** evolutions — always
- **Medium** evolutions that introduce a new subsystem, a new external integration, or a pattern not already in the codebase — always
- **Medium** evolutions that extend an existing pattern — skip (the pattern was already vetted at NEW Step 3a-pre)
- **Small** — skip

When it fires: run the same scan as NEW Step 3a-pre but scoped tightly to the *specific capability* being added. 3-5 reference repos, not 5-10. Harvest mechanisms with the same Adopt/Defer/Reject discipline and the same Reject-biased instruction.

**Output:** appended to `evolutions/{NNN-short-name}/reference-scan.md` (see folder structure below). Adopts feed into the Plan below; Rejects/Defers are logged so the same scan doesn't re-litigate them.

**Per-evolution folder (v2.16, borrowed from Spec Kit's `specs/{FEATURE-ID}/` pattern — see audit-log F33):** Medium and Large evolutions create `evolutions/{NNN-short-name}/` containing this evolution's spec-delta, plan, reference-scan (if applicable), and post-E5 reconciliation note. Number sequentially; short-name in kebab-case. This solves the "everything-about-evolution-7 is scattered across 4 docs" problem; the original docs in `docs/` remain the canonical full-state spec, but the per-evolution folder is the change-unit view. Small evolutions skip — overhead exceeds value.

**E3-main: Plan**

- List what files will change and why
- Identify downstream impacts (what else might break or need updating?)
- For Large changes: identify if new domain specs are needed
- For Behavioral Core changes: explicitly map the decision logic change
- For Medium+: write the plan into `evolutions/{NNN-short-name}/plan.md`

**Plan-mode hard gate (v2.16 — Medium+ only, borrowed from Cline's idiom — see audit-log F34):** For Medium and Large evolutions, the plan above MUST be drafted in Claude Code's plan mode. Switching out of plan mode is a named, deliberate transition into E4 (Execute). Do not slide from planning to editing implicitly — this is the moment most likely to leak scope creep, and naming the gate makes it visible. Small evolutions skip plan mode (overhead exceeds value).

`→ HG:` Human reviews plan, approves. For Medium+, approval is the explicit signal to leave plan mode and start E4.

### Step E4: Execute

- Build the change
- Type-check / build / run tests
- Commit working code

### Step E5: Reconcile (Medium + Large)

- Update affected domain spec(s) to reflect the change
- Update Build Manifest (add an evolution entry with date, description, affected subsystems)
- Log decision in decision-log.md if a non-obvious choice was made
- If this change affects the Behavioral Core: update it and flag for extra review

`→ HG:` Human reviews spec updates

### Step E6: Impact Audit (Large only)

- Check: did this change break assumptions in OTHER subsystems?
- Review adjacent domain specs for stale references
- Run targeted validation on affected areas
- If Behavioral Core changed: test adversarial scenarios against the new logic

`→ HG:` Present findings, fix issues

### Evolution Hardening Threshold

NEW mode has explicit hardening after all build phases. EVOLVE mode accumulates changes that can drift without a hardening check. To prevent silent accumulation:

**Trigger a targeted hardening pass when ANY of these conditions are met:**
- **5th Medium+ evolution** since the last hardening pass (count tracked in Build Manifest)
- **Any single evolution that touches 3+ subsystems**
- **Any evolution that modifies the Behavioral Core** (AI products)
- **6 months since last hardening pass** (calendar trigger)

**Targeted hardening scope (lighter than full NEW-mode hardening):**
1. **Security audit** — scoped to areas changed since last hardening
2. **Integration seam audit** — scoped to boundaries between changed and unchanged subsystems
3. **Spec-code consistency** — full walk of changed domain specs only
4. Fix findings, update Build Manifest with hardening date and scope.

Claude tracks the evolution count in the Build Manifest. When the threshold is approaching (evolution 4 of 5), Claude proactively flags: "This is evolution 4 since the last hardening pass. One more Medium+ evolution will trigger a targeted hardening. Consider scheduling it."
