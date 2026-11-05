// stuck-cards.test.mjs — L569: a card past its time limit is told, once then daily, on the real engine. Nothing moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullTimeouts, must, product, seed, setup, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { STUCK_CARDS_FACT, tellStuckCards } from './stuck-cards.mjs';
import { putFact } from './pass.mjs';
import { tick } from './tick.mjs';
import { ALERT_QUEUE_FACT } from './alerts.mjs';
import { rulesWith } from './fixtures.test-helper.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LIMITS = fullTimeouts({ card: { merged: { minutes: 60, then: 'closed' } } });

function world(values = { timeouts: LIMITS }) {
  const t = setup({ prefix: 'm11-stuck-', values });
  product(t);
  const alert = fakeAlert();
  const card = (id, state) => seed(t, 'card', id, { state, product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 });
  const pass = (at) => {
    const n = alert.calls.length;
    const r = tellStuckCards({ rec: t.record, alert, now: at, report: (l) => assert.fail(l) });
    // The real outbox writes the mark once a copy is delivered; here every copy lands.
    for (const [, { mark }] of alert.calls.slice(n)) {
      const cur = t.record.read('fact', mark.fact)?.doc;
      must(putFact(t.record, mark.fact, { ...cur, ...mark.fields }, mark.kind, cur), 'the mark');
    }
    return r;
  };
  return { t, alert, card, pass, T0: t.clock.t };
}

// Written out, not read from the module: a state dropped there must fail here.
for (const state of ['ready', 'running', 'in_review', 'verified', 'approved']) {
  test(`L569: a card in ${state} is told once past its limit, then again a day later, and is not moved`, () => {
    const w = world();
    w.card('A', state);
    w.pass(w.T0 + 59 * MIN);
    assert.equal(w.alert.texts.length, 0, 'before the limit, nothing');
    assert.deepEqual(w.pass(w.T0 + 61 * MIN).stuck, ['A']);
    assert.equal(w.alert.texts.length, 1);
    assert.ok(w.alert.texts[0].startsWith(`card A (${state}) is past the time limit`), w.alert.texts[0]);
    w.pass(w.T0 + 62 * MIN);
    w.pass(w.T0 + 61 * MIN + DAY - MIN);
    assert.equal(w.alert.texts.length, 1, 'quiet inside the day');
    w.pass(w.T0 + 61 * MIN + DAY + MIN);
    assert.equal(w.alert.texts.length, 2, 'told again a day on');
    assert.equal(w.t.record.read('card', 'A').doc.state, state, 'a tell only');
  });
}

test('L569: merged stays quiet even with a limit and a then, and so do a draft and a wait', () => {
  const w = world();
  w.card('M', 'merged');
  w.card('D', 'draft');
  assert.deepEqual(w.t.record.overdue(w.T0 + 61 * MIN).map((o) => o.id), ['M'], 'the Record does list it, so this is the filter at work');
  assert.deepEqual(w.pass(w.T0 + 61 * MIN).stuck, []);
  assert.equal(w.alert.texts.length, 0);
});

test('L569: only cards are told: a session in `running` past its limit is not', () => {
  const w = world();
  seed(w.t, 'session', 'S', { state: 'running', product: PRODUCT });
  assert.ok(w.t.record.overdue(w.T0 + 61 * MIN).some((o) => o.entity === 'session'), 'the Record does list it');
  w.pass(w.T0 + 61 * MIN);
  assert.equal(w.alert.texts.length, 0);
});

