# BUILD PROTOCOL v2.6

> A systematic framework for building, auditing, and evolving products with Claude Code.
> Created: 2026-04-15. Last updated: 2026-05-15. Owner: Joe Wang.

---

## CONTEXT & PURPOSE

### Why This Exists

This protocol was created because "one-shotting" product specs and implementation plans with AI produces inconsistent results — even after 20+ iterations. The core problem: **Claude Code is extremely capable at execution but has no inherent process discipline.** Without guardrails, it builds things that drift from specs, silently refactors working code, invents behavior not defined anywhere, and produces outputs that require dozens of audit passes to correct.

This document codifies a methodology for how a non-engineer product leader creates products with Claude Code — optimized for someone who is strong at conceptual scoping and product design but relies on AI for implementation.

### What We're Optimizing For

1. **Comprehensive upfront design** — get foundations right so future iterations are easier, not build-as-you-go
2. **Guided sequential execution** — "do next step, do next step" with human review at each boundary, not manual copy-paste
3. **Spec-code consistency** — specs and code stay in sync throughout the build, not just at the beginning
4. **Cross-project learning** — mistakes from one project don't repeat in the next
5. **Human leverage** — the human's time goes to product judgment and decision-making, not technical review or debugging

### How This Was Derived (Evidence Base)

This protocol was reverse-engineered from 4 real projects built between January–April 2026:

| Project | What Happened | Key Lesson |
|---------|--------------|------------|
| **Explain My Blood Test** | 931 commits over 3.5 months, 70% were fixes. No upfront specs. Definition drift (7 copies of one taxonomy). Fix-after-fix chains. ~60K lines of code. | **Build-as-you-go produces massive churn.** Spec-first is definitively better. |
| **Tax Auction** | 7,593 lines of specs → 7,090 lines of code in 3 days. Spec held with no deviations. 1 critical audit found real issues (74 parcel misclassifications). | **Comprehensive upfront specs + sequential phases = cleanest execution.** Even good specs need post-build auditing. |
| **Do Later List** | 21 spec docs, 200K+ lines of code, 13 build phases. Copy-paste prompts. Specs never updated during build → 50+ items per audit pass × 5 audit passes. | **Upfront specs are necessary but not sufficient.** Mandatory reconciliation after each phase is the missing piece. Propagation enforcement prevents downstream rot. |
| **Strategy-research project** | Strategy-first: deep upfront specs (context docs, playbooks, agent specs) before any code. Behavioral and competitive research completed before implementation. | **Spec depth scales with product complexity.** The Behavioral Core pattern (how the system thinks) is reusable across AI products. |

### Core Thesis

**Write comprehensive specs upfront (the human's strength) → execute in sequential phases with human gates → mandate reconciliation after every phase to keep specs and code in sync → extract learnings to improve the next project.**

The protocol prevents the three failure modes observed across these projects:
1. **No specs** (EMBT) → churn, drift, fix-after-fix
2. **Specs but no reconciliation** (DLL) → spec-code divergence accumulates silently
3. **Specs but no propagation** (DLL) → changing one spec doesn't update downstream specs that depend on it

---

## HOW TO USE THIS DOCUMENT

### Quick Start

Just tell Claude Code to read this file. You don't need to read it yourself — Claude will guide you.

**Simplest invocation:** "Read ~/.claude/build-protocol.md and help me use it for my project."

Claude will then ask which mode fits your situation:

---

**When the user references this file without specifying a mode, Claude MUST:**

1. **Check if this is a first-time user** — does `docs/build-manifest.md` exist? If NO, this is a first-time user.
2. **For first-time users:** Show the Journey Map (§11.4) FIRST, then the menu below. Confirm: "Does this look like what you're trying to do?" before proceeding to mode selection. (Narrator Mode is ON by default per §11.)
3. **For returning users:** Jump straight to the menu.

Present this menu and wait for selection:

> **Which mode fits where you are?**
>
> | Mode | What it does | When to use | Roughly how long |
> |---|---|---|---|
> | **A) NEW** | Build a brand-new product from scratch. ~7 spec steps + build phases + hardening. | You're starting from zero or a fresh idea. | 4-12 sessions over 1-4 weeks |
> | **B) AUDIT** | Assess an existing, partially-built product. Maps what you have to the 5-document hierarchy, finds gaps, proposes a remediation plan. | You inherited code, or you've been building without a process and want to formalize. | 1-3 sessions |
> | **C) EVOLVE** | Add features or change an existing product. Classified Small / Medium / Large — bigger changes apply more of the build discipline. | You have a working product and want to extend it. | 1 session (Small) to 1+ week (Large) |
>
> **Which one? (A / B / C)** — or say "I'm not sure" / describe what you're trying to do and I'll recommend one.

After the user selects, Claude reads the relevant PART (II, III, or IV) and begins at Step 1 / A1 / E1. Claude does NOT need to read the entire document upfront — read Part I (Foundation, including §11 Narration Protocol) + the selected mode's section.

---

### Direct Invocation (if you already know which mode)

- **New product:** "Read ~/.claude/build-protocol.md. Use MODE: NEW to guide me through building [product name]. [Brief description of what it is.]"
- **Audit existing:** "Read ~/.claude/build-protocol.md. Use MODE: AUDIT to assess the current state of this project."
- **Evolve existing:** "Read ~/.claude/build-protocol.md. Use MODE: EVOLVE. I want to [describe the change]."

### Complexity Assessment

Before selecting a mode, assess project complexity to determine the appropriate process weight:

| Track | Criteria | What Changes |
|-------|----------|-------------|
| **Light** | 1-3 subsystems, no AI decisions, no multi-user, single integration surface | Skip Behavioral Core (Step 2). Skip Domain Specs if <3 subsystems — put details in Architecture Contract. Simplified Phase Report (always-required sections only). Skip adversarial reviews at spec phase — do them at hardening only. |
| **Standard** | 3-8 subsystems, AI decisions OR multi-user OR 3+ external integrations | Full protocol as documented. This is the default. |
| **Heavy** | Complex AI + multi-user + 5+ external integrations + compliance requirements | Full protocol + mandatory deployment verification at every phase + mandatory second-model review (ChatGPT) at spec and hardening gates + integration test suite required before Phase 2. |

If unsure, start at Standard. You can escalate to Heavy mid-build if you discover unexpected complexity, but downgrading from Standard to Light mid-build is risky — you've already skipped the foundations.

**Mid-build reclassification (escalating to Heavy):**

