// worker-ports.test.mjs — the ports wired in C (L739): the cleanup group's mirror, git and seal folder, filesOf, hostLock
// and reviewEnded, each against its contract, with real folders, a real git mirror and limitedSync's real runner.
// Run: node --test orchestrate/wiring/worker-ports.test.mjs
//
// Each port's planted fault is the one that would pass in silence: an empty or null answer where the real one exists,
// and a folder or file that can't be read taken as "nothing to do". Every such answer fails a test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { limitedSync } from '../modules/M11-dispatcher/sync-limit.mjs';
import { mirrorTree } from '../modules/M11-dispatcher/cleanup.mjs';
import { ENDED_FOLDER } from '../modules/M9-record/outbox.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { MIRROR_CONFIG_TEMPLATE } from '../modules/M4-workshop/git/safe-git.mjs';
import { CLEANUP_GIT, HOST_LOCK_MAX, REVIEW_KIND_OF, REVIEW_STATE_CORRUPT, cleanupPorts, hostLockPort, mirrorProblem, recordHolds, requestsFolderProblem, reviewEndedPort, reviewSessions, runnerSyncPorts, workerPorts } from './worker-ports.mjs';
import { mirrorFilesOf } from './review-ports.mjs';

const ME = process.getuid();
const run = limitedSync(spawnSync);
const P = 'sample-app';
const HEAD = 'a'.repeat(40);

// A plain git call for setting up the test's repositories (not the code under test).
function g(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare mirror holding main with two commits: the first adds a.txt, the second changes a.txt and adds b/c.txt.
function mirrorWorld() {
  const base = tempDir('orch-c2-');
  chmodSync(base, 0o755);
  const work = join(base, 'work');
  mkdirSync(work);
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 't'); g(work, 'config', 'user.email', 't@localhost');
  writeFileSync(join(work, 'a.txt'), 'one\n');
  g(work, 'add', '.'); g(work, 'commit', '-q', '-m', 'one');
  const first = g(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'a.txt'), 'two\n');
  mkdirSync(join(work, 'b'));
  writeFileSync(join(work, 'b', 'c.txt'), 'c\n');
  g(work, 'add', '.'); g(work, 'commit', '-q', '-m', 'two');
  const second = g(work, 'rev-parse', 'HEAD');
  g(work, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const empty = g(work, 'rev-parse', 'HEAD');
  const mirror = join(base, 'mirror');
  g(base, 'clone', '-q', '--bare', work, mirror);
  // The mirror's config is safe-git's template, as worker-copy and push require of it (checkMirror, L763 r1 m2).
  writeFileSync(join(mirror, 'config'), MIRROR_CONFIG_TEMPLATE);
  chmodSync(mirror, 0o755);
  // host.lock's owner (hostLockUid) is never the Dispatcher's own user: the test user is the Dispatcher here.
  // The TOP outboxes and worker-copies folders (L887), as setup makes them.
  for (const f of ['outboxes', 'worker-copies', 'worker-runner/requests', 'worker-runner/runner']) mkdirSync(join(base, f), { recursive: true, mode: 0o755 });
  // The worker runner runs as the owner: host.lock's user (L896).
  const config = { product: P, mirror, sealRoot: join(base, 'seals'), outboxRoot: join(base, 'outboxes'), copiesRoot: join(base, 'worker-copies'), reviewRoot: join(base, 'review-runner'), reviewUid: ME, hostLockPath: join(base, 'host.lock'), hostLockUid: ME + 2,
    workerRequestsDir: join(base, 'worker-runner', 'requests'), workerStatusFile: join(base, 'worker-runner', 'runner', 'status.json'), workerUid: ME + 2 };
  mkdirSync(join(config.reviewRoot, 'launches'), { recursive: true, mode: 0o755 }); chmodSync(config.reviewRoot, 0o755);
  return { base, mirror, first, second, empty, config, ctx: { config, selfUid: ME, limitedSync: run } };
}

// ---- cleanup.mirrorFor, cleanup.git, cleanup.sealRoot ----

