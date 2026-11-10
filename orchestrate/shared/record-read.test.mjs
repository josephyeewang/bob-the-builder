import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, memoryRecord } from './record.mjs';
import { readDoc, docOrThrow, RecordReadError } from './record-read.mjs';

// The real memoryRecord behind the real makeRecord wrapper; fail(true) makes the store throw on read, as a busy or broken
// store does, so the wrapper answers { corrupt: true } exactly as it does in production.
function world() {
  const real = memoryRecord();
  let failing = false;
  const impl = {
    read: (e, id) => { if (failing) throw new Error('SQLITE_BUSY'); return real.read(e, id); },
    list: (e) => real.list(e),
    write: (w) => real.write(w),
    diary: (o) => real.diary(o),
  };
  return { rec: makeRecord(impl), real, fail: (v) => { failing = v; } };
}

test('readDoc: found, absent and failed are three answers; a failed read is never absent', () => {
  const w = world();
  assert.deepEqual(readDoc(w.rec, 'fact', 'usage-a'), { state: 'absent' });
  assert.equal(w.real.write({ actor: 'sensors', entity: 'fact', id: 'usage-a', expectRev: 0, doc: { a: 1 } }).ok, true);
  const f = readDoc(w.rec, 'fact', 'usage-a');
  assert.deepEqual([f.state, f.doc, f.rev], ['found', { a: 1 }, 1]);
  w.fail(true);
  const bad = readDoc(w.rec, 'fact', 'usage-a');
  assert.deepEqual([bad.state, bad.reason], ['failed', 'record error: SQLITE_BUSY']);
  assert.equal(w.rec.read('fact', 'usage-a')?.doc ?? null, null, 'the pattern this replaces reads the same failure as "none"');
});

test('readDoc: a Record that throws, a row with no doc, and no Record at all are failed; it never throws', () => {
  assert.equal(readDoc({ read: () => { throw new Error('boom'); } }, 'fact', 'usage-a').state, 'failed');
  assert.deepEqual(readDoc({ read: () => ({ id: 'x', rev: 1 }) }, 'fact', 'usage-a'), { state: 'failed', reason: 'no document' });
  assert.deepEqual(readDoc({ read: () => ({ id: 'x', rev: 1, doc: 'text' }) }, 'fact', 'usage-a'), { state: 'failed', reason: 'no document' });
  assert.equal(readDoc(null, 'fact', 'usage-a').state, 'failed');
});

test('readDoc never throws (audit #346 m1, m3): a thrown value with no text form, a row whose corrupt field throws; rev is null when the row has none', () => {
  assert.deepEqual(readDoc({ read: () => { throw Object.create(null); } }, 'fact', 'usage-a'), { state: 'failed', reason: 'record error: unreadable error' });
  const trap = { read: () => ({ id: 'x', doc: { a: 1 }, get corrupt() { throw Object.create(null); } }) };
  assert.deepEqual(readDoc(trap, 'fact', 'usage-a'), { state: 'failed', reason: "the read's answer could not be checked: unreadable error" });
  assert.throws(() => docOrThrow(trap, 'fact', 'usage-a', 'the mark'), RecordReadError, 'docOrThrow still throws only its own error');
  assert.deepEqual(readDoc({ read: () => ({ id: 'x', doc: { a: 1 } }) }, 'fact', 'usage-a'), { state: 'found', doc: { a: 1 }, rev: null });
});

test('readDoc: the store\'s own corrupt answer (no throw) is failed with its reason; an entity M9 does not know is absent', () => {
  const rec = makeRecord({ read: (e, id) => ({ id, entity: e, corrupt: true, reason: 'not a plain readable file' }), list: () => [], diary: () => [] });
  assert.deepEqual(readDoc(rec, 'fact', 'usage-a'), { state: 'failed', reason: 'not a plain readable file' });
  assert.deepEqual(readDoc({ read: () => ({ id: 'x', corrupt: 1, doc: { a: 1 } }) }, 'fact', 'usage-a').state, 'failed', 'any truthy corrupt, even with a doc');
  assert.throws(() => docOrThrow(rec, 'fact', 'usage-a', 'the mark'), /^RecordReadError: the mark could not be read \(not a plain readable file\)$/);
  assert.deepEqual(readDoc(world().rec, 'no_such_entity', 'x'), { state: 'absent' }, 'as makeRecord answers it');
});

test('docOrThrow: the doc, null when absent, RecordReadError when the read failed', () => {
  const w = world();
  assert.equal(docOrThrow(w.rec, 'fact', 'usage-a'), null);
  w.real.write({ actor: 'sensors', entity: 'fact', id: 'usage-a', expectRev: 0, doc: { a: 1 } });
  assert.deepEqual(docOrThrow(w.rec, 'fact', 'usage-a'), { a: 1 });
  w.fail(true);
  assert.throws(() => docOrThrow(w.rec, 'fact', 'usage-a', 'the mark'),
    (e) => e instanceof RecordReadError && e.message === 'the mark could not be read (record error: SQLITE_BUSY)' && e.reason === 'record error: SQLITE_BUSY');
  assert.throws(() => docOrThrow(w.rec, 'fact', 'usage-a'), /^RecordReadError: fact usage-a could not be read/);
});
