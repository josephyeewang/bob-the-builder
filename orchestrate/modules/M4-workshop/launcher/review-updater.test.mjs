// Item 19 and L73: the updater, against real git. A local bare repository stands in for GitHub (through the test-only
// `localAddress` option): its main holds an orchestrate folder, its HEAD points at another branch (`evil`), and it has
// a tag. The installed copy, the clone and the seed are throwaway folders; `owner` is this test's own uid and `top` the
// test folder, standing in for root and `/`. Every git call goes through safe-git (no prompts, no askpass, fixed
// environment), and only to local paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, lstatSync, chmodSync, symlinkSync, renameSync, rmSync,
  statSync, realpathSync, readlinkSync, cpSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { gitOk, callLog, ROOT_PATH, safeGitEnv } from '../git/safe-git.mjs';
import { SCRIPTS, UPDATE_EVERY_S, updaterPlist } from './review-daemons.mjs';
import { STAMP, SOURCE, OUTSIDE_FILES, NODE, UPDATER_CONFIG, RUNNER_CONFIG, installProblem, chainProblem, currentCopy, aclProblem, versionName, mainSeenFile, readMainSeen, readInstallStamp,
  nextMainSeen, behindSince, copyReady } from './install-check.mjs';
import { updateOnce, writeNew, leftovers as updaterLeftovers, parseTree, parseBatch, readUpdaterConfig, main, MAIN, PREVIOUS, CLONE_MADE,
  cloneLocks, gitIsRunning, gitToolsProblem, previousCopy, clearLeftovers } from './review-updater.mjs';

const ME = process.getuid();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const KEEP = ['bin', RUNNER_CONFIG, UPDATER_CONFIG];
const GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
const E40 = 'e'.repeat(40);

