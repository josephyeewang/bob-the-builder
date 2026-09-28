---
id: L26
name: Marketing, Copy & Website
band: 7
band_name: Strategic & Market
when_to_run: Any product with marketing surfaces (homepage, landing, blog, docs, social). Mandatory before launches, after positioning changes, quarterly drift check.
estimated_duration: 60-120 min
session_pattern: fresh session; reads L24, L25, L27, L28 if available
output_markdown: audit-artifacts/L26-marketing-copy-website-{YYYY-MM-DD}.md
output_json: audit-artifacts/L26-marketing-copy-website-{YYYY-MM-DD}.json
source_frameworks:
  - Google Helpful Content Update (HCU) / E-E-A-T
  - AI-slop detection (post-2023 SEO penalty signals)
  - Joanna Wiebe / Copyhackers conversion-copy frameworks (PAS, AIDA, voice-of-customer)
  - April Dunford 5-component positioning
  - NN/g 5-second test
  - NN/g 10 usability heuristics (applied to marketing surfaces)
---

# L26 — Marketing, Copy & Website

## Question this lens answers

*Across homepage, landing pages, pricing, docs, blog, emails, and social — is the messaging clear, consistent, AI-slop-free, SEO-readable, conversion-tuned, and voice-coherent with the brand?*

## Why this lens exists / what other lenses miss

L28 (Wedge) checks whether the messaging is opinionated/sharp. L26 checks whether it's *clear*. The two are separate — a product can have a sharp wedge with muddy execution, or vice versa.

Sub-streams Joe called out:
1. **Contradiction hunting** — homepage says X, pricing page says Y, blog says Z
2. **Simplifying / sharpening language** — Wiebe-style PAS, message hierarchy
3. **Content relevance and linking** — internal-link graph, content-hub structure
4. **SEO readability** — meta, structured data, indexability
5. **AI-slop detection** — Google HCU penalty signals
6. **Voice consistency vs variation** — same person across surfaces, but appropriately toned

## When this lens fires

**Always-in-Full-Enchilada for products with marketing surfaces.** Curated panel inclusion criteria:
- ✅ Always — products with homepage, landing pages, public-facing copy.
- ✅ Mandatory — before launches, after positioning changes, quarterly drift check.
- ⏸ Skip — purely internal tools with no marketing surface.

## Session setup

- Start a **fresh Claude Code session.**
- Read L24, L25, L27, L28 if available.
- Inputs:
  - Live URLs: homepage, key landing pages, pricing, blog, docs index, About page
  - Recent emails (welcome, drip campaigns, transactional)
  - Social channels (Twitter/X, LinkedIn)
  - Existing content calendar / editorial guidelines
