#!/usr/bin/env node
// The updater (L66, last bullet; item 19): a LaunchDaemon that runs as root every 10 minutes and keeps the installed
// copy (`installRoot`, review-daemons.mjs) at `main`. `node review-updater.mjs <updater.json> [--first <seed>]`.
//
// What it does, and nothing else:
//   1. fetches `main` (and only main, by its full name) from the repository's address into its own bare clone, through
//      safe-git (no hooks, no repository config, no other place), with a git that only root can change (`gitBin`);
//   2. when main's commit differs from the stamp, writes the files under `orchestrate/` at that commit into a new
//      folder beside the copy (`<installRoot>.new-<commit>`), straight from git's objects: no checkout, no work tree;
//   3. copies the copy's own items that are not in the repository (`keep`: its node, its configs, the wiring, the
//      claude program) from the old copy into the new folder, then writes the commit stamp last;
//   4. checks the new folder is root's alone (`installProblem`), then swaps it in with two renames, and removes the old.
// It runs no code from the repository: it only runs git and copies files. A new folder is complete only once it has
// its stamp, so a run cut off at any point leaves either the old copy or a complete new one (`recoverSwap`).
//
// The wall is `main` itself: only the Merge Gate or Joe changes it. A branch, a tag or the remote's HEAD is never read.
// Two updaters never run at once: launchd starts a job only when its last run has ended, and the install step runs
// before the job is loaded.
//
// updater.json (root's, inside installRoot, one of `keep`):
//   { "installRoot": "/abs", "clone": "/abs", "address": "https://github.com/<owner>/<repo>.git",
//     "keep": ["bin", "config.json", ...], "gitBin": "/abs/git" }
// Exit 0 when the copy is at main (updated or already there), 1 when it refused or could not run.

import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, checkMirror, MIRROR_CONFIG_TEMPLATE } from '../git/safe-git.mjs';
import { STAMP, NODE, installStamp } from './review-daemons.mjs';
import { installProblem, readInstallStamp } from './review-runner-main.mjs';

export const MAIN = 'refs/heads/main';
export const SOURCE = 'orchestrate';
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const FILE_MODES = { 100644: 0o644, 100755: 0o755 };
const GIT_MS = 300_000;

const refuse = (reason) => ({ ok: false, reason });

export function readUpdaterConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['installRoot', 'clone', 'gitBin']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k]) || c[k].includes('..')) throw new Error(`config: ${k} must be an absolute path`);
  if (typeof c.address !== 'string' || !(/^https:\/\/[^\s]+$/.test(c.address) || isAbsolute(c.address))) throw new Error('config: address must be an https address');
  if (!Array.isArray(c.keep) || c.keep.some((n) => typeof n !== 'string' || !NAME.test(n) || n === STAMP)) throw new Error('config: keep must list plain top-level names');
  if (!c.keep.includes(dirname(NODE))) throw new Error(`config: keep must hold ${dirname(NODE)} (the copy's own node)`);
  return c;
}

/**
 * `p` and every folder above it, up to and including `top`: no link, owned by `owner`, written by no one else. For the
 * git root runs and the clone's folder, which the walk inside installRoot does not cover. Null, or the first problem.
 */
export function chainProblem(p, { owner = 0, top = '/', lstat = lstatSync } = {}) {
  let at = p;
  for (;;) {
    let st; try { st = lstat(at); } catch { return `${at} is missing`; }
    if (st.isSymbolicLink()) return `${at} is a link`;
    if (st.uid !== owner) return `${at} is not owned by root`;
    if (st.mode & 0o022) return `${at} can be written by others than root`;
    if (at === top || at === dirname(at)) return null;
    at = dirname(at);
  }
}

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

/** Copies one of the copy's own items (a file or a folder) from the old copy: no links, no group or other write. */
function copyItem(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) throw new Error(`${from} is a link`);
  if (st.isDirectory()) {
    mkdirSync(to, { mode: 0o755 });
    for (const n of readdirSync(from)) copyItem(join(from, n), join(to, n));
    return;
  }
  if (!st.isFile()) throw new Error(`${from} is not a plain file`);
  copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const fd = openSync(to, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, st.mode & 0o755); fsyncSync(fd); } finally { closeSync(fd); }
}

