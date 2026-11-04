// undo.test.mjs — what an undo card undoes is read only from proof the right role made (L74 addendum 1): a fact
// in Sensors' `undo-issue-` family, made by Sensors. A look-alike (the same type, from another role or family) is
// ignored and does not hide the real one. The Record already refuses an undo card that names a look-alike, so the
// first test is the Record's own refusal; the second checks undoneBy itself, given a record that holds one anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoneBy } from './undo.mjs';
import { setup, must, plan, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('L74 addendum: the Record refuses an undo card whose source is a look-alike issue fact; the real one is taken', () => {
  const env = setup({ prefix: 'm6-undo-' });
  // The Dispatcher may write a fact in its own family, of any type, but it is not proof of an audit issue.
  must(env.record.write({ actor: 'dispatcher', entity: 'fact', id: 'stop-look', expectRev: 0, doc: { type: 'undo_issue', authenticated: true, commit: A } }), 'look-alike');
  const fake = env.record.write({ actor: 'dispatcher', entity: 'card', id: 'U-1', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source: { fact: 'stop-look' }, ...plan() } });
  assert.equal(fake.ok, false, JSON.stringify(fake));
  assert.match(fake.reason, /needs an answered Undo ask or an authenticated audit issue/, fake.reason);
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'undo-issue-1', expectRev: 0, doc: { type: 'undo_issue', authenticated: true, commit: B } }), 'issue');
  must(env.record.write({ actor: 'dispatcher', entity: 'card', id: 'U-2', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source: { fact: 'undo-issue-1' }, ...plan() } }), 'undo card');
  assert.deepEqual(undoneBy(env.record, env.record.read('card', 'U-2')), { commit: B, card: null });
});

test('L74 addendum: undoneBy ignores an issue fact from the wrong family or maker, and still reads the real one', () => {
  // A record that holds look-alikes anyway (an older store, a bug elsewhere): undoneBy checks family and maker itself.
  const facts = {
    'stop-look': { doc: { type: 'undo_issue', authenticated: true, commit: A }, by: 'dispatcher' },
    'undo-issue-fake': { doc: { type: 'undo_issue', authenticated: true, commit: A }, by: 'dispatcher' },
    'undo-issue-1': { doc: { type: 'undo_issue', authenticated: true, commit: B }, by: 'sensors' },
  };
  const cards = [{ id: 'M-A', doc: { state: 'merged', merge_commit: A } }, { id: 'M-B', doc: { state: 'merged', merge_commit: B } }];
  const record = {
    read: (entity, id) => (entity === 'fact' ? (facts[id] ? { id, doc: facts[id].doc } : null) : cards.find((c) => c.id === id) ?? null),
    list: (entity) => (entity === 'card' ? cards : []),
    meta: (entity, id) => (entity === 'fact' && facts[id] ? { createdBy: facts[id].by } : null),
  };
  const undo = (fact) => ({ id: 'U-1', doc: { kind: 'exact_reverse', source: { fact } } });
  assert.equal(undoneBy(record, undo('stop-look')), null);
  assert.equal(undoneBy(record, undo('undo-issue-fake')), null);
  assert.deepEqual(undoneBy(record, undo('undo-issue-1')), { commit: B, card: 'M-B' });
});
