# Audit Log

> Cross-audit register for Bob the Builder itself. Created to fix v2.13 finding F22 — Bob mandates registering deferred items per A7i, but Bob wasn't doing it for itself. Each audit pass appends an entry; deferred items carry forward until they're either closed in a later release or explicitly re-Rejected.

This is the operational counterpart to `decision-log.md`. The decision log records *intentional non-goals* (Reject verdicts); this log records *deliberate deferrals* (Defer verdicts) so they don't get forgotten.

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
| F6 | Branch protection / signed commits — **user action** (see checklist below) | M5 |
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

### F6 — branch protection (user action)

Recommended GitHub repo settings to action manually. These are not auto-applied because they require judgment about the solo-dev workflow (e.g., requiring PR review would break direct-to-main commits, which Joe's CLAUDE.md explicitly authorizes).

**Settings → Branches → Branch protection rules → Add rule** (apply to `main`):
- [ ] Require status checks to pass before merging → check `scripts-ci` jobs (shellcheck, bob-init smoke test, bob-doctor smoke test)
- [ ] Require branches to be up to date before merging
- [ ] Disallow force pushes
- [ ] Disallow deletions
- [ ] (Skip: "Require pull request reviews" — incompatible with solo-dev direct-to-main pattern)

**Settings → Tags → Tag protection rules:**
- [ ] Protect tags matching `v*` from deletion / force-update

**Settings → Code security → Commit signature verification (optional, recommended):**
- [ ] Require signed commits (needs Joe to set up GPG or SSH commit signing first)

Document any decision to skip a recommended setting in `decision-log.md` so it doesn't get re-litigated next audit.

---

## How to use this log

- Every AUDIT pass appends a section at the top with: closed items, deferred items, informational notes, and any user-action checklist.
- Deferred items stay in the log until they're either closed in a release (move to the closed section of that release's entry) or formally Rejected (move to `decision-log.md`).
- Reference the audit-log from A7i prose so future audits actually find this file.
