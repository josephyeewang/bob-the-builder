# Case Study: Tax Auction

**Timeline:** ~3 days
**Approach:** Comprehensive upfront specs + 7 sequential phases

## What Happened
- 7,593 lines of specs → 7,090 lines of code in 3 days
- Spec held with no deviations during build
- Clean execution — the best project in terms of process discipline
- 1 critical audit found real issues: 74 parcel misclassifications

## What Went Well
- Comprehensive specs + sequential phases = cleanest execution of all projects
- Near 1:1 spec-to-code ratio shows specs were right-sized
- No mid-build spec changes needed
- Fast: 3 days from spec to working product

## Key Failure Modes
1. **Post-build audit still necessary** — even with perfect spec adherence, the audit found 74 real data misclassifications
2. **No deployment validation** — data quality issues only visible when examining real output

## Lessons Extracted
- Comprehensive upfront specs + sequential phases is the gold standard for execution
- Even "perfect" builds need auditing — specs can be correct and complete but still miss edge cases in real data
- Simpler projects (7 phases, 3 days) can follow a lighter process than complex AI products

## What This Triggered in the Protocol
- Confirmed that spec-first + sequential execution is the right approach
- Supported the case for mandatory hardening audits even when builds go smoothly
- Influenced the Complexity Assessment (Light/Standard/Heavy tracks) — this project would be Light or Standard track
