---
id: L34
name: SEO / AEO / GEO Discoverability
band: 5
band_name: Reach & Distribution
when_to_run: Any product with a public website or marketing surface (almost everything). Skip pure internal tools / headless APIs with no web presence. Mandatory before launch and at quarterly drift checks. The three tiers are independently runnable — a user can request just the GEO tier.
estimated_duration: 90-180 min for the full 4-tier sweep; 30-45 min for a single tier
session_pattern: fresh session; reads L17 (Core Web Vitals / mobile), L26 (copy/voice), L20 (social unfurl), L19 (semantic HTML) if available, and references their measurements instead of re-running them
output_markdown: audit-artifacts/L34-seo-aeo-geo-{YYYY-MM-DD}.md
output_json: audit-artifacts/L34-seo-aeo-geo-{YYYY-MM-DD}.json
source_frameworks:
  - "GEO: Generative Engine Optimization — Aggarwal et al., ACM KDD 2024 (Princeton / Georgia Tech / IIT Delhi / AI2), arXiv 2311.09735 — the only peer-reviewed GEO evidence; effect sizes below"
  - Technical-SEO 12-category consensus (crawl / index / render / CWV / mobile / schema / hreflang / architecture / logs / security / sitemaps)
  - Core Web Vitals 2025 thresholds (LCP <2.5s, INP <200ms, CLS <0.1, TTFB <800ms @ p75 mobile)
  - schema.org + JSON-LD; Google Rich Results Test; FAQPage / QAPage / HowTo / Article / Organization / BreadcrumbList
  - AEO featured-snippet & People-Also-Ask extraction (answer-first, question targeting)
  - Entity optimization / E-E-A-T (consistent entity across Wikipedia / LinkedIn / Crunchbase / G2 / Reddit — "the new PageRank for AI")
  - llms.txt (Answer.AI, 2024 — emerging, low adoption; forward-looking hedge) + AI-crawler directives (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
  - AI-visibility measurement (share-of-AI-voice, citation frequency, sentiment — Profound / Otterly / Semrush AI Toolkit)
  - Open-source crawlers to orchestrate: Lighthouse / PageSpeed, LibreCrawl, open-seo-crawler, CrawlIQ, Screaming Frog
---

# L34 — SEO / AEO / GEO Discoverability

## Question this lens answers

*Will the engines that decide who gets found — classic search, answer engines, and generative AI engines — actually find, rank, extract, and cite this product's website? Across all three: is it crawlable and structured (Foundation), does it rank (SEO), does it win the extracted answer (AEO), and does it get cited by ChatGPT / Perplexity / AI Overviews / Gemini / Claude (GEO)?*

## Why this lens exists / what other lenses miss

Almost every product has a website, so almost every product lives or dies on discoverability — and the channel is fracturing. Classic SEO (the 10 blue links) now shares the page with **answer engines** (featured snippets, voice, People-Also-Ask) and **generative engines** (AI Overviews, ChatGPT, Perplexity, Gemini, Claude), where AI-referred sessions grew **+527% YoY** in early 2025 and convert at higher intent. No existing Bob lens audits this: L20 covers *social* unfurl (will a shared link look good), L26 covers copy clarity/conversion and readability-level SEO — neither audits technical SEO, and **AEO and GEO are entirely absent**.

The field is a pile of fragmented, single-discipline checklists (one for SEO, one for AEO, one for GEO), most of them opinion-ranked. This lens beats them by doing two things none of them do together:

1. **A unified 4-tier model.** SEO, AEO, and GEO are not three separate audits — they're **layers of one discoverability funnel sharing a common substrate.** A GEO citation is impossible if the Foundation fails. So the lens audits Foundation → SEO → AEO → GEO, dedupes the shared ~60%, and ranks fixes by *which layer they unlock* (fix Foundation first — it feeds all three).
2. **Evidence-ranked, not opinion-ranked, recommendations.** GEO tactics are ordered by the **measured effect sizes from the Princeton GEO paper (KDD 2024)** — not vibes. The headline numbers (used throughout Tier 3):

   | GEO tactic | Measured effect on AI visibility | Verdict |
   |---|---|---|
   | Cite credible external sources | **+115%** (largest; strongest on lower-ranked pages) | do first |
   | Add statistics (with named sources) | **+41%** | high leverage |
   | Add quotations from named experts | **+28%** | high leverage |
   | Add more words (no structure) | **≈0%** | useless |
   | **Keyword stuffing** | **−10% (HURTS)** | anti-pattern |

## When this lens fires

**Always-in-Full-Enchilada for products with a web surface.** Curated panel inclusion criteria:
- ✅ Mandatory — any product with a public website, landing pages, blog, or docs (almost everything).
- ✅ Mandatory — before launch, after a redesign/replatform, and at quarterly drift checks (engines + AI citation patterns shift fast).
- ✅ Tier-scoped on request — a user can run just one tier ("run the GEO tier"). Tier 0 should run with any tier (it's the substrate).
- ⏸ Skip — pure internal tools, headless APIs, or apps with verifiably no web presence and no AI-discovery ambition.

## Session setup

- Start a **fresh Claude Code session.**
- Read L17 (Core Web Vitals / mobile — *reference its measurements, don't re-run*), L26 (copy/voice — hand content-clarity findings there), L20 (social unfurl — hand OG/share findings there), L19 (semantic HTML) if available.
- Inputs to load:
  - Live URLs: homepage, top landing pages, key blog/docs, pricing. (This lens audits the **rendered, deployed site** — not source assumptions.)
  - `robots.txt`, `sitemap.xml`, `llms.txt` (if any), and any framework SEO config (Next.js metadata, Nuxt SEO, etc.).
  - Product Spec — target audience, the queries/topics the product should own, declared markets/languages.
  - Google Search Console access if available (indexation, queries, CWV field data).
- Tooling (orchestrate, don't reinvent — D-003):
  - **Lighthouse / PageSpeed Insights** (CLI or API) — performance, SEO, best-practices scores.
  - A **crawler** — LibreCrawl / open-seo-crawler / CrawlIQ / Screaming Frog — for site-wide crawl/index/link analysis.
  - **Google Rich Results Test + Schema.org validator** — structured-data validity.
  - **curl / fetch** — robots.txt, AI-crawler directives, status codes, server vs. client rendering (compare raw HTML vs. rendered DOM).
  - **Playwright** — render check (does primary content exist before JS?), answer-block inspection.
  - AI-visibility tools if available (Profound / Otterly / Semrush AI Toolkit) — share-of-AI-voice; otherwise spot-prompt the engines directly (see Tier 3).

## Source frameworks

- **GEO: Generative Engine Optimization** — Aggarwal et al., **ACM KDD 2024** (Princeton/GT/IIT-Delhi/AI2), arXiv 2311.09735. 9 methods × 10,000 queries × 10 engines; introduced position-adjusted impression + subjective-impression metrics. Effect sizes in the table above. The empirical spine of Tier 3.
- **Technical-SEO consensus** — 12 categories: crawlability, indexation, rendering/JS, Core Web Vitals, mobile, structured data, hreflang, site architecture, log analysis, security, sitemaps/robots, tooling.
- **Core Web Vitals (2025)** — LCP <2.5s · INP <200ms · CLS <0.1 · TTFB <800ms @ 75th-pctile mobile.
- **schema.org / JSON-LD** — Google's preferred structured-data format; FAQPage/QAPage (AEO + GEO), HowTo, Article/BlogPosting, Organization, BreadcrumbList, Product. Validate via Rich Results Test.
- **AEO** — answer-first content (direct answer in first 40-60 words; 2.5× more snippet-eligible), question targeting (PAA), voice.
- **Entity optimization / E-E-A-T** — consistent entity description across owned + third-party properties (Wikipedia, LinkedIn, Crunchbase, G2, Reddit); "entity authority is the new PageRank for AI search."
- **llms.txt** — Answer.AI 2024 proposed standard; **no major AI crawler requests it as of Oct 2025** — treat as a cheap forward-looking hedge, not a ranking lever. AI-crawler directives: GPTBot (OpenAI), ClaudeBot (Anthropic), PerplexityBot, Google-Extended (Gemini/AI Overviews).
- **AI-visibility measurement** — share-of-AI-voice, citation frequency, sentiment (Profound, Otterly.AI, Peec, Semrush AI Toolkit). Note: 40-60% of AI-cited sources change month-to-month — GEO is an ongoing discipline.

## Audit method

> Run the tiers in order. Tier 0 is the shared substrate — always run it. Each later tier *assumes Tier 0 passed*; a Tier-0 failure caps everything above it, so rank a Tier-0 fix above any Tier-3 polish.

### Tier 0 — Foundation (shared substrate; required by SEO, AEO, and GEO)

1. **Crawl access.** Fetch `robots.txt`. Is anything important `Disallow`ed? Are **AI crawlers** (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) blocked? (Blocking them = invisible to GEO — flag as a decision, not auto-bad.) Confirm `sitemap.xml` returns 200, lists only canonical URLs, `lastmod` is real, <50k URLs/file.
2. **Indexation.** Crawl the site; reconcile crawlable URLs vs. sitemap vs. (if available) GSC indexed count. Flag `noindex` on revenue pages, soft-404s, "crawled — not indexed," canonical errors, parameter-URL bloat, crawl depth >4 clicks, orphan pages.
3. **Rendering.** `curl` the raw HTML and compare to the Playwright-rendered DOM. **Is primary content present in the initial HTML before JS executes?** Heavy client-side rendering hides content from crawlers and AI retrieval — flag SSR/prerender gaps.
4. **Performance (reference L17).** Pull Core Web Vitals — LCP <2.5s, INP <200ms, CLS <0.1, TTFB <800ms @ p75 mobile. If L17 ran, cite its numbers; otherwise run Lighthouse/PSI. Perf is a ranking signal *and* an AI source-reliability signal.
5. **Structured data.** Inventory JSON-LD across page types; validate via Rich Results Test. Is the most specific schema.org type used? Does schema mirror the visible content (not contradict it)? Org schema on homepage, Article/BlogPosting on editorial, BreadcrumbList sitewide.
6. **Hygiene.** HTTPS + valid cert, no mixed content, HSTS; one canonical per page; hreflang bidirectional + x-default if multi-locale; clean URL structure.

### Tier 1 — SEO (rank in the blue links)

7. **On-page.** Per top page: unique title (<60 chars, primary term front-loaded), meta description, strict H1→H2→H3 hierarchy, descriptive image `alt`, semantic HTML (overlaps L19).
8. **Internal linking & architecture.** Hub-and-spoke pattern; pillar pages link to ≥3 spokes and back; descriptive anchor text; no orphans; breadcrumbs rendered + marked up.
9. **Content & intent.** Do the priority pages match search intent (informational/commercial/transactional)? Is there topical depth (clusters), not thin one-offs? (Hand prose clarity/voice to L26.)
10. **E-E-A-T & authority.** Author bylines + credentials (Person schema), original data/screenshots, named citations. Backlink/domain authority is paid-data — **flag for human/paid-tool follow-up (F58), don't fake a number.**

### Tier 2 — AEO (win the extracted answer)

11. **Answer-first blocks.** For each target question, is there a **concise direct answer in the first 40-60 words** of a section, under a question-phrased heading? (Direct-answer content is ~2.5× more snippet-eligible.)
12. **Question targeting (PAA / voice).** Map the People-Also-Ask / conversational questions in the niche; does the site answer them explicitly? Are answers scannable (lists, tables, definitions)?
13. **Answer schema.** FAQPage / QAPage / HowTo JSON-LD on appropriate pages, validated, and *mirroring visible Q&A* (no orphan schema). This is the single highest-leverage structured-data type for both AEO and GEO.

### Tier 3 — GEO (get cited by generative engines)

> Apply the Princeton effect sizes. Rank recommendations by measured leverage.

14. **Citation & evidence density (highest leverage).** Does content **cite credible external sources** (the +115% tactic), include **statistics with named sources** (+41%), and **quote named experts** (+28%)? These are the strongest measured GEO levers. Their *absence* on a page meant to be cited is a major finding.
15. **Extraction-friendliness.** Self-contained paragraphs (one complete idea each, no "as mentioned above"); front-loaded points; concrete facts over vague claims; clear descriptive headings. (LLMs lift well-structured passages near-verbatim.)
16. **Entity consistency (the "new PageRank").** Is the brand described consistently — name, category, what it's authoritative for — across the site, schema, Wikipedia, LinkedIn, Crunchbase, and review sites (G2/Capterra/Trustpilot)? Inconsistent entity signals lower AI citation confidence.
17. **Off-site presence.** AI engines pull from Reddit/YouTube/review sites, not just owned content (ChatGPT skews Wikipedia; Perplexity skews Reddit/recency; AI Overviews reuse top-ranking pages; Claude favors multi-source/balanced). Is the brand present where its target engines source from?
18. **AI-crawler access + freshness.** AI crawlers NOT blocked (Tier 0 cross-check); content updated recently (recency is a retrieval signal — stale pages get dropped). `llms.txt` present is a **cheap forward-looking hedge** — note it, but flag honestly that no major crawler honors it yet (Oct 2025), so it is *not* a ranking lever today.
19. **Measure AI visibility.** If tooling exists (Profound/Otterly/Semrush AI), pull **share-of-AI-voice**, citation frequency, and sentiment vs. competitors. Otherwise, **spot-prompt the engines directly**: ask ChatGPT/Perplexity/AI-Overviews 5-10 category questions and record whether the brand is cited, in what context, with what sentiment. Note this is a snapshot — 40-60% of cited sources churn monthly.

### Synthesis

20. **Rank by tier-leverage × impact.** A Tier-0 break (robots blocking the site; client-only rendering) caps all three funnels → Critical. Within GEO, rank by Princeton effect size. Produce the top 3 highest-leverage fixes and a per-tier scorecard.

## Check questions

1. Does `robots.txt` allow important pages, and are AI crawlers (GPTBot/ClaudeBot/PerplexityBot/Google-Extended) intentionally allowed or blocked (a logged decision)?
2. Does `sitemap.xml` return 200, list only canonical URLs, with real `lastmod`?
3. Crawled vs. sitemap vs. indexed — any `noindex` on revenue pages, soft-404s, canonical errors, orphans, crawl depth >4?
4. Is primary content in the **initial HTML before JS** (raw `curl` vs. rendered DOM)?
5. Core Web Vitals within thresholds @ p75 mobile (LCP/INP/CLS/TTFB) — per L17?
6. Is JSON-LD present, valid (Rich Results Test), most-specific-type, and mirroring visible content?
7. HTTPS/HSTS clean, one canonical per page, hreflang correct if multi-locale?
8. Top pages: unique front-loaded title, meta description, strict H-hierarchy, alt text?
9. Hub-and-spoke internal linking, descriptive anchors, no orphans, breadcrumbs marked up?
10. Does content match search intent with topical depth (not thin)?
11. E-E-A-T: author credentials (Person schema), original data, named citations? (Backlink authority → flagged for paid-tool/human.)
12. **AEO:** concise direct answer in the first 40-60 words under question-phrased headings?
13. **AEO:** are PAA/voice/conversational questions explicitly answered and scannable?
14. **AEO:** FAQPage/QAPage/HowTo schema present, valid, mirroring visible Q&A?
15. **GEO:** does cite-able content include external source citations (+115%), statistics (+41%), expert quotations (+28%)?
16. **GEO:** extraction-friendly prose — self-contained, front-loaded, concrete, clear headings?
17. **GEO:** entity described consistently across site + Wikipedia/LinkedIn/Crunchbase/review sites?
18. **GEO:** off-site presence where the target engines source (Reddit/YouTube/reviews)?
19. **GEO:** AI crawlers not blocked + content fresh? (llms.txt noted as low-confidence hedge.)
20. **GEO:** is AI visibility measured (share-of-AI-voice / spot-prompt) with sentiment, not just frequency?
21. Is there evidence of the **keyword-stuffing anti-pattern** (measured −10%) anywhere?
22. What's the single highest-leverage fix, ranked by tier × Princeton effect size?

## Output schema

### Markdown report

```markdown
# L34 — SEO / AEO / GEO Discoverability — {YYYY-MM-DD}

## Tier scorecard
| Tier | Verdict (pass/gaps/fail) | Top issue |
|---|---|---|
| 0 Foundation | | |
| 1 SEO | | |
| 2 AEO | | |
| 3 GEO | | |

## Tier 0 — Foundation
| Check | Result | Evidence (tool/command) | Severity |
|---|---|---|---|

## Tier 1 — SEO
| Check | Result | Evidence | Severity |
|---|---|---|---|

## Tier 2 — AEO
| Check | Result | Evidence | Severity |
|---|---|---|---|

## Tier 3 — GEO (recommendations ranked by Princeton effect size)
| Check | Result | Measured leverage | Evidence | Severity |
|---|---|---|---|---|

## AI-visibility snapshot
| Engine | Brand cited? | Context | Sentiment | Query |
|---|---|---|---|---|
(spot-prompt or tool data; note snapshot volatility)

## Anti-patterns found
| Pattern | Where | Why it hurts |
|---|---|---|

## Top 3 highest-leverage fixes (tier × impact)
1. ...

## Handed to other lenses
- L17 (CWV depth): ...   - L26 (copy/voice): ...   - L20 (social unfurl): ...
- Flagged for human/paid tool (F58 backlink authority): ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L34",
  "lens_name": "SEO / AEO / GEO Discoverability",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "tiers_run": ["foundation", "seo", "aeo", "geo"],
  "tier_verdicts": {"foundation": "", "seo": "", "aeo": "", "geo": ""},
  "ai_crawlers_blocked": [],
  "core_web_vitals_pass": null,
  "structured_data_valid": null,
  "answer_first_coverage_pct": null,
  "geo_evidence_density": {"cites_sources": false, "has_statistics": false, "has_expert_quotes": false},
  "entity_consistency_ok": null,
  "ai_visibility_measured": false,
  "keyword_stuffing_detected": false,
  "executed_against_live_site": false,
  "findings": [
    {
      "id": "L34-F001",
      "severity": "critical|major|minor|cosmetic",
      "tier": "foundation|seo|aeo|geo",
      "category": "crawl_blocked|index_error|client_render_hides_content|cwv_fail|invalid_schema|no_answer_first|missing_answer_schema|low_evidence_density|poor_extraction|entity_inconsistent|no_offsite_presence|ai_crawler_blocked|stale_content|keyword_stuffing|unmeasured_ai_visibility|onpage_gap|thin_content|eeat_gap",
      "title": "{short}",
      "surface": "{URL / page type}",
      "measured_leverage": "{e.g. +115% cite-sources | n/a}",
      "evidence": "{tool output / command}",
      "recommendation": "{specific change}",
      "handed_to": "L17|L26|L20|human_paid_tool|null"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — A Tier-0 break that caps all three funnels: site/important pages blocked in robots, primary content client-rendered (invisible to crawlers + AI), site `noindex`'d, no valid HTTPS. AI crawlers blocked while the product *wants* AI visibility. Keyword stuffing on key pages (measured to actively hurt).
- **Major** — Missing/invalid structured data on key templates; no answer-first content on pages meant to win snippets; **zero evidence density** (no citations/statistics/quotes) on content meant to be AI-cited; inconsistent entity signals; CWV failing on top templates (per L17); broken internal architecture / orphan revenue pages.
- **Minor** — Suboptimal titles/meta/H-hierarchy; thin PAA coverage; missing `llms.txt` (low-confidence); off-site presence gaps on secondary platforms; un-measured AI visibility where tooling exists.
- **Cosmetic** — Polish on already-passing pages; nice-to-have schema types.

## Anti-patterns / Bias instructions

- **Do NOT audit from source — audit the deployed, rendered site.** Crawlers and AI engines see the rendered output, not your intent. Always `curl` raw HTML vs. rendered DOM.
- **Do NOT reinvent a crawler (D-003).** Orchestrate Lighthouse / LibreCrawl / open-seo-crawler / CrawlIQ / Screaming Frog. Building a custom SEO crawler is the wrong call.
- **Do NOT recommend keyword stuffing or density tricks.** The Princeton data measured keyword stuffing at **−10%** — it hurts. This lens's recommendations are evidence-ranked.
- **Do NOT present GEO tactics as opinion.** Cite the effect size (cite-sources +115%, statistics +41%, quotations +28%) or label a recommendation "practitioner-consensus, unmeasured." Don't inflate `llms.txt` — flag honestly that no major crawler honors it yet.
- **Do NOT re-measure CWV/mobile or re-audit copy voice.** Reference L17; hand prose clarity/voice to L26; hand social-unfurl/OG to L20. Stay on the engine-discoverability machinery.
- **Do NOT fabricate authority/backlink numbers.** Off-page authority needs paid data — flag for human/paid-tool follow-up (F58), don't guess a DA score.
- **Do NOT treat an AI-visibility snapshot as stable.** 40-60% of AI-cited sources change monthly — label it a point-in-time reading and recommend ongoing monitoring.
- **Bias toward tier-leverage:** a Tier-0 fix that unlocks all three funnels beats a clever Tier-3 tweak. Rank accordingly.

## Stop conditions (the gap IS the finding)

1. **No web surface.** Internal tool / headless API with no site. Skip and note.
2. **Cannot reach the live site** (no deployed URL, auth-walled). Audit what's reachable statically (robots/sitemap/schema in source), flag that rendered/CWV/AI-visibility checks could not run, and recommend re-running against the deployed URL.
3. **No AI-visibility tooling and engines won't answer category prompts.** Report Tier 0-2 fully; for Tier 3 measurement, record the spot-prompt attempt and flag that quantified share-of-AI-voice needs a dedicated tool. Do not fabricate citation numbers.
4. **Backlink/authority depth requested but only free tools available.** Deliver on-site E-E-A-T signals; flag off-page authority as paid-tool/human follow-up (F58).

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (target queries/markets), L17 Device & Form Factor (CWV/mobile measurements), L26 Marketing/Copy (content/voice baseline).
- **Downstream:**
  - **L26 Marketing/Copy** — content-clarity / voice / AI-slop fixes L34 surfaces in content go to L26.
  - **L20 Shareability** — OG/meta/social-unfurl findings go to L20.
  - **L33 Output Register** — if AI-facing content needs register/structure tuning, L33 owns the rewrite quality.
  - **L24 Competitive** — share-of-AI-voice vs. competitors feeds competitive positioning.
- **Adjacent (~15% overlap):**
  - **L20** — both touch discoverability; L20 = *social* (human-shared unfurl), L34 = *engine* (rank/answer/cite). Overlap only on OG/meta tags; declared.
  - **L26** — L26 owns copy clarity + readability-level SEO; L34 owns the technical + answer + generative-engine machinery. Seam declared.
  - **L17** — CWV/mobile measured once in L17; L34 references, doesn't re-run.
  - **L19** — semantic HTML / heading hierarchy serve both a11y and crawlability; different goals.
