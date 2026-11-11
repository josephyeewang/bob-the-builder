// alert-channel.test.mjs — the channel to Joe (L235–L245): the Record's alert queues become GitHub issues, from the
// robot job, with the Dispatcher dead or alive. Every GitHub call here is a fake; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { memoryRecord } from '../../shared/record.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { ALERT_QUEUE_FACT, outbox, tellThen } from '../M11-dispatcher/alerts.mjs';
import { heldHolders, makeHeldFlag, newHeldToken, readHeldFlag, readUnsent, setHeldFlag } from '../M9-record/unsent.mjs';
import { setup, seed, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { lastLine, lineIs } from './alerts.mjs';
import { BODY_MAX, channelProblem, cutBody, deliverAlertsPass, deliverWith, entryKey, githubIssues, lockedMarker, recordProductProblem, repoProblem, storeText } from './alert-channel.mjs';

const T0 = Date.parse('2026-11-03T08:00:00Z');
const MIN = 60_000;

// The GitHub stand-in, answering as the channel's client does (open → a number, edit/close → true, comment → { at },
// read → the issue, findOpen → a number or null). It is not M13's fakeIssues, whose calls only succeed (L130): a test that needs a call lost swaps
// that method for one that answers false or throws (the L235 c test).
function fakeGitHub() {
  const issues = new Map();
  const calls = [];
  const spoken = [];
  let n = 0;
  const gh = {
    calls, issues, clock: null,
    async open({ title, body, assignee }) { n += 1; issues.set(n, { title, body, assignee, closed: false, comments: [] }); calls.push(['open', n]); return n; },
    async edit(i, body) { issues.get(i).body = body; calls.push(['edit', i]); return true; },
    async comment(i, text) { issues.get(i).comments.push(text); const at = gh.clock ? new Date(gh.clock()).toISOString() : undefined; if (at) spoken.push({ i, at, body: text }); calls.push(['comment', i]); return { at }; },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.byOwner = false; x.comments.push(text); calls.push(['close', i]); return true; },
    async read(i) {
      if (!Number.isSafeInteger(i) || i <= 0) throw new Error(`fakeGitHub.read: not an issue number: ${JSON.stringify(i)}`);
      const x = issues.get(i);
      return x ? { open: !x.closed, body: x.body, ours: true, closedByOwner: x.closed && x.byOwner === true } : null;
    },
    async findOpen(test) { calls.push(['findOpen']); for (const [k, x] of issues) if (!x.closed && test(lastLine(x.body))) return k; return null; },
    async latestOwnComment(i, since) { return spoken.filter((c) => c.i === i && c.at >= since).at(-1) ?? null; },
    ownerCloses(i) { const x = issues.get(i); x.closed = true; x.byOwner = true; },
    openIssues: () => [...issues.values()].filter((x) => !x.closed),
  };
  return gh;
}

function world({ products = ['p1'], product = 'p1', gh = fakeGitHub() } = {}) {
  const root = tempDir('m13-chan-');
  writeFileSync(join(root, 'unsent-alerts.jsonl'), '', { mode: 0o644 });
  let t = T0;
  gh.clock = () => t;
  const rec = memoryRecord({ now: () => t });
  const repos = Object.fromEntries(products.map((p, i) => [p, `acme/product-${i + 1}`]));
  const bound = { recordRoot: root, product, products, repos, owner: 'owner-login', issuesFor: () => gh, lockWaitMs: 30 };
  return { root, rec, gh, bound, repos, tick: (m) => { t += m * MIN; }, now: () => t, run: (over = {}) => deliverAlertsPass({ ...bound, rec, now: () => t, ...over }) };
}
const queued = (rec) => rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
const writeLock = (root, holder) => writeFileSync(join(root, 'lock'), typeof holder === 'string' ? holder : JSON.stringify(holder), { mode: 0o644 });
const ALIVE = { kill: () => true, pidStart: () => 'start-A' };
const DEAD = { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, pidStart: () => null };
const holder = (atMs, pid = 4242) => ({ pid, pid_start: 'start-A', host: 'mac-a', nonce: 'n1', at: new Date(atMs).toISOString() });

test('L236: the Dispatcher never runs, and a queued alert is delivered as an issue to the product repo, assigned to Joe', async () => {
  const w = world();
  outbox(w.rec, T0)('merge gate: card C-1 is held', { mark: { fact: 'stop-f-C-1', fields: { told: true } } });
  const r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.deepEqual([r.sent, r.failed, r.left, r.refused], [1, 0, 0, undefined]);
  assert.equal(w.gh.issues.size, 1);
  assert.equal(w.gh.issues.get(1).assignee, 'owner-login');
  assert.match(w.gh.issues.get(1).title, /card C-1 is held/);
  assert.equal(w.rec.read('fact', 'stop-f-C-1').doc.told, true, 'the mark is written once GitHub took it');
  assert.deepEqual(queued(w.rec), []);
});

test('L235 c: a refused or thrown issue write leaves the alert queued; the next round delivers it', async () => {
  for (const lose of [async () => false, async () => { throw new Error('github down'); }]) {
    const w = world();
    const open = w.gh.open;
    w.gh.open = lose;
    outbox(w.rec, T0)('one', { mark: { fact: 'stop-f-1', fields: { told: true } } });
    const r = await w.run({ probe: ALIVE });
    assert.equal(r.failed, 1);
    assert.equal(queued(w.rec).length, 1, 'kept');
    assert.equal(w.rec.read('fact', 'stop-f-1'), null, 'no told mark');
    w.gh.open = open;
    assert.equal((await w.run({ probe: ALIVE })).sent, 1);
    assert.deepEqual(queued(w.rec), []);
  }
});

test('L237: one key per cause: the same marked cause queued again edits its issue, an unmarked text keys on its hash', async () => {
  const w = world();
  const a = outbox(w.rec, T0);
  a('cause one, first', { mark: { fact: 'stop-f-1', fields: { n: 1 } } });
  await w.run({ probe: ALIVE });
  a('cause one, again', { mark: { fact: 'stop-f-1', fields: { n: 2 } } });
  a('a one-off');
  await w.run({ probe: ALIVE });
  assert.equal(w.gh.issues.size, 2, 'f1 edited, the one-off opened');
  assert.match(w.gh.issues.get(1).body, /cause one, again/);
  assert.equal(entryKey('p', 'x', { mark: { fact: 'f', kind: 'k' } }), 'p|k|f');
  assert.match(entryKey('p', 'x', {}), /^p\|unmarked\|[0-9a-f]{64}$/);
  assert.notEqual(entryKey('p', 'x', {}), entryKey('p', 'y', {}));
});

test('L237: an issue Joe closed does not silence the next alert of its key: it opens a new issue', async () => {
  const w = world();
  const a = outbox(w.rec, T0);
  a('first', { mark: { fact: 'stop-f-1', fields: { n: 1 } } });
  await w.run({ probe: ALIVE });
  w.gh.ownerCloses(1);
  a('second', { mark: { fact: 'stop-f-1', fields: { n: 2 } } });
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.sent, 1);
  assert.equal(w.gh.issues.size, 2);
  assert.equal(w.gh.issues.get(2).closed, false);
  assert.deepEqual(queued(w.rec), []);
});

test('L242: a lock left by a dead process counts as free and the round delivers, but only the store breaks it (it recovers after)', async () => {
  const w = world();
  writeLock(w.root, holder(T0 - 60 * MIN));
  outbox(w.rec, T0)('x');
  const r = await w.run({ host: 'mac-a', probe: DEAD });
  assert.equal(r.refused, undefined);
  assert.equal(r.sent, 1);
  assert.ok(existsSync(join(w.root, 'lock')), 'the dead holder\'s lock is left for the store, whose break triggers recovery');
});

