#!/usr/bin/env node
// The updater (L66, last bullet; item 19; L73): a LaunchDaemon that runs as root every 10 minutes and keeps the
// installed copy (`installRoot`, install-check.mjs) at `main`. `node review-updater.mjs <updater.json> [--first <seed>]`.
//
// What it does, and nothing else:
//   1. checks that every folder it will write in (the copy's and the clone's) and every folder above them is root's
//      alone, and that the copy whose own items it carries over (or the install step's seed) is root's alone, before it
//      writes, renames or removes anything (L73 M1);
//   2. removes what a cut-off run left beside the copy: any versioned folder or link the copy's link does not name,
//      except the copy the last update replaced (`PREVIOUS`), and a clone that was never finished. It never puts one of
//      them in place;
//   3. fetches `main` (and only main, by its full name) from the repository's https address into its own bare clone,
//      through safe-git (no hooks, no repository config, no other place), with a git only root can change (`gitBin`,
//      and on a Mac the developer folder /usr/bin/git hands over to, with its helpers: `gitToolsProblem`), a PATH only
//      root can write (ROOT_PATH) and a home folder of root's beside the clone (`gitHome`), never /tmp;
//   4. when main's commit differs from the stamp, writes the files under `orchestrate/` at that commit into a new
//      versioned folder beside the copy (`<installRoot>.v-<commit>/orchestrate`), and the few files outside it that the
//      code imports (install-check.mjs OUTSIDE_FILES) at their repository paths in the same folder (L92 item 4), straight
//      from git's objects: no checkout, no work tree; copies in the copy's own items that are not in the repository
//      (`keep`: its node, its configs, the wiring, the claude program) from the copy in place, then writes the commit
//      stamp last, at the top of the versioned folder;
//   5. checks the new folder is root's alone (`installProblem`) and holds what the runner's config names in the copy
//      (its wiring, the claude program, the hooks), then flips the copy's link to its `orchestrate/` with one rename. The folder it
//      replaced is kept through one more update (`PREVIOUS`, L75 (a)): a review session started on it names its node
//      and hooks by that folder's real path, and keeps them while it runs; every older one is removed;
//   6. notes, in root's own record beside the copy, when it first saw main ahead of the copy (install-check.mjs
//      `mainSeenFile`), for the Dispatcher's stamp alert.
// As the updater, root runs only its own small module set, from main: this file, install-check.mjs and safe-git.mjs,
// which import nothing but Node's own modules (the test checks; root's one other script, the account copy, is
// accounts.mjs with install-check.mjs). It runs nothing from the repository it copies: only git and
// file copies. The rename that flips the link is atomic, so installRoot names a whole copy at every moment and the
// LaunchDaemons always find their node and scripts (L73 point 1).
//
// The wall is `main` itself: only the Merge Gate or Joe changes it. A branch, a tag or the remote's HEAD is never read.
// Two updaters never run at once: launchd starts a job only when its last run has ended, and the install step runs
// before the job is loaded.
//
// updater.json (root's, inside the copy, one of `keep`):
//   { "installRoot": "/abs", "clone": "/abs", "address": "https://github.com/<owner>/<repo>.git",
//     "keep": ["bin", "updater.json", "review.json", ...], "gitBin": "/abs/git" }
// Exit 0 when the copy is at main (updated or already there), 1 when it refused or could not run.

import { closeSync, constants, copyFileSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, checkMirror, useGitHome, MIRROR_CONFIG_TEMPLATE, ROOT_PATH } from '../git/safe-git.mjs';
import { SOURCE, OUTSIDE_FILES, STAMP, NODE, UPDATER_CONFIG, RUNNER_CONFIG, installStamp, installProblem, chainProblem, aclProblem, currentCopy, readInstallStamp,
  versionName, versionCommit, mainSeenFile, readMainSeen, nextMainSeen } from './install-check.mjs';

