# Lens Retro — Audit Self-Learning Loop (v2.18)

> Every other Bob artifact tells you about **your product**. The retro is the one artifact that tells Bob about **its own lenses**. It is how the audit library gets better every time it runs — without telemetry, without phoning home, and without Bob ever editing its own lenses unsupervised.

## The distinction that makes this work

There are two completely different things you can learn from an audit, and conflating them wastes the loop:

| | Learns about | Example | Where it goes |
|---|---|---|---|
| **Audit findings** (A7.2 summary) | Your product | "L04 found an unauthenticated `/api/results` endpoint" | Fixed in the project; logged in project's `audit-log.md` |
| **Lens retro** (A7.4, this file) | The lens *as an instrument* | "L04 was gold; L20 was pure noise for a health product; nothing caught the Twilio 429 retry storm" | Fed back to improve Bob's lens library |

The retro is **not** the findings. It is a critique of how well the lenses *did their job*. A retro that just restates the findings teaches Bob nothing — findings are project-specific. A retro that says *"L08-F003 was a false positive because the silent action is intentional, and L08's check question Q4 is ambiguous about it"* is gold: it improves the lens for every future project.

## Two halves of the loop

- **A — Auto-emit (every audit, no opt-in).** At the end of every audit pass (A7.4), Bob automatically writes `audit-artifacts/audit-retro-{YYYY-MM-DD}.{md,json}` — a first-pass self-assessment of each lens that ran. The user does not have to ask. This is the raw material.
- **B — Accumulate + flag (periodic ritual).** Retros are collected into Bob's repo (`lens-retros/`). `scripts/lens-retro.sh` aggregates them across runs and projects, and flags lenses that are *consistently* low-signal or high-swap. A human then decides — convergence across retros is **signal, not a verdict** (the D-004 / F35 lesson). Approved changes go through a normal EVOLVE + F47 dogfood. Bob never edits its own lenses unsupervised (see **D-005**).

---

## A — The auto-emit retro artifact (A7.4)

After A7.3 (Fix & Defer Register) completes, Bob writes the retro automatically. The session that ran aggregation has the full context of what each lens produced, so it writes a **first-pass self-assessment**. (A deeper, fresh-session critique can be run later with the standalone retro prompt below — but the auto-emit guarantees a retro always exists, even if nobody asks.)

### Markdown artifact — `audit-artifacts/audit-retro-{YYYY-MM-DD}.md`

```markdown
# Audit Retro — {project} — {YYYY-MM-DD}

> Critique of the LENSES as instruments. Not the findings about {project}.

**Bob version:** {from build-protocol.md header}
**Audit run:** {run_id} — {Curated / Full / Custom} — lenses: {list}
**Project profile:** {keywords}

## Per-lens scorecard
| Lens | Signal (Gold / Useful / Noise) | Highest-value finding it caught | False positives / wasted effort | Executed or only Read? Should it have executed more? | Confusing / ambiguous check questions |
|---|---|---|---|---|---|
| L04 | Gold | L04-F002 unauth `/api/results` | — | Executed (Schemathesis) | — |
| L20 | Noise | none | flagged "no OG tags" but product is SMS-only | Read | Q3 assumes a web surface |

## Selection-rubric accuracy
- Was the proposed panel right for this project? {yes/no + why}
- Lenses I swapped in/out and why: {list}
- Lenses that should NOT have been in the panel: {list}
- Lenses MISSING from the panel that would have caught something real: {list}

## Coverage gaps (most important section)
- Real problem NO lens caught: {what} — why every lens missed it: {why} — is this a **missing lens** or a **missing check-question** in an existing lens? {verdict + target}

## Aggregation & dedup quality
- Did top-10 ranking surface the right priorities? {yes/no}
- Bad merges (two distinct findings wrongly merged): {list}
- Missed overlaps (obvious dup not merged): {list}
- L28 wedge vetoes — fired correctly / incorrectly? {list}

## Execution-principle gaps
- Where did a lens default to "I read the code and it looked correct" when it could have driven Playwright / hit the API / simulated behavior? {list per lens}

## Change requests for Bob (ranked)
1. [MODIFY check question / ADD lens / SPLIT lens / DROP lens / FIX rubric / FIX execution] — target {L##} — {what} — {why} — severity {high/med/low}
2. ...

## Time cost
- {hours} hours over {sessions} sessions. Panel size verdict: {right / too big / too small}.
```

### JSON sidecar — `audit-artifacts/audit-retro-{YYYY-MM-DD}.json`

This is what `scripts/lens-retro.sh` consumes. Schema is stable so the script can aggregate across runs and projects.

```json
{
  "schema_version": "1.0",
  "artifact_type": "audit_retro",
  "project": "{name}",
  "retro_date": "YYYY-MM-DD",
  "bob_version": "v2.18",
  "audit_run_id": "{uuid — links to audit-history.json run}",
  "panel": { "mode": "curated|full_enchilada|custom", "lenses_run": ["L01", "L04", "..."] },
  "project_profile": ["launched", "AI", "health-data", "web"],
  "lens_scorecard": [
    {
      "lens": "L04",
      "signal_verdict": "gold|useful|noise",
      "highest_value_finding": "L04-F002",
      "false_positives": [],
      "executed_vs_read": "executed|read|should_have_executed",
      "confusing_check_questions": [],
      "time_minutes": 25
    }
  ],
  "selection_rubric_accuracy": {
    "panel_was_right": true,
    "swaps": [{ "out": "L09", "in": "L05", "reason": "health PII dominates" }],
    "should_not_have_run": ["L20"],
    "missing_from_panel": ["L13"]
  },
  "coverage_gaps": [
    {
      "missed_problem": "Twilio 429 retry storm",
      "why_missed": "no lens models provider rate-limit backoff",
      "fix_type": "new_check_question|new_lens",
      "target_lens": "L21"
    }
  ],
  "aggregation_quality": {
    "ranking_right": true,
    "bad_merges": [],
    "missed_overlaps": [],
    "wedge_vetoes_correct": true
  },
  "change_requests": [
    {
      "rank": 1,
      "type": "modify_check_question|add_lens|split_lens|drop_lens|fix_rubric|fix_execution",
      "target": "L21",
      "what": "add provider-429 backoff check",
      "why": "...",
      "severity": "high|med|low"
    }
  ],
  "time_cost": { "total_hours": 2.5, "sessions": 3, "panel_size_verdict": "right|too_big|too_small" }
}
```

