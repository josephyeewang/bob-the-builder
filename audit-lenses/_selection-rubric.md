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
Lenses (9, +3 conditional): **L01, L02, L03, L04, L05, L07, L08, L10, L13** — add **L31** (user data fans out to features), **L32** (LLM/algorithm produces a score/diagnosis/recommendation), **L33** (non-technical audience reads generated output).
Justification: foundation (L01-L03), security+privacy because user data (L04, L05), UX because non-engineer users (L07, L08, L10), AI safety because LLM in user flow (L13). The three v2.21 conditionals fire hard for this profile — a consumer AI product with personal data is the exact case L31/L32/L33 were built for. Defers L09 Wow / L11-L12 / L14-L30 for next panel.

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

### Panel K — "Production / launched scrub" (DEFAULT for live solo-dev projects) (v2.19)
Use when: launched, has real users, solo or small team, and you want depth WITHOUT the risk of a 34-lens Full Enchilada (see caution below).
Lenses (12, +3 conditional): **L01, L04, L05, L07, L09, L10, L11, L13, L16, L17, L19, L21** — add **L31** (if user-data fans out to downstream features), **L32** (if there's an analytical/diagnosis/recommendation engine), **L33** (if generated output is read by a non-technical audience).
Justification: foundation + liveness + deploy-verify (L01), security + privacy because real user data (L04, L05), the UX journey + peaks + edge/recovery (L07, L09, L10), AI accuracy + safety (L11, L13), what's actually working (L16), mobile + a11y because public (L17, L19), and operability (L21). Origin: an EMBT Full Enchilada retro found these 12 would have caught **14 of 15** closed Criticals — the strategic/growth lenses (L24-L30) and the half-covered ones (L25) added the most noise and the least new signal. This is the recommended production default; reach for Full Enchilada only at the milestones below. **Note (v2.21):** the 14-of-15 tuning predates L31–L33 — those three target gaps the empirical run *couldn't* have surfaced (data-propagation completeness, method soundness, output register), and the EMBT profile that produced Panel K is exactly the profile they were built for, hence their conditional inclusion here.

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
   - Mode B: Full Enchilada (all 34)
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
> 3. **Full Enchilada** — all 34, the rocketship-launch scrub.
> 4. **Custom** — tell me which lenses (by number or band).
>
> *Recommended this time: **{recommendation}**.*
>
> *Which?"*

After user picks → `→ HG`, then run.

## Sizing guidance

- Curated panel: 6-12 lenses typical. Less = under-coverage; more = panel sprawl (move to Full Enchilada instead). Production/launched projects: default to **Panel K (12)**.
- Full Enchilada: 34 lenses. Runtime: 1-3 hours of Claude work, often multi-session. Use for major-milestone scrubs.
- Custom: any number, but Bob warns if <4 (likely missing foundation) or >20 (likely should be Full Enchilada).

### ⚠️ Full Enchilada on a LIVE production project carries incident risk (v2.19)

A 34-lens scrub generates many fix-commits, and on a live product those compound — an EMBT Full Enchilada *caused a 65-minute P0 outage during the audit itself* (a perf fix that passed local build but white-screened prod). Before recommending Full Enchilada on a production project, Bob warns and offers mitigations:
- **Prefer Panel K (12)** for routine production depth; reserve Full Enchilada for **annual** or **pre-launch / pre-fundraise** milestones.
- If running Full Enchilada on live: batch fixes behind a **staging deploy + post-deploy verification** (L01 q13 / §A7.3 1b), or run during a **change-freeze window**, so compounding fixes don't ship unverified to prod.
- Never apply a build-config/bundler/routing fix from an audit straight to prod without driving the deployed URL (§A7.3 1b).

### New-lens inclusion triggers (v2.21–v2.22) — L31 / L32 / L33 / L34

These lenses are **profile-conditional**, not auto-included everywhere (anti-sprawl). Add them when the trigger fires:

- **L31 Input & Data-Flow Trace** — include when **user-supplied data fans out to downstream features** (profile/upload data feeding scoring/AI/personalization), or there's a **money/credit/quota flow** (purchase → redeem). Skip for read-only / stateless products. Natural fit: Panels A, G, H, K.
- **L32 Analytical Method Soundness** — include when the product has an **interpretation engine** (diagnosis, score, recommendation, ranking, risk rating), whether AI or deterministic. Especially mandatory for health/finance/safety-adjacent analysis. Skip pure CRUD. Natural fit: Panels A, F, K (and I for AI drift).
- **L33 Output Register & Audience Fit** — include when the product **generates prose output a user reads** AND that audience is non-technical OR a house style is declared. Skip data-only UIs. Natural fit: Panels A, H, K.

- **L34 SEO / AEO / GEO Discoverability** (v2.22) — include for **any product with a public website / marketing surface** (almost everything consumer- or B2B-facing). Tiers are independently runnable, so a user can request just the GEO tier. Skip pure internal tools / headless APIs with no web presence. Natural fit: Panels A, B, F, G, H, K — and the dedicated mini-panel below.

A product hitting all three v2.21 triggers (consumer AI product with personal data + an analytical engine + generated output — the EMBT shape) should include those three on top of its base panel, plus L34 if it has a website. A pure internal CRUD tool (Panel D) adds none.

### Panel L — "SEO / AI-visibility scrub" (v2.22)
Use when: the explicit purpose is discoverability — pre-launch website check, a "why aren't we showing up in ChatGPT/Google" investigation, or a quarterly search/AI-visibility pulse.
Lenses (5): **L34, L26, L20, L17, L24**
Justification: L34 is the spine (technical SEO + AEO + GEO); L26 covers content clarity/copy that L34 hands off; L20 covers social-share unfurl; L17 supplies the Core Web Vitals L34 references; L24 frames share-of-AI-voice against competitors. Run L34 alone for a fast single-lens check, or this panel for the full discoverability picture.

### L25 Pricing — rarely standalone (v2.19)

L25 is **not** a default-panel lens. **L24** (competitive), **L16** (effectiveness), and **L08** (friction & trust) cover most pricing signal already. Include L25 only when pricing / monetization is the *explicit purpose* of the audit (e.g., pre-monetization, a repricing decision). Origin: an EMBT retro found L25 produced 0 closed findings + 1 false positive when run alongside L16/L24/L08. (Panels B, G, H still list it where pricing is genuinely in focus; it's just no longer auto-added elsewhere.)

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
