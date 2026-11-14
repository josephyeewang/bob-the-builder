// approve-rules.mjs — `setup.mjs approve-rules <product>` (L1127 c): the owner approves the rules version now on the
// product's GitHub main, by appending its blob to M10's approval list (approved-rules.json, the stopgap until 0b-5; the
// M10 reader adopts a new rules version only when the list names it, forward only: reader.mjs allowListVerifier).
//
//   sudo -k -u orchestrate /usr/local/bin/node <the installed copy>/setup/setup.mjs approve-rules <product>
//
// (-k: sudo forgets any password it remembers, so it asks the owner's password every time.)
//
// WHY A COMMAND. Approving the rules is the owner's act. A hand-written JSON line would mean typing a 40-hex hash copied from
// somewhere, and anything that can write the file could approve; so this reads main's version itself and shows it.
//
// WHAT GUARDS IT (L1132 m1). The guard is sudo asking the owner's password: only `orchestrate` can write the list, and
// becoming `orchestrate` takes that password. SUDO_UID is only an environment variable, and a script can answer a terminal
// prompt through a pseudo-terminal (`script`), so neither is a guard on its own; Claude sessions run as the owner's Mac user,
// so they rest on sudo too. The SUDO_UID match and the retyped name are second checks: they stop a mistaken run (another
// user's sudo, a pipe, an answer for another product), not a determined one.
//
// WHAT IT DOES, in order, each a refusal (exit 1 or 2, nothing written) when it fails:
//   1. who: run as the Dispatcher's user (orchestrate, who owns the list), through sudo by the owner (SUDO_UID is the
//      owner's Mac user id from root's setup config; a second check, see above). Root, the owner run directly, or anyone
//      else is refused.
//   2. which: the Dispatcher's own config in the installed copy (root's file, read as root's are), whose product must be
//      <product>, and its products.json entry (owner/repo). Nothing is taken from the command line but the product name.
//   3. main's version: the branch's commit, then the rules file at that commit, read only (the read-only client and the
//      Dispatcher's own token file) and checked as the reader checks it (rulesFileOf): its blob is what is approved.
//   4. shown: the product, the repository, the commit, the blob, whether it parses and passes M10's module checks (a file
//      that doesn't parse is refused: the reader would never adopt it), what the list holds now, and the file's top lines.
//   5. the owner's yes: the product's name typed again at the terminal itself (/dev/tty), with standard input a terminal
//      too; a pipe or no terminal is refused. A second check, not the guard: a pseudo-terminal can answer it. Anything but
//      the exact name is a no.
//   6. still main's: main is read again; a commit or blob that moved since step 3 is refused ("run it again").
//   7. forward only: the list is read again and must be what step 4 showed; the new list is that one with the blob added at
//      the end, written to a new file in the same private folder and renamed over the old (never edited in place).
//   8. read back: the reader's own check (allowListVerifier) now approves the blob over the version it holds.
// --dry-run stops after step 4. A version the reader holds that is not on the list is refused at step 4: the reader can't
// move forward from it (allowListVerifier), so an approval would be adopted never.
// The blob already last on the list: nothing to do (exit 0). Approved before but not last: it is shown as a version going
// back, and approving it again needs the same yes.

import { closeSync, constants, fsyncSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isatty } from 'node:tty';
import { RULES_PATH, BRANCH, allowListVerifier, readProducts, rulesFileOf } from '../modules/M10-rules/reader.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { moduleProblems } from '../modules/M10-rules/first-cutover.mjs';
import { readOnlyClient, tokenFile } from '../modules/M6-merge-gate/watch-only.mjs';
import { checkConfig } from '../wiring/dispatcher-wiring.mjs';
import { privateFolder } from '../wiring/private-folder.mjs';
import { linkNotFollowed, readConfigFile } from './mac.mjs';
import { TTY_PATH } from './layout.mjs';
import { SHA40 } from '../shared/plan-fingerprint.mjs';
import { readUser } from './users-folders.mjs';
import { installPaths } from './install.mjs';
import { DISPATCHER_CONFIG, DISPATCHER_USER } from './dispatcher-setup.mjs';

