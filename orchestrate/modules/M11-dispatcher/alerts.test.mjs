// The one outbox (alerts.mjs, LEAD-CALLS L47): the sender on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueAlert, sendAlerts, outbox, dropCause, settleAlert, droppedCount, ALERT_QUEUE_FACT, ALERT_QUEUE_MAX, ALERT_UNTRIED_MAX } from './alerts.mjs';
import { holdAlert } from './pass.mjs';
import { recWith, T0 } from './fixtures.test-helper.mjs';

const queue = (rec) => rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
const mark = (fact) => ({ fact, fields: { told_at: 'now' }, kind: 'k' });

test('L47: a send answered false, or thrown, is not delivered: the entry stays, untold, at the back', async () => {
  for (const [label, port] of [['false', () => false], ['throws', () => { throw new Error('no network'); }], ['rejects', async () => { throw new Error('no network'); }]]) {
    const rec = recWith([]);
    queueAlert(rec, 'one', { now: T0, mark: mark('stop-f-1') });
    queueAlert(rec, 'two', { now: T0, mark: mark('stop-f-2') });
    const r = await sendAlerts(rec, port, T0, { sendMs: 50 });
    assert.deepEqual(r, { sent: 0, failed: 1, left: 2 }, label);
    assert.deepEqual(queue(rec).map((e) => [e.text, e.tries ?? 0]), [['two', 0], ['one', 1]], label);
    assert.equal(rec.read('fact', 'stop-f-1'), null, `${label}: marked told although unsent`);
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
  queueAlert(real, 'stop failed', { now: T0, mark: mark('stop-f-1') });
  // The record refuses the queue write that removes the delivered entry, as a crash right after the mark would.
  let crash = true;
  const rec = { read: (...a) => real.read(...a), write: (w) => (crash && w.kind === 'alert_sent' ? { ok: false, reason: 'crashed' } : real.write(w)) };
  const got = [];
  await sendAlerts(rec, (t) => got.push(t), T0, { sendMs: 50 });
  assert.equal(rec.read('fact', 'stop-f-1').doc.told_at, 'now');
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
  assert.equal(alert('hello', { mark: mark('stop-f-1') }), true);
  assert.equal(queue(rec).length, 1);
  gone = true;
  assert.equal(alert('again'), false);
});

// Audit 0b-6 r7 M2: a copy that was out when its cause cleared marks nothing when it settles, delivered or not.
test('r7 M2: a copy settled after its cause cleared writes no mark and leaves no entry', async () => {
  const rec = recWith();
  queueAlert(rec, 'stop failed', { now: T0, mark: mark('stop-f-1') });
  const [out] = queue(rec);
  dropCause(rec, 'stop-f-1');
  assert.equal(queue(rec).length, 0);
  settleAlert(rec, out, true, T0);
  assert.equal(rec.read('fact', 'stop-f-1')?.doc?.told_at, undefined, 'no mark on a cleared cause');
  settleAlert(rec, out, false, T0);
  assert.equal(queue(rec).length, 0, 'a failed copy of a cleared cause is not queued again');
  // Through the sender: a send out when the cause clears marks nothing at settle.
  queueAlert(rec, 'stop failed', { now: T0, mark: mark('stop-f-2') });
  const r = await sendAlerts(rec, () => true, T0, { sendMs: 200, later: true });
  dropCause(rec, 'stop-f-2');
  r.settle();
  assert.equal(rec.read('fact', 'stop-f-2')?.doc?.told_at, undefined);
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

// A Minor from the review of the first Dispatcher build: while the port is down each round tries one entry, so the held cap alone let
// the untried grow without limit. Now they are capped too, the oldest go first, and the dropped count is told once.
test('queue cap: a long outage keeps the queue within both caps; the dropped count is told once when the port is back', async () => {
  const rec = recWith([]);
  const PASSES = 12;
  const PER_PASS = 40;
  let n = 0;
  for (let p = 0; p < PASSES; p += 1) {
    for (let i = 0; i < PER_PASS; i += 1) queueAlert(rec, `p${p}-${i}`, { now: T0 });
    n += PER_PASS;
    await sendAlerts(rec, () => false, T0, { sendMs: 20 });
    const q = queue(rec);
    assert.ok(q.filter((e) => e.held).length <= ALERT_QUEUE_MAX, `pass ${p}: held over the cap`);
    assert.ok(q.filter((e) => !e.held).length <= ALERT_UNTRIED_MAX, `pass ${p}: untried over the cap (${q.length})`);
  }
  const d = rec.read('fact', ALERT_QUEUE_FACT).doc;
  assert.ok(n > ALERT_QUEUE_MAX + ALERT_UNTRIED_MAX, 'the test must queue more than both caps hold');
  assert.equal(d.entries.filter((e) => !e.held).length, ALERT_UNTRIED_MAX);
  assert.equal(d.dropped, n - d.entries.length, 'every entry dropped is counted');
  const texts = d.entries.map((e) => e.text);
  // Each pass tried (and held) the oldest untried entry, p0-0 to p0-11; p0-20 was never tried, so the untried cap took it.
  assert.ok(texts.includes(`p${PASSES - 1}-${PER_PASS - 1}`) && texts.includes('p0-1') && !texts.includes('p0-20'), 'the newest untried stay, the oldest go');
  // A cause queued into the full queue is the one that goes (#39 check, m2, m3), and it is counted once however
  // often it is queued and dropped again (L52).
  for (let p = 0; p < 5; p += 1) queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  assert.equal(queue(rec).filter((e) => e.key === 'stop-A:told_at').length, 0);
  assert.equal(rec.read('fact', ALERT_QUEUE_FACT).doc.dropped, d.dropped);
  assert.deepEqual(causesDropped(rec), ['stop-A:told_at']);
  // The port is back: the first copy delivered carries the dropped count, the others do not, and the count resets.
  const got = [];
  await sendAlerts(rec, (t) => { got.push(t); return true; }, T0, { sendMs: 20, budgetMs: 60_000 });
  const told = got.filter((t) => /older alerts could not be sent and were dropped/.test(t));
  assert.equal(told.length, 1, 'told once');
  assert.match(got[0], new RegExp(`\\(${n - got.length + 1} older alerts could not be sent`));
  assert.equal(droppedAll(rec), 0);
  assert.equal(queue(rec).length, 0);
  // Its step queues the cause again on the next pass, and this time it is sent and marked.
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  await sendAlerts(rec, () => true, T0, { sendMs: 20 });
  assert.equal(rec.read('fact', 'stop-A').doc.told_at, 'now');
});

test('queue cap: a burst of ALERT_UNTRIED_MAX queued while the port works is all sent; one more drops the oldest untried', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
  assert.equal(rec.read('fact', ALERT_QUEUE_FACT).doc.dropped ?? 0, 0);
  queueAlert(rec, 'one more', { now: T0 });
  const d = rec.read('fact', ALERT_QUEUE_FACT).doc;
  assert.equal(d.dropped, 1);
  assert.equal(d.entries[0].text, 'b1', 'the oldest untried went');
  const got = [];
  const r = await sendAlerts(rec, (t) => { got.push(t); return true; }, T0, { sendMs: 20, budgetMs: 60_000 });
  assert.equal(r.sent, ALERT_UNTRIED_MAX);
  assert.equal(got[0], 'b1 (1 older alerts could not be sent and were dropped)');
  assert.equal(got.at(-1), 'one more');
});

// The #39 check. A port held open until the test lets it answer, and the cap's one-offs and causes.
const held = () => {
  let open;
  const gate = new Promise((ok) => { open = ok; });
  const got = [];
  return { got, open: () => open(true), port: (t) => { got.push(t); return gate; } };
};
const setDropped = (rec, n) => {
  const d = rec.read('fact', ALERT_QUEUE_FACT);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: d.rev, doc: { ...d.doc, dropped: n } });
};
const dropped = (rec) => rec.read('fact', ALERT_QUEUE_FACT).doc.dropped ?? 0;
const droppedAll = (rec) => droppedCount(rec.read('fact', ALERT_QUEUE_FACT).doc);
const causesDropped = (rec) => (rec.read('fact', ALERT_QUEUE_FACT).doc.dropped_causes ?? []).map((c) => c.key);
const tickOver = () => new Promise((ok) => setImmediate(ok));

