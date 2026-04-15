# Case Study: Do Later List (DLL)

**Timeline:** April 2026
**Approach:** Comprehensive upfront specs + 13 sequential build phases

## What Happened
- 21 spec documents, ~640KB of specifications
- 200K+ lines of code across 13+ build phases
- Copy-paste prompt execution (before protocol existed)
- Specs written comprehensively upfront but never updated during build
- 50+ items per audit pass x 5 audit passes at hardening
- 24 major decisions logged in decision-log.md

## What Went Well
- Upfront specs were comprehensive and high quality
- Sequential phase execution produced clean, working code per phase
- Architecture patterns (normalized I/O, single orchestration entry point) held throughout
- 12 global invariants maintained across all phases
- Provider abstractions enabled flexibility

## Key Failure Modes
1. **Write-once specs** — specs written upfront but never updated during build, leading to spec-code divergence by Phase 8
2. **No propagation enforcement** — changing one spec didn't trigger updates to downstream specs
3. **Copy-paste execution** — manual, fragile, context lost between prompt pastes
4. **Late cross-cutting discovery** — 5 audit passes found edge cases, missing rate limits, abuse vectors, integration seam mismatches after all code was written
5. **Phase-isolated verification** — each phase checked "does this work?" but never "does this interact safely with everything else?"
6. **Production-only failures** — 6 commits to debug Twilio webhook verification that only failed on Vercel (166 tests all passed locally)
7. **Class-level bugs** — .single() → .maybeSingle() fix required changing 51 queries (same pattern, discovered in one spot)
8. **Non-declining deviations** — 3-7 spec deviations per phase, count never decreased over 13 phases

## Lessons Extracted
- Upfront specs are necessary but NOT sufficient — mandatory reconciliation after every phase is the missing piece
- Propagation enforcement prevents downstream rot when specs change
- Cross-cutting concern scanning must happen every phase, not just at hardening
- Deploy & verify is mandatory for phases with external integrations — "it compiles" is not "it works"
- Class-level pattern scanning prevents one bug from hiding in 50 other locations
- Deviation count is the best leading indicator of build quality — track it

## What This Triggered in the Protocol
- Mandatory reconciliation ([N]c step)
- Propagation enforcement after every spec change
- Per-phase cross-cutting concern scan (v1.2)
- Deploy & verify substep (v2.0)
- Class-level pattern scan (v2.0)
- Hot path definition and per-phase testing (v2.0)
- Deviation count tracking (v2.0)
- Debugging Protocol (v2.0)
- Anti-patterns: "Write-once specs", "Late cross-cutting discovery", "Phase-isolated verification" (Appendix A)
