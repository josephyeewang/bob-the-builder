---
id: L09
name: UX — Wow & Emotional Peaks
band: 2
band_name: User Experience
when_to_run: Products with human users (non-engineer audience). Skip for engineer-only / backend-only / library products. Mandatory before any consumer launch.
estimated_duration: 45-90 min — requires a journey walkthrough, not just code-reading
session_pattern: fresh session; reads L07 (Ease) and L08 (Friction) reports if available
output_markdown: audit-artifacts/L09-ux-wow-emotional-peaks-{YYYY-MM-DD}.md
output_json: audit-artifacts/L09-ux-wow-emotional-peaks-{YYYY-MM-DD}.json
source_frameworks:
  - Daniel Kahneman — Peak-End Rule (NN/g treatment) — https://www.nngroup.com/articles/peak-end-rule/
  - Chip & Dan Heath — "The Power of Moments" (peak categories — elevation, insight, pride, connection)
  - Tony Ulwick / Bob Moesta — JTBD emotional and social job layers — https://strategyn.com/jobs-to-be-done/
  - Nir Eyal — Variable Reward taxonomy (tribe / hunt / self)
  - DLL audit 2026-05-23 — empirical anchor for "spec-conforming but emotionally wrong" pattern
---

# L09 — UX: Wow & Emotional Peaks

## Question this lens answers

*Where are the delightful peaks in the user journey, and where are we missing emotional payoffs the product could deliver but doesn't?*

## Why this lens exists / what other lenses miss

L07 (Ease) checks whether users can navigate without frustration. L08 (Friction) checks where the product feels hostile. Both are about *avoiding negatives*. Neither asks *"where is there delight, surprise, pride, or connection — and where could there be?"*

This is the most operator-distinctive UX lens. Engineering audits never ask it. Even most UX audits stop at "is it usable" rather than "is it memorable." The Peak-End Rule (Kahneman) shows that users' overall experience is shaped disproportionately by peak moments and the ending — not the average. A product that's 70% functional but has one genuinely delightful moment and a satisfying ending will be remembered better than a product that's 95% smooth with no peaks. The DLL audit found one unspecced peak ("the emoji-ack path 👍✅ is legitimately delightful surprise nobody specced") — and a dozen *missed* peaks where the product could have surprised the user but didn't (no notification when memory decay protected them, no celebration at first-task completion, no shareable artifact after a useful query).

The complementary failure mode: **spec-conforming but emotionally wrong.** DLL's "Got it." confirmation works mechanically but lands cold on a user's first interaction. This lens names that pattern.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — for products with non-engineer users.
- ✅ Mandatory — before any consumer launch, public beta, or growth push.
- ✅ Strongly recommended — for AI products, where novelty/surprise is a structural advantage worth exploiting.
- ⏸ Skip — engineer-only, backend-only, internal API, or library products. (For those, the "user" is a developer and L23 Documentation & Onboardability is the analog.)

## Session setup

- Start a **fresh Claude Code session.**
- Read prior lens reports if available — specifically L07 (Ease & Cognitive Path) and L08 (Friction & Trust). These establish where the journey *works* and where it *hurts*; L09 layers on where it could *delight*.
- Open the product in the form a real user would use it — mobile if mobile-first, web if web-first, SMS if SMS-first. Do NOT audit only by reading code. This lens REQUIRES interacting with the live product.
- Have access to the Product Spec for the stated user-experience goals (delight claims, brand voice, target emotional tone).
- No tooling install required, but if the product is multi-device, audit on the primary form factor first, then secondary.

## Source frameworks

- **Peak-End Rule (Kahneman → NN/g)** — overall experience memory is shaped by peak intensity + ending sentiment, not average. https://www.nngroup.com/articles/peak-end-rule/
- **Heath brothers — "The Power of Moments"** — peaks come from four sources: elevation (sensory boost), insight (aha), pride (achievement recognition), connection (shared moment).
- **JTBD emotional/social layers (Ulwick, Christensen, Moesta)** — every functional job has emotional ("how I want to feel using this") and social ("how I want to be perceived using this") layers. Most products only design for functional. https://strategyn.com/jobs-to-be-done/
- **Variable Reward taxonomy (Eyal, Hooked)** — tribe (social rewards: recognition, belonging), hunt (resource rewards: information, items), self (mastery rewards: completion, progression). Peaks usually map to one of these three.
- **DLL audit (Joe Wang, 2026-05-23)** — empirical anchor. Found unspecced peak (emoji-ack) + many missed peaks (no first-task celebration, no Activity-ledger surfaces, no thank-you-for-trying-this moment).

## Audit method

1. **Map the user journey end-to-end.** Pick the single primary user journey (the most-frequent or most-strategic path). Sketch it in 8-15 steps from "user realizes they need this" through "user completes the value-receiving action." For each step, capture the *emotional state* you expect the user to be in (curious, hopeful, slightly anxious, satisfied, relieved, proud, etc.).

2. **Walk the journey live.** Open the product. Go through each step as the user would. At each step, note your actual emotional reaction. Compare to the expected emotion — gaps are findings.

