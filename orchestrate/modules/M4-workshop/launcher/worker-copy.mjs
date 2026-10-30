// Launch checks 1–2 (design v4 §14.1.3): a worker's fresh copy of the code (R-0b-31).
//
// Check 1: the copy comes from the scripts' own mirror of the card's repo, at the card's commit
// (or, on a restart, from the card's last bundle), and nowhere else.
// Check 2: a branch can carry its own Claude settings, skills or tool servers, and Claude reads
// them at start. So every `.claude`, `.mcp.json` and `CLAUDE.local.md` the branch brings, at any
// depth and in any letter case, is removed (a link is removed as a link; what it points at is
// never touched), and main's own copies are put back from the mirror.
//
// All git runs through ../git/safe-git.mjs.

import { lstatSync, readdirSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep, dirname, isAbsolute } from 'node:path';
import { git, gitOk, checkMirror } from '../git/safe-git.mjs';

// Names Claude reads settings, skills or tool servers from. Compared after NFC folding and
// lower-casing, because a Mac's disk treats `.Claude` as `.claude`.
export const PROTECTED_NAMES = Object.freeze(['.claude', '.mcp.json', 'claude.local.md']);
const fold = (n) => n.normalize('NFC').replace(/[­​-‏⁠-⁤﻿]/g, '').toLowerCase();
export const isProtectedName = (n) => PROTECTED_NAMES.includes(fold(n));

const SHA = /^[0-9a-f]{40}$/;
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const refuse = (reason) => ({ ok: false, reason });

/** Path safety (Archon's rule, rewritten from its description): `rel` must stay inside `root`. */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const out = resolve(root, ...parts);
  return out.startsWith(resolve(root) + sep) ? out : null;
}

