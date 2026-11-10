// limit-wait.test.mjs — a card parked on a usage limit, end to end: the Sensors' real limit-hit writer, the Record's
// stand-in (whose guardWrite sets wait.run_started), and the Dispatcher's resume (MAT-1, audit #78 r2 probes A–G).
//
// The rule: a card resumes only on a hit observed after its run began (wait.run_started), once that hit's reset time
// has passed. Every limit wait that can't get there waits on Joe and is told: no run_started, a hit with no reset time,
// no hit for the run within timeouts.usage_unknown_max_min of the park.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFactWriter } from './facts.mjs';
import { writeUsageFact, writeLimitHit } from './state-facts.mjs';
import { dispatcherPass, LIMIT_FACT, LIMIT_NO_RUN, LIMIT_NO_RESET, LIMIT_NO_HIT } from '../M11-dispatcher/pass.mjs';
import { change, parkOnLimit, rulesWith, recWith, setClock, withAlerts, T0, MIN, iso } from '../M11-dispatcher/fixtures.test-helper.mjs';

const ACCT = 'a';
const DAY = 24 * 60 * MIN;
const clockAt = (ms) => () => new Date(ms);
const usageReading = (now) => ({ source: 'status-line', h5: { used_pct: 20, resets_at: iso(now + 60 * MIN) }, week: { used_pct: 30, resets_at: iso(now + 3 * DAY) } });

function world(entries = []) {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...entries]);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'deny', reason: 'no starts' }) });
  const told = [];
  const pass = async (now) => {
    setClock(rec, now);
    await writeUsageFact(makeFactWriter(rec), async () => usageReading(now), ACCT, { now: clockAt(now) });
    return withAlerts(rec, now, (a) => { told.push(a); return true; }, (alert) => dispatcherPass({ rec, rules, now, account: ACCT, sessions: [], probe: () => null,
      launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: () => [], alert }));
  };
  const hit = (account, resets_at, at, source = 'worker-exit') => writeLimitHit(makeFactWriter(rec), { account, resets_at, source }, { now: clockAt(at) });
  const card = (id) => rec.read('card', id).doc;
  const tellsFor = (id) => told.filter((a) => String(a?.text ?? a).startsWith(`card ${id}:`));
  return { rec, pass, hit, card, told, tellsFor };
}

test('stand-in: parked from its run, the wait carries the claim\'s time; a caller\'s run_started is dropped', () => {
  const w = world();
  parkOnLimit(w.rec, 'T2', { ranAt: T0, parkedAt: T0 + 20 * MIN, account: ACCT });
  assert.equal(w.card('T2').wait.run_started, iso(T0));
  assert.equal(w.card('T2').wait.since, iso(T0 + 20 * MIN));
  change(w.rec, 'card', 'T2', { wait: { ...w.card('T2').wait, run_started: iso(T0 + 50 * MIN), next_check: iso(T0 + 30 * MIN) } });
  assert.equal(w.card('T2').wait.run_started, iso(T0), 'a re-check keeps the Record\'s time');
});

test('probe A: park and hit in the same millisecond resume after the reset (the run began before both)', async () => {
  const w = world();
  parkOnLimit(w.rec, 'T2', { ranAt: T0, parkedAt: T0 + 40 * MIN, account: ACCT });
  await w.hit(ACCT, iso(T0 + 70 * MIN), T0 + 40 * MIN);
  await w.pass(T0 + 69 * MIN);
  assert.equal(w.card('T2').state, 'waiting');
  await w.pass(T0 + 71 * MIN);
  assert.equal(w.card('T2').state, 'ready');
});

test('probe B: a hit written before the park still counts: the order of the two writes no longer matters', async () => {
  const w = world();
  // The run began at T0; the worker's hit is written at +5 min, the park at +6.
  const r = await w.hit(ACCT, iso(T0 + 30 * MIN), T0 + 5 * MIN);
  assert.equal(r.ok, true, r.reason);
  parkOnLimit(w.rec, 'T2', { ranAt: T0, parkedAt: T0 + 6 * MIN, account: ACCT });
  await w.pass(T0 + 31 * MIN);
  assert.equal(w.card('T2').state, 'ready');
});

