import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGate, normPath, matches, fileSet, check12 } from './gate.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith } from './fixtures.test-helper.mjs';

const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
const AMBER = { band: 'amber', own_building: 'open', prodBlocked: false };
const RED = { band: 'red', own_building: 'open', prodBlocked: false };

const product = (id, state = 'active') => ['product', id, { state }];
const card = (id, files, extra = {}) => ['card', id, { product: 'p1', tier: 2, state: 'ready', files, ...extra }];
const worker = (n, prod = 'p1', c = `w${n}`) => ({ id: `S-${prod}-${n}`, product: prod, kind: 'editing', card: c });

function setup({ cards = [], products = [product('p1'), product('p2')] } = {}) {
  const fill = [];
  for (let i = 0; i < 10; i++) fill.push(card(`w${i}`, [`src/w${i}.js`]));
  return recWith([...products, ...fill, ...cards]);
}
const go = (over) => {
  const rec = over.rec ?? setup({ cards: over.cards });
  return startGate({ rules: over.rules ?? rulesWith(), rec, card: over.card ?? { id: 'new', product: 'p1', tier: 2, files: ['src/new.js'] }, kind: over.kind ?? 'editing', product: over.product ?? 'p1', b: over.b ?? GREEN, running: over.running ?? [], lead: over.lead });
};

test('row 61: a 4th editing worker on a product and a 6th on the Mac are refused', () => {
  const three = [worker(0), worker(1), worker(2)];
  assert.equal(go({ running: three.slice(0, 2) }).ok, true);
  const r = go({ running: three });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cap 3/);
  const mac5 = [worker(0), worker(1), worker(0, 'p2', 'w3'), worker(1, 'p2', 'w4'), worker(2, 'p2', 'w5')];
  assert.equal(go({ running: mac5.slice(0, 4) }).ok, true);
  const m = go({ running: mac5 });
  assert.equal(m.ok, false);
  assert.match(m.reason, /Mac already runs 5/);
});

test('M14: the product limit is the smallest of its caps', () => {
  // light state: 1
  const rec = setup({ products: [product('p1', 'light'), product('p2')] });
  assert.equal(go({ rec, running: [] }).ok, true);
  assert.equal(go({ rec, running: [worker(0)] }).ok, false);
  // amber: 2 per product, 3 per Mac
  assert.equal(go({ b: AMBER, running: [worker(0)] }).ok, true);
  assert.equal(go({ b: AMBER, running: [worker(0), worker(1)] }).ok, false);
  assert.equal(go({ b: AMBER, running: [worker(0, 'p2', 'w3'), worker(1, 'p2', 'w4'), worker(2, 'p2', 'w5')] }).ok, false);
  assert.equal(go({ b: AMBER, running: [worker(0, 'p2', 'w3'), worker(1, 'p2', 'w4')] }).ok, true);
  // own-building amber gives amber caps with a green band
  assert.equal(go({ b: { ...GREEN, own_building: 'amber' }, running: [worker(0), worker(1)] }).ok, false);
  // a per-state cap missing for the product's state refuses
  const odd = setup({ products: [product('p1', 'mystery')] });
  assert.equal(go({ rec: odd }).ok, false);
  // no product record refuses
  assert.equal(go({ product: 'p9', card: { id: 'x', product: 'p9', tier: 2, files: ['a.js'] } }).ok, false);
});

