---
id: L24
name: Competitive Benchmarking
band: 7
band_name: Strategic & Market
when_to_run: Products with external positioning. Mandatory before fundraising, major launch, or positioning shift. Quarterly during active growth.
estimated_duration: 60-120 min
session_pattern: fresh session
output_markdown: audit-artifacts/L24-competitive-benchmarking-{YYYY-MM-DD}.md
output_json: audit-artifacts/L24-competitive-benchmarking-{YYYY-MM-DD}.json
source_frameworks:
  - Bob's existing A7f-capability competitor scan
  - Bob's existing A7f-implementation mechanism scan (v2.16)
  - April Dunford 5-component positioning
  - Porter's Five Forces
  - Crossing the Chasm (Geoffrey Moore) — early-market vs mainstream
---

# L24 — Competitive Benchmarking

## Question this lens answers

*Versus the 3-5 closest alternatives users would consider, where do we win, where do we lose, and where are we indistinguishable?*

## Why this lens exists / what other lenses miss

This is the outside-in market view. L28 (Strategic Edge) is the inside-out view; both matter. L24 forces honest comparison — not "we're better" assertions, but feature-by-feature, surface-by-surface mapping. The mapping reveals: where we genuinely lead, where competitors have caught up, where we're behind, and where the market has converged (commoditization).

L24 evolves Bob's existing A7f-capability + A7f-implementation pattern (v2.16). The v2.16 dogfood meta-finding ("bias toward Reject, don't auto-import competitor features") still applies: this lens surfaces gaps, doesn't auto-route them to roadmap.

## When this lens fires

**Always-in-Full-Enchilada for externally-positioned products.** Curated panel inclusion criteria:
- ✅ Mandatory — before fundraising (investor diligence), before major positioning shift, before category-defining launch.
- ✅ Quarterly — during active growth (competitors evolve faster than internal docs).
- ⏸ Skip — purely internal tools with no competitive surface.

## Session setup

- Start a **fresh Claude Code session.**
- Inputs:
  - Product Spec § competitors (if listed)
  - `decision-log.md` (prior Adopt/Defer/Reject decisions)
  - Open competitor products in browser
  - Pricing pages, feature pages, docs of competitors
  - Industry analyst reports / G2 / Capterra reviews if applicable

## Source frameworks

- **Bob A7f-capability** — existing competitor capability scan with Adopt / Defer / Reject verdicts. https://build-protocol.md §A7f
- **Bob A7f-implementation** — mechanism scan on rejected competitors (v2.16) — for tools strategically Rejected, are there specific mechanisms worth borrowing?
- **April Dunford 5-component positioning** — competitive alternatives are the FIRST component. https://www.aprildunford.com
- **Porter's Five Forces** — supplier power, buyer power, substitutes, new entrants, rivalry.
- **Crossing the Chasm (Moore)** — early-market vs mainstream-market dynamics.

## Audit method

1. **Identify 3-5 closest alternatives.** Sources:
   - Products users mention in sales/support conversations
   - Tools users had open in another tab when they started using yours
   - "Alternatives to [your product]" search results
   - Adjacent categories with realistic switching distance
   - For methodology / framework products: published frameworks targeting the same outcome

2. **Build capability matrix.** Rows: capabilities. Columns: your product + each competitor. Include shipped + publicly-roadmapped. Avoid speculating about unannounced features.

3. **For each capability gap, decide:**
   - **Adopt** — meaningful gap, plan into next phase
   - **Defer** — gap but not urgent; revisit trigger logged
   - **Reject** — intentional non-goal; record reasoning in `decision-log.md`

4. **For each "you have, they don't" capability:**
   - Is it a real differentiator users care about?
   - Or a "happen-to-have" that costs more than it earns?
   - Differentiators get protected; happen-to-haves get pruned.

5. **Mechanism scan on Rejected competitors (v2.16 A7f-implementation pattern).**
   - For each tool you Reject at the positioning level, scan for specific mechanisms / file formats / workflow primitives worth borrowing.
   - Verdict per mechanism: Adopt-as-pattern (with insertion point) / Defer / Reject.
   - Bias toward Reject — convergence across tools is signal, not verdict.

6. **Pricing comparison.** Side-by-side pricing pages. Are you anchored or anchoring? What's the value-per-tier comparison?

7. **Positioning comparison.** For each competitor, capture their:
   - Hero claim (one sentence)
   - Stated ICP
   - Anti-positioning ("we are NOT X")
   - Brand voice signature
   Compare yours to theirs. Where do you sound the same?

