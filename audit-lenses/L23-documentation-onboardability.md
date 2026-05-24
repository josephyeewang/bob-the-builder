---
id: L23
name: Documentation & Onboardability
band: 6
band_name: Operational
when_to_run: Any product expected to outlive single-developer attention. Mandatory before team expansion, fundraising, or open-sourcing.
estimated_duration: 60-90 min
session_pattern: fresh session
output_markdown: audit-artifacts/L23-documentation-onboardability-{YYYY-MM-DD}.md
output_json: audit-artifacts/L23-documentation-onboardability-{YYYY-MM-DD}.json
source_frameworks:
  - Diátaxis framework (Daniele Procida) — https://diataxis.fr
  - Write the Docs community standards
  - Stripe / Vercel / Linear API docs as gold-standard examples
  - GitHub README best practices
---

# L23 — Documentation & Onboardability

## Question this lens answers

*Could a new collaborator (engineer, operator, product manager, designer) join cold, contribute meaningfully within 2 weeks, and not need to ask the original builder more than 10 questions?*

## Why this lens exists / what other lenses miss

Engineering audits assume the original author. L23 audits everything that breaks down when the original author isn't available — sick day, vacation, departure, scale-up hire, open-source contributor. Documentation is the operator-distinctive lens that engineering teams routinely under-invest in until it's too late. For products built by a single non-engineer (Joe's pattern) it's even more critical — when a contractor or future co-founder joins, can they contribute?

This lens also extends to USER documentation (help center, FAQ) — for products with users who need help understanding capabilities.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Mandatory — before team expansion, before fundraising (acquirer / investor diligence), before open-sourcing.
- ✅ Strongly recommended — products built single-handedly that will outlive single-developer attention.
- ⏸ Skip — pure throwaway prototypes.

## Session setup

- Start a **fresh Claude Code session.**
- Inputs:
  - README.md
  - CONTRIBUTING.md
  - `docs/` folder
  - `CLAUDE.md` / `AGENTS.md` (agent-readable docs)
  - User-facing help center / FAQ / docs site
  - Inline code comments (sample several files)
  - Onboarding docs if any
  - The full architecture surface to test "could a stranger understand this?"

## Source frameworks

- **Diátaxis (Daniele Procida)** — four documentation modes: Tutorials (learning), How-to (task), Reference (info), Explanation (understanding). Most docs conflate these and serve none well. https://diataxis.fr
- **Write the Docs community** — https://www.writethedocs.org
- **Stripe / Vercel / Linear API docs** — gold-standard examples to benchmark against.
- **GitHub README best practices** — title, badges, description, install, usage, contributing, license.

## Audit method

1. **The "cold collaborator" test.** Sit a knowledgeable engineer in front of the repo (or simulate one). Give them 2 hours. Can they:
   - Understand what this product does?
   - Run it locally?
   - Make a small change and see it work?
   - Find where to ask questions?

2. **README audit.** Does the README cover:
   - One-paragraph product description (what + why)
   - Visual demo or screenshot
   - Quick start (clone, install, run, see-it-work in ≤5 commands)
   - Architecture overview (1-2 paragraphs + diagram)
   - Tech stack
   - Where to find detailed docs
   - How to contribute / report bugs
   - License + maintainer info

3. **Diátaxis coverage.** Are there docs of each type?
   - **Tutorials** — "build something working from scratch" for a new user / dev
   - **How-to guides** — "do X specific task" for someone with goal in mind
   - **Reference** — "look up this API / config / behavior" — exhaustive, technical
   - **Explanation** — "why is this architected this way" — discussion / context
   Most projects have Reference and nothing else.

4. **Code comments audit (sample).** Open 5-10 representative files. Are comments:
   - Explaining "why" (good) vs "what" (noise — code already says what)?
   - Up-to-date with code (or stale)?
   - Marking non-obvious invariants, gotchas, workarounds?

5. **CLAUDE.md / AGENTS.md audit (AI-collaborator readiness).**
   - Does Bob's CLAUDE.md mention exist?
   - Does it follow Bob's <150-line discipline?
   - Does it cover: project purpose, key files, conventions, common commands, environment setup?
   - Is it kept up to date?

6. **User-facing help center audit (if applicable).**
   - For consumer/B2B products with non-engineer users: does a help center / FAQ exist?
   - Is it searchable?
   - Top user questions covered?
   - Updated when product changes?
   - Empty-search results lead somewhere useful?

7. **ADR / decision log audit.**
   - Are non-obvious architectural decisions documented (Bob's `decision-log.md` pattern)?
   - Can a reader of the codebase understand WHY choices were made?

8. **Onboarding checklist for new contributors.**
   - Is there a list of "things to set up to start contributing"?
   - Is it tested by walking a new person through it (or running the script)?

9. **Tribal knowledge inventory.**
   - What does the original builder know that ISN'T documented? (Talk to them.)
   - For each unwritten thing, decide: document, or accept the tribal knowledge cost.

## Check questions

1. Cold-collaborator test — can a new dev be productive in <2 weeks with <10 questions?
2. Does README cover product description, quick start, architecture, contribute?
3. Are all 4 Diátaxis types present (Tutorials, How-to, Reference, Explanation)?
4. Are code comments explaining "why" not "what"? Up-to-date with code?
5. Does CLAUDE.md exist, follow <150-line discipline, cover purpose + files + commands?
6. For user-facing products: is there a help center / FAQ? Top questions covered?
7. Are non-obvious architectural decisions in an ADR / decision log?
8. Is there an onboarding checklist for new contributors? Tested?
9. What's the tribal knowledge — what does the builder know that isn't written?
10. Are runbooks (L21) cross-referenced from docs?
11. Are environment variables documented in `.env.example` with comments?
12. Is the contribution flow documented (PR process, code style, test requirements)?
13. For methodology / framework products: are templates and conventions visible?
14. Does docs have a "last updated" date per major section?
15. Are docs themselves under version control (so changes can be reviewed)?

## Output schema

### Markdown report

```markdown
# L23 — Documentation & Onboardability — {YYYY-MM-DD}

## Cold collaborator test
- Time to "I understand this": X min
- Time to "I can run it locally": X min
- Time to "I can make a small change": X min
- Questions needed: N

## README coverage
| Element | Present | Quality |
|---|---|---|
| Product description | yes | clear |
| Quick start | partial | works but takes 12 commands |
| Architecture overview | no | missing |

## Diátaxis coverage
| Type | Coverage | Examples |
|---|---|---|
| Tutorials | partial | one tutorial |
| How-to | none | — |
| Reference | strong | API docs exist |
| Explanation | partial | one "why this design" doc |

## Code comment quality (sampled)
| File | Why-comments | What-comments (noise) | Stale comments |
|---|---|---|---|

## CLAUDE.md status
- Exists: yes
- Line count: 142 (within <150 budget)
- Coverage: purpose ✓, files ⚠ (out of date), commands ✓, conventions ✓

## User-facing help center
- Exists: yes/no
- Searchable: yes/no
- Top 10 user questions covered: yes/partial/no
- Empty-search UX: leads-somewhere / dead-end

## Decision log / ADR
- Present: yes/no
- Entries: N
- Covers major architectural choices: yes/partial/no

## Tribal knowledge inventory
| Knowledge | Currently undocumented | Document or accept |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L23",
  "lens_name": "Documentation & Onboardability",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "cold_collaborator_minutes_to_understand": null,
  "cold_collaborator_minutes_to_first_change": null,
  "readme_completeness_pct": 0,
  "diataxis_coverage": {
    "tutorials": "none|partial|strong",
    "howto": "none|partial|strong",
    "reference": "none|partial|strong",
    "explanation": "none|partial|strong"
  },
  "claude_md_present": false,
  "claude_md_line_count": null,
  "help_center_present": false,
  "decision_log_entries": 0,
  "tribal_knowledge_items": 0,
  "findings": [
    {
      "id": "L23-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "no_readme|incomplete_readme|missing_tutorial|missing_howto|missing_reference|missing_explanation|stale_comments|no_claude_md|no_help_center|no_decision_log|tribal_knowledge_undocumented|no_onboarding_checklist|env_vars_undocumented",
      "title": "{short}",
      "evidence": "{specific gap}",
      "impact_on_collaborator": "{1-sentence}",
      "recommendation": "{specific addition / restructure}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — No README. Cold collaborator gives up. Tribal knowledge >50% of operational understanding. No quick-start.
- **Major** — README incomplete (missing architecture or quickstart). 2+ Diátaxis types missing. CLAUDE.md absent / stale. Help center missing on user-facing product.
- **Minor** — Stale comments. Some Diátaxis gaps. Onboarding checklist exists but untested.
- **Cosmetic** — Polish opportunities; consistency improvements.

## Anti-patterns / Bias instructions

- **Do NOT score "comprehensive docs" as good without testing onboarding.** Verbose docs can be worse than terse docs if they conflate Diátaxis types.
- **Do NOT recommend "more comments in code."** Code comments that explain "what" are noise; comments that explain "why" are gold. Recommend specific why-comments where invariants exist.
- **Do NOT confuse marketing docs with developer docs.** Both matter; different audiences.
- **Bias toward "would I want to be the next person to maintain this?"** Honest answer reveals real gaps.

## Stop conditions

1. **Throwaway prototype.** Skip; docs aren't worth investing here.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (the spec IS a kind of doc; verify it's discoverable).
- **Downstream:** L26 Marketing (docs voice ↔ marketing voice consistency).
- **Adjacent (~15% overlap):**
  - **L02** — both touch spec accuracy.
  - **L26** — both touch language clarity.
