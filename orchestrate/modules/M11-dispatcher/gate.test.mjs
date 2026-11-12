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
  return startGate({ rules: over.rules ?? rulesWith(), rec, card: over.card ?? { id: 'new', product: 'p1', tier: 2, files: ['src/new.js'] }, kind: over.kind ?? 'editing', product: over.product ?? 'p1', b: over.b ?? GREEN, running: over.running ?? [], lead: over.lead, exactReverse: over.exactReverse });
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
  // L696 M1: a row file among the card's files names its row, so it is the card's own (cards carry no rows field; L684)
  assert.equal(go({ card: { id: 'b', tier: 2, rows: ['R-2'], files: ['docs/blueprint/rows/R-3.yaml'] } }).ok, true);
  assert.deepEqual([...fileSet({ rows: ['R-2'], files: ['docs/blueprint/rows/R-3.yaml'] }, { dailyPatterns: [] }).files].sort(), ['docs/blueprint/rows/r-2.yaml', 'docs/blueprint/rows/r-3.yaml']);
  const set = (rows) => fileSet({ rows, files: [] }, { dailyPatterns: [] }).files;
  const meet = (x, y) => [...x].some((f) => y.has(f));
  assert.equal(meet(set(['R-1']), set(['R-1'])), true);
  assert.equal(meet(set(['R-1']), set(['R-2'])), false);
});

