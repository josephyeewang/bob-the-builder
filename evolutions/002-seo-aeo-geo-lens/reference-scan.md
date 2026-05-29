# Reference Scan — Evolution 002 (E3-pre, per v2.16)

> Deep research across SEO / AEO / GEO. Bias-toward-Reject on reinventing; orchestrate incumbent tools (D-003). Each Adopt names its insertion point in the lens.

## Why this scan fired

New lens introducing **search / answer / generative-engine discoverability** — a domain Bob has only touched tangentially (L20 social-share unfurl, L26 SEO-readability of copy). The genuinely-new surface is **AEO** (answer engines) and **GEO** (generative engines: AI Overviews, ChatGPT, Perplexity, Gemini, Claude) — entirely unrepresented in the 33-lens library. Joe's framing: *almost every product has a website → it needs SEO **and** AI-EO.*

## The field, mapped (what people have built)

The market treats SEO, AEO, and GEO as three separate disciplines with overlapping-but-fragmented checklists. Surveyed material:

- **Technical-SEO checklists** (NoGood, DigitalApplied 200-item, The HOTH, Crawl Compass) — converge on ~12 categories: crawlability, indexation, JS/rendering, Core Web Vitals, mobile, structured data, hreflang, site architecture, log analysis, security, sitemaps/robots, tooling.
- **AEO guides** (CXL, SearchEngineLand, Similarweb, HubSpot AEO Grader) — featured snippets, People-Also-Ask, voice, FAQ/QAPage schema, concise direct answers.
- **GEO** — anchored by the **only peer-reviewed academic work**: *GEO: Generative Engine Optimization*, Aggarwal et al., **ACM KDD 2024** (Princeton / Georgia Tech / IIT Delhi / AI2), arXiv 2311.09735. Plus practitioner playbooks (Frase, Jasper, SearchEngineLand, SEOTuners).
- **Emerging standards** — `llms.txt` (Jeremy Howard / Answer.AI, 2024); AI-crawler directives (GPTBot, ClaudeBot, PerplexityBot, Google-Extended).
- **Measurement** — Profound, Otterly.AI, Peec AI, Semrush AI Toolkit, Nightwatch (share-of-AI-voice, citation frequency, sentiment).
- **Open-source crawlers to orchestrate** — Lighthouse/PageSpeed, LibreCrawl, open-seo-crawler, CrawlIQ, plus Schema.org validator + Google Rich Results Test.

## The synthesis that beats them all: a 4-tier discoverability funnel

Every surveyed guide is a flat checklist for *one* of the three. The insight none of them structure around: **SEO, AEO, and GEO are layers of one funnel sharing a common substrate, diverging only at the top.** That layering is L34's spine — it makes the audit coherent, dedupes the shared 60%, and ranks fixes by which layer they unlock.

| Tier | Goal | Wins when… | Distinctive checks |
|---|---|---|---|
| **0 — Foundation (shared)** | Be reachable & legible to *any* engine | crawlable, indexable, fast, rendered server-side, semantically structured, schema'd | robots/sitemap, indexation, JS-rendering, CWV, structured data |
| **1 — SEO** | Rank in the 10 blue links | classic ranking signals | on-page, internal linking, content depth, E-E-A-T, authority |
| **2 — AEO** | Win the *extracted* answer | featured snippet / PAA / voice | concise answer-first blocks, FAQ/QAPage schema, question targeting |
| **3 — GEO** | Get *cited* by generative engines | AI Overview / ChatGPT / Perplexity citation | statistics, quotations, source citations, entity consistency, AI-crawler access, freshness, off-site presence |

Foundation is required by all three; a GEO win is impossible if Tier 0 fails. This lets L34 *rank* recommendations by leverage (fix Tier 0 first — it unlocks everything) instead of dumping a flat 200-item list.

## Adopt / Defer / Reject

