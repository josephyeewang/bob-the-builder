# Audit Memory — Persistent History + Entry Experience

> Joe will not remember what audits were run, when, or which lenses were used. Bob's audit memory makes that irrelevant — every AUDIT mode entry surfaces history + offers four options.

## Why audit memory matters

The realistic UX: Joe types "let's audit DLL" or invokes AUDIT mode. He does NOT remember which lenses ran last time. He does NOT want to choose from a 36-lens menu cold. He wants Bob to remind him + offer sensible choices.

This document defines:
1. The audit-history file format
2. The entry-experience template
3. The four selection options
4. The logic for default recommendations

## Files

| File | Purpose |
|---|---|
| `audit-artifacts/audit-history.json` | Machine-readable audit log; aggregation tooling reads/writes |
| `audit-artifacts/audit-history.md` | Human-readable mirror; Joe reads when curious |
| `audit-artifacts/audit-summary-{YYYY-MM-DD}.md` | Per-run summary (from `_aggregation.md`) |
| `audit-artifacts/L{NN}-{slug}-{YYYY-MM-DD}.md` | Per-lens report (one per lens per run) |
| `audit-artifacts/L{NN}-{slug}-{YYYY-MM-DD}.json` | Per-lens JSON sidecar |
| `audit-artifacts/audit-retro-{YYYY-MM-DD}.md` | Lens retro — critique of the lenses *as instruments* (v2.18; auto-emitted at A7.4). See `_lens-retro.md` |
| `audit-artifacts/audit-retro-{YYYY-MM-DD}.json` | Retro JSON sidecar; consumed by `scripts/lens-retro.sh`. `audit_run_id` links it to the run above |

## audit-history.json schema

```json
{
  "schema_version": "1.0",
  "project": "{name}",
  "runs": [
    {
      "run_id": "{uuid}",
      "date": "YYYY-MM-DD",
      "mode": "curated|full_enchilada|custom",
      "panel_name": "Panel B - B2B SaaS pre-launch",
      "lenses_run": ["L01", "L02", "L03", "L04", "L05", "L07", "L10", "L24", "L25", "L29"],
      "lenses_skipped_with_reason": [
        {"lens": "L09", "reason": "deferred; UX wow lens for post-activation"},
        {"lens": "L11", "reason": "no AI in product"}
      ],
      "findings_count": {
        "critical": 5,
        "major": 12,
        "minor": 17,
        "cosmetic": 8,
        "total": 42
      },
      "duration_hours": 2.5,
      "sessions": 3,
      "summary_artifact": "audit-artifacts/audit-summary-2026-05-23.md",
      "resolved_at_this_run": ["AGG-2026-05-06-001", "..."],
      "still_open_after_this_run": ["AGG-2026-05-23-007", "..."],
      "user_swaps_from_recommended": [
        {"recommended_lens": "L09", "swap_to": "L29", "user_note": "want activation now, wow next time"}
      ]
    }
  ],
  "all_open_findings_across_runs": [
    {
      "aggregate_id": "AGG-2026-05-23-007",
      "first_seen_run_id": "{uuid}",
      "first_seen_date": "YYYY-MM-DD",
      "severity": "major",
      "title": "...",
      "status": "open|fix_in_progress|deferred|rejected",
      "owner": "...",
      "target_date": "YYYY-MM-DD or null"
    }
  ],
  "deferred_with_revisit_triggers": [],
  "rejected_logged_in_decision_log": []
}
```

## Entry experience template

When AUDIT mode is invoked, Bob runs this sequence:

### Step 1 — Read history silently

```python
history = read("audit-artifacts/audit-history.json")
last_run = history.runs[-1] if history.runs else None
```

### Step 2 — Match project profile to a panel

(Per `_selection-rubric.md`.)

### Step 3 — Compute the default recommendation

```
if no last_run:
    default = "Curated (first audit, profile-matched)"

elif days_since_last_run < 14 and same_panel_recently:
    default = "Complementary Curated (broaden coverage)"

elif days_since_last_run > 60:
    default = "Same Curated (drift check)"

elif preparing_for_milestone (detected via Build Manifest):
    default = "Full Enchilada (milestone scrub)"

else:
    default = "Curated (profile-matched)"
```

### Step 4 — Narrate (single block, no questions until end)