// M1: a delivery took off only the count its text carried. Alerts dropped while the send was out are told next.
test('#39 M1: alerts dropped while a deferred send is out at the cap are told on the next send', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_UNTRIED_MAX + 5; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
  assert.equal(dropped(rec), 5);
  const p = held();
  const sending = sendAlerts(rec, p.port, T0, { sendMs: 5_000, budgetMs: 5_000, later: true });
  await tickOver();
  assert.deepEqual(p.got, ['b5 (5 older alerts could not be sent and were dropped)']);
  // b5 is out for sending, so it does not count toward the cap (#39 round 2, m-B): four more drop three.
  for (let i = 0; i < 4; i += 1) queueAlert(rec, `during${i}`, { now: T0 });
  assert.equal(dropped(rec), 8);
  p.open();
  (await sending).settle();
  assert.equal(dropped(rec), 3, 'the 3 dropped during the send are still to be told');
  assert.ok(!queue(rec).some((e) => e.text === 'b5'), 'the copy delivered left the queue');
  const got = [];
  await sendAlerts(rec, (t) => { got.push(t); return true; }, T0, { sendMs: 20, budgetMs: 60_000 });
  assert.match(got[0], /\(3 older alerts could not be sent and were dropped\)$/);
  assert.equal(got.filter((t) => /older alerts/.test(t)).length, 1);
  assert.equal(dropped(rec), 0);
});

