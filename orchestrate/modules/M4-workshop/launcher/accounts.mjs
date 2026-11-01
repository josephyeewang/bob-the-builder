// The account switch (R-1-89): two Claude accounts on one Mac user, each with its own sign-in folder.
//
// How Claude Code keeps them apart (checked 31 Oct 2026 against CLI 2.1.316; a capability claim, re-check on an
// upgrade): `CLAUDE_CONFIG_DIR` names the folder Claude Code reads. The macOS Keychain sign-in is keyed to that folder,
// and so are its settings file `.claude.json` and its list of background sessions. Account `a` is the folder Claude
// Code uses when the variable is not set (`~/.claude`, with `.claude.json` in the home folder), so it runs with the
// variable unset, exactly as today; account `b` is a second folder (`~/.claude-b`). A long-lived token
// (`CLAUDE_CODE_OAUTH_TOKEN`) is not used: it can't start Remote Control, so the Front Door would break.
//
// The second folder shares everything but the sign-in: hooks, settings (and the local allow rules), skills, agents,
// slash commands, plugins, key bindings, the global instructions and the projects folder (memory, transcripts) are
// links to the first folder's, so both accounts run under the same safety hooks. The sign-in and `.claude.json` are
// never linked or copied. The first folder may itself be a link to a folder the same user owns.
//
// Run as a script by the Mac user whose sessions it is for:
//   node accounts.mjs setup        make the second folder and its links (twice changes nothing)
//   node accounts.mjs use a|b      name the account new sessions start on (running sessions keep theirs)
//   node accounts.mjs status       each folder: signed in or not, and the plan; no token, email or raw output
//   node accounts.mjs copy-to <file> --home <dir> --owner <uid> --install <the installed copy>
//                                  copies which account that user's sessions start on into <file> (0644), for the review
//                                  user, who starts its sessions on the same account in its own folders (L65 m-5). Run by
//                                  root from the installed copy (review-account-copy.plist), never from the repository:
//                                  it refuses unless this file and its node are in that copy, root's alone (L75 c-1).
//                                  As the account copy, root runs this file and install-check.mjs, nothing else.
// Nothing here reads a secret: the folders are only listed and linked, and `status` keeps a few named fields of
// `claude auth status` and drops the rest.

import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProblem, copyReady } from './install-check.mjs';

export const ACCOUNTS = Object.freeze({ a: '.claude', b: '.claude-b' });
export const ACCOUNT_NAMES = Object.freeze(Object.keys(ACCOUNTS));
// The one file naming the account in use, in the home folder: one line, `a` or `b`. Missing means `a`.
export const ACCOUNT_FILE = '.claude-account';
export const CONFIG_VAR = 'CLAUDE_CONFIG_DIR';
// What the second folder shares with the first, by a link to the first folder's own, made in this order. The local
// settings file holds only allow rules, so the safety hooks are the shared `settings.json`'s alone (L61 (3)).
export const SHARED = Object.freeze(['hooks', 'settings.json', 'settings.local.json', 'skills', 'agents', 'commands', 'plugins',
  'keybindings.json', 'CLAUDE.md', 'projects']);
// What each folder keeps its own: the sign-in, and the settings file that goes with it. Never linked or copied.
export const OWN = Object.freeze(['.claude.json', '.credentials.json']);

const refuse = (reason) => ({ ok: false, reason });
const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };
const stat = (p) => { try { return statSync(p); } catch { return null; } };
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const readLink = (p) => { try { return readlinkSync(p); } catch { return null; } };

export const accountDir = (home, name) => join(home, ACCOUNTS[name]);
/**
 * The variables a session of this account adds to its environment: the folder for `b`, and none for `a` (the variable
 * left unset, as today). Made to go straight into the launcher's `roleEnv(base, { extra })`, which keeps only its own
 * short list from the parent, so a folder variable set in the parent never reaches account a's session.
 */
export const accountEnv = (home, name) => (name === 'a' ? {} : { [CONFIG_VAR]: accountDir(home, name) });
/**
 * Is the account's folder there? The first may be a link to a folder (L61 (5)); the second must be a folder itself, so it
 * can never be the first folder under another name.
 */
export const isSetUp = (home, name) => !!(name === 'a' ? stat : lstat)(accountDir(home, name))?.isDirectory();

// This user's id, or null where the system has none (the owner check is then skipped).
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * The first folder as setup accepts it: a folder, or a link to a folder this user (`uid`) owns. Null, or the reason it
 * isn't. `uid` is passed in so a test can stand in for another user without admin rights.
 */
