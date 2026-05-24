---
id: L20
name: Shareability, Virality & Discoverability
band: 5
band_name: Reach & Distribution
when_to_run: Public-facing products. Mandatory if growth depends on word-of-mouth, SEO, or viral mechanics.
estimated_duration: 45-90 min
session_pattern: fresh session
output_markdown: audit-artifacts/L20-shareability-virality-discoverability-{YYYY-MM-DD}.md
output_json: audit-artifacts/L20-shareability-virality-discoverability-{YYYY-MM-DD}.json
source_frameworks:
  - OpenGraph protocol — https://ogp.me
  - Twitter / X Cards spec
  - Schema.org structured data
  - Andrew Chen "The Cold Start Problem" — atomic networks
  - Reforge / Brian Balfour growth loops
  - Viral loop archetypes (watermark / referral / collaboration / embed)
---

# L20 — Shareability, Virality & Discoverability

## Question this lens answers

*When users want to share this product (or are exposed to it via search / social / referral), does the moment of exposure render correctly, carry attribution, preserve context, and load into discoverable infrastructure?*

## Why this lens exists / what other lenses miss

Engineering audits never check whether a Slack-link unfurl shows the right thumbnail. UX audits rarely walk the post-success share affordance. Growth audits often look at viral coefficient without checking whether the underlying mechanics (OG tags, attribution, share UX) actually function. This lens covers the surfaces that determine whether word-of-mouth, SEO, and viral mechanics can WORK — independent of whether they're being actively cultivated.

The DLL audit didn't have a virality lens. EMBT (health-adjacent) probably doesn't either. Most products ship without ever sharing their own link to iMessage / Slack / LinkedIn / X to see what renders. That's L20's headline test.

## When this lens fires

**Always-in-Full-Enchilada for public products.** Curated panel inclusion criteria:
- ✅ Mandatory — products where growth depends on word-of-mouth, SEO, viral mechanics, referral, organic sharing.
- ✅ Strongly recommended — any public-facing product (any "person sends a link to another person" use case).
- ⏸ Skip — private internal tools, products with no public surface.

## Session setup

- Start a **fresh Claude Code session.**
- Tools:
  - **Meta Sharing Debugger** — https://developers.facebook.com/tools/debug/
  - **X Card Validator** (Twitter) — https://cards-dev.twitter.com/validator
  - **LinkedIn Post Inspector** — https://www.linkedin.com/post-inspector/
  - **Google Rich Results Test** — https://search.google.com/test/rich-results
  - **Google Search Console** (if available)
- Real test: paste the top 5 URLs into iMessage, Slack, Discord, LinkedIn, X. See what renders.

## Source frameworks

- **OpenGraph protocol** — required tags + image sizing (1200x630 universal). https://ogp.me
- **Twitter / X Cards** — `summary_large_image` is the default. https://developer.x.com/en/docs/twitter-for-websites/cards/overview/abouts-cards
- **Schema.org** — structured data (Article, Product, FAQ, Event, Organization, BreadcrumbList). https://schema.org
- **Andrew Chen — Cold Start Problem** — atomic networks, anti-network-effects, three network types (acquisition, engagement, economic). https://a16z.com/books/the-cold-start-problem/
- **Reforge growth loops** — loops > funnels; output of one cycle = input to next.
- **Viral loop archetypes** — Watermark (Loom, Calendly, Zoom; K≈0.15-0.3), Referral incentive (Dropbox), Collaboration ("Shared with you on Notion"), Content embed (Figma, Loom).

## Audit method

1. **Link-unfurl audit.** Paste the top 5 product URLs into iMessage, Slack, Discord, LinkedIn, X, WhatsApp. For each:
   - Title — correct?
   - Description — present, accurate, compelling?
   - Image — 1200×630 (1.91:1), critical text in safe-zone 1080×600 center, ≤1MB, HTTPS absolute URL?
   - Any blank / broken unfurls?

2. **OG + Twitter Card tag audit.** For each page type, verify:
   - `<meta property="og:title">` — descriptive, ≤60 chars
   - `<meta property="og:type">` — website, article, product as appropriate
   - `<meta property="og:url">` — canonical absolute URL
   - `<meta property="og:image">` — absolute HTTPS, 1200×630
   - `<meta property="og:description">` — ≤155 chars
   - `<meta name="twitter:card" content="summary_large_image">`
   - `<meta name="twitter:image">` if different from OG

3. **SEO basics audit.**
   - Every page has unique `<title>` (50-60 chars) and meta description (150-160)
   - `rel=canonical` on every page (prevents duplicate-content issues)
   - `robots.txt` doesn't block production paths (common mistake when staging copies prod)
   - `sitemap.xml` present and referenced in robots.txt
   - Sitemap submitted to Google Search Console
   - Structured data (JSON-LD) for relevant types, validated by Rich Results Test

4. **Share affordances audit.**
   - Where in the product are share buttons / share affordances?
   - Do they appear at moments of value (post-success, post-completion) vs always-on?
   - Do they prefill platform-specific text + tracked URL?
   - Is Web Share API used on mobile (`navigator.share`)?
   - Copy-link fallback on desktop?
   - Do shared links preserve user context (deep-link to specific item, not just homepage)?

5. **Viral mechanics audit.**
   - Is there an engineered viral loop? Identify which archetype:
     - Watermark — e.g., "Made with X" footer, Calendly "Powered by Calendly"
     - Referral incentive — both sides rewarded?
     - Collaboration — sharing creates new users (multi-player products)
     - Content embed — public-link / oEmbed / iframe
   - K-factor measurable?
   - Anti-virality patterns avoided? (Sharing requires login? Sharing strips context? Watermark too aggressive and disabled by users?)

