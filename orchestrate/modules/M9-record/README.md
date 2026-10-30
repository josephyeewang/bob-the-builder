# M9-record

M9 Record is the one place a product's cards, asks, claims, waits and facts live, and the Store Writer is the one thing that writes it. Every other module reads and writes through `orchestrate/shared/record.mjs` (see `shared/README.md`); `openRecord()` here is what stands behind that interface in production.

See LANES.md for who builds this folder, and the build rows (0b-2, R-0b-20..28) for what.

## The files

| File | What it does |
|---|---|
| `writer.mjs` | The Store Writer. `openRecord({ root, product, ownerUid, rules, alert, outbox })` checks every write against the rev read, the legal moves, who may change which fields, and each move's conditions (the ready rule, a passing verdict for the current head, a full wait, one merge at a time, the round cap). Refused writes go to `refusals.jsonl` with an alert and leave no diary line. Also: the outbox, claims (release, dead-owner break, lapse), the ready list and overdue. |
| `store.mjs` | The files on disk: one diary line per write (`diary.jsonl`, the truth), one file per document, a lock. Folders 755, files 644, and it runs only as the store's owner. A document changed by hand is quarantined, restored from the diary and alerted. `recover()` after a crash cuts a torn last diary line and rolls each document forward; a writer that finds a torn line under the lock recovers before it appends, and a line that doesn't read back stops the write before any document moves. |
| `lock.mjs` | The store lock, and the one "is this process dead?" check: gone means no such process, or a different start time (a reused pid). A process of another user counts as alive. |
| `moves.mjs` | Every legal state move and who may make it. Anything not listed is refused. |
| `permissions.mjs` | Who may create each entity and change which fields; which card kinds each creator may make. |
| `ready.mjs` | The one ready rule, used by both the move into `ready` and the ready list. |
| `outbox.mjs` | Reads an AI session's outbox file as hostile: no links, one name, the role's owner, 256 KB at most, a kind its role may send. |
| `*.test.mjs` | The tests. `*.test-helper.mjs` are shared set-up, not tests. |

## Claims

A claim is a field on its card: set by `ready → claimed`, cleared when the card leaves claimed and running. A session's claim ends by a release from its holder, a lapse (claimed for longer than the card's `claimed` time limit), or a dead-owner break. A break needs all three of: the process gone, its session ended or gone, and no activity for `claims.stuck_min` minutes. If half or more of this Mac's claims look dead at once, none is broken (an outage) and the owner gets one alert. A claim from another Mac is never broken from this one. A tab's claim is never broken; it lapses when its heartbeat is older than `proposals.heartbeat_stale_min` or at the running limit.

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
- **Two claims, one dead.** The outage rule (half or more dead) stops a two-claim Mac from breaking its one dead claim on its own. That is a lead call to make, not a bug.
- **The outage raises an alert, not an ask.** Only `approvals` writes asks; the alert goes out on the owner's push path once a day (L38).

## Known gaps (audit round 2, logged, not fixed here)

- **A re-applied hand-in** (the crash gap above) also writes an `outbox_refused` fact that reads as a real refusal. Read it with the gap in mind until one write closes both.
- **A fix card follows any failure**, not only a reviewer's send-back. Whether a crash or a timeout should get a fix round is a lead call.
- **A cancelled fix card ends its parent's fixes.** The next round fixes the fix card, and a cancelled one can't be fixed; the Lead makes a new card with a new go.
- **`verified` looks for a passing verdict on the current head** and does not also look for a failing one on the same head. Reviewer and auditor disagreeing on one head is for the Merge Gate (0b-9).
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

## Running the tests

Plain Node, no packages:

```bash
node --test orchestrate/modules/M9-record/*.test.mjs
```

The pair walk in `moves.test.mjs` and the 8-process race take about a minute together.
