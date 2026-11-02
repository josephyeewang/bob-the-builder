// required-keys.test.mjs — Approvals' key list matches what readConfig reads (L86 2; L123): every key it reads is
// listed, and every listed key is read, through get( and the typed reads (num, dec, flag, plain or ?.). The reader is
// M10's rules-reads.test-helper.mjs, which M9's test shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';
import { rulesReads } from '../M10-rules/rules-reads.test-helper.mjs';

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

test('every rules key readConfig reads is on Approvals\' list, and every listed key is read', () => {
  const { keys, nonLiteral } = reads(body(KINDS, 'readConfig'));
  assert.equal(nonLiteral, 0, 'every rules read names its key');
  assert.ok(keys.has('accounts.joe.github_id'), 'the typed read rules?.num?.( is seen (L123)');
  for (const k of keys) assert.ok(LIST.includes(k), `readConfig reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of LIST) assert.ok(keys.has(k), `required-keys.mjs lists ${k}, which readConfig doesn't read`);
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
