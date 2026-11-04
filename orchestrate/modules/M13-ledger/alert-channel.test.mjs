// alert-channel.test.mjs — the channel to Joe (L235–L245): the Record's alert queues become GitHub issues, from the
// robot job, with the Dispatcher dead or alive. Every GitHub call here is a fake; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { memoryRecord } from '../../shared/record.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { ALERT_QUEUE_FACT, outbox } from '../M11-dispatcher/alerts.mjs';
import { readUnsent } from '../M9-record/unsent.mjs';
import { setup, seed, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { BODY_MAX, channelProblem, cutBody, deliverAlertsPass, deliverWith, entryKey, githubIssues, lockedMarker, recordProductProblem, repoProblem } from './alert-channel.mjs';

const T0 = Date.parse('2026-11-03T08:00:00Z');
const MIN = 60_000;

// The GitHub stand-in, answering as the channel's client does (open → a number, edit/comment/close → true, findOpen →
// a number or null). It is not M13's fakeIssues, whose calls only succeed (L130): a test that needs a call lost swaps
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
    async comment(i, text) { issues.get(i).comments.push(text); if (gh.clock) spoken.push({ i, at: new Date(gh.clock()).toISOString(), body: text }); calls.push(['comment', i]); return true; },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.comments.push(text); calls.push(['close', i]); return true; },
    async isClosed(i) {
      if (!Number.isSafeInteger(i) || i <= 0 || !issues.has(i)) throw new Error(`fakeGitHub.isClosed: no issue ${JSON.stringify(i)}`);
      return issues.get(i).closed;
    },
    async findOpen(marker) { calls.push(['findOpen']); for (const [k, x] of issues) if (!x.closed && x.body.includes(marker)) return k; return null; },
    async latestOwnComment(i, since) { return spoken.filter((c) => c.i === i && c.at >= since).at(-1) ?? null; },
    ownerCloses(i) { issues.get(i).closed = true; },
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
  const gh = { open: boom, edit: boom, comment: boom, close: boom, isClosed: boom, findOpen: boom };
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
  const gh = githubIssues({ repo: 'acme/r', owner: 'o', token: async () => ({ ok: true, token: 'tok' }), fetchFn });
  answers.push([201, { number: 7 }]);
  assert.equal(await gh.open({ title: 't', body: 'b', assignee: 'o' }), 7);
  assert.deepEqual(seen[0], ['POST', 'https://api.github.com/repos/acme/r/issues', 'Bearer tok', { title: 't', body: 'b', assignees: ['o'] }]);
  answers.push([422, null]);
  assert.equal(await gh.open({ title: 't', body: 'b' }), false);
  answers.push([201, { nope: 1 }]);
  assert.equal(await gh.open({ title: 't', body: 'b' }), false, 'no issue number is a lost write');
  answers.push([200, {}]); assert.equal(await gh.edit(7, 'x'), true);
  answers.push([403, null]); assert.equal(await gh.edit(7, 'x'), false);
  answers.push([201, {}], [200, {}]); assert.equal(await gh.close(7, 'bye'), true);
  answers.push([500, null]); assert.equal(await gh.close(7, 'bye'), false, 'no close after a refused comment');
  answers.push([200, { state: 'closed' }]); assert.equal(await gh.isClosed(7), true);
  // L288 MAT-2 a: deleted (410) or not found (404) reads as closed, so the next alert opens a new issue; others throw.
  answers.push([404, null]); assert.equal(await gh.isClosed(7), true);
  answers.push([410, null]); assert.equal(await gh.isClosed(7), true);
  answers.push([500, null]); await assert.rejects(gh.isClosed(7), /500/);
  await assert.rejects(gh.edit(0, 'x'), /not an issue number/);
  answers.push([200, [{ number: 3, body: `x ${lockedMarker('p1')}`, pull_request: {} }, { number: 4, body: 'other' }, { number: 5, body: `y ${lockedMarker('p1')}` }]]);
  assert.equal(await gh.findOpen(lockedMarker('p1')), 5);
  assert.match(seen.at(-1)[1], /\/issues\?state=open&per_page=100&assignee=o$/);
  answers.push([200, []]); assert.equal(await gh.findOpen(lockedMarker('p1')), null);
  answers.push([401, null]); assert.equal(await gh.findOpen(lockedMarker('p1')), false);
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
  assert.match(w.gh.issues.get(1).body, /^p1's Record store: tamper\nentity: card\nid: C-1/);
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
    if (init.method === 'POST' && !id) { n += 1; live.set(n, { state: 'open' }); posted.push(['open', n]); status = 201; json = { number: n }; }
    else if (init.method === 'GET' && !id) { status = 200; json = []; }
    else if (live.has(id)) {
      if (init.method === 'GET') { status = 200; json = live.get(id); }
      else if (init.method === 'PATCH') { if (body.state) live.get(id).state = body.state; status = 200; json = {}; }
      else if (m[2]) { posted.push(['comment', id]); status = 201; json = {}; }
    }
    return { status, json: async () => json };
  };
  const run = () => deliverAlertsPass({ ...w.bound, issuesFor: undefined, fetchFn, token: async () => ({ ok: true, token: 'fake' }), rec: w.rec, now: w.now, probe: ALIVE });
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
  const r = await w.run({ probe: ALIVE, issuesFor: undefined, token: async () => ({ ok: true, token: 'dummy-token' }), fetchFn });
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

