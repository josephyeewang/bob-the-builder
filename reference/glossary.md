# APPENDIX J: GLOSSARY (v2.3 — plain English)

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


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
