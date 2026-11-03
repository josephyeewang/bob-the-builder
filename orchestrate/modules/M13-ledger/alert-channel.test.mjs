// alert-channel.test.mjs — the channel to Joe (L235–L245): the Record's alert queues become GitHub issues, from the
// robot job, with the Dispatcher dead or alive. Every GitHub call here is a fake; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { memoryRecord } from '../../shared/record.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { ALERT_QUEUE_FACT, outbox } from '../M11-dispatcher/alerts.mjs';
import { readUnsent } from '../M9-record/unsent.mjs';
import { setup, seed, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { RECORD_LOCKED_MARKER, channelProblem, deliverAlertsPass, deliverWith, entryKey, githubIssues, repoProblem } from './alert-channel.mjs';

const T0 = Date.parse('2026-11-03T08:00:00Z');
const MIN = 60_000;

// The GitHub stand-in, answering as the channel's client does (open → a number, edit/comment/close → true, findOpen →
// a number or null). It is not M13's fakeIssues, whose calls only succeed (L130): a test that needs a call lost swaps
// that method for one that answers false or throws (the L235 c test).
function fakeGitHub() {
  const issues = new Map();
  const calls = [];
  let n = 0;
  const gh = {
    calls, issues,
    async open({ title, body, assignee }) { n += 1; issues.set(n, { title, body, assignee, closed: false, comments: [] }); calls.push(['open', n]); return n; },
    async edit(i, body) { issues.get(i).body = body; calls.push(['edit', i]); return true; },
    async comment(i, text) { issues.get(i).comments.push(text); calls.push(['comment', i]); return true; },
    async close(i, text) { const x = issues.get(i); x.closed = true; x.comments.push(text); calls.push(['close', i]); return true; },
    async isClosed(i) {
      if (!Number.isSafeInteger(i) || i <= 0 || !issues.has(i)) throw new Error(`fakeGitHub.isClosed: no issue ${JSON.stringify(i)}`);
      return issues.get(i).closed;
    },
    async findOpen(marker) { calls.push(['findOpen']); for (const [k, x] of issues) if (!x.closed && x.body.includes(marker)) return k; return null; },
    ownerCloses(i) { issues.get(i).closed = true; },
    openIssues: () => [...issues.values()].filter((x) => !x.closed),
  };
  return gh;
}

function world({ products = ['p1'], product = 'p1', gh = fakeGitHub() } = {}) {
  const root = tempDir('m13-chan-');
  writeFileSync(join(root, 'unsent-alerts.jsonl'), '', { mode: 0o644 });
  let t = T0;
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

test('L242: a lock left by a dead process is broken by M9\'s rule, and the round delivers', async () => {
  const w = world();
  writeLock(w.root, holder(T0 - 60 * MIN));
  outbox(w.rec, T0)('x');
  const r = await w.run({ host: 'mac-a', probe: DEAD });
  assert.equal(r.refused, undefined);
  assert.equal(r.sent, 1);
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
  assert.match(w.gh.issues.get(1).body, /locked for 16 min by pid 4242; alerts are queued and not delivered/);
  assert.ok(w.gh.issues.get(1).body.includes(RECORD_LOCKED_MARKER));
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
  const ok = { products: ['p1'], repos: { p1: 'acme/r' }, owner: 'o' };
  assert.equal(channelProblem(ok), null);
  assert.match(channelProblem({ ...ok, owner: '' }), /owner/);
  assert.match(channelProblem({ ...ok, repos: { p1: 'me/bob-the-builder' } }), /Bob's own/);
  assert.match(channelProblem({ ...ok, product: 'p2' }), /no repository for the product p2/);
  assert.match(channelProblem({ ...ok, repos: Object.create({ p1: 'acme/r' }) }), /no repository for the product p1/);
  const w = world();
  const r = await w.run({ repos: { p1: 'me/bob-the-builder' } });
  assert.match(r.refused, /^alert channel not set up: alerts never go to Bob's own repository/);
  assert.equal(w.gh.calls.length, 0);
  assert.throws(() => githubIssues({ repo: 'me/bob-the-builder', token: async () => ({ ok: true, token: 't' }) }), /Bob's own/);
});

test('L237: with no token (the App not set up) the round says so and calls nothing; an alert without a product goes to the first product\'s repo', async () => {
  const w = world({ products: ['p1', 'p2'], product: 'p2' });
  const fetched = [];
  const fetchFn = async (url) => { fetched.push(url); return { status: 201, json: async () => ({ number: 1 }) }; };
  const nb = { ...w.bound, issuesFor: undefined, fetchFn };
  let r = await deliverAlertsPass({ ...nb, rec: w.rec, token: async () => ({ ok: false, reason: 'no key file' }) });
  assert.equal(r.refused, 'alert channel not set up: no key file');
  r = await deliverAlertsPass({ ...nb, rec: w.rec, token: async () => { throw new Error('mint broke'); } });
  assert.equal(r.refused, 'alert channel not set up: mint broke');
  r = await deliverAlertsPass({ ...nb, rec: w.rec });
  assert.equal(r.refused, 'alert channel not set up: no token');
  assert.deepEqual(fetched, []);
  // The store's own alert (no product) goes to the first product's repo; the Record's queue to its own product's.
  appendFileSync(join(w.root, 'unsent-alerts.jsonl'), `${JSON.stringify({ id: 'u1', outcome: 'unsent', event: { type: 'tamper', entity: 'card' } })}\n`);
  outbox(w.rec, T0)('p2 thing');
  const tokens = [];
  r = await deliverAlertsPass({ ...nb, rec: w.rec, probe: ALIVE, token: async () => { tokens.push(1); return { ok: true, token: 'fake-installation-token' }; } });
  assert.equal(r.sent, 2);
  assert.equal(tokens.length, 1, 'the token is minted once per round');
  const posts = fetched.filter((u) => u.endsWith('/issues'));
  assert.deepEqual(posts, ['https://api.github.com/repos/acme/product-2/issues', 'https://api.github.com/repos/acme/product-1/issues']);
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
  answers.push([404, null]); await assert.rejects(gh.isClosed(7), /404/);
  await assert.rejects(gh.edit(0, 'x'), /not an issue number/);
  answers.push([200, [{ number: 3, body: `x ${RECORD_LOCKED_MARKER}`, pull_request: {} }, { number: 4, body: 'other' }, { number: 5, body: `y ${RECORD_LOCKED_MARKER}` }]]);
  assert.equal(await gh.findOpen(RECORD_LOCKED_MARKER), 5);
  assert.match(seen.at(-1)[1], /\/issues\?state=open&per_page=100&assignee=o$/);
  answers.push([200, []]); assert.equal(await gh.findOpen(RECORD_LOCKED_MARKER), null);
  answers.push([401, null]); assert.equal(await gh.findOpen(RECORD_LOCKED_MARKER), false);
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
  assert.match(w.gh.issues.get(1).body, /The Record's store: tamper\nentity: card\nid: C-1/);
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
  const r = await deliverAlertsPass({ rec: memoryRecord(), now: () => T0, recordRoot: env.root, products: [PRODUCT], repos: { [PRODUCT]: 'acme/product-1' }, owner: 'owner-login', issuesFor: () => gh, lockWaitMs: 30 });
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
