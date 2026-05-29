# Bob Audit Lens Library (v2.22)

> **34 ready-made audit prompts across 8 bands.** Loaded once, locked-and-loaded for every project Bob audits. Bob picks the panel based on project profile; the user picks Curated or Full Enchilada at the entry gate.

## Why this exists

Single audits are 90% effective and always miss some %. Different lenses catch *qualitatively different* finding categories — engineering-hygiene audits miss UX, UX audits miss security, both miss strategic-wedge drift. Bob v2.16 had one A7 audit phase with ~10 sub-steps; v2.17 reorganizes that phase into a **lens library** where each lens is a self-contained, source-cited, ready-to-run audit prompt.

Empirical anchor: the DLL audits run 2026-05-23 produced three categorically distinct lens taxonomies (spec-vs-built, capability quality, UX journey). The UX lens alone surfaced findings no engineering audit could catch — silent system actions damaging trust, capability invisibility, triple-SMS in 5 seconds, no recovery path. v2.17 codifies this multi-lens reality into Bob's protocol.

## The 8 bands and 34 lenses

| Band | # | Lens | Question it answers |
|---|---|---|---|
| **1. Engineering Foundation** | L01 | Hygiene & Liveness | Does the code hold up on inspection AND when executed? |
| | L02 | Spec Fidelity | Did we build what we said we'd build? Every capability marked BUILT/PARTIAL/MISSING. |
| | L03 | Critical Capability Quality | For the 30-50 critical capabilities, is each one A-grade or hollow/B-grade? |
| | L04 | Security & Threat Surface | STRIDE + OWASP T10:2025 + ASVS 5.0 across the attack surface. |
| | L05 | Data Protection & Privacy | PII discovery, GDPR Art.30, classification, retention, info-disclosure paths. |
| | L06 | Supply Chain & Configuration | OSS vulns, license, IaC, env hygiene, secret leakage. |
| | L31 | Input & Data-Flow Trace | Follow one input/field end-to-end — stored, secured, deduped, propagated to every consumer, terminal states (redeem/refund/delete) resolved? (taint-tracking + field lineage) |
| **2. User Experience** | L07 | Ease & Cognitive Path | Can the user know what to do? (Nielsen + Cognitive Walkthrough + Norman) |
| | L08 | Friction & Trust | What feels hostile, manipulative, or jargon-y? (Friction Log + Dark Patterns) |
| | L09 | Wow & Emotional Peaks | Where are the delight peaks? (Peak-End + JTBD emotional/social) |
| | L10 | Edge States & Recovery | Empty/Loading/Error/Offline/Partial/Slow — does each one have a graceful path? |
| **3. AI Behavior** | L11 | AI Accuracy & Calibration | How often does the AI produce correct output, and is confidence calibrated? |
| | L12 | AI Right-Sizing & Model Fit | Should this be AI or codified? Is the model choice justified? |
| | L13 | AI Interaction (HAX) & Safety | HAX 18 guidelines + jailbreak resistance + prompt injection + refusal calibration. |
| | L14 | AI Cost & Latency Efficiency | Token bloat, caching hit rate, batching, streaming, cascading. |
| | L32 | Analytical Method Soundness | Is the *method* behind a score/diagnosis/recommendation sound — right inputs, defensible weights, valid assumptions, real depth? Covers AI **and** deterministic logic. (SR 11-7 conceptual soundness) |
| **4. Performance Economics** | L15 | Cost & Speed Drivers | What's driving cost and latency, AND where should we deliberately add cost/time for effectiveness? |
| | L16 | Effectiveness & Quality Drivers | What's driving outcomes the user cares about? Where's the leverage and the leakage? |
| **5. Reach & Distribution** | L17 | Device & Form Factor | Desktop / mobile / tablet — does it actually work on a phone? |
| | L18 | Internationalization & Language | Hardcoded English, broken-under-German layout, missing RTL, locale-naive dates. |
| | L19 | Accessibility (WCAG+) | POUR + cognitive/motor/visual + keyboard/screen-reader paths. |
| | L20 | Shareability, Virality & Discoverability | OG tags, thumbnails, share affordances, *social* discoverability, embed-ability, referral mechanics. |
| | L34 | SEO / AEO / GEO Discoverability | Will engines find, rank, extract, and cite the site? 4-tier model (Foundation → SEO → AEO → GEO), evidence-ranked from the Princeton GEO paper — **then a 3-altitude Action Plan**: tactical fixes, content to produce, and strategic opportunity discovery (what to create next). |
| **6. Operational** | L21 | Observability & Incident Readiness | What can ops see in prod? Runbook + rollback + blast radius. |
| | L22 | Vendor & Dependency Risk | Single-points-of-failure, vendor lock-in, sunset risk, cost-spike risk. |
| | L23 | Documentation & Onboardability | Could a new collaborator contribute in 2 weeks? (Diátaxis framework) |
| **7. Strategic & Market** | L24 | Competitive Benchmarking | Objective comparison — where we win, where we lose, where we're indistinguishable. |
| | L25 | Pricing & Monetization | Strategy + discoverability + competitor benchmarking + mechanics (signup → pay → cancel). |
| | L26 | Marketing, Copy & Website | Contradictions, AI-slop, SEO, voice consistency, trust signals, hero clarity. |
| | L27 | Persona Simulation | What would a doctor / Notion power-user / privacy-paranoid say? |
| | L28 | Strategic Edge & Wedge Sharpness | Are we sharpening our wedge or sanding it off? The anti-convergence audit. |
| | L33 | Output Register & Audience Fit | Does the product's *generated* output (diagnoses, recommendations, insights) match the audience register/jargon level and house structure (e.g. answer-first, labeled takeaways)? (ISO 24495 + Minto) |
| **8. Growth & Adoption** | L29 | Onboarding & Activation | TTFV, aha-moment, drop-off mapping, activation-rate. |
| | L30 | Retention & Compounding Loops | Hook model, growth loops, network effects, churn surfaces. |

