// Test-only: the push script's world (R-0b-45), shared by push.test.mjs and the Dispatcher's launch-to-push test
// (L204-a). A local bare repo stands in for GitHub (reached only through the testRemote port), with a mirror, a worker
// clone on card/c-1, a private folder, a fake gitleaks, the start gate's facts and ports, and M10's real engine for
// push_branch. Nothing here reaches the network.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOk, initMirror } from './safe-git.mjs';
import { createPushScript, bundleName } from './push.mjs';
import { DO_PLANE_TOML } from './gitleaks.mjs';
import { factId } from './start-gate.mjs';
import { memoryRecord } from '../../../shared/record.mjs';
import { fakeRules, makeRules } from '../../../shared/rules.mjs';
import { makeEngine } from '../../M10-rules/engine.mjs';
import { parsePolicy } from '../../M10-rules/policy.mjs';

export const WF = '.github/workflows/outside-check.yml';
export const PRODUCT = 'p1';
export const REPO = 'owner/test-repo';
const here = dirname(fileURLToPath(import.meta.url));

let engine;
/** M10's real engine on its sample policy (L81 sweep). */
export function realEngine() {
  if (engine) return engine;
  const policy = parsePolicy(readFileSync(join(here, '../../M10-rules/fixtures/policy.yaml'), 'utf8'));
  assert.ok(policy.ok, policy.reason);
  engine = makeRules(makeEngine({ products: [PRODUCT], rulesState: () => ({ status: 'ok', policy: policy.policy, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    productState: () => ({ state: 'active' }), running: () => 0, rolesDir: join(here, '../../M10-rules/roles'), clock: () => Date.now() }));
  return engine;
}

// ---- a fake gitleaks: checks it got the Do-plane's config and flags, and does as its mode file says ----
export function makeFakeScanner(dir) {
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

/**
 * The world in `root` (a fresh temporary folder). `record`: the Record the push reads (a fresh stand-in when left
 * out). `seed`: write session S-1 and card C-1 into it as the real Record takes them (push.test.mjs); the launch test
 * passes false, since the Dispatcher's pass makes them. `onPushAsked(subject)` sees each push_branch question.
 */
export async function pushWorld({ root, record = memoryRecord(), seed = true, scanner: scannerOverride, gate = {}, onPushAsked = () => {} } = {}) {
  const gh = join(root, 'gh.git');
  await gitOk(['init', '--bare', '-q', gh], { gitDir: gh });
  const seedDir = join(root, 'seed');
  mkdirSync(seedDir);
  const sg = { gitDir: join(seedDir, '.git'), workTree: seedDir, cwd: seedDir };
  await gitOk(['init', '-q', seedDir], sg);
  mkdirSync(join(seedDir, '.github/workflows'), { recursive: true });
  writeFileSync(join(seedDir, '.github/workflows/ci.yml'), 'name: ci\n');
  writeFileSync(join(seedDir, 'README.md'), 'hello\n');
  writeFileSync(join(seedDir, 'app.txt'), 'app\n');
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

  if (seed) {
    // Seeded as the real Record takes them (L72): a session starts in preparing; a card names its state and module,
    // and its PR title is the card's `what`.
    assert.equal(record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: 0, doc: { state: 'preparing', product: PRODUCT, card: 'C-1', branch: 'card/c-1', outbox, attempt: 'a1' } }).ok, true);
    assert.equal(record.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'draft', module: 'M-test', product: PRODUCT, lane: 'product', what: 'Card one' } }).ok, true);
  }
  const writeFact = (kind, doc) => { const cur = record.read('fact', factId(kind, PRODUCT)); return record.write({ actor: 'sensors', entity: 'fact', id: factId(kind, PRODUCT), expectRev: cur?.rev ?? 0, doc }); };
  const fresh = () => new Date().toISOString();
  writeFact('vercel_skip', { product: PRODUCT, vercel_project: 'prj_1', read_at: fresh(), result: true });
  writeFact('vercel_env', { product: PRODUCT, vercel_project: 'prj_1', read_at: fresh(), result: true });

  const fake = makeFakeScanner((mkdirSync(join(root, 'scan')), join(root, 'scan')));
  const issues = []; const prs = [];
  const values = { 'product.repo': REPO, 'product.mirror': mirror, 'product.onboarded': true, 'product.default_branch': 'main', 'product.vercel_project': 'prj_1', 'outside_check.workflow': WF };
  // push_branch is M10's real engine on its sample policy (L81 sweep): the push is asked what the engine reads.
  const answers = { push_branch: (s) => { onPushAsked(s); return realEngine().may('push_branch', s); } };
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
  // The worker's hand-in: card C-1's branch as a bundle in `into` (the world's own outbox when left out).
  const bundle = async (args = ['refs/heads/card/c-1', '^refs/heads/main'], into = outbox) => { rmSync(join(into, bundleName('C-1')), { force: true }); await gitOk(['bundle', 'create', '-q', join(into, bundleName('C-1')), ...args], cg); };
  const ghRefs = async () => (await gitOk(['for-each-ref', '--format=%(refname) %(objectname)'], { gitDir: gh })).trim();
  const push = (over = {}, sessionId = 'S-1') => createPushScript({ ...ports, ...over })(sessionId);
  return { root, gh, mirror, clone, cg, outbox, record, values, answers, run, fake, issues, prs, commit, bundle, ghRefs, push, ports, writeFact };
}
