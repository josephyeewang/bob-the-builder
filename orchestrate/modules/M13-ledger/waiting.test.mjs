import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { waitingItems, waitingLines } from './waiting.mjs';

function seed() {
  const rec = memoryRecord();
  const w = (entity, id, doc) => assert.equal(rec.write({ actor: 'dispatcher', entity, id, expectRev: 0, doc }).ok, true);
  w('card', 'C-1', { module: 'M4', state: 'waiting', wait: { who: 'joe', what: 'go on the plan', since: '2026-11-03T08:00:00Z', next_check: '2026-11-03T17:00:00Z' } });
  w('ask', 'A-2', { module: 'M4', state: 'pushed', wait: { who: 'joe', what: 'Approve PR 12', since: '2026-11-02T17:00:00Z' } });
  w('card', 'C-3', { module: 'M4', state: 'running' });
  w('card', 'C-4', { module: 'M4', state: 'waiting', wait: { what: 'the Mini', since: '2026-11-03T09:00:00Z' } });
  w('card', 'C-5', { module: 'M4', state: 'waiting' });
  return rec;
}

test('every waiting item is listed with who / what / since from the record, oldest first', () => {
  const items = waitingItems(seed());
  assert.deepEqual(items.map((i) => i.id), ['C-5', 'A-2', 'C-1', 'C-4']);
  const a2 = items.find((i) => i.id === 'A-2');
  assert.deepEqual([a2.who, a2.what, a2.since], ['joe', 'Approve PR 12', '2026-11-02T17:00:00Z']);
  assert.ok(!items.some((i) => i.id === 'C-3'));
});

test('planted: an item with a missing field shows as a record error, not blank', () => {
  const lines = waitingLines(waitingItems(seed()));
  assert.ok(lines.includes('record error: card C-4 is waiting with no who'));
  assert.ok(lines.includes('record error: card C-5 is waiting with no who, what, since'));
  assert.ok(lines.includes('ask A-2: waits on joe for Approve PR 12, since 2026-11-02T17:00:00Z'));
  for (const l of lines) assert.ok(!/undefined|null|waits on  /.test(l), l);
});
