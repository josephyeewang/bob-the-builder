---
id: L18
name: Internationalization & Language
band: 5
band_name: Reach & Distribution
when_to_run: Products with any international audience, OR ambitions to expand internationally, OR EU presence (Digital Services Act / Accessibility Act). Often skipped for US-first MVPs.
estimated_duration: 45-90 min
session_pattern: fresh session
output_markdown: audit-artifacts/L18-internationalization-language-{YYYY-MM-DD}.md
output_json: audit-artifacts/L18-internationalization-language-{YYYY-MM-DD}.json
source_frameworks:
  - W3C i18n checklist + i18n-checker — https://validator.w3.org/i18n-checker/
  - Mozilla L10n best practices — https://mozilla-l10n.github.io/documentation/localization/dev_best_practices.html
  - ICU MessageFormat — https://unicode-org.github.io/icu/userguide/format_parse/messages/
  - FormatJS / i18next conventions
  - Unicode CLDR
---

# L18 — Internationalization & Language

## Question this lens answers

*Is this product ready for non-English users, RTL languages, locale-specific formatting, and translator workflow — even if today's users are all English-speaking?*

## Why this lens exists / what other lenses miss

i18n debt is the canonical "future-blocking present decisions" problem. Strings hardcoded today require a refactor pass to translate tomorrow. Plurals expressed as `count === 1 ? "item" : "items"` break in most languages. Concatenation breaks word order. Layouts that work for English break under German (30-40% longer strings) or Arabic (RTL with bidi). Date / number / currency formatting hardcoded for US-style breaks for everyone else.

Even US-first products usually have global users within 6-12 months. The cost of fixing i18n later >> the cost of doing it right early. This lens surfaces the debt and prioritizes.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Mandatory — any product with international users today, or planned expansion.
- ✅ Recommended — any product with broad consumer ambition (international users will arrive).
- ⏸ Skip — pure internal tool with verifiably no international users planned.

## Session setup

- Start a **fresh Claude Code session.**
- Inputs to load:
  - Codebase (string literals, formatting calls)
  - HTML templates / JSX / Vue / Svelte components
  - Any existing locale files / translation infrastructure
  - User location data if available (where are real users from?)
- Tools:
  - W3C i18n Checker — https://validator.w3.org/i18n-checker/ (online)
  - `eslint-plugin-i18n-text` or equivalent linter for hardcoded strings
  - Browser RTL test via Chrome DevTools (set page direction to RTL)

## Source frameworks

- **W3C i18n Quick Checks + Checker** — https://www.w3.org/International/i18n-drafts/techniques/shortchecklist + https://validator.w3.org/i18n-checker/
- **Mozilla L10n best practices** — https://mozilla-l10n.github.io/documentation/localization/dev_best_practices.html
- **ICU MessageFormat** — plurals, gender, select, nested args. https://unicode-org.github.io/icu/userguide/format_parse/messages/
- **FormatJS / i18next** — runtime libraries implementing ICU.
- **Unicode CLDR** — locale data (number formats, plural rules, names).

## Audit method

1. **Determine user-locale reality.** Where are users today? Where will they be in 12 months? What languages?

2. **Hardcoded string scan.** Grep the codebase for user-visible English strings:
   - JSX/templates: `>{text}<` patterns
   - Inline strings in components
   - Error messages, success messages, button labels
   - Email templates, SMS copy
   - Marketing pages
   For each, mark as: externalized (in locale file) / hardcoded (needs externalization) / build-time-formatted (date/number/currency).

3. **HTML language declaration audit.** Every page should have `<html lang="…">`. Any page without it OR with wrong language → finding.

4. **String concatenation audit.** Search for `"Hello, " + name + "!"` and similar patterns. Concatenation breaks word order in many languages.

5. **Plural handling audit.** Search for `count === 1 ? "item" : "items"`. ICU MessageFormat: `{count, plural, one {item} other {items}}`. Replace ternary plurals with ICU.

6. **RTL audit (if Arabic/Hebrew planned or applicable).**
   - Are CSS properties using logical (`margin-inline-start`) vs physical (`margin-left`)?
   - Do icons mirror appropriately (chevrons yes, brand logos no)?
   - Does layout flip cleanly when `dir="rtl"` is set?
   - Bidi handling for embedded other-direction content (`<bdi>` tag)?

7. **Pseudo-localization test.** Replace all UI strings with accented variants 1.4x length (e.g., "Save" → "Ŝävé Ƥćcñvē Tëśţ"). Walk the UI. Any truncated labels, broken buttons, table headers cut off, nav items wrapped weirdly → findings.

8. **Locale formatting audit.**
   - Dates: hardcoded `MM/DD/YYYY` vs `Intl.DateTimeFormat`?
   - Numbers: hardcoded `1,234.56` vs `Intl.NumberFormat`?
   - Currency: hardcoded `$X.YZ` vs `Intl.NumberFormat({style: 'currency', currency})`?
   - Units: hardcoded "5 miles" vs locale-appropriate?
   - Name order: "First Last" assumption vs locale-aware?
   - Address forms: US-style state-zip vs locale-aware?

9. **Translator workflow audit.**
   - Do translation files have context comments per string?
   - Are screenshot references included for ambiguous strings?
   - Are character-byte limits documented for space-constrained surfaces (push notifications, SMS, button labels)?
   - Are placeholder names self-describing (`{userName}` not `{p1}`)?