test('L244/L245: a live holder: up to the red limit nothing is opened; past it one issue; later rounds edit it; freed, it closes and the queue drains', async () => {
  const w = world();
  outbox(w.rec, T0)('queued while locked');
  writeLock(w.root, holder(T0 - 14 * MIN));
  let r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.match(r.refused, /locked by pid 4242 for 14 min/);
  assert.equal(r.locked, 'waiting');
  assert.equal(w.gh.issues.size, 0, '14 min: no issue');
  writeLock(w.root, holder(T0 - 16 * MIN));
  r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(r.locked, 'opened');
  assert.equal(w.gh.issues.size, 1);
  assert.match(w.gh.issues.get(1).body, /^p1's Record has been locked for 16 min by pid 4242; alerts are queued and not delivered/);
  assert.match(w.gh.issues.get(1).title, /^p1's Record is locked/);
  assert.ok(w.gh.issues.get(1).body.includes(lockedMarker('p1')));
  for (let i = 0; i < 3; i++) { w.tick(1); assert.equal((await w.run({ host: 'mac-a', probe: ALIVE })).locked, 'edited'); }
  assert.equal(w.gh.issues.size, 1, 'three more rounds edit the one issue');
  assert.match(w.gh.issues.get(1).body, /locked for 19 min/);
  assert.equal(queued(w.rec).length, 1, 'nothing lost while locked');
  writeLock(w.root, holder(T0 - 20 * MIN, 9));
  r = await w.run({ host: 'mac-a', probe: DEAD });
  assert.equal(r.sent, 1);
  assert.equal(w.gh.issues.get(1).closed, true, 'the record_locked issue closes once the lock is free');
  assert.deepEqual(queued(w.rec), []);
});

test('L245: a lock whose holder can\'t be read is told at once; a refused list call opens nothing', async () => {
  const w = world();
  writeLock(w.root, '{not json');
  let r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(r.locked, 'opened');
  assert.match(w.gh.issues.get(1).body, /who holds it can't be read/);
  const v = world();
  writeLock(v.root, holder(T0 - 30 * MIN));
  v.gh.findOpen = async () => false;
  r = await v.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(r.locked, 'list refused');
  assert.equal(v.gh.issues.size, 0);
});

test('L245: refused and lost writes leave at most one open record_locked issue', async () => {
  const w = world();
  writeLock(w.root, holder(T0 - 30 * MIN));
  const { open, edit } = w.gh;
  const plan = [['open', async () => false], ['open', async () => { throw new Error('lost'); }], ['open', open], ['edit', async () => false], ['edit', async () => { throw new Error('lost'); }], ['edit', edit], ['edit', edit]];
  for (const [k, f] of plan) {
    w.gh[k] = f;
    const r = await w.run({ host: 'mac-a', probe: ALIVE });
    assert.equal(typeof r.refused, 'string');
    assert.ok(w.gh.openIssues().length <= 1, `after ${k}: at most one open`);
    w.gh.open = open; w.gh.edit = edit;
  }
  assert.equal(w.gh.openIssues().length, 1);
});

test('a GitHub client that throws on every call never makes the round throw', async () => {
  const boom = async () => { throw new Error('boom'); };
  const gh = { open: boom, edit: boom, comment: boom, close: boom, read: boom, findOpen: boom };
  const w = world({ gh });
  outbox(w.rec, T0)('x');
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.failed, 1);
  assert.match(r.refused, /^1 alert\(s\) could not be delivered this round and stay queued/);
  assert.equal(queued(w.rec).length, 1);
  writeLock(w.root, holder(T0 - 30 * MIN));
  const l = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.match(l.locked, /not told: boom/);
  const z = await deliverAlertsPass({ ...w.bound, rec: { read: () => { throw new Error('record gone'); } }, issuesFor: () => { throw new Error('no client'); } });
  assert.equal(typeof z.refused, 'string');
  const v = world();
  const y = await deliverAlertsPass({ ...v.bound, rec: v.rec, probe: ALIVE, issuesFor: () => { throw new Error('no client'); } });
  assert.match(y.refused, /no client/);
});

test('Bob\'s own repository, a bad repo name, no owner or no repo for the product are refused before any call', async () => {
  assert.match(repoProblem('someone/bob-the-builder'), /never go to Bob's own repository/);
  assert.match(repoProblem('someone/Bob-The-Builder'), /Bob's own/);
  for (const bad of ['nope', 'a/b/c', '-x/y', 'x/.git', 42, '']) assert.match(repoProblem(bad), /not an owner\/name repository/, String(bad));
  assert.equal(repoProblem('acme/product-1'), null);
  const ok = { product: 'p1', products: ['p1'], repos: { p1: 'acme/r' }, owner: 'o' };
  assert.equal(channelProblem(ok), null);
  // L288 MAT-3: the Record's product is required, with no default, and must be in the list.
  assert.match(channelProblem({ ...ok, product: undefined }), /no product for this Record/);
  assert.match(channelProblem({ ...ok, product: 'p9', repos: { p1: 'acme/r', p9: 'acme/s' } }), /the product p9 is not in the products list/);
  assert.match(channelProblem({ ...ok, owner: '' }), /owner/);
  assert.match(channelProblem({ ...ok, repos: { p1: 'me/bob-the-builder' } }), /Bob's own/);
  assert.match(channelProblem({ ...ok, products: ['p1', 'p2'], product: 'p2' }), /no repository for the product p2/);
  assert.match(channelProblem({ ...ok, repos: Object.create({ p1: 'acme/r' }) }), /no repository for the product p1/);
  const w = world();
  const r = await w.run({ repos: { p1: 'me/bob-the-builder' } });
  assert.match(r.refused, /^alert channel not set up: alerts never go to Bob's own repository/);
  assert.equal(w.gh.calls.length, 0);
  assert.throws(() => githubIssues({ repo: 'me/bob-the-builder', token: async () => ({ ok: true, token: 't' }) }), /Bob's own/);
});

test('L237, L288 MAT-3: with no token (the App not set up) the round says so and calls nothing; the store\'s own alert goes to this Record\'s product\'s repo, naming it', async () => {
  const w = world({ products: ['p1', 'p2'], product: 'p2' });
  const fetched = [];
  const fetchFn = async (url, o) => {
    fetched.push(url);
    return o.method === 'GET' ? { status: 200, json: async () => [] } : { status: 201, json: async () => ({ number: 1 }) };
  };
  const nb = { ...w.bound, issuesFor: undefined, fetchFn };
  let r = await deliverAlertsPass({ ...nb, rec: w.rec, token: async () => ({ ok: false, reason: 'no key file' }) });
  assert.equal(r.refused, 'alert channel not set up: no key file');
  r = await deliverAlertsPass({ ...nb, rec: w.rec, token: async () => { throw new Error('mint broke'); } });
  assert.equal(r.refused, 'alert channel not set up: mint broke');
  r = await deliverAlertsPass({ ...nb, rec: w.rec });
  assert.equal(r.refused, 'alert channel not set up: no token');
  assert.deepEqual(fetched, []);
  // One Record per product: the store's own alert goes to this product's repo, like the Record's queue (L288 MAT-3).
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), `${JSON.stringify({ id: 'u1', outcome: 'unsent', event: { type: 'tamper', entity: 'card' } })}\n`);
  outbox(w.rec, T0)('p2 thing');
  const tokens = [];
  r = await deliverAlertsPass({ ...nb, rec: w.rec, probe: ALIVE, token: async () => { tokens.push(1); return { ok: true, token: 'fake-installation-token' }; } });
  assert.equal(r.sent, 2);
  assert.equal(tokens.length, 1, 'the token is minted once per round');
  const posts = fetched.filter((u) => u.endsWith('/issues'));
  assert.deepEqual(posts, ['https://api.github.com/repos/acme/product-2/issues', 'https://api.github.com/repos/acme/product-2/issues']);
});

test('githubIssues: fixed host, the contract alerts.mjs reads, and findOpen skips pull requests and other issues', async () => {
  const seen = [];
  const answers = [];
  const fetchFn = async (url, init) => { seen.push([init.method, url, init.headers.authorization, init.body && JSON.parse(init.body)]); const [status, json] = answers.shift(); return { status, json: async () => json }; };
  const robot = 'robot[bot]';
  const gh = githubIssues({ repo: 'acme/r', owner: 'o', token: async () => ({ ok: true, token: 'tok', login: robot }), fetchFn });
  answers.push([201, { number: 7 }]);
  assert.equal(await gh.open({ title: 't', body: 'b', assignee: 'o' }), 7);
  assert.deepEqual(seen[0], ['POST', 'https://api.github.com/repos/acme/r/issues', 'Bearer tok', { title: 't', body: 'b', assignees: ['o'] }]);
  answers.push([201, { number: 8 }]);
  assert.equal(await gh.open({ title: 't', body: 'b', labels: ['orch-alert'] }), 8);
  assert.deepEqual(seen.at(-1)[3], { title: 't', body: 'b', labels: ['orch-alert'] }, 'labels reach GitHub');
  answers.push([422, null]);
  assert.equal(await gh.open({ title: 't', body: 'b' }), false);
  answers.push([201, { nope: 1 }]);
  assert.equal(await gh.open({ title: 't', body: 'b' }), false, 'no issue number is a lost write');
  answers.push([200, {}]); assert.equal(await gh.edit(7, 'x'), true);
  answers.push([403, null]); assert.equal(await gh.edit(7, 'x'), false);
  answers.push([201, {}], [200, {}]); assert.equal(await gh.close(7, 'bye'), true);
  answers.push([500, null]); assert.equal(await gh.close(7, 'bye'), false, 'no close after a refused comment');
  answers.push([200, {}]); assert.equal(await gh.close(7, null), true, 'r4 m1: no text, no comment: one PATCH is all it asks for');
  // A comment answers GitHub's time for it, or false.
  answers.push([201, { created_at: '2026-11-03T01:00:00Z' }]); assert.deepEqual(await gh.comment(7, 'x'), { at: '2026-11-03T01:00:00Z' });
  answers.push([201, {}]); assert.deepEqual(await gh.comment(7, 'x'), { at: undefined });
  answers.push([403, null]); assert.equal(await gh.comment(7, 'x'), false);
  await assert.rejects(gh.edit(0, 'x'), /not an issue number/);
  const bot = { user: { login: robot, type: 'Bot' } };
  const mark = lockedMarker('p1');
  const isMark = lineIs(mark);
  answers.push([200, [{ number: 3, body: `x\n${mark}`, pull_request: {}, ...bot }, { number: 4, body: 'other', ...bot }, { number: 5, body: `y\n${mark}`, ...bot }]]);
  assert.equal(await gh.findOpen(isMark), 5);
  assert.match(seen.at(-1)[1], /\/issues\?state=open&creator=robot%5Bbot%5D&per_page=100&page=1$/);
  answers.push([200, []]); assert.equal(await gh.findOpen(isMark), null);
  answers.push([401, null]); assert.equal(await gh.findOpen(isMark), false);
  const none = githubIssues({ repo: 'acme/r', token: async () => ({ ok: false, reason: 'no key' }), fetchFn });
  await assert.rejects(none.open({ title: 't', body: 'b' }), /alert channel not set up: no key/);
});

test('L239/L240: the store\'s unsent alerts are raised and marked sent; a torn line is skipped; a failed mark is raised again on the same issue', async () => {
  const w = world();
  const f = join(w.root, 'unsent-alerts.jsonl');
  appendFileSync(f, `${JSON.stringify({ id: 'u1', outcome: 'unsent', event: { type: 'tamper', entity: 'card', id: 'C-1' } })}\n{"id":"u2","outc\n`);
  appendFileSync(f, `${JSON.stringify({ id: 'u3', outcome: 'unsent', event: { type: 'torn_line' } })}\n${JSON.stringify({ id: 'u3', outcome: 'sent', at: 'x' })}\n`);
  assert.deepEqual(readUnsent(w.root).map((x) => x.id), ['u1']);
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.sent, 1);
  // L732 m1: each value is fenced as outside text.
  assert.match(w.gh.issues.get(1).body, /^p1's Record store: tamper\nentity: <outside-text source="log-line">card<\/outside-text>\nid: <outside-text source="log-line">C-1<\/outside-text>/);
  assert.deepEqual(readUnsent(w.root), []);
  assert.equal((await w.run({ probe: ALIVE })).sent, 0, 'marked: not raised again');
  // A mark that can't be written (the file replaced by a folder after the read): raised again, editing the same issue.
  const v = world();
  appendFileSync(join(v.root, 'unsent-alerts.jsonl'), `${JSON.stringify({ id: 'u9', outcome: 'unsent', event: { type: 'tamper' } })}\n`);
  const pass1 = await v.run({ probe: ALIVE, now: () => T0 });
  assert.equal(pass1.sent, 1);
  // Undo the mark to stand for a lost one, then run again: the same key edits issue 1, no second issue.
  writeFileSync(join(v.root, 'unsent-alerts.jsonl'), `${JSON.stringify({ id: 'u9', outcome: 'unsent', event: { type: 'tamper' } })}\n`);
  assert.equal((await v.run({ probe: ALIVE })).sent, 1);
  assert.equal(v.gh.issues.size, 1);
  assert.deepEqual(v.gh.issues.get(1).comments, [], 'a retry of the same entry is a silent edit, not a second notice');
});

test('L240: a real store\'s lost alert is delivered by the channel, and the store\'s own resend then stays quiet', async () => {
  let mode = 'false';
  const alert = fakeAlert({ answer: () => mode !== 'false' });
  const env = setup({ prefix: 'm13-chan-store-', extra: { alert } });
  seed(env, 'card', 'C-1', { state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 });
  seed(env, 'card', 'C-1', { state: 'draft', product: PRODUCT, module: 'M2', kind: 'ordinary', round: 1 });
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(env.root, 'docs', 'card', 'C-1.json'));
  env.record.write({ actor: 'approvals', entity: 'card', id: 'C-1', expectRev: 2, doc: { state: 'cancelled', product: PRODUCT, module: 'M2', kind: 'ordinary', round: 1, cancel_reason: 'x' } });
  assert.deepEqual(readUnsent(env.root).map((x) => x.event.type), ['tamper']);
  const gh = fakeGitHub();
  const r = await deliverAlertsPass({ rec: memoryRecord(), now: () => T0, recordRoot: env.root, product: PRODUCT, products: [PRODUCT], repos: { [PRODUCT]: 'acme/product-1' }, owner: 'owner-login', issuesFor: () => gh, lockWaitMs: 30 });
  assert.equal(r.sent, 1);
  assert.deepEqual(readUnsent(env.root), []);
  const before = alert.calls.length;
  env.store.transaction(() => null);
  assert.equal(alert.calls.length, before, 'the store does not resend what the channel delivered');
});

test('L236: nothing the Dispatcher runs imports the channel or the token code', () => {
  const dir = new URL('../M11-dispatcher/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.includes('.test'));
  assert.ok(files.includes('tick.mjs') && files.includes('main.mjs'));
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /alert-channel|M6-merge-gate\/token|token\.mjs/, f);
  const wired = deliverWith({ recordRoot: '/nowhere' });
  assert.equal(typeof wired, 'function');
});

test('deliverWith binds once and passes the round\'s rec and now', async () => {
  const w = world();
  outbox(w.rec, T0)('x');
  const deliver = deliverWith({ ...w.bound, probe: ALIVE });
  const r = await deliver({ rec: w.rec, now: () => T0 });
  assert.equal(r.sent, 1);
  // The round's own clock, not the wall's: a live holder 5 min old at the round's now is under the red limit.
  writeLock(w.root, holder(T0 - 5 * MIN));
  const l = await deliver({ rec: w.rec, now: () => T0 });
  assert.equal(l.locked, 'waiting');
});

// ---- L288: the fresh audit's findings ----

const notifying = (gh, from = 0) => gh.calls.slice(from).filter(([k]) => k === 'open' || k === 'comment');
const storeLine = (id, type = 'tamper') => `${JSON.stringify({ id, outcome: 'unsent', event: { type } })}\n`;

test('L288 MAT-1: a cause told, cleared and come back notifies exactly once; a body edit alone is never the only news', async () => {
  const w = world();
  const a = outbox(w.rec, T0);
  a('the phone link is down', { mark: { fact: 'stop-phone', fields: { n: 1 } } });
  await w.run({ probe: ALIVE });
  assert.equal(notifying(w.gh).length, 1, 'first told: one issue opened');
  // Three days later the same cause, with the same text, is queued again.
  w.tick(3 * 24 * 60);
  const before = w.gh.calls.length;
  outbox(w.rec, w.now())('the phone link is down', { mark: { fact: 'stop-phone', fields: { n: 2 } } });
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.sent, 1);
  assert.deepEqual(notifying(w.gh, before), [['comment', 1]], 'exactly one notifying action: a comment on the open issue');
  assert.match(w.gh.issues.get(1).comments[0], /^New alert: the phone link is down/);
  // The same for the store's own alerts: a new entry on the same key... (store keys are per entry, so each opens one)
  // and a cause whose issue Joe closed opens a new issue: also one notifying action.
  w.gh.ownerCloses(1);
  const b2 = w.gh.calls.length;
  outbox(w.rec, w.now())('the phone link is down', { mark: { fact: 'stop-phone', fields: { n: 3 } } });
  await w.run({ probe: ALIVE });
  assert.deepEqual(notifying(w.gh, b2), [['open', 2]]);
});

test('L288 MAT-2 a: an issue Joe deleted reads as closed through the real client: the next alert opens a new issue', async () => {
  const w = world();
  const live = new Map();
  let n = 0;
  const posted = [];
  const fetchFn = async (url, init) => {
    const m = /\/issues(?:\/(\d+))?(\/comments)?(\?.*)?$/.exec(url);
    const id = m[1] && Number(m[1]);
    const body = init.body ? JSON.parse(init.body) : null;
    let status = 404; let json = null;
    if (init.method === 'POST' && !id) { n += 1; live.set(n, { state: 'open', body: body.body, user: { login: 'robot[bot]', type: 'Bot' } }); posted.push(['open', n]); status = 201; json = { number: n }; }
    else if (init.method === 'GET' && !id) { status = 200; json = []; }
    else if (live.has(id)) {
      if (init.method === 'GET') { status = 200; json = live.get(id); }
      else if (init.method === 'PATCH') { Object.assign(live.get(id), body); status = 200; json = {}; }
      else if (m[2]) { posted.push(['comment', id]); status = 201; json = {}; }
    }
    return { status, json: async () => json };
  };
  const run = () => deliverAlertsPass({ ...w.bound, issuesFor: undefined, fetchFn, token: async () => ({ ok: true, token: 'fake', login: 'robot[bot]' }), rec: w.rec, now: w.now, probe: ALIVE });
  outbox(w.rec, T0)('cause', { mark: { fact: 'stop-x', fields: { n: 1 } } });
  assert.equal((await run()).sent, 1);
  live.delete(1); // Joe deletes issue 1: GitHub now answers 404 for it
  outbox(w.rec, T0)('cause', { mark: { fact: 'stop-x', fields: { n: 2 } } });
  for (let i = 0; i < 2; i += 1) {
    const r = await run();
    assert.equal(r.refused, undefined, JSON.stringify(r));
  }
  assert.deepEqual(posted, [['open', 1], ['open', 2]]);
  assert.deepEqual(queued(w.rec), []);
});

test('L288 MAT-2 b: an alert over GitHub\'s body limit is cut, says so, and is delivered', async () => {
  const w = world();
  const big = `huge alert\n${'x'.repeat(70_000)}`;
  outbox(w.rec, T0)(big);
  w.gh.open = ((open) => async (o) => (o.body.length > 65_536 ? false : open(o)))(w.gh.open);
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const body = w.gh.issues.get(1).body;
  assert.ok(body.length <= 65_536);
  assert.match(body, /\[cut: this alert was \d+ characters; the first 60000 are shown\]/);
  assert.equal(cutBody('short'), 'short');
  assert.equal(cutBody('y'.repeat(BODY_MAX)), 'y'.repeat(BODY_MAX));
});

test('L288 MAT-2 c, d: a Record alert GitHub refuses holds back neither the store\'s alerts nor the report: the round says refused', async () => {
  const w = world();
  const open = w.gh.open;
  w.gh.open = async (o) => (/refused one/.test(o.title) ? false : open(o));
  outbox(w.rec, T0)('the refused one');
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('u1', 'quarantine'));
  const r = await w.run({ probe: ALIVE });
  assert.equal(r.failed, 1);
  assert.equal(r.sent, 1, 'the store alert still went out');
  assert.match(w.gh.issues.get(1).body, /^p1's Record store: quarantine/);
  assert.deepEqual(readUnsent(w.root), []);
  assert.equal(queued(w.rec).length, 1, 'the refused one stays queued');
  assert.match(r.refused, /^1 alert\(s\) could not be delivered/);
});

test('L288 plants: a store send that answers false leaves the alert unmarked and the round refused; one refused store alert does not hold back the next', async () => {
  for (const lose of [async () => false, async () => { throw new Error('github down'); }]) {
    const w = world();
    const open = w.gh.open;
    w.gh.open = async (o) => (/s1kind/.test(o.title) ? lose() : open(o));
    appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('s1', 's1kind') + storeLine('s2', 'other'));
    const r = await w.run({ probe: ALIVE });
    assert.deepEqual([r.sent, r.failed], [1, 1]);
    assert.match(r.refused, /could not be delivered/);
    assert.deepEqual(readUnsent(w.root).map((x) => x.id), ['s1'], 'not marked sent before it was sent');
    assert.equal(r.storeLeft, 1);
    w.gh.open = open;
    const r2 = await w.run({ probe: ALIVE });
    assert.deepEqual([r2.sent, r2.failed, r2.refused], [1, 0, undefined]);
    assert.deepEqual(readUnsent(w.root), []);
  }
});

test('L288 plants: the store mark is written only after GitHub took the issue', async () => {
  const w = world();
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('m1'));
  const open = w.gh.open;
  let unsentAtOpen = null;
  w.gh.open = async (o) => { unsentAtOpen = readUnsent(w.root).map((x) => x.id); return open(o); };
  await w.run({ probe: ALIVE });
  assert.deepEqual(unsentAtOpen, ['m1'], 'still unmarked while the issue was being opened');
  assert.deepEqual(readUnsent(w.root), []);
});

test('L288 plants: a store backlog bigger than one round goes out over later rounds, oldest first, none dropped', async () => {
  const w = world();
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => storeLine(id, `kind-${id}`)).join(''));
  // Each issue write takes a second of the round's clock; a round's budget fits two.
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 1000;
  const rounds = [];
  for (let i = 0; i < 4 && readUnsent(w.root).length; i += 1) {
    const r = await w.run({ probe: ALIVE, clock, sendMs: 1000, budgetMs: 2500 });
    rounds.push([r.sent, r.storeLeft]);
  }
  assert.deepEqual(rounds, [[2, 3], [2, 1], [1, 0]]);
  assert.deepEqual([...w.gh.issues.values()].map((x) => x.title), ['p1\'s Record store: kind-b1', 'p1\'s Record store: kind-b2', 'p1\'s Record store: kind-b3', 'p1\'s Record store: kind-b4', 'p1\'s Record store: kind-b5']);
});

