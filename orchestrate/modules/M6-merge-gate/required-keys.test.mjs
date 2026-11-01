// required-keys.test.mjs — the gate's key list matches what gather.mjs reads (L86 10). gather.mjs can't import the
// list yet (#67 edits it), so this reads its text: every rules key it reads must be on the list, and every listed
// key must be read. The follow-up after #67 has gather.mjs import the list, and this test then checks the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';

const here = new URL('.', import.meta.url);

// The rules keys a reader file reads: get('…') / rules.get('…') with a fixed key, and go_free through goFreeKinds.
const code = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const LIT = /(?<![.\w])get\(\s*(['"`])((?:(?!\1)[^\\])*)\1/g;
// A get( whose key isn't a literal (L96 m-4): a computed key would slip past the list.
export const nonLiteral = (text) => [...code(text).matchAll(/(?<![.\w])get\(/g)].length - [...code(text).matchAll(LIT)].length;
export function keysRead(text) {
  const keys = new Set([...code(text).matchAll(LIT)].map((m) => m[2]));
  if (/\bgoFreeKinds\(/.test(text)) keys.add('approvals.plan_go.go_free');
  return keys;
}
// A key is covered when it is listed, or when it is the map a listed key sits in (product_profile.robot → bot_user_id).
export const covered = (k, list) => list.some((x) => x === k || x.startsWith(`${k}.`));

test('every rules key gather.mjs reads is on the gate\'s list, and every listed key is read', () => {
  const text = readFileSync(new URL('gather.mjs', here), 'utf8');
  const read = keysRead(text);
  assert.ok(read.size >= 6, `found ${[...read]}`);
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  for (const k of read) assert.ok(covered(k, list), `gather.mjs reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of list) assert.ok([...read].some((r) => r === k || k.startsWith(`${r}.`)), `required-keys.mjs lists ${k}, which gather.mjs doesn't read`);
  // Every read goes through the one product-scoped helper, so a read with a computed key can't slip past the list.
  assert.equal([...text.matchAll(/\brules\.get\(/g)].length, 1, 'gather.mjs reads the rules only through get()');
  assert.equal(nonLiteral(text), 0, 'every get() in gather.mjs names its key as a literal');
});

test('the text reader finds a key added to gather.mjs (the drift plant, on a copy)', () => {
  const text = `${readFileSync(new URL('gather.mjs', here), 'utf8')}\nconst x = get('product_profile.new_key');\n`;
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  assert.ok([...keysRead(text)].some((k) => !covered(k, list)));
});

test('the text reader sees double quotes and a computed key (L96 m-4, on copies)', () => {
  const text = readFileSync(new URL('gather.mjs', here), 'utf8');
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  assert.ok([...keysRead(`${text}\nconst x = get("product_profile.new_key");\n`)].some((k) => !covered(k, list)));
  assert.equal(nonLiteral(`${text}\nconst x = get(KEY);\n`), 1);
});
