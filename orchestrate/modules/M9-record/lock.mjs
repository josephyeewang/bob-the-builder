// lock.mjs — the store lock, and the one "is this process dead?" test (0b-2 M-5, M-6, R2-M11).
//
// WHY. Every Do-plane script loads the Store Writer, so several processes may write at once. One exclusive lock file
// makes each write whole. A lock left by a killed process must be broken, but a live one never: a process owned by
// another user answers kill(pid, 0) with EPERM, and a pid can be reused, so "dead" is ESRCH, or a different start time.
//
//   processDead({ pid, pid_start }, probe?)   → true only when the process is provably gone (check (a) of G1)
//   startTime(pid, { run?, timeoutMs? })       → the process's start time in UTC as "2026-11-10T10:16:00Z", or null
//   pidStart(pid)                              → startTime(pid): the one start-time reader every recorder and checker uses
//   startDiffers(recorded, now)                → true only when both are ISO start times and differ (a reused pid)
//   machineId()                                → this Mac's hardware id (IOPlatformUUID), read once, or null when it can't be read
//   const lock = makeLock({ dir, host, machine, timeoutMs, onBroken })
//   lock.acquire() → { nonce, broke }          // throws 'store busy' after timeoutMs
//   lock.holds(nonce) → boolean                // re-read before the commit point
//   lock.release(nonce)
//   readHolder(dir) → the lock's holder record { pid, pid_start, host, machine, nonce, at } | null (no lock) | { unreadable: true }
//
// The lock file is written whole before it appears (written to a temp name, then hard-linked into place, which fails if
// one exists), so a reader never sees an empty lock. A dead holder's lock is broken only while holding `break.lock`, and
// only after re-reading that the lock is the same one that was found dead.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync, constants } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
export function sleepMs(ms) { Atomics.wait(SLEEP, 0, 0, Math.max(1, ms)); }

// The one start-time reader (L830). ps prints lstart in the Mac's time zone and language, so a time zone change made a live
// process's start time read differently and its lock or claim look like a reused pid's. Here ps runs in UTC and the C
// locale, with a time cap, and the answer is turned into one ISO shape that ps itself never prints. A recorded value in
// that shape is compared exactly; any other recorded value (the local lstart every lock and claim held before L830, or
// anything unreadable) can't be compared, so it never says "reused" (processDead).
export const START_PS_MS = 5000;
export const START_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const START_ENV = Object.freeze({ PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ps -o lstart= in the C locale, read as UTC: "Tue Nov 10 10:16:00 2026" (the day may be space-padded) → ISO, or null.
export function lstartIso(text) {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(String(text ?? '').trim());
  const mon = m ? MONTHS.indexOf(m[1]) : -1;
  if (mon < 0) return null;
  const [d, h, mi, se, y] = [m[2], m[3], m[4], m[5], m[6]].map(Number);
  const t = new Date(Date.UTC(y, mon, d, h, mi, se));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mon || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== se) return null;
  return t.toISOString().replace('.000Z', 'Z');
}

export function startTime(pid, { run = execFileSync, timeoutMs = START_PS_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, env: START_ENV });
    return lstartIso(out);
  } catch { return null; }
}

export function pidStart(pid) { return startTime(pid); }

// This Mac's own id (L826, #364 r1 m5): a lock is "this machine's" when its host name or its machine id matches, so a
// host name change after a crash (macOS renames on a name clash, or the owner renames the Mac) no longer leaves a dead
// holder's lock unbreakable for ever. Only the Mac's hardware id (IOPlatformUUID) counts: a Linux machine-id is often
// the same across containers and cloned machines, which would let one break a live holder's lock in another. Read once
// per process (one ioreg, capped, the first time a lock or a holder check needs it); null falls back to the host name.
export function readMachineId({ run = execFileSync } = {}) {
  try {
    const out = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: START_PS_MS, env: { PATH: '/usr/sbin:/usr/bin:/bin', LC_ALL: 'C' } });
    return /"IOPlatformUUID" = "([0-9A-Fa-f-]{36})"/.exec(String(out))?.[1] ?? null;
  } catch { return null; }
}
let ownMachine;
export function machineId() {
  if (ownMachine === undefined) ownMachine = readMachineId();
  return ownMachine;
}

export const realProbe = Object.freeze({
  kill: (pid) => process.kill(pid, 0),
  pidStart,
});

// (a) of G1. ESRCH means gone; EPERM means alive (another user's process). A live pid whose start time differs from the
// recorded one is a reused pid, so the recorded process is gone. Anything we can't read or compare counts as alive.
export function processDead({ pid, pid_start: recorded } = {}, probe = realProbe) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { probe.kill(pid); } catch (e) {
    if (e?.code === 'ESRCH') return true;
    return false;
  }
  if (!comparable(recorded)) return false;
  let now;
  try { now = probe.pidStart(pid); } catch { return false; }
  return startDiffers(recorded, now);
}