test('a hit at or before the run began is an earlier limit: no resume, and on Joe once the wait limit passes', async () => {
  const w = world();
  await w.hit(ACCT, iso(T0 + 30 * MIN), T0);
  parkOnLimit(w.rec, 'T2', { ranAt: T0, parkedAt: T0 + 10 * MIN, account: ACCT });
  await w.pass(T0 + 31 * MIN);
  assert.deepEqual([w.card('T2').state, w.card('T2').wait.who], ['waiting', 'usage'], 'the hit is not this run\'s');
  await w.pass(T0 + 10 * MIN + DAY - MIN);
  assert.equal(w.card('T2').wait.who, 'usage', 'not before the wait limit (1440 min in these rules)');
  assert.equal(w.tellsFor('T2').length, 0);
  await w.pass(T0 + 10 * MIN + DAY + MIN);
  assert.deepEqual([w.card('T2').wait.who, w.card('T2').wait.what], ['joe', LIMIT_NO_HIT]);
  assert.equal(w.tellsFor('T2').length, 1);
});

test('probe C: a reset time already past at the hit is no reset time: on Joe at once, told once', async () => {
  const w = world();
  parkOnLimit(w.rec, 'T2', { ranAt: T0, account: ACCT });
  const r = await w.hit(ACCT, iso(T0 - 22 * 60 * MIN), T0 + 1000);
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, null);
  await w.pass(T0 + MIN);
  assert.deepEqual([w.card('T2').state, w.card('T2').wait.who, w.card('T2').wait.what], ['waiting', 'joe', LIMIT_NO_RESET]);
  assert.equal(w.tellsFor('T2').length, 1);
  assert.match(String(w.tellsFor('T2')[0]?.text ?? w.tellsFor('T2')[0]), /account a hit its usage limit but the reset time could not be read/);
});

test('probe D: a kept reset time (ASSUMPTION c-2: same window) resumes both cards; a later hit with no time goes to Joe, never stuck', async () => {
  const w = world();
  // 10:00 card X's run hits the 5-hour limit, reset 12:00. 10:30 card Y's run hits a limit with an unreadable time: the
  // writer keeps 12:00 (it is still ahead), assumed the same window.
  parkOnLimit(w.rec, 'X', { ranAt: T0 - 30 * MIN, parkedAt: T0, account: ACCT });
  await w.hit(ACCT, iso(T0 + 120 * MIN), T0 + 1000, 'exit-x');
  parkOnLimit(w.rec, 'Y', { ranAt: T0 + 10 * MIN, parkedAt: T0 + 30 * MIN, account: ACCT });
  await w.hit(ACCT, null, T0 + 30 * MIN + 1000, 'exit-y');
  await w.pass(T0 + 121 * MIN);
  assert.deepEqual([w.card('X').state, w.card('Y').state], ['ready', 'ready']);
  // If that limit was not the same window, Y's next run hits it again; the stored 12:00 is past, so the new hit has no
  // time and the card waits on Joe, told, instead of waiting for good.
  parkOnLimit(w.rec, 'Y2', { ranAt: T0 + 125 * MIN, parkedAt: T0 + 126 * MIN, account: ACCT });
  await w.hit(ACCT, null, T0 + 126 * MIN, 'exit-y2');
  assert.equal(w.rec.read('fact', LIMIT_FACT(ACCT)).doc.resets_at, null);
  await w.pass(T0 + 127 * MIN);
  assert.deepEqual([w.card('Y2').wait.who, w.card('Y2').wait.what], ['joe', LIMIT_NO_RESET]);
  assert.equal(w.tellsFor('Y2').length, 1);
});

