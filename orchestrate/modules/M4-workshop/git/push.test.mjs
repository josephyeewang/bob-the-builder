// R-0b-45: the push script, against real git. A local bare repo stands in for GitHub (reached only
// through the test harness's constructor argument). The secret scan uses a fake gitleaks for the
// logic, and the real one, where installed, for the bypass cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, existsSync, renameSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gitOk, git, initMirror, callLog } from './safe-git.mjs';
import { createPushScript, readBundleHeader, githubUrl } from './push.mjs';
import { refusedPath } from './push-refusals.mjs';
import { DO_PLANE_TOML, scanSecrets } from './gitleaks.mjs';
import { startGate, factId, FACT1_MAX_AGE_MS, VERCEL_FACT_MAX_AGE_MS } from './start-gate.mjs';
import { memoryRecord } from '../../../shared/record.mjs';
import { fakeRules, allow, deny } from '../../../shared/rules.mjs';

const tmp = (p = 'orch-push-') => mkdtempSync(join(tmpdir(), p));
const WF = '.github/workflows/outside-check.yml';
const PRODUCT = 'p1';
const REPO = 'owner/test-repo';

// A GitHub-token-shaped string made at run time, so no secret-shaped text is ever committed.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fakeSecret = () => `ghp_${[...randomBytes(36)].map((b) => ALNUM[b % ALNUM.length]).join('')}`;

const realGitleaks = (() => {
  for (const d of (process.env.PATH ?? '').split(delimiter)) { const p = join(d, 'gitleaks'); if (d && existsSync(p)) return p; }
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
if (a[0] === 'version') { console.log(mode === 'wrongversion' ? '1.0.0' : '9.9.9'); process.exit(0); }
const at = (f) => a[a.indexOf(f) + 1];
if (at('--config') !== ${JSON.stringify(join(dir, 'do-plane.toml'))} || at('--gitleaks-ignore-path') !== ${JSON.stringify(join(dir, 'empty-ignore'))} || !a.includes('--ignore-gitleaks-allow')) process.exit(7);
if (Object.keys(process.env).some((k) => k.startsWith('GITLEAKS'))) process.exit(8);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, a[0] + '\\n');
if (mode === 'crash') process.exit(2);
fs.writeFileSync(at('--report-path'), mode === 'leak' ? JSON.stringify([{ RuleID: 'fake-rule', File: 'x.txt' }]) : '[]');
process.exit(mode === 'leak' ? 1 : 0);
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'do-plane.toml'), DO_PLANE_TOML);
  writeFileSync(join(dir, 'empty-ignore'), '');
  return { setup: { bin, version: '9.9.9', config: join(dir, 'do-plane.toml'), ignoreFile: join(dir, 'empty-ignore') }, setMode: (m) => writeFileSync(mode, m), calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '') };
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
  assert.match(w.fake.calls(), /git\nstdin/);
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

test('scanner problems refuse: a finding, a crash (exit 2), the wrong version, a missing binary, a changed config', async () => {
  for (const [mode, re] of [['leak', /found 1 likely secret/], ['crash', /did not finish cleanly/], ['wrongversion', /pin is 9\.9\.9/]]) {
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
    [{ ...goodRun, run_at: iso(now - FACT1_MAX_AGE_MS - 1000) }, /2 hours/],
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
    for (const [doc, re] of [[{ ...good, result: false }, /fails/], [{ ...good, read_at: iso(now - VERCEL_FACT_MAX_AGE_MS - 1000) }, /10 minutes/], [{ ...good, vercel_project: 'prj_2' }, /another project/], [{ ...good, product: 'p2' }, /another project/], [{ ...good, read_at: 'soon' }, /10 minutes/]]) {
      w.writeFact(kind, doc);
      const { r, issues } = await gate({});
      assert.equal(r.ok, false, `${kind} ${JSON.stringify(doc)}`); assert.match(r.reason, re); assert.equal(issues.length, 1);
      w.writeFact(kind, good);
    }
  }
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

test('the mirror is checked before every push: a planted alternates file refuses', async () => {
  const w = await world();
  await w.commit('work', (c) => writeFileSync(join(c, 'a.txt'), 'a\n'));
  await w.bundle();
  writeFileSync(join(w.mirror, 'objects/info/alternates'), join(w.clone, '.git/objects') + '\n');
  await refusedAndUntouched(w, /alternates/);
});
