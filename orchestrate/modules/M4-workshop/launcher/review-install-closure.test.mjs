// review-install-closure.test.mjs — LEAD-CALLS L92 item 4: the install closure.
//
// WHY. The LaunchDaemons start the review runner, the account copy and the updater from the installed copy, which the
// updater makes from main's `orchestrate/` plus a short list of outside files (install-check.mjs OUTSIDE_FILES). An
// import that reaches a file the updater does not install (M6 gather.mjs and M10 policy.mjs import Bob's
// scripts/blueprint/yaml-lite.mjs) fails only on the Mac, at the first run, with ERR_MODULE_NOT_FOUND: no review ever
// starts. Here a repository is made from this checkout's own orchestrate/ and scripts/ files, the real updater
// installs it as on the Mac (owner = this test's uid, `top` = the test folder), and every plist entry point is loaded
// from that copy alone: each import is followed, file by file, and each must land on a file inside the copy's versioned
// folder; then each entry point is imported for real by node, from the copy. Every other module of the copy is walked
// the same way, so one an entry point comes to import later already loads.
//
// What the walk cannot follow: an import whose name is computed at run time (the runner's `wiring`, which is one of
// the copy's own items, not a repository file). Those are the install step's to supply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { gitOk } from '../git/safe-git.mjs';
import { SCRIPTS } from './review-daemons.mjs';
import { NODE, UPDATER_CONFIG, RUNNER_CONFIG, STAMP, SOURCE, OUTSIDE_FILES, currentCopy, readInstallStamp } from './install-check.mjs';
import { updateOnce, MAIN } from './review-updater.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ME = process.getuid();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** The tracked files of this checkout under `dirs`, as they are on disk now (so a planted change is in the copy). */
function tracked(dirs) {
  const r = spawnSync(GIT, ['ls-files', '-z', '--', ...dirs], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter(Boolean).filter((f) => existsSync(join(REPO, f)));
}

/** A repository whose main holds this checkout's orchestrate/ and scripts/, installed by the real updater. */
async function installed() {
  const root = realpathSync.native(tempDir('m4-closure-'));
  const origin = join(root, 'origin.git');
  await gitOk(['init', '--bare', '-q', origin], { gitDir: origin });
  const src = join(root, 'src');
  mkdirSync(src);
  const sg = { gitDir: join(src, '.git'), workTree: src, cwd: src, extraConfig: ID };
  await gitOk(['init', '-q', src], sg);
  for (const f of tracked([SOURCE, 'scripts'])) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), readFileSync(join(REPO, f)));
    chmodSync(join(src, f), statSync(join(REPO, f)).mode & 0o755);
  }
  await gitOk(['add', '-A'], sg);
  await gitOk(['commit', '-q', '-m', 'this checkout'], sg);
  await gitOk(['push', '-q', origin, `HEAD:${MAIN}`], sg);

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'bin'), { recursive: true });
  writeFileSync(join(seed, NODE), 'a node\n');
  writeFileSync(join(seed, RUNNER_CONFIG), '{}\n');
  const installRoot = join(root, 'inst', SOURCE);
  mkdirSync(dirname(installRoot));
  const c = { installRoot, clone: join(root, 'clone.git'), address: origin, keep: ['bin', RUNNER_CONFIG, UPDATER_CONFIG], gitBin: GIT };
  writeFileSync(join(seed, UPDATER_CONFIG), `${JSON.stringify(c)}\n`);
  const r = await updateOnce(c, { first: seed, owner: ME, top: root, localAddress: true });
  assert.equal(r.ok, true, r.reason);
  const cur = currentCopy(installRoot, { owner: ME });
  assert.ok(cur.link && cur.folder, cur.problem);
  return { root, installRoot, cur };
}

// The module names a file imports, statically: `import … from '…'`, `export … from '…'`, a bare `import '…'`, and
// `import('…')` with a plain string. Whole-line and block comments are left out first, so an example in a comment is
// not taken for an import.
const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*(['"])([^'"\n]+)\1|(?:^|[\s;])import\s*(['"])([^'"\n]+)\3|\bimport\(\s*(['"])([^'"\n]+)\5\s*\)/g;
function importsOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return [...code.matchAll(IMPORT)].map((m) => m[2] ?? m[4] ?? m[6]);
}

