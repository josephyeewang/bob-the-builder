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

import { lstatSync, openSync, fstatSync, readSync, writeSync, closeSync, mkdtempSync, rmSync, constants as C } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { git, gitOk, checkMirror, checkGitVersion } from './safe-git.mjs';
import { parseRawZ, refusedEntries } from './push-refusals.mjs';
import { scanSecrets } from './gitleaks.mjs';
import { allowList, maskPath } from './binary-files.mjs';
import { startGate } from './start-gate.mjs';

export const BUNDLE_CAP = 200 * 1024 * 1024;
export const BRANCH = /^card\/[a-z0-9][a-z0-9-]{0,63}$/;
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const NEVER = ['main', 'master', 'jobs-approved'];

class Refusal extends Error {}
const no = (reason) => { throw new Refusal(reason); };

export const githubUrl = (repo) => `https://github.com/${repo}.git`;
export const bundleName = (card) => `bundle-${card}.bundle`;
const tokenConfig = (token) => [['http.https://github.com/.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]];

/** Copies the bundle, never following a link, into `dir`; returns the copy's path. */
function stageBundle(outbox, card, dir, cap) {
  let ost; try { ost = lstatSync(outbox); } catch { no('the outbox is missing'); }
  if (ost.isSymbolicLink() || !ost.isDirectory()) no('the outbox is not a plain folder');
  let fd;
  try { fd = openSync(join(outbox, bundleName(card)), C.O_RDONLY | C.O_NOFOLLOW | (C.O_NONBLOCK ?? 0)); } catch { no('no bundle in the outbox (or it is a link)'); }
  const copy = join(dir, 'card.bundle');
  let out;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) no('the bundle is not a plain file');
    if (st.nlink !== 1) no('the bundle has more than one link');
    // A fast first refusal; the copy loop's own count below is the one that holds if the file grows.
    if (st.size > cap) no(`the bundle is larger than ${cap} bytes`);
    out = openSync(copy, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
    const buf = Buffer.alloc(1 << 20);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      total += n;
      if (total > cap) no(`the bundle is larger than ${cap} bytes`);
      writeSync(out, buf, 0, n);
    }
  } finally { closeSync(fd); if (out !== undefined) closeSync(out); }
  return copy;
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
 */
export function createPushScript(deps) {
  const { record, rules, privateDir, scanner, getRobotToken, readRun, workflowRule, issues, pullRequests, gateCache = {}, testRemote, afterStage, bundleCap = BUNDLE_CAP, now = () => Date.now() } = deps;

  async function attempt(sessionId) {
    const s = record.read('session', sessionId)?.doc;
    if (!s || typeof s !== 'object') no('no launch record for this session');
    const { product, card, branch, outbox, attempt: att } = s;
    if (typeof product !== 'string' || !product) no('the launch record names no product');
    if (!CARD.test(String(card))) no('the launch record has a bad card id');
    if (!ATTEMPT.test(String(att))) no('the launch record has a bad attempt id');
    if (typeof outbox !== 'string' || !isAbsolute(outbox)) no('the launch record has no outbox');
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
    const auth = { extraConfig: tokenConfig(token) };

    const work = mkdtempSync(join(privateDir, 'push-'));
    const holding = `refs/orchestrate/incoming/${card}/${att}`;
    const remoteRef = `refs/orchestrate/remote/${branch}`;
    try {
      // 2. The private copy, its header and its check against the mirror.
      const copy = stageBundle(outbox, card, work, bundleCap);
      await afterStage?.();
      const tip = readBundleHeader(copy, branch);

      // 3. Main (and the card branch) fresh from GitHub, then the bundle into the holding ref.
      const lr = await git(['ls-remote', '--heads', url, `refs/heads/${branch}`], { gitDir: mirror, purpose: 'push-ls-remote', ...auth });
      if (lr.code !== 0) no('could not read GitHub');
      const remoteTip = /^([0-9a-f]{40})\t/.exec(lr.stdout.toString())?.[1] ?? null;
      const specs = ['+refs/heads/main:refs/heads/main'];
      if (remoteTip) specs.push(`+refs/heads/${branch}:${remoteRef}`);
      const fm = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', url, ...specs], { gitDir: mirror, purpose: 'push-fetch-main', ...auth });
      if (fm.code !== 0) no('could not fetch main from GitHub');
      if (!remoteTip) await git(['update-ref', '-d', remoteRef], { gitDir: mirror, purpose: 'push-fetch-main' });

      const bv = await git(['bundle', 'verify', '-q', copy], { gitDir: mirror, purpose: 'push-bundle-verify' });
      if (bv.code !== 0) no('the bundle does not verify against the mirror (a missing earlier commit?)');
      const fb = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', copy, `refs/heads/${branch}:${holding}`], { gitDir: mirror, purpose: 'push-fetch-bundle' });
      if (fb.code !== 0) no('could not take the bundle in');
      const got = (await gitOk(['rev-parse', '--verify', `${holding}^{commit}`], { gitDir: mirror, purpose: 'push-fetch-bundle' })).trim();
      if (got !== tip) no('the bundle\'s branch is not the commit its header names');

      // 4. New commits and the paths they touch.
      if (remoteTip) {
        const ff = await git(['merge-base', '--is-ancestor', remoteTip, tip], { gitDir: mirror, purpose: 'push-fast-forward' });
        if (ff.code !== 0) no('the branch on GitHub has moved; the fix round must start from it (never a force push)');
      }
      const commits = await newCommits(mirror, tip, ['refs/heads/main', ...(remoteTip ? [remoteRef] : [])]);
      if (!commits.length) no('the bundle holds no new commits');
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

      // 5. The secret scan.
      const shas = commits.map(([s]) => s);
      for (const sha of shas) if (await addedAllowComment(mirror, sha)) no(`commit ${sha.slice(0, 12)} adds a "gitleaks:allow" comment`);
      const scan = await scanSecrets({ setup: scanner, mirror, shas, blobs: [...blobs.values()], messages: await messages(mirror, shas, names), privateDir: work, allowedBinaries: allowList(rules.get('product.allowed_binaries', { product })) });
      if (!scan.ok) no(scan.reason);

      // 6. The rules, then the start gate.
      const files = [...new Set(net.map((e) => e.path))];
      const d = rules.may('push_branch', { product, card, files });
      if (d.decision !== 'allow') no(`the rules do not allow this push: ${d.reason}`);
      const gate = await startGate({ product, mirror, record, readRun, workflowPath: rules.get('outside_check.workflow', { product }), workflowRule, vercelProject: rules.get('product.vercel_project', { product }), cache: gateCache, issues, now: now() });
      if (!gate.ok) no(`the start gate is shut: ${gate.reason}`);

      // 7. The push: exactly this commit, exactly this branch, never forced.
      const p = await git(['push', '--porcelain', '--atomic', '--no-verify', url, `${tip}:refs/heads/${branch}`], { gitDir: mirror, purpose: 'push', ...auth });
      if (p.code !== 0) no('GitHub refused the push');
      const card_doc = record.read('card', card)?.doc ?? {};
      let pr;
      try { pr = await pullRequests.upsert({ repo, branch, base, title: String(card_doc.title ?? card), body: String(card_doc.summary ?? ''), token }); } catch { pr = null; }
      await gitOk(['update-ref', `refs/heads/${branch}`, tip], { gitDir: mirror, purpose: 'push-mirror-branch' });
      return { ok: true, product, card, branch, tip, commits: shas.length, pr: pr ?? null, binaries: scan.binaries };
    } finally {
      await git(['update-ref', '-d', holding], { gitDir: mirror, purpose: 'push-cleanup' });
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Pushes one session's bundle. Never throws: { ok, ... } or { ok: false, reason }. */
  return async function pushCard(sessionId) {
    let res;
    try { res = await attempt(sessionId); } catch (e) { res = { ok: false, reason: e instanceof Refusal ? e.message : `the push script failed: ${String(e.message).replace(/\/[^\s'":]+/g, '<path>').slice(0, 200)}` }; }
    // Every reason is masked once, here, before the record: a secret used as a file name is cut to
    // its first four characters, and git's own error text loses its folder paths (round 3 MIN-3, COS-4).
    if (!res.ok) res = { ...res, reason: maskPath(res.reason) };
    const s = record.read('session', sessionId)?.doc ?? {};
    const id = `push.${CARD.test(String(s.card)) ? s.card : 'unknown'}.${ATTEMPT.test(String(s.attempt)) ? s.attempt : 'unknown'}`;
    const cur = record.read('fact', id);
    const doc = res.ok ? { result: 'pushed', branch: res.branch, tip: res.tip, binaries: res.binaries ?? [], at: new Date(now()).toISOString() } : { result: 'refused', reason: res.reason, at: new Date(now()).toISOString() };
    record.write({ actor: 'workshop', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc, kind: res.ok ? 'push' : 'push_refused' });
    return res;
  };
}