6. **Attribution preservation.**
   - UTMs survive redirect chain
   - UTMs survive auth wall / signup
   - Referral codes survive OAuth round-trip
   - Deep links preserved into native app (if applicable)

7. **Embed-ability audit.**
   - oEmbed endpoint? (For products that produce shareable content like Loom, Figma)
   - iframe-friendly? (`X-Frame-Options` / `frame-ancestors` set appropriately)
   - Tested embed on Notion, Medium, Substack?

8. **Discoverability beyond own surfaces.**
   - Indexed in Google?
   - Listed in any directories / aggregators where target users browse?
   - Featured / linkable from places target users hang out?

## Check questions

1. Paste top 5 URLs into iMessage, Slack, LinkedIn, X, Discord — does each render correct unfurl?
2. Is OG image absolute HTTPS, ≤1MB, with critical content in center 1080×600 safe zone?
3. Are required OG tags present + Twitter Card declared?
4. Does each page have unique `<title>` (≤60), meta description (~155), `rel=canonical`?
5. Is `sitemap.xml` present, referenced in `robots.txt`, submitted in Search Console?
6. Is structured data (JSON-LD) implemented for relevant types, validated by Rich Results Test?
7. Where do shared artifacts live, and do they carry attribution (footer badge, watermark, "Made with X")?
8. Is there at least one engineered viral loop? Which archetype? K-factor target?
9. Do share affordances appear at moment of value (post-success, not pre-action)?
10. Do UTMs / referral codes survive redirect, auth wall, OAuth?
11. Is Web Share API used on mobile with copy-link fallback on desktop?
12. For embeddable content: oEmbed endpoint? Tested iframe on Notion / Medium / Substack?
13. Is anything noindex/blocked that *shouldn't* be (`Disallow: /` accidentally in prod robots.txt)?
14. Is the product indexed in Google for its main brand term?
15. Are share moments instrumented (analytics on share-button clicks, attribution on incoming referrals)?

## Output schema

### Markdown report

```markdown
# L20 — Shareability, Virality & Discoverability — {YYYY-MM-DD}

## Link unfurl test (real test)
| URL | iMessage | Slack | LinkedIn | X | Discord | Findings |
|---|---|---|---|---|---|---|

## OG + Twitter Card audit per page type
| Page type | og:title | og:image | og:description | twitter:card | Issues |
|---|---|---|---|---|---|

## SEO basics
| Page | `<title>` | Meta desc | Canonical | In sitemap | Indexed |
|---|---|---|---|---|---|

## Structured data
| Page type | Schema type | Validates? |
|---|---|---|

## Share affordances
| Surface | Affordance present | Moment | Prefills | Web Share API | Findings |
|---|---|---|---|---|---|

## Viral mechanics
| Archetype | Implemented | K-factor target | Measured |
|---|---|---|---|
| Watermark | yes/no | | |
| Referral incentive | | | |
| Collaboration | | | |
| Embed | | | |

## Attribution preservation
| Path | UTMs survive | Referral code survives |
|---|---|---|

## Discoverability
| Channel | Status |
|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L20",
  "lens_name": "Shareability, Virality & Discoverability",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "unfurl_test_pass_rate": 0.0,
  "og_tag_completeness_pct": 0,
  "twitter_card_present_pct": 0,
  "seo_basics_pct": 0,
  "structured_data_pages": 0,
  "share_affordances_at_moment_of_value": 0,
  "viral_loop_present": false,
  "viral_loop_archetype": null,
  "attribution_survives": false,
  "google_indexed": null,
  "findings": [
    {
      "id": "L20-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "broken_unfurl|missing_og_image|missing_og_tags|missing_twitter_card|missing_canonical|missing_meta_desc|missing_sitemap|robots_blocks_prod|missing_structured_data|no_share_affordance|share_at_wrong_moment|attribution_dropped|no_viral_loop|anti_viral_pattern|embed_broken|not_indexed",
      "title": "{short}",
      "evidence": "{URL / tag / surface}",
      "user_impact": "{1-sentence}",
      "growth_impact": "{1-sentence}",
      "recommendation": "{specific fix}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Unfurls broken on top URLs (zero thumbnails, missing title). robots.txt blocks production. No share affordance at all on a product that depends on sharing.
- **Major** — OG image wrong size / missing on top pages. Attribution drops at auth wall. No viral loop on a product whose growth depends on virality.
- **Minor** — Structured data gaps. Share affordances at wrong moment. Web Share API not used.
- **Cosmetic** — OG image / unfurl polish opportunities.

## Anti-patterns / Bias instructions

- **Do NOT skip the live unfurl test.** Tag-validation tools say "OG present" — but the actual unfurl on iMessage/Slack reveals the real failures (image cached, image too big, image dimensions wrong, text cropped).
- **Do NOT recommend "build a viral loop" generically.** Viral mechanics require structural fit — not every product can/should viral. Recommend specific loops only when the product shape supports them.
- **Do NOT confuse SEO checklist completion with discoverability.** Indexed ≠ found. Discoverability requires being where target users look.
- **Bias toward "what happens when a real user pastes our link?"** That's the moment-of-truth.

## Stop conditions

1. **No public surface.** Skip.

## Cross-lens handoff

- **Upstream:** L17 Device (share affordances mobile-friendly).
- **Downstream:** L26 Marketing (OG copy is marketing copy), L30 Retention/Loops (viral mechanics are growth loops).
- **Adjacent (~15% overlap):**
  - **L30** — viral loops overlap with growth loops; L30 is whole-loop, L20 is share-touchpoint.
  - **L26** — page titles and meta descriptions are marketing copy.
