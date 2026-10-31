// Item 19: the updater, against real git. A local bare repository stands in for GitHub: its main holds an orchestrate
// folder, its HEAD points at another branch (`evil`), and it has a tag. The installed copy, the clone and the seed are
// throwaway folders; `owner` is this test's own uid and `top` the test folder, standing in for root and `/`. Every git
// call goes through safe-git (no prompts, no askpass, fixed environment), and only to local paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, lstatSync, chmodSync, symlinkSync, renameSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { gitOk, callLog } from '../git/safe-git.mjs';
import { STAMP, SCRIPTS, NODE, UPDATER_CONFIG, UPDATE_EVERY_S, updaterPlist } from './review-daemons.mjs';
import { updateOnce, writeNew, recoverSwap, parseTree, parseBatch, chainProblem, readUpdaterConfig, main, MAIN } from './review-updater.mjs';

const ME = process.getuid();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const KEEP = ['bin', 'config.json', UPDATER_CONFIG];

async function world() {
  const root = realpathSync(tempDir('m4-updater-'));
  const origin = join(root, 'origin.git');
  await gitOk(['init', '--bare', '-q', origin], { gitDir: origin });
  const seed = join(root, 'seed');
  mkdirSync(seed);
  const sg = { gitDir: join(seed, '.git'), workTree: seed, cwd: seed, extraConfig: ID };
  await gitOk(['init', '-q', seed], sg);
  const put = (rel, text, mode) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); writeFileSync(join(seed, rel), text); if (mode) chmodSync(join(seed, rel), mode); };
  const marker = join(root, 'ran-a-repo-script');
  put('README.md', 'outside the folder\n');
  put('orchestrate/a.txt', 'one\n');
  put('orchestrate/gone.txt', 'goes later\n');
  put('orchestrate/tools/run.sh', '#!/bin/sh\necho run\n', 0o755);
  put(`orchestrate/${SCRIPTS.updater}`, '// the updater, as the copy holds it\n');
  put('orchestrate/install.sh', `#!/bin/sh\ntouch ${marker}\n`, 0o755);
  const commit = async (msg) => { await gitOk(['add', '-A'], sg); await gitOk(['commit', '-q', '-m', msg], sg); return (await gitOk(['rev-parse', 'HEAD'], sg)).trim(); };
  const push = (ref) => gitOk(['push', '-q', '-f', origin, `HEAD:${ref}`], sg);
  const main1 = await commit('first');
  await push(MAIN);
  // Another branch, the remote's HEAD and a tag: none of them may be copied.
  put('orchestrate/evil.txt', 'not main\n');
  await commit('evil');
  await push('refs/heads/evil');
  await push('refs/tags/v-evil');
  await gitOk(['symbolic-ref', 'HEAD', 'refs/heads/evil'], { gitDir: origin });
  await gitOk(['reset', '-q', '--hard', main1], sg);

  // The copy's own items, as the install step's seed holds them.
  const keepSeed = join(root, 'keep-seed');
  mkdirSync(join(keepSeed, 'bin'), { recursive: true });
  writeFileSync(join(keepSeed, NODE), 'a node\n');
  chmodSync(join(keepSeed, NODE), 0o755);
  writeFileSync(join(keepSeed, 'config.json'), '{"runner":true}\n');
  const installRoot = join(root, 'inst', 'orchestrate');
  mkdirSync(dirname(installRoot));
  const c = { installRoot, clone: join(root, 'clone.git'), address: origin, keep: KEEP, gitBin: 'git' };
  writeFileSync(join(keepSeed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const o = { owner: ME, top: root };
  return { root, origin, seed, sg, put, commit, push, main1, marker, keepSeed, installRoot, c, o };
}

/** Every file under `dir` → its text (folders as "dir"), for before-and-after comparisons. */
function snapshot(dir) {
  const out = {};
  const walk = (p) => {
    for (const n of readdirSync(p).sort()) {
      const q = join(p, n);
      const st = lstatSync(q);
      if (st.isDirectory()) { out[q.slice(dir.length)] = 'dir'; walk(q); } else out[q.slice(dir.length)] = `${(st.mode & 0o777).toString(8)} ${readFileSync(q, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}
const leftovers = (w) => readdirSync(dirname(w.installRoot)).filter((n) => n !== basename(w.installRoot));
const stampOf = (w) => readFileSync(join(w.installRoot, STAMP), 'utf8').trim();

test('item 19: the install step copies main\'s orchestrate folder, the copy\'s own items and the stamp, and runs nothing from it', async () => {
  const w = await world();
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.changed, true);
  assert.equal(r.commit, w.main1);
  assert.equal(stampOf(w), w.main1);
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(statSync(join(w.installRoot, 'tools/run.sh')).mode & 0o777, 0o755);
  assert.equal(statSync(join(w.installRoot, 'a.txt')).mode & 0o777, 0o644);
  assert.equal(readFileSync(join(w.installRoot, NODE), 'utf8'), 'a node\n');
  assert.equal(statSync(join(w.installRoot, NODE)).mode & 0o777, 0o755);
  assert.equal(existsSync(join(w.installRoot, 'README.md')), false, 'only the orchestrate folder is copied');
  assert.equal(existsSync(join(w.installRoot, 'evil.txt')), false, 'nothing from another branch, the remote\'s HEAD or a tag');
  assert.equal(existsSync(join(w.installRoot, 'install.sh')), true);
  assert.equal(existsSync(w.marker), false, 'no script from the repository ran');
  assert.deepEqual(leftovers(w), []);
  // Every git call was the updater's own, against its clone.
  const mine = callLog.filter((x) => x.gitDir === w.c.clone);
  assert.ok(mine.length >= 4);
  assert.ok(mine.every((x) => x.purpose.startsWith('updater-')));
  // --first only when there is no copy; a plain run only when there is one.
  assert.match((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).reason, /already an installed copy/);
  const bare = { ...w.c, installRoot: join(w.root, 'inst', 'other') };
  assert.match((await updateOnce(bare, w.o)).reason, /no installed copy; run the install step/);
});

test('item 19: at main already, nothing is touched; when main moves, the copy follows it whole, own items kept', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const before = snapshot(w.installRoot);
  const ino = statSync(w.installRoot).ino;
  const same = await updateOnce(w.c, w.o);
  assert.deepEqual([same.ok, same.changed], [true, false]);
  assert.equal(statSync(w.installRoot).ino, ino);
  assert.deepEqual(snapshot(w.installRoot), before);

  // The copy's own items as they are now in the copy (not the seed) are the ones carried over.
  writeFileSync(join(w.installRoot, 'config.json'), '{"runner":"edited in place"}\n');
  w.put('orchestrate/a.txt', 'two\n');
  rmSync(join(w.seed, 'orchestrate/gone.txt'));
  w.put('orchestrate/new/b.txt', 'b\n');
  const main2 = await w.commit('main moves');
  await w.push(MAIN);
  const r = await updateOnce(w.c, w.o);
  assert.deepEqual([r.ok, r.changed, r.commit], [true, true, main2], r.reason);
  assert.equal(stampOf(w), main2);
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(w.installRoot, 'new/b.txt'), 'utf8'), 'b\n');
  assert.equal(existsSync(join(w.installRoot, 'gone.txt')), false, 'a file main dropped is gone from the copy');
  assert.equal(readFileSync(join(w.installRoot, 'config.json'), 'utf8'), '{"runner":"edited in place"}\n');
  assert.equal(readFileSync(join(w.installRoot, NODE), 'utf8'), 'a node\n');
  assert.equal(existsSync(join(w.installRoot, 'evil.txt')), false);
  assert.equal(existsSync(w.marker), false);
  assert.deepEqual(leftovers(w), [], 'the old copy is removed once the new one is in place');
});

test('item 19 planted: only main is copied, never another branch the remote\'s HEAD points at', async () => {
  const w = await world();
  // main's tip is older than evil's, and the remote's HEAD is evil: a fetch of HEAD, or of every branch, would get it.
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.equal(r.ok, true, r.reason);
  assert.equal(stampOf(w), w.main1);
  assert.equal(existsSync(join(w.installRoot, 'evil.txt')), false);
  const refs = (await gitOk(['for-each-ref', '--format=%(refname)'], { gitDir: w.c.clone })).trim().split('\n');
  assert.deepEqual(refs, [MAIN], 'the clone holds main and nothing else');
});

test('item 19 planted: a hook in the clone is refused before any fetch, so nothing of the repository\'s runs as root', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  mkdirSync(join(w.c.clone, 'hooks'), { recursive: true });
  writeFileSync(join(w.c.clone, 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch ${w.marker}\n`);
  chmodSync(join(w.c.clone, 'hooks', 'reference-transaction'), 0o755);
  w.put('orchestrate/a.txt', 'three\n');
  await w.commit('main moves');
  await w.push(MAIN);
  const before = snapshot(w.installRoot);
  const r = await updateOnce(w.c, w.o);
  assert.equal(r.ok, false);
  assert.match(r.reason, /the clone was refused: mirror has hooks: reference-transaction/);
  assert.equal(existsSync(w.marker), false);
  assert.deepEqual(snapshot(w.installRoot), before);
  // A clone config that names a program is refused the same way.
  rmSync(join(w.c.clone, 'hooks'), { recursive: true });
  writeFileSync(join(w.c.clone, 'config'), `${readFileSync(join(w.c.clone, 'config'), 'utf8')}[core]\n\tfsmonitor = ${join(w.seed, 'orchestrate/install.sh')}\n`);
  assert.match((await updateOnce(w.c, w.o)).reason, /the clone was refused: mirror config differs/);
  assert.equal(existsSync(w.marker), false);
});

test('item 19 planted: a run cut off part way leaves the old copy whole and no half copy anywhere', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  w.put('orchestrate/0-first.txt', 'sorts first\n');
  w.put('orchestrate/a.txt', 'four\n');
  await w.commit('main moves');
  await w.push(MAIN);
  const before = snapshot(w.installRoot);
  let n = 0;
  const write = (file, data, mode) => { if (++n === 3) throw new Error('the disk filled up'); return writeNew(file, data, mode); };
  const r = await updateOnce(w.c, { ...w.o, write });
  assert.equal(r.ok, false);
  assert.match(r.reason, /the new copy was not made \(the disk filled up\); the old one stays/);
  assert.deepEqual(snapshot(w.installRoot), before, 'the copy in place is the old one, untouched');
  assert.deepEqual(leftovers(w), [], 'the part-made folder is removed');
  // The next run finishes the job.
  const again = await updateOnce(w.c, w.o);
  assert.equal(again.ok, true, again.reason);
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'four\n');
});

