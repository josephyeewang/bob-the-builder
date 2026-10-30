// snapshot.test.mjs — the hook-time copy of the rules is refused whenever it can't be trusted (MAT-9, R2-M6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishSnapshot, readSnapshot, askSnapshot, SNAPSHOT_FILE, MAX_AGE_MS, MAX_FUTURE_MS } from './snapshot.mjs';

const T = Date.parse('2026-10-29T12:00:00Z');
const body = () => ({ products: { 'sample-app': { status: 'ok', rules: { caps: { editing_per_mac: 5 } }, rev: 'aaaaaaa:bbbbbbb' },
  'off-app': { status: 'deny_all', rules: null, rev: null } }, mac: { editing_per_mac: 5 }, pin_ok: true });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'm10-snap-')); publishSnapshot(d, body(), T); return d; };

test('a fresh snapshot reads back exactly, mode 644', () => {
  const d = fresh();
  const r = readSnapshot(d, T + 1000);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.body, body());
  assert.equal(statSync(join(d, SNAPSHOT_FILE)).mode & 0o777, 0o644);
});

test('missing, unreadable, wrong format, damaged, stale, future or loosely-permissioned → refused', () => {
  const cases = [
    ['missing', (d) => unlinkSync(join(d, SNAPSHOT_FILE)), T],
    ['unreadable', (d) => writeFileSync(join(d, SNAPSHOT_FILE), '{nope', { mode: 0o644 }), T],
    ['format', (d) => edit(d, (x) => { x.format = 2; }), T],
    ['damaged', (d) => edit(d, (x) => { x.body.products['sample-app'].rules.caps.editing_per_mac = 50; }), T],
    ['stale', () => {}, T + MAX_AGE_MS + 1],
    ['future', () => {}, T - MAX_FUTURE_MS - 1],
    ['group-writable', (d) => chmodSync(join(d, SNAPSHOT_FILE), 0o664), T],
    ['other-writable', (d) => chmodSync(join(d, SNAPSHOT_FILE), 0o646), T],
  ];
  for (const [name, spoil, at] of cases) {
    const d = fresh(); spoil(d);
    const r = readSnapshot(d, at);
    assert.equal(r.ok, false, name);
    assert.equal(askSnapshot(d, at, 'write_production', { product: 'sample-app' }).decision, 'deny', name);
  }
});
function edit(d, fn) { const f = join(d, SNAPSHOT_FILE); const x = JSON.parse(readFileSync(f, 'utf8')); fn(x); writeFileSync(f, JSON.stringify(x), { mode: 0o644 }); }

test('a deny_all product carries no rules, and anything else must carry rules and a version', () => {
  const d = mkdtempSync(join(tmpdir(), 'm10-snap-'));
  assert.throws(() => publishSnapshot(d, { products: { a: { status: 'deny_all', rules: {}, rev: null } } }, T));
  assert.throws(() => publishSnapshot(d, { products: { a: { status: 'ok', rules: null, rev: 'x' } } }, T));
  assert.throws(() => publishSnapshot(d, { products: { a: { status: 'maybe', rules: {}, rev: 'x' } } }, T));
});

test('the snapshot answers hook-time questions only; in 0b every production write is denied', () => {
  const d = fresh();
  assert.match(askSnapshot(d, T, 'start_session', { product: 'sample-app' }).reason, /not answered from the snapshot/);
  assert.equal(askSnapshot(d, T, 'write_production', { product: 'sample-app' }).rev, 'aaaaaaa:bbbbbbb');
  assert.match(askSnapshot(d, T, 'write_production', { product: 'off-app' }).reason, /unusable/);
  assert.match(askSnapshot(d, T, 'write_production', { product: 'nope' }).reason, /unknown product/);
});

test('snapshot.mjs imports nothing that can reach the network', () => {
  const src = readFileSync(new URL('./snapshot.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../../shared/rules.mjs', 'node:crypto', 'node:fs', 'node:path']);
  assert.doesNotMatch(src, /fetch\(|node:https?|node:net|node:dgram|import\(/);
});
