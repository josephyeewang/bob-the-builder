// R-0b-45: the push script, against real git. A local bare repo stands in for GitHub (reached only
// through the test harness's constructor argument). The secret scan uses a fake gitleaks for the
// logic, and the real one, where installed, for the bypass cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, existsSync, renameSync, chmodSync, copyFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync, deflateSync } from 'node:zlib';
import { gitOk, git, initMirror, callLog } from './safe-git.mjs';
import { createPushScript, readBundleHeader, githubUrl } from './push.mjs';
import { refusedPath } from './push-refusals.mjs';
import { DO_PLANE_TOML, RULES_VERSION, scanSecrets } from './gitleaks.mjs';
import { crc32 } from './binary-files.mjs';
import { chunk, makePng, ihdr } from './png-fixture.mjs';
import { startGate, factId } from './start-gate.mjs';
import { memoryRecord } from '../../../shared/record.mjs';
import { fakeRules, allow, deny } from '../../../shared/rules.mjs';

const tmp = (p = 'orch-push-') => mkdtempSync(join(tmpdir(), p));
const WF = '.github/workflows/outside-check.yml';
const PRODUCT = 'p1';
const REPO = 'owner/test-repo';

// A GitHub-token-shaped string made at run time, so no secret-shaped text is ever committed.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fakeSecret = () => `ghp_${[...randomBytes(36)].map((b) => ALNUM[b % ALNUM.length]).join('')}`;

// The real scanner, only when it is the pinned version (the vendored rules are that version's).
const realGitleaks = await (async () => {
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(d, 'gitleaks');
    if (!d || !existsSync(p)) continue;
    try { return (await import('node:child_process')).execFileSync(p, ['version'], { encoding: 'utf8' }).includes(RULES_VERSION) ? p : null; } catch { return null; }
  }
  return null;
})();

// ---- a fake gitleaks: checks it got the Do-plane's config and flags, and does as its mode file says ----
function makeFakeScanner(dir) {
  const bin = join(dir, 'gitleaks');
  const mode = join(dir, 'mode');
  writeFileSync(mode, 'clean');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
if (a[0] === 'version') { console.log(mode === 'wrongversion' ? '1.0.0' : '8.30.1'); process.exit(0); }
const at = (f) => a[a.indexOf(f) + 1];
if (at('--config') !== ${JSON.stringify(join(dir, 'do-plane.toml'))} || at('--gitleaks-ignore-path') !== ${JSON.stringify(join(dir, 'empty-ignore'))} || !a.includes('--ignore-gitleaks-allow')) process.exit(7);
if (Object.keys(process.env).some((k) => k.startsWith('GITLEAKS'))) process.exit(8);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, a[0] + '\\n');
if (mode === 'crash') process.exit(2);
if (mode === 'noreport') process.exit(0);
if (mode === 'stdinquit' && a[0] === 'stdin') process.exit(3);
fs.writeFileSync(at('--report-path'), mode === 'leak' ? JSON.stringify([{ RuleID: 'fake-rule', File: 'x.txt' }]) : mode === 'leakname' ? JSON.stringify([{ RuleID: 'fake-rule', File: 'docs/ghp_' + 'A1'.repeat(18) + '.txt' }]) : mode === 'badreport' ? 'not json' : '[]');
process.exit(mode === 'leak' || mode === 'leakname' ? 1 : 0);
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'do-plane.toml'), DO_PLANE_TOML);
  writeFileSync(join(dir, 'empty-ignore'), '');
  return { setup: { bin, version: '8.30.1', config: join(dir, 'do-plane.toml'), ignoreFile: join(dir, 'empty-ignore') }, setMode: (m) => writeFileSync(mode, m), calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '') };
}

// Positive control for the bypass cases: real gitleaks run the careless way (the branch's own
// config, ignore file, inline comments or environment), to show each bypass does hide the secret
// there, so the push script's refusal is not luck. Returns the exit code (0 = nothing found).
async function scanAsCareless(clone, args, env = {}) {
  const { spawnSync } = await import('node:child_process');
  return spawnSync(realGitleaks, ['git', clone, '--no-banner', '--exit-code', '1', ...args], { env: { PATH: '/usr/bin:/bin', HOME: tmp(), ...env }, encoding: 'utf8' }).status;
}

async function realScanner(dir) {
  const out = (await import('node:child_process')).execFileSync(realGitleaks, ['version'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'do-plane.toml'), DO_PLANE_TOML);
  writeFileSync(join(dir, 'empty-ignore'), '');
  return { bin: realGitleaks, version: /(\d+\.\d+\.\d+)/.exec(out)[1], config: join(dir, 'do-plane.toml'), ignoreFile: join(dir, 'empty-ignore') };
}

// ---- the world: "GitHub", the mirror, a worker clone, the record, rules and the gate's ports ----
async function world({ scanner: scannerOverride, gate = {} } = {}) {
  const root = tmp();
  const gh = join(root, 'gh.git');
  await gitOk(['init', '--bare', '-q', gh], { gitDir: gh });
  const seed = join(root, 'seed');
  mkdirSync(seed);
  const sg = { gitDir: join(seed, '.git'), workTree: seed, cwd: seed };
  await gitOk(['init', '-q', seed], sg);
  mkdirSync(join(seed, '.github/workflows'), { recursive: true });
  writeFileSync(join(seed, '.github/workflows/ci.yml'), 'name: ci\n');
  writeFileSync(join(seed, 'README.md'), 'hello\n');
  writeFileSync(join(seed, 'app.txt'), 'app\n');
  await gitOk(['add', '-A'], sg);
  await gitOk(['commit', '-q', '-m', 'first'], sg);
  await gitOk(['push', '-q', gh, 'HEAD:refs/heads/main'], sg);

  const mirror = join(root, 'mirror.git');
  await initMirror(mirror);
  await gitOk(['fetch', '-q', gh, '+refs/heads/main:refs/heads/main'], { gitDir: mirror });

  const clone = join(root, 'clone');
  mkdirSync(clone);
  const cg = { gitDir: join(clone, '.git'), workTree: clone, cwd: clone };
  await gitOk(['init', '-q', clone], cg);
  await gitOk(['fetch', '-q', '--update-head-ok', gh, 'refs/heads/main:refs/heads/main'], cg);
  await gitOk(['checkout', '-q', '-b', 'card/c-1', 'main'], cg);

  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { mode: 0o700 });
  const privateDir = join(root, 'private');
  mkdirSync(privateDir, { mode: 0o700 });

  const record = memoryRecord();
  record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: 0, doc: { product: PRODUCT, card: 'C-1', branch: 'card/c-1', outbox, attempt: 'a1' } });
  record.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { title: 'Card one', summary: 'does a thing' } });
  const writeFact = (kind, doc) => { const cur = record.read('fact', factId(kind, PRODUCT)); return record.write({ actor: 'sensors', entity: 'fact', id: factId(kind, PRODUCT), expectRev: cur?.rev ?? 0, doc }); };
  const fresh = () => new Date().toISOString();
  writeFact('vercel_skip', { product: PRODUCT, vercel_project: 'prj_1', read_at: fresh(), result: true });
  writeFact('vercel_env', { product: PRODUCT, vercel_project: 'prj_1', read_at: fresh(), result: true });

  const fake = makeFakeScanner(mkdtempSync(join(root, 'scan-')));
  const issues = []; const prs = [];
  const values = { 'product.repo': REPO, 'product.mirror': mirror, 'product.onboarded': true, 'product.default_branch': 'main', 'product.vercel_project': 'prj_1', 'outside_check.workflow': WF };
  const answers = { push_branch: allow('fine') };
  const run = { workflow_path: WF, event: 'schedule', head_branch: 'main', run_at: fresh(), steps: [{ product: PRODUCT, conclusion: 'success' }] };
  const ports = {
    record,
    rules: fakeRules({ answers, values }),
    privateDir,
    scanner: scannerOverride ?? fake.setup,
    getRobotToken: async () => 'robot-key-for-test',
    readRun: async () => (gate.readRun ? gate.readRun() : run),
    workflowRule: gate.workflowRule ?? (async () => ({ ok: true })),
    issues: { upsert: async (i) => { issues.push(i); } },
    pullRequests: { upsert: async (p) => { prs.push(p); return { number: 1 }; } },
    testRemote: () => gh,
  };
  const commit = async (msg, fn) => { fn?.(clone); await gitOk(['add', '-A'], cg); await gitOk(['commit', '-q', '--allow-empty', '-m', msg], cg); };
  const bundle = async (args = ['refs/heads/card/c-1', '^refs/heads/main']) => { rmSync(join(outbox, 'bundle-C-1.bundle'), { force: true }); await gitOk(['bundle', 'create', '-q', join(outbox, 'bundle-C-1.bundle'), ...args], cg); };
  const ghRefs = async () => (await gitOk(['for-each-ref', '--format=%(refname) %(objectname)'], { gitDir: gh })).trim();
  const push = (over = {}) => createPushScript({ ...ports, ...over })('S-1');
  return { root, gh, mirror, clone, cg, outbox, record, values, answers, run, fake, issues, prs, commit, bundle, ghRefs, push, ports, writeFact };
}

