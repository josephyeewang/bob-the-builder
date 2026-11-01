// A git view over a local repository (the review runner's mirror), in the shape the carry-over rule reads (M10
// git-view.mjs reads the same questions from GitHub). The runner has no token, so it asks its own mirror (L80).
// Read only. Anything odd throws, and callers treat a throw as "does not carry over" (fail closed).

import { git, gitOk } from '../M4-workshop/git/safe-git.mjs';

const SHA = /^[0-9a-f]{40}$/;
const STATUS = { A: 'added', D: 'removed', M: 'modified', T: 'modified' };
const sha = (s, what) => { if (typeof s !== 'string' || !SHA.test(s)) throw new Error(`${what} is not a full commit id`); return s; };

export function localGitView({ gitDir, timeoutMs = 60_000 }) {
  const run = (args, purpose) => gitOk(args, { gitDir, purpose, timeoutMs });
  return {
    async commit(s) {
      const t = await run(['cat-file', 'commit', sha(s, 'the commit')], 'local-view-commit');
      return { sha: s, tree: /^tree ([0-9a-f]{40})$/m.exec(t)[1], parents: [...t.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]) };
    },
    async compare(b, h) {
      const mergeBase = (await run(['merge-base', sha(b, 'the base'), sha(h, 'the head')], 'local-view-base')).trim();
      if (!SHA.test(mergeBase)) throw new Error('no common commit');
      return { mergeBase, status: mergeBase === b && b === h ? 'identical' : mergeBase === b ? 'ahead' : mergeBase === h ? 'behind' : 'diverged' };
    },
    async files(b, h) {
      const p = (await run(['diff', '--name-status', '-z', '--no-renames', sha(b, 'the base'), sha(h, 'the head')], 'local-view-files')).split('\0').filter(Boolean);
      const out = [];
      for (let i = 0; i + 1 < p.length; i += 2) {
        if (!STATUS[p[i]]) throw new Error(`unknown file status ${p[i]}`);
        out.push({ status: STATUS[p[i]], path: p[i + 1] });
      }
      return out;
    },
    async entry(s, path) {
      const t = (await run(['ls-tree', '-z', sha(s, 'the commit'), '--', String(path)], 'local-view-entry')).split('\0')[0];
      if (!t) return null;
      const [mode, , blob] = t.split('\t')[0].split(' ');
      return { mode, blob };
    },
    async onHistory(s, tip) {
      return (await git(['merge-base', '--is-ancestor', sha(s, 'the commit'), sha(tip, 'the tip')], { gitDir, purpose: 'local-view-history', timeoutMs })).code === 0;
    },
  };
}
