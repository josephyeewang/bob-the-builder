// record-contract.test.mjs — LEAD-CALLS L72 (4) and (5): the Dispatcher's moves, made by its real steps against the
// real Record (M9 openRecord in a temp folder), not the stand-in. Every move kind M11 makes is covered: claim, start,
// launch refused, dead restart, review request, merge request and wait; plus the merge outcome it settles through
// M6 (L74 b3) and the L72 (5) planted cases. A step's write the real Record refuses fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatcherPass } from './pass.mjs';
import { actOnDead } from './tick.mjs';
import { timeLimits, requestMerges, MERGE_REQUEST } from './merges.mjs';
import { waitOn } from './moves.mjs';
import { outageStep, OUTAGE_FACT } from './outage.mjs';
import { USAGE_FACT } from './usage.mjs';
import { recWith, rulesWith, usageFact, withAlerts } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, outboxFile, passingVerdict, put, must, HEAD, PRODUCT, iso } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ACCT = 'acct-a';
const HOST = 'mac-a';   // the host M9's test record runs as: a claim from any other host is never broken here
const err = (code) => Object.assign(new Error(code), { code });
// A fake process table: `dead` pids answer ESRCH; every other pid is alive.
const fakeProbe = (dead) => ({ kill(pid) { if (dead.has(pid)) throw err('ESRCH'); }, pidStart: () => 'start' });
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const GREEN_BANDS = { band: 'green', own_building: 'open', pace: 0.5, prodBlocked: false };

function world() {
  const dead = new Set();
  const env = setup({ prefix: 'm11-contract-', probe: fakeProbe(dead), host: HOST });
  const rec = env.record;
  product(env);
  // M10's answer for a start: this file does not decide product state.
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  // Sensors' usage reading, green: the Dispatcher reads it, never writes it.
  must(rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: env.clock.t }) }), 'usage');
  const launched = [];
  let answer = () => ({ ok: true });
  let n = 0;
  const pass = () => withAlerts(rec, env.clock.t, () => {}, (alert) => dispatcherPass({
    rec, rules, now: env.clock.t, account: ACCT, sessions: [], probe: () => idle, host: HOST,
    // The launcher starts the session the claim names and reports its process (L72), as M4's does.
    launch: async (x) => { const a = answer(x); if (!a.ok) return a; n += 1; launched.push({ card: x.card.id, sessionId: x.sessionId, pid: 1000 + n }); return { ok: true, sessionId: x.sessionId, pid: 1000 + n, pidStart: 'start', pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: true }), filesOf: () => [], alert,
  }));
  return { env, rec, rules, dead, launched, pass, refuseLaunch: (f) => { answer = f; } };
}
const diaryKinds = (rec, id) => rec.diary().filter((l) => l.id === id).map((l) => l.kind);

test('L72 contract: claim and start: the pass claims a ready card naming its session, then adds the process at running', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  const r = await w.pass();
  assert.deepEqual(r.started, ['C-1']);
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'running');
  const [l] = w.launched;
  assert.deepEqual([c.claim.kind, c.claim.session_id, c.claim.host, c.claim.pid, c.claim.pid_start], ['session', l.sessionId, HOST, l.pid, 'start']);
  const kinds = diaryKinds(w.rec, 'C-1');
  assert.ok(kinds.indexOf('claim') >= 0 && kinds.indexOf('started') > kinds.indexOf('claim'), `claim, then start: ${kinds}`);
  // The launch record the Merge Gate counts from: the session the claim names.
  assert.equal(w.rec.read('launch', l.sessionId).doc.card, 'C-1');
  // A second pass starts nothing: the card is no longer in the Record's ready list.
  assert.deepEqual((await w.pass()).started, []);
});

test('L72 contract: launch refused: the claim is given back by its holder (M9 release) and the card is ready again', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  w.refuseLaunch(() => ({ ok: false, reason: 'no sign-in' }));
  const r = await w.pass();
  assert.deepEqual(r.started, []);
  assert.match(r.refused.find(([id]) => id === 'C-1')[1], /launcher: no sign-in/);
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  const rel = w.rec.diary().filter((l) => l.id === 'C-1').at(-1);
  assert.match(JSON.stringify(rel), /launcher: no sign-in/, 'the release carries the refusal as its reason');
  // Next pass, the launcher works: the card starts.
  w.refuseLaunch(() => ({ ok: true }));
  assert.deepEqual((await w.pass()).started, ['C-1']);
});