8. **Convergence vs differentiation summary.**
   - Where has the category converged (everyone has X)?
   - Where do you genuinely differ?
   - What's at risk of converging next?

## Check questions

1. Have you identified 3-5 closest competitors / alternatives?
2. Has the capability matrix been built — shipped + publicly-roadmapped?
3. For each gap: Adopt / Defer / Reject verdict logged?
4. For each "happen-to-have" you ship: is it real differentiator or pruning candidate?
5. Has mechanism scan run on Rejected competitors (v2.16 A7f-implementation)?
6. Convergence signals identified (mechanisms shared by ≥3 competitors)?
7. Pricing positioning — anchored or anchoring vs alternatives?
8. Has competitor hero copy been captured? Where do you sound the same?
9. What's the category's convergence trajectory — where will it commoditize next?
10. Where are you genuinely differentiated today vs at risk of being copied?
11. Are competitor ICP claims overlapping yours, or distinct?
12. Are there adjacent-category competitors users could switch to that you haven't considered?
13. Bias toward Reject — does the output have ≤3 Adopts per 9 competitors scanned (~30% hit rate)?
14. Has the executive summary (gap / strength / over-built) been written?
15. Decisions logged in `decision-log.md` so they don't get re-litigated?

## Output schema

### Markdown report

```markdown
# L24 — Competitive Benchmarking — {YYYY-MM-DD}

## Closest alternatives identified
| # | Competitor | Why a substitute |
|---|---|---|

## Capability matrix
| Capability | Us | Comp A | Comp B | Comp C | Verdict (Adopt/Defer/Reject) | Notes |
|---|---|---|---|---|---|---|

## Convergence signals (mechanisms shared by ≥3 competitors)
{bullets}

## Mechanism scan on Rejected competitors
| Tool | Mechanism | Verdict | Insertion point | Rationale |
|---|---|---|---|---|

## Top 3 Adopts (ranked by leverage)
1. ...

## Pricing comparison
| Tier | Us | Comp A | Comp B | Comp C | Anchoring posture |
|---|---|---|---|---|---|

## Positioning comparison
| Competitor | Hero claim | ICP | Anti-positioning | Voice signature |
|---|---|---|---|---|

## Convergence vs differentiation summary
- **Most important gap:** {one line}
- **Most defensible strength:** {one line}
- **Most over-built area:** {one line}

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L24",
  "lens_name": "Competitive Benchmarking",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "competitors_scanned": 0,
  "capability_matrix_size": 0,
  "verdicts": {"adopt": 0, "defer": 0, "reject": 0},
  "convergence_signals_count": 0,
  "mechanism_adopts": 0,
  "differentiated_capabilities": [],
  "happen_to_have_pruning_candidates": [],
  "findings": [
    {
      "id": "L24-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "capability_gap_adopt|capability_gap_defer|capability_gap_reject|happen_to_have_prune|mechanism_borrow|positioning_overlap|pricing_anchored|category_convergence|adjacent_substitute_missed",
      "title": "{short}",
      "competitor": "{name}",
      "user_impact": "{1-sentence}",
      "recommendation": "{specific action}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Meaningful capability gap a Reject-Customer would name as deal-breaker. Convergence has caught up on stated differentiator.
- **Major** — Adopt-worthy capability gap. Mechanism worth borrowing. Pricing severely anchored vs alternatives.
- **Minor** — Defer-worthy gap. Positioning overlap (sound like a competitor in hero copy).
- **Cosmetic** — Documentation of competitor inventory.

## Anti-patterns / Bias instructions

- **Do NOT auto-route gaps to roadmap.** Adopt verdicts require explicit human review and capacity check. The lens surfaces; the team decides.
- **Do NOT inflate competitor capabilities by speculating about unannounced features.** Only count shipped + publicly-stated roadmap.
- **Do NOT score everything as Adopt.** Bias toward Reject — convergence is signal, not verdict (v2.16 dogfood meta-finding).
- **Do NOT confuse "feature parity" with strategy.** Some gaps you should keep. The wedge audit (L28) often vetoes Adopt verdicts here.

## Stop conditions

1. **No external positioning.** Skip.
2. **Cannot access competitor products.** Document gap; partial audit only.

## Cross-lens handoff

- **Upstream:** None.
- **Downstream:** L28 Strategic Edge & Wedge (uses L24's gaps to inform sharpening decisions), L25 Pricing (benchmarking feeds pricing).
- **Adjacent (~15% overlap):**
  - **L28** — both look at competitive surface; L24 outside-in, L28 inside-out.
  - **L25** — pricing comparison overlaps.