```markdown
**Audit History**

Last audit: **{N} days ago** ({date}).
You ran: **{mode} — {N} lenses**: {comma-separated lens IDs}.
Result: **{total} findings** ({critical} critical, {major} major, {minor} minor, {cosmetic} cosmetic).
**{open}** still open in audit-log.md.

**Proposed Curated panel for this run: {Panel name — N lenses}**

Included lenses:
- **L01 Hygiene & Liveness** — {one-line why}
- **L02 Spec Fidelity** — {one-line why}
- ...

Skipped lenses (most relevant):
- **L11 AI Accuracy** — {one-line skip reason}
- **L14 AI Cost** — {one-line skip reason}

**Four options:**

1. **Same {mode}** — re-run the same {N} lenses, check what changed
   {recommended if drift check}
2. **Complementary Curated** — {Panel name} or Bob picks {N} lenses you haven't run
   {recommended if recent same-panel}
3. **Full Enchilada** — all 36 lenses, the rocketship-launch scrub
   {recommended if milestone}
4. **Custom** — tell me which lenses (by number or band)

**Bob's recommendation: {option N} — {default}**

Which? (1 / 2 / 3 / 4)
```

### Step 5 — Wait for response

`→ HG`. Do not auto-proceed. Joe picks.

### Step 6 — Confirm and run

After user picks:
- If Same / Complementary / Full → run sequentially per `_aggregation.md`
- If Custom → ask which lenses (numbers, bands, or named), confirm, then run

## First-audit experience (no history)

If `audit-history.json` doesn't exist, the entry narration adjusts:

```markdown
**First audit on this project.**

Based on project profile ({profile keywords}), I'd recommend **{Panel X — N lenses}**: {list with one-line why each}.

**Three options:**

1. **Curated** — {N} lenses targeted to where you are
2. **Full Enchilada** — all 36 lenses, the comprehensive scrub
3. **Custom** — specify lenses

**Bob's recommendation: Curated**

Which?
```

(No "Same" / "Complementary" options — they require prior runs.)

## Sample first-audit on DLL (illustration)

```markdown
**First audit on DLL.**

Project profile: launched, public, AI, personal data, SMS + web, paid plan, real users.

Recommended panel: **Panel A — Pre-launch consumer product (9 lenses)**

Included:
- **L01 Hygiene & Liveness** — every product needs this; engineering foundation
- **L02 Spec Fidelity** — DLL has detailed product spec; verify built vs planned
- **L03 Critical Capability Quality** — for the 30+ critical capabilities, grade A/B/C
- **L04 Security & Threat Surface** — STRIDE + OWASP because user data
- **L05 Data Protection & Privacy** — PII + retention because personal data + GDPR-EU users plausible
- **L07 UX Ease & Cognitive Path** — non-engineer users, SMS interface needs care
- **L08 UX Friction & Trust** — silent system actions risk (DLL spec mentions auto-recovery, decay)
- **L10 UX Edge States & Recovery** — SMS interface = high edge-state risk (delivery failures, etc.)
- **L13 AI Interaction (HAX) & Safety** — LLM in user flow, prompt-injection surface

Skipped this round (most relevant):
- **L09 Wow & Emotional Peaks** — defer to post-activation audit; foundation first
- **L11 AI Accuracy & Calibration** — defer; assumes L02 + L13 catch enough this run
- **L17 Device & Form Factor** — DLL is SMS-first, less mobile-web surface
- **L19 Accessibility** — defer; will run before any consumer scale
- **L24-L30** — defer; strategic/growth lenses after foundation pass

**Three options:**
1. **Curated** — 9 lenses above
2. **Full Enchilada** — all 35
3. **Custom**

**Recommendation: Curated (first audit, focus on foundation + UX + AI safety)**

Which?
```

## Tracking what worked

Each audit run logs `user_swaps_from_recommended`. Over time, if users consistently swap L09 out of Panel A or add L11 in, the selection rubric updates. This is how the rubric improves over usage.

## Cross-machine handoff (Joe's multi-machine model)

`audit-artifacts/` lives in the git repo, so audit history syncs across Joe's Mini ↔ MBA seamlessly. No special handoff logic needed beyond standard git.

## Bob's silent prep

Before showing the entry narration, Bob:
- Validates `audit-history.json` schema
- Counts open findings from prior runs
- Matches project profile to a pre-baked panel
- Computes default recommendation
- Estimates runtime per option (Curated ~1-2 hours per ~6 lenses; Full Enchilada ~1-3 hours over multiple sessions)

All silent — no narration of the prep work.
