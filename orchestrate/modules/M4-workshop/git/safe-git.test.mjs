import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeGitEnv, git, gitOk, checkGitVersion, checkMirror, initMirror, MIRROR_CONFIG_TEMPLATE, SAFE_CONFIG } from './safe-git.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const tmp = () => tempDir('orch-sg-');

test('environment starts empty: no inherited GIT_* or other variables survive', () => {
  process.env.GIT_SSH_COMMAND = 'planted';
  process.env.ORCH_PLANTED_VAR = 'x';
  const env = safeGitEnv({ gitDir: '/x' });
  delete process.env.GIT_SSH_COMMAND; delete process.env.ORCH_PLANTED_VAR;
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.ORCH_PLANTED_VAR, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_DIR, '/x');
  assert.equal(Number(env.GIT_CONFIG_COUNT), SAFE_CONFIG.length);
});

test('git version is at least the floor', async () => {
  const v = await checkGitVersion();
  assert.equal(v.ok, true, v.reason);
});

test('missing GIT_DIR is refused, never discovered from the folder', async () => {
  const r = await git(['status']);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /GIT_DIR is required/);
});

test('a repository hook and fsmonitor planted by a worker never run', async () => {
  const d = tmp();
  const gd = join(d, '.git');
  await gitOk(['init', '-q', d], { gitDir: gd });
  const marker = join(d, 'RAN');
  mkdirSync(join(gd, 'hooks'), { recursive: true });
  writeFileSync(join(gd, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(join(gd, 'config'), readFileSync(join(gd, 'config'), 'utf8') + `[core]\n\tfsmonitor = /bin/sh -c 'touch ${marker}'\n\thooksPath = ${join(gd, 'hooks')}\n`);
  writeFileSync(join(d, 'a.txt'), 'a');
  await gitOk(['add', 'a.txt'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['commit', '-q', '-m', 'x'], { gitDir: gd, workTree: d, cwd: d });
  await gitOk(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d });
  assert.throws(() => statSync(marker), 'a planted hook or fsmonitor ran');
  // Planted fault: drop the safe fsmonitor setting and the same planted program does run,
  // so the check above can fail.
  await gitOk(['status', '--porcelain'], { gitDir: gd, workTree: d, cwd: d, extraConfig: [['core.fsmonitor', `/bin/sh -c 'touch ${marker}'`]] });
  assert.ok(statSync(marker), 'the planted-fault half should have run the program');
});

test('mirror check: the template passes, every planted extra is refused', async () => {
  const d = join(tmp(), 'm.git');
  await initMirror(d);
  assert.deepEqual(checkMirror(d), { ok: true });
  const plant = async (fn, re) => {
    const m = join(tmp(), 'm.git'); await initMirror(m); fn(m);
    const r = checkMirror(m); assert.equal(r.ok, false); assert.match(r.reason, re);
  };
  await plant((m) => writeFileSync(join(m, 'config'), MIRROR_CONFIG_TEMPLATE + '[include]\n\tpath = x\n'), /differs/);
  await plant((m) => writeFileSync(join(m, 'config'), MIRROR_CONFIG_TEMPLATE + '[remote "origin"]\n\turl = x\n'), /differs/);
  await plant((m) => { mkdirSync(join(m, 'objects/info'), { recursive: true }); writeFileSync(join(m, 'objects/info/alternates'), '/x\n'); }, /alternates/);
  await plant((m) => { mkdirSync(join(m, 'info'), { recursive: true }); writeFileSync(join(m, 'info/attributes'), '* filter=x\n'); }, /attributes/);
  await plant((m) => { mkdirSync(join(m, 'hooks')); writeFileSync(join(m, 'hooks/post-update'), '#!/bin/sh\n'); }, /hooks/);
  assert.equal(checkMirror(join(tmp(), 'nope')).ok, false);
});

// Static check (review 0b-4 M5): no other file under orchestrate/ starts git itself.
// Known exceptions, each with the lead's call and date. The test fails if a listed file stops starting git, so the
// line is deleted in the change that routes it through safe-git.mjs.
const KNOWN_EXCEPTIONS = {
  'modules/M12-sensors/history.mjs': 'L36, 29 Oct 2026: lane 3 routes it through safe-git.mjs once this is on main',
};
test('no other orchestrate file spawns git directly', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..', '..');
  const offenders = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, n.name);
      if (n.isDirectory()) { if (n.name !== 'node_modules' && n.name !== 'third_party') walk(p); continue; }
      if (!/\.(mjs|js|cjs|sh)$/.test(n.name) || n.name.endsWith('.test.mjs')) continue;
      if (p === join(here, 'safe-git.mjs')) continue;
      const src = readFileSync(p, 'utf8');
      const spawnsGit = /(spawn|exec|execFile|spawnSync|execSync|execFileSync)\s*\(\s*['"`]git\b/.test(src);
      const shellGit = n.name.endsWith('.sh') && /^\s*git\s+\w/m.test(src);
      if (spawnsGit || shellGit) offenders.push(relative(root, p));
    }
  };
  walk(root);
  for (const f of Object.keys(KNOWN_EXCEPTIONS)) assert.ok(offenders.includes(f), `${f} no longer starts git: delete its line in KNOWN_EXCEPTIONS`);
  assert.deepEqual(offenders.filter((f) => !(f in KNOWN_EXCEPTIONS)), []);
});
