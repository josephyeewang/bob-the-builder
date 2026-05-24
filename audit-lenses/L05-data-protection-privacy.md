---
id: L05
name: Data Protection & Privacy
band: 1
band_name: Engineering Foundation
when_to_run: Mandatory for products handling personal data, health data, financial data, children's data, or EU/UK users. Skip only for products with verifiably zero personal data.
estimated_duration: 60-150 min depending on data surface size
session_pattern: fresh session; reads L04 (Security) report if available
output_markdown: audit-artifacts/L05-data-protection-privacy-{YYYY-MM-DD}.md
output_json: audit-artifacts/L05-data-protection-privacy-{YYYY-MM-DD}.json
source_frameworks:
  - GDPR Article 30 — Records of Processing Activities — https://gdpr-info.eu/art-30-gdpr/
  - GDPR data subject rights (Arts 15-22) — access, rectification, erasure, restriction, portability, objection
  - CCPA / CPRA — California Consumer Privacy Act
  - HIPAA Privacy & Security Rules (for health data)
  - PCI DSS (for payment card data)
  - COPPA (for under-13 users)
  - Microsoft Presidio (PII discovery) — https://microsoft.github.io/presidio/
  - NIST Privacy Framework — https://www.nist.gov/privacy-framework
---

# L05 — Data Protection & Privacy

## Question this lens answers

*What personal data does the product collect / process / store / share, and is each flow compliant with the applicable privacy regimes (GDPR, CCPA, HIPAA, PCI, COPPA, etc.) including data-subject rights?*

## Why this lens exists / what other lenses miss

L04 Security covers info-disclosure as a STRIDE category. It does NOT cover the full data lifecycle: what gets collected, why (lawful basis), how long it's kept, who it's shared with, what rights the data subject has, and whether those rights are operationally available. Privacy is not a subset of security — it's a parallel discipline with its own legal frameworks and engineering implications.

The product can be fully secure (no leaks, no breaches) and fully non-compliant (over-collecting, retaining indefinitely, no erasure path, no records of processing, no DPA with vendors). The fines under GDPR can reach 4% of global revenue; under CCPA, $7,500 per intentional violation per consumer. This lens names the gaps before they become incidents.

The DLL audit didn't catch a privacy lens at all — privacy was not in scope. EMBT (health-adjacent) flagged it heavier. L05 makes privacy explicit and consistent.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Mandatory — any product processing personal data, health data, financial data, children's data, or EU/UK users.
- ✅ Strongly recommended — any product with user accounts, even if data is minimal.
- ⏸ Skip — products with verifiably zero personal data (rare; even logs typically contain IP addresses which are personal data under GDPR).

## Session setup

- Start a **fresh Claude Code session.**
- Read L04 (Security & Threat Surface) report — info-disclosure findings are L05 inputs.
- Inputs to load:
  - `docs/architecture-contract.md` (data classification, retention)
  - `docs/domain-specs/*.md` (per-subsystem data details)
  - `docs/privacy-policy.md` (if exists) — what the product TELLS users vs what it DOES
  - Database schema (every table, every column)
  - Log structure / log retention config
  - Third-party integrations list (every vendor receiving data)
- Install / verify tooling:
  - **Microsoft Presidio** — `pip install presidio-analyzer presidio-anonymizer` for PII discovery
  - Optional: **Privado** for SaaS-scale PII mapping
- Determine applicable regimes upfront:
  - Any EU/UK users → GDPR
  - California residents → CCPA/CPRA
  - Health data → HIPAA (US)
  - Payment cards → PCI DSS
  - Under-13 users → COPPA
  - State-specific: Virginia VCDPA, Colorado CPA, etc.

## Source frameworks

- **GDPR Article 30** — Records of Processing Activities. Every controller MUST maintain a record of data flows. https://gdpr-info.eu/art-30-gdpr/
- **GDPR Articles 15-22** — Data subject rights: access, rectification, erasure, restriction, portability, objection, no-automated-decision.
- **CCPA / CPRA** — "Do Not Sell or Share," "Right to Know," "Right to Delete," "Right to Correct," "Right to Limit Use of Sensitive PI."
- **HIPAA Privacy Rule (45 CFR §164.500)** + Security Rule — for Protected Health Information (PHI).
- **PCI DSS 4.0** — for payment cards. https://www.pcisecuritystandards.org
- **COPPA** — for users under 13. https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- **Microsoft Presidio** — open-source PII discovery library. https://microsoft.github.io/presidio/
- **NIST Privacy Framework** — Identify-P / Govern-P / Control-P / Communicate-P / Protect-P. https://www.nist.gov/privacy-framework

## Audit method

