---
id: L06
name: Supply Chain & Configuration
band: 1
band_name: Engineering Foundation
when_to_run: Always for products with external dependencies, deployed infrastructure, or secrets. Skip only for fully self-contained products with no deps and no config.
estimated_duration: 30-90 min — much of this is tool-driven
session_pattern: fresh session; reads L04 (Security) report if available
output_markdown: audit-artifacts/L06-supply-chain-configuration-{YYYY-MM-DD}.md
output_json: audit-artifacts/L06-supply-chain-configuration-{YYYY-MM-DD}.json
source_frameworks:
  - NIST SSDF (SP 800-218) — PS Protect Software practice group — https://csrc.nist.gov/publications/detail/sp/800-218/final
  - OWASP Top 10:2025 A03 Supply Chain Failures — https://owasp.org/Top10/2025/en/
  - SLSA framework — Supply chain Levels for Software Artifacts — https://slsa.dev
  - Snyk — https://snyk.io
  - Dependabot — https://github.com/dependabot
  - OSV (Open Source Vulnerability database) — https://osv.dev
  - FOSSA / ScanCode for license analysis
  - Gitleaks / Trufflehog for secret detection
  - Checkov / tfsec for IaC scanning
---

# L06 — Supply Chain & Configuration

## Question this lens answers

*Across the dependency tree, build pipeline, deployment configuration, and secret-handling surfaces, where are the known vulnerabilities, licensing risks, configuration weaknesses, and secret exposures?*

## Why this lens exists / what other lenses miss

L04 covers supply-chain as one of ten OWASP categories — necessarily shallow. L06 goes deep across four parallel surfaces:
1. **OSS dependencies** — known CVEs, outdated versions, transitive risk, typosquatting
2. **License compliance** — copyleft contamination, license incompatibilities, unlicensed packages
3. **Infrastructure-as-Code** — Terraform/Pulumi/CloudFormation misconfigurations (open buckets, public RDS, weak IAM)
4. **Secrets** — leaked credentials in git history, in CI configs, in container images, in client bundles

This is high-leverage because supply-chain attacks (xz, event-stream, ua-parser-js, codecov) have become the dominant attack vector. A perfectly written app can be compromised through a transitive dep three layers deep.

Per D-003: L06 orchestrates Snyk, Dependabot, OSV-Scanner, FOSSA, Checkov, tfsec, Gitleaks, Trufflehog. Bob does not reinvent dependency scanning.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — any product with external OSS deps or deployed infra (almost all products).
- ✅ Mandatory — before any production deploy; before any major dependency update; quarterly drift check.
- ⏸ Skip — fully self-contained products with no external deps and no deployed infra (rare).

## Session setup

- Start a **fresh Claude Code session.**
- Read L04 (Security) report — supply-chain findings from L04 are L06 inputs.
- Inputs to load:
  - Dependency manifests — `package.json` + `package-lock.json` (JS/TS), `requirements.txt` / `pyproject.toml` / `poetry.lock` (Python), `go.mod` / `go.sum` (Go), `Cargo.toml` / `Cargo.lock` (Rust), `Gemfile.lock`, `pom.xml`, etc.
  - IaC files — `*.tf`, `*.yaml` (k8s), `Dockerfile`, `docker-compose.yml`, `.github/workflows/*`
  - Env files — `.env.example`, deployment platform env configs
  - CI/CD configs
- Install / verify tooling:
  - **Snyk** — `npm i -g snyk` + `snyk auth`
  - **OSV-Scanner** — `brew install osv-scanner` or equivalent
  - **Dependabot** — already enabled if GitHub-hosted; if not, enable
  - **Gitleaks** — `brew install gitleaks`
  - **Trufflehog** — `brew install trufflehog`
  - **Checkov** (IaC) — `pip install checkov`
  - **tfsec** (Terraform) — `brew install tfsec`
  - **ScanCode** (license) — `pip install scancode-toolkit`

## Source frameworks

- **NIST SSDF PS group** — PS.1 protect components from tampering, PS.2 verify integrity, PS.3 archive + protect each release. https://csrc.nist.gov/publications/detail/sp/800-218/final
- **OWASP Top 10:2025 A03 Supply Chain Failures** — https://owasp.org/Top10/2025/en/
- **SLSA framework** — Levels 1-4 of supply-chain integrity. https://slsa.dev
- **OSV.dev** — open vulnerability DB covering npm, PyPI, Go, Cargo, Maven, etc. https://osv.dev
- **Snyk** — vuln + license database with severity ratings + fix recommendations. https://snyk.io
- **Checkov + tfsec** — IaC scanners.
- **Gitleaks + Trufflehog** — secret scanners.

