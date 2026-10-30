// git-view.test.mjs — the read-only GitHub view refuses odd answers (audit round 3). Run:
// node --test orchestrate/modules/M10-rules/git-view.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitView } from './git-view.mjs';
import { carryOver } from './carry-over.mjs';
import { checkExactReverse } from './exact-reverse.mjs';

const S = (c) => c.repeat(40);
const [A, B, T] = [S('a'), S('b'), S('c')];

// A scripted GitHub that answers every compare with `files` and every commit and tree with what's given.
function scripted({ files = [], tree = { truncated: false, tree: [] } } = {}) {
  return {
    async get(path) {
      if (path.includes('/compare/')) return { status: 200, json: { status: 'ahead', merge_base_commit: { sha: A }, files } };
      if (path.includes('/git/commits/')) { const sha = path.split('/').pop(); return { status: 200, json: { sha, tree: { sha: T }, parents: [{ sha: A }] } }; }
      if (path.includes('/git/trees/')) return { status: 200, json: tree };
      return { status: 404, json: null };
    },
  };
}
const view = (opts) => makeGitView({ gh: scripted(opts), owner: 'sample-org', repo: 'sample-app' });

test('a rename or copy with no old name is refused, and the checks built on the view say no', async () => {
  for (const status of ['renamed', 'copied']) {
    const v = view({ files: [{ filename: 'docs/b.md', status }] });
    await assert.rejects(v.files(A, B), /with no old name/);
    const r = await carryOver({ reviewed: { base: A, head: B }, current: { base: A, head: B }, between: [], catchUps: [], tier1MergesSince: 0, gh: v });
    assert.equal(r.review, false, status);
    const x = await checkExactReverse({ view: v, reverses: B, merged: S('d') });
    assert.equal(x.ok, false, status);
  }
  const named = view({ files: [{ filename: 'docs/b.md', previous_filename: 'docs/a.md', status: 'renamed' }] });
  assert.deepEqual(await named.files(A, B), [{ path: 'docs/b.md', previous_path: 'docs/a.md', status: 'renamed' }]);
});

test('a tree answer that does not say it is complete counts as cut off', async () => {
  await assert.rejects(view({ tree: { tree: [] } }).entry(B, 'x'), /cut off or unknown/);
  await assert.rejects(view({ tree: { truncated: true, tree: [] } }).entry(B, 'x'), /cut off or unknown/);
  assert.equal(await view({ tree: { truncated: false, tree: [] } }).entry(B, 'x'), null);
});

test('isDir: a folder listed as a tree entry, or only implied by a file under it (0b-5 go check)', async () => {
  const blob = (p) => ({ path: p, mode: '100644', type: 'blob', sha: S('d') });
  const v = view({ tree: { truncated: false, tree: [{ path: 'src', mode: '040000', type: 'tree', sha: S('e') }, blob('src/a.mjs'), blob('lib/deep/b.mjs'), blob('top.md')] } });
  assert.equal(await v.isDir(B, 'src'), true);
  assert.equal(await v.isDir(B, 'src/'), true);
  assert.equal(await v.isDir(B, 'lib'), true, 'implied by lib/deep/b.mjs');
  assert.equal(await v.isDir(B, 'lib/deep'), true);
  assert.equal(await v.isDir(B, 'src/a.mjs'), false);
  assert.equal(await v.isDir(B, 'top.md'), false);
  assert.equal(await v.isDir(B, 'nope'), false);
  const cut = view({ tree: { truncated: true, tree: [] } });
  await assert.rejects(cut.isDir(B, 'src'), /cut off/);
});
