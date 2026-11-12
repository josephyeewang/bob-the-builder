// Tests for the Dispatcher's four worker and cleanup keys in setup (L748): the seal folder and the copies' access list in the
// folder table, hostLockPath in the config, `dispatcher-keys`, and check-dispatcher's host.lock line, which says in plain words
// why orchestrate can't read it. Same stand-in Mac as the other setup tests. PLANT tests break one thing each.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COPIES_CLEANUP_ACL, ORCHESTRATE_READ_ACL, ROOT_CONFIG_PATH, dispatcherKeys, folderTable, mirrorPath, parseConfig, sealRootPath } from './layout.mjs';
import { aclEntries } from './users-folders.mjs';
import { checkDispatcherKeys, dispatcherKeysOn, foldersAbove, guardedFolder } from './dispatcher-check.mjs';
import { checkInstall, parseInstallConfig } from './install.mjs';
import { main } from './setup.mjs';
import { WORKER_CONFIG_KEYS } from '../wiring/dispatcher-wiring.mjs';
import { HOST_LOCK_MAX } from '../wiring/worker-ports.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { COPY_MAX_AGE_MS, stampPath } from './host-lock-copy.mjs';

const BASE = '/Library/orch-test';
const LOCK = '/Users/sam/Sync Folder/host.lock';   // a synced folder's name may hold a space
const RAW = { base: BASE, owner: 'sam', products: ['alpha'], hostLockPath: LOCK };
const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };

/** The stand-in Mac after users-folders, with the owner's home, host.lock (sam's, 0644) and the runner's launches folder. */
function world({ raw = RAW, lock = true, launches = true } = {}) {
  const mac = fakeMac({ euid: 0 });
  const file = join(tempDir('orch-dkeys-cfg-'), 'c.json'); writeFileSync(file, JSON.stringify(raw));
  const run = (args) => {
    if (mac.as === 0) { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); } else args = [...args, '--config', file];
    const s = sink(); const code = main(args, { io: mac, out: s.out, err: s.err }); return { code, text: s.lines.join('\n') };
  };
  const first = run(['users-folders']); assert.equal(first.code, 0, first.text);
  chmodSync(mac.prefix, 0o755);   // the stand-in's '/': on a real Mac everyone may search it
  const sam = { uid: 65001, gid: 20 };
  for (const d of ['/Users', '/Users/sam', '/Users/sam/Sync Folder']) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); }
  mac.owners.set('/Users', { uid: mac.rootUid, gid: 0 }); mac.owners.set('/Users/sam', sam); mac.owners.set('/Users/sam/Sync Folder', sam);
  if (lock) { writeFileSync(mac.at(LOCK), 'host: mini\n'); chmodSync(mac.at(LOCK), 0o644); mac.owners.set(LOCK, sam); }
  if (launches) mkdirSync(mac.at(`${BASE}/review/launches`));
  return { mac, run, cfg: parseConfig(raw) };
}
const lockRow = (res) => res.find((r) => r.what.includes('host.lock'));
const failing = (res) => res.filter((r) => !r.ok);

// ───────────────────────────────────────────── the folder table and the config