// The session record as the launcher keeps it: made preparing by the Dispatcher, ended by the workshop.
function endedSession(w, sid, card, pid) {
  must(w.rec.write({ actor: 'dispatcher', entity: 'session', id: sid, expectRev: 0, doc: { state: 'preparing', role: 'worker', card, pid, pid_start: 'start', last_activity: iso(w.env.clock.t) } }), 'session');
  must(put(w.rec, 'workshop', 'session', sid, { state: 'ended' }), 'session ended');
}

test('L72 contract: dead restart: a provably dead owner\'s claim is broken by the Record (breakIfDead), the card ready again', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  await w.pass();
  const [l] = w.launched;
  endedSession(w, l.sessionId, 'C-1', l.pid);
  // A live process: the Record refuses the break, and the card stays running (L72 (5): breakIfDead on a live pid).
  w.env.clock.t += 31 * MIN;
  const live = actOnDead({ rec: w.rec, now: w.env.clock.t, restart: [l.sessionId], asks: [], cards: { [l.sessionId]: 'C-1' } });
  assert.match(live[0][1], /not restarted: owner not provably dead \(process alive\)/);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'running');
  // The process is gone, the session ended, no activity past claims.stuck_min: broken.
  w.dead.add(l.pid);
  const done = actOnDead({ rec: w.rec, now: w.env.clock.t, restart: [l.sessionId], asks: [], cards: { [l.sessionId]: 'C-1' } });
  assert.deepEqual(done, [['C-1', 'ready again']]);
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  assert.equal(diaryKinds(w.rec, 'C-1').at(-1), 'claim_break');
});

test('L72 contract: wait: a dead session\'s card not safe to re-run waits on Joe, a running card going to waiting with its way back', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  await w.pass();
  const done = actOnDead({ rec: w.rec, now: w.env.clock.t, restart: [], asks: ['C-1'] });
  assert.deepEqual(done, [['C-1', 'waiting on Joe']]);
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'waiting');
  assert.deepEqual([c.wait.who, c.wait.resume, c.wait.return_to], ['joe', 'retry', 'ready']);
  assert.equal(c.claim, undefined, 'the claim does not carry into waiting');
  // A wait the Record would refuse is refused by waitOn before it writes (a who M9 does not list).
  assert.match(waitOn(w.rec, 'C-1', { who: 'owner', what: 'x', now: w.env.clock.t }).reason, /wait.who must be one of/);
});

// A running card handed in by its worker (the worker's outbox, M9's intake), with the head the workshop set.
async function inReview(w) {
  readyCard(w.env, 'C-1');
  await w.pass();
  const [l] = w.launched;
  must(put(w.rec, 'workshop', 'card', 'C-1', { head: HEAD }), 'head');
  must(w.rec.applyOutbox({ role: 'worker', sessionId: l.sessionId, card: 'C-1' }, outboxFile(w.env, 'worker', l.sessionId, 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)), 'hand-in');
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'in_review');
  return l;
}

test('L72 contract: review request: an in_review card with no reviewer is asked for one, its count in the Dispatcher\'s attempts', async () => {
  const w = world();
  await inReview(w);
  w.env.clock.t += 16 * MIN;
  const asked = [];
  const run = (requestReview) => timeLimits({ rec: w.rec, rules: w.rules, now: w.env.clock.t, b: GREEN_BANDS, running: [], gateAlive: () => true,
    hasReviewer: async () => false, requestReview, alert: () => {} });
  const done = await run(async (x) => { asked.push(x); return { ok: false, reason: 'runner down' }; });
  assert.deepEqual(done, [['C-1', 'reviewer request failed: runner down']]);
  assert.deepEqual(asked, [{ card: 'C-1', head: HEAD, role: 'reviewer' }]);
  const c = w.rec.read('card', 'C-1').doc;
  assert.deepEqual([c.state, c.attempts], ['in_review', { reviewer_starts: 1 }]);
  assert.equal(diaryKinds(w.rec, 'C-1').at(-1), 'review_request');
  // A second failure a full limit later, then the third goes to Joe: in_review → waiting.
  w.env.clock.t += 16 * MIN;
  await run(async () => ({ ok: false, reason: 'runner down' }));
  w.env.clock.t += 16 * MIN;
  const third = await run(async () => ({ ok: true }));
  assert.deepEqual(third, [['C-1', 'in_review->waiting']]);
  assert.deepEqual([w.rec.read('card', 'C-1').doc.state, w.rec.read('card', 'C-1').doc.wait.who], ['waiting', 'joe']);
});

