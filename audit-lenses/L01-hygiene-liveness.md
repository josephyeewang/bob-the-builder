---
id: L01
name: Hygiene & Liveness
band: 1
band_name: Engineering Foundation
when_to_run: Always. Foundation lens — every Curated panel and every Full Enchilada starts here.
estimated_duration: 45-90 min for a Standard project; up to 2 hours if liveness tooling needs first-time setup
session_pattern: fresh session; reads no prior lens reports (this is the engineering anchor)
output_markdown: audit-artifacts/L01-hygiene-liveness-{YYYY-MM-DD}.md
output_json: audit-artifacts/L01-hygiene-liveness-{YYYY-MM-DD}.json
source_frameworks:
  - Bob's prior A7a-A7e + A7j Liveness Audit (v2.14, v2.15)
  - Knip (JS/TS dead code) — https://knip.dev
  - Vulture + Ruff + deptry (Python dead code) — https://github.com/jendrikseipp/vulture
  - Schemathesis (HTTP+OpenAPI fuzz) — https://schemathesis.readthedocs.io
  - Playwright (browser smoke) — https://playwright.dev
  - Vitest / pytest (function smoke)
  - promptfoo (LLM surface smoke) — https://www.promptfoo.dev
  - SonarQube quality dimensions — https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates
---

# L01 — Hygiene & Liveness

## Question this lens answers