test('row 61 / M14: shakedown (cap 1) refuses a 2nd worker; a missing switch reads as on', () => {
  const on = rulesWith({ [K.shakedown]: true, [K.editingPerProduct]: 3 });
  assert.equal(go({ rules: on, running: [] }).ok, true);
  const r = go({ rules: on, running: [worker(0)] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cap 1/);
  const missing = rulesWith({ [K.shakedown]: undefined });
  assert.equal(go({ rules: missing, running: [worker(0)] }).ok, false);
  assert.equal(go({ rules: rulesWith({ [K.shakedown]: 'yes' }), running: [] }).ok, false);
});

test('row 61 / m3: scripts — a 2nd on one product and a 3rd on the Mac are refused; green only', () => {
  const s = (prod, n) => ({ id: `X-${prod}-${n}`, product: prod, kind: 'script' });
  assert.equal(go({ kind: 'script', running: [] }).ok, true);
  assert.equal(go({ kind: 'script', running: [s('p1', 0)] }).ok, false);
  assert.equal(go({ kind: 'script', product: 'p3', running: [s('p1', 0), s('p2', 0)] }).ok, false);
  assert.equal(go({ kind: 'script', product: 'p3', running: [s('p1', 0)] }).ok, true);
  assert.equal(go({ kind: 'script', b: AMBER, running: [] }).ok, false);
  // scripts and editing workers have separate caps
  assert.equal(go({ kind: 'editing', running: [s('p1', 0)] }).ok, true);
});

test('row 61 / M13: two cards sharing one file (or a case-only twin) do not start together', () => {
  const rec = setup({ cards: [card('a', ['src/App.js'])] });
  const run = [{ id: 'S-a', product: 'p1', kind: 'editing', card: 'a' }];
  assert.match(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['src/App.js'] } }).reason, /shares src\/app.js/);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['SRC/app.JS'] } }).ok, false);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['./src/x/../App.js'] } }).ok, false);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['src/Other.js'] } }).ok, true);
  // a file in the running worker's latest bundle counts as its own
  const withBundle = [{ ...run[0], bundle_files: ['src/Other.js'] }];
  assert.equal(go({ rec, running: withBundle, card: { id: 'b', tier: 2, files: ['src/other.js'] } }).ok, false);
  // the check is per product
  assert.equal(go({ rec, running: [{ ...run[0], product: 'p2' }], card: { id: 'b', tier: 2, files: ['src/App.js'] } }).ok, true);
});

test('M13: a path outside the repo refuses', () => {
  for (const f of ['../x.js', '/etc/hosts', '~/x', 'a/../../x', '', 'C:/x', 'dir/']) {
    assert.equal(go({ card: { id: 'b', tier: 2, files: [f] } }).ok, false, f);
  }
  assert.equal(normPath('./a/./b/../c.js'), 'a/c.js');
});

test('row 61: two cards each touching only their own row file start together; a shared row id overlaps', () => {
  const rec = setup({ cards: [card('a', ['docs/blueprint/rows/R-1.yaml'], { rows: ['R-1'] })] });
  const run = [{ id: 'S-a', product: 'p1', kind: 'editing', card: 'a' }];
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, rows: ['R-2'], files: ['docs/blueprint/rows/R-2.yaml'] } }).ok, true);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, rows: ['R-1'], files: [] } }).ok, false);
  // a row file the card does not name is not its own
  assert.match(go({ rec, running: run, card: { id: 'b', tier: 2, rows: ['R-2'], files: ['docs/blueprint/rows/R-3.yaml'] } }).reason, /without naming it/);
});

test("row 61 / M13: a card touching blueprint.yaml or cards/x.md can't run beside the Lead's daily card", () => {
  const rec = setup({ cards: [card('daily', [], { kind: 'daily' })] });
  const run = [{ id: 'S-d', product: 'p1', kind: 'editing', card: 'daily' }];
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['docs/blueprint/blueprint.yaml'] } }).ok, false);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['docs/blueprint/cards/x.md'] } }).ok, false);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['docs/Blueprint/Cards/deep/y.md'] } }).ok, false);
  assert.equal(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['src/a.js'] } }).ok, true);
  // and the other way round: the daily card can't start beside such a card
  const rec2 = setup({ cards: [card('a', ['docs/blueprint/BLUEPRINT.md'])] });
  assert.equal(go({ rec: rec2, running: [{ id: 'S-a', product: 'p1', kind: 'editing', card: 'a' }], card: { id: 'daily', kind: 'daily', tier: 2, files: [] } }).ok, false);
  assert.equal(matches('docs/blueprint/cards/**', 'docs/blueprint/cards/a/b.md'), true);
  assert.equal(matches('docs/blueprint/cards/*', 'docs/blueprint/cards/a/b.md'), false);
  assert.equal(matches('docs/blueprint/blueprint.yaml', 'docs/blueprint/blueprintxyaml'), false);
});