// L887: the TOP outboxes and worker-copies folders come from the config. outboxRoot is checked at start; copiesRoot on
// each read, so a folder gone later throws inside the step, never "no copies".
test('L887: outboxRoot and cleanup.copiesRoot are the config\'s top folders, real folders only', () => {
  const w = mirrorWorld();
  const ports = workerPorts(w.ctx);
  assert.equal(ports.outboxRoot, w.config.outboxRoot);
  assert.equal(ports.cleanup.copiesRoot, w.config.copiesRoot);
  for (const [k, what] of [['outboxRoot', /the outboxes folder \(outboxRoot\)/], ['copiesRoot', /the worker copies folder \(copiesRoot\)/]]) {
    const link = join(w.base, `${k}-link`);
    symlinkSync(w.config[k], link);
    const file = join(w.base, `${k}-file`);
    writeFileSync(file, '');
    for (const [bad, why] of [[join(w.base, 'nope'), /can't be read \(ENOENT\)/], [link, /is not a plain folder/], [file, /is not a plain folder/]]) {
      const read = () => { const p = workerPorts({ ...w.ctx, config: { ...w.config, [k]: bad } }); return k === 'outboxRoot' ? p.outboxRoot : p.cleanup.copiesRoot; };
      assert.throws(read, (e) => what.test(e.message) && why.test(e.message), `${k} ${bad}`);
    }
  }
  const later = workerPorts(w.ctx).cleanup;
  rmSync(w.config.copiesRoot, { recursive: true });
  assert.throws(() => later.copiesRoot, /the worker copies folder \(copiesRoot\) .* can't be read \(ENOENT\)/, 'checked on each read');
});

test('C (L739): mirrorFor names the mirror for this product\'s cards only; a mirror gone later throws, never "no mirror"', () => {
  const w = mirrorWorld();
  const c = cleanupPorts(w.ctx);
  assert.equal(c.mirrorFor({ product: P }), w.mirror, 'planted: a mirrorFor answering null for its own product fails here');
  assert.equal(c.mirrorFor({ product: 'other-app' }), null, 'another product\'s card has no mirror here');
  assert.equal(c.mirrorFor({}), null, 'a card naming no product is not this product\'s');
  rmSync(w.mirror, { recursive: true, force: true });
  assert.throws(() => c.mirrorFor({ product: P }), /the product's mirror \(mirror\) .* can't be read \(ENOENT\)/);
});

test('C (L739): the mirror is checked at start: missing, a link, another user\'s or writable by others stops the start', () => {
  const w = mirrorWorld();
  const start = (over) => () => workerPorts({ ...w.ctx, config: { ...w.config, ...over } });
  assert.throws(start({ mirror: join(w.base, 'nope') }), /the product's mirror \(mirror\) .*nope can't be read \(ENOENT\)/);
  symlinkSync(w.mirror, join(w.base, 'link'));
  assert.throws(start({ mirror: join(w.base, 'link') }), /is not a plain folder/);
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: ME + 5, workerUid: ME + 5 }, selfUid: ME + 1 }), /belongs to uid \d+, not to this job's uid/);
  chmodSync(w.mirror, 0o775);
  assert.throws(start({}), /can be written by others \(mode 775\)/);
  chmodSync(w.mirror, 0o755);
  assert.equal(mirrorProblem(w.mirror, ME), null);
});

