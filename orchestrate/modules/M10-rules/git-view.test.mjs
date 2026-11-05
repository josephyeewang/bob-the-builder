// git-view.test.mjs — the read-only GitHub view refuses odd answers (audit round 3). Run:
// node --test orchestrate/modules/M10-rules/git-view.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitView } from './git-view.mjs';
import { failedRead } from '../M6-merge-gate/gather.mjs';
import { readOnlyClient } from '../M6-merge-gate/watch-only.mjs';
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

// S16, L543: a client that throws gave no answer, so it is a failed read and the gate holds; git-view's own answers about
// the change are not. Built through the real read-only client where the shape comes from it.
const throwing = (e) => makeGitView({ gh: { get: async () => { throw e; } }, owner: 'o', repo: 'r' });
const viaClient = (o) => makeGitView({ gh: readOnlyClient(o), owner: 'o', repo: 'r' });
const thrown = (p) => p.then(() => { throw new Error('expected a throw'); }, (e) => e);
test('S16: each raw throw from a client is a failed read, its message kept', async () => {
  const cutBody = async () => ({ status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  const noToken = () => { throw new Error('the token file could not be read'); };
  for (const [label, view, re] of [
    ['socket hang up', throwing(new Error('socket hang up')), /socket hang up/],
    ['ECONNRESET', throwing(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), /ECONNRESET/],
    ['a body cut mid-read', viaClient({ token: () => 't', fetchFn: cutBody }), /Unexpected end of JSON/],
    ['a token that can not be read', viaClient({ token: noToken, fetchFn: async () => { throw new Error('never called'); } }), /token file/],
  ]) {
    const e = await thrown(view.commit(B));
    assert.match(e.message, re, label);
    assert.equal(failedRead(e), true, label);
  }
});
test('S16 controls: fetch failed, timeouts and a thrown status class as before; a thrown 404 stays an answer', async () => {
  for (const [label, err, want] of [
    ['fetch failed', new TypeError('fetch failed'), true],
    ['timeout', Object.assign(new Error('the operation timed out'), { name: 'TimeoutError' }), true],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), true],
    ['HTTP 502', new Error('HTTP 502 from GitHub'), true],
    ['status 503', Object.assign(new Error('busy'), { status: 503 }), true],
    ['HTTP 404', new Error('HTTP 404 from GitHub'), false],
    ['status 404', Object.assign(new Error('gone'), { status: 404 }), false],
    ['a thrown non-Error', 'nope', true],
  ]) assert.equal(failedRead(await thrown(throwing(err).commit(B))), want, label);
});
test('S16 controls: git-view\'s own answers about the change stay answers', async () => {
  const e = await thrown(view({ tree: { truncated: true, tree: [] } }).entry(B, 'x'));
  assert.match(e.message, /cut off/);
  assert.equal(failedRead(e), false);
  const odd = await thrown(makeGitView({ gh: { get: async () => ({ status: 500, json: null }) }, owner: 'o', repo: 'r' }).commit(B));
  assert.equal(failedRead(odd), true, 'a 500 answer is still failed, through its message');
});
