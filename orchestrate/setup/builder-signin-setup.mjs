// Setup: the worker (builder) sessions' Claude sign-in (L1261). README, "Where the builder sessions' sign-in lives".
//
//   builder-signin [--dry-run]   root: read a long-lived Claude sign-in token from the terminal (echo off, never shown; the
//                                owner makes it first with `claude setup-token`, as themselves), check its shape, and save it
//                                as builder's own 0600 file (layout.mjs builderSigninPath) in builder's own 0700 folder, which
//                                users-folders makes. Whole or nothing: a side file, written with its owner and mode set on
//                                the handle, renamed over the old one. The same token again changes nothing.
//   check-builder-signin         read only (and the after-run check): lstat only, the token itself is never opened.
//
// The value is never printed, logged, put in a step's text, an error or a program's arguments (registerSecret: any start
// whose command line holds it throws). Why a file and not the Keychain: wiring/builder-signin.mjs.

import { builderSigninPath, BUILDER } from './layout.mjs';
import { aclEntries, readUser } from './users-folders.mjs';
import { registerSecret } from '../shared/secret-guard.mjs';
import { SIGNIN_MAX, signinFileRows, signinShapeProblem } from '../wiring/builder-signin.mjs';
import { dirname } from 'node:path';

const op = (text, run) => ({ text, run });
const modeOf = (st) => st.mode & 0o7777;
export const SIGNIN_PROMPT = 'Paste the long-lived Claude sign-in token (from claude setup-token) and press Return (nothing will show as you paste): ';

/** The plan for `builder-signin`. The terminal is read only when the plan runs (never on --dry-run). */
export function planBuilderSignin(io, cfg) {
  const b = readUser(io, BUILDER);
  if (!b.exists) return { ops: [], problems: [`the ${BUILDER} user does not exist yet (run users-folders first)`] };
  const f = builderSigninPath(cfg); const dir = dirname(f);
  let d; try { d = io.lstat(dir); } catch { return { ops: [], problems: [`${dir} is missing: users-folders makes it, so run that first`] }; }
  if (d.isSymbolicLink() || !d.isDirectory() || d.uid !== b.uid || modeOf(d) !== 0o700) return { ops: [], problems: [`${dir} is not ${BUILDER}'s own 0700 folder (run users-folders first)`] };
  try { const st = io.lstat(f); if (st.isSymbolicLink() || !st.isFile()) return { ops: [], problems: [`${f} is there but is not a plain file (a link or a folder); nothing was saved`] }; } catch (e) { if (e?.code !== 'ENOENT') return { ops: [], problems: [`${f} could not be looked at (${e?.code ?? e})`] }; }
  return { ops: [op(`read the sign-in token from the terminal (typed with the echo off, never shown), then save it as ${f} (${BUILDER}, 0600); the same token again changes nothing`, () => {
    let t = registerSecret(io.readSecret(SIGNIN_PROMPT).trim());
    const bad = signinShapeProblem(t); if (bad) { t = ''; throw new Error(`that does not look like a Claude sign-in token: ${bad}; nothing was saved`); }
    let st = null; try { st = io.lstat(f); } catch { /* not there */ }
    if (st && st.isDirectory() && !st.isSymbolicLink()) { t = ''; throw new Error(`${f} became a folder while the token was typed; nothing was saved`); }
    if (st && (st.isSymbolicLink() || !st.isFile())) { t = ''; throw new Error(`${f} is now not a plain file; nothing was saved`); }
    // The same token, already saved as it should be: nothing is written (a second run with the same value does nothing).
    // "As it should be" is the runner's own read (io.readSignin, wiring/builder-signin.mjs readSigninFile: one handle with
    // O_NOFOLLOW|O_NONBLOCK, builder's 0600 in its 0700 folder, one name, the folders above root's, one token) and no
    // access list on the file; anything else is written again, so the new file replaces it.
    if (st && st.isFile() && !st.isSymbolicLink() && Number(st.nlink) === 1 && st.size <= SIGNIN_MAX + 1) {
      let same = false;
      try {
        const a = aclEntries(io, f);
        if (!a.error && a.entries.length === 0) { const r = io.readSignin(f, { uid: b.uid }); same = r?.ok === true && r.value === t; }
      } catch { /* written again below */ }
      if (same) { t = ''; return; }
    }
    // A side name first, then renamed over the old one, so a write that fails keeps the sign-in that works. A leftover side name
    // from a cut-off run is only a name: a plain unlink, never through a link.
    const tmp = `${f}.new`;
    io.unlink(tmp);
    const drop = () => { try { io.unlink(tmp); } catch { /* the first error is the one to report */ } };
    try { io.writeOwned(tmp, `${t}\n`, { uid: b.uid, gid: b.gid, mode: 0o600 }); } catch (e) { drop(); throw new Error(`the sign-in token could not be written (${e?.code ?? 'error'}); nothing was saved`); } finally { t = ''; }
    try { io.rename(tmp, f); } catch (e) {
      drop();
      throw new Error(`the new sign-in token could not take the old one's place (${e?.code ?? 'error'}); the old file is unchanged`);
    }
  })], problems: [] };
}

/** Read only; never opens the token, only looks at its folder, its size, owner, mode and access list. Needs root to look in. */
export function checkBuilderSignin(io, cfg) {
  const f = builderSigninPath(cfg); const what = `${f} (the builder sessions' sign-in) is ${BUILDER}'s own 0600 file in its own 0700 folder`;
  if (io.euid() !== 0) return [{ ok: true, skip: true, what, why: `the folder is ${BUILDER}-only; needs root to look; run with sudo` }];
  const b = readUser(io, BUILDER);
  if (!b.exists) return [{ ok: false, what, why: `the ${BUILDER} user does not exist` }];
  return signinFileRows(io, { file: f, builderUid: b.uid, acl: (p) => aclEntries(io, p) });
}