// A queue that can't shrink: every entry went out, but the Record refuses to take it off.
const stuckQueue = (w, n) => {
  for (let i = 0; i < n; i += 1) outbox(w.rec, T0)(`stuck alert ${i}`);
  return Object.create(w.rec, { write: { value: (x) => (x.id === ALERT_QUEUE_FACT ? { ok: false, reason: 'refused' } : w.rec.write(x)) } });
};

test('L558 M3: a stuck queue that fills the round leaves time for the store\'s lines', async () => {
  for (const [stuck, ms] of [[20, 300], [50, 300], [50, 150], [10, 600]]) {
    const w = world();
    const rec = stuckQueue(w, stuck);
    appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('k1', 'alert_not_queued'));
    const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * ms;
    await w.run({ rec, probe: ALIVE, clock });
    assert.deepEqual(readUnsent(w.root), [], `${stuck} stuck at ${ms} ms: the store's line went in the first round`);
  }
});

test('L558 M3: with nothing from the store waiting, the queue has the whole round', async () => {
  const w = world();
  for (let i = 0; i < 12; i += 1) outbox(w.rec, T0)(`alert ${i}`);
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 1000;
  const r = await w.run({ probe: ALIVE, clock, sendMs: 1000, budgetMs: 6000 });
  assert.equal(r.sent, 6);
});

