// The push script (R-0b-45; design v4 §8.3 D1–D4; review 0b-4 M2–M8, m1, m2; lead calls L3, L4).
//
// The only way a worker's work reaches GitHub. A worker hands in a sealed bundle in its outbox;
// this script, running as the scripts' own user, in order:
//   1. takes its inputs from the record only (product, card, branch, outbox, attempt), never from
//      the worker's report or the bundle's name;
//   2. copies the bundle into a private folder (so it can't be swapped mid-check), reads its
//      header strictly (exactly one ref, the card's branch) and verifies it against the mirror;
//   3. fetches main (and the card branch, if GitHub has it) fresh from GitHub into the mirror,
//      then fetches the bundle's one branch into a holding ref;
//   4. works out the new commits (none may be a first commit or a merge) and refuses every
//      touched path on the push-refusal list, in each commit and in the net change;
//   5. refuses any added line holding `gitleaks:allow`, then runs the secret scan;
//   6. asks the rules, then the start gate;
//   7. pushes exactly that commit to exactly `refs/heads/<branch>` (no force, ever: L4), opens or
//      updates the pull request, and only then moves the mirror's branch.
// Every refusal leaves GitHub untouched and writes one record line with a plain reason.
// All git goes through safe-git.mjs.
//
// Three doors, one core (R-0b-127; the third below): `pushCard(sessionId)` for a worker's outbox, and `pushProposal({ product,
// card })` for a bundle Joe's own tab dropped in the product's proposals folder (rules `proposals.outbox`). A proposal
// goes through every step above exactly like a worker's bundle. What differs is only where it comes from: the folder,
// the owner the bundle must have (Joe's `ownerUid`, where a worker's must be `uids.worker`; L76 (3), L77 m2), and its
// bytes, which must be the ones the intake holds for `bundle-<card>.bundle`: the script reads that fact itself, and no
// caller names a hash (L325 m1). Its branch is `card/<card>` and its attempt
// `p-<first 12 of sha256>`, so new bytes are a new attempt and bytes already pushed answer that push
// again ({ already: true }); its card must be in the Record. `{ look: true }` stops after step 4 and answers the net
// change's files, with their modes, and the sha256 it read, without asking the rules or pushing: the intake's day-1 docs check reads the push script's own list
// (L77 m1), never one a proposal declares. A refusal that may pass by itself says `retry: true`; the others are final.
//
// The third door, `pushResearch({ product, card })` (L286, L290): a research_copy card has no bundle, because no AI writes
// its copy. This script makes the one commit itself, on main as just fetched from GitHub, from the owner's report in the
// proposals folder, and the file goes in byte for byte, with no text handling at all. Everything else is the same core,
// so the commit meets the refusal list, the secret scan, the rules and the start gate like any other. What it reads comes
// from the card alone. The report is read once, from one handle (M9's plain-file open: no link, one name; then the owner
// and settle checks), its sha256 is checked before anything is staged and its blob id before any commit, and the merge
// gate compares that blob id again at merge (refusal 10). Its attempt is `r-<first 12 of sha256>` and its fact says
// `from: 'research'`; bytes already pushed answer that push again. If the card's branch is already on GitHub (a push
// whose fact was lost), that branch is what goes through the same checks, so it counts only if it is one commit making
// exactly this change. Anything else there is refused, never overwritten. The report is never read as text.

import { lstatSync, openSync, fstatSync, readSync, writeSync, closeSync, mkdtempSync, rmSync, constants as C } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, isAbsolute } from 'node:path';
import { git, checkMirror, checkGitVersion } from './safe-git.mjs';
import { parseRawZ, refusedEntries } from './push-refusals.mjs';
import { scanSecrets } from './gitleaks.mjs';
import { allowList, maskPath } from './binary-files.mjs';
import { startGate } from './start-gate.mjs';
import { BRANCH, cardBranch } from './branch.mjs';
import { WORKER_OUTBOX_ROLES, outboxProblemFor } from './session-outbox.mjs';
import { proposalFolder } from '../launcher/proposal-wall.mjs';
import { plainFd } from '../../M9-record/unsent.mjs';
import { researchPath, researchFileName, RESEARCH_ID } from '../../M2-approvals/research-ask.mjs';
import { intakeFactId } from '../../M11-dispatcher/intake-facts.mjs';

export { BRANCH };
export const BUNDLE_CAP = 200 * 1024 * 1024;
// A file changed this recently may still be being written. One value: the proposals intake's too.
export const SETTLE_MS = 2000;
// A research copy refused with this reason is told to the owner at once (M11 researchCopyPass).
export const REPORT_CHANGED = 'the report\'s bytes are not the ones the intake recorded';
// The bits a proposals folder may not have: anything looser than 750. One value: the intake's folder check too.
export const FOLDER_LOOSE = 0o027;
// git's change letters (diff-tree --raw --no-renames) as M10 names them; a type change (T) is a modified file.
const CHANGE_STATUS = Object.freeze({ A: 'added', M: 'modified', D: 'removed', T: 'modified' });
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isUid = (u) => Number.isSafeInteger(u) && u > 0;
// An attempt id starting p- or r- is a proposal's or a research copy's (their facts live under it); a worker's never does.
const DOOR_ATTEMPT = /^[pr]-/;
const NEVER = ['main', 'master', 'jobs-approved'];