> **IDs are append-only, not band-sorted.** L01–L30 happen to be band-ordered (they shipped together in v2.17); lenses added later (L31 Band 1, L32 Band 3, L33 Band 7 — v2.21; L34 Band 5 — v2.22) keep the next free ID and declare their band in frontmatter rather than forcing a renumber. Group by the `band:` field, not by ID arithmetic.

## How each lens file is structured

Every lens prompt at `audit-lenses/L{NN}-{slug}.md` follows this schema:

```markdown
---
id: L{NN}
name: {Lens Name}
band: {1-8}
band_name: {Band name}
when_to_run: {Criteria for inclusion in Curated panel}
estimated_duration: {Time estimate for a Standard project}
session_pattern: fresh session; reads prior lens reports if any
output_markdown: audit-artifacts/L{NN}-{slug}-{YYYY-MM-DD}.md
output_json: audit-artifacts/L{NN}-{slug}-{YYYY-MM-DD}.json
source_frameworks: [list with URLs]
---

# L{NN} — {Lens Name}

## Question this lens answers
{One sentence stating the lens's unique angle.}

## Why this lens exists / what other lenses miss
{The gap rationale — what an engineering-hygiene audit cannot catch.}

## When this lens fires (Curated panel criteria)
{Project-profile conditions that include this lens. Plus: always-in-Full-Enchilada.}

## Session setup
- Start a **fresh Claude Code session** (writer/reviewer pattern — same rule as A7a-A7e).
- Read prior lens reports in `audit-artifacts/` if any. Do NOT re-litigate findings already logged.
- Install any required tooling first: {commands}.
- Inputs you need: {spec files, code paths, URLs, secrets}.

## Source frameworks (cited, not invented)
{2-5 bullets with URLs. Bob orchestrates; Bob does not reinvent.}

## Audit method
{Numbered steps. What to read, what to execute, what to score.}

## Check questions
{5-15 questions. Each one phrased so "no" is a finding.}

## Output schema
{Markdown table format that Claude fills in. Plus JSON sidecar shape. As of v2.18.1, the lens also appends a `retro_fragment` block to its JSON sidecar as its final step — the live self-assessment of how the lens itself performed, which the end-of-run Lens Retro reads off disk. See `_lens-retro.md` Tier 1.}

## Severity rubric (calibrated to this lens)
- **Critical** — {lens-specific definition}
- **Major** — {lens-specific definition}
- **Minor** — {lens-specific definition}
- **Cosmetic** — {lens-specific definition}

## Anti-patterns / Bias instructions
{Things to AVOID — over-scoring, hallucinating, scope creep, re-litigation.}

## Stop conditions (the gap IS the finding)
{When this lens cannot produce signal — name the absence honestly rather than fabricate findings.}

## Cross-lens handoff
{Which downstream lenses can use this lens's output. Which upstream lenses should have run first.}
```

