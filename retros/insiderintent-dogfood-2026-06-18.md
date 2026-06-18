# Bob Dogfood Retro — the InsiderIntent build (2026-06-18)

> High-fidelity record of the build that produced **v2.26 + v2.27** (Rules 15–21, lenses L35–L36, the Maturity-Stage axis, the Divergent-Ideation step, default-early coverage, the deferred-actions template). This is the canonical instance of Bob's **build → multi-frame retro → harvest-into-protocol** loop. Keep it: the *origins* matter more than the changelog one-liners.

## What happened
A non-engineer (Joe, target persona) drove a complex AI analytical product — **InsiderIntent**, an insider-trading-signals platform — end-to-end through **NEW mode**. The Product Spec went from C1–C8 to ~20 capabilities + 6 substrates across ~25 turns; the Behavioral Core grew to 10 AI surfaces + 18 NEVER / 17 ALWAYS. We then **retro'd the build through multiple frames** (primary "what did the human patch", alternative frames, the AI-Forward lens, an unknown-unknowns sweep) AND incorporated **Joe's own written reflection** on "what I had to do that Bob should have done." Each gap was harvested back into the protocol.

## The meta-finding (why this matters)
**Joe surfaced ~every major improvement himself — and only because he'd done this 5-8× before.** Neither he nor the assistant flagged these as gaps *in real time*. Bob exists so a **first-timer reaches the expert's output**; every learning below is a place where, without an experienced human in the room, the build would have shipped meaningfully worse. *"Someone better than me would push even more — I don't know what I don't know"* → Rule 20.

## The learnings → the rules/lenses they became (with origins)
| What the human had to do that Bob didn't | Became |
|---|---|
| Catch ~5× that rigor/safety-caution/examples were **neutering the differentiating capability**; insist constraints live at the *communication* layer, vocabularies stay open, novelty isn't buried by validation, usefulness is felt | **Rule 15** + **L35 Capability Preservation** (functional complement to L28) |
| Cap ambition: a single-user tool got a fund-grade R&D stack while UX/GTM/data/ops starved | **Rule 16** + **Maturity-Stage axis** (orthogonal to Light/Standard/Heavy) |
| Call the consolidation himself after the spec went append-only & self-contradictory; notice audits ran only when *he* asked | **Rule 17** (executor self-interrupt: consolidation pass, proportionality flag, audit-cadence-push) |
| **Expand the narrow idea** — the platform exists only because Joe kept adding adjacent capabilities/signals; steal from competitors early; extract the moat (it emerged accidentally ~15 turns in); sharpen the analysis | **Rule 18** + **Step 1a-pre+ Divergent Ideation** |
| Ask *"what screams AI-first?"* — the spec was a brilliant **pre-LLM** PM's spec (AI subordinated to engine+dashboard) | **Rule 19** + **L36 AI-Forward / AI-Native** |
| Push past his own knowledge — demand the unknown-unknowns (capacity-vs-virality, causal/placebo, adversary model, rule-regime PIT, net-edge-inventory) | **Rule 20** (push harder than the user) |
| Notice Bob **one-shot** the two foundational docs and sought approval-to-continue; *"if I didn't know better I'd have coasted through a 65th-percentile spec"* | **Rule 21** (don't one-shot Steps 1&2: program human-in-the-loop cycles + self-score + refuse to rush) |
| The boring 40% (UX/GTM/legal/data/ops) + ops basics (cost/silent-failure/observability) surfaced only in a *late* audit; modularity/layering he had to ask for | **default-early coverage** + **proactive-modularity Architecture prompt** |
| Re-invent a `deferred-actions.md` register out of necessity | **`templates/deferred-actions.md`** Tier-1 artifact |
| The best findings came from expert panels *he* had to think to staff (quant/statistician, architect, competitive, growth) | **archetype-cast Independent Audit Panel** (Step 1c) |

## Process insights (how the loop ran well)
- **Fresh-context subagent panels** produced the sharpest findings — independent eyes beat self-review. The AI-Forward + unknown-unknowns pass (run AFTER 5 prior audits) still found 9 net-new, high-leverage items. *Independent audits are not optional polish; they are where the value is.*
- **The builder's reflection was higher-signal than any single audit** — Joe's 8 bullet-point reflection drove Rules 18–21 directly. Always solicit "what did you have to do that I should have done?"
- **Anti-rush is the master lesson (Rule 21).** Everything else (expand, push-harder, self-score, programmed cycles) is downstream of refusing to one-shot the foundations. The single behavior change with the most leverage: after each spec/core pass, *self-score honestly and propose more sharpening* instead of seeking approval to advance.

## How to repeat the loop (institutionalize it)
1. Build a real product through Bob (dogfood).
2. Retro through **multiple independent frames** (what-the-human-patched · alternative-frames · AI-Forward L36 · unknown-unknowns Rule 20) — fresh-context subagents.
3. **Solicit the builder's own reflection** explicitly.
4. Harvest each gap into a rule/lens/step/template with its **origin** recorded.
5. Dogfood-check, version-bump, changelog with provenance, commit.

*This retro is itself an output of step 4–5. v2.28+ should append the next dogfood's retro here.*