function firstFolderProblem(A, uid) {
  const l = lstat(A);
  if (!l) return `~/${ACCOUNTS.a} is not here`;
  if (!l.isSymbolicLink()) return l.isDirectory() ? null : `~/${ACCOUNTS.a} is not a folder`;
  const s = stat(A);
  if (!s) return `~/${ACCOUNTS.a} is a link that leads nowhere`;
  if (!s.isDirectory()) return `~/${ACCOUNTS.a} is a link to something that is not a folder`;
  if (uid !== null && s.uid !== uid) return `~/${ACCOUNTS.a} is a link to a folder another user owns`;
  return null;
}

/** The account new sessions start on: { account, dir, env } or { account: null, reason }. */
export function accountInUse({ home = homedir() } = {}) {
  let name = 'a';
  const f = join(home, ACCOUNT_FILE);
  const st = lstat(f);
  if (st) {
    if (!st.isFile() || st.size > 64) return { account: null, reason: `${ACCOUNT_FILE} is not a short plain file` };
    try { name = readFileSync(f, 'utf8').trim(); } catch (e) { return { account: null, reason: `${ACCOUNT_FILE} could not be read (${e.code ?? e.message})` }; }
    if (!ACCOUNT_NAMES.includes(name)) return { account: null, reason: `${ACCOUNT_FILE} names neither a nor b` };
  }
  if (!isSetUp(home, name)) return { account: null, reason: `account ${name}'s folder ~/${ACCOUNTS[name]} is not set up` };
  return { account: name, dir: accountDir(home, name), env: accountEnv(home, name) };
}

/** `use a|b`: writes the account file (a new file put in place, so a reader never sees half of it). */
export function useAccount({ home = homedir(), name }) {
  if (!ACCOUNT_NAMES.includes(name)) return refuse(`no account "${name}": use a or b`);
  if (!isSetUp(home, name)) return refuse(`account ${name}'s folder ~/${ACCOUNTS[name]} is not set up; run setup first`);
  const f = join(home, ACCOUNT_FILE);
  const st = lstat(f);
  if (st && !st.isFile()) return refuse(`${ACCOUNT_FILE} is there and is not a plain file`);
  const tmp = `${f}.${process.pid}.tmp`;
  // Anyone may read which account is in use (it is a or b, no secret): the review runner reads it when the copy is missing.
  writeFileSync(tmp, `${name}\n`, { mode: 0o644 });
  renameSync(tmp, f);
  return { ok: true, account: name };
}

/**
 * An account file read by another user (the review runner, or root making the copy): never following a link or waiting
 * on a pipe, a plain short file with one name, owned by `uid`, that no one else may write, holding a or b.
 * → { ok, account } | { ok: false, reason }
 */
export function readAccountFile({ file, uid }) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return refuse(e?.code === 'ENOENT' ? `${file} is missing` : e?.code === 'ELOOP' ? `${file} is a link` : `${file} can't be read (${e?.code ?? e})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return refuse(`${file} is not a plain file with one name`);
    if (st.uid !== uid) return refuse(`${file} is not owned by uid ${uid}`);
    if (st.mode & 0o022) return refuse(`${file} can be written by others`);
    if (st.size > 64) return refuse(`${file} is too big`);
    const name = readFileSync(fd, 'utf8').trim();
    return ACCOUNT_NAMES.includes(name) ? { ok: true, account: name } : refuse(`${file} names neither a nor b`);
  } finally { closeSync(fd); }
}

/**
 * `copy-to`: the owner's account file (missing means a) copied to `to`, put in place in one step, mode 0644.
 * `uid` is the owner whose file it is. Root runs it, so (L66) the folder `to` sits in must be root's (`dirOwner`, a test
 * passes its own uid) and written by no one else, and the new file is made fresh, never through a link or over a file
 * someone left there: otherwise it refuses. → { ok, account } | { ok: false, reason }
 */
export function copyAccountTo({ home, uid, to, dirOwner = 0 }) {
  if (typeof to !== 'string' || !to.startsWith('/')) return refuse('copy-to needs a full path');
  const dir = dirname(to);
  const ds = lstat(dir);
  if (!ds || ds.isSymbolicLink() || !ds.isDirectory()) return refuse(`${dir} is not a plain folder`);
  if (ds.uid !== dirOwner) return refuse(`${dir} is not owned by uid ${dirOwner}`);
  if (ds.mode & 0o022) return refuse(`${dir} can be written by others`);
  const f = join(home, ACCOUNT_FILE);
  let r = lstat(f) ? readAccountFile({ file: f, uid }) : { ok: true, account: 'a' };
  if (!r.ok) return r;
  const at = lstat(to);
  if (at && !at.isFile()) return refuse(`${to} is there and is not a plain file`);
  const tmp = `${to}.${process.pid}.tmp`;
  let fd;
  try { fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); } catch (e) {
    return refuse(`${tmp} could not be made fresh (${e?.code ?? e})`);
  }
  try {
    try { writeSync(fd, `${r.account}\n`); fchmodSync(fd, 0o644); } finally { closeSync(fd); }
    renameSync(tmp, to);
  } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } return refuse(`${to} could not be written (${e?.code ?? e})`); }
  return { ok: true, account: r.account };
}

/**
 * `copy-to` as root runs it (L75 c-1): only from the installed copy `install`, with this file (`self`) and the node
 * running it (`node`) in it and the copy root's alone (`installProblem`; `owner` and `top` stand in for root and `/` in a
 * test), and the copy one the updater finished, its link and stamp as the runner wants them (`copyReady`, L106 m-1),
 * then copyAccountTo. → as copyAccountTo.
 */
export function copyFromInstalledCopy({ install, home, uid, to, self = selfFile, node = nodeFile(), owner = 0, top = '/' }) {
  if (typeof install !== 'string' || !install.startsWith('/')) return refuse('copy-to needs --install <the installed copy>');
  const bad = installProblem(install, [self, node], { owner, top });
  if (bad) return refuse(`it runs only from the installed copy, root's alone: ${bad}`);
  const unready = copyReady(install, { owner });
  if (unready) return refuse(`it runs only from an installed copy the updater finished: ${unready}`);
  return copyAccountTo({ home, uid, to, dirOwner: owner });
}

