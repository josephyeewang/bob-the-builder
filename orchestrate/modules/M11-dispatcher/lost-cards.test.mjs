// lost-cards.test.mjs — L557: a card that can't be read is told, once then daily, on the real store, where list() leaves it out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadCard, must, planFile, product, put, readyCard, setup } from '../M9-record/fixtures.test-helper.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { createAsk } from '../M2-approvals/binding.mjs';
import { LOST_CARDS_FACT, tellLostCards } from './lost-cards.mjs';
import { putFact } from './pass.mjs';
import { tick } from './tick.mjs';
import { ALERT_QUEUE_FACT } from './alerts.mjs';
import { rulesWith } from './fixtures.test-helper.mjs';

const H = 3600_000;
const DAY = 24 * H;

function world(...ids) {
  const t = setup({ prefix: 'm11-lost-' });
  product(t);
  for (const id of ids) leadCard(t, id);
  const alert = fakeAlert();
  const path = (id) => join(t.root, 'docs', 'card', `${id}.json`);
  const pass = (at) => {
    const n = alert.calls.length;
    const r = tellLostCards({ rec: t.record, alert, now: at, report: (l) => assert.fail(l) });
    // The real outbox writes the mark once a copy is delivered; here every copy lands.
    for (const [, { mark }] of alert.calls.slice(n)) {
      const cur = t.record.read('fact', mark.fact)?.doc;
      must(putFact(t.record, mark.fact, { ...cur, ...mark.fields }, mark.kind, cur), 'the mark');
    }
    return r;
  };
  return { t, alert, path, pass, T0: t.clock.t };
}