3. **Score peak potential per step.** For each step, rate the current peak intensity (None / Mild / Moderate / Strong / Extraordinary) and the potential peak intensity (what the product *could* offer here if designed for it). The gap between current and potential is the peak opportunity.

4. **Identify the ending sentiment.** Specifically: what does the user feel at the moment they stop using the product this session? Pride? Relief? Frustration? Indifference? Endings have outsized weight in remembered experience. A great middle with a meh ending = meh memory.

5. **Inventory existing peaks.** Find every moment the product currently delights — onboarding surprises, micro-interactions, easter eggs, voice/copy moments, animations that reward an action, status messages that feel human. List them. The product probably has more peaks than the team knows about (DLL discovered the emoji-ack peak retroactively during audit).

6. **Inventory missed peaks.** For each journey step rated below "Strong," ask: what would turn this into a peak? Concrete suggestions, not platitudes. ("Add a celebration after first task" is platitude; "After the user's first completed task, send an SMS that names the specific task and adds 'You're 1 down. Most people get to 3 by the end of day 1.' — gives both pride and social-proof orientation" is concrete.)

7. **Map peaks to the four Heath categories.**
   - **Elevation** — sensory boost, breaking the script, moments that feel different from the routine.
   - **Insight** — aha, learning, sudden clarity.
   - **Pride** — accomplishment recognized, progress made visible.
   - **Connection** — shared moment, feeling seen, social bond.
   Most products over-index on one category and under-index on others. A balanced product has peaks across multiple categories.

8. **Check JTBD emotional + social layers.** For each major user action, ask: how does the user *want to feel* doing this? How do they *want to be perceived* (if anyone else sees)? Does the product help them achieve those emotional/social outcomes, or does it ignore them?

## Check questions