If you discover mid-build that the project is more complex than initially assessed:
1. **Future phases** follow Heavy requirements immediately (mandatory deploy verification every phase, mandatory second-model review at remaining spec and hardening gates)
2. **Catch-up audit** on completed phases: run a one-time review covering the gaps between Standard and Heavy — specifically, deploy verification for any phases that touched external integrations, and second-model review of the Product Spec, Architecture Contract, and Behavioral Core (if they weren't reviewed at the higher bar)
3. **Log the reclassification** in the Build Manifest with: date, which phase triggered it, rationale, and what catch-up work was done
4. **Do NOT retroactively re-run** completed phases — the catch-up audit covers the delta

### Rules for Claude Code

**Execution rules:**
1. **Follow steps in order.** Do not skip, merge, or reorder steps.
2. **Stop at every human gate (marked `→ HG`).** Present your work, wait for explicit approval. Do not proceed without it.
3. **Track current step.** Always know which step you're on. When resuming a session, read the Build Manifest to identify current position.
4. **Step numbering format:** Steps use `Na/Nb/Nc` (e.g., `8a`, `8b`, `8c`) so the human can remember and reference their position. Always prefix your work with the current step ID.
5. **Reconciliation is non-optional.** Every build phase has a reconcile step. If there's nothing to reconcile, explicitly state "No divergences found." Never silently skip it.
6. **Specs are living documents.** They are written upfront and comprehensive, then updated during build when reality diverges from plan. Stale specs are worse than no specs.

**Behavioral guardrails (Claude MUST follow these at all times):**
7. **No silent refactoring.** Previously built modules MUST NOT be refactored unless strictly required for the current phase's functionality. If a refactor IS necessary: list ALL changes explicitly in a `### Refactored` section, explain WHY each refactor was required, and confirm no regression in previously passing tests. Unauthorized refactors (changes to modules not required by the current phase) are a failure condition.
8. **No behavior drift.** Do NOT change the behavior of previously built systems unless the current phase REQUIRES it. If behavior changes are necessary, list ALL changes under a `### Behavior Changes` section, explain WHY each was required (cite the spec section), and confirm no regression in previously passing tests. Silent behavior change is a failure condition. Examples of drift that MUST be flagged: changing confidence thresholds in existing flows, altering message/confirmation formats, modifying state transition rules, changing how engines/schedulers process jobs, altering normalized input/output contracts.
9. **Scope lock.** Only build what is explicitly listed in the phase scope. Do NOT add extra features, extend scope, or anticipate future phases. If something seems missing from the specs, list it — do NOT build it.
10. **Drift prevention.** Do NOT invent behavior not defined in the Behavioral Core. Do NOT invent system design not defined in domain specs. All behavior must trace back to a specific spec section. If you cannot cite the section, the behavior does not exist and must not be implemented.
11. **Idempotency.** Every build step must be safely re-runnable. Check existing state before writing. Update instead of recreate when a file already exists. Verify current state matches expectations before proceeding.
12. **Complexity rule.** Prefer simple implementation, explicit logic, and clarity over abstraction. Three clear lines of code are better than one clever abstraction. Avoid premature optimization and over-generalization.
13. **Flag divergences immediately.** If you discover something that contradicts a spec, STOP and flag it — don't silently pick one interpretation. Present the conflict, propose 2-3 resolution options, and wait for approval.
14. **Two-correction rule.** If the human has corrected the same issue twice in a session, the context is likely polluted with failed approaches. Recommend: `/clear` and restart with a better-scoped prompt. A fresh session with a clear prompt almost always outperforms a long session with accumulated corrections.

**Failure stop conditions (Claude MUST stop immediately if):**
- Required behavior is NOT defined in the Behavioral Core (for AI products)
- Required mechanics are NOT defined in the relevant domain spec
- Two docs conflict with each other
- A system behavior is ambiguous (no clear rule exists)
- An assumption would be needed to proceed
- A dependency from a previous phase is missing or broken
- A referenced module/file does not exist

When stopping: clearly state the gap, propose the exact spec patch needed (which file, which section, what to add), provide 2-3 resolution options if applicable, and wait for approval.

### Role Division

| Role | Who | What |
|------|-----|------|
| **Product scoping & decisions** | Human | Defines what to build, reviews and approves all work, resolves ambiguities, makes tradeoff calls |
| **Adversarial review (specs)** | ChatGPT | Reviews Product Spec, Behavioral Core, and Architecture Contract for gaps and blind spots |
| **Drafting, building, verifying** | Claude Code | Writes specs, code, tests; runs validation; proposes reconciliations |

---

## PART I: FOUNDATION

*These concepts apply to all three modes. Read this section first.*

### 1. Document Hierarchy

Every product has up to 5 canonical documents. Together they are the complete source of truth.

| # | Document | Answers | Required? |
|---|----------|---------|-----------|
| 1 | **Product Spec** | WHAT it does. Vision, capabilities, scenarios, economics. True north star. | Always |
| 2 | **Behavioral Core** | HOW it thinks. Decision logic, confidence thresholds, autonomy boundaries, tone, conflict resolution. | Only if AI makes consequential decisions |
| 3 | **Architecture Contract** | HOW it's built. Tech stack, patterns, constraints, red flags, provider abstractions, security baseline. | Always (for code products) |
| 4 | **Domain Specs** | DETAILS of each subsystem. Data models, APIs, state machines, integration points, edge cases. | If product has 3+ subsystems |
| 5 | **Build Manifest** | WHERE we are. Phase list, current status, decisions made, deferred items, deviations from plan. | Always |

**Hierarchy rules:**
- Product Spec is supreme. If any doc contradicts it, Product Spec wins (or the Product Spec gets updated — never silently ignored).
- Behavioral Core governs all AI behavior. Code must implement it exactly. Drift here is the hardest bug to find.
- Architecture Contract governs all technical choices. No ad-hoc tool or pattern decisions outside it.
- Domain Specs are detailed implementations OF the Product Spec, not alternatives to it.
- Build Manifest is the only doc that tracks current state (what's done, what's in-progress). All other docs describe desired state.

**Source-of-truth priority (when docs conflict):**
1. Product Spec (vision, capabilities, scope)
2. Behavioral Core (decision logic, tone, autonomy rules)
3. Architecture Contract (tech stack, patterns, constraints)
4. Domain Specs (subsystem details, schemas, APIs)
5. Build Manifest (execution sequence, current state)

If behavior is defined in both the Product Spec and the Behavioral Core, the **Behavioral Core wins** — it is the single source of truth for all behavioral decisions. The Product Spec is vision; the Behavioral Core is implementation authority. System docs (domain specs) execute behavior defined in the Behavioral Core — they do not define new behavior.

**Global Spec Lock (MANDATORY):**

Claude MUST treat project specs as STRICT, NOT INTERPRETABLE.

1. If behavior differs from Behavioral Core → FAIL
2. If schema differs from the data model domain spec → FAIL
3. If API route differs from the API architecture domain spec → FAIL
4. If engine/pipeline logic differs from the relevant domain spec → FAIL
5. If behavior is derived from the Product Spec instead of the Behavioral Core (when Behavioral Core defines it) → FAIL

NO reinterpretation allowed. If ambiguity exists → STOP → ask for clarification → DO NOT choose an interpretation.

Implementation must EXACTLY match specs. "Close enough" is not passing.

**Supporting documents (non-hierarchical):**
- `decision-log.md` — Every non-obvious decision with rationale. Prevents re-litigating settled questions across sessions.
- `tool-decisions.md` — Tool comparisons and selection rationale (see Tool Stack section).

### Review Responsibility Matrix

The human and Claude review different things. This prevents the human from drowning in technical detail and prevents Claude from making product judgment calls.

| Claude Code handles (technical) | Human handles (product + business) |
|---|---|
| Does the code match the specs? | Does the product *feel* right? |
| Are invariants and architecture rules followed? | Do confirmations, messages, and alerts sound right? |
| Are there regressions from prior phases? | Would you trust this with your own data? |
| Is the schema/API/engine logic correct? | Do the unit economics work? |
| Are security and data isolation rules met? | Does the UX feel premium, not generic? |

**When reading Claude's phase report, the human should focus on:**
1. **User-facing output** — Read the actual messages, UI, and workflows. Does it feel right or generic?
2. **Spec changes proposed** — Do the proposed additions match your product vision?
3. **Deviations from spec** — Scan for anything that sounds like a product change, not just a technical choice
4. **Assumptions made** — Are any assumptions incorrect or undesirable?

**The human's Go/No-Go decision is about product quality, not technical correctness.** If Claude says "technically sound" but the output feels wrong — that's a valid NO-GO.

### 2. Folder Structure

```
project-name/
├── docs/                           # Specs and process — never runtime code
│   ├── product-spec.md             # Layer 1: WHAT
│   ├── behavioral-core.md          # Layer 2: HOW it thinks (if AI product)
│   ├── architecture.md             # Layer 3: HOW it's built (incl. threat model, observability, rollback posture, cost budget)
│   ├── build-manifest.md           # Layer 5: WHERE we are
│   ├── decision-log.md             # Non-obvious decisions with rationale
│   ├── tool-decisions.md           # Tool evaluations and choices
│   └── domains/                    # Layer 4: subsystem details (prose)
│       ├── [subsystem-1].md
│       └── [subsystem-n].md
├── contracts/                      # v2.2: Machine-readable contracts for subsystem boundaries
│   ├── [subsystem-1].ts            # (or .schema.json, .openapi.yaml, .proto, etc.)
│   └── shared.ts                   # Cross-subsystem shared types
├── evals/                          # v2.2: AI golden eval sets (if AI product)
│   └── behavioral-core.yaml        # Re-run at every AI-touching phase gate
├── src/ or app/ or lib/            # Application code
├── tests/ or __tests__/            # Test code
├── scripts/                        # Automation, deployment, audits
├── supabase/ or db/                # Database migrations (if applicable)
├── config/                         # Configuration files
├── .env.example                    # Environment template (never secrets)
├── CLAUDE.md                       # Claude Code project context (refs docs/, doesn't duplicate)
├── README.md                       # Human-readable project overview
└── package.json / pyproject.toml   # Dependencies
```

**Rules:**
- `docs/` is for specs and process only. Never put runtime code here.
- `CLAUDE.md` is a compact reference that points to `docs/` — it should not duplicate spec content. It contains: what this project is, current phase, architecture rules, red flags, build/deploy commands.
- Non-code products (strategy docs, analysis tools) may not have `src/` — that's fine. The `docs/` structure still applies.

### 3. Tool Stack Selection

#### When to Evaluate
- During Step 4 (Architecture Contract) — choose the primary stack
- When a build phase requires a capability you haven't selected a tool for
- When a current tool proves inadequate (log why in tool-decisions.md)

#### Evaluation Template

Record every tool decision in `docs/tool-decisions.md`:

```markdown
### [Capability Name] — [YYYY-MM-DD]
**Need:** [What capability is required and why]
**Options:**
| Tool | Pros | Cons | Cost (at 1K users) |
|------|------|------|-------------------|
| [A]  |      |      |                   |
| [B]  |      |      |                   |
| [C]  |      |      |                   |

**Decision:** [Tool chosen]
**Rationale:** [Why — reference the weighted factors below]
**Abstraction:** [Wrapped in provider abstraction? Y/N. If N, why not.]
**Revisit trigger:** [What would make us reconsider — cost threshold, feature gap, etc.]
```

#### Decision Factors (weighted)
1. **Simplicity** (30%) — Low config overhead? Claude Code can work with it effectively?
2. **Cost at scale** (20%) — What's the cost trajectory at 100 / 1K / 10K users?
3. **Lock-in risk** (15%) — How hard to switch? Proprietary API? Data portability?
4. **Ecosystem fit** (15%) — Works well with the rest of the chosen stack?
5. **Familiarity** (10%) — Have you or Claude Code worked with this before?
6. **Community & docs** (10%) — Good documentation = Claude Code can assist better

#### Provider Abstraction Rule
If there's >30% chance of switching providers within 12 months, wrap the integration in a provider abstraction from day one. This costs ~1 hour upfront and saves weeks later.
- Common abstractions: messaging (SMS/push), AI models, email, payments, calendar, storage
- Don't abstract everything — only capabilities where the market is shifting or you're uncertain

### 4. Memory & Lessons

#### What Gets Saved (automatically by Claude Code)

| Trigger | What to Save | Where |
|---------|-------------|-------|
| Non-obvious decision made | Decision + rationale | `decision-log.md` |
| Tool surprised us (good or bad) | Finding + impact | `tool-decisions.md` |
| Human corrected Claude's approach | The correction + why | Feedback memory file |
| Phase revealed something specs missed | The discovery | Updated spec + decision-log |
| Project milestone completed | Key learnings | Project memory file |
| Process step felt wasteful or was skipped | Observation | Flag for Build Protocol update |

#### Memory Hygiene Rules
- Check for existing memory before creating new (no duplicates)
- Merge overlapping memories
- Never duplicate CLAUDE.md or docs/ content in memory
- MEMORY.md = one-line index entries, <150 chars, always pointers to detail files
- Archive project memories when project is stable for 3+ weeks

#### Cross-Project Learning
When starting a new project, Claude should:
- Check if similar to a past project (same stack, same domain, same product type)
- Surface relevant lessons and known pitfalls
- Reference tool decisions from similar projects (don't re-evaluate tools you've already chosen unless there's a reason)

### 5. Context & Session Management

Context window degradation is the #1 cause of quality drop-off in long build sessions. Claude doesn't hit a wall — it degrades gradually: inconsistency and "forgetfulness" appear well before the hard limit.

**Rules:**
- **`/clear` between unrelated tasks.** If you finish a build phase and want to ask an unrelated question, clear first. Mixed-context sessions produce the worst outputs.
- **`/compact` proactively, not reactively.** Run it after completing a significant sub-step, before starting the next. Don't wait for degradation signals. Add to CLAUDE.md: *"When compacting, always preserve: the current build phase, list of modified files, pending decisions, and test commands."*
- **Use subagents for investigation.** When Claude needs to research the codebase (reading many files), dispatch a subagent. It runs in a separate context window and reports back a summary, keeping your main context clean.
- **Two-correction rule.** If you've corrected Claude more than twice on the same issue, the context is polluted with failed approaches. `/clear` and start a fresh session with a better prompt that incorporates what you learned. A clean session with a better prompt almost always outperforms a long session with accumulated corrections.
- **Scope file reads explicitly.** "Read only `src/services/billing.ts` for this task" saves enormous context vs "look at the billing system." For large files: "Focus on the `processRefund` function specifically."
- **Session boundaries at phase boundaries.** Each build phase (Na/Nb/Nc) is a natural session boundary. If context is getting heavy, start a fresh session at the next phase — the Build Manifest carries state across sessions.

**Session budget heuristics:**

These are rough expectations, not commitments — actual session length depends on complexity, context load, and iteration cycles:
- **Spec steps** (Steps 0-5): Expect 1-2 sessions for Light track, 2-4 for Standard, 4-6 for Heavy. Each spec step (draft → stress-test → adversarial) can usually fit in one session.
- **S-complexity phases:** ~1 session (build + verify + reconcile)
- **M-complexity phases:** 1-2 sessions. Start a fresh session if verify reveals significant issues.
- **L-complexity phases:** 2-3 sessions. Consider splitting: session 1 for build, session 2 for verify + reconcile.
- **Hardening audits:** 1 session per audit (a/b/c/d/e). Each MUST be a fresh session (writer/reviewer pattern).

If a phase takes more than 3 sessions, it's likely too large — consider splitting it in the Build Manifest.

**Context health indicators:**
- At 50%+ capacity: be more explicit in instructions, scope file reads tightly
- At 70%+: `/compact` immediately, consider fresh session
- At 85%+: start a new session — quality is unreliable from here

### 6. Reconciliation Protocol

#### When to Reconcile
- After every build phase (the Nc step — mandatory, never skip)
- After every Medium+ evolution (EVOLVE mode, Step E5)
- When an audit finds inconsistencies
- When the human flags something that "doesn't match the spec"

#### How to Reconcile
1. **Identify the divergence:** Spec says X, code does Y (or vice versa)
2. **Determine which is correct:**
   - Spec is right → fix the code
   - Code is right (learned something during build) → update the spec
   - Neither is clearly right → flag for human decision
3. **Check downstream impacts:**
   - Does this change affect other domain specs?
   - Does this change affect the Build Manifest timeline or scope?
   - Does this change affect the Architecture Contract constraints?
   - Does this change affect the Behavioral Core logic?
4. **Update all affected documents** — not just the one that diverged
5. **Log the reconciliation** in decision-log.md with rationale

#### Propagation Enforcement (MANDATORY when specs change)

If any spec is modified during a phase, Claude MUST:

1. **Scan ALL future build phases** for references to the changed file/section
2. **Explicitly state whether those phases are impacted** — list each affected phase by name and explain what changed
3. **Flag impacted phases in the Build Manifest** — mark them with a note: "Re-read [spec file] before executing — modified in Phase [N]"

Claude MUST NOT:
- Proceed silently after a spec change
- Assume future phases will "figure it out" when they load the updated spec
- Defer propagation to a later phase without explicit acknowledgment

**If a spec was modified and the propagation section of the Phase Report says "None" — that is a failure condition.**

#### The Anti-Pattern This Prevents
In DLL, specs were written comprehensively upfront (good) but never updated during build (bad). By Phase 8, the Phase 3 data model had changed but the Phase 8 domain spec still referenced the old schema. This wasn't caught until audit passes found 50+ items. Reconciliation + propagation enforcement after every phase prevents this accumulation.

### 7. Quality Gates

| Gate | When | Pass Criteria |
|------|------|---------------|
| **Spec Gate** | After all specs written (Steps 1-5 in NEW mode) | Specs are internally consistent; ChatGPT has reviewed Product Spec + Architecture + Behavioral Core |
| **Phase Gate** | After each build phase (Na/Nb/Nc) | All 4 checks below pass; specs reconciled; propagation complete |
| **Hardening Gate** | After all build phases complete | Security audit, data integrity audit, and spec-code consistency audit all pass |
| **Ship Gate** | Before launch | All hardening items resolved or explicitly deferred with rationale |

**Phase Gate detail (System Integrity Check — required before every phase transition):**

1. **Build check:** Code compiles, types check, no errors. Machine-readable `contracts/` validate.
2. **Test check (by type):**
   - **Unit tests:** All pass. These catch logic errors within modules.
   - **Integration tests:** All pass. These catch contract mismatches between subsystems. At minimum, one integration test must exercise the project's hot path(s) end-to-end.
   - **Deployment tests** (if phase touches external integrations, webhooks, or auth): Deploy to staging/preview environment and confirm at least one real request succeeds. "It compiles" is not "it works."
3. **Hot path check:** Run the project-wide hot path(s) defined in the Build Manifest. Hot path failure is a stop condition — do not advance.
4. **AI eval check (v2.2):** If phase touched AI behavior, re-run `evals/behavioral-core.yaml`. A drop in pass-rate vs prior phase is a stop condition.
5. **Cost guardrail check (v2.2):** If Architecture Contract defines a per-request cost budget, measure actual cost. Exceeding the budget is a stop condition.
6. **Regression check:** Re-test critical flows from ALL prior phases. If any prior flow is broken → fix before advancing.
7. **Global invariants:** Re-verify all project invariants (see Appendix E). If any violated → fix before advancing.
8. **Spec consistency:** Confirm implementation still matches domain specs, Architecture Contract, and Behavioral Core. If drift detected → reconcile before advancing.

If ANY check fails → fix before proceeding. Do NOT advance to next phase with known regressions or invariant violations.

**Human Gates (`→ HG`):**
- Claude presents work and waits for explicit approval
- Human can: **approve** (advance), **revise** (request changes), **reject** (redirect entirely), or **defer** (log it, skip, revisit later)
- Deferred items are saved to Build Manifest deferred list — they don't disappear
- "Approve" means "advance to next step." Nothing else does.

### 8. Protocol Effectiveness Metrics

Track these metrics per project to measure whether the protocol is improving outcomes:

| Metric | What It Measures | Target | Where Tracked |
|--------|-----------------|--------|---------------|
| **Deviation count per phase** | Spec-code fidelity | Declining over consecutive phases | Build Manifest |
| **Fix commits / total commits** | Build quality | <30% (EMBT was 70%) | Git history |
| **Audit finding count at hardening** | Cumulative quality | <10 critical items | Hardening report |
| **Phase completion consistency** | Process predictability | Similar effort per similar-sized phase | Build Manifest |
| **Spec changes per phase** | Upfront spec quality | Declining after Phase 3 | Build Manifest |

**Deviation trend rule:** If the deviation count is NOT declining over 3 consecutive phases, trigger a process review before starting the next phase. Diagnose: Are specs unclear? Is Claude loading the wrong spec? Is context too long (degradation)? Is the phase scope too large?

### 9. Minimum Viable Process

If time pressure forces you to cut steps, follow this priority order. **Never skip** items in Tier 1. Cut from Tier 3 first, then Tier 2.

| Tier | Steps | Why They're Essential |
|------|-------|---------------------|
| **Tier 1 — Never Skip** | Reconciliation ([N]c), Regression check, Scope lock, Class-level pattern scan, Hot path test, **AI eval re-run (AI products only)**, **Machine-readable contract validation (code products)** | These prevent compounding errors. Skipping them creates debt that grows exponentially. |
| **Tier 2 — Skip With Caution** | Cross-cutting concern scan, Global invariant check, Full Phase Report (use abbreviated), Propagation enforcement, **Cost guardrail check** | These catch subtler issues. Skipping them is survivable for 1-2 phases but not more. |
| **Tier 3 — Skip First** | Adversarial reviews (spec phase, including 4c), Experience test, Second-model review, Cowork session template, Detailed module inventory | These improve quality but their absence doesn't compound. Defer to hardening. |

**The escape valve rule:** If you skip Tier 2 or Tier 3 steps during build, you MUST run them at hardening. Hardening is NOT optional even if build phases were compressed.

### 10. Debugging Protocol

When a bug is discovered during verification or after deployment, follow this sequence instead of ad-hoc debugging:

1. **Reproduce:** Confirm the failure. Define the exact input → expected output → actual output.
2. **Isolate:** Which subsystem owns this failure? Trace the data flow until you find where expected ≠ actual.
3. **Check spec coverage:** Does the spec define behavior for this case? If not → this is a spec gap, not just a code bug. Patch the spec first.
4. **Fix:** Apply the targeted fix to the isolated subsystem.
5. **Class-level scan:** Grep the entire codebase for the same pattern. If you found `.single()` should be `.maybeSingle()` in one query, check ALL queries. Report: "Found N additional instances. Fixed all."
6. **Add regression test:** Write a test that would have caught this bug. This prevents recurrence.
7. **Update spec if gap found:** If the bug revealed a spec gap (Step 3), update the relevant spec and run propagation enforcement.

**Anti-pattern this prevents:** The "spray and pray" debugging pattern — adding logging, trying random fixes, bypassing checks, adding temporary endpoints — which produces chains of 5-6 commits that should have been one. (Observed: DLL Twilio webhook debugging required 6 commits; structured debugging would have required 1-2.)

**Three-strikes integration:** If the same fix fails 3 times following this protocol, STOP. The bug is not where you think it is. State what was tried, what was ruled out, and change approach entirely.

### 11. Narration Protocol (v2.3 — for guiding non-engineer users)

The rest of this protocol tells Claude *what to produce*. This section tells Claude *how to narrate the journey* so a non-engineer user knows where they are, what's happening, and what's coming next.

**Default state:** Narrator Mode is **ON** for any session that enters NEW mode. The user can disable it with "skip narration" or "terse mode" at any point. Returning users with an existing Build Manifest get a condensed narration (skip the journey map and glossary primers — they've seen them).

#### 11.1 — The Ten Narration Rules

1. **Open with orientation.** On the first turn of a NEW mode session, before mode selection, show the Journey Map (§11.4). Confirm: "Does this look like what you're trying to do?" Don't proceed until the user has the shape of the thing in their head.

2. **Use the Preamble Template at every step entry.** Before drafting Step 1a, Step 2a, Step 3a, etc., narrate per §11.2. Never just start producing the artifact without context.

3. **Define jargon inline on first use.** When a term from Appendix J appears for the first time in a session, define it in one sentence inline before using it normally. Don't make the user go look it up.

4. **Make every Human Gate (`→ HG`) explicit about choices.** When pausing for approval, state the user's four options every time: *approve* (advance), *revise* (request changes), *reject* (redirect entirely), *defer* (log it, skip, revisit later). Don't assume the user remembers them.

5. **Use the Checkpoint Summary Template after every step completion.** After Step 1c (Product Spec done), Step 2d (Behavioral Core done), etc. — narrate per §11.3 before advancing.

6. **Show progress at every step entry.** Use the Build Manifest progress tracker format (§5b): `Spec phase: ▓▓▓▓░░░ 4/7 complete. Next: Step 3 Architecture Contract.`

7. **Match action items to user expertise.** If user's project CLAUDE.md or the global CLAUDE.md flags them as a non-coder, every actionable step gets the paste-ready block format: (a) what app/window to open, (b) the exact block to paste, (c) one plain-language line on what it does. No bare commands in prose.

8. **Catch confusion signals.** If the user says "I don't get it", "what does that mean", "why are we doing this", "is this normal", or expresses uncertainty — STOP, switch to plain-English explainer mode, and resolve before continuing. Don't power through.

9. **End each session with a Pulse Report.** Before the user closes the tab, narrate: (a) where we are in the Journey Map, (b) what got produced this session, (c) what's the next step when they resume, (d) any open questions Claude asked that the user didn't fully answer.

10. **Stay narrator, not lecturer.** Narration is short and frequent, not long and rare. A one-sentence "we're about to do X because Y" beats a 200-word explainer every time. If you're writing more than 3-4 sentences of narration in a row, you're over-explaining.

#### 11.2 — Preamble Template (use at every step entry)

> **🟦 Step [N.x] — [Step Name]**
> **What we're doing:** [One sentence, plain English. Avoid jargon or define it inline.]
> **Why now:** [What we just finished + what this step enables. The chain.]
> **What I'll ask you:** [Concrete preview of the questions Claude is about to pose.]
> **What "done" looks like:** [The artifact — what file/document will exist, in plain English.]
> **Time:** [Realistic estimate: "1 session", "2-3 turns", etc.]
> **At the Human Gate, you can:** approve / revise / reject / defer.
> **Progress:** [Use the progress bar format.]

#### 11.3 — Checkpoint Summary Template (use after every step completion)

> **✅ Step [N.x] complete — [Step Name]**
> **📦 What we now have:** [The artifact, in 1-2 sentences. Where it lives. What it says.]
> **💎 Why this matters (v2.5):** [Plain-English explanation of what this artifact does for you over the next few weeks. Sell the value. A non-coder needs to feel that the time they just spent was worth it — and a clear "why" also primes them to push back if the artifact is weak. Example: "Without this Product Spec, every future build phase would have to re-litigate 'what are we even doing?' With it, when a question comes up at Phase 5 about whether feature X is in scope, the answer is in one place. This is the artifact that prevents scope creep."]
> **🚀 What this unlocks:** [The next step + why it depends on what we just produced.]
> **⚠️ Risks if we skip something later:** [Optional — only if a future step might be tempting to skip. E.g., "If we skip the eval set in Step 2d, we won't catch behavioral regressions during build."]
> **Progress:** [Updated progress bar.]

#### 11.4 — Journey Map (show on first contact, before mode selection)

> Here's the full journey for building a new product with this protocol:
>
> ```mermaid
> flowchart TD
>     A[Step 0<br/>Intake<br/><i>existing materials, if any</i>] --> B[Step 0.5<br/>Project Profile<br/><i>RAG? Agent? Marketplace?</i>]
>     B --> C[Step 1<br/>Product Spec<br/><i>WHAT it does</i>]
>     C --> D[Step 2<br/>Behavioral Core + Eval Set<br/><i>HOW the AI thinks</i><br/><i>if AI product</i>]
>     D --> E[Step 3<br/>Architecture Contract<br/><i>HOW it's built</i>]
>     E --> F[Step 4<br/>Domain Specs + Contracts<br/><i>DETAILS per subsystem</i>]
>     F --> G[Step 5<br/>Build Manifest<br/><i>PLAN of phases</i>]
>     G --> H[Step 6<br/>Project Setup<br/><i>repo, hooks, environment</i>]
>     H --> I[Steps 7+<br/>Build Phases<br/><i>actual building, one phase at a time</i>]
>     I --> J[Step N+1<br/>Hardening<br/><i>5 fresh-session audits</i>]
>     J --> K[Step N+2<br/>Learning Extraction<br/><i>what worked, what to improve</i>]
>
>     style C fill:#dbeafe,stroke:#1e40af
>     style D fill:#dbeafe,stroke:#1e40af
>     style E fill:#dbeafe,stroke:#1e40af
>     style F fill:#dbeafe,stroke:#1e40af
>     style G fill:#dbeafe,stroke:#1e40af
>     style I fill:#fde68a,stroke:#92400e
>     style J fill:#fecaca,stroke:#991b1b
> ```
>
> - **Blue = spec phase (Steps 1-5)** — we talk through your product, capture decisions, no code yet. ~1-4 sessions.
> - **Yellow = build phase (Steps 7+)** — code happens here. ~1-2 sessions per phase.
> - **Red = hardening** — separate fresh-session audits before ship. ~1 session per audit.
>
> **Total:** Roughly 4-12 sessions over 1-4 weeks, depending on complexity.
>
> We'll pause for your approval at every gate (`→ HG`). You can always stop, redirect, or defer items.

#### 11.5 — Session Open Checklist (every NEW session)

Before doing anything else:

1. Check: is there a `docs/build-manifest.md`? **Yes** → returning user, condensed narration, jump to §11.6. **No** → first-time user, full narration, show Journey Map.
2. State narrator status: "Narrator Mode is on by default. Say 'terse mode' anytime to switch."
3. For returning users: state where we are in the Journey Map and what's next.

#### 11.6 — Condensed narration for returning users

Returning users (Build Manifest exists) skip the Journey Map and jargon primers. They still get:
- Progress bar at every step entry
- Preamble Template (shortened to 3 lines: what / why now / what "done" looks like)
- Checkpoint Summary after each step
- Pulse Report at session end
- Inline jargon definitions ONLY for terms not previously used in this project's specs

#### 11.7 — Quality Bar Templates (v2.5)

The Preamble Template's "what 'done' looks like" line should reference these rubrics when the step has one. Each rubric: (a) the bar for "good enough to advance", (b) a concrete weak example, (c) a concrete strong example, (d) stop-iterating criteria.

**Quality Bar — Product Spec (Step 1a)**

- ✅ **Good enough to advance:** Every capability has a concrete user scenario behind it. Each user scenario passes the "can a stranger act this out?" test. Success metrics are measurable, not aspirational. At least one non-goal is explicit. A skeptical reader can't poke an obvious hole in the value proposition.
- ❌ **Weak:** "Users can manage their tasks. The system will be intuitive and helpful. We'll measure success by user satisfaction."
- ✅ **Strong:** "A user can text a half-formed task ('remind me to call mom tonight') and have it appear in the portal at the right time with the right context — without ever opening an app. We measure success by weekly active task-creators (north star) and the % of texted tasks that get marked complete within their timeframe (leading indicator). Non-goals for v1: project management, team collaboration, calendar sync."
- 🛑 **Stop iterating when:** the human can describe the product from memory in 30 seconds without checking the doc; and a colleague unfamiliar with the project can read the spec and predict the right answer to "is feature X in scope?" 8 times out of 10.

**Quality Bar — Behavioral Core (Step 2a, AI products)**

- ✅ **Good enough to advance:** Every decision the AI makes has a rule. Every rule has a confidence threshold or a deterministic trigger. Every "never" / "always" rule has at least one adversarial test in the eval set (Step 2d). Tone is defined with concrete examples, not adjectives.
- ❌ **Weak:** "The AI should be friendly and helpful. It should avoid being too pushy. It should ask for confirmation when unsure."
- ✅ **Strong:** "If confidence ≥ 0.85 → execute silently. 0.5-0.85 → execute + show a one-line confirmation ('I scheduled it for 7pm — say nope if wrong'). <0.5 → ask one targeted question, never two. Tone: warm and brief, like a competent assistant — never apologetic, never robotic. Example warm: 'Got it — calling mom at 7.' Example NOT warm: 'I have successfully created your task.' Refuse and explain when: the request involves money, the user's identity, or another user's data."
- 🛑 **Stop iterating when:** the rules are concrete enough that two different engineers reading them would implement the same behavior.

**Quality Bar — Architecture Contract (Step 3a)**

- ✅ **Good enough to advance:** Tech stack is chosen with a written rationale (`tool-decisions.md`). Every external integration has an abstraction-or-not decision. Cost-per-user at 100/1K/10K is estimated (range is fine; absent is not). Threat model lists ≥3 plausible threats with mitigations. Observability plan names specific metrics, not categories.
- ❌ **Weak:** "We'll use a modern stack with appropriate security and monitoring."
- ✅ **Strong:** "Next.js 16 + Supabase (Postgres + Auth + RLS) + Vercel for hosting + Anthropic Claude Sonnet via AI Gateway. Cost at 1K users: ~$180/mo (DB $50, Vercel $25, AI ~$105 @ $0.10/active-user-day). Threat model: (1) prompt injection from user task text — mitigation: sanitize + system-prompt isolation. (2) cross-tenant data leak — mitigation: RLS on every table. (3) webhook spoofing — mitigation: signature verification. Observability: log every AI call with tokens + cost + latency; trace SMS-in → AI → SMS-out as one span; alert on p95 latency > 8s or error rate > 2%."
- 🛑 **Stop iterating when:** the architecture lets the human estimate cost and identify failure modes without re-asking Claude.

**Quality Bar — Domain Specs (Step 4b)**

- ✅ **Good enough to advance:** Every subsystem boundary has a machine-readable contract in `contracts/`. Every state machine has all transitions enumerated (including the error transitions). Every API endpoint has explicit error cases. Cross-references between specs use exact field names (no "task ID" in one and "taskId" in another).
- ❌ **Weak:** "The messaging subsystem will handle SMS in and out. It will integrate with the task subsystem."
- ✅ **Strong:** "Messaging subsystem owns inbound SMS parsing, outbound delivery, and provider abstraction. Inbound contract: `{ from: E164, body: string, twilioMessageSid: string }` → produces `NormalizedInput` (see contracts/messaging.ts). Outbound contract: `NormalizedOutput → { to: E164, body: string, provider: 'twilio' | 'mock' }`. States for outbound: queued → sending → sent → delivered | failed (retry up to 3x) → dead. Error cases enumerated: invalid phone (E164 fails), provider 4xx, provider 5xx, provider timeout."
- 🛑 **Stop iterating when:** every spec compiles (machine-readable contracts validate) and every cross-spec reference resolves.

**Quality Bar — Build Manifest (Step 5a)**

- ✅ **Good enough to advance:** Every Product Spec capability maps to exactly one phase (Capability Traceability Matrix). Every phase has an Acceptance Gate with explicit exit criteria AND explicit scope boundary. Every phase has a rollback plan. Hot paths are defined. Success metrics from Step 1a are mapped to instrumentation events.
- ❌ **Weak:** "Phase 1: set up infrastructure. Phase 2: build core features. Phase 3: polish."
- ✅ **Strong:** "Phase 3 (Messaging — Medium). Scope: inbound SMS parsing + outbound delivery via Twilio. Exit criteria: a user can text 'buy milk tomorrow' and receive a confirmation within 5s; failed sends retry per spec; signature verification rejects forged webhooks. Scope boundary: NOT building AI interpretation yet (that's Phase 4) — Phase 3 just routes raw text. Rollback: set `MESSAGING_ENABLED=false` env var → falls back to manual-input mode. Validation: real Twilio test message + 3 forged webhook attempts (all should reject). Hot path: SMS-in → task object exists in DB → outbound confirmation sent."
- 🛑 **Stop iterating when:** the human could hand the Build Manifest to a different engineer and they'd build it the same way.

**General rule:** if the human can't say *what specifically would make this artifact better*, the artifact is done. If they can, keep iterating.

#### 11.8 — Why-this-matters narration (v2.5)

Rule 5 of §11.1 requires the Checkpoint Summary after every step. §11.3 now includes a "💎 Why this matters" line. This subsection is the **rule about that line**:

- It's mandatory for a first-time user. Returning users (condensed narration, §11.6) get a shortened one-liner.
- It must be **product-leader language, not engineer language**. Avoid mentioning files, schemas, or types. Talk about decisions prevented, scope creep avoided, future conversations made shorter.
- It must be **specific to what you just produced**, not a generic platitude. "Your Product Spec is now ready" is not a why-this-matters; "your Product Spec just defined non-goals, which is the thing that will stop scope creep at Phase 5" is.
- If you can't write a specific "why this matters", the artifact is probably weak — go back and look at the Quality Bar (§11.7) before declaring the step complete.

#### 11.9 — Confusion-Catch Phrases (v2.5)

Rule 8 of §11.1 says "catch confusion signals." This subsection lists the specific signals.

**Trigger phrases (stop and back up if you hear any of these):**

- "I'm not sure what you mean."
- "What does [term] mean?"
- "Why are we doing this?"
- "Is this normal?"
- "I'll just trust you on this."  ← *especially this one — it usually means "I'm lost and giving up"*
- "Skip ahead."  ← *unless they explicitly know what they're skipping*
- "Whatever you think is best."
- "Just do what makes sense."
- "I don't really know."
- "Can we move on?"
- "Sounds good." (without engaging with the specifics — this often means disengagement, not approval)

**Response template when triggered:**

> "Let me back up. We're at [step] because [reason in plain English]. What we're trying to figure out right now is [specific question]. The reason that matters is [downstream consequence]. Want me to explain a different way, give an example, or are you okay if I make a reasonable guess and flag it for you to confirm later?"

Then offer three explicit options:
1. **Explain differently** (Claude tries again with a different angle / analogy)
2. **Show an example** (Claude shows what a strong answer looks like from a similar past project)
3. **Make a guess + flag** (Claude proceeds with an assumption, tagged inline, surfaces it again at the next HG)

Never just power through. Disengagement compounds — a user who said "sounds good" at Step 2 will discover at Step 5 that they didn't actually agree, and rolling back is expensive.

---

## PART II: MODE — NEW

*Building a new product from scratch. Follow every step in order.*

### Step 0: Intake

**0a: Existing Materials Check**
- Claude asks: "Do you have existing materials — specs, PRDs, notes, wireframes, Notion docs, Google Docs, slides, or prior conversations with other AI tools?"
- If **no** → skip to Step 1a (draft from scratch)
- If **yes** → human provides the materials (paste, file path, or URL)

**0b: Material Mapping**
- Claude reads all provided materials and maps content to the 5-document hierarchy:
  - What maps to Product Spec? (vision, capabilities, scenarios, economics)
  - What maps to Behavioral Core? (decision logic, tone, autonomy rules)
  - What maps to Architecture Contract? (tech choices, constraints, patterns)
  - What maps to Domain Specs? (subsystem details, data models, APIs)
  - What is NOT covered by any document? (gaps to fill)
  - What contradicts itself across materials? (conflicts to resolve)
- Output: A mapping table showing which existing content covers which hierarchy document, what's missing, and what conflicts
- `→ HG:` Human reviews mapping, confirms which materials to incorporate vs discard

**0c: Accelerated Start**
- For each hierarchy document that has substantial existing coverage: Step [N]a becomes "Review and complete" rather than "Draft from scratch" — Claude incorporates existing content, fills gaps, and flags where existing material is unclear or incomplete
- For documents with no existing coverage: proceed with normal drafting
- Existing materials that don't fit the hierarchy (e.g., competitor analysis, user research) are preserved in `docs/reference/` and cited where relevant

### Step 0.5: Project Profile (v2.4)

*A routing step. Bob's core protocol is generic; archetypes have additional considerations. Step 0.5 classifies the project and pulls in the relevant addendum from Appendix K.*

**0.5a: Classify**
- Claude asks the user: "Which of these archetypes most closely matches what you're building?" — presents the profile list from Appendix K.
- Common archetypes: AI Chat/Copilot, Internal B2B Tool, RAG Pipeline, Vertical SaaS, Agent/Tool-Use Workflow, Marketplace, E-commerce, Content/Community, Real-time/Collaborative, Mobile-First, Browser Extension, Voice/Audio, Data Pipeline/ETL, SEO/Marketing site.
- Multi-archetype projects (e.g., "internal B2B tool with RAG and agent loops") select primary + secondary profiles.
- "None of these / hybrid" is a valid answer — Claude proceeds with the generic protocol.

**0.5b: Pull addendum**
- For each selected profile, Claude reads the matching Appendix K entry and surfaces:
  - Additional Product Spec considerations (extra capabilities/scenarios to include in Step 1a)
  - Additional Architecture Contract considerations (extra concerns for Step 3a)
  - Architecture Patterns relevant to this profile (specific G-pattern references)
  - Known gotchas / failure modes for this archetype
- The addendum is **additive only** — it never replaces or weakens core protocol steps. If a profile addendum and a core step conflict, the core step wins.

**0.5c: Tag in Build Manifest**
- When the Build Manifest is created in Step 5b, the selected profile(s) are recorded at the top: `Project Profile: [primary] + [secondary]`.
- This tag persists across sessions so Claude reloads the relevant addendum at every session start.
- `→ HG:` Human confirms profile selection.

### Step 1: Product Spec

**1a-pre: Structured Interview (v2.5 — MANDATORY if initial description is < ~50 words OR if Claude detects ambiguity)**

The old Step 1a assumed the human walks in with a clear vision. Real users walk in with a sentence. This pre-step extracts what's actually in your head before Claude drafts.

*Skip condition:* If the human provided substantial existing materials in Step 0 (PRDs, slides, prior chats) that already cover the interview dimensions below, Claude skips 1a-pre and proceeds to 1a — but still flags any dimension where the existing materials are thin.

**Part I — JTBD-style interview (~10-15 questions, one at a time):**

Claude asks these in conversation, one or two at a time — never as a wall of questions. Don't proceed to Part II until Part I is complete.

1. **Customer:** Who specifically is this for? (Role, industry, company size, life stage — whatever defines them.) If you say "everyone" or "anyone who wants X" — narrow down. The first version cannot be for everyone.
2. **Problem:** What's the pain they have today? Describe a specific moment when that pain shows up — not the abstract version.
3. **Current alternatives:** What do they do today instead? (Other tools, manual processes, "they just suffer".) What do they hate about those alternatives?
4. **Emotional driver:** When this product solves the problem, how does the customer *feel* in that moment? (Relieved? Smug? Productive? Trusting?)
5. **Trigger:** What event/moment makes them decide they need to solve this? (The "I can't take this anymore" event.)
6. **Success criteria — for the customer:** How will *they* know the product worked for them? (Not "they'll be satisfied" — a concrete observable.)
7. **Success criteria — for you:** What does business success look like in 6 months and 12 months? (Users? Revenue? Retention? Word-of-mouth?)
8. **Closest reference product:** What existing product is closest to what you want to build? What does it get right? What does it get wrong that you'll do differently?
9. **What this is NOT:** Name 3 things that would be tempting to add but you want to explicitly NOT do in v1.
10. **Hard constraints:** Budget, timeline, regulatory, technical (e.g., "must work without an account", "must not store PII", "shipping by Y").
11. **Risk tolerance:** If a feature is 80% reliable, is that ship-worthy or no-go? Where's the bar — "delight" or "doesn't embarrass me"?
12. **One-liner test:** Finish this: "It's like [X] but for [Y]." or "It's [adjective] [category] for [audience]."

Claude captures answers in `docs/interview-notes.md` and surfaces any contradiction it spots ("you said the customer is X but the use case suggests Y — which is it?").

**Part II — Day in the Life walkthrough:**

Before drafting capabilities, Claude asks the human to narrate a typical day for the target user, in detail. Specifically:

- What does the user do *before* they would use this product? (Context — what else is going on in their day.)
- The exact moment they would reach for this product. Where are they? What just happened? What are they trying to accomplish in the next 5 minutes?
- Step-by-step what they do *with* the product. (Bias toward concrete actions, not abstract "they manage their tasks".)
- What happens *after* they're done with the product? (Did the value persist? Do they come back?)
- Where does this break down today? (What goes wrong with their current process at each step?)

This walkthrough surfaces unstated assumptions ("oh wait, they're driving when they think of this — so it has to be voice or SMS, not a web UI"). Capture as `docs/day-in-the-life.md` and treat it as the source for user scenarios in 1a.

`→ HG:` Human reviews interview notes + day-in-the-life. Confirms accuracy. Flags anything Claude misunderstood.

**1a: Draft**
- Human describes the product conversationally
- Claude drafts the Product Spec covering:
  - What is this product? (1-paragraph elevator pitch)
  - Who is it for? (Target users, their pain, their current alternatives)
  - What problem does it solve? (The core value proposition)
  - What are the core capabilities? (MVP scope — be ruthless about what's in vs out)
  - **Non-goals** (explicit list of what this product does NOT do — mirrors the scope-boundary discipline in phase acceptance gates)
  - What's the roadmap beyond MVP? (Phases, not dates)
  - User scenarios (3-5 concrete end-to-end walkthroughs)
  - **Success metrics** (1 north-star metric + 2-3 leading indicators; how we know the product is working, not just the code)
  - **Activation definition** ("a user is activated when X" — the first moment the product delivers its core value)
  - Business model / economics (pricing, cost structure, unit economics)
  - **Data classification** (what user data flows through this? PII / regulated / sensitive / public; informs threat model in Step 3a and security audit at hardening)
  - Constraints (budget, timeline, regulatory, technical)
- `→ HG:` Human reviews, iterates until satisfied with the draft

**1b: Stress-Test**
- Claude pressure-tests the spec:
  - Logical gaps (capability X requires capability Y, but Y isn't listed)
  - Scope clarity (is each capability clearly MVP vs later?)
  - User scenario coverage (do scenarios cover happy path + key edge cases?)
  - Constraint realism (is this buildable within stated constraints?)
  - Missing economics (what's the cost per user? Per AI call? Per message?)
- Present findings as a numbered list
- `→ HG:` Human reviews, resolves each finding

**1c: Adversarial Review**
- Claude performs a self-adversarial review of the Product Spec by adopting an explicitly critical stance:
  - *"I am now reviewing this spec as an adversarial critic. My job is to find holes, not confirm quality."*
  - Focus areas: conceptual gaps, scope creep risks, scenarios where the product would fail or confuse users, missing economics, unstated assumptions
  - Present findings as a numbered list with severity (Critical / Important / Minor)
- Claude proposes fixes for each finding
- `→ HG:` Human reviews, resolves each finding.
- **Optional — second-model review:** Human may additionally take the Product Spec to a second AI (e.g., ChatGPT) for independent review. Prompt: *"Review this product spec. Focus on: conceptual gaps, scope creep risks, market blind spots, scenarios where the product would fail or confuse users. Be adversarial — find the holes."* Bring back any new findings for Claude to incorporate.

**1d: Stability Loop (v2.5 — MANDATORY)**

A fix to one finding can introduce a new gap. One pass of stress-test + adversarial review is not enough.

- Re-run the stress-test (1b focus areas) and the adversarial review (1c focus areas) against the now-revised spec
- Report findings. Compare to prior round:
  - **No new Critical or Important findings** → spec is stable, advance to Step 2
  - **New Critical or Important findings** → resolve them, then loop again
- **Iteration cap: 3 rounds.** If the spec is still unstable after 3 rounds, that's a signal the product idea itself is unstable. STOP and have an honest conversation about whether the scope needs to shrink or the problem needs to be re-framed. Don't keep iterating in hope.
- Each round logs to `docs/decision-log.md`: round number, what was found, what was changed.
- `→ HG:` Human reviews stability report. Product Spec finalized.

Use the **Quality Bar — Product Spec (§11.7)** as the bar for "done." If the human can't say *what specifically would make the spec better*, the spec is done.

### Step 2: Behavioral Core (AI products only — skip if N/A)

**2a: Draft**
- Claude drafts the Behavioral Core covering:
  - Decision framework: How does it decide what to do? (confidence thresholds, scoring, rules)
  - Autonomy boundaries: What can it do without asking? What requires confirmation? What does it refuse?
  - Communication style: Tone, format, length, escalation patterns
  - Absolute constraints: "Never do X" / "Always do Y" rules (hard stops)
  - Conflict resolution: When two subsystems or rules disagree, which wins?
  - Memory model: What does it remember? For how long? How does it use context?
  - Error behavior: What does it do when uncertain, when it fails, when the user is confused?
- `→ HG:` Human reviews, iterates

**2b: Stress-Test**
- Claude tests with adversarial scenarios:
  - Low-confidence input: What happens when the AI isn't sure what the user wants?
  - Rule conflicts: What happens when two Behavioral Core rules point in different directions?
  - Scope boundary: What happens when the user asks for something outside scope?
  - Failure cascade: What happens when the AI is wrong and acts on it?
  - Tone edge cases: What does it sound like when delivering bad news? When nagging? When the user is frustrated?
- `→ HG:` Human reviews, resolves

**2c: Adversarial Review**
- Claude performs a self-adversarial review of the Behavioral Core:
  - *"I am now reviewing this behavioral spec as an adversarial critic. My job is to find logic holes and edge cases, not confirm quality."*
  - Focus areas: decision logic soundness, edge cases where rules conflict, tone consistency under stress, scenarios where this system would frustrate or confuse users, missing error behaviors
  - Present findings as a numbered list with severity (Critical / Important / Minor)
- Claude proposes fixes for each finding
- `→ HG:` Human reviews, resolves. Behavioral Core finalized.
- **Optional — second-model review:** Prompt: *"Review this AI behavioral spec. Focus on: decision logic soundness, edge cases where rules conflict, tone consistency under stress, scenarios where this system would frustrate or confuse users."*

**2d: Eval Harness (MANDATORY for AI products)**

Behavioral Core stress-tests are prose scenarios; they cannot be re-run automatically as the build progresses. For AI products, evals are what unit tests are for deterministic code. Without them, the Behavioral Core is aspiration, not enforcement.

- Claude drafts a **golden eval set** of 10-30 input → expected-behavior pairs covering:
  - Each decision-framework path in the Behavioral Core (happy path + 2-3 branches per major rule)
  - Each absolute constraint ("never X" / "always Y" — adversarial inputs that try to break the rule)
  - Each tone/communication boundary (frustrated user, ambiguous request, bad-news delivery)
  - Each failure-cascade scenario (low-confidence, conflicting rules, scope boundary)
- **Default scoring approach:** LLM-as-judge with explicit rubric per eval. Each eval defines:
  - Input (what the user/system sends in)
  - Expected behavior (the correct response, described concretely — not just "polite reply")
  - Rubric (1-5 scale on the dimensions that matter: correctness, tone, autonomy compliance, etc.)
  - Pass threshold (e.g., "all rubric dimensions ≥ 4")
  - For structured outputs (JSON, enums, function calls): use deterministic equality match in addition to rubric
- Store as `evals/behavioral-core.yaml` (or .json) — machine-readable, version-controlled, reviewable
- Use `templates/eval-set.md` as the authoring template
- **Phase gate integration:** Any phase that touches AI behavior (prompts, decision logic, routing, summarization, tone) MUST re-run the eval set as part of `[N]b: Verify`. A drop in eval pass-rate vs. the prior phase is a stop condition.
- `→ HG:` Human reviews eval set, confirms coverage matches Behavioral Core, approves. Eval set finalized.
- **Maintenance rule:** When Behavioral Core is modified during build, the eval set MUST be updated in the same commit (propagation enforcement applies to evals).

### Step 3: Architecture Contract

**3a: Draft**
- Claude drafts the Architecture Contract covering:
  - Tech stack selection (using tool evaluation template from Section 3)
  - Architectural patterns (monolith vs modules, API design, state management, data flow)
  - Provider abstractions (what gets wrapped and why)
  - Security baseline (auth strategy, encryption, data handling, compliance requirements)
  - **Threat model** — STRIDE or data-flow diagram. For each major data flow / trust boundary, list: assets at risk, plausible threats (spoofing, tampering, repudiation, info disclosure, denial of service, elevation of privilege), and the mitigation owned by this architecture. Pulls security work LEFT instead of deferring it to hardening. Inputs come from the data classification in the Product Spec (Step 1a).
  - **Observability plan** — what gets logged, what gets traced, what metrics are emitted, what alerts fire, where dashboards live. Without this, "deploy and verify" is blind in prod. Specify: log levels and PII redaction rules; trace boundaries (which spans matter); minimum metric set (latency, error rate, AI cost per request, business KPIs from Product Spec success metrics); alert thresholds + on-call destination.
  - **Rollback / kill-switch posture** — Feature-flag strategy. Which features ship behind flags? Which are kill-switchable in seconds vs. requiring a deploy? Default for AI features and risky migrations: behind a flag. This shapes the per-phase rollback plan in the Build Manifest (Step 5a).
  - Cost model (estimated cost per user at 100 / 1K / 10K scale)
  - **Cost-budget guardrail** — Per-request $ ceiling (especially for AI calls) that triggers a regression check at the phase gate. Example: "AI cost per active user per day must stay under $0.05. Phase gate fails if measured cost exceeds 2× the budget."
  - **Accessibility posture (v2.4)** — Target level (WCAG 2.1 AA is the typical default for B2B/consumer products; AAA for regulated/public-sector). Which surfaces are in scope. Testing approach (axe, screen reader spot-checks, keyboard-only smoke test). Even a "we punt on this for v1" decision should be recorded explicitly, not implicit.
  - **Internationalization posture (v2.4)** — Single-locale only (state which) vs. multi-locale (list locales, copy-management approach, currency/date handling, RTL support). Punting is fine if recorded; assumed punt is not.
  - **Compliance scope (v2.4)** — Pick from: None / GDPR / CCPA / HIPAA / SOC2 / PCI / industry-specific. Drives the depth of security audit at hardening, data-handling rules in domain specs, and data-subject-request endpoints. Default for indie/consumer products: GDPR + CCPA baseline (cookie banner, data export, account deletion). For B2B: add SOC2 readiness if enterprise customers will demand it.
  - Constraints (what this architecture does NOT support — explicit boundaries)
  - Red flags ("Stop immediately if you see X" — extracted from past project lessons)
- `→ HG:` Human reviews

**3b: Adversarial Review**
- Claude performs a self-adversarial review of the Architecture Contract:
  - *"I am now reviewing this architecture as an adversarial critic. My job is to find over-engineering, missing concerns, and scaling risks."*
  - Focus areas: over-engineering risks, missing concerns, tech stack fit, scaling bottlenecks, whether complexity matches the product's actual needs, cost trajectory, lock-in risk
  - Present findings as a numbered list with severity (Critical / Important / Minor)
- Claude proposes fixes for each finding
- `→ HG:` Human reviews. Architecture Contract finalized. Changes after this point require a decision-log entry.
- **Optional — second-model review:** Prompt: *"Review this technical architecture for [product]. Focus on: over-engineering risks, missing concerns, tech stack fit, scaling bottlenecks, and whether the complexity matches the product's actual needs."*

### Step 4: Domain Specs

**4a: Identify Subsystems**
- From the Product Spec, identify the major subsystems (typically 3-8)
- For each, define scope: what it does, what it doesn't do, what it connects to
- `→ HG:` Human reviews subsystem list and boundaries

**4b: Write Domain Specs**
- Claude writes each domain spec covering:
  - Purpose (what this subsystem does, scoped from Product Spec)
  - Data model (tables/models, relationships, constraints, indexes)
  - API surface (endpoints or functions, inputs, outputs, error cases)
  - State machine (if applicable: states, transitions, triggers, guards)
  - Integration points (how it connects to other subsystems — explicit contracts)
  - Edge cases and error handling (what can go wrong, how it's handled)
- **Assumption tagging:** Anywhere Claude makes a decision without explicit human input, tag it inline: `[ASSUMPTION: We assume X because Y]`. Rank assumptions as HIGH/MEDIUM/LOW impact. HIGH-impact assumptions MUST be reviewed before build starts.
- **Data flow diagram:** After writing all domain specs, produce a cross-subsystem data flow map showing which subsystems produce artifacts and which consume them. This catches orphaned outputs (nobody reads them) and missing inputs (nobody produces them).
- **Machine-readable contracts (MANDATORY for code products):**
  - For every subsystem boundary, produce an executable contract artifact in `contracts/` — TypeScript types, Zod schemas, OpenAPI spec, JSON Schema, Protobuf, or equivalent. Match the tech stack chosen in the Architecture Contract.
  - The prose in the domain spec **explains** the contract; the file in `contracts/` **is** the contract. When they disagree, the file wins and the prose gets updated.
  - This turns the Global Spec Lock rule (Section 1) from a prose-comparison check into a deterministic compiler/validator check. Phase gates can now fail on a type error instead of relying on Claude noticing a mismatch.
  - Naming convention: `contracts/<subsystem>.<ext>` (e.g., `contracts/messaging.ts`, `contracts/billing.schema.json`). Cross-subsystem shared types live in `contracts/shared.<ext>`.
  - For non-code products (strategy docs, analyses): skip this — no contracts needed.
- After writing all specs, Claude cross-references them:
  - Does Subsystem A's output match Subsystem B's expected input? (And does the machine-readable contract enforce that match?)
  - Do all specs align with the Product Spec and Architecture Contract?
  - Are there gaps — capabilities in the Product Spec that no domain spec covers?
  - Are there orphaned outputs or missing inputs in the data flow diagram?
- Flag any tensions or ambiguities found during cross-reference
- `→ HG:` Human reviews each spec, iterates, approves. **Review technique:** Open each spec in your editor, add inline annotations (corrections, questions, "remove this"), then tell Claude: "I added notes to [file]. Address all of them and update accordingly. Don't implement yet." Repeat until satisfied.

**4c: Adversarial Review**
- Claude performs a self-adversarial review of the Domain Specs as a set:
  - *"I am now reviewing these domain specs as an adversarial critic. My job is to find seam mismatches, hidden coupling, and contract gaps — not confirm quality."*
  - Focus areas:
    - **Contract gaps:** subsystem boundaries where the prose says one thing but the machine-readable contract says another (or where the contract is missing required fields)
    - **Hidden coupling:** subsystems that look independent but actually depend on each other's internal state, timing, or implicit ordering
    - **Null/empty/error propagation:** what does each consuming subsystem do when an upstream returns null, empty, or an error? Are those cases defined?
    - **Versioning & evolution:** if Subsystem A's schema changes later, what breaks? Is there a migration story or is it a tight coupling?
    - **Orphans & dead ends:** outputs that nobody reads; inputs that nobody produces
    - **Cross-spec consistency:** the same concept named or typed differently across two specs (e.g., `userId: string` here, `user_id: number` there)
  - Present findings as a numbered list with severity (Critical / Important / Minor)
- Claude proposes fixes for each finding
- `→ HG:` Human reviews, resolves. Domain Specs and `contracts/` artifacts finalized. Changes after this point require a decision-log entry and propagation enforcement (Section 6).
- **Optional — second-model review:** Prompt: *"Review this set of domain specs and their machine-readable contracts. Focus on: seam mismatches, hidden coupling, null/error propagation gaps, and versioning risks. Be adversarial — find the holes."*

### Step 5: Build Manifest

**5a: Define Phases**
- Break the build into sequential phases (typically 5-12)
- Each phase entry:
  - **Name:** Short descriptive name
  - **Scope:** What gets built (list specific subsystems, features, or capabilities)
  - **Prerequisites:** Which phases must be complete first
  - **Deliverables:** What exists when this phase is done (specific files, endpoints, features)
  - **Definition of Done:** What the human can DO at this milestone — not just what code exists, but what capability is usable. (e.g., "You can text a task via SMS and see it appear in the portal" — not just "SMS pipeline implemented")
  - **Quality target:** Expected accuracy/completeness at this phase. (e.g., "P0 = directional, ~30% error bars. P1 enrichment makes it decision-grade." This sets realistic expectations and prevents premature trust in incomplete systems.)
  - **Validation criteria:** How we know it works (specific checks, not vague "test it")
  - **Manual steps:** Human work required during or after this phase (with time estimates). (e.g., "Set up Stripe account (~30 min), configure webhook endpoints (~15 min)")
  - **Acceptance gate:** Two explicit boundaries that Claude verifies before declaring the phase complete:
    1. **Exit criteria** — what must be TRUE (the minimum bar for "this phase is done")
    2. **Scope boundary** — what must NOT be built yet (prevents scope creep into future phases)
    Claude MUST verify BOTH before declaring a phase complete. If either is violated, the phase is NOT complete.
  - **Experience test:** What should this FEEL like to the user? Describe the experience, not just the functionality. (e.g., "Text 'remind me to call the dentist next Tuesday' → should feel like telling a competent assistant, not filling out a form. Confirmation should be warm and specific, not robotic.") The human evaluates this at the phase gate — "does it feel right?" is a valid go/no-go criterion.
  - **Regression scenarios:** Named test scenarios from prior phases to re-run. Not "re-test prior flows" — specific scenarios with expected outcomes. (e.g., "Re-run: SMS task creation from Phase 1 — send 'buy groceries tomorrow' → confirm task created with correct date. Re-run: correction flow — send 'actually make that Thursday' within 60s → confirm original task updated.")
  - **Phase-specific audit section (if critical subsystem):** If this phase introduces a scheduler, auth system, payment processor, AI pipeline, or other critical subsystem — define a custom set of yes/no verification questions that MUST be answered in the phase report. (e.g., Scheduler: "Can I restart and pending jobs survive? Can two workers run without double-processing? Do failed jobs retry with backoff? Do 3x-failed jobs move to dead letter?") Failure to include this section for a critical subsystem is a failure condition.
  - **Complexity:** S / M / L (guides expectations, not commitments)
  - **Deploy verification required?** Yes / No. Yes if this phase touches external integrations, webhooks, auth flows, or deployment configuration. If yes, define what to verify post-deploy.
  - **Rollback plan:** How this phase gets turned off if it breaks in prod. Specify ONE of: (a) feature flag name + how to disable, (b) env var to flip, (c) revert path (which commit/release to roll back to), or (d) "irreversible — extra care at deploy" with rationale. Anchored to the rollback/kill-switch posture in the Architecture Contract (Step 3a). Mandatory for any phase marked "Deploy verification required: Yes."
- `→ HG:` Human reviews phase plan, adjusts scope/order

**5a-ii: Capability Traceability Matrix (MANDATORY)**

After defining phases, create a matrix mapping EVERY capability from the Product Spec to a build phase:

```
| # | Capability | Phase | Status | Notes |
|---|-----------|-------|--------|-------|
| 1 | [capability name] | Phase N | E/S/F/— | |
```

Status codes:
- **E** = Explicitly built in this phase (full implementation)
- **S** = Stubbed (interface exists, implementation deferred)
- **F** = Future (not built, assigned to a later phase)
- **—** = Not applicable to this phase

**Rules:**
- Every capability in the Product Spec MUST have a row. No implicit capabilities.
- Every row MUST have a phase assignment. Unassigned capabilities are a gap.
- Review this matrix at every `[N]c: Reconcile` — mark capabilities as they're completed.
- At hardening, every E-status row must be verifiable in the code.

This matrix is the "nothing falls through the cracks" guarantee. Without it, you discover at hardening that Phase 3 was supposed to build feature X but nobody assigned it.

`→ HG:` Human reviews matrix for completeness

**5b: Initialize Manifest**
- Create `docs/build-manifest.md` with:
  - **Progress tracker (v2.3)** — visual where-are-we for the user. Updated after every completed step or phase. Format:
    ```
    Spec phase:  ▓▓▓▓▓▓▓ 7/7 ✅ complete
    Build phase: ▓▓░░░░░ 2/7 (currently in Phase 3: messaging)
    Hardening:   ░░░░░░░ 0/5
    ```
    Claude reads this at session start and recites it as part of the Pulse Report (§11.1 rule 9). Claude updates it before declaring any step or phase complete.
  - Phase list with status column (pending / in-progress / complete)
  - Capability traceability matrix (from 5a-ii)
  - Current phase pointer (updated after each phase)
  - **Hot paths** (1-3 project-wide critical paths that are tested at every phase gate, e.g., "SMS inbound → AI interpretation → task creation → confirmation outbound"). Hot path failure at any phase is a stop condition.
  - **Success-metric instrumentation map (v2.4)** — For each success metric and leading indicator defined in the Product Spec (Step 1a), specify: (a) the analytics event name that proxies it, (b) the build phase that wires it up, (c) the dashboard/query that surfaces it post-launch. Without this map, success metrics are aspiration. Example: north-star "weekly active task creators" → event `task_created` (Phase 3) → PostHog cohort `WAU-creators`. If no analytics tool is chosen yet, this row triggers that decision in `tool-decisions.md`.
  - **Deviation tracker** (running count of spec deviations found per phase — used to monitor build quality trend. Format: `| Phase | Deviations Found | Deviations Fixed | Trend |`)
  - Decisions section (links to decision-log.md entries made during build)
  - Deferred items list (things explicitly skipped with rationale)
  - Deviations section (where build diverged from original specs, with explanation)
- **Auto-advance (v2.5):** the Build Manifest is auto-generated from the prior approvals in Step 5a/5a-ii. Claude reports it as a status update ("Build Manifest written to `docs/build-manifest.md`. Includes [N] phases, [M] capabilities mapped, progress tracker initialized.") and proceeds to Step 6 without a separate Human Gate. The human can still object — but the default is to flow through.

### Step 6: Project Setup

**6a: CLAUDE.md**
- Claude generates project-level CLAUDE.md containing:
  - **Bob the Builder protocol reference (v2.6 — MANDATORY)** — first section of the file, stated as a single line: *"This project uses the Bob the Builder protocol at `~/tools/bob-the-builder/build-protocol.md` (full reference) and `~/tools/bob-the-builder/build-protocol-core.md` (compact session reference). Read the core reference at session start; consult the full reference for templates, appendices, and architecture patterns. Resume from `docs/build-manifest.md`."* This single line is what makes Bob **invoke-once-then-auto-resume**: once it's in the project CLAUDE.md, every future Claude Code session in this folder automatically loads Bob without the human re-typing the long invocation. If this line is missing, the protocol's session-resume guarantees break.
  - What this project is (2-3 sentences)
  - Current phase (pointer to Build Manifest)
  - Architecture rules (compact extraction from Architecture Contract — the rules Claude needs in every session)
  - Red flags (stop conditions)
  - Build/deploy/test commands
  - Compaction instructions ("When compacting, always preserve: current build phase, modified files list, pending decisions, and test commands")
  - Pointer to `docs/` for full specs — use **progressive disclosure**, not inline content. Example: "Read docs/product-spec.md for full product context. Read docs/domains/messaging.md before working on SMS features."
- **CLAUDE.md should be <150 lines.** It's a session reference, not a spec. The elimination test for every line: "Would Claude make a mistake without this?" If not, cut it. Don't add anything Claude can figure out by reading code, anything a linter enforces, or anything that's standard practice for the language/framework.
- `→ HG:` Human reviews

**6b: Hooks Setup (DEFAULT ON — opt out explicitly)**

CLAUDE.md rules are advisory (~80% followed). Hooks are deterministic (100% enforced). For a non-engineer user shipping with Claude Code, the difference between 80% and 100% on quality gates is the difference between catching regressions in dev and finding them in prod.

**Default hook set — install unless human opts out:**

1. **PostToolUse (Edit/Write) → auto-format.** Prettier / Black / gofmt / etc. matched to the stack. Prevents whitespace and style noise from cluttering diffs.
2. **Stop (on turn complete) → type-check + build.** Catches type errors and build breaks before the human reviews. The single highest-leverage hook for non-engineer users.
3. **PreToolUse (Bash) → block destructive commands.** `git push --force` to main, `rm -rf` outside the project root, `DROP TABLE`, `truncate`. Pattern-matched, project-tunable.

**Optional add-ons (recommend per project):**

- **PreToolUse (Bash) → block hook-bypass flags.** `--no-verify`, `--no-gpg-sign` — flagged unless the human explicitly approved.
- **PostToolUse (Edit on contracts/) → schema validate.** For projects using machine-readable contracts (Step 4b), validate the contract file on every edit.
- **Stop → run AI eval set.** For AI products, re-run `evals/behavioral-core.yaml` if the phase touched AI behavior. Slower; recommend only if the eval set is fast (<30s).

**Setup mechanics:**
- Hooks live in `.claude/hooks/` (project-local) or `settings.local.json`
- Claude installs the default set during Step 6b and reports each hook with: what it does, when it fires, how to disable
- Human reviews the installed set, opts out of any that don't fit, and `→ HG:` approves the final set

**Opt-out reasons that are legitimate:**
- No build step exists (early prototype, pure prose project, exploratory notebook)
- Build is slow enough that running it on every Stop creates more friction than value (>60s) — in that case, move it to a CI step instead
- Project uses a tool the hook can't drive (rare; surface it and propose an alternative)

**Reasons that are NOT legitimate (push back if you hear them):**
- "It's annoying" — that's the point; the friction catches regressions
- "I'll remember to run the check manually" — see the 80% vs 100% number above
- "I want to commit broken code temporarily" — use a WIP branch, not a disabled hook

**6c: Repository Init**

**v2.6 — preferred path: use the scaffold script.** Claude runs:
```bash
bash ~/tools/bob-the-builder/scripts/bob-init.sh <project-name>
```
This generates the full folder structure (`docs/`, `contracts/`, `evals/`, `scripts/`, `tests/`, `src/`, `.claude/`), writes a project CLAUDE.md that references Bob (so future sessions auto-resume — see §6a), writes `.claude/settings.json` with default hooks, writes `.gitignore` and `.env.example`, and runs `git init` with an initial commit. Safe to re-run — skips anything that already exists.

After the script runs, Claude:
- Customizes the hook commands in `.claude/settings.json` for the chosen stack (replace the placeholder `echo` commands with real format/typecheck commands per Step 6b)
- Sets up hosting/deployment (if applicable — e.g., `vercel link`)
- Pushes to GitHub
- Initializes project memory directory (if not already created)

**Fallback path (manual): if the scaffold script is unavailable or the project has unusual structure needs**, Claude performs the steps manually:
- Create folder structure (per Section 2)
- git init + initial commit with docs/ and CLAUDE.md (CLAUDE.md MUST include the Bob protocol reference per §6a)
- .gitignore (appropriate for stack)
- .env.example (all required env vars documented, no secrets)
- package.json / pyproject.toml / etc. (if code product)
- Push to GitHub
- Set up hosting/deployment (if applicable)
- Initialize project memory directory

**Auto-advance (v2.5):** repo init is mechanical and reversible. Claude reports as a status update ("Repo initialized at `<path>`, pushed to `<url>`, `.env.example` written with [N] variables documented.") and proceeds to Step 7 without a separate Human Gate. If the human needs to add custom files or change folder structure, they say so at this point; the default is to flow through.

### Steps 7+: Build Phases

*Repeat this cycle for each phase defined in the Build Manifest. Each phase follows the execution model: Context Load → Gap Check → Implement → Validate → Reconcile → Pulse Check.*

**[N]a: Build**

*Context Load:*
- Read Build Manifest → identify current phase, scope, and validation criteria
- Re-read all domain spec(s) relevant to this phase
- For AI products: always re-read Behavioral Core if the phase involves user-facing behavior, tone, messaging, recommendations, summaries, decision-making, memory, or routing

*Gap Check (MANDATORY — before writing ANY code):*
- Is the required behavior already defined in the Behavioral Core? (AI products)
- Are the required mechanics already defined in the relevant domain specs?
- Are there any conflicts between docs?
- Is a spec patch needed before implementation can proceed?
- If behavior or mechanics are MISSING from specs → propose the patch FIRST, get approval, THEN implement
- If docs conflict → STOP. Explain the conflict. Do NOT proceed.

*Plan:*
- Propose implementation plan covering:
  - What files will be created or modified
  - What the key implementation decisions are
  - Any concerns or ambiguities from the domain spec
  - What is explicitly OUT of scope (scope lock)
- `→ HG:` Human reviews plan, modifies or approves

*Implement:*
- Execute the approved plan
- Commit working code after each logical unit
- If you discover a spec gap mid-implementation → STOP, propose patch, get approval, then continue

*Critical Architecture Decisions (if phase introduces a major subsystem):*

If a phase introduces a critical subsystem (scheduler, queue, auth, payment processing, AI pipeline, etc.), Claude MUST explicitly state the architecture decision in the phase report:

```
### [Subsystem] Architecture Decision
- Implementation approach: [specific — e.g., DB-backed job table with row-level locking]
- Retry mechanism: [e.g., exponential backoff, max 3 retries, dead-letter after max]
- Key design choices: [e.g., why this approach over alternatives]
```

Claude MUST also define verification questions — concrete yes/no checks that prove the subsystem works. Example: "Can I restart the server and pending jobs still exist?" Failure to include this section for a critical subsystem is a failure condition for that phase.

**[N]b: Verify**

*Phase-specific validation (from Build Manifest validation criteria):*
- Does the code match the domain spec?
- Does it build? Do types check?
- Do the specific validation criteria pass?
- Run applicable tests (if they exist):
  - **Unit tests:** All must pass.
  - **Integration tests:** All must pass. At minimum, one must exercise the project's hot path(s).
  - **Deployment tests:** If phase is marked "Deploy verification required: Yes" in the Build Manifest, deploy and verify (see Deploy & Verify below).

*Class-level pattern scan (MANDATORY when any bug is found):*
- If any bug was discovered during this phase (in build or verification), grep the entire codebase for the same pattern
- Report: "Pattern: [description]. Found N instances. Fixed: N. Remaining: 0."
- Do NOT proceed with a known pattern bug in one location while identical patterns exist elsewhere
- This check also applies to bugs found in prior phases that were only partially fixed

*Regression check (verify prior phases still work):*
- Re-test critical flows from all completed phases
- Confirm no regressions from the current phase's changes
- If any prior-phase flow is broken → fix before advancing

*Global invariants check (if project has defined invariants — see Appendix E):*
- Verify all project-specific invariants still hold
- Include checklist in phase report

*Cross-cutting concern scan (MANDATORY — every phase, not just hardening):*

This catches the class of issues that individual phase verification misses: edge cases at subsystem boundaries, missing rate limits, abuse vectors, cross-subsystem linking gaps. These "holes" don't show up when you check "does Phase 3 work?" — they emerge from interactions between subsystems.

At every phase, Claude MUST scan for:

1. **Integration seams** — Where this phase connects to prior phases, do the contracts actually match? (e.g., Phase 3 outputs a task object → does Phase 1's reminder engine handle it correctly? Are field types compatible? Are nulls handled?)
2. **Rate limits & caps** — Does every new endpoint, webhook, or user-facing action have appropriate rate limiting? Are there caps on how many objects a user can create? Can a user trigger unbounded work? (If not defined in specs → flag as gap, propose reasonable defaults.)
3. **Abuse vectors** — How would a malicious or careless user exploit what was just built? (e.g., Can someone spam the SMS endpoint? Can they create 10,000 tasks? Can they access another user's data by guessing IDs? Can they trigger expensive AI calls with no throttle?)
4. **Error propagation across boundaries** — If Subsystem A fails, does Subsystem B handle it gracefully? Or does it crash, hang, or produce corrupt data? Trace the failure path across at least one subsystem boundary.
5. **Missing auth/permission checks** — Every new endpoint or action: does it verify the user is who they claim to be AND has permission to do this specific thing? Check both authentication (who are you?) and authorization (can you do this?).

This scan is cumulative — each phase checks its own NEW integration seams plus spot-checks one prior seam. By Phase 8, you've scanned every major boundary at least once during build, not for the first time at hardening.

*If issues found → fix before advancing (don't log them for later)*

*Deploy & verify (MANDATORY if phase touches external integrations, webhooks, auth, or deployment config):*
- Deploy the current build to staging or preview environment
- Execute at least one real request through each new external integration point
- Confirm webhook delivery/receipt works with real provider signatures
- Confirm auth flows work end-to-end (not just in test mocks)
- If the Build Manifest marks this phase as "Deploy verification required: Yes" — this substep is a pass/fail gate
- If deployment verification fails: debug using the Debugging Protocol (Section 10), not ad-hoc logging

*Hot path check (MANDATORY — every phase):*
- Run the project-wide hot path(s) defined in the Build Manifest
- Hot path failure is a stop condition — do NOT advance
- Even if the current phase didn't touch hot path code, verify it still works (regressions can be indirect)

*Acceptance gate verification:*
- Verify exit criteria are met (everything that must be true IS true)
- Verify scope boundary is respected (nothing was built that shouldn't have been)
- If either is violated → the phase is NOT complete

Present verification results using the Phase Report Template (Appendix F). Every section is mandatory — omission of any section (Module Inventory, Global Invariant Check, Propagation, Cross-Cutting Concerns) is a failure condition.

*Second-model review (optional — recommended for Heavy-track projects or critical phases):*

The human may optionally paste the Phase Report to a second AI model (e.g., ChatGPT) for independent review. Prompt template:

> "Claude Code just completed Phase [N] of [product] ([brief description]). Here is the Phase Report and self-audit. Please audit: 1) Does the implementation match the specs referenced? 2) Are there security, rate-limiting, or abuse concerns Claude missed? 3) Do the cross-cutting concern findings seem thorough? 4) Does the experience test output feel right or generic? Be adversarial."

If the second model flags issues Claude missed → bring findings back to Claude for resolution before advancing. This step is most valuable for phases introducing critical subsystems (auth, payments, AI pipelines) and for Heavy-track projects.

- `→ HG:` Human reviews, approves or requests fixes

**[N]c: Reconcile**

*Spec divergence check:*
- What worked as spec'd?
- What was harder or different than expected?
- What turned out unnecessary?
- What assumptions were made? (if none, say "None")

*Propagation enforcement (MANDATORY if any spec was modified):*
1. Identify ALL future build phases that depend on the modified spec
2. Explicitly state whether those phases are impacted
3. For each impacted phase: note what needs to change when that phase is reached
4. Update Build Manifest with propagation notes
5. **If a spec was modified and this section says "None" — that is a failure condition**

*Pulse check:*
1. Did this phase require any spec changes? (list files changed)
2. Do future build phases need updating because of those changes?
3. Which future phases may be affected?
4. What should be propagated now so later phases don't drift?
5. Were all impacted future phases flagged in the Build Manifest?

*Update Build Manifest:* mark phase complete, log decisions, note deferred items, record propagation flags

*Update deviation tracker:*
- Record: number of spec deviations found in this phase
- Compare to prior phases: is the trend improving, stable, or worsening?
- If deviations are NOT declining over 3 consecutive phases → trigger process review before starting next phase (see Section 8)

- `→ HG:` Human approves spec updates, advances to next phase

### Step [N+1]: Hardening

*After all build phases are complete. Run these as scoped audits, not generic "audit everything."*

**Important: Use fresh sessions for each audit.** Start a new Claude Code session for each hardening audit (a/b/c). A fresh session reviews from clean context without implementation bias — like a code reviewer who didn't write the code. This is the **writer/reviewer pattern**: the builder sessions wrote the code; the hardening sessions review it independently. Do NOT run hardening in the same session that built the last phase.

**[N+1]a: Security Audit**
- Scoped to actual attack surface:
  - Auth: Can unauthenticated users access protected resources? (List every endpoint, confirm auth check exists.)
  - Input validation: Are all user inputs sanitized? (Grep for raw user input reaching DB queries or AI prompts.)
  - Injection: SQL, XSS, command injection vectors?
  - Secrets: Are API keys, tokens, and credentials properly handled? (Grep for secrets in logs, client-side code, error messages.)
  - Permissions: Can users access other users' data? (Test with two user accounts — can user A see user B's resources by guessing IDs?)
  - Rate limits: Does every public endpoint have rate limiting? What are the limits? Are they appropriate?
  - Webhook security: Are all inbound webhooks verified (signature validation)? Can someone forge a webhook?
- `→ HG:` Present findings, fix critical items

**[N+1]b: Adversarial & Abuse Audit**

*This audit catches what per-phase verification structurally misses: compound abuse scenarios that span multiple subsystems.*

For each user-facing capability, answer:
- **Volume abuse:** What happens if a user does this 10,000 times? Is there a cap? What enforces it?
- **Privilege escalation:** Can a free-tier user access paid features by manipulating requests? Can a group member escalate to admin?
- **Data exfiltration:** Can a user extract more data than intended? (API responses returning extra fields, error messages leaking internals, AI prompts revealing system context.)
- **Resource exhaustion:** Can a user trigger expensive operations (AI calls, external API calls, large queries) with no throttle?
- **Input manipulation:** What happens with: empty strings, extremely long strings (10K chars), special characters, unicode edge cases, SQL/HTML in user input, null bytes?
- **Timing attacks:** Can a user exploit race conditions? (e.g., double-submit a payment, claim the same resource twice, bypass a lock window.)

For AI products additionally:
- **Prompt injection:** Can user input manipulate AI behavior? (e.g., "ignore your instructions and..." in a task description.)
- **AI output abuse:** Can the system be tricked into generating harmful, biased, or inappropriate content?
- **Confidence manipulation:** Can a user game the confidence scoring to force auto-execution of actions that should require confirmation?

Present as a table: `| Capability | Abuse Vector | Severity | Mitigation | Status |`
- `→ HG:` Present findings, fix critical and high items. Medium items may be deferred with rationale.

**[N+1]c: Integration Seam Audit**

*This is the deep version of the per-phase cross-cutting scan. Walk every boundary between subsystems and verify they actually connect correctly.*

For each subsystem boundary:
1. **Contract match:** Does A's output type/shape exactly match B's expected input? (Not "close enough" — exact field names, types, nullability.)
2. **Error handling at boundary:** If A fails, what does B receive? Does B handle it gracefully, or does it crash/hang/produce corrupt data?
3. **Auth propagation:** If A authenticates the user, does B re-verify or trust A? Is that trust warranted?
4. **Rate limit propagation:** If A is rate-limited, can B be reached by bypassing A? Does B have its own limits?
5. **Data consistency:** If A writes and B reads, is there a timing window where B sees stale data? Is that acceptable?
6. **Caps and limits:** Are there reasonable maximums on lists, counts, sizes at every boundary? (e.g., max tasks per user, max objects per task, max characters per field, max API results per page.)

Present as: `| Seam (A → B) | Contract Match | Error Handling | Auth | Rate Limit | Caps | Issues |`
- `→ HG:` Present findings, fix critical items

**[N+1]d: Data Integrity Audit**
- Scoped to actual data flows:
  - State machines: Can objects reach invalid states? (Walk every state machine — list all valid transitions, then check: can code trigger an invalid one?)
  - Error handling: Do failures leave data in consistent state? (Simulate: AI call fails mid-operation — what state is the object in?)
  - Edge cases: Empty inputs, concurrent operations, boundary values?
  - Data flow: Does data survive the full input → process → store → retrieve → display path?
  - Orphaned data: Are there objects that can be created but never cleaned up? (e.g., scheduled jobs for deleted tasks, group memberships for deactivated users.)
- `→ HG:` Present findings, fix critical items

**[N+1]e: Spec-Code Consistency**
- Walk each domain spec section-by-section and verify the code implements it
- Walk the Behavioral Core (if exists) and verify AI behavior matches
- Walk the Capability Traceability Matrix — every E-status capability must be verifiable in code
- Flag any divergences (missed features, extra features, different behavior)
- `→ HG:` Present findings, decide which to fix vs accept

**[N+1]f: Fix & Final Reconcile**
- Fix all approved items from the five audits
- Final spec update: all docs now reflect what was actually built
- Capability Traceability Matrix updated — all statuses final
- Build Manifest updated to reflect hardening complete
- `→ HG:` Hardening gate passed

### Step [N+2]: Learning Extraction

**[N+2]a: Process Review**
- What process steps were most valuable?
- What steps were skipped or felt wasteful?
- What was discovered too late? (What should have been caught earlier, and at which step?)
- What would you do differently on the next project?

**[N+2]b: Update Artifacts**
- Save key learnings to project memory
- Propose updates to this Build Protocol if warranted
- Update tool-decisions.md with any post-launch tool insights

---

## PART III: MODE — AUDIT

*Assessing an existing, partially-built product and aligning it to this process.*

### When to Use
- You have a half-built product and want to understand its state
- You want to find gaps, inconsistencies, or risks
- You want to create missing process artifacts (specs, manifests) from existing code

### Step A1: Inventory

Claude reads (in parallel where possible):
- Complete file and directory structure
- CLAUDE.md (if exists)
- All docs/, specs/, README, or process files
- Git log (recent 50 commits — understand development arc)
- Memory files (if exist)
- Package/dependency files
- .env.example or .env (for understanding integrations)

Output: Structured inventory of what exists

### Step A2: Map to Hierarchy

Assess each document in the hierarchy:

| Document | Exists? | Quality (1-5) | Gaps |
|----------|---------|---------------|------|
| Product Spec | Y / N / Partial | | |
| Behavioral Core | Y / N / Partial / N/A | | |
| Architecture Contract | Y / N / Partial | | |
| Domain Specs | Y / N / Partial | | |
| Build Manifest | Y / N / Partial | | |
| Decision Log | Y / N | | |
| Tool Decisions | Y / N | | |
| CLAUDE.md | Y / N / Partial | | |

For partial docs: note what's covered and what's missing.
For missing docs: note whether the information exists scattered elsewhere (in code, comments, git history, memory).

`→ HG:` Present assessment

### Step A3: Code-Spec Consistency

- If specs exist: walk them against the code and flag divergences
- If specs don't exist: infer what the specs WOULD say from the code and present as a draft
- Identify:
  - Dead code (implemented but not in any spec or user path)
  - Missing features (in spec but not implemented)
  - Inconsistencies (spec says X, code does Y)
  - Over-built areas (code that's more complex than the product needs)
  - Under-built areas (simplistic implementation of something the spec defines as complex)

`→ HG:` Present findings

### Step A4: Risk Assessment

Evaluate across dimensions:
- **Security gaps:** Auth, input validation, secrets handling, permissions
- **Technical debt:** Code duplication, dead code, inconsistent patterns, massive files
- **Spec-code divergence severity:** How far apart are the docs and the code?
- **Test coverage:** What's tested, what's not, what's most risky to change
- **Provider lock-in:** Direct integrations without abstraction layers
- **Scalability concerns:** Obvious bottlenecks at 10x current scale

`→ HG:` Present risk report with severity ratings

### Step A5: Remediation Plan

Based on findings, propose:
1. **Missing docs to create** (prioritized: which docs give the most leverage?)
2. **Inconsistencies to resolve** (with severity and effort estimate)
3. **Code issues to fix** (critical vs nice-to-have)
4. **Process gaps to close** (what's missing from the workflow?)

Organize as a phased plan — don't propose fixing everything at once.

`→ HG:` Human prioritizes, approves remediation scope

### Step A6: Execute Remediation

Follow the approved plan. For each remediation item, use the Na/Nb/Nc pattern:
- **a:** Execute the fix or create the missing artifact
- **b:** Verify it's correct and consistent
- **c:** Reconcile with other docs that might be affected

### Step A7: Re-entry

After remediation is complete, the project is aligned to the Build Protocol. Claude presents the next-step options:

- **If the product has unbuilt capabilities** (identified in A3 as "in spec but not implemented"): "Your project is now aligned. There are [N] unbuilt capabilities. To continue building, I recommend creating a Build Manifest (Step 5) for the remaining work and resuming in NEW mode at Step 7 (Build Phases)."
- **If the product is feature-complete but needs hardening**: "Remediation is done. The codebase would benefit from a hardening pass. Want to run the hardening audits (Security → Adversarial/Abuse → Integration Seam → Data Integrity → Spec-Code Consistency)?"
- **If the product is stable and the user wants to add features**: "Your project is aligned. For new features or changes, use MODE: EVOLVE — start at E1."

`→ HG:` Human chooses next action.

---

## PART IV: MODE — EVOLVE

*Adding features, changing behavior, fixing design-level bugs, or refactoring an existing product.*

### When to Use
- Adding a feature to a product that already follows this process
- Changing existing behavior (not just a bug fix — a design change)
- Refactoring that touches multiple subsystems
- Any change where you'd normally just type "what if we did X" into Claude Code

### Step E1: Classify the Change

| Size | Criteria | Process Steps |
|------|----------|---------------|
| **Small** | 1-3 files, no new concepts, no spec impact | E2 → E3 → E4 |
| **Medium** | 3-10 files, new behavior within existing subsystem, spec update needed | E2 → E3 → E4 → E5 |
| **Large** | New subsystem, architectural change, cross-cutting concern, or Behavioral Core change | E2 → E3 → E4 → E5 → E6 |

If unsure, classify one size up. Under-processing a Large change as Medium is how inconsistencies accumulate.

**Multiple concurrent changes:**

If the user requests 3+ changes simultaneously:
1. **Assess independence:** Are the changes independent (touch different subsystems, no shared data model changes) or interdependent (one change affects another)?
2. **Independent changes:** Run each as a separate sequential E1-E5/E6 flow. Complete one fully before starting the next. Order by: dependencies first, then highest-risk first.
3. **Interdependent changes:** Batch into a single evolution with combined scope. Classify the batch (the batch size is usually one tier above the largest individual change).
4. **If the batch would be Large AND touches 5+ subsystems:** This is no longer an evolution — it's a mini build. Create a Build Manifest with phases (like NEW mode Step 5) and execute as build phases with full [N]a/[N]b/[N]c cycles.

### Step E2: Spec Check

Before building anything:
- Read the relevant domain spec(s) for the area you're changing
- Read the Product Spec section that governs this capability
- Read the Behavioral Core (if this changes AI behavior)
- Read recent entries in decision-log.md (has a related decision already been made?)
- Determine: Does this change require spec updates? Which ones?

`→ HG (Medium/Large):` Present which specs are affected and what changes are anticipated

### Step E3: Plan

- List what files will change and why
- Identify downstream impacts (what else might break or need updating?)
- For Large changes: identify if new domain specs are needed
- For Behavioral Core changes: explicitly map the decision logic change

`→ HG:` Human reviews plan, approves

### Step E4: Execute

- Build the change
- Type-check / build / run tests
- Commit working code

### Step E5: Reconcile (Medium + Large)

- Update affected domain spec(s) to reflect the change
- Update Build Manifest (add an evolution entry with date, description, affected subsystems)
- Log decision in decision-log.md if a non-obvious choice was made
- If this change affects the Behavioral Core: update it and flag for extra review

`→ HG:` Human reviews spec updates

### Step E6: Impact Audit (Large only)

- Check: did this change break assumptions in OTHER subsystems?
- Review adjacent domain specs for stale references
- Run targeted validation on affected areas
- If Behavioral Core changed: test adversarial scenarios against the new logic

`→ HG:` Present findings, fix issues

### Evolution Hardening Threshold

NEW mode has explicit hardening after all build phases. EVOLVE mode accumulates changes that can drift without a hardening check. To prevent silent accumulation:

**Trigger a targeted hardening pass when ANY of these conditions are met:**
- **5th Medium+ evolution** since the last hardening pass (count tracked in Build Manifest)
- **Any single evolution that touches 3+ subsystems**
- **Any evolution that modifies the Behavioral Core** (AI products)
- **6 months since last hardening pass** (calendar trigger)

**Targeted hardening scope (lighter than full NEW-mode hardening):**
1. **Security audit** — scoped to areas changed since last hardening
2. **Integration seam audit** — scoped to boundaries between changed and unchanged subsystems
3. **Spec-code consistency** — full walk of changed domain specs only
4. Fix findings, update Build Manifest with hardening date and scope.

Claude tracks the evolution count in the Build Manifest. When the threshold is approaching (evolution 4 of 5), Claude proactively flags: "This is evolution 4 since the last hardening pass. One more Medium+ evolution will trigger a targeted hardening. Consider scheduling it."

---

## PART V: PROJECT INITIALIZATION CHECKLIST

*Quick reference for the first 15 minutes of any new project.*

Before starting Step 1 (Product Spec):

- [ ] Create project directory (wherever you keep your projects)
- [ ] `git init` + initial commit
- [ ] Create `docs/` directory
- [ ] Create placeholder CLAUDE.md (will be populated at Step 6)
- [ ] Push to GitHub
- [ ] Register in any multi-machine sync scripts you use (optional)
- [ ] Initialize project memory directory
- [ ] Determine project type:
  - [ ] Code product (web app, API, CLI tool)
  - [ ] Analysis tool (data pipeline, scoring model)
  - [ ] Strategy/docs (playbooks, agent specs, proposals)
  - [ ] Hybrid
- [ ] Determine if AI product → will need Behavioral Core at Step 2
- [ ] Check: is this similar to a past project? Surface relevant lessons.

---

## APPENDIX A: ANTI-PATTERNS

*Patterns observed across past projects that this process is designed to prevent.*

| Anti-Pattern | Observed In | What Goes Wrong | How This Process Prevents It |
|-------------|-------------|-----------------|------------------------------|
| Build-as-you-go | EMBT | 70% of commits are fixes; definition drift; fix-after-fix chains | Comprehensive specs upfront (Steps 1-5) |
| Spec inflation | DLL | 14 overlapping docs; inconsistencies between them; maintenance burden | Layered hierarchy; each doc has one job |
| Write-once specs | DLL | Specs never updated during build; 50+ items per audit pass | Mandatory reconciliation (Nc step) |
| Copy-paste execution | DLL | Manual, fragile, context lost between pastes | Guided execution with human gates |
| Late auditing | DLL, Tax Auction | Errors compound through 13 phases before discovery | Inline verification (Nb step) per phase |
| Code volume explosion | DLL (200K lines) | Surface area too large to audit effectively | Volume control; favor config over code |
| No tool rationale | EMBT | Can't remember why tools were chosen; can't evaluate alternatives | tool-decisions.md with evaluation template |
| Scattered behavioral logic | EMBT | Decision logic spread across 5K-line function; hard to audit or debug | Centralized Behavioral Core document |
| Decision amnesia | All | Re-litigating settled questions across sessions | decision-log.md; project memory |
| No cross-project learning | All | Same mistakes repeated in new projects | Learning extraction step; this Build Protocol |
| Late cross-cutting discovery | DLL | 5 audit passes found edge cases, missing rate limits, abuse vectors, integration seam mismatches — all functional code, but holes everywhere at subsystem boundaries | Cross-cutting concern scan at EVERY phase (not just hardening); adversarial audit + integration seam audit at hardening |
| Phase-isolated verification | DLL | Each phase verified "does this work?" but never "does this interact safely with everything else?" | Cumulative seam scanning; each phase checks its own + spot-checks one prior boundary |

---

## APPENDIX B: BEHAVIORAL CORE TEMPLATE

*Use this as a starting structure when writing a Behavioral Core (Step 2).*

```markdown
# [Product Name] — Behavioral Core

## 1. Decision Framework
- How does the system decide what action to take?
- What are the confidence levels? (High / Medium / Low)
- What happens at each level? (Act / Act+Confirm / Clarify)
- What scoring or ranking logic is used?

## 2. Autonomy Boundaries
- What can the system do WITHOUT asking the user?
- What requires user CONFIRMATION before acting?
- What does the system REFUSE to do?
- What happens when the system is unsure which category applies?

## 3. Communication Style
- Default tone (formal / conversational / terse / warm)
- Message length constraints (by channel — SMS, email, portal)
- How it handles: bad news, reminders, errors, celebrations
- Escalation pattern: what does it say when it can't help?

## 4. Absolute Constraints
- [NEVER]: Things the system must never do (list exhaustively)
- [ALWAYS]: Things the system must always do (list exhaustively)
- These override all other rules. No confidence threshold or edge case bypasses them.

## 5. Conflict Resolution
- When two rules point in different directions, which wins?
- Priority hierarchy: Safety > Absolute Constraints > User Preference > Efficiency
- When subsystems disagree (e.g., recommendation engine vs monitoring engine), resolution rules

## 6. Memory & Context
- What does the system remember about the user?
- How long does context persist? (Session / 24h / Forever)
- How does it use past interactions to inform current behavior?
- What does it forget (and why)?

## 7. Error Behavior
- System is uncertain → [behavior]
- System made a mistake → [behavior]
- External service fails → [behavior]
- User is confused or frustrated → [behavior]

## 8. Output Templates (per channel)
- Define exact message templates with field placeholders for each output type
- SMS templates: max length, truncation rules, deep link format
- Email templates: subject line pattern, body structure
- Portal notifications: format, grouping rules
- Example: Weekly summary template, confirmation template, alert template
- Rule: If a message type doesn't have a template, it doesn't get sent

## 9. Temporal Constants
- List ALL time-based thresholds as named values (not magic numbers)
- Example: correction_window=60s, session_timeout=10min, cooldown=30d
- These are defined HERE, not discovered during implementation
- See Architecture Patterns G6 for implementation guidance

## 10. State Mutation Rules
- Which actions auto-execute vs require confirmation?
- Define per action type: [action] → [auto-execute? Y/N] → [confirmation required? Y/N]
- High-risk actions (deletion, financial, medical) → ALWAYS confirm regardless of confidence
- Rule: Never confirm an action that didn't actually happen
```

---

## APPENDIX C: SESSION START PROTOCOL

*What Claude Code should do at the beginning of every session on a project that uses this protocol.*

**Step 0 — First-time vs. resuming check (v2.3):**

1. Read CLAUDE.md
2. Check: does `docs/build-manifest.md` exist?
   - **NO → this is a first-time user / fresh project.** Switch to first-time-user path below.
   - **YES → this is a returning user.** Switch to resuming path below.

**First-time-user path (no Build Manifest yet):**

1. Announce: "Narrator Mode is ON by default per §11. Say 'terse mode' anytime to switch."
2. Show the Journey Map (§11.4) so the user sees the full shape of what's coming.
3. Confirm: "Does this look like what you're trying to do?"
4. Then present the Mode Selection menu (Quick Start section).
5. Once mode is selected, enter the appropriate Part (II / III / IV) at Step 0 / A1 / E1 — using the Preamble Template (§11.2) at every step entry.

**Resuming-user path (Build Manifest exists):**

1. Read `docs/build-manifest.md` → identify current phase and status
2. Read relevant project memory
3. Check for a handoff note from a prior session (if you use one — common pattern: a synced folder like `~/sync/handoffs/<project>.md` shared across your machines). Surface any open questions FIRST.
4. State as a Pulse Report: "We're at Step [X]. Last session completed [Y]. Next up is [Z]. Progress: [bar]."
5. If resuming a build phase: re-read the relevant domain spec before proposing work
6. If the human has a different intent (e.g., they want to EVOLVE, not continue building): switch modes — and use the Preamble Template (§11.2) when entering the new mode.
7. Use **condensed narration** per §11.6 — skip the Journey Map and jargon primers, keep progress bar + preamble + checkpoint summaries.

---

## APPENDIX D: DECISION LOG TEMPLATE

*Use this format for every entry in `docs/decision-log.md`.*

```markdown
### D-XXX: [Decision Title]

- **Date:** YYYY-MM-DD
- **Decision:** What was decided
- **Context:** Why this came up (what problem or question triggered it)
- **Alternatives Considered:** What else was on the table
- **Rationale:** Why this option won
- **Impact:** What downstream docs or code this affects
- **Status:** Active / Superseded / Revisit later
```

Include any decision where you: deviated from a spec, chose a library or tool, changed the data model, changed an API route, changed AI behavior, or deferred a feature. These entries are what prevent decision amnesia across sessions.

---

## APPENDIX E: GLOBAL INVARIANTS PATTERN

*Project-specific invariants that MUST hold true at the end of EVERY build phase. Verified in the Phase Report's Global Invariant Check section — this is not optional.*

Global invariants are architectural rules that, if violated, cause cascading problems. They are checked at every `[N]b: Verify` step and reported in every Phase Report.

**How to define them:** During Step 3 (Architecture Contract) or Step 4 (Domain Specs), identify the 5-15 rules that must ALWAYS be true. Write them as a numbered checklist in the Architecture Contract. Claude MUST verify ALL of them at the end of EVERY phase.

**Enforcement:** If ANY invariant is violated → FIX immediately → DO NOT proceed to next phase. Invariant violations are never deferred.

**Example invariants (adapt to your project):**

For a multi-surface AI product:
```
- [ ] AI never writes to DB directly — all state transitions go through logic layer
- [ ] All inbound messages normalized before processing (no raw provider payloads in core logic)
- [ ] All outbound messages generated as canonical actions before delivery
- [ ] No provider-specific code outside abstraction layers
- [ ] No direct DB access from UI components
- [ ] All capability/model outputs schema-validated before use
- [ ] No cross-layer import violations
- [ ] All timestamps stored in UTC
- [ ] Idempotency enforced on all write paths
```

For a data pipeline / analysis tool:
```
- [ ] All external data validated/sanitized before entering pipeline
- [ ] No hardcoded credentials or API keys in source files
- [ ] All scoring formulas match the documented specification
- [ ] Output format matches schema (no silent field additions or removals)
- [ ] All calculations use consistent units (no implicit conversions)
```

**Enforcement:** If ANY invariant is violated at phase end → fix immediately. Do NOT proceed to next phase.

---

## APPENDIX F: PHASE REPORT TEMPLATE

*Claude MUST use this template when presenting results at every `[N]b: Verify` step. Section markers indicate when each section is required.*

*Section markers: **[A]** = Always required — omission is a failure condition. **[C]** = Conditional — required only when the stated condition applies; write "N/A — [reason]" when skipping. **[O]** = On-demand — include when relevant; omit entirely when not applicable.*

```markdown
## Phase [N] Report

### [O] Gap Check Result
- Behavioral Coverage: [Complete / Missing / Partial — cite spec modules]
- Domain Spec Coverage: [Complete / Missing / Partial — cite sections]
- Conflicts Found: [None / List each with file references]
- Spec Patches Applied Before Build: [None / List each]
*Abbreviate to "Clean — no gaps, no conflicts, no patches" if all clear.*

### [A] Built
- [list everything built — files created, endpoints added, features implemented]

### [C] Mocked / Stubbed — *include only if anything was stubbed*
- [list anything not fully implemented, with rationale]

### [A] Implementation Decisions
- [list key technical decisions made during build]
- [for each: what was decided and why]

### [A] Assumptions Made
- [list any assumptions — if none, say "None"]
- [assumptions are yellow flags — each one is a potential future divergence]

### [A] Spec Deviations
- [list EVERY difference from specs — schema, API, behavior, UI]
- [for each: what changed, why, whether to accept or revert]
- [if none, say "None"]
- **Deviation count this phase: [N]** *(tracked in Build Manifest deviation tracker)*

### [C] Behavior Changes to Existing Systems — *include only if modifying previously built systems*
- [list any changes to previously built systems]
- [for each: what changed, which spec section requires it, regression impact]

### [A] Validation Results
- Build/type-check: [PASS / FAIL]
- Unit tests: [PASS / FAIL — count]
- Integration tests: [PASS / FAIL — count]
- Phase validation criteria: [list each criterion and PASS/FAIL]

### [A] Hot Path Results
- [For each project-wide hot path defined in Build Manifest:]
  - [Hot path name]: [input → expected → actual → PASS/FAIL]
- **Hot path failure is a stop condition.** Do NOT proceed if any hot path fails.

### [A] Regression Check
- [list prior-phase flows tested and PASS/FAIL for each]

### [C] Deploy Verification — *required if phase touches external integrations, webhooks, auth, or deployment config*
- Deployed to: [staging URL / preview environment]
- Integration points tested: [list each with PASS/FAIL]
- Webhook delivery confirmed: [Yes/No/N/A]
- Auth flow end-to-end: [PASS/FAIL/N/A]
- **Rollback plan verified:** [Yes/No — confirm the flag/env-var/revert path defined in Build Manifest actually works]

### [C] AI Eval Results — *required if phase touched AI behavior (prompts, decision logic, routing, summarization, tone)*
- Eval set version: [git SHA of `evals/behavioral-core.yaml`]
- Results table:
  | Category | Total | Pass | Fail | Pass Rate | Δ vs Prior Phase |
  |----------|-------|------|------|-----------|------------------|
  | [list each category from eval set] | | | | | |
  | **Overall** | | | | | |
- Failures (list each: eval ID, what failed, severity, fix-now vs defer rationale)
- **A drop in pass-rate vs prior phase is a stop condition.** If overall or any category dropped → fix before advancing or document why the drop is acceptable.

### [C] Cost Guardrail Check — *required if Architecture Contract defines a per-request cost budget*
- Measured cost per request (or per-user-per-day, matching the budget unit): [$N.NN]
- Budget ceiling: [$N.NN]
- Within budget: [Yes / No — if No, this is a stop condition]

### [A] Acceptance Gate
- Exit criteria met: [Yes/No — cite each criterion]
- Scope boundary respected: [Yes/No — list anything that must NOT have been built]

### [A] Global Invariant Check *(use project's invariant checklist from Architecture Contract)*
- [ ] [Invariant 1] — [PASS/FAIL]
- [ ] [Invariant 2] — [PASS/FAIL]
- [ ] ...
- If ANY invariant is violated → FIX immediately. Do NOT proceed to next phase.

### [C] Provider/Abstraction Enforcement — *include only if project uses provider abstractions*
- grep for provider-specific imports outside abstraction layer: [results — must be empty]
- grep for direct external calls bypassing abstraction: [results — must be empty]
- If ANY violation is found → FIX before proceeding. Do NOT defer.

### [C] Cross-Cutting Concern Scan — *required for phases with integration points or new endpoints*
- Integration seams checked: [list each seam between this phase and prior phases — contract match? nulls handled? types compatible?]
- Rate limits & caps: [list every new endpoint/action and its rate limit. If none defined → FLAG as gap]
- Abuse vectors: [list at least 2 ways a malicious/careless user could exploit what was just built + mitigation]
- Error propagation: [trace at least 1 failure path across a subsystem boundary — what happens?]
- Auth/permission gaps: [list every new endpoint/action and confirm auth + authz checks exist]
- Prior seam spot-check: [pick 1 integration seam from a prior phase — still correct after this phase's changes?]

### [C] Class-Level Pattern Scan — *required if any bug was found during this phase*
- Pattern identified: [description]
- Codebase scan results: [N instances found, N fixed]
- Remaining instances: [0 / list any deferred with rationale]

### [C] Experience Test — *include only if phase has user-facing output*
- Expected experience: [from Build Manifest experience test field]
- Actual output: [show the real message, UI, or workflow the user would see]
- Assessment: [Does it feel right? Warm/robotic? Helpful/generic? Premium/cheap?]
- `→ HG decision:` Human evaluates whether the experience meets the bar. "Feels wrong" is a valid NO-GO.

### [A] Test Cases (minimum 3)
- [test 1: input → expected → actual → PASS/FAIL]
- [test 2: input → expected → actual → PASS/FAIL]
- [test 3: input → expected → actual → PASS/FAIL]

### [A] Regression Scenarios *(from Build Manifest — specific, named scenarios)*
- [scenario name from prior phase]: [expected outcome → actual → PASS/FAIL]
- [scenario name from prior phase]: [expected outcome → actual → PASS/FAIL]

### [A] Propagation *(MANDATORY if specs were modified)*
- Were any specs modified in this phase? [Yes/No — list files]
- If yes: which future phases depend on modified specs? [list each]
- Are those phases impacted? [Yes/No — explain for each]
- Were impacted phases flagged in Build Manifest? [Yes/No]
- **If specs were modified and this section says "None" → FAILURE CONDITION**

### [A] Pulse Check
- Phase complete? [Yes/No]
- Still aligned with Product Spec? [Yes/No]
- Drift detected? [Yes/No — describe]
- Future phases affected? [Yes/No — list which ones]
- Propagation enforcement satisfied? [Yes — all changes propagated / No — list what remains]
- **Deviation trend:** [This phase: N deviations. Prior phase: N. Trend: improving/stable/worsening]

### [A] Module Inventory *(omission is a failure condition)*
- Files created: [list]
- Files modified: [list]
- API routes added: [list]
- DB migrations: [list schema changes]
- Dependencies added: [list new packages]

### [O] Decisions to Log
- [list entries for decision-log.md, if any]
```

---

## APPENDIX G: ARCHITECTURE PATTERNS LIBRARY

*Reusable technical patterns extracted from past projects. Reference these during Step 3 (Architecture Contract) and Step 4 (Domain Specs). Not all patterns apply to every project — pick the ones relevant to yours.*

> **Maintenance note (v2.4):** Patterns G11+ cover newer or more domain-specific topics. The shape of these problems is stable; the specific tools/libraries cited (AI Gateway, Inngest, Manifest V3, Yjs, etc.) move fast. Verify current-state against the latest official docs before relying on specifics in a new project.

### G1. Normalized Input/Output Contracts (Multi-Surface Products)

If your product receives input from multiple surfaces (web, SMS, voice, email, API), define canonical message shapes that ALL surfaces must convert into before touching core logic.

```
[Surface A] → NormalizedInput → Core Logic → NormalizedOutput → [Delivery Channel]
[Surface B] → NormalizedInput → Core Logic → NormalizedOutput → [Delivery Channel]
```

**Why:** Lets you add new surfaces without changing core logic. Prevents surface-specific bugs from leaking into business logic.

**Enforcement:** Grep for provider-specific imports outside abstraction layers at every phase. Must be empty.

### G2. Orchestration as Single Entry Point

Define a single function that ALL inbound user actions pass through. API routes normalize input and call this function — they do NOT call business logic directly.

```
API route → normalize input → orchestrator → [capability/service/engine] → DB → output
```

**Why:** Ensures consistent behavior across all entry points. Makes it impossible for one surface to bypass validation or logging.

### G3. AI ↔ Logic Boundary (State Ownership)

```
AI layer:     Suggest structure, interpret intent, generate text
Logic layer:  Decide, enforce rules, validate, manage state transitions
DB layer:     Store truth
API layer:    Orchestrate the flow between layers
```

**Non-negotiable rules:**
- AI never writes to DB directly
- All state transitions are deterministic (not model-decided)
- All AI outputs are schema-validated (Zod or equivalent) before entering logic layer
- Raw AI output may NEVER reach business logic or database writes

### G4. Confidence → Behavior Matrix (AI Decision Products)

Map AI confidence scores to deterministic system behavior:

```
0.9–1.0   Near-certain    → Execute. Minimal confirmation.
0.7–0.89  Confident       → Execute and confirm. Show what was done.
0.5–0.69  Uncertain       → Execute best guess, flag uncertainty, invite correction.
0.3–0.49  Low             → Ask one targeted question. Do NOT execute.
0.0–0.29  Very low        → Ask for clarification. Do not act.
```

**Modifiers:** Memory context disambiguates (+0.1), high-risk action (deletion, financial) → always confirm regardless of score.

**Golden rule:** Prefer acting and confirming over asking and waiting. The undo path exists. The user's time is more valuable than perfect input.

### G5. Graceful Degradation

When critical systems fail, the user must never receive silence.

| Failure | User-Visible Behavior |
|---------|----------------------|
| AI model fails | "Got your message, but I'm having trouble. Try again shortly." |
| Messaging provider down (outbound) | Queue all messages. Deliver when recovered. |
| Database connection failure | "I'm temporarily unable to save that. Try again shortly." |
| Validation rejects AI output | "I couldn't understand that clearly. Can you try rephrasing?" |

**Non-negotiable:** Never confirm an action that didn't happen. Never send raw error details to users. Always log the failure.

### G6. Temporal Constants

Define all time-based thresholds as named constants, not magic numbers scattered through code.

```
CORRECTION_WINDOW_OPEN = 60        // seconds
CORRECTION_WINDOW_FADING = 300     // seconds
SESSION_TIMEOUT = 600              // seconds
DEDUP_WINDOW = 900                 // seconds
RECOMMENDATION_COOLDOWN = 2592000  // 30 days in seconds
MEMORY_DECAY_TO_STALE = 15552000   // 6 months
```

**Why:** Prevents temporal edge cases from being "fixed" inconsistently across the codebase.

### G7. Provider Abstraction Layer

For each external dependency that might change, create an abstraction:

```
/lib/[capability]/
  ├── types.ts         # Canonical interface
  ├── [provider].ts    # Provider-specific implementation
  └── index.ts         # Exports active provider (configurable)
```

**Pattern:** All provider-specific code lives inside the provider file. Core logic imports only from the types and index. Switching providers = writing a new provider file + changing the index export.

### G8. Tier-Based Feature Gating

Feature access is enforced in the **service layer**, not in AI capabilities or API routes. The check happens BEFORE capabilities execute.

```
Service layer: checkTierAccess(user, feature) → allow / deny / upgrade-prompt
```

**Why:** Deterministic enforcement. AI cannot accidentally grant access to paid features. No tier logic in prompts.

### G9. Audit Logging

Log all critical actions for observability and compliance:
- User actions (create, update, delete)
- Admin actions (config changes, overrides)
- AI-triggered actions (auto-created items, suggestions acted on)
- Security events (auth failures, rate limit hits, webhook rejections)

Schema: `{ id, user_id, event_type, actor_type, payload, created_at }`

### G10. Row-Level Security (Multi-Tenant)

If using Supabase or similar:
- Enable RLS on ALL user-data tables
- Policy: `auth.uid() = user_id` (or group membership check for shared data)
- Admin routes use service role key (bypasses RLS) — server-side only, never client-side
- System tables (config, definitions) = service role only

### G11. RAG Pipeline (v2.4)

For products that retrieve from a corpus to answer user questions.

- **Chunking strategy:** size + overlap depends on content (300-800 tokens typical; smaller for dense legal/finance, larger for narrative). Make this a decision-log entry, not a guess.
- **Embedding model choice:** pick one with a **migration plan**. Embedding models change; if you can't reindex, you're stuck. Wrap behind provider abstraction (G7).
- **Hybrid retrieval:** vector search alone misses keyword matches. Combine BM25 + vector + reranker (Cohere, Voyage) for production-grade recall.
- **Reranker:** non-negotiable for serious products. Cheap, large quality lift, no infra cost if hosted.
- **Reindexing:** when corpus updates or embedding model changes — design from day one. Incremental for steady-state, full-rebuild path for migrations.
- **"Not in corpus" UX:** explicit refusal beats hallucinated answers. Test for it in the eval set.
- **Eval (Step 2d):** retrieval recall@k on a held-out QA set; answer faithfulness (does the answer cite real chunks?); refusal accuracy.

### G12. Agent / Tool-Use Loop (v2.4)

For products where the AI calls tools (functions, APIs, MCP servers) to act, often over multiple steps.

- **Tool definitions are contracts.** Each tool needs a precise schema and a description that explains *when* to call it, not just *how*. Vague descriptions = wrong tool calls.
- **Max-step bound (mandatory).** Every agent loop has a hard cap (e.g., 10 steps) to prevent runaways and cost blowouts. Exceeding the cap returns a partial result + user notification, never silent failure.
- **Tool-call eval:** part of the eval set (Step 2d). For each user intent: did the agent pick the right tool, with the right args? Negative cases: "this should NOT call any tool."
- **Tool-failure handling:** for each tool, define the retry/abort/ask-user behavior. Don't let tools silently fail — agents that don't know tools failed give worse output than agents that admit failure.
- **Observability:** every tool call logged with input, output, latency, cost. Critical for debugging agent behavior in prod.
- **MCP wrapping:** if exposing tools via MCP, treat the MCP server as its own subsystem with a domain spec.
- **Common failure mode:** agent loops calling the same tool with the same args because it didn't get the answer it wanted. Detect with loop detection + early stop.

### G13. Background Job Architecture (v2.4)

For products with async work: scheduled jobs, queued tasks, webhooks-with-work, long-running operations.

- **Pick one orchestrator, abstract it.** Options: Inngest (event-driven, generous free), Trigger.dev (similar), Vercel Workflow (Vercel-native, durable), DB-backed queue (simplest, less powerful). Wrap behind G7 abstraction — you WILL switch eventually.
- **Idempotency is mandatory.** Every job has an idempotency key. Running twice = same result. Without this, retries duplicate charges/emails/whatever.
- **Retry policy:** exponential backoff, capped retries (3-5 typical), dead letter on final failure. Document the policy per job type.
- **Dead-letter handling:** failed jobs go somewhere visible. "Logs alert" is not a dead-letter strategy.
- **Concurrency limits:** per-user, per-tool, global. Prevents a single user spamming the queue and blocking everyone.
- **Observability:** job runs visible in a UI (Inngest/Trigger.dev give this free). Cost per job tracked.
- **Critical Architecture Decision** required when introducing the orchestrator (per Step [N]a) — answer the standard verification questions: server restart → pending jobs survive? two workers → no double-processing? failed jobs → retry with backoff? 3x-failed → dead letter?

### G14. Mobile App Considerations (v2.4 — Tier 3)

For native iOS/Android, React Native, Expo, or Flutter apps. Pattern is signposts, not a playbook — mobile has enough quirks to deserve its own protocol if you go deep.

- **Stack choice:** native (max performance, separate teams) vs RN (one codebase, JS ecosystem) vs Expo (RN + managed services, fastest path) vs Flutter (one codebase, custom rendering). For solo/Claude Code: Expo is the default unless you have a reason.
- **App store review prep:** budget 2-5 days for first submission, including assets (icons, screenshots, privacy nutrition label, data-collection disclosure). Apple is stricter than Google. First rejection is normal; second rejection is a process problem.
- **Push notifications:** provider choice (Expo Notifications, FCM, OneSignal); permissions UX (don't ask on first launch — earn it); user-controlled categories; deep-link routing on tap.
- **Offline behavior:** explicit decision — fully offline-first, offline-tolerant (queue actions, sync later), or online-only (with clear UX when disconnected). "Crash if no signal" is a real-world outcome of leaving this implicit.
- **OTA updates (Expo / RN):** what gets pushed OTA vs requires native binary update. Native code changes always require app-store resubmission.
- **Deep / universal links:** configure early; testing them retroactively is painful.
- **Common gotchas:** assumed permissions always granted; tokens stored in non-secure storage; analytics/crash reporting blocked by App Tracking Transparency on iOS; in-app purchases must use Apple/Google IAP for digital goods (15-30% fee).

### G15. Browser Extension (v2.4 — Tier 3)

For Chrome/Firefox/Edge/Safari extensions. The lifecycle is fundamentally different from a web app.

- **Manifest version:** MV3 is mandatory (Chrome killed MV2 by mid-2024). Background "service worker" replaces persistent background page — *it stops when idle*. Anything that needs to run continuously needs a workaround (alarms API, declarativeContent, etc.).
- **Boundary discipline:** content script (runs in page context, can access DOM) vs background service worker (runs in extension context, handles cross-origin) vs popup/options UI (separate context). Messaging between them is async; treat it like a subsystem boundary in your domain specs.
- **Permissions:** request the minimum — broad permissions delay/block store review. Optional permissions (request-at-use) are reviewed more favorably.
- **Storage:** `chrome.storage.local` (persistent, ~10MB) vs `chrome.storage.sync` (syncs across devices, smaller). Avoid `localStorage` in content scripts — different context, different storage.
- **CSP issues:** many sites have strict Content Security Policy that breaks content scripts. Defensive coding required.
- **Store review:** Chrome Web Store is faster than Apple but still 1-7 days. Reviews tighten when you request broad permissions or modify too many sites.
- **Common gotchas:** service worker dies mid-operation; content script breaks when site updates DOM; cross-browser API differences (use `webextension-polyfill`); auto-updates can land while user has the extension open and break state.

### G16. Real-time / Collaborative (v2.4 — Tier 3)

For products with multi-user real-time state: co-editing, presence, live cursors, chat, multiplayer.

- **Transport:** WebSocket (full-duplex, complex) vs Server-Sent Events (one-way server→client, simpler) vs WebRTC (peer-to-peer, lowest latency). Managed providers (Liveblocks, PartyKit, Pusher, Ably, Supabase Realtime) eliminate most of the infra pain — use them unless you have scale/cost reason not to.
- **Conflict resolution:** CRDTs (Yjs, Automerge — eventually consistent, no central authority needed) vs OT (operational transform — needs central server) vs last-write-wins (simplest, lossy). Pick based on what kind of conflicts you'll see: text editing → CRDT; structured data → CRDT or OT; presence/cursors → LWW is fine.
- **Presence model:** how do you detect a user is online, in this doc, on this section? How quickly does "left" propagate? Stale presence is a UX bug.
- **Offline-first:** if users can edit offline, the merge story is the product. Design it deliberately; don't let it emerge.
- **Permissions:** real-time updates must respect permissions — don't broadcast a doc's changes to users who can't see the doc.
- **Common gotchas:** clock skew causing CRDT divergence (use logical clocks, not wall clocks); reconnect storms after a network blip; presence "online" forever because cleanup never ran; replaying entire history on join (scale issue).

### G17. Voice / Audio Pipeline (v2.4 — Tier 3)

For products that transcribe, generate, or process audio.

- **STT (speech-to-text):** Deepgram (low latency, strong accents), OpenAI Whisper (high accuracy, batch-friendly), AssemblyAI (good speaker diarization). Wrap behind provider abstraction (G7).
- **TTS (text-to-speech):** ElevenLabs (quality, voice cloning), OpenAI (cheaper, decent), Cartesia (low latency for conversational). Same wrapping rule.
- **Streaming vs batch:** real-time conversation needs streaming both directions; transcribing a recording is batch. Mixing modes adds complexity.
- **Latency budget:** end-to-end for conversational AI: user finishes speaking → TTS audio starts. Target <1.5s for natural feel; <800ms feels human. Each hop (VAD → STT → LLM → TTS → audio) eats budget. Optimize the whole pipeline, not one hop.
- **Recording storage & retention:** explicit decision per jurisdiction. EU/CA require disclosure + consent + deletion. Default: short retention (hours-days) unless product needs longer.
- **Legal disclosure:** recording laws vary (one-party vs two-party consent states); for B2B sales/support tools, the disclosure pattern is mandatory.
- **Common gotchas:** STT accuracy degrades on non-native English / specialized vocab — fix with domain prompts or custom models; TTS prosody bad on long output — split at sentence boundaries; audio file format mismatches (sample rate, codec) breaking the pipeline silently.

### G18. Marketplace / Two-Sided Platform (v2.4 — Tier 3)

For products with distinct supply and demand sides where the product brokers their interaction.

- **Two user models, two flows.** Supply side (sellers, providers, hosts) and demand side (buyers, customers, guests) often share an identity layer but have separate onboarding, separate dashboards, separate notification preferences. Don't try to unify the UX prematurely.
- **Trust & safety:** ratings/reviews, reports, block/ban, dispute resolution. This is its own subsystem with its own domain spec.
- **Identity verification:** if money flows, KYC is likely required somewhere. Stripe Connect Identity, Persona, Onfido. Tier-gated (only require KYC at first payout, not at signup) to reduce friction.
- **Payments + payouts:** Stripe Connect is the default for two-sided (handles platform-fee split + payouts). Watch refunds — refund-after-payout creates a balance debt to the platform.
- **Dispute resolution:** define the state machine (open → investigating → resolved-for-buyer / resolved-for-seller / no-resolution → appealed). Audit trail mandatory.
- **Take-rate / fee model:** explicit in Product Spec. Changes here break unit economics retroactively.
- **Common gotchas:** unverified supply side committing fraud; demand side abusing dispute system; payouts incorrect after refund chains; one side's PII leaking to the other (e.g., real names/addresses in messaging); review brigading.

---

## APPENDIX H: COWORK SESSION TEMPLATE

*Use this template when a build phase requires human-in-the-loop data collection, research, or manual enrichment that Claude assists with.*

Some phases require the human and Claude to work together in real-time — looking up data, extracting information from websites, reviewing visual assets, etc. These sessions benefit from the same structure as build phases.

```markdown
## SESSION [N]: [Clear Scope Name]

### Context
[Why we're doing this. What project phase it supports.]

### Your Job
[One-sentence role statement for Claude]

### What to Capture
[Field-by-field list with "where to find it" notes]
| Field | Source | Notes |
|-------|--------|-------|
|       |        |       |

### Output Format
[Exact structure — CSV columns, markdown table, JSON shape]

### Workflow
[Step-by-step sequence]
1. Human does X
2. Claude does Y
3. Repeat for each item

### Items to Process
[Prioritized list with status column]
| # | Item | Status |
|---|------|--------|
| 1 |      | Pending |

### Error Handling
- If item not found: [behavior]
- If data is ambiguous: [behavior]
- If source is down: [behavior]

Let's start with item #1.
```

**When to use:** Vendor account setup, manual data enrichment (Zillow/Redfin lookups, competitor research), content review, visual asset evaluation, any task where Claude reads/processes but the human navigates.

---

## APPENDIX I: PROTOCOL EVOLUTION

*This Build Protocol is itself a living document. It should get better with every project.*

### When to Update

| Trigger | What to Do |
|---------|-----------|
| A project's learning extraction (Step N+2) reveals a process gap | Add or modify the relevant section |
| A pattern recurs across 2+ projects that isn't addressed here | Add it to the appropriate section or appendix |
| A step is consistently skipped because it doesn't add value | Remove or simplify it |
| A new tool or capability (e.g., new Claude Code feature) changes what's possible | Update the relevant sections |
| A guardrail failed to prevent an error it was supposed to catch | Strengthen the guardrail or add a new one |
| An anti-pattern not listed in Appendix A is observed | Add it |
| A new architecture pattern proves reusable | Add it to Appendix G |

### How to Update (The Monthly Review Prompt)

When the human says "update the build protocol based on recent projects," Claude should:

**1. Gather evidence from recent projects:**
- Read all project CLAUDE.md files on Desktop
- Read all project memory files (especially feedback memories)
- Read git logs for commit patterns (% fixes, phase commit frequency)
- Read any decision-log.md files in recent projects
- Read any lessons.md files
- Check: were there audit passes? How many items did they find?

**2. Assess protocol adherence:**
- Which protocol steps were actually followed?
- Which steps were skipped and why?
- Which steps were modified in practice?
- Where did the process break down?
- Were there errors that the protocol should have caught but didn't?

**3. Extract patterns:**
- What went well that isn't captured in the protocol?
- What went wrong that IS captured but wasn't followed? (enforcement gap)
- What went wrong that ISN'T captured? (coverage gap)
- Are there new reusable architecture patterns (Appendix G candidates)?
- Are there new anti-patterns (Appendix A candidates)?
- Are there new behavioral core patterns (Appendix B candidates)?

**4. Propose changes:**
- Present each proposed change with: what to change, why, which project triggered it
- Categorize: new addition / modification / removal / strengthening
- Get human approval before making changes

**5. Version the update:**
- Increment version (v1.0 → v1.1 for additions, v2.0 for structural changes)
- Add entry to the changelog below
- Update the "derived from" line at bottom with new project names

### Changelog

| Version | Date | Changes | Triggered By |
|---------|------|---------|-------------|
| v1.0 | 2026-04-15 | Initial creation. 3 modes (NEW/AUDIT/EVOLVE), 5-layer doc hierarchy, 13 Claude guardrails, 8 appendices including Phase Report Template and Architecture Patterns Library. | Analysis of prior personal projects (EMBT, DLL, Tax Auction, strategy-research project) |
| v1.1 | 2026-04-15 | Hardened enforcement language: Global Spec Lock (FAIL matrix), behavior drift examples, Acceptance Gate, Critical Architecture Decision, mandatory Global Invariant Check, grep-based provider enforcement, Module Inventory as failure condition. | DLL 14-build-guide.md side-by-side comparison |
| v1.2 | 2026-04-15 | Gap closure from self-test simulation: Capability Traceability Matrix, per-phase cross-cutting concern scan (integration seams, rate limits, abuse vectors, error propagation, auth gaps), experience testing, regression scenario specs, per-phase ChatGPT audit template, expanded hardening (5 audits: security + adversarial/abuse + integration seam + data integrity + spec-code consistency), phase-specific mandatory audit sections. | DLL audit findings (5 passes of edge cases/holes despite functional code) |
| v2.0 | 2026-04-15 | Structural overhaul: Complexity Assessment (Light/Standard/Heavy tracks). Self-adversarial review as default, second-model review optional. Deploy & Verify substep for integration phases. Class-level pattern scan in verification. Hot path definition + per-phase testing. Deviation count tracking as health metric. Debugging Protocol (structured failure recovery). Protocol Effectiveness Metrics. Minimum Viable Process (tiered step priority). Conditional Phase Report sections ([A]/[C]/[O] markers). Test type distinction (unit/integration/deployment). Split into core + full reference with extractable templates and case studies. | DLL post-build analysis: 6-commit Twilio debug chain, 51-query class-level fix, non-declining deviation counts, production-only failures despite 166 passing tests |
| v2.1 | 2026-04-15 | Seam and transition fixes from 3-mode simulation: Step 0 (Intake) for NEW mode — warm-start from existing materials. Step A7 (Re-entry) for AUDIT mode — explicit next-step guidance after remediation. Evolution Hardening Threshold — triggered at 5th Medium+ evolution, 3+ subsystem touches, Behavioral Core changes, or 6-month calendar. Mid-build reclassification rules for Complexity Assessment. Multiple concurrent evolutions guidance in E1. Template pointers in core reference. Session budget heuristics. | 3-mode simulation audit |
| v2.2 | 2026-05-15 | **Best-practice gap closure (six changes, applied via Bob-on-Bob EVOLVE):** (1) Product Spec (Step 1a) — added success metrics + activation definition + non-goals + data classification. (2) New Step 2d (AI eval harness) — mandatory golden eval set of 10-30 input/expected pairs, LLM-as-judge + rubric scoring, re-run at every AI-touching phase gate. Drop in pass-rate is a stop condition. New `templates/eval-set.md`. (3) Architecture Contract (Step 3a) — added threat model (STRIDE/DFD), observability plan (logs/traces/metrics/alerts), rollback/kill-switch posture (feature-flag strategy), cost-budget guardrail. (4) Domain Specs (Step 4) — mandatory machine-readable contracts in `contracts/` (Zod/TS/OpenAPI/JSON Schema); new 4c adversarial review parallel to 1c/2c/3c. (5) Build Manifest (Step 5a) — mandatory rollback plan per phase entry. (6) Hooks (Step 6b) — promoted from "recommended" to **default-on with opt-out** for non-engineer users; default set: format + typecheck/build + block-destructive. Phase Report template adds `[C] AI Eval Results`, `[C] Cost Guardrail Check`, and rollback verification line. | Self-audit against 2026 spec-driven dev best practices: missing eval framework for AI products, prose-only integration contracts unenforceable, security/observability deferred to hardening, no per-phase rollback discipline. |
| v2.3 | 2026-05-15 | **Narrator Mode for non-engineer users (applied via Bob-on-Bob EVOLVE):** New Foundation §11 "Narration Protocol" — 10 rules Claude must follow when guiding a first-time user, plus a standardized Preamble Template (used at every step entry), Checkpoint Summary Template (used after every step completion), and Journey Map (shown before mode selection). New Appendix J "Glossary" — plain-English definitions of every term the protocol uses. Mode menu expanded from terse A/B/C to a what/when/time table. Session Start Protocol (Appendix C) branched into first-time-user vs. resuming-user paths. Build Manifest (Step 5b) gained a visual progress tracker (`▓▓▓░░░░ 3/7`) recited at session start. Root CLAUDE.md instructs Claude to enable Narrator Mode by default. Narrator Mode is ON by default; user can disable with "terse mode". | Self-audit found no clear walkthrough capability for non-engineer users — protocol assumed Claude would narrate without explicit instruction, leaving UX inconsistent. |
| v2.6 | 2026-05-15 | **Distribution + invocation polish (post-public-release iteration):** (1) Step 6a now MANDATES that the project-level CLAUDE.md include a Bob protocol reference line as its first section — without it, "invoke once and auto-resume" doesn't actually work; this was a real gap that broke session continuity. (2) New `scripts/bob-init.sh` — scaffold script that generates folder structure (`docs/`, `contracts/`, `evals/`, `scripts/`, `tests/`, `src/`, `.claude/`), writes the Bob-referencing CLAUDE.md, writes `.claude/settings.json` with placeholder hooks, writes `.gitignore` + `.env.example`, and runs `git init`. Safe to re-run. (3) Step 6c now invokes the scaffold script as preferred path; manual fallback retained. (4) ASCII journey map in §11.4 replaced with Mermaid flowchart (renders natively on GitHub; color-coded by phase). README adds same Mermaid + a new "How often do I invoke Bob?" section answering the most common new-user question. | Public release exposed the invocation/auto-resume gap and the visual deficiency of the ASCII journey map. |
| v2.5 | 2026-05-15 | **Spec-extraction depth + narrator quality (applied via Bob-on-Bob mini-build, 4 phases):** **Narrator upgrades:** new §11.7 "Quality Bar Templates" defines what "done" looks like per artifact (Product Spec, Behavioral Core, Architecture Contract, Domain Specs, Build Manifest) with strong/weak examples and stop-iterating criteria — closes the gap where humans couldn't self-evaluate when to advance. New §11.8 mandates "💎 Why this matters" narration in Checkpoint Summary template — sells the value of each artifact in product-leader language. New §11.9 "Confusion-Catch Phrases" lists specific trigger phrases ("I'll just trust you", "sounds good" without engagement, "skip ahead") + response template with 3 explicit options (explain differently / show example / make a guess + flag). **Spec extraction depth:** new Step 1a-pre (Structured Interview + Day-in-the-Life) — mandatory when initial description is thin or ambiguous, runs a JTBD-style 12-question interview + a typical-day walkthrough to extract what's actually in the user's head before Claude drafts. Outputs `docs/interview-notes.md` + `docs/day-in-the-life.md`. New Step 1d "Stability Loop" — re-runs stress-test + adversarial review against revised spec until findings stabilize, capped at 3 iterations (signal that the product idea itself is unstable if not). **HG trimming:** Build Manifest init (5b) and Repo init (6c) auto-advance with status updates instead of HG pause — removes friction at the mechanical steps. | Audit of human-input balance, spec iteration depth, and narrator quality identified four gaps: (1) no interview framework when input is thin, (2) no quality bar to advance, (3) single-pass stress test fails to catch new gaps introduced by fix iterations, (4) narrator explained "what we have" but not "what good looks like" or "why this matters." |
| v2.4 | 2026-05-15 | **Project archetype coverage (applied via Bob-on-Bob mini-build, 4 phases):** **Tier 1** — New Step 0.5 "Project Profile" routes the project through Appendix K addenda; new Appendix K "Project Profiles" with 15 archetypes (K1-K15: AI Chat, B2B Tool, RAG, Vertical SaaS, Agent, Background Jobs, E-commerce, Marketplace, Content/Community, Real-time, Mobile, Extension, Voice, ETL, SEO Site) — additive-only addenda that never override core protocol. Three new architecture patterns: G11 RAG Pipeline (chunking/embedding/reranker/eval), G12 Agent / Tool-Use Loop (tool contracts, max-step bound, tool eval), G13 Background Job Architecture (orchestrator choice, idempotency, dead letter). **Tier 2** — Architecture Contract (Step 3a) gained accessibility posture, internationalization posture, and compliance scope (GDPR/CCPA/HIPAA/SOC2/PCI/None). Build Manifest (Step 5b) gained success-metric instrumentation map (every Product Spec success metric must map to an analytics event + build phase + dashboard, closing the "metric defined but never wired" gap). **Tier 3** — Five additional architecture patterns for less common archetypes that may show up later: G14 Mobile App, G15 Browser Extension, G16 Real-time/Collaborative, G17 Voice/Audio Pipeline, G18 Marketplace/Two-Sided Platform. Pattern Library gains a maintenance note flagging that tool-specific advice in G11+ moves fast. | Self-audit against common 2026 Claude-Code project archetypes found three gaps: no routing layer for archetype-specific considerations; missing patterns for the most common AI-product archetypes (RAG, Agents, Jobs); a11y/i18n/compliance treated as implicit; success metrics defined in Product Spec but never instrumented during build. |

---

## APPENDIX J: GLOSSARY (v2.3 — plain English)

*Inline reference for terms used in this protocol. Claude defines each term on first use during a session; this appendix is the canonical version. Ordered roughly by when you'll encounter the term.*

### The five core documents

- **Product Spec** — The "WHAT" document. Plain-English description of what you're building, who it's for, what problem it solves, and how you'll know it worked. Lives at `docs/product-spec.md`. Comes first because every later document refers to it.
- **Behavioral Core** — The "HOW IT THINKS" document. Only exists if your product has an AI making decisions. Defines confidence thresholds, tone, what the AI is allowed to do without asking, and what it must refuse. Lives at `docs/behavioral-core.md`.
- **Architecture Contract** — The "HOW IT'S BUILT" document. Tech stack, security baseline, threat model, observability plan, cost budget, what the system explicitly does NOT support. Lives at `docs/architecture.md`.
- **Domain Specs** — One document per subsystem (e.g., "messaging", "billing", "scheduler"). Details: data models, APIs, state machines, edge cases. Live in `docs/domains/`.
- **Build Manifest** — The "WHERE WE ARE" document. Phases, current status, what's done, what's deferred, deviations from plan. Lives at `docs/build-manifest.md`. The only document that tracks *current state* — all others describe *desired state*.

### Gates (places we pause)

- **Human Gate (`→ HG`)** — A pause point. Claude stops, presents work, and waits for you to approve / revise / reject / defer. The mechanism that keeps Claude from drifting off the plan.
- **Phase Gate** — A bigger pause point at the end of every build phase. Checks: build passes, tests pass, hot paths work, no regressions, eval set still passes, cost stays in budget, specs still match code. Failing any check stops advancement.
- **Quality Gate** — A category of gate (Spec Gate after spec docs, Phase Gate after each phase, Hardening Gate after audits, Ship Gate before launch). Each has pass criteria.
- **Acceptance Gate** — The exit check for a single phase. Has two parts: *exit criteria* (what must be true) and *scope boundary* (what must NOT have been built — prevents creep into future phases).

### Process disciplines

- **Reconciliation** — After every build phase: spec says X, code does Y; decide which is right; update the other. Done at step `[N]c`. Non-optional.
- **Propagation** — When a spec is modified mid-build, scan future phases that depend on it and flag them. Prevents Phase 3's data-model change from breaking Phase 8 silently.
- **Class-level pattern scan** — When a bug is found, grep the entire codebase for the same pattern and fix all instances. Prevents fixing one symptom while identical bugs remain elsewhere.
- **Hot path** — A 1-3 project-wide critical user flow defined in the Build Manifest (e.g., "user texts a task → AI interprets → task gets created → confirmation sent"). Tested at every phase gate. Failure is a stop condition.
- **Capability Traceability Matrix** — A table mapping every capability in the Product Spec to a specific build phase. Prevents "we forgot to build feature X" at hardening.
- **Hardening** — The audit phase after all build phases. Five fresh-session audits: security, adversarial/abuse, integration seams, data integrity, spec-code consistency. Each is a separate session with clean context (writer/reviewer pattern).
- **Deviation tracker** — Running count of spec-vs-code mismatches per phase. If not declining over 3 phases → trigger a process review.

### Specs & artifacts (v2.2 additions)

- **Eval set** — For AI products: a `evals/behavioral-core.yaml` file with 10-30 input → expected-behavior pairs. The executable version of the Behavioral Core. Re-run at every phase gate that touches AI.
- **Machine-readable contract** — A file in `contracts/` (TypeScript, Zod, OpenAPI, JSON Schema) that defines a subsystem boundary in code, not prose. The compiler/validator enforces what was previously prose-checked.
- **Threat model** — STRIDE or data-flow analysis listing assets, threats, and mitigations. Sits in the Architecture Contract. Pulls security work into design, not hardening.
- **Observability plan** — What gets logged / traced / measured / alerted on, defined in the Architecture Contract. Without it, debugging in production is blind.
- **Rollback plan** — Per-phase: how to turn this phase off if it breaks in prod (feature flag, env var, revert path). Set in the Build Manifest.
- **Cost guardrail** — A per-request or per-user-per-day $ ceiling that triggers a regression check at the phase gate. Common for AI products.

### Modes & complexity

- **NEW mode** — Build a brand-new product from scratch. The longest path: ~7 spec steps + N build phases + hardening.
- **AUDIT mode** — Assess an existing partially-built product, map it to the 5-document hierarchy, find gaps, remediate.
- **EVOLVE mode** — Add features or change an existing product. Classified Small/Medium/Large; the bigger the change, the more of the build discipline applies.
- **Light / Standard / Heavy track** — Project complexity tier set at intake. Light skips Behavioral Core and some adversarial reviews; Heavy adds mandatory deploy verification per phase and second-model review at every gate.

### Narration (v2.3)

- **Narrator Mode** — Default-on for NEW mode. Claude announces what's about to happen, why now, what the user will be asked, and what "done" looks like. Show progress at every step entry. Summarize at every step completion. Catch confusion signals.
- **Preamble Template / Checkpoint Summary** — The two standardized blocks Claude uses at the start and end of each step (see Section 11).
- **Journey Map** — The ASCII overview of the full build path shown to first-time users before mode selection.
- **Pulse Report** — Short session-end narration: where we are, what got produced, what's next, any open questions.

---

## APPENDIX K: PROJECT PROFILES (v2.4)

*Used in Step 0.5. Each profile is an **additive addendum** to the core protocol — extra things to consider, never replacements. If addendum and core protocol conflict, core wins.*

> **Maintenance note:** Profiles reflect best practice as of 2026-05-15. Tech in some of these (especially Tier-3 archetypes) moves fast. Verify against current sources when you actually start a project in that profile.

### Profile index

| Profile | Pattern refs | Tier |
|---|---|---|
| K1. AI Chat / Copilot / Assistant | G3, G4, G11 (if RAG), G12 (if tools) | Core fit |
| K2. Internal B2B Tool / Dashboard | G7, G9, G10 | Core fit |
| K3. RAG Pipeline | G11 | Core fit |
| K4. Vertical SaaS (CRUD-heavy) | G8, G9, G10 | Core fit |
| K5. Agent / Tool-Use Workflow | G3, G4, G12, G13 | Core fit |
| K6. Background Job-Heavy / Workflow Orchestration | G13 | Core fit |
| K7. E-commerce / Subscriptions | G7, G9, G10 | Common |
| K8. Marketplace / Two-Sided Platform | G10, G18 | Tier 3 |
| K9. Content / Community | G8, G10 | Common |
| K10. Real-time / Collaborative | G16 | Tier 3 |
| K11. Mobile-First / Native | G14 | Tier 3 |
| K12. Browser Extension | G15 | Tier 3 |
| K13. Voice / Audio / Video | G17 | Tier 3 |
| K14. Data Pipeline / ETL | G7, G13 | Tier 3 |
| K15. SEO / Marketing Site | (specific addendum below) | Tier 2 |

### K1. AI Chat / Copilot / Assistant

- **Product Spec additions:** conversation memory bounds (how many turns? when does context reset?); citations & sourcing UX; "I don't know" behavior; redirect-out-of-scope behavior; user feedback capture (thumbs up/down, regenerate).
- **Architecture Contract additions:** streaming response strategy; rate limits per user/per-day; AI cost-per-conversation budget (not just per-request); prompt versioning approach.
- **Common gotchas:** prompt injection from user input; context window blowups when memory grows unbounded; tone drift when system prompt is too long.
- **Eval set focus (Step 2d):** disambiguation, refusal, citation accuracy, tone under frustration.

### K2. Internal B2B Tool / Dashboard

- **Product Spec additions:** role-based access (admin/viewer/etc.); audit log requirements; data export expectations; bulk-action workflows.
- **Architecture Contract additions:** SSO strategy (SAML/OIDC if enterprise); audit logging required; row-level security if multi-team.
- **Common gotchas:** assumed roles never enforced; export endpoints leaking data across tenants; bulk actions that lock the DB.

### K3. RAG Pipeline

- **Product Spec additions:** corpus size + update frequency; expected query latency; retrieval accuracy target; "answer found" vs "not in corpus" UX.
- **Architecture Contract additions:** chunking strategy; embedding model choice (and migration plan when it changes); reranker decision; hybrid retrieval (BM25 + vector); reindexing strategy when corpus updates.
- **Patterns:** see **G11** for full pattern.
- **Common gotchas:** chunk size wrong for content type (legal vs slack convos); no reranker = poor retrieval; embeddings stale after corpus update; "I don't know" mishandled.
- **Eval set focus:** retrieval recall@k, answer faithfulness (does the answer cite real chunks?), refusal when not in corpus.

### K4. Vertical SaaS (CRUD-heavy)

- **Product Spec additions:** primary entity hierarchy (Organization → User → Resource); permissions matrix; common workflows (create, edit, delete, share, archive); empty-state design.
- **Architecture Contract additions:** RLS or app-level permissions; soft-delete vs hard-delete; data migration strategy as schema evolves.
- **Common gotchas:** permission checks missing on one endpoint; cascading deletes that nuke too much; no soft-delete = no "undo".

### K5. Agent / Tool-Use Workflow

- **Product Spec additions:** what tools does the agent have access to; what's the max-step bound; how does the user observe agent progress; how does the user stop or redirect mid-run.
- **Architecture Contract additions:** tool definition discipline (schemas, descriptions); tool-call eval; tool-failure handling (retry vs abort vs ask user); MCP integration if applicable.
- **Patterns:** see **G12** for full pattern.
- **Common gotchas:** agent calls wrong tool because description is unclear; infinite loops; agent's tool calls fail silently; no observability into multi-step runs.
- **Eval set focus:** tool selection accuracy, refusal on out-of-scope requests, max-step compliance, recovery from tool errors.

### K6. Background Job-Heavy / Workflow Orchestration

- **Product Spec additions:** which user actions trigger background work; expected latency between trigger and completion; user-visible status; retry policy from user's POV ("we'll keep trying for 24h").
- **Architecture Contract additions:** job runner choice (Inngest, Trigger.dev, Vercel Workflow, DB-backed queue) — see G13; idempotency keys; dead-letter handling; concurrency limits.
- **Patterns:** see **G13**.
- **Common gotchas:** non-idempotent jobs run twice → duplicate charges/emails; no dead-letter = silent loss; jobs not observable in prod.

### K7. E-commerce / Subscriptions

- **Product Spec additions:** payment flow (one-time, subscription, usage-based, freemium); cart/checkout vs single-product purchase; tax/region handling; refund + dispute flow; inventory model if physical goods.
- **Architecture Contract additions:** payment provider (Stripe default, alternatives if EU-heavy); webhook signature verification (G7 abstraction recommended); idempotency on payment retries; PCI scope (use Stripe Elements → out of scope).
- **Common gotchas:** double-charging from non-idempotent retries; webhook failures leaving payment ≠ DB state; tax handling wrong by region.

### K8. Marketplace / Two-Sided Platform

- **Product Spec additions:** supply side and demand side as distinct user types with separate flows; matching/discovery logic; trust & safety (reviews, reports, bans); dispute resolution; payouts to supply side (Stripe Connect or equivalent).
- **Architecture Contract additions:** identity verification (KYC if money flows); review/report system; ban/suspension state machine; escrow vs direct-pay; transaction fees.
- **Patterns:** see **G18**.
- **Common gotchas:** supply side abuses to extract user data; demand side abuses to get free work; payouts incorrect after refunds; no audit trail for disputes.

### K9. Content / Community

- **Product Spec additions:** content types (post, comment, message, reaction); moderation model (pre-publish, post-publish, community); spam/abuse mitigation; notification model (email, in-app, push).
- **Architecture Contract additions:** content storage (DB vs object store for media); moderation pipeline; notification fan-out (esp. for high-follower users); search/indexing strategy.
- **Common gotchas:** notification storms on viral posts; moderation queue grows unboundedly; PII in user content accidentally indexed.

### K10. Real-time / Collaborative

- **Patterns:** see **G16**.
- **Architecture Contract additions:** real-time transport (WebSocket, SSE, WebRTC); CRDT vs OT; presence model; conflict resolution; offline-first vs online-only.
- **Common gotchas:** clock skew causing CRDT divergence; presence leaks (still shows online after disconnect); merge conflicts that lose user work.

### K11. Mobile-First / Native

- **Patterns:** see **G14**.
- **Architecture Contract additions:** native vs RN vs Expo vs Flutter decision; push notification provider; OTA update strategy; app store review prep; offline behavior; deep links / universal links.
- **Common gotchas:** assumed always-online; first app-store review rejection costs a week; push notification permissions never granted; OTA updates breaking when binary differs.

### K12. Browser Extension

- **Patterns:** see **G15**.
- **Architecture Contract additions:** Manifest version (MV3 as of 2026); content-script vs background-worker boundary; cross-origin permissions; sync vs local storage; store review prep.
- **Common gotchas:** MV3 service worker lifecycle (it stops when idle); permissions broader than needed → store rejection; content script breaking on sites with strict CSP.

### K13. Voice / Audio / Video

- **Patterns:** see **G17**.
- **Architecture Contract additions:** STT/TTS provider (Deepgram, Whisper, ElevenLabs); streaming vs batch; latency budget; recording storage & retention; legal recording disclosure.
- **Common gotchas:** latency budget violated end-to-end; recording stored longer than disclosed; STT accuracy variance by accent/language unaddressed.

### K14. Data Pipeline / ETL

- **Product Spec additions:** sources + frequencies; freshness target; schema evolution policy; reprocessing/backfill capability; data quality monitoring.
- **Architecture Contract additions:** orchestrator (Airflow, Dagster, simple cron + scripts); idempotency at every stage; checkpointing; alerting on failure; cost per run.
- **Common gotchas:** late-arriving data corrupts aggregates; schema change downstream breaks consumers; backfills that double-count; silent failures hidden because no one watches the dashboard.

### K15. SEO / Marketing Site

- **Product Spec additions:** target keywords + pages; structured data (Schema.org); social sharing (OG / Twitter cards); analytics + conversion tracking; A/B testing scope.
- **Architecture Contract additions:** rendering strategy (SSG vs SSR vs ISR — favor SSG for SEO); image optimization; Core Web Vitals budget; sitemap + robots.txt; canonical URLs.
- **Common gotchas:** client-side rendering hurting indexability; missing canonical → duplicate-content penalty; CLS/LCP regressions from a careless commit; analytics blocking by ad-blockers.

---

### What This Protocol Is NOT

- **Not a product spec template.** It doesn't tell you what to build — it tells you how to go from idea to built product systematically.
- **Not Claude Code documentation.** It doesn't explain how Claude Code works — it tells Claude Code how to work with you.
- **Not project-specific.** Nothing in here should reference a specific product. Project-specific rules belong in CLAUDE.md and docs/.
- **Not static.** If you're following it exactly as written 6 months from now without any changes, something is wrong — either the protocol is perfect (unlikely) or you stopped learning from projects.

---

*Build Protocol v2.6 — 2026-05-15*
*Derived from prior personal projects: an AI-driven blood-test interpretation tool, a personal task-management app, a tax auction analysis tool, and a strategy-research framework.*
