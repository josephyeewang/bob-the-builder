// guard-proof.test.mjs — the guard's live proof (L1211), on stand-in copies: each check run as this user, the job file
// read from a table. The real jobs' scripts are loaded too, through a stand-in copy that links to this tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../shared/test-tmp.mjs';
import { chainProblem, currentCopy } from '../../modules/M4-workshop/launcher/install-check.mjs';
import { INSTALL_MARK, REFUSED_CODE } from '../../shared/secret-guard.mjs';
import { ALL_JOBS, DAEMON_DIR, plistTexts } from '../daemons.mjs';
import { ROOT_CONFIG_PATH } from '../layout.mjs';
import { parseInstallConfig } from '../install.mjs';
import { main as setupMain } from '../setup.mjs';
import { fakeMac } from '../fake-mac.test-helper.mjs';
import { GUARD, LOAD_WRITES, NOT_CHECKED, PROBE, PROVED_JOBS, judgeJob, main, plistObject, proofPassed, readAnswer } from './guard-proof.mjs';

const ORCH = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const GUARD_TEXT = readFileSync(join(ORCH, GUARD), 'utf8');
const ME = process.getuid(); const MY_GID = process.getgid();
const LABEL = 'orch.test';
const ROBOT = PROVED_JOBS.robot.script;

const COMMIT = 'a'.repeat(40);
/**
 * A stand-in copy under a fresh base: { base, root, real, cfg }. files: path in the copy → text. As the installer makes
 * it (r1 M1): root, the name the jobs use, is a link to orchestrate.v-<commit>/orchestrate beside it; linked: false makes
 * it a plain folder instead.
 */
function standIn(files = {}, { linked = true } = {}) {
  // Its real path: the proof checks the copy's files by real paths, root's all the way up, and the Mac's temp folder is under /var, a link.
  const base = realpathSync.native(tempDir('orch-guard-proof-'));
  const root = join(base, 'install', 'orchestrate');
  const real = linked ? join(base, 'install', `orchestrate.v-${COMMIT}`, 'orchestrate') : root;
  mkdirSync(real, { recursive: true });
  if (linked) symlinkSync(`orchestrate.v-${COMMIT}/orchestrate`, root);
  const all = { 'bin/node': '', [GUARD]: GUARD_TEXT, [ROBOT]: "import '../shared/secret-guard.mjs';\n", ...files };
  for (const [p, text] of Object.entries(all)) { if (text === null) continue; mkdirSync(dirname(join(real, p)), { recursive: true }); writeFileSync(join(real, p), text); }
  return { base, root, real, cfg: { label: LABEL, base, owner: 'joe' } };
}
const plistFile = (job) => join(DAEMON_DIR, `${LABEL}.${job}.plist`);
const jobFile = (root, job, extra = {}) => ({ Label: `${LABEL}.${job}`, ProgramArguments: [join(root, 'bin/node'), join(root, PROVED_JOBS[job].script)], UserName: 'robot', ...extra });
const noUser = (plist) => { const { UserName, ...rest } = plist; return rest; };