1. **Determine applicable regimes.** EU users → GDPR. California residents → CCPA. Health data → HIPAA. Payment cards → PCI. Under-13 → COPPA. Often multiple apply.

2. **PII discovery.** Walk the database schema column by column. Walk log structures. Walk every API request/response. For each, identify whether it contains:
   - **Direct identifiers** — name, email, phone, government ID, IP address (under GDPR)
   - **Quasi-identifiers** — DOB + zip combo, device IDs, locations
   - **Special-category data (GDPR Art 9)** — health, genetic, biometric, race, religion, political opinions, sexual orientation, trade union membership
   - **Financial data** — payment cards (PCI), bank accounts
   - **Children's data**

   Run Presidio against sample data + log samples to surface anything missed.

3. **Build the Records of Processing inventory (GDPR Art 30 even if non-EU — it's a useful baseline).** For each data flow:
   - **Purpose** — why this data is processed
   - **Lawful basis** (GDPR) — consent / contract / legitimate interest / vital interest / public interest / legal obligation
   - **Categories of data subjects**
   - **Categories of personal data**
   - **Recipients** — who receives this data (internal teams, third parties, processors)
   - **Cross-border transfers** — does it leave the EEA? UK? Under what mechanism (SCCs, adequacy, BCRs)?
   - **Retention period** — how long is it kept; what triggers deletion
   - **Security measures**

4. **Data-subject rights operational check.** For each GDPR right (access, rectification, erasure, restriction, portability, objection):
   - Is there an operational mechanism for users to invoke it?
   - How long from request to fulfillment? (GDPR: 30 days default.)
   - Is identity-verification required and proportionate?
   - For erasure: does it cascade across replicas, backups, third-party processors, log archives, AI training data, analytics?

5. **Retention audit.** For each PII-containing table/log/cache, is there a documented retention period? Is there an automated deletion job? When did it last run successfully? (DLL had memory decay engine but never scheduled — same pattern.)

6. **Vendor / processor audit.** For every third party receiving personal data: DPA in place? Sub-processor list available? Data location? Breach notification SLA? Is the relationship documented in `decision-log.md` or equivalent?

7. **Consent management audit.** Where consent is the lawful basis: is it granular (per-purpose)? Specific? Informed? Freely given? Withdrawable as easily as granted? Logged with timestamp?

8. **Privacy policy vs reality check.** Open the privacy policy. For each claim, verify the code matches. ("We delete data after 12 months" vs no deletion job. "We don't sell data" vs analytics tracker that may qualify as sale under CCPA.)

9. **Children's data (if applicable).** Under-13 → COPPA verifiable parental consent flow. Under-16 → GDPR consent threshold considerations.

## Check questions

1. Have you determined every applicable privacy regime (GDPR, CCPA, HIPAA, PCI, COPPA, state laws)?
2. Have you discovered every PII column / log field / API field — including indirect identifiers (IP, device ID)?
3. Have you run Presidio (or equivalent) to catch PII you missed?
4. Have you built a GDPR Art 30 Records of Processing? Even if not legally required, it's a forcing function for completeness.
5. For each data flow: lawful basis named, retention named, recipients named?
6. Is there an operational mechanism for every data-subject right? (Access, rectification, erasure, restriction, portability, objection.)
7. For erasure: does it cascade across replicas, backups, third-party processors, log archives, AI training data, analytics?
8. Is there a documented retention period for every PII store? Is the deletion job automated and verified-running?
9. For every third-party vendor receiving personal data: is there a DPA? Sub-processor list? Breach SLA?
10. If consent is the lawful basis: is it granular, specific, informed, freely given, withdrawable, logged?
11. Does the privacy policy match the code? (Common gap: policy says "we delete after 12 months" but no deletion job exists.)
12. Are special-category data items (health, biometric, etc.) handled with appropriate additional protections?
13. For AI products: is training-data origin documented? Is user data being used for model training? Has consent been obtained?
14. Is there a documented breach response plan with notification SLAs (72hr GDPR, varies CCPA)?
15. Is there a Data Protection Officer or accountable role named, if required?

## Output schema

### Markdown report

```markdown
# L05 — Data Protection & Privacy — {YYYY-MM-DD}

## Applicable regimes
{GDPR, CCPA, HIPAA, PCI, COPPA — list with rationale}

## PII discovery
| Source | Field | Type (direct/quasi/special/financial/children) | Lawful basis | Retention |
|---|---|---|---|---|

## Records of Processing (GDPR Art 30 format)
| Purpose | Lawful basis | Data subjects | Data categories | Recipients | Cross-border? | Retention | Security |
|---|---|---|---|---|---|---|---|

## Data subject rights operational check
| Right | Mechanism exists? | Avg fulfillment time | Cascades to backups/3rd parties/AI? |
|---|---|---|---|

## Retention audit
| Store | Documented retention | Deletion job? | Last successful run |
|---|---|---|---|

## Vendor / processor audit
| Vendor | Data shared | DPA in place? | Sub-processors documented? | Breach SLA | Data location |
|---|---|---|---|---|---|

## Privacy policy vs reality check
| Policy claim | Code reality | Match? |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L05",
  "lens_name": "Data Protection & Privacy",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "applicable_regimes": ["gdpr", "ccpa"],
  "pii_inventory_count": 0,
  "special_category_data_found": false,
  "records_of_processing_completeness": 0.0,
  "data_subject_rights_coverage": {
    "access": "manual|automated|missing",
    "rectification": "manual|automated|missing",
    "erasure": "manual|automated|missing",
    "restriction": "manual|automated|missing",
    "portability": "manual|automated|missing",
    "objection": "manual|automated|missing"
  },
  "retention_coverage": {
    "stores_with_documented_retention": 0,
    "stores_with_automated_deletion": 0,
    "stores_without_retention": 0
  },
  "vendor_dpa_coverage": {
    "vendors": 0,
    "with_dpa": 0,
    "without_dpa": 0
  },
  "policy_reality_mismatches": 0,
  "findings": [
    {
      "id": "L05-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "no_lawful_basis|no_retention|no_erasure_mechanism|erasure_doesnt_cascade|no_dpa|policy_reality_mismatch|special_category_no_extra_protection|consent_not_granular|children_no_parental_consent|cross_border_no_mechanism|over_collection",
      "regime": "gdpr|ccpa|hipaa|pci|coppa|multiple",
      "title": "{short}",
      "evidence": "{schema column / config / vendor name}",
      "legal_exposure": "high|medium|low",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Special-category data (health, biometric, etc.) processed without explicit additional protection. Children's data without verifiable parental consent. PII shared with vendor without DPA. Erasure right requested but cannot be operationally fulfilled. Privacy policy materially contradicts code (legal exposure).
- **Major** — Lawful basis missing or wrong (e.g., legitimate interest claimed where consent is required). Retention undocumented or indefinite. Data-subject rights mechanism manual where automation should exist. Erasure that doesn't cascade to backups or processors.
- **Minor** — Granularity gaps in consent (bundled vs per-purpose). Documentation gaps in Records of Processing. Vendor sub-processor list out of date.
- **Cosmetic** — Privacy policy phrasing improvements; legal-readable but user-confusing language.

## Anti-patterns / Bias instructions

- **Do NOT skip privacy because "we don't think GDPR applies."** GDPR has extraterritorial reach. If you have a single EU user, it applies.
- **Do NOT confuse security with privacy.** Encryption is a security control; lawful basis is a privacy requirement. Both are required.
- **Do NOT recommend "add a cookie banner."** Cookie banners are user-hostile and rarely compliant. If consent is the lawful basis, consent must be specific, informed, granular, freely given, and easy to withdraw. A "Accept All" banner with no per-purpose toggle fails.
- **Do NOT mark "anonymized" data as out-of-scope without verifying.** True anonymization is a high bar (GDPR Recital 26 — irreversibility). Pseudonymized data is still personal data.
- **Bias toward "what would happen if a regulator asked tomorrow?"** Findings should be regulator-readable, not just engineer-readable.
- **For AI products: training-data provenance is a critical sub-audit.** Has user data been used to train models? Has consent been obtained? Can users opt out? Is the answer documented?

## Stop conditions (the gap IS the finding)

1. **No privacy policy exists.** Surface as a Critical finding. Stop further L05 work until at least a draft policy exists.
2. **No data classification in `architecture-contract.md`.** Run L05 anyway but flag the missing classification as a foundational gap.
3. **Database schema is not accessible.** L05 cannot complete without schema visibility. Request access; document the gap.
4. **AI training-data provenance is unknown.** For AI products, this is a critical privacy posture gap on its own — surface it explicitly.

## Cross-lens handoff

- **Upstream:**
  - **L04 Security & Threat Surface** — info-disclosure findings feed into L05's confidentiality posture.
- **Downstream:**
  - **L21 Observability & Incident Readiness** — breach response requires logging; L05 surfaces logging adequacy from privacy angle.
  - **L25 Pricing & Monetization** — privacy is a trust signal; pricing-page transparency builds on privacy clarity.
  - **L27 Persona Simulation** — privacy-paranoid persona is a critical test.
- **Adjacent (~15% overlap):**
  - **L04** — both touch info-disclosure; L04 covers it as STRIDE/OWASP, L05 covers it as lifecycle/rights. Dedup at aggregation.
  - **L22 Vendor & Dependency Risk** — vendor DPA / sub-processor list overlaps with vendor lock-in / sunset analysis.