test('C (L739): cleanup.git is safe-git on the mirror, and only the two reads cleanup makes', async () => {
  const w = mirrorWorld();
  const { git } = cleanupPorts(w.ctx);
  // The real read cleanup makes: the tree at a commit (cleanup.mjs mirrorTree).
  const tree = await mirrorTree(git, w.mirror, w.second);
  assert.ok(tree, 'planted: a git answering nothing makes mirrorTree null, and this fails');
  assert.deepEqual([...tree.keys()].sort(), ['a.txt', 'b/c.txt']);
  assert.equal((await git(['merge-base', '--is-ancestor', w.first, 'refs/heads/main'], { gitDir: w.mirror, purpose: 't' })).code, 0);
  assert.notEqual((await git(['merge-base', '--is-ancestor', 'f'.repeat(40), 'refs/heads/main'], { gitDir: w.mirror, purpose: 't' })).code, 0);
  // Another folder, or any other command, is refused before git runs.
  const other = await git(['ls-tree', w.second], { gitDir: join(w.base, 'work', '.git') });
  assert.equal(other.code, -1); assert.match(other.stderr, /only the product's mirror is read here/);
  const write = await git(['update-ref', 'refs/heads/main', w.first], { gitDir: w.mirror });
  assert.equal(write.code, -1); assert.match(write.stderr, /only ls-tree and merge-base run on the mirror/);
  assert.deepEqual([...CLEANUP_GIT], ['ls-tree', 'merge-base']);
  // Only gitDir, purpose and a capped time reach safe-git: no other program or config can be asked for.
  const seen = [];
  const spy = cleanupPorts(w.ctx, { run: async (a, o) => { seen.push(o); return { code: 0, stdout: Buffer.alloc(0), stderr: '' }; } }).git;
  await spy(['ls-tree', w.second], { gitDir: w.mirror, purpose: 't', gitBin: '/bin/sh', extraConfig: ['core.pager=x'], workTree: '/', timeoutMs: 1e9 });
  // The cap holds when no limit is given, as cleanup.mjs gives none (r1 m1, L763), and for a smaller one given.
  await spy(['merge-base', '--is-ancestor', w.first, 'refs/heads/main'], { gitDir: w.mirror, purpose: 'u' });
  await spy(['ls-tree', w.second], { gitDir: w.mirror, purpose: 'v', timeoutMs: 5_000 });
  assert.deepEqual(seen, [{ gitDir: w.mirror, purpose: 't', timeoutMs: 60_000 }, { gitDir: w.mirror, purpose: 'u', timeoutMs: 60_000 }, { gitDir: w.mirror, purpose: 'v', timeoutMs: 5_000 }]);
  // safe-git's own mirror check runs on each call (r1 m2, L763): grafts or a shallow file would change a commit's parents,
  // so merge-base and the tree would be read wrong. Each is refused before git runs, and the tree is not read.
  for (const f of ['info/grafts', 'shallow', 'objects/info/alternates']) {
    mkdirSync(join(w.mirror, f, '..'), { recursive: true }); writeFileSync(join(w.mirror, f), `${w.first}\n`);
    const r = await git(['merge-base', '--is-ancestor', w.second, 'refs/heads/main'], { gitDir: w.mirror, purpose: 't' });
    assert.equal(r.code, -1, `planted: a cleanup.git without checkMirror runs git with ${f} there`); assert.match(String(r.stderr), new RegExp(`mirror has ${f}`));
    assert.equal(await mirrorTree(git, w.mirror, w.second), null);
    rmSync(join(w.mirror, f));
  }
  assert.ok(await mirrorTree(git, w.mirror, w.second), 'with the mirror as it should be again, the tree is read');
  // A mirror whose config sets a program is refused before git runs, and the tree is not read.
  g(w.mirror, 'config', 'diff.external', '/bin/echo');
  const held = await git(['ls-tree', '-r', '-z', '--full-tree', w.second], { gitDir: w.mirror, purpose: 't' });
  assert.equal(held.code, -1); assert.match(String(held.stderr), /mirror config differs from the template/);
  assert.equal(await mirrorTree(git, w.mirror, w.second), null);
});

test('C (L739): sealRoot is made private at start, refused when linked or shared, and a folder gone later throws on read', () => {
  const w = mirrorWorld();
  const c = cleanupPorts(w.ctx);
  assert.equal(c.sealRoot, w.config.sealRoot, 'planted: a sealRoot answering null or undefined would skip the staging sweep');
  const start = (over) => () => cleanupPorts({ ...w.ctx, config: { ...w.config, ...over } });
  assert.throws(start({ sealRoot: '/nonexistent-orch-parent/seals' }), /the seal folder \(sealRoot\) .* is missing and could not be made/);
  mkdirSync(join(w.base, 'shared'), { mode: 0o755 }); chmodSync(join(w.base, 'shared'), 0o755);
  assert.throws(start({ sealRoot: join(w.base, 'shared') }), /the seal folder \(sealRoot\) .* can be read by others \(mode 755\)/);
  symlinkSync(w.config.sealRoot, join(w.base, 'seal-link'));
  assert.throws(start({ sealRoot: join(w.base, 'seal-link') }), /the seal folder \(sealRoot\) .* is not a plain folder/);
  rmSync(w.config.sealRoot, { recursive: true });
  assert.throws(() => c.sealRoot, /the seal folder \(sealRoot\) .* can't be read \(ENOENT\)/, 'never read as "nothing to sweep"');
  // The tick spreads the group into cleanupPass: the spread itself throws, so the step fails and is told.
  assert.throws(() => ({ ...c }), /the seal folder \(sealRoot\)/);
});

// ---- filesOf ----

test('C (L739): filesOf reads the files a commit changed from the mirror, through limitedSync', () => {
  const w = mirrorWorld();
  const filesOf = mirrorFilesOf({ mirror: w.mirror, uid: ME, run });
  assert.deepEqual(filesOf(w.second).sort(), ['a.txt', 'b/c.txt'], 'planted: an empty or null answer fails here');
  assert.deepEqual(filesOf(w.first), ['a.txt'], 'the first commit, against nothing');
  // git runs with none of this process's environment: a GIT_DIR here points it nowhere else.
  const was = process.env.GIT_DIR;
  process.env.GIT_DIR = join(w.base, 'work', '.git');
  try { assert.deepEqual(filesOf(w.first), ['a.txt']); } finally { if (was === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = was; }
});

test('C (L739): filesOf throws on a commit naming a file that is not UTF-8, never answers an altered name', () => {
  const w = mirrorWorld();
  const work = join(w.base, 'work');
  const blob = g(work, 'hash-object', '-w', 'a.txt');
  const r = spawnSync('git', ['update-index', '--add', '--index-info'], { cwd: work, input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x66, 0xff, 0x2e, 0x74]), Buffer.from('\n')]), env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, String(r.stderr));
  g(work, 'commit', '-q', '-m', 'odd name');
  const odd = g(work, 'rev-parse', 'HEAD');
  g(w.mirror, 'fetch', '-q', work, 'main:main');
  assert.throws(() => mirrorFilesOf({ mirror: w.mirror, uid: ME, run })(odd), /a file whose name is not UTF-8/);
});

