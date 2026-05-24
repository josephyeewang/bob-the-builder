---
id: L04
name: Security & Threat Surface
band: 1
band_name: Engineering Foundation
when_to_run: Always for products handling user data, authentication, payments, or external integrations. Skip only for fully sandboxed offline tools with no network surface.
estimated_duration: 60-180 min depending on threat surface size
session_pattern: fresh session; reads L01 (Hygiene & Liveness) report if available
output_markdown: audit-artifacts/L04-security-threat-surface-{YYYY-MM-DD}.md
output_json: audit-artifacts/L04-security-threat-surface-{YYYY-MM-DD}.json
source_frameworks:
  - STRIDE threat modeling — https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats
  - OWASP Top 10:2025 — https://owasp.org/Top10/2025/en/
  - OWASP ASVS 5.0 — https://owasp.org/www-project-application-security-verification-standard/
  - CWE Top 25 (2024) — https://cwe.mitre.org/top25/archive/2024/2024_cwe_top25.html
  - NIST SSDF (SP 800-218) — https://csrc.nist.gov/publications/detail/sp/800-218/final
  - Microsoft SDL — https://www.microsoft.com/en-us/securityengineering/sdl/practices
---

# L04 — Security & Threat Surface

## Question this lens answers

*Across the full attack surface, what are the credible threats per OWASP/STRIDE/ASVS, and is the product hardened against them?*

## Why this lens exists / what other lenses miss

L01a is the always-check syntactic security baseline (input validation, authn/authz presence, secret-handling). L04 is the threat-modeling deep-dive — structured walks through STRIDE per asset, OWASP Top 10 categories per surface, ASVS 5.0 chapter checks per component. L01a catches obvious gaps; L04 catches the architectural ones — missing defense-in-depth, weak crypto choices, broken access-control patterns, supply-chain integrity gaps, IDOR / authorization-bypass surfaces, business-logic-abuse paths.

