import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, memoryRecord, isActor, STATES, WAIT_FIELDS } from './record.mjs';

test('create, read, update only if unchanged, one diary line per accepted write', () => {
  const rec = memoryRecord();
  const w1 = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'ready' } });
  assert.deepEqual([w1.ok, w1.rev], [true, 1]);
  assert.deepEqual(rec.read('card', 'C-1').doc, { state: 'ready' });
  const stale = rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'claimed' } });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /changed since read/);
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 1, doc: { state: 'claimed' } }).rev, 2);
  const d = rec.diary();
  assert.equal(d.length, 2);
  assert.deepEqual([d[1].from_state, d[1].to_state, d[1].actor], ['ready', 'claimed', 'dispatcher']);
});

test('AI roles cannot call write; bad arguments are refused, not thrown', () => {
  const rec = memoryRecord();
  for (const w of [null, { actor: 'worker:S-1', entity: 'card', id: 'C', expectRev: 0 }, { actor: 'root', entity: 'card', id: 'C', expectRev: 0 },
    { actor: 'joe', entity: 'secrets', id: 'C', expectRev: 0 }, { actor: 'joe', entity: 'card', id: '../x', expectRev: 0 },
    { actor: 'joe', entity: 'card', id: 'C' }]) {
    assert.equal(rec.write(w).ok, false, JSON.stringify(w));
  }
  assert.equal(rec.diary().length, 0);
});

test('applyOutbox needs a known role and its session id', () => {
  const rec = memoryRecord();
  assert.equal(rec.applyOutbox({ role: 'merge_gate', sessionId: 'S' }, 'f').ok, false);
  assert.equal(rec.applyOutbox({ role: 'worker' }, 'f').ok, false);
  assert.equal(rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-1' }, '/o/report-C-1.md').ok, true);
  assert.equal(rec.diary()[0].actor, 'worker:S-4');
});

test('a throwing store comes back as a refusal', () => {
  const rec = makeRecord({ write() { throw new Error('disk full'); }, applyOutbox() { return 'yes'; } });
  assert.match(rec.write({ actor: 'joe', entity: 'card', id: 'C', expectRev: 0 }).reason, /disk full/);
  assert.equal(rec.applyOutbox({ role: 'lead', sessionId: 'S' }, 'f').ok, false);
});

test('names are fixed', () => {
  assert.ok(isActor('reviewer:S-9') && !isActor('reviewer') && !isActor('boss:S-1'));
  assert.ok(STATES.card.includes('reverted') && WAIT_FIELDS.length === 4);
});
