// The worker (builder) sessions' Claude sign-in (L1261): one long-lived token in one file, builder's alone.
//
// WHY. The builder user never logs in to macOS, so it has no login Keychain, and `/login` in a builder session fails ("A
// keychain cannot be found to store builder"). Joe's decision (L1261, not to be revisited): he runs `claude setup-token` as
// himself, pastes the token into root's hidden prompt (setup.mjs builder-signin), root saves it as builder's own 0600 file
// in builder's own 0700 folder (layout.mjs builderSigninPath, right under the root-owned base), and the worker runner reads
// it fresh before each start and each lock-down job and hands it to that claude as SIGNIN_TOKEN_VAR in its environment
// (never on a command line: a command line is shown to every Mac user by /bin/ps; never in a log).
// ACCEPTED (Joe, L1261), said plainly: ANYTHING RUNNING AS BUILDER CAN READ THE TOKEN. That is every worker session, and
// every program one runs: the lock-down claude's (the install job, check 11's baseline, save-work) Bash children too, so
// the product's install and test commands and any third-party package script they run. They inherit it in their
// environment, can see it with `ps -E` on a builder process, and the file is builder's own anyway. What limits where it
// can go is the walls: the builder user (no other user's `ps` shows another user's environment; only builder and root),
// the pf network wall, and the deny lists (every session's settings and the secret-file hook refuse the file's folder).
// POSSIBLE LATER NARROWING (not adopted, L1261 r1): Claude Code's SUBPROCESS_ENV_SCRUB (it forces the permission mode back
// to default, which the walled sessions can't use), and handing the token on an open file (a descriptor variable) in place
// of the environment (unproven on the pin). Both were read in claude-code's own code (checked: claude-code 2.1.325, open
// until 2027-01-15 (L1261)), and the descriptor one also (checked: claude-code 2.1.318, open until 2027-01-15 (L1261));
// NOT the pin 2.1.316. These notes expire on any upgrade: re-check before relying on either.
//
// One reader and one shape check, for root's setup step and the runner alike (I7):
//   signinShapeProblem(value)   → null, or why it does not look like a sign-in token (never repeating what it saw)
//   readSigninFile(file, opts)  → { ok: true, value } | { ok: false, reason }: the file read through one handle, never a
//                                 link; refused unless it and its folder are this user's own (0600, 0700, one name), every
//                                 folder above the folder root's alone, and the text one token. No reason holds a byte of it.
//   signinFileRows(...)         → the read-only check's rows (setup's after-run check and `daemons check`): lstat only, the
//                                 value is never opened.
//
// CAPABILITY NOTE (Principle 9, expires): the prefix is read in Claude Code's own code, `isAnthropicOAuthToken = (e) =>
// e.startsWith("sk-ant-oat")`, and its CLAUDE_CODE_OAUTH_TOKEN read (checked: claude-code 2.1.325, open
// until 2027-01-15 (L1261)): NOT the pin 2.1.316; the live proof (setup/live-proofs/builder-signin.mjs) on the pin closes it. The token lasting about a year is per Anthropic's docs at the time of writing; re-check.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { chainProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { registerSecret } from '../shared/secret-guard.mjs';
import { SIGNIN_TOKEN_VAR } from '../modules/M4-workshop/launcher/env-check.mjs';

export { SIGNIN_TOKEN_VAR };
export const SIGNIN_PREFIX = 'sk-ant-oat';
export const SIGNIN_MIN = 40;
export const SIGNIN_MAX = 400;
const SHAPE = /^[A-Za-z0-9_-]+$/;
const mode = (st) => (st.mode & 0o7777).toString(8);

/** Null when `v` looks like a Claude long-lived sign-in token; else why not, in fixed words (never the text itself). */
export function signinShapeProblem(v) {
  if (typeof v !== 'string' || v === '') return 'nothing was given';
  if (!v.startsWith(SIGNIN_PREFIX)) return `it does not start the way a Claude sign-in token does (${SIGNIN_PREFIX}…); make one with claude setup-token`;
  if (!SHAPE.test(v)) return 'it holds characters a Claude sign-in token does not (a space, a line break or a symbol)';
  if (v.length < SIGNIN_MIN || v.length > SIGNIN_MAX) return `its length is not a Claude sign-in token's (${SIGNIN_MIN} to ${SIGNIN_MAX} characters)`;
  return null;
}

/**
 * The token, read now. `uid`: the user who must own the file and its folder (the runner's own, builder). `rootUid`, `top`,
 * `chain`, `lstat`, `open`, `fstat`, `read` and `ownerOf(st, path)` (who owns what was looked at; setup's stand-in Mac
 * keeps its owners apart) are ports for a test, which is not root. Root's setup step reads it through the same function
 * (io.readSignin) to see whether the same token is already saved. The value is registered with the
 * secret guard as soon as it is read, so no program can be started with it on its command line.
 */
