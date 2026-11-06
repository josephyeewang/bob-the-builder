// required-keys.test.mjs — Approvals' key list matches what the module reads (L86 2; L123; L165): every key any
// non-test file reads is listed, and every listed key is read, through get( and the typed reads (num, dec, flag, plain
// or ?.). A read whose key can't be named fails unless UNNAMED gives its reason. The reader is M10's
// rules-reads.test-helper.mjs, which M9's test shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';
import { KEYS as M11_KEYS } from '../M11-dispatcher/keys.mjs';
import { moduleReads, moduleSources, rulesReads } from '../M10-rules/rules-reads.test-helper.mjs';

const KINDS = readFileSync(new URL('kinds.mjs', import.meta.url), 'utf8');
const LIST = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
const body = (text, name) => {
  const a = text.indexOf(`export function ${name}(`);
  assert.ok(a >= 0, `${name} is in the file`);
  return text.slice(a, text.indexOf('\n}\n', a));
};
// readConfig reads through one helper, called bare as get(; its own line passes a variable, so it is taken out.
const HELPER = 'const get = (k) => rules?.get?.(k, { product });';
function reads(text) {
  assert.ok(text.includes(HELPER), 'readConfig reads the rules through its one get helper');
  return rulesReads(text.replace(HELPER, ''), { helpers: ['get'] });
}

// onboard.mjs reads onboarding.state (L204-b); the whole file is scanned, so a read added anywhere in it is seen (L221 m-4).
const ONBOARD = readFileSync(new URL('onboard.mjs', import.meta.url), 'utf8');

// Every non-test file in the module (L165). kinds.mjs reads through its one get helper; its own line passes a variable.
const SOURCES = moduleSources(new URL('./', import.meta.url));
const FILES = { 'kinds.mjs': { helpers: ['get'], prep: (t) => t.replace(HELPER, '') } };
const UNNAMED = {
  'go.mjs': { count: 1, why: 'live_check.<module>.proven_at: one key per module, a set no list can hold; a missing one means not proven, so the owner decides' },
};
const scan = (sources = SOURCES, unnamed = UNNAMED) => moduleReads(sources, { files: FILES, unnamed, keyMaps: { KEYS: M11_KEYS } });
const swapped = (file, fn) => SOURCES.map((s) => (s.file === file ? { ...s, text: fn(s.text) } : s));

