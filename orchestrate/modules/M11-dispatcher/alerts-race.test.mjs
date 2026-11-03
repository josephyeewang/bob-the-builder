// L288 MAT-4: two processes write the alert queue (the Dispatcher queues, the alert channel's job sends and settles).
// Two views of one store on disk stand for the two processes. In each run the other process commits one write right
// after this process's n-th read of the queue fact, for every n the action makes: every window between a read and a
// write is tried. Nothing either process wrote may be lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../M9-record/fixtures.test-helper.mjs';
import { ALERT_QUEUE_FACT, queueAlert, dropCause, sendAlerts, WRITE_TRIES } from './alerts.mjs';

// `rec` with a hook after its n-th read of the queue fact (n counts from 1; 0 never fires). Answers the view and how
// many queue reads it saw.
function racing(rec, n, other) {
  const seen = { reads: 0, fired: false };
  // The record is frozen, so the view is a copy of its methods with `read` wrapped (its methods do not use `this`).
  const view = { ...rec, read: (e, id) => {
    const r = rec.read(e, id);
    if (e === 'fact' && id === ALERT_QUEUE_FACT && ++seen.reads === n) { seen.fired = true; other(); }
    return r;
  } };
  return { view, seen };
}
const texts = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).map((e) => e.text);

// Runs `act(view)` once without a race to count its queue reads, then once per window.
async function everyWindow(prepare, act, check) {
  const dry = setup({ prefix: 'm11-race-' });
  await prepare(dry);
  const { view, seen } = racing(dry.review, 0, () => {});
  await act(view, dry);
  assert.ok(seen.reads > 0, 'the action read no queue');
  for (let n = 1; n <= seen.reads; n += 1) {
    const env = setup({ prefix: 'm11-race-' });
    await prepare(env);
    const r = racing(env.review, n, () => assert.ok(queueAlert(env.record, 'alert X, queued by the other process', { now: env.clock.t })));
    const out = await act(r.view, env);
    assert.ok(r.seen.fired, `window ${n} never opened`);
    check(env, out, n);
  }
  return seen.reads;
}

test('L288 MAT-4 (probe D): the other process queues X while an alert is sent and settled; X is kept in every window', async () => {
  const sent = [];
  const reads = await everyWindow(
    (env) => { assert.ok(queueAlert(env.record, 'alert A', { now: env.clock.t })); },
    (view, env) => sendAlerts(view, async (t) => { sent.push(t); return true; }, env.clock.t, { sendMs: 1000, budgetMs: 5000 }),
    (env, out, n) => {
      const left = texts(env.record);
      assert.ok(left.includes('alert X, queued by the other process') || sent.includes('alert X, queued by the other process'), `window ${n}: X vanished (queue: ${JSON.stringify(left)})`);
      assert.ok(!left.includes('alert A'), `window ${n}: A was sent but left queued`);
      assert.equal(env.record.read('fact', ALERT_QUEUE_FACT).doc.dropped ?? 0, 0, `window ${n}: a drop was counted`);
    });
  assert.ok(reads >= 3, `expected the send to read the queue at least 3 times, saw ${reads}`);
});

test('L288 MAT-4: a failed send held back, a cause cleared, and a second alert queued: the other process\'s X is kept in every window', async () => {
  await everyWindow(
    (env) => { assert.ok(queueAlert(env.record, 'alert A', { now: env.clock.t })); },
    (view, env) => sendAlerts(view, async () => false, env.clock.t, { sendMs: 1000, budgetMs: 5000 }),
    (env, out, n) => {
      const left = texts(env.record);
      assert.deepEqual([...left].sort(), ['alert A', 'alert X, queued by the other process'], `window ${n}`);
      assert.equal(env.record.read('fact', ALERT_QUEUE_FACT).doc.entries.find((e) => e.text === 'alert A').held, true, `window ${n}: A not held`);
    });
  await everyWindow(
    (env) => { assert.ok(queueAlert(env.record, 'alert B', { now: env.clock.t, mark: { fact: 'stop-p1', fields: { told: true } } })); },
    (view) => dropCause(view, 'stop-p1'),
    (env, ok, n) => {
      assert.equal(ok, true, `window ${n}`);
      assert.deepEqual(texts(env.record), ['alert X, queued by the other process'], `window ${n}`);
    });
  await everyWindow(
    () => {},
    (view, env) => queueAlert(view, 'alert C', { now: env.clock.t }),
    (env, id, n) => {
      assert.ok(id, `window ${n}: C not queued`);
      assert.deepEqual([...texts(env.record)].sort(), ['alert C', 'alert X, queued by the other process'], `window ${n}`);
      const ids = env.record.read('fact', ALERT_QUEUE_FACT).doc.entries.map((e) => e.id);
      assert.equal(new Set(ids).size, 2, `window ${n}: two entries share an id`);
    });
});

test('L288 MAT-4: a queue that keeps changing under the write gives up after WRITE_TRIES and says so; nothing is overwritten', () => {
  const env = setup({ prefix: 'm11-race-' });
  let n = 0;
  const view = { ...env.review, read: (e, id) => {
    const r = env.review.read(e, id);
    if (e === 'fact' && id === ALERT_QUEUE_FACT) queueAlert(env.record, `other ${(n += 1)}`, { now: env.clock.t });
    return r;
  } };
  assert.equal(queueAlert(view, 'mine', { now: env.clock.t }), null);
  const left = texts(env.record);
  assert.ok(!left.includes('mine'));
  assert.ok(n >= WRITE_TRIES);
  for (let i = 1; i <= n; i += 1) assert.ok(left.includes(`other ${i}`), `other ${i} was overwritten`);
});

test('L288 MAT-4: the told mark merges into its fact as read at write time; another process\'s write to that fact is kept', async () => {
  for (const race of [false, true]) {
    const w = setup({ prefix: 'm11-race-' });
    const put = (doc) => { const cur = w.record.read('fact', 'stop-p1'); return w.record.write({ actor: 'dispatcher', entity: 'fact', id: 'stop-p1', expectRev: cur?.rev ?? 0, doc }); };
    assert.equal(put({ reason: 'first' }).ok, true);
    assert.ok(queueAlert(w.record, 'alert B', { now: w.clock.t, mark: { fact: 'stop-p1', fields: { told: true } } }));
    let fired = false;
    const view = { ...w.review, read: (e, id) => {
      const r = w.review.read(e, id);
      if (race && !fired && e === 'fact' && id === 'stop-p1') { fired = true; assert.equal(put({ reason: 'second' }).ok, true); }
      return r;
    } };
    const out = await sendAlerts(view, async () => true, w.clock.t, { sendMs: 1000, budgetMs: 5000 });
    assert.equal(out.sent, 1);
    assert.deepEqual(w.record.read('fact', 'stop-p1').doc, { reason: race ? 'second' : 'first', told: true }, `race ${race}`);
  }
});