test('L558 M3: store lines the round had no time for are named in `refused`', async () => {
  const w = world();
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => storeLine(id, `kind-${id}`)).join(''));
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 1000;
  const r = await w.run({ probe: ALIVE, clock, sendMs: 1000, budgetMs: 2500 });
  assert.equal(r.sent, 2);
  assert.match(r.refused, /3 of the store's unsent alerts had no time this round/);
});

test('L566 N1: a Record send that hangs every round still lets a store line go in each', async () => {
  for (const writable of [false, true]) {
    const w = world();
    const rec = writable ? w.rec : stuckQueue(w, 1);
    if (writable) outbox(w.rec, T0)('stuck alert 0');
    appendFileSync(join(w.root, 'unsent-alerts.jsonl'), ['h1', 'h2', 'h3'].map((id) => storeLine(id, `kind-${id}`)).join(''));
    const open = w.gh.open;
    // The time a round sees is this count, not the wall clock: at a budget of exactly two sends a real 30 ms hang can read
    // as 30 or 29, within budget, and every store line goes in one round (seen on #249's CI).
    let elapsed = 0;
    w.gh.open = (o) => {
      if (!/stuck alert/.test(`${o.title}${o.body}`)) return open(o);
      elapsed += 30;
      return new Promise(() => {});
    };
    for (let round = 3; round > 0; round -= 1) {
      await w.run({ rec, probe: ALIVE, sendMs: 30, budgetMs: 50, clock: () => elapsed });
      assert.equal(readUnsent(w.root).length, round - 1, `writable ${writable}: one store line a round`);
    }
  }
});

test('L566 N1: GitHub at 6 s a call, the store still gets a line out each round', async () => {
  const w = world();
  const rec = stuckQueue(w, 3);
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), ['g1', 'g2', 'g3'].map((id) => storeLine(id, `kind-${id}`)).join(''));
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 6000;
  for (let round = 3; round > 0; round -= 1) {
    await w.run({ rec, probe: ALIVE, clock });
    assert.equal(readUnsent(w.root).length, round - 1);
  }
});

test('L566 N1: past the budget only the one line goes: the rest wait and are named', async () => {
  const w = world();
  const rec = stuckQueue(w, 1);
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), ['o1', 'o2', 'o3'].map((id) => storeLine(id, `kind-${id}`)).join(''));
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 60000;
  const r = await w.run({ rec, probe: ALIVE, clock });
  assert.equal(readUnsent(w.root).length, 2);
  assert.match(r.refused, /2 of the store's unsent alerts had no time this round/);
});

test('L566 N2: a queue the round can\'t get through is named in `refused`', async () => {
  const w = world();
  const rec = stuckQueue(w, 60);
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 300;
  const r = await w.run({ rec, probe: ALIVE, clock });
  assert.ok(r.sent < 60);
  assert.match(r.refused, /60 alert\(s\) are still in the Record's queue after this round, which did not shrink it/);
});

test('L579: a backlog that is clearing fails no pass: a shrinking queue stays quiet', async () => {
  const w = world();
  for (let i = 0; i < 60; i += 1) outbox(w.rec, T0)(`alert ${i}`);
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 300;
  const r = await w.run({ probe: ALIVE, clock });
  assert.ok(queued(w.rec).length > 0 && queued(w.rec).length < 60, `${queued(w.rec).length} left`);
  assert.equal(r.refused ?? '', '');
});

test('L579: one stuck entry on its own is named', async () => {
  const w = world();
  const rec = stuckQueue(w, 1);
  assert.match((await w.run({ rec, probe: ALIVE })).refused, /1 alert\(s\) are still in the Record's queue/);
});

// L593: a delivered alert whose told mark the Record refuses stays on the queue (L527). It went out, so it isn't waiting.
const heldDelivered = async (w) => {
  const rec = Object.create(w.rec, { write: { value: (x) => (x.id === 'stop-m-1' ? { ok: false, reason: 'busy' } : w.rec.write(x)) } });
  tellThen(outbox(rec, w.now()), 'cause still stands', { fact: 'stop-m-1', fields: { told_at: new Date(w.now()).toISOString() }, kind: 'k' });
  await w.run({ rec, probe: ALIVE });     // delivered and held; the line about the mark arrives during this round
  w.tick(5);
  assert.equal((await w.run({ rec, probe: ALIVE })).refused ?? '', '', 'the line about the mark goes out');
  return rec;
};

test('L593: a delivered alert held on the queue fails no pass', async () => {
  const w = world();
  const rec = await heldDelivered(w);
  for (let i = 0; i < 4; i += 1) {
    w.tick(5);
    const left = queued(rec).length;
    assert.equal((await w.run({ rec, probe: ALIVE })).refused ?? '', '', `round ${i}`);
    assert.equal(left, 1, 'still held on the queue');
  }
});

test('L593: a stuck alert behind a held one is named, and only it is counted', async () => {
  const w = world();
  await heldDelivered(w);
  outbox(w.rec, w.now())('a stuck alert');
  const rec = Object.create(w.rec, { write: { value: (x) => (x.id === ALERT_QUEUE_FACT || x.id === 'stop-m-1' ? { ok: false, reason: 'refused' } : w.rec.write(x)) } });
  w.tick(5);
  assert.equal(queued(rec).length, 2);
  assert.match((await w.run({ rec, probe: ALIVE })).refused, /^1 alert\(s\) are still in the Record's queue/);
});

test('L566 N2: a queue that empties says nothing, and the one failed send is not counted twice', async () => {
  const w = world();
  outbox(w.rec, T0)('alert one');
  assert.equal((await w.run({ probe: ALIVE })).refused ?? '', '');
  const v = world();
  outbox(v.rec, T0)('alert two');
  v.gh.open = async () => { throw new Error('socket hang up'); };
  assert.doesNotMatch((await v.run({ probe: ALIVE })).refused, /still in the Record's queue/);
});

test('L566 A7: with store lines waiting the queue gets exactly half of what can be started', async () => {
  const w = world();
  for (let i = 0; i < 12; i += 1) outbox(w.rec, T0)(`alert ${i}`);
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('s1', 'kind-s1'));
  const clock = () => w.gh.calls.filter(([c]) => c !== 'findOpen').length * 1000;
  await w.run({ probe: ALIVE, clock, sendMs: 1000, budgetMs: 5000 });
  assert.equal(queued(w.rec).length, 9); // (5 s - 1 s) / 2 is held back, so 3 s: 3 sends start.
});

test('L288 plants: an unsent file that can\'t be read is refused, never read as empty (the channel and M9)', async () => {
  for (const make of [(f) => { rmSync(f); mkdirSync(f); }, (f) => { rmSync(f); writeFileSync(`${f}.real`, storeLine('z1')); symlinkSync(`${f}.real`, f); }]) {
    const w = world();
    const f = join(w.root, 'unsent-alerts.jsonl');
    make(f);
    assert.throws(() => readUnsent(w.root));
    const r = await w.run({ probe: ALIVE });
    assert.match(r.refused, /^the store's unsent alerts could not be read/);
    assert.equal(w.gh.issues.size, 0);
  }
});

test('L288 MAT-3: the store\'s alerts and the "Record is locked" issue go to this product\'s repo and name it; a Record of another product is refused', async () => {
  const w = world({ products: ['p1', 'p2'], product: 'p2' });
  const seen = [];
  w.bound.issuesFor = (repo) => { seen.push(repo); return w.gh; };
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), storeLine('u1', 'store_fault'));
  assert.equal((await w.run({ probe: ALIVE })).sent, 1);
  assert.match(w.gh.issues.get(1).title, /^p2's Record store: store_fault/);
  writeLock(w.root, holder(T0 - 30 * MIN));
  const l = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(l.locked, 'opened');
  assert.match(w.gh.issues.get(2).title, /^p2's Record is locked/);
  assert.ok(w.gh.issues.get(2).body.includes(lockedMarker('p2')));
  assert.deepEqual([...new Set(seen)], ['acme/product-2'], 'only p2\'s repository is ever used');
  // A Record whose product document is another product's: refused before any alert is sent.
  const v = world({ products: ['p1', 'p2'], product: 'p2' });
  v.rec.write({ actor: 'approvals', entity: 'product', id: 'p1', expectRev: 0, doc: { state: 'active' } });
  outbox(v.rec, T0)('x');
  const r = await v.run({ probe: ALIVE });
  assert.match(r.refused, /this Record holds product p1's state, not p2's/);
  assert.equal(v.gh.calls.length, 0);
  assert.equal(recordProductProblem(v.rec, 'p1'), null);
  // No product: refused, not defaulted to the first.
  const u = world({ products: ['p1', 'p2'] });
  assert.match((await u.run({ probe: ALIVE, product: undefined })).refused, /no product for this Record/);
});

test('L288: a lock holder whose start time is in the future is told at once, never "waiting"', async () => {
  const w = world();
  writeLock(w.root, holder(T0 + 3 * 60 * MIN));
  const r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(r.locked, 'opened');
  assert.match(w.gh.issues.get(1).body, /start time is in the future, so how long it has been held can't be told/);
});

// L298 (the #148 r2 audit's Minors): the auditor's probes N1–N3, N6, N7 made suite tests.
const markOf = (n) => ({ fact: 'stop-x', fields: { n } });

test('L298 Minor 2 (N1): different entries for the same cause, back to back with the issue open: each round notifies once', async () => {
  const w = world();
  const per = [];
  for (let i = 1; i <= 4; i++) {
    const b = w.gh.calls.length;
    outbox(w.rec, w.now())('same cause same text', { mark: markOf(i) });
    await w.run({ probe: ALIVE });
    per.push(notifying(w.gh, b).map((c) => c.join(':')).join(','));
    w.tick(1);
  }
  assert.deepEqual(per, ['open:1', 'comment:1', 'comment:1', 'comment:1']);
});

test('L298 Minor 2 (N2), L389: a crash after GitHub took the comment but before the alert state was saved repeats nothing: GitHub already holds that comment', async () => {
  const w = world();
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ probe: ALIVE });
  outbox(w.rec, w.now())('cause', { mark: markOf(2) });
  const comment = w.gh.comment;
  let crashed = false;
  w.gh.comment = async (i, t) => { await comment(i, t); if (!crashed) { crashed = true; throw new Error('the process died after GitHub took the comment'); } return true; };
  for (let i = 0; i < 4; i++) await w.run({ probe: ALIVE });
  assert.equal(w.gh.issues.get(1).comments.length, 1, 'the entry\'s one comment, and no repeat');
  assert.deepEqual(queued(w.rec), []);
});

test('L298 Minor 2 (N3): a crash between saving the alert state and the queue mark: the next round is a silent edit, one notice in all', async () => {
  const w = world();
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ probe: ALIVE });
  outbox(w.rec, w.now())('cause', { mark: markOf(2) });
  const write = w.rec.write.bind(w.rec);
  let refused = false;
  const rec = Object.fromEntries(Object.keys(w.rec).map((k) => [k, typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]]));
  rec.write = (o) => { if (!refused && o.id === ALERT_QUEUE_FACT && o.kind === 'alert_sent') { refused = true; return { ok: false, reason: 'crash' }; } return write(o); };
  const b = w.gh.calls.length;
  await w.run({ rec, probe: ALIVE });
  assert.equal(queued(w.rec).length, 1, 'the entry is still queued after the crash');
  await w.run({ rec, probe: ALIVE });
  assert.deepEqual(notifying(w.gh, b), [['comment', 1]]);
  assert.deepEqual(queued(w.rec), []);
});

