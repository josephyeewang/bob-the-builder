// unsent.mjs — the store's unsent-alerts.jsonl, read and marked from outside a transaction, and the plain-file opens
// the store's side files use (L240).
//
// WHY its own file. M9's store.mjs commits without the Store Writer's checks, so only M9 may load it (#91 r2 audit N9).
// The alert channel (M13 alert-channel.mjs) must read this one queue and mark entries delivered while the Dispatcher
// is dead, so the queue's reader and its one mark live here, where loading them reaches no write of a document.
// store.mjs uses the same helpers, so there is one way to open a side file.

import { closeSync, fchmodSync, fstatSync, openSync, readFileSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';

// The store's own side files are opened without following a link or waiting on a FIFO, and only a plain file is
// written or read: a link in their place must not let a refusal or a seen mark land outside the store (round 9).
export function plainFd(path, flags) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1) throw Object.assign(new Error(`${path} is not a plain file with one name`), { store: true }); } catch (e) { closeSync(fd); throw e; }
  return fd;
}
export function appendPlain(path, text) {
  const fd = plainFd(path, constants.O_WRONLY | constants.O_APPEND);
  try { fchmodSync(fd, 0o644); writeSync(fd, text); } finally { closeSync(fd); }
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
