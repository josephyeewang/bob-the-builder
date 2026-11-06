// review-ports.test.mjs — group A's GitHub reads (A1, L615), against the fake GitHub; no test reaches the network.
// Run: node --test orchestrate/wiring/review-ports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyClient } from '../modules/M6-merge-gate/watch-only.mjs';
import { ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { fakeGitHubFetch } from './fake-github.test-helper.mjs';
import { githubReads, reviewPorts, wait, NOT_WIRED_REVIEW, reviewRunner, MAIN_SEEN_STALE_MS } from './review-ports.mjs';
import { reviewConfig, writeSeen, writeStatus } from './review-ports.test-helper.mjs';
import { mkdtempSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('A1: mainSha reads main afresh on each call, never a kept answer (audit #256 r1 m3)', async () => {
  const shas = ['a'.repeat(40), 'b'.repeat(40)];
  let n = 0;
  const gh = { get: async () => ({ status: 200, json: { object: { sha: shas[n++] } } }) };
  const r = githubReads({ gh, entry: ENTRY });
  assert.equal(await r.mainSha({ product: ENTRY.product }), shas[0]);
  assert.equal(await r.mainSha({ product: ENTRY.product }), shas[1]);
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

test('A1: wait waits, and a wait it can\'t read waits no time', { timeout: 5000 }, async () => {
  const t = Date.now();
  await wait(30);
  assert.ok(Date.now() - t >= 25);
  // Text and a BigInt too: the timer itself would wait '1500' out, and throw on 5n (audit #256 r1 m2).
  for (const ms of [-5, NaN, undefined, 'x', Infinity, '1500', 5n]) {
    const s = Date.now();
    await wait(ms);
    assert.ok(Date.now() - s < 1000, String(ms));
  }
});

test('A1, A2: the port file answers exactly what it took off its list', () => {
  const answered = Object.keys(reviewPorts({ gh: client(), entry: ENTRY, config: reviewConfig(temp()), now: Date.now }));
  assert.deepEqual(answered.sort(), ['hasReviewer', 'mainSha', 'planView', 'requestReview', 'reviewAlerts', 'wait']);
  for (const k of answered) assert.ok(!NOT_WIRED_REVIEW.includes(k), k);
});

// ---- A2 (L615, L639): the review runner's ports, against a throwaway runner folder of this user's.
const temp = () => mkdtempSync(join(tmpdir(), 'orch-review-ports-'));
const T0 = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;
const D = 'd'.repeat(40);
function runner({ status = {}, seen = {}, at = T0 } = {}) {
  const dir = temp();
  const config = reviewConfig(dir, { now: T0, status, seen });
  let t = at;
  const ports = reviewRunner({ config, now: () => t, owner: process.getuid(), top: dir });
  return { config, ports, dir, setNow: (v) => { t = v; } };
}
const stamp = (list) => list.find((a) => a.id === 'stamp');

test('A2: requestReview writes one whole request into the runner\'s requests folder, and starts nothing', () => {
  const w = runner();
  const r = w.ports.requestReview({ card: 'c-1', head: 'a'.repeat(40), role: 'reviewer' });
  assert.equal(r.ok, true, r.reason);
  const files = readdirSync(w.config.reviewRequestsDir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(w.config.reviewRequestsDir, files[0]), 'utf8')).card, 'c-1');
});

test('A2: hasReviewer reads what the runner says runs, and a status it can\'t trust is an error, never a no', () => {
  const head = 'a'.repeat(40);
  const w = runner({ status: { running: [{ card: 'c-1', role: 'reviewer', head }] } });
  assert.equal(w.ports.hasReviewer('c-1', 'reviewer', head), true);
  assert.equal(w.ports.hasReviewer('c-1', 'auditor', head), false);
  w.setNow(T0 + 4 * MIN);
  assert.throws(() => w.ports.hasReviewer('c-1', 'reviewer', head), /4 minutes old/);
  const gone = runner({ status: null });
  assert.throws(() => gone.ports.hasReviewer('c-1', 'reviewer', head), /status is missing/);
  const open = runner();
  chmodSync(open.config.reviewStatusFile, 0o666);
  assert.throws(() => open.ports.hasReviewer('c-1', 'reviewer', head), /written by others/);
});

test('A2: reviewAlerts carries the runner\'s alerts and holds, and a copy at main says nothing about its stamp', () => {
  const w = runner({ status: { alerts: [{ id: 'a1', at: 'x', text: 'hello' }], holds: [{ id: 'h1', since: 's', text: 'held' }] } });
  const list = w.ports.reviewAlerts();
  assert.deepEqual(list.map((a) => a.id), ['a1', 'h1']);
  assert.equal(list[1].hold, true);
});

test('A2: a copy behind root\'s record of main is told once past the grace, by the installed commit', () => {
  const w = runner({ status: { installed_commit: 'c'.repeat(40) }, seen: { commit: D, installed: 'c'.repeat(40), since: T0 - 40 * MIN, checked_at: T0 - 2 * MIN } });
  assert.match(stamp(w.ports.reviewAlerts()).text, /installed copy is at ccccccc, but main is at ddddddd/);
});

test('A2: a stale record of main, or none, keeps the stamp hold and says why, never "at main"', () => {
  const stale = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS - MIN } });
  const s = stamp(stale.ports.reviewAlerts());
  assert.equal(s.keep, true);
  assert.match(s.text, /can't be checked\. The read said: root's updater last checked main 21 min ago; it checks every 10 min/);
  const fine = runner({ seen: { checked_at: T0 - MAIN_SEEN_STALE_MS + MIN } });
  assert.equal(stamp(fine.ports.reviewAlerts()), undefined, 'inside two updater turns: fine');
  const ahead = runner({ seen: { checked_at: T0 + 60 * MIN } });
  assert.match(stamp(ahead.ports.reviewAlerts()).text, /at a time that can't be read/);
  const none = runner({ seen: null });
  assert.match(stamp(none.ports.reviewAlerts()).text, /record of main beside the review copy is missing or can't be trusted/);
  const open = runner();
  chmodSync(`${open.config.reviewInstallRoot}.main-seen.json`, 0o666);
  assert.equal(stamp(open.ports.reviewAlerts()).keep, true, 'a record others could write is not trusted');
});

test('A2: the stale limit is two of the updater\'s turns, read from its LaunchDaemon interval', () => {
  assert.equal(MAIN_SEEN_STALE_MS, 20 * MIN);
});

test('A2: a review uid that is not a Mac user id stops the start', () => {
  for (const reviewUid of [undefined, -1, 1.5, '501']) {
    const config = { ...reviewConfig(temp()), reviewUid };
    assert.throws(() => reviewRunner({ config, now: Date.now }), /config: reviewUid must be a Mac user id/, String(reviewUid));
  }
});
