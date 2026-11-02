// undo-chain.test.mjs — LEAD-CALLS L81's done-test, end to end with no fakes for M2, M9, M6 or M10's count_approval.
// A real Undo ask is made and answered through M2's own path (createAsk, the schedule's push, one tap read by
// processSession); M11's undo step reads it and writes the exact_reverse card through the real M9 writer; M6's
// queueOrder serves that card first and M6's undoneBy judges it the exact reverse of the merged card.
// Fixtures follow lane 3's R-0b-140 stand-in (M2 undo-flag.test.mjs on its branch): a merged docs card, its merge doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { seed, plan, HEAD } from '../M9-record/fixtures.test-helper.mjs';
import { env as m2env, must, PRODUCT, session, write, box, tap } from '../M2-approvals/fixtures.test-helper.mjs';
import { createAsk, processSession } from '../M2-approvals/binding.mjs';
import { schedulePass } from '../M2-approvals/schedule.mjs';
import { queueOrder } from '../M6-merge-gate/gate.mjs';
import { undoneBy } from '../M6-merge-gate/undo.mjs';
import { undoStep, UNDO_CARD } from './undo.mjs';

const MIN = 60_000;
const SID = 'FD-1';
const FILES = ['docs/pricing.md'];
const here = dirname(fileURLToPath(import.meta.url));

// M10's real engine on its sample policy answers every rules.may; M2's settings (its timeouts, the owner) stay the
// fixture's values, which M10 does not hold.
function realRules(t) {
  const policy = parsePolicy(readFileSync(join(here, '../M10-rules/fixtures/policy.yaml'), 'utf8'));
  assert.ok(policy.ok, policy.reason);
  const eng = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, '../M10-rules/roles'), clock: () => t.clock.t }));
  const values = t.ctx.rules;
  return makeRules({ rev: eng.rev, may: (a, s) => eng.may(a, s), get: (k, o) => values.get(k, o), classify: (c) => eng.classify(c) });
}

// A docs change the Merge Gate merged: its card (merged) and its merge document (`merge_commit`, L81 d).
function merged(t, card = 'C-7', pr = 41) {
  seed(t, 'product', PRODUCT, { state: 'active' });
  seed(t, 'card', card, { state: 'merged', product: PRODUCT, lane: 'docs', title: 'Pricing page copy', merge_commit: HEAD, ...plan({ module: 'docs', files: FILES }) });
  seed(t, 'merge', `M-${card}`, { state: 'merged', card, pr, merge_commit: HEAD, product: PRODUCT });
}

// The owner's Undo ask, made and answered through M2's path; returns the world and the ask id.
async function answeredUndo({ choice = 'Undo', risky = [] } = {}) {
  const t = m2env();
  t.ctx.rules = realRules(t);
  session(t, SID);
  merged(t);
  const id = 'undo-C-7';
  must(createAsk(t.ctx, { id, kind: 'undo', card: 'C-7', title: 'Undo Pricing page copy (C-7, pull request #41)?', tier: 2, risky }), 'the undo ask');
  const pushes = [];
  Object.assign(t.ctx, { stateDir: join(t.base, 'm2-state'), push: async (e) => { pushes.push(e); return true; } });
  t.clock.t += MIN;
  must(await schedulePass(t.ctx), 'schedule');
  assert.equal(pushes.length, 1, 'the urgent undo ask is pushed at once');
  const doc = t.record.read('ask', id).doc;
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, SID, b.entry, tap(b.id, doc.payload, choice, t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  processSession(t.ctx, { sessionId: SID, sourcePath: t.log(SID) });
  return { t, id };
}

const step = (t) => undoStep({ rec: t.record, rules: t.ctx.rules, now: t.clock.t, filesOf: (sha) => (sha === HEAD ? FILES : null), alert: () => {} });

test('L81 done-test: a real answered Undo ask -> M11 writes the exact_reverse card through M9 -> M6 serves it first and judges it the exact reverse', async () => {
  const { t, id } = await answeredUndo();
  const ask = t.record.read('ask', id).doc;
  assert.equal(ask.state, 'answered');
  assert.deepEqual([ask.answer.channel, ask.answer.choice, ask.answer.approves], ['tap', 'Undo', true]);
  assert.equal(Object.hasOwn(ask, 'via'), false, 'no top-level via');

  assert.deepEqual(await step(t), [[id, 'undo card written']]);
  const undo = t.record.read('card', UNDO_CARD(id));
  assert.ok(undo, 'the undo card was written');
  assert.equal(undo.doc.kind, 'exact_reverse');
  assert.deepEqual(undo.doc.source, { ask: id });
  assert.equal(undo.doc.state, 'ready');
  assert.equal(t.record.meta('card', undo.id).createdBy, 'dispatcher', 'written by the Dispatcher through the real writer');
  assert.deepEqual(undo.doc.files, FILES);
  // A second pass writes no second card.
  assert.deepEqual(await step(t), []);
  assert.equal(t.record.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 1);

  seed(t, 'card', 'T-1', { state: 'ready', product: PRODUCT, ...plan({ tier: 1 }) });
  const cardOf = (c) => t.record.read('card', c)?.doc;
  const order = queueOrder([{ id: 'm1', doc: { card: 'T-1', queue_since: '2026-11-01T00:00:00Z' } }, { id: 'm2', doc: { card: undo.id, queue_since: '2026-11-03T00:00:00Z' } }], { cardOf });
  assert.deepEqual(order.map((m) => m.doc.card), [undo.id, 'T-1'], 'the reverse is served first');
  assert.deepEqual(undoneBy(t.record, undo), { commit: HEAD, card: 'C-7' });
});

test('L81 done-test: a Keep answer, or a tap on a risky change, writes no undo card', async () => {
  const keep = await answeredUndo({ choice: 'Keep' });
  assert.equal(keep.t.record.read('ask', keep.id).doc.answer.approves, false);
  assert.deepEqual(await step(keep.t), []);
  assert.equal(keep.t.record.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
  // A risky class needs the owner's GitHub Approve: M2 does not record the tap as counted, and M11 writes nothing.
  const risky = await answeredUndo({ risky: ['schema'] });
  assert.notEqual(risky.t.record.read('ask', risky.id).doc.state, 'answered');
  await step(risky.t);
  assert.equal(risky.t.record.list('card').filter((c) => c.doc.kind === 'exact_reverse').length, 0);
});
