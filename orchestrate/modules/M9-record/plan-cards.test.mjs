import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HEAD, HEAD2, PRODUCT, iso, leadCard, must, outboxFile, plan, planFile, product, put, roadmap, setup } from './fixtures.test-helper.mjs';

const world = () => { const env = setup({ prefix: 'm9-plan-' }); product(env); return env; };
const entry = (id, over = {}) => ({ id, tier: 2, module: 'M1', depends_on: [], brief: { goal: `the goal of ${id}`, done_when: 'tests pass', files: ['src/a.mjs'] }, ...over });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const launch = (env, sid = 'L-1', head = HEAD) => must(env.record.write({ actor: 'dispatcher', entity: 'launch', id: `lead-${sid}`, expectRev: 0, doc: { session_id: sid, role: 'lead', card: null, head, rev: null, product: PRODUCT, launched_at: iso(env.clock.t) } }));
const hand = (env, text, tag = {}) => env.record.applyOutbox({ role: 'lead', sessionId: 'L-1', checked_sha256: sha(text), ...tag }, outboxFile(env, 'lead', 'L-1', `plan-${Math.random().toString(36).slice(2)}.json`, text));

test('R-0b-170: a plan makes its draft cards in one diary line, written by the Lead, with the file\'s hash and the launch\'s main commit', () => {
  const env = world();
  const r = planFile(env, [entry('A', { tier: 1 }), entry('B', { depends_on: ['A'], module: 'M2', brief: { goal: 'b', done_when: 'it works', files: ['src/b.mjs'] } })], { head: HEAD2 });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([r.created, r.updated, r.dropped], [['A', 'B'], [], []]);
  const a = env.record.read('card', 'A').doc;
  assert.deepEqual([a.state, a.kind, a.product, a.tier, a.module, a.main_commit, a.what, a.done_when], ['draft', 'ordinary', PRODUCT, 1, 'M1', HEAD2, 'the goal of A', 'tests pass']);
  assert.match(a.plan_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(env.record.read('card', 'B').doc.depends_on, ['A']);
  const lines = env.record.diary().filter((l) => l.kind === 'plan');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor, 'lead:L-1');
  assert.deepEqual(lines[0].writes.map((w) => w.id), ['A', 'B']);
});

test('R-0b-170: anything typed as plan_sha256 or main_commit in a plan is ignored', () => {
  const env = world();
  launch(env);
  const text = JSON.stringify({ cards: [{ ...entry('A'), plan_sha256: 'd'.repeat(64), main_commit: 'c'.repeat(40) }] });
  must(hand(env, text));
  const { doc } = env.record.read('card', 'A');
  assert.equal(doc.plan_sha256, sha(text));
  assert.equal(doc.main_commit, HEAD);
});

test('R-0b-170: only the bytes the plan check read are applied', () => {
  const env = world();
  launch(env);
  const text = JSON.stringify({ cards: [entry('A')] });
  assert.match(hand(env, text, { checked_sha256: undefined }).reason, /not the one the plan check read/);
  assert.match(hand(env, text, { checked_sha256: 'd'.repeat(64) }).reason, /not the one the plan check read/);
  assert.equal(env.record.read('card', 'A'), null);
});

test('R-0b-170: a Lead with no launch record, or whose newest launch names no commit, has its plan refused', () => {
  const env = world();
  const text = JSON.stringify({ cards: [entry('A')] });
  assert.match(hand(env, text).reason, /no launch record naming the main commit/);
  must(env.record.write({ actor: 'dispatcher', entity: 'launch', id: 'lead-old', expectRev: 0, doc: { session_id: 'L-1', role: 'lead', card: null, head: HEAD, rev: null, launched_at: iso(env.clock.t) } }));
  must(env.record.write({ actor: 'dispatcher', entity: 'launch', id: 'lead-new', expectRev: 0, doc: { session_id: 'L-1', role: 'lead', card: null, head: 'not a sha', rev: null, launched_at: iso(env.clock.t) } }));
  assert.match(hand(env, text).reason, /no launch record naming the main commit/, 'never the launch before it');
  assert.equal(env.record.read('card', 'A'), null);
});

test('R-0b-170: another Lead\'s launch record does not count for this Lead', () => {
  const env = world();
  launch(env, 'L-2');
  assert.match(hand(env, JSON.stringify({ cards: [entry('A')] })).reason, /no launch record naming the main commit/);
  assert.equal(env.record.read('card', 'A'), null);
});

test('R-0b-170: a later plan updates draft cards, and names the cards it left out', () => {
  const env = world();
  must(planFile(env, [entry('A'), entry('B', { brief: { goal: 'b', done_when: 'd', files: ['src/b.mjs'] } })]));
  const r = planFile(env, [entry('A', { tier: 1 }), entry('C', { brief: { goal: 'c', done_when: 'd', files: ['src/c.mjs'] } })]);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([r.created, r.updated, r.dropped], [['C'], ['A'], ['B']]);
  assert.equal(env.record.read('card', 'A').doc.tier, 1);
  assert.equal(env.record.read('card', 'B').doc.state, 'draft', 'left as it was');
});

test('R-0b-170: a plan is all or nothing: a card past draft, a new module or new depends_on turns the whole plan down', () => {
  const env = world();
  must(planFile(env, [entry('A'), entry('B', { brief: { goal: 'b', done_when: 'd', files: ['src/b.mjs'] } })]));
  must(put(env.record, 'approvals', 'card', 'B', { state: 'cancelled' }), 'cancel');
  const before = env.record.read('card', 'A');
  const bad = planFile(env, [entry('A', { tier: 1 }), entry('B')]);
  assert.match(bad.reason, /card B is cancelled, so no plan may change it; nothing in this plan was applied/);
  assert.deepEqual(env.record.read('card', 'A'), before);
  assert.match(planFile(env, [entry('A', { module: 'M9' })]).reason, /card A is in module M1, and that can't change/);
  assert.match(planFile(env, [entry('A', { depends_on: ['Z'] })]).reason, /card A's depends_on can't change/);
});

test('R-0b-170: a plan with no tier or no module is refused, and no default stands in', () => {
  const env = world();
  assert.match(planFile(env, [entry('A', { tier: undefined })]).reason, /card A needs an id, a tier and a module/);
  assert.match(planFile(env, [entry('A', { module: undefined })]).reason, /card A needs an id, a tier and a module/);
  assert.match(planFile(env, [entry('A', { tier: 3 })]).reason, /needs an id, a tier and a module/);
});

test('R-0b-170: a roadmap file may not set plan_sha256 or main_commit, on a new card or an old one', () => {
  const env = world();
  for (const fields of [{ plan_sha256: 'd'.repeat(64) }, { main_commit: HEAD }]) {
    const r = roadmap(env, { id: 'R', expectRev: 0, fields: { product: PRODUCT, kind: 'ordinary', ...plan(), ...fields } });
    assert.match(r.reason, /a roadmap file may not set/);
  }
  const { rev } = (leadCard(env, 'A'), env.record.read('card', 'A'));
  assert.match(roadmap(env, { id: 'A', expectRev: rev, fields: { plan_sha256: 'd'.repeat(64) } }).reason, /a roadmap file may not set/);
});
