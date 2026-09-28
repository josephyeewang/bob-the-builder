---
id: L03
name: Critical Capability Quality
band: 1
band_name: Engineering Foundation
when_to_run: Always when a Spec Fidelity (L02) census has been run. Skip if no capability census exists yet. Mandatory before any launch milestone.
estimated_duration: 60-120 min — requires per-capability code reading and grading
session_pattern: fresh session; reads L02 (Spec Fidelity) as mandatory input
output_markdown: audit-artifacts/L03-critical-capability-quality-{YYYY-MM-DD}.md
output_json: audit-artifacts/L03-critical-capability-quality-{YYYY-MM-DD}.json
source_frameworks:
  - DLL "Slice 2" critical features audit (Joe Wang, 2026-05-23) — empirical anchor
  - ISO 25010:2023 functional suitability (completeness + correctness + appropriateness)
  - SonarQube Reliability + Security ratings (A-E)
  - Bob's existing CTM H / H++ badge pattern
---

# L03 — Critical Capability Quality

## Question this lens answers

*For the 30-50 most critical capabilities, is each one A-grade work — wired, robust, error-pathed, complete — or is it B-grade / hollow / unwired / silently degraded?*

## Why this lens exists / what other lenses miss

L01 says "exists and runs." L02 says "matches the spec." Neither says *"is it any good?"* A capability can pass L01 (executes without throwing) AND pass L02 (matches the spec claim) and still be B-grade work — wired in only one direction, missing error handling, defaulting silently when it shouldn't, lacking the subtle behavior that makes the capability actually useful.

The DLL audit found this pattern repeatedly:
- Memory decay engine exists, exported, but `processMemoryDecay` never scheduled — will silently hit 500-record cap.
- 3-strike overdue management has a counter but never prompts "still want this?" — escalation MISSING.
- "done" only completes last task, no keyword matching ("done air filter" fails).
- Recommendations append silently with no separator — user can't tell what's their task vs DLL's suggestion.
- Snooze without a time silently defaults to 7 days.

None of these are spec gaps (the spec said the capability would exist) or engineering failures (the code runs). They're *quality* gaps. This lens grades them.

## When this lens fires

**Always-in-Full-Enchilada.** Curated panel inclusion criteria:
- ✅ Always — when L02 has produced a capability census.
- ✅ Mandatory — before any launch milestone, major version, or hand-off (investors, partners, public users).
- ⏸ Skip — only if L02 hasn't run yet (run L02 first; the census is L03's input).

## Session setup

- Start a **fresh Claude Code session.**
- Mandatory input: L02 Spec Fidelity report (most recent). Without it, L03 doesn't know which capabilities to grade.
- Inputs to load:
  - L02 markdown report — the BUILT + PARTIAL capability list
  - L01 markdown report (if available) — verifies what's runnable
  - Product Spec — for stated importance / criticality of capabilities
  - Code — read for grading; this lens does NOT execute code (L01 does)
- No tooling install required. Pure code-reading + grading.

## Source frameworks

