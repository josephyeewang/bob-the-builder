// typed-reads.test.mjs — rules.num() and rules.flag() over the real rules text (lead call L96). The rules reader
// hands back text for every key it doesn't convert, so `claims.stuck_min: 30` arrived as "30" and every module check
// for a number refused it. These tests build their rules through the real parsePolicy text path and the real engine,
// never a JS object. Run: node --test 'orchestrate/modules/M10-rules/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules, fakeRules, wholeNumber, decimal, exactFlag } from '../../shared/rules.mjs';
import { makeEngine, MAC_LIST_ALL } from './engine.mjs';
import { parsePolicy } from './policy.mjs';
import { rulesFromText } from './from-text.mjs';

const P = { product: 'app' };
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
const C = 'c'.repeat(40); const B = 'b'.repeat(40);

// The fixture plus extra rules text, appended under keys the fixture doesn't have.
const withText = (extra) => {
  const r = parsePolicy(`${FIXTURE}\n${extra}\n`);
  assert.ok(r.ok, r.reason);
  return r.policy;
};
// The fixture with the usage block given extra lines (usage is in the fixture already, so it is edited in place).
const withUsage = (lines) => {
  const t = FIXTURE.replace(/^usage:\n/m, `usage:\n${lines}\n`);
  assert.notEqual(t, FIXTURE, 'the fixture has a usage block');
  const r = parsePolicy(t);
  assert.ok(r.ok, r.reason);
  return r.policy;
};

function rulesFor(policies) {
  const products = Object.keys(policies);
  return makeRules(makeEngine({
    products,
    rulesState: (p) => ({ status: 'ok', policy: policies[p], commit: C, blob: B }),
    productState: () => ({ state: 'active' }),
    running: () => 0,
    rolesDir: join(here, 'roles'),
    clock: () => Date.parse('2026-10-14T14:00:00Z'),
  }));
}

test('L96: the reader hands back text for a key it does not convert; get() shows it, num() reads it', () => {
  const rules = rulesFor({ app: withText('claims:\n  stuck_min: 30\nproposals:\n  heartbeat_stale_min: 45\n  lead_go_free: true\n  off: false') });
  assert.equal(rules.get('claims.stuck_min', { product: 'app' }), '30', 'get() is the value as written');
  assert.equal(rules.num('claims.stuck_min', { product: 'app' }), 30);
  assert.equal(rules.num('proposals.heartbeat_stale_min', { product: 'app' }), 45);
  assert.equal(rules.flag('proposals.lead_go_free', { product: 'app' }), true);
  assert.equal(rules.flag('proposals.off', { product: 'app' }), false);
  // A key the reader already converted reads the same way through num().
  assert.equal(rules.num('caps.rounds', { product: 'app' }), 3);
  assert.equal(rules.num('caps.editing_per_mac'), 5, 'a Mac-wide number, no product');
});

test('L96: num() is a strict whole number; anything else is missing', () => {
  const rules = rulesFor({ app: withText([
    'claims:',
    '  a: 3x', '  b: 1.5', '  c: "30"', '  d: -2', '  e: 007', '  f: 99999999999999999999', '  g: "3 "', '  h: true', '  i: [1]',
  ].join('\n')) });
  const n = (k) => rules.num(`claims.${k}`, { product: 'app' });
  assert.equal(n('a'), undefined, '3x');
  assert.equal(n('b'), undefined, '1.5');
  assert.equal(n('c'), 30, 'quoted digits are still digits');
  // One whole-number rule for the checker and for num() (L104): no minus, no leading zero.
  assert.equal(n('d'), undefined, '-2');
  assert.equal(n('e'), undefined, '007');
  assert.equal(n('f'), undefined, 'past the safe range');
  assert.equal(n('g'), undefined, 'a trailing space');
  assert.equal(n('h'), undefined, 'a flag is not a number');
  assert.equal(n('i'), undefined, 'a list is not a number');
  assert.equal(n('missing'), undefined);
  assert.equal(rules.num('claims.a', { product: 'other' }), undefined, 'an unknown product');
});