test('C (L739): filesOf throws, never answers empty, on a commit it can\'t read, an empty one, a bad id or a mirror it can\'t use', () => {
  const w = mirrorWorld();
  const filesOf = mirrorFilesOf({ mirror: w.mirror, uid: ME, run });
  assert.throws(() => filesOf('f'.repeat(40)), /the mirror can't say which files commit fffffff changed \(exited/);
  assert.throws(() => filesOf(w.empty), /changes no file on the mirror/);
  assert.throws(() => filesOf('HEAD'), /is not a commit id/);
  assert.throws(() => mirrorFilesOf({ mirror: w.mirror, uid: ME })(w.second), /no limitedSync/);
  assert.throws(() => mirrorFilesOf({ mirror: w.mirror, uid: ME + 1, run })(w.second), /belongs to uid/);
  // safe-git's mirror check, run here too (r1 m2, L763): grafts or a shallow file would change a commit's parents, and so
  // the files diff-tree names; each is refused before git reads the commit.
  for (const f of ['info/grafts', 'shallow', 'objects/info/commit-graph']) {
    mkdirSync(join(w.mirror, f, '..'), { recursive: true }); writeFileSync(join(w.mirror, f), `${w.second}\n`);
    assert.throws(() => filesOf(w.second), new RegExp(`the product's mirror \\(mirror\\) .* can't be used: mirror has ${f}`), `planted: a filesOf without checkMirror reads the commit with ${f} there`);
    rmSync(join(w.mirror, f));
  }
  assert.deepEqual(filesOf(w.second).sort(), ['a.txt', 'b/c.txt']);
  // A config key off the safe list is refused before git reads the commit (the config is no longer the template).
  g(w.mirror, 'config', 'diff.external', '/bin/echo');
  assert.throws(() => filesOf(w.second), /can't be used: mirror config differs from the template/);
  g(w.mirror, 'config', '--unset', 'diff.external');
  assert.deepEqual(filesOf(w.second).sort(), ['a.txt', 'b/c.txt']);
  rmSync(w.mirror, { recursive: true, force: true });
  assert.throws(() => filesOf(w.second), /the product's mirror \(mirror\) .* can't be read \(ENOENT\)/);
});

// ---- hostLock ----

test('C (L739): hostLock answers the text, null only when no file is there, and throws for a file or folder it can\'t read', () => {
  const w = mirrorWorld();
  const path = w.config.hostLockPath;
  // The file is the owner's, never the Dispatcher's (M1): this user stands in for the owner, so the Dispatcher is another.
  const hostLock = hostLockPort({ path, run, ownerUid: ME, selfUid: ME + 1 });
  assert.equal(hostLock(), null, 'no file in a folder that is there: no host claimed');
  writeFileSync(path, 'mini\n');
  assert.equal(hostLock(), 'mini\n', 'planted: a hostLock answering null while the file is there fails here');
  chmodSync(path, 0o000);
  assert.throws(() => hostLock(), /host\.lock .* can't be read \(EACCES\)/, 'unreadable is "not known", never "no host"');
  chmodSync(path, 0o644);
  writeFileSync(path, 'x'.repeat(HOST_LOCK_MAX + 1));
  assert.throws(() => hostLock(), /is over 4096 bytes/);
  rmSync(path);
  symlinkSync(join(w.base, 'elsewhere'), path);
  assert.throws(() => hostLock(), /is not a plain file/);
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => hostLock(), /is not a plain file/);
  rmSync(path, { recursive: true });
  // A path whose folder is not there is a wrong path, told, never "no host".
  assert.throws(() => hostLockPort({ path: join(w.base, 'no-folder', 'host.lock'), run, ownerUid: ME, selfUid: ME + 1 })(), /host\.lock's folder .*no-folder can't be read \(ENOENT\)/);
  const shut = join(w.base, 'shut');
  mkdirSync(shut); writeFileSync(join(shut, 'host.lock'), 'x'); chmodSync(shut, 0o000);
  try { assert.throws(() => hostLockPort({ path: join(shut, 'host.lock'), run, ownerUid: ME, selfUid: ME + 1 })(), /host\.lock .* can't be read \(EACCES\)/); } finally { chmodSync(shut, 0o755); }
  // A folder that is a link to a folder is still a folder: a missing file there is no host.
  mkdirSync(join(w.base, 'real-folder'));
  symlinkSync(join(w.base, 'real-folder'), join(w.base, 'folder-link'));
  assert.equal(hostLockPort({ path: join(w.base, 'folder-link', 'host.lock'), run, ownerUid: ME, selfUid: ME + 1 })(), null);
  assert.throws(() => hostLockPort({ path, ownerUid: ME, selfUid: ME + 1 })(), /no limitedSync/);
  // A read held past its limit (a Dropbox stuck fetching), or one that says nothing usable, is "not known", never "no host".
  assert.throws(() => hostLockPort({ path, run: () => ({ ok: false, why: 'timed out after 10000 ms' }), ownerUid: ME, selfUid: ME + 1 })(), /host\.lock .* can't be read \(timed out after 10000 ms\)/);
  assert.throws(() => hostLockPort({ path, run: () => ({ ok: true, stdout: '' }), ownerUid: ME, selfUid: ME + 1 })(), /said nothing it could parse/);
  assert.throws(() => hostLockPort({ path, run, ownerUid: ME })(), /no Dispatcher uid/);
  assert.throws(() => hostLockPort({ path, run, selfUid: ME + 1 })(), /hostLockUid \(the owner's Mac user id, host\.lock's owner\) must be a Mac user id/);
});

test('C (L739, self-review M1, L763): hostLock reads only a file of the owner\'s, never the Dispatcher\'s own or a hard link', () => {
  const w = mirrorWorld();
  const path = w.config.hostLockPath;
  const own = join(w.base, 'dispatcher-only');
  writeFileSync(own, 'private', { mode: 0o600 });
  // A file of the Dispatcher's own in host.lock's place: here the test user is the Dispatcher, and the owner is another.
  writeFileSync(path, 'mini\n');
  assert.throws(() => workerPorts(w.ctx).hostLock(), /is not the owner's file \(its owner is uid \d+, not \d+\)/, 'through workerPorts, checked against hostLockUid');
  // A config naming the Dispatcher's own user, root or the review user as host.lock's owner, or none, stops the start.
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: ME } }), /hostLockUid is the Dispatcher's own user/);
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: 0 } }), /hostLockUid is root/);
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: ME + 7, reviewUid: ME + 7 } }), /hostLockUid is the review user/);
  assert.throws(() => hostLockPort({ path, run, ownerUid: 0, selfUid: ME })(), /hostLockUid is root/);
  // The checks come first: a bad owner stops the start before the seal folder is made.
  rmSync(w.config.sealRoot, { recursive: true, force: true });
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: ME } }), /hostLockUid/);
  assert.equal(existsSync(w.config.sealRoot), false, 'nothing was made before the refusal');
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, hostLockUid: undefined } }), /hostLockUid .* must be a Mac user id/);
  assert.throws(() => hostLockPort({ path, run, ownerUid: ME, selfUid: ME })(), /hostLockUid is the Dispatcher's own user/);
  rmSync(path);
  // A hard link to a file only the Dispatcher can read: lstat shows a plain file, so the name alone can't tell.
  linkSync(own, path);
  assert.throws(() => hostLockPort({ path, run, ownerUid: ME, selfUid: ME + 1 })(), /has another name too \(a hard link\)/);
});

