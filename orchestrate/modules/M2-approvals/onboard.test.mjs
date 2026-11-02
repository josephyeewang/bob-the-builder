// onboard.test.mjs — a product's record is made once, as active, when its rules file says `onboarding.state: active`
// and it has none (LEAD-CALLS L204-b, L209): through the real pass, on the real M9 writer, and on M10's real engine with
// rules kept from the last good file. Never over a record that exists, in any state; never on any other value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { env, PRODUCT, must } from './fixtures.test-helper.mjs';
import { schedulePass } from './schedule.mjs';
import { onboard, ONBOARD_KEY } from './onboard.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { FIRST } from '../M10-rules/first-cutover.test-helper.mjs';

const ON = { [ONBOARD_KEY]: 'active' };
function world(values = ON) {
  const t = env({ values });
  t.ctx.stateDir = join(t.base, 'm2-state');
  return t;
}
const onboards = (t) => t.record.diary({}).filter((l) => l.entity === 'product' && l.kind === 'onboard');

test('a product with no record and `onboarding.state: active` gets one, active, written by approvals as onboard', async () => {
  const t = world();
  assert.equal(t.record.read('product', PRODUCT), null, 'the set-up makes no product record');
  const r = await schedulePass(t.ctx);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.events.filter((e) => e.type === 'onboarded'), [{ type: 'onboarded', product: PRODUCT }]);
  const p = t.record.read('product', PRODUCT);
  assert.equal(p.doc.state, 'active');
  assert.equal(p.rev, 1);
  const lines = onboards(t);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor, 'approvals');
  assert.equal(lines[0].id, PRODUCT);
});

test('a second pass after the create writes nothing new: no second onboard line', async () => {
  const t = world();
  await schedulePass(t.ctx);
  const before = t.record.diary({}).length;
  const r = await schedulePass(t.ctx);
  assert.ok(r.ok, r.reason);
  assert.equal(r.events.some((e) => e.type === 'onboarded' || e.type === 'onboard_refused'), false);
  assert.equal(onboards(t).length, 1);
  assert.equal(t.record.read('product', PRODUCT).rev, 1);
  assert.equal(t.record.diary({}).filter((l) => l.entity === 'product').length, 1);
  assert.ok(t.record.diary({}).length >= before);
});

test('an existing record in any state is never touched: a paused product stays paused, with no onboard line', async () => {
  for (const state of ['paused', 'away', 'light', 'active']) {
    const t = world();
    must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state } }), 'product');
    const r = await schedulePass(t.ctx);
    assert.ok(r.ok, r.reason);
    assert.equal(r.events.some((e) => e.type === 'onboarded' || e.type === 'onboard_refused'), false, `${state}: no write was tried`);
    const p = t.record.read('product', PRODUCT);
    assert.equal(p.doc.state, state, state);
    assert.equal(p.rev, 1, state);
    assert.equal(onboards(t).length, 0, state);
  }
});

test('a missing key, another case, a trailing space, another type or unreadable rules make no record', async () => {
  const cases = [
    ['missing', {}],
    ['Active', { [ONBOARD_KEY]: 'Active' }],
    ['trailing space', { [ONBOARD_KEY]: 'active ' }],
    ['a number', { [ONBOARD_KEY]: 123 }],
    ['a list', { [ONBOARD_KEY]: ['active'] }],
    ['a map', { [ONBOARD_KEY]: { state: 'active' } }],
    ['true', { [ONBOARD_KEY]: true }],
    ['paused', { [ONBOARD_KEY]: 'paused' }],
  ];
  for (const [name, values] of cases) {
    const t = world(values);
    const r = await schedulePass(t.ctx);
    assert.ok(r.ok, `${name}: ${r.reason}`);
    assert.equal(t.record.read('product', PRODUCT), null, name);
    assert.equal(onboards(t).length, 0, name);
  }
  // Rules that can't be read: the engine's get gives nothing, or throws.
  for (const [name, get] of [['undefined', () => undefined], ['throws', () => { throw new Error('rules unreadable'); }]]) {
    const t = world();
    const ctx = { ...t.ctx, rules: { ...t.ctx.rules, get } };
    assert.equal(onboard(ctx), null, name);
    assert.equal(t.record.read('product', PRODUCT), null, name);
  }
});

test('the key is read for this product: a Mac-wide read would never see it', () => {
  const t = world();
  const asked = [];
  const ctx = { ...t.ctx, rules: { get: (k, o) => { asked.push([k, o]); return o?.product === PRODUCT ? 'active' : undefined; } } };
  assert.deepEqual(onboard(ctx), { type: 'onboarded', product: PRODUCT });
  assert.deepEqual(asked, [[ONBOARD_KEY, { product: PRODUCT }]]);
});

test('a corrupt product record counts as a record: nothing is written over it', () => {
  const t = world();
  const ctx = { ...t.ctx, record: { ...t.record, read: () => ({ id: PRODUCT, entity: 'product', corrupt: true, reason: 'x' }), write: () => assert.fail('no write') } };
  assert.equal(onboard(ctx), null);
});

test('a refused write is reported as an event, not an onboard', () => {
  const t = world();
  const ctx = { ...t.ctx, record: { read: () => null, write: () => ({ ok: false, reason: 'rev moved' }) } };
  assert.deepEqual(onboard(ctx), { type: 'onboard_refused', product: PRODUCT, reason: 'rev moved' });
});

test('a bad approvals config stops the pass before any record is made', async () => {
  const t = world({ ...ON, 'approvals.push_windows': 'noon' });
  const r = await schedulePass(t.ctx);
  assert.equal(r.ok, false);
  assert.equal(t.record.read('product', PRODUCT), null);
});

test('on M10\'s real engine, rules kept from the last good file with the key make the record', async () => {
  const pol = parsePolicy(FIRST);
  assert.ok(pol.ok, pol.reason);
  for (const status of ['last_good', 'ok']) {
    const t = world();
    const rules = makeRules(makeEngine({
      products: [PRODUCT],
      rulesState: () => ({ status, policy: pol.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
      productState: () => null, running: () => 0,
      rolesDir: new URL('../M10-rules/roles', import.meta.url).pathname,
      clock: () => t.clock.t,
    }));
    assert.equal(rules.get(ONBOARD_KEY, { product: PRODUCT }), 'active', status);
    assert.deepEqual(onboard({ ...t.ctx, rules }), { type: 'onboarded', product: PRODUCT }, status);
    assert.equal(t.record.read('product', PRODUCT).doc.state, 'active', status);
  }
  // Rules the engine can't use (deny_all, none) give nothing, so nothing is made.
  for (const state of [null, { status: 'deny_all' }]) {
    const t = world();
    const rules = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => state, productState: () => null, running: () => 0,
      rolesDir: new URL('../M10-rules/roles', import.meta.url).pathname, clock: () => t.clock.t }));
    assert.equal(onboard({ ...t.ctx, rules }), null);
    assert.equal(t.record.read('product', PRODUCT), null);
  }
});
