// required-keys.test.mjs — the Record's key list matches every rules read in ready.mjs and writer.mjs (L86 2, 9;
// L96 M-1, m-4): every key read is listed, every listed key is read, in any quote kind, template keys included, and a
// read whose key isn't written out fails the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';
import { PRODUCT_STATES } from '../M10-rules/policy.mjs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const LITERAL = String.raw`\s*(['"\x60])((?:(?!\1)[^\\])*)\1`;

// The keys a file reads through `call(` (rules.get or writer.mjs's own get helper), with a template key expanded over
// the product states; and every call whose key isn't a literal.
export function keysRead(text, call) {
  const keys = new Set();
  for (const m of text.matchAll(new RegExp(`${call}\\(${LITERAL}`, 'g'))) {
    const k = m[2];
    if (m[1] === '`' && /\$\{[^}]*\}/.test(k)) for (const s of PRODUCT_STATES) keys.add(k.replace(/\$\{[^}]*\}/, s));
    else keys.add(k);
  }
  const calls = [...text.matchAll(new RegExp(`${call}\\(`, 'g'))].length;
  const literal = [...text.matchAll(new RegExp(`${call}\\(${LITERAL}`, 'g'))].length;
  return { keys, nonLiteral: calls - literal };
}

function recordReads(ready = read('ready.mjs'), writer = read('writer.mjs')) {
  const r = keysRead(ready, String.raw`\brules\??\.get(?:\?\.)?`);
  // writer.mjs reads through one helper, `const get = (key) => rules.get(key, { product })`; its view's
  // `get(entity, id) {` is the record's own get, not a rules read.
  const helper = 'const get = (key) => rules.get(key, { product });';
  assert.ok(writer.includes(helper), 'writer.mjs reads the rules through its one get helper');
  const w = keysRead(writer.replace(helper, '').replace(/\n\s*get\(entity, id\) \{/, '\n'), String.raw`(?<![.\w])get`);
  const wr = keysRead(writer.replace(helper, ''), String.raw`\brules\??\.get(?:\?\.)?`);
  return { keys: new Set([...r.keys, ...w.keys, ...wr.keys]), nonLiteral: r.nonLiteral + w.nonLiteral + wr.nonLiteral };
}

test('every rules key ready.mjs and writer.mjs read is on the Record\'s list, and every listed key is read', () => {
  const { keys, nonLiteral } = recordReads();
  assert.equal(nonLiteral, 0, 'every rules read names its key as a literal');
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  for (const k of keys) assert.ok(list.includes(k), `the Record reads ${k}, which required-keys.mjs doesn't list`);
  for (const k of list) assert.ok(keys.has(k), `required-keys.mjs lists ${k}, which the Record doesn't read`);
  assert.ok(keys.has('product_state_rules.light.start') && keys.has('caps.rounds'));
});

test('the drift reader catches a new read in readyCheck, in double quotes, and a computed key (the P9 and P10 plants, on copies)', () => {
  const ready = read('ready.mjs');
  const at = ready.indexOf("const cap = rules.get('caps.rounds'");
  assert.ok(at > 0);
  const plant = (line) => recordReads(`${ready.slice(0, at)}${line}\n    ${ready.slice(at)}`);
  const list = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
  assert.ok([...plant("rules.get('caps.new_m9_key', { product });").keys].some((k) => !list.includes(k)));
  assert.ok([...plant('rules.get("caps.new_m9_key", { product });').keys].some((k) => !list.includes(k)));
  assert.equal(plant('rules.get(KEY, { product });').nonLiteral, 1);
  // L115 m-B, the O5 plant: an optional-call read is a read too.
  assert.ok([...plant("rules?.get?.('caps.new_m9_key', { product });").keys].some((k) => !list.includes(k)));
  const writer = read('writer.mjs');
  assert.ok([...recordReads(ready, writer.replace("get('caps.rounds')", 'get(`caps.other`)')).keys].includes('caps.other'));
});
