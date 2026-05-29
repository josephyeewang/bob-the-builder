# Evolution 002 — SEO / AEO / GEO Discoverability Lens (L34)

- **Mode:** EVOLVE
- **Classification:** Medium (1 new lens + wiring; new domain/pattern → Reference Scan fired)
- **Date opened:** 2026-05-29
- **Origin:** Joe — "almost every product will have a website, which means it needs SEO and AI-EO." Wants one selectively-invokable audit ("hey Bob, run the SEO audit") that aggregates the fragmented SEO/AEO/GEO field into a master structured approach that beats them all.
- **Version target:** v2.22

## What & why

Bob's library has **no technical-SEO lens**, and **AEO/GEO is entirely absent** — yet nearly every product ships a website, and AI answer/generative engines (AI Overviews, ChatGPT, Perplexity, Gemini, Claude) are a fast-growing, high-intent discovery channel (AI-referred sessions +527% YoY in early 2025). L20 (social-share unfurl) and L26 (copy/readability) only graze the surface.

## The "beats them all" thesis

Every surveyed guide is a *flat checklist for one of the three*. L34's spine is the insight that **SEO, AEO, and GEO are layers of one discoverability funnel sharing a common substrate** (see reference-scan.md):

- **Tier 0 — Foundation** (shared): crawlable · indexable · fast · server-rendered · semantically structured · schema'd.
- **Tier 1 — SEO**: rank in the blue links (on-page, internal linking, content depth, E-E-A-T, authority).
- **Tier 2 — AEO**: win the *extracted* answer (answer-first blocks, FAQ/QAPage schema, question targeting).
- **Tier 3 — GEO**: get *cited* by generative engines (statistics, quotations, source citations, entity consistency, AI-crawler access, freshness, off-site presence, platform targeting).

Two things make it rigorous rather than another listicle:
1. **Evidence-ranked recommendations.** GEO tactics are ranked by the **Princeton GEO paper (KDD 2024)** measured effect sizes — cite sources +115%, statistics +41%, quotations +28%, keyword stuffing **−10% (hurts)** — not by opinion.
2. **Leverage ordering.** Tier 0 unlocks all three, so a Tier-0 failure outranks a Tier-3 polish. The lens fixes foundation first instead of dumping 200 flat items.

## Scope (in / out)

**In:** one new lens `L34` (Band 5), covering all three tiers, with **independently-runnable tiers** (a user can request only the GEO tier); executable checks orchestrating incumbent tools (Lighthouse, a crawler, Schema validator, robots/AI-crawler check); evidence-ranked GEO recommendations; full lens template; wiring + count 33→34.

**Out (non-goals):** no custom crawler (D-003 — orchestrate Lighthouse/LibreCrawl/open-seo-crawler/CrawlIQ/Screaming Frog); no paid backlink-authority data faked (flag as DEFER/human); no re-measuring Core Web Vitals (reference L17); no social-unfurl (stays L20); no copy-voice rewrite (stays L26).

## Design decisions

- **D-EVO5 — One lens, four tiers, tiers independently runnable.** Honors Joe's "one invokable SEO audit" while letting `run the GEO tier of L34` work standalone. Rejected splitting into 3 lenses (would fragment the shared-foundation insight and add sprawl).
- **D-EVO6 — Evidence-ranked, not opinion-ranked.** Every GEO recommendation cites the Princeton effect size or is labeled "practitioner-consensus, unmeasured." `llms.txt` explicitly tagged low-confidence/forward-looking (no major crawler honors it yet, Oct 2025).
- **D-EVO7 — Reference, don't re-run, overlapping signals.** CWV/mobile → cite L17; content clarity/voice → hand to L26; social unfurl → hand to L20. Declared cross-lens seams prevent double-work and double-counting.
- **D-EVO8 — Append-only ID + profile-conditional.** L34, Band 5. Fires when the product has a public website/marketing surface; skip pure internal tools / APIs with no web presence. Added to website-bearing panels + a dedicated "AI-visibility / SEO scrub" mini-panel.

## File manifest

**New:** `audit-lenses/L34-seo-aeo-geo.md`; `evolutions/002-…/{reference-scan,spec}.md` ✓.

**Edit (wiring):** `audit-lenses/README.md` (Band 5 row, 33→34, distinctive note, version); `_selection-rubric.md` (count + profile trigger + SEO/AI-visibility mini-panel); `_aggregation.md` (L34 = actionable, normal queue; strategic sub-findings like positioning stay out); `_execution-principle.md` (L34 catalog row — heavy execute); `_audit-memory.md` (counts); `build-protocol-core.md` (Band 5 table + count + footer); `build-protocol.md` (band table + count); `skill/SKILL.md` (description); `README.md` public (33→34 + reach mention); `CLAUDE.md` (v2.22 entry); `audit-log.md` (EVOLVE pass).

**Frozen:** historical changelog/audit-log entries (counts stay at their shipped values).

## Reconcile / verify (E5)

- Lens has all 13 template sections; tiers independently runnable; every GEO recommendation cites an effect size or is labeled unmeasured.
- No live "33-lens" left; version = v2.22; distinctness/adjacency declared (L20/L26/L17/L19).
- Commit + push.

## Continuation — v2.23 (same-day, on Joe's follow-up)

Joe pushed: the lens must not just *audit* but produce *what fixes to make* — tactical, work-oriented, and strategic. v2.22 L34 was audit-heavy (per-finding tactical recs only). Added without splitting the lens:

- **D-EVO9 — One lens, two phases (Audit → Action Plan).** Rejected splitting into an audit lens + a strategy lens — the plan derives from the findings + opportunity scan; splitting fragments a coupled flow and adds sprawl.
- **3-altitude Action Plan** (① tactical fixes · ② content to produce · ③ strategic positioning) as the primary deliverable.
- **Strategic opportunity discovery** (new method steps 20-23): topic-space seeding w/ relevance gate → free demand signals (GSC striking-distance, autocomplete, PAA, community, AI sub-questions) → competitor content-gap → relevance × demand × winnability scoring → sequenced roadmap. No fabricated volumes.
- JSON `opportunities[]` + `action_plan{}`; +5 check questions; +4 anti-patterns; +1 stop condition. Version → v2.23; lens count unchanged (34).

## Deferred

- **F58 — Backlink/authority depth.** Off-page authority needs paid data (Ahrefs/Semrush). L34 flags it as human/paid-tool follow-up rather than faking. Revisit if a free authority source becomes reliable.
- **F59 — GEO effect-size drift.** The Princeton numbers are 2024; generative engines change fast (40-60% of cited sources churn monthly). Revisit trigger: a newer peer-reviewed GEO study, or a second real field retro that contradicts the rankings.