export const MAIN = 'refs/heads/main';
export { SOURCE, OUTSIDE_FILES };
// What `keep` must hold, or the first update would drop it: the copy's node, the updater's config, the runner's config.
export const MUST_KEEP = Object.freeze({ [dirname(NODE)]: 'the copy\'s own node', [UPDATER_CONFIG]: 'the updater\'s config', [RUNNER_CONFIG]: 'the review runner\'s config' });
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/;
const FILE_MODES = { 100644: 0o644, 100755: 0o755 };
const GIT_MS = 300_000;
// The runner's config keys that name something in the copy the repository does not hold (L75 m-4): `keep` must carry
// each over, or the first update would drop it. Checked in the new copy before the flip.
export const RUNNER_NAMES = Object.freeze(['wiring', 'claudeBin', 'hooksDir']);
// The link naming the copy the last update replaced (L75 (a)), `<installRoot>.prev`, root's, beside the copy. Only
// root writes in that folder, so it is root's doing. It only keeps that folder from being removed; nothing is ever put
// in place from it.
export const PREVIOUS = '.prev';
// The clone is made under `<clone>.new-<pid>`, finished with this file in it, then renamed in (L75 m-1): a clone
// without it was cut off while being made, and is made again.
export const CLONE_MADE = 'orch-clone-made';

const refuse = (reason) => ({ ok: false, reason });
const there = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/**
 * The config, checked. `localAddress` lets a test fetch from a local folder standing in for GitHub; it is an option of
 * the call, which the real run never passes, so no key in the file can turn it on (L73 point 3).
 */
export function readUpdaterConfig(file, { localAddress = false } = {}) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  // In its plain form (L75 c-3): no `.`, `..`, doubled or trailing `/`, so a name can't stand for another.
  for (const k of ['installRoot', 'clone', 'gitBin']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k]) || resolve(c[k]) !== c[k] || c[k].includes('..') || c[k] === '/') throw new Error(`config: ${k} must be an absolute path in its plain form`);
  if (!addressOk(c.address, localAddress)) throw new Error('config: address must be an https address');
  if (!Array.isArray(c.keep) || c.keep.some((n) => typeof n !== 'string' || !NAME.test(n) || n === STAMP)) throw new Error('config: keep must list plain top-level names');
  for (const [n, what] of Object.entries(MUST_KEEP)) if (!c.keep.includes(n)) throw new Error(`config: keep must hold ${n} (${what})`);
  return c;
}
const addressOk = (a, localAddress) => typeof a === 'string' && (HTTPS.test(a) || (localAddress === true && isAbsolute(a)));

/** A path from the tree is written only if each of its parts is a plain name (no `.`, `..`, empty part or `.git`). */
function plainPath(p) {
  const parts = p.split('/');
  return parts.every((x) => x !== '' && x !== '.' && x !== '..' && x.toLowerCase() !== '.git' && !x.includes('\0'));
}

/** `git ls-tree -r -z` output → [{ mode, oid, path }], or a refusal for a link, a submodule or an odd path. */
export function parseTree(buf, { keep = [] } = {}) {
  const out = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (!m) return refuse(`an unreadable tree line: ${JSON.stringify(rec.slice(0, 80))}`);
    const [, mode, type, oid, path] = m;
    if (mode === '120000') return refuse(`${SOURCE}/${path} is a link`);
    if (mode === '160000' || type !== 'blob') return refuse(`${SOURCE}/${path} is a submodule`);
    if (!FILE_MODES[mode]) return refuse(`${SOURCE}/${path} has mode ${mode}`);
    if (!plainPath(path)) return refuse(`${SOURCE}/${JSON.stringify(path)} is not a plain path`);
    const top = path.split('/')[0];
    if (top === STAMP || keep.includes(top)) return refuse(`${SOURCE}/${top} has the name of one of the copy's own items`);
    out.push({ mode: FILE_MODES[mode], oid, path });
  }
  if (!out.length) return refuse(`main holds no ${SOURCE} folder`);
  return { ok: true, files: out };
}

/**
 * `git ls-tree -r -z --full-tree <commit> -- <OUTSIDE_FILES>` output → [{ mode, oid, path }] at repository paths, or a
 * refusal: each listed file must be on main once, as a plain file, and nothing else may come back (L92 item 4).
 */
