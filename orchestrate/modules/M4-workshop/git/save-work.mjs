// Save-work: the one step that runs git inside a worker's copy (review 0b-4 M6, R-0b-46).
//
// A worker that stopped before writing its bundle gets one written for it. Everything in the
// copy is the worker's, so before any git runs:
//   - `.git` must be a real folder (a `gitdir:` pointer file or a link is refused);
//   - `.git/config` is replaced with a fixed template (this drops every planted setting and
//     every include.path / includeIf);
//   - config.worktree, hooks, info/attributes, info/grafts and commondir are removed;
//   - objects/info/alternates must be absent or name exactly the mirror's objects folder.
// Then the only git call is `bundle create` of the card branch, through safe-git, with
// core.symlinks=false. It runs only through `runLocked`, the launcher's lock-down runner (same
// network-off sandbox and read-deny as the worker), even when started on its own.

import { lstatSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitOk } from './safe-git.mjs';
import { BRANCH, bundleName } from './push.mjs';

export const CLONE_CONFIG_TEMPLATE = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n';
export const REMOVED = Object.freeze(['config.worktree', 'hooks', 'info/attributes', 'info/grafts', 'commondir', 'shallow']);
const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const refuse = (reason) => ({ ok: false, reason });
const st = (p) => { try { return lstatSync(p); } catch { return null; } };

/** Resets a worker's `.git` so nothing in it can name a program. Throws on anything unsafe. */
export function resetCloneGit({ clone, mirror }) {
  const gitDir = join(clone, '.git');
  const g = st(gitDir);
  if (!g) throw new Error('the copy has no .git folder');
  if (g.isSymbolicLink() || !g.isDirectory()) throw new Error('the copy\'s .git is not a real folder (a pointer file or a link)');
  const cfg = join(gitDir, 'config');
  if (st(cfg)?.isSymbolicLink()) rmSync(cfg);
  writeFileSync(cfg, CLONE_CONFIG_TEMPLATE, { flag: 'w' });
  for (const f of REMOVED) rmSync(join(gitDir, f), { recursive: true, force: true });
  const alt = join(gitDir, 'objects', 'info', 'alternates');
  const a = st(alt);
  if (a) {
    if (!a.isFile()) throw new Error('the copy\'s alternates file is not a plain file');
    const lines = readFileSync(alt, 'utf8').split('\n').filter((l) => l.trim());
    const want = resolve(mirror, 'objects');
    if (lines.length !== 1 || resolve(clone, '.git', 'objects', lines[0]) !== want) throw new Error('the copy borrows objects from somewhere other than the mirror');
  }
  for (const f of ['objects/info/http-alternates']) if (st(join(gitDir, f))) throw new Error(`the copy has ${f}`);
  return gitDir;
}

/**
 * `runLocked(fn)` runs `fn` inside the worker's lock-down and returns its result. Required:
 * without it save-work refuses. Returns { ok: true, bundle } or { ok: false, reason }.
 */
export function createSaveWork({ runLocked }) {
  return async function saveWork({ clone, mirror, card, branch, outbox }) {
    if (typeof runLocked !== 'function') return refuse('save-work runs only inside the worker\'s lock-down');
    if (!CARD.test(String(card))) return refuse('bad card id');
    if (branch !== `card/${String(card).toLowerCase()}` || !BRANCH.test(branch)) return refuse('bad card branch');
    try {
      return await runLocked(async () => {
        const gitDir = resetCloneGit({ clone, mirror });
        const o = st(outbox);
        if (!o || o.isSymbolicLink() || !o.isDirectory()) throw new Error('the outbox is not a real folder');
        // Written under a temporary name, then moved, so a half-written bundle is never read.
        const tmp = join(outbox, `.${bundleName(card)}.partial`);
        rmSync(tmp, { force: true });
        await gitOk(['bundle', 'create', '-q', tmp, `refs/heads/${branch}`], { gitDir, purpose: 'save-work', extraConfig: [['core.symlinks', 'false']], allowObjects: [resolve(mirror, 'objects')] });
        const out = join(outbox, bundleName(card));
        if (st(out)?.isSymbolicLink()) rmSync(out);
        renameSync(tmp, out);
        return { ok: true, bundle: out };
      });
    } catch (e) { return refuse(e.message); }
  };
}