async function world() {
  const root = realpathSync.native(tempDir('m4-updater-'));
  const origin = join(root, 'origin.git');
  await gitOk(['init', '--bare', '-q', origin], { gitDir: origin });
  const seed = join(root, 'seed');
  mkdirSync(seed);
  const sg = { gitDir: join(seed, '.git'), workTree: seed, cwd: seed, extraConfig: ID };
  await gitOk(['init', '-q', seed], sg);
  const put = (rel, text, mode) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); writeFileSync(join(seed, rel), text); if (mode) chmodSync(join(seed, rel), mode); };
  const marker = join(root, 'ran-a-repo-script');
  put('README.md', 'outside the folder\n');
  // The one outside file the copy's code imports (install-check OUTSIDE_FILES, L92 item 4).
  put('scripts/blueprint/yaml-lite.mjs', 'export const parseYaml = () => ({});\n');
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
  writeFileSync(join(keepSeed, RUNNER_CONFIG), '{"runner":true}\n');
  const installRoot = join(root, 'inst', 'orchestrate');
  mkdirSync(dirname(installRoot));
  const c = { installRoot, clone: join(root, 'clone.git'), address: origin, keep: KEEP, gitBin: GIT };
  writeFileSync(join(keepSeed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const o = { owner: ME, top: root, localAddress: true };
  return { root, origin, seed, sg, put, commit, push, main1, marker, keepSeed, installRoot, c, o };
}

/** For main(), which checks that git is the owner's alone: a small wrapper the test's user owns, noting the PATH it gets. */
function ownGit(w) {
  mkdirSync(join(w.root, 'gitbin'), { recursive: true });
  const gitBin = join(w.root, 'gitbin', 'git');
  writeFileSync(gitBin, `#!/bin/sh\necho "$PATH" >> '${join(w.root, 'path-seen')}'\nexec '${GIT}' "$@"\n`);
  chmodSync(gitBin, 0o755);
  w.c = { ...w.c, gitBin };
  writeFileSync(join(w.keepSeed, UPDATER_CONFIG), `${JSON.stringify(w.c)}\n`);
  return gitBin;
}

/** Every file under `dir` → its text (folders as "dir"), for before-and-after comparisons. */
function snapshot(dir) {
  const out = {};
  const walk = (p) => {
    for (const n of readdirSync(p).sort()) {
      const q = join(p, n);
      const st = lstatSync(q);
      if (st.isDirectory()) { out[q.slice(dir.length)] = 'dir'; walk(q); } else if (st.isSymbolicLink()) out[q.slice(dir.length)] = `link ${readlinkSync(q)}`;
      else out[q.slice(dir.length)] = `${(st.mode & 0o777).toString(8)} ${readFileSync(q, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}
const linkOf = (w) => { try { return readlinkSync(w.installRoot); } catch { return null; } };
const prevOf = (w) => { try { return readlinkSync(`${w.installRoot}${PREVIOUS}`); } catch { return null; } };
/** What a link to the copy names (L92 item 4): `orchestrate` inside the versioned folder, which mirrors the repository. */
const into = (v) => `${v}/${SOURCE}`;
/** The versioned folder a link's target is in. */
const vOf = (to) => (to ? to.split('/')[0] : null);
/**
 * What is beside the copy other than its link, the folder the link names, the link to the copy the last update replaced
 * and that folder (L75 (a)), and root's record of main.
 */
const leftovers = (w) => readdirSync(dirname(w.installRoot)).filter((n) => ![basename(w.installRoot), vOf(linkOf(w)), `${basename(w.installRoot)}${PREVIOUS}`, vOf(prevOf(w)), basename(mainSeenFile(w.installRoot))].includes(n));
// The stamp sits at the top of the versioned folder, beside orchestrate/ and the outside files (L92 item 4).
const stampOf = (w) => readFileSync(join(dirname(w.installRoot), vOf(linkOf(w)), STAMP), 'utf8').trim();
const moveMain = async (w, text) => { w.put('orchestrate/a.txt', text); const m = await w.commit(`main: ${text.trim()}`); await w.push(MAIN); return m; };

test('item 19: the install step copies main\'s orchestrate folder, the copy\'s own items and the stamp, and runs nothing from it', async () => {
  const w = await world();
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.changed, true);
  assert.equal(r.commit, w.main1);
  assert.equal(stampOf(w), w.main1);
  assert.equal(lstatSync(w.installRoot).isSymbolicLink(), true, 'the copy is the link the updater flips');
  assert.equal(linkOf(w), into(versionName(w.installRoot, w.main1)));
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
  assert.equal(installProblem(w.installRoot, [join(w.installRoot, NODE)], { owner: ME, top: w.root }), null);
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
  writeFileSync(join(w.installRoot, RUNNER_CONFIG), '{"runner":"edited in place"}\n');
  w.put('orchestrate/a.txt', 'two\n');
  rmSync(join(w.seed, 'orchestrate/gone.txt'));
  w.put('orchestrate/new/b.txt', 'b\n');
  const main2 = await w.commit('main moves');
  await w.push(MAIN);
  const r = await updateOnce(w.c, w.o);
  assert.deepEqual([r.ok, r.changed, r.commit], [true, true, main2], r.reason);
  assert.equal(stampOf(w), main2);
  assert.equal(linkOf(w), into(versionName(w.installRoot, main2)));
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(w.installRoot, 'new/b.txt'), 'utf8'), 'b\n');
  assert.equal(existsSync(join(w.installRoot, 'gone.txt')), false, 'a file main dropped is gone from the copy');
  assert.equal(readFileSync(join(w.installRoot, RUNNER_CONFIG), 'utf8'), '{"runner":"edited in place"}\n');
  assert.equal(readFileSync(join(w.installRoot, NODE), 'utf8'), 'a node\n');
  assert.equal(existsSync(join(w.installRoot, 'evil.txt')), false);
  assert.equal(existsSync(w.marker), false);
  // L75 (a): the copy it replaced is kept through one more update, named by `.prev`; nothing else is left.
  const first = versionName(w.installRoot, w.main1);
  assert.equal(prevOf(w), into(first));
  assert.equal(readFileSync(join(dirname(w.installRoot), into(first), 'a.txt'), 'utf8'), 'one\n', 'whole, as it was');
  assert.deepEqual(leftovers(w), []);
  const main3 = await moveMain(w, 'three\n');
  const r3 = await updateOnce(w.c, w.o);
  assert.deepEqual([r3.ok, r3.commit], [true, main3], r3.reason);
  assert.equal(prevOf(w), into(versionName(w.installRoot, main2)));
  assert.equal(existsSync(join(dirname(w.installRoot), first)), false, 'the one before it is removed');
  assert.deepEqual(readdirSync(dirname(w.installRoot)).filter((n) => n.startsWith(first)), [], 'the whole versioned folder goes, its outside files too (L92 item 4)');
  assert.deepEqual(leftovers(w), []);
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
  await moveMain(w, 'three\n');
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

test('item 19 planted: a write that fails part way leaves the old copy whole and no half copy anywhere', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  w.put('orchestrate/0-first.txt', 'sorts first\n');
  await moveMain(w, 'four\n');
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
  await moveMain(w, 'five\n');
  const before = snapshot(w.installRoot);
  const write = (file, data, mode) => writeNew(file, data, file.endsWith('/a.txt') ? 0o666 : mode);
  const r = await updateOnce(w.c, { ...w.o, write });
  assert.match(r.reason, /the new copy is not root's alone: .*a\.txt can be written by others than root/);
  assert.deepEqual(snapshot(w.installRoot), before);
  assert.deepEqual(leftovers(w), []);
});

test('L73 point 1: at every step of an update the path launchd starts from names a whole copy, and a run stopped at any step is put right by the next', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const main2 = await moveMain(w, 'six\n');
  const inst = dirname(w.installRoot);
  // launchd's view: the node and the updater's script through installRoot, in a copy root's alone with a good stamp.
  const whole = (where) => {
    assert.equal(lstatSync(w.installRoot).isSymbolicLink(), true, where);
    assert.equal(readFileSync(join(w.installRoot, NODE), 'utf8'), 'a node\n', where);
    assert.equal(existsSync(join(w.installRoot, SCRIPTS.updater)), true, where);
    assert.ok([w.main1, main2].includes(stampOf(w)), where);
    assert.equal(installProblem(w.installRoot, [join(w.installRoot, NODE)], { owner: ME, top: w.root }), null, where);
  };
  // Each image is the disk as a run killed right there would leave it (no clean-up runs).
  const images = [];
  const freeze = (where) => {
    whole(where);
    const d = join(w.root, `image-${images.length}`);
    cpSync(inst, d, { recursive: true, verbatimSymlinks: true });
    // The new versioned folder, as a run killed here leaves it, holds its stamp only once every other file is in it
    // (L106 m-2: a second guard on the stamp being written last, beside L73 point 2's).
    const nv = join(d, versionName(w.installRoot, main2));
    if (existsSync(join(nv, STAMP))) {
      for (const n of [join(SOURCE, NODE), join(SOURCE, 'a.txt'), join(SOURCE, SCRIPTS.updater), join(SOURCE, RUNNER_CONFIG), ...OUTSIDE_FILES]) {
        assert.equal(existsSync(join(nv, n)), true, `${where}: the new copy has its stamp only once ${n} is in it`);
      }
    }
    images.push({ where, d });
  };
  const write = (file, data, mode) => { writeNew(file, data, mode); freeze(`after writing ${basename(file)}`); };
  const r = await updateOnce(w.c, { ...w.o, write, step: (name) => freeze(`after ${name}`) });
  assert.equal(r.ok, true, r.reason);
  whole('at the end');
  const names = images.map((x) => x.where);
  for (const n of ['after cleared', 'after fetching', 'after folder', 'after outside files', `after writing ${STAMP}`, 'after stamped', 'after linked', 'after kept the previous', 'after flipped', 'after removed the older copies', 'after noted']) {
    assert.ok(names.includes(n), `no image ${n}`);
  }
  for (const { where, d } of images) {
    rmSync(inst, { recursive: true, force: true });
    cpSync(d, inst, { recursive: true, verbatimSymlinks: true });
    whole(`restored ${where}`);
    const again = await updateOnce(w.c, w.o);
    assert.equal(again.ok, true, `${where}: ${again.reason}`);
    assert.equal(stampOf(w), main2, where);
    assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'six\n', where);
    assert.deepEqual(leftovers(w), [], where);
  }
});

test('L73 point 2: the stamp is the last file written into a new copy, after every file of main and every own item', async () => {
  const w = await world();
  const order = [];
  const write = (file, data, mode) => {
    order.push(file);
    if (basename(file) === STAMP) {
      for (const n of [...KEEP, NODE, 'a.txt', 'tools/run.sh']) assert.equal(existsSync(join(dirname(file), SOURCE, n)), true, `${n} is there before the stamp`);
      for (const f of OUTSIDE_FILES) assert.equal(existsSync(join(dirname(file), f)), true, `${f} is there before the stamp`);
    }
    return writeNew(file, data, mode);
  };
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed, write });
  assert.equal(r.ok, true, r.reason);
  const folder = join(dirname(w.installRoot), versionName(w.installRoot, w.main1));
  const intoCopy = order.filter((f) => f.startsWith(`${folder}/`));
  assert.ok(intoCopy.length > 3);
  assert.equal(intoCopy.at(-1), join(folder, STAMP), 'nothing is written into the copy after its stamp');
  // L92 item 4: the stamp is at the top of the versioned folder, not inside orchestrate/, and the check reads it there.
  assert.equal(existsSync(join(folder, SOURCE, STAMP)), false);
  assert.equal(readInstallStamp(w.installRoot, { owner: ME }), w.main1);
  assert.ok(intoCopy.some((f) => f === join(folder, OUTSIDE_FILES[0])), 'the outside files are written into the same folder');
});

test('L92 item 4: a copy cut off between the two trees, or before its stamp, is never put in place', async () => {
  for (const cut of ['the first outside file', 'the stamp']) {
    const w = await world();
    assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
    await moveMain(w, 'cut\n');
    const before = snapshot(dirname(w.installRoot));
    const at = (file) => (cut === 'the stamp' ? basename(file) === STAMP : file.endsWith(`/${OUTSIDE_FILES[0]}`));
    const write = (file, data, mode) => { if (at(file)) throw new Error(`cut off at ${cut}`); return writeNew(file, data, mode); };
    const r = await updateOnce(w.c, { ...w.o, write });
    assert.match(r.reason, new RegExp(`the new copy was not made \\(cut off at ${cut}\\); the old one stays`), cut);
    assert.equal(linkOf(w), into(versionName(w.installRoot, w.main1)), cut);
    assert.equal(stampOf(w), w.main1, cut);
    assert.deepEqual(leftovers(w), [], `${cut}: the part-made folder is removed`);
    // Only root's record of main may differ; the copies and links are as they were.
    const now = snapshot(dirname(w.installRoot));
    for (const k of Object.keys({ ...before, ...now })) if (!k.includes(basename(mainSeenFile(w.installRoot)))) assert.equal(now[k], before[k], `${cut}: ${k}`);
  }
});

test('L73 M1 probe A: the clone is never made in a folder others can write, and nothing is written before that check', async () => {
  const w = await world();
  const open = join(w.root, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  const c = { ...w.c, clone: join(open, 'clone.git') };
  const r = await updateOnce(c, { ...w.o, first: w.keepSeed });
  assert.match(r.reason, /the folder of the clone: .*\/open can be written by others than root/);
  assert.equal(existsSync(c.clone), false, 'no git init ran');
  assert.equal(callLog.some((x) => x.gitDir === c.clone), false, 'no git call at all');
  assert.equal(existsSync(w.installRoot), false);
  assert.deepEqual(readdirSync(dirname(w.installRoot)), []);
  // A clone that is a link is refused before git runs in it.
  chmodSync(open, 0o755);
  mkdirSync(join(w.root, 'real-clone'));
  symlinkSync(join(w.root, 'real-clone'), c.clone);
  assert.match((await updateOnce(c, { ...w.o, first: w.keepSeed })).reason, /the clone: .*clone\.git is a link/);
  assert.equal(callLog.some((x) => x.gitDir === c.clone), false);
  assert.deepEqual(readdirSync(join(w.root, 'real-clone')), []);
});

test('L73 M1 probe B: a folder planted beside the copy is never put in place, and a copy that is not root\'s alone is not copied from', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const inst = dirname(w.installRoot);
  const plant = (name) => {
    const d = join(inst, name);
    mkdirSync(join(d, 'bin'), { recursive: true });
    writeFileSync(join(d, NODE), 'EVIL NODE\n');
    for (const n of [RUNNER_CONFIG, UPDATER_CONFIG]) writeFileSync(join(d, n), '{}\n');
    writeFileSync(join(d, STAMP), `${E40}\n`);
    return d;
  };
  // The reviewer's probe: the copy moved away, and an old-style folder and a versioned one planted beside it.
  const away = join(w.root, 'away');
  renameSync(w.installRoot, away);
  const oldStyle = plant(`${basename(w.installRoot)}.old-${E40}`);
  plant(versionName(w.installRoot, E40));
  await moveMain(w, 'seven\n');
  const r = await updateOnce(w.c, w.o);
  assert.match(r.reason, /there is no installed copy; run the install step/);
  assert.equal(existsSync(w.installRoot), false, 'nothing planted was put in place');
  const lines = [];
  const mo = { ...w.o, log: (s) => lines.push(s), uid: ME, self: join(w.installRoot, SCRIPTS.updater) };
  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG)], mo), 1);
  assert.match(lines.pop(), /orchestrate is missing/);
  assert.equal(lines.some((l) => /the copy is now at|put .* back|put .* in/.test(l)), false, lines.join('\n'));
  assert.equal(existsSync(w.installRoot), false);

  // With the copy's link back, the planted versioned folder is removed, never used; the old-style one is not the
  // updater's name and is left alone (and never read).
  renameSync(away, w.installRoot);
  const ok = await updateOnce(w.c, w.o);
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(ok.recovered.includes(`removed ${versionName(w.installRoot, E40)}`));
  assert.equal(readFileSync(join(w.installRoot, NODE), 'utf8'), 'a node\n');
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'seven\n');
  rmSync(oldStyle, { recursive: true });
  assert.deepEqual(leftovers(w), []);

  // A copy whose node others can write is refused before anything is copied from it, or removed beside it (R3).
  chmodSync(join(w.installRoot, NODE), 0o777);
  await moveMain(w, 'eight\n');
  const before = snapshot(w.installRoot);
  const planted = plant(versionName(w.installRoot, E40));
  assert.match((await updateOnce(w.c, w.o)).reason, /the installed copy is not root's alone: .*bin\/node can be written by others than root/);
  assert.deepEqual(snapshot(w.installRoot), before);
  assert.equal(existsSync(planted), true, 'nothing beside the copy is removed before the copy is checked');
  rmSync(planted, { recursive: true });
  assert.deepEqual(leftovers(w), []);
  chmodSync(join(w.installRoot, NODE), 0o755);

  // A link that names anything but a versioned folder beside it is refused.
  const elsewhere = join(w.root, 'elsewhere');
  cpSync(realpathSync.native(w.installRoot), elsewhere, { recursive: true });
  const tmp = join(w.root, 'tmp-link');
  symlinkSync(elsewhere, tmp);
  renameSync(tmp, w.installRoot);
  // A short token, since the path is cut at 200 characters in the message (L75 m-5).
  assert.match((await updateOnce(w.c, w.o)).reason, /orchestrate points at "\/[^"]*", not orchestrate in a copy folder beside it/);
  assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root }), /not orchestrate in a copy folder beside it/);
  // A link that names a sibling by a name that is not a versioned one (K3), or a versioned name that is a file (K2).
  rmSync(w.installRoot);
  cpSync(elsewhere, join(inst, 'elsewhere'), { recursive: true });
  symlinkSync('elsewhere', w.installRoot);
  assert.match(currentCopy(w.installRoot, { owner: ME }).problem, /orchestrate points at "elsewhere", not orchestrate in a copy folder beside it/);
  rmSync(join(inst, 'elsewhere'), { recursive: true });
  rmSync(w.installRoot);
  writeFileSync(join(inst, versionName(w.installRoot, E40)), '');
  symlinkSync(into(versionName(w.installRoot, E40)), w.installRoot);
  assert.match(currentCopy(w.installRoot, { owner: ME }).problem, /is not a folder/);
  rmSync(join(inst, versionName(w.installRoot, E40)));
  rmSync(w.installRoot);
  symlinkSync(elsewhere, w.installRoot);
  // A link of another owner's; a plain folder where the link should be.
  assert.match(currentCopy(w.installRoot, { owner: ME + 1 }).problem, new RegExp(`the copy's link, is not owned by uid ${ME + 1}`));
  rmSync(w.installRoot);
  cpSync(elsewhere, w.installRoot, { recursive: true });
  assert.match((await updateOnce(w.c, w.o)).reason, /orchestrate is a plain folder, not the copy's link the updater flips/);
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'seven\n', 'left as it was');
});

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('L92 item 4: the copy\'s link names exactly <name>.v-<commit>/orchestrate, real folders at every level, and the whole versioned folder is checked', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const inst = dirname(w.installRoot);
  const v = versionName(w.installRoot, w.main1);
  const good = currentCopy(w.installRoot, { owner: ME });
  assert.deepEqual(good, { real: join(inst, v, SOURCE), folder: join(inst, v), link: true, commit: w.main1 });
  const relink = (to) => { rmSync(w.installRoot); symlinkSync(to, w.installRoot); return currentCopy(w.installRoot, { owner: ME }).problem; };
  const SHAPE = /not orchestrate in a copy folder beside it/;
  mkdirSync(join(inst, v, 'other'));
  // The old form (straight to the versioned folder), another subfolder, a deeper path, `..`, `.`, a doubled or
  // trailing slash, an absolute path, a folder that is not a versioned name, a commit not in lower-case hex.
  for (const to of [`${v}/other`, `${v}/${SOURCE}/modules`, `${v}/../${v}/${SOURCE}`, `./${v}/${SOURCE}`, `${v}/./${SOURCE}`, `${v}/${SOURCE}/`,
    `${v}//${SOURCE}`, join(inst, v, SOURCE), `x/${SOURCE}`, `${basename(w.installRoot)}.v-${'E'.repeat(40)}/${SOURCE}`,
    `${v}/${SOURCE}/..`, `${v}x/${SOURCE}`, `../${basename(inst)}/${v}/${SOURCE}`]) {
    assert.match(relink(to) ?? 'accepted', SHAPE, `the link ${to} is refused`);
  }
  // The old form (L106 m-3) has its own message: what it is and what to do.
  assert.match(relink(v) ?? 'accepted', /is an install from before the copy's layout changed/);
  rmSync(join(inst, v, 'other'), { recursive: true });
  // A link at the versioned folder, or at orchestrate inside it, even when the name has the right shape.
  const v2 = versionName(w.installRoot, E40);
  symlinkSync(v, join(inst, v2));
  assert.match(relink(`${v2}/${SOURCE}`) ?? 'accepted', new RegExp(`${esc(v2)}, which .* points into, is not a folder`));
  rmSync(join(inst, v2));
  mkdirSync(join(inst, v2));
  symlinkSync(join(inst, v, SOURCE), join(inst, v2, SOURCE));
  assert.match(relink(`${v2}/${SOURCE}`) ?? 'accepted', new RegExp(`${esc(`${v2}/${SOURCE}`)}, which .* points into, is not a folder`));
  rmSync(join(inst, v2), { recursive: true });
  assert.match(relink(`${v2}/${SOURCE}`) ?? 'accepted', /is missing/);
  relink(`${v}/${SOURCE}`);
  assert.deepEqual(currentCopy(w.installRoot, { owner: ME }), good);
  // Each level must be the owner's: a port reports the versioned folder, then orchestrate in it, as another's.
  for (const p of [join(inst, v), join(inst, v, SOURCE)]) {
    const lstat = (q) => { const st = lstatSync(q); return q === p ? { uid: ME + 1, isSymbolicLink: () => st.isSymbolicLink(), isDirectory: () => st.isDirectory() } : st; };
    assert.match(currentCopy(w.installRoot, { owner: ME, lstat }).problem ?? 'accepted', new RegExp(`${esc(p)}, which .* points into, is not owned by uid ${ME}`));
  }
  // The walk covers the whole versioned folder: the outside files, their folders and the stamp, not just orchestrate/.
  assert.equal(installProblem(w.installRoot, [], { owner: ME, top: w.root }), null);
  for (const f of [OUTSIDE_FILES[0], dirname(OUTSIDE_FILES[0]), STAMP]) {
    const p = join(inst, v, f);
    const was = statSync(p).mode & 0o777;
    chmodSync(p, was | 0o022);
    assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root }) ?? 'passed', new RegExp(`${esc(f)} can be written by others than root`), f);
    chmodSync(p, was);
  }
});