test('L96: flag() is exactly true or false; anything else is missing', () => {
  const rules = rulesFor({ app: withText(['claims:', '  a: True', '  b: yes', '  c: 1', '  d: "false"', '  e: ""', '  f: [true]'].join('\n')) });
  const f = (k) => rules.flag(`claims.${k}`, { product: 'app' });
  assert.equal(f('a'), undefined, 'True');
  assert.equal(f('b'), undefined, 'yes');
  assert.equal(f('c'), undefined, '1');
  assert.equal(f('d'), false, 'quoted false is still false');
  assert.equal(f('e'), undefined, 'empty');
  assert.equal(f('f'), undefined, 'a list');
});

test('L96: the converters themselves, value by value', () => {
  for (const [v, want] of [[30, 30], ['30', 30], ['0', 0], ['-0', undefined], ['030', undefined], ['-30', undefined], [-30, undefined], [-0, 0], [3.5, undefined], [NaN, undefined], [Infinity, undefined],
    ['', undefined], ['+3', undefined], ['0x10', undefined], ['1e3', undefined], ['٣', undefined], [null, undefined], [undefined, undefined], [true, undefined]]) {
    assert.equal(Object.is(wholeNumber(v), want), true, `wholeNumber(${JSON.stringify(v)}) → ${wholeNumber(v)}`);
  }
  for (const [v, want] of [[true, true], ['true', true], [false, false], ['false', false], ['TRUE', undefined], [0, undefined], [null, undefined], ['true ', undefined]]) {
    assert.equal(exactFlag(v), want, `exactFlag(${JSON.stringify(v)})`);
  }
  // L104 M-3: a decimal is digits with an optional fraction; no exponent, sign, space or bare dot.
  for (const [v, want] of [[0.85, 0.85], ['0.85', 0.85], ['0.5', 0.5], ['3', 3], ['0', 0], ['10.25', 10.25], [-0.1, undefined],
    ['.5', undefined], ['1.', undefined], ['1e-3', undefined], ['-0.1', undefined], ['+1', undefined], [' 0.5', undefined],
    ['0.5 ', undefined], ['05.5', undefined], ['', undefined], [NaN, undefined], [Infinity, undefined], [true, undefined], [null, undefined]]) {
    assert.equal(Object.is(decimal(v), want), true, `decimal(${JSON.stringify(v)}) → ${decimal(v)}`);
  }
});

test('L104: the checker and num() share one whole-number rule: "030" and "-30" are refused by both', () => {
  for (const bad of ['030', '-30']) {
    const t = FIXTURE.replace(/^caps:\n/m, `caps:\n  rounds_extra: ${bad}\n`);
    assert.notEqual(t, FIXTURE);
    assert.equal(parsePolicy(t).ok, false, `the checker refuses caps.* = ${bad}`);
    assert.equal(rulesFor({ app: withText(`claims:\n  stuck_min: ${bad}`) }).num('claims.stuck_min', { product: 'app' }), undefined, `num refuses ${bad}`);
  }
  // And a decimal the checker reads is the decimal dec() reads.
  for (const bad of ['1e-3', '.5', '+1']) {
    assert.equal(parsePolicy(FIXTURE.replace(/^usage:\n/m, `usage:\n  pace_min_share: ${bad}\n`)).ok, false, `the checker refuses ${bad}`);
    assert.equal(rulesFor({ app: withText(`claims:\n  share: ${bad}`) }).dec('claims.share', { product: 'app' }), undefined, `dec refuses ${bad}`);
  }
});

