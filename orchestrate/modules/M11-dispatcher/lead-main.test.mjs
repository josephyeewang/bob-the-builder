// The lead-main export (Track A step 8 G1, L1370): the Lead's read-only copy of main, swapped in whole, and the heads it gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { recWith, T0 } from './fixtures.test-helper.mjs';
import { HEAD_FILE, KEEP_HEADS, LEAD_MAIN_FACT, OLD, TEMP, copyHead, exportMain, exportedHead, leadMainStep, noteExported } from './lead-main.mjs';
import { UNTAR_ARGS, leadMainRootProblem, untarInto } from '../../wiring/worker-ports.mjs';
import { PRODUCT } from '../../shared/product-paths.mjs';
import { git as safeGit } from '../M4-workshop/git/safe-git.mjs';

const P = 'sample-app';
const ME = process.getuid();

// A plain git call for setting up the test's repositories (not the code under test).
function g(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare mirror with main at a first commit (a.txt, run.sh runnable, d/e.txt), a work folder to move main on, and the root.
function world() {
  const base = tempDir('m11-lead-main-');
  chmodSync(base, 0o755);
  const work = join(base, 'work');
  mkdirSync(work);
  g(work, 'init', '-q', '-b', 'main');
  g(work, 'config', 'user.name', 't'); g(work, 'config', 'user.email', 't@localhost');
  writeFileSync(join(work, 'a.txt'), 'one\n');
  writeFileSync(join(work, 'run.sh'), '#!/bin/sh\n'); chmodSync(join(work, 'run.sh'), 0o755);
  mkdirSync(join(work, 'd')); writeFileSync(join(work, 'd', 'e.txt'), 'e\n');
  g(work, 'add', '.'); g(work, 'commit', '-q', '-m', 'one');
  const mirror = join(base, 'mirror');
  g(base, 'clone', '-q', '--bare', work, mirror);
  const root = join(base, 'lead-main');
  mkdirSync(root); chmodSync(root, 0o755);
  const git = async (args) => {
    const r = spawnSync('git', ['--git-dir', mirror, ...args], { env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, stdout: r.stdout, stderr: String(r.stderr) };
  };
  // A new commit on main: a.txt changed, d/ removed, f.txt added; pushed to the mirror.
  const move = (text = 'two\n') => {
    writeFileSync(join(work, 'a.txt'), text);
    g(work, 'rm', '-q', '-r', '--ignore-unmatch', 'd');
    writeFileSync(join(work, 'f.txt'), text);
    g(work, 'add', '.'); g(work, 'commit', '-q', '-m', text.trim());
    g(work, 'push', '-q', mirror, 'main:main');
    return g(work, 'rev-parse', 'HEAD');
  };
  const dest = join(root, P);
  return { base, work, mirror, root, dest, git, move, main: () => g(work, 'rev-parse', 'HEAD'), run: (over = {}) => exportMain({ root, product: P, git, untar: untarInto, ...over }) };
}

const modeOf = (p) => lstatSync(p).mode & 0o777;
const withUmask = async (u, f) => { const was = process.umask(u); try { return await f(); } finally { process.umask(was); } };

test('L1370: the export makes <root>/<product> main\'s files with .head = main, readable by others and writable by none, whatever the umask', async () => {
  const w = world();
  const r = await withUmask(0o077, () => w.run());
  assert.deepEqual(r, { head: w.main(), changed: true });
  assert.equal(readFileSync(join(w.dest, HEAD_FILE), 'utf8'), `${w.main()}\n`);
  assert.equal(copyHead(w.dest), w.main());
  assert.equal(readFileSync(join(w.dest, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(join(w.dest, 'd', 'e.txt'), 'utf8'), 'e\n');
  // The Dispatcher job's umask is 63 (0o077): without the modes set, the owner could read none of it.
  assert.equal(modeOf(w.dest), 0o755);
  assert.equal(modeOf(join(w.dest, 'd')), 0o755);
  assert.equal(modeOf(join(w.dest, 'a.txt')), 0o644);
  assert.equal(modeOf(join(w.dest, 'd', 'e.txt')), 0o644);
  assert.equal(modeOf(join(w.dest, 'run.sh')), 0o755, 'a runnable file stays runnable');
  assert.equal(modeOf(join(w.dest, HEAD_FILE)), 0o644);
  assert.deepEqual(readdirSync(w.root), [P], 'no temp or old folder is left');
});

test('L1370: main unmoved leaves the copy as it is; main moved swaps in a whole new copy, and the old files go', async () => {
  const w = world();
  const first = (await w.run()).head;
  const ino = lstatSync(w.dest).ino;
  assert.deepEqual(await w.run(), { head: first, changed: false });
  assert.equal(lstatSync(w.dest).ino, ino, 'not written again');
  const second = w.move();
  assert.deepEqual(await w.run(), { head: second, changed: true });
  assert.equal(copyHead(w.dest), second);
  assert.equal(readFileSync(join(w.dest, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(join(w.dest, 'd')), false, 'a file main dropped is not kept');
  assert.equal(readFileSync(join(w.dest, 'f.txt'), 'utf8'), 'two\n');
  assert.deepEqual(readdirSync(w.root), [P]);
});

test('L1370: a half-written copy is never seen at <product>, nor with a .head beside it; a failed unpack keeps the copy that was there', async () => {
  const w = world();
  const first = (await w.run()).head;
  const second = w.move();
  const seen = [];
  // Mid-unpack: some files written, then the unpack fails. What a reader sees at <product> meanwhile is the old copy, whole.
  const untar = async (tar, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'half');
    seen.push({ head: copyHead(w.dest), a: readFileSync(join(w.dest, 'a.txt'), 'utf8'), tempHead: existsSync(join(dir, HEAD_FILE)) });
    throw new Error('disk full');
  };
  await assert.rejects(w.run({ untar }), /disk full/);
  assert.deepEqual(seen, [{ head: first, a: 'one\n', tempHead: false }]);
  assert.equal(copyHead(w.dest), first, 'the copy that was there stays');
  assert.equal(readFileSync(join(w.dest, 'a.txt'), 'utf8'), 'one\n');
  assert.deepEqual(readdirSync(w.root), [P], 'the temp folder is deleted');
  // With no copy before, a failed unpack leaves no <product> folder at all, so no .head names a tree that isn't whole.
  const v = world();
  await assert.rejects(v.run({ untar }), /disk full/);
  assert.deepEqual(readdirSync(v.root), []);
  // And the next pass makes it.
  assert.deepEqual(await w.run(), { head: second, changed: true });
});

test('L1370: a temp or old folder a stopped pass left is deleted on the next pass; another product\'s is not touched', async () => {
  const w = world();
  for (const n of [`${TEMP(P)}abc`, `${OLD(P)}123`, `${TEMP('other')}abc`]) { mkdirSync(join(w.root, n)); writeFileSync(join(w.root, n, HEAD_FILE), 'x'); }
  await w.run();
  assert.deepEqual(readdirSync(w.root).sort(), [`${TEMP('other')}abc`, P]);
});

test('L1370 audit m1: product alpha\'s cleanup never deletes product alpha-beta\'s temp or old folder', async () => {
  const w = world();
  // alpha-beta's leftovers, by the names its own pass makes them; then alpha's own.
  const theirs = [`${TEMP('alpha-beta')}abc123`, `${OLD('alpha-beta')}1700000000000`];
  const mine = [`${TEMP('alpha')}xyz789`, `${OLD('alpha')}1700000000000`];
  for (const n of [...theirs, ...mine]) mkdirSync(join(w.root, n));
  await exportMain({ root: w.root, product: 'alpha', git: w.git, untar: untarInto });
  assert.deepEqual(readdirSync(w.root).sort(), [...theirs, 'alpha'].sort());
  // The separator is one no product name can hold (shared product-paths.mjs PRODUCT).
  assert.equal(PRODUCT.test('alpha.beta'), false);
  for (const n of ['alpha', 'alpha-beta']) assert.ok(TEMP(n).endsWith(`${n}.`) && OLD(n).endsWith(`${n}.`), n);
});

test('L1370 audit m3: a .head at the top of main fails the export with its cause named, and leaves the copy that was there', async () => {
  const w = world();
  const first = (await w.run()).head;
  writeFileSync(join(w.work, HEAD_FILE), 'mine\n');
  g(w.work, 'add', HEAD_FILE); g(w.work, 'commit', '-q', '-m', 'head file'); g(w.work, 'push', '-q', w.mirror, 'main:main');
  await assert.rejects(w.run(), /main [0-9a-f]{12} has a \.head at its top.*renames or removes it/);
  assert.equal(copyHead(w.dest), first);
  assert.deepEqual(readdirSync(w.root), [P], 'the temp folder is deleted');
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('L1370 audit m2: one budget from until: each git and the tar get what is left, a slow git is stopped by it, and nothing is renamed after it', async () => {
  const w = world();
  await w.run();
  w.move();
  // Each child is handed what is left of the one budget, never more.
  const got = [];
  const watch = async (args, o) => { got.push({ cmd: args[0], ...o }); return w.git(args); };
  const untarWatch = async (tar, dir, o) => { got.push({ cmd: 'tar', ...o }); return untarInto(tar, dir, o); };
  await w.run({ git: watch, untar: untarWatch, until: Date.now() + 3_000 });
  assert.deepEqual(got.map((x) => x.cmd), ['rev-parse', 'archive', 'tar']);
  for (const x of got) assert.ok(x.timeoutMs > 0 && x.timeoutMs <= 3_000, `${x.cmd}: ${x.timeoutMs}`);
  assert.ok(got[1].maxOutBytes > 0, 'the archive is capped');
  // A slow git: the archive hangs until its timeout stops it (as safe-git kills the group), well inside the old 120 s.
  const v = world();
  const kept = (await v.run()).head;
  v.move();
  const slow = async (args, o) => (args[0] === 'archive' ? (await sleep(o.timeoutMs), { code: -1, stdout: Buffer.alloc(0), stderr: `killed at ${o.timeoutMs} ms` }) : v.git(args));
  const s0 = Date.now();
  await assert.rejects(v.run({ git: slow, until: s0 + 300 }), /git archive of [0-9a-f]{12} failed \(killed at/);
  assert.ok(Date.now() - s0 < 2_000, 'it ended by the budget');
  assert.equal(copyHead(v.dest), kept);
  // A slow git that ignores its timeout and answers after the budget: the copy is not swapped in, the old one stays.
  const late = async (args) => { if (args[0] === 'archive') await sleep(400); return v.git(args); };
  await assert.rejects(v.run({ git: late, until: Date.now() + 200 }), /ran out of time before (unpacking|swapping the copy in)/);
  assert.equal(copyHead(v.dest), kept, 'never renamed after the deadline');
  assert.deepEqual(readdirSync(v.root), [P]);
  // Unpacked in time but the budget spent before the swap: still no rename.
  const slowTar = async (tar, dir, o) => { await untarInto(tar, dir, o); await sleep(300); };
  await assert.rejects(v.run({ untar: slowTar, until: Date.now() + 200 }), /ran out of time before swapping the copy in/);
  assert.equal(copyHead(v.dest), kept);
  assert.deepEqual(readdirSync(v.root), [P]);
});

test('L1370 audit m2: a tar that runs past its budget is killed', async () => {
  const base = tempDir('m11-lead-main-tar-');
  const bin = join(base, 'slow-tar.sh');
  writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n'); chmodSync(bin, 0o755);
  const dir = join(base, 'x'); mkdirSync(dir);
  const t0 = Date.now();
  await assert.rejects(untarInto(Buffer.from('x'), dir, { bin, timeoutMs: 200 }), /tar did not end within 200 ms/);
  assert.ok(Date.now() - t0 < 2_000);
});

test('L1370 audit m2: safe-git stops a git whose output passes maxOutBytes, and keeps none of it', async () => {
  const base = tempDir('m11-lead-main-big-');
  const bin = join(base, 'big-git.sh');
  writeFileSync(bin, '#!/bin/sh\nexec /usr/bin/yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'); chmodSync(bin, 0o755);
  const r = await safeGit(['--version'], { gitDir: '/dev/null', gitBin: bin, maxOutBytes: 64 * 1024, timeoutMs: 10_000 });
  assert.equal(r.code, -1);
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr, /git wrote more than 65536 bytes and was stopped/);
});

test('L1370: main that can\'t be read, or an archive that fails, changes nothing and says why', async () => {
  const w = world();
  await assert.rejects(w.run({ git: async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: bad ref' }) }), /could not read main in the mirror \(fatal: bad ref\)/);
  await assert.rejects(w.run({ git: async () => ({ code: 0, stdout: Buffer.from('not-a-sha\n'), stderr: '' }) }), /could not read main/);
  const archiveFails = async (args) => (args[0] === 'archive' ? { code: 1, stdout: Buffer.alloc(0), stderr: 'no' } : w.git(args));
  await assert.rejects(w.run({ git: archiveFails }), /git archive of [0-9a-f]{12} failed \(no\)/);
  assert.deepEqual(readdirSync(w.root), []);
});

test('L1370 audit C1: tar refuses an entry with .. and one through a link the archive made; nothing lands outside', async () => {
  const base = tempDir('m11-lead-main-evil-');
  const T = (...a) => { const r = spawnSync('/usr/bin/tar', a, { cwd: base }); if (r.status !== 0) throw new Error(String(r.stderr)); return r; };
  const outside = join(base, 'outside'); mkdirSync(outside);
  mkdirSync(join(base, 'src')); writeFileSync(join(base, 'src', 'evil.txt'), 'evil\n');
  // ../evil.txt, made with tar's own rename.
  T('-cf', 'dotdot.tar', '-C', join(base, 'src'), '-s', ',^,../,', 'evil.txt');
  // link -> outside, then link/evil.txt: a file written through the link would land in outside.
  mkdirSync(join(base, 'd1')); symlinkSync(outside, join(base, 'd1', 'link'));
  mkdirSync(join(base, 'd2', 'link'), { recursive: true }); writeFileSync(join(base, 'd2', 'link', 'evil.txt'), 'evil\n');
  T('-cf', 'sym.tar', '-C', join(base, 'd1'), 'link', '-C', join(base, 'd2'), 'link/evil.txt');
  for (const [name, why] of [['dotdot.tar', /Path contains '\.\.'/], ['sym.tar', /through symlink/]]) {
    const dir = join(base, `x-${name}`); mkdirSync(dir);
    await assert.rejects(untarInto(readFileSync(join(base, name)), dir), why, name);
    assert.deepEqual(readdirSync(outside), [], `${name}: nothing outside`);
    assert.equal(existsSync(join(base, 'evil.txt')), false, `${name}: nothing beside the folder`);
  }
  // The flags that keep extended attributes, access lists and file flags off the copy are passed; -P never is.
  for (const f of ['--no-xattrs', '--no-acls', '--no-fflags']) assert.ok(UNTAR_ARGS.includes(f), f);
  assert.equal(UNTAR_ARGS.includes('-P'), false);
});

test('L1370: the system tar unpacks the archive; a broken archive is refused', async () => {
  const w = world();
  const a = await w.git(['archive', '--format=tar', 'main']);
  const dir = join(w.base, 'x'); mkdirSync(dir);
  await untarInto(a.stdout, dir);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\n');
  const bad = join(w.base, 'y'); mkdirSync(bad);
  await assert.rejects(untarInto(Buffer.from('not a tar archive at all'.repeat(40)), bad), /tar failed/);
});

test('L1370: the root must be a plain folder of this job\'s, that others read and none but it writes', () => {
  const w = world();
  assert.equal(leadMainRootProblem(w.root, ME), null);
  assert.match(leadMainRootProblem(w.root, ME + 1), /belongs to uid/);
  assert.match(leadMainRootProblem(join(w.base, 'nope'), ME), /can't be read \(ENOENT\)/);
  const link = join(w.base, 'link'); symlinkSync(w.root, link);
  assert.match(leadMainRootProblem(link, ME), /not a plain folder/);
  chmodSync(w.root, 0o775);
  assert.match(leadMainRootProblem(w.root, ME), /can be written by others \(mode 775\)/);
  chmodSync(w.root, 0o750);
  assert.match(leadMainRootProblem(w.root, ME), /can't be read by the owner \(mode 750\)/);
  chmodSync(w.root, 0o755);
});

const sha = (n) => n.toString(16).padStart(40, '0');

test('L1370: the exported heads are kept newest first, the last KEEP_HEADS only; exportedHead answers for an earlier one', () => {
  const rec = recWith();
  assert.equal(KEEP_HEADS, 5);
  assert.deepEqual(exportedHead(rec, { head: sha(1), product: P }), { ok: false, reason: `no lead-main export has been noted for ${P}` });
  for (let i = 1; i <= 7; i += 1) noteExported(rec, { product: P, head: sha(i), now: T0 + i });
  const doc = rec.read('fact', LEAD_MAIN_FACT(P)).doc;
  assert.deepEqual(doc.heads, [7, 6, 5, 4, 3].map(sha));
  assert.equal(doc.product, P);
  assert.deepEqual(noteExported(rec, { product: P, head: sha(7), now: T0 + 9 }), { ok: true, unchanged: true }, 'the same head again writes nothing');
  // A head exported again moves to the front, once.
  noteExported(rec, { product: P, head: sha(4), now: T0 + 10 });
  assert.deepEqual(rec.read('fact', LEAD_MAIN_FACT(P)).doc.heads, [4, 7, 6, 5, 3].map(sha));
  assert.deepEqual(exportedHead(rec, { head: sha(3), product: P }), { ok: true }, 'an earlier head still answers');
  assert.equal(exportedHead(rec, { head: sha(2), product: P }).ok, false, 'one past the kept number does not');
  assert.match(exportedHead(rec, { head: sha(2), product: P }).reason, /not one of the last 5 heads/);
  assert.equal(exportedHead(rec, { head: sha(4), product: 'other-app' }).ok, false, 'another product\'s heads are its own');
  assert.equal(exportedHead(rec, {}).ok, false);
});

test('L1370: exportedHead counts only the Dispatcher\'s own fact', () => {
  const rec = recWith();
  noteExported(rec, { product: P, head: sha(1), now: T0 });
  const as = (createdBy) => ({ read: (e, id) => rec.read(e, id), meta: () => ({ createdBy }) });
  assert.deepEqual(exportedHead(as('dispatcher'), { head: sha(1), product: P }), { ok: true });
  assert.match(exportedHead(as('sensors'), { head: sha(1), product: P }).reason, /not the Dispatcher's own/);
  assert.match(exportedHead({ read: (e, id) => rec.read(e, id) }, { head: sha(1), product: P }).reason, /not the Dispatcher's own/, 'no writer known is no');
});

test('L1370: the step exports, then notes the head; a head whose note failed is noted on the next pass', async () => {
  const w = world();
  const rec = recWith();
  const leadMain = { product: P, exportMain: () => w.run() };
  const r = await leadMainStep({ rec, now: T0, leadMain });
  assert.equal(r.changed, true);
  assert.deepEqual(rec.read('fact', LEAD_MAIN_FACT(P)).doc.heads, [w.main()]);
  // The copy is in place but the note was lost: the next pass, main unmoved, notes it.
  const fresh = recWith();
  const again = await leadMainStep({ rec: fresh, now: T0 + 60_000, leadMain });
  assert.equal(again.changed, false);
  assert.deepEqual(exportedHead(fresh, { head: w.main(), product: P }), { ok: true });
  // An export that fails notes nothing.
  const none = recWith();
  await assert.rejects(leadMainStep({ rec: none, now: T0, leadMain: { product: P, exportMain: async () => { throw new Error('no'); } } }), /no/);
  assert.equal(none.read('fact', LEAD_MAIN_FACT(P)), null);
});