export function parseOutside(buf, list = OUTSIDE_FILES) {
  const out = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (!m) return refuse(`an unreadable tree line: ${JSON.stringify(rec.slice(0, 80))}`);
    const [, mode, type, oid, path] = m;
    if (!list.includes(path) || out.some((x) => x.path === path)) return refuse(`git listed ${JSON.stringify(path.slice(0, 200))}, which is not one of the outside files`);
    if (mode === '120000') return refuse(`${path} is a link`);
    if (mode === '160000' || type !== 'blob') return refuse(`${path} is a submodule`);
    if (!FILE_MODES[mode]) return refuse(`${path} has mode ${mode}`);
    out.push({ mode: FILE_MODES[mode], oid, path });
  }
  const missing = list.filter((f) => !out.some((x) => x.path === f));
  if (missing.length) return refuse(`main has no ${missing.join(', ')}, which the copy's code imports`);
  return { ok: true, files: out };
}

// Each outside file sits at a plain repository path beside SOURCE, never in it or at the stamp's name (checked once,
// when this file loads, so a bad list stops every run).
for (const f of OUTSIDE_FILES) {
  if (!plainPath(f) || f.split('/')[0] === SOURCE || f === STAMP) throw new Error(`install-check OUTSIDE_FILES: ${f} is not a plain path outside ${SOURCE}`);
}

/** `git cat-file --batch` output → Map oid → Buffer, checking each answer is the blob that was asked for. */
export function parseBatch(buf, oids) {
  const got = new Map();
  let at = 0;
  for (const want of oids) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return refuse('git gave fewer objects than asked');
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(buf.subarray(at, nl).toString('utf8'));
    if (!m || m[1] !== want) return refuse(`git did not give blob ${want}`);
    const size = Number(m[2]);
    const end = nl + 1 + size;
    if (end + 1 > buf.length || buf[end] !== 0x0a) return refuse(`blob ${want} is cut short`);
    got.set(want, buf.subarray(nl + 1, end));
    at = end + 1;
  }
  if (at !== buf.length) return refuse('git gave more than was asked');
  return { ok: true, blobs: got };
}

/** A new file, never through a link and never over one that is there: O_EXCL | O_NOFOLLOW, then flushed to disk. */
export function writeNew(file, data, mode) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    fchmodSync(fd, mode);
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Copies one of the copy's own items (a file or a folder) from the copy in place, which `installProblem` has passed:
 * no links, no group or other write.
 */
function copyItem(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) throw new Error(`${from} is a link`);
  if (st.isDirectory()) {
    mkdirSync(to, { mode: 0o755 });
    for (const n of readdirSync(from).sort()) copyItem(join(from, n), join(to, n));
    return;
  }
  if (!st.isFile()) throw new Error(`${from} is not a plain file`);
  copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const fd = openSync(to, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, st.mode & 0o755); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * What a cut-off run can leave beside the copy, in name order: versioned folders (`<name>.v-<commit>`) and links
 * not yet flipped in (`<name>.link-<commit>`, `<name>.prev-<commit>`). Anything else there is not the updater's and is
 * left alone. `list` is a port, since a disk may list a folder in any order.
 */
export function leftovers(installRoot, { list = readdirSync } = {}) {
  const base = basename(installRoot);
  let names = [];
  try { names = list(dirname(installRoot)); } catch { return []; }
  const temp = (n) => [`${base}.link-`, `${base}${PREVIOUS}-`].some((pre) => n.startsWith(pre) && HEX40.test(n.slice(pre.length)));
  return names.filter((n) => versionCommit(installRoot, n) !== null || temp(n))
    .sort().map((n) => join(dirname(installRoot), n));
}

/**
 * The versioned folder `<installRoot>.prev` names (`<name>.v-<commit>/orchestrate`, as the copy's link does), or null.
 * The whole versioned folder is what is kept, and what is removed when it goes.
 */
