// The bob step (L994, L995): the Bob folder and its pinned file list, from one commit, together; check 13 takes the pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { apply } from './users-folders.mjs';
import { BOB_COMMIT, BOB_MANIFEST, BOB_NEW, BOB_OLD, bobGit, bobManifestPath, checkBob, landedList, leftOut, manifestText, planBob, readCommit } from './bob-manifest.mjs';
import { main, parseArgs, planCommand } from './setup.mjs';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import { RUNNER_CONFIG, UPDATER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { readUpdaterConfig } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { checkBobFolder } from '../modules/M4-workshop/launcher/launch.mjs';
import { bobFolderDeny, bobFolderShell } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';

const BASE = '/Users/Shared/orch';
const COPY_COMMIT = 'c'.repeat(40);
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** A plain copy of a folder of plain files and folders. */
const cpTree = (from, to) => { mkdirSync(to); for (const n of readdirSync(from)) { const a = join(from, n); if (lstatSync(a).isDirectory()) cpTree(a, join(to, n)); else writeFileSync(join(to, n), readFileSync(a)); } };
const git = (dir, args, input) => {
  const r = spawnSync('git', ['-C', dir, ...args], { input, encoding: 'buffer', env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('utf8').trim();
};
const port = (dir) => (args, input) => {
  const r = spawnSync('git', ['-C', dir, ...args], { input, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: dir }, maxBuffer: 1 << 28 });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: String(r.stderr ?? '') };
};

/** A Bob checkout: `files` { path: text } written and committed; `index` { path: [mode, text-or-oid] } added straight to the index (for what a Mac disk can't hold). → the commit. */
function commitOf(repo, files, index = {}) {
  if (!existsSync(join(repo, '.git'))) git(repo, ['init', '-q']);
  git(repo, ['rm', '-rq', '--cached', '--ignore-unmatch', '.']);
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); git(repo, ['add', '-f', p]); }
  for (const [p, [mode, v]] of Object.entries(index)) {
    const oid = mode === '160000' ? v : git(repo, ['hash-object', '-w', '--stdin'], Buffer.from(v));
    git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`]);
  }
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'x']);
  return git(repo, ['rev-parse', 'HEAD']);
}

const FILES = {
  'README.md': '# Bob\n', 'rules.md': 'rule 1\n', 'scripts/check.sh': '#!/bin/sh\necho ok\n', 'modes/deep/audit.md': 'audit\n',
  'skill/SKILL.md': 'a skill\n', 'skills/one/x.md': 'in skills\n', 'docs/Skills/y.md': 'in Skills, any case\n', 'docs/skill.md': 'a skill file, any case\n',
};
const KEPT = ['README.md', 'modes/deep/audit.md', 'rules.md', 'scripts/check.sh'];

/** The installed copy under `base` as install leaves it: the link the updater flips and its real folder, with the updater's config. → the real folder. */
function installedCopy(at, base) {
  const install = `${base}/install`;
  const realCopy = `${install}/orchestrate.v-${COPY_COMMIT}/orchestrate`;
  mkdirSync(at(realCopy), { recursive: true });
  symlinkSync(`orchestrate.v-${COPY_COMMIT}/orchestrate`, at(`${install}/orchestrate`));
  writeFileSync(at(`${realCopy}/${UPDATER_CONFIG}`), JSON.stringify({ installRoot: `${install}/orchestrate`, clone: `${install}/clone.git`, gitBin: '/usr/bin/git', address: 'https://github.com/o/r.git', keep: ['bin', UPDATER_CONFIG, RUNNER_CONFIG] }));
  return realCopy;
}

/** A Mac with the installed copy (its link and real folder, root's), the base, the empty Bob folder and a Bob checkout. */
function world() {
  const mac = fakeMac({ users: { orchestrate: { UniqueID: '501', PrimaryGroupID: '501', UserShell: '/usr/bin/false', NFSHomeDirectory: '/var/empty' } } });
  const at = (p) => join(mac.prefix, p);
  const realCopy = installedCopy(at, BASE); mkdirSync(at(`${BASE}/bob`), { recursive: true });
  const cfg = { base: BASE, owner: 'sam', gitBin: '/usr/bin/git' };
  const repo = realpathSync(tempDir('orch-bob-repo-'));
  const plan = (commit, over = {}) => planBob(mac, cfg, { from: repo, commit, git: port(repo), ...over });
  const run = (commit, over) => { const p = plan(commit, over); assert.deepEqual(p.problems, []); apply(p.ops, { log: () => {} }); return p; };
  const pair = () => ({ folder: landedList(at(`${BASE}/bob`)), list: JSON.parse(readFileSync(at(`${realCopy}/${BOB_MANIFEST}`), 'utf8')), commit: readFileSync(at(`${realCopy}/${BOB_COMMIT}`), 'utf8').trim() });
  return { mac, at, cfg, repo, realCopy, plan, run, pair };
}

test('bob: the folder holds exactly the commit\'s files less the skills, the list is what landed, and check 13 takes the pair', () => {
  const w = world();
  const c = commitOf(w.repo, FILES);
  w.run(c);
  const bob = w.at(`${BASE}/bob`);
  const p = w.pair();
  assert.deepEqual(Object.keys(p.folder).sort(), KEPT);
  assert.deepEqual(p.list, Object.fromEntries(KEPT.map((k) => [k, sha(FILES[k])])), 'the list is each file\'s sha256');
  assert.equal(readFileSync(w.at(`${w.realCopy}/${BOB_MANIFEST}`), 'utf8'), manifestText(p.folder));
  assert.equal(p.commit, c, 'the commit is recorded beside the list');
  assert.equal(lstatSync(join(bob, 'scripts/check.sh')).mode & 0o777, 0o644, 'git\'s 644 kept');
  for (const n of [BOB_NEW, BOB_OLD]) assert.equal(existsSync(w.at(`${BASE}/${n}`)), false, `no ${n} left`);
  assert.deepEqual(readdirSync(w.at(w.realCopy)).filter((n) => n.endsWith('.adding')), []);
  const keep = readUpdaterConfig(w.at(`${w.realCopy}/${UPDATER_CONFIG}`)).keep;
  for (const n of [BOB_MANIFEST, BOB_COMMIT]) assert.ok(keep.includes(n), `${n} kept across an update`);
  assert.deepEqual(w.mac.owners.get(`${BASE}/bob`), { uid: 501, gid: 501 }, 'the folder is orchestrate\'s (layout.mjs)');
  assert.ok(w.mac.log.some((l) => l.startsWith(`chown ${w.mac.rootUid}:0`) && l.endsWith(`${BASE}/${BOB_NEW}/rules.md`)), 'its files made root\'s');
  assert.equal(w.mac.owners.get(`${w.realCopy}/${BOB_MANIFEST}`).uid, w.mac.rootUid, 'the list root\'s');
  assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok), JSON.stringify(checkBob(w.mac, w.cfg)));
  // M4's own check 13, on the pair as installed.
  const settings = { [S.permissions]: { [S.deny]: bobFolderDeny(bob) }, [S.sandbox]: { [S.filesystem]: { [S.denyWrite]: bobFolderShell(bob) } } };
  assert.deepEqual(checkBobFolder({ folder: bob, manifest: p.list, settings }), { ok: true });
  writeFileSync(join(bob, 'rules.md'), 'changed\n');
  assert.match(checkBobFolder({ folder: bob, manifest: p.list, settings }).reason, /rules\.md differs from the pinned Bob commit/);
  assert.equal(checkBob(w.mac, w.cfg).some((x) => !x.ok), true, 'checkBob sees it too');
});

test('bob (PR-1 r2 m1): checkBob refuses what check 13 refuses: a linked top folder, and an empty list', () => {
  const w = world();
  w.run(commitOf(w.repo, FILES));
  const bob = w.at(`${BASE}/bob`); const moved = w.at(`${BASE}/bob-real`);
  renameSync(bob, moved); symlinkSync(moved, bob);
  const linked = checkBob(w.mac, w.cfg);
  assert.ok(linked.some((x) => !x.ok && /is a plain folder/.test(x.what) && /link/.test(x.why)), JSON.stringify(linked));
  rmSync(bob); renameSync(moved, bob);
  assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok), 'put back: it passes again');
  for (const n of readdirSync(bob)) rmSync(join(bob, n), { recursive: true });
  writeFileSync(w.at(`${w.realCopy}/${BOB_MANIFEST}`), '{}\n');
  const empty = checkBob(w.mac, w.cfg);
  assert.ok(empty.some((x) => !x.ok && /names at least one file/.test(x.what)), JSON.stringify(empty));
  assert.ok(empty.some((x) => x.ok && /holds exactly the list's files/.test(x.what)), 'the folder does match the empty list: only the list check refuses');
});

test('bob: executable files stay executable; leftOut matches check 13\'s skill rule', () => {
  const w = world();
  const c = commitOf(w.repo, { 'a.md': 'a\n' }, { 'run.sh': ['100755', '#!/bin/sh\n'] });
  w.run(c);
  assert.equal(lstatSync(w.at(`${BASE}/bob/run.sh`)).mode & 0o777, 0o755);
  for (const p of ['SKILL.md', 'x/Skill.MD', 'skill/a', 'a/SKILLS/b.md']) assert.equal(leftOut(p), true, p);
  for (const p of ['skillful.md', 'a/skills.md', 'skillsx/a.md']) assert.equal(leftOut(p), false, p);
});

test('bob: refusals come before any change: a short or unknown commit, a link, another repository, names that clash on a case-blind disk', () => {
  const w = world();
  const good = commitOf(w.repo, { 'a.md': 'a\n' });
  const before = () => ({ bob: readdirSync(w.at(`${BASE}/bob`)), copy: readdirSync(w.at(w.realCopy)).sort() });
  const was = before();
  const refused = (commit, re, over) => { const p = w.plan(commit, over); assert.equal(p.ops.length, 0); assert.match(p.problems.join('\n'), re); assert.match(p.problems[0], /Nothing was changed/); };
  refused(good.slice(0, 12), /--commit must be the full commit: 40 lower-case hex/);
  refused(good.toUpperCase(), /--commit must be the full commit/);
  refused('0'.repeat(40), /is not a commit in --from/);
  refused(git(w.repo, ['rev-parse', 'HEAD^{tree}']), /is not a commit in --from \(it is a tree\)/);
  refused(good, /--from must be the full path/, { from: 'relative/bob' });
  refused(commitOf(w.repo, { 'a.md': 'a\n' }, { 'docs/link.md': ['120000', 'a.md'] }), /the commit holds a link \(docs\/link\.md\)/);
  refused(commitOf(w.repo, { 'a.md': 'a\n' }, { vendor: ['160000', good] }), /the commit holds another repository \(vendor\)/);
  refused(commitOf(w.repo, { 'a.md': 'a\n' }, { 'B.md': ['100644', 'x'], 'b.md': ['100644', 'y'] }), /would land on one another on a disk that ignores case/);
  refused(commitOf(w.repo, { 'a.md': 'a\n' }, { 'Docs/x.md': ['100644', 'x'], 'docs/y.md': ['100644', 'y'] }), /would land on one another/);
  refused(commitOf(w.repo, {}, { 'skills/a.md': ['100644', 'x'] }), /holds no file the Bob folder would keep/);
  // Two spellings of one accented name (the Mac's git folds them when adding, so the tree is made directly).
  const blob = (t) => git(w.repo, ['hash-object', '-w', '--stdin'], Buffer.from(t));
  const tree = git(w.repo, ['mktree'], Buffer.from(`100644 blob ${blob('x')}\tcaf\u00e9.md\n100644 blob ${blob('y')}\tcafe\u0301.md\n`));
  refused(git(w.repo, ['commit-tree', tree, '-m', 'x']), /would land on one another/);
  // A name that is not plain, as a file or as a folder (a tree made directly: git's own commands refuse to add one).
  const sub = git(w.repo, ['mktree'], Buffer.from(`100644 blob ${blob('x')}\tz.md\n`));
  for (const [line, shown] of [[`100644 blob ${blob('x')}\t..`, '..'], [`040000 tree ${sub}\t..`, '..'], [`040000 tree ${sub}\t.GIT`, '.GIT']]) {
    const t = git(w.repo, ['mktree', '--missing'], Buffer.from(`100644 blob ${blob('a')}\ta.md\n${line}\n`));
    refused(git(w.repo, ['commit-tree', t, '-m', 'x']), new RegExp(`the commit holds a path that is not plain \\(${JSON.stringify(shown).replace(/\./g, '\\.')}`));
  }
  // A list over the review runner's 1 MiB: many long names (one blob), refused before any change.
  const long = Array.from({ length: 5000 }, (_, i) => `100644 blob ${blob('x')}\t${String(i).padStart(5, '0')}${'n'.repeat(200)}.md`).join('\n');
  refused(git(w.repo, ['commit-tree', git(w.repo, ['mktree'], Buffer.from(`${long}\n`)), '-m', 'x']), /the file list comes to \d+ bytes, over the review runner's 1048576/);
  assert.deepEqual(before(), was, 'nothing changed by any refusal');
  // A link inside a skills folder is never installed, so it is left out with the folder rather than refused.
  w.run(commitOf(w.repo, { 'a.md': 'a\n' }, { 'skills/l': ['120000', 'a.md'] }));
  assert.deepEqual(Object.keys(w.pair().folder), ['a.md']);
  const p = readCommit(port(w.repo), good); assert.deepEqual(p.problems, []);
});

test('bob: a run again replaces the folder and the list together; the old files go', () => {
  const w = world();
  w.run(commitOf(w.repo, FILES));
  const c2 = commitOf(w.repo, { 'README.md': '# Bob 2\n', 'new/one.md': 'n\n' });
  w.run(c2);
  const p = w.pair();
  assert.deepEqual(Object.keys(p.folder).sort(), ['README.md', 'new/one.md']);
  assert.deepEqual(p.folder, p.list); assert.equal(p.commit, c2);
  assert.equal(existsSync(w.at(`${BASE}/${BOB_OLD}`)), false);
});

test('bob: a step that fails partway leaves the old pair in force, never a mixed one', () => {
  for (const failAt of ['swap-folder', 'swap-list', 'read-back']) {
    const w = world();
    const c1 = commitOf(w.repo, FILES); w.run(c1);
    const old = w.pair();
    const c2 = commitOf(w.repo, { 'README.md': '# Bob 2\n' });
    const p = w.plan(c2);
    const rename = w.mac.rename; const write = w.mac.write;
    if (failAt === 'swap-folder') w.mac.rename = (a, b) => { if (a === `${BASE}/${BOB_NEW}`) throw new Error('planted'); return rename(a, b); };
    if (failAt === 'swap-list') w.mac.rename = (a, b) => { if (b.endsWith(`/${BOB_MANIFEST}`)) throw new Error('planted'); return rename(a, b); };
    if (failAt === 'read-back') { w.mac.write = (q, t, m) => write(q, q.endsWith('README.md') ? 'not what git gave\n' : t, m); }
    assert.throws(() => apply(p.ops, { log: () => {} }), failAt === 'read-back' ? /what landed in .* is not the commit's files \(changed README\.md\); the old Bob folder and list are as they were/ : /planted/);
    w.mac.rename = rename; w.mac.write = write;
    assert.deepEqual(w.pair(), old, `${failAt}: the old pair, whole`);
    assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok), failAt);
    // And the next run, with nothing failing, puts the new pair in.
    w.run(c2); assert.equal(w.pair().commit, c2); assert.deepEqual(w.pair().folder, w.pair().list);
  }
});

test('bob: a run after a crash between the renames puts a missing folder back first, or drops the old one, then builds the pair', () => {
  // Crash after the old folder went aside and before the new came in: the folder is missing, .bob-old holds it.
  const w = world();
  const c1 = commitOf(w.repo, FILES); w.run(c1);
  const p2 = w.plan(commitOf(w.repo, { 'z.md': 'z\n' }));   // planned while the folder is still there
  w.mac.rename(`${BASE}/bob`, `${BASE}/${BOB_OLD}`);
  mkdirSync(w.at(`${BASE}/${BOB_NEW}`)); writeFileSync(w.at(`${BASE}/${BOB_NEW}/half.md`), 'half');
  assert.match(checkBob(w.mac, w.cfg).find((x) => !x.ok).why, /ENOENT|missing/i, 'meanwhile check 13 refuses: no folder');
  apply(p2.ops.slice(0, 1), { log: () => {} });
  assert.deepEqual(w.pair().folder, w.pair().list, 'the old folder is back, with its own list');
  assert.equal(existsSync(w.at(`${BASE}/${BOB_NEW}`)), false);
  apply(p2.ops.slice(1), { log: () => {} });
  assert.deepEqual(Object.keys(w.pair().folder), ['z.md']); assert.deepEqual(w.pair().folder, w.pair().list);
  // A stale .bob-old beside a folder that matches its list is dropped, not put back over it.
  mkdirSync(w.at(`${BASE}/${BOB_OLD}`)); writeFileSync(w.at(`${BASE}/${BOB_OLD}/stale.md`), 's');
  const c3 = commitOf(w.repo, { 'y.md': 'y\n' });
  w.run(c3);
  assert.equal(existsSync(w.at(`${BASE}/${BOB_OLD}`)), false);
  assert.deepEqual(Object.keys(w.pair().folder), ['y.md']);
});

test('bob (PR-1 r1 m2): after a crash between the folder and the list, a run that then fails leaves the old pair, not the half-done one', () => {
  const w = world();
  const c1 = commitOf(w.repo, FILES); w.run(c1);
  const old = w.pair();
  // The real state: the new folder in place, the old one aside, the old list in force (ops 0-4 ran, then the swap's first two renames).
  const p2 = w.plan(commitOf(w.repo, { 'z.md': 'z\n' }));
  apply(p2.ops.slice(0, 5), { log: () => {} });
  w.mac.rename(`${BASE}/bob`, `${BASE}/${BOB_OLD}`); w.mac.rename(`${BASE}/${BOB_NEW}`, `${BASE}/bob`);
  assert.equal(checkBob(w.mac, w.cfg).every((x) => x.ok), false, 'meanwhile check 13 refuses: folder and list differ');
  // The next run's read-back fails (a write lands wrong): the folder that matches the list in force is the one left.
  const p3 = w.plan(commitOf(w.repo, { 'y.md': 'y\n' }));
  const write = w.mac.write; w.mac.write = (q, t, m) => write(q, q.endsWith('y.md') ? 'not what git gave\n' : t, m);
  assert.throws(() => apply(p3.ops, { log: () => {} }), /is not the commit's files/);
  w.mac.write = write;
  assert.deepEqual(w.pair(), old, 'the old folder is back with its own list');
  assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok));
  assert.equal(existsSync(w.at(`${BASE}/${BOB_OLD}`)), false);
});

test('bob (PR-1 r1 m3, m7): a failed commit or keep rename is said and seen by the check; a failed undo says the folder may be missing', () => {
  const w = world();
  const c1 = commitOf(w.repo, FILES); w.run(c1);
  const c2 = commitOf(w.repo, { 'README.md': '# Bob 2\n' });
  const p = w.plan(c2);
  const rename = w.mac.rename;
  w.mac.rename = (a, b) => { if (b.endsWith(`/${BOB_COMMIT}`)) throw new Error('planted'); return rename(a, b); };
  assert.throws(() => apply(p.ops, { log: () => {} }), /planted; the new Bob folder and list are in force, but the commit record or the updater's keep is not: run it again/);
  w.mac.rename = rename;
  const bad = checkBob(w.mac, w.cfg, { commit: c2 }).filter((x) => !x.ok);
  assert.deepEqual(bad.map((x) => x.why), [`it records ${c1}`], JSON.stringify(bad));
  w.run(c2);
  assert.ok(checkBob(w.mac, w.cfg, { commit: c2 }).every((x) => x.ok));
  // The keep list without the two names is seen.
  const u = w.at(`${w.realCopy}/${UPDATER_CONFIG}`);
  const conf = JSON.parse(readFileSync(u, 'utf8'));
  writeFileSync(u, JSON.stringify({ ...conf, keep: conf.keep.filter((n) => n !== BOB_MANIFEST) }));
  assert.match(checkBob(w.mac, w.cfg, { commit: c2 }).find((x) => !x.ok).what, /the updater keeps bob-manifest\.json and bob-commit\.txt/);
  writeFileSync(u, JSON.stringify(conf));
  // The list's rename fails, then putting the folder back fails too: both are said.
  const c3 = commitOf(w.repo, { 'q.md': 'q\n' });
  const p3 = w.plan(c3);
  w.mac.rename = (a, b) => { if (b.endsWith(`/${BOB_MANIFEST}`)) throw new Error('list planted'); if (b === `${BASE}/${BOB_NEW}`) throw new Error('undo planted'); return rename(a, b); };
  assert.throws(() => apply(p3.ops, { log: () => {} }), /list planted; putting the old Bob folder back failed too \(undo planted\): .* may be missing, with the old folder at .*\.bob-old/);
  w.mac.rename = rename;
  w.run(c3); assert.ok(checkBob(w.mac, w.cfg, { commit: c3 }).every((x) => x.ok));
});

test('bob (PR-1 r1 M1): root takes no object git gives that is not its own; a replace ref does not change what is installed', () => {
  const w = world();
  const c = commitOf(w.repo, { 'rules.md': 'vetted\n' });
  const vetted = git(w.repo, ['rev-parse', `${c}:rules.md`]);
  const other = git(w.repo, ['hash-object', '-w', '--stdin'], Buffer.from('other\n'));
  git(w.repo, ['replace', vetted, other]);
  // A git that honours the replace ref hands the other bytes for the vetted id: refused.
  assert.match(readCommit(port(w.repo), c).problems.join('\n'), new RegExp(`object ${vetted} with contents that are not its own`));
  // bobGit turns replace refs off: the vetted bytes are installed.
  const real = bobGit({ euid: () => 501 }, { owner: 'sam', gitBin: '/usr/bin/git' }, w.repo);
  const got = readCommit(real, c);
  assert.deepEqual(got.problems, []);
  assert.equal(got.files[0].bytes.toString(), 'vetted\n');
  // A changed object (stored under the vetted id, other bytes of the same length) is refused too.
  const changed = (args, input) => { const r = port(w.repo)(['--no-replace-objects', ...args], input); return { ...r, stdout: Buffer.from(r.stdout.toString('latin1').replace('vetted', 'other!'), 'latin1') }; };
  assert.match(readCommit(changed, c).problems.join('\n'), /not its own/);
});

test('bob: refused without an installed copy, a copy that is a plain folder, or the orchestrate user', () => {
  const w = world();
  const c = commitOf(w.repo, { 'a.md': 'a\n' });
  const mac2 = fakeMac({ users: { orchestrate: { UniqueID: '501', PrimaryGroupID: '501' } } });
  assert.match(planBob(mac2, w.cfg, { from: w.repo, commit: c, git: port(w.repo) }).problems.join('\n'), /is not installed yet: run install first/);
  mkdirSync(join(mac2.prefix, `${BASE}/install/orchestrate`), { recursive: true });
  assert.match(planBob(mac2, w.cfg, { from: w.repo, commit: c, git: port(w.repo) }).problems.join('\n'), /is a plain folder, not the link the updater flips/);
  w.mac.users.delete('orchestrate');
  assert.match(w.plan(c).problems.join('\n'), /the Mac user orchestrate .* was not found/);
});

test('bob: git runs as the owner under root (root only reads what it prints), as whoever runs a dry run, with a cleared environment', () => {
  const seen = [];
  const run = (file, argv, opts) => { seen.push({ file, argv, env: opts.env }); return { status: 0, stdout: Buffer.from('commit\n'), stderr: '' }; };
  const cfg = { owner: 'sam', gitBin: '/usr/bin/git' };
  bobGit({ euid: () => 0 }, cfg, '/Users/sam/bob', { run })(['cat-file', '-t', 'x']);
  bobGit({ euid: () => 501 }, cfg, '/Users/sam/bob', { run })(['cat-file', '-t', 'x']);
  assert.deepEqual(seen[0].file, '/usr/bin/sudo');
  // sudo resets the environment: git's is set after it, through env, so it reaches git (PR-1 r1 m1).
  const gitEnv = ['PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL=C', 'GIT_TERMINAL_PROMPT=0', 'GIT_CONFIG_NOSYSTEM=1'];
  assert.deepEqual(seen[0].argv, ['-n', '-H', '-u', 'sam', '/usr/bin/env', ...gitEnv, '/usr/bin/git', '--no-replace-objects', '-C', '/Users/sam/bob', 'cat-file', '-t', 'x']);
  assert.deepEqual([seen[1].file, ...seen[1].argv], ['/usr/bin/git', '--no-replace-objects', '-C', '/Users/sam/bob', 'cat-file', '-t', 'x']);
  assert.deepEqual(Object.entries(seen[1].env).map(([k, v]) => `${k}=${v}`), gitEnv, 'a dry run\'s git gets the same, directly');
});

test('setup.mjs bob: needs --from and a full --commit, which belong to it alone; planCommand puts the wall first; planning changes nothing', () => {
  const c = 'a'.repeat(40);
  assert.deepEqual([parseArgs(['bob', '--from', '/x', '--commit', c]).from, parseArgs(['bob', '--from', '/x', '--commit', c]).commit], ['/x', c]);
  assert.throws(() => parseArgs(['bob', '--from', '/x']), /bob needs --from .* and --commit/);
  assert.throws(() => parseArgs(['bob', '--commit', c]), /bob needs --from/);
  assert.throws(() => parseArgs(['bob', '--from', '/x', '--commit', 'abc']), /--commit must be the full commit/);
  assert.throws(() => parseArgs(['install', '--from', '/x']), /--from and --commit are only for bob/);
  const w = world();
  const commit = commitOf(w.repo, FILES);
  const planned = planCommand(w.mac, w.cfg, { cmd: 'bob', from: w.repo, commit }, { bobGitOf: (from) => port(from) });
  assert.deepEqual(planned.problems, []);
  assert.match(planned.ops[0].text, /every folder above .* is root's alone/, 'the base wall goes first');
  assert.ok(planned.ops.some((o) => /write the 4 files of .* \(left out: 4 skill file\(s\)\)/.test(o.text)), planned.ops.map((o) => o.text).join('\n'));
  assert.deepEqual(readdirSync(w.at(`${BASE}/bob`)), [], 'planning changes nothing');
  assert.equal(bobManifestPath(w.cfg), `${BASE}/install/orchestrate/${BOB_MANIFEST}`);
});

// L1035: tests for the plants #472's audit found uncaught (audit-pr472-r1 m3, c3).

test('L1035 A9/A10: setup.mjs bob, run end to end as root, checks the pair after the run, and the recorded commit against --commit', () => {
  const B = '/Library/orch-bob';   // an install config's base is never under /Users
  const raw = { base: B, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: 'com.example.orch-bob', runnerConfig: '/nowhere/review.json' };
  const mac = fakeMac({ euid: 0 });
  const run = (args) => {
    const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644);
    const lines = []; const code = main(args, { io: mac, bobGitOf: (from) => port(from), out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) });
    return { code, text: lines.join('\n') };
  };
  const uf = run(['users-folders']); assert.equal(uf.code, 0, uf.text);
  installedCopy(mac.at, B);
  const repo = realpathSync(tempDir('orch-bob-main-'));
  const c1 = commitOf(repo, FILES);
  const ok = run(['bob', '--from', repo, '--commit', c1]);
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /^done: all \d+ items PASS\.$/m, 'the after-run check ran');
  assert.doesNotMatch(ok.text, /^done\.$/m);
  // The step records a commit other than --commit: only the check given --commit sees it.
  const other = 'd'.repeat(40);
  const write = mac.write; mac.write = (p, t, m) => write(p, p.includes(BOB_COMMIT) ? `${other}\n` : t, m);
  const c2 = commitOf(repo, { 'README.md': '# Bob 2\n' });
  const bad = run(['bob', '--from', repo, '--commit', c2]);
  mac.write = write;
  assert.equal(bad.code, 1, bad.text);
  assert.match(bad.text, new RegExp(`^ERR FAIL  the Bob commit ${c2} is recorded beside the list \\(${BOB_COMMIT.replace('.', '\\.')}\\) — it records ${other}$`, 'm'));
  assert.match(bad.text, /^1 item\(s\) still FAIL after the run\.$/m);
});

test('L1035 A7: --commit in upper case is refused when the arguments are read', () => {
  assert.throws(() => parseArgs(['bob', '--from', '/x', '--commit', 'A'.repeat(40)]), /--commit must be the full commit/);
  assert.throws(() => parseArgs(['bob', '--from', '/x', '--commit', `${'a'.repeat(39)}F`]), /--commit must be the full commit/);
});

test('L1035 A12/A13: --from that is a link or a file is refused, and so is an orchestrate user with id 0; nothing changes', () => {
  const w = world();
  const c = commitOf(w.repo, { 'a.md': 'a\n' });
  const d = realpathSync(tempDir('orch-bob-from-'));
  symlinkSync(w.repo, join(d, 'link'));
  writeFileSync(join(d, 'file'), 'x');
  for (const from of [join(d, 'link'), join(d, 'file'), join(d, 'none')]) {
    const p = w.plan(c, { from });
    assert.equal(p.ops.length, 0, from); assert.match(p.problems.join('\n'), new RegExp(`--from ${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is not a folder \\(a link is not taken`), from);
  }
  assert.deepEqual(w.plan(c).problems, [], 'the folder itself is taken');
  w.mac.users.set('orchestrate', { ...w.mac.users.get('orchestrate'), UniqueID: '0' });
  const root = w.plan(c);
  assert.equal(root.ops.length, 0); assert.match(root.problems.join('\n'), /the Mac user orchestrate \(the Bob folder's owner\) was not found/);
  assert.deepEqual(readdirSync(w.at(`${BASE}/bob`)), []);
});

test('L1035 A15/A16/A39: checkBob FAILs an unreadable or non-JSON list, a link inside the folder, and (without --commit) a record that is not a commit', () => {
  const w = world();
  const c = commitOf(w.repo, FILES); w.run(c);
  assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok));
  const list = w.at(`${w.realCopy}/${BOB_MANIFEST}`); const text = readFileSync(list, 'utf8');
  const failed = (re, why, opts) => { const bad = checkBob(w.mac, w.cfg, opts).filter((x) => !x.ok); assert.ok(bad.some((x) => re.test(x.what) && (why === undefined || why.test(x.why))), JSON.stringify(bad)); };
  writeFileSync(list, 'not json'); failed(/the Bob file list .* can be read$/, /not JSON/);
  rmSync(list); failed(/the Bob file list .* can be read$/, /ENOENT/);
  writeFileSync(list, text);
  // A link inside the folder (a top-level one, and one deeper down).
  const bob = w.at(`${BASE}/bob`);
  symlinkSync('README.md', join(bob, 'extra.md')); failed(/the Bob folder .* holds only plain files$/, /extra\.md landed as a link/);
  rmSync(join(bob, 'extra.md'));
  symlinkSync('/etc', join(bob, 'modes/deep/etc')); failed(/holds only plain files$/, /landed as a link/);
  rmSync(join(bob, 'modes/deep/etc'));
  assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok), 'put back: it passes');
  // The record is checked for a commit's form even when no --commit is given.
  const rec = w.at(`${w.realCopy}/${BOB_COMMIT}`);
  for (const junk of ['', 'garbage', c.slice(0, 39), c.toUpperCase()]) {
    writeFileSync(rec, `${junk}\n`); failed(/the Bob commit is recorded beside the list/, undefined);
  }
  writeFileSync(rec, `${c}\n`); assert.ok(checkBob(w.mac, w.cfg).every((x) => x.ok));
});

test('L1035 A31: the list, the commit record and the updater config are written 0644, root\'s', () => {
  const w = world();
  const c = commitOf(w.repo, FILES); w.run(c);
  for (const n of [BOB_MANIFEST, BOB_COMMIT, UPDATER_CONFIG]) {
    assert.equal(lstatSync(w.at(`${w.realCopy}/${n}`)).mode & 0o7777, 0o644, n);
    assert.deepEqual(w.mac.owners.get(`${w.realCopy}/${n}`), { uid: w.mac.rootUid, gid: 0 }, n);
  }
});

test('L1035 A18: an object whose header names another id is refused as not that object', () => {
  const w = world();
  const c = commitOf(w.repo, { 'rules.md': 'r\n' });
  const swapped = (args, input) => {
    const r = port(w.repo)(args, input);
    if (!args.includes('--batch')) return r;
    const s = r.stdout.toString('latin1'); const nl = s.indexOf('\n');
    return { ...r, stdout: Buffer.from(`${'f'.repeat(40)}${s.slice(40, nl)}${s.slice(nl)}`, 'latin1') };
  };
  assert.match(readCommit(swapped, c).problems.join('\n'), /git gave something other than object [0-9a-f]{40}/);
});

test('L1035 A40: a folder that can\'t be read never counts as matching the list: a crash\'s .bob-old that does is put back', () => {
  const w = world();
  const c1 = commitOf(w.repo, FILES); w.run(c1);
  const old = w.pair();
  // As a crash leaves it: the old folder aside (it matches the list in force), and the folder in place holds a link.
  cpTree(w.at(`${BASE}/bob`), w.at(`${BASE}/${BOB_OLD}`));
  symlinkSync('README.md', w.at(`${BASE}/bob/extra.md`));
  const p = w.plan(commitOf(w.repo, { 'z.md': 'z\n' }));
  apply(p.ops.slice(0, 1), { log: () => {} });
  assert.equal(existsSync(w.at(`${BASE}/${BOB_OLD}`)), false);
  assert.equal(existsSync(w.at(`${BASE}/bob/extra.md`)), false, 'the folder with the link is gone');
  assert.deepEqual(w.pair().folder, old.list, 'the old folder, which matches the list, is back');
});

test('L1035 A45: a commit of exactly 20000 files is taken; 20001 is refused', () => {
  const w = world();
  commitOf(w.repo, { 'a.md': 'a\n' });   // makes the repository
  const blob = git(w.repo, ['hash-object', '-w', '--stdin'], Buffer.from('x'));
  const of = (n) => {
    const t = git(w.repo, ['mktree'], Buffer.from(`${Array.from({ length: n }, (_, i) => `100644 blob ${blob}\t${String(i).padStart(5, '0')}.md`).join('\n')}\n`));
    return git(w.repo, ['commit-tree', t, '-m', 'x']);
  };
  const at = readCommit(port(w.repo), of(20000));
  assert.deepEqual(at.problems, []); assert.equal(at.files.length, 20000);
  assert.match(readCommit(port(w.repo), of(20001)).problems.join('\n'), /the commit holds more than 20000 files/);
});