## Audit method

1. **Dependency inventory.** Capture full direct + transitive tree. Use `npm ls --all`, `pip freeze`, `go mod graph`, etc. Output to file.

2. **Vulnerability scan.**
   - `snyk test --all-projects`
   - `osv-scanner --recursive .`
   - `npm audit` / `pip-audit` / `cargo audit`
   - Cross-reference findings — different scanners catch different vulns. Convergence matters.

3. **Outdated dependency check.** For each dep, current version vs latest. Note: outdated ≠ vulnerable, but stale deps accumulate vuln risk over time.

4. **Typosquatting / suspicious package check.** Scan recently-added deps for typosquat patterns (similar names to popular packages). Check published-recently + few-downloads + maintainer-unknown patterns.

5. **License compliance.**
   - `scancode -clpieu --json licenses.json .` or FOSSA equivalent.
   - For each license, classify: permissive (MIT, Apache 2.0, BSD) / weak-copyleft (LGPL, MPL) / strong-copyleft (GPL, AGPL).
   - Flag any GPL/AGPL deps if the product is closed-source.
   - Flag unlicensed deps (no LICENSE file = "all rights reserved" by default).

6. **IaC scanning.**
   - `checkov -d .` against all IaC files.
   - `tfsec .` for Terraform.
   - For Dockerfiles: check for `latest` tags, root user, no health checks, baked-in secrets, no `.dockerignore`.
   - For k8s: check for `privileged: true`, missing resource limits, missing network policies, missing PSP/PSA.

7. **Secret detection.**
   - `gitleaks detect --source . --no-banner --verbose` (full git history scan).
   - `trufflehog filesystem .` for additional coverage.
   - Manual check: any secret in `.env.example` should be obviously-placeholder (`your_key_here`, never a real-looking value).
   - Check CI logs (GitHub Actions, etc.) for accidental secret printing.
   - Check Docker images for baked-in secrets (`docker history` reveals each layer).
   - Check client-side bundles for backend secrets (a common JS/TS mistake).

8. **CI/CD integrity.** Are workflows pinned to commit SHAs (not tags or `@v1`)? Are third-party actions reviewed? Are secrets scoped per-environment? Is there branch protection requiring review?

9. **Configuration hygiene.**
   - Default credentials in any config?
   - Production config baked into Dockerfile vs env-injected?
   - Debug flags / verbose logging accidentally enabled in production?
   - CORS too permissive (`*`)?
   - TLS config — minimum version, cipher suites?

10. **SBOM check.** Is there a Software Bill of Materials generated per build? (CycloneDX or SPDX format.) Required for SLSA L2+.

## Check questions

1. Has a full dependency tree been captured (direct + transitive)?
2. Has Snyk / OSV-Scanner / npm audit run? Any Critical or High vulns unaddressed?
3. Are any deps so outdated they're approaching EOL or have lost maintainer support?
4. Are there typosquat or suspicious package patterns in recently-added deps?
5. Has license analysis been run? Any GPL/AGPL/unlicensed deps in closed-source product?
6. Has Checkov / tfsec run against all IaC? Any High findings?
7. Are Dockerfiles using non-`latest` tags, non-root users, and `.dockerignore`?
8. Has Gitleaks run against full git history? Has Trufflehog confirmed?
9. Are CI workflows pinned to commit SHAs (not floating tags)?
10. Are secrets scoped per-environment (no prod secrets in staging logs)?
11. Are env vars set securely (cloud secret manager, not committed `.env`)?
12. Is there an SBOM generated per build?
13. Is there a documented dependency-update cadence (weekly Dependabot, monthly review)?
14. For client-side products: has the production bundle been searched for accidentally-included backend secrets?
15. Is there a documented rollback plan if a dep update breaks production?

## Output schema

### Markdown report