class Refusal extends Error {}
const no = (reason) => { throw new Refusal(reason); };
// A refusal that may pass by itself (GitHub, the mirror, the robot key, the start gate, a proposal's bundle changed since the
// intake held it): the caller keeps the work and tries again (`retry: true` on the answer), where every other refusal is
// the end of it (L325 m2, L597 (2)).
const later = (reason) => { const e = new Refusal(reason); e.retry = true; throw e; };
// One rule for every git call in this script (L680). A git that did not finish (safe-git's time limit, a failed start, or
// its refusal to run: code -1) says nothing about the bundle, so it is a wait. Git's own non-zero answer is judged by what
// the command asks about: the bundle's own bytes or names (BUNDLE) is final, `no`; GitHub or the mirror (PLACE) may pass
// by itself, `later`. `final` is the reason said either way. A BUNDLE answer that is the Mac's (MAC_FAULT), or says
// nothing at all, is a wait too (L702 M1): a broken bundle always says so (early EOF, missing objects), and a final
// refusal is keyed on the bundle's bytes, so it could never be taken back.
const BUNDLE = 'bundle';
const PLACE = 'GitHub or the mirror';
// git's and the system's words for a fault of the Mac, not the bundle: a mirror it could not write (a stale lock, a full
// or read-only disk, a folder it may not write), or a helper that was killed or could not start (memory, file handles,
// processes). safe-git runs git with LANG=C, so these are always in English.
export const MAC_FAULT = /cannot lock ref|unable to create '[^']*\.lock'|\.lock': File exists|no space left on device|disk quota exceeded|read-only file system|died of signal|out of memory|cannot allocate memory|permission denied|operation not permitted|input\/output error|too many open files|cannot fork|unable to fork|resource temporarily unavailable/i;
const gitAnswer = (r, about, final) => {
  const said = String(r.stderr ?? '');
  if (r.code === -1) later(`git did not finish: ${plainError(said.slice(0, 200))}`);
  if (about === BUNDLE && !said.trim()) later('git failed with no message, so it is not judged the bundle\'s');
  // A request for more memory than any Mac has is a broken object size in the bundle, not the Mac (#262 r4 N2, L713).
  const asked = /tried to allocate (\d+) bytes/i.exec(said);
  const absurd = asked !== null && Number(asked[1]) > 2 ** 40;
  if (about === BUNDLE && !absurd && MAC_FAULT.test(said)) later(`git failed on this Mac, not on the bundle: ${plainError(said.trim().split('\n').find((l) => MAC_FAULT.test(l)) ?? '').slice(0, 200)}`);
  return about === BUNDLE ? no(final) : later(final);
};
// Tests only (createPushScript's testGit): { bin, timeouts: { <command>: ms }, failStart: [<command>] } for this run's git
// calls, so a test can make one command stall past its time limit, fail to start, or answer as it likes.
const gitTest = new AsyncLocalStorage();
function run(args, opts) {
  const t = gitTest.getStore();
  if (!t) return git(args, opts);
  const cmd = args[0];
  return git(args, { ...opts, ...(t.bin ? { gitBin: t.bin } : {}), ...(t.timeouts?.[cmd] ? { timeoutMs: t.timeouts[cmd] } : {}), ...(t.failStart?.includes(cmd) ? { gitBin: '/nonexistent/git' } : {}) });
}
/** git `args`, through the one rule: its answer when it exits 0, else a wait or a refusal (gitAnswer). */
async function gitDo(args, opts, about, final) {
  const r = await run(args, opts);
  if (r.code !== 0) gitAnswer(r, about, final);
  return r;
}
const gitText = async (args, opts, about, final) => (await gitDo(args, opts, about, final)).stdout.toString('utf8');