*Does the code hold up on inspection AND does it actually run end-to-end?* L01 combines the static-correctness audits (Bob's prior A7a-A7e — security syntax, abuse-resistance, integration seams, data integrity, spec-code match) with the live-execution audit (A7j Liveness, v2.14) — every callable surface in built subsystems is *executed*, not just read.

## Why this lens exists / what other lenses miss

Static review and live execution catch different classes of failure. Static catches obvious bugs, missing input validation, dead imports. Live execution catches the "function looks correct in source but throws on first call" pattern — typo'd env vars, broken imports compiled-but-unreachable, dead routes registered but throwing in middleware, AI surfaces with bad config, orphan functions never wired into a user path. Both must run; either alone leaves a class of failure invisible.

This lens consolidates Bob v2.16's A7a-A7e + A7j into a single foundation lens. The previous structure had them as separate phases requiring 6 fresh sessions; v2.17 keeps the fresh-session-per-lens pattern but treats hygiene+liveness as one band with a unified scope map and aggregated finding list.

Per D-003 (orchestrate, don't reinvent): this lens does NOT implement any tooling. It orchestrates Knip, Vulture, Ruff, deptry, Schemathesis, Playwright, Vitest/pytest, and promptfoo. When those tools improve, L01 improves for free.

## When this lens fires

**Always — Foundation lens.** Curated panel inclusion criteria:
- ✅ Always in every panel. L01 is the engineering anchor; every other lens benefits from running on a known-hygienic baseline.
- ✅ Mandatory before any launch milestone, phase gate (v2.15 per-phase Liveness), or evolution that touches callable surface.

## Session setup

- Start a **fresh Claude Code session.** The writer/reviewer pattern matters here — code authors rationalize past decisions; reviewers catch the silent failures.
- Inputs to load:
  - Codebase access (read + execute permissions)
  - `docs/architecture-contract.md` for threat model + observability plan
  - `docs/build-manifest.md` for phase status + Capability Traceability Matrix
- Install / verify tooling (per language stack):
  - **JS/TS:** `npm i -g knip`; `npm i -g playwright`; ensure `vitest` available
  - **Python:** `pip install vulture ruff deptry pytest`
  - **HTTP+OpenAPI:** `pip install schemathesis`
  - **LLM surfaces:** `npm i -g promptfoo` (or pip equivalent)
- Precondition for liveness: app must be **runnable locally** OR a preview/staging URL must be provided. If neither, surface "Liveness unverifiable" as the finding and skip the live portion (do not paper over absence).

## Source frameworks

- **Bob A7a-A7e (v2.13)** — security, adversarial/abuse, integration seam, data integrity, spec-code match. The static-correctness foundation. See `build-protocol.md` §[N+1]a-e.
- **Bob A7j Liveness Audit (v2.14)** — the only audit that executes code rather than reading it. See `build-protocol.md` §[N+1]j and D-003 (orchestrate, don't reinvent).
- **Knip** (JS/TS dead code) — https://knip.dev
- **Vulture + Ruff + deptry** (Python dead code) — https://github.com/jendrikseipp/vulture, https://docs.astral.sh/ruff, https://github.com/fpgmaas/deptry
- **Schemathesis** (HTTP+OpenAPI fuzz) — https://schemathesis.readthedocs.io
- **Playwright** (browser smoke) — https://playwright.dev
- **promptfoo** (LLM smoke) — https://www.promptfoo.dev
- **SonarQube quality dimensions** — reliability, security, maintainability, coverage, duplications — https://docs.sonarsource.com

## Audit method

1. **Hygiene Scope Map (always first).** Produce a table covering every audit category × what's in-scope-now vs deferred:
   | Audit | In scope now (what's built) | Deferred (and why) | Defer to |
   |---|---|---|---|
   | L01a Security | every public endpoint, auth flow, secret path, stored-data table that exists today | unbuilt subsystems | their build phase |
   | L01b Abuse | every user-facing capability marked implemented in CTM | unbuilt features | their build phase |
   | L01c Integration seam | every boundary where both sides are built | seams to stub/mock | when both sides land |
   | L01d Data integrity | every state machine + data flow that exists end-to-end | partial flows | when end-to-end |
   | L01e Spec-code | capabilities marked implemented in CTM | unimplemented | their build phase |
   | L01j Liveness | every callable surface in implemented subsystems IF runnable target exists | unbuilt OR no runnable target | when target available |

   `→ HG:` user can override scope before audits fire.

2. **L01a — Security syntax & input validation.** Trace every external input → handler → sink. Check input validation, auth on every endpoint, secret handling, SQL/HTML/command escaping, deserialization safety. (Note: L04 Security & Threat Surface goes deeper on threat modeling and OWASP. L01a is the syntactic / always-check baseline.)

3. **L01b — Abuse & adversarial resistance (in-scope features).** For each user-facing capability, ask: how could a hostile user abuse this? Rate-limit checks, cost-bombing, prompt injection (AI products), authorization bypass via parameter tampering, race conditions in state transitions.

4. **L01c — Integration seam audit.** For every boundary where two built subsystems meet, verify: contract types match, error propagation defined, retry semantics defined, timeout behavior defined, observability spans the seam.

5. **L01d — Data integrity.** For every state machine + data flow with end-to-end code, verify: transitions are exhaustive, terminal states are reachable, invariants hold under partial failure, idempotency where the spec claims it.

6. **L01e — Spec-code consistency.** For each CTM-marked-implemented capability, verify the code matches what the spec says. (L02 generalizes this — L01e is the immediate-vicinity check; L02 is the full census.)

7. **L01j — Liveness execution.** Run, don't read:
   - **Dead code:** `knip` (JS/TS) or `vulture --min-confidence 80` + `deptry` (Python). Surface every export/import unreferenced.
   - **HTTP endpoints:** If OpenAPI spec exists, run `schemathesis run <spec> --checks all`. If no spec, hand-curl every route in the manifest and check status codes + response shape.
   - **Browser flows:** Run Playwright on the 1-3 hot paths from Build Manifest. Any flow that doesn't reach its terminal step = finding.
   - **Functions:** Run `vitest` / `pytest`. Coverage on new/modified surface ≥ phase-defined threshold.
   - **LLM call sites:** Run `promptfoo` against the eval set. Any AI surface that throws or returns malformed output = finding.

8. **Aggregate findings.** Critical: any L01j surface that 5xx's or throws on first call. Major: significant static gaps (missing input validation, leaked secrets, broken integration contract). Minor: hygiene improvements (dead exports, missing type annotations, weak naming).

## Check questions

1. Has the hygiene scope map been produced and approved at `→ HG`?
2. For every public endpoint, is there input validation AND authorization AND a documented schema?
3. For every external input, is the sanitization at the boundary (not deep inside)?
4. Are there any hardcoded secrets, API keys, or credentials in source?
5. For every built capability in the CTM, can you run the actual user-facing path end-to-end without errors?
6. For every state machine, are all transitions covered and all terminal states reachable?
7. For every integration boundary between built subsystems, do contracts match (types, shapes, error modes)?
8. Has Knip / Vulture surfaced dead code? Is each instance either pruned or annotated as intentionally unused?
9. Has Schemathesis run against every documented HTTP endpoint? Any 5xx or contract-violation findings?
10. Has Playwright run the hot paths? Did each one reach its terminal step?
11. For AI products: has promptfoo run against the eval set? Any throws or malformed outputs?
12. For every callable surface (route, exported function, job, AI call site), is there evidence it was *executed* in this audit, not just read?
13. Any deferred items registered into Build Manifest as inherited obligations on future phases?

## Output schema

### Markdown report

```markdown
# L01 — Hygiene & Liveness — {YYYY-MM-DD}

## Scope map
{table per L01a-e + L01j with in-scope-now vs deferred}

## L01a — Security syntax
{findings table}

## L01b — Abuse & adversarial resistance
{findings table}

## L01c — Integration seam
{findings table}

## L01d — Data integrity
{findings table}

## L01e — Spec-code consistency (immediate vicinity)
{findings table}

## L01j — Liveness execution
| Surface | Tool | Result | Finding? |
|---|---|---|---|
| GET /api/tasks | schemathesis | 200 OK | — |
| POST /api/intake | schemathesis | 500 (env var missing) | Critical |
| processMemoryDecay | knip | unreferenced export | Major |

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L01",
  "lens_name": "Hygiene & Liveness",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "scope_map": {},
  "liveness": {
    "tooling_available": true,
    "runnable_target": true,
    "dead_code_findings": 0,
    "5xx_findings": 0,
    "browser_flow_findings": 0,
    "ai_smoke_findings": 0
  },
  "findings": [
    {
      "id": "L01-F001",
      "severity": "critical|major|minor|cosmetic",
      "subaudit": "L01a|L01b|L01c|L01d|L01e|L01j",
      "category": "missing_authn|missing_authz|dead_route|throwing_on_call|broken_contract|state_unreachable|prompt_injection|secret_leak",
      "title": "{short}",
      "evidence": "{path:line or tool output reference}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Any L01j surface that 5xx's, throws, or returns malformed output on first call. Any missing authn/authz on an endpoint handling user data. Any hardcoded secret. Any data-integrity invariant violated under partial failure.
- **Major** — Significant static gap with reachable code path (missing input validation, weak boundary contract, broken integration seam, race condition in critical state machine).
- **Minor** — Hygiene improvements (dead exports, weak naming, type-annotation gaps, refactor candidates).
- **Cosmetic** — Style / formatting / comment-quality.

## Anti-patterns / Bias instructions

- **Do NOT skip live execution because tooling isn't installed.** Install it. If you can't, surface "Liveness unverifiable" as the headline finding and stop — don't pretend to have run liveness checks.
- **Do NOT mark L01j findings as Minor.** Anything that throws on first call is Critical or Major. The whole point of A7j (v2.14) was to escalate runtime failures over static gaps.
- **Do NOT re-litigate findings from prior L01 runs.** Read the prior report; mark resolved items as resolved; only re-report regressions and new findings.
- **Do NOT build custom dead-code or smoke tooling.** D-003 — orchestrate Knip, Vulture, Schemathesis, Playwright, Vitest/pytest, promptfoo. Custom is the wrong call.
- **Bias toward execution evidence.** Every L01j finding must reference tool output, not source-reading inference.

## Stop conditions (the gap IS the finding)

1. **No runnable target available.** Surface "Liveness unverifiable" as the headline. Static portions (L01a-e) can still run. Recommend providing a runnable target before next audit.
2. **Required tooling missing and cannot be installed.** Document which tool, why it can't be installed, and which findings cannot be produced as a result.
3. **No CTM / Build Manifest exists.** Scope map cannot be produced. Recommend completing Build Manifest first (Bob NEW mode Step 5).

## Cross-lens handoff

- **Upstream:** None. Foundation lens.
- **Downstream:**
  - **L02 Spec Fidelity** — uses L01's "in-scope built" list as the verification universe.
  - **L03 Critical Capability Quality** — takes L01's BUILT list and grades each one.
  - **L04 Security & Threat Surface** — extends L01a beyond syntactic checks into threat modeling.
  - **L21 Observability & Incident Readiness** — uses L01's reachable-surface list to verify every surface is observable.
- **Adjacent (~15% overlap):**
  - **L04 Security** — L01a is the always-check security baseline; L04 is the deep-dive. L04 reads L01a's report and goes deeper, not re-litigates.
