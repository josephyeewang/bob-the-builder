---
id: L27
name: Persona Simulation
band: 7
band_name: Strategic & Market
when_to_run: Any product with external users. Mandatory before launch, especially for products targeting non-engineer users.
estimated_duration: 90-150 min — adversarial reasoning is slow but high-leverage
session_pattern: fresh session; reads L02 (Spec Fidelity for target audience) and L26 (Marketing voice) if available
output_markdown: audit-artifacts/L27-persona-simulation-{YYYY-MM-DD}.md
output_json: audit-artifacts/L27-persona-simulation-{YYYY-MM-DD}.json
source_frameworks:
  - Tony Ulwick — Outcome-Driven Innovation (ODI)
  - Bob Moesta — "switch interview"
  - Christensen — Jobs-to-be-Done emotional / social / functional layers
  - PersonaTeaming red-team paper (arXiv 2509.03728)
  - Adversarial-user-research / "would this person swipe right" frameworks
---

# L27 — Persona Simulation

## Question this lens answers

*Sitting at the desk of 4-6 named personas — domain expert, competitor power-user, brand-affinity user, privacy-paranoid skeptic, target core user, accidental side user — what would each one think, push back on, demand, skip, or quit on?*

## Why this lens exists / what other lenses miss

The audit is being run by the builder. The builder sees the product as a builder. Real users see it from completely different vantage points. Per the PersonaTeaming paper (arXiv 2509.03728), persona-conditioned reasoning surfaces 144% more findings than persona-free review — identity changes what gets discovered. Engineering audits, UX audits, even marketing audits all share the builder's vantage. L27 deliberately escapes it.

The DLL audit didn't have an explicit persona simulation. EMBT (health-adjacent product) would benefit enormously from "what would a doctor say?" The pattern is: pick personas the team is NOT, simulate them, capture what they'd surface.

## When this lens fires

**Always-in-Full-Enchilada for products with external users.** Curated panel inclusion criteria:
- ✅ Mandatory — before launches, especially products targeting non-engineer users.
- ✅ Strongly recommended — any product where the builder is the user (high risk of builder-vantage bias).
- ⏸ Skip — pure internal engineer-tool with builder=user identity.

## Session setup

- Start a **fresh Claude Code session.**
- Read L02 (Spec Fidelity) for declared target audience, L26 (Marketing voice).
- Inputs:
  - Product Spec § target persona, ICP, anti-user (if defined)
  - The live product
  - Marketing surfaces (what does the product TELL users?)
- No tooling install required. This is structured adversarial reasoning.

## Source frameworks

- **Tony Ulwick — Outcome-Driven Innovation (ODI)** — customers hire products to do a job; capture desired outcomes as measurable statements ("minimize the time it takes to X"). https://strategyn.com/jobs-to-be-done/
- **Bob Moesta — "switch interview"** — what triggered the buy, what they were doing before, what almost stopped them.
- **JTBD emotional / social / functional layers (Christensen / Ulwick / Klement)** — every job has three layers.
- **PersonaTeaming paper (arXiv 2509.03728)** — persona-conditioned reasoning raised adversarial attack success up to 144%. Same principle: identity changes discovery.
- **Adversarial-user-research** — pick personas the team is NOT.

## Audit method

