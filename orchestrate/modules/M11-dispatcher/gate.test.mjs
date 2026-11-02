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
  // a per-state cap missing for the product's state refuses (the Record holds only the four product states, so the
  // rules leave one out)
  assert.equal(go({ rules: rulesWith({ [K.perState]: { light: 1, away: 3, paused: 0 } }) }).ok, false);
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
  const s = (prod, n) => ({ id: `X-${prod}-${n}`, product: prod, kind: 'script', card: 'w9' });
  assert.equal(go({ kind: 'script', running: [] }).ok, true);
  assert.equal(go({ kind: 'script', running: [s('p1', 0)] }).ok, false);
  assert.equal(go({ kind: 'script', product: 'p3', running: [s('p1', 0), s('p2', 0)] }).ok, false);
  assert.equal(go({ kind: 'script', product: 'p3', running: [s('p1', 0)] }).ok, true);
  assert.equal(go({ kind: 'script', b: AMBER, running: [] }).ok, false);
  // scripts and editing workers have separate caps
  assert.equal(go({ kind: 'editing', running: [s('p1', 0)] }).ok, true);
  // audit MAT-6: but a script writes files, so an editing card sharing its file waits
  assert.match(go({ kind: 'editing', running: [s('p1', 0)], card: { id: 'new', product: 'p1', tier: 2, files: ['src/w9.js'] } }).reason, /shares src\/w9\.js/);
  assert.equal(go({ kind: 'editing', running: [{ id: 'X-1', product: 'p1', kind: 'script' }] }).ok, false, 'a script with no card is not known to be disjoint');
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

test('row 61: a card names the row files it touches; named rows overlap on the shared row only', () => {
  assert.equal(go({ card: { id: 'b', tier: 2, rows: ['R-2'], files: ['docs/blueprint/rows/R-2.yaml'] } }).ok, true);
  assert.match(go({ card: { id: 'b', tier: 2, rows: ['R-2'], files: ['docs/blueprint/rows/R-3.yaml'] } }).reason, /without naming it/);
  const set = (rows) => fileSet({ rows, files: [] }, { dailyPatterns: [] }).files;
  const meet = (x, y) => [...x].some((f) => y.has(f));
  assert.equal(meet(set(['R-1']), set(['R-1'])), true);
  assert.equal(meet(set(['R-1']), set(['R-2'])), false);
});

// (b) for the lead (L72): M9's card has no `rows` field, so no card in the Record can name a row, and the gate refuses
// every card that touches a row file. Kept as a todo until M9 has the field (or the gate stops reading it).
test('row 61 through the Record: two cards each touching only their own row file start together; a shared row id overlaps', { todo: 'M9 card has no rows field (b)' }, () => {
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

test('M20 (the start gate alone; the intake path is in tick.test): thinking sessions count against the asking Lead, never the editing caps', () => {
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

test('audit MAT-3: a card with no tier counts as Tier 1; the stricter of the card and the rules wins', () => {
  const UNKNOWN = { band: 'unknown', own_building: 'unknown', prodBlocked: true };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  const base = rulesWith();
  // The same rules, with only classify answering differently; the typed readers (num/dec/flag, L123) come along.
  const says = (tier, risky = []) => ({ ...base, classify: () => ({ tier, risky, reasons: {} }) });
  const c = (extra) => ({ id: 'new', product: 'p1', files: ['src/new.js'], ...extra });
  // unknown usage: no tier -> Tier 1 -> held; an explicit Tier 2 the rules agree with starts
  assert.equal(go({ b: UNKNOWN, card: c({}) }).ok, false);
  assert.equal(go({ b: UNKNOWN, card: c({ tier: 'two' }) }).ok, false);
  assert.equal(go({ b: UNKNOWN, card: c({ tier: 2 }), rules: says(2) }).ok, true);
  // the card says 2, the rules say 1: Tier 1
  assert.equal(go({ b: UNKNOWN, card: c({ tier: 2 }), rules: says(1) }).ok, false);
  // above 90%: production work with no tier is held; the rules' risky classes count too
  assert.equal(go({ b: OVER90, card: c({ risky: ['production_data'] }) }).ok, false);
  assert.equal(go({ b: OVER90, card: c({ tier: 2 }), rules: says(1, ['schema']) }).ok, false);
  assert.equal(go({ b: OVER90, card: c({ tier: 2 }), rules: says(2, ['schema']) }).ok, true);
});

test('audit MIN-20 (G21): an editing card for a product with no record is refused', () => {
  const r = go({ product: 'p9', card: { id: 'new', product: 'p9', tier: 2, files: ['src/new.js'] } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no product record for p9/);
});

test('audit 0b-6 r2 / L27: an unknown kind is refused; an overnight run meets the caps and the files check; running overnight work counts', () => {
  assert.match(go({ kind: 'nightly' }).reason, /unknown (session )?kind nightly/);
  // past the band check too: the gate itself refuses a kind it does not know
  assert.match(startGate({ rules: rulesWith(), rec: setup(), card: null, kind: 'readonly_x', product: 'p1', b: { band: 'green', own_building: 'open', prodBlocked: false }, running: [] }).reason, /unknown/);
  const three = [worker(0), worker(1), worker(2)];
  assert.match(go({ kind: 'overnight', running: three }).reason, /cap 3/);
  assert.equal(go({ kind: 'overnight' }).ok, true);
  const night = (n) => ({ ...worker(n), kind: 'overnight' });
  assert.match(go({ running: [night(0), night(1), night(2)] }).reason, /cap 3/, 'overnight sessions count toward the editing cap');
  assert.match(go({ card: { id: 'new', product: 'p1', tier: 2, files: ['src/w0.js'] }, running: [night(0)] }).reason, /src\/w0\.js|overlap|same file/i);
  // the named cap-free kinds still pass
  for (const kind of ['review', 'audit', 'merge', 'undo_merge', 'lead', 'front_door']) assert.equal(go({ kind, running: three }).ok, true, kind);
});

// Audit 0b-6 r4 MAT-5: the gate's own part of L40, asked directly. Only an undo that is an exact reverse
// skips a missing cap value; the same undo not marked exact, or any other kind marked exact, is refused.
test('L40 / r4 MAT-5: a missing cap is skipped only for an undo that is an exact reverse, and is still named', () => {
  const rules = rulesWith({ [K.perState]: undefined });
  const undo = { id: 'U-1', product: 'p1', tier: 2, kind: 'undo', files: ['src/u.js'] };
  const ask = (kind, exactReverse) => startGate({ rules, rec: setup(), card: undo, kind, product: 'p1', b: GREEN, running: [], exactReverse });
  const exact = ask('undo', true);
  assert.equal(exact.ok, true, exact.reason);
  assert.equal(exact.missing, K.perState);
  for (const [kind, ex] of [['undo', false], ['undo', undefined], ['editing', true]]) {
    const r = ask(kind, ex);
    assert.equal(r.ok, false, `${kind} ${ex}`);
    assert.equal(r.missing, K.perState, `${kind} ${ex}`);
  }
  // The files check still runs for the exact reverse: a running worker on the same file holds it.
  const rec = setup({ cards: [card('w-u', ['src/u.js'])] });
  const shared = startGate({ rules, rec, card: undo, kind: 'undo', product: 'p1', b: GREEN, running: [worker(0, 'p1', 'w-u')], exactReverse: true });
  assert.equal(shared.ok, false);
  assert.match(shared.reason, /shares src\/u\.js/);
});
