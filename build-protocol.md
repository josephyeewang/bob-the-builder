# BUILD PROTOCOL v2.0

> A systematic framework for building, auditing, and evolving products with Claude Code.
> Created: 2026-04-15. Owner: Joe Wang.

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
| **strategy-research project** | Strategy-first: 280K lines of specs (context, playbook, agent specs) before any code. Deep behavioral and competitive research upfront. | **Spec depth scales with product complexity.** The Behavioral Core pattern (how the system thinks) is reusable across AI products. |

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

**When the user references this file without specifying a mode, Claude MUST present this menu and wait for selection:**

> **Which mode fits where you are?**
>
> **A) NEW** — Start a brand new product from scratch
> *I have an idea (or a rough spec) and want to build it systematically. This walks you through: product spec → behavioral core (if AI) → architecture → domain specs → phased build with verification at every step.*
>
> **B) AUDIT** — Assess an existing, partially-built product
> *I already have code and/or docs but I'm not sure how solid they are. This inventories what you have, maps gaps against a standard framework, scores consistency, and produces a prioritized remediation plan.*
>
> **C) EVOLVE** — Add features or make changes to an existing product
> *I have a working product and want to add something or change something. This classifies the change (small/medium/large), checks relevant specs, builds it, and keeps docs in sync.*
>
> **Which one? (A / B / C)** — or describe what you're trying to do and I'll recommend one.

After the user selects, Claude reads the relevant PART (II, III, or IV) and begins at Step 1 / A1 / E1. Claude does NOT need to read the entire document upfront — read Part I (Foundation) + the selected mode's section.

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
│   ├── architecture.md             # Layer 3: HOW it's built
│   ├── build-manifest.md           # Layer 5: WHERE we are
│   ├── decision-log.md             # Non-obvious decisions with rationale
│   ├── tool-decisions.md           # Tool evaluations and choices
│   └── domains/                    # Layer 4: subsystem details
│       ├── [subsystem-1].md
│       └── [subsystem-n].md
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

1. **Build check:** Code compiles, types check, no errors
2. **Test check (by type):**
   - **Unit tests:** All pass. These catch logic errors within modules.
   - **Integration tests:** All pass. These catch contract mismatches between subsystems. At minimum, one integration test must exercise the project's hot path(s) end-to-end.
   - **Deployment tests** (if phase touches external integrations, webhooks, or auth): Deploy to staging/preview environment and confirm at least one real request succeeds. "It compiles" is not "it works."
3. **Hot path check:** Run the project-wide hot path(s) defined in the Build Manifest. Hot path failure is a stop condition — do not advance.
4. **Regression check:** Re-test critical flows from ALL prior phases. If any prior flow is broken → fix before advancing.
5. **Global invariants:** Re-verify all project invariants (see Appendix E). If any violated → fix before advancing.
6. **Spec consistency:** Confirm implementation still matches domain specs, Architecture Contract, and Behavioral Core. If drift detected → reconcile before advancing.

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
| **Tier 1 — Never Skip** | Reconciliation ([N]c), Regression check, Scope lock, Class-level pattern scan, Hot path test | These prevent compounding errors. Skipping them creates debt that grows exponentially. |
| **Tier 2 — Skip With Caution** | Cross-cutting concern scan, Global invariant check, Full Phase Report (use abbreviated), Propagation enforcement | These catch subtler issues. Skipping them is survivable for 1-2 phases but not more. |
| **Tier 3 — Skip First** | Adversarial reviews (spec phase), Experience test, Second-model review, Cowork session template, Detailed module inventory | These improve quality but their absence doesn't compound. Defer to hardening. |

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

### Step 1: Product Spec