// The one comparison of two start times (L830): true only when both are in the one shape and differ, so the pid was
// reused. A value in any other shape (the local lstart recorded before L830, an unread one) can't be compared: false.
// Every check of a recorded start time is to use it, never a copy of `!==`; the runner's group check (runner-loop.mjs
// groupGone) and leaderStart use startDiffers and startTime (L850 X1).
const comparable = (v) => typeof v === 'string' && START_ISO.test(v);
export function startDiffers(recorded, now) { return comparable(recorded) && comparable(now) && now !== recorded; }

// This process's own start time, kept once read. A ps that failed (a busy Mac, the cap) is not kept as null for ever, which
// would leave this process's locks without a start time to compare, but it is not run again on every lock attempt
// either (#379 r1 m5): a hung ps costs up to START_PS_MS, so a failure is remembered for OWN_RETRY_MS before the next try.
export const OWN_RETRY_MS = 60_000;
let ownStart = null;
let ownFailedAt = -Infinity;
export function ownPidStart({ read = pidStart, now = Date.now } = {}) {
  if (ownStart === null && now() - ownFailedAt >= OWN_RETRY_MS) {
    ownStart = read(process.pid);
    if (ownStart === null) ownFailedAt = now();
  }
  return ownStart;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return e?.code === 'ENOENT' ? null : { unreadable: true }; }
}

// Make `path` exist with `body`, all at once, or report that it already exists.
function createWhole(dir, path, body) {
  const tmp = join(dir, `.lock-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  try { chmodSync(tmp, 0o644); linkSync(tmp, path); return true; } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}

// Who holds the lock in `dir`, read without taking it (L240, L245): the alert channel tells Joe when a live holder has
// kept the Record locked too long, and the age comes from the holder's own `at`.
export function readHolder(dir) { return readJson(join(dir, 'lock')); }

// The one test of a dead holder: one on this host whose process is gone. makeLock breaks only such a lock; the alert
// channel uses the same test to see that a lock is no one's, and leaves breaking it to the store (lane 1's review).
export function holderDead(h, { host = hostname(), machine = machineId(), probe = realProbe } = {}) {
  return !!h && !h.unreadable && onThisMachine(h, { host, machine }) && processDead(h, probe);
}
// A holder is this machine's (L826, #379 r1 m2): when both sides carry a machine id, the id decides, so a renamed Mac is
// still itself and two Macs that share a host name are two. When either id is missing (an older record, an id not read),
// the host name decides, as before. Only a process here can be probed.
const anId = (v) => typeof v === 'string' && v !== '';
export function onThisMachine(h, { host, machine }) {
  if (anId(h?.machine) && anId(machine)) return h.machine === machine;
  return h?.host === host;
}

export function makeLock({ dir, host = hostname(), machine = machineId(), timeoutMs = 10000, probe = realProbe, disabled = false } = {}) {
  const path = join(dir, 'lock');
  const breakPath = join(dir, 'break.lock');
  const isDead = (h) => holderDead(h, { host, machine, probe });
  const me = () => ({ pid: process.pid, pid_start: ownPidStart(), host, ...(machine ? { machine } : {}), nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() });

  function tryBreak(found) {
    const mine = me();
    if (!createWhole(dir, breakPath, JSON.stringify(mine))) {
      // Someone else is breaking it; if that breaker died, clear its break.lock the same way (it holds nothing else).
      const b = readJson(breakPath);
      if (isDead(b)) { try { if (readJson(breakPath)?.nonce === b.nonce) unlinkSync(breakPath); } catch { /* raced */ } }
      return false;
    }
    try {
      const again = readJson(path);
      if (again && found && again.nonce === found.nonce) { unlinkSync(path); return true; }
      return false;
    } finally { try { unlinkSync(breakPath); } catch { /* gone */ } }
  }

  return Object.freeze({
    path,
    acquire() {
      if (disabled) return { nonce: 'disabled', broke: false };   // test-only: the mutation race (M-6)
      const deadline = Date.now() + timeoutMs;
      let broke = false;
      for (;;) {
        const mine = me();
        if (createWhole(dir, path, JSON.stringify(mine))) return { nonce: mine.nonce, broke };
        const h = readJson(path);
        if (isDead(h) && tryBreak(h)) { broke = true; continue; }
        if (Date.now() > deadline) throw Object.assign(new Error(`store busy (lock held by pid ${h?.pid ?? '?'} on ${h?.host ?? '?'})`), { store: true });
        sleepMs(5 + Math.floor(Math.random() * 20));
      }
    },
    holds(nonce) { return disabled || readJson(path)?.nonce === nonce; },
    release(nonce) {
      if (disabled) return;
      if (readJson(path)?.nonce === nonce) unlinkSync(path);
    },
  });
}