export function previousCopy(installRoot) {
  const link = `${installRoot}${PREVIOUS}`;
  let to; try { if (!lstatSync(link).isSymbolicLink()) return null; to = readlinkSync(link); } catch { return null; }
  const parts = String(to).split('/');
  return parts.length === 2 && parts[1] === SOURCE && versionCommit(installRoot, parts[0]) !== null ? join(dirname(installRoot), parts[0]) : null;
}

/**
 * Removes every leftover except `current` (the folder the copy's link names) and the copy the last update replaced
 * (previousCopy). Nothing found here is ever put in place: the copy is only ever a folder this run made and checked
 * (L73 M1). → what was removed, for the log.
 */
export function clearLeftovers(installRoot, { current = null } = {}) {
  const done = [];
  const previous = previousCopy(installRoot);
  for (const d of leftovers(installRoot)) {
    if (d === current) continue;
    if (d === previous) continue;
    rmSync(d, { recursive: true, force: true });
    done.push(`removed ${basename(d)}`);
  }
  return done;
}

/**
 * A new bare clone in the mirror's shape (no hooks, the fixed config), made with root's git under `<clone>.new-<pid>`
 * and renamed in once it is whole, with CLONE_MADE in it (L75 m-1). A cut-off leaves only a `.new-` folder, which the
 * next run removes. No template folder: git copies nothing in from its own install.
 */
async function makeClone(clone, g, { write, step }) {
  const pre = `${basename(clone)}.new-`;
  for (const n of readdirSync(dirname(clone))) if (n.startsWith(pre)) rmSync(join(dirname(clone), n), { recursive: true, force: true });
  const tmp = `${clone}.new-${process.pid}`;
  const r = await git(['init', '--bare', '-q', '--template=', tmp], { ...g, gitDir: tmp, purpose: 'updater-init' });
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim().slice(0, 200)}`);
  step('clone-init');
  const cfg = join(tmp, 'config');
  rmSync(cfg);
  step('clone-config-removed');
  write(cfg, Buffer.from(MIRROR_CONFIG_TEMPLATE), 0o644);
  step('clone-config');
  rmSync(join(tmp, 'hooks'), { recursive: true, force: true });
  rmSync(join(tmp, 'description'), { force: true });
  step('clone-hooks');
  write(join(tmp, CLONE_MADE), Buffer.from('made whole by the updater\n'), 0o644);
  step('clone-marked');
  renameSync(tmp, clone);
}

/**
 * The lock files a git cut off part way leaves in the clone (`*.lock` at its top and under refs/): while one is there,
 * every fetch fails. → their paths.
 */
export function cloneLocks(clone) {
  const out = [];
  const look = (d, deep) => {
    let names = []; try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isFile() && n.endsWith('.lock')) out.push(p);
      else if (deep && st.isDirectory() && !st.isSymbolicLink()) look(p, true);
    }
  };
  look(clone, false);
  look(join(clone, 'refs'), true);
  return out.sort();
}

/**
 * Is any git running on this Mac (`ps`, as root sees every process)? A lock is removed only when none is (L75 m-1): a
 * git that is still running holds its lock rightly. A `ps` that fails counts as yes.
 */
export function gitIsRunning({ run = spawnSync } = {}) {
  const r = run('/bin/ps', ['-A', '-o', 'comm='], { encoding: 'utf8', env: { PATH: ROOT_PATH, LC_ALL: 'C' }, timeout: 10_000 });
  if (r.error || r.status !== 0) return true;
  return String(r.stdout).split('\n').some((l) => /^git(?:-|$)/.test(basename(l.trim())));
}

/**
 * Git's home folder for root (L75 c-6): `<clone>.home`, root's own (0700), in the clone's folder, whose chain was
 * checked. Made when missing. → null, or why it can't be used.
 */
export function gitHome(clone, { owner = 0 } = {}) {
  const dir = `${clone}.home`;
  try { lstatSync(dir); } catch { mkdirSync(dir, { mode: 0o700 }); }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return { problem: `${dir} is not a plain folder` };
  if (st.uid !== owner || st.mode & 0o077) return { problem: `${dir} is not root's own folder (0700)` };
  return { dir };
}

