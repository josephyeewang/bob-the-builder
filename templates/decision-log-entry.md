# Decision Log Entry Template (ADR format, v2.7)

> Use this format for every entry in `docs/decision-log.md`. Adapted from Michael Nygard's Architecture Decision Record (ADR) pattern — the industry standard for recording non-obvious decisions.
>
> Include any decision where you: deviated from a spec, chose a library or tool, changed the data model, changed an API route, changed AI behavior, deferred a feature, or made a non-obvious tradeoff. If a future reader would ask "why did they do it this way?", it deserves an ADR.

---

### D-XXX: [Decision Title — short, declarative, present tense]

- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Deprecated | Superseded by D-YYY
- **Context:** What problem, situation, or trigger forced a decision? What constraints or facts apply? (Include any relevant Bob step — e.g., "raised during Step 3a Architecture Contract review.")
- **Decision:** What we chose. Stated as an action: "We will use X" — not "X seems good."
- **Alternatives considered:** What else was on the table, with a one-line "why not."
- **Consequences:** What follows from this choice — good, bad, and neutral. What constraints are now imposed on future decisions? What downstream specs, contracts, or code does this affect?
- **Revisit trigger (optional):** What would make us reconsider? (E.g., "if cost per active user exceeds $X", "if Vercel changes pricing", "if we add a second LLM provider.")

---

## Status values

- **Proposed** — decision drafted, not yet ratified. Don't act on it until Accepted.
- **Accepted** — current load-bearing decision. Code, specs, downstream choices depend on it.
- **Deprecated** — no longer applies but not actively replaced (e.g., feature being deleted).
- **Superseded** — overturned by a later ADR. Link back: `Status: Superseded by D-042`. Never delete superseded entries — they're the audit trail.

## Anti-pattern

ADRs that describe the decision without consequences. The Consequences section is where future-you discovers why the seemingly clever shortcut is the thing now blocking a new requirement.
