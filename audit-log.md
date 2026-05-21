# Audit Log

> Cross-audit register for Bob the Builder itself. Created to fix v2.13 finding F22 — Bob mandates registering deferred items per A7i, but Bob wasn't doing it for itself. Each audit pass appends an entry; deferred items carry forward until they're either closed in a later release or explicitly re-Rejected.

This is the operational counterpart to `decision-log.md`. The decision log records *intentional non-goals* (Reject verdicts); this log records *deliberate deferrals* (Defer verdicts) so they don't get forgotten.

---

## EVOLVE pass — v2.14 (2026-05-20) — A7j Liveness Audit added

**Trigger:** User report — two functions in a downstream Bob-built product (Explain My Blood Test) implemented the previous day were silently broken on manual spot-check. Failure mode: static review and spec-match passed, but functions threw at first runtime invocation. Root cause: no A7 step actually executes code; every existing audit reads source and reasons about it.

**Change shipped:**

- **New audit step:** `[N+1]j Liveness Audit` (canonical playbook in NEW mode) and `A7j Liveness Audit` (scoped reference in AUDIT mode). Inserted after [N+1]e / A7e, before [N+1]f / A7f.
- **A7 categories restructured:** "two categories" → "three categories." Internal correctness now splits into *static* (A7a–A7e, read code) and *live* (A7j, run code).
- **A7.0 scope map updated:** new A7j row; new precondition rule ("if no runnable target, surface 'Liveness unverifiable' as the finding rather than skipping silently").
- **A7i updated:** A7j 5xx / function-throws findings are explicitly tagged as always-critical (they represent code that does not run at all).
- **Compact reference (build-protocol-core.md) updated:** N+1 sequence now includes Liveness; A7 description includes the third category.

**Tool selection (decision rationale captured in D-003):**
- Knip (JS/TS dead exports + inventory) — incumbent; ts-prune is effectively dead
- Vulture + Ruff + deptry (Python) — same job split across three tools because the Python ecosystem split them
- Schemathesis (HTTP fuzz from OpenAPI) — uncontested in its niche
- Playwright (browser flows) — settled vs Cypress in 2025–26
- Vitest / pytest (function-level smoke harness)
- promptfoo (LLM/AI surface smoke)

All have JSON reporters, all CLI-callable by Claude Code without human in the loop.

**Bob's stance:** orchestrate, don't reinvent. A7j is glue + triage + reporting on top of mature OSS tools.

### Closed in v2.14

| # | Title | Notes |
|---|---|---|
| F25 | A7j Liveness Audit added | Resolves blind spot where AUDIT could not catch silently-broken runtime code |

### Deferred from v2.14

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F26 | A7j as per-phase Nb verification step (not just A7) | M | Higher-impact change — would catch dead functions the day they ship, not weeks later. Deferred to keep v2.14 surgical. | Next AUDIT pass on Bob, OR after first real user runs A7j and reports back |
| F27 | A7j auth-token bootstrap helper (script that generates `.env.test` token from project config) | L | Today users have to provide a test-user token manually. Tooling that auto-generates it would be useful but not blocking. | If multiple PR-back reports cite auth-token setup as friction |
| F28 | A7j writes findings into a structured `liveness-report.json` artifact | L | Currently the verdict table is markdown only. A machine-readable artifact would let downstream tools / CI consume A7j output. | When A7j is run more than ~3 times by external users |

### Informational

| # | Note |
|---|---|
| F29 | A7j is the first A7 audit that has a hard precondition (runnable target). Surfacing "Liveness unverifiable" as a *first-class finding* rather than skipping silently is deliberate — it makes the gap visible instead of papering over it, same pattern as A7g's stop condition for missing success metrics (v2.13 F17). |

---

## Audit pass — v2.13 (2026-05-20)

**Auditor:** Fresh Claude Opus session, no involvement in v2.10–v2.12 authoring.
**Scope:** Full A1–A7 (incl. A7f/g/h External Fit & Value audits).
**Total findings:** 24 — 16 Adopt, 5 Defer, 2 Reject, 1 informational.

### Closed in v2.13 (Adopts shipped)

