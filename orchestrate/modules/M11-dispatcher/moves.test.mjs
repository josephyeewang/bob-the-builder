import { test } from 'node:test';
import assert from 'node:assert/strict';
import { move, waitOn, ageMs } from './moves.mjs';
import { recWith, T0, MIN, iso } from './fixtures.test-helper.mjs';

test('audit MIN-19: every move stamps changed_at, which the time limits read', () => {
  const rec = recWith([['card', 'C-1', { state: 'ready', changed_at: iso(T0 - 60 * MIN) }]]);
  assert.equal(move(rec, 'card', 'C-1', { state: 'claimed' }, { now: T0 }).ok, true);
  assert.equal(rec.read('card', 'C-1').doc.changed_at, iso(T0));
  assert.equal(ageMs(rec.read('card', 'C-1').doc, T0 + 5 * MIN), 5 * MIN);
  assert.equal(ageMs({}, T0), Infinity);
  assert.match(move(rec, 'card', 'C-9', {}, { now: T0 }).reason, /not in the record/);
});

test('audit MIN-20 (V1): a wait missing who or what is refused, and the card is left as it was', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }]]);
  assert.match(waitOn(rec, 'C-1', { who: '', what: 'x', now: T0 }).reason, /a wait needs who/);
  assert.match(waitOn(rec, 'C-1', { who: 'joe', what: undefined, now: T0 }).reason, /a wait needs what/);
  assert.equal(rec.read('card', 'C-1').doc.state, 'running');
  assert.equal(waitOn(rec, 'C-1', { who: 'joe', what: 'x', now: T0 }).ok, true);
  const w = rec.read('card', 'C-1').doc.waiting;
  assert.deepEqual([w.who, w.what, w.since, w.next_check], ['joe', 'x', iso(T0), iso(T0 + MIN)]);
});