test('L298 Minor 1 (N6): two products on one repository: each has its own locked issue, and one clearing leaves the other open', async () => {
  const gh = fakeGitHub();
  const a = world({ products: ['p1', 'p2'], product: 'p1', gh });
  const b = world({ products: ['p1', 'p2'], product: 'p2', gh });
  a.bound.repos = b.bound.repos = { p1: 'acme/shared', p2: 'acme/shared' };
  writeLock(a.root, holder(T0 - 30 * MIN));
  writeLock(b.root, holder(T0 - 30 * MIN));
  assert.equal((await a.run({ host: 'mac-a', probe: ALIVE })).locked, 'opened');
  assert.equal((await b.run({ host: 'mac-a', probe: ALIVE })).locked, 'opened');
  rmSync(join(a.root, 'lock'));
  await a.run({ host: 'mac-a', probe: ALIVE });
  assert.equal(gh.issues.size, 2);
  assert.equal(gh.issues.get(1).closed, true, 'p1\'s cleared');
  assert.equal(gh.issues.get(2).closed, false, 'p2\'s is still locked and its issue stays open');
  assert.ok(gh.issues.get(2).body.includes(lockedMarker('p2')));
  assert.ok(!gh.issues.get(2).body.includes(lockedMarker('p1')));
});

test('L298 Minor 4 (N7): an entry id used again after the queue\'s counter was reset still comments', async () => {
  const w = world();
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ probe: ALIVE });
  const cur = w.rec.read('fact', ALERT_QUEUE_FACT);
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: cur.rev, doc: { entries: [] }, kind: 'reset' });
  w.tick(5);
  outbox(w.rec, w.now())('cause', { mark: markOf(2) });
  assert.equal(queued(w.rec)[0].id, 'a1', 'the counter really restarted');
  const b = w.gh.calls.length;
  assert.equal((await w.run({ probe: ALIVE })).sent, 1);
  assert.deepEqual(notifying(w.gh, b), [['comment', 1]]);
});

test('L298 Minor 5: a round that leaves alerts queued names the first one and GitHub\'s answer, masked', async () => {
  // The real client: GitHub answers 422 to the issue write.
  const w = world();
  outbox(w.rec, T0)('merge gate: card C-9 is held');
  const fetchFn = async (url, o) => ({ status: o.method === 'GET' ? 200 : 422, json: async () => [] });
  const r = await w.run({ probe: ALIVE, issuesFor: undefined, token: async () => ({ ok: true, token: 'dummy-token', login: 'robot[bot]' }), fetchFn });
  assert.equal(r.failed, 1);
  assert.match(r.refused, /^1 alert\(s\) could not be delivered this round and stay queued for the next; the first, "merge gate: card C-9 is held": GitHub answered 422 to POST \/issues$/);
  // A store alert that throws: its title and the error.
  const v = world();
  v.gh.open = async () => { throw new Error('socket hang up'); };
  appendFileSync(join(v.root, 'unsent-alerts.jsonl'), storeLine('u1', 'store_fault'));
  assert.match((await v.run({ probe: ALIVE })).refused, /the first, "p1's Record store: store_fault": socket hang up$/);
  // A planted fake key in the alert never reaches the report.
  const FAKE_KEY = ['ghp', 'dummyFAKEkey0000xxxx'].join('_');
  const k = world();
  k.gh.open = async () => false;
  outbox(k.rec, T0)(`leaked ${FAKE_KEY} in a title`);
  const kr = await k.run({ probe: ALIVE });
  assert.ok(!kr.refused.includes(FAKE_KEY), kr.refused);
  assert.match(kr.refused, /GitHub refused the write$/);
});

test('L298 cosmetic: whose Record it is is checked before the lock, and a product that can\'t be read is named so', async () => {
  const w = world({ products: ['p1', 'p2'], product: 'p2' });
  w.rec.write({ actor: 'approvals', entity: 'product', id: 'p1', expectRev: 0, doc: { state: 'active' } });
  writeLock(w.root, holder(T0 - 30 * MIN));
  const r = await w.run({ host: 'mac-a', probe: ALIVE });
  assert.match(r.refused, /this Record holds product p1's state, not p2's/);
  assert.equal(r.locked, undefined);
  assert.equal(w.gh.calls.length, 0, 'a locked Record of another product tells no repository anything');
  const rec = { list: () => [{ id: null, doc: {} }] };
  assert.equal(recordProductProblem(rec, 'p2'), 'this Record\'s product can\'t be read, so it can\'t be told apart from p2\'s');
});

// The Record refusing to keep where an issue is, in delivery rounds: nothing is lost and nothing waits (L401). What it costs
// is reads, so two rounds running get one alert of their own (L402).
const refusingAlerts = (w, refuse = (o) => o.doc?.kind === 'fact.alert') => {
  const write = w.rec.write.bind(w.rec);
  const rec = Object.fromEntries(Object.keys(w.rec).map((k) => [k, typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]]));
  rec.write = (o) => (refuse(o) ? { ok: false, reason: 'the store is full' } : write(o));
  return rec;
};
const troubleOf = (gh) => [...gh.issues.values()].filter((x) => /refusing alert writes/.test(x.title));

test('L401: with the Record refusing, every round delivers and drains; the second raises one alert, and it clears once the Record takes a write', async () => {
  const w = world();
  const rec = refusingAlerts(w);
  for (let i = 1; i <= 6; i++) {
    outbox(w.rec, w.now())('cause', { mark: markOf(i) });
    const r = await w.run({ rec, probe: ALIVE });
    assert.deepEqual([r.sent, r.failed, r.refused], [1, 0, undefined], `round ${i}`);
    assert.deepEqual(queued(w.rec), []);
    assert.equal(troubleOf(w.gh).length, i === 1 ? 0 : 1, `round ${i}`);
    w.tick(10);
  }
  assert.equal(w.gh.calls.filter(([c]) => c === 'open').length, 2, 'the alert, and one about the Record');
  assert.match(troubleOf(w.gh)[0].body, /the store is full/);
  assert.match(troubleOf(w.gh)[0].title, /\(alert-channel\)$/, 'r5 m2: the round reports under its own name');
  outbox(w.rec, w.now())('cause', { mark: markOf(7) });
  await w.run({ probe: ALIVE });
  assert.equal(w.gh.calls.filter(([c]) => c === 'open').length, 2);
  assert.equal(troubleOf(w.gh)[0].closed, true);
});

test('L402: when the alert about the Record itself can\'t go out, the round says so and counts as failed', async () => {
  const w = world();
  const rec = refusingAlerts(w);
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ rec, probe: ALIVE });
  const { open } = w.gh;
  w.gh.lastAnswer = 'GitHub answered 503 to POST /issues';
  w.gh.open = async (o) => (/refusing alert writes/.test(o.title) ? false : open(o));
  outbox(w.rec, w.now())('cause', { mark: markOf(2) });
  let r = await w.run({ rec, probe: ALIVE });
  assert.equal(r.sent, 1);
  assert.match(r.refused, /the alert about the Record refusing writes did not go out: GitHub answered 503 to POST \/issues/);
  w.gh.open = async (o) => { if (/refusing alert writes/.test(o.title)) throw new Error('socket hang up'); return open(o); };
  outbox(w.rec, w.now())('cause', { mark: markOf(3) });
  r = await w.run({ rec, probe: ALIVE });
  assert.match(r.refused, /did not go out: socket hang up/);
});