test('L104: usage.pace_min_share: 0.5 in the rules text comes out as 0.5', () => {
  const rules = rulesFromText(FIXTURE.replace(/^usage:\n/m, 'usage:\n  pace_min_share: 0.5\n'));
  assert.equal(rules.dec('usage.pace_min_share', { product: 'app' }), 0.5);
  assert.throws(() => rulesFromText(FIXTURE.replace(/^usage:\n/m, 'usage:\n  pace_min_share: 1.5\n')), /pace_min_share must be 0–1/);
});

test('L104 O-1: the checker accepts outage.*, the timeouts minute keys and caps.shakedown, and reads them typed', () => {
  const text = `${FIXTURE.replace(/^caps:\n/m, 'caps:\n  shakedown: false\n')
    .replace(/^timeouts:\n/m, 'timeouts:\n  cancel_grace_min: 20\n  usage_unknown_max_min: 90\n')}\noutage:\n  min_dead: 2\n  share: 0.5\n`;
  const rules = rulesFromText(text);
  const o = { product: 'app' };
  assert.equal(rules.flag('caps.shakedown', o), false);
  assert.equal(rules.num('caps.shakedown_workers', o), 1, 'the fixture holds 1');
  assert.equal(rules.num('timeouts.cancel_grace_min', o), 20);
  assert.equal(rules.num('timeouts.usage_unknown_max_min', o), 90);
  assert.equal(rules.num('timeouts.merging_open_max_min', o), 10, "the Merge Gate's limit, in the fixture itself (L148)");
  assert.equal(rules.num('outage.min_dead', o), 2);
  assert.equal(rules.dec('outage.share', o), 0.5);
  // What it still refuses: a shakedown that isn't true or false, a minute key that isn't a whole number, a misspelt
  // entity, an unknown outage key, a share above 1.
  const refused = (t, why) => assert.equal(parsePolicy(t).ok, false, why);
  refused(FIXTURE.replace(/^caps:\n/m, 'caps:\n  shakedown: yes\n'), 'shakedown: yes');
  refused(FIXTURE.replace(/^timeouts:\n/m, 'timeouts:\n  cancel_grace_min: 2.5\n'), 'a fractional minute');
  refused(FIXTURE.replace(/^timeouts:\n/m, 'timeouts:\n  cancel_grace: 20\n'), 'not an entity, not a _min key');
  refused(FIXTURE.replace(/^timeouts:\n/m, 'timeouts:\n  cards_min:\n    a: 1\n'), 'a _min key holding a map');
  refused(`${FIXTURE}\noutage:\n  min_deda: 2\n`, 'a misspelt outage key');
  refused(`${FIXTURE}\noutage:\n  share: 1.5\n`, 'outage.share above 1');
  refused(`${FIXTURE}\noutage: 3\n`, 'outage that is not a map');
});

test('L104 O-1: a per-product key read with no product is missing, and recorded', () => {
  const rules = rulesFromText(FIXTURE);
  assert.notEqual(rules.num('caps.rounds', { product: 'app' }), undefined);
  assert.equal(rules.num('caps.rounds'), undefined, 'no product: missing');
  assert.equal(rules.get('claims.stuck_min', { product: null }), undefined);
  assert.equal(rules.num('caps.rounds', { product: 'other' }), undefined, 'an unknown product is missing too');
  assert.deepEqual([...rules.engine.noProductReads], ['caps.rounds', 'claims.stuck_min'], 'only the no-product reads are kept');
  // A Mac-wide key needs no product and is not recorded.
  rules.num('caps.editing_per_mac');
  assert.deepEqual([...rules.engine.noProductReads], ['caps.rounds', 'claims.stuck_min']);
});

test('L104 Minor: usage.red_runs read with a product is the Mac-wide value, not that product\'s own list', () => {
  const two = rulesFor({ app: withUsage('  red_runs: [undos, reviews, merges]'), web: withUsage('  red_runs: [merges, undos]') });
  assert.deepEqual([...two.get('usage.red_runs', { product: 'app' })], [...two.get('usage.red_runs')]);
  assert.deepEqual([...two.get('usage.red_runs', { product: 'web' })], ['undos', 'merges']);
});

