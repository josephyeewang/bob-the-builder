// ready.test.mjs — R-0b-25 / R-0b-26: the one ready rule, its planted negatives, and the ready list (0b-2 M-2, m-3,
// R2-M4, R2-M5, R2-m2, R3-M3, R3-m2). Own tests, behaviour-equivalent to BMAD's dependency rules (a cycle is refused,
// a missing dependency blocks, a dependency that will never merge waits on Joe, many and chained dependencies);
// no upstream source was available to port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goFreeKinds, readyCheck, rootOf } from './ready.mjs';
import { PRODUCT, fingerprintFor, must, plan, product, put, readyCard, rulesFor, seed, setup } from './fixtures.test-helper.mjs';

// An in-memory view: cards by id, gos, the product state, and who created each card.
function view({ cards = {}, gos = [], productState = 'active', creators = {} } = {}) {
  return {
    get(entity, id) {
      if (entity === 'card') return cards[id] === undefined ? null : cards[id] === 'corrupt' ? { id, corrupt: true } : { id, doc: cards[id] };
      if (entity === 'product') return productState === null ? null : { id, doc: { state: productState } };
      return null;
    },
    list: (entity) => (entity === 'go' ? gos : []),
    createdBy: (entity, id) => (Object.hasOwn(creators, id) ? creators[id] : 'lead:L-1'),
  };
}
const card = (over = {}) => ({ state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, ...plan(), ...over });
const goFor = (id, doc, over = {}) => ({ id: `go-${id}`, doc: { product: PRODUCT, card_id: id, plan_fingerprint: fingerprintFor(id, doc), ...over } });
const R = rulesFor();
const check = (id, doc, v, rules = R) => readyCheck({ id, doc }, v, { rules, product: PRODUCT });
// A card C-1 with a go, plus whatever `cards` are added.
function withGo(doc, cards = {}, extra = {}) { return view({ cards: { 'C-1': doc, ...cards }, gos: [goFor('C-1', doc)], ...extra }); }

test('ready: a card with Joe\'s go for this plan, in an active product, with no dependencies', () => {
  const d = card();
  assert.deepEqual(check('C-1', d, withGo(d)), { ok: true });
});