// A file this user can read but doesn't own, which a hard link can name (macOS lets a user hard-link a file it doesn't own).
// Null where the system has none, or links across to it are refused (another disk, or a system that forbids them).
function foreignFile(base) {
  for (const f of ['/private/etc/shells', '/etc/shells']) {
    try { const at = join(base, `probe-${Math.random().toString(36).slice(2)}`); linkSync(f, at); rmSync(at); return f; } catch { /* next */ }
  }
  return null;
}

test('C (L763 r1 M1): a link in the folders above host.lock never reads another user\'s file into the Record', () => {
  const w = mirrorWorld();
  // The owner can write host.lock's folder, so they can make it a link to a folder of someone else's files: lstat of the
  // name shows a plain file with one name, so only its owner tells it apart.
  // /private/etc on a Mac, /etc elsewhere (the Linux CI job): root's either way, and /etc/shells is in both.
  symlinkSync(existsSync('/private/etc/shells') ? '/private/etc' : '/etc', join(w.base, 'etc-link'));
  assert.throws(() => hostLockPort({ path: join(w.base, 'etc-link', 'shells'), run, ownerUid: ME, selfUid: ME + 1 })(), /is not the owner's file \(its owner is uid 0, not \d+\)/,
    'planted: a reader without the owner check reads root\'s file here');
});

test('C (L763 r1 M1): a hard link made and removed between the open and the check never reads another user\'s file', (t) => {
  const w = mirrorWorld();
  const victim = foreignFile(w.base);
  // A Mac lets a user hard-link another user's file; Linux (the CI job) does not (protected_hardlinks), so there this test
  // skips and the folder-link test above is the guard. Its proof is from a Mac run.
  if (!victim) { t.skip('runs only on a Mac: no file of another user can be hard-linked here, so the race can\'t be made'); return; }
  const path = join(w.base, 'owner', 'host.lock');
  mkdirSync(join(w.base, 'owner'));
  // The owner's side: link the victim to host.lock and remove it, over and over (the r1 race, scratchpad race.mjs).
  const loop = `const fs=require('fs');const [v,p]=process.argv.slice(1);for(;;){try{fs.linkSync(v,p)}catch{}try{fs.unlinkSync(p)}catch{}}`;
  const atk = spawn(process.execPath, ['-e', loop, victim, path], { stdio: 'ignore' });
  try {
    const port = hostLockPort({ path, run, ownerUid: ME, selfUid: ME + 1 });
    const seen = { text: 0, refused: 0, none: 0 };
    // At least 120 reads, and on until one has seen the link (at most 600): a busy machine may be slow to make it.
    for (let i = 0; i < 600 && (i < 120 || seen.refused === 0); i++) {
      let got; try { got = port(); } catch { seen.refused++; continue; }
      if (got === null) seen.none++; else seen.text++;
    }
    // Before L763 the hard-link check came after the open, and 44 of 400 reads got the victim's text.
    assert.equal(seen.text, 0, `planted: a reader without the owner check reads the victim's text (${JSON.stringify(seen)})`);
    assert.ok(seen.refused > 0, `the race ran: some reads saw the link (${JSON.stringify(seen)})`);
  } finally { atk.kill('SIGKILL'); }
});

