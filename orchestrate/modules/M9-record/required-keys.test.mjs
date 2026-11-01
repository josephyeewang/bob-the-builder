// required-keys.test.mjs — the Record's go_free key matches what goFreeKinds reads (L86 2, 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS } from './required-keys.mjs';

test('goFreeKinds reads exactly the key on the Record\'s list', () => {
  const text = readFileSync(new URL('ready.mjs', import.meta.url), 'utf8');
  const a = text.indexOf('export function goFreeKinds(');
  assert.ok(a >= 0);
  const fn = text.slice(a, text.indexOf('\n}\n', a));
  const read = [...fn.matchAll(/\bget\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(read, [...REQUIRED_KEYS]);
});