test('no go, or a go for another plan, card or product, is not ready', () => {
  const d = card();
  assert.match(check('C-1', d, view({ cards: { 'C-1': d } })).reason, /no go from Joe/);
  const changed = card({ files: ['src/a.mjs', 'src/extra.mjs'] });
  assert.match(check('C-1', changed, withGo(d, { 'C-1': changed })).reason, /no go from Joe/, 'planted: go with the wrong fingerprint');
  for (const over of [{ card_id: 'C-2' }, { product: 'other-app' }]) {
    const v = view({ cards: { 'C-1': d }, gos: [goFor('C-1', d, over)] });
    assert.match(check('C-1', d, v).reason, /no go from Joe/, JSON.stringify(over));
  }
  assert.match(check('C-1', card({ files: ['src/*'] }), view({ cards: {} })).reason, /can't be fingerprinted/);
});

test('every plan input is in the fingerprint: changing any one voids the go', () => {
  const t1 = card({ tier: 1, plan_sha256: 'a'.repeat(64), main_commit: 'b'.repeat(40) });
  const v = withGo(t1);
  assert.equal(check('C-1', t1, v).ok, true);
  for (const over of [{ tier: 2 }, { files: ['src/b.mjs'] }, { done_when: 'other' }, { plan_sha256: 'c'.repeat(64) }, { main_commit: 'd'.repeat(40) }]) {
    assert.equal(check('C-1', { ...t1, ...over }, v).ok, false, JSON.stringify(over));
  }
  // Fields outside the plan don't matter.
  assert.equal(check('C-1', { ...t1, brief: 'reworded' }, v).ok, true);
});

test('go-free kinds: listed in the rules AND made by their one allowed creator', () => {
  const d = card({ kind: 'lead_daily_card' });
  assert.equal(check('C-1', d, view({ cards: { 'C-1': d } })).ok, true);
  assert.match(check('C-1', d, view({ cards: { 'C-1': d }, creators: { 'C-1': 'dispatcher' } })).reason, /made by dispatcher needs Joe's go/);
  assert.match(check('C-1', d, view({ cards: { 'C-1': d }, creators: { 'C-1': null } })).reason, /unknown writer/);
  const er = card({ kind: 'exact_reverse' });
  assert.equal(check('C-1', er, view({ cards: { 'C-1': er }, creators: { 'C-1': 'dispatcher' } })).ok, true);
  // Planted: a go-free kind the rules don't list needs a go.
  const notListed = rulesFor({ 'approvals.plan_go.go_free': ['lead_daily_card'] });
  assert.match(check('C-1', er, view({ cards: { 'C-1': er }, creators: { 'C-1': 'dispatcher' } }), notListed).reason, /no go from Joe/);
  // An ordinary card is never go-free, whatever the rules list.
  const ord = card();
  assert.match(check('C-1', ord, view({ cards: { 'C-1': ord } }), rulesFor({ 'approvals.plan_go.go_free': ['ordinary_typo'] })).reason, /no go/);
  assert.deepEqual(goFreeKinds(rulesFor({ 'approvals.plan_go.go_free': { lead_daily_card: true } }), PRODUCT), ['lead_daily_card']);
  assert.deepEqual(goFreeKinds(rulesFor({ 'approvals.plan_go.go_free': 'lead_daily_card' }), PRODUCT), []);
});

test('the product: paused (or no product record) starts nothing; light and away start some', () => {
  const d = card();
  for (const [state, ok] of [['active', true], ['light', true], ['away', true], ['paused', false], [null, false]]) {
    const r = check('C-1', d, withGo(d, {}, { productState: state }));
    assert.equal(r.ok, ok, `${state}: ${r.reason}`);
  }
  assert.match(check('C-1', d, withGo(d, {}, { productState: null })).reason, /no product record/);
  const noRule = rulesFor({ 'product_state_rules.away.start': undefined });
  assert.match(check('C-1', d, withGo(d, {}, { productState: 'away' }), noRule).reason, /say nothing about starting work in a away product/);
  assert.match(check('C-1', card({ product: 'other-app' }), withGo(d)).reason, /belongs to product other-app/);
});

test('a dependency that is missing, unreadable, or not yet merged blocks', () => {
  const cases = [[undefined, /does not exist/], ['corrupt', /unreadable/]];
  for (const s of ['draft', 'ready', 'claimed', 'running', 'in_review', 'verified', 'approved', 'merging', 'waiting', 'reverted']) cases.push([card({ state: s }), new RegExp(`is ${s}, not merged`)]);
  for (const [dep, pattern] of cases) {
    const d = card({ depends_on: ['C-0'] });
    const r = check('C-1', d, withGo(d, dep === undefined ? {} : { 'C-0': dep }));
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
    assert.equal(r.joe, undefined);
  }
});

test('a dependency that will never merge (cancelled, no answer, failed) waits on Joe', () => {
  for (const s of ['cancelled', 'closed_no_answer', 'failed']) {
    const d = card({ depends_on: ['C-0'] });
    const r = check('C-1', d, withGo(d, { 'C-0': card({ state: s }) }));
    assert.equal(r.ok, false);
    assert.equal(r.joe, true, s);
    assert.match(r.reason, /Joe decides/);
  }
});

test('merged or closed dependencies are done; many must all be done', () => {
  const d = card({ depends_on: ['A', 'B', 'C'] });
  const done = { A: card({ state: 'merged' }), B: card({ state: 'closed' }), C: card({ state: 'merged' }) };
  assert.equal(check('C-1', d, withGo(d, done)).ok, true);
  const r = check('C-1', d, withGo(d, { ...done, B: card({ state: 'in_review' }) }));
  assert.match(r.reason, /dependency B is in_review/);
  assert.equal(check('C-1', card({ depends_on: [] }), withGo(card({ depends_on: [] }))).ok, true);
  assert.match(check('C-1', card({ depends_on: 'A' }), withGo(card({ depends_on: 'A' }))).reason, /not a list/);
});

test('chained dependencies: only the direct dependency\'s state counts, but a cycle anywhere back is refused', () => {
  const d = card({ depends_on: ['B'] });
  const chain = { B: card({ state: 'merged', depends_on: ['C'] }), C: card({ state: 'draft' }) };
  assert.equal(check('C-1', d, withGo(d, chain)).ok, true, 'B merged already, whatever C is now');
  assert.match(check('C-1', card({ depends_on: ['C-1'] }), withGo(card({ depends_on: ['C-1'] }))).reason, /cycle back to C-1/);
  const loop = { B: card({ state: 'merged', depends_on: ['C'] }), C: card({ state: 'merged', depends_on: ['C-1'] }) };
  assert.match(check('C-1', d, withGo(d, loop)).reason, /cycle back to C-1/, 'a cycle through merged cards is still a cycle');
  // A cycle that doesn't include this card is not this card's problem; a loop among others doesn't hang the check.
  const other = { B: card({ state: 'merged', depends_on: ['C'] }), C: card({ state: 'merged', depends_on: ['B'] }) };
  assert.equal(check('C-1', d, withGo(d, other)).ok, true);
});

test('the round cap and the round itself', () => {
  const d = card({ round: 4 });
  assert.match(check('C-1', d, withGo(d)).reason, /round 4 is over the cap of 3/);
  assert.match(check('C-1', card({ round: 0 }), withGo(card({ round: 0 }))).reason, /no round/);
  assert.match(check('C-1', card(), withGo(card()), rulesFor({ 'caps.rounds': undefined })).reason, /no round cap/);
});

test('a fix card is covered by its root card\'s go; a broken fix chain is not ready (R2-M5)', () => {
  const root = card();
  const fix1 = card({ kind: 'fix', fix_of: 'C-1', round: 2 });
  const fix2 = card({ kind: 'fix', fix_of: 'F-1', round: 3 });
  const v = view({ cards: { 'C-1': root, 'F-1': fix1, 'F-2': fix2 }, gos: [goFor('C-1', root)] });
  assert.equal(check('F-2', fix2, v).ok, true);
  assert.equal(rootOf({ id: 'F-2', doc: fix2 }, v).root.id, 'C-1');
  assert.match(check('F-2', fix2, view({ cards: { 'F-2': fix2 }, gos: [goFor('C-1', root)] })).reason, /F-1 is missing/);
  const loopy = view({ cards: { 'F-1': card({ kind: 'fix', fix_of: 'F-2' }), 'F-2': card({ kind: 'fix', fix_of: 'F-1' }) } });
  assert.match(check('F-2', card({ kind: 'fix', fix_of: 'F-1', round: 2 }), loopy).reason, /loops/);
});

test('the check fails closed when the record throws', () => {
  const broken = { get() { throw new Error('disk gone'); }, list() { throw new Error('disk gone'); }, createdBy: () => null };
  const r = check('C-1', card(), broken);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ready check failed: disk gone/);
  assert.match(readyCheck(null, broken, { rules: R, product: PRODUCT }).reason, /no card/);
});

// ---- through the record: the move into ready and the ready list use the same rule ----

test('draft → ready is refused for each failing rule, with the rule\'s reason', () => {
  const env = setup({ prefix: 'm9-ready-' });
  product(env);
  readyCard(env, 'C-0');
  must(put(env.record, 'dispatcher', 'card', 'C-0', { state: 'claimed', claim: { kind: 'tab', claim_id: 'T', host: 'mac-a' } }));
  const r = put(env.record, 'dispatcher', 'card', 'C-0', { state: 'ready' });
  assert.equal(r.ok, false, 'claimed → ready is a release, not a write');
  assert.match(r.reason, /made only by a claim break or lapse/);
  seed(env, 'card', 'D-1', card({ depends_on: ['C-0'] }));
  const d = env.record.read('card', 'D-1').doc;
  seed(env, 'go', 'go-D-1', { product: PRODUCT, card_id: 'D-1', plan_fingerprint: fingerprintFor('D-1', d) });
  assert.match(put(env.record, 'dispatcher', 'card', 'D-1', { state: 'ready' }).reason, /not ready: dependency C-0 is claimed/);
  seed(env, 'card', 'D-2', card());
  assert.match(put(env.record, 'dispatcher', 'card', 'D-2', { state: 'ready' }).reason, /not ready: no go/);
});

test('the ready list: a dependency closing makes a card appear; reverting makes it disappear; a pause empties it', () => {
  const env = setup({ prefix: 'm9-ready-' });
  product(env);
  seed(env, 'card', 'A', card({ state: 'in_review' }));
  const b = card({ state: 'ready', depends_on: ['A'] });
  seed(env, 'card', 'B', b);
  seed(env, 'go', 'go-B', { product: PRODUCT, card_id: 'B', plan_fingerprint: fingerprintFor('B', b) });
  readyCard(env, 'C');
  const ids = () => env.record.ready().map((c) => c.id).sort();
  assert.deepEqual(ids(), ['C'], 'B waits for A');
  seed(env, 'card', 'A', card({ state: 'merged' }));
  assert.deepEqual(ids(), ['B', 'C'], 'A merged: B appears');
  seed(env, 'card', 'A', card({ state: 'closed' }));
  assert.deepEqual(ids(), ['B', 'C'], 'A closed: B stays');
  seed(env, 'card', 'A', card({ state: 'reverted' }));
  assert.deepEqual(ids(), ['C'], 'A reverted: B disappears');
  seed(env, 'card', 'A', card({ state: 'cancelled' }));
  assert.deepEqual(ids(), ['C'], 'A cancelled: B waits on Joe, not listed');
  // A plan edited after the go (planted: a seeded edit past the writer) drops the card off the list.
  seed(env, 'card', 'C', { ...env.record.read('card', 'C').doc, files: ['src/changed.mjs'] });
  assert.deepEqual(ids(), []);
  readyCard(env, 'E');
  assert.deepEqual(ids(), ['E']);
  must(env.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: env.record.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } }), 'pause');
  assert.deepEqual(ids(), [], 'paused: nothing is ready');
  // A claimed card never shows, even if its rule passes.
  seed(env, 'product', PRODUCT, { state: 'active' });
  must(put(env.record, 'dispatcher', 'card', 'E', { state: 'claimed', claim: { kind: 'tab', claim_id: 'T-1', host: 'mac-a' } }));
  assert.deepEqual(ids(), []);
});
