// The one outbox (alerts.mjs, LEAD-CALLS L47): the sender on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueAlert, sendAlerts, outbox, dropCause, settleAlert, ALERT_QUEUE_FACT } from './alerts.mjs';
import { recWith, T0 } from './fixtures.test-helper.mjs';

const queue = (rec) => rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
const mark = (fact) => ({ fact, fields: { told_at: 'now' }, kind: 'k' });

test('L47: a send answered false, or thrown, is not delivered: the entry stays, untold, at the back', async () => {
  for (const [label, port] of [['false', () => false], ['throws', () => { throw new Error('no network'); }], ['rejects', async () => { throw new Error('no network'); }]]) {
    const rec = recWith([]);
    queueAlert(rec, 'one', { now: T0, mark: mark('f-1') });
    queueAlert(rec, 'two', { now: T0, mark: mark('f-2') });
    const r = await sendAlerts(rec, port, T0, { sendMs: 50 });
    assert.deepEqual(r, { sent: 0, failed: 1, left: 2 }, label);
    assert.deepEqual(queue(rec).map((e) => [e.text, e.tries ?? 0]), [['two', 0], ['one', 1]], label);
    assert.equal(rec.read('fact', 'f-1'), null, `${label}: marked told although unsent`);
  }
});

test('L47: a text the sender always refuses does not hold the rest: it goes to the back each round', async () => {
  const rec = recWith([]);
  for (const t of ['bad', 'a', 'b']) queueAlert(rec, t, { now: T0 });
  const got = [];
  const port = (t) => (t === 'bad' ? false : got.push(t));
  await sendAlerts(rec, port, T0, { sendMs: 50 });
  await sendAlerts(rec, port, T0, { sendMs: 50 });
  assert.deepEqual(got, ['a', 'b']);
  assert.deepEqual(queue(rec).map((e) => e.text), ['bad']);
});

test('L47: the sender stops at its budget once one send is done, and the rest waits for the next pass', async () => {
  const rec = recWith([]);
  for (const t of ['a', 'b', 'c']) queueAlert(rec, t, { now: T0 });
  let ms = 0;
  const got = [];
  const r = await sendAlerts(rec, (t) => { ms += 40; got.push(t); }, T0, { sendMs: 50, budgetMs: 80, clock: () => ms });
  assert.deepEqual(got, ['a'], 'a second send could pass the budget');
  assert.deepEqual(r, { sent: 1, failed: 0, left: 2 });
  // A budget smaller than one send still sends one: the queue always moves.
  const r2 = await sendAlerts(rec, (t) => got.push(t), T0, { sendMs: 50, budgetMs: 1, clock: () => 0 });
  assert.equal(r2.sent, 1);
});

test('L47: a crash between marking and removing sends the entry again (twice, never lost)', async () => {
  const real = recWith([]);
  queueAlert(real, 'stop failed', { now: T0, mark: mark('f-1') });
  // The record refuses the queue write that removes the delivered entry, as a crash right after the mark would.
  let crash = true;
  const rec = { read: (...a) => real.read(...a), write: (w) => (crash && w.kind === 'alert_sent' ? { ok: false, reason: 'crashed' } : real.write(w)) };
  const got = [];
  await sendAlerts(rec, (t) => got.push(t), T0, { sendMs: 50 });
  assert.equal(rec.read('fact', 'f-1').doc.told_at, 'now');
  assert.equal(queue(rec).length, 1);
  crash = false;
  await sendAlerts(rec, (t) => got.push(t), T0, { sendMs: 50 });
  assert.deepEqual(got, ['stop failed', 'stop failed']);
  assert.deepEqual(queue(rec), []);
});

test('L47: the outbox queues and answers at once; it never calls a port, waits or throws', () => {
  const real = recWith([]);
  let gone = false;
  const rec = { read: (...a) => real.read(...a), write: (w) => { if (gone) throw new Error('record gone'); return real.write(w); } };
  const alert = outbox(rec, T0);
  assert.equal(alert.queues, true);
  assert.equal(alert('hello', { mark: mark('f-1') }), true);
  assert.equal(queue(rec).length, 1);
  gone = true;
  assert.equal(alert('again'), false);
});

// Audit 0b-6 r7 M2: a copy that was out when its cause cleared marks nothing when it settles, delivered or not.
test('r7 M2: a copy settled after its cause cleared writes no mark and leaves no entry', async () => {
  const rec = recWith();
  queueAlert(rec, 'stop failed', { now: T0, mark: mark('f-1') });
  const [out] = queue(rec);
  dropCause(rec, 'f-1');
  assert.equal(queue(rec).length, 0);
  settleAlert(rec, out, true, T0);
  assert.equal(rec.read('fact', 'f-1')?.doc?.told_at, undefined, 'no mark on a cleared cause');
  settleAlert(rec, out, false, T0);
  assert.equal(queue(rec).length, 0, 'a failed copy of a cleared cause is not queued again');
  // Through the sender: a send out when the cause clears marks nothing at settle.
  queueAlert(rec, 'stop failed', { now: T0, mark: mark('f-2') });
  const r = await sendAlerts(rec, () => true, T0, { sendMs: 200, later: true });
  dropCause(rec, 'f-2');
  r.settle();
  assert.equal(rec.read('fact', 'f-2')?.doc?.told_at, undefined);
  assert.equal(queue(rec).length, 0);
});

// Audit 0b-6 r7 M1: with `later`, nothing settles until the safety steps are done, so the count of dropped
// alerts is still in the queue for the second copy; it rides on the first one only.
test('r7 M1: in a deferred send the dropped count rides on the first copy only', async () => {
  const rec = recWith();
  queueAlert(rec, 'one', { now: T0 });
  queueAlert(rec, 'two', { now: T0 });
  const d = rec.read('fact', ALERT_QUEUE_FACT);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: d.rev, doc: { ...d.doc, dropped: 3 } });
  const got = [];
  const r = await sendAlerts(rec, (t) => { got.push(t); return true; }, T0, { sendMs: 200, later: true });
  r.settle();
  assert.deepEqual(got, ['one (3 older alerts could not be sent and were dropped)', 'two']);
  assert.equal(rec.read('fact', ALERT_QUEUE_FACT).doc.dropped, 0);
  assert.equal(queue(rec).length, 0);
});
