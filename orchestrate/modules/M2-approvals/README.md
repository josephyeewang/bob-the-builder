# M2-approvals

M2 Approvals is the one place that decides whether the owner said yes. It words every question the owner is asked, sends it at the right time, and counts an answer only when it can prove the owner gave it: a tap on M2's own question box, or the owner's own Approve on GitHub. Only M2 (actor `approvals`) writes asks and gos in the M9 record.

See LANES.md for who builds this folder, and the build rows (0b-5, R-0b-48..53) for what.

## The files

| File | What it does |
|---|---|
| `kinds.mjs` | The fixed lines the Front Door shows word for word, the reading of the owner's settings (push windows, zones, lapse times), `dueWindow` (is now a push window?) and `lapseAt` (when this round of an ask runs out). Ask kinds themselves are shared names in `shared/asks.mjs`. |
| `payload.mjs` | The exact question box for an ask, written on the ask when it is created (plain and "still open" versions). |
| `ask-store.mjs` | Reads and writes asks and gos through the M9 writer as `approvals`; an ask or go last written by anyone else is not trusted and is alerted. `writeDoc` is for M2's own files; another module closes an ask only through `consumeAsk(ctx, id, note)` (answered → consumed, the note may only add new fields; L85 m-3), and `consume-ask.test.mjs` fails on a module outside M2 that imports `writeDoc`. |
| `transcript-copy.mjs` | M2's tamper-checked copy of a launched session's conversation log. Taps are read from the copy, never from the live file. |
| `binding.mjs` | When a tap counts (R-0b-48): the box must match the payload exactly, be asked in a Front Door or thinking session the Dispatcher launched, and be answered by a tap while the ask is still in its round. `createAsk` lives here. |
| `github-review.mjs` | When a GitHub Approve counts (R-0b-49): the owner's account by numeric id, an Approve on the exact commit (or one it carries over to), given after the ask was raised. |
| `decision.mjs` | Decisions as small decision pull requests (R-0b-50): Approve with no text is the recommended choice, a one-letter text picks another, "Request changes" declines. The pull request is closed unmerged once the answer is recorded. A Tier-1 go is a decision pull request too, answered only by an empty Approve. |
| `go.mjs` | The owner's go on one plan of one card (R-0b-52, R-0b-53): when an Approve ask is needed at all, raising the go, recording it, the merge-time check that a change stays inside it, and the Tier-1 re-check when main moves. A Tier-1 go is asked only after a fresh plan reviewer passed the plan with 0 Material (`planCheck`, R-0b-138), and the pass names the card and the plan's whole fingerprint (`goFingerprint`), so a file list or done_when changed after review needs a new pass (audit kit-lane3 r1 M-2). |
| `go-view.mjs` | What the owner reads for a go (R-0b-138, R-0b-139): the plan in three lines (Tier 1 adds "number work", the checked plan and "audited until 0 Material"), how to answer, and a fold of the files the go allows, which is the ask's bound list. The Tier-2 push carries it; the Tier-1 decision pull request's body is it. A Tier-1 go without a fresh plan pass is never shown or sent. Also the day-1 [Undo] push text (sent by R-0b-140). |
| `research-ask.mjs` | Research asks (R-0b-136): turns the Front Door's `ask-request-` report into an open research ask `R-<n>` whose wait puts it on "waiting on you"; gives the owner's desktop session the brief by number (`researchBrief`); takes it off the list once its research_copy card exists (`landResearch`). |
| `schedule.mjs` | When asks go out and run out (R-0b-51, R-0b-53): push windows, urgent re-pushes, lapse and the one re-ask, the 24-hour void of an unmerged approval, held decisions. |
| `*.test.mjs` | The tests. `fixtures.test-helper.mjs` and `fixtures/` are shared set-up (a real M9 record, a fake GitHub), not tests. |

## The rules in one place

- **Push times.** A non-urgent ask goes out only in a push window (08:00 or 17:00 in the owner's zone, or the trip zone while away), and only if it existed when that window opened. Urgent kinds (undo, incident repair) go out at once and every 2 hours until answered. That is the one re-push rule.
- **Running out.** A lapsing ask unanswered 12 hours after it was raised is re-asked once, in the next window; a second lapse closes it. Re-pushes never restart the 12-hour clock. An approval with no merge within 24 hours goes back the same way. Nothing merges on a lapsed approval, and an approval given while the Mini was down is judged by the time GitHub gives it, so it lapses the same way.
- **A go is bound** to its card's file list, pass test (the rows' done_when texts), tier and main commit, through the plan fingerprint. A go on card A never satisfies card B. Only risky classes, `needs_joe`, or a Tier-1 module not yet proven live raise an Approve ask.
- **At merge**, a Tier-2 change whose files go outside the go's list needs a new go. A Tier-1 plan whose listed file changed on main is re-checked; a changed plan needs a new go. Folder patterns in a file list are refused.
- **Held decisions.** A decision that names its modules is not raised while any open card works on one of them; a card with no module holds every held decision.

## What the tests cover, and what they don't

- **Typed and tapped can't be told apart in the log.** Claude Code writes a typed "Other" answer and a tap the same way; a typed answer that equals an option label counts as that tap. Checked on Claude Code 2.1.312, 30 Oct 2026; void at its next release.
- **GitHub is faked.** `fixtures/fake-github.mjs` behaves like the REST endpoints M2 calls; the real API is not called in tests.

## Not built here (logged)

- **Ask-request intake, other than research.** Only the Front Door's research ask is turned into an ask (R-0b-136); an incident's `ask-request-` is refused and alerted.
- **A research ask never closes.** The record has no move from open to consumed, so a landed research ask stays open with no wait; one copy card per ask still holds (M9 writer).
- **An old Tier-1 go pull request is not closed** when its plan changes and a new go is raised.
- **Cards have no `rows` field.** The Lead's plan passes the rows to `raiseGo`; M10's lane rule reads `card.rows`, which a card can't hold yet.

## Known gaps (audits, logged, not fixed here)

All fail closed: nothing here counts a yes the owner didn't give.

- **A decision branch made but its file never written.** `openDecision` creates the branch before the file; if the write fails, every retry hits "already exists" and the ask waits until the branch is deleted by hand. Alerted each window.
- **The decision pull request's head is not checked to be the robot's own commit.** Anyone able to push to `decision/<id>` could change the file the owner reads; the letter maps to the choices as stored. No one can push there today (lanes push only their own files).
- **A session whose launch record isn't written yet** has its log lines marked read and dropped, so a box asked in it never binds.
- **Pass order.** If a pass runs the lapse step before reading the session logs, a tap given in time is lost and the ask is re-asked.
- **A catch-up after an approval is counted** moves the head, so the approval no longer stands until it is re-asked at the 24-hour mark; after a merge the 24-hour rule can re-ask on a merged pull request (noise).
- **A held decision needs its `modules` field**; the caller sets it, nothing enforces it.
- **`goCheck` trusts the go it is handed** (only M2 can write a go in M9).
- **A corrupt or untrusted ask under a go's id** blocks that plan: no new ask can take the id. Alerted as untrusted.
- **A go tap never recorded** (the plan changed before `recordGo`) is reused if the plan returns to exactly that one, however long after. It is the owner's real yes on that exact plan; whether it should age out is a lead call.
- **Twenty closed asks on one plan** ("not now", withdrawn, expired) and that plan can't be asked again; the refusal says so, with no reset.
