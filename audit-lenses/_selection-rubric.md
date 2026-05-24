# Selection Rubric — How Bob Picks the Curated Panel

> Bob proposes a 6-10 lens Curated panel based on project profile. User confirms or swaps lenses with one gate. Bob NEVER asks the user to pick lenses cold from a menu of 30 — that's a worse experience than picking from a curated 6-10 with rationale.

This document defines Bob's selection logic.

## Inputs Bob assesses silently

When AUDIT mode is invoked, Bob reads (silently — no questions):
1. `docs/build-manifest.md` — phase status, complexity classification
2. `docs/product-spec.md` — target audience, success metrics, monetization plan
3. `docs/architecture-contract.md` — observability plan, threat model, AI use, deployment posture
4. `audit-artifacts/audit-history.json` — what was audited before, when, what's still open
5. Code state — is it deployed? does it have a UI? does it have AI?

From these, Bob assesses **project profile dimensions**:

| Dimension | Values | How Bob detects |
|---|---|---|
| **Maturity** | greenfield / mid-build / launched / mature | Build Manifest phase status + git history |
| **Surface** | internal / private-beta / public | Product Spec target audience + deployment status |
| **Data sensitivity** | none / personal / regulated (health/finance/EU/children) | Product Spec data classification + L05 prior findings |
| **Product type** | CRUD / AI / infrastructure / methodology / library | Architecture Contract + repo composition |
| **Distribution** | web / mobile / SMS / API / multi-channel | Product Spec + deployment surfaces |
| **Monetization** | free / paid / mixed | Product Spec + pricing-page existence |
| **Has external positioning** | yes / no | Marketing surfaces exist? |
| **Has users today** | yes / no / pre-launch | Analytics or self-report |

## Pre-baked Curated panels (recommended starting points)

### Panel A — "Pre-launch consumer product" (DLL profile)
Use when: mid-build → launched, public, AI, personal data, web/SMS/multi-channel, has paid plan, real users.
Lenses (9): **L01, L02, L03, L04, L05, L07, L08, L10, L13**
Justification: foundation (L01-L03), security+privacy because user data (L04, L05), UX because non-engineer users (L07, L08, L10), AI safety because LLM in user flow (L13). Defers L09 Wow / L11-L12 / L14-L30 for next panel.

### Panel B — "Pre-launch B2B SaaS"
Use when: launched / mid-build, public, has paid plan, personal data, web, AI optional.
Lenses (10): **L01, L02, L03, L04, L05, L07, L10, L24, L25, L29**
Justification: foundation + risk + UX (L01-L10), plus competitive (L24), pricing (L25), activation (L29). Pricing matters more in B2B.

### Panel C — "Methodology / framework product" (Bob itself, Spec Kit, etc.)
Use when: methodology product, public, no PII, no AI runtime (just protocol docs).
Lenses (6): **L01, L02, L03, L23, L24, L28**
Justification: foundation, docs (L23), competitive (L24), and wedge (L28) because methodology products live by their wedge. Skip security/privacy/UX/AI lenses.

### Panel D — "Internal tool" (private, small audience)
Use when: internal, private, no monetization, low data sensitivity.
Lenses (3): **L01, L02, L03**
Justification: foundation only. Skip everything else until external positioning exists.

### Panel E — "Greenfield mid-spec"
Use when: NEW mode just finished spec phases, no code yet.
Lenses (0 — defer audit):
Justification: nothing to audit yet. Recommend resuming NEW mode build phases.

### Panel F — "Post-launch growth phase"
Use when: launched, has users, growth investment ongoing.
Lenses (8): **L01, L11, L14, L16, L24, L26, L29, L30**
Justification: foundation drift (L01), AI accuracy (L11), AI cost (L14 if AI), effectiveness (L16), competitive (L24), marketing (L26), activation (L29), retention (L30). Drops L02-L10 because spec/UX should be stable; assumes prior audit ran them.

### Panel G — "Pre-fundraise scrub"
Use when: any maturity, preparing for investor diligence.
Lenses (12): **L01, L02, L03, L04, L05, L15, L16, L22, L24, L25, L28, L29**
Justification: investor diligence covers (a) is the code real (L01-L03), (b) is the data handled correctly (L04-L05), (c) what are the economics (L15-L16, L25), (d) what's the moat (L24, L28), (e) what's the growth (L29). Often a "rocket launch" Full Enchilada is preferred here.

