// guard-proof.test.mjs — the guard's live proof (L1211), on stand-in copies: each check run as this user, the job file
// read from a table. The real jobs' scripts are loaded too, through a stand-in copy that links to this tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';
import { chainProblem } from '../../modules/M4-workshop/launcher/install-check.mjs';
import { INSTALL_MARK, REFUSED_CODE } from '../../shared/secret-guard.mjs';
import { DAEMON_DIR } from '../daemons.mjs';
import { GUARD, LOAD_WRITES, NOT_CHECKED, PROBE, PROVED_JOBS, judgeJob, main, proofPassed, readAnswer } from './guard-proof.mjs';

const ORCH = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const GUARD_TEXT = readFileSync(join(ORCH, GUARD), 'utf8');
const ME = process.getuid(); const MY_GID = process.getgid();
const LABEL = 'orch.test';
const ROBOT = PROVED_JOBS.robot.script;

/** A stand-in copy under a fresh base: { base, root, cfg }. files: path in the copy → text. */
function standIn(files = {}) {
  const base = tempDir('orch-guard-proof-');
  const root = join(base, 'install', 'orchestrate');
  const all = { 'bin/node': '', [GUARD]: GUARD_TEXT, [ROBOT]: "import '../shared/secret-guard.mjs';\n", ...files };
  for (const [p, text] of Object.entries(all)) { if (text === null) continue; mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  return { base, root, cfg: { label: LABEL, base, owner: 'joe' } };
}
const plistFile = (job) => join(DAEMON_DIR, `${LABEL}.${job}.plist`);
const jobFile = (root, job, extra = {}) => ({ ProgramArguments: [join(root, 'bin/node'), join(root, PROVED_JOBS[job].script)], UserName: 'robot', ...extra });

/** The proof's io for a stand-in: the job files from a table, users from a table, each check run as this user. */
function testIo({ base, plists = {}, users = { robot: { uid: ME, gid: MY_GID }, joe: { uid: 99_999, gid: 20 } }, chain, myUid = ME, child } = {}) {
  return {
    exists: (f) => Object.hasOwn(plists, f),
    readPlist: (f) => plists[f],
    realpath: (p) => realpathSync.native(p),
    idOf: (n) => users[n] ?? null,
    chain: chain ?? ((p) => chainProblem(p, { owner: ME, top: base, acl: () => null })),
    runChild: child ?? (({ env }) => spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { env, cwd: base, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })),
    myUid,
  };
}
const judge = (s, { job = 'robot', plist, ...o } = {}) => judgeJob(job, { cfg: s.cfg, io: testIo({ base: s.base, plists: { [plistFile(job)]: plist ?? jobFile(s.root, job) }, ...o }), ownerUid: 99_999, ...(o.loadWrites ? { loadWrites: o.loadWrites } : {}) });

test('L1211 (a): a stand-in copy whose script loads the copy\'s guard passes', () => {
  const s = standIn();
  const r = judge(s);
  assert.equal(r.result, 'PASS', r.why);
  assert.match(r.why, /refused a registered value with its own code/);
});

test('L1211: every real job\'s script, loaded from this tree in the child, installs the guard and passes, with no write, connection or start at load', () => {
  const base = tempDir('orch-guard-proof-real-');
  const env = (entry) => ({ PATH: '/usr/bin:/bin', HOME: base, ORCH_GUARD_PROOF: JSON.stringify({ entry, guard: join(ORCH, GUARD), nonce: 'n0', mark: INSTALL_MARK.description, code: REFUSED_CODE }) });
  for (const [job, spec] of Object.entries(PROVED_JOBS)) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { env: env(join(ORCH, spec.script)), cwd: base, encoding: 'utf8', timeout: 30_000 });
    const [result, why] = readAnswer(r, 'n0', 'this user');
    assert.equal(result, 'PASS', `${job}: ${why}`);
  }
  assert.deepEqual(LOAD_WRITES, {}, 'a job named in LOAD_WRITES is never proved: it needs the lead\'s word');
});

test('L1211 (b): a script that skips the guard is a FAIL', () => {
  const r = judge(standIn({ [ROBOT]: 'export const x = 1;\n' }));
  assert.deepEqual([r.result, r.why], ['FAIL', 'the script loaded no guard that marked its install']);
});

