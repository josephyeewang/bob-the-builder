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
