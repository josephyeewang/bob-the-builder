# Bob Dogfood Retro — a data product build (2026-06-18)

> Anonymized record of the build that produced **v2.26 + v2.27** (Rules 15–21, lenses L35–L36, the Maturity-Stage axis, the Divergent-Ideation step, default-early coverage, the deferred-actions template). This is the canonical instance of Bob's **build → multi-frame retro → harvest-into-protocol** loop. Keep it: the *origins* matter more than the changelog one-liners. Product-specific detail has been removed; only the process lessons remain.

## What happened
A non-engineer (Joe, target persona) drove a complex AI analytical data product end-to-end through **NEW mode**. The Product Spec and Behavioral Core grew substantially over ~25 turns. We then **retro'd the build through multiple frames** (primary "what did the human patch", alternative frames, the AI-Forward lens, an unknown-unknowns sweep) AND incorporated **Joe's own written reflection** on "what I had to do that Bob should have done." Each gap was harvested back into the protocol.

## The meta-finding (why this matters)
**Joe surfaced ~every major improvement himself — and only because he'd done this 5-8× before.** Neither he nor the assistant flagged these as gaps *in real time*. Bob exists so a **first-timer reaches the expert's output**; every learning below is a place where, without an experienced human in the room, the build would have shipped meaningfully worse. *"Someone better than me would push even more — I don't know what I don't know"* → Rule 20.

## The learnings → the rules/lenses they became
| What the human had to do that Bob didn't | Became | How to detect it next time |
|---|---|---|
| Catch repeatedly that rigor/safety-caution/examples were **neutering the differentiating capability**; insist constraints live at the *communication* layer, vocabularies stay open, novelty isn't buried by validation, usefulness is felt | **Rule 15** + **L35 Capability Preservation** (functional complement to L28) | Trace boldest-case scenarios through the product's own guardrails; any guardrail that stops the product *doing* the valuable thing (vs. *saying* it carelessly) is a neuter |
| Cap ambition: a single-user tool got a heavyweight research stack while UX/GTM/data/ops starved | **Rule 16** + **Maturity-Stage axis** (orthogonal to Light/Standard/Heavy) | Tag each capability with the earliest stage that justifies it; beyond-stage depth is a flag |
| Call the consolidation himself after the spec went append-only & self-contradictory; notice audits ran only when *he* asked | **Rule 17** (executor self-interrupt: consolidation pass, proportionality flag, audit-cadence-push) | ~5 spec additions without a consolidation pass; audits that only ever run on request |
| **Expand the narrow idea** — the product grew only because the human kept adding adjacent capabilities; steal from competitors early; extract the moat (it emerged accidentally mid-build); sharpen the analysis | **Rule 18** + **Step 1a-pre+ Divergent Ideation** | The spec's scope equals the user's first sentence; the moat is not named in the first pass |
| Ask *"what screams AI-first?"* — the spec was a brilliant **pre-LLM** PM's spec (AI subordinated to engine+dashboard) | **Rule 19** + **L36 AI-Forward / AI-Native** | AI appears only as a feature bolted onto a conventional pipeline + dashboard |
| Push past his own knowledge — demand the unknown-unknowns | **Rule 20** (push harder than the user) | The user's stopping point is treated as the ceiling; the user not catching a gap is itself a red flag |
| Notice Bob **one-shot** the two foundational docs and sought approval-to-continue; *"if I didn't know better I'd have coasted through a 65th-percentile spec"* | **Rule 21** (don't one-shot Steps 1&2: program human-in-the-loop cycles + self-score + refuse to rush) | A first draft followed immediately by "approve to continue?" with no self-score |
| The boring 40% (UX/GTM/legal/data/ops) + ops basics (cost/silent-failure/observability) surfaced only in a *late* audit; modularity/layering he had to ask for | **default-early coverage** + **proactive-modularity Architecture prompt** | These areas absent from the spec at Step 1 |
| Re-invent a deferred-actions register out of necessity | **`templates/deferred-actions.md`** Tier-1 artifact | Parked items scattered across chat and notes |
| The best findings came from expert panels *he* had to think to staff (statistician, architect, competitive, growth) | **archetype-cast Independent Audit Panel** (Step 1c) | Only self-review ran; no fresh-context expert seats cast by product type |

## Process insights (how the loop ran well)
- **Fresh-context subagent panels** produced the sharpest findings — independent eyes beat self-review. The AI-Forward + unknown-unknowns pass (run AFTER several prior audits) still found many net-new, high-leverage items. *Independent audits are not optional polish; they are where the value is.*
- **The builder's reflection was higher-signal than any single audit** — Joe's short bullet-point reflection drove Rules 18–21 directly. Always solicit "what did you have to do that I should have done?"
- **Anti-rush is the master lesson (Rule 21).** Everything else (expand, push-harder, self-score, programmed cycles) is downstream of refusing to one-shot the foundations. The single behavior change with the most leverage: after each spec/core pass, *self-score honestly and propose more sharpening* instead of seeking approval to advance.

## How to repeat the loop (institutionalize it)
1. Build a real product through Bob (dogfood).
2. Retro through **multiple independent frames** (what-the-human-patched · alternative-frames · AI-Forward L36 · unknown-unknowns Rule 20) — fresh-context subagents.
3. **Solicit the builder's own reflection** explicitly.
4. Harvest each gap into a rule/lens/step/template with its **origin** recorded.
5. Dogfood-check, version-bump, changelog with provenance, commit.

*This retro is itself an output of step 4–5. v2.28+ should append the next dogfood's retro here.*
