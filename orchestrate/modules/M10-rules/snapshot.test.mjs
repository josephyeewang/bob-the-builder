// snapshot.test.mjs — the hook-time copy of the rules is refused whenever it can't be trusted (MAT-9, R2-M6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { publishSnapshot, readSnapshot, snapshotAnswer, SNAPSHOT_FILE, MAX_AGE_MS, MAX_FUTURE_MS } from './snapshot.mjs';

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
    ['folder group-writable', (d) => chmodSync(d, 0o775), T],
    ['folder other-writable', (d) => chmodSync(d, 0o777), T],
    ['a link to a good snapshot', (d) => { const real = fresh(); unlinkSync(join(d, SNAPSHOT_FILE)); symlinkSync(join(real, SNAPSHOT_FILE), join(d, SNAPSHOT_FILE)); }, T],
  ];
  for (const [name, spoil, at] of cases) {
    const d = fresh(); spoil(d);
    const r = readSnapshot(d, at);
    assert.equal(r.ok, false, name);
    assert.equal(snapshotAnswer(readSnapshot(d, at), 'write_production', { product: 'sample-app' }).decision, 'deny', name);
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
  assert.match(snapshotAnswer(readSnapshot(d, T), 'start_session', { product: 'sample-app' }).reason, /not answered from the snapshot/);
  assert.equal(snapshotAnswer(readSnapshot(d, T), 'write_production', { product: 'sample-app' }).rev, 'aaaaaaa:bbbbbbb');
  assert.match(snapshotAnswer(readSnapshot(d, T), 'write_production', { product: 'off-app' }).reason, /unusable/);
  assert.match(snapshotAnswer(readSnapshot(d, T), 'write_production', { product: 'nope' }).reason, /unknown product/);
  assert.match(snapshotAnswer(readSnapshot(d, T), 'write_production', { product: '__proto__' }).reason, /unknown product/);
});

test('snapshot_fresh: allow only on a clean, fresh read (R3-m1)', () => {
  const d = fresh();
  assert.equal(snapshotAnswer(readSnapshot(d, T), 'snapshot_fresh').decision, 'allow');
  assert.equal(snapshotAnswer(readSnapshot(d, T), 'snapshot_fresh', { product: 'sample-app' }).decision, 'allow');
  assert.equal(snapshotAnswer(readSnapshot(d, T), 'snapshot_fresh', { product: 'off-app' }).decision, 'deny');
  assert.equal(snapshotAnswer(readSnapshot(d, T + MAX_AGE_MS + 1), 'snapshot_fresh').decision, 'deny');
  assert.equal(snapshotAnswer(undefined, 'snapshot_fresh').decision, 'deny');
});

test('snapshot.mjs imports nothing that can reach the network', () => {
  const src = readFileSync(new URL('./snapshot.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../../shared/rules.mjs', 'node:crypto', 'node:fs', 'node:path']);
  assert.doesNotMatch(src, /fetch\(|node:https?|node:net|node:dgram|import\(/);
});

test('reading the snapshot works with no network at all: fetch throws (MAT-9, audit minor 2)', () => {
  const d = fresh();
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    assert.equal(snapshotAnswer(readSnapshot(d, T), 'snapshot_fresh', { product: 'sample-app' }).decision, 'allow');
  } finally { globalThis.fetch = real; }
});

test('the snapshot answer equals the live answer for every rules status (R2-M6(d), MIN-5)', async () => {
  const { makeEngine } = await import('./engine.mjs');
  const { makeRules } = await import('../../shared/rules.mjs');
  const { parsePolicy } = await import('./policy.mjs');
  const policy = parsePolicy(readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8')).policy;
  const [C, B] = ['c'.repeat(40), 'b'.repeat(40)];
  for (const status of ['ok', 'last_good', 'deny_all']) {
    const live = makeRules(makeEngine({ products: ['sample-app'], productState: () => ({ state: 'active' }), running: () => 0,
      rulesState: () => (status === 'deny_all' ? { status, policy: null } : { status, policy, commit: C, blob: B }),
      rolesDir: new URL('./roles', import.meta.url).pathname, clock: () => T }));
    const d = mkdtempSync(join(tmpdir(), 'm10-snap-'));
    publishSnapshot(d, { products: { 'sample-app': status === 'deny_all' ? { status, rules: null, rev: null } : { status, rules: policy, rev: 'x' } } }, T);
    const hook = snapshotAnswer(readSnapshot(d, T), 'write_production', { product: 'sample-app' });
    assert.equal(hook.decision, live.may('write_production', { product: 'sample-app' }).decision, status);
  }
});

test('a folder or file owned by another user is refused (audit round 2)', () => {
  const d = fresh();
  const real = process.getuid;
  try {
    process.getuid = () => real() + 1;          // as if the folder had been made by another user
    assert.match(readSnapshot(d, T).reason, /folder owned by someone else/);
    let calls = 0;                              // the folder is ours; the file inside is someone else's
    process.getuid = () => (++calls === 1 ? real() : real() + 1);
    assert.equal(readSnapshot(d, T).reason, 'snapshot owned by someone else');
  } finally { process.getuid = real; }
  assert.equal(readSnapshot(d, T).ok, true);
});

test('a named pipe planted at the snapshot path is refused at once, not waited on (audit round 2)', () => {
  const d = fresh();
  unlinkSync(join(d, SNAPSHOT_FILE));
  execFileSync('mkfifo', [join(d, SNAPSHOT_FILE)]);
  // In a child process with a time limit, so a read that waits on the pipe fails this test instead of hanging the run.
  const mod = new URL('./snapshot.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { readSnapshot } from ${JSON.stringify(mod)}; console.log(JSON.stringify(readSnapshot(${JSON.stringify(d)}, ${T})));`],
    { timeout: 5000, encoding: 'utf8' });
  assert.equal(JSON.parse(out).ok, false);
});