test('L73 M1 probe C: the install step refuses a folder others can write, and a seed that is not root\'s alone', async () => {
  const w = await world();
  ownGit(w);
  const inst = dirname(w.installRoot);
  chmodSync(inst, 0o777);
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.match(r.reason, /the folder of the copy: .*\/inst can be written by others than root/);
  assert.deepEqual(readdirSync(inst), [], 'nothing was written there');
  assert.equal(existsSync(w.c.clone), false);
  const lines = [];
  const mo = { ...w.o, log: (s) => lines.push(s), uid: ME };
  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG), '--first', w.keepSeed], mo), 1);
  assert.match(lines.pop(), /the folder of the copy: .*can be written by others than root/);
  assert.deepEqual(readdirSync(inst), []);
  chmodSync(inst, 0o755);
  // The seed itself: a node others can write, then the seed's folder.
  chmodSync(join(w.keepSeed, NODE), 0o777);
  assert.match((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).reason, /the seed is not root's alone: .*bin\/node can be written by others than root/);
  chmodSync(join(w.keepSeed, NODE), 0o755);
  chmodSync(w.keepSeed, 0o777);
  assert.match((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).reason, /the seed is not root's alone: .*keep-seed can be written by others than root/);
  assert.equal(await main([join(w.keepSeed, UPDATER_CONFIG), '--first', w.keepSeed], mo), 1);
  assert.match(lines.pop(), /the config: .*keep-seed can be written by others than root/);
  assert.deepEqual(readdirSync(inst), []);
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
  symlinkSync('/etc/hosts', join(w.keepSeed, 'review.json.real'));
  rmSync(join(w.keepSeed, RUNNER_CONFIG));
  symlinkSync(join(w.keepSeed, 'review.json.real'), join(w.keepSeed, RUNNER_CONFIG));
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.match(r.reason, /review\.json(\.real)? is a link/);
  assert.equal(existsSync(w.installRoot), false);
  assert.deepEqual(leftovers(w), []);
});

