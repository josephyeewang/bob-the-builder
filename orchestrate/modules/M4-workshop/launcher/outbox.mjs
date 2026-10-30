// Launch check 3 and the outbox intake (R-0b-38).
//
// Check 3: before a role starts, its outbox is emptied, but only once nothing is still running
// that could write there (the process check is injected; on the Mini it wraps the system tools,
// review 0b-3 m5). The outbox itself may not be a link. Anything that is not a plain, flat file
// with an allowed name (a dot-name, a sub-folder, a link) is removed and raises an alert, since
// the role should never have been able to make it.
//
// Intake: a file is read only through a handle opened without following links, and only if the
// open file is a plain file with one link, owned by the role's user, with a name of the form
// <kind>-<id>.(md|json|txt) for one of the role's kinds.

import { lstatSync, readdirSync, rmSync, openSync, fstatSync, readFileSync, closeSync, constants as C } from 'node:fs';
import { join } from 'node:path';

export const OUTBOX_NAME = /^([a-z]+)-[A-Za-z0-9-]+\.(md|json|txt)$/;
const refuse = (reason) => ({ ok: false, reason });

/**
 * `busy(outbox)` returns a list of running programs that hold the folder (empty when none).
 * `alert(message)` raises an alert to Joe. Never follows a link: entries are removed as entries.
 */
export function emptyOutbox(outbox, { busy, alert = () => {} }) {
  let st; try { st = lstatSync(outbox); } catch { return refuse('the outbox is missing'); }
  if (st.isSymbolicLink() || !st.isDirectory()) return refuse('the outbox is not a plain folder');
  let holders; try { holders = busy(outbox); } catch { return refuse('could not check what holds the outbox'); }
  if (!Array.isArray(holders)) return refuse('could not check what holds the outbox');
  if (holders.length) return refuse(`still held by ${holders.join(', ')}; not emptied`);
  const odd = [];
  for (const n of readdirSync(outbox)) {
    const p = join(outbox, n);
    const e = lstatSync(p);
    if (n.startsWith('.') || e.isDirectory() || e.isSymbolicLink() || !e.isFile()) odd.push(n);
    rmSync(p, { recursive: true, force: true }); // rm never follows a link it is handed
  }
  if (odd.length) alert(`the outbox held things a role cannot make: ${odd.join(', ')}`);
  return { ok: true, removed: odd };
}

/** Reads one outbox file for intake. `uid` is the role's user id. */
export function readOutboxFile(outbox, name, { kinds, uid }) {
  const m = OUTBOX_NAME.exec(name);
  if (!m || name.includes('/')) return refuse(`"${name}" is not an outbox file name`);
  if (!kinds.includes(m[1])) return refuse(`"${m[1]}" is not one of this role's kinds`);
  let fd;
  try { fd = openSync(join(outbox, name), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch { return refuse(`"${name}" could not be opened without following a link`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return refuse(`"${name}" is not a plain file`);
    if (st.nlink !== 1) return refuse(`"${name}" has more than one link`);
    if (st.uid !== uid) return refuse(`"${name}" is not owned by the role's user`);
    return { ok: true, kind: m[1], text: readFileSync(fd, 'utf8') };
  } finally { closeSync(fd); }
}
