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
// Three doors, one core (R-0b-127; the third below): `pushCard(sessionId)` for a worker's outbox, and `pushProposal({ product, card,
// sha256 })` for a bundle Joe's own tab dropped in the product's proposals folder (rules `proposals.outbox`). A proposal
// goes through every step above exactly like a worker's bundle. What differs is only where it comes from: the folder,
// the owner the bundle must have (Joe's `ownerUid`, where a worker's must be `uids.worker`; L76 (3), L77 m2), and its
// bytes, which must be the ones the intake recorded (`sha256`). Its branch is `card/<card>` and its attempt
// `p-<first 12 of sha256>`, so new bytes are a new attempt and bytes already pushed answer that push
// again ({ already: true }); its card must be in the Record. `{ look: true }` stops after step 4 and answers the net
// change's files without asking the rules or pushing: the intake's day-1 docs check reads the push script's own list
// (L77 m1), never one a proposal declares.
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
import { join, isAbsolute } from 'node:path';
import { git, gitOk, checkMirror, checkGitVersion } from './safe-git.mjs';
import { parseRawZ, refusedEntries } from './push-refusals.mjs';
import { scanSecrets } from './gitleaks.mjs';
import { allowList, maskPath } from './binary-files.mjs';
import { startGate } from './start-gate.mjs';
import { plainFd } from '../../M9-record/unsent.mjs';
import { researchPath, researchFileName } from '../../M2-approvals/research-ask.mjs';

export const BUNDLE_CAP = 200 * 1024 * 1024;
// A file changed this recently may still be being written. One value: the proposals intake's too.
export const SETTLE_MS = 2000;
// A research copy refused with this reason is told to the owner at once (M11 researchCopyPass).
export const REPORT_CHANGED = 'the report\'s bytes are not the ones the intake recorded';
export const BRANCH = /^card\/[a-z0-9][a-z0-9-]{0,63}$/;
// git's change letters (diff-tree --raw --no-renames) as M10 names them; a type change (T) is a modified file.
const CHANGE_STATUS = Object.freeze({ A: 'added', M: 'modified', D: 'removed', T: 'modified' });
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isUid = (u) => Number.isSafeInteger(u) && u >= 0;
const NEVER = ['main', 'master', 'jobs-approved'];

class Refusal extends Error {}
const no = (reason) => { throw new Refusal(reason); };