10. **Font / glyph coverage.** Does the font stack render CJK, Devanagari, Arabic shaping without "tofu" boxes at common weights?

## Check questions

1. Does every HTML page declare `charset=UTF-8`, `<html lang="…">`, and (if applicable) `dir="rtl"`?
2. Are any user-visible strings hardcoded in source (grep for literal English)?
3. Are plurals expressed via ICU `{count, plural, one {…} other {…}}`, never `count === 1 ? "item" : "items"`?
4. Are strings ever built by concatenation instead of placeholders?
5. Does the UI survive RTL flipping — mirrored layout, mirrored icons (chevrons, undo), but NOT mirrored content (phone numbers, code, logos)?
6. Does pseudo-localization at 1.4× expansion truncate any label, button, nav, table header?
7. Are dates / numbers / currency / units formatted via `Intl.*` with locale, not hand-formatted?
8. Do translation files include context comments / screenshots / max-length per string?
9. Is locale negotiation deterministic — `Accept-Language` → user pref → fallback?
10. Does the font stack render every supported script without tofu at common weights?
11. Run W3C i18n-checker on 3 representative pages — any errors/warnings?
12. Are placeholder names self-describing?
13. Is name-order locale-aware (Eastern vs Western)?
14. Are address forms locale-aware or US-only?
15. For email / SMS templates: are they translated or English-only?

## Output schema

### Markdown report

```markdown
# L18 — Internationalization & Language — {YYYY-MM-DD}

## User-locale reality
- Current user locales: {distribution}
- Planned expansion: {locales}
- Languages today: {languages}
- RTL needed? Yes/No/Future

## Hardcoded strings inventory
| Surface | Strings hardcoded | Strings externalized | Coverage % |
|---|---|---|---|

## HTML language declaration
| Page | `<html lang>` correct? | `dir` set? |
|---|---|---|

## Concatenation findings
| File | Pattern | ICU replacement |
|---|---|---|

## Plural handling findings
| File | Current pattern | ICU replacement |
|---|---|---|

## RTL findings (if applicable)
{list}

## Pseudo-localization results
| Surface | Truncated/broken | Severity |
|---|---|---|

## Locale formatting findings
| Type (date/number/currency/unit/name) | Surface | Hardcoded format | Recommendation |
|---|---|---|---|

## Translator workflow gaps
{list}

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L18",
  "lens_name": "Internationalization & Language",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "current_locales": [],
  "planned_locales": [],
  "string_externalization_coverage_pct": 0,
  "concatenation_findings": 0,
  "plural_ternary_findings": 0,
  "rtl_ready": false,
  "pseudo_loc_truncations": 0,
  "intl_formatting_coverage_pct": 0,
  "html_lang_correct_pct": 0,
  "findings": [
    {
      "id": "L18-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "hardcoded_string|string_concatenation|ternary_plural|missing_html_lang|rtl_layout_broken|pseudo_loc_truncation|hardcoded_date_format|hardcoded_number_format|hardcoded_currency|name_order_assumption|us_address_only|translator_context_missing|font_glyph_gap|locale_negotiation_missing",
      "title": "{short}",
      "evidence": "{file:line or surface}",
      "blocks_locale": "{which locale gets affected}",
      "recommendation": "{specific change with ICU/Intl example}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Product blocked from international expansion by hardcoded UI strings (>50% strings hardcoded). RTL completely broken. Locale negotiation absent.
- **Major** — String concatenation present (breaks word order). Ternary plurals (breaks non-English plural rules). Date/number/currency hardcoded.
- **Minor** — Translator context missing. Pseudo-loc truncation in non-primary surfaces. Some `Intl.*` adoption, some hand-formatted.
- **Cosmetic** — Self-describing placeholder names; consistency in i18n infrastructure choices.

## Anti-patterns / Bias instructions

- **Do NOT skip i18n audit for US-first MVPs.** Hardcoded debt accumulates fast; cost of refactoring later is 5-10x cost of building right early.
- **Do NOT recommend "wait until we have international users."** By then the rewrite is expensive. Externalize strings from day 1; translate later.
- **Do NOT confuse i18n (infrastructure) with l10n (specific translations).** i18n is "ready to be translated"; l10n is "translated." This lens audits i18n.
- **Bias toward "what would break if German speakers showed up tomorrow?"** German strings are ~30-40% longer than English; the truncation pattern reveals layout fragility.
- **Half-shipped i18n → one binary decision, not N findings (v2.19).** When the UI is mostly hardcoded (e.g. <5% translated) but AI/content output is heavily translated (e.g. >50%) — a common "half-shipped" state — do NOT emit 7 separate per-gap findings. Compress to a single decision finding: **"commit to i18n (and here's the gap list) OR revert the partial translation (and hide the language picker)."** The half-state is the problem; itemizing it is noise.

## Stop conditions

1. **No UI surface.** Skip.

## Cross-lens handoff

- **Upstream:** L07 Ease.
- **Downstream:** L19 Accessibility (RTL ↔ keyboard nav RTL ordering), L26 Marketing (international SEO).
- **Adjacent (~15% overlap):**
  - **L19 Accessibility** — language declaration overlaps with screen-reader pronunciation.
