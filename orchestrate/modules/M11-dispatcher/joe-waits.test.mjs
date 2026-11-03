// joe-waits.test.mjs — L130: a card put on Joe is told until a copy is delivered, and only a delivered copy marks it.
// Real Record (M9 setup, real permissions), the real outbox and sendAlerts (through withAlerts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnJoe, retellWaits, WAIT_TELL_FACT, untoldWaitText } from './joe-waits.mjs';
import { withAlerts } from './fixtures.test-helper.mjs';
import { outbox, isQueued, ALERT_QUEUE_FACT } from './alerts.mjs';
import { waitOn } from './moves.mjs';
import { setup, product, readyCard, runCard, leadCard, seed, plan, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ask = { what: 'dead_session: probe', link: 'card C-1', kind: 'dead_ask' };

function world() {
  const E = setup({ prefix: 'm11-joewaits-', probe: { kill() {}, pidStart: () => 'start' }, host: 'mac-a' });
  product(E);
  readyCard(E, 'C-1');
  runCard(E, 'C-1');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  const pass = () => withAlerts(E.record, E.clock.t, port, (alert) => retellWaits({ rec: E.record, alert, now: E.clock.t }));
  return { E, got, port, pass, card: () => E.record.read('card', 'C-1').doc, tell: () => E.record.read('fact', WAIT_TELL_FACT('C-1'))?.doc };
}

test('L130: an alert answering false leaves the card on Joe untold; the next pass tells it once and marks it', async () => {
  const w = world();
  const r = waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert: () => false, now: w.E.clock.t, ...ask });
  assert.equal(r.ok, true);
  assert.equal(w.card().wait.who, 'joe');
  assert.equal(w.tell().told_since, undefined, 'no told mark on a false answer');
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [['C-1', 'told again: waits on joe']]);
  assert.deepEqual(w.got, ['card C-1 needs you']);
  assert.equal(w.tell().told_since, w.card().wait.since, 'marked told for this wait once delivered');
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.equal(w.got.length, 1, 'told once');
});

test('L130: a queued tell is not queued twice, and a delivered one is not re-told', async () => {
  const w = world();
  const r = await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'told at once', alert, now: w.E.clock.t, ...ask }));
  assert.equal(r.ok, true);
  assert.deepEqual(w.got, ['told at once']);
  for (let i = 0; i < 3; i++) { w.E.clock.t += MIN; assert.deepEqual(await w.pass(), []); }
  assert.equal(w.got.length, 1);
});

test('L130: a tell that cannot be recorded moves nothing (the step sees the card again next pass)', () => {
  const w = world();
  const real = w.E.record;
  const rec = Object.create(real, { write: { value: (x) => (x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') ? { ok: false, reason: 'busy' } : real.write(x)) } });
  let asked = 0;
  const r = waitOnJoe(rec, 'C-1', { text: 't', alert: () => { asked += 1; return true; }, now: w.E.clock.t, ...ask });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the tell could not be recorded: busy/);
  assert.equal(w.card().state, 'running', 'the card did not move');
  assert.equal(asked, 0, 'nothing was said about a wait that does not exist');
});

test('L130, L316: a tell recorded for an older wait is not re-told under a newer one; the newer one is told on its own words', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'first', alert: () => false, now: w.E.clock.t, ...ask }).ok, true);
  // A later re-wait written straight (not through waitOnJoe): its `since` is not the one the tell recorded.
  w.E.clock.t += MIN;
  const again = waitOn(w.E.record, 'C-1', { who: 'joe', what: 'dead_session: probe again', now: w.E.clock.t, link: 'card C-1' });
  assert.equal(again.ok, true, again.reason);
  assert.notEqual(w.card().wait.since, w.tell().since);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [['C-1', 'told again: waits on joe']]);
  assert.deepEqual(w.got, [untoldWaitText('C-1', w.card().wait)], 'not "first": the older wait\'s words');
  assert.match(w.got[0], /^card C-1 waits on you \(dead_session: probe again\)/);
});

