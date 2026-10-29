# APPENDIX A: ANTI-PATTERNS

> Moved word for word from `build-protocol.md` on 2026-10-29 (D-030), so each mode and each reference lives in its own file. `build-protocol.md` keeps this heading as a pointer, so older references to it still lead here. A reference here to another Part, Step or Appendix means that section of [`build-protocol.md`](../build-protocol.md) unless it says otherwise (if that heading is now a pointer, the file it names).


*Patterns observed across past projects that this process is designed to prevent.*

| Anti-Pattern | Observed In | What Goes Wrong | How This Process Prevents It |
|-------------|-------------|-----------------|------------------------------|
| Build-as-you-go | A real product build | Most commits are fixes; definition drift; fix-after-fix chains | Comprehensive specs upfront (Steps 1-5) |
| Spec inflation | Consumer task app | 14 overlapping docs; inconsistencies between them; maintenance burden | Layered hierarchy; each doc has one job |
| Write-once specs | Consumer task app | Specs never updated during build; 50+ items per audit pass | Mandatory reconciliation (Nc step) |
| Copy-paste execution | Consumer task app | Manual, fragile, context lost between pastes | Guided execution with human gates |
| Late auditing | Consumer task app, data-analysis tool | Errors compound through 13 phases before discovery | Inline verification (Nb step) per phase |
| Code volume explosion | Consumer task app (200K lines) | Surface area too large to audit effectively | Volume control; favor config over code |
| No tool rationale | Consumer AI app | Can't remember why tools were chosen; can't evaluate alternatives | tool-decisions.md with evaluation template |
| Scattered behavioral logic | Consumer AI app | Decision logic spread across 5K-line function; hard to audit or debug | Centralized Behavioral Core document |
| Decision amnesia | All | Re-litigating settled questions across sessions | decision-log.md; project memory |
| No cross-project learning | All | Same mistakes repeated in new projects | Learning extraction step; this Build Protocol |
| Late cross-cutting discovery | Consumer task app | 5 audit passes found edge cases, missing rate limits, abuse vectors, integration seam mismatches — all functional code, but holes everywhere at subsystem boundaries | Cross-cutting concern scan at EVERY phase (not just hardening); adversarial audit + integration seam audit at hardening |
| Phase-isolated verification | Consumer task app | Each phase verified "does this work?" but never "does this interact safely with everything else?" | Cumulative seam scanning; each phase checks its own + spot-checks one prior boundary |
