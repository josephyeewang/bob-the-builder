// A git view over a local repository (the review runner's mirror), with the same contract as M10 git-view.mjs, which
// reads the same questions from GitHub (local-view.test.mjs runs both on one repository). The runner has no token, so
// it asks its own mirror (L80). Read only. Anything odd throws, and callers treat a throw as "does not carry over".
// isDir is left out: carry-over doesn't ask it. GitHub's 300-file limit on compare has no meaning here.

import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';

const SHA = /^[0-9a-f]{40}$/;
const STATUS = { A: 'added', D: 'removed', M: 'modified', T: 'modified' };
const sha = (s, what) => { if (typeof s !== 'string' || !SHA.test(s)) throw new Error(`${what} is not a full commit id`); return s; };

export function localGitView({ gitDir, timeoutMs = 60_000 }) {
  const run = (args, purpose) => gitOk(args, { gitDir, purpose, timeoutMs });
  const diff = async (b, h) => {
    const p = (await run(['diff', '--name-status', '-z', '--no-renames', b, h], 'local-view-files')).split('\0').filter(Boolean);
    const out = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (!STATUS[p[i]]) throw new Error(`unknown file status ${p[i]}`);
      out.push(Object.freeze({ path: p[i + 1], status: STATUS[p[i]] }));
    }
    return out;
  };
  async function compare(b, h) {
    sha(b, 'base'); sha(h, 'head');
    const mergeBase = sha((await run(['merge-base', b, h], 'local-view-base')).trim(), 'merge base');
    const status = b === h ? 'identical' : mergeBase === b ? 'ahead' : mergeBase === h ? 'behind' : 'diverged';
    return { status, mergeBase, files: await diff(mergeBase, h) };
  }
  return Object.freeze({
    async commit(s) {
      const t = await run(['cat-file', 'commit', sha(s, 'commit')], 'local-view-commit');
      return Object.freeze({ sha: s, tree: /^tree ([0-9a-f]{40})$/m.exec(t)[1], parents: Object.freeze([...t.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1])) });
    },
    compare,
    async files(b, h) {
      const c = await compare(b, h);
      if (c.mergeBase !== b || (c.status !== 'ahead' && c.status !== 'identical')) throw new Error(`${b.slice(0, 7)} is not an ancestor of ${h.slice(0, 7)}`);
      return c.files;
    },
    async entry(s, path) {
      const t = (await run(['ls-tree', '-z', sha(s, 'commit'), '--', String(path)], 'local-view-entry')).split('\0')[0];
      if (!t) return null;
      const [mode, type, blob] = t.split('\t')[0].split(' ');
      return type === 'tree' ? null : { blob, mode };
    },
    async onHistory(s, tip) {
      const r = await git(['merge-base', '--is-ancestor', sha(s, 'commit'), sha(tip, 'tip')], { gitDir, purpose: 'local-view-history', timeoutMs });
      if (r.code !== 0 && r.code !== 1) throw new Error(`whether ${s.slice(0, 7)} is on ${tip.slice(0, 7)} could not be read (${r.code})`);
      return r.code === 0;
    },
  });
}