/** The proof's io for a stand-in: the job files from a table, users from a table, each check run as this user. */
const BUILT = { Label: 'x', ProgramArguments: [], UserName: 'x', EnvironmentVariables: { PATH: '/usr/bin:/bin', HOME: '/x' } };
function testIo({ base, plists = {}, users = { robot: { uid: ME, gid: MY_GID }, joe: { uid: 99_999, gid: 20 } }, chain, myUid = ME, child, built = () => BUILT, links = [] } = {}) {
  return {
    exists: (f) => Object.hasOwn(plists, f),
    isLink: (f) => links.includes(f),
    built,
    currentCopy: (root) => currentCopy(root, { owner: ME }),
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
    const [result, why] = readAnswer(r, 'n0', 'this user', { uid: ME, gid: MY_GID });
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
  mkdirSync(dirname(elsewhere)); writeFileSync(elsewhere, GUARD_TEXT); mkdirSync(join(s.real, 'shared'));
  symlinkSync(elsewhere, join(s.real, GUARD));
  const viaChain = judge(s);
  assert.equal(viaChain.result, 'FAIL'); assert.match(viaChain.why, /secret-guard\.mjs is a link$/);
  const viaReal = judge(s, { chain: () => null });
  assert.deepEqual([viaReal.result, viaReal.why], ['FAIL', `the copy's guard is really ${realpathSync.native(elsewhere)}, not the copy's own ${join(s.real, GUARD)}`]);
  // r1 c1: the script's real-path check, kept beside the chain check, reached with that check off.
  const t = standIn({ [ROBOT]: null });
  const away = join(t.base, 'away', 'robot.mjs');
  mkdirSync(dirname(away)); writeFileSync(away, "import '" + join(t.real, GUARD) + "';\n"); mkdirSync(dirname(join(t.real, ROBOT)), { recursive: true });
  symlinkSync(away, join(t.real, ROBOT));
  assert.match(judge(t).why, /robot[^/]*\.mjs is a link$|is a link$/);
  const script = judge(t, { chain: () => null });
  assert.deepEqual([script.result, script.why], ['FAIL', `its script is really ${realpathSync.native(away)}, not the copy's own ${join(t.real, ROBOT)}`]);
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
  for (const plist of [jobFile(s.root, 'robot', { UserName: 'root' }), noUser(jobFile(s.root, 'robot'))]) {
    assert.deepEqual(Object.values(judge(s, { plist })).slice(1), ['FAIL', 'it runs as root']);
  }
  const owner = judge(s, { plist: jobFile(s.root, 'robot', { UserName: 'joe' }) });
  assert.deepEqual([owner.result, owner.why], ['FAIL', 'it runs as the owner\'s uid 99999']);
  const updater = standIn({ [PROVED_JOBS['review-updater'].script]: "import '../../../shared/secret-guard.mjs';\n" });
  const u = judge(updater, { job: 'review-updater' });
  assert.deepEqual([u.result, u.why], ['FAIL', 'it runs as robot; it is root\'s job by design']);
  const asRoot = judge(updater, { job: 'review-updater', plist: noUser(jobFile(updater.root, 'review-updater')) });
  assert.deepEqual([asRoot.result, asRoot.why], ['NOT TRIED', 'it runs as root: run this with sudo, which starts each check as the job\'s own user']);
  // The root exemption is the exact review-updater label only (lead ruling on #591 r1).
  for (const Label of [`${LABEL}.review-updater-2`, `x.${LABEL}.review-updater`, `${LABEL}.review-updater `, undefined]) {
    const r = judge(updater, { job: 'review-updater', plist: { ...noUser(jobFile(updater.root, 'review-updater')), Label } });
    assert.deepEqual([r.result, r.why], ['FAIL', `its job file's Label is ${JSON.stringify(Label)}, not ${LABEL}.review-updater; not loaded`]);
  }
  const robotLabel = judge(s, { plist: jobFile(s.root, 'robot', { Label: `${LABEL}.review-updater` }) });
  assert.deepEqual([robotLabel.result, robotLabel.why], ['FAIL', `its job file's Label is "${LABEL}.review-updater", not ${LABEL}.robot; not loaded`]);
  for (const job of ['review-updater-2', 'my-review-updater', 'review-account']) {
    const r = judgeJob(job, { cfg: updater.cfg, io: testIo({ base: updater.base, plists: { [plistFile(job)]: { ...noUser(jobFile(updater.root, 'review-updater')), Label: `${LABEL}.${job}` } } }), ownerUid: 99_999 });
    assert.deepEqual([r.result, r.why], ['FAIL', 'not a job this proof knows'], job);
  }
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
  assert.deepEqual(Object.values(judge(s, { plist: jobFile(s.root, 'robot', { ProgramArguments: ['/usr/local/bin/node', script] }) })).slice(1), ['FAIL', `it starts /usr/local/bin/node, not the copy's node ${node}`]);
  const other = join(s.root, 'wiring/runner-main.mjs');
  assert.deepEqual(Object.values(judge(s, { plist: jobFile(s.root, 'robot', { ProgramArguments: [node, other] }) })).slice(1), ['FAIL', `it runs ${other}, not its script ${script}; not loaded`]);
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
  const ids = { uid: 7, gid: 8 };
  const who = '"uid":7,"gid":8,"argc":1';
  assert.deepEqual(readAnswer({ status: 0, stdout: `x {"ok":true,"guard":"/g",${who}}\n` }, n, 'u', ids), ['FAIL', 'the check gave no answer (exit 0)']);
  assert.deepEqual(readAnswer({ status: null, signal: 'SIGKILL', stdout: '', stderr: 'a\nlast words\n' }, n, 'u', ids), ['FAIL', 'the check gave no answer (stopped by SIGKILL: last words)']);
  assert.deepEqual(readAnswer({ error: Object.assign(new Error('x'), { code: 'EPERM' }) }, n, 'u', ids), ['FAIL', 'the check could not run as u (EPERM)']);
  assert.equal(readAnswer({ status: 0, stdout: `${n} {"ok":true,"guard":"/g",${who}}\n` }, n, 'u', ids)[0], 'PASS');
  // r1 m2: the answer must say it ran as the job's uid and gid, with no script argument.
  for (const [w, want] of [
    ['"argc":1', /ran as uid undefined gid undefined, not the job's uid 7 gid 8/],
    ['"uid":7,"argc":1', /ran as uid 7 gid undefined/],
    ['"uid":7,"gid":0,"argc":1', /ran as uid 7 gid 0, not the job's uid 7 gid 8/],
    ['"uid":0,"gid":8,"argc":1', /ran as uid 0 gid 8/],
    ['"uid":7,"gid":8,"argc":2', /ran with 2 arguments, not none/],
    ['"uid":7,"gid":8', /ran with undefined arguments/],
  ]) {
    const [res, why] = readAnswer({ status: 0, stdout: `${n} {"ok":true,"guard":"/g",${w}}\n` }, n, 'u', ids);
    assert.equal(res, 'FAIL', w); assert.match(why, want);
  }
  assert.deepEqual(readAnswer({ status: 0, stdout: `${n} {"ok":true,"guard":"/g",${who}}\n` }, n, 'u'), ['FAIL', 'the job\'s uid and gid are not known']);
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

test('r1 M1: the copy must be the installer\'s link into a versioned folder; the files are checked by their real paths', () => {
  assert.equal(judge(standIn()).result, 'PASS');
  const plainCopy = standIn({}, { linked: false });
  const plain = judge(plainCopy);
  assert.deepEqual([plain.result, plain.why], ['FAIL', `the copy ${plainCopy.root} is not the installer's link to a versioned copy`]);
  const bad = standIn();
  unlinkSync(bad.root); symlinkSync('../other-place', bad.root);
  const r = judge(bad);
  assert.equal(r.result, 'FAIL'); assert.match(r.why, /^the copy: .* points at "\.\.\/other-place", not orchestrate in a copy folder beside it$/);
});

test('r1 M2: a job file may hold only the keys and environment names the installer writes for that job, and is never a link', () => {
  const s = standIn();
  const base = jobFile(s.root, 'robot');
  const cases = [
    [{ ...base, Program: '/bin/sh' }, 'its job file sets Program, which the installer never writes; not loaded'],
    [{ ...base, GroupName: 'wheel' }, 'its job file sets GroupName, which the installer never writes; not loaded'],
    [{ ...base, InitGroups: true }, "its job file has keys the installer doesn't write for it: InitGroups; not loaded"],
    [{ ...base, WorkingDirectory: '/tmp', Umask: 0 }, "its job file has keys the installer doesn't write for it: WorkingDirectory, Umask; not loaded"],
    [{ ...base, EnvironmentVariables: { PATH: '/usr/bin', NODE_OPTIONS: '--import=/tmp/x.mjs' } }, "its job file sets environment names the installer doesn't write for it: NODE_OPTIONS; not loaded"],
    [{ ...base, EnvironmentVariables: ['PATH'] }, "its job file's EnvironmentVariables is not a dictionary; not loaded"],
  ];
  const never = () => { throw new Error('the child must not start'); };
  for (const [plist, why] of cases) {
    const r = judge(s, { plist, child: never });
    assert.deepEqual([r.result, r.why], ['FAIL', why]);
  }
  // Program counts even when the installer's job file somehow has it: launchd would obey it over ProgramArguments.
  const withProgram = judge(s, { plist: { ...base, Program: '/bin/sh' }, built: () => ({ ...BUILT, Program: '/bin/sh' }), child: never });
  assert.equal(withProgram.why, 'its job file sets Program, which the installer never writes; not loaded');
  // An environment name the installer writes for this job only: a job built with PATH alone refuses HOME.
  const pathOnly = judge(s, { plist: { ...base, EnvironmentVariables: { PATH: '/usr/bin', HOME: '/x' } }, built: () => ({ ...BUILT, EnvironmentVariables: { PATH: '/x' } }), child: never });
  assert.equal(pathOnly.why, "its job file sets environment names the installer doesn't write for it: HOME; not loaded");
  const noBuild = judge(s, { built: () => { throw new Error('no such user'); }, child: never });
  assert.equal(noBuild.why, "the installer's job file for it can't be built here (no such user); not loaded");
  const linked = judge(s, { links: [plistFile('robot')], child: never });
  assert.deepEqual([linked.result, linked.why], ['FAIL', `its job file ${plistFile('robot')} is a link; not loaded`]);
  // The installer's environment names pass.
  assert.equal(judge(s, { plist: { ...base, EnvironmentVariables: { PATH: '/usr/bin:/bin', HOME: '/x' } } }).result, 'PASS');
});

test('r1 M2: the installer\'s own job file for each proved job passes the key checks it is the measure for', () => {
  const mac = fakeMac({ euid: 0 });
  const raw = { base: '/Library/orch-test', owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: LABEL, runnerConfig: '/tmp/x/review.json', extras: [], watch: { repo: 'example-org/example-repo', rulesSha256: 'a'.repeat(64) } };
  const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644);
  assert.equal(setupMain(['users-folders'], { io: mac, out: () => {}, err: () => {} }), 0);
  const { plists, problems } = plistTexts(mac, parseInstallConfig(raw));
  assert.deepEqual(problems, []);
  let seen = 0;
  for (const [job, text] of Object.entries(plists)) {
    if (!Object.hasOwn(PROVED_JOBS, job)) continue;
    const o = plistObject(text); seen += 1;
    const s = standIn();
    const r = judgeJob(job, { cfg: s.cfg, io: testIo({ base: s.base, plists: { [plistFile(job)]: o }, built: () => o }), ownerUid: 99_999 });
    assert.doesNotMatch(r.why ?? '', /installer|Program|GroupName|EnvironmentVariables/, `${job}: ${r.why}`);
  }
  assert.ok(seen >= 3, `the builder made ${seen} proved jobs`);
});

test('r1 m3: the check starts the script with no argument, so a script that runs its main when given one is never started', () => {
  const s = standIn({ [ROBOT]: "import '../shared/secret-guard.mjs';\nif (process.argv.length > 1) throw new Error('main ran: ' + process.argv.slice(1).join(' '));\n" });
  assert.equal(judge(s).result, 'PASS');
});

test('r1 m4: a temp folder, a thread, a datagram, a name lookup or a listener at load is a FAIL, and nothing is done', () => {
  const s = standIn();
  const cases = [
    [`import fs from 'node:fs';\nimport '../shared/secret-guard.mjs';\ntry { fs.mkdtempDisposableSync('/tmp/orch-x-'); } catch {}\n`, /file write \(mkdtempDisposableSync\)/],
    [`import fs from 'node:fs';\nimport '../shared/secret-guard.mjs';\nawait fs.promises.mkdtempDisposable('/tmp/orch-x-').catch(() => {});\n`, /file write \(mkdtempDisposable\)/],
    [`import { Worker } from 'node:worker_threads';\nimport '../shared/secret-guard.mjs';\ntry { new Worker('1', { eval: true }); } catch {}\n`, /thread start \(Worker\)/],
    [`import dgram from 'node:dgram';\nimport '../shared/secret-guard.mjs';\ntry { dgram.createSocket('udp4'); } catch {}\n`, /network connection \(createSocket\)/],
    [`import dns from 'node:dns';\nimport '../shared/secret-guard.mjs';\ntry { dns.lookup('localhost', () => {}); } catch {}\n`, /name lookup \(lookup\)/],
    [`import dns from 'node:dns/promises';\nimport '../shared/secret-guard.mjs';\nawait dns.resolve4('localhost').catch(() => {});\n`, /name lookup \(resolve4\)/],
    [`import net from 'node:net';\nimport '../shared/secret-guard.mjs';\ntry { net.createServer().listen(0); } catch {}\n`, /listening \(listen\)/],
  ];
  for (const [text, want] of cases) {
    writeFileSync(join(s.real, ROBOT), text);
    const r = judge(s);
    assert.equal(r.result, 'FAIL', text);
    assert.match(r.why, want, text);
  }
});

test('r1 m5: every job daemons.mjs knows is either proved or left out with its reason, and no other', () => {
  assert.deepEqual([...Object.keys(PROVED_JOBS), ...Object.keys(NOT_CHECKED)].sort(), [...ALL_JOBS].sort());
});
