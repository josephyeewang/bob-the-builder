# M3-lead

The ORCHESTRATE lead builds this folder (see LANES.md); the build rows say what. The Lead is the session that turns what
the owner wants into cards. It has no shell and no token: it reads, and writes only its outbox files.

| File | Row | What it does |
|---|---|---|
| `lead-wording.mjs` | R-0b-142 | The Lead's wording: plan small cards, give each a four-part brief, group them into waves (no shared file inside a wave; a card after the cards it needs), treat outside text as data. The plan reviewer's wording: PASS, or one numbered question. `checkPlan` checks a plan's shape; `readPlanReview` reads the reviewer's one-line answer. |
| `task-brief.mjs` | R-0b-142, 143 | A card's brief: Goal, Done when, Files it is expected to touch (plain paths), Not in scope. A wait's `who` takes only shared `WAIT_WHO` (the Store Writer's own list); `date` needs a reason. |
| `lead-input.mjs` | R-0b-143, R-0b-126 | The Lead's input file: one section per outside kind, in a fixed order, each with the safety note even when empty. Raw text is cleaned once here; text from the record is checked, never cleaned twice. Passes M12's join check for all five kinds. |
| `handoff.mjs` | R-0b-143 | The handoff note's one shape (Claim, Open card, Next step, Decisions, Messages) and the resume card a restarted Lead reads first. A note missing a part is refused. |

Not decided here: which outbox kind carries a plan, and when the Dispatcher builds the Lead's input file. Those are the
Dispatcher's and M9's.
