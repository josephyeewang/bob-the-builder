import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, product, readyCard, runCard, outboxFile, runnerLaunch, HEAD, put, must, PRODUCT } from './fixtures.test-helper.mjs';

test('smoke: draft → ready → claimed → running → hand-in → verified', () => {
  const env = setup();
  product(env);
  readyCard(env, 'C-1');
  assert.deepEqual(env.record.ready().map((c) => c.id), ['C-1']);
  runCard(env, 'C-1');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD }), 'head');
  const f = outboxFile(env, 'worker', 'S-1', 'handin-1.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review', fields: { summary: 'done' } })}\n`);
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, f), 'handin');
  assert.equal(env.record.read('card', 'C-1').doc.state, 'in_review');
  assert.equal(env.record.read('card', 'C-1').doc.claim, undefined);
  runnerLaunch(env, 'C-1', 'R-1');
  const v = outboxFile(env, 'reviewer', 'R-1', 'verdict-1.md', `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: env.record.read('card', 'C-1').rev, fields: { head: HEAD, pass: true } })}\n`);
  must(env.review.applyOutbox({ role: 'reviewer', sessionId: 'R-1', card: 'C-1' }, v), 'verdict');
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
  const kinds = env.record.diary().map((l) => l.kind);
  assert.ok(kinds.includes('claim'));
  assert.equal(env.alerts.filter((a) => a.type !== 'refused').length, 0, JSON.stringify(env.alerts));
});
