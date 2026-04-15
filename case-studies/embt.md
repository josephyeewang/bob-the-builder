# Case Study: Explain My Blood Test (EMBT)

**Timeline:** January–April 2026
**Approach:** Build-as-you-go (no upfront specs)

## What Happened
- 931 commits over 3.5 months
- ~70% of commits were fixes, not features
- ~60K lines of code
- 7 copies of one taxonomy (definition drift)
- Fix-after-fix chains: fixing one thing broke another

## Key Failure Modes
1. **No upfront specs** — requirements discovered during build, not before
2. **Definition drift** — same concept defined differently in multiple places (7 copies of one taxonomy)
3. **Fix-after-fix chains** — patches on patches, each introducing new issues
4. **Scattered behavioral logic** — AI decision logic spread across a 5K-line function, impossible to audit
5. **No tool rationale** — couldn't remember why tools were chosen, couldn't evaluate alternatives

## Lessons Extracted
- **Build-as-you-go produces massive churn.** Spec-first is definitively better.
- Behavioral logic needs a centralized document (Behavioral Core), not code comments.
- Tool decisions need written rationale (tool-decisions.md).
- Decision amnesia across sessions is real — use decision-log.md.

## What This Triggered in the Protocol
- Mandatory comprehensive upfront specs (Steps 1-5 in NEW mode)
- Behavioral Core as a first-class document
- Tool evaluation template and decision logging
- Anti-pattern: "Build-as-you-go" (Appendix A)
- Anti-pattern: "Scattered behavioral logic" (Appendix A)