async function refusedAndUntouched(w, re, over) {
  const before = await w.ghRefs();
  const r = await w.push(over);
  assert.equal(r.ok, false, 'should be refused');
  assert.match(r.reason, re);
  assert.equal(await w.ghRefs(), before, 'GitHub changed on a refusal');
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.result, 'refused');
  return r;
}

test('all good: pushes exactly refs/heads/<branch>, opens the PR, moves the mirror branch; the key never reaches a command line', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'app.txt'), 'changed\n'));
  await w.bundle();
  callLog.length = 0;
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  const refs = await w.ghRefs();
  assert.deepEqual(refs.split('\n').map((l) => l.split(' ')[0]).sort(), ['refs/heads/card/c-1', 'refs/heads/main']);
  const tip = (await gitOk(['rev-parse', 'refs/heads/card/c-1'], w.cg)).trim();
  assert.match(refs, new RegExp(`refs/heads/card/c-1 ${tip}`));
  assert.equal((await gitOk(['rev-parse', 'refs/heads/card/c-1'], { gitDir: w.mirror })).trim(), tip);
  assert.equal(w.prs.length, 1);
  assert.equal(w.prs[0].branch, 'card/c-1');
  assert.equal(w.record.read('fact', 'push.C-1.a1').doc.result, 'pushed');
  assert.ok(!JSON.stringify(callLog).includes('robot-key-for-test'), 'the key appeared in a logged command');
  assert.ok(!callLog.some((c) => c.args.some((a) => /^\+/.test(a) && a.includes('card/'))), 'a forced push spec was used');
  assert.match(w.fake.calls(), /git\ndir\nstdin/);
  const holding = await git(['rev-parse', '--verify', 'refs/orchestrate/incoming/C-1/a1'], { gitDir: w.mirror });
  assert.notEqual(holding.code, 0, 'the holding ref was left behind');
});

const REFUSED_PATHS = ['.github/workflows/x.yml', 'pkg/.github/workflows/x.yml', '.github/actions/a/action.yml', 'pkg/.github/actions/a/action.yml',
  '.claude/settings.json', 'src/.claude/skills/x/SKILL.md', '.mcp.json', 'a/b/.mcp.json', 'CLAUDE.local.md', 'docs/CLAUDE.local.md',
  ...['vercel.json', 'vercel.ts', 'vercel.js', 'vercel.mjs', 'vercel.cjs', 'vercel.mts'].flatMap((n) => [n, `apps/web/${n}`]),
  '.Claude/settings.json', '.GitHub/Workflows/x.yml', 'VERCEL.JSON', '.git​hub/workflows/x.yml', '.cla­ude/x', '.gitmodules'];

test('the refusal list: every name, at the root and at depth, in any case and with invisible characters', () => {
  for (const p of REFUSED_PATHS) assert.ok(refusedPath(p), `${p} not refused`);
  for (const p of ['README.md', '.github/CODEOWNERS', '.github/dependabot.yml', 'src/claude/x.js', 'vercel.json.md', 'my-vercel.json', 'workflows/x.yml', 'docs/.github.md']) assert.equal(refusedPath(p), null, `${p} wrongly refused`);
});

test('every refused name, pushed for real at the root and at depth: refused, GitHub untouched', async () => {
  for (const p of REFUSED_PATHS.filter((x) => !/[​­]/.test(x))) {
    const w = await world();
    await w.commit(`add ${p}`, (c) => { mkdirSync(dirname(join(c, p)), { recursive: true }); writeFileSync(join(c, p), 'x\n'); });
    await w.bundle();
    await refusedAndUntouched(w, /touches files no card may/);
  }
});

