---
id: L07
name: UX — Ease & Cognitive Path
band: 2
band_name: User Experience
when_to_run: Products with human users. Skip engineer-only / backend / library products.
estimated_duration: 60-90 min — requires walking the live product, not just code-reading
session_pattern: fresh session; reads L02 (Spec Fidelity) for declared user-experience claims
output_markdown: audit-artifacts/L07-ux-ease-cognitive-path-{YYYY-MM-DD}.md
output_json: audit-artifacts/L07-ux-ease-cognitive-path-{YYYY-MM-DD}.json
source_frameworks:
  - Nielsen's 10 Usability Heuristics — https://www.nngroup.com/articles/ten-usability-heuristics/
  - Cognitive Walkthrough (Lewis & Rieman) — https://www.userfocus.co.uk/articles/cogwalk.html
  - Don Norman's principles (Affordances, Signifiers, Constraints, Mappings, Feedback, Conceptual model)
  - Nielsen Severity Scale 0-4 — https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
  - DLL audit 2026-05-23 — capability invisibility pattern
---

# L07 — UX: Ease & Cognitive Path

## Question this lens answers

*At each step of the user's journey, will they know what to do, notice the right action, associate the action with the outcome, and see feedback that closes the loop?*

## Why this lens exists / what other lenses miss

Engineering audits verify the code works. L07 verifies the user can *use* the code. The DLL audit found that HELP was a compliance one-liner instead of a capability menu; PACKS used engineer syntax (`car_ownership`); the welcome SMS tried to convey three things in 226 characters; memory / objects / Activity ledger were powerful but invisible from the SMS interface. None of these are engineering bugs. All of them are *cognitive path* failures — the user doesn't know what to do, what's available, or where they are.

L07 is the foundation UX lens. L08 (Friction & Trust), L09 (Wow), and L10 (Edge States) build on top of it. If L07 is failing, the others are noise — fix navigation before celebrating peak moments.

## When this lens fires

**Always-in-Full-Enchilada for human-facing products.** Curated panel inclusion criteria:
- ✅ Always — for products with non-engineer users.
- ✅ Mandatory — before any consumer launch or major UX redesign.
- ⏸ Skip — engineer-only, backend-only, internal API, or library products.

## Session setup

- Start a **fresh Claude Code session.**
- Read L02 (Spec Fidelity) for declared UX claims (Product Spec § brand voice, target persona, expected flow).
- Open the product in the form a real user would use it (mobile if mobile-first, etc.). Do NOT audit from code alone.
- No tooling install required. This is human-reasoning + product-interaction.

## Source frameworks

- **Nielsen's 10 Usability Heuristics** — visibility of system status; match real-world; user control & freedom; consistency & standards; error prevention; recognition over recall; flexibility & efficiency; aesthetic minimalism; help users recognize/recover from errors; help & documentation. https://www.nngroup.com/articles/ten-usability-heuristics/
- **Cognitive Walkthrough (Lewis & Rieman)** — four questions per step: (a) will user try the right outcome? (b) will they notice the correct action? (c) will they associate the action with the outcome? (d) will they see progress feedback? https://www.userfocus.co.uk/articles/cogwalk.html
- **Don Norman's 6 principles** — Affordances, Signifiers, Constraints, Mappings, Feedback, Conceptual model.
- **Nielsen Severity Scale** — 0 not a problem / 1 cosmetic / 2 minor / 3 major / 4 catastrophe. Multiply by frequency × persistence. https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- **DLL audit (Joe Wang, 2026-05-23)** — empirical anchor for capability invisibility and engineer-syntax-on-user-surface patterns.

## Audit method

1. **Map the primary journey in 8-15 steps.** Same map as L09 if L09 has run.

2. **For each step, run the Cognitive Walkthrough 4-question test:**
   - Will the user try to achieve the right outcome at this step?
   - Will they NOTICE the correct action is available?
   - Will they ASSOCIATE the action with the desired outcome?
   - Will they SEE FEEDBACK confirming progress?
   Each "no" is a finding.

3. **Walk Nielsen's 10 heuristics across the whole product:**
   - Visibility of system status — is the user always told what's happening?
   - Match between system and real world — does language match user's mental model?
   - User control & freedom — undo, redo, escape paths from any state?
   - Consistency & standards — same word for same thing across the product?
   - Error prevention — does the design make errors unlikely?
   - Recognition over recall — is information visible vs requiring memory?
   - Flexibility & efficiency — shortcuts for expert users?
   - Aesthetic & minimalist design — no noise that competes with primary info?
   - Help users recognize/recover from errors — plain-language error messages with recovery action?
   - Help & documentation — searchable, task-focused, available at moment of need?

4. **Don Norman audit (the deeper one):**
   - **Affordances** — does each interactive thing look interactive (button-y, link-y, tap-y)?
   - **Signifiers** — are signals about availability visible (cursor change, hover state, highlighted area)?
   - **Mappings** — does interaction structure mirror the user's mental task? (Slider for continuous, toggle for binary, etc.)
   - **Feedback** — every action produces a system response within 100ms?
   - **Constraints** — does the design prevent invalid actions (greying out, disabling, blocking)?
   - **Conceptual model** — does the user form an accurate mental model of how the product works after 1-2 sessions?

