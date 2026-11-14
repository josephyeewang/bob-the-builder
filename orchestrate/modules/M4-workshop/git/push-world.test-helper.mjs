// Test-only: the push script's world (R-0b-45), shared by push.test.mjs and the Dispatcher's launch-to-push test
// (L204-a). A local bare repo stands in for GitHub (reached only through the testRemote port), with a mirror, a worker
// clone on card/c-1, a private folder, a fake gitleaks, the start gate's facts and ports, and M10's real engine for
// push_branch. Nothing here reaches the network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitOk, initMirror } from './safe-git.mjs';
import { createPushScript, bundleName } from './push.mjs';
import { cardBranch } from './branch.mjs';
import { DO_PLANE_TOML } from './gitleaks.mjs';
import { factId } from './start-gate.mjs';
import { intakeFactId } from '../../M11-dispatcher/intake-facts.mjs';
import { memoryRecord } from '../../../shared/record.mjs';
import { fakeRules, makeRules } from '../../../shared/rules.mjs';
import { makeEngine } from '../../M10-rules/engine.mjs';
import { parsePolicy } from '../../M10-rules/policy.mjs';

export const WF = '.github/workflows/outside-check.yml';
export const PRODUCT = 'p1';
export const REPO = 'owner/test-repo';
// Tests can't chown, so every file here is the test user's. The worker door expects that user by default, and the owner
// is another id; the proposal tests swap the two (R-0b-127).
const ME = process.getuid();
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
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
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

// ---- a fake git (L680): stalls, fails or answers as its rules say for one command, and runs the real git otherwise ----
// `rules`: [{ cmd, has?, sleep?, code?, stderr?, stdout? }]. `cmd` is git's command (the first word after the leading
// options; '--version' for the version check), `has` a text one of its words must hold (a bundle's '.bundle'). The
// first rule that fits is used: `sleep` stalls past any time limit, else it prints and exits with `code`. Pass
// `{ bin }` as createPushScript's testGit (with `timeouts` for a stall); setRules changes the rules mid-test.
const REAL_GIT = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, 'git')).find((f) => existsSync(f));
export function makeFakeGit(dir, rules = []) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'git');
  const file = join(dir, 'rules.json');
  const setRules = (r) => writeFileSync(file, JSON.stringify(r));
  setRules(rules);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
