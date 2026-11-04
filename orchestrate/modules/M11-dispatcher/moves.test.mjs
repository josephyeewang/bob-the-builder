import { test } from 'node:test';
import assert from 'node:assert/strict';
import { move, waitOn, ageMs } from './moves.mjs';
import { recWith, setClock, T0, MIN, iso } from './fixtures.test-helper.mjs';

test('audit MIN-19 (L72): no move stamps a time; the time limits read the Record\'s own clock', () => {
  const rec = recWith([['card', 'C-1', { state: 'ready', changed_at: iso(T0 - 60 * MIN) }]]);
  assert.equal(ageMs(rec, 'card', 'C-1', T0), 60 * MIN);
  assert.equal(waitOn(rec, 'C-1', { who: 'joe', what: 'x', now: T0 }).ok, true);
  assert.equal('changed_at' in rec.read('card', 'C-1').doc, false, 'the Dispatcher writes no time of its own');
  assert.equal(ageMs(rec, 'card', 'C-1', T0 + 5 * MIN), 5 * MIN, 'the age runs from the move into waiting');
  // A write that keeps the state moves the last-write time only.
  setClock(rec, T0 + 2 * MIN);
  assert.equal(move(rec, 'card', 'C-1', { summary: 's' }).ok, true);
  assert.equal(ageMs(rec, 'card', 'C-1', T0 + 5 * MIN), 5 * MIN);
  assert.equal(ageMs(rec, 'card', 'C-1', T0 + 5 * MIN, { since: 'write' }), 3 * MIN);
  // Unknown is Infinity: an entry not in the record, or a Record that can't say.
  assert.equal(ageMs(rec, 'card', 'C-9', T0), Infinity);
  assert.equal(ageMs({ read: () => null }, 'card', 'C-1', T0), Infinity);
  assert.match(move(rec, 'card', 'C-9', {}).reason, /not in the record/);
});

test('audit MIN-20 (V1): a wait missing who or what is refused, and the card is left as it was', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }]]);
  assert.match(waitOn(rec, 'C-1', { who: '', what: 'x', now: T0 }).reason, /a wait needs who/);
  assert.match(waitOn(rec, 'C-1', { who: 'joe', what: undefined, now: T0 }).reason, /a wait needs what/);
  assert.equal(rec.read('card', 'C-1').doc.state, 'running');
  assert.equal(waitOn(rec, 'C-1', { who: 'joe', what: 'x', now: T0 }).ok, true);
  const w = rec.read('card', 'C-1').doc.wait;
  assert.deepEqual([w.who, w.what, w.since, w.next_check, w.resume, w.return_to], ['joe', 'x', iso(T0), iso(T0 + MIN), 'retry', 'ready']);
  assert.match(waitOn(rec, 'C-1', { who: 'lead', what: 'x', now: T0 }).reason, /wait.who must be one of/);
});
