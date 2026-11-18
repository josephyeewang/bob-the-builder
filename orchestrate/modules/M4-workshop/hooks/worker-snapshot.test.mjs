// L1226 (snapshot wall (ii)): a worker session's hooks read the rules snapshot root's worker-rules job writes
// (setup/worker-rules.mjs), with `--snapshot-owner U`, and take it only when it is U's alone, every folder above it too, as
// the machine-wide copy is (L1031), and fresh, as every role snapshot is. Here the test's own uid stands in for root (the
// worker runner always gives 0). A hook given no --snapshot-owner reads its snapshot as before (the review roles').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, mkdirSync, chmodSync, linkSync, symlinkSync, realpathSync, lstatSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';
import { makeSnapshot, readHookSnapshot, readSnapshot, rootChainProblem, SNAPSHOT_MAX_AGE_MS, WORKER_RULES_COPY } from './snapshot.mjs';
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

// #610 r1 M1: the file's own owner check, alone. A wrong-owner plant in a test's own folders is refused by the folder check
// first, so here the file is a real one of root's (one name, 0644) in folders root owns all the way up, read with this
// test's uid as the owner named: only the file's owner is wrong. Picked when the test runs; skipped if none qualifies.
const ROOT_FILE = (() => {
  if (ME === 0) return null;
  for (const p of ['/private/etc/shells', '/private/etc/protocols', '/private/etc/services', '/private/etc/networks', '/private/etc/rpc']) {
    try {
      const st = lstatSync(p);
      if (st.isFile() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022) && rootChainProblem(p, 0) === null) return p;
    } catch { /* not on this Mac */ }
  }
  return null;
})();
test('#610 r1 M1: a file root owns, in folders root owns, read with another owner named, is refused by the FILE check (worker and machine-wide)', { skip: !ROOT_FILE && 'no root-owned, one-name, 0644 file in a root-only chain here (or running as root)' }, () => {
  const fileMsg = (what) => new RegExp(`^${what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not root's alone \\(it must be owned by uid ${ME}, standing in for root,`);
  assert.equal(rootChainProblem(ROOT_FILE, ME), null, 'the folders pass, so only the file check can refuse');
  const w = readHookSnapshot(args(ROOT_FILE, ME));
  assert.equal(w.ok, false); assert.match(w.reason, fileMsg(WORKER_RULES_COPY)); assert.doesNotMatch(w.reason, /the folder/);
  const m = readSnapshot(ROOT_FILE, { ownerUid: ME });
  assert.equal(m.ok, false); assert.match(m.reason, fileMsg('the machine-wide rules copy')); assert.doesNotMatch(m.reason, /the folder/);
  // Control: named as root's, the same file passes both checks and is refused only as not a snapshot.
  assert.match(readSnapshot(ROOT_FILE, { ownerUid: 0 }).reason, /not JSON/);
});

test('#610 r1 m3: the path as written is checked too: a link reached through a folder others can write is refused, though its real folder is root\'s alone', () => {
  const { d, f } = snapAt();
  const open = join(d, 'open'); mkdirSync(open); chmodSync(open, 0o775);
  const via = join(open, 'to'); symlinkSync(d, via);
  const p = join(via, 'alpha.json');
  assert.equal(realpathSync(dirname(p)), d, 'its real folder is the good one');
  // Since r2 m1 the walk meets the link first (it is nearer the file than the open folder) and refuses it as not the Mac's own.
  refused(p, ME, /the link .*open\/to on the way to the worker sessions' rules snapshot .*is not one of the Mac's own/, 'a link inside a group-writable folder');
  for (const bad of ['alpha.json', `${d}//alpha.json`, `${d}/./alpha.json`, `${d}/x/../alpha.json`]) assert.match(rootChainProblem(bad, ME), /not a full path in its simplest form/, bad);
  assert.equal(readHookSnapshot(args(f, ME)).ok, true, 'control: the plain path');
});