/**
 * On a Mac, /usr/bin/git only hands over to the git in the developer folder `xcode-select -p` names, which an admin can
 * point at an app folder they own (L75 m-3). That folder, its git and every helper in its libexec/git-core (where git
 * looks for its own programs) must be root's alone: each helper that is a link must lead inside the folder. Another
 * git is checked by its own chain alone. `run` and `platform` are ports for a test. → null, or the problem.
 */
export function gitToolsProblem(gitBin, { platform = process.platform, run = spawnSync, owner = 0, top = '/', realpath = realpathSync.native } = {}) {
  if (platform !== 'darwin' || gitBin !== '/usr/bin/git') return null;
  const r = run('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', env: { PATH: ROOT_PATH, LC_ALL: 'C' }, timeout: 10_000 });
  const named = String(r.stdout ?? '').trim();
  if (r.error || r.status !== 0 || !isAbsolute(named) || named.includes('\n')) return 'xcode-select names no developer folder';
  let dev; try { dev = realpath(named); } catch { return `the developer folder ${named} is missing`; }
  const devBad = chainProblem(dev, { owner, top });
  if (devBad) return `the developer folder: ${devBad}`;
  const gitBad = chainProblem(join(dev, 'usr', 'bin', 'git'), { owner, top });
  if (gitBad) return `the developer folder's git: ${gitBad}`;
  const core = join(dev, 'usr', 'libexec', 'git-core');
  const seen = [];
  const walk = (p) => {
    let st; try { st = lstatSync(p); } catch { return `${p} is missing`; }
    if (st.isSymbolicLink()) {
      let to; try { to = realpath(p); } catch { return `${p} leads nowhere`; }
      const rel = relative(dev, to);
      return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? `${p} leads outside the developer folder` : null;
    }
    if (st.uid !== owner) return `${p} is not owned by ${owner === 0 ? 'root' : `uid ${owner}`}`;
    if (st.mode & 0o022) return `${p} can be written by others than root`;
    seen.push(p);
    if (!st.isDirectory()) return null;
    for (const n of readdirSync(p)) { const bad = walk(join(p, n)); if (bad) return bad; }
    return null;
  };
  const coreBad = chainProblem(dirname(core), { owner, top }) ?? walk(core) ?? aclProblem(seen);
  return coreBad ? `git's helpers: ${coreBad}` : null;
}

/** Root's record of main, replaced whole: written beside it, then renamed over it. */
function writeMainSeen(installRoot, state, write) {
  const file = mainSeenFile(installRoot);
  const tmp = `${file}.new`;
  rmSync(tmp, { force: true });
  write(tmp, Buffer.from(`${JSON.stringify(state)}\n`), 0o644);
  renameSync(tmp, file);
}

/**
 * One update. `c` is the updater config. `first` is a seed folder holding the `keep` items, for the install step only
 * (when there is no copy yet). `owner` and `top` stand in for root and `/` in tests; `write` is the file writer and
 * `step` is told each step done (ports, so a test can stop a run at any point); `now` is the clock; `localAddress` as
 * for readUpdaterConfig. → { ok, changed, commit, recovered } or { ok: false, reason }.
 */