test('#39 M1: two copies in one deferred round take off the count once', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'one', { now: T0 });
  queueAlert(rec, 'two', { now: T0 });
  setDropped(rec, 3);
  const r = await sendAlerts(rec, () => true, T0, { sendMs: 200, later: true });
  setDropped(rec, 5);
  r.settle();
  assert.equal(r.sent, 2);
  assert.equal(dropped(rec), 2);
});

test('#39 M1: the count comes off as told even when the copy delivered left the queue meanwhile', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  setDropped(rec, 5);
  const p = held();
  const sending = sendAlerts(rec, p.port, T0, { sendMs: 5_000, later: true });
  await tickOver();
  dropCause(rec, 'stop-A');
  setDropped(rec, 7);
  p.open();
  (await sending).settle();
  assert.equal(dropped(rec), 2);
  assert.equal(rec.read('fact', 'stop-A')?.doc?.told_at, undefined, 'a cleared cause is not marked');
  // Not delivered, nothing comes off.
  queueAlert(rec, 'next', { now: T0 });
  await sendAlerts(rec, () => false, T0, { sendMs: 20 });
  assert.equal(dropped(rec), 2);
});

// m1: the entry out for sending is never dropped by the cap, so its delivery settles it and marks its cause.
test('#39 m1: the cap never drops the entry being sent; its cause is marked once delivered', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  for (let i = 1; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
  const p = held();
  const sending = sendAlerts(rec, p.port, T0, { sendMs: 5_000, budgetMs: 5_000, later: true });
  await tickOver();
  assert.deepEqual(p.got, ['stop A']);
  // Its step queues it again while it is out: the copy that replaced it is out for sending too.
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  queueAlert(rec, 'one more', { now: T0 });
  assert.ok(queue(rec).some((e) => e.key === 'stop-A:told_at'), 'the entry out for sending stays');
  // It does not count toward the cap either (#39 round 2, m-B), so nothing goes.
  const firstOneOff = () => queue(rec).find((e) => !e.key).text;
  assert.equal(firstOneOff(), 'b1');
  assert.equal(droppedAll(rec), 0);
  queueAlert(rec, 'two more', { now: T0 });
  assert.equal(firstOneOff(), 'b2', 'past the cap the oldest one-off goes');
  assert.equal(dropped(rec), 1);
  p.open();
  (await sending).settle();
  assert.equal(rec.read('fact', 'stop-A').doc.told_at, 'now');
  assert.ok(!queue(rec).some((e) => e.key), 'and it left the queue');
  assert.equal(dropped(rec), 1, 'the copy carried no count, so none comes off');
  // Once settled it is an ordinary entry again: past the cap the same cause goes first.
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `c${i}`, { now: T0 });
  assert.ok(!queue(rec).some((e) => e.key), 'not out for sending, a cause goes first');
  assert.deepEqual(causesDropped(rec), ['stop-A:told_at'], 'and is counted');
});