test('L72 contract: merge request: a verified card with its PR and worker session gets one create-only request; M6 settles a timed-out merge', async () => {
  const w = world();
  const l = await inReview(w);
  passingVerdict(w.env, 'C-1', 'R-1', HEAD);
  must(put(w.env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
  // Sensors' PR reading at the card's head.
  must(w.rec.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: 0, doc: { type: 'pr', head_sha: HEAD, at: iso(w.env.clock.t) } }), 'pr reading');
  const args = { rec: w.rec, rules: w.rules, now: w.env.clock.t, b: GREEN_BANDS, running: [] };
  assert.deepEqual(requestMerges(args), [['C-1', 'merge requested']]);
  const { rev } = w.rec.read('card', 'C-1');
  const q = w.rec.read('merge_request', MERGE_REQUEST('C-1', HEAD, rev));
  assert.deepEqual([q.doc.card, q.doc.pr, q.doc.session_id, q.doc.head, q.doc.rev], ['C-1', 7, l.sessionId, HEAD, rev]);
  assert.deepEqual(requestMerges(args), [], 'one request per head and rev');
  // The gate takes it (merge_gate), the check runs past its limit: M6's settleMerge writes the refusal as merge_gate and
  // puts the card back (L74 b3); the Dispatcher writes no merge outcome itself.
  must(w.rec.write({ actor: 'merge_gate', entity: 'merge', id: 'MG-1', expectRev: 0, doc: { state: 'requested', card: 'C-1', pr: 7, head: HEAD, product: PRODUCT } }), 'merge requested');
  must(put(w.rec, 'merge_gate', 'merge', 'MG-1', { state: 'queued' }), 'merge queued');
  // The gate's one paired write: the merge enters checking as its card moves to merging (M6 gate.mjs).
  const mg = w.rec.read('merge', 'MG-1');
  const cd = w.rec.read('card', 'C-1');
  must(w.rec.write({ actor: 'merge_gate', entity: 'merge', id: 'MG-1', expectRev: mg.rev, doc: { ...mg.doc, state: 'checking', judged_head: HEAD },
    also: [{ entity: 'card', id: 'C-1', expectRev: cd.rev, doc: { ...cd.doc, state: 'merging' } }] }), 'merge checking, card merging');
  const writes = [];
  // Through the view that knows the review user (M9 fixtures: tests run as one Mac user, so the plain view can't tell the
  // reviewer's outbox from the worker's, and the Record would count no verdict for verified).
  const view = w.env.review;
  const spy = { ...view, write: (x) => { writes.push([x.actor, x.entity]); return view.write(x); } };
  w.env.clock.t += 31 * MIN;
  const done = await timeLimits({ ...args, rec: spy, now: w.env.clock.t, gateAlive: () => true, hasReviewer: async () => true, requestReview: async () => ({ ok: true }), alert: () => {} });
  assert.deepEqual(done, [['MG-1', 'refused:timeout'], ['C-1', '->verified']]);
  assert.deepEqual([w.rec.read('merge', 'MG-1').doc.state, w.rec.read('card', 'C-1').doc.state], ['refused', 'verified']);
  assert.deepEqual(w.rec.read('card', 'C-1').doc.attempts.merge_refusals, ['timeout']);
  assert.equal(writes.some(([a, e]) => a === 'dispatcher' && (e === 'merge' || e === 'card')), false, 'no Dispatcher write of a merge outcome');
});

// ---- L72 (5): the planted cases, on the real Record (and the stand-in where the case is the guard's) ----

test('L72 (5): a field outside the allow list is refused by both the real Record and the stand-in', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  const sneaky = (r) => { const c = r.read('card', 'C-1'); return r.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: c.rev, doc: { ...c.doc, rerun_safe: true } }); };
  const real = sneaky(w.rec);
  assert.equal(real.ok, false);
  assert.match(real.reason, /rerun_safe/);
  const s = sneaky(recWith([['card', 'C-1', { state: 'ready', product: 'p1', tier: 2, files: ['src/a.mjs'] }]]));
  assert.equal(s.ok, false);
  assert.match(s.reason, /rerun_safe/);
});