test('probe E: a hit written for b leaves a card on a waiting; after the wait limit it waits on Joe, told', async () => {
  const w = world();
  parkOnLimit(w.rec, 'T2', { ranAt: T0, account: ACCT });
  await w.hit('b', iso(T0 + 30 * MIN), T0 + 1000);
  await w.pass(T0 + 31 * MIN);
  assert.equal(w.card('T2').wait.who, 'usage');
  await w.pass(T0 + 7 * DAY);
  assert.deepEqual([w.card('T2').wait.who, w.card('T2').wait.what], ['joe', LIMIT_NO_HIT]);
  assert.equal(w.tellsFor('T2').length, 1);
  assert.match(String(w.tellsFor('T2')[0]?.text ?? w.tellsFor('T2')[0]), /account a's usage limit with no limit hit recorded/);
});

test('probe F: a hit with no reset time is told at once, and once only over a week of passes', async () => {
  const w = world();
  parkOnLimit(w.rec, 'T2', { ranAt: T0, account: ACCT });
  await w.hit(ACCT, null, T0 + 1000);
  await w.pass(T0 + MIN);
  assert.equal(w.tellsFor('T2').length, 1);
  for (const d of [1, 3, 7]) await w.pass(T0 + d * DAY);
  assert.equal(w.tellsFor('T2').length, 1);
  assert.deepEqual([w.card('T2').state, w.card('T2').wait.who], ['waiting', 'joe']);
});

// Probe G (a writer with no get()) is m11-readers.test.mjs "#78 r2 m-4": writeLimitHit refuses it.

test('a limit wait with no run_started (not parked from a run) waits on Joe at once, told; a reset hit does not resume it', async () => {
  // Parked from ready: the Record gives the wait no run_started, and drops the one the caller gave.
  const w = world([['card', 'R', { state: 'waiting', product: 'p1', tier: 2, files: ['src/r.js'],
    wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0 + MIN), account: ACCT, run_started: iso(T0 - DAY) } }]]);
  assert.equal(w.card('R').wait.run_started, undefined, 'a caller\'s run_started is dropped');
  await w.hit(ACCT, iso(T0 + 5 * MIN), T0 + MIN);
  await w.pass(T0 + 6 * MIN);
  assert.deepEqual([w.card('R').state, w.card('R').wait.who, w.card('R').wait.what], ['waiting', 'joe', LIMIT_NO_RUN]);
  assert.equal(w.tellsFor('R').length, 1);
  await w.pass(T0 + 7 * MIN);
  assert.equal(w.tellsFor('R').length, 1, 'told once');
});

// L781 class sweep: the keep rule's read goes through the real Record wrapper, whose read answers a store error as
// `corrupt`, never by throwing. A failed read is no stored hit: the write is refused and the reset time still ahead stays.
test('L781: a limit hit with no time, whose stored hit cannot be read, writes nothing over a reset time still ahead', async () => {
  const { memoryRecord, makeRecord } = await import('../../shared/record.mjs');
  const real = memoryRecord(); let fail = false;
  const rec = makeRecord(new Proxy({}, { get: (_, k) => (k === 'read' ? (e, id) => { if (fail) throw new Error('SQLITE_BUSY'); return real.read(e, id); } : typeof real[k] === 'function' ? real[k].bind(real) : real[k]) }));
  const at = new Date(Date.parse('2026-11-05T12:00:00Z'));
  const ahead = '2026-11-05T15:00:00.000Z';
  assert.equal((await writeLimitHit(makeFactWriter(rec), { account: 'a', resets_at: ahead, source: 'worker-exit' }, { now: () => at })).ok, true);
  fail = true;
  const r = await writeLimitHit(makeFactWriter(rec), { account: 'a', resets_at: null, source: 'worker-exit' }, { now: () => new Date(at.getTime() + 60e3) });
  fail = false;
  assert.equal(r.ok, false); assert.match(r.reason, /could not be read, so nothing was written over it/);
  assert.equal(real.read('fact', LIMIT_FACT('a'))?.doc?.resets_at, ahead);
});