// m2, m3: past a cap, entries tied to a cause go first; a one-off goes only when none is left. Every drop is
// counted, a cause once (L52).
test('#39 m2, m3: the untried cap drops entries tied to a cause first and counts each cause once', () => {
  const rec = recWith([]);
  queueAlert(rec, 'unsaved work in S-1', { now: T0 });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `hold ${i}`, { now: T0, mark: mark(`hold-${i}`) });
  assert.equal(queue(rec)[0].text, 'unsaved work in S-1', 'the one-off stays');
  assert.ok(!queue(rec).some((e) => e.text === 'hold 0'), 'the oldest cause went');
  assert.equal(dropped(rec), 0);
  assert.deepEqual(causesDropped(rec), ['hold-0:told_at']);
  // The same cause queued and dropped again counts once.
  for (let pass = 0; pass < 5; pass += 1) queueAlert(rec, 'hold 0', { now: T0, mark: mark('hold-0') });
  assert.deepEqual(causesDropped(rec), ['hold-0:told_at', 'hold-1:told_at'], 'hold 0 back in pushed out hold 1; hold 0 never counts twice');
  queueAlert(rec, 'hold 1', { now: T0, mark: mark('hold-1') });
  assert.equal(droppedAll(rec), 3);
  assert.equal(queue(rec).length, ALERT_UNTRIED_MAX);
  // With no cause left, the oldest one-off goes and is counted.
  const rec2 = recWith([]);
  for (let i = 0; i <= ALERT_UNTRIED_MAX; i += 1) queueAlert(rec2, `one-off ${i}`, { now: T0 });
  assert.equal(dropped(rec2), 1);
  assert.equal(queue(rec2)[0].text, 'one-off 1');
});

test('#39 m2, m3: the held cap drops entries tied to a cause first and counts it', () => {
  const rec = recWith([]);
  const one = { id: 'h0', key: null, text: 'N sessions stopped', mark: null, queued_at: 'x', held: true, tries: 1 };
  const causes = Array.from({ length: ALERT_QUEUE_MAX }, (_, i) => ({ id: `h${i + 1}`, key: `hold-${i}:told_at`, text: `hold ${i}`, mark: mark(`hold-${i}`), queued_at: 'x', held: true, tries: 1 }));
  rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: 0, doc: { entries: [one, ...causes], next: 100 } });
  queueAlert(rec, 'fresh', { now: T0 });
  const q = queue(rec);
  assert.equal(q.filter((e) => e.held).length, ALERT_QUEUE_MAX);
  assert.ok(q.some((e) => e.id === 'h0') && !q.some((e) => e.id === 'h1'));
  assert.equal(dropped(rec), 0);
  assert.deepEqual(causesDropped(rec), ['hold-0:told_at']);
});

// #39 round 2 (L52): every drop is counted. A one-shot mark is queued once and never again, so no rule may rest
// on a step queueing its alert again.
const deliverAll = async (rec) => { const got = []; await sendAlerts(rec, (t) => { got.push(t); return true; }, T0, { sendMs: 20, budgetMs: 60_000 }); return got; };

