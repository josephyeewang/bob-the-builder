import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { outageStep, isDead, OUTAGE_FACT, OUTAGE_MIN_DEAD, OUTAGE_MIN_SHARE } from './outage.mjs';
import { takePassLock, pidDead } from './pass-lock.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, T0, MIN } from './fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const R = rulesWith();
const live = (id, card) => ({ id, card, alive: true, ended: false, lastWriteAt: T0 - MIN });
const gone = (id, card, quietMin = 6) => ({ id, card, alive: false, ended: true, lastWriteAt: T0 - quietMin * MIN });
// The Record has no rerun_safe field (L72 census, a (b) for the lead): no card can be marked safe, so every dead
// session's card becomes an ask. The restart branch waits on M9 having the field (the todo below).
const cards = () => [1, 2, 3, 4].map((n) => ['card', `C-${n}`, { state: 'running' }]);

test('G1: dead needs the process gone, the session ended and 5 quiet minutes', () => {
  const q = 5 * MIN;
  assert.equal(isDead(gone('a', 'C', 5), { now: T0, quietMs: q }), true);
  assert.equal(isDead(gone('a', 'C', 4), { now: T0, quietMs: q }), false);
  assert.equal(isDead({ ...gone('a'), alive: true }, { now: T0, quietMs: q }), false);
  assert.equal(isDead({ ...gone('a'), ended: false }, { now: T0, quietMs: q }), false);
  assert.equal(isDead({ ...gone('a'), alive: undefined }, { now: T0, quietMs: q }), false);
  assert.equal(isDead({ ...gone('a'), lastWriteAt: undefined }, { now: T0, quietMs: q }), false);
});