## How a lens session runs (operator view)

1. **Bob proposes a panel** based on project profile (see `_selection-rubric.md`).
2. **User picks Curated or Full Enchilada** (see audit memory entry below).
3. **For each lens in the panel:**
   - Start a fresh Claude Code session.
   - Paste the lens entry prompt: *"Read `audit-lenses/L{NN}-{slug}.md` and run this audit on the current project. Read prior reports in `audit-artifacts/` first."*
   - Claude executes the audit, writes markdown + JSON to `audit-artifacts/`, and surfaces findings.
4. **After all lenses finish**, run aggregation (see `_aggregation.md`) — dedup, severity-rank, top findings.
5. **Hard gate** before remediation: user reviews aggregated report, decides what to fix vs defer.

## Two run modes (always offered)

| Mode | What it does | When to use |
|---|---|---|
| **Curated Panel** | Bob picks 6-10 lenses targeted to where you are (e.g., DLL pre-launch profile → L01, L02, L03, L04, L05, L07, L08, L10, L13). One-line justification for each include AND each exclude. | Default. Mid-build checkpoints, post-evolution validation, periodic pulse audits. |
| **Full Enchilada** | All 34 lenses run sequentially. No curation. | Major milestones: pre-launch, major version bumps, post-incident comprehensive review, investor/partner/user hand-off. Runtime: 1-3 hours of Claude work, often multi-session. |

## Audit memory entry

Every audit run is logged in `audit-artifacts/audit-history.json` (machine) + `audit-artifacts/audit-history.md` (human mirror). When you next ask Bob for an audit, the AUDIT mode entry opens with:

> *"Last audit was **N days ago** (YYYY-MM-DD). You ran the **{Curated panel — M lenses / Full Enchilada}**: {lens list}. Result: X findings ({critical}/{major}/{minor}). **Y still open** in audit-log.md.*
>
> *Four options:*
> 1. **Same Curated** — re-run the same M lenses, check what changed.
> 2. **Complementary Curated** — Bob picks M lenses you *haven't* run yet (broadens coverage; recommended if you ran the same panel <30 days ago).
> 3. **Full Enchilada** — all 34 lenses, the rocketship-launch scrub.
> 4. **Custom** — tell Bob which lenses (by number or band)."*

You never need to remember a command. Default-recommended option depends on context (see `_audit-memory.md` for the logic).

## Cross-lens handoff principles

- **Sequential, not parallel.** Each lens reads the prior lens's report and avoids re-litigation. The intentional ~15% overlap across lenses becomes *confirmation signal* ("L03 already flagged this; I confirm with additional context") rather than noise.
- **Foundation lenses first.** L01 (Hygiene) → L02 (Spec Fidelity) → L03 (Critical Capability Quality) anchor the rest by establishing what's built and how well.
- **Risk lenses (L04-L06) before UX (L07-L10).** Security/privacy findings often constrain UX choices.
- **AI lenses (L11-L14) cluster.** Run together — accuracy feeds right-sizing feeds cost.
- **Strategic & Growth lenses (L24-L30) last.** They benefit from understanding what's actually working (from earlier lenses) before judging direction.

## Execution Principle (v2.17.1 — load-bearing rule)

**Claude should EXECUTE, not just READ.** Many lenses default to "read code and reason" when Claude Code can actually drive Playwright, run scripts, query APIs, execute code, install tools, and simulate user behavior. Execution catches what reading misses.

Before running any lens, Claude reads **`_execution-principle.md`** — a cross-cutting catalog naming for each lens what should be EXECUTED (tool runs, code execution, Playwright drives, API queries), what should be READ (static analysis, configs, docs), and what genuinely requires HUMAN follow-up (subjective UX scoring, real-customer interviews, brand-voice judgment).

The rule of thumb: when a check question can be expressed as either *"is X true?"* (READ) or *"does Y happen when I do Z?"* (EXECUTE), prefer the latter. A finding with execution evidence is materially stronger than a finding with reading inference. See `_execution-principle.md` for the full per-lens catalog + rephrasing examples.