test('#39 round 2 MAT-1: a one-shot cause dropped at the untried cap is counted and told', async () => {
  const rec = recWith([]);
  holdAlert({ rec, cause: 'run-late', text: 'a Dispatcher pass did not finish in time', alert: outbox(rec, T0), now: T0 });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `one-off ${i}`, { now: T0 });
  assert.ok(!queue(rec).some((e) => e.key), 'the cause went first');
  assert.equal(droppedAll(rec), 1, 'and is counted');
  const got = await deliverAll(rec);
  assert.equal(got[0], 'one-off 0 (1 older alerts could not be sent and were dropped)');
  assert.equal(droppedAll(rec), 0, 'told, the count clears');
  assert.equal(rec.read('fact', 'hold-run-late')?.doc?.told_at, undefined, 'its own alert was never delivered, so it is not marked told');
});

test('#39 round 2 MAT-1: a one-shot cause dropped at the held cap is counted and told', async () => {
  const rec = recWith([]);
  holdAlert({ rec, cause: 'launch-late-c-1', text: 'card c-1: the launcher did not answer', alert: outbox(rec, T0), now: T0 });
  await sendAlerts(rec, () => false, T0, { sendMs: 20 });
  const d = rec.read('fact', ALERT_QUEUE_FACT);
  assert.equal(d.doc.entries[0].held, true, 'the cause waited through a failed send');
  const ones = Array.from({ length: ALERT_QUEUE_MAX }, (_, i) => ({ id: `h${i}`, key: null, text: `held ${i}`, mark: null, queued_at: 'x', held: true, tries: 1 }));
  rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: d.rev, doc: { ...d.doc, entries: [...d.doc.entries, ...ones] } });
  queueAlert(rec, 'fresh', { now: T0 });
  assert.ok(!queue(rec).some((e) => e.key), 'the held cause went first');
  assert.equal(queue(rec).filter((e) => e.held).length, ALERT_QUEUE_MAX);
  assert.equal(droppedAll(rec), 1);
  const got = await deliverAll(rec);
  assert.match(got[0], /\(1 older alerts could not be sent and were dropped\)$/);
  assert.equal(droppedAll(rec), 0);
});

test('#39 round 2 m-A: a round started while another is out carries only what that one does not', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_UNTRIED_MAX + 5; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
  assert.equal(droppedAll(rec), 5);
  const gotA = [];
  const roundA = sendAlerts(rec, (t) => { gotA.push(t); return new Promise((ok) => setTimeout(() => ok(true), 20)); }, T0, { sendMs: 50, budgetMs: 60, later: true });
  await tickOver();
  const b = held();
  const roundB = sendAlerts(rec, b.port, T0, { sendMs: 5_000, budgetMs: 5_000, later: true });
  await tickOver();
  assert.match(gotA[0], /\(5 older alerts/);
  assert.ok(!/older alerts/.test(b.got[0]), 'round B does not carry what round A has out');
  for (let i = 0; i < 4; i += 1) queueAlert(rec, `during${i}`, { now: T0 });
  const three = droppedAll(rec) - 5;
  assert.equal(three, 3, 'three more dropped while both are out');
  (await roundA).settle();
  b.open();
  (await roundB).settle();
  assert.equal(droppedAll(rec), 3, 'both settled, the three are still to be told');
  const got = await deliverAll(rec);
  assert.match(got[0], /\(3 older alerts could not be sent and were dropped\)$/);
  assert.equal(droppedAll(rec), 0);
});

test('#39 round 2 m-B: entries out for sending do not count toward the cap', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
  const r = await sendAlerts(rec, () => true, T0, { sendMs: 20, budgetMs: 60_000, later: true });
  assert.equal(r.sent, ALERT_UNTRIED_MAX, 'all delivered, none settled yet');
  queueAlert(rec, '3 sessions stopped', { now: T0 });
  assert.ok(queue(rec).some((e) => e.text === '3 sessions stopped'), 'it survives');
  assert.equal(droppedAll(rec), 0);
  r.settle();
  assert.deepEqual(queue(rec).map((e) => e.text), ['3 sessions stopped']);
});

