---
id: L28
name: Strategic Edge & Wedge Sharpness
band: 7
band_name: Strategic & Market
when_to_run: Always, when the product has any external positioning (paying customers, fundraising, public users, recruiting). Skip only for purely internal tools with no external surface. Mandatory before any positioning or fundraising milestone.
estimated_duration: 60-90 min — requires strategic reasoning, not just inspection
session_pattern: fresh session; reads L24 (Competitive Benchmarking) and L26 (Marketing/Copy) reports if available
output_markdown: audit-artifacts/L28-strategic-edge-wedge-sharpness-{YYYY-MM-DD}.md
output_json: audit-artifacts/L28-strategic-edge-wedge-sharpness-{YYYY-MM-DD}.json
source_frameworks:
  - April Dunford — 5-component positioning (Obviously Awesome) — https://www.aprildunford.com/post/a-quickstart-guide-to-positioning
  - Lochhead/Ramadan/Maney — Play Bigger category design — https://lochhead.com/power-of-a-point-of-view/
  - Karri Saarinen (Linear) — craft-as-moat, opinionated workflows — https://review.firstround.com/podcast/inside-linear-why-craft-and-focus-still-win-in-product-building/
  - Jason Fried / DHH — opinionated software, "if no one's upset" — https://signalvnoise.com/posts/646-jason-fried-discusses-highrise-red-flag-words-opinionated-companies-and-benevolent-dictators
  - Patrick Hanlon — Primal Branding (7 elements)
---

# L28 — Strategic Edge & Wedge Sharpness

## Question this lens answers

*Are we sharpening our strategic edge — or sanding it off?* Most audits force products toward "best-practice average." This one does the opposite. It asks whether the product is becoming *more* opinionated, *more* recognizable, *more* worth believing in over time — or whether convergence pressure is dulling the wedge.

## Why this lens exists / what other lenses miss

The audit-induced-mediocrity problem is real. Every other lens in this library catches gaps and recommends fixes. The cumulative effect is convergence — a product that's plugged every hole, adopted every best practice, addressed every user friction. That product is *competent and forgettable*. The history of category-defining products (Linear, Superhuman, Figma, Notion early, Things, Stripe, Tailwind, 37signals) shows the opposite pattern: sharp opinions, named enemies, anti-features, defensible style. Karri Saarinen on Linear: *"Productivity tools should have a point of view on how work should be done."* Linear didn't beat Jira on features — it beat Jira on conviction.

L24 (Competitive Benchmarking) asks the *outside-in* question: where do we win/lose vs alternatives. L28 asks the *inside-out* question: are we sharpening our edge or losing it? Both matter, and they often disagree. A product can be losing on feature comparison (L24) while winning on conviction (L28) — that's healthy. A product can be winning feature comparison while losing on conviction — that's the convergence trap.

This is the most philosophically distinctive lens in the library. It's also the one most likely to push BACK on findings from other lenses ("yes, L08 flagged this as friction — but the friction is intentional, it's part of our point of view, don't smooth it"). Run it last in any Curated panel that includes it.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — for products with any external positioning (paying customers, fundraising, public users, recruiting, partnerships).
- ✅ Mandatory — before fundraising, brand refresh, public launch, major-version positioning shift.
- ✅ Strongly recommended — quarterly check during the first 18 months of a product's life (convergence pressure is highest then).
- ⏸ Skip — purely internal tools with no external surface.

## Session setup

- Start a **fresh Claude Code session.**
- Read prior reports if available — L24 (Competitive Benchmarking) for the outside-in view, L26 (Marketing/Copy) for the voice/messaging surface, L02 (Spec Fidelity) for declared product intent.
- Inputs to load:
  - Product Spec — specifically any "intentional non-goals," anti-features, or "we believe" claims.
  - `decision-log.md` — load-bearing Reject decisions are wedge evidence.
  - Marketing surfaces — homepage, About page, founder essays, recent product posts.
  - The last 10 feature changes / PRs / release notes.
  - 3-5 competitor / category-leader products (open them, look at them).
- No tooling install required. This lens is strategic reasoning, not tool orchestration.

## Source frameworks

