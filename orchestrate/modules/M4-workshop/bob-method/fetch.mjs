// fetch.mjs — Bob's method folder at the pinned commit, for the roles that read it (R-0b-141; design v4 §8 C19, §4.4).
//
// WHY. The Lead, M14 and the reviewers read Bob's method (build-protocol-core.md and the rest) as plain text, never as a
// skill, and must not change it. Launch check 13 (launcher/launch.mjs checkBobFolder) already refuses a folder that is not
// exactly the pinned files, holds a SKILL.md, a skill(s) folder or a link, or that the role's settings do not deny writing;
// render-settings.mjs already adds the folder read-only and denies reading any SKILL.md. What was missing is the thing that
// puts the pinned files there. This is it.
//
//   fetchBobMethod({ rules, product, folder, mirror, address, owner }) → { ok, commit, manifest, fetched } | { ok: false, reason }
//
// What it does:
//   1. reads `bob.pin` (a full 40-character commit) and `bob.method_files` (exact paths, or a folder written `dir/**`) from
//      the product's rules; anything else is refused, so a pattern this code can't read never widens the list;
//   2. runs as the `orchestrate` user (`owner`, its uid, from a port), never root, and only into a folder whose parent is
//      that user's alone;
//   3. fetches that one commit, by its id, from GitHub's https address of the public repository through safe-git, into its
//      own bare mirror (checked against the mirror template first). No token: safe-git starts git from an empty
//      environment with no credential helper, and this call adds no header, so a token in the caller's environment never
//      reaches git. A commit the mirror already holds is not fetched again;
//   4. writes the matching files straight from git's objects (no checkout, no work tree) into a new folder beside
//      `folder`, files 0444 and folders 0555, then swaps it in by rename. A link, a submodule, an odd path, a SKILL.md or
//      anything under a skill/skills folder at the pin is refused, never skipped, so check 13 and this agree;
//   5. returns the manifest { path: sha256 } that check 13 compares the folder against (the launcher's `bobManifest`).
//      A folder that already holds exactly the pinned files is left as it is (`fetched: false`).
//
// Not here: the call at each start (the launcher's wiring, lanes 2 and 4) and the folder's place on the Mac (setup).
// Capability note (Principle 9): fetching a commit by its id relies on GitHub serving any reachable commit to a plain
// `git fetch <url> <id>`; checked 9 Nov 2026 against github.com with git 2.54.0.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { git, checkMirror, initMirror } from '../git/safe-git.mjs';
import { parseBatch } from '../launcher/review-updater.mjs';

const refuse = (reason) => ({ ok: false, reason });
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const HEX40 = /^[0-9a-f]{40}$/;
// The public repository's https address, with no name or token in it.
export const GITHUB_ADDRESS = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
export const PIN_REF = 'refs/orchestrate/bob-pin';
const GIT_MS = 300_000;

function plainPart(x) { return x !== '' && x !== '.' && x !== '..' && x.toLowerCase() !== '.git' && !x.includes('\0') && !x.includes('\\'); }

/** `bob.method_files` → [{ exact } | { under }], or a refusal. Only exact paths and `dir/**` are read. */
export function methodPatterns(list) {
  if (!Array.isArray(list) || !list.length) return refuse('the rules list no Bob method files (bob.method_files)');
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return refuse(`a Bob method file entry is not text: ${JSON.stringify(raw)}`);
    const under = raw.endsWith('/**') ? raw.slice(0, -3) : null;
    const path = under ?? raw;
    if (/[*?[\]{}]/.test(path) || !path.split('/').every(plainPart)) return refuse(`bob.method_files: ${JSON.stringify(raw)} is not a plain path or a folder written dir/**`);
    out.push(under ? { under } : { exact: path });
  }
  return { ok: true, patterns: out };
}

const matches = (patterns, p) => patterns.some((x) => (x.exact ? p === x.exact : p.startsWith(`${x.under}/`)));