test('a rename to a workflow file, a deleted workflow file, and add-then-remove across two commits are all refused', async () => {
  let w = await world();
  await w.commit('rename', () => renameSync(join(w.clone, 'app.txt'), join(w.clone, '.github/workflows/x.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /\.github\/workflows/);

  w = await world();
  await w.commit('delete', () => rmSync(join(w.clone, '.github/workflows/ci.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /\.github\/workflows/);

  w = await world();
  await w.commit('add', (c) => writeFileSync(join(c, '.github/workflows/evil.yml'), 'x\n'));
  await w.commit('remove', (c) => rmSync(join(c, '.github/workflows/evil.yml')));
  await w.bundle();
  await refusedAndUntouched(w, /evil\.yml/);
});

test('links and submodules: a new link, a link to /etc, a file changed into a link, a submodule entry', async () => {
  let w = await world();
  await w.commit('link', (c) => symlinkSync('app.txt', join(c, 'l')));
  await w.bundle();
  await refusedAndUntouched(w, /link/);

  w = await world();
  await w.commit('etc', (c) => symlinkSync('/etc', join(c, 'etc')));
  await w.bundle();
  await refusedAndUntouched(w, /link/);

  w = await world();
  await w.commit('type change', (c) => { rmSync(join(c, 'README.md')); symlinkSync('app.txt', join(c, 'README.md')); });
  await w.bundle();
  await refusedAndUntouched(w, /README\.md: adds or changes a link/);

  w = await world();
  const head = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['update-index', '--add', '--cacheinfo', `160000,${head},sub`], w.cg);
  await gitOk(['commit', '-q', '-m', 'submodule'], w.cg);
  await w.bundle();
  await refusedAndUntouched(w, /submodule/);
});

test('a merge commit and a first (root) commit are refused', async () => {
  let w = await world();
  await w.commit('a', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await gitOk(['checkout', '-q', '-b', 'side', 'main'], w.cg);
  await w.commit('b', (c) => writeFileSync(join(c, 'b.txt'), 'b\n'));
  await gitOk(['checkout', '-q', 'card/c-1'], w.cg);
  await gitOk(['merge', '-q', '--no-ff', '-m', 'merge', 'side'], w.cg);
  await w.bundle();
  await refusedAndUntouched(w, /merge/);

  w = await world();
  await gitOk(['checkout', '-q', '--orphan', 'tmp'], w.cg);
  await w.commit('root', (c) => writeFileSync(join(c, 'r.txt'), 'r\n'));
  await gitOk(['branch', '-f', 'card/c-1', 'tmp'], w.cg);
  await w.bundle(['refs/heads/card/c-1']);
  await refusedAndUntouched(w, /first commit/);
});

test('bad bundles: HEAD, two refs, main, a tag, missing earlier commits, a filter, a link, none at all', async () => {
  const cases = [
    [['HEAD', 'refs/heads/card/c-1', '^refs/heads/main'], /exactly one branch|holds HEAD/],
    [['refs/heads/card/c-1', 'refs/heads/main'], /exactly one branch/],
    [['refs/heads/main'], /holds refs\/heads\/main/],
  ];
  for (const [args, re] of cases) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle(args);
    await refusedAndUntouched(w, re);
  }
  let w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await gitOk(['tag', 'v1'], w.cg);
  await w.bundle(['refs/heads/card/c-1', 'refs/tags/v1', '^refs/heads/main']);
  await refusedAndUntouched(w, /exactly one branch/);

  w = await world();
  await w.commit('hidden', (c) => writeFileSync(join(c, 'h.txt'), 'h\n'));
  const hidden = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle(['refs/heads/card/c-1', `^${hidden}`]);
  await refusedAndUntouched(w, /does not verify/);

  w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  const real = join(w.root, 'elsewhere.bundle');
  renameSync(join(w.outbox, 'bundle-C-1.bundle'), real);
  symlinkSync(real, join(w.outbox, 'bundle-C-1.bundle'));
  await refusedAndUntouched(w, /link/);

  w = await world();
  await refusedAndUntouched(w, /no bundle/);

  const f = join(tmp(), 'f.bundle');
  writeFileSync(f, `# v3 git bundle\n@filter=blob:none\n${'a'.repeat(40)} refs/heads/card/c-1\n\nPACK`);
  assert.throws(() => readBundleHeader(f, 'card/c-1'), /capability/);
  writeFileSync(f, `# v3 git bundle\n@object-format=sha1\n${'a'.repeat(40)} refs/heads/card/c-1\n\nPACK`);
  assert.equal(readBundleHeader(f, 'card/c-1'), 'a'.repeat(40));
});

test('a bundle swapped after the private copy is taken: the copy is what gets pushed', async () => {
  const w = await world();
  await w.commit('good', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const good = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.bundle();
  // A second, bad bundle is ready; the swap happens while the start gate is being read.
  await w.commit('evil', (c) => writeFileSync(join(c, '.mcp.json'), '{}'));
  const evil = join(w.root, 'evil.bundle');
  await gitOk(['bundle', 'create', '-q', evil, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  const r = await w.push({ readRun: async () => { copyFileSync(evil, join(w.outbox, 'bundle-C-1.bundle')); return w.run; } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, good);
  assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${good}`));
});

test('a bundle swapped right after the private copy is taken, before any check: the copy is what gets checked and pushed', async () => {
  const w = await world();
  await w.commit('good', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const good = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.bundle();
  await w.commit('evil', (c) => writeFileSync(join(c, '.mcp.json'), '{}'));
  const evil = join(w.root, 'evil.bundle');
  await gitOk(['bundle', 'create', '-q', evil, 'refs/heads/card/c-1', '^refs/heads/main'], w.cg);
  let swapped = false;
  const r = await w.push({ afterStage: () => { copyFileSync(evil, join(w.outbox, 'bundle-C-1.bundle')); swapped = true; } });
  assert.equal(swapped, true, 'the seam ran');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.tip, good);
  assert.match(await w.ghRefs(), new RegExp(`refs/heads/card/c-1 ${good}`));
});

test('scanner problems refuse: a finding, a crash (exit 2), the wrong version, a missing binary, a changed config', async () => {
  for (const [mode, re] of [['leak', /found 1 likely secret/], ['crash', /did not finish cleanly/], ['wrongversion', /pin is 8\.30\.1/], ['noreport', /did not finish cleanly/], ['badreport', /did not finish cleanly/]]) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle();
    w.fake.setMode(mode);
    await refusedAndUntouched(w, re);
  }
  let w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /scanner is missing/, { scanner: { ...w.ports.scanner, bin: join(w.root, 'nope') } });
  writeFileSync(w.ports.scanner.config, DO_PLANE_TOML + '[allowlist]\npaths = [".*"]\n');
  await refusedAndUntouched(w, /config has changed/);
});

test('an added "gitleaks:allow" line is refused by the push script itself, in any case', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'key = "x" # GitLeaks:Allow\n'));
  await w.bundle();
  await refusedAndUntouched(w, /gitleaks:allow/);
});

test('real gitleaks: a planted secret is stopped despite the branch\'s .gitleaks.toml, .gitleaksignore and GITLEAKS_CONFIG', { skip: realGitleaks ? false : 'skipped: gitleaks not installed' }, async () => {
  const scanDir = tmp();
  const scanner = await realScanner(scanDir);
  // (a) the branch's own allow-list.
  let w = await world({ scanner });
  const s1 = fakeSecret();
  await w.commit('allowlist', (c) => { writeFileSync(join(c, '.gitleaks.toml'), '[extend]\nuseDefault = true\n[allowlist]\npaths = [\'\'\'.*\'\'\']\nregexes = [\'\'\'.*\'\'\']\n'); writeFileSync(join(c, 'cfg.txt'), `token = "${s1}"\n`); });
  await w.bundle();
  assert.equal(await scanAsCareless(w.clone, ['--config', scanner.config]), 1, 'control: gitleaks should see the secret');
  // gitleaks picks up the branch's own .gitleaks.toml when no config is named.
  assert.equal(await scanAsCareless(w.clone, []), 0, 'control: the branch allow-list should hide it');
  await refusedAndUntouched(w, /likely secret/);
  // (b) a fingerprint in the branch's .gitleaksignore (worked out from a first scan).
  w = await world({ scanner });
  const s2 = fakeSecret();
  await w.commit('secret', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${s2}"\n`));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('ignore', (c) => writeFileSync(join(c, '.gitleaksignore'), `${sha}:cfg.txt:github-pat:1\n`));
  await w.bundle();
  assert.equal(await scanAsCareless(w.clone, ['--gitleaks-ignore-path', w.clone]), 0, 'control: the branch ignore file should hide it');
  await refusedAndUntouched(w, /likely secret/);
  // (d) GITLEAKS_CONFIG in the caller's own environment, pointing at an allow-everything config.
  w = await world({ scanner });
  const s3 = fakeSecret();
  await w.commit('secret', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${s3}"\n`));
  await w.bundle();
  const loose = join(scanDir, 'loose.toml');
  writeFileSync(loose, '[allowlist]\nregexes = [\'\'\'.*\'\'\']\n');
  assert.equal(await scanAsCareless(w.clone, [], { GITLEAKS_CONFIG: loose }), 0, 'control: GITLEAKS_CONFIG should hide it');
  process.env.GITLEAKS_CONFIG = loose; process.env.GITLEAKS_CONFIG_TOML = readFileSync(loose, 'utf8');
  try { await refusedAndUntouched(w, /likely secret/); } finally { delete process.env.GITLEAKS_CONFIG; delete process.env.GITLEAKS_CONFIG_TOML; }
  // A secret in a commit message is stopped too (review m5).
  w = await world({ scanner });
  await w.commit(`notes ${fakeSecret()}`, (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /message/);
  // Planted fault: the same scan on a clean branch passes, so the refusals above are the scanner's.
  w = await world({ scanner });
  await w.commit('clean', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  const ok = await w.push();
  assert.equal(ok.ok, true, ok.reason);
});

test('real gitleaks: an inline gitleaks:allow comment does not hide a secret from the scan itself', { skip: realGitleaks ? false : 'skipped: gitleaks not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  await w.commit('inline', (c) => writeFileSync(join(c, 'cfg.txt'), `token = "${fakeSecret()}" # gitleaks:allow\n`));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  assert.equal(await scanAsCareless(w.clone, []), 0, 'control: without the flag the inline comment hides it');
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  const r = await scanSecrets({ setup: scanner, mirror: w.mirror, shas: [sha], messages: [], privateDir: tmp() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /likely secret/);
});

test('R-0b-47 MAT-1, real gitleaks: a secret in a folder or file the default rules skip is still stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const old = join(tmp(), 'old.toml');
  writeFileSync(old, '[extend]\nuseDefault = true\n');
  for (const path of ['node_modules/a.js', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'docs/x.svg']) {
    const w = await world({ scanner });
    await w.commit('skipped place', (c) => { mkdirSync(dirname(join(c, path)), { recursive: true }); writeFileSync(join(c, path), `token = "${fakeSecret()}"\n`); });
    // Positive control: the default rules, with their allow-list, let it through.
    assert.equal(await scanAsCareless(w.clone, ['--config', old]), 0, `control: the default allow-list skips ${path}`);
    await w.bundle();
    const r = await refusedAndUntouched(w, /likely secret/);
    assert.ok(r.reason.includes(path.split('/').at(-1)), path);
  }
});

test('R-0b-47 MAT-2, real gitleaks: a secret in a file git calls binary is still stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  await w.commit('binary', (c) => writeFileSync(join(c, 'b.js'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\nconst t = "${fakeSecret()}";\n`)])));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  // Positive control: the git scan alone, without the files, misses it.
  assert.deepEqual(await scanSecrets({ setup: scanner, mirror: w.mirror, shas: [sha], messages: [], privateDir: tmp() }), { ok: true, binaries: [] });
  await w.bundle();
  const r = await refusedAndUntouched(w, /b\.js cannot be scanned for secrets/);
  assert.match(r.reason, /not plain UTF-8 text/);
});

test('R-0b-47 MAT-1: the vendored rules have no allow-list and are all there', () => {
  assert.doesNotMatch(DO_PLANE_TOML.replace(/^#.*$/gm, ''), /allowlist/i);
  assert.ok((DO_PLANE_TOML.match(/^\[\[rules\]\]$/gm) ?? []).length > 200, 'the default rules are all there');
  assert.doesNotMatch(DO_PLANE_TOML, /useDefault/);
});

test('start gate on a full push: a shut gate pushes nothing and raises one issue', async () => {
  const w = await world({ gate: { workflowRule: async () => ({ ok: false, reason: 'writes with a broad key' }) } });
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /start gate is shut.*ci\.yml/);
  assert.equal(w.issues.length, 1);
  assert.equal(w.issues[0].key, `start-gate-${PRODUCT}`);
});

test('start gate: each fact bad, missing, stale by 1 s, or for the wrong repo shuts it, with one issue each time', async () => {
  const w = await world();
  const now = Date.now();
  const base = { product: PRODUCT, mirror: w.mirror, record: w.record, workflowPath: WF, workflowRule: async () => ({ ok: true }), vercelProject: 'prj_1', now };
  const goodRun = { ...w.run, run_at: new Date(now - 1000).toISOString() };
  const gate = async (over) => { const issues = []; const r = await startGate({ ...base, readRun: async () => goodRun, cache: {}, issues: { upsert: async (i) => { issues.push(i); } }, ...over }); return { r, issues }; };
  const ok = await gate({});
  assert.equal(ok.r.ok, true, ok.r.reason);
  const iso = (ms) => new Date(ms).toISOString();
  const runCases = [
    [{ ...goodRun, steps: [{ product: PRODUCT, conclusion: 'failure' }] }, /read-only/],
    [{ ...goodRun, steps: [{ product: 'other', conclusion: 'success' }] }, /read-only/],
    [{ ...goodRun, run_at: iso(now - 2 * 3600 * 1000 - 1000) }, /2 hours/], // the review's 2 hours, written out (MIN-3)
    [{ ...goodRun, run_at: iso(now + 2 * 60 * 1000) }, /2 hours/], // dated in the future (MIN-2)
    [{ ...goodRun, workflow_path: '.github/workflows/other.yml' }, /pinned workflow/],
    [{ ...goodRun, event: 'push' }, /scheduled or manual/],
    [{ ...goodRun, head_branch: 'card/x' }, /not on main/],
    [null, /could not be read/],
  ];
  for (const [run, re] of runCases) {
    const { r, issues } = await gate({ readRun: async () => run });
    assert.equal(r.ok, false); assert.match(r.reason, re); assert.equal(issues.length, 1);
  }
  const t = await gate({ readRun: async () => { throw new Error('offline'); } });
  assert.equal(t.r.ok, false);
  for (const rule of [undefined, async () => ({ ok: false, reason: 'bad' }), async () => { throw new Error('boom'); }]) {
    const { r, issues } = await gate({ workflowRule: rule });
    assert.equal(r.ok, false); assert.equal(issues.length, 1);
  }
  for (const kind of ['vercel_skip', 'vercel_env']) {
    const good = { product: PRODUCT, vercel_project: 'prj_1', read_at: iso(now - 1000), result: true };
    for (const [doc, re] of [[{ ...good, result: false }, /fails/], [{ ...good, read_at: iso(now - 10 * 60 * 1000 - 1000) }, /10 minutes/], [{ ...good, read_at: iso(now + 2 * 60 * 1000) }, /10 minutes/], [{ ...good, vercel_project: 'prj_2' }, /another project/], [{ ...good, product: 'p2' }, /another project/], [{ ...good, read_at: 'soon' }, /10 minutes/]]) {
      w.writeFact(kind, doc);
      const { r, issues } = await gate({});
      assert.equal(r.ok, false, `${kind} ${JSON.stringify(doc)}`); assert.match(r.reason, re); assert.equal(issues.length, 1);
      w.writeFact(kind, good);
    }
  }
  // Just inside each limit is still open, so the limits are not shorter than the review's either.
  const inside = await gate({ readRun: async () => ({ ...goodRun, run_at: iso(now - 2 * 3600 * 1000 + 60 * 1000) }) });
  assert.equal(inside.r.ok, true, inside.r.reason);
  for (const kind of ['vercel_skip', 'vercel_env']) w.writeFact(kind, { product: PRODUCT, vercel_project: 'prj_1', read_at: iso(now - 10 * 60 * 1000 + 60 * 1000), result: true });
  assert.equal((await gate({})).r.ok, true);
  const empty = await startGate({ ...base, record: memoryRecord(), readRun: async () => goodRun, cache: {}, issues: { upsert: async () => {} } });
  assert.match(empty.reason, /no fact yet/);
});

test('start gate: the outside check run is read at most once an hour', async () => {
  const w = await world();
  let reads = 0;
  const now = Date.now();
  const cache = {};
  const readRun = async () => { reads += 1; return { ...w.run, run_at: new Date(now).toISOString() }; };
  const g = (at) => startGate({ product: PRODUCT, mirror: w.mirror, record: w.record, readRun, workflowPath: WF, workflowRule: async () => ({ ok: true }), vercelProject: 'prj_1', cache, issues: { upsert: async () => {} }, now: at });
  await g(now); await g(now + 59 * 60 * 1000);
  assert.equal(reads, 1);
  await g(now + 61 * 60 * 1000);
  assert.equal(reads, 2);
});

test('the branch on GitHub moved (a catch-up merge): a plain push is refused; a fix round built on it fast-forwards (L4)', async () => {
  const w = await world();
  await w.commit('one', (c) => writeFileSync(join(c, 'a.txt'), '1\n'));
  await w.bundle();
  assert.equal((await w.push()).ok, true);
  // GitHub's "update branch" adds a merge on the card branch.
  const other = join(w.root, 'other');
  mkdirSync(other);
  const og = { gitDir: join(other, '.git'), workTree: other, cwd: other };
  await gitOk(['init', '-q', other], og);
  await gitOk(['fetch', '-q', '--update-head-ok', w.gh, 'refs/heads/main:refs/heads/main', 'refs/heads/card/c-1:refs/heads/card/c-1'], og);
  await gitOk(['checkout', '-q', 'main'], og);
  writeFileSync(join(other, 'm.txt'), 'm\n');
  await gitOk(['add', '-A'], og); await gitOk(['commit', '-q', '-m', 'main moves'], og);
  await gitOk(['checkout', '-q', 'card/c-1'], og);
  await gitOk(['merge', '-q', '--no-ff', '-m', 'update branch', 'main'], og);
  await gitOk(['push', '-q', w.gh, 'main:refs/heads/main', 'card/c-1:refs/heads/card/c-1'], og);
  // A fix round built on the old bundle: refused, GitHub untouched.
  await w.commit('two', (c) => writeFileSync(join(c, 'a.txt'), '2\n'));
  await w.bundle();
  const before = await w.ghRefs();
  const r = await createPushScript(w.ports)('S-1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /has moved/);
  assert.equal(await w.ghRefs(), before);
  // The fix round done right: start from GitHub's branch, then commit (the merge is GitHub's, not new).
  await gitOk(['fetch', '-q', w.gh, '+refs/heads/card/c-1:refs/heads/card/c-1-gh', '+refs/heads/main:refs/heads/main'], w.cg);
  await gitOk(['reset', '-q', '--hard', 'card/c-1-gh'], w.cg);
  await w.commit('two again', (c) => writeFileSync(join(c, 'a.txt'), '2\n'));
  await w.bundle(['refs/heads/card/c-1', '^refs/heads/card/c-1-gh']);
  const r2 = await createPushScript(w.ports)('S-1');
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(r2.commits, 1);
});

test('inputs come from the record only; the branch, product and rules are checked; production addresses are github.com only', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /not allow/, { rules: fakeRules({ answers: { push_branch: deny('frozen') }, values: w.values }) });
  await refusedAndUntouched(w, /not onboarded/, { rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.onboarded': false } }) });
  for (const repo of ['../x', 'a/b/c', 'evil.com:x/y', 'a b/c', 'owner/..']) {
    const r = await createPushScript({ ...w.ports, testRemote: undefined, rules: fakeRules({ answers: w.answers, values: { ...w.values, 'product.repo': repo } }) })('S-1');
    assert.equal(r.ok, false, repo); assert.match(r.reason, /valid GitHub repo/);
  }
  assert.equal(githubUrl(REPO), `https://github.com/${REPO}.git`);
  await refusedAndUntouched(w, /robot key/, { getRobotToken: async () => '' });
  for (const [doc, re] of [[{ product: PRODUCT, card: 'C-1', branch: 'main', outbox: w.outbox, attempt: 'a1' }, /not the card's branch/], [{ product: PRODUCT, card: 'C-1', branch: 'card/c-2', outbox: w.outbox, attempt: 'a1' }, /not the card's branch/], [{ product: PRODUCT, card: '../x', branch: 'card/x', outbox: w.outbox, attempt: 'a1' }, /bad card id/]]) {
    const cur = w.record.read('session', 'S-1');
    w.record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: cur.rev, doc });
    const r = await w.push();
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
  const r = await createPushScript(w.ports)('S-404');
  assert.match(r.reason, /no launch record/);
});

test('R-0b-47 MIN-5: a bundle over the size cap, or with a second hard link, is refused', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  await refusedAndUntouched(w, /larger than 10 bytes/, { bundleCap: 10 });
  linkSync(join(w.outbox, 'bundle-C-1.bundle'), join(w.root, 'second-name.bundle'));
  await refusedAndUntouched(w, /more than one link/);
});

test('R-0b-47 MIN-11: a mirror holding grafts, shallow or a commit-graph refuses', async () => {
  for (const f of ['info/grafts', 'shallow', 'objects/info/commit-graph', 'objects/info/commit-graphs']) {
    const w = await world();
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    await w.bundle();
    mkdirSync(dirname(join(w.mirror, f)), { recursive: true });
    if (f.endsWith('commit-graphs')) mkdirSync(join(w.mirror, f)); else writeFileSync(join(w.mirror, f), '');
    await refusedAndUntouched(w, new RegExp(`mirror has ${f}`));
  }
});

test('R-0b-47 MIN-1: a program that quits before reading its input is refused, and the process lives on', async () => {
  const r = await git(['version'], { gitDir: tmp(), input: Buffer.alloc(16 * 1024 * 1024, 'x'), purpose: 'test' });
  assert.equal(r.code, 0);
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  w.fake.setMode('stdinquit');
  const s = await scanSecrets({ setup: w.ports.scanner, mirror: w.mirror, shas: [sha], messages: [[sha, 'x'.repeat(16 * 1024 * 1024)]], privateDir: tmp() });
  assert.equal(s.ok, false);
  assert.match(s.reason, /header lines or file names: .*did not finish cleanly/);
});

test('the mirror is checked before every push: a planted alternates file refuses', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  writeFileSync(join(w.mirror, 'objects/info/alternates'), join(w.clone, '.git/objects') + '\n');
  await refusedAndUntouched(w, /alternates/);
});

// ---- R-0b-46: git never runs inside a worker's copy (save-work is the one, after its reset) ----
import { createSaveWork, CLONE_CONFIG_TEMPLATE } from './save-work.mjs';
import { prepareWorkerCopy } from '../launcher/worker-copy.mjs';
import { readdirSync, statSync } from 'node:fs';

const HOOK_NAMES = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction',
  'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-pre-submit', 'post-index-change'];

/** Plants every program-running setting git has in the clone; each program writes a marker. */
async function boobyTrap(w) {
  const markers = join(w.root, 'markers');
  mkdirSync(markers);
  const prog = (name) => { const p = join(w.root, 'traps', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat\n`); chmodSync(p, 0o755); return p; };
  // Committed first, so committing does not itself run the filter.
  await w.commit('attributes', (c) => { writeFileSync(join(c, '.gitattributes'), '* filter=x diff=x\n'); writeFileSync(join(c, 'app.txt'), 'changed\n'); });
  const hooks = join(w.root, 'traps', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const h of HOOK_NAMES) { writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${JSON.stringify(join(markers, `hook-${h}`))}\n`); chmodSync(join(hooks, h), 0o755); }
  const gd = join(w.clone, '.git');
  mkdirSync(join(gd, 'hooks'), { recursive: true });
  for (const h of HOOK_NAMES) copyFileSync(join(hooks, h), join(gd, 'hooks', h));
  chmodSync(join(gd, 'hooks'), 0o755);
  for (const h of HOOK_NAMES) chmodSync(join(gd, 'hooks', h), 0o755);
  const inc = join(w.root, 'traps', 'included.cfg');
  writeFileSync(inc, `[core]\n\tpager = ${prog('pager-inc')}\n[diff]\n\texternal = ${prog('diff-inc')}\n`);
  const cfg = readFileSync(join(gd, 'config'), 'utf8') + [
    '[core]', `\tfsmonitor = ${prog('fsmonitor')}`, `\thooksPath = ${hooks}`, `\tpager = ${prog('pager')}`, `\tsshCommand = ${prog('ssh')}`, `\taskPass = ${prog('askpass')}`,
    '[diff]', `\texternal = ${prog('diff-external')}`, '[diff "x"]', `\ttextconv = ${prog('textconv')}`, `\tcommand = ${prog('diff-driver')}`,
    '[filter "x"]', `\tclean = ${prog('clean')}`, `\tsmudge = ${prog('smudge')}`, `\tprocess = ${prog('process')}`, '\trequired = true',
    '[remote "origin"]', '\turl = https://example.invalid/evil.git', '\tpushurl = https://example.invalid/evil.git',
    '[uploadpack]', `\tpackObjectsHook = ${prog('pack-objects-hook')}`, '[credential]', `\thelper = !${prog('credential')}`,
    '[include]', `\tpath = ${inc}`, '[includeIf "gitdir:/"]', `\tpath = ${inc}`, ''].join('\n');
  writeFileSync(join(gd, 'config'), cfg);
  mkdirSync(join(gd, 'info'), { recursive: true });
  writeFileSync(join(gd, 'info', 'attributes'), '* filter=x diff=x\n');
  writeFileSync(join(gd, 'config.worktree'), `[core]\n\tfsmonitor = ${prog('fsmonitor-wt')}\n`);
  // The clone moves its own idea of GitHub's main.
  writeFileSync(join(gd, 'packed-refs'), `${(await gitOk(['rev-parse', 'HEAD'], w.cg)).trim()} refs/remotes/origin/main\n`);
  return { markers, fired: () => readdirSync(markers) };
}

const lockedRunner = () => { const r = { calls: 0 }; r.run = async (fn) => { r.calls++; return fn(); }; return r; };
const underClone = (w, c) => [c.gitDir, c.cwd, c.workTree].some((p) => p && (p === w.clone || p.startsWith(w.clone + '/')));

test('R-0b-46: a booby-trapped clone: save-work, the push, the launch check and the restart check run none of its programs', async () => {
  const w = await world();
  const mirrorCfg = readFileSync(join(w.mirror, 'config'));
  const mirrorRefs = await gitOk(['for-each-ref'], { gitDir: w.mirror });
  const trap = await boobyTrap(w);
  callLog.length = 0;
  const lock = lockedRunner();
  const saved = await createSaveWork({ runLocked: lock.run })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(lock.calls, 1, 'save-work did not run inside the lock-down');
  assert.equal(readFileSync(join(w.clone, '.git', 'config'), 'utf8'), CLONE_CONFIG_TEMPLATE);
  for (const f of ['hooks', 'config.worktree', 'info/attributes']) assert.ok(!existsSync(join(w.clone, '.git', f)), `${f} was left`);

  const pushed = await w.push();
  assert.equal(pushed.ok, true, pushed.reason);
  // The push moved the mirror's card branch only; its config and every other ref are untouched.
  assert.deepEqual(readFileSync(join(w.mirror, 'config')), mirrorCfg);
  const refsNow = (await gitOk(['for-each-ref'], { gitDir: w.mirror })).split('\n').filter((l) => l && !l.includes('refs/heads/card/'));
  assert.deepEqual(refsNow.join('\n'), mirrorRefs.trimEnd());

  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main, branch: 'card/c-1' };
  const launch = await prepareWorkerCopy({ product, card, dest: join(w.root, 'fresh') });
  assert.equal(launch.ok, true, launch.reason);
  // Restart from the bundle made out of the trapped clone (it carries `* filter=x`).
  const restart = await prepareWorkerCopy({ product, card, dest: join(w.root, 'restarted'), lastBundle: saved.bundle });
  assert.equal(restart.ok, true, restart.reason);
  assert.ok(existsSync(join(w.root, 'restarted', '.gitattributes')), 'the restart did not check out the branch');

  assert.deepEqual(trap.fired(), [], 'a planted program ran');
  const inClone = callLog.filter((c) => underClone(w, c));
  assert.ok(inClone.length > 0 && inClone.every((c) => c.purpose === 'save-work'), `git ran inside the worker copy: ${inClone.map((c) => c.purpose).join(', ')}`);
});

test('R-0b-46: positive control: the planted programs do run when git is used inside the clone the careless way', async () => {
  const w = await world();
  const trap = await boobyTrap(w);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['-C', w.clone, 'status'], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: tmp() } });
  spawnSync('git', ['-C', w.clone, 'diff', 'HEAD~1'], { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: tmp() } });
  assert.ok(trap.fired().length > 0, 'the traps are not live, so the main test would prove nothing');
});

test('R-0b-46: save-work refuses a .git pointer file, a .git link, a foreign alternates file, and running outside the lock-down', async () => {
  const w = await world();
  const args = { clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox };
  const lock = lockedRunner();
  const save = createSaveWork({ runLocked: lock.run });
  assert.match((await createSaveWork({})(args)).reason, /lock-down/);
  assert.match((await save({ ...args, branch: 'card/c-2' })).reason, /bad card branch/);

  // Alternates naming the mirror's objects is allowed; anything else is refused.
  const alt = join(w.clone, '.git', 'objects', 'info', 'alternates');
  mkdirSync(dirname(alt), { recursive: true });
  writeFileSync(alt, `${join(w.mirror, 'objects')}\n`);
  assert.equal((await save(args)).ok, true);
  writeFileSync(alt, `${join(w.gh, 'objects')}\n`);
  assert.match((await save(args)).reason, /borrows objects/);
  rmSync(alt);

  // A gitdir: pointer to another repository.
  const real = join(w.root, 'real-git');
  renameSync(join(w.clone, '.git'), real);
  writeFileSync(join(w.clone, '.git'), `gitdir: ${real}\n`);
  callLog.length = 0;
  assert.match((await save(args)).reason, /not a real folder/);
  assert.equal(callLog.length, 0, 'git ran on a pointer file');
  rmSync(join(w.clone, '.git'));
  symlinkSync(real, join(w.clone, '.git'));
  assert.match((await save(args)).reason, /not a real folder/);
  assert.equal(callLog.length, 0);
});

test('R-0b-46: a worker changing origin and its own main affects no other copy, the mirror, or the Do-plane read of main', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  const second = await prepareWorkerCopy({ product, card: { ...card, id: 'C-2' }, dest: join(w.root, 'second') });
  assert.equal(second.ok, true, second.reason);
  const snap = (dir) => readdirSync(dir, { recursive: true }).filter((p) => !String(p).startsWith('.git/objects') && !String(p).includes('index')).map((p) => { const f = join(dir, String(p)); return statSync(f).isFile() ? `${p}:${readFileSync(f, 'base64')}` : String(p); }).sort();
  const before = { second: snap(join(w.root, 'second')), mirror: snap(w.mirror) };
  await gitOk(['remote', 'add', 'origin', 'https://example.invalid/evil.git'], w.cg);
  await gitOk(['config', 'core.hooksPath', '/tmp/evil-hooks'], w.cg);
  await gitOk(['update-ref', 'refs/remotes/origin/main', (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim()], w.cg);
  await gitOk(['update-ref', 'refs/heads/main', (await gitOk(['commit-tree', '-m', 'evil', `${main}^{tree}`], w.cg)).trim()], w.cg);
  assert.deepEqual(snap(join(w.root, 'second')), before.second);
  assert.deepEqual(snap(w.mirror), before.mirror);
  assert.equal((await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim(), main);
});

test('R-0b-46: a planted alternates file in the mirror refuses the launch check and the restart check too', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  writeFileSync(join(w.mirror, 'objects', 'info', 'alternates'), `${join(w.clone, '.git', 'objects')}\n`);
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'x1') })).reason, /alternates/);
  await w.bundle(['refs/heads/card/c-1']);
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'x2'), lastBundle: join(w.outbox, 'bundle-C-1.bundle') })).reason, /alternates/);
  assert.match((await w.push()).reason, /alternates/);
});

