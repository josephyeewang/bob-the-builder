# Decision Log

> ADR-format decisions for Bob the Builder itself. Format per `templates/decision-log-entry.md`. Decisions are recorded once and not re-litigated — this is the audit-resistant memory of intentional non-goals and load-bearing tradeoffs.

The companion `audit-log.md` records *deferred* items (Defer verdicts that may still ship later). This file records *Reject* verdicts (intentional non-goals that should NOT be re-evaluated absent a fundamental shift in context).

---

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

## Anti-pattern reminder

ADRs that describe the decision without consequences are useless. The Consequences section is where future-you discovers why the seemingly clever shortcut is the thing now blocking a new requirement. Every decision in this file has a Consequences block — keep it that way.