## Lens Retro — the self-learning loop (v2.18)

The library improves itself over usage. After every audit, Bob auto-emits a **lens retro** (`audit-artifacts/audit-retro-{date}.{md,json}`) — a critique of the *lenses as instruments*, not the findings about the product ("L20 was noise for an SMS-only product; nothing caught the provider-429 retry storm"). Retros collect in `lens-retros/`; `scripts/lens-retro.sh` aggregates them and flags lenses that are consistently low-signal or high-swap. A human then decides which lenses to edit — **convergence across retros is signal, not a verdict** (D-004 / F35), and **Bob never auto-edits its own lenses** (D-005). See **`_lens-retro.md`** for the full artifact schema, the standalone retro prompt, and the ritual.

## Provenance — what we surveyed

The library consolidates convergent angles from:
- **12 commercial AI code-review tools**: CodeRabbit, Greptile, Bito, Qodo PR-Agent, Sourcery, DeepSource, Cursor Bugbot, GitHub Copilot Code Review, Graphite Diamond, CodeAnt, diffray, Kodus.
- **4 canonical review frameworks**: Google eng-practices, OWASP Code Review Guide v2, thoughtbot/guides, joho/awesome-code-review meta-list (~100 tools/papers).
- **14 industry audit taxonomies**: ISO 25010:2023, OWASP Top 10:2025, OWASP ASVS 5.0, STRIDE, CWE Top 25, NIST SSDF, WCAG 2.2, GDPR Art.30, Microsoft SDL, SonarQube quality gates, Snyk scan categories, GitLab Secure, CodeQL query suites, OWASP Top 10 for LLMs 2025.
- **13 UX/product audit methods**: Nielsen 10 Heuristics, Cognitive Walkthrough, Don Norman Principles, JTBD (Ulwick/Christensen/Moesta), Friction Log, Peak-End Rule, Aha Moment, Edge State audits, IA audits, Microsoft HAX, Brignull's 12 Dark Patterns, Content audits, Conversational/AI UX heuristics.
- **3 academic papers** on LLM multi-agent SE systems (PersonaTeaming, MARG, LLM-MAS for SE).
- **Strategic/marketing frameworks**: April Dunford's 5-component positioning, Play Bigger (Lochhead) category design, Linear/Karri Saarinen craft-as-moat, 37signals opinionated software, Hanlon Primal Branding, Ramanujam Monetizing Innovation, Patrick Campbell value-metric pricing, Joanna Wiebe conversion copy, Google HCU/AI-slop signals.
- **Growth frameworks**: Sean Ellis activation, Reforge / Balfour growth loops, Nir Eyal Hook model, Andrew Chen network effects, a16z retention smile curves.

**Bob-distinctive lenses**: L01 Liveness (carried forward from v2.14, novel among surveyed tools), L02 Spec Fidelity (no surveyed tool generalizes this), L03 Critical Capability Quality (the hollow-implementation lens that no surveyed tool names explicitly). Added v2.21: **L31 Input & Data-Flow Trace** (per-field horizontal propagation completeness — taint-tracking and column-level lineage applied to product correctness, not security), **L32 Analytical Method Soundness** (SR 11-7 conceptual-soundness validation extended to deterministic + AI interpretation logic), **L33 Output Register & Audience Fit** (ISO 24495 + Minto applied to *generated in-product output*, a surface L26 explicitly skips). Added v2.22: **L34 SEO / AEO / GEO Discoverability** — the only audit that unifies search, answer, and generative-engine discoverability into one 4-tier funnel (Foundation → SEO → AEO → GEO) with GEO recommendations *evidence-ranked* from the Princeton GEO paper (KDD 2024), rather than a flat single-discipline checklist.

## Version

Lens library v2.23 — 2026-05-29 (34 lenses; L34 gained its two-phase Audit→Action-Plan + strategic opportunity discovery). Prior: v2.22 (34; L34 added), v2.21 (33; L31–L33), v2.17 (30, original). Each lens prompt is version-controlled and revised via standard Bob EVOLVE cycles. Lens additions or significant rewrites bump the library minor version; lens removals require a Decision Log entry.
