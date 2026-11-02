// readme-keys.test.mjs — the README's "New rules keys" list is NEW_KEYS in keys.mjs, key for key (L94 c-1: the list
// is written by hand, and it fell behind once).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEW_KEYS } from './keys.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the README lists exactly NEW_KEYS, in order', () => {
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  const at = readme.indexOf('## New rules keys');
  assert.ok(at >= 0, 'the README has its "New rules keys" section');
  const para = readme.slice(at).split('\n').find((l) => l.startsWith('`'));
  const listed = para.slice(0, para.indexOf('. The list is `NEW_KEYS`')).split(', ').map((x) => x.replace(/^`|`$/g, ''));
  assert.deepEqual(listed, [...NEW_KEYS]);
});
