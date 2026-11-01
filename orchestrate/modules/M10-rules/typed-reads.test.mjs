// typed-reads.test.mjs — rules.num() and rules.flag() over the real rules text (lead call L96). The rules reader
// hands back text for every key it doesn't convert, so `claims.stuck_min: 30` arrived as "30" and every module check
// for a number refused it. These tests build their rules through the real parsePolicy text path and the real engine,
// never a JS object. Run: node --test orchestrate/modules/M10-rules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRules, fakeRules, wholeNumber, exactFlag } from '../../shared/rules.mjs';
import { makeEngine, MAC_LIST_ALL } from './engine.mjs';
import { parsePolicy } from './policy.mjs';

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
  assert.equal(n('d'), -2);
  assert.equal(n('e'), 7);
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
  for (const [v, want] of [[30, 30], ['30', 30], ['-0', 0], [-0, 0], [3.5, undefined], [NaN, undefined], [Infinity, undefined],
    ['', undefined], ['+3', undefined], ['0x10', undefined], ['1e3', undefined], ['٣', undefined], [null, undefined], [undefined, undefined], [true, undefined]]) {
    assert.equal(Object.is(wholeNumber(v), want), true, `wholeNumber(${JSON.stringify(v)}) → ${wholeNumber(v)}`);
  }
  for (const [v, want] of [[true, true], ['true', true], [false, false], ['false', false], ['TRUE', undefined], [0, undefined], [null, undefined], ['true ', undefined]]) {
    assert.equal(exactFlag(v), want, `exactFlag(${JSON.stringify(v)})`);
  }
});

test('L96: a fake and the real engine convert the same way', () => {
  const fake = fakeRules({ values: { 'claims.stuck_min': '30', 'x.on': 'true', 'x.bad': '3x' } });
  assert.equal(fake.num('claims.stuck_min'), 30);
  assert.equal(fake.flag('x.on'), true);
  assert.equal(fake.num('x.bad'), undefined);
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