test('#39 round 2 m-C: a one-off goes only when no cause is left in either class', () => {
  const heldOnes = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, key: null, text: `held ${i}`, mark: null, queued_at: 'x', held: true, tries: 1 }));
  const causes = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, key: `hold-${i}:told_at`, text: `hold ${i}`, mark: mark(`hold-${i}`), queued_at: 'x' }));
  const start = (entries) => { const rec = recWith([]); rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: 0, doc: { entries, next: 1000 } }); return rec; };
  // The held class is over its cap and the untried class holds a cause: the cause goes, not a held one-off.
  const a = start([...heldOnes(ALERT_QUEUE_MAX + 1), ...causes(1)]);
  queueAlert(a, 'fresh', { now: T0 });
  assert.equal(queue(a).filter((e) => e.held).length, ALERT_QUEUE_MAX + 1, 'no held one-off went while a cause is left');
  assert.deepEqual(queue(a).filter((e) => !e.held).map((e) => e.text), ['fresh']);
  assert.equal(dropped(a), 0);
  assert.deepEqual(causesDropped(a), ['hold-0:told_at']);
  // Only as many go as the classes are over: one, the oldest cause.
  const b = start([...heldOnes(ALERT_QUEUE_MAX + 1), ...causes(ALERT_UNTRIED_MAX - 1)]);
  queueAlert(b, 'fresh', { now: T0 });
  assert.equal(queue(b).filter((e) => e.held).length, ALERT_QUEUE_MAX + 1);
  assert.ok(!queue(b).some((e) => e.id === 'c0') && queue(b).some((e) => e.text === 'fresh'), 'the oldest cause went');
  assert.equal(queue(b).length, ALERT_QUEUE_MAX + ALERT_UNTRIED_MAX, 'and only it');
  assert.deepEqual(causesDropped(b), ['hold-0:told_at']);
  // The untried class is over with only one-offs, and the held class holds a cause: the cause goes.
  const ones = Array.from({ length: ALERT_UNTRIED_MAX }, (_, i) => ({ id: `u${i}`, key: null, text: `u ${i}`, mark: null, queued_at: 'x' }));
  const c = start([{ ...causes(1)[0], held: true, tries: 1 }, ...heldOnes(ALERT_QUEUE_MAX - 1), ...ones]);
  queueAlert(c, 'fresh', { now: T0 });
  assert.ok(!queue(c).some((e) => e.key) && queue(c).some((e) => e.id === 'u0'), 'the held cause went, not the oldest one-off');
  assert.equal(queue(c).length, ALERT_QUEUE_MAX + ALERT_UNTRIED_MAX, 'and only it');
  assert.equal(dropped(c), 0);
  assert.equal(droppedAll(c), 1);
  // No cause left anywhere: the over class's oldest one-off goes, and is counted.
  const d = start(heldOnes(ALERT_QUEUE_MAX + 1));
  queueAlert(d, 'fresh', { now: T0 });
  assert.ok(!queue(d).some((e) => e.id === 'h0'));
  assert.equal(dropped(d), 1);
});