/** Why a path at the pin may not go in the Bob folder, or null. Matches check 13's refusals, in any case. */
export function skillWhy(p) {
  const parts = p.split('/');
  if (parts.at(-1).toLowerCase() === 'skill.md') return `${p} is a skill`;
  if (parts.slice(0, -1).some((x) => ['skill', 'skills'].includes(x.toLowerCase()))) return `${p} is in a skills folder`;
  return null;
}

/** `git ls-tree -r -z --full-tree <pin>` → the method files [{ oid, path }], or a refusal. */
export function pickFiles(buf, patterns) {
  const out = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(rec);
    if (!m) return refuse(`an unreadable tree line: ${JSON.stringify(rec.slice(0, 80))}`);
    const [, mode, type, oid, path] = m;
    if (!matches(patterns, path)) continue;
    if (mode === '120000') return refuse(`${path} is a link`);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) return refuse(`${path} is not a plain file (mode ${mode})`);
    if (!path.split('/').every(plainPart)) return refuse(`${JSON.stringify(path)} is not a plain path`);
    const why = skillWhy(path);
    if (why) return refuse(`the pinned Bob commit has ${why}; the Bob folder never holds one`);
    out.push({ oid, path });
  }
  const missing = patterns.filter((x) => !out.some((f) => matches([x], f.path))).map((x) => x.exact ?? `${x.under}/**`);
  if (missing.length) return refuse(`the pinned Bob commit has no ${missing.join(', ')}`);
  return { ok: true, files: out };
}

function listFolder(root) {
  const out = new Map();
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(p.slice(root.length + 1), st.isFile() ? p : null);
    }
  };
  walk(root);
  return out;
}

/** Does `folder` hold exactly the manifest's files, as plain files with those bytes? */
export function folderMatches(folder, manifest) {
  try {
    if (!lstatSync(folder).isDirectory()) return false;
    const have = listFolder(folder);
    if (have.size !== Object.keys(manifest).length) return false;
    for (const [rel, p] of have) if (!p || manifest[rel] !== sha256(readFileSync(p))) return false;
    return true;
  } catch { return false; }
}

function ownFolderProblem(dir, owner) {
  let st;
  try { st = lstatSync(dir); } catch { return `${dir} is missing`; }
  if (!st.isDirectory()) return `${dir} is not a plain folder`;
  if (st.uid !== owner) return `${dir} is not the orchestrate user's`;
  if (st.mode & 0o022) return `${dir} can be written by others`;
  return null;
}

function removeTree(p) {
  try {
    const walk = (d) => { chmodSync(d, 0o700); for (const n of readdirSync(d)) { const c = join(d, n); if (lstatSync(c).isDirectory()) walk(c); } };
    if (lstatSync(p).isDirectory()) walk(p);
  } catch { /* gone */ }
  rmSync(p, { recursive: true, force: true });
}

/**
 * Puts Bob's method files at the pinned commit in `folder`. `mirror` is this script's own bare clone; `address` the
 * repository's https address (`localAddress: true` lets a test name a local folder instead). `owner` is the orchestrate
 * user's uid; `uid` the running process's (a port for tests). Never throws.
 */