test('item 19: a new copy with a file others can write is not put in place', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  w.put('orchestrate/a.txt', 'five\n');
  await w.commit('main moves');
  await w.push(MAIN);
  const before = snapshot(w.installRoot);
  const write = (file, data, mode) => writeNew(file, data, file.endsWith('/a.txt') ? 0o666 : mode);
  const r = await updateOnce(w.c, { ...w.o, write });
  assert.match(r.reason, /the new copy is not root's alone: .*a\.txt can be written by others than root/);
  assert.deepEqual(snapshot(w.installRoot), before);
  assert.deepEqual(leftovers(w), []);
});

test('item 19: a run cut off between the two renames is put right on the next run', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const before = snapshot(w.installRoot);
  const fake = 'f'.repeat(40);
  // Cut off after the first rename: the old copy is aside and a complete new one waits. The old one goes back.
  renameSync(w.installRoot, `${w.installRoot}.old-${fake}`);
  mkdirSync(`${w.installRoot}.new-${fake}`);
  writeFileSync(join(`${w.installRoot}.new-${fake}`, STAMP), `${fake}\n`);
  assert.deepEqual(recoverSwap(w.installRoot, { owner: ME }), ['put the old copy back', `removed ${basename(w.installRoot)}.new-${fake}`]);
  assert.deepEqual(snapshot(w.installRoot), before);
  assert.deepEqual(leftovers(w), []);
  // No old copy, and a new one without its stamp (cut off while writing): it is not put in, and is removed.
  const half = `${w.installRoot}.new-${fake}`;
  renameSync(w.installRoot, half);
  rmSync(join(half, STAMP));
  assert.deepEqual(recoverSwap(w.installRoot, { owner: ME }), [`removed ${basename(half)}`]);
  assert.equal(existsSync(w.installRoot), false);
  // A complete new one (its stamp names its own commit) is put in.
  const whole = join(w.root, 'whole');
  assert.equal((await updateOnce({ ...w.c, installRoot: whole }, { ...w.o, first: w.keepSeed })).ok, true);
  renameSync(whole, `${w.installRoot}.new-${w.main1}`);
  assert.deepEqual(recoverSwap(w.installRoot, { owner: ME }), ['put the complete new copy in']);
  assert.equal(stampOf(w), w.main1);
});