### Panel H — "Pre-public-launch scrub"
Use when: about to ship to public, consumer or B2B.
Lenses (14): **L01, L02, L03, L04, L05, L07, L08, L09, L10, L17, L19, L20, L25, L29**
Justification: comprehensive but not full — adds reach lenses (L17 mobile, L19 a11y, L20 share) plus pricing (L25) and activation (L29) that pre-launch B2B panel covers.

### Panel I — "Quarterly drift check"
Use when: live product, last audit >60 days ago.
Lenses (6): **L01, L04, L11, L15, L21, L24**
Justification: drift catchers — hygiene drifts, security drifts, AI accuracy drifts (model updates), cost drifts, observability rots, competitors evolve.

### Panel J — "Post-incident audit"
Use when: production incident just happened.
Lenses (5): **L01, L04, L10, L21, L22**
Justification: root-cause-adjacent lenses + observability + vendor risk (incidents often vendor-triggered).

## Selection algorithm

```
1. Read audit-history.json. If <30 days since last audit:
   - default recommend = Complementary panel (lenses NOT in last run)
   Else:
   - default recommend = Same panel (drift check) OR profile-matched panel

2. Match project profile to pre-baked panels A-J (best fit by maturity + surface + data + monetization + product type)
   - If exact match, recommend that panel
   - If partial match, propose closest panel + swap suggestions

3. Always offer:
   - Mode A: Curated (the proposed 6-10 lens panel)
   - Mode B: Full Enchilada (all 30)
   - Mode C: Custom (user specifies)

4. Present to user with:
   - Last audit date + what was run
   - Proposed panel + one-line justification per lens INCLUDED
   - One-line note for each lens EXCLUDED with why (~5-10 most relevant skipped lenses)
   - "Same / Complementary / Full / Custom" decision

5. Confirm with `→ HG` before running.
```

## Bob's entry narration template

When AUDIT mode fires, Bob says (paraphrasing):

> *"Last audit was **{N} days ago** ({date}). You ran **{mode — Curated panel / Full Enchilada}**: {lenses}. Result: {findings count} findings ({critical}/{major}/{minor}). **{open}** still open in audit-log.md.*
>
> *Based on the project profile ({profile keywords}), I'd recommend **{Panel X — N lenses}**: {lens list with one-line "why" each}.*
>
> *Lenses I'd skip this round (and why):
> - L{XX} {name} — {one-line: skip because {reason}}
> - ...*
>
> *Four options:*
> 1. **Same {Curated/Full}** — re-run the same N lenses, check what changed.
> 2. **Complementary Curated** — Bob picks N lenses you haven't run yet.
> 3. **Full Enchilada** — all 30, the rocketship-launch scrub.
> 4. **Custom** — tell me which lenses (by number or band).
>
> *Recommended this time: **{recommendation}**.*
>
> *Which?"*

After user picks → `→ HG`, then run.

## Sizing guidance

- Curated panel: 6-10 lenses typical. Less = under-coverage; more = panel sprawl (move to Full Enchilada instead).
- Full Enchilada: 30 lenses. Runtime: 1-3 hours of Claude work, often multi-session. Use for major-milestone scrubs.
- Custom: any number, but Bob warns if <4 (likely missing foundation) or >20 (likely should be Full Enchilada).

## When Bob should override the user

User chooses "Custom" but excludes L01 Hygiene & Liveness: Bob pushes back once — *"L01 is foundation; downstream lenses assume engineering-hygiene baseline. Are you sure? If you've recently run L01 separately, that's fine."*

User chooses "Custom" with only UX lenses: Bob notes *"Running UX-only is reasonable IF foundation has been audited recently. Last L01 was {date}; want to add it?"*

These soft overrides honor user intent while surfacing reasonable cautions.

## Updating this rubric

This file is updated whenever:
- A new pre-baked panel pattern emerges from real audit usage
- A lens is added to or removed from the library
- Bob's selection logic produces consistently wrong panels (track which panels users swap away from)

The audit-history.json includes a "swaps from recommended" field so this rubric improves over time based on real selection patterns.
