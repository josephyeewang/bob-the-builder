# BUILD PROTOCOL — CORE REFERENCE

> Compact reference for session context. For full templates, appendices, and architecture patterns, read `build-protocol.md`.

---

## MODES

When the user references this protocol without specifying a mode, present this menu:

> **A) NEW** — Start a brand new product from scratch
> **B) AUDIT** — Assess an existing, partially-built product
> **C) EVOLVE** — Add features or make changes to an existing product
>
> **Which one? (A / B / C)**

## COMPLEXITY ASSESSMENT

Before starting, assess project complexity:

| Track | Criteria | What Changes |
|-------|----------|-------------|
| **Light** | 1-3 subsystems, no AI, no multi-user, single surface | Skip Behavioral Core, skip Domain Specs if <3 subsystems, simplified Phase Report ([A] sections only), adversarial reviews at hardening only |
| **Standard** | 3-8 subsystems, AI OR multi-user OR 3+ integrations | Full protocol (default) |
| **Heavy** | Complex AI + multi-user + 5+ integrations + compliance | Full protocol + mandatory deploy verification every phase + mandatory second-model review at spec and hardening gates |

**Mid-build reclassification:** If escalating to Heavy mid-build: (1) future phases follow Heavy requirements immediately, (2) run one-time catch-up audit on completed phases for the Standard→Heavy delta (deploy verification, second-model spec review), (3) log reclassification in Build Manifest. Do NOT re-run completed phases.

---

## DOCUMENT HIERARCHY

| # | Document | Answers | Required? |
|---|----------|---------|-----------|
| 1 | **Product Spec** | WHAT it does | Always |
| 2 | **Behavioral Core** | HOW it thinks | If AI makes decisions |
| 3 | **Architecture Contract** | HOW it's built | Always (code products) |
| 4 | **Domain Specs** | DETAILS per subsystem | If 3+ subsystems |
| 5 | **Build Manifest** | WHERE we are | Always |

**Priority when docs conflict:** Product Spec > Behavioral Core > Architecture Contract > Domain Specs > Build Manifest. Exception: if behavior is defined in both Product Spec and Behavioral Core, Behavioral Core wins.

---

## RULES FOR CLAUDE CODE

**Execution:**
1. Follow steps in order. Do not skip, merge, or reorder.
2. Stop at every human gate (`→ HG`). Wait for explicit approval.
3. Track current step. Resume from Build Manifest.
4. Reconciliation is non-optional after every build phase.
5. Specs are living documents — update during build when reality diverges.

**Behavioral guardrails:**
6. **No silent refactoring.** List ALL changes. Explain WHY. Confirm no regression.
7. **No behavior drift.** Do NOT change previously built behavior unless current phase REQUIRES it.
8. **Scope lock.** Only build what's in the phase scope. Don't anticipate future phases.
9. **Drift prevention.** All behavior must trace to a spec section. Can't cite it → don't build it.
10. **Idempotency.** Every step safely re-runnable. Check before writing. Update instead of recreate.
11. **Complexity rule.** Prefer simple, explicit code over clever abstractions.
12. **Flag divergences immediately.** Don't silently pick one interpretation.
13. **Two-correction rule.** Same issue corrected twice → recommend `/clear` and fresh session.

**Failure stop conditions (STOP immediately if):**
- Required behavior NOT in Behavioral Core (AI products)
- Required mechanics NOT in domain spec
- Two docs conflict
- Behavior is ambiguous (no clear rule)
- An assumption is needed to proceed
- A prior-phase dependency is missing or broken

---

## MODE: NEW — Step Sequence

0. **Intake** → 0a: Existing materials check → 0b: Material mapping → 0c: Accelerated start → `→ HG` *(skip if starting from scratch)*
1. **Product Spec** → 1a: Draft (or review/complete if intake provided coverage) → 1b: Stress-test → 1c: Adversarial review → `→ HG`
2. **Behavioral Core** (AI only) → 2a: Draft → 2b: Stress-test → 2c: Adversarial review → `→ HG` — use `templates/behavioral-core.md`
3. **Architecture Contract** → 3a: Draft → 3b: Adversarial review → `→ HG`
4. **Domain Specs** → 4a: Identify subsystems → 4b: Write + cross-reference → `→ HG`
5. **Build Manifest** → 5a: Define phases + capability matrix → 5b: Initialize manifest → `→ HG`
6. **Project Setup** → 6a: CLAUDE.md → 6b: Hooks → 6c: Repo init → `→ HG`
7+. **Build Phases** → For each phase: [N]a: Build → [N]b: Verify (use `templates/phase-report.md`) → [N]c: Reconcile → `→ HG`
N+1. **Hardening** → Security → Adversarial/Abuse → Integration Seam → Data Integrity → Spec-Code → Fix *(fresh session per audit)*
N+2. **Learning Extraction** → Process review → Update artifacts

