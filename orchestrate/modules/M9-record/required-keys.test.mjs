// required-keys.test.mjs — the Record's key list matches every rules read in ready.mjs and writer.mjs (L86 2, 9;
// L96 M-1, m-4; L123): every key read is listed, every listed key is read, in any quote kind and through the typed reads
// (num, dec, flag, plain or ?.), template and const-named keys included, and a read whose key can't be named fails.
// The reader is M10's rules-reads.test-helper.mjs, which M2's test shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS } from './required-keys.mjs';
import { GO_FREE, GO_FREE_KEY } from './ready.mjs';
import { listed, readsListed, rulesReads } from '../M10-rules/rules-reads.test-helper.mjs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const LIST = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
// writer.mjs reads through two helpers, called bare: get( and num(. Their own lines pass a variable, so they are taken
// out; its view's `get(entity, id) {` is the record's own get, not a rules read.
const HELPERS = ['const get = (key) => rules.get(key, { product });', 'const num = (key) => rules.num(key, { product });'];

function recordReads(ready = read('ready.mjs'), writer = read('writer.mjs')) {
  let w = writer;
  for (const h of HELPERS) { assert.ok(w.includes(h), `writer.mjs has its helper: ${h}`); w = w.replace(h, ''); }
  w = w.replace(/\n\s*get\(entity, id\) \{/, '\n');
  const r = rulesReads(ready);
  const x = rulesReads(w, { helpers: ['get', 'num'] });
  return { keys: new Set([...r.keys, ...x.keys]), nonLiteral: r.nonLiteral + x.nonLiteral };
}
const unlisted = (keys) => [...keys].filter((k) => !listed(LIST, k));

test('every rules key ready.mjs and writer.mjs read is on the Record\'s list, and every listed key is read', () => {
  const { keys, nonLiteral } = recordReads();
  assert.equal(nonLiteral, 0, 'every rules read names its key');
  assert.deepEqual(unlisted(keys), [], 'every key read is listed');
  for (const k of LIST) assert.ok(readsListed(keys, k), `required-keys.mjs lists ${k}, which the Record doesn't read`);
  // The template key over the states, the typed reads, and goFreeOn's computed key over every go-free kind (L123).
  for (const k of ['product_state_rules.light.start', 'caps.rounds', 'claims.stuck_min', 'proposals.heartbeat_stale_min',
    ...Object.keys(GO_FREE).map((kind) => `${GO_FREE_KEY}.${kind}`)]) assert.ok(keys.has(k), k);
});

test('the drift reader catches a new read in readyCheck in every form, and a key it can\'t name (the P9, P10, O5 and L123 plants, on copies)', () => {
  const ready = read('ready.mjs');
  const at = ready.indexOf("const cap = rules.num('caps.rounds'");
  assert.ok(at > 0, 'readyCheck reads caps.rounds through rules.num');
  const plant = (line, text = ready) => recordReads(`${text.slice(0, at)}${line}\n    ${text.slice(at)}`);
  const NEW = 'caps.new_m9_key';
  for (const line of [
    `rules.get('${NEW}', { product });`, `rules.get("${NEW}", { product });`, `rules?.get?.('${NEW}', { product });`,
    `rules.num('${NEW}', { product });`, `rules?.num?.('${NEW}', { product });`,
    `rules.flag('${NEW}', { product });`, `rules?.flag?.('${NEW}', { product });`,
    `rules.dec('${NEW}', { product });`, `rules?.dec?.('${NEW}', { product });`,
    `const k9 = '${NEW}'; rules.num(k9, { product });`,
  ]) assert.deepEqual(unlisted(plant(line).keys), [NEW], line);
  for (const line of ['rules.get(KEY, { product });', 'rules?.flag?.(key2, { product });', 'rules.num(`caps.${what}`, { product });'])
    assert.equal(plant(line).nonLiteral, 1, line);
  // goFreeOn's computed key: a changed map name, or a ${…} the reader can't name, is caught.
  const gf = 'const key = `${GO_FREE_KEY}.${kind}`;';
  assert.ok(ready.includes(gf), 'goFreeOn builds its key from GO_FREE_KEY and the kind');
  assert.ok(unlisted(recordReads(ready.replace(gf, 'const key = `${GO_FREE_KEY}_x.${kind}`;')).keys).length > 0);
  assert.equal(recordReads(ready.replace(gf, 'const key = `${GO_FREE_KEY}.${other}`;')).nonLiteral, 2, 'both reads of key');
  assert.ok(unlisted(recordReads(ready.replace("export const GO_FREE_KEY = 'approvals.plan_go.go_free';", "export const GO_FREE_KEY = 'approvals.go_free';")).keys).length > 0);
  // writer.mjs: its helpers and its own typed read.
  const writer = read('writer.mjs');
  assert.deepEqual(unlisted(recordReads(ready, writer.replace("num('caps.rounds')", 'num(`caps.other`)')).keys), ['caps.other']);
  assert.deepEqual(unlisted(recordReads(ready, writer.replace("get('timeouts')", "get('timeouts2')")).keys), ['timeouts2']);
  assert.deepEqual(unlisted(recordReads(ready, writer.replace("rules?.num?.('proposals.heartbeat_stale_min'", "rules?.num?.('proposals.heartbeat_x'")).keys), ['proposals.heartbeat_x']);
});