test('L1211 (c): a script whose import throws is a FAIL, with the reason', () => {
  const r = judge(standIn({ [ROBOT]: "import '../shared/secret-guard.mjs';\nthrow new Error('boom at load');\n" }));
  assert.equal(r.result, 'FAIL');
  assert.match(r.why, /^loading the script: boom at load/);
});

test('L1211: a job not placed is NOT PLACED, never a PASS; the proof passes only with one placed and every placed one passing', () => {
  const s = standIn();
  const r = judgeJob('robot', { cfg: s.cfg, io: testIo({ base: s.base, plists: {} }), ownerUid: 99_999 });
  assert.deepEqual([r.result, r.why], ['NOT PLACED', `no job file at ${plistFile('robot')}`]);
  assert.equal(proofPassed([r]), false, 'nothing placed proves nothing');
  assert.equal(proofPassed([r, { result: 'PASS' }]), true);
  assert.equal(proofPassed([r, { result: 'PASS' }, { result: 'NOT TRIED' }]), false);
  assert.equal(proofPassed([{ result: 'PASS' }, { result: 'FAIL' }]), false);
});

test('L1211 (d): the copy\'s guard at a link is a FAIL: the chain check says so, and without it the real path does', () => {
  const s = standIn({ [GUARD]: null });
  const elsewhere = join(s.base, 'elsewhere', 'secret-guard.mjs');
  mkdirSync(dirname(elsewhere)); writeFileSync(elsewhere, GUARD_TEXT); mkdirSync(join(s.root, 'shared'));
  symlinkSync(elsewhere, join(s.root, GUARD));
  const viaChain = judge(s);
  assert.equal(viaChain.result, 'FAIL'); assert.match(viaChain.why, /secret-guard\.mjs is a link$/);
  const viaReal = judge(s, { chain: () => null });
  assert.deepEqual([viaReal.result, viaReal.why], ['FAIL', `the copy's guard is really ${realpathSync.native(elsewhere)}, not the copy's own`]);
});

test('L1211 (d): a script that loaded another guard first is a FAIL: the install mark names that one, not the copy\'s', () => {
  const s = standIn({ 'other/secret-guard.mjs': GUARD_TEXT, [ROBOT]: "import '../other/secret-guard.mjs';\nimport '../shared/secret-guard.mjs';\n" });
  const r = judge(s);
  assert.equal(r.result, 'FAIL');
  assert.equal(r.why, `the guard that installed itself is ${join(realpathSync.native(s.root), 'other/secret-guard.mjs')}, not the copy's ${join(realpathSync.native(s.root), GUARD)}`);
});

test('L1211 (d): a guard that marks itself but is read back as another instance is a FAIL', () => {
  // The copy's guard file sets a mark naming itself but with a registerSecret of its own making, not the one it exports.
  const fake = `${GUARD_TEXT}\n;delete globalThis[Symbol.for('x')];\n`.replace(
    'Object.freeze({ url: import.meta.url, registerSecret })', 'Object.freeze({ url: import.meta.url, registerSecret: (v) => v })');
  assert.notEqual(fake, GUARD_TEXT);
  const r = judge(standIn({ [GUARD]: fake }));
  assert.deepEqual([r.result, r.why], ['FAIL', 'the copy\'s guard read back is another instance than the one that installed itself']);
});

