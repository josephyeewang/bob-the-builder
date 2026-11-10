// private-folder.mjs — the one check for a private folder (moved here from dispatcher-wiring.mjs in L739, so that
// worker-ports.mjs can use it without an import cycle through dispatcher-wiring.mjs). dispatcher-wiring.mjs re-exports it.

import { accessSync, constants, lstatSync, mkdirSync } from 'node:fs';

/**
 * Refuses unless `path` is a plain folder (not a link) owned by `uid` with no group or other access, and, with
 * `writable`, one this process can write. With `create`, a missing folder is made first (mode 700, its parent must
 * exist); a make that fails refuses. The one check for a private folder: robot-wiring.mjs checkUser uses it for the
 * robot key folder, dispatcher-wiring.mjs wire() for the approvals state folder (L295 MAT-1), worker-ports.mjs for
 * the seal folder (L739). → path
 */
export function privateFolder({ path, uid, what, create = false, writable = false, lstat = lstatSync }) {
  let st;
  try { st = lstat(path); } catch (e) {
    if (!(create && e?.code === 'ENOENT')) throw new Error(`${what} ${path} can't be read (${e?.code ?? e})`);
    try { mkdirSync(path, { mode: 0o700 }); st = lstat(path); } catch (m) { throw new Error(`${what} ${path} is missing and could not be made (${m?.code ?? m})`); }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${what} ${path} is not a plain folder`);
  if (st.uid !== uid) throw new Error(`${what} ${path} belongs to uid ${st.uid}, not to this job's uid ${uid}`);
  if (st.mode & 0o077) throw new Error(`${what} ${path} can be read by others (mode ${(st.mode & 0o777).toString(8)}); it must be 700`);
  if (writable) { try { accessSync(path, constants.W_OK | constants.X_OK); } catch (e) { throw new Error(`${what} ${path} can't be written (${e?.code ?? e})`); } }
  return path;
}