// #610 r2 m2: the link's own refusal, alone: a link whose every folder passes is refused by the LINK check, word for word.
const linkMsg = (dir) => `the link ${dir} on the way to ${WORKER_RULES_COPY} is not one of the Mac's own (/var, /tmp or /etc, root's, into /private); name the file by its real folders`;
test('#610 r2 m2: a link that is not the Mac\'s own, in folders that all pass, is refused by the link check (its exact words)', () => {
  const { d } = snapAt();
  const via = join(d, 'to'); symlinkSync(d, via);
  const p = join(via, 'alpha.json');
  assert.equal(realpathSync(dirname(p)), d, 'its real folder is the good one');
  const r = readHookSnapshot(args(p, ME)); assert.equal(r.ok, false); assert.equal(r.reason, linkMsg(via));
  for (const dec of [guard, secrets]) assert.equal(dec(HARMLESS, args(p, ME)).reason, linkMsg(via), 'through the hooks, every call refused');
});

test('#610 r2 m1: a chain of two links (g/link → open/l2 → the good folder) is refused at the first link; the Mac\'s own /var link passes', () => {
  const { d, f } = snapAt();
  const g = join(d, 'g'); mkdirSync(g); chmodSync(g, 0o755);
  const open = join(d, 'open'); mkdirSync(open); chmodSync(open, 0o777);
  const l2 = join(open, 'l2'); symlinkSync(d, l2);
  const link = join(g, 'link'); symlinkSync(l2, link);
  const p = join(link, 'alpha.json');
  assert.equal(realpathSync(dirname(p)), d, 'its real folder is the good one, through two links');
  assert.equal(rootChainProblem(p, ME, WORKER_RULES_COPY), linkMsg(link));
  assert.equal(readHookSnapshot(args(p, ME)).reason, linkMsg(link));
  chmodSync(open, 0o755);
  assert.equal(readHookSnapshot(args(p, ME)).reason, linkMsg(link), 'still refused with every folder made root\'s alone: no link but the Mac\'s own');
  // The Mac's own link: the same file named through /var (root's, into /private/var) passes, and the plain path too.
  if (f.startsWith('/private/var/')) assert.equal(readHookSnapshot(args(f.slice('/private'.length), ME)).ok, true, 'control: through /var');
  assert.equal(readHookSnapshot(args(f, ME)).ok, true, 'control: the plain path');
});

test('#610 r2 m3: the file read is the one opened and checked: replaced at its name after the open, the opened one\'s rules are what come back', () => {
  const { d, f } = snapAt();
  const OTHER = { ...RULES, production: { ...RULES.production, programs: ['other'] } };
  const real = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (...a) {
    if (!swapped) { swapped = true; renameSync(f, join(d, 'away.json')); writeFileSync(f, makeSnapshot(OTHER)); chmodSync(f, 0o644); }
    return real.apply(this, a);
  };
  syncBuiltinESMExports();
  try {
    const r = readHookSnapshot(args(f, ME));
    assert.equal(swapped, true, 'the swap ran between the open and the read');
    assert.equal(r.ok, true, r.reason); assert.deepEqual(r.rules, RULES, 'the rules of the file opened, not of the one now at its name');
  } finally { fs.readFileSync = real; syncBuiltinESMExports(); }
  assert.deepEqual(readHookSnapshot(args(f, ME)).rules, OTHER, 'control: read again, the new file at the name is the one read');
});

test('#610 r1 m1 and m4: a key given twice, or one not lower case with dashes, is refused', () => {
  const base = ['--role', 'worker', '--outbox', '/o', '--snapshot', '/s/alpha.json'];
  assert.throws(() => parseArgs([...base, '--snapshot-owner', '0', '--snapshot-owner', '501']), /--snapshot-owner given twice/);
  assert.throws(() => parseArgs([...base, '--snapshot', '/s/other.json']), /--snapshot given twice/);
  for (const k of ['--snapshotOwner', '--notKinds', '--__proto__', '--Role', '---x']) assert.throws(() => parseArgs([...base, k, '501']), /bad argument/, k);
  assert.equal(parseArgs([...base, '--snapshot-owner', '0']).snapshotOwner, 0, 'control: once');
});