**Each build phase follows:** Context Load → Gap Check → Plan → `→ HG` → Implement → Verify → Reconcile → `→ HG`

---

## MODE: AUDIT — Step Sequence

A1: Inventory → A2: Map to hierarchy → A3: Code-spec consistency → A4: Risk assessment → A5: Remediation plan → A6: Execute remediation → A7: Re-entry

**A7: Re-entry** — After remediation, Claude presents next-step options: resume building unbuilt capabilities (→ NEW mode Step 7), run hardening, or switch to EVOLVE for new features.

---

## MODE: EVOLVE — Step Sequence

E1: Classify (Small/Medium/Large) → E2: Spec check → E3: Plan → E4: Execute → E5: Reconcile (Medium+) → E6: Impact audit (Large only)

**Multiple concurrent changes:** If 3+ changes requested: independent → run sequentially (E1-E5 each); interdependent → batch into one evolution (classify batch one tier up). If batch is Large + touches 5+ subsystems → treat as mini build with phases, not an evolution.

**Evolution hardening threshold:** Trigger targeted hardening (Security + Integration Seam + Spec-Code scoped to changed areas) when: 5th Medium+ evolution since last hardening, any evolution touching 3+ subsystems, any Behavioral Core modification, or 6 months since last hardening. Claude tracks count in Build Manifest and proactively warns at evolution 4 of 5.

---

## PHASE GATE (required before every phase transition)

1. **Build check:** Compiles, types check
2. **Test check:** Unit tests pass. Integration tests pass (hot path exercised). Deployment tests if external integrations.
3. **Hot path check:** Project-wide hot paths pass. Failure = stop condition.
4. **Regression check:** All prior-phase flows still work.
5. **Global invariants:** All pass.
6. **Spec consistency:** No drift detected.

---

## VERIFICATION ADDITIONS (v2.0)

**Class-level pattern scan:** When any bug is found, grep entire codebase for same pattern. Fix ALL instances before proceeding.

**Deploy & verify:** Mandatory if phase touches external integrations, webhooks, auth, or deployment config. Deploy to staging, test real requests.

**Hot path testing:** 1-3 project-wide critical paths defined in Build Manifest, tested at EVERY phase gate.

**Deviation tracking:** Count spec deviations per phase. If not declining over 3 phases → process review.

---

## DEBUGGING PROTOCOL

1. Reproduce → 2. Isolate subsystem → 3. Check spec coverage → 4. Fix → 5. Class-level scan → 6. Add regression test → 7. Update spec if gap found

Three strikes: same fix fails 3x → STOP. Change approach entirely.

---

## MINIMUM VIABLE PROCESS

| Tier 1 — Never Skip | Tier 2 — Skip With Caution | Tier 3 — Skip First |
|---------------------|---------------------------|-------------------|
| Reconciliation, Regression check, Scope lock, Class-level scan, Hot path test | Cross-cutting scan, Global invariants, Full Phase Report, Propagation | Adversarial reviews (spec phase), Experience test, Second-model review |

If Tier 2-3 skipped during build → MUST run at hardening.

---

## SESSION BUDGET HEURISTICS

- **Spec steps (0-5):** 1-2 sessions (Light), 2-4 (Standard), 4-6 (Heavy). One spec step per session usually fits.
- **S-complexity phases:** ~1 session (build + verify + reconcile)
- **M-complexity phases:** 1-2 sessions. Fresh session if verify reveals significant issues.
- **L-complexity phases:** 2-3 sessions. Consider splitting: build in session 1, verify + reconcile in session 2.
- **Hardening audits:** 1 fresh session per audit (a/b/c/d/e). MUST be fresh sessions (writer/reviewer pattern).
- **If a phase takes 3+ sessions:** it's likely too large — split it in the Build Manifest.

---

## SESSION START PROTOCOL

1. Read CLAUDE.md
2. Read `docs/build-manifest.md` → identify current phase and status
3. Read relevant project memory
4. State: "We're at Step [X]. Last session completed [Y]. Next up is [Z]."
5. If resuming a build phase: re-read the relevant domain spec

---

## TEMPLATES & REFERENCES

- Phase Report template: `templates/phase-report.md` or Appendix F in full protocol
- Behavioral Core template: `templates/behavioral-core.md` or Appendix B
- Decision Log entry: `templates/decision-log-entry.md` or Appendix D
- Cowork Session: `templates/cowork-session.md` or Appendix H
- Architecture Patterns: Appendix G in full protocol
- Anti-patterns: Appendix A in full protocol
- Global Invariants guide: Appendix E in full protocol

---

*Core Reference for Build Protocol v2.1 — 2026-04-15*