// ---- reviewEnded ----

function endedRecord(root, sid, over = {}) {
  const dir = join(root, ENDED_FOLDER);
  mkdirSync(dir, { mode: 0o755, recursive: true }); chmodSync(dir, 0o755);
  const at = new Date().toISOString();
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify({ session_id: sid, role: 'reviewer', card: 'C-1', head: HEAD, launched_at: at, request_id: `q-${sid}`, ended_at: at, verdict_sha256: 'none', how: 'ended', ...over }), { mode: 0o644 });
  chmodSync(join(dir, `${sid}.json`), 0o644);
}
const session = (sid) => ({ sessionId: sid, role: 'reviewer', card: 'C-1', head: HEAD });

test('C (L739): reviewEnded is the runner\'s own ended record for the session\'s role, card and head', () => {
  const w = mirrorWorld();
  const ended = reviewEndedPort({ root: w.config.reviewRoot, uid: ME });
  const none = ended(session('R-1'));
  assert.deepEqual([none.ok, none.none], [false, true], 'no ended folder yet: not ended');
  endedRecord(w.config.reviewRoot, 'R-1');
  const r = ended(session('R-1'));
  assert.equal(r.ok, true, `planted: an answer that never reads the record fails here (${r.reason})`);
  assert.equal(r.ended.verdict_sha256, 'none');
  assert.match(ended({ ...session('R-1'), head: 'b'.repeat(40) }).reason, /is for another role, card or head/);
  assert.equal(ended(session('R-2')).none, true);
  // Through workerPorts, from the config keys.
  assert.equal(workerPorts(w.ctx).reviewEnded(session('R-1')).ok, true);
  // The review user is the config's reviewUid, not the Dispatcher's own.
  assert.match(workerPorts({ ...w.ctx, config: { ...w.config, reviewUid: ME + 1 } }).reviewEnded(session('R-1')).reason, /the review runner's folder \(reviewRoot\) .* is not owned by the review user/);
});

test('C (L739): a runner folder that is gone, a link or not the review user\'s is a refusal, never "not ended yet"', () => {
  const w = mirrorWorld();
  endedRecord(w.config.reviewRoot, 'R-1');
  const gone = reviewEndedPort({ root: join(w.base, 'nope'), uid: ME })(session('R-1'));
  assert.equal(gone.ok, false); assert.notEqual(gone.none, true, 'M9 would read a missing ended folder as "not ended"');
  assert.match(gone.reason, /the review runner's folder \(reviewRoot\) .*nope can't be read \(ENOENT\)/);
  assert.match(reviewEndedPort({ root: w.config.reviewRoot, uid: ME + 1 })(session('R-1')).reason, /the review runner's folder \(reviewRoot\) .* is not owned by the review user/);
  symlinkSync(w.config.reviewRoot, join(w.base, 'runner-link'));
  assert.match(reviewEndedPort({ root: join(w.base, 'runner-link'), uid: ME })(session('R-1')).reason, /is not a plain folder/);
  // At start: a runner folder that is not there stops it.
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, reviewRoot: join(w.base, 'nope') } }), /the review runner's folder \(reviewRoot\) .* can't be read/);
  // A real folder that is not the runner's (no launch records folder) would read as "not ended" for ever: it stops the start.
  mkdirSync(join(w.base, 'not-runner'));
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, reviewRoot: join(w.base, 'not-runner') } }), /has no launches folder, so it is not the runner's/);
});

// ---- B (L925, L927, L933): the worker runner's sync ports, and the review runner's sessions beside them ----