test('L557: a corrupt card is left out of list() but told, once, then again a day later', () => {
  const w = world('A', 'B');
  writeFileSync(w.path('A'), 'not json');
  assert.deepEqual(w.t.record.list('card').map((c) => c.id), ['B'], 'the store really does leave it out, so no list could find it');
  assert.deepEqual(w.pass(w.T0).lost, ['A']);
  assert.equal(w.alert.texts.length, 1);
  assert.match(w.alert.texts[0], /^card A can't be read/);
  assert.match(w.alert.texts[0], /repaired by hand/);
  w.pass(w.T0 + 5 * 60_000);
  w.pass(w.T0 + 23 * H);
  assert.equal(w.alert.texts.length, 1, 'once within the day, however often the pass runs');
  w.pass(w.T0 + DAY);
  assert.equal(w.alert.texts.length, 2, 'again while it stands');
});

test('L557: a card file gone from disk is told the same way, and nothing is said about cards that read', () => {
  const w = world('A');
  readyCard(w.t, 'B');   // only a first version may be missing after a crash: a later one was removed by hand
  assert.deepEqual(w.pass(w.T0).lost, []);
  assert.equal(w.alert.texts.length, 0);
  rmSync(w.path('B'));
  assert.deepEqual(w.pass(w.T0 + H).lost, ['B']);
  assert.equal(w.alert.texts.length, 1);
});

test('L557: a card written second on a diary line, as every plan writes them, is found', () => {
  const w = world();
  const entry = (id) => ({ id, tier: 2, module: 'M1', depends_on: [], brief: { goal: `the goal of ${id}`, done_when: 'tests pass', files: ['src/a.mjs'] } });
  must(planFile(w.t, [entry('A'), entry('B')]));
  assert.equal(w.t.record.diary({ since: 0 }).at(-1).id, 'A', 'the line names only its first write');
  writeFileSync(w.path('B'), 'x');
  assert.deepEqual(w.pass(w.T0).lost, ['B']);
});

test('L557: several lost cards are one line, and a change in the list is told at once', () => {
  const w = world('A', 'B', 'C');
  writeFileSync(w.path('B'), 'x');
  writeFileSync(w.path('A'), 'x');
  w.pass(w.T0);
  assert.equal(w.alert.texts.length, 1);
  assert.match(w.alert.texts[0], /^cards A, B can't be read/);
  writeFileSync(w.path('C'), 'x');
  w.pass(w.T0 + H);
  assert.equal(w.alert.texts.length, 2, 'a new card does not wait out the day');
  assert.match(w.alert.texts[1], /^cards A, B, C can't/);
});

test('L557: the mark clears when the cards read again, so a card lost later is told afresh', () => {
  const w = world('A');
  writeFileSync(w.path('A'), 'x');
  w.pass(w.T0);
  w.t.recover();
  assert.deepEqual(w.pass(w.T0 + H).lost, []);
  assert.equal(w.t.record.read('fact', LOST_CARDS_FACT).doc.told_at, null, 'nothing waits, so the mark is gone');
  writeFileSync(w.path('A'), 'x');
  w.pass(w.T0 + 2 * H);
  assert.equal(w.alert.texts.length, 2, 'lost again: told again, not held by the old mark');
});

test('L557: a card whose go is still asked is left to M2, so it is not told twice; once the ask ends it is told here', () => {
  const w = world('A', 'B');
  must(createAsk({ record: w.t.record, now: () => w.t.clock.t }, { id: 'go-1', kind: 'go_t2', card: 'A', title: 'Go on A', fingerprint: 'a'.repeat(64), files: ['src/a.mjs'] }));
  assert.equal(askStore(w.t.record).ask('go-1').doc.state, 'open');
  writeFileSync(w.path('A'), 'x');
  assert.deepEqual(w.pass(w.T0).lost, []);
  assert.equal(w.alert.texts.length, 0);
  must(put(w.t.record, 'approvals', 'ask', 'go-1', { state: 'withdrawn' }), 'the ask ends');
  assert.deepEqual(w.pass(w.T0 + H).lost, ['A']);
  assert.equal(w.alert.texts.length, 1);
});

test('L557: an alert that is refused keeps no mark, and the next pass tries again', () => {
  const w = world('A');
  writeFileSync(w.path('A'), 'x');
  const lostAlert = fakeAlert({ answer: false });
  tellLostCards({ rec: w.t.record, alert: lostAlert, now: w.T0, report: (l) => assert.fail(l) });
  tellLostCards({ rec: w.t.record, alert: lostAlert, now: w.T0 + 60_000, report: (l) => assert.fail(l) });
  assert.equal(lostAlert.calls.length, 2);
});

test('L557: it only tells: no card is written, and the corrupt file is left as it was', () => {
  const w = world('A');
  writeFileSync(w.path('A'), 'x');
  const before = w.t.record.diary({ since: 0 }).filter((l) => l.entity === 'card').length;
  w.pass(w.T0);
  assert.equal(w.t.record.diary({ since: 0 }).filter((l) => l.entity === 'card').length, before);
  assert.equal(w.t.record.read('card', 'A').corrupt, true);
});

test('L575: a diary that throws is not swallowed, so the tick step failure tells it', () => {
  const w = world('A');
  const good = w.t.record;
  // The go check reads the diary first and the card walk second: each is tried failing alone.
  for (const failsOn of [1, 2]) {
    let n = 0;
    const rec = Object.create(good, { diary: { value: (o) => { n += 1; if (n === failsOn) throw new Error('the diary could not be opened'); return good.diary(o); } } });
    assert.throws(() => tellLostCards({ rec, alert: w.alert, now: w.T0, report: (l) => assert.fail(l) }), /could not be opened/, `read ${failsOn}`);
  }
});

test('L575: a queued alert that cannot be dropped is reported, and the clear waits for the next pass', () => {
  const w = world('A');
  writeFileSync(w.path('A'), 'x');
  w.pass(w.T0);
  w.t.recover();
  const good = w.t.record;
  const rec = Object.create(good, { read: { value: (e, id) => { if (e === 'fact' && id === ALERT_QUEUE_FACT) throw new Error('the queue could not be read'); return good.read(e, id); } } });
  const lines = [];
  tellLostCards({ rec, alert: w.alert, now: w.T0 + 60_000, report: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(LOST_CARDS_FACT));
  assert.equal(typeof good.read('fact', LOST_CARDS_FACT).doc.told_at, 'string', 'the mark stays until the drop works');
});

test('L575: a lost card reaches the owner through a real tick', async () => {
  const w = world('A', 'B');
  writeFileSync(w.path('A'), 'x');
  await tick({ rec: w.t.record, rules: rulesWith({}), now: w.T0, ports: { alert: w.alert } });
  assert.deepEqual(w.alert.texts.filter((t) => /can't be read/.test(t)).map((t) => t.slice(0, 19)), ["card A can't be rea"]);
});
