// required-keys.test.mjs — the Record's key list matches every rules read in any of its non-test files (L86 2, 9;
// L96 M-1, m-4; L123; L165): every key read is listed, every listed key is read, in any quote kind and through the typed reads
// (num, dec, flag, plain or ?.), template and const-named keys included, and a read whose key can't be named fails.
// The reader is M10's rules-reads.test-helper.mjs, which M2's test shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REQUIRED_KEYS, OPTIONAL_KEYS, FLAG_KEYS } from './required-keys.mjs';
import { GO_FREE, GO_FREE_KEY } from './ready.mjs';
import { KEYS as M11_KEYS } from '../M11-dispatcher/keys.mjs';
import { listed, moduleReads, moduleSources, readsListed, rulesReads } from '../M10-rules/rules-reads.test-helper.mjs';

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

// Every non-test file in the module (L165).
const SOURCES = moduleSources(new URL('./', import.meta.url));
const stripWriter = (t) => { let w = t; for (const h of HELPERS) w = w.replace(h, ''); return w.replace(/\n\s*get\(entity, id\) \{/, '\n'); };
const FILES = { 'writer.mjs': { helpers: ['get', 'num'], prep: stripWriter } };
const UNNAMED = { 'required-keys.mjs': { count: 3, why: 'policyProblems walks REQUIRED_KEYS itself, so these reads take their key from the list this test checks' } };
const scan = (sources = SOURCES, unnamed = UNNAMED) => moduleReads(sources, { files: FILES, unnamed, keyMaps: { KEYS: M11_KEYS } });

test('every rules key any file in the Record reads is on its list, and every listed key is read', () => {
  const { keys, problems } = scan();
  assert.deepEqual(problems, [], 'every rules read names its key, or says why not');
  assert.ok(SOURCES.length > 10 && SOURCES.some((s) => s.file === 'store.mjs') && !SOURCES.some((s) => /\.test/.test(s.file)), 'every non-test file, and no test');
  assert.deepEqual(unlisted(keys), [], 'every key read is listed');
  for (const k of LIST) assert.ok(readsListed(keys, k), `required-keys.mjs lists ${k}, which the Record doesn't read`);
  // The template key over the states, the typed reads, and goFreeOn's computed key over every go-free kind (L123).
  for (const k of ['product_state_rules.light.start', 'caps.rounds', 'claims.stuck_min', 'proposals.heartbeat_stale_min',
    ...Object.keys(GO_FREE).map((kind) => `${GO_FREE_KEY}.${kind}`)]) assert.ok(keys.has(k), k);
});

test('L165 plants, on copies: a read in a file the old test skipped, in a new file, or with a key it can\'t name; a stale UNNAMED entry', () => {
  const swapped = (file, fn) => SOURCES.map((s) => (s.file === file ? { ...s, text: fn(s.text) } : s));
  const atStore = (line) => swapped('store.mjs', (t) => `${t}\n${line}\n`);
  assert.deepEqual(unlisted(scan(atStore("export const a = (rules) => rules.num('caps.in_store');")).keys), ['caps.in_store']);
  assert.match(scan(atStore('export const a = (rules, k) => rules.get(k);')).problems.join(), /store\.mjs: 1 rules read/);
  assert.deepEqual(unlisted(scan([...SOURCES, { file: 'new.mjs', text: "export const a = (ctx) => ctx.rules.flag('caps.in_new');\n" }]).keys), ['caps.in_new']);
  assert.match(scan(SOURCES, {}).problems.join(), /required-keys\.mjs: 3 rules read/);
  assert.match(scan(SOURCES, { 'required-keys.mjs': { ...UNNAMED['required-keys.mjs'], count: 4 } }).problems.join(), /4 allowed/, 'an allowance larger than the reads is stale');
  assert.match(scan(SOURCES, { ...UNNAMED, 'gone.mjs': { count: 0, why: 'x'.repeat(30) } }).problems.join(), /gone\.mjs is listed/);
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

// L164 m1: the optional claim waits, when set, are whole minutes, at least 1 (missing is fine; each says what happens).
test('L164 m1: claims.stuck_min and claims.unlaunched_min, when set, must be whole minutes, at least 1', async () => {
  const { policyProblems } = await import('./required-keys.mjs');
  const { fakeRules } = await import('../../shared/rules.mjs');
  const P = 'sample-app';
  for (const key of OPTIONAL_KEYS.filter((k) => !FLAG_KEYS.includes(k))) {
    const line = `M9: ${key}, when set, must be a whole number of minutes, at least 1`;
    for (const bad of [0, 'soon', -2, 1.5]) assert.ok(policyProblems(fakeRules({ values: { [key]: bad } }), P).includes(line), `${key}: ${bad}`);
    for (const good of [1, 30, '30', undefined]) assert.ok(!policyProblems(fakeRules({ values: good === undefined ? {} : { [key]: good } }), P).includes(line), `${key}: ${good}`);
  }
});

test('L1122 m4: product.test_product, when set, must be exactly true or false, and a good one passes the whole rules check', async () => {
  const { policyProblems } = await import('./required-keys.mjs');
  const { fakeRules } = await import('../../shared/rules.mjs');
  const { FIRST, ENTRY, fit, swap } = await import('../M10-rules/first-cutover.test-helper.mjs');
  const P = 'sample-app';
  const line = 'M9: product.test_product, when set, must be true or false';
  const minutes = /product\.test_product, when set, must be a whole number of minutes/;
  for (const bad of ['yes', 1, 0, 'TRUE', 'on']) {
    const out = policyProblems(fakeRules({ values: { 'product.test_product': bad } }), P);
    assert.ok(out.includes(line), `refused: ${bad}`);
    assert.ok(!out.some((x) => minutes.test(x)), `never read as minutes: ${bad}`);
  }
  for (const good of [true, false, 'true', 'false', undefined]) {
    const out = policyProblems(fakeRules({ values: good === undefined ? {} : { 'product.test_product': good } }), P);
    assert.ok(!out.some((x) => /test_product/.test(x)), `passes: ${good} (${out.join('; ')})`);
  }
  // The whole rules check (firstCutoverProblems, which runs moduleProblems over every module's list): orchestrate-test's
  // line passes, quoted or not; a bad one is refused as a switch, never as minutes.
  const withFlag = (v) => swap(FIRST, 'product:\n  cutover_stage: first\n', `product:\n  cutover_stage: first\n  test_product: ${v}\n`);
  for (const v of ['true', '"true"', 'false']) assert.deepEqual(fit(withFlag(v), ENTRY), [], `the rules file passes with test_product: ${v}`);
  const bad = fit(withFlag('yes'), ENTRY);
  assert.ok(bad.some((x) => /test_product.*must be true or false/.test(x)), bad.join('; '));
  assert.ok(!bad.some((x) => minutes.test(x)), bad.join('; '));
});