// The runner's status, stood in for (owner-status.test.mjs reads the real files): the owner's folder and file, fresh.
const OWNER = ME + 2; const T = Date.parse('2026-11-10T12:00:00Z');
const fakeSt = ({ uid = OWNER, dir = false, link = false } = {}) => ({ uid, mode: dir ? 0o755 : 0o644, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => link });
const SIZE = { tokens: 9, compactions: 0, turnEnded: true, endedAt: null, openTools: [] };
function syncWorld({ sessions, requests, review = { running: [] }, rec = { read: () => null }, folder = fakeSt({ dir: true }), statusText } = {}) {
  const w = mirrorWorld();
  const c = w.config;
  const row = (id, product, more = {}) => ({ id, product, kind: 'editing', card: 'C-7', lead: null, role: 'worker', pgid: 70, signin: 's', config_dir: '/cfg', bundle_files: [],
    outbox: join(c.outboxRoot, product, 'worker', id), uid: OWNER, alive: true, ended: false, outbox_open: true, stop_requested: false, size: SIZE, activity: { state: 'active' }, ...more });
  const list = typeof sessions === 'function' ? sessions(row) : sessions ?? [row('S-1', P), row('S-9', 'other-app')];
  const doc = { written_at: new Date(T - 5000).toISOString(), sessions: list, requests: requests ?? Object.fromEntries(list.map((x) => [x.id, { state: 'started' }])) };
  const writes = [];
  const io = {
    stat: (p) => { if (p === join(c.workerStatusFile, '..')) return fakeSt({ dir: true }); return fakeSt({ dir: true }); },
    open: () => ({ st: fakeSt(), text: statusText ?? JSON.stringify(doc) }),
    realpath: (p) => p,
    lstat: (p) => { assert.equal(p, c.workerRequestsDir); return folder; },
    writeFile: (path, text) => writes.push([path, text]),
    reviewStatus: typeof review === 'function' ? review : () => review,
  };
  return { c, io, row, writes, ports: runnerSyncPorts({ config: c, rec, now: () => T }, io) };
}

