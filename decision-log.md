# Decision Log

> ADR-format decisions for Bob the Builder itself. Format per `templates/decision-log-entry.md`. Decisions are recorded once and not re-litigated — this is the audit-resistant memory of intentional non-goals and load-bearing tradeoffs.

The companion `audit-log.md` records *deferred* items (Defer verdicts that may still ship later). This file records *Reject* verdicts (intentional non-goals that should NOT be re-evaluated absent a fundamental shift in context).

---

### D-007: The Build-Integrity Loop — milestone audits are push-not-pull; the build never forgets (Rule 24)

- **Date:** 2026-06-24
- **Status:** Accepted (v2.30)
- **Context:** A continuation of the D-006 insight, generalized. Across a single InsiderIntent session the founder had to *manually* trigger: three cross-doc coherence audits (D-073/074/078), a 4-seat effectiveness panel ("given modern AI, is this the right capability set?"), a robustness sweep (signal symmetry / input-weighting / backend auditability), and a real-world benchmark (does our spec match/beat a real hedge-fund-13F writeup?). Each was high-value and each surfaced real gaps — but **every one was pull-based**: Bob had the capabilities (the A7 lens library, the Independent Audit Panel, Rule 20's unknown-unknowns sweep, the Reconcile/Phase-Gate/CTM machinery) yet they were **advisory**, so the non-engineer was the scheduler. Worse, nothing systematically guarded against *forgetting* — a capability planned in P1 or a binding decision (e.g. "no LLM numbers", "off-the-shelf-first") could silently drift by a later phase, invisible until someone re-read everything. Joe: *"how do we upgrade bob so these iterations happen automatically… do we have proper steps that ensure we build step-by-step, recursive audits at each milestone, propagate findings, and don't forget earlier steps or core decisions?"*
- **Decision:** Add **Rule 24 — the Build-Integrity Loop**, which makes the existing cadence **enforced + push-based** (not new parallel machinery — it *connects and enforces* Reconcile / Phase Gate / CTM / decision-log / A7 / Rule-23): **(a)** a **trigger→audit map** (doc-edit → coherence sweep · phase-boundary → Anti-Forgetting Gate + mandatory Curated lens panel · named-gate → effectiveness panel re-fired + Rule-20 expert-demand checklist + real-world benchmark + full coherence audit), tracked in `audit-ledger.json` that **gate-blocks** until done-or-deferred-with-reason; **(b)** an **Anti-Forgetting Gate** at every phase boundary that mechanically re-checks CTM-diff (no capability silently dropped), decision-honor (build still honors every live decision), and finding-propagation (findings scanned backward); **(c)** tooling — `coherence-check.sh` gains a **class-7 code/contract scan** (closing the .md-only blind spot that let `event.ts` and `schema.sql` drift) and is wired as a **git pre-commit hook**. Rule 20 gains a real-world-benchmark frame + a "re-run at each milestone" clause.
- **Alternatives considered:** (1) *Leave the cadence advisory and rely on the human* — rejected: that IS the failure mode (the founder-as-scheduler). (2) *A heavyweight always-on agent that re-audits everything every turn* — rejected as over-build (Rule 16/17) and token-ruinous; the right shape is *triggered* audits scoped to the milestone, mechanical-first. (3) *Make the script fully verify contracts-match-spec* — rejected: that's semantic (the script can't know the spec says "Event gains X"); the honest division is script-harvests-mechanical (retired terms, §-refs, contiguity) + a gate-prompt for the human/AI to reconcile the semantic rest.
- **Dogfood note:** the class-7 scan, run once on InsiderIntent, immediately found a stale `§2.4` and a dropped-`@ai-spine-core` residue in `contracts/schema.sql` that three prior `.md`-only coherence audits had all missed — validating both the gap and the fix.
- **Origin:** Joe, InsiderIntent build, 2026-06-24.

---

### D-006: Living-doc coherence is a triggered, mechanical sweep (Rule 23 + coherence-check.sh)