1. Have you mapped the primary user journey in 8-15 steps with expected emotional state at each step?
2. Have you walked the journey live (not just read code)?
3. For each step, what's the current peak intensity and the potential peak intensity? Where's the biggest gap?
4. What's the ending sentiment of a typical session — and is it the sentiment you'd want a user to leave with?
5. Have you found at least 1-3 *existing* peaks the team may not be tracking explicitly? (DLL had emoji-ack; what's your equivalent?)
6. Have you found at least 3 *missed* peaks where the product could deliver elevation/insight/pride/connection but doesn't?
7. Have you mapped peaks across all 4 Heath categories, or is the product peaking on only one (typically pride or insight, rarely connection or elevation)?
8. For each major user action, do you know how the user *wants to feel* — and does the product help them feel that way?
9. For products where users might be observed using them (in public, in front of colleagues), does the product help them be perceived as competent/savvy/discerning?
10. Are there moments where the product takes a beneficial action *for* the user but doesn't tell them — silently denying a chance for the user to feel grateful or impressed? (DLL pattern: auto-recovery, duplicate detection — invisible work that could have been a peak.)
11. Is there a "thank you for being here / for trying / for sticking with this" moment somewhere in the first week, or is the product purely transactional?
12. For AI products: when the AI does something impressive (catches a subtle thing, makes a connection the user didn't see), does the product *show* the impressive moment, or hide it behind a generic UI?
13. What's the single highest-leverage peak addition this product could ship in <1 week of engineering work?

## Output schema

### Markdown report

```markdown
# L09 — UX: Wow & Emotional Peaks — {YYYY-MM-DD}

## Journey map
| Step | What user does | Expected emotion | Observed emotion | Current peak intensity | Potential peak intensity |
|---|---|---|---|---|---|
| 1 | [action] | [emotion] | [emotion] | None/Mild/Moderate/Strong/Extraordinary | Same scale |

## Existing peaks (delights to protect)
| # | Peak | Where | Category (elevation/insight/pride/connection) | Why it works |
|---|---|---|---|---|
| 1 | Emoji-ack path 👍✅ | SMS reply | Connection + Insight | Feels casual, human, mirrors user's medium |

## Missed peaks (opportunities)
| # | Journey step | Current state | Proposed peak | Category | Effort | Priority |
|---|---|---|---|---|---|---|
| 1 | First task completion | "Got it." | Personalized confirmation that names the task + social-proof orientation | Pride + Connection | Low | High |

## Heath category coverage
| Category | Number of existing peaks | Number of opportunities | Imbalance? |
|---|---|---|---|
| Elevation | X | X | over/under-indexed? |
| Insight | X | X | |
| Pride | X | X | |
| Connection | X | X | |

## JTBD emotional/social audit
| Action | Functional job | Emotional job | Social job | Product addresses each? |
|---|---|---|---|---|
| [action] | [completion] | [feel competent] | [look organized to colleagues] | Yes/Partial/No |

## Ending sentiment audit
- **Default ending sentiment:** {your read}
- **Aspirational ending sentiment:** {what the brand voice/Product Spec implies it should be}
- **Gap:** {1-paragraph}

## Top 3 highest-leverage peak additions
1. **{Peak title}** — {what it is, where it goes, why it's the highest leverage, effort estimate}
2. ...
3. ...

## Findings
{Full numbered list, severity-tagged, JSON-mirrored.}

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L09",
  "lens_name": "UX: Wow & Emotional Peaks",
  "run_date": "YYYY-MM-DD",
  "project": "{project name}",
  "schema_version": "1.0",
  "journey_steps_mapped": 0,
  "existing_peaks_found": 0,
  "missed_peaks_identified": 0,
  "heath_category_balance": {
    "elevation": {"existing": 0, "opportunities": 0},
    "insight": {"existing": 0, "opportunities": 0},
    "pride": {"existing": 0, "opportunities": 0},
    "connection": {"existing": 0, "opportunities": 0}
  },
  "ending_sentiment_gap": "{1-sentence}",
  "findings": [
    {
      "id": "L09-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "missed_peak|spec_emotionally_wrong|silent_beneficial_action|category_imbalance|ending_sentiment_gap|existing_peak_undocumented",
      "title": "{short}",
      "journey_step": "{where}",
      "heath_category": "elevation|insight|pride|connection",
      "user_impact": "{1-sentence}",
      "recommendation": "{concrete, not platitude}",
      "effort_estimate": "low|medium|high"
    }
  ],
  "top_findings": ["L09-F001", "L09-F005", "L09-F007"]
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Spec-conforming-but-emotionally-wrong copy at a critical moment (first task, payment success, error recovery). The user finishes the moment feeling worse than they should, on a moment the product depends on. Also: ending sentiment is the *opposite* of what the brand voice implies it should be (Product Spec says "users feel in control" but actual ending leaves them feeling abandoned).
- **Major** — Missed peak at a high-frequency or high-strategic-importance moment (onboarding, first activation, key retention surface). Heath category imbalance where one category has 0 peaks and the product's emotional positioning depends on it.
- **Minor** — Missed peak at a lower-frequency moment, OR an existing peak that's not consistently delivered (works on web but not mobile, etc.).
- **Cosmetic** — Existing peak that could be amplified with low-effort polish (animation timing, micro-copy refinement).

## Anti-patterns / Bias instructions

- **Do NOT recommend "add an animation" or "add a celebration" as standalone findings.** Those are platitudes. Every recommendation must be specific: which moment, what specifically happens, what emotional payoff it serves, how it fits the brand voice.
- **Do NOT over-emote on findings.** This lens is the most subjective; don't oversell. A "missed peak" should reference a real Heath category and a real user moment, not a vague vibes-based wish.
- **Do NOT add peaks that violate the product's tone.** A serious-tool product (medical, legal, finance) should not be told to add Slack-style confetti. Match the peak to the voice.
- **Do NOT propose peaks that require infrastructure the product doesn't have.** "Add personalized celebrations using ML" when the product has no ML pipeline is not a finding — it's a wishlist item belonging in EVOLVE.
- **Do NOT re-litigate L07/L08 findings.** If L07 flagged a cognitive-path break, that's an Ease finding. L09 only takes journey steps where Ease/Friction are at least passable and asks "could this be delightful?" If the step is hostile, the upstream Ease/Friction work has to happen first.
- **Bias toward "what would a user remember 24 hours later?"** Peaks that don't survive 24 hours of memory are not peaks. Test each proposed peak against this filter.

## Stop conditions (the gap IS the finding)

1. **No live product to walk.** If the product isn't runnable yet, L09 cannot produce signal. Write: *"L09 not runnable. No live product to walk the journey on. Re-run when a usable prototype or staging URL exists."* Do not invent peaks from reading code alone.
2. **No human users in scope.** If the audience is engineers / backend / internal API / library, L09 doesn't apply. Defer to L23 Documentation & Onboardability (the analog for developer audience).
3. **Product Spec doesn't define brand voice or emotional positioning.** L09 can still run, but flag the gap — the lens's recommendations will be voice-uncalibrated and may suggest tone-wrong peaks. Surface the missing voice definition as a Spec Fidelity (L02) follow-up.

## Cross-lens handoff

- **Upstream (lenses that should run BEFORE L09):**
  - **L07 Ease & Cognitive Path** — establishes baseline navigability. Peaks on top of broken navigation are noise.
  - **L08 Friction & Trust** — flags hostile moments. Peaks at hostile moments aren't peaks.
  - **L02 Spec Fidelity** — provides brand voice and emotional positioning if specified.
- **Downstream (lenses that USE L09's output):**
  - **L26 Marketing, Copy & Website** — picks up tone consistency between product peaks and marketing voice.
  - **L29 Onboarding & Activation** — peak placement in the first session is high-leverage for activation.
  - **L30 Retention & Compounding Loops** — peaks at session end drive return.
- **Adjacent lenses with intentional ~15% overlap:**
  - **L08 Friction & Trust** — both look at emotional response, but L08 is about avoiding negatives, L09 is about adding positives. Same skill, opposite direction.
  - **L27 Persona Simulation** — L27 asks "what would a {persona} feel?" L09 asks "what feeling could the product evoke?" L27's findings can be inputs to L09's peak proposals.
