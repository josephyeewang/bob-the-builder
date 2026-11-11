// M4's reader for the rules snapshot (launch check 8; review 0b-3 M4, m9).
//
// The rules publish a snapshot file the hooks and the launcher read instead of asking anything
// live. Shape assumed until lane 1's shared reader lands: { written_at: ISO, hash, rules } with
// hash = sha256 of JSON.stringify(rules). Missing, unreadable, bad hash, or older than 5 minutes
// means refuse.
//
// A stale snapshot refuses EVERY call, even `ls`, by design: the loop rewrites it every pass, so a
// stale one means nothing is keeping the rules current. The refusal says so (lane 3 corpus run).
// A run that writes its own snapshot (a test corpus, a fake) and lasts longer than the limit keeps
// it fresh with `keepSnapshotFresh`, never by raising the limit.

import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fstatSync, closeSync, constants as FS } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

export const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const refuse = (reason) => ({ ok: false, reason });

export const snapshotHash = (rules) => createHash('sha256').update(JSON.stringify(rules)).digest('hex');

// The worker runner's keepSnapshotFresh call is lane 4's runner (wiring/runner-main.mjs, runner stages s6/s7), not on
// main yet; the wording is for when it lands (lane 4's #369 r1 note).
export function staleReason(ageMs, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  return `rules snapshot is stale (${Math.round(ageMs / 1000)} s old, the limit is ${Math.round(maxAgeMs / 1000)} s), `
    + 'so every call is refused until it is rewritten; the loop rewrites it every pass for its own sessions, and the '
    + 'worker runner for a worker session it started (keepSnapshotFresh), so a stale one means whichever wrote it has '
    + 'stopped, or a run that wrote its own snapshot outlasted it (keep it fresh with keepSnapshotFresh)';
}

export function parseSnapshot(text, { now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = {}) {
  let s; try { s = JSON.parse(text); } catch { return refuse('rules snapshot is not JSON'); }
  if (!s || typeof s !== 'object' || !s.rules || typeof s.rules !== 'object') return refuse('rules snapshot has no rules');
  if (typeof s.hash !== 'string' || snapshotHash(s.rules) !== s.hash) return refuse('rules snapshot hash does not match');
  const at = Date.parse(s.written_at);
  if (!Number.isFinite(at)) return refuse('rules snapshot has no time');
  const age = now - at;
  if (age > maxAgeMs) return refuse(staleReason(age, maxAgeMs));
  if (age < -60000) return refuse('rules snapshot is from the future');
  return { ok: true, rules: s.rules, writtenAt: s.written_at, hash: s.hash };
}

/**
 * Reads the snapshot through one open handle, and only a plain file with one name (#439 m4): a second name (a hard link
 * made elsewhere) would let whoever holds that name change the rules the hooks read, from outside the walled folder.
 * The runner replaces the file by rename, so the snapshot it writes always has one name.
 */
export function readSnapshot(path, opts = {}) {
  // Opened without waiting (O_NONBLOCK), so a pipe planted at the name can't hang a hook; it is then refused as not a file.
  let fd; try { fd = openSync(path, FS.O_RDONLY | FS.O_NONBLOCK); } catch { return refuse('rules snapshot is missing or unreadable'); }
  try {
    let st; try { st = fstatSync(fd); } catch { return refuse('rules snapshot is missing or unreadable'); }
    if (!st.isFile()) return refuse('rules snapshot is not a plain file');
    if (st.nlink !== 1) return refuse(`rules snapshot has ${st.nlink} names (a hard link); it must have one`);
    let text; try { text = readFileSync(fd, 'utf8'); } catch { return refuse('rules snapshot is missing or unreadable'); }
    return parseSnapshot(text, opts);
  } finally { try { closeSync(fd); } catch { /* closed */ } }
}

/** For tests and the fake: builds a snapshot file body. */
export function makeSnapshot(rules, at = new Date()) {
  return JSON.stringify({ written_at: at.toISOString(), hash: snapshotHash(rules), rules });
}

/**
 * Writes a snapshot whole: to a side file first, then renamed, so a hook never reads half of one (L921). The side file
 * is made new ('wx': refused if anything is at that name, a link included, so nothing planted there is written through)
 * under a random name nobody can guess ahead; if the write or the rename fails, the side file is removed and the error
 * thrown, so no half-written side file is left behind.
 */
export function writeSnapshot(path, rules, at = new Date()) {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, makeSnapshot(rules, at), { flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    // Only a side file this call made is removed: one refused by 'wx' was never ours (EEXIST).
    if (e?.code !== 'EEXIST') { try { unlinkSync(tmp); } catch { /* not made, or gone */ } }
    throw e;
  }
}

/**
 * For a run that writes its own snapshot and may outlast the limit (a test corpus, the fake loop):
 * writes it now and again every `everyMs` (default a minute, well inside the limit) until `stop()`.
 * The timer never keeps the process alive. A rewrite that fails stops the refresher and is kept in
 * `error()`, so a deleted folder can't throw from a timer; the snapshot then goes stale and every
 * call is refused, as it should be.
 */
export function keepSnapshotFresh(path, rules, { everyMs = 60_000, clock = () => new Date(), timers = { setInterval, clearInterval } } = {}) {
  if (!(typeof everyMs === 'number' && everyMs > 0 && everyMs < SNAPSHOT_MAX_AGE_MS)) throw new Error(`keepSnapshotFresh: everyMs must be a number above 0 and below ${SNAPSHOT_MAX_AGE_MS}`);
  writeSnapshot(path, rules, clock());
  let failed = null;
  const t = timers.setInterval(() => {
    try { writeSnapshot(path, rules, clock()); } catch (e) { failed = e; timers.clearInterval(t); }
  }, everyMs);
  t?.unref?.();
  return { stop: () => timers.clearInterval(t), error: () => failed };
}