const D = 24 * 60 * MIN;

test('L315: a card on Joe is told at once, quiet within the day, then again every day while it waits (was: once, ever)', async () => {
  const w = world();
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: w.E.clock.t, ...ask }));
  assert.equal(w.got.length, 1);
  w.E.clock.t += 2 * 60 * MIN;
  await w.pass();
  assert.equal(w.got.length, 1, 'quiet at +2 h');
  for (let d = 1; d <= 30; d++) { w.E.clock.t += D; await w.pass(); }
  assert.equal(w.got.length, 31, 'once a day for thirty days');
  assert.ok(w.got.every((t) => t === 'card C-1 needs you'));
});

test('L315: when the wait ends the mark is cleared and a queued copy dropped; a new wait on Joe is told at once', async () => {
  const w = world();
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: w.E.clock.t, ...ask }));
  // It ends: the card leaves Joe (back to its owner's queue is not this file's business; any other wait will do).
  w.E.clock.t += MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'dependency', what: 'card C-9', now: w.E.clock.t }).ok, true);
  await w.pass();
  assert.equal(w.tell().told_at, null, 'cleared');
  for (let i = 0; i < 3; i++) { w.E.clock.t += D; await w.pass(); }
  assert.equal(w.got.length, 1, 'nothing told while it waits on someone else');
  // Back on Joe within the day of the last tell: told at once, not held by the old mark.
  w.E.clock.t += MIN;
  await withAlerts(w.E.record, w.E.clock.t, w.port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you again', alert, now: w.E.clock.t, ...ask }));
  assert.deepEqual(w.got, ['card C-1 needs you', 'card C-1 needs you again']);
});

test('L316: the round cap, as M9 writer.mjs writes it (a joe wait with no tell), is told: the card, what, why and what Joe can do', async () => {
  // The real writer: caps.rounds 1, so the first fix card is round 2 and is created waiting on the owner.
  const E = setup({ prefix: 'm11-joewaits-cap-', values: { 'caps.rounds': 1 } });
  product(E);
  leadCard(E, 'C-1');
  seed(E, 'card', 'C-1', { ...E.record.read('card', 'C-1').doc, state: 'failed' });
  const fix = E.record.write({ actor: 'dispatcher', entity: 'card', id: 'F-1', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'fix', fix_of: 'C-1', ...plan() } });
  assert.equal(fix.ok, true, fix.reason);
  const f = E.record.read('card', 'F-1').doc;
  assert.equal(f.state, 'waiting');
  assert.equal(f.wait.what, 'round cap');
  assert.equal(E.record.read('fact', WAIT_TELL_FACT('F-1')), null, 'the writer wrote no tell');
  const got = [];
  const pass = () => withAlerts(E.record, E.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => retellWaits({ rec: E.record, alert, now: E.clock.t }));
  E.clock.t += MIN;
  await pass();
  assert.deepEqual(got, [`card F-1 waits on you (round cap): ${f.wait.reason}. Answer it through the Front Door`]);
  assert.match(got[0], /the owner cancels it, or the Lead makes a new card/, 'what Joe can do');
  E.clock.t += 60 * MIN;
  await pass();
  assert.equal(got.length, 1, 'quiet within the day');
  E.clock.t += D;
  await pass();
  assert.equal(got.length, 2, 'again a day later');
});

test('L316: a joe wait with no reason is told with the general answer', () => {
  assert.equal(untoldWaitText('C-7', { who: 'joe', what: 'dead_session: probe' }),
    'card C-7 waits on you (dead_session: probe); no reason was recorded. Answer it through the Front Door: say how it goes on, or cancel the card');
});

test('L316: a card parked because its product is paused is not told card by card (it resumes by itself)', async () => {
  const w = world();
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'joe', what: 'paused', now: w.E.clock.t }).ok, true);
  for (let i = 0; i < 3; i++) { w.E.clock.t += D; await w.pass(); }
  assert.deepEqual(w.got, []);
});