test('L925 rule 1: sessions() is every product\'s worker sessions and the review runner\'s reviewers and auditors, or a throw, never a half', () => {
  const rv = { running: [{ card: 'C-7', head: HEAD, role: 'reviewer', session_id: 'R-1', pid: 1, started_at: 't' }, { card: 'C-8', head: HEAD, role: 'auditor', session_id: 'A-1', pid: 2, started_at: 't' },
    { card: 'C-9', fingerprint: 'f', request_id: 'q', role: 'plan_reviewer', session_id: 'P-1', pid: 3, started_at: 't' }] };
  const { ports } = syncWorld({ review: rv });
  assert.deepEqual(ports.sessions().map((x) => [x.id, x.product, x.kind]), [['S-1', P, 'editing'], ['S-9', 'other-app', 'editing'], ['R-1', null, 'review'], ['A-1', null, 'audit']],
    'Mac-wide (another product\'s too), and the plan reviewer left out: planReviewsRunning counts it');
  assert.deepEqual(ports.sessions()[2], { id: 'R-1', product: null, kind: 'review', card: 'C-7', lead: null, role: 'reviewer', pgid: null, signin: null, config_dir: null, bundle_files: [] });
  assert.deepEqual({ ...REVIEW_KIND_OF }, { reviewer: 'review', auditor: 'audit' });
  // Either status not known: the whole list is not known.
  assert.throws(() => syncWorld({ review: () => { throw new Error('the review runner\'s status is missing'); } }).ports.sessions(), /review runner's status is missing/);
  assert.throws(() => syncWorld({ statusText: '{' }).ports.sessions(), /worker runner's status can't be read/);
  // One entry the review runner does not write: not known either, never the entries that could be read.
  for (const [bad, re] of [[null, /not what the runner writes/], [{ role: 'worker', session_id: 'X', card: 'C' }, /role "worker", which the review runner does not start/],
    [{ role: 'reviewer', card: 'C' }, /no session id/], [{ role: 'auditor', session_id: 'A-2' }, /A-2 .* has no card/]]) {
    assert.throws(() => syncWorld({ review: { running: [rv.running[0], bad] } }).ports.sessions(), re, JSON.stringify(bad));
  }
  assert.deepEqual(reviewSessions({ running: [] }), []);
  // The review runner's memory can't be read: it lists none running, but some may be. Not known (self-review m2).
  assert.ok(readFileSync(new URL('../modules/M4-workshop/launcher/review-runner.mjs', import.meta.url), 'utf8').includes(`hold('${REVIEW_STATE_CORRUPT}',`), 'the id the review runner lists');
  assert.throws(() => syncWorld({ review: { running: [], holds: [{ id: 'state-corrupt', text: 'x' }] } }).ports.sessions(), /can't read its own memory/);
  assert.deepEqual(reviewSessions({ running: [], holds: [{ id: 'other', text: 'x' }] }), [], 'another hold is not this');
});

test('L925 rule 2: probe answers for the kinds the worker runner starts; a review, audit or any other kind throws', () => {
  const { ports } = syncWorld();
  assert.deepEqual(ports.probe({ id: 'S-1', kind: 'editing' }), { size: SIZE, activity: { state: 'active' } });
  assert.throws(() => ports.probe({ id: 'R-1', kind: 'review', role: 'reviewer' }), /R-1 is the review runner's, which reports no size or activity/);
  assert.throws(() => ports.probe({ id: 'A-1', kind: 'audit', role: 'auditor' }), /review runner's/);
  for (const kind of ['lead', 'readonly', 'merge', 'front_door', undefined]) assert.throws(() => ports.probe({ id: 'X-1', kind }), /no runner here reports on a/, String(kind));
  // A worker kind the runner has no row for is its own throw, never a stand-in answer.
  assert.throws(() => ports.probe({ id: 'S-404', kind: 'editing' }), /S-404 is not in the worker runner's status/);
});

test('L927: the board and the outboxes are this product\'s only, by the product the status names; holds reads this Record\'s claim', () => {
  const held = { read: (e, id) => (id === 'C-7' ? { doc: { state: 'running', claim: { kind: 'session', session_id: 'S-2' } } } : null) };
  const dead = { alive: false, ended: true };
  const ws = syncWorld({ rec: held, sessions: (row) => [row('S-1', P), row('S-2', P, dead), row('S-9', 'other-app'), row('S-8', 'other-app', dead)], requests: { 'S-1': { state: 'started' }, 'S-2': { state: 'stopped' }, 'S-9': { state: 'started' }, 'S-8': { state: 'stopped' } } });
  assert.deepEqual(ws.ports.board().map((r) => r.id), ['S-1', 'S-2'], 'S-9 runs, and S-8\'s C-7 reads as held here: neither is this product\'s');
  assert.deepEqual(ws.ports.outboxSessions().map((x) => x.sessionId), ['S-1', 'S-2']);
  // recordHolds: the card's claim, by session; missing is false; corrupt or a failed read throws.
  const h = recordHolds(held);
  assert.equal(h({ card: 'C-7', sessionId: 'S-2' }), true);
  assert.equal(h({ card: 'C-7', sessionId: 'S-3' }), false, 'another session\'s claim');
  assert.equal(h({ card: 'C-404', sessionId: 'S-2' }), false, 'not in the Record');
  for (const doc of [{ state: 'waiting', claim: { kind: 'session', session_id: 'S-2' } }, { state: 'running', claim: { kind: 'tab', claim_id: 'S-2' } }]) assert.equal(recordHolds({ read: () => ({ doc }) })({ card: 'C', sessionId: 'S-2' }), false, JSON.stringify(doc));
  assert.throws(() => recordHolds({ read: () => ({ corrupt: true, reason: 'document changed outside the Store Writer' }) })({ card: 'C', sessionId: 'S' }), /can't be read from the Record \(document changed/);
  assert.throws(() => recordHolds({ read: () => { throw new Error('store gone'); } })({ card: 'C', sessionId: 'S' }), /store gone/);
});

test('L925: stopSession writes its stop request into the runner\'s requests folder, only while that folder is the owner\'s plain folder', () => {
  const used = syncWorld({ requests: { 'S-1': { state: 'started' }, 'S-9': { state: 'started' }, 'S-5': { state: 'stopped' } } });
  assert.equal(used.ports.stopSession('S-5'), true, 'used up and nothing listed: gone');
  assert.deepEqual(used.writes, []);
  assert.equal(used.ports.stopSession('S-1'), false);
  assert.deepEqual(used.writes, [[join(used.c.workerRequestsDir, 'stop-S-1.json'), '{"stop":"S-1"}\n']]);
  for (const [folder, re] of [[fakeSt({ dir: true, uid: ME }), /is not the owner's \(workerUid\)/], [fakeSt({ dir: true, link: true }), /is not a plain folder/], [fakeSt(), /is not a plain folder/]]) {
    const w = syncWorld({ folder });
    assert.throws(() => w.ports.stopSession('S-1'), re);
    assert.deepEqual(w.writes, [], 'nothing written');
  }
  assert.match(requestsFolderProblem('/nope/requests', OWNER), /can't be read \(ENOENT\)/);
});

test('L925, L896: the worker runner is the owner\'s user and its requests folder is there, or the start is refused; the ports are wired', () => {
  const w = mirrorWorld();
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, workerUid: ME + 9 } }), /workerUid must be the owner's Mac user id, hostLockUid's/);
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, workerUid: undefined } }), /workerUid must be/);
  assert.throws(() => workerPorts({ ...w.ctx, config: { ...w.config, workerRequestsDir: join(w.base, 'nope') } }), /requests folder \(workerRequestsDir\) .*nope can't be read \(ENOENT\)/);
  const ports = workerPorts(w.ctx);
  assert.equal(ports.product, P, 'the stop step\'s product is the config\'s (L927)');
  for (const k of ['sessions', 'board', 'outboxSessions', 'probe', 'stopSession']) assert.equal(typeof ports[k], 'function', k);
  // The real reads: this test's runner folder is this user's, not the owner's, so the status is never trusted.
  assert.throws(() => ports.sessions(), /the worker runner's folder is not owned by the owner's user/);
});