| # | Title | Milestone |
|---|---|---|
| F1 | `update bob` symlink preflight | M2 |
| F2 | bob-init.sh git config preflight | M2 |
| F3 | README prerequisite section | M1 |
| F4 | Install one-liner idempotent | M1 |
| F5 | Supply-chain CI (shellcheck + smoke tests) | M5 |
| F6 | Branch protection (Option A) applied via Rulesets API: no force-push, no deletion on `main`; no update, no deletion on `v*` tags. Signed commits deferred (see checklist below). | M5 + post-ship |
| F7 | CTM template file | M4 |
| F8 | CTM H / H++ hardening column in template | M4 |
| F11 | AGENTS.md scaffold in bob-init | M4 |
| F15 | bob-stats.sh + multi-location PR-back + parallel channel | M6 |
| F16 | CLAUDE.md self-effectiveness rephrase | M3 |
| F17 | A7g stop condition as first-class finding | M3 |
| F18 | README Terminal/git/xcode preflight | M1 |
| F19 | Step 2 worked example extended to all 7 sections | M3 |
| F21 | Step [N+2]d Closing Checkpoint Summary template | M3 |
| F22 | This audit-log.md file | M7 |

### Deferred (revisit at next audit)

| # | Title | Severity | Why deferred | Revisit trigger |
|---|---|---|---|---|
| F9 | README "eight separate audits before ship" implies all 8 always run; protocol actually defers most via A7.0 scope map | L | Cosmetic; no signal yet that this misleads real users | If a user reports confusion in a PR-back or issue |
| F10 | README "Fallback — no install" path doesn't set up symlink, doesn't enable `/bob`, doesn't enable `update bob` — silently degraded experience | L | Fallback is a v2.6 escape hatch; primary install path is the recommended one and the README correctly leads with it | If we ever see fallback-mode usage become common |
| F12 | Cursor / Codex / Copilot now have native plan modes that overlap Bob's plan-mode mandate at Step [N]a; positioning may need a rethink | L | Strategic, not tactical. Bob's depth (spec → behavior → arch → domain + audit modes) is the durable differentiation, not plan mode | When one of those tools ships an external-fit-style audit step |
| F20 | Streamlined startup proposes a complexity classification the user can't meaningfully push back on | L | Trade-off accepted: hiding the classification loses signal value, surfacing it creates a small friction the user can't act on | If users ever ask to change it |
| F24 | v2.12 SECURITY.md "user-side pinning" instructions buried in prose; cautious adopters unlikely to find them | L | Pinning is opt-in by design; making it more prominent risks signaling that the default install is unsafe (it isn't) | If a security incident makes pinning a higher-priority default |

### Informational

| # | Note |
|---|---|
| F14 | Verdicts from the v2.10 → v2.11 → v2.12 audit chain all held under re-inspection. Implementation bias did not produce bad Adopts; the failure mode of that chain was *what got missed*, not *what got shipped*. |

### F6 — branch & tag protection (status)

**Applied via Rulesets API (2026-05-20):**

- [x] **Ruleset `main-no-force-push-no-delete`** (id 16664976) — `non_fast_forward` + `deletion` rules on `refs/heads/main`. Bypass: never. Solo-dev direct-to-main commits still allowed; history cannot be rewritten or branch deleted.
- [x] **Ruleset `tag-v-no-update-no-delete`** (id 16664978) — `update` + `deletion` rules on `refs/tags/v*`. Released tags cannot be moved or removed.

**Deferred:**

- [ ] **Require status checks to pass before merging** — not applied. Solo-dev direct-to-main pattern means commits often need to land before CI catches an issue (Joe's CLAUDE.md: "Push is pre-authorized; changes can't be evaluated until live"). CI failures will still surface via the GitHub UI; chose ergonomics over strict gating.
- [ ] **Require pull request reviews** — skipped, incompatible with solo-dev direct-to-main pattern.
- [ ] **Require signed commits** — deferred. Needs Joe to set up GPG/SSH commit signing first; recommended but not zero-effort.

Document any future decision to skip or revisit any of these in `decision-log.md` so it doesn't get re-litigated next audit.

---

## How to use this log

- Every AUDIT pass appends a section at the top with: closed items, deferred items, informational notes, and any user-action checklist.
- Deferred items stay in the log until they're either closed in a release (move to the closed section of that release's entry) or formally Rejected (move to `decision-log.md`).
- Reference the audit-log from A7i prose so future audits actually find this file.
