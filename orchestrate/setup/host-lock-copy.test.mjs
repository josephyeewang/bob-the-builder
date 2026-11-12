// Tests for the owner's host.lock copier (L757 fallback, L1029 E): one run copies the synced host.lock to the copy the
// Dispatcher reads, or removes the copy when the synced file is gone, and stamps the run; a run that can't read the synced
// file writes nothing; the stamp's age is what check-dispatcher judges. Real files in a temp folder, as this user.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPY_AHEAD_MS, COPY_MAX_AGE_MS, copierPlist, copyHostLock, stampPath, stampProblem } from './host-lock-copy.mjs';
import { parseConfig } from './layout.mjs';
import { HOST_LOCK_MAX } from '../wiring/worker-ports.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

const T0 = Date.parse('2026-11-12T10:00:00Z');
function world() {
  const d = tempDir('orch-hlcopy-');
  const sync = join(d, 'Sync'); const local = join(d, 'local');
  mkdirSync(sync); mkdirSync(local); chmodSync(local, 0o755);
  const from = join(sync, 'host.lock'); const to = join(local, 'host.lock');
  return { d, from, to, run: (o = {}) => copyHostLock({ from, to, now: T0, ...o }) };
}
const stamp = (to) => JSON.parse(readFileSync(stampPath(to), 'utf8'));

test('L1029 E: the copy is the synced text, 0644, and each run stamps when it ran and that the source was there', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\nclaimed_at=2026-11-12T08:00:00Z\n');
  assert.deepEqual(w.run(), { ok: true, did: 'copied' });
  assert.equal(readFileSync(w.to, 'utf8'), 'host=mini\nclaimed_at=2026-11-12T08:00:00Z\n');
  assert.equal(statSync(w.to).mode & 0o777, 0o644, 'orchestrate reads it');
  assert.equal(statSync(stampPath(w.to)).mode & 0o777, 0o644);
  assert.deepEqual(stamp(w.to), { at: new Date(T0).toISOString(), source: 'present' });
  // Unchanged: the copy is left alone, the stamp moves on.
  const ino = statSync(w.to).ino;
  assert.deepEqual(w.run({ now: T0 + 60_000 }), { ok: true, did: 'same' });
  assert.equal(statSync(w.to).ino, ino, 'not rewritten');
  assert.equal(stamp(w.to).at, new Date(T0 + 60_000).toISOString());
  // A change is copied whole.
  writeFileSync(w.from, 'host=air\n');
  assert.deepEqual(w.run(), { ok: true, did: 'copied' });
  assert.equal(readFileSync(w.to, 'utf8'), 'host=air\n');
  // A copy someone made writable (or replaced) is written again, not taken as current.
  chmodSync(w.to, 0o666);
  assert.deepEqual(w.run(), { ok: true, did: 'copied' });
  assert.equal(statSync(w.to).mode & 0o777, 0o644);
  // No leftovers beside it.
  assert.deepEqual(fs.readdirSync(join(w.d, 'local')).sort(), ['host.lock', 'host.lock.copied']);
});

test('L1029 E: a synced host.lock that is gone removes the copy (no host claimed), and is stamped absent', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\n'); w.run();
  fs.unlinkSync(w.from);
  assert.deepEqual(w.run({ now: T0 + 1 }), { ok: true, did: 'removed' });
  assert.equal(existsSync(w.to), false);
  assert.deepEqual(stamp(w.to), { at: new Date(T0 + 1).toISOString(), source: 'absent' });
  assert.deepEqual(w.run(), { ok: true, did: 'none' });
});