| Source | What it gives | Verdict | Insertion point |
|---|---|---|---|
| **Princeton GEO paper (KDD 2024, arXiv 2311.09735)** | The *only* empirical, peer-reviewed evidence. 9 methods × 10k queries × 10 engines; new visibility metrics (position-adjusted impression, subjective impression). **Effect sizes:** cite credible sources **+115%** (low-rank pages), statistics addition **+41%**, quotation addition **+28%**; "add more words" ≈0%; **keyword stuffing −10% (HURTS)**. Effects vary by domain. | **ADOPT (spine)** | Tier 3 method ranking + severity rubric + the evidence-ranked recommendation principle |
| **Technical-SEO 12-category consensus** | Crawl/index/render/CWV/mobile/schema/hreflang/architecture/logs/security/sitemaps | **ADOPT** | Tier 0 + Tier 1 audit method; executable check list |
| **Core Web Vitals 2025 thresholds** | LCP <2.5s, INP <200ms, CLS <0.1, TTFB <800ms (75th pctile mobile) | **ADOPT** | Tier 0 perf checks — but *reference L17's* measurements, don't re-run |
| **AEO featured-snippet + FAQ/QAPage schema** | Direct-answer-first (40-60 words), question targeting; snippet content 2.5× more likely when it answers directly | **ADOPT** | Tier 2 audit method |
| **schema.org / JSON-LD + Rich Results Test** | Org/Article/FAQ/HowTo/Breadcrumb/Product; validate | **ADOPT** | Tier 0 structured-data checks |
| **Entity optimization ("new PageRank")** | Consistent entity across site + Wikipedia/LinkedIn/Crunchbase/G2/Reddit; entity = AI citation driver | **ADOPT** | Tier 3 off-site + entity-consistency checks |
| **`llms.txt`** | Emerging map-for-LLMs; **no major crawler requests it yet (Oct 2025)** | **ADOPT as low-confidence / forward-looking** | Tier 3 check, explicitly flagged "low adoption — cheap hedge, not a ranking lever today" |
| **AI-crawler directives** (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) | Blocking them = invisibility in GEO | **ADOPT** | Tier 0/Tier 3 — verify NOT blocked if AI visibility wanted |
| **Platform-specific citation patterns** | ChatGPT→Wikipedia/encyclopedic; Perplexity→Reddit/recency/citations; AI Overviews→top-ranking+FAQ; Claude→multi-source/balanced | **ADOPT** | Tier 3 platform-targeting sub-section |
| **AI-visibility measurement** (Profound, Otterly, Semrush AI) | Share-of-AI-voice, citation frequency, sentiment; 40-60% of cited sources churn monthly | **ADOPT (measure-mode)** | Tier 3 measurement + "ongoing discipline" note |
| **Open-source crawlers** (Lighthouse, LibreCrawl, open-seo-crawler, CrawlIQ) + Screaming Frog | Execute the crawl/audit | **ADOPT (orchestrate, D-003)** | Execution-principle row; session setup tooling |
| Commercial rank-trackers (Ahrefs/Semrush/Moz full suites) | Backlink/keyword databases | **DEFER** | Note as optional; backlink-authority depth is a paid-data problem, flag don't fake |
| Build-a-custom-SEO-crawler | — | **REJECT (D-003)** | Orchestrate existing crawlers; never reinvent |
| Keyword stuffing / spammy density tactics | — | **REJECT (evidence: −10%)** | Named anti-pattern in the lens |

## Anti-patterns harvested (baked into the lens)

1. **Keyword stuffing** — measured to *hurt* (−10%); the canonical "don't."
2. **JS-heavy client-side rendering** — content invisible to crawlers/AI retrieval; SSR/prerender required.
3. **Inconsistent entity signals** across web properties — lowers AI confidence/citation.
4. **Schema without content clarity** — schema mirrors visible content; structure the content first.
5. **Sole reliance on owned site** — AI pulls from Reddit/YouTube/review sites; off-site presence matters.
6. **Ignoring sentiment** — high citation frequency is worthless if framed negatively.
7. **Blocking AI crawlers** then expecting GEO visibility — contradiction.
8. **Treating GEO as set-and-forget** — 40-60% of cited sources change monthly.

## Distinctness vs existing lenses (anti-sprawl gate)

- **vs L20 Shareability/Virality/Discoverability** — L20 = *social* discoverability (OG unfurl, share affordances, referral, embed; "will a human-shared link look good"). L34 = *engine* discoverability (rank/answer/cite). Overlap only on OG/meta tags (which serve both) — declared; L34 hands social-unfurl to L20.
- **vs L26 Marketing/Copy/Website** — L26 = copy clarity/conversion/voice/AI-slop + *readability-level* SEO. L34 = the technical + answer + generative-engine machinery. Seam: L34 hands content-clarity/voice to L26; L26 hands technical SEO to L34.
- **vs L17 Device & Form Factor** — overlap on Core Web Vitals + mobile-friendliness (ranking signals). L34 *references* L17's CWV measurements as ranking inputs rather than re-measuring.
- **vs L19 Accessibility** — semantic HTML / heading hierarchy overlap (good a11y ≈ good crawlability). Declared adjacency; different goal.

**Verdict: genuinely new.** No lens does technical SEO; AEO and GEO are entirely absent. Band 5 (Reach & Distribution), beside L17–L20. Heavyweight lens (1-3 hrs) with independently-runnable tiers, so a user can ask for "just the GEO check."
