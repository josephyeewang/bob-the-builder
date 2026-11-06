// review-ports.test.mjs — group A's GitHub reads (A1, L615), against the fake GitHub; no test reaches the network.
// Run: node --test orchestrate/wiring/review-ports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyClient } from '../modules/M6-merge-gate/watch-only.mjs';
import { ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { fakeGitHubFetch } from './fake-github.test-helper.mjs';
import { githubReads, reviewPorts, wait, NOT_WIRED_REVIEW } from './review-ports.mjs';

const COMMIT = 'c'.repeat(40);
const TOKEN = 't'.repeat(40);
const client = (over = {}) => readOnlyClient({ token: () => TOKEN, fetchFn: fakeGitHubFetch({ owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: 'x', ...over }) });
// A client that answers each path from a table, and counts its reads.
const table = (paths) => {
  const asked = [];
  return { asked, get: async (p) => { asked.push(p); const a = paths[p]; if (a instanceof Error) throw a; return a ?? { status: 404, json: null }; } };
};
const base = `/repos/${ENTRY.owner}/${ENTRY.repo}`;

test('A1: mainSha reads the product\'s main branch through the read-only client', async () => {
  const r = githubReads({ gh: client(), entry: ENTRY });
  assert.equal(await r.mainSha({ product: ENTRY.product }), COMMIT);
});

test('A1: another product, or none, is refused before anything is read', async () => {
  const gh = table({});
  const r = githubReads({ gh, entry: ENTRY });
  for (const product of ['other', null, undefined]) {
    await assert.rejects(r.mainSha({ product }), new RegExp(`runs product ${ENTRY.product}, so it can't read product ${product}`));
    await assert.rejects(r.planView({ product }), /can't read product/);
  }
  await assert.rejects(r.mainSha(), /can't read product undefined/);
  assert.deepEqual(gh.asked, []);
});

test('A1: a main read that fails, answers oddly or names no commit throws, never a made-up commit', async () => {
  const ref = `${base}/git/ref/heads/main`;
  for (const [answer, why] of [
    [{ status: 404, json: null }, /GitHub answered 404 for the main branch/],
    [{ status: 200, json: {} }, /named no commit/],
    [{ status: 200, json: { object: { sha: 'abc' } } }, /named no commit/],
    [{ status: 200, json: { object: { sha: 'C'.repeat(40) } } }, /named no commit/],
  ]) await assert.rejects(githubReads({ gh: table({ [ref]: answer }), entry: ENTRY }).mainSha({ product: ENTRY.product }), why);
  // A client that threw gave no answer: marked unreadable, as M10's git view marks it (S16).
  await assert.rejects(githubReads({ gh: table({ [ref]: new Error('socket hang up') }), entry: ENTRY }).mainSha({ product: ENTRY.product }),
    (e) => e.unreadable === true && /socket hang up/.test(e.message));
});

test('A1: planView answers isDir from the commit\'s tree, a fresh view each call', async () => {
  const tree = 'd'.repeat(40);
  const blob = 'b'.repeat(40);
  const gh = table({
    [`${base}/git/commits/${COMMIT}`]: { status: 200, json: { sha: COMMIT, tree: { sha: tree }, parents: [] } },
    [`${base}/git/trees/${tree}?recursive=1`]: { status: 200, json: { truncated: false, tree: [{ type: 'blob', path: 'src/a.mjs', sha: blob, mode: '100644' }] } },
  });
  const r = githubReads({ gh, entry: ENTRY });
  const v = await r.planView({ product: ENTRY.product });
  assert.equal(await v.isDir(COMMIT, 'src'), true);
  assert.equal(await v.isDir(COMMIT, 'src/a.mjs'), false);
  const reads = gh.asked.length;
  await (await r.planView({ product: ENTRY.product })).isDir(COMMIT, 'src');
  assert.equal(gh.asked.length, reads * 2, 'a later pass reads GitHub again');
});

test('A1: the read-only client refuses anything but a repository read, so these ports can\'t write', async () => {
  const gh = client();
  await assert.rejects(gh.get('/user'), /only repository reads/);
  await assert.rejects(gh.post(`${base}/pulls`, {}), /only write-shaped call/);
  assert.throws(() => githubReads({ gh: null, entry: ENTRY }), /need the read-only client/);
});

test('A1: wait waits, and a wait it can\'t read waits no time', async () => {
  const t = Date.now();
  await wait(30);
  assert.ok(Date.now() - t >= 25);
  for (const ms of [-5, NaN, undefined, 'x', Infinity]) {
    const s = Date.now();
    await wait(ms);
    assert.ok(Date.now() - s < 1000, String(ms));
  }
});

test('A1: the port file answers exactly what it took off its list', () => {
  const answered = Object.keys(reviewPorts({ gh: client(), entry: ENTRY }));
  assert.deepEqual(answered.sort(), ['mainSha', 'planView', 'wait']);
  for (const k of answered) assert.ok(!NOT_WIRED_REVIEW.includes(k), k);
});