test('item 19, L73 point 6: the daemon\'s run checks it is root, that its config, itself, its node, git and the clone are root\'s alone, and gives git a PATH only root can write', async () => {
  const w = await world();
  // A git only the owner can change: a small wrapper in the test folder, which notes the PATH it was given.
  const gitBin = ownGit(w);
  const pathSeen = join(w.root, 'path-seen');
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
  const paths = readFileSync(pathSeen, 'utf8').trim().split('\n');
  assert.ok(paths.length >= 4);
  assert.deepEqual([...new Set(paths)], [ROOT_PATH], 'every git root ran got root\'s own PATH');
  assert.doesNotMatch(ROOT_PATH, /homebrew|local/);
  assert.equal(safeGitEnv({ path: ROOT_PATH }).PATH, ROOT_PATH);
  assert.match(safeGitEnv().PATH, /homebrew/, 'the workers\' own git calls keep theirs');

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
  // L75 m-3: the git root runs is checked past its own chain too (on a Mac, the developer folder /usr/bin/git hands over to).
  const asked = [];
  assert.equal(await main([conf], { ...o, self, gitTools: (g) => { asked.push(g); return 'the developer folder: a planted problem'; } }), 1);
  assert.match(lines.pop(), /^updater: git: the developer folder: a planted problem$/);
  assert.deepEqual(asked, [gitBin]);
  // A folder on root's PATH that is not root's alone (here: this test's own folder, which is not root's).
  assert.equal(await main([conf], { ...o, self, pathDirs: [join(w.root, 'gitbin')] }), 1);
  assert.match(lines.pop(), /updater: PATH: .*gitbin is not owned by root/);
  // The real run passes no localAddress, so a config naming a local folder is refused.
  assert.equal(await main([conf], { ...o, self, localAddress: false }), 1);
  assert.match(lines.pop(), /address must be an https address/);
});