// L138 MAT-1: the Record stamps a wait with its own clock. The tick's `now` runs behind it here, so the wait's stored
// since is not the since the tick asked for; the tell is matched on the stored one.
for (const skew of [5, 1500]) {
  test(`L138 MAT-1: the Record's clock ${skew} ms ahead of the tick; a refused first tell is told on a later pass, exactly once`, async () => {
    const w = world();
    let answer = false;
    const port = (t) => { w.got.push(typeof t === 'string' ? t : t.text); return answer; };
    const tickNow = () => w.E.clock.t - skew;
    const r = await withAlerts(w.E.record, tickNow(), port, (alert) => waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert, now: tickNow(), ...ask }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(w.card().wait.since, new Date(w.E.clock.t).toISOString(), 'the Record stamped its own time');
    assert.notEqual(w.card().wait.since, w.tell().since, 'not the time the tick asked at');
    assert.equal(w.tell().wait_since, w.card().wait.since, 'the stored since is copied onto the tell');
    assert.deepEqual(w.got, ['card C-1 needs you'], 'sent once and refused');
    assert.equal(w.tell().told_since, undefined, 'a refused send marks nothing');
    answer = true;
    const passAt = () => withAlerts(w.E.record, tickNow(), port, (alert) => retellWaits({ rec: w.E.record, alert, now: tickNow() }));
    w.E.clock.t += MIN;
    await passAt();
    assert.deepEqual(w.got, ['card C-1 needs you', 'card C-1 needs you'], 'told again on the next pass');
    assert.equal(w.tell().told_since, w.card().wait.since, 'marked told for the stored wait');
    for (let i = 0; i < 3; i++) { w.E.clock.t += MIN; assert.deepEqual(await passAt(), []); }
    assert.equal(w.got.length, 2, 'told exactly once once delivered (P20)');
  });
}

test('L138 MAT-1: a wait whose stored since could not be copied onto the tell is matched by the window, copied, then told', async () => {
  const w = world();
  const real = w.E.record;
  let refuse = true;
  const rec = Object.create(real, { write: { value: (x) => (refuse && x.entity === 'fact' && x.id === WAIT_TELL_FACT('C-1') && x.doc?.wait_since ? { ok: false, reason: 'busy' } : real.write(x)) } });
  const r = await withAlerts(rec, w.E.clock.t - 1500, w.port, (alert) => waitOnJoe(rec, 'C-1', { text: 'needs you', alert, now: w.E.clock.t - 1500, ...ask }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(w.card().state, 'waiting');
  assert.equal(w.tell().wait_since, undefined, 'the copy was refused');
  assert.deepEqual(w.got, [], 'nothing queued under a since the tell does not hold');
  refuse = false;
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), [['C-1', 'told again: waits on joe']]);
  assert.equal(w.tell().wait_since, w.card().wait.since, 'copied on by the next pass');
  assert.equal(w.tell().told_since, w.card().wait.since);
  assert.deepEqual(w.got, ['needs you']);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.equal(w.got.length, 1);
});

test('L315: a copy still queued is not queued again a day later, and is dropped when the wait ends', () => {
  const w = world();
  const fact = WAIT_TELL_FACT('C-1');
  const queued = () => (w.E.record.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => e.mark?.fact === fact).length;
  // Queued, never sent (no outbox sender runs here).
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'card C-1 needs you', alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t, ...ask }).ok, true);
  assert.equal(queued(), 1);
  for (let d = 1; d <= 2; d++) { w.E.clock.t += D; retellWaits({ rec: w.E.record, alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t }); }
  assert.equal(queued(), 1, 'one copy, not one per day');
  w.E.clock.t += MIN;
  assert.equal(waitOn(w.E.record, 'C-1', { who: 'dependency', what: 'card C-9', now: w.E.clock.t }).ok, true);
  retellWaits({ rec: w.E.record, alert: outbox(w.E.record, w.E.clock.t), now: w.E.clock.t });
  assert.equal(isQueued(w.E.record, fact), false, 'the wait ended: the unsent copy leaves the queue');
});