test('L1211 (e): a job running as root (named or by no UserName) or as the owner\'s uid is a FAIL; the updater must be root\'s', () => {
  const s = standIn();
  for (const plist of [jobFile(s.root, 'robot', { UserName: 'root' }), { ProgramArguments: jobFile(s.root, 'robot').ProgramArguments }]) {
    assert.deepEqual(Object.values(judge(s, { plist })).slice(1), ['FAIL', 'it runs as root']);
  }
  const owner = judge(s, { plist: jobFile(s.root, 'robot', { UserName: 'joe' }) });
  assert.deepEqual([owner.result, owner.why], ['FAIL', 'it runs as the owner\'s uid 99999']);
  const updater = standIn({ [PROVED_JOBS['review-updater'].script]: "import '../../../shared/secret-guard.mjs';\n" });
  const u = judge(updater, { job: 'review-updater' });
  assert.deepEqual([u.result, u.why], ['FAIL', 'it runs as robot; it is root\'s job by design']);
  const asRoot = judge(updater, { job: 'review-updater', plist: { ProgramArguments: jobFile(updater.root, 'review-updater').ProgramArguments } });
  assert.deepEqual([asRoot.result, asRoot.why], ['NOT TRIED', 'it runs as root: run this with sudo, which starts each check as the job\'s own user']);
  assert.equal(judge(s, { plist: jobFile(s.root, 'robot', { UserName: 'nobody-here' }) }).why, 'its user nobody-here is not a user on this Mac');
});

/** A stand-in guard that marks itself as the copy's, says `installed`, and puts `spawnSync` (source text) in place. */
const fakeGuard = ({ installed = 'true', spawnSync = null }) => `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
export function registerSecret(v) { return v; }
export const guardInstalled = () => ${installed};
${spawnSync ? `cp.spawnSync = ${spawnSync};\nsyncBuiltinESMExports();` : ''}
Object.defineProperty(globalThis, Symbol.for('${INSTALL_MARK.description}'), { value: { url: import.meta.url, registerSecret } });
`;