test('every rules key any file in Approvals reads is on its list, and every listed key is read (L165)', () => {
  assert.ok(SOURCES.length > 10 && SOURCES.some((s) => s.file === 'go.mjs') && !SOURCES.some((s) => /\.test/.test(s.file)), 'every non-test file, and no test');
  const { keys, problems } = scan();
  assert.deepEqual(problems, []);
  assert.ok(keys.has('accounts.joe.github_id'), 'the typed read rules?.num?.( is seen (L123)');
  assert.ok(keys.has('onboarding.state'));
  for (const k of keys) assert.ok(LIST.includes(k), `M2 reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of LIST) assert.ok(keys.has(k), `required-keys.mjs lists ${k}, which no file in Approvals reads`);
});

test('L165 plants, on copies: a read outside readConfig, in a new file, or with a key it can\'t name; a stale or bare UNNAMED entry', () => {
  const unlisted = (keys) => [...keys].filter((k) => !LIST.includes(k));
  const outside = (line) => swapped('kinds.mjs', (t) => t.replace('export function zoneFor(', `${line}\nexport function zoneFor(`));
  assert.deepEqual(unlisted(scan(outside("const a = (rules) => rules.num('approvals.outside');")).keys), ['approvals.outside']);
  assert.deepEqual(scan(outside('const a = (rules, k) => rules.get(k);')).problems.length, 1, 'kinds.mjs outside readConfig, a key it can\'t name');
  assert.deepEqual(unlisted(scan(outside('const a = (rules) => need(rules, KEYS.merge_timeout);')).keys).length + scan(outside('const a = (rules) => need(rules, KEYS.merge_timeout);')).problems.length > 0, true, 'a need( read is seen through the key map');
  const fresh = [...SOURCES, { file: 'brand-new.mjs', text: "export const f = (rules) => rules.flag('approvals.brand_new');\n" }];
  assert.deepEqual(unlisted(scan(fresh).keys), ['approvals.brand_new'], 'a new file is scanned unasked');
  assert.match(scan(swapped('go.mjs', (t) => t.replace('return { needed', "rules.get(other);\n  return { needed"))).problems.join(), /go\.mjs: 2 rules read/, 'one more unnamed read in a file with a reason');
  assert.deepEqual(scan(SOURCES, {}).problems.length, 1, 'go.mjs with no reason listed');
  assert.match(scan(SOURCES, { ...UNNAMED, 'gone.mjs': { count: 0, why: 'x'.repeat(30) } }).problems.join(), /gone\.mjs is listed/);
  assert.match(scan(SOURCES, { 'go.mjs': { count: 1, why: 'x' } }).problems.join(), /need a reason/);
});

test('the reader sees a new read in onboard.mjs, and a key it can\'t name (plants on copies, L221 m-4)', () => {
  const at = "const on = ctx.rules?.get?.('onboarding.state', { product: ctx.product });";
  assert.ok(ONBOARD.includes(at), 'onboard.mjs reads the key through ctx.rules, written out');
  const plant = (line) => rulesReads(ONBOARD.replace(at, `${at} ${line}`));
  assert.deepEqual([...plant("ctx.rules.get('onboarding.extra', { product: ctx.product });").keys].filter((k) => !LIST.includes(k)), ['onboarding.extra']);
  assert.equal(rulesReads(ONBOARD.replace("get?.('onboarding.state'", 'get?.(keyFromSomewhere')).nonLiteral, 1);
});

test('the only rules reads in kinds.mjs are readConfig\'s', () => {
  const all = rulesReads(KINDS).keys;
  const mine = reads(body(KINDS, 'readConfig')).keys;
  assert.deepEqual([...all].filter((k) => !mine.has(k)), []);
});

test('the reader sees a new read in readConfig in every form, and a key it can\'t name (the P10 and L123 plants, on copies)', () => {
  const at = "const u = get('approvals.urgent');";
  assert.ok(KINDS.includes(at));
  const plant = (line) => reads(body(KINDS.replace(at, `${at} ${line}`), 'readConfig'));
  const NEW = 'approvals.extra';
  for (const line of [`get("${NEW}");`, `get('${NEW}');`, `rules.get('${NEW}', { product });`, `rules?.get?.('${NEW}', { product });`,
    `rules.num('${NEW}', { product });`, `rules?.num?.('${NEW}', { product });`, `rules.flag('${NEW}', { product });`,
    `rules?.flag?.('${NEW}', { product });`, `rules.dec('${NEW}', { product });`, `rules?.dec?.('${NEW}', { product });`])
    assert.deepEqual([...plant(line).keys].filter((k) => !LIST.includes(k)), [NEW], line);
  assert.equal(reads(body(KINDS.replace("get('approvals.urgent')", 'get(URGENT)'), 'readConfig')).nonLiteral, 1);
  assert.equal(plant('rules?.num?.(key, { product });').nonLiteral, 1);
  // A typed read moved out of readConfig is a read the list check no longer sees, so the second test catches it.
  const moved = KINDS.replace("rules?.num?.('accounts.joe.github_id', { product })", 'undefined')
    .replace('export function zoneFor(', "const gid = (rules, product) => rules?.num?.('accounts.joe.github_id', { product });\nexport function zoneFor(");
  assert.ok(!reads(body(moved, 'readConfig')).keys.has('accounts.joe.github_id'));
  assert.ok(rulesReads(moved).keys.has('accounts.joe.github_id'));
});