test('item 19, L73 points 3 and 4: the config names absolute paths, an https address, the copy\'s own items (its node and both configs among them) and git', async () => {
  const dir = tempDir('m4-updcfg-');
  const f = join(dir, 'u.json');
  const ok = { installRoot: '/I/o', clone: '/C', address: 'https://github.com/o/r.git', keep: ['bin', UPDATER_CONFIG, RUNNER_CONFIG, 'x.json'], gitBin: '/usr/bin/git' };
  const t = (c, opts) => { writeFileSync(f, JSON.stringify(c)); return () => readUpdaterConfig(f, opts); };
  assert.equal(t(ok)().address, ok.address);
  assert.throws(t({ ...ok, installRoot: 'I' }), /installRoot must be an absolute path/);
  assert.throws(t({ ...ok, installRoot: '/' }), /installRoot must be an absolute path/);
  assert.throws(t({ ...ok, clone: '/a/../b' }), /clone must be an absolute path/);
  assert.throws(t({ ...ok, address: 'git@github.com:o/r.git' }), /address must be an https address/);
  assert.throws(t({ ...ok, address: 'http://github.com/o/r.git' }), /address must be an https address/);
  assert.throws(t({ ...ok, address: '/srv/origin.git' }), /address must be an https address/, 'a local folder only through the test option');
  assert.throws(t({ ...ok, address: '/srv/origin.git', localAddress: true }), /address must be an https address/, 'no key in the file turns it on');
  assert.equal(t({ ...ok, address: '/srv/origin.git' }, { localAddress: true })().address, '/srv/origin.git');
  assert.throws(t({ ...ok, keep: ['bin', '../x'] }), /keep must list plain top-level names/);
  assert.throws(t({ ...ok, keep: ['bin', STAMP] }), /keep must list plain top-level names/);
  assert.throws(t({ ...ok, keep: [UPDATER_CONFIG, RUNNER_CONFIG] }), /keep must hold bin/);
  assert.throws(t({ ...ok, keep: ['bin', RUNNER_CONFIG] }), /keep must hold updater\.json \(the updater's config\)/);
  assert.throws(t({ ...ok, keep: ['bin', UPDATER_CONFIG] }), /keep must hold review\.json \(the review runner's config\)/);
  // updateOnce itself refuses a local address without the option.
  const w = await world();
  assert.match((await updateOnce(w.c, { owner: ME, top: w.root, first: w.keepSeed })).reason, /the address must be an https address/);
  assert.equal(existsSync(w.installRoot), false);
});

test('L73 point 7(b): the stamp alert\'s "since" is when the updater first saw main ahead of the copy, by its own clock, kept while the copy stays behind', async () => {
  const w = await world();
  const file = mainSeenFile(w.installRoot);
  const seen = () => readMainSeen(file, { owner: ME, top: w.root });
  const failing = (file2, data, mode) => { if (file2.includes('.v-')) throw new Error('the disk filled up'); return writeNew(file2, data, mode); };
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed, now: () => 1_000 })).ok, true);
  assert.deepEqual(seen(), { commit: w.main1, since: 1_000, installed: w.main1, checked_at: 1_000 });
  assert.equal(lstatSync(file).mode & 0o777, 0o644, 'anyone may read it; only root writes it');

  const main2 = await moveMain(w, 'nine\n');
  assert.equal((await updateOnce(w.c, { ...w.o, write: failing, now: () => 5_000 })).ok, false);
  assert.deepEqual(seen(), { commit: main2, since: 5_000, installed: w.main1, checked_at: 5_000 }, 'the run\'s clock, not the commit\'s date');
  assert.equal((await updateOnce(w.c, { ...w.o, write: failing, now: () => 9_000 })).ok, false);
  assert.deepEqual(seen(), { commit: main2, since: 5_000, installed: w.main1, checked_at: 9_000 }, 'kept while the copy stays behind');
  const main3 = await moveMain(w, 'ten\n');
  assert.equal((await updateOnce(w.c, { ...w.o, write: failing, now: () => 12_000 })).ok, false);
  const s12 = seen();
  assert.deepEqual(s12, { commit: main3, since: 5_000, installed: w.main1, checked_at: 12_000 }, 'a main that keeps moving does not restart it');
  assert.equal(behindSince(s12, main3), 5_000);
  assert.equal(behindSince(s12, 'f'.repeat(40)), 12_000, 'a head the updater has not seen: since its last fetch');
  assert.equal(behindSince(null, main3), null);

  assert.equal((await updateOnce(w.c, { ...w.o, now: () => 15_000 })).ok, true);
  assert.deepEqual(seen(), { commit: main3, since: 15_000, installed: main3, checked_at: 15_000 });
  // Caught up, then behind again: the clock starts when the updater first sees the new head.
  const main4 = await moveMain(w, 'eleven\n');
  assert.equal((await updateOnce(w.c, { ...w.o, write: failing, now: () => 20_000 })).ok, false);
  assert.equal(seen().since, 20_000);
  assert.equal(seen().commit, main4);
  // A record dated ahead of the clock is not kept; one others can write is not read.
  assert.equal(nextMainSeen({ commit: main4, since: 99_000, installed: main3, checked_at: 20_000 }, { commit: main4, installed: main3, now: 21_000 }).since, 21_000);
  chmodSync(file, 0o666);
  assert.equal(seen(), null);
  chmodSync(file, 0o644);
  assert.notEqual(seen(), null);
  // Its folder others can write (c-5): not read either.
  chmodSync(dirname(file), 0o777);
  assert.equal(seen(), null);
  chmodSync(dirname(file), 0o755);
  // S1: a copy that changed while main stayed ahead starts the clock again.
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.equal(nextMainSeen({ commit: main4, since: 1_000, installed: a, checked_at: 2_000 }, { commit: main4, installed: b, now: 3_000 }).since, 3_000);
  assert.equal(nextMainSeen({ commit: main4, since: 1_000, installed: a, checked_at: 2_000 }, { commit: main4, installed: a, now: 3_000 }).since, 1_000);
});

test('L73 point 5, L75 c-1: root runs only two small module sets, the updater\'s and the account copy\'s, which import nothing but Node\'s own', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const set = (entry) => {
  const found = new Set();
  const visit = (file) => {
    if (found.has(file)) return;
    found.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g), ...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const m of src.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
      const lit = /^\s*['"]([^'"]+)['"]\s*$/.exec(m[1]);
      assert.ok(lit, `${basename(file)} has a dynamic import of something that is not named: import(${m[1]})`);
      specs.push(lit[1]);
    }
    for (const s of specs) {
      if (s.startsWith('node:')) continue;
      assert.ok(s.startsWith('.'), `${basename(file)} imports ${s}`);
      visit(resolve(dirname(file), s));
    }
  };
  visit(join(here, entry));
  return [...found].map((f) => f.slice(dirname(here).length + 1)).sort();
  };
  assert.deepEqual(set('review-updater.mjs'), ['git/safe-git.mjs', 'launcher/install-check.mjs', 'launcher/review-updater.mjs']);
  assert.deepEqual(set('accounts.mjs'), ['launcher/accounts.mjs', 'launcher/install-check.mjs']);
});

test('L73 point 7(c): the access-list reader, on both systems\' ls output, and failing closed', () => {
  const calls = [];
  const run = (out, status = 0) => (bin, args) => { calls.push([bin, ...args]); return { status, stdout: out, stderr: status ? 'no' : '' }; };
  const plain = '-rw-r--r--@ 1 u  g  0 Oct 31 20:45 /a\n';
  assert.equal(aclProblem(['/a'], { run: run(plain), platform: 'darwin' }), null);
  assert.deepEqual(calls.pop(), ['/bin/ls', '-led', '--', '/a']);
  assert.match(aclProblem(['/a'], { run: run(`${plain} 0: group:everyone deny delete\n`), platform: 'darwin' }), /^\/a has an access list \(ACL\)/);
  assert.match(aclProblem(['/a'], { run: run('-rw-r--r--+ 1 u g 0 Oct 31 20:45 /a\n'), platform: 'linux' }), /^\/a has an access list/);
  assert.deepEqual(calls.pop(), ['/bin/ls', '-ld', '--', '/a']);
  assert.match(aclProblem(['/a', '/b'], { run: run('', 1), platform: 'darwin' }), /the access lists \(ACL\) of \/a and others could not be read/);
  calls.length = 0;
  assert.equal(aclProblem(Array.from({ length: 450 }, (_, i) => `/p${i}`), { run: run(plain), platform: 'darwin' }), null);
  assert.equal(calls.length, 3, 'in batches');
  assert.equal(aclProblem([], { run: () => { throw new Error('not called'); } }), null);
});