test('L4 restart: the copy fast-forwards to GitHub\'s branch kept in the mirror; a branch that went another way is refused', async () => {
  const w = await world();
  const main = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: w.mirror })).trim();
  await w.commit('one', (c) => writeFileSync(join(c, 'app.txt'), 'one\n'));
  await w.bundle(['refs/heads/card/c-1']);
  const bundleHead = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await w.commit('two, on GitHub', (c) => writeFileSync(join(c, 'app.txt'), 'two\n'));
  const ahead = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['fetch', '-q', w.clone, `refs/heads/card/c-1:refs/orchestrate/remote/card/c-1`], { gitDir: w.mirror });
  const product = { repo: REPO, mirror: w.mirror };
  const card = { id: 'C-1', repo: REPO, commit: main };
  const lastBundle = join(w.outbox, 'bundle-C-1.bundle');
  const r = await prepareWorkerCopy({ product, card, dest: join(w.root, 'ff'), lastBundle });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.head, ahead);
  assert.notEqual(r.head, bundleHead);
  // GitHub's copy behind the bundle: the bundle's head is kept.
  await gitOk(['update-ref', 'refs/orchestrate/remote/card/c-1', main], { gitDir: w.mirror });
  assert.equal((await prepareWorkerCopy({ product, card, dest: join(w.root, 'behind'), lastBundle })).head, bundleHead);
  // Went another way: refused, nothing rewritten.
  const other = (await gitOk(['commit-tree', '-p', main, '-m', 'elsewhere', `${main}^{tree}`], { gitDir: w.mirror })).trim();
  await gitOk(['update-ref', 'refs/orchestrate/remote/card/c-1', other], { gitDir: w.mirror });
  assert.match((await prepareWorkerCopy({ product, card, dest: join(w.root, 'diverged'), lastBundle })).reason, /went another way/);
});