test('L72 (5): a claim with no process past claims.unlaunched_min lapses (once its session is stopped)', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  // The launcher never answers in time: the card stays claimed (no process), so it can't start twice.
  w.refuseLaunch(() => ({ ok: false, reason: 'it did not answer within 30000 ms' }));
  await w.pass();
  const c = w.rec.read('card', 'C-1').doc;
  assert.deepEqual([c.state, c.claim.pid], ['claimed', undefined]);
  w.env.clock.t += 60 * MIN;
  const stopped = [];
  const r = w.rec.lapseClaims(w.env.clock.t, { stopSession: (sid) => { stopped.push(sid); return true; } });
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']], JSON.stringify(r));
  assert.deepEqual(stopped, [c.claim.session_id]);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'ready');
  assert.equal(diaryKinds(w.rec, 'C-1').at(-1), 'claim_lapse');
});

test('L72 (5): a double claim for one card is refused', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  const before = w.rec.read('card', 'C-1');
  // The pass claims it and its launch is late: the card stays claimed, its claim naming the pass's session.
  w.refuseLaunch(() => ({ ok: false, reason: 'it did not answer within 30000 ms' }));
  await w.pass();
  const mine = w.rec.read('card', 'C-1').doc.claim.session_id;
  const other = { kind: 'session', session_id: 'S-other', host: HOST };
  // A second claimer that read the card while it was ready.
  const late = w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: before.rev, doc: { ...before.doc, state: 'claimed', claim: other } });
  assert.equal(late.ok, false);
  // One that re-reads and tries to take the claim over.
  const cur = w.rec.read('card', 'C-1');
  const swap = w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: cur.rev, doc: { ...cur.doc, claim: other } });
  assert.equal(swap.ok, false);
  assert.match(swap.reason, /a claim is set only by ready → claimed/);
  assert.equal(w.rec.read('card', 'C-1').doc.claim.session_id, mine);
  // The next pass does not start it a second time.
  w.refuseLaunch(() => ({ ok: true }));
  assert.deepEqual((await w.pass()).started, []);
  // The stand-in other tests use refuses the same take-over, by the same check (M9 claimCheck).
  const s = recWith([['card', 'C-1', { state: 'ready', product: 'p1', tier: 2, files: ['src/a.mjs'] }]]);
  const r0 = s.read('card', 'C-1');
  must(s.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: r0.rev, doc: { ...r0.doc, state: 'claimed', claim: { kind: 'session', session_id: 'S-1', host: HOST } } }), 'stand-in claim');
  const s1 = s.read('card', 'C-1');
  const sSwap = s.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: s1.rev, doc: { ...s1.doc, claim: other } });
  assert.equal(sSwap.ok, false);
  assert.match(sSwap.reason, /a claim is set only by ready → claimed/);
  assert.equal(s.read('card', 'C-1').doc.claim.session_id, 'S-1');
});

test('L72 (5): two dead out of ten is no outage; three dead out of five is', () => {
  const w = world();
  const gone = (id) => ({ id, card: null, alive: false, ended: true, lastWriteAt: w.env.clock.t - 10 * MIN });
  const live = (id) => ({ id, card: null, alive: true, ended: false, lastWriteAt: w.env.clock.t });
  const board = (d, a) => [...Array.from({ length: d }, (_, i) => gone(`D${i}`)), ...Array.from({ length: a }, (_, i) => live(`L${i}`))];
  const alerts = [];
  const two = outageStep({ rec: w.rec, rules: w.rules, board: board(2, 8), now: w.env.clock.t, healthy: true, alert: (a) => alerts.push(a) });
  assert.equal(two.outage, false);
  assert.equal(w.rec.read('fact', OUTAGE_FACT), null);
  const three = outageStep({ rec: w.rec, rules: w.rules, board: board(3, 2), now: w.env.clock.t, healthy: true, alert: (a) => alerts.push(a) });
  assert.equal(three.outage, true);
  assert.equal(w.rec.read('fact', OUTAGE_FACT).doc.state, 'open', 'the real Record takes the Dispatcher\'s outage fact');
  assert.equal(alerts.length, 1);
});
