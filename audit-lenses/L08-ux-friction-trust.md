---
id: L08
name: UX — Friction & Trust
band: 2
band_name: User Experience
when_to_run: Products with human users. Mandatory for consumer products, products handling money/data, AI products.
estimated_duration: 45-90 min — requires walking the live product
session_pattern: fresh session; reads L07 (Ease) report if available
output_markdown: audit-artifacts/L08-ux-friction-trust-{YYYY-MM-DD}.md
output_json: audit-artifacts/L08-ux-friction-trust-{YYYY-MM-DD}.json
source_frameworks:
  - Friction Log methodology (Google DX) — https://sites.research.google/datacardsplaybook/activities/friction-log-template.pdf
  - Brignull's 12 Dark Patterns — https://www.deceptive.design/types
  - Bob's existing A7h UX Friction audit
  - NN/g content audit methodology
  - DLL audit 2026-05-23 — silent system actions, spec-conforming-but-emotionally-wrong patterns
---

# L08 — UX: Friction & Trust

## Question this lens answers

*Where does the product feel hostile, manipulative, jargon-y, or untrustworthy to the user — and where is trust silently eroded by patterns the team hasn't named?*

## Why this lens exists / what other lenses miss

L07 catches cognitive-path failures (user can't figure out what to do). L08 catches a different class: cases where the user CAN figure out what to do but the interaction feels bad. Silent auto-collapses that hide what happened. Friction stacks that make cancellation harder than signup. Dark patterns that nudge users toward outcomes they didn't intend. Copy that hides behavior or implies more than it delivers. The DLL audit caught this pattern explicitly: "duplicate detection auto-collapses with zero user signal"; "recommendation appends attach invisibly"; "engagement scoring front-loaded — reads as empty when user has 0 completions."

Trust is the long-tail compounding asset for any user-facing product. A single hostile pattern can erase months of earned trust. L08 surfaces them before users do.

## When this lens fires

**Always-in-Full-Enchilada for human-facing products.** Curated panel inclusion criteria:
- ✅ Mandatory — consumer products, products handling money/data/identity, AI products.
- ✅ Strongly recommended — any product with a paid tier (pricing pages and cancel flows attract dark patterns).
- ⏸ Skip — engineer-only / backend / library products.

## Session setup

- Start a **fresh Claude Code session.**
- Read L07 (Ease) report if available — friction findings often share root cause with cognitive-path findings.
- Walk the live product, especially cancel flows, payment flows, settings, deletion, opt-out paths.
- Have access to copy across all surfaces (marketing, in-product, emails, error messages, system messages).

## Source frameworks

- **Friction Log methodology (Google DX)** — record per-step: scenario, expected vs actual behavior, thought process, delights, pain points. https://sites.research.google/datacardsplaybook/activities/friction-log-template.pdf
- **Brignull's 12 Dark Patterns** — Hidden costs, Forced continuity, Confirmshaming, Roach motel (easy in / hard out), Privacy Zuckering, Trick questions, Sneak into basket, Disguised ads, Bait & switch, Misdirection, Friend spam, Price comparison prevention. https://www.deceptive.design/types
- **Bob's existing A7h UX Friction** — friction = "user working for the product, not for the outcome."
- **DLL audit (Joe Wang, 2026-05-23)** — silent-system-actions and spec-conforming-but-emotionally-wrong patterns.

## Audit method

1. **Build a friction log for the primary journey.** Walk it step by step. Per step: what the user expects, what actually happens, where there's hesitation / re-reading / "wait what just happened."

2. **Scan for the 12 dark patterns.** For each, check whether the product has any instances:
   - **Hidden costs** — costs revealed only at the end
   - **Forced continuity** — auto-renewal without clear notice
   - **Confirmshaming** — "No thanks, I don't want to save money"
   - **Roach motel** — easy to sign up, hard to cancel
   - **Privacy Zuckering** — tricked into sharing more data
   - **Trick questions** — confusing double-negatives in opt-in/opt-out
   - **Sneak into basket** — items added without consent
   - **Disguised ads** — ads styled as content
   - **Bait & switch** — action does something different than expected
   - **Misdirection** — attention drawn away from important info
   - **Friend spam** — contact list misuse
   - **Price comparison prevention** — different units/units obscuring comparison

3. **Silent system actions audit.** For every action the product takes WITHOUT user awareness — auto-collapses, auto-recovery, default-applies, hidden filters, implicit logging — ask: is the silence appropriate? When the user discovers later, will they feel respected or violated?

4. **Asymmetric friction audit.** Compare paired flows: signup vs cancel. Free vs paid. Opt-in vs opt-out. Subscribe vs unsubscribe. Are the harder flows ones that benefit users, or ones that benefit the company at user expense?

5. **Spec-conforming-but-emotionally-wrong audit.** Walk error messages, confirmations, status messages. Each one functionally correct? Each one emotionally appropriate? "Got it." on a user's first task vs after their 50th — same words, very different feel.

6. **Content audit for trust-eroding language.** Jargon, weasel words ("may," "could," "in some cases"), unspecific claims ("up to 80% faster"), passive voice on responsibility ("your account was charged" not "we charged your account").

7. **Trust signal inventory.** For consumer + financial + AI products specifically: where are the trust signals (security badges, privacy clarity, real-name attribution, transparency, audit trails)?

## Check questions

1. Have you walked the journey and logged friction at every step (with severity)?
2. Have you scanned for instances of each of the 12 Brignull dark patterns?
3. Are there silent system actions the user would feel violated by if they noticed?
4. Is cancel-flow as easy as signup-flow (FTC Click-to-Cancel + general trust)?
5. Is opt-out as easy as opt-in?
6. Are there asymmetric frictions that favor the company at user expense?
7. Are error/system messages emotionally appropriate, or just functionally correct?
8. Is there weasel-word language ("may," "up to," "in some cases") that hides real behavior?
9. Are there places where passive voice obscures responsibility?
10. For AI products: is "AI may be wrong" communicated clearly without scaring users away?
11. Are trust signals present at moments where the user is making a high-stakes decision (payment, data sharing, deletion, account creation)?
12. Is there confirmshaming language anywhere ("No thanks, I don't want to be productive")?
13. Are price displays comparable across plans / competitors?
14. Are auto-renewal terms visible before signup, not after?
15. Are notifications opt-in by default vs opt-out?

## Output schema

### Markdown report

```markdown
# L08 — UX: Friction & Trust — {YYYY-MM-DD}

## Friction log
| Step | Expected | Actual | Friction level | Severity |
|---|---|---|---|---|

## Dark pattern scan (12 categories)
| Pattern | Instances found | Severity |
|---|---|---|

## Silent system actions
| Action | Where | Visibility to user | Recommendation |
|---|---|---|---|

## Asymmetric friction
| Paired flow | Easier side | Effort gap | Benefit (user/company) |
|---|---|---|---|

## Spec-conforming-but-emotionally-wrong
| Where | Message | Why it lands wrong | Replacement |
|---|---|---|---|

## Trust-eroding language
| Surface | Phrasing | Weasel / passive / jargon / unspecific | Replacement |
|---|---|---|---|

## Trust signal inventory at high-stakes moments
| Moment | Trust signal present? | What kind |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L08",
  "lens_name": "UX: Friction & Trust",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "friction_log_steps": 0,
  "dark_patterns_found": {
    "hidden_costs": 0,
    "forced_continuity": 0,
    "confirmshaming": 0,
    "roach_motel": 0,
    "privacy_zuckering": 0,
    "trick_questions": 0,
    "sneak_into_basket": 0,
    "disguised_ads": 0,
    "bait_and_switch": 0,
    "misdirection": 0,
    "friend_spam": 0,
    "price_comparison_prevention": 0
  },
  "silent_actions_count": 0,
  "asymmetric_frictions_count": 0,
  "findings": [
    {
      "id": "L08-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "friction_stack|dark_pattern|silent_action|asymmetric_friction|emotionally_wrong|weasel_language|missing_trust_signal|confirmshaming|hidden_cost|forced_continuity|roach_motel",
      "title": "{short}",
      "evidence": "{specific UI / copy / flow}",
      "user_impact": "{1-sentence}",
      "trust_cost": "high|medium|low",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Active dark pattern (confirmshaming, forced continuity without clear notice, roach motel cancel-flow). Silent action with material trust cost (auto-charge, auto-share, auto-collect data without consent).
- **Major** — Asymmetric friction favoring company (cancel harder than signup). Spec-conforming-but-emotionally-wrong copy at a critical moment (payment confirmation, error during first use).
- **Minor** — Weasel language. Missing trust signal at moderate-stakes moment. Inconsistent friction within similar-importance flows.
- **Cosmetic** — Tone polish opportunities; copy that's neutral but could be warmer.

## Anti-patterns / Bias instructions

- **Do NOT excuse a dark pattern as "industry standard."** "Everyone does it" doesn't make confirmshaming acceptable. If a competitor uses dark patterns, that's a wedge opportunity (L28), not a justification.
- **Do NOT recommend "remove the friction" without thinking about which side benefits.** Some friction protects the user (irreversible action confirmations). Find user-protecting friction and keep it.
- **Do NOT over-recommend warmth.** A serious tool can be cold and still trustworthy. The fix to "spec-conforming-but-emotionally-wrong" is appropriateness, not friendliness.
- **Bias toward "what would happen if a regulator / journalist / Twitter user found this?"** Dark patterns are increasingly publicly shamed.

## Stop conditions

1. **No live product.** Cannot walk friction log. Skip and note.

## Cross-lens handoff

- **Upstream:** L07 Ease (cognitive failures often = friction).
- **Downstream:** L09 (peaks after friction is reduced), L28 (some friction is wedge, not bug).
- **Adjacent (~15% overlap):**
  - **L26 Marketing/Copy** — both look at copy; L26 catches contradictions/SEO, L08 catches emotional/trust.
  - **L25 Pricing & Monetization** — dark patterns concentrate in pricing/cancel flows; L08 catches dark-pattern instances, L25 evaluates pricing strategy holistically.
