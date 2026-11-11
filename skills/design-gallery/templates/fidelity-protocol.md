# The Fidelity Transfer Protocol — mock → product, EXACTLY

The winning mock file is the canonical visual input. A summary, stale comment or approximate
specification can lose details at a handoff. Use this procedure for every visual build/restyle.

## The seven rules

### 1. Read the mock FILE first — prose is never a sufficient input
Open the winning mock and work from its literal CSS. LOCKED-DESIGN.md maps the decision to the
source file; it does not replace that file. A delegated task receives the source path and exact
transformation values, alongside the scope and constraints.

### 2. Mock CONTENT is not chrome
Sample figures, scales, charts and placeholder series illustrate the layout; do not ship them
as defaults. Every product figure must trace to actual approved data. Omit unavailable data
rather than filling it with an illustrative series. Clearly label fictional gallery content.

### 3. Components built ≠ design done — enforce CONSUMPTION
Check that intended product pages actually consume the tokens/components. Inventory each surface
and its imports; a completed component library alone does not establish a completed transfer.

### 4. Finish with an adversarial diff — value-level AND rendered
- Compare font families/weights/sizes, radii, colours and spacing against the mock's literal CSS.
- Inspect computed styles, not only class names: font configuration can substitute a different face.
- Render the actual page beside the mock and inspect differences using approved fictional/test data.
  Use available browser/screenshot tools. For protected surfaces, use an authorized test account or
  an explicitly approved isolated fixture; do not disable production authentication to get a screenshot.
- Use the production build for final review. Isolate its build/output directory from any dev server,
  and stop only a server process owned by this task. Verify the screenshot targets the intended build.
- Run both checks: matching style values does not establish correct data or actual rendered behavior.

### 5. Gate it in CI, and retire rival design descriptions
Adapt this illustrative token gate to the actual surface paths, lock and deliberate exceptions;
dry-run it before making it a required check:

```yaml
- name: Design-token gate (locked design — no off-lock radii or raw palette colors on user surfaces)
  run: |
    set -e
    TARGETS=$(git ls-files '<user-surface globs>' | grep -v '<owner/admin exemptions>' || true)
    BAD=0
    for pat in 'rounded-lg' 'rounded-xl' 'rounded-md' '(amber|emerald|rose|indigo|sky|teal|green|red|blue|orange|violet|fuchsia)-[0-9]{2,3}'; do
      HITS=$(echo "$TARGETS" | xargs grep -lnE "$pat" 2>/dev/null || true)
      if [ -n "$HITS" ]; then echo "OFF-LOCK STYLE ($pat) in:"; echo "$HITS"; BAD=1; fi
    done
    [ "$BAD" = "0" ] || { echo "The design is locked — tokens only (see LOCKED-DESIGN.md)."; exit 1; }
```

Update old stylesheet headers, READMEs and design summaries to point to the lock/mock instead of
restating obsolete values. Re-read the current source before styling; remembered values may be stale.
The gate checks selected literal patterns, not the whole design: keep the rendered review.

### 6. The reskin contract preserves information architecture
A visual restyle changes colour, borders, typography, radii, shadows and spacing. Existing content,
columns, groupings, order, labels and interaction depth remain unless the user approved a redesign.
Compare old and new surfaces. Restyle existing components in place where replacing them would lose
behavior or edge states. Consult the lock's pinned decisions and deliberate exceptions before
changing an intentional deviation.

### 7. Iteration hygiene — experiments must revert cleanly
- Keep experimental styling in a distinct removable layer rather than scattering overrides.
- On completion, check wrapper components, class swaps and overlays; retire unused experiment CSS.
- Keep gallery mockups separate from production files and review the diff before saving a round.
- Keep galleries unexposed by default. If they must be application routes, apply appropriate access
  controls and noindex; noindex alone does not protect confidential content. Exclude scratch captures
  from commits unless they are intentionally reviewed project artifacts.

## Task checklist
- [ ] Read the winning mock; use literal values rather than prose or memory.
- [ ] Keep sample content out of production defaults; trace every displayed figure to real data.
- [ ] Preserve the reskin contract and approved exceptions.
- [ ] Verify all intended pages consume the tokens/components.
- [ ] Complete value-level and rendered production-build comparisons, including computed fonts.
- [ ] Check the token gate and update obsolete design descriptions.
- [ ] Keep gallery/experiment files separate, revertible and appropriately private.