### Standalone retro prompt (deeper, fresh-session version)

The auto-emit is a first-pass by the session that ran the audit. For a sharper critique — or when sharing back to Bob — run this in a **fresh session** (writer/reviewer: the session that ran the audit rationalizes; a clean session judges harder):

> *Read every audit artifact in `audit-artifacts/` (the summary, every per-lens report, audit-history.json). Produce a LENS RETRO per `audit-lenses/_lens-retro.md` — a critique of the lenses as instruments, NOT the findings about this product. Judge whether each lens did its job: signal verdict, highest-value finding, false positives, executed-vs-read, confusing check questions. Then: was the panel right, what coverage gap did no lens catch, did aggregation rank correctly, and rank concrete change requests for Bob. Write both the `.md` and the `.json` sidecar. Be brutally honest and cite lens + finding IDs — vague praise is useless.*

---

## B — Accumulate + flag (the Lens Retro Ritual)

Retros are worthless scattered. The ritual turns a pile of retros into a ranked "lenses to review" list, then routes each through human judgment.

### Collection point: `lens-retros/`

Retro JSONs accumulate in Bob's own repo at `lens-retros/`. Three ways they get there:
1. **Joe's own projects** — copy `audit-artifacts/audit-retro-*.json` from EMBT / DLL / etc. into `lens-retros/`, or point the script at the project dir directly (it accepts path args).
2. **External users (PR-back)** — paste the retro into a GitHub issue, or PR the JSON file into `lens-retros/`. This is the audit-specific cousin of the Step [N+2]c PR-back.
3. **Email** — joe@joe.wang, same private channel as [N+2]c; Joe drops the JSON into `lens-retros/`.

No telemetry. No phone-home. Retros arrive only when a human shares them — consistent with Bob's no-telemetry-by-design stance.

### When to run the ritual

When **≥3 retros** have accumulated (this matches F48's own revisit trigger — "if 3+ users self-report friction"). Sooner than that, a single retro is one project's opinion, not a pattern. Don't act on N=1.

### The ritual steps

1. **Aggregate** — `bash scripts/lens-retro.sh` (optionally with project paths as args). It reads every retro JSON and produces a ranked report: per lens, how often it was flagged Noise, how often swapped out, how many change-requests target it, and how often it should-have-executed-but-read.
2. **Read the underlying retros** for each flagged lens — the script flags *candidates*; the prose tells you *why*.
3. **Bob proposes a specific edit** per flagged lens (modify check question / add lens / split / drop / fix rubric / fix execution-mode), citing which retros support it.
4. **`→ HG` — Joe applies the higher-order filter.** This is the load-bearing gate. **Convergence across retros is signal, not a verdict** — exactly the D-004 / F35 lesson (5 of 9 tools converged on sharded rules; Joe correctly rejected it anyway). A lens flagged Noise in 4 of 5 retros is a strong *candidate for review*, never an *automatic edit*. Joe approves / rejects each.
5. **Approved edits → EVOLVE + F47 dogfood.** Edit the lens file through a normal EVOLVE pass; dogfood the change on Bob (or the project that surfaced it) before shipping. Bump the version.
6. **Rejected edits → `decision-log.md`** with rationale, so the same retro signal isn't re-litigated next quarter.

### Hard rule (D-005): the loop surfaces, it never commits

Bob **never auto-edits its own lens prompts** from retro signal. The retro loop produces *proposals*; a human supplies the *verdict*. Full automation is explicitly rejected — see `decision-log.md` D-005. Rationale: lens prompts are load-bearing (~7,200 lines), auto-editing risks convergence-to-mediocrity, and it contradicts the principle that the human applies the higher-order filter.

---

## Relationship to existing infrastructure

- **`_audit-memory.md`** — the retro artifact joins the per-run artifacts listed there; `audit_run_id` links a retro to its `audit-history.json` run.
- **`_selection-rubric.md`** — the ritual's `selection_rubric_accuracy` aggregates are the direct input for refining panel recommendations (which lenses to add/drop from a profile's default panel). This finally activates the `user_swaps_from_recommended` signal that `_audit-memory.md` always tracked but never aggregated.
- **`_aggregation.md`** — distinct. `_aggregation.md` combines *findings* within one run; `_lens-retro.md` + `lens-retro.sh` combine *retros* across runs. Different artifacts, different scripts, different purpose. (This is why the retro work does not close F51 — F51 is about a findings-aggregation script.)
- **Step [N+2]c PR-back** — the retro is the audit-scoped cousin. [N+2]c reviews the whole build; the retro reviews the audit instrument specifically.

## Provenance

Originated from Joe's three-part question (2026-05-24): (1) how does a project self-apply audit learnings, (2) how does Bob learn what the audit got right/wrong, (3) how does that become semi-automatic. (1) is project-side hygiene (not Bob's concern). (2) is the auto-emit retro (A). (3) is the accumulate-and-flag ritual (B). The deliberate non-goal — Bob auto-editing its own lenses — is logged as D-005.