test('#39 round 2: a dropped cause stops counting when it clears, or when an alert for it is delivered', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'stop A', { now: T0, mark: mark('stop-A') });
  queueAlert(rec, 'stop B', { now: T0, mark: mark('stop-B') });
  for (let i = 0; i < ALERT_UNTRIED_MAX - 1; i += 1) queueAlert(rec, `one-off ${i}`, { now: T0 });
  assert.deepEqual(causesDropped(rec), ['stop-A:told_at']);
  queueAlert(rec, 'one more', { now: T0 });
  assert.deepEqual(causesDropped(rec), ['stop-A:told_at', 'stop-B:told_at']);
  dropCause(rec, 'stop-A');
  assert.deepEqual(causesDropped(rec), ['stop-B:told_at'], 'a cleared cause no longer counts');
  // stop B is queued again (in one-off 0's place) and delivered first: it does not count itself, and once told
  // its drop clears.
  const d = rec.read('fact', ALERT_QUEUE_FACT);
  const again = { id: 'z1', key: 'stop-B:told_at', text: 'stop B', mark: mark('stop-B'), queued_at: 'x' };
  rec.write({ actor: 'dispatcher', entity: 'fact', id: ALERT_QUEUE_FACT, expectRev: d.rev, doc: { ...d.doc, entries: [again, ...d.doc.entries.slice(1)] } });
  const got = await deliverAll(rec);
  assert.equal(got[0], 'stop B', 'its own drop is not counted in its own text');
  assert.ok(!got.some((t) => /older alerts/.test(t)), 'nor in any later one: it was told');
  assert.equal(rec.read('fact', 'stop-B').doc.told_at, 'now');
  assert.equal(droppedAll(rec), 0);
});