test('item 19: a link or a submodule in main\'s folder, or a name that is one of the copy\'s own items, refuses the update', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const before = snapshot(w.installRoot);
  symlinkSync('/etc/passwd', join(w.seed, 'orchestrate/link'));
  await w.commit('a link');
  await w.push(MAIN);
  const r = await updateOnce(w.c, w.o);
  assert.match(r.reason, /orchestrate\/link is a link/);
  assert.deepEqual(snapshot(w.installRoot), before);
  assert.deepEqual(leftovers(w), []);

  const oid = 'a'.repeat(40);
  const line = (mode, type, path) => `${mode} ${type} ${oid}\t${path}\0`;
  assert.match(parseTree(Buffer.from(line('160000', 'commit', 'sub'))).reason, /orchestrate\/sub is a submodule/);
  assert.match(parseTree(Buffer.from(line('100664', 'blob', 'x'))).reason, /has mode 100664/);
  assert.match(parseTree(Buffer.from(line('100644', 'blob', 'a/../b'))).reason, /is not a plain path/);
  assert.match(parseTree(Buffer.from(line('100644', 'blob', 'a/.GIT/config'))).reason, /is not a plain path/);
  assert.match(parseTree(Buffer.from(line('100644', 'blob', 'bin/node')), { keep: ['bin'] }).reason, /orchestrate\/bin has the name of one of the copy's own items/);
  assert.match(parseTree(Buffer.from(line('100644', 'blob', STAMP))).reason, /has the name of one of the copy's own items/);
  assert.match(parseTree(Buffer.alloc(0)).reason, /main holds no orchestrate folder/);
  assert.deepEqual(parseTree(Buffer.from(line('100755', 'blob', 'x/y'))).files, [{ mode: 0o755, oid, path: 'x/y' }]);
});

test('item 19: git\'s answers are checked: each object is the blob asked for, whole, and nothing more', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const ok = Buffer.from(`${a} blob 3\nabc\n${b} blob 0\n\n`);
  const r = parseBatch(ok, [a, b]);
  assert.equal(r.ok, true);
  assert.equal(r.blobs.get(a).toString(), 'abc');
  assert.equal(r.blobs.get(b).length, 0);
  assert.match(parseBatch(Buffer.from(`${b} blob 3\nabc\n`), [a]).reason, /did not give blob/);
  assert.match(parseBatch(Buffer.from(`${a} missing\n`), [a]).reason, /did not give blob/);
  assert.match(parseBatch(Buffer.from(`${a} blob 9\nabc\n`), [a]).reason, /cut short/);
  assert.match(parseBatch(Buffer.from(`${a} blob 3\nabc\nextra`), [a]).reason, /more than was asked/);
  assert.match(parseBatch(Buffer.from(''), [a]).reason, /fewer objects/);
});