/** Refuses when any existing folder on the way from root to `abs` is a link (no writes through links). */
function noLinkOnTheWay(root, abs) {
  let cur = resolve(root);
  for (const p of abs.slice(cur.length + 1).split(sep).slice(0, -1)) {
    cur = join(cur, p);
    let st; try { st = lstatSync(cur); } catch { return true; }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/** Removes every protected entry under `root` without following links. Returns the paths removed. */
export function removeProtected(root) {
  const removed = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.name === '.git' && dir === root) continue;
      if (isProtectedName(ent.name)) {
        // rmSync on a link removes the link only; on a folder it does not follow links inside.
        rmSync(p, { recursive: true, force: true });
        removed.push(p.slice(root.length + 1));
        continue;
      }
      if (ent.isDirectory() && !ent.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return removed;
}

const isProtectedPath = (path) => path.split('/').some(isProtectedName);

/**
 * Prepares one worker's copy.
 *   product      the rules' product entry: { repo: 'owner/name', mirror: '<folder>' }
 *   card         { id, repo, commit, branch }   (from the record)
 *   dest         the new folder for this copy; must not exist
 *   lastBundle   on a restart, the card's last bundle file (else null)
 * Returns { ok: true, dest, head, removed, restored } or { ok: false, reason }.
 */
export async function prepareWorkerCopy({ product, card, dest, lastBundle = null }) {
  if (!product?.repo || !product?.mirror) return refuse('product has no repo or mirror in the rules');
  if (!card || card.repo !== product.repo) return refuse(`card repo "${card?.repo}" is not the product's repo "${product.repo}"`);
  if (!CARD.test(String(card.id))) return refuse('bad card id');
  if (!SHA.test(String(card.commit))) return refuse('card commit is not a full commit id');
  const branch = `card/${String(card.id).toLowerCase()}`;
  if (card.branch && card.branch !== branch) return refuse(`card branch "${card.branch}" is not ${branch}`);
  try { lstatSync(dest); return refuse('copy folder already exists'); } catch { /* good */ }

  const mirror = product.mirror;
  const m = checkMirror(mirror);
  if (!m.ok) return refuse(`mirror: ${m.reason}`);

  // Check 1: the commit is in the mirror and on main's history (a wrong commit is refused).
  const t = await git(['cat-file', '-t', card.commit], { gitDir: mirror, purpose: 'launch-check-commit' });
  if (t.code !== 0 || t.stdout.toString().trim() !== 'commit') return refuse('card commit is not in the mirror');
  const anc = await git(['merge-base', '--is-ancestor', card.commit, 'refs/heads/main'], { gitDir: mirror, purpose: 'launch-check-commit' });
  if (anc.code !== 0) return refuse('card commit is not on main');

  mkdirSync(dest, { recursive: false });
  const gitDir = join(dest, '.git');
  const opts = (purpose) => ({ gitDir, workTree: dest, cwd: dest, purpose });
  try {
    await gitOk(['init', '-q', dest], opts('launch-init'));
    // Fetch main's commit from the mirror by path; the copy keeps no remote.
    await gitOk(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', mirror, `${card.commit}:refs/orchestrate/base`], opts('launch-fetch'));
    let head = card.commit;
    if (lastBundle) {
      const v = await git(['bundle', 'verify', '-q', lastBundle], opts('launch-bundle-verify'));
      if (v.code !== 0) throw new Error(`last bundle does not verify: ${v.stderr.trim().slice(0, 200)}`);
      const heads = (await gitOk(['bundle', 'list-heads', lastBundle], opts('launch-bundle-heads'))).trim().split('\n').filter(Boolean);
      if (heads.length !== 1 || !heads[0].endsWith(` refs/heads/${branch}`)) throw new Error('last bundle must hold exactly the card branch');
      await gitOk(['fetch', '-q', '--no-tags', '--no-write-fetch-head', lastBundle, `refs/heads/${branch}:refs/heads/${branch}`], opts('launch-bundle-fetch'));
      head = heads[0].split(' ')[0];
      const a = await git(['merge-base', '--is-ancestor', card.commit, head], opts('launch-bundle-base'));
      if (a.code !== 0) throw new Error('last bundle is not built on the card commit');
    } else {
      await gitOk(['branch', branch, card.commit], opts('launch-branch'));
    }
    await gitOk(['checkout', '-q', '-f', branch], opts('launch-checkout'));
    const got = (await gitOk(['rev-parse', 'HEAD'], opts('launch-verify-head'))).trim();
    if (got !== head) throw new Error('checked-out commit is not the expected one');

    // Check 2: remove what the branch brought, then restore main's copies.
    const removed = removeProtected(dest);
    const restored = await restoreMainCopies({ mirror, dest });
    return { ok: true, dest, head, branch, removed, restored };
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    return refuse(e.message);
  }
}

/** Writes main's own `.claude/**`, `.mcp.json` and `CLAUDE.local.md` (any depth) into dest. */
export async function restoreMainCopies({ mirror, dest }) {
  const raw = await gitOk(['ls-tree', '-r', '-z', '--full-tree', 'refs/heads/main'], { gitDir: mirror, purpose: 'launch-restore-list' });
  const restored = [];
  const realDest = realpathSync(dest);
  for (const rec of raw.split('\0').filter(Boolean)) {
    const [meta, path] = rec.split('\t');
    const [mode, type, oid] = meta.split(' ');
    if (!isProtectedPath(path)) continue;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new Error(`main's ${path} is not a plain file (mode ${mode})`);
    const abs = safeJoin(realDest, path);
    if (!abs) throw new Error(`unsafe path in main: ${path}`);
    mkdirSync(dirname(abs), { recursive: true });
    if (!noLinkOnTheWay(realDest, abs)) throw new Error(`a link is on the way to ${path}`);
    const r = await git(['cat-file', 'blob', oid], { gitDir: mirror, purpose: 'launch-restore-blob' });
    if (r.code !== 0) throw new Error(`cannot read main's ${path}`);
    writeFileSync(abs, r.stdout, { mode: mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    restored.push(path);
  }
  return restored;
}
