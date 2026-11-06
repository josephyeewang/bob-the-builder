// unsent.mjs — the store's unsent-alerts.jsonl, read and marked from outside a transaction, and the plain-file opens
// the store's side files use (L240).
//
// WHY its own file. M9's store.mjs commits without the Store Writer's checks, so only M9 may load it (#91 r2 audit N9).
// The alert channel (M13 alert-channel.mjs) must read this one queue and mark entries delivered while the Dispatcher
// is dead, so the queue's reader and its one mark live here, where loading them reaches no write of a document.
// store.mjs uses the same helpers, so there is one way to open a side file.

import { closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, unlinkSync, writeSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
// only ever overwritten in place. That needs no new space: checked on full HFS+ and APFS RAM disks with no local
// snapshot of the volume, macOS 27.0.1 (one holder on 5 Nov 2026, two holders merged on 6 Nov). A capability claim,
// void on a new macOS until re-run (ORCH_FULLDISK_TEST=1, test/diary-damaged-told.test.mjs). On APFS a block shared
// with a local snapshot (Time Machine, or the one an OS update makes) is copy-on-write, so the overwrite may then need
// a new block: setHeldFlag throws, and the case falls back to the round's disk check (#260 r3 m4). One JSON object
// padded with spaces when set, all spaces when clear. The robot's delivery pass reads it, tells it once, clears it.
//
// Several processes may hold at once (#260 r3 M1): two Dispatcher passes a minute apart on a disk that stays full, or
// the robot's own process. So a set merges, never overwrites: the first holder's fields stay at the top (pid, token,
// at, held, dropped, and its first warning's id and event, the one the robot tells), each later holder is one entry in
// `also` ({ pid, token, at, held, dropped }), and `total` sums them all. A holder is a store instance: its pid and a
// random token (newHeldToken), so a later process given a dead one's pid is a different holder (#260 r3 m1). When the
// file can't take every entry, the oldest of `also` are folded into `cut` (counted, not named); the first holder, its
// warning's id and `total` are never dropped. `gen` goes up at every write, so no two writes read the same.
//
// No lock (#260 r3 m2, option b): the store lock can't be taken on a full disk (lock.mjs createWhole writes a new
// file), and a set comes from keep() and keepAlert(), which also run outside it (store.mjs alertOrKeep, keepAlert and
// the diary read in refresh). So a clear compares what it told, reads the flag again just before it writes, and keeps
// one that changed. A write can still land in the moment between another's read and its write, and be overwritten,
// so a setter reads the flag again HELD_FLAG_SETTLE_MS later and merges itself back in if its entry is gone. What is
// left is told twice, never lost, except for a writer stalled longer than that between two of its system calls.
export const HELD_FLAG = 'held-flag';
export const HELD_FLAG_BYTES = 4096;
export const HELD_FLAG_SETTLE_MS = 10;
const BLANK = () => Buffer.alloc(HELD_FLAG_BYTES, 0x20);
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const OWN = new Set();
/** A random token for one store instance in this process; isOwnHolder knows it. */
export function newHeldToken() { const t = randomBytes(8).toString('hex'); OWN.add(t); return t; }
/** Whether a flag entry is a store instance in this process: its pid and a token made here. */
export const isOwnHolder = (h) => !!h && h.pid === process.pid && typeof h.token === 'string' && OWN.has(h.token);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sameHolder = (a, b) => !!a && !!b && a.pid === b.pid && (a.token ?? null) === (b.token ?? null);
const entryOf = (x) => ({ pid: x.pid ?? null, token: x.token ?? null, at: x.at ?? null, held: count(x.held), dropped: count(x.dropped) });
const cutOf = (c) => ({ holders: count(c?.holders), held: count(c?.held), dropped: count(c?.dropped) });
/** Every holder the flag names, first one first, as written (counts not coerced). A cleared first slot is skipped. */
export function heldHolders(flag) {
  if (!isObj(flag)) return [];
  const first = { pid: flag.pid, token: flag.token, at: flag.at, held: flag.held, dropped: flag.dropped, first: true };
  const keepFirst = flag.pid != null || count(flag.held) > 0 || count(flag.dropped) > 0 || isObj(flag.event);
  return [...(keepFirst ? [first] : []), ...(Array.isArray(flag.also) ? flag.also.filter(isObj) : [])];
}
/** The holders folded out of the flag for room: { holders, held, dropped }, zeros when none. */
export const heldCut = (flag) => cutOf(isObj(flag) ? flag.cut : null);
const withTotal = (f) => {
  const all = heldHolders(f).map(entryOf);
  const c = cutOf(f.cut);
  return { ...f, total: { holders: all.length + c.holders, held: all.reduce((a, h) => a + h.held, c.held), dropped: all.reduce((a, h) => a + h.dropped, c.dropped) } };
};
// The text that fits HELD_FLAG_BYTES: the warning's event shrunk first, then the oldest of `also` folded into `cut`,
// then the event dropped (its id kept), then all of `also`. `total` is worked out first and never changes here.
const fits = (t) => Buffer.byteLength(t) <= HELD_FLAG_BYTES;
function fitText(f) {
  let x = withTotal(f);
  let t = JSON.stringify(x);
  if (fits(t)) return t;
  if (isObj(x.event)) {
    const e = x.event;
    const cut = (v) => (typeof v === 'string' ? v.slice(0, 600) : undefined);
    x = { ...x, event: { type: String(e.type ?? 'unknown').slice(0, 100), reason: cut(e.reason), text: cut(e.text), at: cut(e.at) } };
    t = JSON.stringify(x);
  }
  const fold = (g) => { const c = cutOf(x.cut); x = { ...x, also: x.also.slice(1), cut: { holders: c.holders + 1, held: c.held + count(g.held), dropped: c.dropped + count(g.dropped) } }; t = JSON.stringify(x); };
  while (!fits(t) && x.also.length > 1) fold(x.also[0]);
  if (!fits(t) && x.event) { x = { ...x, event: null }; t = JSON.stringify(x); }
  while (!fits(t) && x.also.length) fold(x.also[0]);
  if (!fits(t)) t = JSON.stringify({ gen: x.gen, pid: x.pid, token: x.token, at: String(x.at ?? '').slice(0, 40), held: x.held, dropped: x.dropped, id: String(x.id ?? '').slice(0, 64) || null, event: null, also: [], cut: { holders: x.total.holders - 1, held: x.total.held - count(x.held), dropped: x.total.dropped - count(x.dropped) }, total: x.total });
  return t;
}
const bytesOf = (t) => { const b = BLANK(); Buffer.from(t, 'utf8').copy(b); return b; };
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
    const b = BLANK();
    if (writeSync(fd, b, 0, b.length, 0) !== b.length) throw Object.assign(new Error(`${HELD_FLAG} could not be made whole`), { code: 'ENOSPC' });
    fsyncSync(fd);
  } catch (e) { closeSync(fd); fd = undefined; try { unlinkSync(f); } catch { /* gone */ } throw e; } finally { if (fd !== undefined) closeSync(fd); }
}
// The flag with holder `x` merged in: x's own entry is replaced (the top one if x is first, with x's first warning),
// any other holder is kept as it was, and a newcomer goes at the end of `also`. A flag that can't be read is replaced,
// and says so (torn_before), as the holders it named are not known.
function merged(cur, x) {
  const me = entryOf(x);
  const gen = count(cur?.flag?.gen) + 1;
  const f = cur?.flag;
  if (!f) return { gen, ...me, id: x.id ?? null, event: x.event ?? null, also: [], ...(cur ? { torn_before: true } : {}) };
  const also = (Array.isArray(f.also) ? f.also.filter(isObj) : []).map(entryOf);
  const keep = { ...(f.cut ? { cut: cutOf(f.cut) } : {}), ...(f.torn_before ? { torn_before: true } : {}) };
  const top = entryOf(f);
  if (heldHolders(f)[0]?.first && sameHolder(top, me)) return { gen, ...me, at: top.at ?? me.at, id: x.id ?? null, event: x.event ?? null, also, ...keep };
  if (!heldHolders(f)[0]?.first) return { gen, ...me, id: x.id ?? null, event: x.event ?? null, also, ...keep };   // a cleared first slot
  const i = also.findIndex((h) => sameHolder(h, me));
  if (i >= 0) also[i] = { ...me, at: also[i].at ?? me.at }; else also.push(me);
  return { gen, ...top, id: f.id ?? null, event: f.event ?? null, also, ...keep };
}
const holds = (flag, x) => heldHolders(flag).some((h) => sameHolder(h, x));
/**
 * Merges this holder into the flag: x = { pid, token, at, held, dropped, id, event }, its own first held warning's id
 * and event. Then, `settleMs` later, checks the entry is still there, and merges it back if a rewrite elsewhere took it
 * (at most `tries` times). Throws when it can't write. `afterWrite` is a test seam: another writer landing then.
 */
