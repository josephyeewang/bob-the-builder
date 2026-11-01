# M9-record

M9 Record is the one place a product's cards, asks, claims, waits and facts live, and the Store Writer is the one thing that writes it. Every other module reads and writes through `orchestrate/shared/record.mjs` (see `shared/README.md`); `openRecord()` here is what stands behind that interface in production.

See LANES.md for who builds this folder, and the build rows (0b-2, R-0b-20..28) for what.

## The files

| File | What it does |
|---|---|
| `writer.mjs` | The Store Writer. `openRecord({ root, product, ownerUid, rules, alert, outbox })` checks every write against the rev read, the legal moves, who may change which fields, and each move's conditions (the ready rule, a passing verdict for the current head, a full wait, one merge at a time, the round cap). Refused writes go to `refusals.jsonl` with an alert and leave no diary line. Also: the outbox, claims (release, dead-owner break, lapse), the ready list and overdue. |
| `store.mjs` | The files on disk: one diary line per write (`diary.jsonl`, the truth), one file per document, a lock. Folders 755, files 644, and it runs only as the store's owner. Before any read or write it checks the store folder's own names are a real folder or plain file; a link, a pipe or the wrong kind of thing stops the store with one alert naming it. A document changed by hand is quarantined, restored from the diary and alerted. Anything in `docs/` that is not a plain readable file (a folder, a link, a file the owner can't read) is moved into `quarantine/` as it is, never followed, so it can neither block writes nor reach outside the store; Finder's `.DS_Store` is left alone. `recover()` after a crash cuts a torn last diary line and rolls each document forward; a writer that finds a torn line under the lock recovers before it appends, and a line that doesn't read back stops the write before any document moves. |
| `lock.mjs` | The store lock, and the one "is this process dead?" check: gone means no such process, or a different start time (a reused pid). A process of another user counts as alive. |
| `moves.mjs` | Every legal state move and who may make it. Anything not listed is refused. |
| `permissions.mjs` | Who may create each entity and change which fields; which card kinds each creator may make. |
| `ready.mjs` | The one ready rule, used by both the move into `ready` and the ready list. |
| `outbox.mjs` | Reads an AI session's outbox file as hostile: no links, the role's owner, 256 KB at most, a kind its role may send; one name in a worker's outbox (a second name in review's own stores is no fault, L70: it can't change review's bytes, while review's files may not be writable by others). A review session's outbox folder that is gone is a refusal, never a silence (L71). |
| `*.test.mjs` | The tests. `*.test-helper.mjs` are shared set-up, not tests. |

## Claims

A claim is a field on its card: set by `ready → claimed`, cleared when the card leaves claimed and running. It has two steps (lead call L72). `ready → claimed` names the session before it starts (`kind`, `session_id`, `host`, and `rules_rev`, the rules it was made under); the writer stamps `claimed_at`. `claimed → running` adds the process (`pid`, `pid_start`) and nothing else. A tab's claim carries `claim_id` in place of the session and does not change at running.

A session's claim ends three ways:

- **A release** by its holder.
- **A lapse.** A claim that has no process yet and is older than `claims.unlaunched_min` (5 minutes when the rules don't say) goes back to ready. It lapses only once the caller's `stopSession(session_id)` says whatever started under that id is stopped, so the card can't run twice. With no `stopSession`, or one that does not answer true, the claim stays and the owner gets one alert a day.
- **A dead-owner break.** `breakIfDead` breaks only the claim it is given, and only when all three hold: the process is gone (pid and start time), its session ended or is gone, and there has been no activity for `claims.stuck_min` minutes. A claim with no process yet is never broken (it lapses instead). A claim from another Mac is never broken from this one.

Whether many dead claims at once mean an outage (hold them all) is the Dispatcher's rule, in M11, not this store's (L72). A tab's claim is never broken. Nothing writes its heartbeat yet, so the running limit alone ends it.

## Facts: families and who may change them

Every fact id belongs to one role's family (`FACT_FAMILIES` in `permissions.mjs`, lead call L74). An entry ending in `-` or `.` is a prefix; any other entry is that one id. A role creates a fact only in its own family, and no two roles' families overlap (`familyOverlaps()`, tested). A fact is changed only by the role that created it (the store keeps who wrote a document's first diary line). A reader that takes a fact as proof uses `factFrom(role, entry, family)`: the id must be in that role's family AND written by that role. The fact's `type` alone is never proof, since any role can write any type into its own family. Nothing that gates reads a workshop fact as proof.

A card's `attempts` holds counts kept across moves: `reviewer_starts` and `review_requests` (both written by the Dispatcher; the second goes up on every review request, so the request always changes the card and its clock moves, L85 m-1) and `merge_refusals` (a list of reasons, written by the merge gate). Each key has one writer and one shape; no other key is allowed.

## Why our own store, not Claude Code's task list

Claude Code has a native task list. We checked whether it could hold the claims: tests 3 (a claim on a stale read is refused), 4 (eight processes race, one wins) and 9 (a dead owner's claim is broken) cannot be expressed in it, so they were not run against it. Checked on Claude Code 2.1.312 (the version installed that day; the project pins 2.1.300), 29 Oct 2026; this note is void at its next release, so check again then. Until it can, the claims stay in this store.

## What the tests cover, and what they don't

- **A kill is not a power cut.** The crash tests kill the writer with SIGKILL at every step of a write. On macOS, `fsync` doesn't force the disk's own cache to the platter (that needs `F_FULLFSYNC`), so a power cut could still lose the last write. Not tested.
- **The nightly copy of the diary is not built yet.** When it is, it must mask anything private before it copies.
- **The ready rule's dependency behaviour** is our own, written to behave like BMAD's (a cycle is refused, a missing dependency blocks, a dependency that will never merge waits on the owner). No upstream source was available to port.
- **The owner's step:** in production the store belongs to its own Mac user, and AI sessions write their outbox as the owner's everyday user. The tests run as one user, so "a write as the everyday user fails" is tested by giving the writer a different owner uid. That the real other user gets "permission denied" is a check the owner runs once on the Mac.

## Known gaps (audit round 1, logged, not fixed here)

- **A crash between applying an outbox file and marking it seen.** On restart the file is applied again: a hand-in is refused (and logged as a refusal it isn't), a verdict is stored twice. Both are harmless to the card's state; one write for both would close it.
- **`merged → reverted` has no evidence check yet.** The reversing merge is the Merge Gate's to name (0b-9).
- ~~**Two claims, one dead.**~~ Closed by lead call L43. Since L72 the outage rule is the Dispatcher's (M11).
- ~~**The outage raises an alert, not an ask.**~~ Moved to M11 with the outage rule (L72).

## Known gaps (audit round 2, logged, not fixed here)

- **A re-applied hand-in** (the crash gap above) also writes an `outbox_refused` fact that reads as a real refusal. Read it with the gap in mind until one write closes both.
- **A fix card follows any failure**, not only a reviewer's send-back. Whether a crash or a timeout should get a fix round is a lead call.
- **A cancelled fix card ends its parent's fixes.** The next round fixes the fix card, and a cancelled one can't be fixed; the Lead makes a new card with a new go.
- **`verified` takes the worst verdict on the current head (L68; this gap is closed).** Every session the review runner launched on the card at that head is read from the runner's own records and review's outbox (`headReviews`, `worstVerdict` in outbox.mjs), never from the Record's verdict rows: one reviewer must have passed, none failed, none ended without a verdict (L69: silence is a failure), and none be unsettled (not yet marked ended in the runner's `ended/`, file or not), and no auditor may have failed. The ended record holds the sha256 of the verdict file the session ended with, and only that version counts (L69). Sessions at any head with the same tree count (L69; `outbox.treeOf`, else the trees the launch records name). A session Joe set aside (`set-aside/`) has no say, but only while its ended record says `none` and its outbox holds no verdict (L71); a launch record that fails its checks refuses even when set aside. A start that never ran (ended record `never_ran`, L71) has no say until a verdict file shows up in its outbox; then that file counts as it says. A launch record that fails its checks refuses only its own card, and which card it names is read only once its owner and mode are good (L70), so bytes in a file review does not own freeze nothing. What passes is one definition, `PASSES` in outbox.mjs, which the Merge Gate uses too. The Merge Gate judges the same way (M6 refusal 5). A verdict is taken in matched on its card, head and launched session, not on the card's revision (writer.mjs): the Dispatcher's own writes to the card would make a long review stale.
- **A write refused at the read-back** (its diary line is down but reads back wrong) marks the store damaged; the owner decides whether that line stands. Only reachable with a test fault (audit round 3, cosmetic).
- **A claim whose session record is missing is never broken** (deny by default, L32): the Dispatcher writes the session before the claim, so a missing one is a fault to look at, not a dead owner. A claimed card still lapses; a running one shows as overdue at its running limit, for the owner to look at.

## Known gaps (audit round 5, logged, not fixed here)

- **A hand-in for a card whose file was changed by hand is refused for good.** The card is restored and the owner alerted, but the outbox file is marked seen; the session hands in again.
- **No `outbox_refused` fact while the diary is damaged.** The refusal still goes to `refusals.jsonl` and the alert; the fact waits until the owner repairs the diary.
- **`recover()` on damage in the middle of the diary** (not a torn last line) rolls documents back to the last good line before it stops. Writes stay stopped until the owner repairs it, so nothing new is lost, but the documents show the older versions meanwhile.
- **"Store busy" alerts on every pass** while another writer holds the lock, not once a day per cause (L38). Rare: the lock is held for milliseconds.

## Known gaps (audit round 6, logged, not fixed here)

- **A disk error after the commit point** (the rename or the folder sync, once the diary line is down) is reported as "store error, tried again". The write did happen. A retried verdict is then stored twice, and a retried hand-in is refused with an `outbox_refused` fact although it went through. Same family as the round 1 crash gap; one write that also marks the file seen closes both.
- **No test drives a real disk error (an `e.code`) inside an outbox apply.** The code retries it; that branch is unproven by a test.
- **A verdict is not checked to come after its launch.** If the Dispatcher ever reused a session id for a second launch on a new head, a pass written before that launch would count. The Dispatcher (0b-9) must never reuse a session id.
- **A store written before round 6 with an id over 200 characters** stops every write with "bad entity or id", not "damaged". No live store exists yet, so there is nothing to mend; a store made from now on can't get such a line.
- **A hand-edited diary line naming `../x`** makes every later write fail with a plain error rather than "the diary is damaged". It can't reach outside the store; it only blocks writes until the owner repairs the diary.

## Known gaps (audit round 9, logged, not fixed here)

Round 9 changed approach: rather than patching one store name at a time, one check now looks at the whole store folder (each folder must be a real folder, each of its files a plain file) before any open, read or write. A link, a pipe or the wrong kind of thing in place of any name stops the store with one alert naming it, and nothing is read, written, moved or deleted through it. What it leaves:

- **How far to defend against the owner's own hands** is a lead call. These checks treat the owner's links and pipes in the store folder as mistakes to stop on, not attacks; the store isn't hardened against an owner racing the check (swapping a name between the check and the open).
- **A lock or break.lock holding garbage** reads as "store busy", not as a named fault (m1).
- **Quarantined items keep a `.json` name** even when they were a folder or a link, and a link is kept as a link (c1).
- **macOS `._*` files** (left on some shared or external disks) are moved aside as odd, not ignored like `.DS_Store` (c2).
- **The diary's own no-link open and the side files' plain-file check** sit behind the folder check. A planted break of either alone isn't caught, because the folder check already stops the same cases; they stay as a second guard.

## Known gaps (audit round 10, logged, not fixed here)

Round 10 added: a store file with a second name (a hard link) is a layout fault like a link; ids that differ only in upper/lower case are refused (the Mac's default disk would give them one file); one folder recovery can't read is skipped with one alert instead of stopping every write. What it leaves:

- **`diary()` throws when the store can't be read**, where every other read call answers. Kept on purpose and written into `shared/record.mjs`: its callers walk every line, and an empty answer would read as "nothing happened".
- **A document file with a second name** is read and replaced like any other (a replace never changes the other name's file); only the store's own diary and side files are refused for it.
- **Two writes in one batch whose ids differ only in case** are refused by a check no test reaches: no caller writes such a batch today.

## Known gaps (audit round 11, the last confirm under lead call L42)

Round 11 fixed: the round-10 one-name rule wrongly caught the lock, which is made by a hard link from a temp name, so busy stores raised false alerts and a writer killed at the wrong moment stopped the store. The lock files are now exempt, and recovery clears a dead maker's temp name. A refused hand-in's fact now goes down before the file is marked seen, under an id taken from the file, so a kill can't lose it and a replay can't write it twice. What it leaves:

- **A worker can hand in a reviewer's verdict (a lead call, outside L42's scope).** Every AI role writes its outbox as the same everyday Mac user, so "owned by the role's user" can't tell a worker from a reviewer. A worker that writes a passing verdict into a reviewer's outbox folder gets its own card verified. The fix is either one Mac user per role, or the Dispatcher taking verdicts only from a folder that the reviewer alone can write.
- **An unreadable `docs/<entity>` folder alerts once per document in it**, not once per folder.

## Known gaps (lead call L43, logged, not fixed here)

- **A kill between a claim break and its alert** leaves the break in the diary (a `claim_break` line) with no alert sent; the card is already back to ready, so nothing retries it. Same window as any crash; the per-break alert has no seen mark.
- **A Mac with one or two claims breaks them all after a reboot**, since that is under the outage floor of three. That is what L43 asks for; the floor is M11's since L72.

## Running the tests

Plain Node, no packages:

```bash
node --test orchestrate/modules/M9-record/*.test.mjs
```

The pair walk in `moves.test.mjs` and the 8-process race take about a minute together.