test('item 19: a link among the copy\'s own items refuses the update', async () => {
  const w = await world();
  symlinkSync('/etc/hosts', join(w.keepSeed, 'config.json.real'));
  rmSync(join(w.keepSeed, 'config.json'));
  symlinkSync(join(w.keepSeed, 'config.json.real'), join(w.keepSeed, 'config.json'));
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.match(r.reason, /config\.json is a link/);
  assert.equal(existsSync(w.installRoot), false);
  assert.deepEqual(leftovers(w), []);
});

test('item 19: the daemon\'s run checks it is root, and that its config, itself, its node, git and the clone are root\'s alone', async () => {
  const w = await world();
  // A git only the owner can change: a small wrapper in the test folder.
  mkdirSync(join(w.root, 'gitbin'));
  const gitBin = join(w.root, 'gitbin', 'git');
  writeFileSync(gitBin, '#!/bin/sh\nexec git "$@"\n');
  chmodSync(gitBin, 0o755);
  const c = { ...w.c, gitBin };
  writeFileSync(join(w.keepSeed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const lines = [];
  const log = (s) => lines.push(s);
  const o = { ...w.o, log, uid: ME };
  const conf = join(w.installRoot, UPDATER_CONFIG);
  const self = join(w.installRoot, SCRIPTS.updater);

  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG)], { ...o, uid: ME + 1 }), 1);
  assert.match(lines.pop(), /runs as root only/);
  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG), '--first'], o), 1);
  assert.match(lines.pop(), /usage/);
  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG), '--first', w.keepSeed], { ...o, self }), 0, lines.join('\n'));
  assert.match(lines.pop(), /the copy is now at [0-9a-f]{40}/);
  assert.equal(await main([conf], { ...o, self }), 0, lines.join('\n'));

  chmodSync(conf, 0o666);
  assert.equal(await main([conf], { ...o, self }), 1);
  assert.match(lines.pop(), /updater\.json can be written by others than root/);
  chmodSync(conf, 0o644);
  assert.equal(await main([conf], { ...o, self: join(w.root, 'elsewhere.mjs') }), 1);
  assert.match(lines.pop(), /elsewhere\.mjs is not inside the installed copy/);
  chmodSync(gitBin, 0o775);
  assert.equal(await main([conf], { ...o, self }), 1);
  assert.match(lines.pop(), /git: .*gitbin\/git can be written by others than root/);
  chmodSync(gitBin, 0o755);
  chmodSync(join(w.root, 'gitbin'), 0o777);
  assert.equal(await main([conf], { ...o, self }), 1);
  assert.match(lines.pop(), /git: .*gitbin can be written by others than root/);
  chmodSync(join(w.root, 'gitbin'), 0o755);
  chmodSync(w.c.clone, 0o777);
  assert.equal(await main([conf], { ...o, self }), 1);
  assert.match(lines.pop(), /the clone: .*clone\.git can be written by others than root/);
  chmodSync(w.c.clone, 0o755);
  assert.equal(await main([conf], { ...o, self }), 0, lines.join('\n'));
});