export const githubUrl = (repo) => `https://github.com/${repo}.git`;
export const bundleName = (card) => `bundle-${card}.bundle`;
const tokenConfig = (token) => [['http.https://github.com/.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]];

/** The folder a file is taken from: a plain folder, not a link, owned by `folderUid` when that is given. */
function checkFolder(folder, folderUid) {
  let ost; try { ost = lstatSync(folder); } catch { no('the outbox is missing'); }
  if (ost.isSymbolicLink() || !ost.isDirectory()) no('the outbox is not a plain folder');
  if (folderUid !== undefined && ost.uid !== folderUid) no(`the folder is owned by user ${ost.uid}, not user ${folderUid}`);
}

/**
 * Copies the bundle, never following a link, into `dir`; returns the copy's path. The bundle must be owned by `uid`
 * (the caller's: the worker's for an outbox, Joe's for a proposals folder; L77 m2), checked on the handle it is read
 * through. With `folderUid`, the folder must be owned by that user too. With `sha256`, the copy's bytes must hash to it.
 */
function stageBundle(outbox, card, dir, cap, { uid, folderUid, sha256, fstat = fstatSync }) {
  if (!isUid(uid)) no('no owner to check the bundle against');
  checkFolder(outbox, folderUid);
  let fd;
  try { fd = openSync(join(outbox, bundleName(card)), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch { no('no bundle in the outbox (or it is a link)'); }
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
    if (sha256 !== undefined && hash.digest('hex') !== sha256) no('the bundle\'s bytes are not the ones the intake recorded');
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
    const r = await git(['ls-tree', '-z', tree], { gitDir: mirror, purpose: 'push-research-tree' });
    if (r.code !== 0) no('could not read main\'s files');
    rows.push(...r.stdout.toString('latin1').split('\0').filter(Boolean));
  }
  const have = rows.find((row) => row.slice(row.indexOf('\t') + 1) === name);
  const [, type, id] = have?.split(/[ \t]/) ?? [];
  if (have && (type === 'tree') !== (rest.length > 0)) no(`main has ${name} as ${type === 'tree' ? 'a folder' : 'a file'}, so the report can't go there`);
  const entry = rest.length ? `040000 tree ${await treeWith(mirror, id ?? null, rest, blob)}\t${name}` : `100644 blob ${blob}\t${name}`;
  const kept = rows.filter((row) => row !== have);
  const m = await git(['mktree', '-z'], { gitDir: mirror, purpose: 'push-research-tree', input: Buffer.from(`${[...kept, entry].join('\0')}\0`, 'latin1') });
  if (m.code !== 0) no('could not build the copy\'s files');
  return m.stdout.toString().trim();
}

/** The copy's one commit on main, held at `holding`: the report's bytes exactly as they are, at the card's one path. */
async function commitReport(mirror, { path, blob, ask }, bytes, holding) {
  const made = await git(['hash-object', '-w', '--stdin', '--no-filters'], { gitDir: mirror, purpose: 'push-research-blob', input: bytes });
  if (made.code !== 0) no('could not store the report');
  if (made.stdout.toString().trim() !== blob) no(REPORT_CHANGED);
  const main = (await gitOk(['rev-parse', '--verify', 'refs/heads/main^{commit}'], { gitDir: mirror, purpose: 'push-research-commit' })).trim();
  const was = (await gitOk(['rev-parse', '--verify', 'refs/heads/main^{tree}'], { gitDir: mirror, purpose: 'push-research-commit' })).trim();
  const tree = await treeWith(mirror, was, path.split('/'), blob);
  if (tree === was) no(`main already holds these bytes at ${path}`);
  const tip = (await gitOk(['commit-tree', tree, '-p', main, '-m', `Copy research ask ${ask}'s report to ${path}`], { gitDir: mirror, purpose: 'push-research-commit' })).trim();
  await gitOk(['update-ref', holding, tip], { gitDir: mirror, purpose: 'push-research-commit' });
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
async function newCommits(mirror, tip, exclude) {
  const out = await gitOk(['rev-list', '--parents', tip, '--not', ...exclude], { gitDir: mirror, purpose: 'push-new-commits' });
  return out.trim().split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split(' '); return [s, p]; });
}

async function changes(mirror, args) {
  const r = await git(['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', ...args], { gitDir: mirror, purpose: 'push-paths' });
  if (r.code !== 0) no('could not list a commit\'s changes');
  return parseRawZ(r.stdout);
}

async function addedAllowComment(mirror, sha) {
  const r = await git(['diff-tree', '-p', '-r', '--text', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--no-color', sha], { gitDir: mirror, purpose: 'push-allow-lines' });
  if (r.code !== 0) no('could not read a commit\'s changes');
  return r.stdout.toString('utf8').split('\n').some((l) => l.startsWith('+') && /gitleaks:allow/i.test(l));
}

// Each commit's whole object (author, committer and every other header line, then the message;
// R-0b-47 round 2 MAT-B) and the names of the files it touches, for the stdin scan.
async function messages(mirror, shas, names) {
  const res = [];
  for (const sha of shas) {
    const r = await git(['cat-file', 'commit', sha], { gitDir: mirror, purpose: 'push-messages' });
    if (r.code !== 0) no(`could not read commit ${sha.slice(0, 12)}`);
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
 *   pullRequests.upsert({ repo, branch, base, title, body, token })   opens or updates the PR
 *   testRemote(repo)        tests only: a local bare repo standing in for GitHub. Production
 *                           never passes it, so every address is https://github.com/<repo>.git.
 *   afterStage()            tests only: runs right after the private copy is taken, so a test can
 *                           swap the outbox bundle at the earliest moment (review R-0b-47 MAT-4).
 *   uids.worker             the Mac user a worker's bundle must be owned by (`orchestrate`, L65)
 *   ownerUid                Joe's Mac user: a proposals bundle, and its folder, must be owned by it (L77 m2)
 *   fstat(fd)               tests only: stands in for fstatSync on the bundle's handle, so a test can make a bundle
 *                           look owned by another user (tests can't chown).
 */
export function createPushScript(deps) {
  const { record, rules, privateDir, scanner, getRobotToken, readRun, workflowRule, issues, pullRequests, gateCache = {}, testRemote, afterStage, bundleCap = BUNDLE_CAP, now = () => Date.now(), uids, ownerUid, fstat } = deps;
  // Checked once, here: a push script that can't tell a worker's bundle from Joe's is never made.
  if (!isUid(uids?.worker)) throw new Error('createPushScript: uids.worker must be a Mac user id');
  if (!isUid(ownerUid)) throw new Error('createPushScript: ownerUid must be a Mac user id');
  if (uids.worker === ownerUid) throw new Error('createPushScript: the worker user and the owner must be different users');

  /** A worker's inputs, from the session record only (step 1). */
  function workerInputs(sessionId) {
    const s = record.read('session', sessionId)?.doc;
    if (!s || typeof s !== 'object') no('no launch record for this session');
    const { product, card, branch, outbox, attempt: att } = s;
    if (typeof product !== 'string' || !product) no('the launch record names no product');
    if (!CARD.test(String(card))) no('the launch record has a bad card id');
    if (!ATTEMPT.test(String(att))) no('the launch record has a bad attempt id');
    if (typeof outbox !== 'string' || !isAbsolute(outbox)) no('the launch record has no outbox');
    return { product, card, branch, folder: outbox, uid: uids.worker, att };
  }

  /** A proposal's inputs: the caller names product, card and the sha256 the intake recorded; the rest is the rules'. */
  function proposalInputs({ product, card, sha256 } = {}) {
    if (typeof product !== 'string' || !product) no('the proposal names no product');
    if (!CARD.test(String(card))) no('the proposal has a bad card id');
    if (!SHA256.test(String(sha256))) no('the proposal has no sha256 of the bundle the intake recorded');
    // Fail closed here too, not only at the intake (L274 (2), L334): a proposal for a card the Record lacks is refused.
    if (!record.read('card', card)?.doc) no(`card ${card} is not in the Record`);
    const folder = rules.get('proposals.outbox', { product });
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.split('/').includes('..')) no('the product has no proposals folder in the rules');
    return { product, card, branch: `card/${card.toLowerCase()}`, folder, uid: ownerUid, folderUid: ownerUid, att: `p-${sha256.slice(0, 12)}`, sha256 };
  }

  /** A research copy's attempt id: new bytes are a new attempt. Null for a card with no readable sha256. */
  function researchAttempt(card) {
    const sha = record.read('card', card)?.doc?.source?.sha256;
    return SHA256.test(String(sha)) ? `r-${sha.slice(0, 12)}` : null;
  }

  /** A research copy's inputs: the card alone says what is copied, and only a ready research_copy card is. */
  function researchInputs({ product, card } = {}) {
    if (typeof product !== 'string' || !product) no('the research copy names no product');
    if (!CARD.test(String(card))) no('the research copy has a bad card id');
    const c = record.read('card', card);
    if (c?.corrupt || !c?.doc) no(`card ${card} is not in the Record`);
    const d = c.doc;
    if (d.kind !== 'research_copy') no(`card ${card} is not a research_copy card`);
    if (d.product !== product) no(`card ${card} is another product's`);
    if (d.state !== 'ready') no(`card ${card} is ${d.state}, not ready`);
    const ask = d.research_ask;
    const { file, sha256, blob, size } = d.source ?? {};
    if (typeof ask !== 'string' || file !== researchFileName(ask) || !Array.isArray(d.files) || d.files.length !== 1 || d.files[0] !== researchPath(ask)) no(`card ${card} does not name its ask's one file`);
    if (!SHA256.test(String(sha256)) || !SHA.test(String(blob)) || !Number.isSafeInteger(size) || size <= 0) no(`card ${card} has no proof of the report's bytes`);
    const folder = rules.get('proposals.outbox', { product });
    if (typeof folder !== 'string' || !isAbsolute(folder) || folder.split('/').includes('..')) no('the product has no proposals folder in the rules');
    return { product, card, branch: `card/${card.toLowerCase()}`, folder, uid: ownerUid, folderUid: ownerUid, att: researchAttempt(card), research: { ask, file, sha256, blob, size, path: d.files[0] } };
  }

  async function attempt({ product, card, branch, folder, uid, folderUid, att, sha256, research }, { look = false } = {}) {
    if (!BRANCH.test(String(branch)) || branch !== `card/${card.toLowerCase()}`) no(`the branch "${branch}" is not the card's branch`);

    const repo = rules.get('product.repo', { product });
    const mirror = rules.get('product.mirror', { product });
    const base = rules.get('product.default_branch', { product }) ?? 'main';
    if (rules.get('product.onboarded', { product }) !== true) no('the product is not onboarded yet (its entry is not on main)');
    if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..')) no('the product has no valid GitHub repo in the rules');
    if (typeof mirror !== 'string' || !isAbsolute(mirror)) no('the product has no mirror in the rules');
    if ([...NEVER, base].includes(branch) || branch.startsWith('orchestrate/')) no(`the branch "${branch}" may never be pushed`);
    const fmt = await git(['check-ref-format', '--branch', branch], { gitDir: mirror, purpose: 'push-branch-name' });
    if (fmt.code === -1 && fmt.stderr.startsWith('safe-git: refused: ')) no(`mirror: ${fmt.stderr.slice('safe-git: refused: '.length)}`);
    if (fmt.code !== 0) no(`the branch "${branch}" is not a valid name`);

    const url = testRemote ? testRemote(repo) : githubUrl(repo);
    if (!testRemote && !url.startsWith('https://github.com/')) no('the push address is not on github.com');
    if (testRemote && (typeof url !== 'string' || !isAbsolute(url))) no('the test remote is not a local folder');

    const v = await checkGitVersion();
    if (!v.ok) no(v.reason);
    const m = checkMirror(mirror);
    if (!m.ok) no(`mirror: ${m.reason}`);

    let token;
    try { token = await getRobotToken(product); } catch { token = null; }
    if (typeof token !== 'string' || !token) no('no robot key for this product');
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
      const lr = await git(['ls-remote', '--heads', url, `refs/heads/${branch}`], { gitDir: mirror, purpose: 'push-ls-remote', ...auth });
      if (lr.code !== 0) no('could not read GitHub');
      const remoteTip = /^([0-9a-f]{40})\t/.exec(lr.stdout.toString())?.[1] ?? null;
      const specs = ['+refs/heads/main:refs/heads/main'];
      if (remoteTip) specs.push(`+refs/heads/${branch}:${remoteRef}`);
      const fm = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', url, ...specs], { gitDir: mirror, purpose: 'push-fetch-main', ...auth });
      if (fm.code !== 0) no('could not fetch main from GitHub');
      if (!remoteTip) await git(['update-ref', '-d', remoteRef], { gitDir: mirror, purpose: 'push-fetch-main' });

      if (research) {
        // A branch already on GitHub is checked below as this push; pushing the same commit again changes nothing.
        tip = remoteTip ?? await commitReport(mirror, research, report, holding);
      } else {
        const bv = await git(['bundle', 'verify', '-q', copy], { gitDir: mirror, purpose: 'push-bundle-verify' });
        if (bv.code !== 0) no('the bundle does not verify against the mirror (a missing earlier commit?)');
        const fb = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', copy, `refs/heads/${branch}:${holding}`], { gitDir: mirror, purpose: 'push-fetch-bundle' });
        if (fb.code !== 0) no('could not take the bundle in');
        const got = (await gitOk(['rev-parse', '--verify', `${holding}^{commit}`], { gitDir: mirror, purpose: 'push-fetch-bundle' })).trim();
        if (got !== tip) no('the bundle\'s branch is not the commit its header names');
      }

      // 4. New commits and the paths they touch.
      if (remoteTip) {
        const ff = await git(['merge-base', '--is-ancestor', remoteTip, tip], { gitDir: mirror, purpose: 'push-fast-forward' });
        if (ff.code !== 0) no('the branch on GitHub has moved; the fix round must start from it (never a force push)');
      }
      // A research copy's commits are always counted from main: a branch already on GitHub is checked whole.
      const commits = await newCommits(mirror, tip, ['refs/heads/main', ...(remoteTip && !research ? [remoteRef] : [])]);
      if (!commits.length) no('the bundle holds no new commits');
      if (research && commits.length !== 1) no('the card\'s branch on GitHub holds more than the one copy commit');
      const why = [];
      const blobs = new Map(); // every added or changed file under each of its names, for the raw-bytes scan
      const names = new Map(); // the file names each commit touches, for the stdin scan
      for (const [sha, parents] of commits) {
        if (parents.length === 0) no(`commit ${sha.slice(0, 12)} is a first commit`);
        if (parents.length > 1) no(`commit ${sha.slice(0, 12)} is a merge; a worker never merges`);
        const ch = await changes(mirror, [sha]);
        why.push(...refusedEntries(ch));
        names.set(sha, ch.map((e) => e.path));
        for (const e of ch) if (e.status !== 'D' && /^1(00644|00755|20000)$/.test(e.newMode)) blobs.set(`${e.newId} ${e.path}`, { id: e.newId, path: e.path });
      }
      const mb = (await gitOk(['merge-base', 'refs/heads/main', tip], { gitDir: mirror, purpose: 'push-paths' })).trim();
      const net = await changes(mirror, [mb, tip]);
      why.push(...refusedEntries(net));
      if (why.length) no(`the branch touches files no card may: ${[...new Set(why)].slice(0, 5).join('; ')}`);
      if (research && (net.length !== 1 || net[0].path !== research.path || net[0].newId !== research.blob || net[0].newMode !== '100644')) no('the branch is not exactly the report at its one path');
      const files = net.map((e) => ({ path: e.path, status: CHANGE_STATUS[e.status] ?? `unknown (${e.status})` }));
      // A look stops here: the net change, checked against the refusal list, and nothing asked or pushed.
      if (look) return { ok: true, product, card, branch, tip, files };

      // 5. The secret scan.
      const shas = commits.map(([s]) => s);
      for (const sha of shas) if (await addedAllowComment(mirror, sha)) no(`commit ${sha.slice(0, 12)} adds a "gitleaks:allow" comment`);
      const scan = await scanSecrets({ setup: scanner, mirror, shas, blobs: [...blobs.values()], messages: await messages(mirror, shas, names), privateDir: work, allowedBinaries: allowList(rules.get('product.allowed_binaries', { product })) });
      if (!scan.ok) no(scan.reason);

      // 6. The rules, then the start gate. M10's push_branch reads the card as { id, kind, rows, doc: { lane } } and each
      // file as { path, status } (shared/README.md). Asked with the card's id and bare names, the real engine refused
      // every push (L81 sweep). A change letter M10 has no word for stays unknown, so the push is refused.
      const cardDoc = record.read('card', card)?.doc ?? {};
      const subject = { product, card: { id: card, kind: cardDoc.kind, rows: Array.isArray(cardDoc.rows) ? cardDoc.rows : [], doc: { lane: cardDoc.lane } }, files };
      // An exact reverse names the reversed commit's files (the card's own list, which M11 took from that commit); M10 lets
      // such a push through only when every changed file is in it, and the merge still checks the reverse on GitHub.
      if (cardDoc.kind === 'exact_reverse' && Array.isArray(cardDoc.files)) subject.reverses_files = cardDoc.files;
      const d = rules.may('push_branch', subject);
      if (d.decision !== 'allow') no(`the rules do not allow this push: ${d.reason}`);
      const gate = await startGate({ product, mirror, record, readRun, workflowPath: rules.get('outside_check.workflow', { product }), workflowRule, vercelProject: rules.get('product.vercel_project', { product }), cache: gateCache, issues, now: now() });
      if (!gate.ok) no(`the start gate is shut: ${gate.reason}`);

      // 7. The push: exactly this commit, exactly this branch, never forced.
      const p = await git(['push', '--porcelain', '--atomic', '--no-verify', url, `${tip}:refs/heads/${branch}`], { gitDir: mirror, purpose: 'push', ...auth });
      if (p.code !== 0) no('GitHub refused the push');
      const card_doc = cardDoc;
      let pr;
      try { pr = await pullRequests.upsert({ repo, branch, base, title: String(card_doc.what ?? card), body: String(card_doc.summary ?? ''), token }); } catch { pr = null; }
      await gitOk(['update-ref', `refs/heads/${branch}`, tip], { gitDir: mirror, purpose: 'push-mirror-branch' });
      return { ok: true, product, card, branch, tip, commits: shas.length, pr: pr ?? null, binaries: scan.binaries };
    } finally {
      await git(['update-ref', '-d', holding], { gitDir: mirror, purpose: 'push-cleanup' });
      rmSync(work, { recursive: true, force: true });
    }
  }

  // Runs one door. Never throws: { ok, ... } or { ok: false, reason }. A push or a refusal writes one fact,
  // `push.<card>.<attempt>`; a look writes nothing (the intake records what it decides).
  async function settle(inputs, factParts, { look = false, from } = {}) {
    let res;
    try { res = await attempt(inputs(), { look }); } catch (e) { res = { ok: false, reason: e instanceof Refusal ? e.message : `the push script failed: ${String(e.message).replace(/\/[^\s'":]+/g, '<path>').slice(0, 200)}` }; }
    // Every reason is masked once, here, before the record: a secret used as a file name is cut to
    // its first four characters, and git's own error text loses its folder paths (round 3 MIN-3, COS-4).
    if (!res.ok) res = { ...res, reason: maskPath(res.reason) };
    if (look) return res;
    const [card, att] = factParts();
    // Only real text names a fact: String(undefined) or String(null) would pass the id patterns as "undefined" / "null".
    const id = `push.${typeof card === 'string' && CARD.test(card) ? card : 'unknown'}.${typeof att === 'string' && ATTEMPT.test(att) ? att : 'unknown'}`;
    const cur = record.read('fact', id);
    let doc = res.ok ? { result: 'pushed', branch: res.branch, tip: res.tip, binaries: res.binaries ?? [], at: new Date(now()).toISOString() } : { result: 'refused', reason: res.reason, at: new Date(now()).toISOString() };
    // A refusal never erases a recorded push of the same attempt (#170 r1): it is added to it as the last refusal.
    if (!res.ok && cur?.doc?.result === 'pushed' && !cur.corrupt) doc = { ...cur.doc, last_refusal: { reason: res.reason, at: doc.at } };
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
   * Pushes one proposal's bundle from the product's proposals folder ({ product, card, sha256 }), or with
   * `{ look: true }` answers { ok, files } for its net change without asking the rules or pushing.
   */
  async function pushProposal(p = {}, { look = false } = {}) {
    const sha = SHA256.test(String(p?.sha256)) ? p.sha256 : null;
    // The same bytes are the same attempt (L274 (6), L334): once pushed, they answer the recorded push, with no
    // second push and the fact left as it is. Only after the proposal's own checks pass (the card still in the Record,
    // the product's folder), and only for the product the fact recorded; a corrupt fact is not a push (#170 r1 m1, m2).
    if (!look && sha) {
      let inputs = null;
      // Any throw here (a refusal, or a rules or Record read that fails, the push fact's too) falls through to settle, which meets the same
      // error and records it the usual way, masked (#170 r2).
      let done = null;
      try {
        inputs = proposalInputs(p);
        const f = record.read('fact', `push.${inputs.card}.${inputs.att}`);
        done = f?.doc && !f.corrupt ? f.doc : null;
      } catch { done = null; }
      if (done?.result === 'pushed' && done.product === inputs.product) return { ok: true, already: true, product: inputs.product, card: inputs.card, branch: done.branch, tip: done.tip, binaries: done.binaries ?? [] };
    }
    return settle(() => proposalInputs(p), () => [p?.card, sha ? `p-${sha.slice(0, 12)}` : null], { look, from: 'proposal' });
  }

  /** Makes and pushes a ready research_copy card's one commit ({ product, card }). Bytes already pushed answer that push. */
  async function pushResearch(p = {}) {
    let inputs = null;
    let done = null;
    // Any throw here falls through to settle, which meets the same error and records it, masked (as pushProposal).
    try {
      inputs = researchInputs(p);
      const f = record.read('fact', `push.${inputs.card}.${inputs.att}`);
      done = f?.doc && !f.corrupt ? f.doc : null;
    } catch { done = null; }
    if (done?.result === 'pushed' && done.product === inputs.product) return { ok: true, already: true, product: inputs.product, card: inputs.card, branch: done.branch, tip: done.tip, binaries: done.binaries ?? [] };
    return settle(() => researchInputs(p), () => { let a = null; try { a = researchAttempt(p?.card); } catch { a = null; } return [p?.card, a]; }, { from: 'research' });
  }

  // The function itself stays the worker's door, so every caller of createPushScript(deps)(sessionId) is unchanged.
  return Object.assign(pushCard, { pushCard, pushProposal, pushResearch });
}