export function setHeldFlag(root, x, { settleMs = HELD_FLAG_SETTLE_MS, tries = 3, afterWrite } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const cur = readHeldFlag(root);
    overwriteFlag(root, bytesOf(fitText(merged(cur, x))));
    afterWrite?.(i);
    if (!(settleMs > 0)) return;
    Atomics.wait(SLEEP, 0, 0, settleMs);
    const after = readHeldFlag(root);
    if (after?.flag && holds(after.flag, x)) return;
  }
}
/** null when clear or missing; { raw, flag } when set (`flag` is null when its text can't be read, as a torn write). */
export function readHeldFlag(root) {
  let raw;
  try { raw = readPlain(join(root, HELD_FLAG)); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  if (!raw.trim()) return null;
  let flag = null;
  try { const x = JSON.parse(raw.trim()); if (isObj(x)) flag = x; } catch { /* torn */ }
  return { raw, flag };
}
// The flag with only the holders `keep` accepts. The first holder's warning goes with it; a later holder moved to the
// top has none to tell. Folded counts (`cut`) stay. null when nothing is left.
function keptOnly(f, keep) {
  const [top, ...rest] = heldHolders(f).map((h) => ({ h, e: entryOf(h) }));
  const also = rest.filter(({ h }) => keep(h)).map(({ e }) => e);
  const c = cutOf(f.cut);
  const extra = { ...(c.holders ? { cut: c } : {}), ...(f.torn_before ? { torn_before: true } : {}) };
  const gen = count(f.gen) + 1;
  if (top?.h.first && keep(top.h)) return { gen, ...top.e, id: f.id ?? null, event: f.event ?? null, also, ...extra };
  if (also.length) return { gen, ...also[0], id: null, event: null, also: also.slice(1), ...extra };
  if (c.holders) return { gen, pid: null, token: null, at: null, held: 0, dropped: 0, id: null, event: null, also: [], ...extra };
  return null;
}
/**
 * Clears the flag if it still reads `raw` (what was told), so a flag set again since is kept. With `keep`, the holders
 * it accepts stay (the robot's own, told from its held list). It reads again just before it writes, so a set that
 * landed after the compare is kept too. Throws when it can't. `between` is a test seam: a set landing after the compare.
 */
export function clearHeldFlag(root, raw, { keep, between } = {}) {
  const now = readHeldFlag(root);
  if (!now || (raw !== undefined && now.raw !== raw)) return false;
  const left = keep && now.flag ? keptOnly(now.flag, keep) : null;
  between?.();
  if (readHeldFlag(root)?.raw !== now.raw) return false;
  overwriteFlag(root, left ? bytesOf(fitText(left)) : BLANK());
  return true;
}
/** Drops one holder's own entry ({ pid, token }); the flag is cleared only when nothing else is left. */
export function dropHeldHolder(root, x) {
  const f = readHeldFlag(root);
  if (!f?.flag || !holds(f.flag, x)) return false;
  return clearHeldFlag(root, f.raw, { keep: (h) => !sameHolder(h, x) });
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