/** An error's text with its folder paths cut to <path>, at most 200 characters: one rule for every error a caller shows. */
export const plainError = (m) => String(m).replace(/\/[^\s'":]+/g, '<path>').slice(0, 200);
/** The fact a push is recorded in, per card and attempt; a proposal's attempt is named by its bundle's bytes. */
export const PUSH_FACT = (card, att) => `push.${card}.${att}`;
export const PROPOSAL_ATTEMPT = (sha) => `p-${sha.slice(0, 12)}`;
export const githubUrl = (repo) => `https://github.com/${repo}.git`;
export const bundleName = (card) => `bundle-${card}.bundle`;
const tokenConfig = (token) => [['http.https://github.com/.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]];

/** The folder a file is taken from: a plain folder, not a link, owned by `folderUid` when that is given. */
function checkFolder(folder, folderUid) {
  let ost; try { ost = lstatSync(folder); } catch { later('the outbox is missing'); }
  if (ost.isSymbolicLink() || !ost.isDirectory()) no('the outbox is not a plain folder');
  if (folderUid !== undefined && ost.uid !== folderUid) no(`the folder is owned by user ${ost.uid}, not user ${folderUid}`);
  if (folderUid !== undefined && (ost.mode & FOLDER_LOOSE) !== 0) no('the folder is looser than 750');
}

/**
 * Copies the bundle, never following a link, into `dir`; returns the copy's path. The bundle must be owned by `uid`
 * (the caller's: the worker's for an outbox, Joe's for a proposals folder; L77 m2), checked on the handle it is read
 * through. With `folderUid`, the folder must be owned by that user too, and be no looser than 750. With `sha256`, the copy's bytes must hash to it.
 */
function stageBundle(outbox, card, dir, cap, { uid, folderUid, sha256, fstat = fstatSync }) {
  if (!isUid(uid)) no('no owner to check the bundle against');
  checkFolder(outbox, folderUid);
  let fd;
  try { fd = openSync(join(outbox, bundleName(card)), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch (e) { (e?.code === 'ELOOP' ? no : later)(e?.code === 'ELOOP' ? 'the bundle in the outbox is a link' : 'no bundle in the outbox'); }
  const copy = join(dir, 'card.bundle');
  let out;
  try {
    const st = fstat(fd);
    if (!st.isFile()) no('the bundle is not a plain file');
    if (st.nlink !== 1) no('the bundle has more than one link');
    if (st.uid !== uid) no(`the bundle is owned by user ${st.uid}, not user ${uid}`);
    // A fast first refusal; the copy loop's own count below is the one that holds if the file grows.
    if (st.size > cap) no(`the bundle is larger than ${cap} bytes`);
    out = openSync(copy, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
    const buf = Buffer.alloc(1 << 20);
    const hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      total += n;
      if (total > cap) no(`the bundle is larger than ${cap} bytes`);
      hash.update(buf.subarray(0, n));
      writeSync(out, buf, 0, n);
    }
    // The bytes checked are the bytes copied, from the one handle (L233 M-5): a swap after the intake read is refused.
    // The file changed after the intake held it: the next pass judges the bytes there now, so this may pass (L597 (2)).
    if (sha256 !== undefined && hash.digest('hex') !== sha256) later('the bundle\'s bytes are not the ones the intake recorded');
  } finally { closeSync(fd); if (out !== undefined) closeSync(out); }
  return copy;
}

/**
 * The report's raw bytes, read once from one handle (L290): M9's plain-file open, then the owner and settle checks on
 * that handle, then the card's size and sha256. It reads one byte past the size, so a file still growing is refused.
 */
function readReport(folder, { file, sha256, size }, { uid, folderUid, fstat = fstatSync, now }) {
  checkFolder(folder, folderUid);
  let fd;
  // plainFd's own error names the path; the reason recorded says what was wrong instead.
  try { fd = plainFd(join(folder, file), C.O_RDONLY); } catch { no('the report is missing, a link, or has more than one name'); }
  try {
    const st = fstat(fd);
    if (st.uid !== uid) no(`the report is owned by user ${st.uid}, not user ${uid}`);
    if (!(now - st.mtimeMs >= SETTLE_MS)) no('the report changed a moment ago, so it may still be being written');
    const buf = Buffer.alloc(size + 1); // One byte over, so a longer file is seen as longer without reading all of it.
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (!n) break;
      got += n;
    }
    const bytes = buf.subarray(0, got);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) no(REPORT_CHANGED);
    return bytes;
  } finally { closeSync(fd); }
}

/** The id of tree `tree` (null: none) with the blob at path `parts` and every other entry as it was. Names stay raw bytes. */
async function treeWith(mirror, tree, [name, ...rest], blob) {
  const rows = [];
  if (tree) {
    const r = await gitDo(['ls-tree', '-z', tree], { gitDir: mirror, purpose: 'push-research-tree' }, PLACE, 'could not read main\'s files');
    rows.push(...r.stdout.toString('latin1').split('\0').filter(Boolean));
  }
  const have = rows.find((row) => row.slice(row.indexOf('\t') + 1) === name);
  const [, type, id] = have?.split(/[ \t]/) ?? [];
  if (have && (type === 'tree') !== (rest.length > 0)) no(`main has ${name} as ${type === 'tree' ? 'a folder' : 'a file'}, so the report can't go there`);
  const entry = rest.length ? `040000 tree ${await treeWith(mirror, id ?? null, rest, blob)}\t${name}` : `100644 blob ${blob}\t${name}`;
  const kept = rows.filter((row) => row !== have);
  const m = await gitDo(['mktree', '-z'], { gitDir: mirror, purpose: 'push-research-tree', input: Buffer.from(`${[...kept, entry].join('\0')}\0`, 'latin1') }, PLACE, 'could not build the copy\'s files');
  return m.stdout.toString().trim();
}

/** The copy's one commit on main, held at `holding`: the report's bytes exactly as they are, at the card's one path. */
async function commitReport(mirror, { path, blob, ask }, bytes, holding) {
  const made = await gitDo(['hash-object', '-w', '--stdin', '--no-filters'], { gitDir: mirror, purpose: 'push-research-blob', input: bytes }, PLACE, 'could not store the report');
  if (made.stdout.toString().trim() !== blob) no(REPORT_CHANGED);
  const main = (await gitText(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { gitDir: mirror, purpose: 'push-research-commit' }, PLACE, 'could not read main in the mirror')).trim();
  const was = (await gitText(['rev-parse', '--verify', 'refs/heads/main^{tree}'], { gitDir: mirror, purpose: 'push-research-commit' }, PLACE, 'could not read main in the mirror')).trim();
  const tree = await treeWith(mirror, was, path.split('/'), blob);
  if (tree === was) no(`main already holds these bytes at ${path}`);
  const tip = (await gitText(['commit-tree', tree, '-p', main, '-m', `Copy research ask ${ask}'s report to ${path}`], { gitDir: mirror, purpose: 'push-research-commit' }, PLACE, 'could not make the copy\'s commit')).trim();
  await gitDo(['update-ref', holding, tip], { gitDir: mirror, purpose: 'push-research-commit' }, PLACE, 'could not hold the copy\'s commit');
  return tip;
}

/** Reads the bundle header strictly. Exactly one ref, `refs/heads/<branch>`; no filter. */
export function readBundleHeader(path, branch) {
  const fd = openSync(path, C.O_RDONLY);
  const buf = Buffer.alloc(65536);
  let n; try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  const text = buf.subarray(0, n).toString('latin1');
  const end = text.indexOf('\n\n');
  if (end < 0) no('the bundle header is unreadable');
  const lines = text.slice(0, end).split('\n');
  const sig = lines.shift();
  if (sig !== '# v2 git bundle' && sig !== '# v3 git bundle') no('not a git bundle');
  const refs = [];
  for (const l of lines) {
    if (l.startsWith('@')) { if (sig === '# v3 git bundle' && l === '@object-format=sha1') continue; no(`the bundle carries a capability it may not (${l.slice(0, 40)})`); }
    if (l.startsWith('-')) { if (!SHA.test(l.slice(1, 41))) no('the bundle has an unreadable prerequisite'); continue; }
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(l);
    if (!m) no('the bundle header has an unreadable line');
    refs.push({ sha: m[1], ref: m[2] });
  }
  if (refs.length !== 1) no(`the bundle must hold exactly one branch (it holds ${refs.length})`);
  if (refs[0].ref !== `refs/heads/${branch}`) no(`the bundle holds ${refs[0].ref}, not refs/heads/${branch}`);
  return refs[0].sha;
}

/** Commit ids with their parents: [[sha, [parents]]]. */
async function newCommits(mirror, tip, exclude, about) {
  const out = await gitText(['rev-list', '--parents', tip, '--not', ...exclude], { gitDir: mirror, purpose: 'push-new-commits' }, about, 'could not list the branch\'s commits');
  return out.trim().split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split(' '); return [s, p]; });
}

async function changes(mirror, args, about) {
  const r = await gitDo(['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', ...args], { gitDir: mirror, purpose: 'push-paths' }, about, 'could not list a commit\'s changes');
  return parseRawZ(r.stdout);
}

async function addedAllowComment(mirror, sha, about) {
  const r = await gitDo(['diff-tree', '-p', '-r', '--text', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--no-color', sha], { gitDir: mirror, purpose: 'push-allow-lines' }, about, 'could not read a commit\'s changes');
  return r.stdout.toString('utf8').split('\n').some((l) => l.startsWith('+') && /gitleaks:allow/i.test(l));
}

// Each commit's whole object (author, committer and every other header line, then the message;
// R-0b-47 round 2 MAT-B) and the names of the files it touches, for the stdin scan.
async function messages(mirror, shas, names, about) {
  const res = [];
  for (const sha of shas) {
    const r = await gitDo(['cat-file', 'commit', sha], { gitDir: mirror, purpose: 'push-messages' }, about, `could not read commit ${sha.slice(0, 12)}`);
    res.push([sha, `${r.stdout.toString('utf8')}\n${(names.get(sha) ?? []).join('\n')}\n`]);
  }
  return res;
}

/**
 * deps:
 *   record, rules           the shared interfaces (actor 'workshop' writes)
 *   privateDir              the scripts' private folder (mode 700)
 *   scanner                 { bin, version, config, ignoreFile } for gitleaks
 *   getRobotToken(product)  M6's short-lived robot key (R-0b-86)
 *   readRun, workflowRule, issues, gateCache   the start gate's ports (start-gate.mjs)
 *   productPlace(product)   { repo: 'owner/name', mirror: '<folder>' }: the wiring builds it from the products.json entry
 *                           and this Mac's config. Neither is a rules line: one home each (L568). products.json keeps
 *                           `repo` as the bare name with `owner` beside it, so the wiring joins them:
 *                           repo: `${entry.owner}/${entry.repo}`. Passing entry.repo alone makes every push wait (L719 m5).
 *                           It may be async; the push awaits it.
 *   outsideWorkflow         the outside check's pinned workflow path, from this Mac's config (L568)
 *   pullRequests.upsert({ repo, branch, base, title, body, token })   opens or updates the PR
 *   testRemote(repo)        tests only: a local bare repo standing in for GitHub. Production
 *                           never passes it, so every address is https://github.com/<repo>.git.
 *   testFstat(fd)           tests only, refused outside them: stands in for fstat on the bundle's handle.
 *   testGit                 tests only, refused outside them: { bin, timeouts, failStart } for every git call (gitTest).
 *   afterStage()            tests only: runs right after the private copy is taken, so a test can
 *                           swap the outbox bundle at the earliest moment (review R-0b-47 MAT-4).
 *   uids.worker             the Mac user a worker's bundle must be owned by (`orchestrate`, L65)
 *   outboxRoot              the outboxes' root folder, not a product's (each product's folder is under it, #378
 *                           r1 m2): a worker's outbox must really be
 *                           <root>/<product>/worker/<session id> (<root>/<product>/script/<session id> for a script
 *                           card, L767; the product's own folder, L836 shared/product-paths.mjs)
 *   ownerUid                Joe's Mac user: a proposals bundle, and its folder, must be owned by it (L77 m2)
 *   fstat(fd)               tests only: stands in for fstatSync on the bundle's handle, so a test can make a bundle
 *                           look owned by another user (tests can't chown).
 */
export function createPushScript(deps) {
  const { record, rules, productPlace, outsideWorkflow, privateDir, scanner, getRobotToken, readRun, workflowRule, issues, pullRequests, gateCache = {}, testRemote, afterStage, bundleCap = BUNDLE_CAP, now = () => Date.now(), uids, ownerUid, outboxRoot, testFstat: fstat, testGit } = deps;
  if (fstat !== undefined && !process.env.NODE_TEST_CONTEXT) throw new Error('createPushScript: testFstat is for tests only');
  if (testGit !== undefined && !process.env.NODE_TEST_CONTEXT) throw new Error('createPushScript: testGit is for tests only');
  // Checked once, here: a push script that can't tell a worker's bundle from Joe's is never made.
  // So is one that doesn't know where a product lives, or which outside check to trust (L568).
  if (typeof productPlace !== 'function') throw new Error('createPushScript: productPlace must be a function');
  if (typeof outsideWorkflow !== 'string' || !outsideWorkflow) throw new Error('createPushScript: outsideWorkflow must name the pinned workflow');
  if (!isUid(uids?.worker)) throw new Error('createPushScript: uids.worker must be a Mac user id');
  if (!isUid(ownerUid)) throw new Error('createPushScript: ownerUid must be a Mac user id');
  if (uids.worker === ownerUid) throw new Error('createPushScript: the worker user and the owner must be different users');

  /** A worker's inputs, from the session record only (step 1). */
  function workerInputs(sessionId) {
    const s = record.read('session', sessionId)?.doc;
    if (!s || typeof s !== 'object') no('no launch record for this session');
    const { product, card, branch, outbox, attempt: att } = s;
    if (typeof product !== 'string' || !product) no('the launch record names no product');
    if (typeof card !== 'string' || !CARD.test(card)) no('the launch record has a bad card id');
    if (typeof att !== 'string' || !ATTEMPT.test(att) || DOOR_ATTEMPT.test(att)) no('the launch record has a bad attempt id');
    // The record says role worker for a script card too (L759), so either runner role's folder is this session's own (L767).
    // Taking either here is safe because of an earlier check, not this one (#358 c3): the Dispatcher wrote this outbox
    // into the record only after checking it under the session's own role (M11 pass.mjs, startRole(kind)), so a
    // worker's record never names the script folder, nor a script's the worker one. In the session's own product's
    // folder (L836: <root>/<product>/<role>/<id>).
    const badOutbox = outboxProblemFor(outbox, sessionId, { outboxRoot, product, role: WORKER_OUTBOX_ROLES });
    if (badOutbox) no(`the launch record's outbox ${badOutbox}`);
    return { product, card, branch, folder: outbox, uid: uids.worker, att };
  }

  /** The sha256 the intake holds for this card's bundle: the one source of which bytes a proposal is (L325 m1). */
  function heldSha({ product, card } = {}) {
    if (typeof product !== 'string' || !product) no('the proposal names no product');
    if (typeof card !== 'string' || !CARD.test(card)) no('the proposal has a bad card id');
    const f = record.read('fact', intakeFactId(product, bundleName(card)));
    // The intake read the fact held this same pass: anything else here is a Record fault or a race, never the bundle's
    // (L680 cosmetic 1).
    if (f?.corrupt || f?.doc?.state !== 'held' || !SHA256.test(String(f.doc.sha256))) later('the intake holds no bundle for this card');
    return f.doc.sha256;
  }

  /** A proposal's inputs: the caller names product and card, the intake's fact the bytes, and the rest is the rules'. */
  function proposalInputs({ product, card }, sha256) {
    // Fail closed here too, not only at the intake (L274 (2), L334): a proposal for a card the Record lacks is refused.
    // Not there, or not readable, this once: a wait, as at the intake's own check (L597 (2), L669 M1).
    if (!record.read('card', card)?.doc) later(`card ${card} is not in the Record`);
    const folder = proposalFolder(rules, product);
    if (!folder) later('the product has no proposals folder in the rules');
    return { product, card, branch: cardBranch(card), folder, uid: ownerUid, folderUid: ownerUid, att: PROPOSAL_ATTEMPT(sha256), sha256 };
  }

  /** A research copy's attempt id: new bytes are a new attempt. Null for a card with no readable sha256. */
  function researchAttempt(card) {
    const sha = record.read('card', card)?.doc?.source?.sha256;
    return SHA256.test(String(sha)) ? `r-${sha.slice(0, 12)}` : null;
  }

  /** A research copy's inputs: the card alone says what is copied, and only a ready research_copy card is. */
  function researchInputs({ product, card } = {}) {
    if (typeof product !== 'string' || !product) no('the research copy names no product');
    if (typeof card !== 'string' || !CARD.test(card)) no('the research copy has a bad card id');
    const c = record.read('card', card);
    if (c?.corrupt || !c?.doc) no(`card ${card} is not in the Record`);
    const d = c.doc;
    if (d.kind !== 'research_copy') no(`card ${card} is not a research_copy card`);
    if (d.product !== product) no(`card ${card} is another product's`);
    if (d.state !== 'ready') no(`card ${card} is ${d.state}, not ready`);
    const ask = d.research_ask;
    const { file, sha256, blob, size } = d.source ?? {};
    if (typeof ask !== 'string' || !RESEARCH_ID.test(ask) || file !== researchFileName(ask) || !Array.isArray(d.files) || d.files.length !== 1 || d.files[0] !== researchPath(ask)) no(`card ${card} does not name its ask's one file`);
    if (!SHA256.test(String(sha256)) || !SHA.test(String(blob)) || !Number.isSafeInteger(size) || size <= 0) no(`card ${card} has no proof of the report's bytes`);
    const folder = proposalFolder(rules, product);
    if (!folder) no('the product has no proposals folder in the rules');
    const research = { ask, file, sha256, blob, size, path: d.files[0] };
    return { product, card, branch: cardBranch(card), folder, uid: ownerUid, folderUid: ownerUid, att: researchAttempt(card), research };
  }

  async function attempt({ product, card, branch, folder, uid, folderUid, att, sha256, research }, { look = false } = {}) {
    if (!BRANCH.test(String(branch)) || branch !== cardBranch(card)) no(`the branch "${branch}" is not the card's branch`);

    // Awaited: the wiring may read products.json asynchronously (L719 m3). A throw here is a wait, via settle (L669 M1).
    const { repo, mirror } = (await productPlace(product)) ?? {};
    const base = rules.get('product.default_branch', { product }) ?? 'main';
    // The one "on" switch, the same line M2 onboard.mjs reads (L204-b, L568); only the exact word active is on. The
    // product's setup is not about the bundle: once it is fixed on main or on this Mac, the same bytes go on (L669 M1).
    if (rules.get('onboarding.state', { product }) !== 'active') later('the product is not onboarded yet (its entry is not on main)');
    if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..')) later('the product has no valid GitHub repo on this Mac');
    if (typeof mirror !== 'string' || !isAbsolute(mirror)) later('the product has no mirror on this Mac');
    if ([...NEVER, base].includes(branch) || branch.startsWith('orchestrate/')) no(`the branch "${branch}" may never be pushed`);
    // What a branch's commits are about: a research copy's are made here, from main in the mirror; any other's come from
    // the bundle.
    const of = research ? PLACE : BUNDLE;
    const fmt = await run(['check-ref-format', '--branch', branch], { gitDir: mirror, purpose: 'push-branch-name' });
    if (fmt.code === -1 && fmt.stderr.startsWith('safe-git: refused: ')) later(`mirror: ${fmt.stderr.slice('safe-git: refused: '.length)}`);
    if (fmt.code !== 0) gitAnswer(fmt, BUNDLE, `the branch "${branch}" is not a valid name`);

    const url = testRemote ? testRemote(repo) : githubUrl(repo);
    if (!testRemote && !url.startsWith('https://github.com/')) later('the push address is not on github.com');
    if (testRemote && (typeof url !== 'string' || !isAbsolute(url))) later('the test remote is not a local folder');

    const v = await checkGitVersion(gitTest.getStore()?.bin ? { gitBin: gitTest.getStore().bin } : {});
    if (!v.ok) later(v.reason);
    const m = checkMirror(mirror);
    if (!m.ok) later(`mirror: ${m.reason}`);

    let token;
    try { token = await getRobotToken(product); } catch { token = null; }
    if (typeof token !== 'string' || !token) later('no robot key for this product');
    // The one address the network calls may name besides local paths (safe-git, L51).
    const auth = { extraConfig: tokenConfig(token), address: url };

    const work = mkdtempSync(join(privateDir, 'push-'));
    const holding = `refs/orchestrate/incoming/${card}/${att}`;
    const remoteRef = `refs/orchestrate/remote/${branch}`;
    try {
      // 2. The private copy, its header and its check against the mirror.
      // (A research copy has no bundle: its report is read here, and its commit made once main is fresh.)
      const report = research ? readReport(folder, research, { uid, folderUid, fstat, now: now() }) : null;
      const copy = research ? null : stageBundle(folder, card, work, bundleCap, { uid, folderUid, sha256, fstat });
      await afterStage?.();
      let tip = research ? null : readBundleHeader(copy, branch);

      // 3. Main (and the card branch) fresh from GitHub, then the bundle into the holding ref.
      const lr = await gitDo(['ls-remote', '--heads', url, `refs/heads/${branch}`], { gitDir: mirror, purpose: 'push-ls-remote', ...auth }, PLACE, 'could not read GitHub');
      const remoteTip = /^([0-9a-f]{40})\t/.exec(lr.stdout.toString())?.[1] ?? null;
      const specs = ['+refs/heads/main:refs/heads/main'];
      if (remoteTip) specs.push(`+refs/heads/${branch}:${remoteRef}`);
      await gitDo(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', url, ...specs], { gitDir: mirror, purpose: 'push-fetch-main', ...auth }, PLACE, 'could not fetch main from GitHub');
      if (!remoteTip) await run(['update-ref', '-d', remoteRef], { gitDir: mirror, purpose: 'push-fetch-main' });

      if (research) {
        // A branch already on GitHub is checked below as this push; pushing the same commit again changes nothing.
        tip = remoteTip ?? await commitReport(mirror, research, report, holding);
      } else {
        // Not -q: git's -q verify fails a bundle missing an earlier commit with no words at all, which gitAnswer would
        // take for a wait (L702 M1); without it git says "lacks these prerequisite commits", so it stays final.
        await gitDo(['bundle', 'verify', copy], { gitDir: mirror, purpose: 'push-bundle-verify' }, BUNDLE, 'the bundle does not verify against the mirror (a missing earlier commit?)');
        // `bundle verify` reads the header and the earlier commits, never the pack: a cut-off pack, or one missing an
        // object, fails here, and that is the bundle's (L680 M1). A lock or a full disk is the mirror's, and passes.
        const fb = await run(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', copy, `refs/heads/${branch}:${holding}`], { gitDir: mirror, purpose: 'push-fetch-bundle' });
        if (fb.code !== 0) gitAnswer(fb, BUNDLE, 'the bundle could not be taken in: its pack is cut off or missing objects');
        const got = (await gitText(['rev-parse', '--verify', `${holding}^{commit}`], { gitDir: mirror, purpose: 'push-fetch-bundle' }, BUNDLE, 'the bundle\'s branch does not name a commit')).trim();
        if (got !== tip) no('the bundle\'s branch is not the commit its header names');
      }

      // 4. New commits and the paths they touch.
      if (remoteTip) {
        // Exit 1 is git's "not an ancestor": the branch moved, final. Any other failure is the mirror's (a missing object).
        const ff = await run(['merge-base', '--is-ancestor', remoteTip, tip], { gitDir: mirror, purpose: 'push-fast-forward' });
        if (ff.code === 1) no('the branch on GitHub has moved; the fix round must start from it (never a force push)');
        if (ff.code !== 0) gitAnswer(ff, PLACE, 'could not compare the branch on GitHub with this one');
      }
      // Counted from the branch on GitHub, unless this is that same commit (a retry, after a stop or a refused head write)
      // or a research copy: those are checked whole, from main, and pushing the same commit changes nothing.
      const commits = await newCommits(mirror, tip, ['refs/heads/main', ...(remoteTip && remoteTip !== tip && !research ? [remoteRef] : [])], of);
      // A proposal's branch that is already this commit, with main past it too: nothing is left to push (L274 (6)).
      if (!commits.length && sha256 !== undefined && !look && remoteTip === tip) return { ok: true, product, card, branch, tip, commits: 0, pr: null, binaries: [] };
      if (!commits.length) no('the bundle holds no new commits');
      if (research && commits.length !== 1) no('the card\'s branch on GitHub holds more than the one copy commit');
      const why = [];
      const blobs = new Map(); // every added or changed file under each of its names, for the raw-bytes scan
      const names = new Map(); // the file names each commit touches, for the stdin scan
      for (const [sha, parents] of commits) {
        if (parents.length === 0) no(`commit ${sha.slice(0, 12)} is a first commit`);
        if (parents.length > 1) no(`commit ${sha.slice(0, 12)} is a merge; a worker never merges`);
        const ch = await changes(mirror, [sha], of);
        why.push(...refusedEntries(ch));
        names.set(sha, ch.map((e) => e.path));
        for (const e of ch) if (e.status !== 'D' && /^1(00644|00755|20000)$/.test(e.newMode)) blobs.set(`${e.newId} ${e.path}`, { id: e.newId, path: e.path });
      }
      // Exit 1 is git's "no common commit": the branch shares no history with main, final (L702 minor 3).
      const mbr = await run(['merge-base', 'refs/heads/main', tip], { gitDir: mirror, purpose: 'push-paths' });
      if (mbr.code === 1) no('the branch shares no history with main');
      if (mbr.code !== 0) gitAnswer(mbr, PLACE, 'could not find where the branch leaves main');
      const mb = mbr.stdout.toString('utf8').trim();
      const net = await changes(mirror, [mb, tip], of);
      why.push(...refusedEntries(net));
      if (why.length) no(`the branch touches files no card may: ${[...new Set(why)].slice(0, 5).join('; ')}`);
      if (research && (net.length !== 1 || net[0].path !== research.path || net[0].newId !== research.blob || net[0].newMode !== '100644')) no('the branch is not exactly the report at its one path');
      const files = net.map((e) => ({ path: e.path, status: CHANGE_STATUS[e.status] ?? `unknown (${e.status})` }));
      // A look stops here: the net change, checked against the refusal list, and nothing asked or pushed.
      if (look) return { ok: true, product, card, branch, tip, sha256, files: net.map((e, i) => ({ ...files[i], mode: e.newMode })) };

      // 5. The secret scan.
      const shas = commits.map(([s]) => s);
      for (const sha of shas) if (await addedAllowComment(mirror, sha, of)) no(`commit ${sha.slice(0, 12)} adds a "gitleaks:allow" comment`);
      const scan = await scanSecrets({ setup: scanner, mirror, shas, blobs: [...blobs.values()], messages: await messages(mirror, shas, names, of), privateDir: work, allowedBinaries: allowList(rules.get('product.allowed_binaries', { product })) });
      if (!scan.ok) no(scan.reason);

      // 6. The rules, then the start gate. M10's push_branch reads the card as { id, kind, rows, doc: { lane, files } } and each
      // file as { path, status } (shared/README.md). Asked with the card's id and bare names, the real engine refused
      // every push (L81 sweep). A change letter M10 has no word for stays unknown, so the push is refused.
      // The card's files carry its rows: a card's rows are the row files it lists (L684, L696; audit #266 M1-r2).
      const cardDoc = record.read('card', card)?.doc ?? {};
      const subject = { product, card: { id: card, kind: cardDoc.kind, rows: Array.isArray(cardDoc.rows) ? cardDoc.rows : [], doc: { lane: cardDoc.lane, files: Array.isArray(cardDoc.files) ? cardDoc.files : [] } }, files };
      // An exact reverse names the reversed commit's files (the card's own list, which M11 took from that commit); M10 lets
      // such a push through only when every changed file is in it, and the merge still checks the reverse on GitHub.
      if (cardDoc.kind === 'exact_reverse' && Array.isArray(cardDoc.files)) subject.reverses_files = cardDoc.files;
      const d = rules.may('push_branch', subject);
      if (d.decision !== 'allow') no(`the rules do not allow this push: ${d.reason}`);
      const gate = await startGate({ product, mirror, record, readRun, workflowPath: outsideWorkflow, workflowRule, vercelProject: rules.get('product.vercel_project', { product }), cache: gateCache, issues, now: now() });
      if (!gate.ok) later(`the start gate is shut: ${gate.reason}`);

      // 7. The push: exactly this commit, exactly this branch, never forced.
      const p = await run(['push', '--porcelain', '--atomic', '--no-verify', url, `${tip}:refs/heads/${branch}`], { gitDir: mirror, purpose: 'push', ...auth });
      if (p.code !== 0) {
        // GitHub's own words (its `remote:` lines), path-cut, so Joe can act on them (L702 minor 2). A file over GitHub's
        // size limit (GH001) or its secret blocking (GH013) is never lifted for the same commits: final. Any other
        // refusal may pass by itself.
        // GitHub prints GH001 last, after its trace and one line per large file, so the code is looked for in the whole raw
        // text, and its line is put first in what Joe is told, before the 200-character cut (#262 r4 N1, L713).
        const remote = String(p.stderr ?? '').split('\n').filter((l) => l.startsWith('remote:')).map((l) => l.slice('remote:'.length).trim()).filter(Boolean);
        const GH_FINAL = /\bGH001\b|\bGH013\b/;
        const ghLine = remote.find((l) => GH_FINAL.test(l));
        const said = plainError((ghLine ? [ghLine, ...remote.filter((l) => l !== ghLine)] : remote).join(' '));
        const why = said ? `GitHub refused the push: ${said}` : 'GitHub refused the push';
        if (p.code !== -1 && ghLine) no(why);
        gitAnswer(p, PLACE, why);
      }
      const card_doc = cardDoc;
      let pr;
      try { pr = await pullRequests.upsert({ repo, branch, base, title: String(card_doc.what ?? card), body: String(card_doc.summary ?? ''), token }); } catch { pr = null; }
      await gitDo(['update-ref', `refs/heads/${branch}`, tip], { gitDir: mirror, purpose: 'push-mirror-branch' }, PLACE, 'pushed, but the mirror\'s copy of the branch could not be moved');
      return { ok: true, product, card, branch, tip, commits: shas.length, pr: pr ?? null, binaries: scan.binaries };
    } finally {
      await run(['update-ref', '-d', holding], { gitDir: mirror, purpose: 'push-cleanup' });
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Runs one door. Never throws: { ok, ... } or { ok: false, reason }. A push or a refusal writes one fact,
  // `push.<card>.<attempt>`; a look writes nothing (the intake records what it decides).
  // The card's head is the push's to write and no one else's (M9 permissions): the Dispatcher reads it to ask for a
  // reviewer and to request a merge. Head only, except where M9 asks for more: a new head on a verified or approved
  // card sends it back to in_review. Tried twice, for the Dispatcher writes the card too. -> null, or why it wasn't.
  function writeHead(card, tip) {
    let why = null;
    for (let i = 0; i < 2; i += 1) {
      const c = record.read('card', card);
      if (!c?.doc || c.corrupt) return `card ${card} could not be read`;
      if (c.doc.head === tip) return null;
      const back = c.doc.state === 'verified' || c.doc.state === 'approved';
      const w = record.write({ actor: 'workshop', entity: 'card', id: card, expectRev: c.rev, doc: { ...c.doc, head: tip, ...(back ? { state: 'in_review' } : {}) }, kind: 'push_head' });
      if (w.ok) return null;
      why = w.reason;
    }
    return why;
  }

  async function settle(inputs, factParts, { look = false, from } = {}) {
    let res;
    try { res = await gitTest.run(testGit, () => attempt(inputs(), { look })); } catch (e) { res = { ok: false, reason: e instanceof Refusal ? e.message : `the push script failed: ${plainError(e?.message ?? e)}`, ...(e?.retry || !(e instanceof Refusal) ? { retry: true } : {}) }; }
    // Every reason is masked once, here, before the record: a secret used as a file name is cut to
    // its first four characters, and git's own error text loses its folder paths (round 3 MIN-3, COS-4).
    if (!res.ok) res = { ...res, reason: maskPath(res.reason) };
    if (look) return res;
    const [card, att] = factParts();
    // Only a real card and attempt name a fact, so two refusals can't share one (L325 m3). String(undefined) or
    // String(null) would pass the id patterns as "undefined" / "null". With neither there is only the answer.
    if (typeof card !== 'string' || !CARD.test(card) || typeof att !== 'string' || !ATTEMPT.test(att)) return res;
    const id = PUSH_FACT(card, att);
    // Before the fact: a stop between the two leaves no fact, so the retry finds the branch and comes back here.
    const headRefused = res.ok ? writeHead(card, res.tip) : null;
    const cur = record.read('fact', id);
    let doc = res.ok ? { result: 'pushed', branch: res.branch, tip: res.tip, binaries: res.binaries ?? [], at: new Date(now()).toISOString() } : { result: 'refused', reason: res.reason, ...(res.retry ? { retry: true } : {}), at: new Date(now()).toISOString() };
    // A refusal never erases a recorded push of the same attempt (#170 r1): it is added to it as the last refusal.
    if (!res.ok && cur?.doc?.result === 'pushed' && !cur.corrupt) doc = { ...cur.doc, last_refusal: { reason: res.reason, at: doc.at } };
    if (headRefused) doc.head_refused = headRefused;
    if (from) doc.from = from;
    // The product pushed for: bytes already pushed answer again only for the same product (#170 r1 m1).
    if (res.ok && from) doc.product = res.product;
    record.write({ actor: 'workshop', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc, kind: res.ok ? 'push' : 'push_refused' });
    return res;
  }

  /** Pushes one session's bundle. */
  async function pushCard(sessionId) {
    return settle(() => workerInputs(sessionId), () => { const s = record.read('session', sessionId)?.doc ?? {}; return [s.card, s.attempt]; });
  }

  /**
   * Pushes one proposal's bundle from the product's proposals folder ({ product, card }): the bytes the intake holds
   * for that card, or with `{ look: true }` answers { ok, sha256, files } for its net change without asking the rules or pushing.
   */
  async function pushProposal(p = {}, { look = false } = {}) {
    // Read once: the fact's name and the bytes checked are the same hash, whatever the intake does meanwhile.
    let sha = null;
    const inputs = () => { sha ??= heldSha(p ?? {}); return proposalInputs(p, sha); };
    // The same bytes are the same attempt (L274 (6), L334): once pushed, they answer the recorded push, with no
    // second push and the fact left as it is. Only after the proposal's own checks pass (the card still in the Record,
    // the product's folder), and only for the product the fact recorded; a corrupt fact is not a push (#170 r1 m1, m2).
    if (!look) {
      let got = null;
      // Any throw here (a refusal, or a rules or Record read that fails, the push fact's too) falls through to settle, which meets the same
      // error and records it the usual way, masked (#170 r2).
      let done = null;
      try {
        got = inputs();
        const f = record.read('fact', PUSH_FACT(got.card, got.att));
        done = f?.doc && !f.corrupt ? f.doc : null;
      } catch { done = null; }
      if (done?.result === 'pushed' && done.product === got.product && !done.head_refused) return { ok: true, already: true, product: got.product, card: got.card, branch: done.branch, tip: done.tip, binaries: done.binaries ?? [] };
    }
    return settle(inputs, () => [p?.card, sha ? PROPOSAL_ATTEMPT(sha) : null], { look, from: 'proposal' });
  }

  /** Makes and pushes a ready research_copy card's one commit ({ product, card }). Bytes already pushed answer that push. */
  async function pushResearch(p = {}) {
    let inputs = null;
    let done = null;
    // Any throw here falls through to settle, which meets the same error and records it, masked (as pushProposal).
    try {
      inputs = researchInputs(p);
      const f = record.read('fact', PUSH_FACT(inputs.card, inputs.att));
      done = f?.doc && !f.corrupt ? f.doc : null;
    } catch { done = null; }
    if (done?.result === 'pushed' && done.product === inputs.product && !done.head_refused) return { ok: true, already: true, product: inputs.product, card: inputs.card, branch: done.branch, tip: done.tip, binaries: done.binaries ?? [] };
    return settle(() => researchInputs(p), () => { let a = null; try { a = researchAttempt(p?.card); } catch { a = null; } return [p?.card, a]; }, { from: 'research' });
  }

  // The function itself stays the worker's door, so every caller of createPushScript(deps)(sessionId) is unchanged.
  return Object.assign(pushCard, { pushCard, pushProposal, pushResearch });
}