test('L748: the seal folder is orchestrate\'s 0700; the copies folder has the one cleanup entry, list/read/delete only, inherited', () => {
  const cfg = parseConfig(RAW);
  const rows = folderTable(cfg); const by = (p) => rows.find((r) => r.path === p);
  assert.deepEqual([by(sealRootPath(cfg)).owner, by(sealRootPath(cfg)).mode, by(sealRootPath(cfg)).acl], ['orchestrate', 0o700, []]);
  assert.equal(sealRootPath(cfg), `${BASE}/seals`);
  assert.deepEqual([by(`${BASE}/worker-copies`).owner, by(`${BASE}/worker-copies`).mode, by(`${BASE}/worker-copies`).acl], ['owner', 0o755, [COPIES_CLEANUP_ACL]]);
  assert.deepEqual([...COPIES_CLEANUP_ACL.perms].sort(), ['delete_child', 'directory_inherit', 'file_inherit', 'list', 'readattr', 'readextattr', 'readsecurity', 'search']);
  // No add or write; no `read` (a folder shows it as `list`, so the exact check could never pass) and no `delete` (the empty copies folder itself could go).
  for (const no of ['add_file', 'add_subdirectory', 'write', 'append', 'writeattr', 'writeextattr', 'writesecurity', 'chown', 'read', 'delete', 'execute']) assert.ok(!COPIES_CLEANUP_ACL.perms.includes(no), no);
  assert.equal(COPIES_CLEANUP_ACL.who, ORCHESTRATE_READ_ACL.who);
});

test('L748: on the real chmod and ls, the copies entry round-trips exactly, and a file made under it gets read and no write', () => {
  const w = world();
  const dir = `${BASE}/worker-copies`;
  assert.deepEqual(aclEntries(w.mac, dir).entries, ['user:orchestrate allow delete_child,directory_inherit,file_inherit,list,readattr,readextattr,readsecurity,search']);
  mkdirSync(w.mac.at(`${dir}/card-1`)); writeFileSync(w.mac.at(`${dir}/card-1/f.txt`), 'x');
  const inherited = aclEntries(w.mac, `${dir}/card-1/f.txt`).entries;
  assert.equal(inherited.length, 1);
  assert.match(inherited[0], /^user:orchestrate inherited allow (\S+)$/);
  const perms = inherited[0].split(' ').pop().split(',');
  assert.ok(perms.includes('read'), inherited[0]);
  for (const no of ['write', 'append', 'delete', 'writeattr', 'writeextattr']) assert.ok(!perms.includes(no), `${no} in ${inherited[0]}`);
  assert.match(aclEntries(w.mac, `${dir}/card-1`).entries[0], /^user:orchestrate inherited allow .*\bdelete_child\b/);
});

test('L748, L763, L925: dispatcherKeys names the ten Dispatcher keys, the very ones the wiring reads, from the one place', () => {
  const cfg = parseConfig(RAW);
  const k = dispatcherKeys(cfg, { hostLockUid: 65001 });
  assert.deepEqual(Object.keys(k).sort(), [...WORKER_CONFIG_KEYS].sort());
  assert.deepEqual(k, { reviewRoot: `${BASE}/review`, mirror: mirrorPath(cfg), sealRoot: sealRootPath(cfg), outboxRoot: `${BASE}/outboxes`, copiesRoot: `${BASE}/worker-copies`, hostLockPath: LOCK, hostLockUid: 65001,
    workerRequestsDir: `${BASE}/worker-runner/requests`, workerStatusFile: `${BASE}/worker-runner/runner/status.json`, workerUid: 65001 });
  assert.throws(() => dispatcherKeys(parseConfig({ ...RAW, hostLockPath: undefined }), { hostLockUid: 65001 }), /hostLockPath is not set/);
  // host.lock's owner is the owner's Mac user id, read on this Mac: none is never a key.
  assert.throws(() => dispatcherKeys(cfg), /the owner sam is not a user on this Mac, so host\.lock's owner \(hostLockUid\) can't be named/);
  // On the stand-in Mac, dispatcherKeysOn reads it from the owner's own record.
  const w = world();
  assert.equal(dispatcherKeysOn(w.mac, w.cfg).hostLockUid, 65001);
  assert.throws(() => dispatcherKeysOn(w.mac, parseConfig({ ...RAW, owner: 'nobody2', hostLockPath: '/Users/nobody2/host.lock' })), /the owner nobody2 is not a user on this Mac/);
});