- **April Dunford — 5-component positioning** — competitive alternatives, differentiated capabilities, differentiated value, best-fit customers, market category. Order: start from alternatives, not from the product. https://www.aprildunford.com/post/a-quickstart-guide-to-positioning
- **Lochhead / Ramadan / Maney — Play Bigger category design** — POV defines the new space on your terms. "What you stand FOR and AGAINST." https://lochhead.com/power-of-a-point-of-view/
- **Karri Saarinen (Linear) — craft as a moat** — quality and opinion are the moat when feature parity is table stakes. https://review.firstround.com/podcast/inside-linear-why-craft-and-focus-still-win-in-product-building/ + https://www.figma.com/blog/karri-saarinens-10-rules-for-crafting-products-that-stand-out/
- **Jason Fried / DHH — opinionated software** — "If no one's upset by what you're saying, you're not pushing hard enough." Constraints unlock creativity. Anti-features as identity. https://signalvnoise.com/posts/646-jason-fried-discusses-highrise-red-flag-words-opinionated-companies-and-benevolent-dictators
- **Patrick Hanlon — Primal Branding** — 7 elements of belief systems: creation story, creed, icons, rituals, pagans (the enemy), sacred words, leader.

## Audit method

1. **Articulate the wedge in one sentence.** Before reading anything else, write the product's wedge — the sharp claim about what's broken in the category, what we believe, what we refuse to do, why we exist. Do this from memory / current understanding. If you can't articulate it in one sentence without hedging, that's already the finding.

2. **Identify the "old way" / named enemy.** What is this product replacing? If it's a vendor, name them. If it's a behavior pattern, name it. Products without a named enemy converge — there's no opposition to push against. Linear's enemy is Jira. Superhuman's enemy is Gmail's defaults. Stripe's was PayPal's developer experience. Tailwind's was Bootstrap's component lock-in. Name yours.