// L389: the channel's rounds, with the Record refusing the alert's state. The entry stays queued and the round is red,
// saying so; GitHub's own state keeps it to one issue and one comment.
test('L389: a refused save in a delivery round: red, in plain words, the entry stays queued, one issue and one comment over many rounds', async () => {
  const w = world();
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  const write = w.rec.write.bind(w.rec);
  const rec = Object.fromEntries(Object.keys(w.rec).map((k) => [k, typeof w.rec[k] === 'function' ? w.rec[k].bind(w.rec) : w.rec[k]]));
  rec.write = (o) => (o.doc?.kind === 'fact.alert' ? { ok: false, reason: 'the store is full' } : write(o));
  for (let i = 0; i < 6; i++) {
    const r = await w.run({ rec, probe: ALIVE });
    assert.equal(r.failed, 1);
    assert.match(r.refused, /the Record refused to save this alert's state: the store is full/);
    w.tick(10);
  }
  assert.equal(w.gh.calls.filter(([c]) => c === 'open').length, 1);
  assert.equal(queued(w.rec).length, 1);
  outbox(w.rec, w.now())('cause', { mark: markOf(1) });
  await w.run({ probe: ALIVE });
  assert.equal(w.gh.calls.filter(([c]) => c === 'open').length, 1, 'once the Record takes it, the same issue goes on');
  assert.deepEqual(queued(w.rec), []);
});

test('L389 githubIssues.latestOwnComment: only the robot\'s comments, every page, and false when it can\'t read them all', async () => {
  const answers = [];
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const [status, json] = answers.shift();
    return { status, json: async () => json };
  };
  const gh = githubIssues({ repo: 'acme/product-1', owner: 'owner-login', token: async () => ({ ok: true, token: 'not-a-real-token' }), fetchFn });
  const robot = { user: { login: 'robot[bot]' } };
  const said = (login, at, body) => ({ user: { login }, created_at: at, body });
  const SINCE = '2026-11-02T08:00:00.000Z';
  answers.push([200, robot], [200, [said('robot[bot]', '2026-11-03T01:00:00Z', 'old'), said('someone', '2026-11-03T02:00:00Z', 'not me'), said('robot[bot]', '2026-11-03T01:30:00Z', 'new')]]);
  assert.deepEqual(await gh.latestOwnComment(7, SINCE), { at: '2026-11-03T01:30:00Z', body: 'new' });
  assert.ok(asked[1].includes(`/issues/7/comments?since=${encodeURIComponent(SINCE)}&per_page=100&page=1`));
  answers.push([200, robot], [200, [said('someone', '2026-11-03T02:00:00Z', 'not me')]]);
  assert.equal(await gh.latestOwnComment(7, SINCE), null);
  const flood = Array.from({ length: 100 }, () => said('someone', '2026-11-03T02:00:00Z', 'flood'));
  answers.push([200, robot], [200, flood], [200, [said('robot[bot]', '2026-11-03T03:00:00Z', 'on page two')]]);
  assert.deepEqual(await gh.latestOwnComment(7, SINCE), { at: '2026-11-03T03:00:00Z', body: 'on page two' });
  answers.push([200, robot], ...Array.from({ length: 10 }, () => [200, flood]));
  assert.equal(await gh.latestOwnComment(7, SINCE), false, 'more than it will read');
  answers.push([500, null]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
  answers.push([200, robot], [403, null]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
  answers.push([200, robot], [200, [said('robot[bot]', 'no time', 'x')]]);
  assert.equal(await gh.latestOwnComment(7, SINCE), false);
});
