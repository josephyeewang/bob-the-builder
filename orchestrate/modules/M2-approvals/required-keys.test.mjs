// required-keys.test.mjs — Approvals' key list matches what readConfig reads (L86 2): every key it reads is listed,
// and every listed key is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';

const KINDS = readFileSync(new URL('kinds.mjs', import.meta.url), 'utf8');
const body = (text, name) => {
  const a = text.indexOf(`export function ${name}(`);
  assert.ok(a >= 0, `${name} is in the file`);
  return text.slice(a, text.indexOf('\n}\n', a));
};
// A rules read in any quote kind (L96 m-4); comment lines are not code.
const code = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const LIT = /(?<![.\w])get\(\s*(['"`])((?:(?!\1)[^\\])*)\1/g;
const keysRead = (text) => new Set([...code(text).matchAll(LIT)].map((m) => m[2]));
// A get( whose key isn't a literal: a computed key would slip past the list.
const nonLiteral = (text) => [...code(text).matchAll(/(?<![.\w])get\(/g)].length - [...code(text).matchAll(LIT)].length;

test('every rules key readConfig reads is on Approvals\' list, and every listed key is read', () => {
  const read = keysRead(body(KINDS, 'readConfig'));
  assert.ok(read.size >= 5, `found ${[...read]}`);
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  for (const k of read) assert.ok(list.includes(k), `readConfig reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of list) assert.ok(read.has(k), `required-keys.mjs lists ${k}, which readConfig doesn't read`);
});

test('the only rules reads in kinds.mjs are readConfig\'s', () => {
  const all = keysRead(KINDS);
  const mine = keysRead(body(KINDS, 'readConfig'));
  assert.deepEqual([...all].filter((k) => !mine.has(k)), []);
});

test('readConfig names every key as a literal, and the reader sees double quotes (the P10 plant, on a copy)', () => {
  assert.equal(nonLiteral(body(KINDS, 'readConfig')), 0);
  const planted = KINDS.replace("const u = get('approvals.urgent');", 'const u = get(\'approvals.urgent\'); const x = get("approvals.extra");');
  assert.ok(keysRead(body(planted, 'readConfig')).has('approvals.extra'));
  assert.equal(nonLiteral(KINDS.replace("get('approvals.urgent')", 'get(URGENT)')), 1);
});