- Tools:
  - Hemingway (readability) or readable.com
  - Google Search Console (if available)
  - SEO crawler (Screaming Frog, Sitebulb) — for internal link graph
  - AI-content detector (OpenAI's classifier deprecated; use heuristics + manual)

## Source frameworks

- **Google Helpful Content Update (HCU)** — March 2024 core update absorbed HCU; targets 40% reduction in unhelpful content. Sites >90% unedited AI content saw mass deindexing within 3-6 months.
- **E-E-A-T (Experience, Expertise, Authoritativeness, Trust)** — Google quality framework.
- **AI-slop signals** — "delve," "tapestry," "furthermore," "in conclusion," "it's important to note," "navigating the landscape," "ever-evolving," excessive em-dashes per 200 words, listicle padding, no first-person experience, no original data/screenshots, hollow tricolons.
- **Joanna Wiebe / Copyhackers** — PAS (Problem-Agitate-Solution), AIDA, message hierarchy, voice-of-customer (VoC) writing, "spit draft" off wireframe. https://copyhackers.com
- **April Dunford 5-component positioning** — competitive alternatives, unique attributes, value+proof, target customer, market category. https://www.aprildunford.com
- **NN/g 5-second test** — show page for 5s; user can name what it does + who for + what's different.

## Audit method

1. **5-second test on homepage.** Show 5 strangers the homepage for 5 seconds. Can each name (a) what it does, (b) who it's for, (c) what's different? <3/5 = hero failure.

2. **Dunford 5-pack on hero.** Write one sentence each for competitive alternative, unique attribute, value+proof, target customer, market category. Any blank = positioning gap.

3. **AI-slop scan.** Grep the site for:
   - "delve," "tapestry," "furthermore," "in conclusion," "it's important to note"
   - "navigating the landscape," "ever-evolving," "harness the power of"
   - Em-dashes per 200 words >3 (uncommon in human writing)
   - Hollow tricolons ("X, Y, and Z" patterns where Z adds nothing)
   - "Comprehensive" / "robust" / "innovative" / "cutting-edge" (LLM crutches)
   Flag pages above thresholds for rewrite.

4. **Originality test on top 10 pages.** Per page, count:
   - First-person stories (founder POV, customer case, behind-the-scenes)
   - Original screenshots
   - Proprietary data / charts
   - Named customer quotes (not anonymous)
   <3 of those per page = HCU risk.

5. **Cross-surface contradiction sweep.** Across homepage / pricing / docs / blog / sales deck — does each say the same thing about:
   - ICP (target customer)
   - Core promise (hero claim)
   - #1 differentiator
   Every mismatch is a finding.

6. **Wiebe PAS on hero + first scroll.** Is the problem named in customer's words (VoC) BEFORE the solution? Or does the page open with the product?

7. **Message hierarchy.** Rank H1 → H2 → body in priority order. Does each level pay off the one above? Or jump topics?

8. **CTA strength audit.** Each page has ONE primary CTA, verb-led, specific ("Start free with your email" vs "Get Started"). Pages with >1 primary CTA = diluted.

9. **Trust signal audit on conversion pages.**
   - Real-name testimonials with face/title/company
   - Customer logos (with permission)
   - Security/compliance badges (SOC2, GDPR)
   - Pricing transparency
   - Refund/cancel policy linked from footer
   Count missing.

10. **SEO readability.**
    - Flesch-Kincaid ≤Grade 9 on marketing pages, ≤Grade 12 on docs
    - Paragraphs ≤3 lines
    - H-tag hierarchy strict (no H2 without H1)
    - Meta description on every page
    - Title tag unique per page

11. **Internal-link graph.**
    - Hub pages link to ≥3 spoke pages and vice versa
    - Any orphan pages (0 inbound links)?
    - Stale / 404'd internal links

12. **Voice consistency.** Pick 10 random copy blocks from different surfaces. Do they sound like one person? Tone variance is fine (docs ≠ landing); voice variance is not.

13. **Content audit.**
    - % of pages updated in last 12 months
    - % with named author
    - % with original data / screenshots
    - HCU loves freshness + E-E-A-T

14. **Page-killer audit.** Does any page exist primarily to rank for a keyword vs primarily to help a known user? Kill or rewrite.

## Check questions

1. 5-second test passes on homepage (3/5 strangers)?
2. Dunford 5-pack writable for hero?
3. AI-slop grep finds any pages above thresholds?
4. Top 10 pages have ≥3 originality signals each?
5. Cross-surface contradictions on ICP / promise / differentiator?
6. Hero applies Wiebe PAS (problem first, in customer's words)?
7. Message hierarchy intact?
8. Each page has ONE primary CTA?
9. Trust signals on conversion pages (testimonials, logos, badges)?
10. Readability ≤Grade 9 marketing, ≤Grade 12 docs?
11. Internal-link graph healthy (no orphans, hub-spoke patterns)?
12. Voice consistent across surfaces?
13. Content freshness — % updated in last 12 months?
14. Any pages exist to rank vs to help? (HCU casualties)
15. Has cross-surface contradiction sweep been done at least once this quarter?

## Output schema

### Markdown report

```markdown
# L26 — Marketing, Copy & Website — {YYYY-MM-DD}

## 5-second test results
- N strangers: 5
- "What it does" recall: X/5
- "Who for" recall: X/5
- "What's different" recall: X/5
- Verdict: pass / fail

## Dunford 5-pack
| Component | Hero sentence | Blank? |
|---|---|---|
| Competitive alternative | ... | |
| Unique attribute | ... | |
| Value + proof | ... | |
| Target customer | ... | |
| Market category | ... | |

## AI-slop scan
| Page | Slop signal | Severity |
|---|---|---|

## Originality on top 10 pages
| Page | First-person | Original screenshots | Proprietary data | Named quotes | Pass HCU? |
|---|---|---|---|---|---|

## Cross-surface contradictions
| Topic | Homepage | Pricing | Docs | Blog | Mismatch? |
|---|---|---|---|---|---|

## Hero structure
- Wiebe PAS: applied / not
- Problem in VoC: yes/no
- Message hierarchy intact: yes/no

## CTAs
| Page | # primary CTAs | Verb-led | Specific |
|---|---|---|---|

## Trust signals
| Conversion page | Testimonials | Logos | Badges | Pricing transparency | Refund policy |
|---|---|---|---|---|---|

## SEO readability
| Page type | F-K grade level | Paragraph length | H-hierarchy | Meta desc unique | Title unique |
|---|---|---|---|---|---|

## Internal-link graph
- Orphan pages: N
- Hubs linking to ≥3 spokes: %
- Stale internal links: N

## Voice consistency
| Surface | Voice notes | Coherent? |
|---|---|---|

## Content freshness
- Updated in 12 months: X% of pages
- With named author: X%
- With original assets: X%

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L26",
  "lens_name": "Marketing, Copy & Website",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "five_second_test_pass": false,
  "dunford_5_pack_blanks": 0,
  "ai_slop_pages_flagged": 0,
  "originality_pages_passing_hcu": 0,
  "contradictions_count": 0,
  "wiebe_pas_applied": false,
  "primary_cta_dilution_pages": 0,
  "trust_signals_present_pct": 0,
  "readability_grade_marketing": null,
  "readability_grade_docs": null,
  "orphan_pages_count": 0,
  "voice_coherent": null,
  "content_freshness_pct": 0,
  "findings": [
    {
      "id": "L26-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "hero_unclear|positioning_gap|ai_slop|hcu_originality_low|cross_surface_contradiction|hero_product_first|message_hierarchy_break|cta_dilution|missing_trust_signal|readability_too_high|orphan_page|voice_inconsistent|stale_content|page_killer_keyword_targeted",
      "title": "{short}",
      "surface": "{URL or page}",
      "evidence": "{specific copy / pattern}",
      "recommendation": "{specific rewrite or change}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Hero fails 5-second test (3/5 strangers can't name what it does). Dunford 5-pack has 2+ blanks (foundational positioning gaps). Site at HCU risk (top pages no originality, AI-slop prevalent).
- **Major** — Cross-surface contradiction on core promise. AI-slop on homepage. CTA dilution >50% of pages. Voice inconsistent across surfaces.
- **Minor** — Readability above target. Stale content. Internal-link gaps.
- **Cosmetic** — Polish; specific phrasing improvements.

## Anti-patterns / Bias instructions

- **Do NOT recommend "write more content."** HCU penalizes more content if it's unoriginal. Quality + originality > quantity.
- **Do NOT optimize for keywords at the expense of clarity.** Keyword-stuffed content is HCU bait.
- **Do NOT recommend "use AI to generate more content."** That's the L26 antagonist. Use AI to draft, but human-edit for originality + first-person + brand voice.
- **Bias toward "would a real prospect read this and feel they understand the product?"** Not "did we mention every feature?"
- **After fixing any hero/marketing claim, grep every surface for the same claim class (v2.19).** Failure this prevents: a hero subhead ("Get a real diagnosis") that contradicted an AI-safety fix was corrected on the homepage, but analogous "diagnosis / doctor-replacement" copy survived on other surfaces. A marketing claim fixed in one place but live in five is still a liability. Enforced generally at build-protocol §A7.3.

## Stop conditions

1. **No marketing surface.** Skip.

## Cross-lens handoff

- **Upstream:** L24, L25, L27, L28.
- **Downstream:** L29 Onboarding (homepage promise → onboarding payoff).
- **Adjacent (~15% overlap):**
  - **L28 Wedge** — both touch voice; L26 = clarity, L28 = sharpness.
  - **L20 Shareability** — page titles + meta descriptions overlap.