// #39 round 3 (LEAD-CALLS L56): a delivery clears only the drops its text carried. A cause dropped again while
// a send is out is told by a later text, never wiped by the earlier one (the reviewer's repros, plus the case
// with no `dropCause` in between).
const doc39 = (rec) => rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
const toldIn = (texts) => texts.reduce((s, t) => s + Number(/\((\d+) older/.exec(t)?.[1] ?? 0), 0);
const drain = async (rec, texts) => {
  for (let i = 0; i < 400 && doc39(rec).entries?.length; i += 1) await sendAlerts(rec, (t) => { texts.push(t); }, T0, { sendMs: 50, budgetMs: 1e12, clock: () => 0 });
};

test('#39 round 3 (L56): dropCause, then the same cause dropped again during an unsettled delivery, is still told', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'cause K, first time', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 1);
  const texts = [];
  const a = await sendAlerts(rec, (t) => { texts.push(t); }, T0, { later: true, sendMs: 50, budgetMs: 1 });
  assert.match(texts[0], /\(1 older alerts/);
  dropCause(rec, 'hold-x');
  queueAlert(rec, 'cause K, second time', { now: T0, mark: mark('hold-x') });
  queueAlert(rec, 'one more', { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 1, 'the second drop of K is counted');
  a.settle();
  const after = droppedCount(doc39(rec));
  assert.equal(after, 1, 'the earlier text did not carry the second drop, so its delivery leaves it');
  texts.length = 0;
  await drain(rec, texts);
  assert.equal(toldIn(texts), 1, 'the second drop of K is told exactly once');
  assert.equal(droppedCount(doc39(rec)), 0);
});

test('#39 round 3 (L56): K told by its own delivery, dropped again, then an older send carrying K settles: the new drop stays', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'K first', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  const texts = [];
  const a = await sendAlerts(rec, (t) => { texts.push(t); }, T0, { later: true, sendMs: 50, budgetMs: 1 });
  queueAlert(rec, 'K again', { now: T0, mark: mark('hold-x') });
  while (doc39(rec).entries.some((e) => e.key)) await sendAlerts(rec, (t) => { texts.push(t); }, T0, { sendMs: 50, budgetMs: 1 });
  queueAlert(rec, 'K third', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `v${i}`, { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 1, 'K\'s own delivery cleared its first drop (out in u0, recheck N2); the new drop is listed');
  a.settle();
  assert.equal(droppedCount(doc39(rec)), 1, 'a text written before the new drop does not clear it');
  texts.length = 0;
  await drain(rec, texts);
  assert.equal(toldIn(texts), 1, 'the new drop is told once');
});

test('#39 round 3 (L56): with no dropCause, a cause dropped again while the text carrying its first drop is out is listed anew and told', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'K first', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 1);
  const texts = [];
  const a = await sendAlerts(rec, (t) => { texts.push(t); }, T0, { later: true, sendMs: 50, budgetMs: 1 });
  assert.match(texts[0], /\(1 older alerts/, 'u0 carries the first drop of K');
  queueAlert(rec, 'K second', { now: T0, mark: mark('hold-x') });
  queueAlert(rec, 'one more', { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 2, 'the second drop is listed: the only listing of K is out in a text written before it');
  queueAlert(rec, 'K third', { now: T0, mark: mark('hold-x') }); // the untried class is full again: K goes at once
  assert.equal(droppedCount(doc39(rec)), 2, 'a third drop while the second is still listed and not out adds nothing (once per cause)');
  a.settle();
  assert.equal(droppedCount(doc39(rec)), 1, 'the delivery clears only the drop its text carried');
  texts.length = 0;
  await drain(rec, texts);
  assert.equal(toldIn(texts), 1, 'the later drop is told once');
  assert.equal(droppedCount(doc39(rec)), 0);
});

// #39 round 3 recheck (LEAD-CALLS L56): the reviewer's over-count repros on the first L56 fix.
test('#39 round 3 recheck (L56, N1): K dropped again while its listing is out in a send that then fails counts once', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'K first', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  assert.equal(droppedCount(doc39(rec)), 1);
  const a = await sendAlerts(rec, () => false, T0, { later: true, sendMs: 50, budgetMs: 1 }); // u0 carries K's drop; fails
  queueAlert(rec, 'K again', { now: T0, mark: mark('hold-x') });
  queueAlert(rec, 'one more', { now: T0 }); // K dropped again: listed anew, its first listing is out
  a.settle(); // the send failed: the first listing is back
  const texts = [];
  await sendAlerts(rec, (t) => { texts.push(t); }, T0, { sendMs: 50, budgetMs: 1 });
  assert.match(texts[0], /\(1 older alerts/, 'one cause, dropped twice, should count once (L52)');
});

test('#39 round 3 recheck (L56, N2): K told by its own alert clears its older drop out in a send that then fails', async () => {
  const rec = recWith([]);
  queueAlert(rec, 'K first', { now: T0, mark: mark('hold-x') });
  for (let i = 0; i < ALERT_UNTRIED_MAX; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  const a = await sendAlerts(rec, () => false, T0, { later: true, sendMs: 50, budgetMs: 1 }); // u0 carries K's drop; fails, unsettled
  queueAlert(rec, 'K again', { now: T0, mark: mark('hold-x') }); // fits: u0 is out
  // Deliver from the front until K's own copy is delivered and settled (rounds that settle at once).
  const texts = [];
  while (doc39(rec).entries.some((e) => e.key)) await sendAlerts(rec, (t) => { texts.push(t); }, T0, { sendMs: 50, budgetMs: 1 });
  assert.ok(texts.includes('K again'));
  a.settle(); // u0's failure: K's first listing is back
  assert.equal(droppedCount(doc39(rec)), 0, 'K was told by its own alert; its older drop is not counted again');
});

test('#39 round 3 recheck (L56, N1): through an outage as tick.mjs runs it, one cause stays listed once', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_UNTRIED_MAX + 60; i += 1) queueAlert(rec, `u${i}`, { now: T0 }); // full queue from an outage
  const counts = [];
  for (let pass = 0; pass < 10; pass += 1) {
    const early = await sendAlerts(rec, () => false, T0, { later: true, sendMs: 50 }); // port down
    queueAlert(rec, 'step stops failed', { now: T0, mark: mark('hold-x') }); // a step's cause, each pass
    for (let j = 0; j < 3; j += 1) queueAlert(rec, `fresh ${pass}-${j}`, { now: T0 }); // and three new one-offs
    early.settle();
    await sendAlerts(rec, () => false, T0, { sendMs: 50 }); // the last send fails too
    counts.push(doc39(rec).dropped_causes.length);
  }
  assert.ok(counts.at(-1) <= 1, 'one cause is listed once (L52)');
});