test('L1029 E: a synced host.lock that can\'t be read as the Dispatcher would writes nothing: the copy stays, the stamp ages', () => {
  const cases = [
    ['its folder is gone (a wrong path, never "no host")', (w) => fs.rmSync(join(w.d, 'Sync'), { recursive: true }), /folder .* can't be read \(ENOENT\)/],
    ['a link', (w) => { fs.unlinkSync(w.from); writeFileSync(join(w.d, 'other'), 'host=x\n'); symlinkSync(join(w.d, 'other'), w.from); }, /is a link/],
    ['a hard link', (w) => linkSync(w.from, join(w.d, 'second')), /another name too/],
    ['too big', (w) => writeFileSync(w.from, 'x'.repeat(HOST_LOCK_MAX + 1)), new RegExp(`over ${HOST_LOCK_MAX} bytes`)],
    ['a folder', (w) => { fs.unlinkSync(w.from); mkdirSync(w.from); }, /not a plain file/],
  ];
  for (const [name, spoil, why] of cases) {
    const w = world();
    writeFileSync(w.from, 'host=mini\n'); w.run();
    const before = [readFileSync(w.to, 'utf8'), readFileSync(stampPath(w.to), 'utf8')];
    spoil(w);
    const r = w.run({ now: T0 + 60_000 });
    assert.equal(r.ok, false, name); assert.match(r.why, why, name);
    assert.deepEqual([readFileSync(w.to, 'utf8'), readFileSync(stampPath(w.to), 'utf8')], before, `${name}: nothing written`);
  }
});

test('L1029 E: macOS refusing the read (privacy protection) is told with the way out, and writes nothing', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\n'); w.run();
  const before = readFileSync(stampPath(w.to), 'utf8');
  const denied = { ...fs, openSync: (p, ...a) => { if (p === w.from) throw Object.assign(new Error('nope'), { code: 'EPERM' }); return fs.openSync(p, ...a); } };
  const r = w.run({ fs: denied, now: T0 + 60_000 });
  assert.equal(r.ok, false);
  assert.match(r.why, /can't be read \(EPERM\): if it is macOS's privacy protection, give this job's node Full Disk Access/);
  assert.equal(readFileSync(stampPath(w.to), 'utf8'), before);
  assert.equal(readFileSync(w.to, 'utf8'), 'host=mini\n');
});

test('L1029 E: the synced file must be this user\'s, and the copy\'s folder this user\'s plain folder only they can write', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\n');
  // The synced file another user's (only it: the copy's folder stays this user's).
  const srcFd = new Set();
  const other = { ...fs, openSync: (p, ...x) => { const fd = fs.openSync(p, ...x); if (p === w.from) srcFd.add(fd); return fd; },
    fstatSync: (fd, ...x) => { const st = fs.fstatSync(fd, ...x); if (srcFd.has(fd)) Object.defineProperty(st, 'uid', { value: st.uid + 1 }); return st; } };
  const r = w.run({ fs: other });
  assert.equal(r.ok, false); assert.match(r.why, /the synced host\.lock .* is not this user's file \(its owner is uid \d+\)/);
  assert.equal(existsSync(w.to), false); assert.equal(existsSync(stampPath(w.to)), false);
  // The copy's folder another user's.
  assert.match(w.run({ uid: process.getuid() + 1 }).why, /the copy's folder .* is not this user's/);
  assert.equal(existsSync(w.to), false); assert.equal(existsSync(stampPath(w.to)), false);
  chmodSync(join(w.d, 'local'), 0o775);
  assert.match(w.run().why, /can be written by its group or others/);
  chmodSync(join(w.d, 'local'), 0o755);
  const l = join(w.d, 'linked'); symlinkSync(join(w.d, 'local'), l);
  assert.match(copyHostLock({ from: w.from, to: join(l, 'host.lock'), now: T0 }).why, /is not a plain folder/);
  assert.match(copyHostLock({ from: w.from, to: join(w.d, 'none', 'host.lock'), now: T0 }).why, /make it first/);
  assert.match(copyHostLock({ from: w.from, to: w.from, now: T0 }).why, /two different full paths/);
  assert.equal(existsSync(w.to), false);
});

test('L1029 E: a .new left by a cut-off run is replaced, not refused', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\n');
  writeFileSync(join(w.d, 'local', '.host.lock.new'), 'half');
  writeFileSync(join(w.d, 'local', '.host.lock.copied.new'), 'half');
  assert.deepEqual(w.run(), { ok: true, did: 'copied' });
  assert.equal(readFileSync(w.to, 'utf8'), 'host=mini\n');
  assert.deepEqual(fs.readdirSync(join(w.d, 'local')).sort(), ['host.lock', 'host.lock.copied']);
});