export async function updateOnce(c, { first = null, owner = 0, top = '/', write = writeNew, step = () => {}, now = Date.now, localAddress = false, rename = renameSync, gitRunning = gitIsRunning } = {}) {
  if (!addressOk(c.address, localAddress)) return refuse('the address must be an https address');
  // L73 M1: before root writes, renames or removes anything, every folder above where it does is root's alone.
  for (const [what, p] of [['the copy', dirname(c.installRoot)], ['the clone', dirname(c.clone)]]) {
    const bad = chainProblem(p, { owner, top });
    if (bad) return refuse(`the folder of ${what}: ${bad}`);
  }
  const cur = currentCopy(c.installRoot, { owner });
  if (first && !cur.missing) return refuse('there is already an installed copy; --first is only for the install step');
  if (!first && cur.missing) return refuse('there is no installed copy; run the install step');
  if (!first && cur.problem) return refuse(cur.problem);
  if (!first && !cur.link) return refuse(`${c.installRoot} is a plain folder, not the copy's link the updater flips; run the install step`);
  // What the copy's own items are copied from is checked before it is used: the copy in place, or the seed.
  const from = first ?? c.installRoot;
  const fromBad = installProblem(from, [], { owner, top });
  if (fromBad) return refuse(`${first ? 'the seed' : 'the installed copy'} is not root's alone: ${fromBad}`);
  const recovered = clearLeftovers(c.installRoot, { current: cur.folder ?? null });
  step('cleared');

  const home = gitHome(c.clone, { owner });
  if (home.problem) return refuse(`git's home: ${home.problem}`);
  useGitHome(home.dir);
  const g = { gitDir: c.clone, gitBin: c.gitBin, timeoutMs: GIT_MS, path: ROOT_PATH };
  // A clone that is there is root's alone before anything is done in it. One with no CLONE_MADE was cut off while being
  // made, or is from before it: made again (L75 m-1).
  if (there(c.clone)) {
    const was = chainProblem(c.clone, { owner, top });
    if (was) return refuse(`the clone: ${was}`);
    if (!there(join(c.clone, CLONE_MADE))) { rmSync(c.clone, { recursive: true, force: true }); recovered.push('removed a clone that was never finished'); }
  }
  if (!there(c.clone)) { await makeClone(c.clone, g, { write, step }); step('cloned'); }
  const chain = chainProblem(c.clone, { owner, top });
  if (chain) return refuse(`the clone: ${chain}`);
  const m = checkMirror(c.clone);
  if (!m.ok) return refuse(`the clone was refused: ${m.reason}`);
  // A git cut off part way (the fetch's time limit) leaves its lock, and every fetch after it fails. Removed only when no
  // git is running (L75 m-1).
  const locks = cloneLocks(c.clone);
  if (locks.length) {
    if (gitRunning()) return refuse(`the clone holds ${locks.map((x) => basename(x)).join(', ')} and a git is running; the next run tries again`);
    for (const x of locks) { rmSync(x, { force: true }); recovered.push(`removed ${relative(c.clone, x)} from the clone`); }
  }
  step('fetching');

  // Only main, by its full name, into main: never HEAD, a tag or another branch.
  const f = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', c.address, `+${MAIN}:${MAIN}`],
    { ...g, address: c.address, purpose: 'updater-fetch' });
  if (f.code !== 0) return refuse(`the fetch failed: ${f.stderr.trim().slice(0, 300)}`);
  const rp = await git(['rev-parse', '--verify', '-q', `${MAIN}^{commit}`], { ...g, purpose: 'updater-main' });
  const commit = rp.stdout.toString('utf8').trim();
  if (rp.code !== 0 || !HEX40.test(commit)) return refuse('main has no commit in the clone');

  const r = await swapIn(c, { commit, cur, from, first, owner, write, step, g, rename });
  // Root's record of main, after every fetch that worked, whatever the update did (item 20(c), L73 point 7(b)).
  try {
    const file = mainSeenFile(c.installRoot);
    writeMainSeen(c.installRoot, nextMainSeen(readMainSeen(file, { owner, top }), { commit, installed: readInstallStamp(c.installRoot, { owner }), now: now() }), write);
    step('noted');
  } catch (e) { return refuse(`${r.ok ? 'the copy is at main, but ' : `${r.reason}; and `}root's record of main could not be written (${e.code ?? e.message})`); }
  return r.ok ? { ...r, recovered } : r;
}

