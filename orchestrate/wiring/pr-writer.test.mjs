// pr-writer.test.mjs — the pull request writer and its pending retry (lane N; L1079 Q3, L1082 Q6). GitHub is a stand-in
// fetch; the Record is an in-memory one that keeps revisions and who wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prWriter, PR_FACT, PR_FACT_PREFIX } from './pr-writer.mjs';
import { PUSH_FACT } from '../modules/M4-workshop/git/push.mjs';
import { FACT_FAMILIES } from '../modules/M9-record/permissions.mjs';

const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const KEY = 'dummy-robot-key-1';
const ARGS = { repo: 'owner-x/sample', branch: 'card/c-1', base: 'main', title: 'Add the thing', body: 'Why it matters', token: KEY };

function memRecord() {
  const docs = new Map();
  const writes = [];
  return {
    docs, writes,
    read: (e, id) => docs.get(`${e}/${id}`) ?? null,
    list: (e) => [...docs.entries()].filter(([k]) => k.startsWith(`${e}/`)).map(([, v]) => v),
    write: ({ actor, entity, id, expectRev, doc, kind }) => {
      writes.push({ actor, entity, id, doc, kind });
      const cur = docs.get(`${entity}/${id}`);
      if ((cur?.rev ?? 0) !== expectRev) return { ok: false, reason: 'stale' };
      docs.set(`${entity}/${id}`, { id, rev: expectRev + 1, doc });
      return { ok: true };
    },
  };
}

// A GitHub stand-in: `open` is the list of open PRs; `posts` scripts POST answers in order.
function gh({ open = [], posts = [] } = {}) {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ method: init.method ?? 'GET', path: u.pathname + u.search, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    const answer = (status, json) => ({ status, json: async () => json });
    if ((init.method ?? 'GET') === 'GET') return answer(200, open);
    const st = posts.shift() ?? 201;
    if (st === 201) { const pr = { number: 40 + open.length, html_url: `https://github.com/x/pull/${40 + open.length}` }; open.push(pr); return answer(201, pr); }
    if (st === 'race') { open.push({ number: 77, html_url: 'u77' }); return answer(422, { message: 'A pull request already exists' }); }
    return answer(st, { message: 'no' });
  };
  return { fetchFn, seen };
}

test('the pending fact sits in the Workshop\'s own family and can never be taken for a push fact', () => {
  const id = PR_FACT('card/c-1');
  assert.ok(FACT_FAMILIES.workshop.some((f) => id.startsWith(f)));
  assert.equal(id.split('.').length, 4, 'three dots');
  assert.equal(PUSH_FACT('c-1', 'a1').split('.').length, 3, 'two dots');
  assert.ok(id.startsWith(PR_FACT_PREFIX));
});

test('upsert opens a pull request from the branch into its base, masked, with the robot token', async () => {
  const rec = memRecord();
  const g = gh();
  const w = prWriter({ record: rec, fetchFn: g.fetchFn, now: () => T0, mask: (s) => s.replace(/Why/g, '***') });
  const pr = await w.upsert(ARGS);
  assert.equal(pr.number, 40);
  const post = g.seen.find((x) => x.method === 'POST');
  assert.equal(post.path, '/repos/owner-x/sample/pulls');
  assert.deepEqual(post.body, { title: 'Add the thing', head: 'card/c-1', base: 'main', body: '*** it matters', maintainer_can_modify: false });
  assert.equal(post.auth, `Bearer ${KEY}`);
  assert.match(g.seen[0].path, /head=owner-x%3Acard%2Fc-1/);
  assert.equal(rec.writes.length, 0, 'no pending record when nothing was pending');
});

test('upsert is safe to repeat: an open pull request already there is the answer, left as it is (L1082 c2)', async () => {
  const g = gh({ open: [{ number: 9, html_url: 'u9' }] });
  const pr = await prWriter({ record: memRecord(), fetchFn: g.fetchFn }).upsert(ARGS);
  assert.deepEqual(pr, { number: 9, url: 'u9' });
  assert.equal(g.seen.filter((x) => x.method !== 'GET').length, 0);
});

test('a 422 from a race is answered by looking again', async () => {
  const g = gh({ posts: ['race'] });
  const pr = await prWriter({ record: memRecord(), fetchFn: g.fetchFn }).upsert(ARGS);
  assert.equal(pr.number, 77);
});

test('a failed upsert answers null and records it pending as the Workshop, never with the token (L1082 c1)', async () => {
  const rec = memRecord();
  const pr = await prWriter({ record: rec, fetchFn: gh({ posts: [502] }).fetchFn, now: () => T0 }).upsert(ARGS);
  assert.equal(pr, null);
  const f = rec.read('fact', PR_FACT('card/c-1'));
  assert.equal(rec.writes[0].actor, 'workshop');
  assert.equal(f.doc.state, 'pending');
  assert.equal(f.doc.tries, 1);
  assert.match(f.doc.last_reason, /502/);
  assert.ok(!JSON.stringify(f.doc).includes(KEY));
  assert.ok(!Object.keys(f.doc).some((k) => /token/i.test(k)));
});

