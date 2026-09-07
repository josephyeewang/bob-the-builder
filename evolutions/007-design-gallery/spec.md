# Evolution 007 — the Design-Gallery machinery (v2.38, Step 5.5)

**Date:** 2026-09-06 · **Origin projects:** InsiderIntent (D-312) + Explain My Blood Test (Sep-2026 redesign round)

## What this evolution adds

1. **`skills/design-gallery/`** — the umbrella capability: explore a product's look as a rated
   gallery → converge by feedback-by-number rounds + a live parameter playground → LOCK exact
   values → transfer to the real product under a mechanical fidelity protocol. Three lanes
   (HTML mockups / image comps via design-mockups / SVG logo board). Templates: the rating
   board, the playground controls bar, LOCKED-DESIGN, the fidelity protocol + CI token gate.
2. **Step 5.5 in NEW mode** (core + full protocol): Design Gallery & Lock, between the Build
   Manifest and Project Setup, HG'd on the lock; the fidelity protocol governs every visual
   build phase after it.
3. **design-mockups upgrades** (the EMBT Sep-2026 judging layer): stable canonical gallery
   numbering + number→ref resolution (the user's "#117" becomes a style-transfer ref without
   hand-typed paths), curated (★-themed + auto-Remainder) and keyword-grouped board modes,
   `reject` prune-not-delete, per-round boards, the negative-constraint prompt vocabulary and
   the overshoot-recover lesson, and `references/build-bridge.md` (comp→code handoff, motion
   stack, DESIGN.md layer — distilled from EMBT's METHODOLOGY.md).

## Why (the field evidence)

The gallery half of the arc worked on both origin projects. The TRANSFER half failed twice on
InsiderIntent (~70% re-creations), and the root-cause archaeology found one mechanism in every
incident: **a prose intermediary — spec text, a "done" note, a stale css header — stood in for
the mock file at a hand-off.** Drift also ran the OTHER way: mock sample content (a fake default
delta, a hardcoded ±40 legend) shipped inside components as chrome. Both incidents were rescued
only by founder-demanded adversarial audits. This evolution turns that rescue ritual into the
step's exit condition and adds hard gates (CI token gate, consumption count, mock-is-canonical
banners) so fidelity fails loudly instead of decaying silently.

## Design decisions

- **The machinery versions WITH Bob** (`skills/` in this repo, symlinked into `~/.claude/skills`)
  — the prior copy-install of design-mockups drifted within a week (gallery.py diverged); the
  symlink kills the replicated-and-drifted class for skills the way it already does for `bob`.
- **HTML mockups are the spec for product UI** — image comps explore cheaply but cannot transfer
  exactly; anything that must survive the transfer to code is mocked in HTML with `:root` tokens
  from file one.
- **Step 5.5 sits before the Pre-Build Review Gate** so the lock artifacts are part of the doc
  set the 6.5a machine audit reviews.
