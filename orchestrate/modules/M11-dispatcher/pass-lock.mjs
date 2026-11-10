// Only one Dispatcher pass at a time (review 0b-6 M16; rail A4). The login job can start a pass
// while the last one still runs, and two passes would start sessions past the caps. The lock is a
// file made with "create only if absent", holding the pid and the time it was taken. It is broken
// only when that pid is provably dead; anything else (an unreadable lock, a live pid, a pid we may
// not signal) means "another pass runs" and this pass exits.
//
// Known limit: a pid can be reused after a crash. The lock also holds its start time, so a lock
// whose pid is alive is still respected (fail closed); a reboot clears it because the folder is
// emptied at login (live proof with R-0b-65).
//
// The lock appears whole (L754, #312 Minor): it is written to a file of this pid's own, then linked into place, which fails
// when a lock is there. So no reader ever finds it empty half-way through being taken, which read as "unreadable".
//
// A dead lock is broken by moving it (L771 Minor 1): a rename of it to a name of this pid's own, then a re-read of what was
// moved. Only one taker can move a given file, so only one breaks the dead lock; one that finds the move missing (another
// moved it first) tries the link again. One that moved a lock that is not the dead one (another broke it and linked a live
// lock in between) puts it back and refuses. Deleting it after the check, as before, could delete a live lock another taker
// had just linked, and both passes ran.
// Known limits, each needing takers inside microseconds over one dead lock:
// - A third taker that links in the instant a moved live lock is out of place, or a put-back that fails, leaves two passes
//   running. The refusal carries `moved_live`, and both callers (tick.mjs runTick, robot-main) tell Joe, once a day (L785 m1).
// - release() still reads, then deletes (L785 m3): a holder whose lock another taker moved after the read, while a third
//   linked into the place, deletes that third's live lock, and the third runs with no lock in place.
// - A put-back of a lock its holder has since released leaves that lock behind, so a later pass breaks it and says a pass
//   was stopped (one false tell). It needs the mover to stall across the holder's whole pass: it read the dead lock before
//   the holder broke it, and moved the holder's lock only after the holder released.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync, renameSync } from 'node:fs';

/** True only when the pid surely does not exist. Permission errors mean it exists. */
export function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/**
 * Takes the lock. Returns { ok: true, release, broke } or { ok: false, reason, held?, moved_live?, broke? } (`broke` once
 * this taker broke a dead lock, whether or not it then holds; L800 M-A): `held` is the live holder's lock as read
 * (L754), so a caller never reads the file a second time, when it may be gone or another's. `dead(pid)` is for tests.
 */
export function takePassLock(file, { pid = process.pid, now = Date.now(), dead = pidDead } = {}) {
  // `broke` is the dead pass's lock when this one broke it, so the caller can tell Joe. It rides on a refusal too: a late
  // taker can link into the gap after the break, and then it holds with nothing to tell (L800 M-A).
  let broke = null;
  const refuse = (r) => (broke ? { ...r, broke } : r);
  for (let attempt = 0; attempt < 2; attempt++) {
    const mine = `${file}.${pid}.new`;
    try { unlinkSync(mine); } catch { /* none left from a crash */ }
    let fd;
    try { fd = openSync(mine, 'wx', 0o600); } catch (e) { return refuse({ ok: false, reason: `could not take the pass lock: ${e.code}` }); }
    try { writeSync(fd, JSON.stringify({ pid, taken_at: new Date(now).toISOString() })); } finally { closeSync(fd); }
    let linked = null;
    try { linkSync(mine, file); linked = true; } catch (e) { linked = e; }
    try { unlinkSync(mine); } catch { /* the lock itself is kept */ }
    if (linked !== true) {
      if (linked?.code !== 'EEXIST') return refuse({ ok: false, reason: `could not take the pass lock: ${linked?.code ?? linked}` });
      let held;
      // A lock gone between the link and the read was released (or broken) just then: try the link again, never "unreadable".
      try { held = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
        if (e?.code === 'ENOENT') continue;
        return refuse({ ok: false, reason: 'the pass lock is unreadable; another pass may run' });
      }
      if (!dead(held?.pid)) return refuse({ ok: false, reason: `another pass runs (pid ${held?.pid})`, held });
      const moved = `${file}.${pid}.dead`;
      try { unlinkSync(moved); } catch { /* none left from a crash */ }
      try { renameSync(file, moved); } catch (e) {
        // Another taker moved it first: try the link again. `held` was judged dead and a dead holder never releases, so
        // only a breaker moved it: the dead lock was broken, and whichever taker holds tells it (L785 M1).
        if (e?.code === 'ENOENT') { broke = held; continue; }
        return refuse({ ok: false, reason: 'could not break a dead pass lock' });
      }
      let was = null; try { was = JSON.parse(readFileSync(moved, 'utf8')); } catch { /* checked below */ }
      if (was?.pid !== held?.pid || was?.taken_at !== held?.taken_at) {
        // Not the dead lock: another taker broke it and linked its own in between. Put that one back and refuse.
        // Only EEXIST means a third took the place; any other failure of the link puts it back by rename, or leaves it where
        // it is, never deleted (self-review Minor 2).
        let back = false; let third = false;
        try { linkSync(moved, file); back = true; } catch (e) { third = e?.code === 'EEXIST'; }
        if (!back && !third) { try { renameSync(moved, file); back = true; } catch { /* left at `moved`: told below */ } }
        else { try { unlinkSync(moved); } catch { /* gone */ } }
        const who = was ? `pid ${was.pid}` : 'a lock that could not be read';
        // The holder put back is judged like any holder read, so a caller's `dead` sees it (robot-main's exit code; self-review Minor 1).
        if (back) { if (was) dead(was.pid); return refuse({ ok: false, reason: `another pass runs (${who})`, held: was }); }
        return refuse({ ok: false, reason: third ? `another pass runs (${who}); its lock was moved while breaking a dead one and a third took the place`
          : `another pass runs (${who}); its lock was moved while breaking a dead one and could not be put back (it is at ${moved})`, held: was, moved_live: true });
      }
      try { unlinkSync(moved); } catch { /* the dead lock is out of place either way */ }
      broke = held;
      continue;
    }
    return {
      ok: true,
      broke,
      release() {
        try { const h = JSON.parse(readFileSync(file, 'utf8')); if (h.pid === pid) unlinkSync(file); } catch { /* already gone */ }
      },
    };
  }
  return refuse({ ok: false, reason: 'the pass lock was taken again while breaking it' });
}