async function swapIn(c, { commit, cur, from, first, owner, write, step, g, rename }) {
  if (!first && readInstallStamp(c.installRoot, { owner }) === commit) return { ok: true, changed: false, commit };

  const ls = await git(['ls-tree', '-r', '-z', '--full-tree', `${commit}:${SOURCE}`], { ...g, purpose: 'updater-list' });
  if (ls.code !== 0) return refuse(`main's ${SOURCE} folder could not be listed: ${ls.stderr.trim().slice(0, 200)}`);
  const tree = parseTree(ls.stdout, { keep: c.keep });
  if (!tree.ok) return tree;
  const oids = tree.files.map((x) => x.oid);
  const cat = await git(['cat-file', '--batch'], { ...g, input: `${oids.join('\n')}\n`, purpose: 'updater-read' });
  if (cat.code !== 0) return refuse(`git could not read the files: ${cat.stderr.trim().slice(0, 200)}`);
  const batch = parseBatch(cat.stdout, oids);
  if (!batch.ok) return batch;
  // The few files outside SOURCE the code imports (L92 item 4), at their repository paths. With none listed, git is not
  // asked: `ls-tree <commit> --` with no path would list the whole tree.
  const outside = { files: [] };
  const obatch = { blobs: new Map() };
  if (OUTSIDE_FILES.length) {
    const lo = await git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...OUTSIDE_FILES], { ...g, purpose: 'updater-list-outside' });
    if (lo.code !== 0) return refuse(`main's outside files could not be listed: ${lo.stderr.trim().slice(0, 200)}`);
    const listed = parseOutside(lo.stdout);
    if (!listed.ok) return listed;
    outside.files = listed.files;
    const ooids = listed.files.map((x) => x.oid);
    const ocat = await git(['cat-file', '--batch'], { ...g, input: `${ooids.join('\n')}\n`, purpose: 'updater-read-outside' });
    if (ocat.code !== 0) return refuse(`git could not read the outside files: ${ocat.stderr.trim().slice(0, 200)}`);
    const read = parseBatch(ocat.stdout, ooids);
    if (!read.ok) return read;
    obatch.blobs = read.blobs;
  }

  const name = versionName(c.installRoot, commit);
  const next = join(dirname(c.installRoot), name);
  // The copy in place already has this folder's name but not its stamp: it is not this run's to replace.
  if (cur.folder === next) return refuse(`the copy in place, ${name}, has no good stamp; it is left as it is`);
  try {
    mkdirSync(next, { mode: 0o755 });
    step('folder');
    const copy = join(next, SOURCE);
    for (const [base, files, blobs] of [[copy, tree.files, batch.blobs], [next, outside.files, obatch.blobs]]) {
      for (const x of files) {
        const file = join(base, x.path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
        write(file, blobs.get(x.oid), x.mode);
      }
    }
    step('outside files');
    for (const n of c.keep) {
      if (!there(join(from, n))) throw new Error(`the copy's own item ${n} is missing from ${from}`);
      copyItem(join(from, n), join(copy, n));
      step(`kept ${n}`);
    }
    const missing = runnerNamesMissing(c.installRoot, copy);
    if (missing) throw new Error(missing);
    // Last, after both trees and the kept items, so a folder with a stamp is a whole one (L73 point 2, L92 item 4).
    write(join(next, STAMP), Buffer.from(installStamp(commit)), 0o644);
    step('stamped');
    const bad = installProblem(next, [], { owner, top: next });
    if (bad) throw new Error(`the new copy is not root's alone: ${bad}`);
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy was not made (${e.message}); the old one stays`);
  }
  // The flip (L73 point 1): a new link beside the copy's, then one rename over it. The rename is atomic, so
  // installRoot names the old copy or the new one at every moment, never nothing. Before it, `.prev` is set to the copy
  // in place (L75 (a)), so that copy is kept through one more update.
  const link = join(dirname(c.installRoot), `${basename(c.installRoot)}.link-${commit}`);
  const prevLink = `${c.installRoot}${PREVIOUS}-${commit}`;
  const undo = (e) => {
    rmSync(link, { force: true });
    rmSync(prevLink, { force: true });
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy could not be put in place (${e.code ?? e.message}); the old one stays`);
  };
  try {
    symlinkSync(`${name}/${SOURCE}`, link);
  } catch (e) { return undo(e); }
  step('linked');
  if (cur.real) {
    try {
      symlinkSync(`${basename(cur.folder)}/${SOURCE}`, prevLink);
      rename(prevLink, `${c.installRoot}${PREVIOUS}`);
    } catch (e) { return undo(e); }
    step('kept the previous');
  }
  try {
    rename(link, c.installRoot);
  } catch (e) { return undo(e); }
  step('flipped');
  // Every older copy goes; the new one and the one it replaced stay.
  clearLeftovers(c.installRoot, { current: next });
  step('removed the older copies');
  return { ok: true, changed: true, commit };
}

