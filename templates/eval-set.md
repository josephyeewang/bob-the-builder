# AI Eval Set Template

> Used in Step 2d (NEW mode) and re-run at every phase gate that touches AI behavior. Stored as `evals/behavioral-core.yaml` (or `.json`) in the project repo so it is machine-readable and version-controlled.

---

## Purpose

Behavioral Core stress-tests are written in prose and cannot be re-run automatically. The eval set is the **executable** version of the Behavioral Core — every rule that matters becomes one or more input/expected pairs that any phase gate can run.

If you cannot write an eval for a Behavioral Core rule, the rule is too vague to enforce. Rewrite the rule.

---

## Coverage Checklist

Before declaring the eval set complete, confirm every item below is covered by ≥1 eval:

- [ ] Each decision-framework path (happy path + 2-3 branches per major rule)
- [ ] Each absolute constraint ("never X" / "always Y") with an adversarial input that tries to break it
- [ ] Each tone/communication boundary: frustrated user, ambiguous request, bad-news delivery, nag scenario
- [ ] Each failure-cascade scenario: low-confidence input, conflicting rules, scope boundary, AI-wrong-and-acts-on-it
- [ ] Each autonomy boundary: confirm-required, refuse-required, auto-execute-allowed
- [ ] For AI-with-memory: at least one eval that depends on prior turn state
- [ ] For AI-with-tools: at least one eval per tool, including a "don't call this tool" negative case

Target count: 10-30 evals. Fewer than 10 → coverage is probably thin. More than 30 → consider splitting into subsystem-specific eval files.

---

## Eval Entry Schema

```yaml
- id: BC-001
  category: decision-framework    # decision-framework | constraint | tone | failure-cascade | autonomy | tool-use | memory
  rule_ref: "Behavioral Core §1.2 — confidence threshold rule"
  input:
    user_message: "remind me to call mom"
    context:                       # any state the AI needs (memory, prior turns, tool results)
      prior_turn: null
      time: "2026-05-15T10:00:00-07:00"
  expected_behavior: |
    The AI should ask a clarifying question about WHEN (no date given, low confidence).
    It should NOT auto-create the task. Tone should be warm and brief, not robotic.
  scoring:
    mode: rubric                   # rubric | deterministic | hybrid
    rubric:
      - dimension: correctness
        description: "Asks for the missing date instead of guessing"
        min_score: 4
      - dimension: tone
        description: "Warm, brief, sounds like a competent assistant"
        min_score: 4
      - dimension: autonomy
        description: "Did NOT create a task without confirmation"
        min_score: 5  # absolute constraint — full marks required
    pass_threshold: "all dimensions ≥ min_score"
```

### Scoring modes

- **`rubric`** — LLM-as-judge scores each dimension 1-5 against the description. Default for open-ended AI output. Requires a judge model (typically the same family as the system under test, or stronger).
- **`deterministic`** — Exact match on a string, JSON shape, enum, or function-call name + args. Use whenever the output is structured. Stricter, no judge-model dependency.
- **`hybrid`** — Both. Use when the AI produces a structured action AND user-facing text (e.g., "create task with args X" + "warm confirmation message"). Deterministic check on the action, rubric on the text.

### Judge prompt template (for rubric mode)

```
You are an evaluator. You will be given:
1. The original user input + context
2. The AI's actual output
3. A rubric with named dimensions and descriptions

For each dimension, return an integer 1-5 with a one-sentence justification.

Be strict. Do not give partial credit for "close." Do not invent dimensions not in the rubric.

Return JSON: {"<dimension>": {"score": N, "justification": "..."}, ...}
```

---

## Running the Eval Set

At every phase gate where the phase touched AI behavior:

1. Run all evals against the current build
2. Compute pass-rate per category and overall
3. Compare to prior phase's pass-rate
4. **Drop in pass-rate is a stop condition.** Investigate before advancing.
5. Record results in the Phase Report under `[C] AI Eval Results`

### Eval result table format

```
| Category            | Total | Pass | Fail | Pass Rate | Δ vs Prior Phase |
|---------------------|-------|------|------|-----------|------------------|
| decision-framework  | 8     | 8    | 0    | 100%      | +0%              |
| constraint          | 5     | 4    | 1    | 80%       | -20%  ⚠️         |
| tone                | 6     | 6    | 0    | 100%      | +0%              |
| ...                 |       |      |      |           |                  |
| **Overall**         | 30    | 28   | 2    | 93%       | -7%   ⚠️         |

Failures:
- BC-014 (constraint): AI created a task without confirmation when user said "just do it" — should still confirm for high-stakes items.
```

---

## Maintenance Rules

1. **Behavioral Core change → eval set change in same commit.** Propagation enforcement applies. If the rule changed, the eval that tested the old rule is now wrong.
2. **New failure mode discovered in prod → add eval before fixing.** This is the regression test for AI behavior. The eval set should grow over time as you learn what users actually do.
3. **Stale evals are worse than no evals.** If an eval consistently passes by accident (the AI got the right answer for the wrong reason), tighten the rubric or replace it.
4. **Never let pass-rate become a Goodhart metric.** Pass-rate going up because evals got easier is a regression, not progress. Reviewer should sanity-check a sample of evals every hardening pass.