// L696 M1: M9's card has no `rows` field, so the gate takes a card's rows from the row files among its files.
test('row 61 through the Record: two cards each touching only their own row file start together; a shared row overlaps, whatever its case', () => {
  const rec = setup({ cards: [card('a', ['src/a.js', 'docs/blueprint/rows/R-1.yaml'])] });
  const run = [{ id: 'S-a', product: 'p1', kind: 'editing', card: 'a' }];
  assert.deepEqual(go({ rec, running: run, card: { id: 'b', tier: 2, files: ['docs/blueprint/rows/R-2.yaml'] } }), { ok: true });
  for (const b of [{ files: ['docs/blueprint/rows/R-1.yaml'] }, { files: ['DOCS/Blueprint/Rows/r-1.YAML'] }, { rows: ['r-1'], files: [] }]) {
    const r = go({ rec, running: run, card: { id: 'b', tier: 2, ...b } });
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.match(r.reason, /r-1\.yaml/i, JSON.stringify(b));
  }
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
  const undo = { id: 'U-1', product: 'p1', kind: 'exact_reverse', files: ['src/u.js'] };
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

// L199 (1): the first cutover's rules set caps.editing_per_product to 0, and Joe's Undo must still start. An exact
// reverse undo is never held by the editing caps (L31); its own limit is one undo running per product; while it runs
// it counts toward the caps for every other editing start.
const undoCard = (id = 'U-1', files = ['src/u.js']) => ({ id, product: 'p1', kind: 'exact_reverse', files });
const undoSession = (n, prod = 'p1', c = `u${n}`) => ({ id: `S-U-${prod}-${n}`, product: prod, kind: 'undo', card: c });

test('L199: at caps.editing_per_product 0 an exact-reverse undo starts; editing and a not-exact undo are held at cap 0', () => {
  const rules = rulesWith({ [K.editingPerProduct]: 0 });
  const exact = go({ rules, card: undoCard(), kind: 'undo', exactReverse: true });
  assert.equal(exact.ok, true, exact.reason);
  assert.equal(exact.missing, undefined, 'no cap value is missing: nothing to tell Joe');
  for (const [kind, ex] of [['undo', false], ['undo', undefined], ['editing', true], ['editing', false], ['overnight', true]]) {
    const r = go({ rules, card: kind === 'undo' ? undoCard() : undefined, kind, exactReverse: ex });
    assert.equal(r.ok, false, `${kind} ${ex}`);
    assert.match(r.reason, /cap 0/, `${kind} ${ex}`);
  }
});

// (The amber caps are never asked for an undo: the usage band gives an undo none, usage.mjs mayStart.)
test('L199: the product, Mac and shakedown caps never hold an exact-reverse undo', () => {
  const full = [worker(0, 'p2', 'w3'), worker(1, 'p2', 'w4'), worker(2, 'p2', 'w5'), worker(3, 'p2', 'w6'), worker(4, 'p2', 'w7')];
  const cases = [['product cap', rulesWith(), GREEN, [worker(0), worker(1), worker(2)]], ['Mac cap', rulesWith(), GREEN, full], ['shakedown', rulesWith({ [K.shakedown]: true }), GREEN, [worker(0)]]];
  for (const [what, rules, b, running] of cases) {
    const r = go({ rules, b, card: undoCard(), kind: 'undo', exactReverse: true, running });
    assert.equal(r.ok, true, `${what}: ${r.reason}`);
    // Control: the same start not marked exact is held by that cap.
    const held = go({ rules, b, card: undoCard(), kind: 'undo', exactReverse: false, running });
    assert.equal(held.ok, false, `${what} control`);
    assert.match(held.reason, /cap \d/, `${what} control`);
  }
});

test('L199: one undo at a time per product; another product\'s undo does not hold it', () => {
  const rules = rulesWith({ [K.editingPerProduct]: 0 });
  const rec = setup({ cards: [card('u0', ['src/other.js'], { kind: 'exact_reverse' })] });
  const second = go({ rules, rec, card: undoCard(), kind: 'undo', exactReverse: true, running: [undoSession(0)] });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'an undo is already running for p1 (one at a time)');
  const elsewhere = go({ rules, rec, card: undoCard(), kind: 'undo', exactReverse: true, running: [undoSession(0, 'p2')] });
  assert.equal(elsewhere.ok, true, elsewhere.reason);
  // Editing workers on the product are not undos: three of them (the cap) do not hold it.
  const workers = go({ card: undoCard(), kind: 'undo', exactReverse: true, running: [worker(0), worker(1), worker(2)] });
  assert.equal(workers.ok, true, workers.reason);
});

test('L199: a running undo counts toward the caps for every other editing start', () => {
  const rec = setup({ cards: [card('u0', ['src/other.js'], { kind: 'exact_reverse' })] });
  const one = rulesWith({ [K.editingPerProduct]: 1 });
  const r = go({ rules: one, rec, running: [undoSession(0)] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /runs 1 editing worker\(s\) \(cap 1\)/);
  assert.equal(go({ rules: one, rec, running: [] }).ok, true, 'control: with no undo running it starts');
  // The Mac cap counts it too: four workers and one undo on another product fill the Mac's five.
  const mac = [worker(0, 'p2', 'w3'), worker(1, 'p2', 'w4'), worker(2, 'p2', 'w5'), worker(3, 'p2', 'w6'), undoSession(0, 'p2')];
  assert.match(go({ running: mac }).reason ?? '', /Mac already runs 5/);
  assert.equal(go({ running: mac.slice(0, 4) }).ok, true, 'control: four on the Mac');
});

// L210 (one rule across start, push and merge; lane 1's shared wording): an exact-reverse undo starts on a paused
// product; every other editing start there is refused; a second undo while one runs is refused.
// `stateIs` stands in a product document the Record would not hold (no state, or one it doesn't know): read through.
const stateIs = (rec, doc) => ({ read: (e, id) => (e === 'product' && id === 'p1' ? { id, doc } : rec.read(e, id)), list: (e) => rec.list(e) });

test('L210: a paused product starts its undo; a normal edit there is refused; so is a second undo while one runs', () => {
  const rec = setup({ products: [product('p1', 'paused'), product('p2')], cards: [card('u0', ['src/other.js'], { kind: 'exact_reverse' })] });
  const undo = go({ rec, card: undoCard(), kind: 'undo', exactReverse: true });
  assert.equal(undo.ok, true, undo.reason);
  assert.equal(undo.missing, undefined, 'nothing to tell Joe: the paused cap is there');
  const edit = go({ rec });
  assert.deepEqual([edit.ok, edit.reason], [false, 'p1 is paused: only its undo starts']);
  const second = go({ rec, card: undoCard(), kind: 'undo', exactReverse: true, running: [undoSession(0)] });
  assert.deepEqual([second.ok, second.reason], [false, 'an undo is already running for p1 (one at a time)']);
  // Not the undo: an undo start not checked as an exact reverse, a card that is not an exact_reverse card, or an editing start.
  for (const [what, over] of [['not exact', { exactReverse: false }], ['not an undo card', { card: { ...undoCard(), kind: 'fix' } }], ['an editing start', { kind: 'editing' }]]) {
    const r = go({ rec, card: undoCard(), kind: 'undo', exactReverse: true, ...over });
    assert.deepEqual([r.ok, r.reason], [false, 'p1 is paused: only its undo starts'], what);
  }
  // A read-only start is not an editing start: the Lead's swarm, as before (M20).
  assert.equal(go({ rec, kind: 'readonly', lead: 'L1' }).ok, true);
  // The other product is not paused by p1's state.
  assert.equal(go({ rec, product: 'p2', card: { id: 'n2', product: 'p2', tier: 2, files: ['src/n2.js'] } }).ok, true);
});

test('L210: a product with no state, or one the Record does not know, reads as paused: its undo starts, nothing else', () => {
  for (const doc of [{}, { state: 'retired' }, { state: null }]) {
    const rec = stateIs(setup(), doc);
    const undo = go({ rec, card: undoCard(), kind: 'undo', exactReverse: true });
    assert.equal(undo.ok, true, `${JSON.stringify(doc)}: ${undo.reason}`);
    assert.equal(undo.missing, undefined, `${JSON.stringify(doc)}: looked up as paused, so no rule is missing`);
    assert.equal(go({ rec }).reason, 'p1 is paused: only its undo starts', JSON.stringify(doc));
  }
});

test('L210: a per-state value that is there but not a whole number refuses the undo; a missing one is named and the undo starts', () => {
  const rec = setup({ products: [product('p1', 'paused'), product('p2')] });
  for (const bad of ['two', -1, 1.5, '']) {
    const r = go({ rec, rules: rulesWith({ [K.perState]: { light: 1, active: 3, away: 3, paused: bad } }), card: undoCard(), kind: 'undo', exactReverse: true });
    assert.equal(r.ok, false, `paused: ${JSON.stringify(bad)}`);
    assert.equal(r.missing, K.perState);
  }
  const gone = go({ rec, rules: rulesWith({ [K.perState]: { light: 1, active: 3, away: 3 } }), card: undoCard(), kind: 'undo', exactReverse: true });
  assert.equal(gone.ok, true, gone.reason);
  assert.equal(gone.missing, K.perState, 'Joe is told the paused cap is missing (L40)');
});

test('#117 m2: the one-undo limit counts the product\'s exact_reverse cards claimed or running in the Record, not only the running list', () => {
  for (const state of ['claimed', 'running']) {
    const rec = setup({ cards: [card('U-0', ['src/other.js'], { kind: 'exact_reverse', state })] });
    const r = go({ rec, card: undoCard(), kind: 'undo', exactReverse: true, running: [] });
    assert.deepEqual([r.ok, r.reason], [false, 'an undo is already running for p1 (one at a time)'], state);
  }
  // Not counted: one finished or waiting to start, another product's, a card that is not an undo, or this card itself.
  const quiet = setup({ cards: [
    card('U-0', ['src/a.js'], { kind: 'exact_reverse', state: 'in_review' }),
    card('U-2', ['src/b.js'], { kind: 'exact_reverse', state: 'ready' }),
    card('U-3', ['src/c.js'], { kind: 'exact_reverse', state: 'running', product: 'p2' }),
    card('C-4', ['src/d.js'], { state: 'running' }),
    card('U-1', ['src/u.js'], { kind: 'exact_reverse', state: 'claimed' }),
  ] });
  const ok = go({ rec: quiet, card: undoCard(), kind: 'undo', exactReverse: true, running: [] });
  assert.equal(ok.ok, true, ok.reason);
  // A Record whose cards can't be listed refuses the undo.
  const deaf = { read: (e, id) => quiet.read(e, id), list: () => { throw new Error('locked'); } };
  const r = go({ rec: deaf, card: undoCard(), kind: 'undo', exactReverse: true, running: [] });
  assert.deepEqual([r.ok, r.reason], [false, 'the running undos could not be counted (locked)']);
});

test('L228 Minor 2: a cap value that is there but unreadable, whichever cap, refuses the undo and says so; a missing one is named and the undo starts', () => {
  const rec = setup({ products: [product('p1', 'paused'), product('p2')] });
  const undo = (values) => go({ rec, rules: rulesWith(values), card: undoCard(), kind: 'undo', exactReverse: true });
  for (const key of [K.editingPerProduct, K.editingPerMac]) {
    const r = undo({ [key]: 'two' });
    assert.deepEqual([r.ok, r.missing, r.reason], [false, key, `the rules' value for ${key} is unreadable: start nothing`], key);
    const gone = undo({ [key]: undefined });
    assert.deepEqual([gone.ok, gone.missing], [true, key], `${key} missing: ${gone.reason}`);
  }
  const ps = undo({ [K.perState]: { light: 1, active: 3, away: 3, paused: 'two' } });
  assert.deepEqual([ps.ok, ps.reason], [false, `the rules' value for ${K.perState} is unreadable: start nothing`]);
  // A non-undo is refused either way, with the same words.
  assert.equal(go({ rec, rules: rulesWith({ [K.editingPerMac]: 'two' }), product: 'p2', card: { id: 'n2', product: 'p2', tier: 2, files: ['src/n2.js'] } }).reason, `the rules' value for ${K.editingPerMac} is unreadable: start nothing`);
});

// L852 (#369 m3): the worker runner asks check 12 for an undo too; it asks the pass's own exact-reverse check, with the
// same filesOf, so a paused product starts its exact undo through the launch as through the pass, and refuses, as the
// pass does, an undo that is not an exact reverse, on any product.
test('L852: launch check 12 gives an undo the pass\'s answer: exact with filesOf, refused as not exact without', async () => {
  const SHA = 'a'.repeat(40);
  const rec = recWith([product('p1', 'paused'),
    ['card', 'T-1', { state: 'merged', product: 'p1', tier: 2, files: ['src/a.js'], merge_commit: SHA }],
    ['merge', 'MG-1', { state: 'audited_ok', card: 'T-1', pr: 7, merge_commit: SHA, product: 'p1' }],
    ['ask', 'A-1', { state: 'answered', kind: 'undo', product: 'p1', card: 'T-1' }],
    // The undo cards themselves, as the Record holds them: check12 asks that the id names one (L875 m2).
    ['card', 'U-1', { state: 'ready', kind: 'exact_reverse', source: { ask: 'A-1' }, product: 'p1', tier: 2, files: ['src/a.js'] }],
    ['card', 'U-2', { state: 'ready', kind: 'exact_reverse', source: { ask: 'A-9' }, product: 'p1', tier: 2, files: ['src/a.js'] }]]);
  const rules = rulesWith();
  const undo = { id: 'U-1', state: 'ready', kind: 'exact_reverse', source: { ask: 'A-1' }, product: 'p1', tier: 2, files: ['src/a.js'] };
  const filesOf = () => ['src/a.js'];
  const base = { rules, rec, bandsNow: () => GREEN, runningNow: () => [] };
  const ask = (port, card = undo) => port({ card, kind: 'undo', product: 'p1', undoCommit: SHA });
  const viaPass = startGate({ rules, rec, card: undo, kind: 'undo', product: 'p1', b: GREEN, running: [], exactReverse: true });
  assert.equal(viaPass.ok, true, 'control: the pass starts this undo on a paused product');
  assert.deepEqual(await ask(check12({ ...base, filesOf })), viaPass);
  for (const [why, port, card] of [['no filesOf', check12(base), undo], ['files differ', check12({ ...base, filesOf: () => ['src/b.js'] }), undo],
    ['filesOf throws', check12({ ...base, filesOf: () => { throw new Error('x'); } }), undo], ['no merge', check12({ ...base, filesOf }), { ...undo, id: 'U-2', source: { ask: 'A-9' } }]]) {
    const r = await ask(port, card);
    assert.equal(r.ok, false, why);
    assert.match(r.reason, /^it is not an exact reverse: /, why);
  }
  // On an active product with room too: the pass refuses a not-exact undo whatever the caps say, and so does the launch.
  const active = recWith([product('p1'), ...['T-1', 'MG-1', 'A-1', 'U-1'].map((id) => { const e = id === 'T-1' || id === 'U-1' ? 'card' : id === 'MG-1' ? 'merge' : 'ask'; return [e, id, rec.read(e, id).doc]; })]);
  const onActive = { ...base, rec: active };
  assert.equal((await ask(check12({ ...onActive, filesOf }))).ok, true, 'control: exact on an active product');
  for (const [why, port] of [['no filesOf', check12(onActive)], ['files differ', check12({ ...onActive, filesOf: () => ['src/b.js'] })]]) {
    const r = await ask(port);
    assert.equal(r.ok, false, why);
    assert.match(r.reason, /^it is not an exact reverse: /, why);
  }
  assert.match((await check12({ ...base, filesOf })({ card: null, kind: 'undo', product: 'p1' })).reason, /^it is not an exact reverse: it has no card/);
  // L976: the commit the session was handed must be the one the source names; one that is not, or none at all when named, is refused.
  assert.deepEqual(await ask((x) => check12({ ...base, filesOf })({ ...x, undoCommit: SHA })), viaPass, 'the source\'s commit');
  for (const undoCommit of ['b'.repeat(40), undefined, null]) {
    const r = await check12({ ...base, filesOf })({ card: undo, kind: 'undo', product: 'p1', undoCommit });
    assert.equal(r.ok, false, String(undoCommit)); assert.match(r.reason, /the reversed commit it was handed is not the one its source names/);
  }
  // #468 m1: fails closed. An undo launch that leaves the key out is refused, not let past the comparison.
  const keyless = await check12({ ...base, filesOf })({ card: undo, kind: 'undo', product: 'p1' });
  assert.equal(keyless.ok, false, 'no undoCommit key');
  assert.equal(keyless.reason, 'it is not an exact reverse: the launch names no reversed commit');
  // L863 m1: at launch the undo is already claimed. With its id it is told from another undo and starts; a card doc
  // with no id is refused for that, never counted as "an undo is already running" by its own claim.
  const claimed = recWith([...['T-1', 'MG-1', 'A-1'].map((id) => { const e = id === 'T-1' ? 'card' : id === 'MG-1' ? 'merge' : 'ask'; return [e, id, rec.read(e, id).doc]; }),
    product('p1', 'paused'), ['card', 'U-1', { ...undo, id: undefined, state: 'claimed' }],
    ['card', 'U-9', { ...undo, id: undefined, state: 'ready', source: { ask: 'A-7' } }], ['card', 'E-1', { state: 'ready', product: 'p1', tier: 2, files: ['src/e.js'] }],
    // L882 m3: one field off each: the product only, the kind only.
    ['card', 'P-2', { ...undo, id: undefined, state: 'claimed', product: 'p2' }], ['card', 'K-1', { ...undo, id: undefined, state: 'claimed', kind: 'editing' }]]);
  const atLaunch = check12({ ...base, rec: claimed, filesOf });
  assert.equal((await atLaunch({ card: { ...undo, state: 'claimed' }, kind: 'undo', product: 'p1', undoCommit: SHA })).ok, true, 'with its id: its own claim is not another undo');
  const { id: _, ...noId } = { ...undo, state: 'claimed' };
  const r = await atLaunch({ card: noId, kind: 'undo', product: 'p1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the undo's card names no id/);
  assert.doesNotMatch(r.reason, /already running/);
  for (const id of ['', 7]) assert.match((await atLaunch({ card: { ...noId, id }, kind: 'undo', product: 'p1' })).reason, /the undo's card names no id/, String(id));
  // L875 m2: a blank id, a padded one, or one naming another card (another undo's, a plain card, or none) is refused
  // too, and never as "already running".
  assert.match((await atLaunch({ card: { ...noId, id: ' ' }, kind: 'undo', product: 'p1' })).reason, /the undo's card names no id/);
  // L882 c1: a padded id has its own reason.
  for (const id of [' U-1', 'U-1 ']) assert.match((await atLaunch({ card: { ...noId, id }, kind: 'undo', product: 'p1' })).reason, new RegExp(`the undo's card id ${JSON.stringify(id)} has spaces around it`), JSON.stringify(id));
  for (const id of ['U-9', 'E-1', 'U-404', 'P-2', 'K-1']) {
    const w = await atLaunch({ card: { ...noId, id }, kind: 'undo', product: 'p1' });
    assert.equal(w.ok, false, id);
    assert.match(w.reason, new RegExp(`the undo's card id ${id} names no card of its kind, product and source`), id);
    assert.doesNotMatch(w.reason, /already running/, id);
  }
  // L882 m3: a lookup that throws, or a card the store reads as corrupt, names no card either: refused, never running.
  for (const [what, read] of [['throws', () => { throw new Error('store down'); }], ['corrupt', (e, id) => ({ id, entity: e, corrupt: true, reason: 'bad bytes' })]]) {
    const odd = Object.create(claimed);
    Object.defineProperty(odd, 'read', { value: (e, id) => (e === 'card' && id === 'U-1' ? read(e, id) : claimed.read(e, id)) });
    const w = await check12({ ...base, rec: odd, filesOf })({ card: { ...undo, state: 'claimed' }, kind: 'undo', product: 'p1' });
    assert.equal(w.ok, false, what);
    assert.match(w.reason, /the undo's card id U-1 names no card of its kind, product and source/, what);
    assert.doesNotMatch(w.reason, /already running/, what);
  }
  // L875 c1 (plant G8): an id is asked only of an undo; a card of any other kind with no id goes to startGate as before.
  const plain = { product: 'p1', tier: 2, files: ['src/x.js'] };
  for (const kind of ['editing', 'script']) {
    assert.deepEqual(await atLaunch({ card: plain, kind, product: 'p1' }),
      startGate({ rules, rec: claimed, card: plain, kind, product: 'p1', b: GREEN, running: [] }), kind);
  }
  // Every other kind is unchanged: exact or not is asked only for an undo.
  const ed = { id: 'new', product: 'p1', tier: 2, files: ['src/new.js'] };
  assert.deepEqual(await check12({ ...base, filesOf })({ card: ed, kind: 'editing', product: 'p1' }), startGate({ rules, rec, card: ed, kind: 'editing', product: 'p1', b: GREEN, running: [] }));
});
