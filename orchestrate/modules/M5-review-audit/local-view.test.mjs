// local-view.test.mjs: the mirror's git view and M10's GitHub one answer alike (L80, L92 Minor 4). One real repository,
// read through localGitView and through makeGitView over a stand-in that answers GitHub's questions from git.
// Run: node --test orchestrate/modules/M5-review-audit/local-view.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOk } from '../M4-workshop/git/safe-git.mjs';
import { makeGitView, touchedPaths } from '../M10-rules/git-view.mjs';
import { localGitView } from './local-view.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';

const GH_STATUS = { A: 'added', D: 'removed', M: 'modified', T: 'changed', R: 'renamed' };

// GitHub's answers, worked out from the same repository; renames are found, as GitHub finds them.
const githubFrom = (gitDir) => {
  const run = (args) => gitOk(args, { gitDir });
  const get = async (path) => {
    let m;
    if ((m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const t = await run(['cat-file', 'commit', m[1]]);
      return { status: 200, json: { sha: m[1], tree: { sha: /^tree (\S+)$/m.exec(t)[1] }, parents: [...t.matchAll(/^parent (\S+)$/gm)].map((p) => ({ sha: p[1] })) } };
    }
    if ((m = /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path))) {
      const lines = (await run(['ls-tree', '-r', '-t', '-z', m[1]])).split('\0').filter(Boolean);
      return { status: 200, json: { truncated: false, tree: lines.map((l) => { const [meta, name] = l.split('\t'); const [mode, type, sha] = meta.split(' '); return { path: name, mode, type, sha }; }) } };
    }
    if ((m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path))) {
      const [, b, h] = m;
      const mb = (await run(['merge-base', b, h])).trim();
      const status = b === h ? 'identical' : mb === b ? 'ahead' : mb === h ? 'behind' : 'diverged';
      const p = (await run(['diff', '--name-status', '-z', '-M', mb, h])).split('\0').filter(Boolean);
      const files = [];
      for (let i = 0; i < p.length;) {
        const code = p[i][0];
        if (code === 'R') { files.push({ status: GH_STATUS.R, previous_filename: p[i + 1], filename: p[i + 2] }); i += 3; } else { files.push({ status: GH_STATUS[code], filename: p[i + 1] }); i += 2; }
      }
      return { status: 200, json: { status, merge_base_commit: { sha: mb }, files } };
    }
    return { status: 404, json: null };
  };
  return { get };
};

async function world() {
  const src = join(tempDir('m5-view-'), 'src');
  const gitDir = join(src, '.git');
  mkdirSync(src, { recursive: true });
  const g = (args) => gitOk(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { gitDir, workTree: src, cwd: src });
  await gitOk(['init', '-q', src], { gitDir });
  const put = (p, t) => { mkdirSync(dirname(join(src, p)), { recursive: true }); writeFileSync(join(src, p), t); };
  const commit = async (msg) => { await g(['add', '.']); await g(['commit', '-q', '-m', msg]); return (await gitOk(['rev-parse', 'HEAD'], { gitDir })).trim(); };
  put('app/a.mjs', 'one\n'); put('app/moved.mjs', Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('')); put('run.sh', 'echo\n'); put('docs/x.md', 'x\n'); put('gone.md', 'bye\n'); put('kind', 'a file that becomes a link\n');
  await g(['branch', '-M', 'main']).catch(() => {});
  const root = await commit('root');
  await g(['branch', '-M', 'main']);
  put('app/a.mjs', 'two\n'); put('app/new.mjs', 'new\n'); rmSync(join(src, 'gone.md')); chmodSync(join(src, 'run.sh'), 0o755); symlinkSync('docs/x.md', join(src, 'link')); rmSync(join(src, 'kind')); symlinkSync('docs/x.md', join(src, 'kind'));
  await g(['mv', 'app/moved.mjs', 'app/renamed.mjs']);
  const ahead = await commit('change');
  await g(['switch', '-q', '-c', 'side', root]);
  put('docs/y.md', 'y\n');
  const side = await commit('side');
  return { gitDir, root, ahead, side, local: localGitView({ gitDir }), remote: makeGitView({ gh: githubFrom(gitDir), owner: 'sample-org', repo: 'sample-app' }) };
}