test('L748: hostLockPath is a full path in the owner\'s own home; anything else is refused', () => {
  assert.equal(parseConfig(RAW).hostLockPath, LOCK);
  assert.equal(parseConfig({ ...RAW, hostLockPath: undefined }).hostLockPath, undefined);
  for (const bad of ['host.lock', '/Users/other/host.lock', '/Users/sam', '/Users/sam/', '/Users/samx/host.lock', '/Users/sam/a/../host.lock', '/Users/sam/./host.lock', '/Users/sam//host.lock', '/Users/sam/a\nb', `/Users/sam/${'a'.repeat(300)}`, 7]) {
    assert.throws(() => parseConfig({ ...RAW, hostLockPath: bad }), /hostLockPath must be/, String(bad));
  }
});

test('L748: dispatcher-keys prints the five keys as JSON; with no hostLockPath it is a PROBLEM, exit 1; it never changes anything', () => {
  const w = world();
  const before = w.mac.log.length;
  const r = w.run(['dispatcher-keys']); assert.equal(r.code, 0, r.text);
  assert.deepEqual(JSON.parse(r.text), dispatcherKeysOn(w.mac, w.cfg));
  assert.equal(JSON.parse(r.text).hostLockUid, 65001);
  assert.equal(w.mac.log.length, before);
  const w2 = world({ raw: { ...RAW, hostLockPath: undefined } });
  const r2 = w2.run(['dispatcher-keys']); assert.equal(r2.code, 1); assert.match(r2.text, /PROBLEM {2}config: hostLockPath is not set/);
});

// ───────────────────────────────────────────── check-install's Dispatcher lines