- **DLL "Slice 2" critical features audit** (Joe Wang, 2026-05-23) — empirical anchor. Methodology: identify 30-50 critical capabilities, grade each on the dimensions of wired-ness, robustness, error paths, defaults, completeness.
- **ISO 25010:2023 Functional Suitability** — completeness (does it do everything needed), correctness (does it produce right results), appropriateness (does it fit the user's task). https://www.iso.org/standard/78176.html
- **SonarQube Reliability + Security A-E ratings** — the A-E grading pattern adapted to capability quality. https://docs.sonarsource.com
- **Bob's existing CTM H / H++ badge pattern** — H = hardened internally, H++ = hardened internally + externally. L03 grades inform the H badge.

## Audit method

1. **Identify the critical 30-50 capabilities.** Pull L02's BUILT + PARTIAL list. From that, identify the 30-50 most critical — by user-impact (used most often), revenue-impact (gates monetization), strategic-impact (core to the wedge), or load-bearing-impact (other capabilities depend on it). If the BUILT list has <30 capabilities, grade all of them.

2. **For each critical capability, grade across 5 dimensions:**
   - **Wired-ness** — is it reachable from the user-facing path it should be reachable from? Wired in both directions if the spec implies a round-trip?
   - **Robustness** — does it handle the obvious failure modes (empty input, malformed input, partial input, concurrent invocation)?
   - **Error paths** — when it fails, does it fail gracefully (clear error to user, structured error to logs) or silently/noisily-wrong?
   - **Defaults** — are silent defaults safe? (Spec says "snooze with optional time" → does empty-time default to a sane value WITH user visibility, or silently default to 7 days as in DLL?)
   - **Completeness** — does it do everything implied by its capability claim, or only the obvious half?

3. **Assign letter grade A-D-F per capability:**
   - **A** — solid on all 5 dimensions. Ship-ready.
   - **B** — solid on 3-4 dimensions, weak on 1-2. Functional but improvable.
   - **C** — solid on 1-2 dimensions, weak on the rest. Capability exists but is hollow / brittle / partial.
   - **D** — Wired but most other dimensions failing. The "exists in name only" pattern.
   - **F** — Capability claim is misleading; what's there doesn't deliver what's promised.

4. **Identify "hollow capabilities."** Capabilities graded C-F where the spec promise vs delivered substance creates active trust damage. DLL's `undo` is the archetype: spec told users they could say "undo," code never implemented it — users typing "undo" create a literal task titled "undo." That's worse than missing; that's deceptive.

5. **Identify "silent default" findings.** Cases where the code makes a decision the user wouldn't expect with no visibility. Snooze defaulting to 7 days, "done" matching only the last task, recommendations appending without separator. These are individually minor but cumulatively erode trust.

6. **Identify "unidirectional wiring" findings.** Capabilities the spec implies are bidirectional but code only handles one direction. (DLL: 3-strike overdue counter increments but never prompts.)

7. **Rank top 3 quality-degrading findings.** Not all C/D/F's are equally bad. Rank by: user-impact × frequency × trust-cost.

## Check questions

1. Have you identified 30-50 critical capabilities (or all BUILT capabilities if <30 exist)?
2. For each capability, have you graded across all 5 dimensions (Wired / Robust / Error paths / Defaults / Completeness)?
3. For each Grade-C or worse capability, can you state the SPECIFIC weak dimension (not just "weak")?
4. Are there "hollow capabilities" — capability claims that exist in source but deliver materially less than promised?
5. Are there "silent defaults" — code making decisions without user visibility that would surprise the user?
6. Are there "unidirectional wirings" — capabilities the spec implies are round-trip but code is one-way?
7. For each Grade-B+, is the upgrade path clear (specific code change to elevate to A)?
8. Are there capabilities where the spec is right and the code is wrong (raise code quality) vs where the code is right and the spec was over-promising (prune spec)?
9. What's the single highest-leverage quality upgrade? (One capability, one change, biggest jump in user-perceived quality.)
10. Are there capabilities that exist robustly but are wired to *no user path* (orphan but high-quality)? Flag for L02 follow-up.

## Output schema

### Markdown report

```markdown
# L03 — Critical Capability Quality — {YYYY-MM-DD}

## Critical capability list (with grades)
| # | Capability | Wired | Robust | Error paths | Defaults | Complete | Grade |
|---|---|---|---|---|---|---|---|
| 1 | Memory decay | A | A | A | B | B | B |
| 2 | Undo command | F | F | F | F | F | F (hollow / misleading) |
| 3 | Snooze | A | A | C | C | A | C (silent default) |

## Grade distribution
- A: X capabilities
- B: X
- C: X
- D: X
- F: X

## Hollow capabilities (Critical)
| # | Capability | Spec promise | Delivered reality | User-impact |
|---|---|---|---|---|

## Silent defaults
| # | Decision the code makes silently | Default chosen | Should it be visible? | Recommendation |
|---|---|---|---|---|

## Unidirectional wirings
| # | Capability | Direction implemented | Direction missing | Why this matters |
|---|---|---|---|---|

## Top 3 quality-degrading findings (ranked by user-impact × frequency × trust-cost)
1. ...

## Findings (full, severity-tagged)

## Stop conditions encountered
```

### JSON sidecar

```json
{
  "lens_id": "L03",
  "lens_name": "Critical Capability Quality",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "capabilities_graded": 0,
  "grade_distribution": {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0},
  "hollow_capabilities_count": 0,
  "silent_defaults_count": 0,
  "unidirectional_wirings_count": 0,
  "findings": [
    {
      "id": "L03-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "hollow|silent_default|unidirectional_wiring|brittle_error_path|incomplete_capability|spec_overpromise",
      "title": "{short}",
      "capability": "{name}",
      "grade": "A|B|C|D|F",
      "weak_dimensions": ["robustness", "error_paths"],
      "evidence": "{path:line}",
      "user_impact": "{1-sentence}",
      "recommendation": "{1-sentence}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric (calibrated to this lens)

- **Critical** — Hollow capability where the spec actively misleads users (e.g., DLL's `undo` — promise without implementation). Grade F. Or: Grade D on a high-frequency user-facing capability.
- **Major** — Grade C on a high-frequency capability, or Grade D on lower-frequency. Silent default with material trust cost. Unidirectional wiring on a spec-implied round-trip.
- **Minor** — Grade B with specific improvement opportunity. Silent default with low trust cost. Brittle error path on rarely-exercised capability.
- **Cosmetic** — Grade A capabilities with stylistic polish opportunities.

## Anti-patterns / Bias instructions

- **Do NOT grade more than 50 capabilities in one run.** Beyond that, grading fidelity drops. Pick the most critical 30-50; defer the rest to next audit cycle.
- **Do NOT grade capabilities you haven't read the code for.** Grading from spec alone is L02's job. L03 requires opening the code.
- **Do NOT confuse "could be better" with "is B-grade."** Grade by what exists today; improvement potential is separate from current grade.
- **Do NOT recommend "rewrite from scratch."** Almost every B/C capability has a specific 1-3 line improvement path. Recommendations should be surgical, not architectural.
- **Bias toward "would a user notice the gap in 24 hours?"** A capability with a hidden defect users will never encounter is closer to A than its dimension-score suggests. A capability with a visible defect users hit on first use is closer to D than its dimension-score suggests. User-encounter rate weights the grade.

## Stop conditions (the gap IS the finding)

1. **L02 has not been run.** Cannot proceed without a capability census. Run L02 first.
2. **L02 has run but BUILT list is empty.** Nothing to grade. Surface as a Spec Fidelity escalation — the product has spec but no implementation; that's an L02 critical, not an L03 run.
3. **Code is too large to grade 30 capabilities in one session.** Split by domain — one L03 run per domain spec. Do not produce a partial grading silently.

## Cross-lens handoff

- **Upstream:** L02 Spec Fidelity (mandatory input)
- **Downstream:**
  - **L08 UX Friction & Trust** — silent defaults and hollow capabilities are friction surfaces.
  - **L09 UX Wow** — Grade-A capabilities are peak candidates if not already amplified.
  - **L21 Observability** — Grade-D/F capabilities need extra observability so quality regressions are caught.
- **Adjacent (~15% overlap):**
  - **L02** — both grade capabilities, but L02 grades against spec (presence/absence), L03 grades against quality (well/poorly). Together they form a 2D grid.
