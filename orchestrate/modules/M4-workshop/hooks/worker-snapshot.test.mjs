// L1226 (snapshot wall (ii)): a worker session's hooks read the rules snapshot root's worker-rules job writes
// (setup/worker-rules.mjs), with `--snapshot-owner U`, and take it only when it is U's alone, every folder above it too, as
// the machine-wide copy is (L1031), and fresh, as every role snapshot is. Here the test's own uid stands in for root (the
// worker runner always gives 0). A hook given no --snapshot-owner reads its snapshot as before (the review roles').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, linkSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';
import { makeSnapshot, readHookSnapshot, readSnapshot, SNAPSHOT_MAX_AGE_MS, WORKER_RULES_COPY } from './snapshot.mjs';
import { decide as guard } from './production-write-guard.mjs';
import { decide as secrets } from './secret-file-block.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = process.getuid();
const RULES = { production: { env_files: ['/srv/app/prod-settings.conf'], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: ['/srv/app/key.pem'] } };
const HARMLESS = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/' };
const PROD = { tool_name: 'Bash', tool_input: { command: 'vercel deploy' }, cwd: '/' };

/** The snapshot in a folder of this test's own, 0755, every folder above it root's or ME's and written by no one else. */
function snapAt(body = makeSnapshot(RULES), mode = 0o644) {
  const d = realpathSync(tempDir('orch-ws-')); chmodSync(d, 0o755);
  const f = join(d, 'alpha.json'); writeFileSync(f, body); chmodSync(f, mode);
  return { d, f };
}
const args = (snapshot, owner) => ({ role: 'worker', outbox: '/o', snapshot, ...(owner !== undefined ? { snapshotOwner: owner } : {}), kinds: [], notKinds: [], files: [] });
const refused = (f, owner, re, c) => {
  const r = readHookSnapshot(args(f, owner));
  assert.equal(r.ok, false, c); assert.match(r.reason, re, c);
  for (const d of [guard, secrets]) { const b = d(HARMLESS, args(f, owner)); assert.equal(b.block, true, `${c}: every call is refused`); assert.match(b.reason, re, c); }
};

test('L1226: --snapshot-owner takes a uid, and nothing else', () => {
  const base = ['--role', 'worker', '--outbox', '/o', '--snapshot', '/s/alpha.json'];
  assert.equal(parseArgs([...base, '--snapshot-owner', '0']).snapshotOwner, 0);
  assert.equal(parseArgs([...base, '--snapshot-owner', '502']).snapshotOwner, 502);
  assert.equal(parseArgs(base).snapshotOwner, undefined, 'left out: none, as before');
  for (const bad of ['-1', '01', 'root', '1.5', '0x0', ' 0', '12345678901']) assert.throws(() => parseArgs([...base, '--snapshot-owner', bad]), /bad --snapshot-owner|bad argument/, bad);
});

test('L1226 clean control: root\'s alone and fresh, the hooks decide by its rules', () => {
  const { f } = snapAt();
  assert.equal(readHookSnapshot(args(f, ME)).ok, true);
  assert.deepEqual(guard(HARMLESS, args(f, ME)), { block: false });
  assert.equal(guard(PROD, args(f, ME)).block, true, 'a production command is still refused, by rule');
  assert.deepEqual(secrets(HARMLESS, args(f, ME)), { block: false });
});

test('L1226 plant 1 and 2: a snapshot that is not the owner\'s alone is refused (another owner, group or others able to write); without the flag it reads as before', () => {
  const { f } = snapAt();
  if (ME !== 0) refused(f, 0, /worker sessions' rules snapshot .*is not root's alone/, 'the runner\'s own user owns it (plant 1: it wrote it itself)');
  refused(f, ME + 1, /is not root's alone/, 'someone else owns it');
  for (const mode of [0o664, 0o646]) {
    const g = snapAt(makeSnapshot(RULES), mode).f;
    refused(g, ME, /worker sessions' rules snapshot .*is not root's alone/, `mode ${mode.toString(8)}`);
    assert.equal(readHookSnapshot(args(g)).ok, true, 'no --snapshot-owner: read as before (the review roles\' hooks)');
  }
});

test('L1226 plant 3: a folder above it that others can write, or another user owns, is refused', () => {
  const { d } = snapAt();
  const sub = join(d, 'sub'); mkdirSync(sub); chmodSync(sub, 0o775);
  const f = join(sub, 'alpha.json'); writeFileSync(f, makeSnapshot(RULES)); chmodSync(f, 0o644);
  refused(f, ME, /the folder .*sub above the worker sessions' rules snapshot/, 'a group-writable folder');
  chmodSync(sub, 0o755);
  assert.equal(readHookSnapshot(args(f, ME)).ok, true, 'control: the same folder made root\'s alone again');
  if (ME !== 0) refused(f, ME + 1, /the folder .* above the worker sessions' rules snapshot .*is not root's alone/, 'folders the owner named does not own');
});

test('L1226 plant 4 and 5: a link at its name is not followed, and a second name (a hard link) is refused', () => {
  const { d, f } = snapAt();
  const l = join(d, 'link.json'); symlinkSync(f, l);
  refused(l, ME, /missing or unreadable/, 'a link at the name');
  const h = join(d, 'other.json'); linkSync(f, h);
  refused(f, ME, /2 names/, 'a hard link');
});

test('L1226 plant 6 and 11: older than 5 minutes is refused (exactly 5 passes); more than 60 s ahead is refused', () => {
  const t = Date.parse('2026-11-14T12:00:00Z');
  const { f } = snapAt(makeSnapshot(RULES, new Date(t)));
  const at = (now) => readSnapshot(f, { ownerUid: ME, what: WORKER_RULES_COPY, now });
  assert.equal(at(t + SNAPSHOT_MAX_AGE_MS).ok, true, 'exactly 5 minutes');
  assert.match(at(t + SNAPSHOT_MAX_AGE_MS + 1000).reason, /stale/);
  assert.equal(at(t - 60_000).ok, true, '60 s ahead');
  assert.match(at(t - 61_000).reason, /from the future/);
  // Through the hooks, on the real clock.
  refused(snapAt(makeSnapshot(RULES, new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 1000))).f, ME, /stale/, 'stale, through the hooks');
  refused(snapAt(makeSnapshot(RULES, new Date(Date.now() + 120_000))).f, ME, /from the future/, 'ahead, through the hooks');
});

test('L1226: the real hook scripts, run with --snapshot-owner 0 as a worker session\'s settings run them, refuse a snapshot root does not own', () => {
  const { f } = snapAt();
  for (const h of ['production-write-guard.mjs', 'secret-file-block.mjs']) {
    const run = (owner) => spawnSync(process.execPath, [join(HERE, h), '--role', 'worker', '--outbox', '/o', '--snapshot', f, '--snapshot-owner', owner], { input: JSON.stringify(HARMLESS), encoding: 'utf8' });
    const r = run('0');
    if (ME === 0) assert.equal(r.status, 0, r.stderr);
    else { assert.equal(r.status, 2, `${h}: ${r.stderr}`); assert.match(r.stderr, /worker sessions' rules snapshot .*is not root's alone/, h); }
    assert.equal(run(String(ME)).status, 0, `${h}: control, its owner named`);
  }
});