/** Every file reached from `entry` by imports: { files, bad: [why…] }. Each must be a file inside `folder`. */
function closure(entry, folder) {
  const seen = new Set();
  const bad = [];
  const todo = [realpathSync.native(entry)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of importsOf(readFileSync(f, 'utf8'))) {
      if (BUILTIN.has(spec)) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../')) { bad.push(`${relative(folder, f)} imports ${spec}, which is not a file of the copy`); continue; }
      const to = resolve(dirname(f), spec);
      const rel = relative(folder, to);
      if (rel.startsWith('..') || isAbsolute(rel)) { bad.push(`${relative(folder, f)} imports ${spec}, outside the installed copy`); continue; }
      if (!existsSync(to)) { bad.push(`${relative(folder, f)} imports ${spec}, which the updater did not install (${rel})`); continue; }
      todo.push(realpathSync.native(to));
    }
  }
  return { files: [...seen], bad };
}

test('L92 item 4: every plist entry point loads from the installed copy alone, following every import', async () => {
  const w = await installed();
  const folder = w.cur.folder;
  // The layout: the link names <v>/orchestrate; the outside files sit at their repository paths in <v>; the stamp too.
  assert.equal(w.cur.real, join(folder, SOURCE));
  for (const f of OUTSIDE_FILES) assert.ok(existsSync(join(folder, f)), `${f} is installed beside ${SOURCE}`);
  assert.ok(existsSync(join(folder, STAMP)) && !existsSync(join(w.cur.real, STAMP)), 'the stamp is at the top of the versioned folder');
  assert.match(readInstallStamp(w.installRoot, { owner: ME }), /^[0-9a-f]{40}$/);

  const reached = new Set();
  for (const [name, script] of Object.entries(SCRIPTS)) {
    const entry = join(w.installRoot, script);
    assert.ok(existsSync(entry), `${name}: ${script} is in the copy`);
    const { files, bad } = closure(entry, folder);
    assert.deepEqual(bad, [], `${name}: every import lands in the copy`);
    for (const f of files) reached.add(relative(folder, f));
    // And node itself loads it from the copy (each entry point runs nothing when it is imported rather than started).
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(entry).href)});`],
      { cwd: w.root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `${name} loads from the copy: ${r.stderr.slice(0, 600)}`);
  }
  // Every module of the copy, too, not only what the entry points reach today: a module the runner comes to import
  // later (as the runner does M6's gather.mjs once #67 is in) must already load from the copy. Test files are left out: they run
  // in the repository, never on the Mac.
  const used = new Set();
  for (const f of modulesOf(w.cur.real)) {
    const { files, bad } = closure(f, folder);
    assert.deepEqual(bad, [], `${relative(folder, f)}: every import lands in the copy`);
    for (const g of files) used.add(relative(folder, g));
  }
  // Every listed outside file is imported by a module of the copy, so the list holds no stale entry.
  for (const f of OUTSIDE_FILES) assert.ok(used.has(f), `${f} is imported by a module of the copy`);
  assert.ok(reached.size > 10, 'the entry points reach the modules they import');
});

/** Every .mjs file under `dir` that is not a test file or a test helper. */
function modulesOf(dir) {
  const out = [];
  const walk = (p) => {
    for (const n of readdirSync(p).sort()) {
      const q = join(p, n);
      const st = lstatSync(q);
      if (st.isDirectory()) walk(q);
      else if (st.isFile() && n.endsWith('.mjs') && !/\.test(-helper)?\.mjs$/.test(n)) out.push(q);
    }
  };
  walk(dir);
  return out;
}

test('L92 item 4: the walk finds what a copy lacks and an import that leaves the copy', () => {
  const root = realpathSync.native(tempDir('m4-closure-'));
  const v = join(root, 'inst.v-x');
  mkdirSync(join(v, SOURCE, 'm'), { recursive: true });
  writeFileSync(join(v, SOURCE, 'm', 'a.mjs'), "import { b } from './b.mjs';\n// import { c } from './not-a-real-import.mjs';\nimport '../../../outside.mjs';\nimport('../../scripts/x.mjs');\n");
  writeFileSync(join(v, SOURCE, 'm', 'b.mjs'), "import fs from 'node:fs';\nimport x from 'some-package';\nexport {\n  y,\n} from './missing.mjs';\n/* import './in-a-block-comment.mjs'; */\nexport const b = 1;\n");
  const { files, bad } = closure(join(v, SOURCE, 'm', 'a.mjs'), v);
  assert.deepEqual(bad.sort(), [
    'orchestrate/m/a.mjs imports ../../../outside.mjs, outside the installed copy',
    'orchestrate/m/a.mjs imports ../../scripts/x.mjs, which the updater did not install (scripts/x.mjs)',
    'orchestrate/m/b.mjs imports ./missing.mjs, which the updater did not install (orchestrate/m/missing.mjs)',
    'orchestrate/m/b.mjs imports some-package, which is not a file of the copy',
  ]);
  assert.deepEqual(files.map((f) => relative(v, f)).sort(), ['orchestrate/m/a.mjs', 'orchestrate/m/b.mjs']);
});