```markdown
# L06 — Supply Chain & Configuration — {YYYY-MM-DD}

## Dependency inventory
- **Direct deps:** X
- **Transitive deps:** Y
- **Languages:** [...]

## Vulnerability scan results
| Tool | Critical | High | Medium | Low |
|---|---|---|---|---|
| Snyk | 0 | 2 | 5 | 12 |
| OSV-Scanner | 0 | 2 | 6 | 14 |
| npm audit | 0 | 2 | 5 | 12 |

## Vulnerable deps (Critical/High only)
| Package | Version | CVE | Severity | Fix available? | Direct or transitive? |
|---|---|---|---|---|---|

## License analysis
| License | # packages | Risk if closed-source product |
|---|---|---|
| MIT | 142 | low |
| Apache-2.0 | 38 | low |
| GPL-3.0 | 1 | HIGH |

## IaC findings
| File | Tool | Severity | Finding |
|---|---|---|---|

## Secret scan
| Tool | Findings | False positives | Real |
|---|---|---|---|
| Gitleaks | 3 | 1 | 2 |
| Trufflehog | 4 | 1 | 3 |

## Real secret exposures
| File / commit | Secret type | Status (rotated/active) |
|---|---|---|

## Config hygiene findings
| Issue | Location | Severity |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L06",
  "lens_name": "Supply Chain & Configuration",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "deps": {
    "direct": 0,
    "transitive": 0
  },
  "vulns": {
    "snyk": {"critical": 0, "high": 0, "medium": 0, "low": 0},
    "osv": {"critical": 0, "high": 0, "medium": 0, "low": 0},
    "native_audit": {"critical": 0, "high": 0, "medium": 0, "low": 0}
  },
  "license_risk": {
    "gpl_agpl_in_closed_source": 0,
    "unlicensed": 0,
    "unknown": 0
  },
  "iac_findings": {
    "checkov_critical": 0,
    "checkov_high": 0,
    "tfsec_critical": 0,
    "tfsec_high": 0
  },
  "secrets": {
    "gitleaks_real": 0,
    "trufflehog_real": 0
  },
  "sbom_generated": false,
  "ci_workflows_pinned": true,
  "findings": [
    {
      "id": "L06-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "vuln_critical_dep|vuln_high_dep|outdated_dep|license_incompatible|typosquat_risk|iac_misconfig|leaked_secret|active_secret_in_repo|insecure_default_config|ci_unpinned|client_bundle_leak|no_sbom",
      "title": "{short}",
      "package_or_file": "{name@version | path}",
      "cve_or_finding_id": "{CVE-XXXX-YYYY | tool-finding-id | null}",
      "evidence": "{tool output reference}",
      "remediation_available": true,
      "recommendation": "{1-sentence with specific version/config target}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Critical-severity CVE in a directly-imported or hot-path transitive dep. Active secret leaked in current repo state (not just historical). GPL/AGPL dep in closed-source product. IaC misconfig that exposes user data (open S3 bucket, public RDS, public Lambda URL with PII access).
- **Major** — High-severity CVE in any dep with available fix. Outdated dep with maintainer abandoned >12 months. Historical secret in git history not rotated. CI workflow unpinned third-party action with elevated permissions.
- **Minor** — Medium-severity CVE. Outdated dep without known CVE. License documentation incomplete. IaC misconfig with low-impact (verbose logging, missing tags).
- **Cosmetic** — Style / consistency in dependency management (mixed lockfile types, inconsistent pinning).

## Anti-patterns / Bias instructions

- **Do NOT mark "no vulns" without running at least 2 scanners.** Snyk + OSV-Scanner + native audit (npm audit / pip-audit) should converge. One scanner finding = signal; three converging = confidence.
- **Do NOT recommend "update everything to latest."** That's the fastest way to break production. Recommendations should be specific (which dep, which version, what's the breaking-change risk, what's the testing strategy).
- **Do NOT skip secret detection on the basis of "we use a secret manager."** Gitleaks scans git history. A rotated secret can still be in old commits; an "unused" secret can still be active.
- **Do NOT downgrade IaC misconfigs as "ops will fix it later."** Open buckets and public DBs are Critical at discovery time, not after the breach.
- **Do NOT recommend "build a custom dependency tracker."** D-003. Snyk + Dependabot + OSV cover the field.
- **Bias toward "would this be caught in a SOC2 / ISO 27001 audit?"** Supply-chain hygiene is increasingly compliance-mandated.

## Stop conditions (the gap IS the finding)

1. **Lockfile missing.** Without a lockfile, dependency tree is non-deterministic — scanning a snapshot doesn't reflect what's actually deployed. Surface as a Critical finding.
2. **Tooling cannot run.** Document which tool, why, what findings are NOT produced.
3. **No CI/CD configured.** Surface as a Major finding (lack of automated dep scanning = drift risk).

## Cross-lens handoff

- **Upstream:**
  - **L04 Security & Threat Surface** — supply-chain category in OWASP T10 is L06's input.
- **Downstream:**
  - **L21 Observability & Incident Readiness** — SBOM + dep tree feed incident response (when CVE drops, can we tell if we're affected in <1 hour?).
  - **L22 Vendor & Dependency Risk** — extends L06 into vendor sunset / pricing / lock-in.
- **Adjacent (~15% overlap):**
  - **L05 Data Protection & Privacy** — vendor DPA list overlaps with L06's vendor list.
  - **L04** — both touch supply-chain; L04 catches it as one of 10 categories, L06 goes deep. Dedup at aggregation.