test('L73 point 7(c): an access list on the copy or on a folder root writes in is refused', { skip: process.platform !== 'darwin' && 'chmod +a is macOS\'s' }, async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const chmod = (...a) => assert.equal(spawnSync('/bin/chmod', a).status, 0);
  const f = join(realpathSync.native(w.installRoot), 'a.txt');
  chmod('+a', 'everyone deny delete', f);
  assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root }), /a\.txt has an access list \(ACL\)/);
  await moveMain(w, 'twelve\n');
  assert.match((await updateOnce(w.c, w.o)).reason, /the installed copy is not root's alone: .*a\.txt has an access list/);
  chmod('-N', f);
  assert.equal(installProblem(w.installRoot, [], { owner: ME, top: w.root }), null);
  const inst = dirname(w.installRoot);
  chmod('+a', 'everyone allow add_file', inst);
  assert.match(chainProblem(inst, { owner: ME, top: w.root }), /inst has an access list/);
  assert.match((await updateOnce(w.c, w.o)).reason, /the folder of the copy: .*inst has an access list/);
  chmod('-N', inst);
  assert.equal((await updateOnce(w.c, w.o)).ok, true);
});

test('item 19, L73 C3: chainProblem walks every folder up to the top, names the owner it wants, and the leftovers come in name order', () => {
  const st = (uid, mode, link = false) => ({ uid, mode, isSymbolicLink: () => link });
  const table = { '/a': st(0, 0o40755), '/a/b': st(0, 0o40755), '/a/b/git': st(0, 0o100755), '/': st(0, 0o41777) };
  const lstat = (p) => { if (!table[p]) throw new Error('ENOENT'); return table[p]; };
  const seen = [];
  const acl = (ps) => { seen.push(ps); return null; };
  assert.equal(chainProblem('/a/b/git', { lstat, acl }), '/ can be written by others than root');
  table['/'] = st(0, 0o40755);
  assert.equal(chainProblem('/a/b/git', { lstat, acl }), null);
  assert.deepEqual(seen.pop(), ['/a/b/git', '/a/b', '/a', '/'], 'the access lists of the whole chain are read');
  table['/a'] = st(501, 0o40755);
  assert.equal(chainProblem('/a/b/git', { lstat, acl }), '/a is not owned by root');
  assert.equal(chainProblem('/a/b/git', { lstat, acl, owner: 502 }), '/a/b/git is not owned by uid 502');
  assert.equal(chainProblem('/a/b/git', { lstat, acl, top: '/a/b' }), null, 'the walk stops at the top');
  assert.equal(chainProblem('/a/b/git', { lstat, acl: () => '/a/b has an access list (ACL)', top: '/a/b' }), '/a/b has an access list (ACL)');
  table['/a/b'] = st(0, 0o120755, true);
  assert.equal(chainProblem('/a/b/git', { lstat, acl }), '/a/b is a link');
  assert.equal(chainProblem('/a/b/none', { lstat, acl }), '/a/b/none is missing');

  const dir = tempDir('m4-leftovers-');
  const ir = join(dir, 'orchestrate');
  for (const n of [`orchestrate.v-${'b'.repeat(40)}`, `orchestrate.v-${'a'.repeat(40)}`, `orchestrate.link-${'c'.repeat(40)}`, 'orchestrate.v-short', 'other']) mkdirSync(join(dir, n));
  const want = [`orchestrate.link-${'c'.repeat(40)}`, `orchestrate.v-${'a'.repeat(40)}`, `orchestrate.v-${'b'.repeat(40)}`];
  assert.deepEqual(updaterLeftovers(ir).map((p) => basename(p)), want);
  // Whatever order the disk lists them in.
  assert.deepEqual(updaterLeftovers(ir, { list: (d) => readdirSync(d).sort().reverse() }).map((p) => basename(p)), want);
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

test('L75 C1, C4, A1, A3: every folder up to the top is checked, on the link layout too, and every path\'s access list is read', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  await moveMain(w, 'c1\n');
  // C1: a folder two above the copy (here the top) that others can write stops the run before anything else.
  chmodSync(w.root, 0o777);
  try {
    assert.match((await updateOnce(w.c, w.o)).reason, /^the folder of the copy: .* can be written by others than root/);
  } finally { chmodSync(w.root, 0o755); }
  // C4: the walk above the copy runs when installRoot is the link.
  const inst = dirname(w.installRoot);
  chmodSync(inst, 0o777);
  try {
    assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root }), /inst, above the installed copy, can be written by others than root/);
  } finally { chmodSync(inst, 0o755); }
  // A1, A3, c-4: the access lists of the link, every folder above it and every path of the copy, however many.
  const real = realpathSync.native(w.installRoot);
  mkdirSync(join(real, 'many'));
  for (let i = 0; i < 250; i++) writeFileSync(join(real, 'many', `f${String(i).padStart(3, '0')}`), '');
  const got = [];
  assert.equal(installProblem(w.installRoot, [], { owner: ME, top: w.root, acl: (ps) => { got.push(...ps); return null; } }), null);
  for (const p of [w.installRoot, inst, w.root, real, join(real, 'many', 'f000'), join(real, 'many', 'f249')]) assert.ok(got.includes(p), `${p} is not read`);
  assert.ok(got.length > 250);
  assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root, acl: (ps) => (ps.includes(join(real, 'many', 'f249')) ? 'f249 has an access list (ACL)' : null) }), /f249 has an access list/);
});

test('L75 F3: a flip that fails leaves the copy in place whole, and no new folder or link behind', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  await moveMain(w, 'f3\n');
  const before = snapshot(w.installRoot);
  for (const failAt of [`${w.installRoot}${PREVIOUS}`, w.installRoot]) {
    const rename = (a, b) => { if (b === failAt) { const e = new Error('no'); e.code = 'EIO'; throw e; } return renameSync(a, b); };
    const r = await updateOnce(w.c, { ...w.o, rename });
    assert.match(r.reason, /the new copy could not be put in place \(EIO\); the old one stays/, failAt);
    assert.deepEqual(snapshot(w.installRoot), before, failAt);
    assert.equal(linkOf(w), into(versionName(w.installRoot, w.main1)), failAt);
    assert.deepEqual(leftovers(w), [], failAt);
  }
  const r = await updateOnce(w.c, w.o);
  assert.equal(r.ok, true, r.reason);
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'f3\n');
});

test('L75 m-1: an install cut off at any step, inside the clone\'s making and the fetch too, is put right by the next run', async () => {
  const steps = ['clone-init', 'clone-config-removed', 'clone-config', 'clone-hooks', 'clone-marked', 'cloned', 'fetching', 'cleared', 'folder', 'stamped', 'linked', 'flipped', 'noted'];
  const cutAt = [];
  for (const at of steps) {
    const w = await world();
    let cut = false;
    try { await updateOnce(w.c, { ...w.o, first: w.keepSeed, step: (n) => { if (n === at) { cut = true; throw new Error('CUT'); } } }); } catch (e) { assert.equal(e.message, 'CUT'); }
    if (cut) cutAt.push(at);
    const cur = currentCopy(w.installRoot, { owner: ME });
    const r = await updateOnce(w.c, cur.missing ? { ...w.o, first: w.keepSeed } : w.o);
    assert.equal(r.ok, true, `${at}: ${r.reason}`);
    assert.equal(stampOf(w), w.main1, at);
    assert.equal(lstatSync(w.installRoot).isSymbolicLink(), true, at);
    assert.deepEqual(leftovers(w), [], at);
    assert.equal(existsSync(join(w.c.clone, CLONE_MADE)), true, at);
    assert.deepEqual(readdirSync(w.root).filter((n) => n.startsWith(`${basename(w.c.clone)}.new-`)), [], `${at}: no half-made clone is left`);
    const again = await updateOnce(w.c, w.o);
    assert.deepEqual([again.ok, again.changed], [true, false], `${at}: ${again.reason}`);
  }
  assert.deepEqual(cutAt, steps, 'every step was reached and cut');
  // A clone from before the marker, or one a cut-off left without it, is made again.
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  rmSync(join(w.c.clone, CLONE_MADE));
  await moveMain(w, 'remade\n');
  const r = await updateOnce(w.c, w.o);
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.recovered.includes('removed a clone that was never finished'));
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'remade\n');
});

