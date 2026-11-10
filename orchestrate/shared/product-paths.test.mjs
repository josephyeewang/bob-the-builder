// L836, L848: the one definition of the worker runner's per-product places (product-paths.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT, productRoleClash, runnerCopy, runnerOutbox, runnerPlaces } from './product-paths.mjs';
import * as status from '../wiring/owner-status.mjs';

test('L836: a copy is <copiesRoot>/<product>/<card>, an outbox <outboxRoot>/<product>/<role>/<sessionId>', () => {
  assert.deepEqual(runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product: 'p1' }), { copies: '/c/p1', outboxes: '/o/p1' });
  assert.equal(runnerCopy({ copiesRoot: '/c', product: 'p1', card: 'C-1' }), '/c/p1/C-1');
  assert.equal(runnerOutbox({ outboxRoot: '/o', product: 'p1', role: 'worker', sessionId: 'S-1' }), '/o/p1/worker/S-1');
  // owner-status.mjs re-exports the same functions (L848): one definition, not a copy.
  for (const f of ['PRODUCT', 'productRoleClash', 'runnerPlaces', 'runnerCopy', 'runnerOutbox']) assert.equal(status[f], { PRODUCT, productRoleClash, runnerPlaces, runnerCopy, runnerOutbox }[f], f);
});

test('L836, #378 M1: a product is a name setup makes a folder for, never a role\'s, in any letter case', () => {
  for (const product of ['worker', 'script', 'lead', 'reviewer']) assert.throws(() => runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product }), /named as a role/, product);
  for (const product of ['Alpha', 'p.1', 'p_1', '-p', '', 'a'.repeat(65), 'p/q', '..', undefined]) assert.throws(() => runnerPlaces({ copiesRoot: '/c', outboxRoot: '/o', product }), /not a product name setup makes a folder for/, String(product));
  assert.equal(productRoleClash('Worker'), true); assert.equal(productRoleClash('p1'), false); assert.equal(productRoleClash(undefined), false);
  assert.equal(PRODUCT.test('a'.repeat(64)), true);
});

test('L848: a card, role or session id that is not one plain folder name is refused', () => {
  for (const card of ['a/b', '..', 'a..b', '.hidden', '', 'a\0b', undefined, 7]) assert.throws(() => runnerCopy({ copiesRoot: '/c', product: 'p1', card }), /not a card that names one plain folder/, String(card));
  for (const role of ['../worker', '.w', 'w/x', '']) assert.throws(() => runnerOutbox({ outboxRoot: '/o', product: 'p1', role, sessionId: 'S-1' }), /not a role that names one plain folder/, role);
  for (const sessionId of ['../S', '.S', 'S/1', '', undefined]) assert.throws(() => runnerOutbox({ outboxRoot: '/o', product: 'p1', role: 'worker', sessionId }), /not a session id that names one plain folder/, String(sessionId));
});

test('#378 r1 c1: a plain folder name is the card and session id characters only, so the helper is safe by itself', () => {
  for (const card of ['a b', 'a\nb', 'a\tb', 'é', 'a:b', 'a\\b', 'x'.repeat(201)]) assert.throws(() => runnerCopy({ copiesRoot: '/c', product: 'p1', card }), /not a card that names one plain folder/, JSON.stringify(card));
  for (const card of ['C-1', 'c_1', 'a.b', '-x', 'x'.repeat(200)]) assert.equal(runnerCopy({ copiesRoot: '/c', product: 'p1', card }), `/c/p1/${card}`);
});
