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
// <kind><id>.(md|json|txt) for one of the role's kinds. The kind is read as M9 reads it, the longest listed prefix of the
// name (shared outboxKindOf, L82 M-1), so `report-compact-x` is report-compact-, not report-.

import { lstatSync, readdirSync, rmSync, openSync, fstatSync, readFileSync, readSync, closeSync, constants as C } from 'node:fs';
import { join } from 'node:path';
import { outboxKindOf } from '../../../shared/record-names.mjs';

export const OUTBOX_NAME = /^[a-z]+-[A-Za-z0-9-]+\.(md|json|txt)$/;
const refuse = (reason) => ({ ok: false, reason });

/**
 * `busy(outbox)` returns a list of running programs that hold the folder (empty when none).
 * `alert(message)` raises an alert to the owner. Never follows a link: entries are removed as entries.
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

/**
 * Reads the file at `path` through a handle opened without following a link. The open file must be a plain file with one
 * link, owned by `uid`, and, when `maxBytes` is given, no bigger than that. The one safe open for an outbox file
 * (readOutboxFile) and a one-shot Lead's launch file (M3 sessions.mjs readLaunchFile; L1370 audit m3).
 * `label` names the file in a refusal and `notOwned` is the refusal for a file `uid` does not own. Answers { ok: true,
 * text } or { ok: false, reason, missing?, code? }: `missing` when there is no file.
 */
export function readOwnedFile(path, { uid, label, notOwned = `${label} is not owned by the role's user`, maxBytes, open = openSync }) {
  let fd;
  try { fd = open(path, C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch (e) {
    return { ok: false, missing: e?.code === 'ENOENT', code: e?.code ?? 'error', reason: `${label} could not be opened without following a link` };
  }
  try {
    const st = fstatSync(fd);
    const no = (reason) => ({ ok: false, reason });
    if (!st.isFile()) return no(`${label} is not a plain file`);
    if (st.nlink !== 1) return no(`${label} has more than one link`);
    if (st.uid !== uid) return no(notOwned);
    if (maxBytes === undefined) return { ok: true, text: readFileSync(fd, 'utf8') };
    if (st.size > maxBytes) return no(`${label} is too big`);
    // Read one byte past the cap, so a file that grew after the look is still refused.
    const buf = Buffer.alloc(maxBytes + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > maxBytes) return no(`${label} is too big`);
    return { ok: true, text: buf.subarray(0, n).toString('utf8') };
  } finally { closeSync(fd); }
}

/** Reads one outbox file for intake. `uid` is the role's user id. */
export function readOutboxFile(outbox, name, { kinds, uid }) {
  if (!OUTBOX_NAME.test(name) || name.includes('/')) return refuse(`"${name}" is not an outbox file name`);
  const kind = outboxKindOf(name);
  if (!kind || !kinds.includes(kind)) return refuse(`"${name}" is not a kind this role may hand in`);
  const f = readOwnedFile(join(outbox, name), { uid, label: `"${name}"` });
  return f.ok ? { ok: true, kind, text: f.text } : refuse(f.reason);
}