/**
 * Null, or what the new copy `next` lacks of what the runner's config names in the copy (RUNNER_NAMES, L75 m-4): the
 * config is the one just copied into `next` (one of `keep`), and each path it names through installRoot must be there.
 * A name it does not set, or sets outside the copy, is the runner's own check.
 */
function runnerNamesMissing(installRoot, next) {
  let rc; try { rc = JSON.parse(readFileSync(join(next, RUNNER_CONFIG), 'utf8')); } catch { return `the new copy's ${RUNNER_CONFIG} is not JSON`; }
  for (const k of RUNNER_NAMES) {
    const v = rc?.[k];
    if (typeof v !== 'string' || !isAbsolute(v)) continue;
    const rel = relative(installRoot, v);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (!there(join(next, rel))) return `the new copy has no ${rel}, the runner's ${k}: keep must hold ${rel.split('/')[0]}`;
  }
  return null;
}

/**
 * The daemon's run. Before an update: it runs as root; the config, this script and the copy's node are inside the
 * installed copy and root's alone (on `--first`, the config's folders only, since the copy is not there yet); git and
 * every folder above it are root's alone, and so is every folder on root's PATH (ROOT_PATH), so root runs no git
 * anyone else could have changed. `localAddress` is for tests only (readUpdaterConfig), and so is `pathDirs`, the
 * folders of that PATH (always checked as root's, to `/`), so a test can name one that fails.
 */
export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`), uid = process.getuid(), owner = 0, top = '/', self = me, write, step, now, localAddress = false, pathDirs = ROOT_PATH.split(':'), gitTools = gitToolsProblem, rename, gitRunning } = {}) {
  if (uid !== owner) { log('updater: it runs as root only'); return 1; }
  const [file, flag, seed] = argv;
  if (!file || (flag !== undefined && (flag !== '--first' || !seed || !isAbsolute(seed)))) { log('usage: review-updater.mjs <updater.json> [--first <seed folder>]'); return 1; }
  let config;
  try { config = realpathSync.native(file); } catch (e) { log(`updater: the config can't be found (${e.code ?? e.message})`); return 1; }
  // The config and every folder above it are root's alone before a word of it is read (L75 c-2).
  const cb = chainProblem(config, { owner, top });
  if (cb) { log(`updater: the config: ${cb}`); return 1; }
  let c;
  try { c = readUpdaterConfig(config, { localAddress }); } catch (e) { log(`updater: ${e.message}`); return 1; }
  const bad = flag ? null : installProblem(c.installRoot, [config, self, join(c.installRoot, NODE)], { owner, top });
  if (bad) { log(`updater: ${bad}`); return 1; }
  const gb = chainProblem(c.gitBin, { owner, top }) ?? gitTools(c.gitBin);
  if (gb) { log(`updater: git: ${gb}`); return 1; }
  // The folders on root's PATH are the system's own, root's on every Mac: checked as root's whatever `owner` stands in.
  for (const d of pathDirs) {
    let real; try { real = realpathSync.native(d); } catch { continue; }
    const pb = chainProblem(real, { owner: 0, top: '/' });
    if (pb) { log(`updater: PATH: ${pb}`); return 1; }
  }
  let r;
  try { r = await updateOnce(c, { first: flag ? seed : null, owner, top, localAddress, ...(write ? { write } : {}), ...(step ? { step } : {}), ...(now ? { now } : {}), ...(rename ? { rename } : {}), ...(gitRunning ? { gitRunning } : {}) }); } catch (e) { r = refuse(e.message); }
  for (const x of r.recovered ?? []) log(`updater: ${x}`);
  if (!r.ok) { log(`updater: ${r.reason}`); return 1; }
  if (r.changed) log(`updater: the copy is now at ${r.commit}`);
  return 0;
}

const me = (() => { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) process.exitCode = await main(process.argv.slice(2));