export async function fetchBobMethod({ rules, product, folder, mirror, address, owner, uid = process.getuid?.(), localAddress = false, gitBin = 'git', now = Date.now } = {}) {
  try {
    if (uid === 0) return refuse('the Bob fetch never runs as root');
    if (!Number.isInteger(owner) || uid !== owner) return refuse('the Bob fetch runs only as the orchestrate user');
    const pin = rules?.get?.('bob.pin', { product });
    if (typeof pin !== 'string' || !HEX40.test(pin)) return refuse('the rules pin no Bob commit (bob.pin, a full commit id)');
    if (/^0{40}$/.test(pin)) return refuse('bob.pin is still the placeholder commit');
    const pat = methodPatterns(rules.get('bob.method_files', { product }));
    if (!pat.ok) return pat;
    if (!(GITHUB_ADDRESS.test(String(address)) || (localAddress && typeof address === 'string' && address.startsWith('/')))) {
      return refuse('the Bob address must be the public repository\'s https address on github.com, with no name or token in it');
    }
    for (const p of [folder, mirror]) if (typeof p !== 'string' || !p.startsWith('/') || p.includes('/../') || p.endsWith('/..')) return refuse('the Bob folder and mirror must be absolute paths');
    for (const dir of new Set([dirname(folder), dirname(mirror)])) { const bad = ownFolderProblem(dir, owner); if (bad) return refuse(bad); }

    const g = { gitDir: mirror, gitBin, timeoutMs: GIT_MS };
    let st = null;
    try { st = lstatSync(mirror); } catch { /* none yet */ }
    if (!st) await initMirror(mirror);
    const mc = checkMirror(mirror);
    if (!mc.ok) return refuse(`the Bob mirror: ${mc.reason}`);

    const have = await git(['cat-file', '-e', `${pin}^{commit}`], { ...g, purpose: 'bob-have' });
    if (have.code !== 0) {
      const f = await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-recurse-submodules', address, `+${pin}:${PIN_REF}`],
        { ...g, address: localAddress ? undefined : address, purpose: 'bob-fetch' });
      if (f.code !== 0) return refuse(`the Bob fetch failed: ${f.stderr.trim().slice(0, 300)}`);
      const again = await git(['cat-file', '-e', `${pin}^{commit}`], { ...g, purpose: 'bob-have' });
      if (again.code !== 0) return refuse(`the fetch did not bring commit ${pin}`);
    }

    const ls = await git(['ls-tree', '-r', '-z', '--full-tree', pin], { ...g, purpose: 'bob-list' });
    if (ls.code !== 0) return refuse(`git could not list commit ${pin}`);
    const picked = pickFiles(ls.stdout, pat.patterns);
    if (!picked.ok) return picked;
    const oids = [...new Set(picked.files.map((f) => f.oid))];
    const cat = await git(['cat-file', '--batch'], { ...g, input: `${oids.join('\n')}\n`, purpose: 'bob-read' });
    if (cat.code !== 0) return refuse('git could not read the pinned files');
    const blobs = parseBatch(cat.stdout, oids);
    if (!blobs.ok) return blobs;
    const manifest = {};
    for (const f of picked.files) manifest[f.path] = sha256(blobs.blobs.get(f.oid));

    if (folderMatches(folder, manifest)) return { ok: true, commit: pin, manifest, fetched: false };

    const tag = `${process.pid}-${now()}`;
    const fresh = join(dirname(folder), `.${basename(folder)}.new-${tag}`);
    mkdirSync(fresh, { mode: 0o755 });
    try {
      const dirs = new Set();
      for (const f of picked.files) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) { const d = join(fresh, ...parts.slice(0, i)); if (!dirs.has(d)) { mkdirSync(d, { mode: 0o755 }); dirs.add(d); } }
        writeFileSync(join(fresh, f.path), blobs.blobs.get(f.oid), { flag: 'wx', mode: 0o444 });
        chmodSync(join(fresh, f.path), 0o444);
      }
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) chmodSync(d, 0o555);
      chmodSync(fresh, 0o555);
      let old = null;
      try { lstatSync(folder); old = join(dirname(folder), `.${basename(folder)}.old-${tag}`); renameSync(folder, old); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      renameSync(fresh, folder);
      if (old) removeTree(old);
    } catch (e) {
      removeTree(fresh);
      return refuse(`the Bob folder could not be written: ${e.message}`);
    }
    if (!folderMatches(folder, manifest)) return refuse('the Bob folder does not read back as the pinned files');
    return { ok: true, commit: pin, manifest, fetched: true };
  } catch (e) {
    return refuse(`the Bob fetch stopped: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