**1a: Draft**
- Human describes the product conversationally
- Claude drafts the Product Spec covering:
  - What is this product? (1-paragraph elevator pitch)
  - Who is it for? (Target users, their pain, their current alternatives)
  - What problem does it solve? (The core value proposition)
  - What are the core capabilities? (MVP scope — be ruthless about what's in vs out)
  - What's the roadmap beyond MVP? (Phases, not dates)
  - User scenarios (3-5 concrete end-to-end walkthroughs)
  - Business model / economics (pricing, cost structure, unit economics)
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
- `→ HG:` Human reviews, resolves each finding. Product Spec finalized.
- **Optional — second-model review:** Human may additionally take the Product Spec to a second AI (e.g., ChatGPT) for independent review. Prompt: *"Review this product spec. Focus on: conceptual gaps, scope creep risks, market blind spots, scenarios where the product would fail or confuse users. Be adversarial — find the holes."* Bring back any new findings for Claude to incorporate.

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

### Step 3: Architecture Contract

**3a: Draft**
- Claude drafts the Architecture Contract covering:
  - Tech stack selection (using tool evaluation template from Section 3)
  - Architectural patterns (monolith vs modules, API design, state management, data flow)
  - Provider abstractions (what gets wrapped and why)
  - Security baseline (auth strategy, encryption, data handling, compliance requirements)
  - Cost model (estimated cost per user at 100 / 1K / 10K scale)
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
- After writing all specs, Claude cross-references them:
  - Does Subsystem A's output match Subsystem B's expected input?
  - Do all specs align with the Product Spec and Architecture Contract?
  - Are there gaps — capabilities in the Product Spec that no domain spec covers?
  - Are there orphaned outputs or missing inputs in the data flow diagram?
- Flag any tensions or ambiguities found during cross-reference
- `→ HG:` Human reviews each spec, iterates, approves. **Review technique:** Open each spec in your editor, add inline annotations (corrections, questions, "remove this"), then tell Claude: "I added notes to [file]. Address all of them and update accordingly. Don't implement yet." Repeat until satisfied.

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
  - Phase list with status column (pending / in-progress / complete)
  - Capability traceability matrix (from 5a-ii)
  - Current phase pointer (updated after each phase)
  - **Hot paths** (1-3 project-wide critical paths that are tested at every phase gate, e.g., "SMS inbound → AI interpretation → task creation → confirmation outbound"). Hot path failure at any phase is a stop condition.
  - **Deviation tracker** (running count of spec deviations found per phase — used to monitor build quality trend. Format: `| Phase | Deviations Found | Deviations Fixed | Trend |`)
  - Decisions section (links to decision-log.md entries made during build)
  - Deferred items list (things explicitly skipped with rationale)
  - Deviations section (where build diverged from original specs, with explanation)
- `→ HG:` Build Manifest initialized

### Step 6: Project Setup

**6a: CLAUDE.md**
- Claude generates project-level CLAUDE.md containing:
  - What this project is (2-3 sentences)
  - Current phase (pointer to Build Manifest)
  - Architecture rules (compact extraction from Architecture Contract — the rules Claude needs in every session)
  - Red flags (stop conditions)
  - Build/deploy/test commands
  - Compaction instructions ("When compacting, always preserve: current build phase, modified files list, pending decisions, and test commands")
  - Pointer to `docs/` for full specs — use **progressive disclosure**, not inline content. Example: "Read docs/product-spec.md for full product context. Read docs/domains/messaging.md before working on SMS features."
- **CLAUDE.md should be <150 lines.** It's a session reference, not a spec. The elimination test for every line: "Would Claude make a mistake without this?" If not, cut it. Don't add anything Claude can figure out by reading code, anything a linter enforces, or anything that's standard practice for the language/framework.
- `→ HG:` Human reviews

**6b: Hooks Setup (recommended)**
- CLAUDE.md rules are advisory (~80% followed). Hooks are deterministic (100% enforced). For must-happen quality gates, set up hooks:
  - **PostToolUse (Edit/Write):** Auto-format after file changes (Prettier, Black, etc.)
  - **Stop (on turn complete):** Run type-check / build to catch errors before human reviews
  - **PreToolUse (Bash):** Block dangerous commands if needed (force-push, drop table, etc.)
- Hooks live in `.claude/hooks/` or are configured in `settings.local.json`
- Only add hooks for rules that MUST be enforced — don't over-constrain

**6c: Repository Init**
- Create folder structure (per Section 2)
- git init + initial commit with docs/ and CLAUDE.md
- .gitignore (appropriate for stack)
- .env.example (all required env vars documented, no secrets)
- package.json / pyproject.toml / etc. (if code product)
- Push to GitHub
- Set up hosting/deployment (if applicable)
- Initialize project memory directory
- `→ HG:` Environment ready

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

- [ ] Create project directory (`~/Desktop/[project-name]/`)
- [ ] `git init` + initial commit
- [ ] Create `docs/` directory
- [ ] Create placeholder CLAUDE.md (will be populated at Step 6)
- [ ] Push to GitHub
- [ ] Register in sync scripts (if using multi-machine Dropbox sync)
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

1. Read CLAUDE.md
2. Read `docs/build-manifest.md` → identify current phase and status
3. Read relevant project memory
4. State: "We're at Step [X]. Last session completed [Y]. Next up is [Z]."
5. If resuming a build phase: re-read the relevant domain spec before proposing work
6. If the human has a different intent (e.g., they want to EVOLVE, not continue building): switch modes

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
| v1.0 | 2026-04-15 | Initial creation. 3 modes (NEW/AUDIT/EVOLVE), 5-layer doc hierarchy, 13 Claude guardrails, 8 appendices including Phase Report Template and Architecture Patterns Library. | Analysis of EMBT, DLL, Tax Auction, strategy-research project |
| v1.1 | 2026-04-15 | Hardened enforcement language: Global Spec Lock (FAIL matrix), behavior drift examples, Acceptance Gate, Critical Architecture Decision, mandatory Global Invariant Check, grep-based provider enforcement, Module Inventory as failure condition. | DLL 14-build-guide.md side-by-side comparison |
| v1.2 | 2026-04-15 | Gap closure from self-test simulation: Capability Traceability Matrix, per-phase cross-cutting concern scan (integration seams, rate limits, abuse vectors, error propagation, auth gaps), experience testing, regression scenario specs, per-phase ChatGPT audit template, expanded hardening (5 audits: security + adversarial/abuse + integration seam + data integrity + spec-code consistency), phase-specific mandatory audit sections. | DLL audit findings (5 passes of edge cases/holes despite functional code) |
| v2.0 | 2026-04-15 | Structural overhaul: Complexity Assessment (Light/Standard/Heavy tracks). Self-adversarial review as default, second-model review optional. Deploy & Verify substep for integration phases. Class-level pattern scan in verification. Hot path definition + per-phase testing. Deviation count tracking as health metric. Debugging Protocol (structured failure recovery). Protocol Effectiveness Metrics. Minimum Viable Process (tiered step priority). Conditional Phase Report sections ([A]/[C]/[O] markers). Test type distinction (unit/integration/deployment). Split into core + full reference with extractable templates and case studies. | DLL post-build analysis: 6-commit Twilio debug chain, 51-query class-level fix, non-declining deviation counts, production-only failures despite 166 passing tests |
| v2.1 | 2026-04-15 | Seam and transition fixes from 3-mode simulation: Step 0 (Intake) for NEW mode — warm-start from existing materials. Step A7 (Re-entry) for AUDIT mode — explicit next-step guidance after remediation. Evolution Hardening Threshold — triggered at 5th Medium+ evolution, 3+ subsystem touches, Behavioral Core changes, or 6-month calendar. Mid-build reclassification rules for Complexity Assessment. Multiple concurrent evolutions guidance in E1. Template pointers in core reference. Session budget heuristics. | 3-mode simulation audit |

### What This Protocol Is NOT

- **Not a product spec template.** It doesn't tell you what to build — it tells you how to go from idea to built product systematically.
- **Not Claude Code documentation.** It doesn't explain how Claude Code works — it tells Claude Code how to work with you.
- **Not project-specific.** Nothing in here should reference a specific product. Project-specific rules belong in CLAUDE.md and docs/.
- **Not static.** If you're following it exactly as written 6 months from now without any changes, something is wrong — either the protocol is perfect (unlikely) or you stopped learning from projects.

---

*Build Protocol v2.1 — 2026-04-15*
*Derived from: Explain My Blood Test (931 commits), Do Later List (200K lines, 13 phases), Tax Auction (7 phases, 3 days), strategy-research framework*
