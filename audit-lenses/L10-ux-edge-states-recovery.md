---
id: L10
name: UX — Edge States & Recovery
band: 2
band_name: User Experience
when_to_run: Products with human users. Especially important for products with network calls, async operations, or stateful flows.
estimated_duration: 45-90 min
session_pattern: fresh session; reads L07 (Ease) report if available
output_markdown: audit-artifacts/L10-ux-edge-states-recovery-{YYYY-MM-DD}.md
output_json: audit-artifacts/L10-ux-edge-states-recovery-{YYYY-MM-DD}.json
source_frameworks:
  - Edge-case audit methodology (Figr, Vibe Coder)
  - Nielsen H9 — Help users recognize/diagnose/recover from errors
  - DLL audit 2026-05-23 — missing recovery paths pattern (no "wrong number?" fallback)
  - "Empty / Loading / Error / Offline / Partial / Slow / Permission-denied" state enumeration
---

# L10 — UX: Edge States & Recovery

## Question this lens answers

*For every non-happy-path state (empty, loading, error, offline, partial, slow, permission-denied), does the product handle it gracefully — and is there a recovery path from each one?*

## Why this lens exists / what other lenses miss

Engineering tests verify the happy path. Engineering audits often check error handling (L01, L04) at the technical level — does the code throw an exception, is the error caught. Neither asks *"when the system is in a degraded or unusual state, does the user know what's happening and what they can do?"*

The DLL audit caught this pattern explicitly: "login has no 'wrong number?' fallback"; "phone-capture form has no 'SMS didn't arrive?' retry"; "did it work? anxiety has no portal link from confirmation." NN/g found 92% of AI-generated UIs ship without empty states. Edge states are the highest-leverage UX gap because they happen often (every user hits them) but no one designs for them.

This lens enumerates the states and verifies each one has a recovery path.

## When this lens fires

**Always-in-Full-Enchilada for human-facing products.** Curated panel inclusion criteria:
- ✅ Always — for products with non-engineer users.
- ✅ Especially important — products with network calls, async operations, AI calls (high failure rate), multi-step flows.
- ⏸ Skip — engineer-only / backend / library products.

## Session setup

- Start a **fresh Claude Code session.**
- Read L07 (Ease) report — recovery paths often share root with cognitive-path failures.
- Walk the live product, deliberately triggering each non-happy state:
  - Disable network (offline)
  - Throttle network to 3G (slow)
  - Submit empty data (empty state on lists/results)
  - Submit invalid data (form errors)
  - Reach quota / rate limit (limit hit)
  - Deny browser permissions (no camera/mic/location)
  - Trigger backend 500 (server error)
  - Navigate to a stale link (404)
- For AI products: trigger model timeout, model refusal, model malformed output.

## Source frameworks

- **Edge case audit methodology** — categorized state enumeration. https://figr.design/blog/10-edge-cases-every-pm-misses-and-why-they-cost-50-100x-more-after-launch + https://blog.vibecoder.me/empty-states-loading-states-error-states
- **Nielsen Heuristic 9** — error recovery via plain-language messages + recovery action.
- **DLL audit (Joe Wang, 2026-05-23)** — recovery-path-absence pattern.

## Audit method

1. **Enumerate every state per surface.** For each user-visible surface (page, screen, modal, SMS message), list which of the following non-happy states it can be in:
   - **Empty** — no data to show (first-time user, all items completed/deleted, filtered to nothing)
   - **Loading** — async operation in progress
   - **Error** — operation failed (with sub-categories: validation error, server error, network error, permission error, quota error)
   - **Offline** — no network
   - **Partial** — some data loaded, some failed (e.g., 8 of 10 items rendered, 2 failed)
   - **Slow** — operation taking longer than 1s, 5s, 30s
   - **Permission-denied** — user tried to access restricted resource

2. **For each state, verify presence + quality of handling:**
   - **Presence** — does the product have a designed state for this, or does it crash / show blank / show developer error?
   - **Quality** — does the state explain what happened, why, and what the user can do?
   - **Recovery action** — is there a path forward (retry, contact support, see something else)?

3. **AI-product additional states.** For any AI surface, also check:
   - **Hallucination uncertainty** — does the UI communicate confidence?
   - **Refusal** — when the model refuses, does it explain why with a recovery path?
   - **Malformed output** — what happens when the model returns wrong-shape data?
   - **Cost/rate limit** — what does the user see if their quota hit?
   - **Timeout** — what if the model takes 60+ seconds?

4. **"Did it work?" anxiety audit (DLL pattern).** For every action where the user's mental model is uncertain about success — actions with side effects (charge, send, delete, share) — is there explicit confirmation? Where in the UX flow is the confirmation surfaced (immediately vs after a beat)?

5. **Recovery path mapping.** From every error state, can the user get to a known-good state in ≤2 steps? Or are they stuck?

## Check questions

