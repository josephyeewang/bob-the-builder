// queue-refused-told.test.mjs — L545: an alert whose queue write gives up still reaches the owner.
//
// WHY. The outbox queue is a Record fact. When the Record won't take that write, the alert has nowhere to wait, and a
// refused write is only logged (store.mjs refuse goes through `say`, never kept). This runs a real store, a queue write
// refused at the Record, and follows the alert into the store's unsent file and out through M13's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_QUEUE_FACT, outbox, queueAlert, settleAlert, tellThen } from '../modules/M11-dispatcher/alerts.mjs';
import { setup } from '../modules/M9-record/fixtures.test-helper.mjs';
import { readUnsent } from '../modules/M9-record/unsent.mjs';
import { storeText } from '../modules/M13-ledger/alert-channel.mjs';

const T0 = Date.parse('2026-11-04T12:00:00Z');

// The real Record, with every write of the queue fact refused.
const queueRefused = (record) => Object.create(record, {
  write: { value: (w) => (w.entity === 'fact' && w.id === ALERT_QUEUE_FACT ? { ok: false, reason: 'the disk said no' } : record.write(w)) },
});

test('L545: a refused queue write: the alert is in the unsent file and M13 would send its text', () => {
  const env = setup({ prefix: 'orch-qrefused-', extra: { alert: () => false } });
  const told = outbox(queueRefused(env.record), T0)('the usage band is red');
  assert.equal(told, false, 'the site still hears that it was not queued');
  const kept = readUnsent(env.root);
  assert.equal(kept.length, 1, 'kept in the unsent file, so the owner hears it');
  const text = storeText(kept[0].event, 'sample-app');
  assert.match(text, /the usage band is red/);
  assert.match(text, /the disk said no/);
});

test('L545: a site telling every pass is one line a day, keyed on its mark, and each pass still hears "not queued"', () => {
  const env = setup({ prefix: 'orch-qrefused-', extra: { alert: () => false } });
  const rec = queueRefused(env.record);
  for (let i = 0; i < 60; i += 1) {
    const did = tellThen(outbox(rec, T0 + i), `band red, pass ${i}`, { fact: 'stop-q', fields: { told_at: 'x' }, kind: 'k' });
    assert.notEqual(did, true, 'nothing was queued');
  }
  assert.equal(readUnsent(env.root).length, 1);
  assert.match(readUnsent(env.root)[0].event.text, /band red, pass 0/);
});

test('L545: a conflict that a second try wins is no give-up: nothing is kept', () => {
  const env = setup({ prefix: 'orch-qrefused-', extra: { alert: () => false } });
  let first = true;
  const rec = Object.create(env.record, {
    write: { value: (w) => {
      if (!(w.entity === 'fact' && w.id === ALERT_QUEUE_FACT && first)) return env.record.write(w);
      first = false;
      // Another writer got there first: the version moved, so this try lost and the next one is a fresh try.
      env.record.write({ ...w, doc: { entries: [] }, kind: 'alert_queued' });
      return { ok: false, reason: 'the fact moved under this write' };
    } },
  });
  assert.equal(outbox(rec, T0)('the band is red'), true);
  assert.equal(first, false, 'the first try was refused');
  assert.equal(readUnsent(env.root).length, 0);
});

test('L545: a settle that can not write the queue keeps one line, on the queue\'s own key', () => {
  const env = setup({ prefix: 'orch-qrefused-', extra: { alert: () => false } });
  const queued = outbox(env.record, T0)('told already');
  assert.equal(queued, true);
  const entry = env.record.read('fact', ALERT_QUEUE_FACT).doc.entries[0];
  const rec = queueRefused(env.record);
  for (let i = 0; i < 3; i += 1) assert.equal(settleAlert(rec, entry, true, T0 + i).ok, false);
  const kept = readUnsent(env.root);
  assert.equal(kept.length, 1);
  assert.match(storeText(kept[0].event, 'sample-app'), /alert queue can't be written/);
  assert.doesNotMatch(kept[0].event.text, /told already/, 'that alert was delivered: its text is not repeated');
});

test('L545: a Record that throws on the queue write: the alert is kept and the throw still reaches the caller', () => {
  const env = setup({ prefix: 'orch-qrefused-', extra: { alert: () => false } });
  const rec = Object.create(env.record, { write: { value: (w) => { if (w.id === ALERT_QUEUE_FACT) throw new Error('the store broke'); return env.record.write(w); } } });
  assert.equal(outbox(rec, T0)('the band is red'), false);
  assert.match(readUnsent(env.root)[0]?.event.text ?? '', /the band is red.*the store broke/);
  assert.throws(() => queueAlert(rec, 'the band is red', { now: T0 }), /the store broke/);
});