test('item 19: the config names absolute paths, an address, the copy\'s own items (its node among them) and git', () => {
  const dir = tempDir('m4-updcfg-');
  const f = join(dir, 'u.json');
  const ok = { installRoot: '/I/o', clone: '/C', address: 'https://github.com/o/r.git', keep: ['bin', 'x.json'], gitBin: '/usr/bin/git' };
  const t = (c) => { writeFileSync(f, JSON.stringify(c)); return () => readUpdaterConfig(f); };
  assert.equal(t(ok)().address, ok.address);
  assert.throws(t({ ...ok, installRoot: 'I' }), /installRoot must be an absolute path/);
  assert.throws(t({ ...ok, clone: '/a/../b' }), /clone must be an absolute path/);
  assert.throws(t({ ...ok, address: 'git@github.com:o/r.git' }), /address must be an https address/);
  assert.throws(t({ ...ok, keep: ['bin', '../x'] }), /keep must list plain top-level names/);
  assert.throws(t({ ...ok, keep: ['bin', STAMP] }), /keep must list plain top-level names/);
  assert.throws(t({ ...ok, keep: ['x.json'] }), /keep must hold bin/);
});

test('item 19: chainProblem walks every folder up to the top', () => {
  const st = (uid, mode, link = false) => ({ uid, mode, isSymbolicLink: () => link });
  const table = { '/a': st(0, 0o40755), '/a/b': st(0, 0o40755), '/a/b/git': st(0, 0o100755), '/': st(0, 0o41777) };
  const lstat = (p) => { if (!table[p]) throw new Error('ENOENT'); return table[p]; };
  assert.equal(chainProblem('/a/b/git', { lstat }), '/ can be written by others than root');
  table['/'] = st(0, 0o40755);
  assert.equal(chainProblem('/a/b/git', { lstat }), null);
  table['/a'] = st(501, 0o40755);
  assert.equal(chainProblem('/a/b/git', { lstat }), '/a is not owned by root');
  assert.equal(chainProblem('/a/b/git', { lstat, top: '/a/b' }), null, 'the walk stops at the top');
  table['/a/b'] = st(0, 0o120755, true);
  assert.equal(chainProblem('/a/b/git', { lstat }), '/a/b is a link');
  assert.equal(chainProblem('/a/b/none', { lstat }), '/a/b/none is missing');
});

test('item 19: the updater\'s LaunchDaemon runs as root every 10 minutes, from the installed copy only', () => {
  const p = updaterPlist({ label: 'org.example.orch', installRoot: '/I/o', logDir: '/L' });
  assert.equal(UPDATE_EVERY_S, 600);
  assert.match(p, /<key>Label<\/key><string>org\.example\.orch\.review-updater<\/string>/);
  assert.doesNotMatch(p, /UserName/, 'root: no user named');
  assert.match(p, new RegExp(`<key>ProgramArguments</key><array><string>/I/o/${NODE}</string><string>/I/o/${SCRIPTS.updater}</string><string>/I/o/${UPDATER_CONFIG}</string></array>`));
  assert.match(p, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>PATH<\/key><string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.throws(() => updaterPlist({ label: 'x y', installRoot: '/I', logDir: '/L' }), /bad job label/);
  assert.throws(() => updaterPlist({ label: 'x', installRoot: 'I', logDir: '/L' }), /installRoot must be an absolute path/);
});