test('L1029 E: the stamp is fresh only within COPY_MAX_AGE_MS, never ahead of the clock, and only the owner\'s', () => {
  const w = world();
  writeFileSync(w.from, 'host=mini\n'); w.run();
  const io = { lstat: lstatSync, readText: (p) => readFileSync(p, 'utf8') };
  const me = process.getuid();
  assert.equal(stampProblem(io, w.to, { now: T0, ownerUid: me }), null);
  assert.equal(stampProblem(io, w.to, { now: T0 + COPY_MAX_AGE_MS, ownerUid: me }), null, 'at the bound');
  assert.match(stampProblem(io, w.to, { now: T0 + COPY_MAX_AGE_MS + 1, ownerUid: me }), /last good run was at 2026-11-12T10:00:00\.000Z, over 5 minutes ago.*host-lock-copy\.err\.log/);
  assert.equal(stampProblem(io, w.to, { now: T0 - COPY_AHEAD_MS, ownerUid: me }), null);
  assert.match(stampProblem(io, w.to, { now: T0 - COPY_AHEAD_MS - 1, ownerUid: me }), /ahead of this Mac's clock/);
  assert.match(stampProblem(io, w.to, { now: T0, ownerUid: me + 1 }), /is not the owner's/);
  writeFileSync(stampPath(w.to), 'garbage');
  assert.match(stampProblem(io, w.to, { now: T0, ownerUid: me }), /can't be read as the copier's stamp/);
  fs.unlinkSync(stampPath(w.to));
  assert.match(stampProblem(io, w.to, { now: T0, ownerUid: me }), /has never finished a run/);
});

test('L1029 E: the copier\'s job is the owner\'s own (no UserName), from the installed copy, with the setup config, logging beside the copy', () => {
  const text = copierPlist({ label: 'com.example.orch', installRoot: '/Library/o/install/orchestrate', node: 'bin/node', configPath: '/Library/orchestrate-setup.json', copy: '/Users/sam/.orchestrate/host.lock', home: '/Users/sam' });
  assert.match(text, /<key>Label<\/key><string>com\.example\.orch\.host-lock-copy<\/string>/);
  assert.match(text, /<array><string>\/Library\/o\/install\/orchestrate\/bin\/node<\/string><string>\/Library\/o\/install\/orchestrate\/setup\/host-lock-copy\.mjs<\/string><string>\/Library\/orchestrate-setup\.json<\/string><\/array>/);
  assert.doesNotMatch(text, /UserName/);
  assert.match(text, /\/Users\/sam\/\.orchestrate\/host-lock-copy\.err\.log/);
  assert.match(text, /<key>Umask<\/key><integer>18<\/integer>/);
});

test('L1029 E: the config takes hostLockSource only with hostLockPath, as a different file in the owner\'s home', () => {
  const raw = { base: '/Library/orch-test', owner: 'sam', products: ['alpha'], hostLockPath: '/Users/sam/.orchestrate/host.lock' };
  assert.equal(parseConfig({ ...raw, hostLockSource: '/Users/sam/Dropbox/99.0 Claude Sync/host.lock' }).hostLockSource, '/Users/sam/Dropbox/99.0 Claude Sync/host.lock');
  assert.equal(Object.hasOwn(parseConfig(raw), 'hostLockSource'), false);
  assert.throws(() => parseConfig({ ...raw, hostLockPath: undefined, hostLockSource: '/Users/sam/Dropbox/host.lock' }), /hostLockSource needs hostLockPath/);
  assert.throws(() => parseConfig({ ...raw, hostLockSource: '/Users/sam/.orchestrate/HOST.lock' }), /two different files/);
  for (const bad of ['/Users/other/host.lock', '/Users/sam/../x/host.lock', '/Users/sam/d/', 'rel/host.lock', 7]) assert.throws(() => parseConfig({ ...raw, hostLockSource: bad }), /hostLockSource must be the full path/, String(bad));
});
