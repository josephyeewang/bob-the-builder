// joe-waits.test.mjs — L130: a card put on Joe is told until a copy is delivered, and only a delivered copy marks it.
// Real Record (M9 setup, real permissions), the real outbox and sendAlerts (through withAlerts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitOnJoe, retellWaits, WAIT_TELL_FACT } from './joe-waits.mjs';
import { withAlerts } from './fixtures.test-helper.mjs';
import { waitOn } from './moves.mjs';
import { setup, product, readyCard, runCard } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ask = { what: 'dead_session: probe', link: 'card C-1', kind: 'dead_ask' };

function world() {
  const E = setup({ prefix: 'm11-joewaits-', probe: { kill() {}, pidStart: () => 'start' }, host: 'mac-a' });
  product(E);
  readyCard(E, 'C-1');
  runCard(E, 'C-1');
  const got = [];
  const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return true; };
  const pass = () => withAlerts(E.record, E.clock.t, port, (alert) => retellWaits({ rec: E.record, alert }));
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

test('L130: a tell recorded for an older wait is not re-told under a newer one', async () => {
  const w = world();
  assert.equal(waitOnJoe(w.E.record, 'C-1', { text: 'first', alert: () => false, now: w.E.clock.t, ...ask }).ok, true);
  // A later re-wait written straight (not through waitOnJoe): its `since` is not the one the tell recorded.
  w.E.clock.t += MIN;
  const again = waitOn(w.E.record, 'C-1', { who: 'joe', what: 'dead_session: probe again', now: w.E.clock.t, link: 'card C-1' });
  assert.equal(again.ok, true, again.reason);
  assert.notEqual(w.card().wait.since, w.tell().since);
  w.E.clock.t += MIN;
  assert.deepEqual(await w.pass(), []);
  assert.deepEqual(w.got, []);
});
