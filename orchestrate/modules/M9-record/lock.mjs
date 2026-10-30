// lock.mjs — the store lock, and the one "is this process dead?" test (0b-2 M-5, M-6, R2-M11).
//
// WHY. Every Do-plane script loads the Store Writer, so several processes may write at once. One exclusive lock file
// makes each write whole. A lock left by a killed process must be broken, but a live one never: a process owned by
// another user answers kill(pid, 0) with EPERM, and a pid can be reused, so "dead" is ESRCH, or a different start time.
//
//   processDead({ pid, pid_start }, probe?)   → true only when the process is provably gone (check (a) of G1)
//   pidStart(pid)                              → the process's start time as `ps -o lstart=` prints it, or null
//   const lock = makeLock({ dir, host, timeoutMs, onBroken })
//   lock.acquire() → { nonce, broke }          // throws 'store busy' after timeoutMs
//   lock.holds(nonce) → boolean                // re-read before the commit point
//   lock.release(nonce)
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

export function pidStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.trim() || null;
  } catch { return null; }
}

export const realProbe = Object.freeze({
  kill: (pid) => process.kill(pid, 0),
  pidStart,
});

// (a) of G1. ESRCH means gone; EPERM means alive (another user's process). A live pid whose start time differs from the
// recorded one is a reused pid, so the recorded process is gone. Anything we can't read counts as alive.
export function processDead({ pid, pid_start: recorded } = {}, probe = realProbe) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { probe.kill(pid); } catch (e) {
    if (e?.code === 'ESRCH') return true;
    return false;
  }
  if (typeof recorded !== 'string' || !recorded) return false;
  let now;
  try { now = probe.pidStart(pid); } catch { return false; }
  return typeof now === 'string' && now !== '' && now !== recorded;
}

let ownStart;
export function ownPidStart() {
  if (ownStart === undefined) ownStart = pidStart(process.pid);
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

export function makeLock({ dir, host = hostname(), timeoutMs = 10000, probe = realProbe, disabled = false } = {}) {
  const path = join(dir, 'lock');
  const breakPath = join(dir, 'break.lock');
  const isDead = (h) => !!h && !h.unreadable && h.host === host && processDead(h, probe);
  const me = () => ({ pid: process.pid, pid_start: ownPidStart(), host, nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() });

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