test('L402: a clear the Record won\'t note, inside a retry, loses nothing: the footer holds it, and the entry goes out', async () => {
  const w = world();
  const line = `${JSON.stringify({ id: 'u9', outcome: 'unsent', event: { type: 'tamper' } })}\n`;
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), line);
  assert.equal((await w.run({ probe: ALIVE })).sent, 1);
  w.gh.ownerCloses(1);
  writeFileSync(join(w.root, 'unsent-alerts.jsonl'), line);
  const rec = refusingAlerts(w, (o) => o.doc?.status === 'cleared');
  const r = await w.run({ rec, probe: ALIVE });
  assert.deepEqual([r.sent, r.failed], [1, 0]);
  assert.equal(w.gh.issues.size, 2);
  assert.deepEqual(readUnsent(w.root), []);
});

// L402 condition: `owed` that can't be settled answers false, and the channel keeps the entry and stays red.
test('L402 owed: a notice stuck on a failed read is red every round, with GitHub\'s answer, and one comment over them all', async () => {
  const w = world();
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ probe: ALIVE });
  outbox(w.rec, w.now())('cause', { mark: markOf(2) });
  const { edit, latestOwnComment } = w.gh;
  let n = 0;
  w.gh.edit = async (...a) => { n += 1; return n === 2 ? false : edit(...a); };
  await w.run({ probe: ALIVE }); // the comment went out; the edit after it was lost
  w.gh.edit = edit;
  w.gh.lastAnswer = 'GitHub answered 403 to GET /issues/1/comments';
  w.gh.latestOwnComment = async () => false;
  for (let i = 0; i < 3; i++) {
    w.tick(10);
    const r = await w.run({ probe: ALIVE });
    assert.equal(r.failed, 1);
    assert.match(r.refused, /GitHub answered 403 to GET \/issues\/1\/comments/);
    assert.equal(queued(w.rec).length, 1);
  }
  assert.equal(w.gh.issues.get(1).comments.length, 1);
  w.gh.latestOwnComment = latestOwnComment;
  const r = await w.run({ probe: ALIVE });
  assert.deepEqual([r.sent, r.failed, r.refused], [1, 0, undefined]);
  assert.equal(w.gh.issues.get(1).comments.length, 1, 'found on GitHub, so not sent twice');
  assert.deepEqual(queued(w.rec), []);
});

