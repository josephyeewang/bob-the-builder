// Only one Dispatcher pass at a time (review 0b-6 M16; rail A4). The login job can start a pass
// while the last one still runs, and two passes would start sessions past the caps. The lock is a
// file made with "create only if absent", holding the pid and the time it was taken. It is broken
// only when that pid is provably dead; anything else (an unreadable lock, a live pid, a pid we may
// not signal) means "another pass runs" and this pass exits.
//
// Known limit: a pid can be reused after a crash. The lock also holds its start time, so a lock
// whose pid is alive is still respected (fail closed); a reboot clears it because the folder is
// emptied at login (live proof with R-0b-65).

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';

/** True only when the pid surely does not exist. Permission errors mean it exists. */
export function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/**
 * Takes the lock. Returns { ok: true, release, broke } or { ok: false, reason }. `dead(pid)` is for tests.
 */
export function takePassLock(file, { pid = process.pid, now = Date.now(), dead = pidDead } = {}) {
  // `broke` is the dead pass's lock when this one broke it, so the caller can tell Joe.
  let broke = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = openSync(file, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: `could not take the pass lock: ${e.code}` };
      let held;
      try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'the pass lock is unreadable; another pass may run' }; }
      if (!dead(held?.pid)) return { ok: false, reason: `another pass runs (pid ${held?.pid})` };
      try { unlinkSync(file); } catch { return { ok: false, reason: 'could not break a dead pass lock' }; }
      broke = held;
      continue;
    }
    writeSync(fd, JSON.stringify({ pid, taken_at: new Date(now).toISOString() }));
    closeSync(fd);
    return {
      ok: true,
      broke,
      release() {
        try { const h = JSON.parse(readFileSync(file, 'utf8')); if (h.pid === pid) unlinkSync(file); } catch { /* already gone */ }
      },
    };
  }
  return { ok: false, reason: 'the pass lock was taken again while breaking it' };
}