export function readSigninFile(file, { uid = process.getuid(), rootUid = 0, top = '/', chain = chainProblem, lstat = lstatSync, open = openSync, fstat = fstatSync, read = readSync, ownerOf = (st) => st.uid } = {}) {
  const no = (reason) => ({ ok: false, reason: `the builder sign-in file ${file} ${reason}` });
  if (typeof file !== 'string' || !file.startsWith('/')) return { ok: false, reason: 'no builder sign-in file is named' };
  const dir = dirname(file);
  let d; try { d = lstat(dir); } catch (e) { return no(`can't be reached: its folder ${dir} ${e?.code === 'ENOENT' ? 'is missing (run setup users-folders)' : `can't be looked at (${e?.code ?? 'error'})`}`); }
  if (d.isSymbolicLink() || !d.isDirectory()) return no(`is refused: its folder ${dir} is not a plain folder`);
  if (ownerOf(d, dir) !== uid) return no(`is refused: its folder ${dir} is not this user's own (uid ${ownerOf(d, dir)}, want ${uid})`);
  if ((d.mode & 0o7777) !== 0o700) return no(`is refused: its folder ${dir} is ${mode(d)}, want 700`);
  const above = chain(dirname(dir), { owner: rootUid, top });
  if (above) return no(`is refused: a folder above it is not root's alone (${above})`);
  let fd;
  try { fd = open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return no(e?.code === 'ENOENT' ? 'is missing (make it: claude setup-token as the owner, then sudo /usr/local/bin/node setup.mjs builder-signin)' : e?.code === 'ELOOP' ? 'is a link, which is never followed' : `can't be opened (${e?.code ?? 'error'})`);
  }
  try {
    const st = fstat(fd);
    if (!st.isFile()) return no('is not a plain file');
    if (ownerOf(st, file) !== uid) return no(`is not this user's own (uid ${ownerOf(st, file)}, want ${uid})`);
    if ((st.mode & 0o7777) !== 0o600) return no(`is ${mode(st)}, want 600`);
    if (st.nlink !== 1) return no('has another name (a hard link), so it may not be the file setup wrote');
    if (st.size < SIGNIN_MIN || st.size > SIGNIN_MAX + 1) return no('is not the size of one sign-in token');
    const buf = Buffer.alloc(SIGNIN_MAX + 2); let n = 0;
    for (;;) { const k = read(fd, buf, n, buf.length - n, null); if (k === 0) break; n += k; if (n === buf.length) return no('grew past the size of one sign-in token'); }
    const text = buf.toString('utf8', 0, n); buf.fill(0);
    const value = text.endsWith('\n') ? text.slice(0, -1) : text;
    const bad = signinShapeProblem(value);
    if (bad) return no(`does not hold one sign-in token: ${bad}`);
    return { ok: true, value: registerSecret(value) };
  } catch (e) {
    return no(`can't be read (${e?.code ?? 'error'})`);
  } finally { try { closeSync(fd); } catch { /* the read's answer stands */ } }
}

/**
 * The read-only rows for the sign-in file (setup's after-run check and `daemons check`): its folder builder's 0700 and not a
 * link, every folder above it root's alone, the file builder's 0600, one name, a token's size, and no access list on
 * either. Looked at with lstat only; the file is never opened. Rows: { ok, what, why } (setup's report shape).
 * `io` is setup's (lstat, rootUid, at), `builderUid` the builder's uid, `acl(path)` → { entries, error } (users-folders aclEntries).
 */
export function signinFileRows(io, { file, builderUid, acl, chain = (p) => chainProblem(io.at(p), { owner: io.rootUid, top: io.prefix || '/' }) }) {
  const dir = dirname(file); const rows = [];
  const row = (ok, what, why) => rows.push({ ok, what, ...(ok ? {} : { why }) });
  let d = null; try { d = io.lstat(dir); } catch (e) { row(false, `${dir} is builder's own 0700 folder`, e?.code === 'ENOENT' ? 'missing (run setup users-folders)' : `can't be looked at (${e?.code ?? 'error'})`); return rows; }
  const dWhy = d.isSymbolicLink() || !d.isDirectory() ? 'is not a plain folder' : d.uid !== builderUid ? `owner is uid ${d.uid}, want ${builderUid}` : (d.mode & 0o7777) !== 0o700 ? `mode is ${mode(d)}, want 700` : null;
  row(dWhy === null, `${dir} is builder's own 0700 folder`, dWhy);
  const above = chain(dirname(dir)); row(above === null, `every folder above ${dir} is root's alone`, above);
  let st = null; try { st = io.lstat(file); } catch (e) {
    row(false, `${file} (the builder sessions' sign-in) is there`, e?.code === 'ENOENT' ? 'missing: as the owner run claude setup-token, then sudo /usr/local/bin/node setup.mjs builder-signin (README, "Where the builder sessions\' sign-in lives")' : `can't be looked at (${e?.code ?? 'error'})`);
    return rows;
  }
  const why = [];
  if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
  else {
    if (st.uid !== builderUid) why.push(`owner is uid ${st.uid}, want ${builderUid}`);
    if ((st.mode & 0o7777) !== 0o600) why.push(`mode is ${mode(st)}, want 600`);
    if (st.nlink !== 1) why.push('has another name (a hard link)');
    if (st.size < SIGNIN_MIN || st.size > SIGNIN_MAX + 1) why.push('size is not a sign-in token\'s');
  }
  for (const p of [dir, file]) { const a = acl(p); if (a.error) why.push(a.error); else if (a.entries.length) why.push(`${p} has an access list (${a.entries.join('; ')})`); }
  row(why.length === 0, `${file} (the builder sessions' sign-in) is builder's 0600 file, a token's size, no access list`, why.join('; '));
  return rows;
}
