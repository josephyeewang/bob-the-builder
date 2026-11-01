#!/usr/bin/env node
// The updater (L66, last bullet; item 19; L73): a LaunchDaemon that runs as root every 10 minutes and keeps the
// installed copy (`installRoot`, install-check.mjs) at `main`. `node review-updater.mjs <updater.json> [--first <seed>]`.
//
// What it does, and nothing else:
//   1. checks that every folder it will write in (the copy's and the clone's) and every folder above them is root's
//      alone, and that the copy whose own items it carries over (or the install step's seed) is root's alone, before it
//      writes, renames or removes anything (L73 M1);
//   2. removes what a cut-off run left beside the copy: any versioned folder or link the copy's link does not name. It
//      never puts one of them in place;
//   3. fetches `main` (and only main, by its full name) from the repository's https address into its own bare clone,
//      through safe-git (no hooks, no repository config, no other place), with a git only root can change (`gitBin`)
//      and a PATH only root can write (ROOT_PATH);
//   4. when main's commit differs from the stamp, writes the files under `orchestrate/` at that commit into a new
//      folder beside the copy (`<installRoot>.v-<commit>`), straight from git's objects: no checkout, no work tree;
//      copies in the copy's own items that are not in the repository (`keep`: its node, its configs, the wiring, the
//      claude program) from the copy in place, then writes the commit stamp last;
//   5. checks the new folder is root's alone (`installProblem`), then flips the copy's link to it with one rename and
//      removes the old folder;
//   6. notes, in root's own record beside the copy, when it first saw main ahead of the copy (install-check.mjs
//      `mainSeenFile`), for the Dispatcher's stamp alert.
// Root runs only the updater's own small module set, from main: this file, install-check.mjs and safe-git.mjs, which
// import nothing but Node's own modules (the test checks). It runs nothing from the repository it copies: only git and
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
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, checkMirror, MIRROR_CONFIG_TEMPLATE, ROOT_PATH } from '../git/safe-git.mjs';
import { STAMP, NODE, UPDATER_CONFIG, RUNNER_CONFIG, installStamp, installProblem, chainProblem, currentCopy, readInstallStamp,
  versionName, versionCommit, mainSeenFile, readMainSeen, nextMainSeen } from './install-check.mjs';

export const MAIN = 'refs/heads/main';
export const SOURCE = 'orchestrate';
// What `keep` must hold, or the first update would drop it: the copy's node, the updater's config, the runner's config.
export const MUST_KEEP = Object.freeze({ [dirname(NODE)]: 'the copy\'s own node', [UPDATER_CONFIG]: 'the updater\'s config', [RUNNER_CONFIG]: 'the review runner\'s config' });
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/;
const FILE_MODES = { 100644: 0o644, 100755: 0o755 };
const GIT_MS = 300_000;

const refuse = (reason) => ({ ok: false, reason });
const there = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/**
 * The config, checked. `localAddress` lets a test fetch from a local folder standing in for GitHub; it is an option of
 * the call, which the real run never passes, so no key in the file can turn it on (L73 point 3).
 */
export function readUpdaterConfig(file, { localAddress = false } = {}) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['installRoot', 'clone', 'gitBin']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k]) || c[k].includes('..') || c[k] === '/') throw new Error(`config: ${k} must be an absolute path`);
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
 * not yet flipped in (`<name>.link-<commit>`). Anything else there is not the updater's and is left alone. `list` is a
 * port, since a disk may list a folder in any order.
 */
export function leftovers(installRoot, { list = readdirSync } = {}) {
  const base = basename(installRoot);
  let names = [];
  try { names = list(dirname(installRoot)); } catch { return []; }
  const pre = `${base}.link-`;
  return names.filter((n) => versionCommit(installRoot, n) !== null || (n.startsWith(pre) && HEX40.test(n.slice(pre.length))))
    .sort().map((n) => join(dirname(installRoot), n));
}

/**
 * Removes every leftover except `current` (the folder the copy's link names). Nothing found here is ever put in place:
 * the copy is only ever a folder this run made and checked (L73 M1). → what was removed, for the log.
 */
export function clearLeftovers(installRoot, { current = null } = {}) {
  const done = [];
  for (const d of leftovers(installRoot)) {
    if (d === current) continue;
    rmSync(d, { recursive: true, force: true });
    done.push(`removed ${basename(d)}`);
  }
  return done;
}

/** A new bare clone in the mirror's shape (no hooks, the fixed config), made with root's git. */
async function makeClone(clone, g) {
  const r = await git(['init', '--bare', '-q', clone], { ...g, purpose: 'updater-init' });
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim().slice(0, 200)}`);
  const cfg = join(clone, 'config');
  rmSync(cfg);
  writeNew(cfg, Buffer.from(MIRROR_CONFIG_TEMPLATE), 0o644);
  rmSync(join(clone, 'hooks'), { recursive: true, force: true });
  rmSync(join(clone, 'description'), { force: true });
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
export async function updateOnce(c, { first = null, owner = 0, top = '/', write = writeNew, step = () => {}, now = Date.now, localAddress = false } = {}) {
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
  const recovered = clearLeftovers(c.installRoot, { current: cur.real ?? null });
  step('cleared');

  const g = { gitDir: c.clone, gitBin: c.gitBin, timeoutMs: GIT_MS, path: ROOT_PATH };
  if (!there(c.clone)) { await makeClone(c.clone, g); step('cloned'); }
  const chain = chainProblem(c.clone, { owner, top });
  if (chain) return refuse(`the clone: ${chain}`);
  const m = checkMirror(c.clone);
  if (!m.ok) return refuse(`the clone was refused: ${m.reason}`);

  // Only main, by its full name, into main: never HEAD, a tag or another branch.
  const f = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', c.address, `+${MAIN}:${MAIN}`],
    { ...g, address: c.address, purpose: 'updater-fetch' });
  if (f.code !== 0) return refuse(`the fetch failed: ${f.stderr.trim().slice(0, 300)}`);
  const rp = await git(['rev-parse', '--verify', '-q', `${MAIN}^{commit}`], { ...g, purpose: 'updater-main' });
  const commit = rp.stdout.toString('utf8').trim();
  if (rp.code !== 0 || !HEX40.test(commit)) return refuse('main has no commit in the clone');

  const r = await swapIn(c, { commit, cur, from, first, owner, write, step, g });
  // Root's record of main, after every fetch that worked, whatever the update did (item 20(c), L73 point 7(b)).
  try {
    const file = mainSeenFile(c.installRoot);
    writeMainSeen(c.installRoot, nextMainSeen(readMainSeen(file, { owner }), { commit, installed: readInstallStamp(c.installRoot, { owner }), now: now() }), write);
    step('noted');
  } catch (e) { return refuse(`${r.ok ? 'the copy is at main, but ' : `${r.reason}; and `}root's record of main could not be written (${e.code ?? e.message})`); }
  return r.ok ? { ...r, recovered } : r;
}