5. **Capability invisibility scan (DLL pattern).** What does the product DO that the user has no way to discover? Memory? History? Settings? Power features? Each "exists but undiscoverable" is a finding.

6. **Engineer-syntax-on-user-surface scan.** Any place where developer terminology leaks into user-visible UI/copy. (DLL: PACKS using `car_ownership`. Generic: error codes, debug strings, internal IDs, jargon.)

## Check questions

1. Have you walked the primary journey live and run the Cognitive Walkthrough 4-question test on every step?
2. For each step where a question is "no," what's the specific affordance / signifier / feedback missing?
3. Have you walked all 10 Nielsen heuristics against the whole product?
4. Are there capabilities the product has that the user has no way to discover?
5. Is help context-sensitive (available at the moment of need) or buried (in a separate help section)?
6. Are error messages plain-language with a recovery action, or technical?
7. Is there an undo / escape path from every irreversible-feeling state?
8. Does same language refer to same concept consistently (no "task" in one screen, "item" in another)?
9. Does the cursor / hover state signal interactability everywhere?
10. Does every user action produce visible feedback within 100ms?
11. Is the navigation predictable (back button, breadcrumbs, "where am I")?
12. Are there places where the user has to remember information from one screen to use it on another (recall vs recognition)?
13. Are there places where engineer-syntax leaks to user-facing UI?
14. For mobile: are touch targets ≥44px and free of accidental-tap risks?
15. What's the single highest-leverage cognitive-path fix?

## Output schema

### Markdown report

```markdown
# L07 — UX: Ease & Cognitive Path — {YYYY-MM-DD}

## Cognitive Walkthrough (per journey step)
| Step | Right outcome? | Notice action? | Associate w/ outcome? | See feedback? | Severity |
|---|---|---|---|---|---|

## Nielsen 10 heuristics (whole product)
| # | Heuristic | Status | Findings |
|---|---|---|---|

## Don Norman principles
| Principle | Findings |
|---|---|

## Capability invisibility findings
| Capability | Where it lives | How user discovers (or doesn't) |
|---|---|---|

## Engineer-syntax findings
| Where | User-visible string | Should be |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged by Nielsen scale)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L07",
  "lens_name": "UX: Ease & Cognitive Path",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "cognitive_walkthrough_failures": 0,
  "nielsen_findings_per_heuristic": {},
  "norman_findings": [],
  "capability_invisibility_findings": 0,
  "engineer_syntax_findings": 0,
  "findings": [
    {
      "id": "L07-F001",
      "severity": "catastrophe|major|minor|cosmetic",
      "nielsen_severity": "0-4",
      "category": "cognitive_walkthrough_fail|nielsen_visibility|nielsen_match_real_world|nielsen_user_control|nielsen_consistency|nielsen_error_prevention|nielsen_recognition|nielsen_flexibility|nielsen_aesthetic|nielsen_error_recovery|nielsen_help|norman_affordance|norman_signifier|norman_feedback|norman_mapping|norman_constraint|norman_conceptual_model|capability_invisible|engineer_syntax",
      "title": "{short}",
      "journey_step": "{where in journey}",
      "evidence": "{specific UI element / screen / copy}",
      "user_impact": "{1-sentence}",
      "recommendation": "{specific change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens — Nielsen scale)

- **Catastrophe (Nielsen 4)** — User cannot complete primary task, gets stuck, abandons. Examples: critical action has no affordance, irreversible action with no warning, error message that doesn't say what to do.
- **Major (Nielsen 3)** — User completes task but with significant struggle (multiple wrong tries, has to ask for help, takes 5x expected time). Examples: capability invisibility on a frequently-needed feature, missing feedback on a long-running action.
- **Minor (Nielsen 2)** — User completes task but is mildly annoyed or confused. Examples: inconsistent terminology, weak signifier on a secondary action.
- **Cosmetic (Nielsen 1)** — Polish opportunity. Examples: micro-copy could be clearer, hover state could be more distinct.

## Anti-patterns / Bias instructions

- **Do NOT audit from code alone.** L07 requires walking the live product. Code-only audit will miss the visual/interactive issues that ARE the lens's point.
- **Do NOT recommend "add a tooltip" as default fix.** Tooltips are an onboarding crutch. Strong design surfaces information through the interface itself.
- **Do NOT recommend "rewrite the UI."** L07 surfaces specific findings with specific fixes. UI rewrites are EVOLVE-mode work, not audit recommendations.
- **Do NOT confuse "I find this confusing" with "users find this confusing."** Note: as the auditor, you're an N=1. Findings should reference specific Cognitive Walkthrough question failures or Nielsen heuristics, not vibes.
- **Bias toward "first-time user reaching for first task."** Most usability failures appear in the first 5 minutes. Audit there before optimizing power-user paths.

## Stop conditions

1. **No live product.** Can't run cognitive walkthrough. Surface and skip.
2. **No declared user audience.** L07 needs to know who it's auditing for. Flag missing Product Spec persona.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (user audience, declared UX claims).
- **Downstream:** L08, L09, L10 all build on L07's journey map.
- **Adjacent (~15% overlap):**
  - **L09 Wow** — both look at journey emotion, L07 catches negatives (confusion), L09 catches potential positives (delight).
  - **L08 Friction** — L07's cognitive failures often manifest as L08's friction. Same root, different lens.
