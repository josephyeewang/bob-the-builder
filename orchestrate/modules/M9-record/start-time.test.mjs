// start-time.test.mjs — the one start-time reader (L830) and a lock's machine (L826, #364 r1 m5).
//
// A start time is read by ps in UTC and the C locale and recorded as one ISO shape, so the Mac's time zone or language
// never makes a live process look reused. A value recorded the old way (local lstart) can't be compared and never reads
// as reused. A lock is this machine's when its host name or its machine id matches, so a renamed Mac can break a dead
// holder's lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { START_ISO, START_PS_MS, holderDead, ownPidStart, lstartIso, makeLock, onThisMachine, pidStart, processDead, readMachineId, realProbe, sleepMs, startDiffers, startTime } from './lock.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const LOCK = fileURLToPath(new URL('./lock.mjs', import.meta.url));

function liveChild() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !pidStart(c.pid); i++) sleepMs(20);
  return c;
}
async function deadPid() {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((res) => c.on('exit', res));
  return c.pid;
}
// Read a pid's start time, and whether processDead calls it dead, from a fresh node run under the given time zone and language.
function readUnder(env, pid, recorded) {
  const code = `import { pidStart, processDead } from ${JSON.stringify(LOCK)};\nprocess.stdout.write(JSON.stringify({ s: pidStart(${pid}), dead: processDead({ pid: ${pid}, pid_start: ${JSON.stringify(recorded)} }) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('L830: lstartIso reads the C-locale lstart as UTC, space-padded days included, and nothing else', () => {
  assert.equal(lstartIso('Tue Nov 10 10:16:00 2026'), '2026-11-10T10:16:00Z');
  assert.equal(lstartIso('Tue Nov  3 01:02:03 2026\n'), '2026-11-03T01:02:03Z');
  for (const bad of ['', null, 'Mon Feb 30 01:02:03 2026', 'mar. 10 nov. 10:16:00 2026', 'Tue Nov 10 25:16:00 2026', '2026-11-10T10:16:00Z', 'start']) assert.equal(lstartIso(bad), null, String(bad));
});

test('L830: startTime runs ps in UTC and the C locale with a time cap, and gives the ISO shape or null', () => {
  const seen = [];
  const run = (cmd, args, opts) => { seen.push({ cmd, args, opts }); return 'Tue Nov 10 10:16:00 2026\n'; };
  assert.equal(startTime(4242, { run }), '2026-11-10T10:16:00Z');
  assert.deepEqual(seen[0].args, ['-o', 'lstart=', '-p', '4242']);
  assert.equal(seen[0].opts.env.TZ, 'UTC0');
  assert.equal(seen[0].opts.env.LC_ALL, 'C');
  assert.equal(seen[0].opts.timeout, START_PS_MS);
  assert.equal(startTime(4242, { run, timeoutMs: 1000 }), '2026-11-10T10:16:00Z');
  assert.equal(seen[1].opts.timeout, 1000, 'a caller may cap it lower (the runner)');
  assert.equal(startTime(4242, { run: () => { throw new Error('timed out'); } }), null);
  assert.equal(startTime(4242, { run: () => 'jeu.  1 oct. 11:00:00 2026' }), null, 'an answer not in the C form is no answer');
  for (const pid of [0, -1, 1.5, '42', null]) assert.equal(startTime(pid, { run }), null);
});

test('L830: a real child reads the same start time under every time zone and language, and stays alive to processDead', () => {
  const kid = liveChild();
  try {
    const mine = pidStart(kid.pid);
    assert.match(mine, START_ISO);
    for (const env of [{ TZ: 'UTC' }, { TZ: 'Asia/Seoul' }, { TZ: 'America/Los_Angeles', LC_ALL: 'fr_FR.UTF-8' }, { TZ: 'Pacific/Kiritimati', LANG: 'ko_KR.UTF-8' }, { TZ: 'Asia/Kathmandu', LC_ALL: 'de_DE.UTF-8' }]) {
      const r = readUnder(env, kid.pid, mine);
      assert.equal(r.s, mine, `the same start time under ${JSON.stringify(env)}`);
      assert.equal(r.dead, false, `alive under ${JSON.stringify(env)}`);
    }
    assert.equal(processDead({ pid: kid.pid, pid_start: '2020-01-01T00:00:00Z' }), true, 'a different ISO start time is a reused pid');
  } finally { kid.kill('SIGKILL'); }
});

test('L830: a lock or claim recorded the old way (local lstart) is never read as reused; a gone process is still dead', async () => {
  const kid = liveChild();
  try {
    const local = spawnSync('ps', ['-o', 'lstart=', '-p', String(kid.pid)], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', TZ: 'Asia/Seoul' } }).stdout.trim();
    assert.ok(local, 'ps gave the old local form');
    assert.equal(processDead({ pid: kid.pid, pid_start: local }), false, 'the old form, written in another time zone, is alive');
    assert.equal(processDead({ pid: kid.pid, pid_start: 'Thu Oct  1 11:00:00 2026' }), false, 'an old value that differs is "can\'t tell", so alive');
    assert.equal(processDead({ pid: kid.pid, pid_start: 'jeu.  1 oct. 11:00:00 2026' }), false, 'another language: alive');
    let reads = 0;
    assert.equal(processDead({ pid: kid.pid, pid_start: local }, { kill: () => {}, pidStart: () => { reads += 1; return '2020-01-01T00:00:00Z'; } }), false);
    assert.equal(reads, 0, 'an old value is never compared, so no ps is run for it (a busy Mac is spared the call)');
    const dir = tempDir('m9-start-');
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: kid.pid, pid_start: local, host: 'mac-a', nonce: 'n-old', at: 'x' }));
    assert.throws(() => makeLock({ dir, host: 'mac-a', machine: null, timeoutMs: 50 }).acquire(), /store busy/, 'an old-form lock of a live holder is kept');
  } finally { kid.kill('SIGKILL'); }
  const gone = await deadPid();
  assert.equal(processDead({ pid: gone, pid_start: 'Thu Oct  1 11:00:00 2026' }), true, 'ESRCH needs no start time');
});

test('L830: a claim the runner records through this reader is alive to processDead; the runner\'s raw UTC ps text (until it imports startTime) is "can\'t tell"', () => {
  const kid = liveChild();
  try {
    // The runner records through this reader (lane 4's leaderStart imports startTime with its own cap).
    const claim = { pid: kid.pid, pid_start: startTime(kid.pid, { timeoutMs: 1000 }) };
    assert.match(claim.pid_start, START_ISO);
    assert.equal(processDead(claim), false);
    assert.equal(processDead(claim, realProbe), false);
    assert.equal(processDead({ ...claim, pid_start: '2026-01-01T00:00:00Z' }), true, 'its pid with another start time is reused');
    // A reader that answers in any other shape (the runner's raw UTC ps text today, a stand-in) can't be compared: alive.
    const raw = spawnSync('ps', ['-o', 'lstart=', '-p', String(kid.pid)], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' } }).stdout.trim();
    assert.equal(processDead({ pid: kid.pid, pid_start: raw }), false, 'a claim holding the raw UTC text reads alive');
    for (const other of [raw, 'start', ' ']) {
      assert.equal(processDead(claim, { kill: realProbe.kill, pidStart: () => other }), false, `a "${other}" answer is no comparison`);
    }
  } finally { kid.kill('SIGKILL'); }
});

test('L826 (#364 r1 m5): a dead holder\'s lock is broken after a host name change when its machine id matches', async () => {
  const gone = await deadPid();
  const dir = tempDir('m9-start-');
  writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: gone, pid_start: '2026-10-01T11:00:00Z', host: 'old-name', machine: 'M-1', nonce: 'n1', at: 'x' }));
  const got = makeLock({ dir, host: 'new-name', machine: 'M-1', timeoutMs: 200 }).acquire();
  assert.equal(got.broke, true, 'same machine, new host name: broken');
  // Another machine (its id differs) and another host name: never broken from here, however dead it looks.
  const dir2 = tempDir('m9-start-');
  writeFileSync(join(dir2, 'lock'), JSON.stringify({ pid: gone, pid_start: '2026-10-01T11:00:00Z', host: 'mac-b', machine: 'M-2', nonce: 'n2', at: 'x' }));
  assert.throws(() => makeLock({ dir: dir2, host: 'new-name', machine: 'M-1', timeoutMs: 50 }).acquire(), /store busy/);
  // A lock written before L826 (no machine id) keeps the host name test.
  const dir3 = tempDir('m9-start-');
  writeFileSync(join(dir3, 'lock'), JSON.stringify({ pid: gone, pid_start: '2026-10-01T11:00:00Z', host: 'old-name', nonce: 'n3', at: 'x' }));
  assert.throws(() => makeLock({ dir: dir3, host: 'new-name', machine: 'M-1', timeoutMs: 50 }).acquire(), /store busy/);
  assert.equal(makeLock({ dir: dir3, host: 'old-name', machine: 'M-1', timeoutMs: 200 }).acquire().broke, true);
});

test('L826: onThisMachine and holderDead: host or machine id; an empty or missing id never matches', async () => {
  assert.equal(onThisMachine({ host: 'a' }, { host: 'a', machine: null }), true);
  assert.equal(onThisMachine({ host: 'a', machine: 'M' }, { host: 'b', machine: 'M' }), true);
  assert.equal(onThisMachine({ host: 'a', machine: 'M' }, { host: 'b', machine: 'N' }), false);
  assert.equal(onThisMachine({ host: 'a', machine: '' }, { host: 'b', machine: '' }), false);
  assert.equal(onThisMachine({ host: 'a' }, { host: 'b', machine: null }), false);
  const gone = await deadPid();
  assert.equal(holderDead({ pid: gone, host: 'old', machine: 'M' }, { host: 'new', machine: 'M' }), true);
  assert.equal(holderDead({ unreadable: true }, { host: 'new', machine: 'M' }), false);
});

test('L826: a lock records this machine\'s id; the id comes from ioreg only, else none', () => {
  const dir = tempDir('m9-start-');
  const l = makeLock({ dir, host: 'h', machine: 'M-9' });
  const got = l.acquire();
  const h = JSON.parse(spawnSync('cat', [join(dir, 'lock')], { encoding: 'utf8' }).stdout);
  assert.equal(h.machine, 'M-9');
  assert.match(h.pid_start, START_ISO, 'the lock records the one start-time shape');
  l.release(got.nonce);
  assert.equal(existsSync(join(dir, 'lock')), false);
  const l2 = makeLock({ dir, host: 'h', machine: null });
  l2.acquire();
  assert.equal('machine' in JSON.parse(spawnSync('cat', [join(dir, 'lock')], { encoding: 'utf8' }).stdout), false, 'no id read: none written');
  const uuid = '01234567-89AB-CDEF-0123-456789ABCDEF';
  assert.equal(readMachineId({ run: () => `  "IOPlatformUUID" = "${uuid}"\n` }), uuid);
  // Only the Mac's hardware id: no ioreg, no id (a Linux machine-id can be shared by clones), so the host name alone.
  assert.equal(readMachineId({ run: () => { throw new Error('no ioreg'); } }), null);
  assert.equal(readMachineId({ run: () => 'nothing' }), null);
});

test('L830: startDiffers is the one comparison: both in the one shape and different, else false', () => {
  const a = '2026-11-10T10:16:00Z'; const b = '2026-11-10T10:16:01Z';
  assert.equal(startDiffers(a, b), true);
  assert.equal(startDiffers(a, a), false);
  for (const [r, n] of [['Tue Nov 10 10:16:00 2026', a], [a, 'Tue Nov 10 10:16:00 2026'], [null, a], [a, null], ['', ''], ['x', 'y']]) assert.equal(startDiffers(r, n), false, `${r} / ${n}`);
});

test('L830: a lock whose live holder has another start time (a reused pid) is broken; with its own start time it is kept', () => {
  const kid = liveChild();
  try {
    const dir = tempDir('m9-start-');
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: kid.pid, pid_start: '2020-01-01T00:00:00Z', host: 'mac-a', nonce: 'n-re', at: 'x' }));
    assert.equal(makeLock({ dir, host: 'mac-a', machine: null, timeoutMs: 200 }).acquire().broke, true);
    const dir2 = tempDir('m9-start-');
    writeFileSync(join(dir2, 'lock'), JSON.stringify({ pid: kid.pid, pid_start: pidStart(kid.pid), host: 'mac-a', nonce: 'n-own', at: 'x' }));
    assert.throws(() => makeLock({ dir: dir2, host: 'mac-a', machine: null, timeoutMs: 50 }).acquire(), /store busy/);
  } finally { kid.kill('SIGKILL'); }
});

test('L830: a failed read of this process\'s own start time is tried again, never kept as null', () => {
  // A fresh node, so this process's own cached value is not touched.
  const code = `import { ownPidStart } from ${JSON.stringify(LOCK)};\nconst a = ownPidStart({ read: () => null });\nconst b = ownPidStart({ read: () => '2026-11-10T10:16:00Z' });\nconst c = ownPidStart({ read: () => 'other' });\nprocess.stdout.write(JSON.stringify([a, b, c]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [null, '2026-11-10T10:16:00Z', '2026-11-10T10:16:00Z'], 'read again after null, then kept');
  assert.equal(typeof ownPidStart, 'function');
});