const both = async (w, ask) => [await ask(w.local), await ask(w.remote)];
const same = async (w, ask, what) => { const [l, r] = await both(w, ask); assert.deepEqual(l, r, what); return l; };

test('L92 Minor 4: both views read a commit alike', async () => {
  const w = await world();
  const c = await same(w, (v) => v.commit(w.ahead).then((x) => ({ ...x, parents: [...x.parents] })));
  assert.deepEqual(c.parents, [w.root]);
});

test('L92 Minor 4: both views agree on a compare in every direction, and on the names a change touches', async () => {
  const w = await world();
  const shape = (v, b, h) => v.compare(b, h).then((c) => ({ status: c.status, mergeBase: c.mergeBase, touched: [...touchedPaths(c.files)].sort() }));
  assert.equal((await same(w, (v) => shape(v, w.root, w.ahead))).status, 'ahead');
  assert.equal((await same(w, (v) => shape(v, w.ahead, w.root))).status, 'behind');
  assert.equal((await same(w, (v) => shape(v, w.ahead, w.ahead))).status, 'identical');
  const d = await same(w, (v) => shape(v, w.ahead, w.side));
  assert.equal(d.status, 'diverged');
  assert.equal(d.mergeBase, w.root);
  assert.deepEqual(d.touched, ['docs/y.md'], 'from the merge base, as GitHub\'s three-dot compare is');
  // The one kept difference: GitHub reports a rename, the mirror an add and a remove. Both name the old and the new file.
  const [l, r] = await both(w, (v) => v.compare(w.root, w.ahead));
  assert.ok(r.files.some((f) => f.status === 'renamed' && f.previous_path === 'app/moved.mjs'));
  const named = (list, p) => list.find((f) => f.path === p)?.status;
  assert.equal(named(l.files, 'app/moved.mjs'), 'removed');
  assert.equal(named(l.files, 'app/renamed.mjs'), 'added');
  for (const p of ['app/a.mjs', 'app/new.mjs', 'gone.md', 'run.sh', 'link', 'kind']) assert.equal(named(l.files, p), named(r.files, p), p);
  assert.equal(named(l.files, 'kind'), 'modified', 'a file that became a link is a change of that file');
});

test('L92 Minor 4: both views read a file\'s version alike: file, mode, link, nothing there, a folder', async () => {
  const w = await world();
  for (const p of ['app/a.mjs', 'run.sh', 'link', 'gone.md', 'no/such', 'app']) await same(w, (v) => v.entry(w.ahead, p), p);
  assert.equal((await w.local.entry(w.ahead, 'run.sh')).mode, '100755');
  assert.equal((await w.local.entry(w.ahead, 'link')).mode, '120000');
  assert.equal(await w.local.entry(w.ahead, 'app'), null, 'a folder is no file');
});

test('L92 Minor 4: both views agree on history, and refuse a list of files between commits that are not in line', async () => {
  const w = await world();
  for (const [s, tip, want] of [[w.root, w.ahead, true], [w.ahead, w.ahead, true], [w.ahead, w.root, false], [w.side, w.ahead, false]]) {
    assert.equal(await same(w, (v) => v.onHistory(s, tip)), want);
  }
  await same(w, (v) => v.files(w.root, w.side).then((f) => f.map((x) => x.path)));
  for (const v of [w.local, w.remote]) await assert.rejects(v.files(w.ahead, w.side), /is not an ancestor of/);
  for (const v of [w.local, w.remote]) await assert.rejects(v.commit('nope'), /not a full commit id/);
});

test('L92 Minor 4: a commit the mirror does not hold throws, so it never reads as no change', async () => {
  const w = await world();
  const missing = 'a'.repeat(40);
  await assert.rejects(w.local.commit(missing));
  await assert.rejects(w.local.compare(w.root, missing));
  await assert.rejects(w.local.onHistory(missing, w.root));
  await assert.rejects(w.local.entry(missing, 'app/a.mjs'));
});
