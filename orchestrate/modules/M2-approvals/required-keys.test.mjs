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
const keysRead = (text) => new Set([...text.matchAll(/\bget\(\s*'([^']+)'/g)].map((m) => m[1]));

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
