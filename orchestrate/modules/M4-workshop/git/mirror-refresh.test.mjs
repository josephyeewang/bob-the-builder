// mirror-refresh.test.mjs — the gate's fetch into the mirror before a short re-audit (L513 MAT-1, L521). The end-to-end
// run, with the real gate and the real runner, is in M6's gate.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMirrorRefresh } from './mirror-refresh.mjs';
import { gitOk, initMirror } from './safe-git.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const P = 'sample';
const OK_RULES = (mirror) => ({ 'product.repo': 'sample-org/sample-app', 'product.mirror': mirror });

async function world() {
  const d = tempDir('m4-refresh-');
  const hub = join(d, 'hub');
  mkdirSync(hub);
  const g = (args) => execFileSync('git', ['-C', hub, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  g(['init', '-q', '--initial-branch=main']);
  const commit = async (name) => { writeFileSync(join(hub, name), name); g(['add', name]); g(['commit', '-q', '-m', name]); return g(['rev-parse', 'HEAD']).trim(); };
  const base = await commit('a');
  g(['switch', '-q', '-c', 'card/c-1']);
  const head = await commit('b');
  g(['switch', '-q', 'main']);
  const main = await commit('c');
  const mirror = join(d, 'mirror.git');
  await initMirror(mirror);
  const make = (values = OK_RULES(mirror), token = async () => 'a-test-value') => createMirrorRefresh({ rules: { get: (k) => values[k] }, getRobotToken: token, testRemote: () => hub });
  const ref = async (r) => (await gitOk(['rev-parse', '--verify', r], { gitDir: mirror, purpose: 't' })).trim();
  return { d, g, commit, base, head, main, mirror, make, ref };
}

test('L513 MAT-1: main and the card branch reach the mirror, through safe-git, and a later main comes in on the next call', async () => {
  const w = await world();
  const refresh = w.make();
  assert.deepEqual(await refresh({ product: P, card: 'C-1', head: w.head }), { ok: true });
  assert.equal(await w.ref('refs/heads/main'), w.main);
  assert.equal(await w.ref('refs/heads/card/c-1'), w.head);
  const later = await w.commit('d');
  assert.deepEqual(await refresh({ product: P, card: 'C-1', head: w.head }), { ok: true });
  assert.equal(await w.ref('refs/heads/main'), later);
});

test('L521: a branch that has moved on from the head is no refresh of that head', async () => {
  const w = await world();
  const stale = w.base;
  const r = await w.make()({ product: P, card: 'C-1', head: stale });
  assert.equal(r.ok, false);
  assert.equal(r.reason, `the branch is at ${w.head.slice(0, 7)}, not ${stale.slice(0, 7)}`);
});

test('L521: every refusal is an answer, never a throw, and none carries a key or git\'s own words', async () => {
  const w = await world();
  const key = 'a-test-value';
  const ask = (make, over = {}) => make({ product: P, card: 'C-1', head: w.head, ...over });
  const cases = [
    [w.make(), { card: '../x' }, /^not a card's branch$/],
    [w.make(), { head: 'HEAD' }, /^the head is not 40 hex$/],
    [w.make({ 'product.mirror': w.mirror }), {}, /no valid GitHub repo/],
    [w.make({ 'product.repo': 'a/../b', 'product.mirror': w.mirror }), {}, /no valid GitHub repo/],
    [w.make({ 'product.repo': 'a/b' }), {}, /no mirror in the rules/],
    [w.make({ 'product.repo': 'a/b', 'product.mirror': 'relative' }), {}, /no mirror in the rules/],
    [w.make({ 'product.repo': 'a/b', 'product.mirror': join(w.d, 'none') }), {}, /^mirror: /],
    [w.make(undefined, async () => { throw new Error(key); }), {}, /^no robot key for this product$/],
    [w.make(undefined, async () => ''), {}, /^no robot key for this product$/],
    [createMirrorRefresh({ rules: { get: (k) => OK_RULES(w.mirror)[k] }, getRobotToken: async () => key, testRemote: () => join(w.d, 'no-such-hub') }), {}, /^could not fetch from GitHub$/],
  ];
  for (const [make, over, want] of cases) {
    const r = await ask(make, over);
    assert.equal(r.ok, false, String(want));
    assert.match(r.reason, want);
    assert.ok(!r.reason.includes(key));
  }
});