test('M13: an editing card with no file list runs alone', () => {
  const rec = setup({ cards: [card('empty', [])] });
  assert.equal(go({ card: { id: 'e', tier: 2, files: [] }, running: [] }).ok, true);
  assert.match(go({ card: { id: 'e', tier: 2, files: [] }, running: [worker(0)] }).reason, /runs alone/);
  assert.match(go({ rec, running: [{ id: 'S-e', product: 'p1', kind: 'editing', card: 'empty' }] }).reason, /runs alone/);
  // a running worker whose card is missing from the record refuses
  assert.equal(go({ running: [{ id: 'S-z', product: 'p1', kind: 'editing', card: 'nope' }] }).ok, false);
});

test('M20: thinking sessions count against the asking Lead, never the editing caps', () => {
  const ro = (n, lead = 'L1') => ({ id: `R${n}`, product: 'p1', kind: 'readonly', lead });
  const rec = setup({ products: [product('p1', 'paused')] });
  const rules = rulesWith({ [K.editingPerProduct]: 0 });
  assert.equal(go({ rec, rules, kind: 'readonly', lead: 'L1', running: [ro(1), ro(2), ro(3)] }).ok, true);
  assert.match(go({ rec, rules, kind: 'readonly', lead: 'L1', running: [ro(1), ro(2), ro(3), ro(4)] }).reason, /cap 4/);
  assert.equal(go({ kind: 'readonly', lead: 'L2', running: [ro(1), ro(2), ro(3), ro(4)] }).ok, true);
  assert.equal(go({ kind: 'readonly', running: [] }).ok, false);
  // m2: they wait in red, run in amber
  assert.equal(go({ kind: 'readonly', lead: 'L1', b: RED, running: [] }).ok, false);
  assert.equal(go({ kind: 'readonly', lead: 'L1', b: AMBER, running: [] }).ok, true);
});

test('the band comes first; a missing key starts nothing', () => {
  assert.equal(go({ b: RED }).ok, false);
  assert.equal(go({ kind: 'review', b: RED }).ok, true);
  for (const key of [K.editingPerProduct, K.editingPerMac, K.perState, K.leadDailyCard, K.redRuns]) {
    const r = go({ rules: rulesWith({ [key]: undefined }) });
    assert.equal(r.ok, false, key);
    assert.match(r.reason, /start nothing/);
  }
  assert.equal(go({ rules: rulesWith({ [K.amberEditingPerMac]: undefined }), b: AMBER }).ok, false);
  assert.equal(go({ rules: rulesWith({ [K.amberEditingPerMac]: undefined }), b: GREEN }).ok, true);
});

test('m11: launch check 12 gives the same answer as the pass', async () => {
  const rec = setup();
  const rules = rulesWith();
  const running = [worker(0), worker(1), worker(2)];
  const port = check12({ rules, rec, bandsNow: () => GREEN, runningNow: () => running });
  const c = { id: 'new', product: 'p1', tier: 2, files: ['src/new.js'] };
  const viaLaunch = await port({ card: c, kind: 'editing', product: 'p1' });
  assert.deepEqual(viaLaunch, startGate({ rules, rec, card: c, kind: 'editing', product: 'p1', b: GREEN, running }));
  assert.equal(viaLaunch.ok, false);
  running.pop();
  assert.equal((await port({ card: c, kind: 'editing', product: 'p1' })).ok, true);
});

test('fileSet: the daily card carries its patterns, others none', () => {
  const pats = ['docs/blueprint/cards/**'];
  assert.deepEqual(fileSet({ kind: 'daily', files: [] }, { dailyPatterns: pats }).patterns, pats);
  assert.deepEqual(fileSet({ files: ['a.js'] }, { dailyPatterns: pats }).patterns, []);
});