Per D-003 (orchestrate, don't reinvent): L04 orchestrates Semgrep, CodeQL, OWASP ZAP, Snyk, Gitleaks, Bandit, and similar incumbent tooling. Bob does not implement security scanners.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — for products with user accounts, payments, external integrations, or stored user data.
- ✅ Mandatory — before any production launch handling user data; before adding any new integration with sensitive data flow.
- ⏸ Skip — fully sandboxed offline tools with no network surface. (Rare in practice.)

## Session setup

- Start a **fresh Claude Code session.**
- Read L01 (Hygiene & Liveness) report — L01a's findings establish the syntactic baseline; L04 builds on it.
- Inputs to load:
  - `docs/architecture-contract.md` (threat model, observability plan)
  - `docs/domain-specs/*.md` (per-subsystem security details)
  - `.env.example`, `secrets.md`, IaC files
  - The full code surface (every public endpoint, auth flow, secret-handling path, stored-data table)
- Install / verify tooling:
  - **Semgrep** — `pip install semgrep` (community rules)
  - **CodeQL** — via GitHub Code Scanning if repo is GitHub-hosted
  - **OWASP ZAP** — optional, for DAST against staging
  - **Snyk** (also used in L06) — `npm i -g snyk`
  - **Gitleaks** — `brew install gitleaks`
  - **Bandit** (Python) — `pip install bandit`

## Source frameworks

- **STRIDE** — Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats
- **OWASP Top 10:2025** — Broken Access Control, Security Misconfiguration, Software Supply Chain Failures (new), Cryptographic Failures, Injection, Insecure Design, Auth Failures, Software/Data Integrity Failures, Logging & Alerting Failures, Mishandling of Exceptional Conditions (new). https://owasp.org/Top10/2025/en/
- **OWASP ASVS 5.0** — 17 chapters: Encoding/Sanitization, Validation/Business Logic, Web Frontend Security, API & Web Service, File Handling, Authentication, Session Management, Authorization, Self-Contained Tokens, OAuth/OIDC, Cryptography, Communication, Configuration, Data Protection, Secure Coding, Logging/Error Handling, WebRTC. https://owasp.org/www-project-application-security-verification-standard/
- **CWE Top 25 (2024)** — web injection, memory safety, access control, input validation, sensitive info exposure, resource consumption, deserialization. https://cwe.mitre.org/top25/archive/2024/2024_cwe_top25.html
- **NIST SSDF (SP 800-218)** — 4 practice groups: Prepare Organization, Protect Software, Produce Well-Secured Software, Respond to Vulnerabilities. https://csrc.nist.gov/publications/detail/sp/800-218/final
- **Microsoft SDL** — Requirements, Design, Implementation, Verification, Release + Response. https://www.microsoft.com/en-us/securityengineering/sdl/practices

## Audit method

1. **Build the attack-surface inventory.** Every public endpoint, authenticated endpoint, file-upload surface, webhook receiver, OAuth callback, deserialization point, third-party integration, secret-handling path, stored-data table. Group by surface type.

2. **STRIDE per asset.** For each major asset (user accounts, sessions, payment records, AI prompts/outputs, file uploads), walk STRIDE:
   - **Spoofing** — can an attacker impersonate this asset / user / service?
   - **Tampering** — can the asset be modified without detection?
   - **Repudiation** — can actions on this asset be denied due to insufficient logging?
   - **Information disclosure** — can the asset leak (logs, errors, side channels, timing)?
   - **Denial of service** — can the asset be made unavailable cheaply?
   - **Elevation of privilege** — can a lower-privilege actor gain higher access?

3. **OWASP Top 10:2025 sweep.** For each Top 10 category, check whether the product has any instances:
   - Broken Access Control — IDOR, missing function-level authz, parameter tampering
   - Security Misconfiguration — default credentials, verbose errors, unnecessary services
   - Supply Chain Failures — outdated/vulnerable deps, unverified npm/pip installs, typosquatting risk
   - Cryptographic Failures — weak crypto, weak random, weak password storage
   - Injection — SQL/NoSQL/command/LDAP/XPath/HTML
   - Insecure Design — fundamental design choices that make security retrofits impossible
   - Auth Failures — session fixation, weak password resets, missing MFA, JWT misuse
   - Data Integrity Failures — unsigned tokens, untrusted deserialization, CI/CD without verification
   - Logging & Alerting Failures — missing auth-event logs, no alerting on anomalies
   - Mishandling of Exceptional Conditions — error states reveal data, partial failures left in inconsistent state

4. **ASVS 5.0 chapter scan.** Pick the chapters relevant to the product's shape (e.g., Web Frontend Security if there's a browser app; API & Web Service if there's an API; OAuth/OIDC if SSO; File Handling if uploads). Walk each chapter's requirements at L1 (baseline) — flag any missing.

5. **Run tooling:**
   - **Semgrep** — `semgrep --config p/owasp-top-ten --config p/security-audit` against the codebase
   - **Gitleaks** — `gitleaks detect --source . --verbose` for secrets in git history
   - **Snyk Code** — `snyk code test`
   - **Bandit** (Python) — `bandit -r .`
   - **OWASP ZAP** (optional, staging) — baseline scan against staging URL

6. **Business-logic abuse check.** Beyond technical vulns, look for business-logic flaws: can a user trigger refund + delivery, can a free-tier user invoke a paid feature, can a rate-limited action be parallelized to bypass the limit?

7. **Rank top 3 findings by exploitability × impact.** Not by count.

## Check questions

1. Has the attack-surface inventory been built? Every public endpoint, secret path, integration, data store enumerated?
2. Has STRIDE been walked for each major asset?
3. Has every OWASP Top 10:2025 category been checked for instances?
4. Has the relevant ASVS 5.0 chapter set been walked at L1?
5. Has Semgrep / CodeQL run with security rulesets? Any unresolved Critical/High findings?
6. Has Gitleaks run against full git history? Any secret leaks (even in old commits)?
7. Is every public endpoint authenticated/authorized appropriately for its data sensitivity?
8. Are passwords stored with appropriate hashing (Argon2id / bcrypt with appropriate cost, NOT MD5/SHA1)?
9. Are sessions properly invalidated on logout, password change, and significant account change?
10. Are JWTs (if used) properly signed, with appropriate expiry, no `alg: none` accepted, and rotation strategy?
11. Are file uploads scanned, size-limited, type-restricted, and stored outside the webroot?
12. Are error messages user-safe (no stack traces, no internal paths, no DB error leakage)?
13. Are auth events logged with appropriate detail for forensic reconstruction?
14. Is there a documented vulnerability disclosure / response process?
15. Is the dependency tree free of known-vulnerable versions per Snyk / npm audit / Dependabot?

## Output schema

### Markdown report

```markdown
# L04 — Security & Threat Surface — {YYYY-MM-DD}

## Attack surface inventory
{table by surface type}

## STRIDE walk (per major asset)
| Asset | Spoofing | Tampering | Repudiation | Info disclosure | DoS | EoP |
|---|---|---|---|---|---|---|
| user_accounts | mitigated | mitigated | partial | finding | mitigated | finding |

## OWASP Top 10:2025 sweep
| Category | Instances found | Severity range |
|---|---|---|

## ASVS 5.0 chapter coverage (relevant chapters)
| Chapter | L1 requirements checked | Missing |
|---|---|---|

## Tooling results
| Tool | Critical | High | Medium | Low |
|---|---|---|---|---|
| Semgrep | 0 | 2 | 5 | 12 |
| Gitleaks | 0 | 0 | 0 | 0 |
| Snyk Code | 1 | 3 | 8 | 4 |

## Top 3 highest-leverage findings (by exploitability × impact)
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L04",
  "lens_name": "Security & Threat Surface",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "attack_surface_inventory": {},
  "stride_findings": {},
  "owasp_top10_findings": {},
  "asvs_chapter_coverage": {},
  "tooling_results": {
    "semgrep": {"critical": 0, "high": 0, "medium": 0, "low": 0},
    "gitleaks": 0,
    "snyk_code": {"critical": 0, "high": 0}
  },
  "findings": [
    {
      "id": "L04-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "broken_access_control|injection|crypto_failure|auth_failure|supply_chain|misconfig|insecure_design|data_integrity|logging_failure|exception_mishandling|business_logic_abuse",
      "stride_dimension": "spoofing|tampering|repudiation|info_disclosure|dos|eop|null",
      "owasp_top10": "A01|A02|...|null",
      "asvs_requirement": "V3.4.1|null",
      "cwe": "CWE-89|null",
      "title": "{short}",
      "evidence": "{path:line or tool output}",
      "exploitability": "trivial|practical|theoretical",
      "impact": "critical|high|medium|low",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence with citation to mitigation}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Trivially exploitable, high impact: secret leak in repo, unauthenticated PII endpoint, SQL injection in user-facing query, broken authn allowing impersonation, RCE.
- **Major** — Practically exploitable, high impact: IDOR with predictable IDs, missing CSRF on state-changing endpoint, weak password hash, JWT with `alg: none` accepted, missing rate limit on auth endpoint.
- **Minor** — Practically exploitable but low impact, or theoretically exploitable with high impact: verbose error messages, missing security headers (HSTS, CSP, X-Frame-Options), session not invalidated on password change.
- **Cosmetic** — Defense-in-depth improvements without a clear current exploitation path.

## Anti-patterns / Bias instructions

- **Do NOT skip running tooling.** Semgrep + Gitleaks + Snyk are non-negotiable. Manual code review without tools misses obvious gaps these tools catch in seconds.
- **Do NOT mark "no findings" without running tooling AND walking STRIDE AND scanning OWASP Top 10.** Three independent passes; convergence on "no findings" is evidence; one pass is not.
- **Do NOT recommend building custom security tooling.** D-003. Orchestrate Semgrep, CodeQL, ZAP, Snyk, Gitleaks, Bandit.
- **Do NOT downgrade severity for findings that are 'just' theoretical.** Defense-in-depth matters; today's theoretical exploit is tomorrow's practical one.
- **Bias toward exploitability × impact, not category prestige.** A "merely" Misconfiguration finding (verbose errors leaking DB schema) can be higher-leverage than a complex Crypto Failure finding (weak cipher used for non-critical encryption).
- **Do NOT recommend "rebuild auth from scratch."** Cite the specific weak component and the specific remediation pattern (e.g., "swap to Argon2id with t=3, m=64MB, p=4 per OWASP Password Storage Cheat Sheet").

## Stop conditions (the gap IS the finding)

1. **No threat model exists in `architecture-contract.md`.** Run a structured STRIDE walk anyway, but flag the missing threat model as a foundational finding — recommend adding one to the Architecture Contract before next audit.
2. **Required tooling cannot be installed.** Document which tools couldn't run, what findings are NOT produced as a result. Static review still happens; tooling results are missing.
3. **Code structure prevents accurate analysis** (e.g., obfuscated build, generated code only). Document and request access to source.

## Cross-lens handoff

- **Upstream:**
  - **L01 Hygiene & Liveness** — L01a's syntactic security baseline is the floor L04 builds on.
- **Downstream:**
  - **L05 Data Protection & Privacy** — extends L04 into PII-specific territory.
  - **L06 Supply Chain & Configuration** — picks up the supply-chain / config / secrets portion deeper.
  - **L13 AI Interaction (HAX) & Safety** — for AI products, extends into prompt-injection, jailbreak, OWASP LLM Top 10.
  - **L21 Observability & Incident Readiness** — uses L04's logging-gap findings.
- **Adjacent (~15% overlap):**
  - **L05** — both touch PII; L04 covers info-disclosure as STRIDE category, L05 covers data lifecycle. Dedup at aggregation.
  - **L06** — both touch supply chain; L04 covers it as OWASP T10 category, L06 goes deeper on SBOM + license.