1. For every user-visible surface, have you enumerated which non-happy states are possible?
2. Does every list / collection screen have a designed empty state (not just blank)?
3. Does every async action have a loading state that appears within 100ms?
4. Does every error message say (a) what happened, (b) why, (c) what the user can do?
5. Does the product detect offline and tell the user, vs failing silently?
6. For slow operations (>5s), is there a progress indicator and/or a "this is taking longer than expected" message?
7. Does every permission-denied state explain WHICH permission and HOW to grant?
8. For partial-load states, are the failed parts clearly marked vs silently missing?
9. For AI products: is hallucination uncertainty communicated when the model is uncertain?
10. For AI products: when the model refuses, is the refusal user-respectful + has a recovery path?
11. From every error state, can the user reach a known-good state in ≤2 actions?
12. For irreversible actions, is there an explicit confirmation (or undo within N seconds)?
13. After actions with side effects (send, charge, delete), is there explicit "this happened" feedback?
14. For long async flows (SMS arrival, email delivery), is there a "didn't work?" retry path?
15. What's the single highest-leverage edge-state gap?

## Output schema

### Markdown report

```markdown
# L10 — UX: Edge States & Recovery — {YYYY-MM-DD}

## State enumeration per surface
| Surface | Empty | Loading | Error | Offline | Partial | Slow | Permission-denied |
|---|---|---|---|---|---|---|---|

(designed / undesigned / unknown per cell)

## Designed-state quality
| State | Surface | Explains what? | Explains why? | Recovery action? |
|---|---|---|---|---|

## AI-specific states (AI products only)
| Surface | Hallucination signaling | Refusal handling | Malformed output | Timeout | Quota |
|---|---|---|---|---|---|

## "Did it work?" anxiety audit
| Action | Side effect | Confirmation visible? | Where |
|---|---|---|---|

## Recovery path mapping
| Error state | Steps to known-good | Within budget (≤2)? |
|---|---|---|

## Top 3 highest-leverage findings
1. ...

## Findings (full, severity-tagged)

## Stop conditions
```

### JSON sidecar

```json
{
  "lens_id": "L10",
  "lens_name": "UX: Edge States & Recovery",
  "run_date": "YYYY-MM-DD",
  "schema_version": "1.0",
  "surfaces_audited": 0,
  "state_coverage": {
    "empty_designed_pct": 0,
    "loading_designed_pct": 0,
    "error_designed_pct": 0,
    "offline_designed_pct": 0,
    "partial_designed_pct": 0,
    "slow_designed_pct": 0,
    "permission_denied_designed_pct": 0
  },
  "ai_state_coverage": {},
  "recovery_path_within_budget_pct": 0,
  "findings": [
    {
      "id": "L10-F001",
      "severity": "critical|major|minor|cosmetic",
      "category": "missing_empty_state|missing_loading_state|missing_error_message|missing_offline_handling|missing_partial_handling|missing_slow_indicator|missing_permission_path|no_recovery_path|ai_hallucination_unsignaled|ai_refusal_no_path|missing_confirmation|no_retry_path",
      "title": "{short}",
      "surface": "{page/screen/message}",
      "state": "empty|loading|error|offline|partial|slow|permission_denied|ai_hallucination|ai_refusal|ai_malformed|ai_timeout|ai_quota",
      "evidence": "{what happens currently}",
      "user_impact": "{1-sentence}",
      "recommendation": "{designed state proposal}"
    }
  ],
  "top_findings": []
}
```

## Severity rubric

- **Critical** — Error state shows raw stack trace / dev error / blank screen to user. Action with side effect has no confirmation (user can't tell if it worked). No recovery path from a frequently-reached error state.
- **Major** — Missing empty state on a first-time-user-likely screen (first impression is "broken"). Loading state >5s with no indicator. Error message says what but not why or how to fix.
- **Minor** — Designed states exist but copy could be warmer or clearer. Slow state lacks "taking longer than expected" message.
- **Cosmetic** — Polish on existing well-designed states.

## Anti-patterns / Bias instructions

- **Do NOT enumerate states from code alone.** L10 requires triggering each state in the live product. Code-only enumeration misses the visual outcomes.
- **Do NOT recommend "add error handling" generically.** Every recommendation must name the specific state, the specific surface, and the specific designed handling proposal.
- **Do NOT confuse engineering error handling with UX error handling.** The exception was caught (engineering); was the user informed and given a path forward (UX)? Both must be true.
- **Bias toward "what does a user see when something the engineer didn't think about happens?"** The whole lens is about anticipating non-anticipated states.

## Stop conditions

1. **No live product.** Cannot trigger states. Skip and note.
2. **Cannot trigger certain states in test environment** (e.g., rate limits, payment failures). Document which states could not be tested.

## Cross-lens handoff

- **Upstream:** L07 Ease.
- **Downstream:** L21 Observability (errors that users see should also be logged for ops).
- **Adjacent (~15% overlap):**
  - **L13 AI Interaction (HAX) & Safety** — AI-specific edge states are L13's deeper territory.
  - **L21 Observability** — error surfaces overlap with monitoring; user-side vs ops-side, same root.