async function swapIn(c, { commit, cur, from, first, owner, write, step, g }) {
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

  const name = versionName(c.installRoot, commit);
  const next = join(dirname(c.installRoot), name);
  // The copy in place already has this folder's name but not its stamp: it is not this run's to replace.
  if (cur.real === next) return refuse(`the copy in place, ${name}, has no good stamp; it is left as it is`);
  try {
    mkdirSync(next, { mode: 0o755 });
    step('folder');
    for (const x of tree.files) {
      const file = join(next, x.path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      write(file, batch.blobs.get(x.oid), x.mode);
    }
    for (const n of c.keep) {
      if (!there(join(from, n))) throw new Error(`the copy's own item ${n} is missing from ${from}`);
      copyItem(join(from, n), join(next, n));
      step(`kept ${n}`);
    }
    // Last, so a folder with a stamp is a whole one (L73 point 2).
    write(join(next, STAMP), Buffer.from(installStamp(commit)), 0o644);
    step('stamped');
    const bad = installProblem(next, [], { owner, top: next });
    if (bad) throw new Error(`the new copy is not root's alone: ${bad}`);
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy was not made (${e.message}); the old one stays`);
  }
  // The flip (L73 point 1): a new link beside the copy's, then one rename over it. The rename is atomic, so
  // installRoot names the old copy or the new one at every moment, never nothing.
  const link = join(dirname(c.installRoot), `${basename(c.installRoot)}.link-${commit}`);
  try {
    symlinkSync(name, link);
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy could not be put in place (${e.code ?? e.message}); the old one stays`);
  }
  step('linked');
  try {
    renameSync(link, c.installRoot);
  } catch (e) {
    rmSync(link, { force: true });
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy could not be put in place (${e.code ?? e.message}); the old one stays`);
  }
  step('flipped');
  if (cur.real && cur.real !== next) { rmSync(cur.real, { recursive: true, force: true }); step('removed the old copy'); }
  return { ok: true, changed: true, commit };
}

/**
 * The daemon's run. Before an update: it runs as root; the config, this script and the copy's node are inside the
 * installed copy and root's alone (on `--first`, the config's folders only, since the copy is not there yet); git and
 * every folder above it are root's alone, and so is every folder on root's PATH (ROOT_PATH), so root runs no git
 * anyone else could have changed. `localAddress` is for tests only (readUpdaterConfig), and so is `pathDirs`, the
 * folders of that PATH (always checked as root's, to `/`), so a test can name one that fails.
 */
export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`), uid = process.getuid(), owner = 0, top = '/', self = me, write, step, now, localAddress = false, pathDirs = ROOT_PATH.split(':') } = {}) {
  if (uid !== owner) { log('updater: it runs as root only'); return 1; }
  const [file, flag, seed] = argv;
  if (!file || (flag !== undefined && (flag !== '--first' || !seed || !isAbsolute(seed)))) { log('usage: review-updater.mjs <updater.json> [--first <seed folder>]'); return 1; }
  let c;
  try { c = readUpdaterConfig(file, { localAddress }); } catch (e) { log(`updater: ${e.message}`); return 1; }
  let config;
  try { config = realpathSync.native(file); } catch (e) { log(`updater: the config can't be found (${e.code ?? e.message})`); return 1; }
  const bad = flag ? chainProblem(config, { owner, top }) : installProblem(c.installRoot, [config, self, join(c.installRoot, NODE)], { owner, top });
  if (bad) { log(`updater: ${flag ? 'the config: ' : ''}${bad}`); return 1; }
  const gb = chainProblem(c.gitBin, { owner, top });
  if (gb) { log(`updater: git: ${gb}`); return 1; }
  // The folders on root's PATH are the system's own, root's on every Mac: checked as root's whatever `owner` stands in.
  for (const d of pathDirs) {
    let real; try { real = realpathSync.native(d); } catch { continue; }
    const pb = chainProblem(real, { owner: 0, top: '/' });
    if (pb) { log(`updater: PATH: ${pb}`); return 1; }
  }
  let r;
  try { r = await updateOnce(c, { first: flag ? seed : null, owner, top, localAddress, ...(write ? { write } : {}), ...(step ? { step } : {}), ...(now ? { now } : {}) }); } catch (e) { r = refuse(e.message); }
  for (const x of r.recovered ?? []) log(`updater: ${x}`);
  if (!r.ok) { log(`updater: ${r.reason}`); return 1; }
  if (r.changed) log(`updater: the copy is now at ${r.commit}`);
  return 0;
}

const me = (() => { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) process.exitCode = await main(process.argv.slice(2));