test('L1211: a refusal that is not the guard\'s own (another error, no code) is a FAIL', () => {
  const r = judge(standIn({ [GUARD]: fakeGuard({ spawnSync: "(f, a) => { if (a?.length) throw new Error('refused to start a program (spawnSync): its command line would hold a secret'); return { status: 0 }; }" }) }));
  assert.equal(r.result, 'FAIL');
  assert.match(r.why, /^a start was refused, but not by the guard \(no code: refused to start/);
});

test('L1211: a guard that says it is off, that refuses nothing, or that stops a plain start too is a FAIL', () => {
  const off = judge(standIn({ [GUARD]: fakeGuard({ installed: 'false' }) }));
  assert.deepEqual([off.result, off.why], ['FAIL', 'the start functions are not the guard\'s wrapped ones']);
  const none = judge(standIn({ [GUARD]: fakeGuard({}) }));
  assert.deepEqual([none.result, none.why], ['FAIL', 'a start whose argument holds a registered value was not refused']);
  const all = judge(standIn({ [GUARD]: fakeGuard({ spawnSync: `(f, a) => { if (a?.length) throw Object.assign(new Error('x'), { code: '${REFUSED_CODE}' }); return { status: 1 }; }` }) }));
  assert.deepEqual([all.result, all.why], ['FAIL', 'a plain start did not run (exit 1)']);
});

test('L1211: a script that writes, connects or starts a program while it loads is a FAIL, and nothing is done', () => {
  const s = standIn();
  const mark = join(s.base, 'written-at-load');
  const cases = [
    [`import { writeFileSync } from 'node:fs';\nimport '../shared/secret-guard.mjs';\ntry { writeFileSync(${JSON.stringify(mark)}, 'x'); } catch {}\n`, /file write \(writeFileSync\)/],
    [`import { promises } from 'node:fs';\nimport '../shared/secret-guard.mjs';\nawait promises.open(${JSON.stringify(mark)}, 'w').catch(() => {});\n`, /file write \(open\)/],
    [`import net from 'node:net';\nimport '../shared/secret-guard.mjs';\ntry { net.connect(1, '127.0.0.1').on('error', () => {}); } catch {}\n`, /network connection \(connect\)/],
    [`import { execFileSync } from 'node:child_process';\nimport '../shared/secret-guard.mjs';\ntry { execFileSync('/usr/bin/touch', [${JSON.stringify(mark)}]); } catch {}\n`, /program start \(execFileSync\)/],
  ];
  for (const [text, want] of cases) {
    writeFileSync(join(s.root, ROBOT), text);
    const r = judge(s);
    assert.equal(r.result, 'FAIL', text);
    assert.match(r.why, /^while it loaded, the script tried: /);
    assert.match(r.why, want);
    assert.equal(existsSync(mark), false, 'nothing was written');
  }
  // A read at load is fine (the scripts read their own rule files).
  writeFileSync(join(s.root, ROBOT), `import { readFileSync } from 'node:fs';\nimport '../shared/secret-guard.mjs';\nreadFileSync(new URL(import.meta.url), 'utf8');\n`);
  assert.equal(judge(s).result, 'PASS');
});

test('L1211: the job file must start the copy\'s node and the job\'s own script; a job named in LOAD_WRITES is never loaded', () => {
  const s = standIn();
  const [node, script] = jobFile(s.root, 'robot').ProgramArguments;
  assert.deepEqual(Object.values(judge(s, { plist: { ProgramArguments: ['/usr/local/bin/node', script], UserName: 'robot' } })).slice(1), ['FAIL', `it starts /usr/local/bin/node, not the copy's node ${node}`]);
  const other = join(s.root, 'wiring/runner-main.mjs');
  assert.deepEqual(Object.values(judge(s, { plist: { ProgramArguments: [node, other], UserName: 'robot' } })).slice(1), ['FAIL', `it runs ${other}, not its script ${script}; not loaded`]);
  assert.equal(judge(s, { plist: { UserName: 'robot' } }).why, 'its job file has no program and script');
  const never = () => { throw new Error('the child must not start'); };
  const r = judge(s, { loadWrites: { robot: 'it writes its status at load' }, child: never });
  assert.deepEqual([r.result, r.why], ['NOT TRIED', 'its script is not loaded here: it writes its status at load']);
  const notRoot = judge(s, { myUid: ME + 1, child: never });
  assert.deepEqual([notRoot.result, notRoot.why], ['NOT TRIED', 'it runs as robot: run this with sudo, which starts each check as the job\'s own user']);
});

test('L1211: only the answer line with this run\'s nonce counts, and the script never sees the nonce', () => {
  const s = standIn({ [ROBOT]: "import '../shared/secret-guard.mjs';\nif (process.env.ORCH_GUARD_PROOF !== undefined) throw new Error('the script saw the input');\n" });
  assert.equal(judge(s).result, 'PASS');
  const n = randomBytes(16).toString('hex');
  assert.deepEqual(readAnswer({ status: 0, stdout: `x {"ok":true,"guard":"/g"}\n` }, n, 'u'), ['FAIL', 'the check gave no answer (exit 0)']);
  assert.deepEqual(readAnswer({ status: null, signal: 'SIGKILL', stdout: '', stderr: 'a\nlast words\n' }, n, 'u'), ['FAIL', 'the check gave no answer (stopped by SIGKILL: last words)']);
  assert.deepEqual(readAnswer({ error: Object.assign(new Error('x'), { code: 'EPERM' }) }, n, 'u'), ['FAIL', 'the check could not run as u (EPERM)']);
  assert.equal(readAnswer({ status: 0, stdout: `${n} {"ok":true,"guard":"/g"}\n` }, n, 'u')[0], 'PASS');
});

test('L1211: main lists every job (NOT PLACED included) and every job left out, and exits 1 when nothing is placed', () => {
  const s = standIn();
  const config = join(s.base, 'setup.json');
  writeFileSync(config, JSON.stringify({ base: s.base, owner: 'joe', products: [], address: 'https://example.com/x/y.git', label: LABEL, runnerConfig: join(s.base, 'review.json'), nodeBin: process.execPath }));
  const lines = [];
  const code = main(['--config', config], { io: testIo({ base: s.base }), out: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.equal(lines.filter((l) => l.startsWith('NOT PLACED')).length, Object.keys(PROVED_JOBS).length);
  for (const job of Object.keys(NOT_CHECKED)) assert.ok(lines.some((l) => l.startsWith(`NOT CHECKED ${job}: `)), job);
  assert.match(lines.at(-1), /^FAIL: /);
  const placed = main(['--config', config], { io: testIo({ base: s.base, plists: { [plistFile('robot')]: jobFile(s.root, 'robot') } }), out: () => {} });
  assert.equal(placed, 0, 'one placed job that passes, the rest not placed');
  assert.equal(main(['--config', join(s.base, 'missing.json')], { io: testIo({ base: s.base }), out: () => {} }), 1);
});
