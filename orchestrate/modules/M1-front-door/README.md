# M1 Front Door

Lane 3 builds this folder (LANES.md). The Front Door is the one session the owner reaches from their phone. It has no shell:
everything they ask for becomes one small file in its outbox and one short reply. Milestone 0b-8 is its minimum.

| File | Row | What it does |
|---|---|---|
| `skill/orchestrate/SKILL.md` | R-0b-81, 137 | The one skill: new idea, a piece of work sorted into a Bob mode, pause, away, back, wrap up, rotate. "Not wired yet" for the rest. |
| `outbox.mjs` | R-0b-81, 83 | The three file shapes (`state-`, `request-`, `idea-`) and intake's check. Never `state: active`; a key in any file refuses it; a product off the list or a reused id is refused (L26). `intakePush` is the confirmation the owner gets. |
| `sort.mjs` | R-0b-137 | The full loop's reference: the cue words per Bob mode (the skill's table must match), the three-line read-back with Go, Change, Not now, the one question with a recommendation when unsure, and the check that a reply never repeats a pasted key. Number work (Tier 1, R-0b-138) reads back "the Lead is planning it now" and that the go comes after a fresh plan check. |
| (in `outbox.mjs`) | R-0b-136 | `ask-request-<id>.json`, the owner's "find out X": a research ask with its product and one-line brief. M2 `research-ask.mjs` turns it into the ask. |
| `timezone.mjs` | R-0b-83 | A time zone counts only as a city-based name the system knows; anything ambiguous is null, which holds number work for products on the Merge Gate. |
| `trip.mjs` | R-0b-83 | The trip brief: go items and risky asks with links, the Mini check (online, logged in, battery backup), the Air. |
| `transcript.mjs` | R-0b-82, 84 | Reads the Front Door's own conversation log: the owner's turns, question boxes and their answers, "turn finished". |
| `restart.mjs` | R-0b-82 | When to restart after a quiet spell (past 150k, quiet 15 min, no open question box, turn finished), and the ≤3k handoff. |
| `readback.mjs` | R-0b-81 | Checks the read-back the owner gets from the phone against the role profile passed in. |
| `OWNER-TEST.md` | R-0b-81 to 84 | The owner's steps for the real halves, with the stop conditions. |

Two pieces sit in other lane 3 folders because trip mode needs them: `M12-sensors/power-source.mjs` (battery backup,
one fact; a line deviation: not in the 0b-7 count) and the heartbeat status fact in `M13-ledger/heartbeat.mjs`.
R-0b-82's decision and handoff code sit here although the row is tagged M11 (lane constraint).

## What is decided where (binding: review-0b-8)

- **250k** is the launch compaction limit, owned by lane 2's launcher and the role profile; it fires whether or not a
  question is open. Nothing here restarts at 250k.
- **Quiet** counts from the owner's last timed turn: a typed message, an image or document they sent, a message they queued
  while a turn ran, or a question-box answer (a declined box too). Lines the Dispatcher types (always starting
  `[watchdog]`), a box "answered" by such a line, relays, side threads and injected notices don't count. If their newest
  turn has no time, there is no restart. **Question open** means a question box in the Front
  Door's own log with no answer carrying its call ID; open asks in the record don't count.
- **The handoff** is text only, masked and fenced, oldest turns cut first, the owner's newest turn last. Lane 2 delivers it.
- **Merge hours** are the Merge Gate's to enforce. The brief states them only for products on the Merge Gate.
- **Mini check:** green only from facts under an hour old; a missing fact reads "unknown".

## Join items (other lanes)

1. Lane 1: the Store Writer refuses `state: active` from the front_door role; the Merge Gate reads `tz` (null while
   away = hold Tier 1; [Undo] never held). The role profile lists two more outbox kinds (`state-compact-`,
   `ask-request-`) than this milestone writes; they are other rows'.
2. Lanes 1 and 2: the three outbox shapes in `outbox.mjs` are the contract for intake (R-0b-56); intake calls
   `checkOutboxFile` after lane 2's name and owner check, and passes idea text on through `cleanOutside`.
3. Lane 2: stop and start the Front Door under its fixed name when `shouldRestartFrontDoor` says so, and deliver
   `makeFrontDoorHandoff`'s text (first prompt, or a read-only file outside the outbox).