// L399: the login comes with the token, and without it the round says what it fell back to.
test('L399: a token with no login: the alert still goes out, any bot counts, and the round is red, naming why', async () => {
  const w = world();
  outbox(w.rec, T0)('x');
  const fetchFn = async (url, o) => (o.method === 'GET' ? { status: 200, json: async () => [] } : { status: 201, json: async () => ({ number: 1 }) });
  const r = await w.run({ probe: ALIVE, issuesFor: undefined, fetchFn, token: async () => ({ ok: true, token: 'not-a-real-token', login: null, login_reason: 'GitHub answered 401 to GET /app' }) });
  assert.equal(r.sent, 1);
  assert.match(r.refused, /the robot's own login could not be read \(GitHub answered 401 to GET \/app\), so any bot's issue counted as the robot's this round/);
  const ok = world();
  outbox(ok.rec, T0)('x');
  const y = await ok.run({ probe: ALIVE, issuesFor: undefined, fetchFn, token: async () => ({ ok: true, token: 'not-a-real-token', login: 'robot[bot]' }) });
  assert.deepEqual([y.sent, y.refused], [1, undefined]);
});

// Through the real client.
function realClient(token = { ok: true, token: 'not-a-real-token', login: 'robot[bot]' }) {
  const answers = [];
  const asked = [];
  const fetchFn = async (url) => { asked.push(url); const [status, json] = answers.shift(); return { status, json: async () => json }; };
  return { answers, asked, gh: githubIssues({ repo: 'acme/product-1', token: async () => token, fetchFn }) };
}
const ROBOT = { login: 'robot[bot]', type: 'Bot' };
const closedBy = (closed_by) => [200, { state: 'closed', body: 'b', user: ROBOT, closed_by }];

test('L399, L402 githubIssues.read: the state, whose issue it is, and only a person\'s close counts as the owner\'s', async () => {
  const { answers, gh } = realClient();
  const closedByOwner = async (a) => { answers.push(a); return (await gh.read(7)).closedByOwner; };
  answers.push([200, { state: 'open', body: 'b', user: ROBOT, closed_by: null }]);
  assert.deepEqual(await gh.read(7), { open: true, body: 'b', ours: true, closedByOwner: false, created_at: null });
  answers.push([200, { state: 'open', body: null, user: ROBOT }]);
  assert.equal((await gh.read(7)).body, '');
  assert.equal(await closedByOwner(closedBy({ login: 'owner-login', type: 'User' })), true, 'the owner');
  assert.equal(await closedByOwner(closedBy(ROBOT)), false, 'the robot');
  assert.equal(await closedByOwner(closedBy({ login: 'robot[bot]', type: 'User' })), false, 'the robot, however it is typed');
  assert.equal(await closedByOwner(closedBy({ login: 'other-app[bot]', type: 'Bot' })), false, 'another app');
  assert.equal(await closedByOwner(closedBy({ login: 'owner-login' })), false, 'no type');
  assert.equal(await closedByOwner(closedBy({ type: 'User' })), false, 'no login');
  assert.equal(await closedByOwner(closedBy(null)), false, 'nobody named');
  answers.push([200, { state: 'open', body: 'b', user: { login: 'other-app[bot]', type: 'Bot' } }]);
  assert.equal((await gh.read(7)).ours, false, 'another app\'s');
  answers.push([200, { state: 'open', body: 'b', user: { login: 'someone', type: 'User' } }]);
  assert.equal((await gh.read(7)).ours, false, 'a stranger\'s');
  answers.push([200, { state: 'open', body: 'b' }]);
  assert.equal((await gh.read(7)).ours, false, 'no author');
  for (const [status, json, want] of [[404, null, null], [410, null, null], [502, null, false], [500, { state: 'open' }, false], [200, null, false]]) {
    answers.push([status, json]);
    assert.equal(await gh.read(7), want, String(status));
  }
});

test('r5 m1: a round with nothing to send still says the login is unknown, and a token it can\'t get stops nothing', async () => {
  const w = world();
  const gh = { ...w.gh, loginTrouble: null, ready: async () => { gh.loginTrouble = 'the robot\'s own login could not be read'; } };
  assert.match((await w.run({ probe: ALIVE, issuesFor: () => gh })).refused, /could not be read/);
  const { gh: noToken } = realClient({ ok: false, reason: 'no key' });
  await noToken.ready();
  assert.equal(noToken.loginTrouble, null);
});

test('L399 githubIssues: without the login any bot counts as the robot, a person never does, and it says why', async () => {
  const { answers, gh, asked } = realClient({ ok: true, token: 'not-a-real-token', login: null, login_reason: 'GitHub answered 401 to GET /app' });
  assert.equal(gh.loginTrouble, null, 'nothing asked yet');
  await gh.ready();
  assert.match(gh.loginTrouble, /GitHub answered 401 to GET \/app/, 'r5 m1: ready learns it with no GitHub call');
  assert.equal(asked.length, 0);
  answers.push([200, { state: 'open', body: 'b', user: { login: 'other-app[bot]', type: 'Bot' } }]);
  assert.equal((await gh.read(7)).ours, true);
  assert.match(gh.loginTrouble, /GitHub answered 401 to GET \/app/);
  answers.push([200, { state: 'open', body: 'b', user: { login: 'someone', type: 'User' } }]);
  assert.equal((await gh.read(7)).ours, false);
  answers.push(closedBy({ login: 'owner-login', type: 'User' }));
  assert.equal((await gh.read(7)).closedByOwner, true);
  const MARK = '<!-- alert-key alert-1 -->';
  answers.push([200, [{ number: 4, body: MARK, user: { type: 'Bot', login: 'other-app[bot]' } }]]);
  assert.equal(await gh.findOpen(lineIs(MARK)), 4);
  assert.ok(!asked.at(-1).includes('creator='), 'no filter without a login');
  const known = realClient();
  known.answers.push([200, { state: 'open', body: 'b', user: ROBOT }]);
  await known.gh.read(7);
  assert.equal(known.gh.loginTrouble, null);
});

test('L393, L399 githubIssues.findOpen: the robot\'s issue on any page, never another\'s or a marker that isn\'t the last line, and a reason when there are too many', async () => {
  const { answers, asked, gh } = realClient();
  const MARK = '<!-- alert-key alert-1 -->';
  const test = lineIs(MARK);
  const other = (number) => ({ number, body: 'something else', user: { type: 'User', login: 'someone' } });
  const full = Array.from({ length: 100 }, (_, i) => other(i + 100));
  answers.push([200, [{ number: 9, body: MARK, user: { type: 'User', login: 'someone' } }]]);
  assert.equal(await gh.findOpen(test), null, 'a stranger quoted it');
  answers.push([200, [{ number: 9, body: MARK, user: { type: 'Bot', login: 'other-app[bot]' } }]]);
  assert.equal(await gh.findOpen(test), null, 'another app carries it');
  answers.push([200, [{ number: 9, body: `${MARK}\nand some text after it`, user: ROBOT }]]);
  assert.equal(await gh.findOpen(test), null, 'not the last line');
  answers.push([200, full], [200, [{ number: 8, body: MARK, user: ROBOT }]]);
  assert.equal(await gh.findOpen(test), 8, 'on the second page, whoever it is assigned to');
  assert.match(asked.at(-1), /&page=2$/);
  for (let i = 0; i < 10; i++) answers.push([200, full]);
  assert.equal(await gh.findOpen(test), false);
  assert.match(gh.lastAnswer, /more than 1000 open issues/);
});

test('L389 githubIssues.latestOwnComment: only the robot\'s comments, every page, and false when it can\'t read them all', async () => {
  const answers = [];
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const [status, json] = answers.shift();
    return { status, json: async () => json };
  };
  const gh = githubIssues({ repo: 'acme/product-1', owner: 'owner-login', token: async () => ({ ok: true, token: 'not-a-real-token', login: 'robot[bot]' }), fetchFn });
  const said = (login, at, body) => ({ user: { login }, created_at: at, body });
  const SINCE = '2026-11-02T08:00:00.000Z';
  answers.push([200, [said('robot[bot]', '2026-11-03T01:00:00Z', 'old'), said('someone', '2026-11-03T02:00:00Z', 'not me'), said('robot[bot]', '2026-11-03T01:30:00Z', 'new')]]);
  assert.deepEqual(await gh.latestOwnComment(7, SINCE), { at: '2026-11-03T01:30:00Z', body: 'new' });
  assert.ok(asked[0].includes(`/issues/7/comments?since=${encodeURIComponent(SINCE)}&per_page=100&page=1`));
  answers.push([200, [said('someone', '2026-11-03T02:00:00Z', 'not me')]]);
  assert.equal(await gh.latestOwnComment(7, SINCE), null);
  const flood = Array.from({ length: 100 }, () => said('someone', '2026-11-03T02:00:00Z', 'flood'));
  answers.push([200, flood], [200, [said('robot[bot]', '2026-11-03T03:00:00Z', 'on page two')]]);
  assert.deepEqual(await gh.latestOwnComment(7, SINCE), { at: '2026-11-03T03:00:00Z', body: 'on page two' });
  answers.push(...Array.from({ length: 10 }, () => [200, flood]));
  assert.equal(await gh.latestOwnComment(7, SINCE), false, 'more than it will read');
  assert.match(gh.lastAnswer, /more than 1000 comments on issue 7/, 'not "answered 200" (L393 m1)');
  answers.push([500, null]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
  answers.push([403, null]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
  answers.push([200, [said('robot[bot]', 'no time', 'x')]]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
});

// ---- L620: warnings the store holds in this process only (a full disk) ----
const withHeld = (rec, h) => ({ ...rec, heldHere: typeof h === 'function' ? h : () => h });
const HELD = { held: [{ id: 'abcd0001', event: { at: '2026-11-03T08:00:00Z', type: 'diary_damaged', reason: 'a broken line' } }], dropped: 0 };

test('L620: a held warning is sent from the pass, on its own key, and the round is still not clean', async () => {
  const w = world();
  const r = await w.run({ rec: withHeld(w.rec, HELD) });
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.held, 1);
  assert.match(r.refused, /1 of the store's warnings could not be written to its disk \(is it full\?\) and are held in this process only \(1 sent this round\)/);
  const open = w.gh.openIssues();
  assert.equal(open.length, 1);
  assert.match(open[0].body, /diary_damaged/);
  assert.match(open[0].body, /a broken line/);
  // Next round: still held, raised again on the same key, so the same issue, not a second.
  w.tick(5);
  const r2 = await w.run({ rec: withHeld(w.rec, HELD) });
  assert.match(r2.refused, /held in this process only/);
  assert.equal(w.gh.openIssues().length, 1);
});

test('L620: a held warning GitHub refuses is a failed send, named, and the held line stays', async () => {
  const w = world();
  w.gh.open = async () => { throw new Error('GitHub is down'); };
  const r = await w.run({ rec: withHeld(w.rec, HELD) });
  assert.equal(r.failed, 1);
  assert.match(r.refused, /could not be delivered this round/);
  assert.match(r.refused, /GitHub is down/);
  assert.match(r.refused, /\(0 sent this round\)/);
});

test('L620: dropped kept-back counts alone make the round not clean', async () => {
  const w = world();
  const r = await w.run({ rec: withHeld(w.rec, { held: [], dropped: 3 }) });
  assert.equal(r.sent, 0);
  assert.match(r.refused, /3 count\(s\) of alerts the Record's queue would not take could not be written to the store's disk and are lost/);
  assert.doesNotMatch(r.refused, /held in this process only/);
});

test('L620: a heldHere that throws is a refusal; one that answers null or none adds nothing', async () => {
  const w = world();
  const r = await w.run({ rec: withHeld(w.rec, () => { throw new Error('boom'); }) });
  assert.match(r.refused, /what the store holds in memory could not be read: boom/);
  for (const h of [null, { held: [], dropped: 0 }]) {
    const w2 = world();
    const r2 = await w2.run({ rec: withHeld(w2.rec, h) });
    assert.equal(r2.refused, undefined, JSON.stringify(h));
    assert.equal(r2.held, undefined);
  }
  const w3 = world();
  assert.equal((await w3.run()).refused, undefined, 'a Record with no heldHere at all');
});

// ---- #260 r1: a store disk that can't take a write, a store answer that can't be read, and a held line flushed ----
test('#260 r1 M2: a store disk that can\'t take a write makes the round not clean, with nothing held here', async () => {
  const w = world();
  const r = await w.run({ rec: withHeld(w.rec, { held: [], dropped: 0, disk: 'the store\'s disk is full (ENOSPC)' }) });
  assert.equal(r.sent, 0);
  assert.match(r.refused, /the store's disk is full \(ENOSPC\): a warning any process on this store raises now \(the Dispatcher too\) may be held in that process's memory only/);
  assert.doesNotMatch(r.refused, /held in this process only/);
  const ok = world();
  assert.equal((await ok.run({ rec: withHeld(ok.rec, { held: [], dropped: 0, disk: null }) })).refused, undefined, 'a disk that takes writes adds nothing');
});

test('#260 r1 m1: a store answer that can\'t be read ({ error }, as makeRecord gives for a throw or a bad shape) is a refusal', async () => {
  const w = world();
  const r = await w.run({ rec: withHeld(w.rec, { error: 'the store\'s answer has a shape this does not know' }) });
  assert.match(r.refused, /what the store holds in memory could not be read: the store's answer has a shape this does not know/);
});

test('#260 r1 m2: the store is asked before its file is read, so a held line it puts back on file goes out this round', async () => {
  const w = world();
  const line = { id: 'back0001', outcome: 'unsent', event: { at: '2026-11-03T08:00:00Z', type: 'diary_damaged', reason: 'put back on file' } };
  const r = await w.run({ rec: withHeld(w.rec, () => { appendFileSync(join(w.root, 'unsent-alerts.jsonl'), `${JSON.stringify(line)}\n`); return { held: [], dropped: 0, disk: null }; }) });
  assert.equal(r.sent, 1);
  assert.equal(r.refused, undefined);
  assert.match(w.gh.openIssues()[0].body, /put back on file/);
  assert.equal(readUnsent(w.root).length, 0, 'and marked delivered');
});

// ---- #260 r2 M1 a: the held flag another process left (the Dispatcher exits after each pass) ----

const OTHER = process.pid + 100000;
const flagIn = (root, x = {}) => { makeHeldFlag(root); setHeldFlag(root, { pid: OTHER, at: '2026-11-05T08:00:00Z', held: 2, dropped: 0, id: 'abcd0009', event: { at: '2026-11-05T08:00:00Z', type: 'diary_damaged', reason: 'a broken line' }, ...x }); };

test('#260 r2 M1: another process\'s held flag is told once on the held key, cleared, and that round is not clean; the next is', async () => {
  const w = world();
  flagIn(w.root);
  const r = await w.run();
  assert.equal(r.sent, 1);
  assert.match(r.refused, new RegExp(`process ${OTHER} on this store held 2 warning\\(s\\) in its memory only at 2026-11-05T08:00:00Z, as the store's disk could not take them`));
  const open = w.gh.openIssues();
  assert.equal(open.length, 1);
  assert.equal(open[0].assignee, 'owner-login');
  assert.match(open[0].body, /a broken line/);
  assert.equal(readHeldFlag(w.root), null, 'cleared once told');
  w.tick(5);
  const r2 = await w.run();
  assert.equal(r2.refused, undefined, 'the next round is clean');
  assert.equal(w.gh.openIssues().length, 1);
});

test('#260 r2 M1: a flag GitHub refuses is a failed send, named, and the flag stays up for the next round', async () => {
  const w = world();
  flagIn(w.root);
  w.gh.open = async () => { throw new Error('GitHub is down'); };
  const r = await w.run();
  assert.equal(r.failed, 1);
  assert.match(r.refused, /GitHub is down/);
  assert.equal(readHeldFlag(w.root).flag.id, 'abcd0009');
});

test('#260 r2 M1: this process\'s own flag is left to its held list; a torn flag is a refusal, never clean', async () => {
  const w = world();
  flagIn(w.root, { pid: process.pid, token: newHeldToken() });
  const r = await w.run();
  assert.equal(r.refused, undefined);
  assert.equal(w.gh.openIssues().length, 0);
  assert.ok(readHeldFlag(w.root), 'not cleared from here');
  const w2 = world();
  makeHeldFlag(w2.root);
  writeFileSync(join(w2.root, 'held-flag'), '{"pid":4'.padEnd(4096, ' '));
  const r2 = await w2.run();
  assert.match(r2.refused, /the store's held flag is set but can't be read/);
});

test('#260 r2 M1: a flag with lost counts says so; one with no warning says none can be told from here', async () => {
  const w = world();
  flagIn(w.root, { held: 0, dropped: 3, id: null, event: null });
  const r = await w.run();
  assert.match(r.refused, /held 0 warning\(s\) .*, and lost 3 count\(s\) of alerts: none can be told from here/);
  assert.equal(readHeldFlag(w.root), null);
});

// ---- #260 r3: several holders in one flag; this process's own entry; a flag with no count ----

test('#260 r3 M1: a flag with several holders tells the first warning once and names every holder and the total', async () => {
  const w = world();
  flagIn(w.root, { token: 'x1' });
  setHeldFlag(w.root, { pid: OTHER + 1, token: 'x2', at: '2026-11-05T08:01:00Z', held: 1, dropped: 2, id: 'abcd0010', event: { type: 'diary_damaged', reason: 'the second' } });
  const r = await w.run();
  assert.equal(r.sent, 1, 'the first warning only');
  assert.match(w.gh.openIssues()[0].body, /a broken line/);
  assert.match(r.refused, new RegExp(`2 processes on this store held 3 warning\\(s\\) in all in their memory only, as the store's disk could not take them, and lost 2 count\\(s\\) of alerts \\(process ${OTHER} at 2026-11-05T08:00:00Z, 2; process ${OTHER + 1} at 2026-11-05T08:01:00Z, 1 and 2 lost\\): the first is told this round, and the others are lost if those processes have stopped`));
  assert.equal(readHeldFlag(w.root), null);
});

test('#260 r3 M1: this process\'s own entry is not told from the flag and stays in it after the clear; the others are told and cleared', async () => {
  const w = world();
  const mine = newHeldToken();
  flagIn(w.root, { pid: process.pid, token: mine });
  setHeldFlag(w.root, { pid: OTHER, token: 'x1', at: '2026-11-05T08:01:00Z', held: 1, dropped: 0, id: 'abcd0011', event: { type: 'diary_damaged', reason: 'theirs' } });
  const r = await w.run();
  assert.equal(r.sent, 0, 'the first warning is this process\'s own; the other\'s warning is not in the flag');
  assert.match(r.refused, new RegExp(`process ${OTHER} on this store held 1 warning\\(s\\) in its memory only at 2026-11-05T08:01:00Z, as the store's disk could not take them: the first is this process's own, told above, and none of the others' can be told from here`));
  assert.deepEqual(heldHolders(readHeldFlag(w.root).flag).map((h) => [h.pid, h.token]), [[process.pid, mine]], 'only this process\'s own entry is left');
  const r2 = await w.run();
  assert.equal(r2.refused, undefined, 'its own alone is left to its held list');
});

test('#260 r3 m1: a flag with this pid but a token no store here made is another process\'s (a reused pid), and is told', async () => {
  const w = world();
  flagIn(w.root, { pid: process.pid, token: 'not-made-here' });
  const r = await w.run();
  assert.equal(r.sent, 1);
  assert.equal(readHeldFlag(w.root), null);
});

test('#260 r3 c2: a flag with no usable count does not say "it is told this round" as if it held one', async () => {
  const w = world();
  makeHeldFlag(w.root);
  writeFileSync(join(w.root, 'held-flag'), JSON.stringify({ pid: OTHER, at: '2026-11-05T08:00:00Z', id: 'abcd0012', event: { type: 'diary_damaged', reason: 'r' } }).padEnd(4096, ' '));
  const r = await w.run();
  assert.equal(r.sent, 1);
  assert.match(r.refused, /held some warning\(s\) in its memory only.*: the first is told this round; how many it held is not known, and any others are lost if that process has stopped/);
  assert.doesNotMatch(r.refused, /it is told this round/);
});

test('#260 r3 M1: holders folded out of a full flag are counted in the round, never dropped', async () => {
  const w = world();
  flagIn(w.root, { token: 'x0', event: { type: 'diary_damaged', reason: 'r'.repeat(3000) } });
  for (let i = 1; i <= 120; i += 1) setHeldFlag(w.root, { pid: OTHER + i, token: `x${i}`, at: 'T', held: 1, dropped: 0 }, { settleMs: 0 });
  const f = readHeldFlag(w.root).flag;
  assert.ok(f.cut.holders > 0);
  const r = await w.run();
  assert.match(r.refused, /121 processes on this store held 122 warning\(s\) in all/);
  assert.match(r.refused, new RegExp(`${f.cut.holders} more not named, as the flag is full, ${f.cut.held}`));
});

test('#260 r4 m2 (P1): a flag holding only folded counts (no named holder) is told and cleared', async () => {
  const w = world();
  makeHeldFlag(w.root);
  const f = { gen: 9, pid: null, token: null, at: null, held: 0, dropped: 0, id: null, event: null, also: [], cut: { holders: 3, held: 4, dropped: 1 }, total: { holders: 3, held: 4, dropped: 1 } };
  writeFileSync(join(w.root, 'held-flag'), JSON.stringify(f).padEnd(4096, ' '));
  const r = await w.run();
  assert.match(r.refused ?? '', /3 processes on this store held 4 warning\(s\) in all in their memory only, as the store's disk could not take them, and lost 1 count\(s\) of alerts \(3 more not named, as the flag is full, 4 and 1 lost\): none can be told from here/);
  assert.equal(readHeldFlag(w.root), null, 'cleared once told');
});

test('#260 r4 m2 (P1): folded counts behind this process\'s own entry are still told, and only its own entry is kept', async () => {
  const w = world();
  makeHeldFlag(w.root);
  const mine = newHeldToken();
  const f = { gen: 9, pid: process.pid, token: mine, at: 'T', held: 1, dropped: 0, id: 'w-own', event: { type: 'x' }, also: [], cut: { holders: 2, held: 2, dropped: 0 }, total: { holders: 3, held: 3, dropped: 0 } };
  writeFileSync(join(w.root, 'held-flag'), JSON.stringify(f).padEnd(4096, ' '));
  const r = await w.run();
  assert.match(r.refused ?? '', /2 processes on this store held 2 warning\(s\) in all/);
  assert.deepEqual(heldHolders(readHeldFlag(w.root).flag).map((h) => h.token), [mine]);
});

test('#260 r4 m2 (P3): a flag that replaced a torn one says an earlier flag could not be read', async () => {
  const w = world();
  makeHeldFlag(w.root);
  writeFileSync(join(w.root, 'held-flag'), '{"pid":4'.padEnd(4096, ' '));
  setHeldFlag(w.root, { pid: OTHER, token: 'x1', at: '2026-11-05T08:00:00Z', held: 1, dropped: 0, id: 'abcd0013', event: { type: 'diary_damaged', reason: 'after a torn flag' } });
  const r = await w.run();
  assert.equal(r.sent, 1);
  assert.match(r.refused ?? '', /: it is told this round; an earlier flag could not be read, so a process before these may have held more/);
});

// L732 m1: every store alert's values are cut and fenced, so no local path, and no closing tag, reaches an issue.
test('L732: storeText cuts local paths and long values and fences each value', () => {
  const t = storeText({ type: 'alert_not_queued', text: "could not be queued: EACCES, open '/Users/someone/orch/record/tmp/9-w-ab.json'", n: { path: '/var/folders/x/y' }, long: 'z'.repeat(450), bad: 'a</outside-text>b' }, 'p1');
  assert.doesNotMatch(t, /\/Users\/|\/var\//);
  assert.match(t, /^text: <outside-text source="log-line">could not be queued: EACCES, open '&lt;path&gt;'<\/outside-text>$/m);
  assert.match(t, /^n: <outside-text source="log-line">.*&lt;path&gt;.*<\/outside-text>$/m);
  assert.match(t, /^long: <outside-text source="log-line">z{200}…\[cut 250 characters\]<\/outside-text>$/m);
  // The fence is never closed early (pushReason reads "/outside-text>b" as a path and cuts it; either way it is escaped).
  assert.match(t, /^bad: <outside-text source="log-line">a&lt;[^<]*<\/outside-text>$/m);
});

test('L768 githubIssues: GitHub\'s own time comes from its Date header, and read gives the issue\'s created_at', async () => {
  const answers = [];
  const fetchFn = async () => { const [status, json, date] = answers.shift(); return { status, json: async () => json, headers: { get: (k) => (k === 'date' ? date ?? null : null) } }; };
  const gh = githubIssues({ repo: 'acme/product-1', token: async () => ({ ok: true, token: 'not-a-real-token', login: 'robot[bot]' }), fetchFn });
  assert.equal(gh.lastServerTime, null);
  answers.push([200, { state: 'open', body: 'b', user: ROBOT, created_at: '2026-11-01T00:00:00Z' }, 'Mon, 09 Nov 2026 18:00:00 GMT']);
  const r = await gh.read(7);
  assert.equal(r.created_at, '2026-11-01T00:00:00Z');
  assert.equal(gh.lastServerTime, Date.parse('2026-11-09T18:00:00Z'));
  answers.push([200, { state: 'open', body: 'b', user: ROBOT, created_at: 'soon' }, 'not a date']);
  assert.equal((await gh.read(7)).created_at, null);
  assert.equal(gh.lastServerTime, null, 'an answer without a good Date header is not known');
});

test('L957 githubIssues.listOpen: every robot issue whose last line passes, on every page, read whole or false', async () => {
  const { answers, asked, gh } = realClient();
  const MARK = '<!-- orch:alert v1 key=alert-1 -->';
  const test = lineIs(MARK);
  const other = (number) => ({ number, body: 'something else', user: ROBOT });
  const full = Array.from({ length: 100 }, (_, i) => other(i + 100));
  full[3] = { number: 3, body: `text\n${MARK}`, user: ROBOT };
  full[4] = { number: 4, body: MARK, user: { type: 'User', login: 'someone' } };
  full[5] = { number: 5, body: MARK, user: { type: 'Bot', login: 'other-app[bot]' } };
  full[6] = { number: 6, body: `${MARK}\nafter`, user: ROBOT };
  full[7] = { number: 7, body: MARK, user: ROBOT, pull_request: {} };
  answers.push([200, full], [200, [{ number: 8, body: MARK, user: ROBOT }]]);
  assert.deepEqual(await gh.listOpen(test), [{ number: 3, body: `text\n${MARK}` }, { number: 8, body: MARK }]);
  assert.match(asked.at(-2), /state=open&creator=robot%5Bbot%5D&per_page=100&page=1$/);
  assert.match(asked.at(-1), /&page=2$/);
  answers.push([200, full], [502, null]);
  assert.equal(await gh.listOpen(test), false, 'a refused second page: not a part list');
  answers.push([200, { message: 'not a list' }]);
  assert.equal(await gh.listOpen(test), false);
  answers.push([200, [{ number: 'x', body: MARK, user: ROBOT }]]);
  assert.equal(await gh.listOpen(test), false, 'a matching issue with no number');
  for (let i = 0; i < 10; i++) answers.push([200, full]);
  assert.equal(await gh.listOpen(test), false);
  assert.match(gh.lastAnswer, /more than 1000 open issues/);
});