/**
 * `setup`: the second folder and its links. Every target is checked before anything changes, so a refusal changes
 * nothing; a second run finds every link in place and changes nothing.
 * Returns { ok, made: [names], kept: [names], skipped: [names with no first-folder original] } or { ok: false, reason }.
 * `uid` is the user the first folder must belong to when it is a link (this user; a test passes another).
 */
export function setupSecondFolder({ home = homedir(), name = 'b', uid = currentUid() } = {}) {
  if (name === 'a' || !ACCOUNT_NAMES.includes(name)) return refuse('only the second account\'s folder is set up');
  const A = accountDir(home, 'a');
  const B = accountDir(home, name);
  const problem = firstFolderProblem(A, uid);
  if (problem) return refuse(`nothing changed: ${problem}`);
  const b = lstat(B);
  if (b && !b.isDirectory()) return refuse(`~/${ACCOUNTS[name]} is there and is not a folder (a link would share the sign-in)`);
  const realA = real(A);
  if (realA === B || (b && real(B) === realA)) return refuse(`nothing changed: ~/${ACCOUNTS.a} leads to ~/${ACCOUNTS[name]}, so the two accounts would be one folder`);
  const bad = [];
  for (const own of OWN) if (lstat(join(B, own))?.isSymbolicLink()) bad.push(`~/${ACCOUNTS[name]}/${own} is a link: the two accounts would share a sign-in`);
  const plan = { made: [], kept: [], skipped: [] };
  for (const n of SHARED) {
    const src = join(A, n);
    const dst = join(B, n);
    const d = lstat(dst);
    if (!lstat(src)) { if (d) bad.push(`~/${ACCOUNTS[name]}/${n} is there but ~/${ACCOUNTS.a}/${n} is not`); else plan.skipped.push(n); continue; }
    if (!d) plan.made.push(n);
    else if (d.isSymbolicLink() && readLink(dst) === src) plan.kept.push(n);
    else bad.push(`~/${ACCOUNTS[name]}/${n} is there and is not the link to ~/${ACCOUNTS.a}/${n}`);
  }
  if (bad.length) return refuse(`nothing changed: ${bad.join('; ')}`);
  // A folder that can't be written (L61 (4)): a plain refusal saying how far it got. The links go in SHARED's order,
  // and a second run keeps what is there and makes the rest.
  const done = [];
  try {
    if (!b) mkdirSync(B, { mode: 0o700 });
    for (const n of plan.made) { symlinkSync(join(A, n), join(B, n)); done.push(n); }
  } catch (e) {
    return refuse(`could not write in ~/${ACCOUNTS[name]} (${e.code ?? e.message}): ${done.length} of ${plan.made.length} new links made${done.length ? ` (${done.join(', ')})` : ''}; make the folder writable, then run setup again to finish`);
  }
  return { ok: true, ...plan };
}

// The named fields `status` keeps, each shown only when it is a short plain word; everything else is dropped.
const WORD = /^[A-Za-z0-9._-]{1,32}$/;
const shown = (v) => (typeof v === 'string' && WORD.test(v) ? v : null);

/**
 * One folder's sign-in from the text `claude auth status --json` printed: { signedIn, method, plan, folderMatches }.
 * Never returns a field it was not asked for, and a value that is not a short word (a token, an address) is dropped.
 */
