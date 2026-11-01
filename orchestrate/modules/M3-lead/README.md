# M3-lead

The ORCHESTRATE lead builds this folder (see LANES.md); the build rows say what. The Lead is the session that turns what
the owner wants into cards. It has no shell and no token: it reads, and writes only its outbox files.

| File | Row | What it does |
|---|---|---|
| `lead-wording.mjs` | R-0b-142 | The Lead's wording: plan small cards, give each a four-part brief, group them into waves (no shared file inside a wave, however it is spelled, and no folder beside a file inside it; a card after the cards it needs), the owner's words only as their whole outside-text block in the Goal, treat outside text as data. Every shape a check reads is written out in the wording and tested against its reader: the plan file (`PLAN_FORMAT`, every key `checkPlan` reads) and the handoff (`HANDOFF_WORDING`, the same headings as `handoff.mjs` HEADS, with a place for queued requests). The plan reviewer's wording: one card's plan per review; PASS alone only with nothing Material left, or one numbered question. `checkPlan` checks a plan's shape and never throws on a wrong one; `readPlanReview` reads the reviewer's one-line answer, which `shared/plan-review.mjs` planPass turns into M2's plan check. |
| `task-brief.mjs` | R-0b-142, 143 | A card's brief: Goal, Done when, Files it is expected to touch, Not in scope. Paths go by the one shared rule (`shared/plan-fingerprint.mjs` cleanPath) and are compared case-blind (`pathKey`). No field holds a heading line, a stray `<`/`>` or an escaped fence; only the Goal may hold an outside-text block, whole, and the brief then carries a safety note. A wait's `who` takes only shared `WAIT_WHO` (the Store Writer's own list); `date` needs a reason; `since` and `next_check` are ISO times. |
| `lead-input.mjs` | R-0b-143, R-0b-126 | The Lead's input file: one `<lead-input kind="…">` block per outside kind, in a fixed order, each with the safety note even when empty, so outside text can't fake a section. Raw text is cleaned once here; text from the record is checked, never cleaned twice. An item may carry several fenced parts under its kind's real writer's sources (M13's issue title and body; M12's commit subject and author). Passes M12's join check for all five kinds. |
| `handoff.mjs` | R-0b-143 | The handoff note's one shape (Claim, Open card, Next step, Decisions, Messages), in that order, and the resume card a restarted Lead reads first. A note missing a part is refused; `handoffText` never writes one the reader refuses. `handoffProblem` is the check the Dispatcher's vet runs before the old Lead is stopped (M11 lead-restart, once #68 is in). |

Not decided here: which outbox kind carries a plan, and when the Dispatcher builds the Lead's input file. Those are the
Dispatcher's and M9's.