test('L75 m-1: a lock a cut-off git left in the clone is removed only when no git is running', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  writeFileSync(join(w.c.clone, 'refs', 'heads', 'main.lock'), '');
  writeFileSync(join(w.c.clone, 'packed-refs.lock'), '');
  assert.deepEqual(cloneLocks(w.c.clone), [join(w.c.clone, 'packed-refs.lock'), join(w.c.clone, 'refs', 'heads', 'main.lock')]);
  await moveMain(w, 'locked\n');
  const busy = await updateOnce(w.c, { ...w.o, gitRunning: () => true });
  assert.match(busy.reason, /the clone holds packed-refs\.lock, main\.lock and a git is running; the next run tries again/);
  assert.equal(existsSync(join(w.c.clone, 'refs', 'heads', 'main.lock')), true, 'a running git keeps its lock');
  const r = await updateOnce(w.c, { ...w.o, gitRunning: () => false });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.recovered.includes('removed refs/heads/main.lock from the clone'), r.recovered.join(', '));
  assert.ok(r.recovered.includes('removed packed-refs.lock from the clone'));
  assert.equal(readFileSync(join(w.installRoot, 'a.txt'), 'utf8'), 'locked\n');
  assert.deepEqual(cloneLocks(w.c.clone), []);
  // Who is running: any program named git or git-something; a `ps` that fails counts as one.
  const ps = (stdout, status = 0) => () => ({ status, stdout });
  assert.equal(gitIsRunning({ run: ps('launchd\n/usr/bin/git\nzsh\n') }), true);
  assert.equal(gitIsRunning({ run: ps('launchd\n/Library/Developer/CommandLineTools/usr/libexec/git-core/git-remote-https\n') }), true);
  assert.equal(gitIsRunning({ run: ps('launchd\nzsh\ngithub-desktop\nnode\n') }), false);
  assert.equal(gitIsRunning({ run: ps('', 1) }), true);
  assert.equal(gitIsRunning({ run: () => ({ error: new Error('no ps') }) }), true);
});

test('L75 m-3: on a Mac, the developer folder /usr/bin/git hands over to, its git and every helper must be root\'s alone', () => {
  const root = realpathSync.native(tempDir('m4-devdir-'));
  const dev = join(root, 'CommandLineTools');
  mkdirSync(join(dev, 'usr', 'bin'), { recursive: true });
  mkdirSync(join(dev, 'usr', 'libexec', 'git-core', 'sub'), { recursive: true });
  writeFileSync(join(dev, 'usr', 'bin', 'git'), '');
  chmodSync(join(dev, 'usr', 'bin', 'git'), 0o755);
  writeFileSync(join(dev, 'usr', 'libexec', 'git-core', 'git-remote-https'), '');
  writeFileSync(join(dev, 'usr', 'libexec', 'git-core', 'sub', 'x'), '');
  symlinkSync('../../bin/git', join(dev, 'usr', 'libexec', 'git-core', 'git-fetch'));
  const calls = [];
  const xs = (out, status = 0) => (bin, args, o) => { calls.push([bin, ...args, o.env.PATH]); return { status, stdout: out }; };
  const opts = { platform: 'darwin', owner: ME, top: root };
  assert.equal(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(`${dev}\n`) }), null);
  assert.deepEqual(calls.pop(), ['/usr/bin/xcode-select', '-p', ROOT_PATH]);
  assert.equal(gitToolsProblem('/usr/bin/git', { ...opts, platform: 'linux', run: () => { throw new Error('not called'); } }), null);
  assert.equal(gitToolsProblem('/opt/git/bin/git', { ...opts, run: () => { throw new Error('not called'); } }), null, 'another git is checked by its own chain');
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs('', 2) }), /xcode-select names no developer folder/);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs('relative/path\n') }), /names no developer folder/);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(join(root, 'none')) }), /the developer folder .*none is missing/);
  // A developer folder an admin can change, its git, a helper, a link that leads out.
  chmodSync(dev, 0o777);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(dev) }), /^the developer folder: .*CommandLineTools can be written by others than root/);
  chmodSync(dev, 0o755);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, owner: ME + 1, run: xs(dev) }), /is not owned by uid/);
  chmodSync(join(dev, 'usr', 'bin', 'git'), 0o775);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(dev) }), /^the developer folder's git: .*bin\/git can be written by others than root/);
  chmodSync(join(dev, 'usr', 'bin', 'git'), 0o755);
  chmodSync(join(dev, 'usr', 'libexec', 'git-core', 'sub', 'x'), 0o666);
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(dev) }), /^git's helpers: .*sub\/x can be written by others than root/);
  chmodSync(join(dev, 'usr', 'libexec', 'git-core', 'sub', 'x'), 0o644);
  symlinkSync(join(root, 'elsewhere'), join(dev, 'usr', 'libexec', 'git-core', 'git-evil'));
  writeFileSync(join(root, 'elsewhere'), '');
  assert.match(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(dev) }), /git-evil leads outside the developer folder/);
  rmSync(join(dev, 'usr', 'libexec', 'git-core', 'git-evil'));
  assert.equal(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(dev) }), null);
  // The developer folder named through a link is checked at its real place.
  symlinkSync(dev, join(root, 'dev-link'));
  assert.equal(gitToolsProblem('/usr/bin/git', { ...opts, run: xs(join(root, 'dev-link')) }), null);
});