export const APPROVED_FILE = 'approved-rules.json';
export const TOP_LINES = 25;
const MAX_LIST_BYTES = 1 << 20;

/** The list's text → { product: [blob, ...] }, or a throw: an object whose every value is a list of 40-hex blobs. */
export function parseList(text) {
  let v; try { v = JSON.parse(text); } catch { throw new Error(`${APPROVED_FILE} is not valid JSON`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${APPROVED_FILE} is not an object of product lists`);
  for (const [k, l] of Object.entries(v)) if (!Array.isArray(l) || !l.every((b) => typeof b === 'string' && SHA40.test(b))) throw new Error(`${APPROVED_FILE}: ${k} is not a list of blobs`);
  return v;
}

/**
 * The list file as it is: { text: null } when there is none, else { text }. One handle, never a link, a plain file of
 * `uid`'s that no one else can write, under 1 MB. Anything else is a throw (a list this can't trust is never written over).
 */
export function readListFile(file, { uid }) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if (e?.code === 'ENOENT') return { text: null };
    throw new Error(e?.code === 'ELOOP' ? linkNotFollowed(file) : `${file} can't be opened (${e?.code ?? e})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a plain file`);
    if (st.uid !== uid) throw new Error(`${file} belongs to uid ${st.uid}, not to ${DISPATCHER_USER}`);
    if (st.mode & 0o022) throw new Error(`${file} can be written by others than ${DISPATCHER_USER} (mode ${(st.mode & 0o777).toString(8)})`);
    if (st.nlink !== 1) throw new Error(`${file} has another name (a hard link)`);
    const buf = Buffer.alloc(MAX_LIST_BYTES + 1); let n = 0;
    for (;;) { const k = readSync(fd, buf, n, buf.length - n, null); if (k === 0) break; n += k; if (n > MAX_LIST_BYTES) throw new Error(`${file} is over 1 MB`); }
    return { text: buf.toString('utf8', 0, n) };
  } finally { closeSync(fd); }
}

/** The new list's text, written to a new private file in the same folder, flushed, then renamed over the list. */
export function writeListFile(file, text) {
  const tmp = `${file}.${process.pid}.new`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  closeSync(fd);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  // The rename itself made lasting: the folder flushed too (L1132 c1).
  const dfd = openSync(dirname(file), constants.O_RDONLY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

/**
 * One line typed at the terminal itself, shown as typed. Refuses when standard input is not a terminal (a pipe) or there
 * is no terminal (a session without one). `isTty` and `ttyPath` are for tests.
 */
/** The terminal itself, never standard input: the yes must come from the keyboard of the window sudo ran in. */
export { TTY_PATH };
export function readLineFromTty(prompt, { maxBytes = 200, isTty = () => isatty(0), ttyPath = TTY_PATH } = {}) {
  if (!isTty()) throw new Error('standard input is not a terminal (a pipe or a script?); run this yourself in the Terminal app');
  let fd;
  try { fd = openSync(ttyPath, 'r+'); } catch { throw new Error('there is no terminal to type the answer into; run this in the Terminal app'); }
  try {
    writeSync(fd, prompt);
    const bytes = []; const one = Buffer.alloc(1);
    for (;;) {
      if (readSync(fd, one, 0, 1, null) !== 1) break;
      if (one[0] === 10 || one[0] === 13) break;
      if (bytes.length >= maxBytes) throw new Error('that answer is far too long');
      bytes.push(one[0]);
    }
    return Buffer.from(bytes).toString('utf8');
  } finally { closeSync(fd); }
}

/** main's rules version for `entry` → { commit, blob, text }, or a throw. Two reads, the reader's own. */
export async function mainRules(gh, entry) {
  const base = `/repos/${entry.owner}/${entry.repo}`;
  const ref = await gh.get(`${base}/git/ref/heads/${BRANCH}`);
  if (ref.status !== 200) throw new Error(`the ${BRANCH} branch read answered ${ref.status}`);
  const commit = ref.json?.object?.sha;
  if (!SHA40.test(commit ?? '')) throw new Error(`the ${BRANCH} branch read gave no commit`);
  const file = await gh.get(`${base}/contents/${RULES_PATH}?ref=${commit}`);
  if (file.status !== 200) throw new Error(`the rules file read answered ${file.status}${file.status === 404 ? ` (no ${RULES_PATH} on ${BRANCH})` : ''}`);
  let got; try { got = rulesFileOf(file.json); } catch (e) { throw new Error(`main's rules file can't be used: ${e.message}`); }
  return { commit, ...got };
}

/**
 * The real ports, as the Dispatcher's user: its config read as root's files are, its token, the read-only client, the list
 * file, the terminal. Tests pass their own.
 */
export function realPorts(io, cfg, { fetchFn } = {}) {
  return {
    dispatcherConfig: () => JSON.parse(readConfigFile(join(installPaths(cfg).installRoot, DISPATCHER_CONFIG), { strict: true, rootUid: io.rootUid, what: "the Dispatcher's config (dispatcher.json)" })),
    products: (file) => readProducts(file),
    gh: (c, uid) => readOnlyClient({ token: tokenFile(c.tokenFile, { uid }), fetchFn }),
    folder: (path, uid) => privateFolder({ path, uid, what: "the rules reader's state folder (rulesStateDir)", writable: true }),
    readList: readListFile,
    writeList: writeListFile,
    lastGood: (dir, product) => { try { const r = readListFile(join(dir, `${product}.last-good.json`), { uid: io.euid() }); return r.text === null ? null : JSON.parse(r.text)?.blob ?? null; } catch { return undefined; } },
    verify: (file) => allowListVerifier(file),
    ask: readLineFromTty,
  };
}

/**
 * The command. `io` is setup's (euid, rootUid, run for dscl); `cfg` root's parsed setup config; `env` the process's; `ports`
 * as realPorts. → exit code: 0 approved (or already last), 1 refused after looking, 2 refused before reading anything.
 */
export async function approveRules({ io, cfg, product, dry = false, env, ports, out, err }) {
  // 1. who.
  const me = readUser(io, DISPATCHER_USER);
  const owner = readUser(io, cfg.owner);
  if (!me.exists || !owner.exists) { err(`refused: ${!me.exists ? DISPATCHER_USER : cfg.owner} is not a user on this Mac`); return 2; }
  if (io.euid() !== me.uid) { err(`refused: run this as ${DISPATCHER_USER}, who owns the approval list: sudo -k -u ${DISPATCHER_USER} … approve-rules ${product}`); return 2; }
  if (owner.uid === me.uid || owner.uid === io.rootUid) { err(`refused: the owner in root's setup config (${cfg.owner}) can't be ${DISPATCHER_USER} or root`); return 2; }
  if (env.SUDO_UID !== String(owner.uid)) { err(`refused: only the owner (${cfg.owner}) approves rules, through sudo from their own login (SUDO_UID is ${env.SUDO_UID === undefined ? 'not set' : 'another user'})`); return 2; }

  // 2. which.
  let c; let entry; let dir; let file;
  try {
    c = checkConfig(ports.dispatcherConfig(), { selfUid: me.uid });
    if (c.product !== product) throw new Error(`the Dispatcher's config is for ${c.product}, not ${product}`);
    entry = ports.products(c.productsFile).find((p) => p.product === product);
    if (!entry) throw new Error(`${c.productsFile} does not list ${product}`);
    dir = ports.folder(c.rulesStateDir, me.uid);
    file = join(dir, APPROVED_FILE);
  } catch (e) { err(`refused: ${e.message}`); return 2; }

  // 3. main's version.
  const gh = ports.gh(c, me.uid);
  let m; try { m = await mainRules(gh, entry); } catch (e) { err(`refused: ${e.message}`); return 1; }

  // 4. shown.
  let before; let list;
  try { before = ports.readList(file, { uid: me.uid }); list = before.text === null ? {} : parseList(before.text); } catch (e) { err(`refused: the approval list can't be used: ${e.message}`); return 1; }
  const mine = list[product] ?? [];
  const parsed = parsePolicy(m.text);
  out(`product      ${product} (${entry.owner}/${entry.repo})`);
  out(`main         commit ${m.commit}`);
  out(`rules file   ${RULES_PATH}, blob ${m.blob}`);
  if (!parsed.ok) { err(`refused: main's rules don't parse (${parsed.reason}); the reader would never adopt them`); return 1; }
  const mp = moduleProblems(parsed.policy, product);
  out(`checks       it parses; M10's module checks: ${mp.length ? `${mp.length} problem(s): ${mp.join('; ')}` : 'none'}`);
  const held = ports.lastGood(dir, product);
  out(`in force     ${held === null ? 'no version yet (the reader has adopted none)' : held === undefined ? "the reader's last good copy can't be read" : `blob ${held}`}`);
  out(`the list     ${mine.length ? `${mine.length} approved for ${product}, the last ${mine.at(-1)}` : `none approved for ${product} yet`}`);
  if (mine.at(-1) === m.blob) { out(`already approved: ${m.blob} is the last on the list. Nothing written.`); return 0; }
  // The reader moves forward only from a version the list names (allowListVerifier): one it holds that the list doesn't
  // name can never be moved on from, so writing would approve nothing.
  // One that can't be read can't be checked against the list, so it is a refusal, never a skip (L1132 m4).
  if (held === undefined) { err(`refused: the reader's last good copy in ${dir} can't be read, so it can't be checked against the list. Look at it first.`); return 1; }
  if (typeof held === 'string' && !mine.includes(held)) { err(`refused: the version the reader holds (${held}) is not on the list, so the reader can't move forward from it; nothing an approval adds would be adopted. Look at ${file}.`); return 1; }
  if (mine.includes(m.blob)) out(`NOTE         this version was approved before and later replaced: approving it again lets the reader go back to it`);
  out(`--- the first ${TOP_LINES} lines of main's ${RULES_PATH} ---`);
  for (const l of m.text.split('\n').slice(0, TOP_LINES)) out(`  ${l}`);
  out('---');
  if (dry) { out('dry run: nothing asked, nothing written.'); return 0; }

  // 5. the owner's yes.
  let typed; try { typed = ports.ask(`To approve this version for the Dispatcher, type the product's name (${product}) and press Return: `); } catch (e) { err(`refused: ${e.message}`); return 1; }
  if (typed !== product) { err('not approved: the name typed is not the product\'s. Nothing written.'); return 1; }

  // 6. still main's.
  let again; try { again = await mainRules(gh, entry); } catch (e) { err(`refused: main can't be read again (${e.message}). Nothing written.`); return 1; }
  if (again.commit !== m.commit || again.blob !== m.blob) { err(`refused: main moved while you were reading (now commit ${again.commit}, blob ${again.blob}). Nothing written; run it again to see the new version.`); return 1; }

  // 7. forward only.
  let now; try { now = ports.readList(file, { uid: me.uid }); } catch (e) { err(`refused: the approval list can't be read again (${e.message}). Nothing written.`); return 1; }
  if (now.text !== before.text) { err('refused: the approval list changed while you were reading. Nothing written; run it again.'); return 1; }
  const next = { ...list, [product]: [...mine, m.blob] };
  try { ports.writeList(file, `${JSON.stringify(next, null, 2)}\n`); } catch (e) { err(`refused: the approval list could not be written (${e?.code ?? e.message})`); return 1; }

  // 8. read back.
  let ok; try { ok = ports.verify(file)({ product, blob: m.blob, lastGoodBlob: typeof held === 'string' ? held : null }) === true; } catch { ok = false; }
  if (!ok) { err(`FAIL  ${APPROVED_FILE} was written, but the reader's own check does not approve ${m.blob}: look at ${file}`); return 1; }
  out(`approved: ${m.blob} is now the last on ${product}'s list; the Dispatcher's rules reader adopts it on its next pass.`);
  return 0;
}