export function readAuthStatus(text, dir) {
  let j;
  try { j = JSON.parse(text); } catch { return { readable: false }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { readable: false };
  // Only the four fields it knows, each read as the answer's own (not inherited); nothing else is looked at.
  const field = (k) => (Object.hasOwn(j, k) ? j[k] : undefined);
  const [loggedIn, authMethod, plan, folder] = ['loggedIn', 'authMethod', 'subscriptionType', 'configDirectory'].map(field);
  return {
    readable: true,
    signedIn: loggedIn === true,
    method: shown(authMethod),
    plan: shown(plan),
    folderMatches: typeof folder === 'string' ? folder === dir : null,
  };
}

/** `status` text. `authStatus(name, env)` runs `claude auth status --json` for one folder and returns its stdout or null. */
export function statusText({ home = homedir(), authStatus }) {
  const tilde = (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const use = accountInUse({ home });
  const lines = [use.account ? `Account in use: ${use.account}` : `Account in use: none (${use.reason})`];
  for (const name of ACCOUNT_NAMES) {
    const dir = accountDir(home, name);
    let what;
    if (!isSetUp(home, name)) what = 'not set up';
    else {
      const out = authStatus(name, accountEnv(home, name));
      const s = typeof out === 'string' ? readAuthStatus(out, dir) : { readable: false };
      if (!s.readable) what = 'sign-in unknown (claude auth status gave no readable answer)';
      else if (!s.signedIn) what = 'not signed in';
      else what = `signed in${s.method ? ` (${s.method})` : ''}, plan: ${s.plan ?? 'unknown'}`;
      if (s.readable && s.folderMatches === false) what += '; Claude reports a different folder';
    }
    lines.push(`${name === use.account ? '*' : ' '} ${name}  ${tilde(dir).padEnd(12)} ${what}`);
  }
  return lines.join('\n');
}

/** The real `claude auth status --json` for one folder: a time limit, no input, nothing inherited on screen. */
export function claudeAuthStatus(claudeBin = 'claude') {
  return (name, env) => {
    const e = { ...process.env };
    delete e[CONFIG_VAR];
    if (env[CONFIG_VAR]) e[CONFIG_VAR] = env[CONFIG_VAR];
    const r = spawnSync(claudeBin, ['auth', 'status', '--json'], { env: e, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    // Not signed in exits 1 with the answer still printed, so the output counts whatever the exit.
    return r.error ? null : r.stdout;
  };
}

function cli(argv, { home = homedir(), claudeBin = 'claude', owner, install } = {}) {
  const [cmd, arg] = argv;
  if (cmd === 'setup') {
    const r = setupSecondFolder({ home });
    if (!r.ok) return [1, `Refused: ${r.reason}`];
    const say = [`~/${ACCOUNTS.b} is set up.`];
    if (r.made.length) say.push(`Linked: ${r.made.join(', ')}.`);
    if (r.kept.length) say.push(`Already linked: ${r.kept.join(', ')}.`);
    if (r.skipped.length) say.push(`Not in ~/${ACCOUNTS.a}, so not linked: ${r.skipped.join(', ')} (run setup again once they are).`);
    say.push(`Its sign-in is its own: sign it in once with CLAUDE_CONFIG_DIR=~/${ACCOUNTS.b} claude, then /login.`);
    return [0, say.join('\n')];
  }
  if (cmd === 'use') {
    const r = useAccount({ home, name: arg });
    return r.ok ? [0, `New sessions start on account ${r.account}. Sessions already running keep their account until they end.`] : [1, `Refused: ${r.reason}`];
  }
  if (cmd === 'status') return [0, statusText({ home, authStatus: claudeAuthStatus(claudeBin) })];
  if (cmd === 'copy-to') {
    const r = Number.isInteger(owner) ? copyFromInstalledCopy({ install, home, uid: owner, to: arg }) : refuse('copy-to needs --owner <uid>');
    return r.ok ? [0, `Account ${r.account} copied to ${arg}.`] : [1, `Refused: ${r.reason}`];
  }
  return [2, 'Use: node accounts.mjs setup | use a|b | status | copy-to <file> --home <dir> --owner <uid> --install <the installed copy>'];
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const selfFile = self ?? fileURLToPath(import.meta.url);
function nodeFile() { try { return realpathSync.native(process.execPath); } catch { return process.execPath; } }
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (self && self === invoked) {
  // `--claude <path>` points `status` at another claude program (the tests use a fake).
  const args = process.argv.slice(2);
  const k = args.indexOf('--claude');
  const claudeBin = k >= 0 ? args.splice(k, 2)[1] : 'claude';
  const h = args.indexOf('--home');
  const home = h >= 0 ? args.splice(h, 2)[1] : homedir();
  const o = args.indexOf('--owner');
  const owner = o >= 0 ? Number(args.splice(o, 2)[1]) : undefined;
  const i = args.indexOf('--install');
  const install = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const [code, text] = cli(args, { claudeBin, home, owner, install });
  (code ? process.stderr : process.stdout).write(`${text}\n`);
  process.exitCode = code;
}