test('plant (L1082): an upsert that fails twice then succeeds opens on the second retry, the record marked opened', async () => {
  const rec = memRecord();
  const g = gh({ posts: [502, 500] });
  let t = T0;
  const w = prWriter({ record: rec, fetchFn: g.fetchFn, now: () => t });
  assert.equal(await w.upsert(ARGS), null);
  const getToken = async () => 'dummy-fresh-key';
  t += 15 * 60_000;
  let r = await w.retryPending({ getToken, repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r.opened, []);
  assert.equal(rec.read('fact', PR_FACT('card/c-1')).doc.tries, 2);
  assert.equal(rec.read('fact', PR_FACT('card/c-1')).doc.since, new Date(T0).toISOString(), 'since kept from the first failure');
  t += 15 * 60_000;
  r = await w.retryPending({ getToken, repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r.opened, ['card/c-1']);
  assert.equal(rec.read('fact', PR_FACT('card/c-1')).doc.state, 'opened');
  assert.equal(g.seen.at(-1).auth, 'Bearer dummy-fresh-key', 'the retry uses the round\'s token, not a stored one');
  r = await w.retryPending({ getToken, repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r, { opened: [], waiting: [], unreadable: [] }, 'opened is not asked again');
});

test('plant (L1082): an existing pull request found on the retry counts as opened, nothing posted', async () => {
  const rec = memRecord();
  await prWriter({ record: rec, fetchFn: gh({ posts: [502] }).fetchFn, now: () => T0 }).upsert(ARGS);
  const g2 = gh({ open: [{ number: 5, html_url: 'u5' }] });
  const r = await prWriter({ record: rec, fetchFn: g2.fetchFn, now: () => T0 + 20 * 60_000 }).retryPending({ getToken: async () => 'dummy', repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r.opened, ['card/c-1']);
  assert.equal(g2.seen.filter((x) => x.method === 'POST').length, 0);
  assert.equal(rec.read('fact', PR_FACT('card/c-1')).doc.number, 5);
});

test('a pending one tried less than `every` ago waits, listed so it stays told, and no token is minted for it', async () => {
  const rec = memRecord();
  let t = T0;
  const w = prWriter({ record: rec, fetchFn: gh({ posts: [502] }).fetchFn, now: () => t });
  await w.upsert(ARGS);
  t += 60_000;
  let minted = 0;
  const r = await w.retryPending({ getToken: async () => { minted += 1; return 'dummy'; }, repos: [ARGS.repo], every: 15 * 60_000 });
  assert.equal(minted, 0);
  assert.equal(r.waiting.length, 1);
  assert.match(r.waiting[0][1], /502/);
});

test('a pending time in the future is not believed: it is tried now (I4)', async () => {
  const rec = memRecord();
  await prWriter({ record: rec, fetchFn: gh({ posts: [502] }).fetchFn, now: () => T0 + 3600_000 }).upsert(ARGS);
  const r = await prWriter({ record: rec, fetchFn: gh().fetchFn, now: () => T0 }).retryPending({ getToken: async () => 'dummy', repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r.opened, ['card/c-1']);
});

test('a token that can\'t be had leaves it waiting with the reason; another robot\'s repo is not touched (I6)', async () => {
  const rec = memRecord();
  let t = T0;
  const w = prWriter({ record: rec, fetchFn: gh({ posts: [502, 502] }).fetchFn, now: () => t });
  await w.upsert(ARGS);
  await w.upsert({ ...ARGS, repo: 'someone/else', branch: 'card/c-2' });
  t += 20 * 60_000;
  const r = await w.retryPending({ getToken: async () => { throw new Error('mint refused'); }, repos: [ARGS.repo], every: 15 * 60_000 });
  assert.deepEqual(r.waiting.map((x) => x[0]), ['card/c-1']);
  assert.match(r.waiting[0][1], /mint refused/);
});

test('a pending record that can\'t be read is said; a fact list that can\'t be read throws (I1)', async () => {
  const rec = memRecord();
  rec.docs.set(`fact/${PR_FACT('card/c-1')}`, { id: PR_FACT('card/c-1'), corrupt: true });
  const w = prWriter({ record: rec, fetchFn: gh().fetchFn });
  const r = await w.retryPending({ getToken: async () => 'dummy', repos: [ARGS.repo] });
  assert.deepEqual(r.unreadable, [PR_FACT('card/c-1')]);
  await assert.rejects(w.retryPending({ getToken: async () => 'dummy', repos: [] }), /names no repo/);
  rec.list = () => undefined;
  await assert.rejects(w.retryPending({ getToken: async () => 'dummy', repos: [ARGS.repo] }), /could not be read/);
});

test('bad names are refused before any call to GitHub', async () => {
  const g = gh();
  const w = prWriter({ record: memRecord(), fetchFn: g.fetchFn });
  assert.equal(await w.upsert({ ...ARGS, repo: 'not a repo' }), null);
  assert.equal(await w.upsert({ ...ARGS, base: '../main' }), null);
  assert.equal(await w.upsert({ ...ARGS, token: '' }), null);
  assert.equal(g.seen.length, 0);
});

test('the real masker hides a secret-shaped string in the card\'s words', async () => {
  const g = gh();
  const fake = ['gh', 'p_', 'dummy', 'x'.repeat(31)].join('');
  await prWriter({ record: memRecord(), fetchFn: g.fetchFn }).upsert({ ...ARGS, body: `key ${fake} here` });
  const post = g.seen.find((x) => x.method === 'POST');
  assert.ok(!post.body.body.includes(fake));
});
