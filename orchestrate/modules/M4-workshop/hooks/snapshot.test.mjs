// Lane 2 follow-up (snapshot expiry, lane 3 Minor): a long corpus run outlived the rules snapshot it wrote, and every
// call was then refused, even `ls`, with a reason that didn't say why. The refusal now says what it means, and a run
// that writes its own snapshot can keep it fresh with keepSnapshotFresh. The 5-minute limit itself is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_MAX_AGE_MS, parseSnapshot, readSnapshot, makeSnapshot, writeSnapshot, keepSnapshotFresh, staleReason } from './snapshot.mjs';
import * as prodGuard from './production-write-guard.mjs';
import * as secret from './secret-file-block.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = { production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } };
const writtenAt = (p) => JSON.parse(readFileSync(p, 'utf8')).written_at;

// Timers a test drives by hand: tick() runs the interval body once.
function fakeTimers() {
  const live = new Set();
  return {
    live,
    setInterval: (fn, ms) => { const t = { fn, ms, unref() { this.unrefd = true; } }; live.add(t); return t; },
    clearInterval: (t) => { live.delete(t); },
    tick() { for (const t of [...live]) t.fn(); },
  };
}

test('a stale snapshot is refused with a reason that says what it means and what to do', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const r = parseSnapshot(makeSnapshot(RULES, new Date(now - 312_000)), { now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rules snapshot is stale (312 s old, the limit is 300 s), so every call is refused until it is rewritten; '
    + 'the loop rewrites it every pass, so a stale one means the loop has stopped, or a run that wrote its own snapshot '
    + 'outlasted it (keep it fresh with keepSnapshotFresh)');
  assert.equal(r.reason, staleReason(312_000));
  // The limit is not loosened: one millisecond past it is stale, at it is fresh.
  assert.equal(parseSnapshot(makeSnapshot(RULES, new Date(now - SNAPSHOT_MAX_AGE_MS - 1)), { now }).ok, false);
  assert.equal(parseSnapshot(makeSnapshot(RULES, new Date(now - SNAPSHOT_MAX_AGE_MS)), { now }).ok, true);
});

test('each hook that reads the snapshot passes that reason on, even for ls', () => {
  const d = tempDir('m4-snap-');
  const p = join(d, 'rules.json');
  writeSnapshot(p, RULES, new Date(Date.now() - 400_000));
  const input = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: d };
  for (const [name, hook] of [['production-write-guard', prodGuard], ['secret-file-block', secret]]) {
    const r = hook.decide(input, { role: 'worker', outbox: join(d, 'outbox'), snapshot: p, kinds: ['report'] });
    assert.equal(r.block, true, name);
    assert.match(r.reason, /^rules snapshot is stale \(\d+ s old, the limit is 300 s\), so every call is refused until it is rewritten; .*keepSnapshotFresh\)$/, name);
  }
  // And the same command passes once the snapshot is rewritten.
  writeSnapshot(p, RULES);
  for (const hook of [prodGuard, secret]) assert.equal(hook.decide(input, { role: 'worker', outbox: join(d, 'outbox'), snapshot: p, kinds: ['report'] }).block, false);
});

test('keepSnapshotFresh writes now, rewrites on every tick, and stops when told', () => {
  const d = tempDir('m4-snap-');
  const p = join(d, 'rules.json');
  let at = Date.parse('2026-10-31T12:00:00Z');
  const timers = fakeTimers();
  const k = keepSnapshotFresh(p, RULES, { everyMs: 60_000, clock: () => new Date(at), timers });
  assert.equal(writtenAt(p), '2026-10-31T12:00:00.000Z', 'written at once, not after the first minute');
  assert.equal([...timers.live][0].ms, 60_000);
  assert.equal([...timers.live][0].unrefd, true, 'the timer must not keep the process alive');
  // Ten minutes of ticks: each one rewrites, so the snapshot is still fresh at the end.
  for (let i = 0; i < 10; i++) { at += 60_000; timers.tick(); }
  assert.equal(writtenAt(p), '2026-10-31T12:10:00.000Z');
  assert.equal(readSnapshot(p, { now: at + 1000 }).ok, true);
  assert.deepEqual(readSnapshot(p, { now: at }).rules, RULES);
  k.stop();
  assert.equal(timers.live.size, 0);
  at += 60_000; timers.tick();
  assert.equal(writtenAt(p), '2026-10-31T12:10:00.000Z', 'no rewrite after stop');
  assert.equal(k.error(), null);
  assert.deepEqual(readdirSync(d), ['rules.json'], 'no side files left');
});

test('a rewrite that fails stops the refresher, is kept, and is never thrown from the timer', () => {
  const d = tempDir('m4-snap-');
  const p = join(d, 'rules.json');
  let at = Date.parse('2026-10-31T12:00:00Z');
  const timers = fakeTimers();
  let fail = false;
  const clock = () => { if (fail) throw new Error('disk gone'); return new Date(at); };
  const k = keepSnapshotFresh(p, RULES, { clock, timers });
  fail = true;
  assert.doesNotThrow(() => timers.tick());
  assert.equal(k.error()?.message, 'disk gone');
  assert.equal(timers.live.size, 0, 'stopped after the failure');
  // The snapshot then goes stale and is refused, as it should be.
  assert.equal(readSnapshot(p, { now: at + SNAPSHOT_MAX_AGE_MS + 1 }).ok, false);
});

test('keepSnapshotFresh refuses an interval that could let the snapshot go stale', () => {
  const d = tempDir('m4-snap-');
  for (const everyMs of [0, -1, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_MAX_AGE_MS + 1, Number.NaN, '60000']) {
    assert.throws(() => keepSnapshotFresh(join(d, 'rules.json'), RULES, { everyMs, timers: fakeTimers() }), /everyMs must be a number above 0 and below 300000/, String(everyMs));
  }
  assert.equal(existsSync(join(d, 'rules.json')), false, 'nothing written when refused');
});

test('with real timers it rewrites, and a run that never calls stop still ends on its own', () => {
  const d = tempDir('m4-snap-');
  const p = join(d, 'rules.json');
  // A child that starts a refresher every 50 ms, watches two rewrites, then just returns without stop().
  const script = `
    import { keepSnapshotFresh } from ${JSON.stringify(join(HERE, 'snapshot.mjs'))};
    import { readFileSync } from 'node:fs';
    const p = ${JSON.stringify(p)};
    const seen = new Set();
    keepSnapshotFresh(p, { a: 1 }, { everyMs: 50 });
    const watch = setInterval(() => {
      seen.add(JSON.parse(readFileSync(p, 'utf8')).written_at);
      if (seen.size >= 3) { clearInterval(watch); console.log('rewrites', seen.size); }
    }, 20);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.error, undefined, `the child did not end on its own: ${r.error?.code}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^rewrites [3-9]/);
});