test('M9: a board of 4 with 3 killed in one pass restarts nothing and alerts once', () => {
  const rec = recWith(cards());
  const alerts = [];
  const board = [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3'), live('S4', 'C-4')];
  const r = outageStep({ rec, rules: R, board, now: T0, healthy: false, alert: (a) => alerts.push(a) });
  assert.equal(r.outage, true);
  assert.deepEqual(r.restart, []);
  assert.equal(alerts.length, 1);
  assert.equal(typeof alerts[0], 'string'); // audit cosmetic 2: every alert is plain text
  assert.match(alerts[0], /3 of 4 running sessions stopped at once/);
  // the next passes during the outage: still nothing restarts, no second alert
  const later = [gone('S4', 'C-4')];
  const r2 = outageStep({ rec, rules: R, board: later, now: T0 + MIN, healthy: false, alert: (a) => alerts.push(a) });
  assert.equal(r2.outage, true);
  assert.deepEqual(r2.restart, []);
  assert.equal(alerts.length, 1);
  assert.deepEqual(rec.read('fact', OUTAGE_FACT).doc.dead.map((d) => d.id), ['S1', 'S2', 'S3', 'S4']);
});

test('M9: a board of 4 with 1 killed decides that one on its own (an ask: no card is marked safe)', () => {
  const rec = recWith(cards());
  const r = outageStep({ rec, rules: R, board: [gone('S1', 'C-1'), live('S2', 'C-2'), live('S3', 'C-3'), live('S4', 'C-4')], now: T0, healthy: true, alert: () => assert.fail('no alert') });
  assert.equal(r.outage, false);
  assert.deepEqual([r.restart, r.asks], [[], ['C-1']]);
  // the threshold is max(min_dead, ceil(share × board)): a board of 2 with 1 dead is no outage
  const rec2 = recWith(cards());
  assert.equal(outageStep({ rec: rec2, rules: R, board: [gone('S1', 'C-1'), live('S2', 'C-2')], now: T0, healthy: true, alert: () => {} }).outage, false);
  // a board of 6 needs 3
  const six = [1, 2, 3, 4, 5, 6].map((n) => (n <= 2 ? gone(`S${n}`, 'C-1') : live(`S${n}`, 'C-1')));
  assert.equal(outageStep({ rec: recWith(cards()), rules: R, board: six, now: T0, healthy: true, alert: () => {} }).outage, false);
  six[2] = gone('S3', 'C-1');
  assert.equal(outageStep({ rec: recWith(cards()), rules: R, board: six, now: T0, healthy: true, alert: () => {} }).outage, true);
});

test('M9: the outage ends after 2 healthy passes in a row, then its dead cards are decided', () => {
  const rec = recWith(cards());
  const board = [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3'), live('S4', 'C-4')];
  outageStep({ rec, rules: R, board, now: T0, healthy: false, alert: () => {} });
  const step = (healthy, extra = {}) => outageStep({ rec, rules: R, board: [live('S4', 'C-4')], now: T0 + MIN, healthy, alert: () => {}, ...extra });
  assert.equal(step(true).outage, true);
  assert.equal(step(false).outage, true); // the count starts again
  assert.equal(step(true).outage, true);
  const end = step(true);
  assert.equal(end.outage, false);
  assert.equal(end.ended, true);
  assert.deepEqual([end.restart, end.asks.sort()], [[], ['C-1', 'C-2', 'C-3']]);
  assert.equal(rec.read('fact', OUTAGE_FACT).doc.ended_by, 'healthy');
});

test("M9: Joe's resume ends an outage", () => {
  const rec = recWith(cards());
  outageStep({ rec, rules: R, board: [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3')], now: T0, healthy: false, alert: () => {} });
  const r = outageStep({ rec, rules: R, board: [], now: T0 + MIN, healthy: false, resume: true, alert: () => {} });
  assert.equal(r.ended, true);
  assert.equal(rec.read('fact', OUTAGE_FACT).doc.ended_by, 'joe');
});

test('M10 / m18: a card not safe to re-run is never restarted; it becomes an ask', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['card', 'C-2', { state: 'running' }], ['card', 'C-3', { state: 'running' }]]);
  const board = [gone('S1', 'C-1'), live('S2', 'C-2'), live('S3', 'C-3'), live('S4', 'C-3'), live('S5', 'C-3')];
  const r = outageStep({ rec, rules: R, board, now: T0, healthy: true, alert: () => {} });
  assert.deepEqual(r.restart, []);
  assert.deepEqual(r.asks, ['C-1']);
  const r2 = outageStep({ rec: recWith([['card', 'C-2', { state: 'running' }]]), rules: R, board: [gone('S2', 'C-2'), live('a'), live('b')], now: T0, healthy: true, alert: () => {} });
  assert.deepEqual(r2.asks, ['C-2']);
  // after an outage, an unsafe card is still an ask, not a restart
  const rec3 = recWith(cards());
  assert.equal(outageStep({ rec: rec3, rules: R, board: [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3')], now: T0, healthy: false, alert: () => {} }).outage, true);
  const end = outageStep({ rec: rec3, rules: R, board: [], now: T0, healthy: false, resume: true, alert: () => {} });
  assert.deepEqual(end.restart, []);
  assert.deepEqual(end.asks.sort(), ['C-1', 'C-2', 'C-3']);
});

test('the outage keys come from the rules', () => {
  const rec = recWith(cards());
  const board = [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3'), live('S4', 'C-4')];
  assert.equal(outageStep({ rec, rules: R, board, now: T0, healthy: true, alert: () => {} }).outage, true);
  // The rules may raise either number: 4 dead needed, or more than three quarters of the board, and 3 of 4 is no outage.
  assert.equal(outageStep({ rec: recWith(cards()), rules: rulesWith({ [K.outageMinDead]: 4 }), board, now: T0, healthy: true, alert: () => {} }).outage, false);
  assert.equal(outageStep({ rec: recWith(cards()), rules: rulesWith({ [K.outageShare]: 0.8 }), board, now: T0, healthy: true, alert: () => {} }).outage, false);
  assert.throws(() => outageStep({ rec: recWith(), rules: rulesWith({ [K.outageShare]: undefined }), board, now: T0, healthy: true, alert: () => {} }));
  assert.equal(outageStep({ rec: recWith(cards()), rules: rulesWith({ [K.deadQuietMin]: 10 }), board, now: T0, healthy: true, alert: () => {} }).outage, false);
});

test('M16: two passes started together: one runs, one exits', () => {
  const dir = tempDir('m11-lock-');
  const f = join(dir, 'pass.lock');
  const a = takePassLock(f, { pid: 111, dead: () => false });
  const b = takePassLock(f, { pid: 222, dead: () => false });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.reason, /another pass runs \(pid 111\)/);
  a.release();
  assert.equal(existsSync(f), false);
  assert.equal(takePassLock(f, { pid: 222, dead: () => false }).ok, true);
});

test('M16: the lock is broken only when its pid is provably dead', () => {
  const dir = tempDir('m11-lock-');
  const f = join(dir, 'pass.lock');
  writeFileSync(f, JSON.stringify({ pid: 999 }));
  assert.equal(takePassLock(f, { pid: 1, dead: () => false }).ok, false);
  const t = takePassLock(f, { pid: 2, dead: (p) => p === 999 });
  assert.equal(t.ok, true);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, 2);
  writeFileSync(f, 'not json');
  assert.match(takePassLock(f, { pid: 3, dead: () => true }).reason, /unreadable/);
  // release never removes another pass's lock
  writeFileSync(f, JSON.stringify({ pid: 7 }));
  t.release();
  assert.equal(existsSync(f), true);
});

test('pidDead: this process is alive; a finished child is dead; nonsense is not dead', async () => {
  assert.equal(pidDead(process.pid), false);
  const c = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => c.on('exit', r));
  assert.equal(pidDead(c.pid), true);
  assert.equal(pidDead(undefined), false);
  assert.equal(pidDead(-1), false);
  assert.equal(pidDead(1), false); // exists, may not be signalled: alive
});

test('audit O8: an outage whose fact the record refuses raises no alert', () => {
  const real = recWith(cards());
  const rec = { read: (...a) => real.read(...a), list: (...a) => real.list(...a), write: (a) => (a.entity === 'fact' && a.id === OUTAGE_FACT ? { ok: false, reason: 'stale rev' } : real.write(a)) };
  const alerts = [];
  const r = outageStep({ rec, rules: R, board: [gone('S1', 'C-1'), gone('S2', 'C-2'), gone('S3', 'C-3'), live('S4', 'C-4')], now: T0, healthy: false, alert: (a) => alerts.push(a) });
  assert.equal(r.outage, true);
  assert.equal(alerts.length, 0);
});

// ---- Lead call L43(a): an outage needs at least 3 dead and half the board or more ----

test('L43(a): the floor is 3 dead and half the board, whatever lower numbers the rules give', () => {
  assert.deepEqual([OUTAGE_MIN_DEAD, OUTAGE_MIN_SHARE], [3, 0.5]);
  const is = (dead, alive, rules = R) => {
    const board = [...Array.from({ length: dead }, (_, i) => gone(`D${i}`, 'C-1')), ...Array.from({ length: alive }, (_, i) => live(`L${i}`, 'C-2'))];
    return outageStep({ rec: recWith(cards()), rules, board, now: T0, healthy: true, alert: () => {} }).outage;
  };
  // A small Mac: one or two dead sessions are never an outage, even when they are the whole board.
  assert.equal(is(1, 0), false);
  assert.equal(is(2, 0), false);
  assert.equal(is(2, 1), false);
  // 3 dead and half or more: an outage.
  assert.equal(is(3, 0), true);
  assert.equal(is(3, 3), true);
  // 3 dead but under half: no outage.
  assert.equal(is(3, 4), false);
  assert.equal(is(4, 5), false);
  assert.equal(is(5, 5), true);
  // Rules below the floor do not lower it.
  const low = rulesWith({ [K.outageMinDead]: 1, [K.outageShare]: 0.1 });
  assert.equal(is(1, 3, low), false);
  assert.equal(is(2, 0, low), false);
  assert.equal(is(3, 5, low), false);
  assert.equal(is(3, 3, low), true);
});

test('L43(a): a two-session Mac with both sessions dead handles each card on its own', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['card', 'C-2', { state: 'running' }]]);
  const alerts = [];
  const r = outageStep({ rec, rules: R, board: [gone('S1', 'C-1'), gone('S2', 'C-2')], now: T0, healthy: true, alert: (a) => alerts.push(a) });
  assert.equal(r.outage, false);
  assert.deepEqual([r.restart, r.asks], [[], ['C-1', 'C-2']]);
  assert.equal(alerts.length, 0, 'no outage alert');
  assert.equal(rec.read('fact', OUTAGE_FACT), null);
});

// (b) for the lead (L72): M9's card has no rerun_safe field, so outageStep's restart branch is unreachable.
test.todo('M10: a dead card marked safe to re-run is restarted (needs M9 rerun_safe)');