3. **Inventory existing opinionated defaults.** For each major workflow / interaction / interface choice, ask: is this an *opinion* (we chose this because we believe it's right) or a *neutral default* (we chose this because it was the standard / easiest)? Opinions are wedge-sharpening. Neutral defaults are convergence-vulnerable.

4. **Inventory the anti-feature list.** What does this product deliberately NOT do that competitors do? Where is the "we will never X" claim? An anti-feature list is the most concrete artifact of an opinionated product. If yours is empty, you don't have opinions — you have unfinished features.

5. **Detect convergence drift.** Look at the last 6-10 features shipped. For each, ask: would a category-converging competitor also ship this? If >50% are "yes, they'd ship it too," you're sanding off the edge with each release. Common pattern: shipping requested features that pull the product toward "what users say they want" (which is usually what they get elsewhere).

6. **Identify the recognizable signature.** Could a user identify this product from a screenshot with the logo cropped? What's the visual / interaction / copy signature? Linear has its keyboard-first vibe and Cycles. Superhuman has its keyboard shortcuts and toast notifications. Notion has the slash-command and infinite-canvas feel. Stripe has the developer-API-first aesthetic. What's yours?

7. **Check sacred words / owned vocabulary.** Do you own a noun or verb in your category? ("Slack me," "a Linear issue," "Notion page," "Loom it"). If your product's vocabulary is generic (tasks / projects / users / docs), you're not building category vocabulary — you're inheriting it.

8. **Sean Ellis inverse test.** Run the inverse PMF check: if this product disappeared tomorrow, would users be "very disappointed," "somewhat disappointed," or "not disappointed"? Very disappointed = wedge is strong. Somewhat = commodity territory. Not = the product is replaceable.

9. **Cult signal scan.** Do users put your logo on their laptop / homepage / Twitter bio? Do users wear your shirt? Does anyone tattoo your logo? (Tattoo is the extreme indicator — but the gradient matters. Stickers and merch are signals.) Cult signals indicate belief, not just utility. Lack of them indicates you're a tool, not a movement.

10. **Convergence-finding pushback pass.** Pull findings from L07 (Ease), L08 (Friction), and L09 (Wow) if those lenses ran. For each finding, ask: *is this friction / lack-of-wow intentional? Is it part of the wedge?* If yes, the L07/L08/L09 finding should be marked "intentional" rather than fixed. (Example: Vim's learning curve is friction by Ease standards and identity by L28 standards.)

## Check questions

1. Can you articulate the wedge in ONE sentence without hedging? Write it.
2. What do we believe about our category that 80% of competitors would publicly disagree with? Cite three claims.
3. Name the "old way" we're replacing. If it's a vendor, name them. If we can't name an enemy, what's our POV opposing?
4. What's in our anti-feature list this quarter? When did we last add to it (vs delete from it)?
5. Of the last 10 features shipped, how many would a category-converging competitor also ship? (>5 = sanding off.)
6. Could a user identify our product from a screenshot with logo cropped? What's the recognizable signature?
7. Which workflow do we *force* (Linear's Cycles, Things' Today inbox, Superhuman's keyboard-first)? What's ours?
8. Who explicitly is *not* our user — and have we said so publicly?
9. Do we own a noun or verb in our category?
10. Where in the last 6 months did a customer ask for X and we said no — and what was the strategic reason?
11. Sean Ellis inverse: if we disappeared, would users be "very disappointed" or merely inconvenienced?
12. What's our creation story — and does every employee tell the same version?
13. If a PM joined from a competitor tomorrow, what 3 product instincts would they have to *unlearn*?
14. Cult signal: do users put our logo on their laptop / tattoo / homepage? If no, we're a tool, not a belief.
15. Pull findings from other lenses (L07 Ease, L08 Friction, L09 Wow): how many of those flagged-as-fix findings are actually intentional and should be marked "do not fix — wedge"?

## Output schema

### Markdown report

```markdown
# L28 — Strategic Edge & Wedge Sharpness — {YYYY-MM-DD}

## Wedge articulation
**One-sentence wedge:** {written from memory at start of audit}
**Hedge density:** {how many qualifying clauses; lower is sharper}

## Named enemy / "old way"
**Named:** {Yes — {who/what} | No — gap}

## Three "we believe" claims
1. {claim}
2. {claim}
3. {claim}

## Opinionated defaults inventory
| Workflow / surface | Choice | Opinion or neutral default? | Rationale |
|---|---|---|---|

## Anti-feature list
| # | Anti-feature | Why we refuse it | When was this decided | Logged in decision-log.md? |
|---|---|---|---|---|

## Convergence drift check (last 6-10 features)
| Feature | Would converger competitor also ship? | Wedge-sharpening / wedge-neutral / wedge-dulling |
|---|---|---|

## Recognizable signature
**Visual / interaction / copy signature:** {1-paragraph}
**Logo-cropped screenshot test:** {Passes / Fails / Borderline}

## Owned vocabulary
| Term | Generic or owned? | Has the market adopted it? |
|---|---|---|

## Sean Ellis inverse signal
**If product disappeared:** {Very disappointed / Somewhat / Not}
**Source:** {survey / interviews / qualitative inference}

## Cult signal scan
| Signal | Observed? |
|---|---|
| Logo on laptop stickers | Yes / No / Unknown |
| Logo in Twitter/X bios | Yes / No / Unknown |
| Merch demand | Yes / No / Unknown |
| Tattoo | Yes / No / Unknown |

## Convergence-pushback on other lenses' findings
| Source lens & finding | Verdict | Rationale |
|---|---|---|
| L07-F003 "user confused by keyboard shortcuts on first run" | Do not fix — wedge | Keyboard-first is identity; tutorial yes, removal no |

## Top 3 wedge-sharpening opportunities
1. {what — specific}
2. ...
3. ...

## Top 3 wedge-dulling risks (changes that would sand off the edge if shipped)
1. {what — specific}
2. ...
3. ...

## Findings
{Full numbered list, severity-tagged, JSON-mirrored.}

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L28",
  "lens_name": "Strategic Edge & Wedge Sharpness",
  "run_date": "YYYY-MM-DD",
  "project": "{project name}",
  "schema_version": "1.0",
  "wedge_articulation": {
    "one_sentence": "{...}",
    "hedge_density": 0,
    "named_enemy": "{...}",
    "we_believe_claims": ["{...}", "{...}", "{...}"]
  },
  "opinionated_defaults_count": 0,
  "anti_features_count": 0,
  "convergence_drift_score": 0.0,
  "recognizable_signature": "{...}",
  "owned_vocabulary": [],
  "sean_ellis_inverse_signal": "very_disappointed|somewhat|not|unknown",
  "cult_signals_observed": 0,
  "pushback_on_other_lenses": [],
  "findings": [
    {
      "id": "L28-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "no_wedge|no_named_enemy|convergence_drift|no_opinionated_defaults|empty_anti_feature_list|generic_vocabulary|no_recognizable_signature|cult_signal_absence|wedge_dulling_change",
      "title": "{short}",
      "evidence": "{specific feature/copy/release/decision}",
      "strategic_impact": "{1-sentence}",
      "recommendation": "{1-sentence — wedge-sharpening, not feature-adding}"
    }
  ],
  "top_sharpening_opportunities": [],
  "top_dulling_risks": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Cannot articulate a wedge in one sentence without hedging. OR no named enemy. OR last 6-10 features are 100% wedge-neutral or wedge-dulling. Product is converging to category average; this is an existential strategic risk.
- **Major** — Wedge exists but is fading: convergence drift score >50%, empty anti-feature list, generic vocabulary across all major terms. OR a wedge-dulling change is currently in development that should be re-evaluated.
- **Minor** — Wedge is intact but under-communicated: signature exists but not surfaced in marketing, anti-feature list exists in founder's head but isn't documented, opinionated defaults aren't obvious to users.
- **Cosmetic** — Polish issues — wedge present, communicated, defended, but specific language could be sharper.

## Anti-patterns / Bias instructions

- **Do NOT recommend "soften the wedge to broaden appeal."** That is the failure mode this lens is designed to PREVENT. If a finding suggests the product is too sharp / niche / opinionated and would benefit from broader appeal, that's NOT an L28 finding — that's an L24 (Competitive Benchmarking) consideration where the user explicitly decides to broaden. L28 always biases toward sharpening.
- **Do NOT confuse 'opinionated' with 'inflexible.'** Opinionated software has strong defaults AND clear escape hatches. Linear forces Cycles as default but lets you skip them. Stripe's developer-first defaults assume APIs but support GUI. Sharpness without escape hatches is just stubborn.
- **Do NOT prescribe "name an enemy" as a marketing move.** Naming an enemy is a strategic position, not a copy choice. If the product hasn't truly decided what it's against, naming an enemy in marketing will read as posturing and damage trust.
- **Do NOT confuse niche with wedge.** A wedge is a sharp position on a *core* belief that the wider market may eventually adopt. A niche is a small market segment. Linear has a wedge (opinionated workflows) on a broad market (software teams). Confusing niche-thinking for wedge-thinking leads to under-ambition.
- **Bias toward "what would we refuse, even if the user asked for it?"** The strongest wedge-evidence is documented refusals. If `decision-log.md` is empty of Reject decisions, the product hasn't been sharpening — it's been accommodating.
- **Pushback findings on other lenses are legitimate and should be loud.** If L08 flagged the keyboard-only-onboarding as friction and L28 considers it wedge-evidence, L28 explicitly says "do not fix — wedge" and references the finding ID. The aggregation step (`_aggregation.md`) honors L28's pushback over the recommend-fix from earlier lenses.

## Stop conditions (the gap IS the finding)

1. **No external positioning exists.** Internal tool, library, backend service — L28 doesn't apply. Skip and note.
2. **Founder/team cannot or will not articulate a wedge.** That IS the finding. Write: *"Wedge cannot be articulated by the team in one sentence without hedging. This is not a marketing issue — it's a strategic identity gap. Recommend a positioning workshop (Dunford 5-component, Play Bigger POV, or both) before any further product-strategy decisions."* Do not invent a wedge for them.
3. **Product is too early to have shipped 6-10 features.** Run the lens but mark convergence-drift section as "N/A — insufficient release history; revisit in 6 months."
4. **No competitive context known.** L24 should have run first; if not, L28 partially runs — articulate the wedge, but skip the comparative drift section. Note the dependency.

## Cross-lens handoff

- **Upstream (lenses that should run BEFORE L28):**
  - **L24 Competitive Benchmarking** — provides the outside-in view L28 inverts.
  - **L26 Marketing, Copy & Website** — provides the voice/messaging surface L28 evaluates.
  - **L02 Spec Fidelity** — provides declared product intent.
  - **L07 / L08 / L09 (UX lenses)** — provide findings L28 may push back on.
- **Downstream (lenses that USE L28's output):**
  - **L25 Pricing & Monetization** — pricing strategy should reinforce the wedge, not undercut it. Free tiers, value metrics, and tier-naming all carry strategic signal.
  - **L26 Marketing, Copy & Website** — wedge clarity feeds copy sharpness. (L28 reads L26, but if L28 surfaces wedge insights L26 didn't have, L26 should re-run.)
  - **L27 Persona Simulation** — anti-user identification (who is NOT our user) is wedge-clarifying.
- **Adjacent lenses with intentional ~15% overlap:**
  - **L24 Competitive Benchmarking** — both look at the competitive surface, but L24 asks "where do we win/lose" (objective, market-comparative) and L28 asks "are we still us" (subjective, identity-coherent). Same data, opposite questions.
  - **L26 Marketing, Copy & Website** — both look at voice, but L26 is about clarity/consistency/SEO and L28 is about edge/conviction/opinion. A product can have great L26 marketing copy that's perfectly clear and perfectly forgettable; L28 catches that.