test('L104 Minor: caps.per_state is read per state, through num() on the full key', () => {
  const rules = rulesFromText(FIXTURE.replace(/^caps:\n/m, 'caps:\n  per_state:\n    editing: 4\n    checking: 0\n'));
  const o = { product: 'app' };
  assert.equal(rules.num('caps.per_state.editing', o), 4);
  assert.equal(rules.num('caps.per_state.checking', o), 0);
  assert.equal(rules.num('caps.per_state.missing', o), undefined);
  assert.equal(rules.num('caps.per_state', o), undefined, 'the map itself is not a number');
});

test('L104 Cosmetic: an empty-string item is missing for num(), dec() and flag()', () => {
  const rules = fakeRules({ values: { e: '', l: [''] } });
  assert.equal(rules.num('e'), undefined);
  assert.equal(rules.dec('e'), undefined);
  assert.equal(rules.flag('e'), undefined);
  assert.equal(rules.num('l'), undefined);
  // And the Mac-wide list refuses a list with an empty name.
  assert.equal(rulesFor({ app: withUsage('  red_runs: [undos, ""]') }).get('usage.red_runs'), undefined);
});

test('L96: a fake and the real engine convert the same way', () => {
  const fake = fakeRules({ values: { 'claims.stuck_min': '30', 'x.on': 'true', 'x.bad': '3x' } });
  assert.equal(fake.num('claims.stuck_min', P), 30);
  assert.equal(fake.flag('x.on', P), true);
  assert.equal(fake.num('x.bad', P), undefined);
  // A get() that throws is missing, as for get().
  const broken = makeRules({ may: () => null, get: () => { throw new Error('boom'); }, classify: () => null });
  assert.equal(broken.num('a'), undefined);
  assert.equal(broken.flag('a'), undefined);
});

test('L96 (audit #77 M-3a): usage.red_runs is Mac-wide, so a read with no product answers it, strictest-wins', () => {
  assert.deepEqual([...MAC_LIST_ALL], ['usage.red_runs']);
  const one = rulesFor({ app: withUsage('  red_runs: [undos, reviews, merges]') });
  assert.deepEqual([...one.get('usage.red_runs')], ['undos', 'reviews', 'merges'], 'no product needed');
  // Two products: only what both lists name.
  const two = rulesFor({ app: withUsage('  red_runs: [undos, reviews, merges]'), web: withUsage('  red_runs: [merges, undos]') });
  assert.deepEqual([...two.get('usage.red_runs')], ['undos', 'merges']);
  // One product with none, or a list that isn't plain names: missing for the whole Mac.
  assert.equal(rulesFor({ app: withUsage('  red_runs: [undos]'), web: withUsage('') }).get('usage.red_runs'), undefined);
  assert.equal(rulesFor({ app: withUsage('  red_runs: undos') }).get('usage.red_runs'), undefined, 'one value, not a list');
  assert.equal(rulesFor({ app: withUsage('  red_runs:\n    - kind: undos') }).get('usage.red_runs'), undefined, 'a list of maps, not names');
  // An empty list is a real answer: nothing runs in the red band.
  assert.deepEqual([...rulesFor({ app: withUsage('  red_runs: []') }).get('usage.red_runs')], []);
});

test("L148: the fixture holds the Merge Gate's open limit, read through the real text path, under merge.merging's own limit", () => {
  const limit = rulesFromText(FIXTURE).num('timeouts.merging_open_max_min', P);
  assert.equal(limit, 10, '#68 gate.mjs reads this; without it a real install gets MissingKey and no alert');
  const p = parsePolicy(FIXTURE);
  assert.ok(p.ok, p.reason);
  assert.ok(limit < p.policy.timeouts.merge.merging.minutes, "the gate decides before the record's merging limit does");
});
