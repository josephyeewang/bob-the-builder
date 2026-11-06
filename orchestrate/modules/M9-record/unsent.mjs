// unsent.mjs — the store's unsent-alerts.jsonl, read and marked from outside a transaction, and the plain-file opens
// the store's side files use (L240).
//
// WHY its own file. M9's store.mjs commits without the Store Writer's checks, so only M9 may load it (#91 r2 audit N9).
// The alert channel (M13 alert-channel.mjs) must read this one queue and mark entries delivered while the Dispatcher
// is dead, so the queue's reader and its one mark live here, where loading them reaches no write of a document.
// store.mjs uses the same helpers, so there is one way to open a side file.

import { closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';

// The store's own side files are opened without following a link or waiting on a FIFO, and only a plain file is
// written or read: a link in their place must not let a refusal or a seen mark land outside the store (round 9).
export function plainFd(path, flags) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1) throw Object.assign(new Error(`${path} is not a plain file with one name`), { store: true }); } catch (e) { closeSync(fd); throw e; }
  return fd;
}
// One whole line or nothing (#260 r1 M1). On a full disk write() can land part of a line and return a short count with
// no error. A short write is cut back off the file's end and thrown, so the caller holds what it meant to write (the
// store keeps the warning in memory) and no half line is left for the next one to run into. Every line goes in with a
// newline first, so it parses on its own after any cut line, whoever left it and whenever (#260 r2 m1): the readers
// skip the empty lines that makes. The cut-back only removes bytes that are still the file's last ones and match
// ours, and never a lone newline, which is harmless and may be another writer's last byte (#260 r2 c1). `write` is a
// test seam.
export function appendPlain(path, text, { write = writeSync } = {}) {
  const fd = plainFd(path, constants.O_RDWR | constants.O_APPEND);
  try {
    fchmodSync(fd, 0o644);
    const bytes = Buffer.from(`\n${text}`, 'utf8');
    const n = write(fd, bytes);
    if (n !== bytes.length) {
      const size = fstatSync(fd).size;
      if (n > 1 && size >= n) {
        const tail = Buffer.alloc(n);
        if (readSync(fd, tail, 0, n, size - n) === n && tail.equals(bytes.subarray(0, n))) ftruncateSync(fd, size - n);
      }
      throw Object.assign(new Error(`${path}: only ${n} of ${bytes.length} bytes were written (is the disk full?)`), { code: 'ENOSPC' });
    }
  } finally { closeSync(fd); }
}
// ---- held-flag: a lasting mark that a process holds warnings on no disk (#260 r2 M1) ----
// A process that can't write a warning's line (a full disk) holds it in memory, and the Dispatcher exits after each
// pass, so the warning would die with it. The flag is a file of a fixed HELD_FLAG_BYTES, made at store open, and is
// only ever overwritten in place: that needs no new space (checked on full HFS+ and APFS RAM disks, macOS 27.0.1,
// 5 Nov 2026). One JSON object padded with spaces when set, all spaces when clear. The robot's delivery pass reads
// it, tells it once and clears it.
export const HELD_FLAG = 'held-flag';
export const HELD_FLAG_BYTES = 4096;
const flagText = (x) => {
  let t = JSON.stringify(x);
  if (Buffer.byteLength(t) > HELD_FLAG_BYTES) {
    const e = x.event ?? {};
    const cut = (v) => (typeof v === 'string' ? v.slice(0, 600) : undefined);
    t = JSON.stringify({ ...x, event: { type: String(e.type ?? 'unknown').slice(0, 100), reason: cut(e.reason), text: cut(e.text), at: cut(e.at) } });
  }
  const b = Buffer.alloc(HELD_FLAG_BYTES, 0x20);
  const body = Buffer.byteLength(t) <= HELD_FLAG_BYTES ? t : JSON.stringify({ pid: x.pid, at: x.at, held: x.held, dropped: x.dropped });
  Buffer.from(body, 'utf8').copy(b);
  return b;
};
function overwriteFlag(root, b) {
  const fd = plainFd(join(root, HELD_FLAG), constants.O_WRONLY);
  try {
    if (fstatSync(fd).size !== HELD_FLAG_BYTES) throw new Error(`${HELD_FLAG} is not ${HELD_FLAG_BYTES} bytes`);
    const n = writeSync(fd, b, 0, b.length, 0);
    if (n !== b.length) throw Object.assign(new Error(`${HELD_FLAG}: only ${n} of ${b.length} bytes were written`), { code: 'ENOSPC' });
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Made clear at store open if it is missing (it then takes its one block). Throws when it can't be made. */
export function makeHeldFlag(root) {
  const f = join(root, HELD_FLAG);
  let fd;
  try { fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); } catch (e) { if (e?.code === 'EEXIST') return; throw e; }
  try {
    const b = Buffer.alloc(HELD_FLAG_BYTES, 0x20);
    if (writeSync(fd, b, 0, b.length, 0) !== b.length) throw Object.assign(new Error(`${HELD_FLAG} could not be made whole`), { code: 'ENOSPC' });
    fsyncSync(fd);
  } catch (e) { closeSync(fd); fd = undefined; try { unlinkSync(f); } catch { /* gone */ } throw e; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Sets the flag: { pid, at, held, dropped, id, event }, the first held warning's id and event. Throws when it can't. */
export function setHeldFlag(root, x) { overwriteFlag(root, flagText(x)); }
/** null when clear or missing; { raw, flag } when set (`flag` is null when its text can't be read, as a torn write). */
export function readHeldFlag(root) {
  let raw;
  try { raw = readPlain(join(root, HELD_FLAG)); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  if (!raw.trim()) return null;
  let flag = null;
  try { const x = JSON.parse(raw.trim()); if (x && typeof x === 'object' && !Array.isArray(x)) flag = x; } catch { /* torn */ }
  return { raw, flag };
}
/** Clears the flag if it still reads `raw` (what was told), so a flag set again since is kept. Throws when it can't. */
export function clearHeldFlag(root, raw) {
  const now = readHeldFlag(root);
  if (!now || (raw !== undefined && now.raw !== raw)) return false;
  overwriteFlag(root, Buffer.alloc(HELD_FLAG_BYTES, 0x20));
  return true;
}

export function readPlain(path) { const fd = plainFd(path, constants.O_RDONLY); try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); } }

// ---- unsent-alerts.jsonl: the one reader and the one 'delivered' mark (L240) ----
// Read by resend() at every transaction and by the alert channel (M13 alert-channel.mjs) in the robot job, which delivers
// them while the Dispatcher is dead. A line that is not whole JSON (a torn write) is skipped: it neither waits nor marks
// anything sent. The file is only ever appended to, so a mark from outside the lock never races a resend; both may
// send one alert twice, never lose it.
export const UNSENT = 'unsent-alerts.jsonl';
function unsentIn(text) {
  const done = new Set();
  const waiting = [];
  for (const l of String(text).split('\n')) {
    let x; try { x = JSON.parse(l); } catch { continue; }
    if (x?.outcome === 'sent' && typeof x.id === 'string') done.add(x.id);
    else if (x?.outcome === 'unsent' && typeof x.id === 'string' && x.event && typeof x.event === 'object') waiting.push(x);
  }
  return waiting.filter((x) => !done.has(x.id));
}
/** The store's alerts not yet delivered: [{ id, event }], oldest first. Throws when the file can't be read as a plain file. */
export function readUnsent(root) { return unsentIn(readPlain(join(root, UNSENT))).map(({ id, event }) => ({ id, event })); }
/**
 * Marks one delivered: one line, appended in a single write() with O_APPEND (appendPlain), well under the size a write
 * lands whole in. Throws when it can't be written; the alert then stays unsent and is delivered again.
 */
export function markSent(root, id, at) {
  if (typeof id !== 'string' || !id) throw new Error('markSent needs an entry id');
  appendPlain(join(root, UNSENT), `${JSON.stringify({ id, outcome: 'sent', at: String(at) })}\n`);
}
