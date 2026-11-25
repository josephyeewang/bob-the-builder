// The lead-main export (Track A step 8 G1, L1370): the Lead's read-only copy of main, swapped in whole, and the heads it gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { recWith, T0 } from './fixtures.test-helper.mjs';
import { HEAD_FILE, KEEP_HEADS, LEAD_MAIN_FACT, copyHead, exportMain, exportedHead, leadMainStep, noteExported } from './lead-main.mjs';
import { leadMainRootProblem, untarInto } from '../../wiring/worker-ports.mjs';

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
  for (const n of [`.tmp-${P}-abc`, `.old-${P}-123`, '.tmp-other-abc']) { mkdirSync(join(w.root, n)); writeFileSync(join(w.root, n, HEAD_FILE), 'x'); }
  await w.run();
  assert.deepEqual(readdirSync(w.root).sort(), ['.tmp-other-abc', P]);
});

test('L1370: main that can\'t be read, or an archive that fails, changes nothing and says why', async () => {
  const w = world();
  await assert.rejects(w.run({ git: async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: 'fatal: bad ref' }) }), /could not read main in the mirror \(fatal: bad ref\)/);
  await assert.rejects(w.run({ git: async () => ({ code: 0, stdout: Buffer.from('not-a-sha\n'), stderr: '' }) }), /could not read main/);
  const archiveFails = async (args) => (args[0] === 'archive' ? { code: 1, stdout: Buffer.alloc(0), stderr: 'no' } : w.git(args));
  await assert.rejects(w.run({ git: archiveFails }), /git archive of [0-9a-f]{12} failed \(no\)/);
  assert.deepEqual(readdirSync(w.root), []);
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