test('L569: a time ahead of now counts as past the limit, and says the time can\'t be read', () => {
  const w = world();
  w.t.clock.t = w.T0 + 10 * DAY;
  w.card('A', 'ready');
  assert.deepEqual(w.pass(w.T0).stuck, ['A']);
  assert.match(w.alert.texts[0], /card A \(ready, its start time can't be read\) is past the time limit/);
});

test('L569: a time that can\'t be read at all counts as past the limit', () => {
  const w = world();
  w.card('A', 'ready');
  const late = { entity: 'card', id: 'A', state: 'ready', since: 'not a time', limit: 60 };
  const rec = Object.create(w.t.record, { overdue: { value: () => [late] } });
  tellStuckCards({ rec, alert: w.alert, now: w.T0, report: (l) => assert.fail(l) });
  assert.match(w.alert.texts[0], /card A \(ready, its start time can't be read\)/);
});

test('L569: a corrupt entry is told whatever it names, each with its reason', () => {
  const noRow = fullTimeouts();
  delete noRow.merge.merging;
  const w = world({ timeouts: noRow });
  seed(w.t, 'merge', 'R', { state: 'merging', product: PRODUCT });
  const r = w.pass(w.T0);
  assert.equal(r.broken, 1);
  assert.match(w.alert.texts[0], /^the time limits could not be worked out: the rules have no time limit for merge merging$/);
  w.pass(w.T0 + MIN);
  assert.equal(w.alert.texts.length, 1, 'once a day, like the rest');
});

test('L569: a Record that can\'t answer is told, not read as nothing stuck', () => {
  const w = world();
  const rec = Object.create(w.t.record, { overdue: { value: () => [{ entity: null, id: null, corrupt: true, reason: 'record error: no disk' }] } });
  tellStuckCards({ rec, alert: w.alert, now: w.T0, report: (l) => assert.fail(l) });
  assert.match(w.alert.texts[0], /record error: no disk/);
});

test('L569: a new stuck card is told at once, and the line names both; the mark clears when the last moves on', () => {
  const w = world();
  w.card('A', 'ready');
  w.pass(w.T0 + 61 * MIN);
  w.t.clock.t = w.T0 + 2 * 60 * MIN;
  w.card('B', 'running');
  w.pass(w.T0 + 3 * 60 * MIN + MIN);
  assert.equal(w.alert.texts.length, 2);
  assert.match(w.alert.texts[1], /^cards A \(ready\), B \(running\) are past the time limit/);
  w.card('A', 'closed');
  w.card('B', 'closed');
  w.pass(w.T0 + 4 * 60 * MIN);
  assert.equal(w.t.record.read('fact', STUCK_CARDS_FACT).doc.told_at, null);
  w.t.clock.t = w.T0 + 5 * 60 * MIN;
  w.card('A', 'ready');
  w.pass(w.T0 + 6 * 60 * MIN + MIN);
  assert.equal(w.alert.texts.length, 3, 'a wait that comes back is told afresh');
});

test('L569: a card that moves to another listed state is told at once, not held by the old mark', () => {
  const w = world();
  w.card('A', 'running');
  w.pass(w.T0 + 61 * MIN);
  w.t.clock.t = w.T0 + 2 * 60 * MIN;
  w.card('A', 'in_review');
  w.pass(w.T0 + 3 * 60 * MIN + MIN);
  assert.equal(w.alert.texts.length, 2);
  assert.match(w.alert.texts[1], /in_review/);
});

test('L569: a stuck card reaches the owner through a real tick, its step reporting ok', async () => {
  const w = world();
  w.card('A', 'ready');
  const r = await tick({ rec: w.t.record, rules: rulesWith(), now: w.T0 + 61 * MIN, ports: { alert: w.alert } });
  assert.equal(r.steps['stuck-cards'].ok, true, r.steps['stuck-cards'].error);
  assert.ok(w.alert.texts.some((x) => x.startsWith('card A (ready) is past the time limit')), w.alert.texts.join(' | '));
});

test('L569: a queued alert that cannot be dropped is reported, and the clear waits for the next pass', () => {
  const w = world();
  w.card('A', 'ready');
  w.pass(w.T0 + 61 * MIN);
  w.card('A', 'closed');
  const good = w.t.record;
  const rec = Object.create(good, { read: { value: (e, id) => { if (e === 'fact' && id === ALERT_QUEUE_FACT) throw new Error('the queue could not be read'); return good.read(e, id); } } });
  const lines = [];
  tellStuckCards({ rec, alert: w.alert, now: w.T0 + 62 * MIN, report: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.ok(good.read('fact', STUCK_CARDS_FACT).doc.told_at, 'the mark stays until the copy is gone');
});

test('L569: a pass writes to no card, only ever through the alert path', () => {
  const w = world();
  w.card('A', 'ready');
  const good = w.t.record;
  const writes = [];
  const rec = Object.create(good, { write: { value: (x) => { writes.push(x.entity); return good.write(x); } } });
  tellStuckCards({ rec, alert: w.alert, now: w.T0 + 61 * MIN, report: (l) => assert.fail(l) });
  assert.equal(w.alert.texts.length, 1);
  assert.deepEqual(writes, []);
});

test('L569: the same card and time in another state counts as a change, for a time that can\'t be read', () => {
  const w = world();
  const late = { entity: 'card', id: 'A', state: 'running', since: 'not a time', limit: 60 };
  let state = 'running';
  const rec = Object.create(w.t.record, { overdue: { value: () => [{ ...late, state }] } });
  const pass = (at) => {
    const n = w.alert.calls.length;
    tellStuckCards({ rec, alert: w.alert, now: at, report: (l) => assert.fail(l) });
    for (const [, { mark }] of w.alert.calls.slice(n)) {
      const cur = w.t.record.read('fact', mark.fact)?.doc;
      must(putFact(w.t.record, mark.fact, { ...cur, ...mark.fields }, mark.kind, cur), 'the mark');
    }
  };
  pass(w.T0);
  state = 'in_review';
  pass(w.T0 + MIN);
  assert.equal(w.alert.texts.length, 2);
});