// A one-file zip, stored (not packed); `locked` sets the "encrypted" flag a password lock sets.
function makeZip(name, data, { locked = false } = {}) {
  const n = Buffer.from(name); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(locked ? 1 : 0, 6);
  h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(locked ? 1 : 0, 8);
  c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
  const local = Buffer.concat([h, n, data]); const central = Buffer.concat([c, n]);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(central.length, 12); e.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, e]);
}

test('L28: a file the scan cannot fully read is refused by default: a .tgz, a renamed archive, a locked zip, a zip, UTF-16 text, a zip renamed to .png', async () => {
  const secret = Buffer.from(`key = "${fakeSecret()}"\n`);
  const tgz = gzipSync(secret);
  const cases = {
    'pack.tgz': tgz,
    'data.txt': tgz, // a packed file renamed
    'locked.zip': makeZip('cfg.txt', randomBytes(64), { locked: true }),
    'plain.zip': makeZip('cfg.txt', secret),
    'notes16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([...secret].flatMap((b) => [b, 0]))]),
    'docs/pic.png': makeZip('cfg.txt', secret), // inside an allowed path, but not really a PNG
    'docs/tail.png': Buffer.concat([makePng(), makeZip('cfg.txt', secret)]), // a real PNG with an archive after its end
    'docs/ztxt.png': makePng({ extra: [chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0'), deflateSync(secret)]))] }), // packed text inside
  };
  for (const [path, bytes] of Object.entries(cases)) {
    const w = await world();
    w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
    await w.commit('one', (c) => { mkdirSync(dirname(join(c, path)), { recursive: true }); writeFileSync(join(c, path), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
    assert.ok(r.reason.includes(path), `${path}: ${r.reason}`);
  }
});

test('L28: a real image is allowed only where the rules entry names its type and path, and it is listed in the read-back', async () => {
  const png = makePng();
  // No entry (the first cutover's default), a malformed entry, the wrong type, the wrong path: refused.
  for (const entry of [undefined, 'docs/**/*.png', [{ path: 'docs/**/*.png' }], [{ path: '/docs/*.png', type: 'png' }], [{ path: 'docs/**/*.png', type: 'jpeg' }], [{ path: 'img/*.png', type: 'png' }]]) {
    const w = await world();
    w.values['product.allowed_binaries'] = entry;
    await w.commit('pic', (c) => { mkdirSync(join(c, 'docs', 'a'), { recursive: true }); writeFileSync(join(c, 'docs', 'a', 'pic.png'), png); });
    await w.bundle();
    await refusedAndUntouched(w, /docs\/a\/pic\.png cannot be scanned for secrets/);
  }
  // Planted fault: with the entry, the same push goes through and the image is in the read-back.
  const w = await world();
  w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
  await w.commit('pic', (c) => { mkdirSync(join(c, 'docs', 'a'), { recursive: true }); writeFileSync(join(c, 'docs', 'a', 'pic.png'), png); writeFileSync(join(c, 'a.txt'), 'text\n'); });
  await w.bundle();
  const r = await w.push();
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.binaries, [{ path: 'docs/a/pic.png', type: 'png' }]);
  const fact = w.record.list('fact').find((f) => f.id.startsWith('push.'));
  assert.deepEqual(fact.doc.binaries, [{ path: 'docs/a/pic.png', type: 'png' }]);
});

// Files gitleaks dir skips or misreads when given as they are (round 2 MAT-A).
const typed = (secret) => {
  const s = Buffer.from(`key = "${secret}"\n`);
  const pad = (n) => Buffer.alloc(n, 0);
  const tar = Buffer.alloc(512, 0); tar.write('cfg.txt', 0); tar.write('ustar', 257);
  // A packed .tar.gz: the secret is unreadable until the archive is opened.
  const h = Buffer.alloc(512, 0);
  h.write('cfg.txt', 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${s.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  const tgz = gzipSync(Buffer.concat([h, s, pad(512 - s.length), pad(1024)]));
  return {
    'pack.tar.gz': tgz,
    'db.sqlite': Buffer.concat([Buffer.from('SQLite format 3\0'), pad(84), s]),
    'pack.tar': Buffer.concat([tar, s, pad(100)]),
    'pack.zip': Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), pad(26), s]),
    'tool.bin': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), pad(56), s]),
    'doc.pdf': Buffer.concat([Buffer.from('%PDF-1.4\n%\0\n'), s]),
    'notes16.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([...s].flatMap((b) => [b, 0]))]),
  };
};

test('R-0b-47 round 2 MAT-A (L28), real gitleaks: a file that looks like an archive, a program, a database, a PDF or UTF-16 text is refused unread', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  for (const [name, bytes] of Object.entries(typed(fakeSecret()))) {
    // Positive control: gitleaks dir on the file as it is finds nothing.
    const d = tmp(); mkdirSync(join(d, 'f')); writeFileSync(join(d, 'f', name), bytes);
    const { spawnSync } = await import('node:child_process');
    const c = spawnSync(realGitleaks, ['dir', join(d, 'f'), '--config', scanner.config, '--no-banner', '--exit-code', '1']);
    assert.equal(c.status, 0, `control: gitleaks dir alone misses ${name}`);
    const w = await world({ scanner });
    await w.commit('typed', (c2) => { mkdirSync(join(c2, 'deep'), { recursive: true }); writeFileSync(join(c2, 'deep', name), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
    assert.ok(r.reason.includes(`deep/${name}`), `${name}: ${r.reason}`);
  }
});

test('R-0b-47 round 2 MAT-B, real gitleaks: a secret in an extra commit header line or in a file name is stopped', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  // (a) An invented header line, and a signature block, written straight into the commit object.
  let w;
  for (const header of [(x) => `x-note key = "${x}"`, (x) => `gpgsig -----BEGIN PGP SIGNATURE-----\n \n key = "${x}"\n -----END PGP SIGNATURE-----`]) {
    w = await world({ scanner });
    await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
    const head = (await gitOk(['cat-file', 'commit', 'HEAD'], w.cg)).toString();
    const secret = fakeSecret();
    const forged = head.replace(/\n\n/, `\n${header(secret)}\n\n`);
    const sha = (await gitOk(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { ...w.cg, input: forged })).trim();
    await gitOk(['update-ref', 'refs/heads/card/c-1', sha], w.cg);
    // Positive control: the message and author view the old scan read does not hold it.
    assert.doesNotMatch(await gitOk(['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B', sha], w.cg), new RegExp(secret));
    await w.bundle();
    await refusedAndUntouched(w, /header lines or file names: .*likely secret/);
  }
  // (b) A file whose name is the secret.
  w = await world({ scanner });
  const s2 = fakeSecret();
  await w.commit('named', (c) => writeFileSync(join(c, `${s2}.txt`), 'nothing here\n'));
  await w.bundle();
  await refusedAndUntouched(w, /header lines or file names: .*likely secret/);
});

test('R-0b-47 round 2 MIN-a, MIN-c, real gitleaks: an allowed image is still scanned, under each of its names, executable or not', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const w = await world({ scanner });
  w.values['product.allowed_binaries'] = [{ path: 'docs/**/*.png', type: 'png' }];
  const bytes = makePng({ text: `key = "${fakeSecret()}"` });
  await w.commit('twice', (c) => { mkdirSync(join(c, 'docs'), { recursive: true }); for (const n of ['one.png', 'two.png', 'run.png']) writeFileSync(join(c, 'docs', n), bytes); chmodSync(join(c, 'docs', 'run.png'), 0o755); });
  assert.match(await gitOk(['ls-files', '-s', 'docs/run.png'], w.cg), /^100755/);
  await w.bundle();
  const r = await refusedAndUntouched(w, /the file scan: .*likely secret/);
  for (const n of ['one.png', 'two.png', 'run.png']) assert.ok(r.reason.includes(`docs/${n}`), `${n}: ${r.reason}`);
  // MIN-b: a finding names the repo path, never the private scan folder (moved here, round 3 COS-2).
  assert.doesNotMatch(r.reason, /scan-|files\/(raw|text|nul|img)/);
});

test('R-0b-47 round 3 MIN-2 and MAT-1, real gitleaks: an allowed PNG hiding a secret as UTF-16 text or in its image data is refused', { skip: realGitleaks ? false : 'skipped: gitleaks 8.30.1 not installed' }, async () => {
  const scanner = await realScanner(tmp());
  const line = Buffer.from(`key = "${fakeSecret()}"\n`);
  const pixels = Buffer.concat([Buffer.from([0]), line]);
  const cases = {
    'docs/utf16.png': makePng({ text: Buffer.from([...line].flatMap((b) => [b, 0])) }), // only the zero-bytes-removed view reads it
    'docs/pixels.png': makePng({ head: ihdr({ w: line.length }), pixels }), // only the unpacked view reads it
  };
  for (const [path, bytes] of Object.entries(cases)) {
    const w = await world({ scanner });
    w.values['product.allowed_binaries'] = [{ path: 'docs/*.png', type: 'png' }];
    await w.commit('img', (c) => { mkdirSync(join(c, 'docs'), { recursive: true }); writeFileSync(join(c, path), bytes); });
    await w.bundle();
    const r = await refusedAndUntouched(w, /the file scan: .*likely secret/);
    assert.ok(r.reason.includes(path), `${path}: ${r.reason}`);
  }
});

test('R-0b-47 round 3 MIN-1 and MIN-3: base64 of a packed file is refused, and a secret used as a file name never reaches the record in full', async () => {
  let w = await world();
  await w.commit('b64', (c) => writeFileSync(join(c, 'blob.txt'), `${gzipSync(Buffer.from(`key = "${fakeSecret()}"`)).toString('base64')}\n`));
  await w.bundle();
  await refusedAndUntouched(w, /blob\.txt holds packed data written out as text/);
  w = await world();
  const secret = fakeSecret();
  await w.commit('named', (c) => writeFileSync(join(c, `${secret}.zip`), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
  await w.bundle();
  const r = await refusedAndUntouched(w, /cannot be scanned for secrets/);
  assert.ok(!r.reason.includes(secret.slice(4)), r.reason);
  assert.ok(!JSON.stringify(w.record.read('fact', 'push.C-1.a1').doc).includes(secret.slice(4)), 'the record holds the secret');  // A finding in a file whose name is secret-shaped: the scan's own reason is masked the same way.
  w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  w.fake.setMode('leakname');
  const f = await refusedAndUntouched(w, /found 1 likely secret.*ghp_A1A1…\.txt/);
  assert.ok(!f.reason.includes('A1'.repeat(18)), f.reason);
});

test('R-0b-47 round 2 MIN-d: a new file over the size cap, or new files over the total cap, are refused before they are read', async () => {
  const w = await world();
  await w.commit('big', (c) => { writeFileSync(join(c, 'a.txt'), 'a'.repeat(5000)); writeFileSync(join(c, 'b.txt'), 'b'.repeat(3000)); });
  const sha = (await gitOk(['rev-parse', 'HEAD'], w.cg)).trim();
  await gitOk(['push', '-q', w.mirror, 'HEAD:refs/heads/scan'], w.cg);
  const ls = await gitOk(['ls-tree', 'HEAD'], w.cg);
  const blobs = ls.trim().split('\n').map((l) => ({ id: l.split(/\s+/)[2], path: l.split('\t')[1] })).filter((b) => /^[ab]\.txt$/.test(b.path));
  const scan = (o) => scanSecrets({ setup: w.ports.scanner, mirror: w.mirror, shas: [sha], blobs, messages: [], privateDir: tmp(), ...o });
  const before = callLog.length;
  let r = await scan({ maxFileBytes: 4000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /a\.txt is larger than 4000 bytes/);
  assert.ok(!callLog.slice(before).some((c) => c.args[0] === 'cat-file' && c.args[1] === 'blob' && c.args[2] === blobs.find((b) => b.path === 'a.txt').id), 'the big file is never read');
  r = await scan({ maxTotalBytes: 7000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than 7000 bytes/);
  // Planted fault: under both caps the same scan passes.
  assert.deepEqual(await scan({}), { ok: true, binaries: [] });
});