1. **Pick 4-6 personas.** Mandatory categories:
   - **Domain expert** — a professional in the product's domain (doctor for health products, lawyer for legal, CFO for finance)
   - **Competitor power-user** — someone who lives in a competing product (Notion die-hard, Excel power-user, Linear loyalist)
   - **Brand-affinity** — user with strong design / interaction expectations (Apple aesthetic, Linux purist, indie-aesthetic developer)
   - **Skeptic** — privacy-paranoid, regulation-aware, security-conscious, cost-sensitive
   - **Target core user** — the explicit primary persona from Product Spec
   - **Accidental side user** — someone using the product for a use case it wasn't designed for

   Plus optional:
   - **Anti-user** — someone who should NOT use this product (if you can't name one, positioning is too broad)
   - **First-time / pre-onboarding** — someone landing on homepage for the first time

2. **For each persona, write a one-paragraph profile.** Background, current tools, mental model, concerns, what they're optimizing for. Stay specific — "a 45-year-old internist who uses Epic and is skeptical of consumer health apps because she's seen patients harmed by them" is better than "a doctor."

3. **Walk the product as each persona.** Land on the homepage. Walk the journey. At each step, ask:
   - What would this persona notice that you didn't?
   - What would they push back on?
   - What would they demand?
   - What would they skip?
   - When would they quit?

4. **JTBD layer audit per persona.** For the primary action of each persona:
   - **Functional job** — what task are they completing?
   - **Emotional job** — how do they want to feel doing this?
   - **Social job** — how do they want to be perceived using this?
   Does the product address each layer for each persona?

5. **Persona-specific concern audit:**
   - **Domain expert**: Are claims accurate? Is there expert insight, or LLM-generated overview? Would they flag anything as wrong / unsafe / unprofessional?
   - **Competitor power-user**: Where does muscle memory fail? Where is your product non-obvious because they expect competitor patterns?
   - **Brand-affinity**: Does the visual/interaction language match their aesthetic standard? Where would they bounce on polish?
   - **Skeptic** (privacy): Read the privacy policy + data-handling page as someone with breach trauma. Are there ≥3 specific reassurances?
   - **Skeptic** (regulation): If health / finance / kids / EU — name the regs + persona's first 3 questions. Answers visible without contacting sales?
   - **Skeptic** (security): For AI products, hallucination-skeptic + data-leakage-skeptic + cost-runaway. Are answers on-page?
   - **Target core user**: Does the product feel made for them, or for a more general audience?
   - **Accidental side user**: What happens — does the product accommodate gracefully or fail confusingly?
   - **Anti-user**: If they signed up by mistake, would they self-identify and leave?

6. **Switch interview simulation per persona** (Moesta). For each persona, narrate the 24 hours before they bought:
   - What were they doing?
   - What broke?
   - What did they Google?
   - Does the product show up at that moment?

7. **"Would they swipe right?" test per persona.** Show landing + pricing for 30 seconds. Swipe right / left / hesitate. Capture the *reason*.

8. **Aggregate findings.** Each persona surfaces 5-15 findings. Themes will emerge across personas — those are highest-leverage.

## Check questions

1. Have you picked 4-6 personas across mandatory categories?
2. Is each persona profile specific (not generic)?
3. Have you walked the product as each persona (not just thought about them abstractly)?
4. JTBD functional + emotional + social layers addressed per persona?
5. Domain expert: claims accurate? expert-flagged issues?
6. Competitor power-user: muscle-memory failures captured?
7. Brand-affinity: aesthetic bounce points?
8. Privacy skeptic: ≥3 specific reassurances visible?
9. Regulation skeptic: regs named, first 3 questions answered on-page?
10. Anti-user named publicly?
11. Switch interview narrative for each persona — does product show up at the trigger moment?
12. "Would they swipe right?" results per persona?
13. Themes across personas identified?
14. Accessibility persona (keyboard-only, screen-reader, color-blind, low-vision) walked? (Overlaps L19.)
15. AI-product specific: hallucination-skeptic, data-leak-skeptic, cost-runaway personas walked?

## Output schema

### Markdown report

```markdown
# L27 — Persona Simulation — {YYYY-MM-DD}

## Persona inventory
| # | Persona | Profile (1 paragraph) |
|---|---|---|
| 1 | Internist Dr. M | 45yo, uses Epic, skeptical of consumer health apps |
| 2 | Notion die-hard | uses Notion 6hrs/day, expects keyboard-first |
| 3 | ... | |

## Per-persona walk
### Persona 1: Internist Dr. M
- **Functional job:** {what}
- **Emotional job:** {feel}
- **Social job:** {perceived}
- **Notices:** {what}
- **Pushes back on:** {what}
- **Demands:** {what}
- **Skips:** {what}
- **Quits when:** {moment}
- **Switch interview narrative:** {24 hours before}
- **Swipe right?** yes/no/hesitate — {reason}
- **Findings:** N

[Repeat per persona]

## Themes across personas
| Theme | Personas surfacing it | Severity |
|---|---|---|

## Anti-user audit
- Named anti-user: {who or gap}
- Would they self-identify and leave? {yes/no/unclear}

## Top 3 highest-leverage findings (cross-persona themes)
1. ...

## Findings (full, severity-tagged with persona attribution)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L27",
  "lens_name": "Persona Simulation",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "personas_simulated": 0,
  "personas_by_category": {
    "domain_expert": 0,
    "competitor_power_user": 0,
    "brand_affinity": 0,
    "skeptic": 0,
    "target_core_user": 0,
    "accidental_side_user": 0,
    "anti_user": 0
  },
  "swipe_right_rate": 0.0,
  "cross_persona_themes_count": 0,
  "findings": [
    {
      "id": "L27-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "domain_expert_concern|competitor_muscle_memory|brand_affinity_polish|privacy_skeptic_concern|regulation_skeptic_unanswered|target_persona_mismatch|accidental_user_confusion|anti_user_undefined|missing_jtbd_emotional|missing_jtbd_social|switch_interview_no_product_match",
      "persona": "{name}",
      "title": "{short}",
      "evidence": "{specific surface / interaction / claim}",
      "user_impact": "{1-sentence}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Domain expert flags inaccurate / unsafe claim. Privacy skeptic finds no reassurances on data handling. Regulation skeptic finds basic reg questions unanswered. Target persona feels product is not for them.
- **Major** — Cross-persona theme that 3+ personas surface. Switch-interview shows product doesn't show up at trigger moment. Anti-user not defined.
- **Minor** — Single-persona findings without broader theme. Brand-affinity polish concerns.
- **Cosmetic** — Persona inventory completeness.

## Anti-patterns / Bias instructions

- **Do NOT pick personas the team identifies with.** That defeats the purpose. Pick personas you're NOT.
- **Do NOT use generic personas.** "A user" is not a persona. "A 45-year-old internist who uses Epic and has seen patients harmed by health apps" is.
- **Do NOT just think about personas — walk the product as them.** Imagination is N=1; product-walking is N=2 (you + the simulated persona).
- **Bias toward "what would they say to a friend after using this for 10 minutes?"** That captures the gut-check honesty.

## Stop conditions

1. **No external users.** Skip.
2. **No declared target persona in Product Spec.** Flag as foundational gap; L27 still runs but is less anchored.

## Cross-lens handoff

- **Upstream:** L02 (declared persona), L26 (marketing voice).
- **Downstream:** L28 (anti-user feeds wedge sharpening), L09 (persona-specific emotional jobs feed peak design).
- **Adjacent (~15% overlap):**
  - **L09** — both look at emotion; L09 product-driven, L27 persona-driven.
  - **L19** — accessibility personas overlap; L19 = compliance, L27 = experience.