- **Date:** 2026-06-24
- **Status:** Accepted (v2.29)
- **Context:** The InsiderIntent dogfood exposed a *recurring* version of the drift problem. Two consecutive sessions each needed a **manual** full cross-doc sync audit: D-073 ("propagate D-058→D-072 everywhere") and then D-074, which caught drift D-073's own grep-sweep missed (the Ask-AI tier was renumbered P4→P6 by the robust-first roadmap, propagated everywhere *except* the Behavioral Core; plus a dangling `§2.4` cross-ref, version-summary lag, and index docs still saying "synced through D-072"). The human had to *notice* the drift and *call* the audit both times. Bob already had the concept (Pre-Build-Gate 6.5a lens 1 "internal consistency & drift"; the spec-phase consolidation pass), but it was **pull-based** (fires at a gate or on a growth trigger) and **manual** (hand-grepping), so a living spec set silently accumulates drift between gates and the non-engineer ends up being the drift detector. Joe: *"seems like I'm manually doing a lot of checks and edits that should be part of the Bob NEW build process."* (Bob's own docs had the same disease — the full-protocol rule list stops at 15 while 16–22 live only in the core ref; its changelog table stops at v2.16.)
- **Decision:** Add **Rule 23 + `scripts/coherence-check.sh`**. Coherence becomes **push-based and tooled**: (a) any change to a *shared identifier* restated across docs (version number, phase ID, decision ID, capability/subsystem code, section anchor §) must propagate to every reference in the *same* edit; (b) a **Coherence Sweep** runs on a trigger — every living-doc version bump, every decision-log entry, every phase/code renumber, and as Pre-Build-Gate lens 1 — invoking the script *first* so the human never hand-greps. The script (macOS bash-3.2-portable, zero deps) harvests the mechanical drift classes (decision-log contiguity + highest-ID-vs-"synced-through" claims, version-string drift, §/D/P cross-ref inventory, snapshot-filtered retired-term residue, dated docs missing a snapshot banner), hard-failing only on contiguity gaps/dupes; everything else is a review list. The script harvests; the AI/human judges the semantic rest (is a §-ref pointing at the *right* section).
- **Alternatives considered:** (1) *Fold into the existing consolidation pass / gate lens only* — rejected: that's where it already nominally lived, and it still required a human to call it; the lesson is that it must be *triggered* and *mechanical*, which warrants its own rule + tool. (2) *A fully-automatic semantic coherence checker* — rejected as over-build (Rule 16/17): cross-ref *validity* and contradiction-detection are genuinely fuzzy; the right division is script-harvests-mechanical-classes, AI-judges-semantics, which is exactly what the two manual audits did by hand. (3) *Make retired-term residue a hard fail* — rejected after dogfooding: too many false positives (lines that name a retired term precisely to retire it); demoted to a snapshot/retirement-context-filtered review list.
- **Origin:** Joe, InsiderIntent NEW-mode build (D-073 → D-074), 2026-06-24.

---

### D-002: A mandatory Pre-Build Review Gate (machine audit + human sign-off) before any product code

- **Date:** 2026-06-23
- **Status:** Accepted (v2.28)
- **Context:** The InsiderIntent dogfood exposed a serious protocol hole: Bob ran Steps 1–6 (all five spec docs, including a thorough spec, behavioral core, architecture contract, domain specs, build manifest) and then **slid straight into writing product code with no intentional stop** — no fresh-context machine audit of the whole doc-set/plan, and no plain-language human recap/sign-off. The founder had to notice ("are we already in build phase? did we do a full audit of the build plan?") and call the audit himself. That audit then found real bugs in the just-written code (a tautological data-quality check, a wedge-signal miscount) AND structural plan gaps (no engagement-observation gate, mis-sequenced phases) — exactly the class of problem a pre-build gate exists to catch *before* code. The spec→code boundary is the least-reversible transition in the protocol; mistakes there compound through every later phase, and the post-build hardening audits (Step N+1) are too late.
- **Decision:** Add **Rule 22 + Step 6.5 — a MANDATORY Pre-Build Review Gate**: (a) a fresh-context, multi-lens **machine audit** of the complete document set + build plan (consistency/drift, foundation-first sequencing, table-stakes-in-plan, data-quality, domain-expert POV, AI-nativity) producing a written findings doc, run *before* the first line of product code; and (b) an affirmative **human recap & sign-off** — a plain-language recap of what will be built, the phase plan, decisions, open questions, and audit findings, with an explicit invitation to review/tweak. Build (Step 7) cannot begin until the user affirmatively approves; a generic earlier "continue/proceed" does not count. **The gate is announced to the user up front at mode selection** so they expect a deliberate stop before building.
- **Alternatives considered:**
  - *Rely on the existing per-phase reconcile + the post-build hardening audits.* Rejected — those are mid/post-build; they cannot prevent a bad foundation or a mis-sequenced plan from being built in the first place. The whole point is to catch it before code.
  - *Make it a soft recommendation rather than a hard rule.* Rejected — the failure mode is precisely momentum overriding good intentions ("the specs feel done, the user said proceed"). Only a hard, announced, affirmative-approval gate resists it.
  - *Fold it into Step 6 (Project Setup) auto-advance.* Rejected — auto-advance is what caused the slide. The gate must be a deliberate, non-auto-advanced stop.