4. Lane 2: each Ledger pass calls `nextTripPush({ states, lastPushedIds, lastFailedIds, build })` (`states`: `{ id, state }` of the
   newest checked `state-` file per product, of which only `away` ones count; `build` = `buildTripBrief` with those ids). A result is sent to the owner's
   phone over the Front Door's push path and its `ids` stored as `lastPushedIds` (lead call L22); a result with
   `failed: true` (the brief couldn't be built) is pushed too, but its `ids` go to `lastFailedIds`, never
   `lastPushedIds`, so the next passes keep trying and push the real brief once it builds; pass both lists back in
   every time (each one replaced by the newest result of its kind; an old `lastFailedIds` is harmless, since ids are never reused). The pass also writes each result's text (a brief or a failure) to the read-only file the skill quotes
   if the owner asks first, and runs `readPowerSource` with the
   heartbeat. The skill quotes only a brief that names the ids it wrote (0b-8 audit round 3 M-3). If the push isn't
   ready by the first cutover, trip mode falls back to two replies ("filed", then the brief when the owner says "brief").
5. Lane 2: its launch read-back checker replaces `readback.mjs` at the join; the two agree on EndConversation and on
   settings sources (machine-wide + `--settings` only).
6. The Air's health result (lead call L23): /configaudit on the Air runs `node M12-sensors/air-health.mjs <red count>
   <folder>`, which writes a dated `request-airhealth-<time>-air.json` to the Mini's air-health folder (synced, and
   one the Front Door can't write). Intake reads that folder only, checks each file with `checkAirHealthFile`, and the
   Ledger stores `airFactFromFile(doc, now, storedFact)` under `AIR_FACT` ('air-health') when it isn't null. The fact
   carries the check's own time, so a late take-in is never fresh, and an older check never replaces a newer one. The Front Door's outbox check refuses that name. The owner never types a count.
7. "Filed, then confirmed" (lead call L26). Lane 2: the Front Door's context file carries the product list (exact
   names), and for every Front Door file intake takes in or refuses, it pushes `intakePush(name, result)` to the owner's
   phone ("Confirmed: …" for pause, away and idea; "Request taken: … nothing has happened yet" for resume, wrap up and
   rotate; or "Not filed: <reason>. Say it again."), **only after the record write succeeded**; a failed write pushes
   "Not filed". Lanes 1 and 2: intake calls `checkOutboxFile(name, text, { products, seenIds })`, both a list or a
   Set, with `seenIds` every id taken in before, kept in the record so it survives a restart. Both are required: a
   result whose `checked` shows either skipped is pushed as "Not filed". Until this is wired, a "Filed" reply has no
   confirmation behind it.
8. The rotate push says "the steps follow" (lead call L26 wording). Lane 2 (or the Lead's rotate flow): send the owner
   the rotate steps for that name after the "Request taken" push. Until that is wired, the push promises steps that
   don't come (0b-8 audit round 9 minor 3).
9. Mode requests (R-0b-137). Lane 2's intake takes in `request-evolve-`, `request-audit-`, `request-upgrade-` and
   `request-think-` like the other requests (same `checkOutboxFile`, same push, "Request taken: … Nothing has started
   yet"). The Lead acts on evolve, audit and upgrade as Bob runs on that product; think opens a thinking room on the
   rules' `models.main`. `what` is the owner's words, one line, already checked for keys; pass it on through
   `cleanOutside`. NEW files nothing: the owner opens their own session. Until this is wired, the request sits unread.
10. Research asks (R-0b-136). Lane 2's intake checks `ask-request-<id>.json` with `checkOutboxFile` and pushes
   `intakePush` like the other Front Door files, then hands it to the record's `applyOutbox` (kept as a report). Each
   pass runs M2's `openResearchAsks(ctx)` and pushes each `opened[].push` to the owner's phone. R-0b-135, after it
   writes the research_copy card, calls M2's `landResearch(ctx, id)`. The owner's desktop session (Bob's method for
   "run research ask R-12") reads the brief and the file name to leave with M2's `researchBrief(record, id)`, then
   writes `research-R-12.md` to the proposals folder; how that session reads the record is the Lead's to place.

## Ledger: two lines per row (review-0b-8 MAT-10)

| Row | Built, fake tests pass (Claude) | Proven on phone/Mini (owner + Claude, date, result) |
|---|---|---|
| R-0b-81 | yes: `outbox.test.mjs`, `skill.test.mjs` | not yet (OWNER-TEST steps 1–5) |
| R-0b-82 | yes: `restart.test.mjs`, `transcript.test.mjs` | not yet (step 6; needs lane 2's stop/start) |
| R-0b-83 | yes: `trip.test.mjs`, `outbox.test.mjs`, `M12-sensors/power-source.test.mjs` | not yet (step 7) |
| R-0b-84 | yes: `transcript.test.mjs` (the checker) | not yet (step 8) |
| R-0b-85 | audit rounds logged in the build notes | — |
| R-0b-136 | yes: `M2-approvals/research-ask.test.mjs` (against a stand-in for R-0b-135) | not yet (needs join item 10 and R-0b-135) |
| R-0b-137 | yes: `sort.test.mjs` | not yet (needs join item 9) |

A §13 proof row stays unproven until its owner line is filled. R-0b-85's audit of the restart covers lane 2's
stop/start half after the join.
