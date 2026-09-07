# The Fidelity Transfer Protocol — mock → product, EXACTLY

The whole point of a gallery lock is that the winning mock transfers to the real product
verbatim. Twice on InsiderIntent it didn't: the transfer degraded into re-creation-from-prose
and shipped a ~70% approximation. The root-cause archaeology (D-312, receipts in that repo's
decision log) found one mechanism behind every incident: **a prose intermediary — a spec doc,
a summary, a stale code comment — stood in for the mock file at a hand-off.** This protocol
makes the fix mechanical. Follow it for EVERY task that touches user-facing visuals.

## The five rules

### 1. Read the mock FILE first — prose is never a sufficient input
Before writing or restyling any surface, open the winning mock (`designs/NN-*.html`) and work
from its literal CSS. LOCKED-DESIGN.md is a *map*, not a source. If you're delegating,
hand the subagent the mock file path + literal transformation values — a delegated sweep with
literal rules holds fidelity; a delegated sweep with a summary drifts (both observed).

### 2. Mock CONTENT is not chrome
The mock's sample numbers, fake axis scales, decorative sparklines, and placeholder series are
CONTENT — they exist to make the mock look real. They never port into components as defaults or
hardcodes. Observed failures of this inverse class: a KPI component shipping a fabricated
default delta ("▲ +0.06" nobody passed), a heatmap legend hardcoded to the mock's "±40" while
rendering real ±$90B data. Every displayed figure in the product must trace to real data;
where no honest data series exists yet, OMIT the element and note it as a deferred upgrade —
never fake it.

### 3. Components built ≠ design done — enforce CONSUMPTION
A faithful component library that no page imports is a shelved design (InsiderIntent's sat at
3-of-20 pages for six weeks while a "design complete" note stood in a tracking doc). A design
phase closes only when the real surfaces consume the tokens/components — check it as a number
(`grep -cl` the component dir across pages), not a feeling.

### 4. Finish with an adversarial diff — value-level AND rendered
- **Value diff:** element by element, compare your output's fonts/weights/sizes/radii/colors/
  spacing against the mock's CSS. Assume you drifted; hunt for it.
- **Rendered diff:** screenshot the REAL page (real data) next to the mock and compare.
  Headless Chrome needs no tooling:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=out.png
   --window-size=1280,1700 --hide-scrollbars --virtual-time-budget=25000 <url-or-file>`
  For an auth-gated app, look for a single-user/no-auth dev mode (e.g. start dev with the auth
  env var emptied) rather than skipping the check. Two traps: never run a production build
  while the dev server shares its build dir (it poisons the running server), and kill dev
  servers by port (`lsof -ti :PORT | xargs kill`), or your screenshot hits a stale process.
- The rendered diff catches a different defect class than the value diff (rule-2 violations
  only show up rendered). Run BOTH. On InsiderIntent the pair caught 9 real drifts a green
  build sailed past.
- **Review the PRODUCTION build, not the dev server.** Dev-mode hot-reload CSS is unreliable
  (observed: Turbopack + Tailwind v4 intermittently dropping utility classes between
  recompiles, so the design "reverted" mid-review — InsiderIntent D-091). When a visual looks
  wrong, `npm run build && npm run start` (or your stack's equivalent) is the source of truth
  before you debug anything.

### 5. Gate it in CI, and kill counterfeit SSOTs
- **CI token gate** (~10 lines): fail the build when off-lock radii or raw framework palette
  literals appear on user surfaces. Adapt:

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
  (On its first dry run at InsiderIntent it caught three components inside the already-"audited"
  design-system library.) Dry-run locally and fix hits BEFORE adding the gate.
- **Counterfeit SSOTs:** any comment or doc that *describes* the design becomes a rival source
  the moment it's stale — InsiderIntent's global stylesheet header still said "Robinhood-style,
  white" seven weeks after the lock, mis-briefing every session that opened it. When you lock,
  grep for prior design self-descriptions (css headers, READMEs, old spec sections) and rewrite
  them to point at the mock.

## Task checklist (paste into any visual task)
- [ ] Opened the winning mock file; worked from its literal CSS
- [ ] No mock sample content ported as defaults/hardcodes; every figure traces to real data
- [ ] Real pages consume the tokens/components (count it)
- [ ] Value-level adversarial diff done
- [ ] Rendered screenshot diff done (real page, real data)
- [ ] CI token gate passing; no new counterfeit design descriptions introduced