test('L748: all is well → the launches line, the host.lock line and the job line PASS, as root', () => {
  const w = world();
  const res = checkDispatcherKeys(w.mac, w.cfg);
  assert.equal(res.length, 3); assert.deepEqual(failing(res), []); assert.ok(!res.some((r) => r.skip));
  assert.match(res[2].what, /the Dispatcher's own background job can read host\.lock/);
});

test('L1029 E: with the owner\'s copier (hostLockSource), check-dispatcher FAILs unless its stamp beside the copy is fresh and the owner\'s', () => {
  const SRC = '/Users/sam/Library/CloudStorage/Dropbox/host.lock';
  const w = world({ raw: { ...RAW, hostLockSource: SRC } });
  const T = Date.parse('2026-11-12T10:00:00Z');
  const row = (res) => res.find((r) => r.what.includes('copier'));
  const at = (o = {}) => checkDispatcherKeys(w.mac, w.cfg, { now: T, ...o });
  // Never run: the copier line FAILs, the rest is as before.
  let res = at();
  assert.equal(res.length, 4); assert.equal(row(res).ok, false);
  assert.match(row(res).what, /copier has copied \/Users\/sam\/Library\/CloudStorage\/Dropbox\/host\.lock to \/Users\/sam\/Sync Folder\/host\.lock in the last 5 minutes/);
  assert.match(row(res).why, /has never finished a run/);
  assert.deepEqual(failing(res).length, 1);
  // A fresh stamp of the owner's: PASS.
  const st = stampPath(LOCK);
  writeFileSync(w.mac.at(st), JSON.stringify({ at: new Date(T - 60_000).toISOString(), source: 'present' })); w.mac.owners.set(st, { uid: 65001, gid: 20 });
  res = at(); assert.deepEqual(failing(res), []);
  // Old: FAIL, naming the copier's log.
  res = at({ now: T + COPY_MAX_AGE_MS }); assert.equal(row(res).ok, false); assert.match(row(res).why, /over 5 minutes ago.*host-lock-copy\.err\.log/);
  // Not the owner's (the Dispatcher's own, say): FAIL.
  w.mac.owners.set(st, { uid: 0, gid: 0 }); res = at(); assert.equal(row(res).ok, false); assert.match(row(res).why, /is not the owner's/);
  // Without hostLockSource there is no copier line.
  assert.equal(row(checkDispatcherKeys(world().mac, parseConfig(RAW), { now: T })), undefined);
});

test('L748 r1 M2: host.lock in a folder macOS guards → the Terminal read PASSes, but the job line is NOT TRIED, never a PASS', () => {
  for (const guarded of ['/Users/sam/Library/CloudStorage/Box-x/host.lock', '/Users/sam/Library/Mobile Documents/host.lock', '/Users/sam/Desktop/host.lock', '/Users/sam/Documents/a/host.lock', '/Users/sam/Downloads/host.lock']) {
    const w = world({ raw: { ...RAW, hostLockPath: guarded }, lock: false });
    mkdirSync(w.mac.at(dirname(guarded)), { recursive: true });
    for (const d of foldersAbove(guarded).filter((x) => x.startsWith('/Users/sam/'))) { chmodSync(w.mac.at(d), 0o755); w.mac.owners.set(d, { uid: 65001, gid: 20 }); }
    writeFileSync(w.mac.at(guarded), 'host: mini\n'); chmodSync(w.mac.at(guarded), 0o644); w.mac.owners.set(guarded, { uid: 65001, gid: 20 });
    const res = checkDispatcherKeys(w.mac, w.cfg);
    assert.equal(res[1].ok, true, guarded);
    assert.equal(res[2].ok, false, guarded); assert.equal(res[2].notTried, true, guarded);
    assert.match(res[2].why, /proves only the permissions/);
  }
  assert.equal(guardedFolder('/Users/sam/Sync Folder/host.lock'), false);
  assert.equal(guardedFolder('/Users/sam/Desktopx/host.lock'), false);
});

// The stand-in Mac with host.lock's folder at `folder` (made, sam's, 0755) and no host.lock in it.
function missingIn(folder, { make = folder } = {}) {
  const lock = `${folder}/host.lock`;
  const w = world({ raw: { ...RAW, hostLockPath: lock }, lock: false });
  mkdirSync(w.mac.at(make), { recursive: true });
  for (const d of foldersAbove(`${make}/x`).filter((x) => x.startsWith('/Users/sam/'))) { chmodSync(w.mac.at(d), 0o755); w.mac.owners.set(d, { uid: 65001, gid: 20 }); }
  return w;
}

test('L763 r1 M1: host.lock missing in a folder macOS guards → the job line is NOT TRIED, never a clean PASS', () => {
  for (const folder of ['/Users/sam/Library/CloudStorage/Dropbox/99.0 Claude Sync', '/Users/sam/Desktop', '/Users/sam/Documents/a']) {
    const w = missingIn(folder);
    const res = checkDispatcherKeys(w.mac, w.cfg);
    assert.equal(res.length, 3, `${folder}: ${JSON.stringify(res)}`);
    assert.equal(res[1].ok, true, folder); assert.match(res[1].what, /is not there, which the Dispatcher reads as no host claimed/);
    assert.equal(res[2].ok, false, folder); assert.equal(res[2].notTried, true, `planted: the missing branch returning before the guarded test PASSes here (${folder})`);
    assert.match(res[2].why, /is not there now, and would be .* refused the read \("Operation not permitted"\), not told "no such file"/);
  }
  // Missing outside the guarded folders: the job line PASSes, as for a file that is there.
  const plain = checkDispatcherKeys(missingIn('/Users/sam/Sync Folder').mac, missingIn('/Users/sam/Sync Folder').cfg);
  assert.deepEqual(failing(plain), []); assert.equal(plain.length, 3); assert.match(plain[2].what, /the Dispatcher's own background job can read host\.lock/);
  // Missing, as the owner without root: the read is NEEDS ROOT, and a guarded place is still NOT TRIED (it needs no read).
  const w = missingIn('/Users/sam/Library/CloudStorage/Dropbox');
  w.mac.as = 65001;
  const res = checkDispatcherKeys(w.mac, w.cfg);
  assert.ok(res.some((r) => r.skip && /is not there/.test(r.what)), JSON.stringify(res));
  assert.ok(res.some((r) => r.notTried), JSON.stringify(res));
  // A folder that is not there is a wrong path, told, never "no host".
  const gone = world({ raw: { ...RAW, hostLockPath: '/Users/sam/No Such/host.lock' }, lock: false });
  const g = lockRow(checkDispatcherKeys(gone.mac, gone.cfg));
  assert.equal(g.ok, false); assert.match(g.why, /its folder \/Users\/sam\/No Such is not there, so the path is wrong/);
});

test('L763 r1 m1: the guarded test reads the real path with the disk\'s own case, and another volume is guarded too', (t) => {
  // The config spells the folder in other case; the disk holds Library/CloudStorage. Mac disks ignore case (the test's too).
  const w = missingIn('/Users/sam/library/cloudStorage/Dropbox', { make: '/Users/sam/Library/CloudStorage/Dropbox' });
  if (!existsSync(w.mac.at('/Users/sam/library/cloudStorage/Dropbox'))) { t.skip('this disk minds case, so the other spelling is simply another folder'); return; }
  const res = checkDispatcherKeys(w.mac, w.cfg);
  assert.equal(res[2].notTried, true, `planted: a test on the path as typed PASSes here (${JSON.stringify(res)})`);
  assert.match(res[2].why, /would be \/Users\/sam\/Library\/CloudStorage\/Dropbox\/host\.lock/);
  // The same with the file there.
  writeFileSync(w.mac.at('/Users/sam/Library/CloudStorage/Dropbox/host.lock'), 'host: mini\n'); chmodSync(w.mac.at('/Users/sam/Library/CloudStorage/Dropbox/host.lock'), 0o644);
  w.mac.owners.set('/Users/sam/library/cloudStorage/Dropbox/host.lock', { uid: 65001, gid: 20 });
  const there = checkDispatcherKeys(w.mac, w.cfg);
  assert.equal(there[2].notTried, true, JSON.stringify(there)); assert.match(there[2].why, /is really \/Users\/sam\/Library\/CloudStorage\/Dropbox\/host\.lock/);
  // The regex alone ignores case too, and covers a link from the home to another volume (its real path is under /Volumes).
  for (const p of ['/Users/sam/library/cloudstorage/x', '/Users/sam/DESKTOP/host.lock', '/Volumes/USB Disk/host.lock', '/Volumes/share']) assert.equal(guardedFolder(p), true, p);
  for (const p of ['/Volumes', '/Users/sam/Sync Folder/host.lock', '/Users/sam/volumes/x']) assert.equal(guardedFolder(p), false, p);
});

test('L748 PLANT: a folder above host.lock orchestrate can\'t go into → "folder permissions", naming the folder', () => {
  const w = world(); chmodSync(w.mac.at('/Users/sam'), 0o750);
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, false); assert.match(row.why, /can't read it, so the Dispatcher would say "not known" on every pass/);
  assert.match(row.why, /folder permissions: orchestrate can't go into \/Users\/sam, a folder above host\.lock/);
});

test('L748 PLANT: host.lock not readable by others → "file permissions"', () => {
  const w = world(); chmodSync(w.mac.at(LOCK), 0o600);
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, false); assert.match(row.why, /file permissions: host\.lock itself is mode 600, which doesn't let orchestrate read it \(it must be readable by others, mode o\+r, for example 644\)/);
});

test('L748 PLANT: permissions allow it but macOS refuses the read → "macOS privacy protection", with what to do', () => {
  const w = world(); w.mac.privacyBlocked.add(LOCK);
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, false); assert.match(row.why, /macOS privacy protection: the permissions allow it, but macOS refused the read/);
  assert.match(row.why, /CloudStorage/);
});

test('L748 r1 m5: a read that fails for another reason is said as it is, not as privacy protection; no orchestrate user → run users-folders', () => {
  const w = world();
  const real = w.mac.run; w.mac.run = (cmd, args) => (args.includes('/bin/cat') ? { status: 1, stdout: '', stderr: 'sudo: a timeout\n' } : real(cmd, args));
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, false); assert.match(row.why, /Why: the read failed: sudo: a timeout$/); assert.doesNotMatch(row.why, /privacy/);
  const w2 = world(); w2.mac.users.delete('orchestrate');
  const row2 = lockRow(checkDispatcherKeys(w2.mac, w2.cfg));
  assert.equal(row2.ok, false); assert.match(row2.why, /the orchestrate user doesn't exist yet; run users-folders first/);
});

test('L748 r1 m4: a folder only the named path passes through (a link\'s parent) is walked too', () => {
  const w = world();
  // /Users/sam/Sync Folder is a link to a folder outside the home; /Users/sam itself is closed to others.
  mkdirSync(w.mac.at('/Volumes/X'), { recursive: true }); chmodSync(w.mac.at('/Volumes'), 0o755); chmodSync(w.mac.at('/Volumes/X'), 0o755);
  rmSync(w.mac.at('/Users/sam/Sync Folder'), { recursive: true });
  writeFileSync(w.mac.at('/Volumes/X/host.lock'), 'x'); chmodSync(w.mac.at('/Volumes/X/host.lock'), 0o644);
  symlinkSync(w.mac.at('/Volumes/X'), w.mac.at('/Users/sam/Sync Folder')); w.mac.owners.set(LOCK, { uid: 65001, gid: 20 });
  chmodSync(w.mac.at('/Users/sam'), 0o750);
  w.mac.privacyBlocked.add(LOCK);   // the stand-in's cat doesn't walk a link's parents; a real Mac refuses with "Permission denied"
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.match(row.why, /folder permissions: orchestrate can't go into \/Users\/sam,/);
});

test('L748: the reasons are judged on host.lock\'s real place (a synced folder reached through a link)', () => {
  const w = world();
  mkdirSync(w.mac.at('/Users/sam/Library/Cloud'), { recursive: true }); chmodSync(w.mac.at('/Users/sam/Library'), 0o700); chmodSync(w.mac.at('/Users/sam/Library/Cloud'), 0o755);
  rmSync(w.mac.at('/Users/sam/Sync Folder'), { recursive: true });
  writeFileSync(w.mac.at('/Users/sam/Library/Cloud/host.lock'), 'host: mini\n'); chmodSync(w.mac.at('/Users/sam/Library/Cloud/host.lock'), 0o644);
  symlinkSync(w.mac.at('/Users/sam/Library/Cloud'), w.mac.at('/Users/sam/Sync Folder'));
  w.mac.owners.set('/Users/sam/Library', { uid: 65001, gid: 20 }); w.mac.owners.set(LOCK, { uid: 65001, gid: 20 });
  // The stand-in's own read (cat) does not follow the folder link's real parents, so a real Mac's refusal is stood in for.
  w.mac.privacyBlocked.add(LOCK);
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, false); assert.match(row.why, /folder permissions: orchestrate can't go into \/Users\/sam\/Library,/);
});

test('L748 PLANT: host.lock missing, orchestrate\'s, someone else\'s, a link, two names, too big → each FAILs and says which', () => {
  const cases = [
    ['orchestrate\'s', (w) => w.mac.owners.set(LOCK, { uid: Number(w.mac.users.get('orchestrate').UniqueID), gid: 0 }), /it is orchestrate's own file; it must be sam's/],
    ['root\'s', (w) => w.mac.owners.set(LOCK, { uid: w.mac.rootUid, gid: 0 }), /its owner is uid \d+, not sam \(uid 65001\)/],
    ['a link', (w) => { writeFileSync(w.mac.at('/Users/sam/real.lock'), 'x'); rmSync(w.mac.at(LOCK)); symlinkSync(w.mac.at('/Users/sam/real.lock'), w.mac.at(LOCK)); }, /it is a link; the Dispatcher reads it without following one/],
    ['two names', (w) => linkSync(w.mac.at(LOCK), w.mac.at('/Users/sam/other-name')), /it has 2 names/],
    ['too big', (w) => writeFileSync(w.mac.at(LOCK), 'x'.repeat(HOST_LOCK_MAX + 1)), new RegExp(`the Dispatcher reads at most ${HOST_LOCK_MAX}`)],
    ['a folder', (w) => { rmSync(w.mac.at(LOCK)); mkdirSync(w.mac.at(LOCK)); }, /it is not a plain file/],
  ];
  for (const [name, plant, why] of cases) {
    const w = world(); plant(w);
    const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
    assert.equal(row.ok, false, name); assert.match(row.why, why, name);
  }
});

test('L748 r1 m3: host.lock missing is the Dispatcher\'s "no host claimed": PASS when orchestrate can reach its folder, FAIL naming the folder when not', () => {
  const w = world({ lock: false });
  const row = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row.ok, true, row.why); assert.match(row.what, /is not there, which the Dispatcher reads as no host claimed/);
  chmodSync(w.mac.at('/Users/sam/Sync Folder'), 0o700);
  const row2 = lockRow(checkDispatcherKeys(w.mac, w.cfg));
  assert.equal(row2.ok, false); assert.match(row2.why, /folder permissions: orchestrate can't go into \/Users\/sam\/Sync Folder, so the Dispatcher would say "not known"/);
  w.mac.as = 65001; assert.equal(lockRow(checkDispatcherKeys(w.mac, w.cfg)).skip, true);
});

test('L748: without root the host.lock read is NEEDS ROOT, never a PASS; the launches line still answers', () => {
  const w = world(); w.mac.as = 65001;
  const res = checkDispatcherKeys(w.mac, w.cfg);
  assert.equal(lockRow(res).skip, true); assert.match(lockRow(res).why, /needs root; run check-dispatcher with sudo/);
  assert.equal(res[0].ok, true); assert.ok(!res[0].skip);
});

test('L763 self-review m4: without root, a host.lock in a guarded folder is still NOT TRIED (it needs no read), there or missing, or its folder shut', () => {
  const lock = '/Users/sam/Desktop/host.lock';
  for (const state of ['there', 'missing', 'shut']) {
    const w = world({ raw: { ...RAW, hostLockPath: lock }, lock: false });
    mkdirSync(w.mac.at('/Users/sam/Desktop'), { recursive: true }); chmodSync(w.mac.at('/Users/sam/Desktop'), 0o755); w.mac.owners.set('/Users/sam/Desktop', { uid: 65001, gid: 20 });
    if (state !== 'missing') { writeFileSync(w.mac.at(lock), 'host: mini\n'); chmodSync(w.mac.at(lock), 0o644); w.mac.owners.set(lock, { uid: 65001, gid: 20 }); }
    w.mac.as = 65001;
    const real = w.mac.lstat; if (state === 'shut') w.mac.lstat = (p) => { if (p === lock) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return real(p); };
    const res = checkDispatcherKeys(w.mac, w.cfg);
    assert.ok(res.some((r) => r.skip), `${state}: ${JSON.stringify(res)}`);
    assert.ok(res.some((r) => r.notTried), `planted: a NEEDS ROOT return without the guarded line (${state}: ${JSON.stringify(res)})`);
  }
});

test('L748 PLANT: the runner\'s launches folder missing or a link → FAIL, saying to load the review jobs first', () => {
  const w = world({ launches: false });
  const res = checkDispatcherKeys(w.mac, w.cfg);
  assert.equal(res[0].ok, false); assert.match(res[0].why, /not there yet: the review runner makes it on its first run, so load the review jobs first/);
  const w2 = world({ launches: false }); symlinkSync(w2.mac.at('/Users'), w2.mac.at(`${BASE}/review/launches`));
  assert.match(checkDispatcherKeys(w2.mac, w2.cfg)[0].why, /is not a plain folder/);
});

test('L748 r1 M1: check-dispatcher prints the lines; check-install never does (daemons load and the watch cutover wait on it), only a pointer', () => {
  const INSTALL = { address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-test', runnerConfig: '/nowhere/review.json' };
  const w = world({ raw: { ...RAW, ...INSTALL } });
  const r = w.run(['check-dispatcher']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^PASS {2}the owner's host\.lock \(\/Users\/sam\/Sync Folder\/host\.lock\) is sam's and orchestrate can read it/m);
  assert.match(r.text, /^PASS {2}the review runner's folder \/Library\/orch-test\/review holds its launches folder/m);
  chmodSync(w.mac.at(LOCK), 0o600);
  const bad = w.run(['check-dispatcher']); assert.equal(bad.code, 1); assert.match(bad.text, /^FAIL {2}the owner's host\.lock .* file permissions/m);
  // check-install: the same failing host.lock changes nothing in its lines or its exit code.
  const ci = w.run(['check-install']);
  assert.doesNotMatch(ci.text, /^(PASS|FAIL|NEEDS ROOT|NOT TRIED) .*(host\.lock|launches folder)/m);
  assert.match(ci.text, /^the Dispatcher's folders and host\.lock: run check-dispatcher/m);
  assert.equal(checkInstall(w.mac, parseInstallConfig({ ...RAW, ...INSTALL })).some((x) => /host\.lock|launches/.test(x.what)), false);
  const w2 = world({ raw: { ...RAW, ...INSTALL, hostLockPath: undefined } });
  assert.doesNotMatch(w2.run(['check-install']).text, /host\.lock|check-dispatcher/);
  const r2 = w2.run(['check-dispatcher']); assert.equal(r2.code, 1); assert.match(r2.text, /hostLockPath is not set/);
});

test('L1029 E: host-lock-copier prints the owner\'s job file on stdout and the steps on stderr; refused under sudo and without hostLockSource', () => {
  const INSTALL = { address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-test', runnerConfig: '/nowhere/review.json' };
  const SRC = '/Users/sam/Library/CloudStorage/Dropbox/host.lock';
  const w = world({ raw: { ...RAW, ...INSTALL, hostLockSource: SRC } });
  const root = w.run(['host-lock-copier']); assert.equal(root.code, 2); assert.match(root.text, /the host\.lock copier is the owner's own job; run this without sudo/);
  w.mac.as = 65001;
  const r = w.run(['host-lock-copier']); assert.equal(r.code, 0, r.text);
  assert.match(r.text, /<string>com\.example\.orch-test\.host-lock-copy<\/string>/);
  assert.match(r.text, /<string>\/Library\/orch-test\/install\/orchestrate\/setup\/host-lock-copy\.mjs<\/string>/);
  assert.match(r.text, /^ERR Save the text above as \/Users\/sam\/Library\/LaunchAgents\/com\.example\.orch-test\.host-lock-copy\.plist .*launchctl bootstrap gui\/\$\(id -u\)/m);
  assert.match(r.text, /^ERR .*Run dispatcher-config again so the Dispatcher's dispatcher\.json names the copy too/m, 'review M2: the job reads dispatcher.json');
  const w2 = world({ raw: { ...RAW, ...INSTALL } }); w2.mac.as = 65001;
  const r2 = w2.run(['host-lock-copier']); assert.equal(r2.code, 1); assert.match(r2.text, /names no hostLockSource/);
});

test('foldersAbove lists every folder above a file, top first', () => {
  assert.deepEqual(foldersAbove('/Users/sam/Sync Folder/host.lock'), ['/', '/Users', '/Users/sam', '/Users/sam/Sync Folder']);
  assert.deepEqual(foldersAbove('/host.lock'), ['/']);
});