const leftovers = (installRoot, kind) => {
  const pre = `${basename(installRoot)}.${kind}-`;
  let names = [];
  try { names = readdirSync(dirname(installRoot)); } catch { return []; }
  return names.filter((n) => n.startsWith(pre) && HEX40.test(n.slice(pre.length))).map((n) => join(dirname(installRoot), n));
};

/**
 * After a run that was cut off. With the copy missing (cut off between the two renames), the old copy goes back; with
 * no old copy, a new one that has its stamp (complete) goes in. Then every leftover new or old folder is removed.
 */
export function recoverSwap(installRoot, { owner = 0 } = {}) {
  const done = [];
  if (!existsSync(installRoot)) {
    const old = leftovers(installRoot, 'old')[0];
    const ready = leftovers(installRoot, 'new').find((d) => readInstallStamp(d, { owner }) === d.slice(-40));
    if (old) { renameSync(old, installRoot); done.push('put the old copy back'); }
    else if (ready) { renameSync(ready, installRoot); done.push('put the complete new copy in'); }
  }
  for (const d of [...leftovers(installRoot, 'new'), ...leftovers(installRoot, 'old')]) { rmSync(d, { recursive: true, force: true }); done.push(`removed ${basename(d)}`); }
  return done;
}

/** A new bare clone in the mirror's shape (no hooks, the fixed config), made with root's git. */
async function makeClone(clone, gitBin) {
  const r = await git(['init', '--bare', '-q', clone], { gitDir: clone, gitBin, purpose: 'updater-init' });
  if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim().slice(0, 200)}`);
  const cfg = join(clone, 'config');
  rmSync(cfg);
  writeNew(cfg, Buffer.from(MIRROR_CONFIG_TEMPLATE), 0o644);
  rmSync(join(clone, 'hooks'), { recursive: true, force: true });
  rmSync(join(clone, 'description'), { force: true });
}

/**
 * One update. `c` is the updater config. `first` is a seed folder holding the `keep` items, for the install step only
 * (when there is no copy yet). `owner` and `top` stand in for root and `/` in tests; `write` is the file writer (a port,
 * so a test can cut a run off part way). → { ok, changed, commit, recovered } or { ok: false, reason }.
 */
export async function updateOnce(c, { first = null, owner = 0, top = '/', write = writeNew } = {}) {
  const recovered = recoverSwap(c.installRoot, { owner });
  const have = existsSync(c.installRoot);
  if (first && have) return refuse('there is already an installed copy; --first is only for the install step');
  if (!first && !have) return refuse('there is no installed copy; run the install step');
  const from = first ?? c.installRoot;

  const g = { gitDir: c.clone, gitBin: c.gitBin, timeoutMs: GIT_MS };
  if (!existsSync(c.clone)) await makeClone(c.clone, c.gitBin);
  const m = checkMirror(c.clone);
  if (!m.ok) return refuse(`the clone was refused: ${m.reason}`);
  const chain = chainProblem(c.clone, { owner, top });
  if (chain) return refuse(`the clone: ${chain}`);

  // Only main, by its full name, into main: never HEAD, a tag or another branch.
  const f = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', c.address, `+${MAIN}:${MAIN}`],
    { ...g, address: c.address, purpose: 'updater-fetch' });
  if (f.code !== 0) return refuse(`the fetch failed: ${f.stderr.trim().slice(0, 300)}`);
  const rp = await git(['rev-parse', '--verify', '-q', `${MAIN}^{commit}`], { ...g, purpose: 'updater-main' });
  const commit = rp.stdout.toString('utf8').trim();
  if (rp.code !== 0 || !HEX40.test(commit)) return refuse('main has no commit in the clone');
  if (!first && readInstallStamp(c.installRoot, { owner }) === commit) return { ok: true, changed: false, commit, recovered };

  const ls = await git(['ls-tree', '-r', '-z', '--full-tree', `${commit}:${SOURCE}`], { ...g, purpose: 'updater-list' });
  if (ls.code !== 0) return refuse(`main's ${SOURCE} folder could not be listed: ${ls.stderr.trim().slice(0, 200)}`);
  const tree = parseTree(ls.stdout, { keep: c.keep });
  if (!tree.ok) return tree;
  const oids = tree.files.map((x) => x.oid);
  const cat = await git(['cat-file', '--batch'], { ...g, input: `${oids.join('\n')}\n`, purpose: 'updater-read' });
  if (cat.code !== 0) return refuse(`git could not read the files: ${cat.stderr.trim().slice(0, 200)}`);
  const batch = parseBatch(cat.stdout, oids);
  if (!batch.ok) return batch;

  const next = `${c.installRoot}.new-${commit}`;
  const old = `${c.installRoot}.old-${commit}`;
  try {
    mkdirSync(next, { mode: 0o755 });
    for (const x of tree.files) {
      const file = join(next, x.path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      write(file, batch.blobs.get(x.oid), x.mode);
    }
    for (const n of c.keep) {
      if (!existsSync(join(from, n))) throw new Error(`the copy's own item ${n} is missing from ${from}`);
      copyItem(join(from, n), join(next, n));
    }
    write(join(next, STAMP), Buffer.from(installStamp(commit)), 0o644);
    const bad = installProblem(next, [], { owner, top: next });
    if (bad) throw new Error(`the new copy is not root's alone: ${bad}`);
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy was not made (${e.message}); the old one stays`);
  }
  if (have) renameSync(c.installRoot, old);
  try { renameSync(next, c.installRoot); } catch (e) {
    if (have) renameSync(old, c.installRoot);
    rmSync(next, { recursive: true, force: true });
    return refuse(`the new copy could not be put in place (${e.code ?? e.message}); the old one stays`);
  }
  if (have) rmSync(old, { recursive: true, force: true });
  return { ok: true, changed: true, commit, recovered };
}

/**
 * The daemon's run. Before an update: it runs as root; the config, this script and the copy's node are inside the
 * installed copy and root's alone (on `--first`, the config only, since the copy is not there yet); git and every folder
 * above it are root's alone, so root runs no git anyone else could have changed.
 */
export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`), uid = process.getuid(), owner = 0, top = '/', self = me, write } = {}) {
  if (uid !== owner) { log('updater: it runs as root only'); return 1; }
  const [file, flag, seed] = argv;
  if (!file || (flag !== undefined && (flag !== '--first' || !seed || !isAbsolute(seed)))) { log('usage: review-updater.mjs <updater.json> [--first <seed folder>]'); return 1; }
  let c;
  try { c = readUpdaterConfig(file); } catch (e) { log(`updater: ${e.message}`); return 1; }
  const config = realpathSync(file);
  if (flag) {
    const bad = chainProblem(config, { owner, top });
    if (bad) { log(`updater: the config: ${bad}`); return 1; }
  } else if (existsSync(c.installRoot)) {
    const bad = installProblem(c.installRoot, [config, self, join(c.installRoot, NODE)], { owner, top });
    if (bad) { log(`updater: ${bad}`); return 1; }
  }
  const gb = chainProblem(c.gitBin, { owner, top });
  if (gb) { log(`updater: git: ${gb}`); return 1; }
  let r;
  try { r = await updateOnce(c, { first: flag ? seed : null, owner, top, ...(write ? { write } : {}) }); } catch (e) { r = refuse(e.message); }
  for (const x of r.recovered ?? []) log(`updater: ${x}`);
  if (!r.ok) { log(`updater: ${r.reason}`); return 1; }
  if (r.changed) log(`updater: the copy is now at ${r.commit}`);
  return 0;
}

const me = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) process.exitCode = await main(process.argv.slice(2));
