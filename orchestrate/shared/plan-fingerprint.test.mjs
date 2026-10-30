// plan-fingerprint.test.mjs — the one fingerprint the owner's go binds to (0b-5 M7, 0b-2 R2-M12, R2-M5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TIER1_BAR, canonicalJson, planFingerprint } from './plan-fingerprint.mjs';

const T2 = { product: 'sample-app', card_id: 'C-1', tier: 2, files: ['src/a.mjs'], done_when: 'tests pass' };
const T1 = { ...T2, tier: 1, plan_sha256: 'a'.repeat(64), main_commit: 'b'.repeat(40) };
const fp = (over) => planFingerprint({ ...T2, ...over });

test('the hash is sha256 of the canonical JSON, which is stable and spells out every input', () => {
  const r = planFingerprint(T2);
  assert.equal(r.ok, true);
  assert.equal(r.sha256, createHash('sha256').update(r.canonical, 'utf8').digest('hex'));
  assert.equal(r.canonical, '{"card_id":"C-1","done_bar":["tests pass"],"files":["src/a.mjs"],"main_commit":null,"plan_sha256":null,"product":"sample-app","tier":2}');
  assert.deepEqual(planFingerprint(T1).inputs.done_bar, ['tests pass', TIER1_BAR]);
});

test('file lists: order, duplicates and a leading ./ don\'t matter; case does', () => {
  const base = fp({ files: ['src/a.mjs', 'src/b.mjs'] }).sha256;
  assert.equal(fp({ files: ['src/b.mjs', './src/a.mjs', 'src/a.mjs'] }).sha256, base);
  assert.notEqual(fp({ files: ['src/A.mjs', 'src/b.mjs'] }).sha256, base);
  assert.notEqual(fp({ files: ['src/a.mjs'] }).sha256, base);
});

test('Unicode is compared in NFC, so the same text typed two ways is one plan', () => {
  assert.equal(fp({ done_when: 'café works' }).sha256, fp({ done_when: 'café works' }).sha256);
  assert.equal(fp({ files: ['src/café.mjs'] }).sha256, fp({ files: ['src/café.mjs'] }).sha256);
});

test('each input changes the hash', () => {
  const base = planFingerprint(T1).sha256;
  for (const over of [{ product: 'other' }, { card_id: 'C-2' }, { files: ['src/b.mjs'] }, { done_when: 'other' }, { plan_sha256: 'c'.repeat(64) }, { main_commit: 'd'.repeat(40) }]) {
    assert.notEqual(planFingerprint({ ...T1, ...over }).sha256, base, JSON.stringify(over));
  }
  assert.notEqual(planFingerprint({ ...T1, tier: 2 }).sha256, base, 'tier');
  // Tier 2 ignores plan_sha256 and main_commit.
  assert.equal(planFingerprint({ ...T2, plan_sha256: 'c'.repeat(64), main_commit: 'd'.repeat(40) }).sha256, planFingerprint(T2).sha256);
});

test('refused: missing inputs, a folder pattern, odd paths, and Tier 1 without its hashes', () => {
  const bad = [
    [{ product: '' }, /no product/], [{ card_id: undefined }, /no card id/], [{ tier: 3 }, /tier must be 1 or 2/],
    [{ files: [] }, /no file list/], [{ files: 'src/a.mjs' }, /no file list/], [{ done_when: '  ' }, /no done_when/],
    [{ tier: 1 }, /plan_sha256/], [{ tier: 1, plan_sha256: 'a'.repeat(64) }, /main_commit/],
  ];
  for (const p of ['src/*', 'src/?.mjs', 'src/[ab].mjs', 'src/{a,b}.mjs', '/abs/a.mjs', 'src/', '../a.mjs', 'src/../a.mjs', 'src//a.mjs', 'src\\a.mjs', '', 7]) {
    bad.push([{ files: [p] }, /is not one plain path/]);
  }
  for (const [over, pattern] of bad) {
    const r = fp(over);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.match(r.reason, pattern, JSON.stringify(over));
  }
  assert.equal(planFingerprint(undefined).ok, false);
});

test('canonicalJson sorts keys at every level and refuses what JSON can\'t say', () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
  assert.throws(() => canonicalJson(NaN), /finite/);
  assert.throws(() => canonicalJson(undefined), /cannot fingerprint/);
  assert.throws(() => canonicalJson(() => 1), /cannot fingerprint/);
});