test('L75 m-4: a new copy must hold what the runner\'s config names in it (wiring, claude, the hooks), or the update is refused', async () => {
  const w = await world();
  writeFileSync(join(w.keepSeed, RUNNER_CONFIG), `${JSON.stringify({ wiring: join(w.installRoot, 'wiring', 'w.mjs'), claudeBin: '/usr/local/bin/claude', hooksDir: join(w.installRoot, 'modules') })}\n`);
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.match(r.reason, /the new copy was not made \(the new copy has no wiring\/w\.mjs, the runner's wiring: keep must hold wiring\)/);
  assert.equal(existsSync(w.installRoot), false);
  assert.deepEqual(leftovers(w), []);
  mkdirSync(join(w.keepSeed, 'wiring'));
  writeFileSync(join(w.keepSeed, 'wiring', 'w.mjs'), '');
  writeFileSync(join(w.keepSeed, RUNNER_CONFIG), `${JSON.stringify({ wiring: join(w.installRoot, 'wiring', 'w.mjs'), claudeBin: join(w.installRoot, 'claude', 'bin') })}\n`);
  const c = { ...w.c, keep: [...w.c.keep, 'wiring'] };
  assert.match((await updateOnce(c, { ...w.o, first: w.keepSeed })).reason, /has no claude\/bin, the runner's claudeBin: keep must hold claude/);
  writeFileSync(join(w.keepSeed, RUNNER_CONFIG), `${JSON.stringify({ wiring: join(w.installRoot, 'wiring', 'w.mjs'), claudeBin: '/usr/local/bin/claude' })}\n`);
  const ok = await updateOnce(c, { ...w.o, first: w.keepSeed });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(existsSync(join(w.installRoot, 'wiring', 'w.mjs')), true);
  writeFileSync(join(w.installRoot, RUNNER_CONFIG), 'not json\n');
  await moveMain(w, 'm4\n');
  assert.match((await updateOnce(c, w.o)).reason, /the new copy's review\.json is not JSON/);
});

test('L75 c-2, c-3, c-6: the config is checked before it is read, names plain paths, and root\'s git keeps its home beside the clone', async () => {
  const w = await world();
  const lines = [];
  const o = { ...w.o, log: (s) => lines.push(s), uid: ME };
  // c-2: a config in a folder others can write is refused by its chain, before a word of it is read.
  const open = join(w.root, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  writeFileSync(join(open, 'u.json'), 'not json');
  assert.equal(await main([join(open, 'u.json')], o), 1);
  assert.match(lines.pop(), /^updater: the config: .*open can be written by others than root/);
  // c-3
  const f = join(w.root, 'plain.json');
  for (const bad of ['/I/o/', '/I/./o', '/I//o']) {
    writeFileSync(f, JSON.stringify({ ...w.c, installRoot: bad }));
    assert.throws(() => readUpdaterConfig(f, { localAddress: true }), /installRoot must be an absolute path in its plain form/, bad);
  }
  // c-6: git's home is root's own folder beside the clone, never /tmp.
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const home = `${w.c.clone}.home`;
  assert.equal(lstatSync(home).mode & 0o777, 0o700);
  assert.equal(safeGitEnv({ path: ROOT_PATH }).HOME, home);
  chmodSync(home, 0o755);
  assert.match((await updateOnce(w.c, w.o)).reason, /git's home: .*clone\.git\.home is not root's own folder \(0700\)/);
  rmSync(home, { recursive: true });
  mkdirSync(join(w.root, 'other-home'), { mode: 0o700 });
  symlinkSync(join(w.root, 'other-home'), home);
  assert.match((await updateOnce(w.c, w.o)).reason, /git's home: .*clone\.git\.home is not a plain folder/);
});

/**
 * The layout an updater from before L92 item 4 made: the link names the versioned folder, which is the copy itself,
 * with the stamp inside it. Made here from a new-shape install of the same commit.
 */
function oldShape(w) {
  const inst = dirname(w.installRoot);
  const v = vOf(linkOf(w));
  rmSync(w.installRoot);
  renameSync(join(inst, v), join(inst, 'was'));
  renameSync(join(inst, 'was', SOURCE), join(inst, v));
  renameSync(join(inst, 'was', STAMP), join(inst, v, STAMP));
  rmSync(join(inst, 'was'), { recursive: true });
  symlinkSync(v, w.installRoot);
  return v;
}

test('L106 m-3, m-2: an install from before L92 item 4 is refused everywhere, nothing changed, and Joe is told to remove the link and run the install step again', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  await moveMain(w, 'later\n');
  const v = oldShape(w);
  const inst = dirname(w.installRoot);
  const before = snapshot(inst);
  const told = new RegExp(`${esc(w.installRoot)} is an install from before the copy's layout changed \\(L92 item 4\\): its link names the folder ${esc(v)} itself, not ${esc(v)}/${SOURCE}\\. Nothing was changed.*remove the old link, then run the install step again .*--first <seed folder>.*to paste in Terminal: sudo /bin/rm ${esc(w.installRoot)}$`);
  // The update, the install step, the runner's and the account copy's check, and the install check all say it.
  assert.match((await updateOnce(w.c, w.o)).reason, told);
  assert.match((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).reason, told);
  assert.match(copyReady(w.installRoot, { owner: ME }), told);
  assert.match(installProblem(w.installRoot, [], { owner: ME, top: w.root }), told);
  assert.equal(currentCopy(w.installRoot, { owner: ME }).old, true);
  assert.equal(readInstallStamp(w.installRoot, { owner: ME }), null);
  const now = snapshot(inst);
  for (const k of Object.keys({ ...before, ...now })) if (!k.includes(basename(mainSeenFile(w.installRoot)))) assert.equal(now[k], before[k], `nothing changed: ${k}`);
  // Doing what it says: the link alone is removed, and the install step makes the new shape and clears the old folder.
  rmSync(w.installRoot);
  const r = await updateOnce(w.c, { ...w.o, first: w.keepSeed });
  assert.equal(r.ok, true, r.reason);
  assert.equal(linkOf(w), into(versionName(w.installRoot, r.commit)));
  assert.equal(stampOf(w), r.commit);
  assert.equal(copyReady(w.installRoot, { owner: ME }), null);
  assert.equal(existsSync(join(inst, v, STAMP)), false, 'the old folder is cleared');
  assert.deepEqual(leftovers(w), []);
});

test('L106 m-1: a copy the updater did not finish (no stamp, or another commit\'s) is not ready, though its link is good', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const folder = join(dirname(w.installRoot), vOf(linkOf(w)));
  assert.equal(copyReady(w.installRoot, { owner: ME }), null);
  rmSync(join(folder, STAMP));
  assert.match(copyReady(w.installRoot, { owner: ME }), new RegExp(`the copy's commit stamp \\(none at ${esc(join(folder, STAMP))}\\) is not the commit its folder is named for \\(${w.main1}\\)`));
  // A stamp written inside orchestrate/ (where a hand install might put it) is not read (L106 m-6).
  writeFileSync(join(folder, SOURCE, STAMP), `${w.main1}\n`, { mode: 0o644 });
  assert.match(copyReady(w.installRoot, { owner: ME }), /stamp \(none at /);
  writeFileSync(join(folder, STAMP), `${E40}\n`, { mode: 0o644 });
  assert.match(copyReady(w.installRoot, { owner: ME }), new RegExp(`stamp \\(${E40}\\) is not the commit its folder is named for`));
  // The updater still replaces such a copy: it does not ask copyReady.
  const main2 = await moveMain(w, 'mend\n');
  const r = await updateOnce(w.c, w.o);
  assert.deepEqual([r.ok, r.commit], [true, main2], r.reason);
  assert.equal(copyReady(w.installRoot, { owner: ME }), null);
});

test('L106 m-7, m-5: an old-shape .prev is not kept, and the leftover clean-up takes only a versioned folder beside the copy as the one in use', async () => {
  const w = await world();
  assert.equal((await updateOnce(w.c, { ...w.o, first: w.keepSeed })).ok, true);
  const main2 = await moveMain(w, 'two\n');
  assert.equal((await updateOnce(w.c, w.o)).ok, true);
  const inst = dirname(w.installRoot);
  const v1 = versionName(w.installRoot, w.main1);
  assert.equal(previousCopy(w.installRoot), join(inst, v1));
  // `.prev` as an updater from before L92 item 4 wrote it: straight at the versioned folder.
  const prev = `${w.installRoot}${PREVIOUS}`;
  rmSync(prev);
  symlinkSync(v1, prev);
  assert.equal(previousCopy(w.installRoot), null, 'the old shape is not a previous copy');
  const cur = currentCopy(w.installRoot, { owner: ME });
  // m-5: the copy inside the versioned folder, or a path elsewhere, is refused, and nothing is removed.
  for (const bad of [cur.real, join(w.root, 'elsewhere', versionName(w.installRoot, main2)), join(inst, 'not-a-version')]) {
    assert.throws(() => clearLeftovers(w.installRoot, { current: bad }), /is not a versioned folder beside/, bad);
    assert.equal(existsSync(join(inst, v1)), true, `${bad}: nothing removed`);
  }
  assert.deepEqual(clearLeftovers(w.installRoot, { current: cur.folder }), [`removed ${v1}`]);
  assert.equal(existsSync(join(inst, v1)), false, 'the folder an old-shape .prev names is removed');
  assert.equal(currentCopy(w.installRoot, { owner: ME }).commit, main2);
  assert.equal(copyReady(w.installRoot, { owner: ME }), null);
});