let i = 0; while (i < a.length && a[i] !== '--version' && a[i].startsWith('-')) i += a[i] === '-c' ? 2 : 1;
const cmd = a[i] ?? '';
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, cmd + '\\n');
const rule = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')).find((r) => r.cmd === cmd && (!r.has || a.some((w) => w.includes(r.has))));
if (!rule) { const r = spawnSync(${JSON.stringify(REAL_GIT)}, a, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
if (rule.sleep) setTimeout(() => process.exit(0), 600000);
else { if (rule.stdout) process.stdout.write(rule.stdout); if (rule.stderr) process.stderr.write(rule.stderr); process.exitCode = rule.code ?? 0; }
`);
  chmodSync(bin, 0o755);
  return { bin, setRules, calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : []) };
}

/**
 * The world in `root` (a fresh temporary folder). `record`: the Record the push reads (a fresh stand-in when left
 * out). `seed`: write session S-1 and card C-1 into it as the real Record takes them (push.test.mjs); the launch test
 * passes false, since the Dispatcher's pass makes them. `onPushAsked(subject)` sees each push_branch question.
 */
export async function pushWorld({ root, record = memoryRecord(), seed = true, card = 'C-1', product = PRODUCT, scanner: scannerOverride, gate = {}, onPushAsked = () => {}, ciText = 'name: ci\n' } = {}) {
  const gh = join(root, 'gh.git');
  await gitOk(['init', '--bare', '-q', gh], { gitDir: gh });
  const seedDir = join(root, 'seed');
  mkdirSync(seedDir);
  const sg = { gitDir: join(seedDir, '.git'), workTree: seedDir, cwd: seedDir };
  await gitOk(['init', '-q', seedDir], sg);
  mkdirSync(join(seedDir, '.github/workflows'), { recursive: true });
  // ciText: main's one workflow (a test of the real start gate's workflow rule gives one that passes it).
  writeFileSync(join(seedDir, '.github/workflows/ci.yml'), ciText);
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
  await gitOk(['checkout', '-q', '-b', cardBranch(card), 'main'], cg);

  // The session's own outbox, in its product's folder (L836: <outboxRoot>/<product>/<role>/<session id>).
  const outbox = join(root, 'outboxes', product, 'worker', 'S-1');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const proposals = join(root, 'proposals'); // the product's proposals folder (rules proposals.outbox), the owner's own
  mkdirSync(proposals, { mode: 0o750 });
  const privateDir = join(root, 'private');
  mkdirSync(privateDir, { mode: 0o700 });

  if (seed) {
    // Seeded as the real Record takes them (L72): a session starts in preparing; a card names its state and module,
    // and its PR title is the card's `what`.
    assert.equal(record.write({ actor: 'dispatcher', entity: 'session', id: 'S-1', expectRev: 0, doc: { state: 'preparing', product: PRODUCT, card: 'C-1', branch: 'card/c-1', outbox, attempt: 'a1' } }).ok, true);
    assert.equal(record.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: 0, doc: { state: 'draft', module: 'M-test', product: PRODUCT, lane: 'product', what: 'Card one' } }).ok, true);
  }
  const writeFact = (kind, doc) => { const cur = record.read('fact', factId(kind, product)); return record.write({ actor: 'sensors', entity: 'fact', id: factId(kind, product), expectRev: cur?.rev ?? 0, doc }); };
  const fresh = () => new Date().toISOString();
  writeFact('vercel_skip', { product, vercel_project: 'prj_1', read_at: fresh(), result: true });
  writeFact('vercel_env', { product, vercel_project: 'prj_1', read_at: fresh(), result: true });

  const fake = makeFakeScanner((mkdirSync(join(root, 'scan')), join(root, 'scan')));
  const issues = []; const prs = [];
  const values = { 'onboarding.state': 'active', 'product.default_branch': 'main', 'product.vercel_project': 'prj_1', 'proposals.outbox': proposals };
  // Where the product lives and which outside check to trust come from the wiring, not the rules file (L568).
  const place = { repo: REPO, mirror };
  // push_branch is M10's real engine on its sample policy (L81 sweep): the push is asked what the engine reads.
  const answers = { push_branch: (s) => { onPushAsked(s); return realEngine().may('push_branch', s); } };
  const run = { workflow_path: WF, event: 'schedule', head_branch: 'main', run_at: fresh(), steps: [{ product, conclusion: 'success' }] };
  const ports = {
    record,
    rules: fakeRules({ answers, values }),
    // The place for the product asked about, and none for any other: a push that asks with the wrong key waits (L719 m1).
    productPlace: (p) => (p === product ? place : null),
    outsideWorkflow: WF,
    privateDir,
    scanner: scannerOverride ?? fake.setup,
    getRobotToken: async () => 'robot-key-for-test',
    readRun: async () => (gate.readRun ? gate.readRun() : run),
    workflowRule: gate.workflowRule ?? (async () => ({ ok: true })),
    issues: { upsert: async (i) => { issues.push(i); } },
    pullRequests: { upsert: async (p) => { prs.push(p); return { number: 1 }; } },
    testRemote: () => gh,
    uids: { worker: ME },
    ownerUid: ME + 1,
    // The outboxes' root, required (#403 r1 M1): the push finds the session's outbox in its product's folder under it.
    outboxRoot: join(root, 'outboxes'),
  };
  const commit = async (msg, fn) => { fn?.(clone); await gitOk(['add', '-A'], cg); await gitOk(['commit', '-q', '--allow-empty', '-m', msg], cg); };
  // The worker's hand-in: the card's branch as a bundle in `into` (the world's own outbox when left out).
  const bundle = async (args = [`refs/heads/${cardBranch(card)}`, '^refs/heads/main'], into = outbox) => { rmSync(join(into, bundleName(card)), { force: true }); await gitOk(['bundle', 'create', '-q', join(into, bundleName(card)), ...args], cg); };
  const ghRefs = async () => (await gitOk(['for-each-ref', '--format=%(refname) %(objectname)'], { gitDir: gh })).trim();
  const push = (over = {}, sessionId = 'S-1') => createPushScript({ ...ports, ...over })(sessionId);
  // What the intake records for a bundle it took in; the push script reads this fact, and no caller names a hash (L325 m1).
  const hold = (sha256, heldCard = 'C-1', heldProduct = product, state = 'held') => {
    const id = intakeFactId(heldProduct, `bundle-${heldCard}.bundle`);
    const put = record.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: record.read('fact', id)?.rev ?? 0, doc: { sha256, state, at: new Date().toISOString() }, kind: 'proposal_bundle' });
    assert.equal(put.ok, true, put.reason);
    return sha256;
  };
  // A bundle the owner's tab drops in the proposals folder; answers the sha256 the intake records for it.
  const propose = async (args = ['refs/heads/card/c-1', '^refs/heads/main']) => {
    const p = join(proposals, 'bundle-C-1.bundle');
    rmSync(p, { force: true });
    await gitOk(['bundle', 'create', '-q', p, ...args], cg);
    return hold(createHash('sha256').update(readFileSync(p)).digest('hex'));
  };
  // The proposal door, with the owner as the test user (and the worker as someone else) unless `over` says otherwise.
  const pushP = (input, { look = false, ...over } = {}) => createPushScript({ ...ports, uids: { worker: ME + 1 }, ownerUid: ME, ...over }).pushProposal(input, { look });
  return { root, product, gh, mirror, clone, cg, outbox, proposals, record, values, answers, run, fake, issues, prs, commit, bundle, propose, hold, ghRefs, push, pushP, ports, writeFact };
}