- **Consequences:** Every NEW build now has one unmissable, plain-language review checkpoint before code — the non-engineer's real chance to review/tweak the entire plan. Adds one gate; removes a whole class of foundation-and-sequencing mistakes. AUDIT mode's lens library is reused for 6.5a (no new machinery). Origin retro: `retros/insiderintent-dogfood-2026-06-18.md` (extended).

### D-001: Bob does not adopt influence patterns from Plandex / Roo Code / goose / Continue.dev

- **Date:** 2026-05-20
- **Status:** Accepted
- **Context:** v2.13 audit finding F13 (A7f Capability Gap, fresh competitor scan). v2.11's scan covered Spec Kit, Cursor rules, BMad, Aider, and Cline. The v2.13 re-scan surfaced four entrants worth at least listing: **Plandex** (persistent structured plans), **Roo Code** (Cline fork with custom modes — closest architectural parallel to Bob's NEW/AUDIT/EVOLVE pattern), **goose** (Block's agent runtime with session checkpoints), **Continue.dev** (context-prep + chat extension).
- **Decision:** We will NOT incorporate features or framings from these tools into Bob v2.13. None of them change Bob's "right thing to build" decisions for its target user (a non-engineer product leader building real products with Claude Code).
- **Alternatives considered:**
  - *Adopt Roo Code's custom-modes pattern as inspiration for additional Bob modes.* Rejected — Bob's three modes (NEW / AUDIT / EVOLVE) carry methodology weight, not just prompt scaffolds. Adding modes for the sake of variety would dilute, not deepen.
  - *Adopt Plandex's persistent structured plans.* Rejected — Bob's Build Manifest + Phase Reports already capture what plans capture, with more context (decisions, deviations, rollback).
  - *Adopt goose's session checkpoints.* Rejected — Bob's Pulse Report + handoff notes pattern (see Joe's CLAUDE.md multi-machine model) already cover this for the target user.
- **Consequences:**
  - We accept that Bob will not be the "most feature-rich" agent-protocol product in any single dimension. Bob's competitive differentiation is the **methodology depth** (5-doc hierarchy + audit modes + non-engineer narration) — not feature parity.
  - If a future audit pass surfaces a *specific* pattern from one of these tools that addresses a *specific* gap Bob can't solve another way, that ADR should reference this one as the supersession baseline.
- **Revisit trigger:** Any one of these tools ships an *external-fit-style audit step* (the closest competitor to Bob's A7f–A7h). That would be a genuine architectural overlap worth re-evaluating.
- **2026-05-20 addendum (v2.16):** The original Reject was scoped to **strategic positioning** — *should Bob's identity become like theirs?* — and that verdict stands unchanged. The v2.16 EVOLVE pass introduced a distinct sub-audit (A7f-implementation) that asks a different question: *are there specific MECHANISMS in those Rejected tools worth borrowing as discrete patterns?* The first run of A7f-implementation on the same 9 tools produced 3 mechanism-level Adopts (per-feature folder, plan-mode hard gate, sharded rules files) — see audit-log v2.16 entry. **Strategic Reject ≠ mechanism Reject.** This ADR's identity-level verdict is unchanged; future audits should use A7f-implementation for the mechanism question and not re-litigate the identity question logged here.

---

### D-003: A7j Liveness Audit orchestrates incumbent OSS tools instead of building custom

- **Date:** 2026-05-20
- **Status:** Accepted
- **Context:** v2.14 added A7j Liveness Audit to catch silently-broken runtime code (functions that pass static review but throw on first invocation). The natural temptation was to build a custom liveness runner inside Bob — a Bob-flavored test harness, a Bob-flavored route enumerator, a Bob-flavored AI smoke checker. The alternative is to point A7j at well-established OSS tools with mature CLI + JSON-reporter interfaces and let Bob orchestrate them.
- **Decision:** A7j orchestrates incumbents. Bob does not implement any of:
  - Dead-code detection (use **Knip** for JS/TS, **Vulture** + **Ruff** + **deptry** for Python)
  - HTTP endpoint fuzzing from a schema (use **Schemathesis**)
  - Browser flow smoke (use **Playwright**)
  - Function-level smoke harness (use **Vitest** / **pytest**)
  - LLM surface smoke (use **promptfoo**)
- **Alternatives considered:**
  - *Build a custom Bob liveness CLI that abstracts all five tools behind one interface.* Rejected — the abstraction would lag the underlying tools (Knip ships a new release every few weeks; Bob can't keep up), be a maintenance tax with no proportionate value, and create a "Bob lock-in" feel that contradicts Bob's stance as a methodology, not a tool.
  - *Build only the orchestration layer (a script that runs all five tools and merges JSON outputs).* Considered — eventually appropriate, but not in v2.14. The protocol prose tells Claude exactly which tool to invoke and how; that's enough orchestration for now. Revisit if external users self-report this as friction.
  - *Pick one tool per stack and require it.* Rejected — different projects already have different tools wired up; Bob should adapt to what the user has, not impose a particular vendor.
- **Consequences:**
  - A7j's quality is bounded above by the quality of the underlying OSS tools. When Knip improves, Bob improves for free. When (e.g.) Schemathesis drops support for a spec format, A7j inherits the limitation.
  - The protocol prose at [N+1]j must keep tool recommendations current. If one of the cited tools dies (as ts-prune did before v2.14), the protocol needs an audit pass to update.
  - Users running A7j must install the relevant tools first. The protocol could add a one-shot installer script as future work; deferred (audit-log F27).
  - Bob's "do not reinvent" principle is now explicit in a decision, not just an implicit norm. Future audits proposing custom tooling for similar problems should reference this ADR.
- **Revisit trigger:** Either (a) one of the cited incumbents becomes unmaintained without a clear successor, OR (b) multiple PR-back reports cite tool-orchestration friction as the biggest A7j pain point.

---

### D-004: Bob projects use a single rules file (CLAUDE.md), not sharded rules with glob-scoped activation

- **Date:** 2026-05-20
- **Status:** Accepted
- **Context:** v2.16 dogfood pass (A7f-implementation scan) flagged sharded rules files with YAML frontmatter scoping (Cursor `.cursor/rules/*.mdc`, Continue `.prompt`, Cline `.clinerules`, Roo `.roomodes`, goose `.goosehints`, BMad templates) as the **strongest single Adopt** in the entire run — 5 of 9 tools converged on this exact mechanism. Initially deferred as F35 pending a discrete EVOLVE pass. On user review, Joe rejected the premise: *"not sure why anyone would deviate from a single rules file."*
- **Decision:** Bob projects keep a **single CLAUDE.md** as the agent's rules surface. We will NOT shard into `.claude/rules/*.md` with glob-scoped activation, even though tool convergence suggests it.
- **Alternatives considered:**
  - *Mirror Cursor's `.cursor/rules/*.mdc` shape with `description` + `globs` + `alwaysApply` frontmatter.* Rejected — the sharded model assumes a project large enough that monolithic rules pollute context; Bob's target user (non-engineer product leader) ships single-purpose products where a slim CLAUDE.md (the protocol already mandates <150 lines) fits comfortably as always-on context. Splitting it adds cognitive overhead (where does this rule go?) without proportionate benefit.
  - *Document a Bob-flavored sharding convention.* Rejected — would violate D-003 ("orchestrate, don't reinvent") because the underlying tool (Claude Code) doesn't have native scoped-rule machinery in the same shape, so we'd be inventing a Bob-specific format.
  - *Wait until projects accumulate enough rules that CLAUDE.md becomes painful.* Rejected as the trigger — by then we'd be migrating a convention rather than designing one. If pain ever shows up, the response is "prune CLAUDE.md," not "shard it."
- **Consequences:**
  - The dogfood meta-finding gets a stronger anchor: **convergence across tools ≠ Adopt for Bob.** F35 is now the canonical example — a mechanism that 5 of 9 tools share, that Bob still rejects because the target user is different. Future scans surfacing convergence-Adopts should reference D-004 as the reminder that field convergence is signal, not verdict.
  - The "single rules file" stance is now load-bearing for Bob's design. Step 6a's CLAUDE.md template stays monolithic; the <150-line elimination test ("Would Claude make a mistake without this?") becomes the maintenance discipline rather than sharding.
  - We accept that Bob projects with unusually large rule sets *may* eventually want sharding — but at that point the project has already outgrown Bob's target shape, and the right answer is to question the rule-set growth, not to add sharding ergonomics.
- **Revisit trigger:** A Bob user reports that their CLAUDE.md exceeded 300 lines without obvious prunable content, and the rule bloat is materially hurting their session quality. Until then, this is the Bob position.

---

### D-002: Bob does not maintain a full Capability Traceability Matrix for itself

- **Date:** 2026-05-20
- **Status:** Accepted
- **Context:** v2.13 audit finding F23. Bob mandates a CTM in Step 5a-ii for any code product, and the v2.13 audit flagged that Bob (a markdown methodology product + 3 shell scripts) doesn't have one for itself. The mirror question was raised: should Bob eat its own dog food here?
- **Decision:** We will NOT maintain a full CTM for Bob itself. The CTM exists to prevent capabilities silently falling between specs and code in a multi-subsystem product. Bob has no subsystems in that sense — the protocol is a single document, the scripts are tiny and exhaustively grep-able, and there is no "Phase N" build cadence to map capabilities into.
- **Alternatives considered:**
  - *Build a minimal CTM mapping Bob's modes (NEW/AUDIT/EVOLVE) and major sections to the markdown anchors that define them.* Rejected — this would be a list of headings, not capability-traceability. The cost (maintenance) exceeds the value (none — nothing is at risk of falling through).
  - *Build a CTM only for the scripts.* Rejected — three scripts × ~100 lines each is below the threshold where CTM helps.
- **Consequences:**
  - The deferred-item register lives in `audit-log.md` rather than as a CTM column. That's the lightweight equivalent appropriate to Bob's shape.
  - We accept the slight inconsistency of Bob mandating-but-not-having a CTM. The protocol prose at Step 5a-ii now references `templates/capability-traceability-matrix.md` and the template explicitly addresses *code products* — readers of the protocol applying it to a methodology product would self-route to "skip per Light track."
  - The Light track in the Complexity Assessment already permits skipping the CTM for `<3` subsystems. Bob is comfortably below that threshold.
- **Revisit trigger:** Bob grows to multiple subsystems (e.g., a hosted dashboard, a telemetry pipeline, a marketplace of community-contributed templates). At that point, CTM becomes load-bearing.

---

### D-005: The Lens Retro loop surfaces lens edits — it never commits them. Bob does not auto-edit its own lenses.

- **Date:** 2026-05-25
- **Status:** Accepted
- **Context:** v2.18 added the Audit Self-Learning Loop (auto-emitted lens retros + `scripts/lens-retro.sh` aggregation). The obvious next step — and the one Joe explicitly raised as a possibility — is *full* automation: Bob reads accumulated retros and rewrites its own lens prompts without a human in the loop. The retro JSONs are structured; an agent could mechanically apply the highest-frequency change-requests. Joe asked for the semi-automatic version (auto-emit + flag) and we deliberately stopped there.
- **Decision:** Bob's lens-retro loop is **surface-only**. `scripts/lens-retro.sh` flags review candidates; Bob proposes specific edits; a **human supplies the verdict**; approved edits go through a normal EVOLVE + F47 dogfood. Bob will NOT auto-edit, auto-merge, or auto-ship changes to its own lens prompts from retro signal.
- **Alternatives considered:**
  - *Auto-apply change-requests above a frequency threshold (e.g., "3+ retros agree → edit the lens").* Rejected — this is precisely the D-004 / F35 failure mode. In v2.16, 5 of 9 surveyed tools converged on sharded rules files (the single strongest mechanical signal in the whole scan); Joe correctly rejected it anyway on higher-order judgment. **Convergence across sources is signal, not a verdict.** An auto-apply rule would have shipped F35. The human filter is the load-bearing part, not the aggregation.
  - *Auto-draft a PR that a human merges.* Considered, deferred — closer to acceptable because a merge gate preserves the human verdict, but it adds CI/PR machinery that contradicts Bob's prose-driven, low-infrastructure stance (D-003) and isn't worth it until retro volume is high. Revisit if retro volume ever justifies it.
  - *Convergence-to-mediocrity risk.* Lens prompts are load-bearing (~7,200 lines of curated content synthesized from 46+ sources). Auto-editing toward whatever the average retro complains about would sand off the distinctive lenses (L01 Liveness, L02 Spec Fidelity, L03 Critical Capability Quality, L28 Wedge) precisely because they're unusual — the same anti-convergence logic L28 applies to product features applies to Bob's own lenses.
- **Consequences:**
  - The loop's improvement cadence is gated on a human running the ritual (`_lens-retro.md` §B). That is intentional friction, not a missing feature.
  - Retros accumulate even when nobody acts on them, so signal isn't lost between rituals — the cost of the human gate is latency, not data loss.
  - If a future contributor proposes "let Bob improve its own lenses automatically," this ADR is the answer: surface, yes; commit, no.
- **Revisit trigger:** Retro volume grows large enough (e.g., dozens per quarter from external users) that human triage becomes the bottleneck AND a PR-with-human-merge-gate is built. Even then, the human merge verdict is non-negotiable — only the *drafting* would automate.

---

### D-006: From the Spec Kit `/clarify` scan, Bob adopts the coverage taxonomy only — not ID-traceability or CLI machinery

- **Date:** 2026-06-16
- **Status:** Accepted
- **Context:** v2.25 (evolution 003) harvested GitHub Spec Kit's `/clarify` command after a Bob-vs-Spec-Kit deep comparison. `/clarify` bundles four mechanisms: (1) a fixed ambiguity taxonomy, (2) capped recommended-default questioning, (3) incremental write-back, and (4) — via the sibling `/analyze` command — stable `FR-###`/`SC-###` requirement IDs mapped to tasks for zero-coverage detection. Spec Kit also ships a `specify` CLI with self-upgrade and a YAML extension-hook system.
- **Decision:** Bob adopts mechanisms (1)–(3) into Step 1b (the Coverage Taxonomy + capped resolution + write-back to existing artifacts). Bob does **NOT** adopt: the FR/SC ID-traceability + task-coverage map, nor any CLI / extension-hook / self-upgrade machinery.
- **Alternatives considered:**
  - *Adopt FR-###/SC-### IDs with a task-coverage map.* Rejected — Bob already covers requirement→phase→test traceability via `templates/capability-traceability-matrix.md` (Step 5a), the L02 Spec-Fidelity lens, and mandatory Reconciliation. Adding a parallel ID scheme in Step 1b would be two sources of truth for the same concept — a direct Single-Source-of-Truth violation and exactly the kind of sprawl the v2.17 meta-finding warns against.
  - *Adopt the `specify`-style CLI + extension hooks.* Rejected — this is **distribution machinery, not methodology**. Bob is a prose-driven Claude Code skill for one non-engineer; a versioned CLI with pluggable YAML hooks solves a multi-agent-portability / community-contribution problem Bob doesn't have. This is the same call as F35 (sharded rules, D-004): the mechanism scan can surface it, the human still rejects it.
- **Consequences:**
  - Step 1b gains a coverage *checklist* but not a coverage *ledger* — there is no machine-checkable "every requirement has a task" gate at spec time. That gate lives later (Step 5a matrix + Reconciliation), by design. If a future project shows requirements silently dropping between spec and build *despite* the matrix, revisit whether ID-tagging at Step 1b would help — but only as a supersession of this ADR, not a quiet addition.
  - Bob stays CLI-free and low-infrastructure (consistent with D-003). If Bob is ever productized for external users (the "Bob as a public tool" question), Spec Kit's CLI/extension model is the documented blueprint to revisit — but that is a strategic decision outside any single evolution.
- **Revisit trigger:** (a) requirements demonstrably leak between spec and build despite the Step 5a matrix; or (b) a deliberate decision to make Bob a public, multi-agent-portable product.

---

## Anti-pattern reminder

ADRs that describe the decision without consequences are useless. The Consequences section is where future-you discovers why the seemingly clever shortcut is the thing now blocking a new requirement. Every decision in this file has a Consequences block — keep it that way.
