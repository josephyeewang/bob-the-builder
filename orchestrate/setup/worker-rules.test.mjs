// L1225, L1226, L1227: root's worker-rules job, on the stand-in Mac. It writes each product's rules snapshot, root's 0644 in
// root's folder, only while launchd shows the worker runner's job running as the builder; anything else writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { ROOT_CONFIG_PATH, workerRulesDir, workerRulesPath } from './layout.mjs';
import { installPaths } from './install.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { readSnapshot, snapshotHash } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { OPTIONAL_JOBS, jobsFor, onlyJobs, plistTexts } from './daemons.mjs';
import { WORKER_RUNNER_JOB } from './worker-runner-setup.mjs';
import { WALL_CHECK_JOB } from './builder-wall.mjs';
import { PS, WORKER_RULES_JOB, WORKER_RULES_SCRIPT, WRITE_EVERY_S, configSha256, main, planBeat, rulesText, runnerLive, workerRulesPlist, writeRules } from './worker-rules.mjs';

const BASE = '/Library/orchestrate';
const LABEL = 'com.example.orch';
const BUILDER_UID = 65002;
const RUNNER = `${LABEL}.${WORKER_RUNNER_JOB}`;
const RULES = Object.freeze({ production: { env_files: ['/srv/app/.env'], programs: ['deploy'], hosts: ['db.example.invalid'] }, secrets: { paths: ['/srv/keys'] } });
const OTHER_RULES = Object.freeze({ ...RULES, production: { ...RULES.production, hosts: ['other.example.invalid'] } });

/** A config the runner's own check takes, for the product `alpha` (paths only need to be full). */
const runnerConfig = (over = {}) => ({ installRoot: '/i', requestsDir: '/w/requests', statusFile: '/w/runner/status.json', orchestrateUid: 501,
  outboxRoot: '/w/outboxes', copiesRoot: '/w/copies', home: '/w/home', path: '/usr/bin:/bin', claudeBin: '/i/claude', recordRoot: '/w/record', recordUid: 501,
  claimMs: 600_000, wallStatus: '/w/wall/status.json',
  products: { alpha: { repo: 'o/alpha', mirror: '/w/mirror', rules: RULES, render: { paths: { deny: { record: '/w/record', ssh: '/w/home/.ssh', gh: '/w/home/.config/gh', claudeHome: '/w/home/.claude', robotKeys: '/w/keys', secrets: ['/w/secrets'] } } } } },
  ...over });

/**
 * The stand-in Mac with a builder, root's base, and the worker runner's job as launchd would show it. `runner`: undefined
 * (not loaded) or { state, pid, uid } (uid: the user ps gives its pid). `print`: launchctl's answer for it, replaced.
 */
function world({ runner = { state: 'running', pid: 4100, uid: BUILDER_UID }, builder = true, print = null, ps = null } = {}) {
  const mac = fakeMac({ users: builder ? { builder: { UniqueID: String(BUILDER_UID), PrimaryGroupID: '20', UserShell: '/bin/zsh', NFSHomeDirectory: '/Users/builder' } } : {} });
  mkdirSync(mac.at(BASE), { recursive: true }); chmodSync(mac.at(BASE), 0o755); mac.owners.set(BASE, { uid: mac.rootUid, gid: 0 });
  if (runner) mac.loaded.set(RUNNER, { state: runner.state, pid: runner.pid });
  const run = mac.run; mac.calls = [];
  mac.run = (cmd, args) => {
    mac.calls.push([cmd, ...args].join(' '));
    if (cmd === '/bin/launchctl' && args[0] === 'print' && args[1] === `system/${RUNNER}` && print) return print;
    if (cmd === PS && args[0] === '-o' && args[1] === 'uid=') {
      if (ps) return ps;
      return runner && Number(args[3]) === runner.pid ? { status: 0, stdout: `  ${runner.uid}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    return run(cmd, args);
  };
  const cfg = { base: BASE, owner: 'sam', products: ['alpha'], label: LABEL, workerRunner: { product: 'alpha' } };
  return { mac, cfg };
}
const beat = (w, config = runnerConfig(), at = new Date('2026-11-14T12:00:00Z')) => planBeat(w.mac, w.cfg, { readConfig: () => config, now: at });
const written = (w) => readFileSync(w.mac.at(workerRulesPath(w.cfg, 'alpha')), 'utf8');
const doBeat = (w, config) => { const p = beat(w, config); assert.deepEqual(p.problems, []); for (const x of p.writes) writeRules(w.mac, w.cfg, x.product, x.text); return p; };

test('L1226: the job is root\'s (no UserName), runs node <copy>/setup/worker-rules.mjs write at load and every minute, and is on exactly with the worker runner, first of the three', () => {
  const { cfg } = world();
  const t = workerRulesPlist(cfg); const P = installPaths(cfg);
  assert.ok(t.includes(`<key>Label</key><string>${LABEL}.${WORKER_RULES_JOB}</string>`), t);
  assert.ok(t.includes(`<string>${join(P.installRoot, NODE)}</string><string>${join(P.installRoot, WORKER_RULES_SCRIPT)}</string><string>write</string>`), t);
  assert.ok(t.includes(`<key>StartInterval</key><integer>${WRITE_EVERY_S}</integer>`) && t.includes('<key>RunAtLoad</key><true/>'), t);
  assert.equal(t.includes('UserName'), false, 'it runs as root');
  assert.ok(WRITE_EVERY_S * 4 < 300, 'four beats can be missed inside the snapshot\'s 5-minute limit');
  const off = { ...cfg, workerRunner: undefined };
  assert.deepEqual(jobsFor(cfg).slice(-3), [WORKER_RULES_JOB, WALL_CHECK_JOB, WORKER_RUNNER_JOB]);
  assert.equal(jobsFor(off).includes(WORKER_RULES_JOB), false);
  assert.ok(OPTIONAL_JOBS.includes(WORKER_RULES_JOB));
  assert.throws(() => onlyJobs(off, WORKER_RULES_JOB), /workerRunner/);
  assert.deepEqual(onlyJobs(off, WORKER_RULES_JOB, { anyKnown: true }), [WORKER_RULES_JOB], 'one the config has since turned off can still be taken out');
  const { plists, problems } = plistTexts(world().mac, cfg);
  assert.deepEqual(problems, []); assert.equal(plists[WORKER_RULES_JOB], t);
  assert.equal(workerRulesPath(cfg, 'alpha'), `${BASE}/worker-rules/alpha.json`);
});

test('L1226 clean control: with the runner running as the builder, one beat writes alpha\'s snapshot, root\'s 0644 in root\'s 0755 folder, that the hooks\' root reader takes', () => {
  const w = world(); const c = runnerConfig();
  const p = doBeat(w, c);
  assert.deepEqual(p.writes.map((x) => x.product), ['alpha']);
  const f = workerRulesPath(w.cfg, 'alpha'); const st = w.mac.lstat(f); const d = w.mac.lstat(workerRulesDir(w.cfg));
  assert.equal(st.uid, w.mac.rootUid); assert.equal(st.mode & 0o7777, 0o644); assert.equal(st.nlink, 1);
  assert.equal(d.uid, w.mac.rootUid); assert.equal(d.mode & 0o7777, 0o755);
  const s = JSON.parse(written(w));
  assert.deepEqual(Object.keys(s).sort(), ['config_sha256', 'hash', 'product', 'rules', 'written_at']);
  assert.deepEqual(s.rules, RULES); assert.equal(s.hash, snapshotHash(RULES)); assert.equal(s.product, 'alpha');
  assert.equal(s.config_sha256, configSha256(c)); assert.equal(s.written_at, '2026-11-14T12:00:00.000Z');
  // The reader PR (ii) gives the hooks and the runner: root's alone, every folder above root's (the test's user stands in for root).
  const r = readSnapshot(w.mac.at(f), { ownerUid: w.mac.rootUid, now: Date.parse('2026-11-14T12:01:00Z') });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.rules, RULES);
  // The pid was read from launchctl's answer for the exact label, and its user asked of ps by that pid.
  assert.ok(w.mac.calls.includes(`/bin/launchctl print system/${RUNNER}`), w.mac.calls.join('\n'));
  assert.ok(w.mac.calls.includes(`${PS} -o uid= -p 4100`), w.mac.calls.join('\n'));
  // A second beat rewrites it (a fresh time, the same one name).
  const p2 = beat(w, c, new Date('2026-11-14T12:01:00Z')); writeRules(w.mac, w.cfg, 'alpha', p2.writes[0].text);
  assert.equal(JSON.parse(written(w)).written_at, '2026-11-14T12:01:00.000Z');
});

test('L1227 plant 15: the runner not loaded, not running, or running as anyone but the builder writes nothing, and says why', () => {
  const cases = [
    [{ runner: null }, /is not loaded/],
    [{ runner: { state: 'waiting', pid: 0, uid: BUILDER_UID } }, /is waiting, not running/],
    [{ runner: { state: 'running', pid: 4100, uid: 65001 } }, /runs as uid 65001, not the builder user's \(65002\)/],
    [{ runner: { state: 'running', pid: 4100, uid: 0 } }, /runs as uid 0, not the builder/],
    [{ ps: { status: 1, stdout: '', stderr: '' } }, /pid 4100 is gone/],
    [{ ps: { status: 0, stdout: 'builder\n', stderr: '' } }, /can't be read/],
    [{ builder: false }, /builder user is not on this Mac/],
  ];
  for (const [opts, why] of cases) {
    const w = world(opts); const p = beat(w);
    assert.deepEqual(p.writes, [], JSON.stringify(opts));
    assert.match(p.problems.join('\n'), why);
    assert.match(p.problems.join('\n'), /no snapshot was written .*go stale within 5 minutes/);
  }
  // Once the runner stops, nothing is written again: the last one is left to go stale (today's behaviour, L1227).
  const w = world(); doBeat(w); const before = written(w);
  w.mac.loaded.delete(RUNNER);
  assert.deepEqual(beat(w, runnerConfig(), new Date('2026-11-14T12:01:00Z')).writes, []);
  assert.equal(written(w), before);
});

test('L1227: launchctl\'s answer that can\'t be read writes nothing (fail closed): no state line, two, a pid that is not a number, two pids, a failed print', () => {
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  const cases = [
    [ok(`system/${RUNNER} = {\n\tpid = 4100\n}\n`), /0 top-level state lines/],
    [ok(`system/${RUNNER} = {\n\tstate = running\n\tstate = running\n\tpid = 4100\n}\n`), /2 top-level state lines/],
    [ok(`system/${RUNNER} = {\n\tstate = running\n}\n`), /gives 0 pid lines/],
    [ok(`system/${RUNNER} = {\n\tstate = running\n\tpid = 4100\n\tpid = 4101\n}\n`), /gives 2 pid lines/],
    [ok(`system/${RUNNER} = {\n\tstate = running\n\tpid = 41a0\n}\n`), /the pid "41a0"/],
    [ok(`system/${RUNNER} = {\n\tstate = running\n\tpid = 0\n}\n`), /the pid "0"/],
    [{ status: 5, stdout: '', stderr: 'launchctl: something else\n' }, /failed \(launchctl: something else\)/],
  ];
  for (const [print, why] of cases) {
    const w = world({ print }); const p = beat(w);
    assert.deepEqual(p.writes, [], print.stdout); assert.match(p.problems.join('\n'), why);
  }
  // A pid nested deeper than the job's own fields (two tabs: a section inside it) is not the job's pid.
  const nested = world({ print: ok(`system/${RUNNER} = {\n\tstate = running\n\tendpoints = {\n\t\tpid = 4100\n\t}\n}\n`) });
  assert.match(beat(nested).problems.join('\n'), /gives 0 pid lines/);
  // The control: the same form with the job's own pid line is live.
  assert.deepEqual(runnerLive(world({ print: ok(`system/${RUNNER} = {\n\tstate = running\n\tpid = 4100\n}\n`) }).mac, world().cfg, BUILDER_UID), { live: true, pid: 4100 });
});

test('L1226 plant 12: a config the job can\'t read, one the runner refuses, or one naming a product setup does not list writes nothing for any product', () => {
  const cases = [
    [() => { throw new Error('job config /x: can be written by group or others'); }, /can be written by group or others/],
    [() => runnerConfig({ claimMs: 0 }), /claimMs/],
    [() => runnerConfig({ products: {} }), /at least one product/],
    [() => runnerConfig({ products: { ...runnerConfig().products, beta: { ...runnerConfig().products.alpha } } }), /"beta", which the setup config does not list/],
    [() => runnerConfig({ products: { alpha: { ...runnerConfig().products.alpha, rules: undefined } } }), /no rules for alpha|can't be used/],
  ];
  for (const [readConfig, why] of cases) {
    const w = world(); const p = planBeat(w.mac, w.cfg, { readConfig });
    assert.deepEqual(p.writes, []); assert.match(p.problems.join('\n'), why);
  }
  // The real reading refuses a config that isn't there (the runner's own reading of root's copy).
  const w = world(); const p = planBeat(w.mac, w.cfg);
  assert.deepEqual(p.writes, []); assert.match(p.problems.join('\n'), /worker-runner\.json can't be used/);
});

test('L1226: the snapshot follows the config: other rules give another hash, and the fingerprint names the very config read', () => {
  const w = world();
  doBeat(w); const a = JSON.parse(written(w));
  doBeat(w, runnerConfig({ products: { alpha: { ...runnerConfig().products.alpha, rules: OTHER_RULES } } })); const b = JSON.parse(written(w));
  assert.notEqual(a.hash, b.hash); assert.notEqual(a.config_sha256, b.config_sha256); assert.deepEqual(b.rules, OTHER_RULES);
  doBeat(w, runnerConfig({ claimMs: 600_001 })); const c = JSON.parse(written(w));
  assert.equal(c.hash, a.hash, 'the same rules'); assert.notEqual(c.config_sha256, a.config_sha256, 'another config');
  assert.equal(rulesText('alpha', RULES, 'x'.repeat(64), new Date(0)), `${JSON.stringify({ written_at: new Date(0).toISOString(), hash: snapshotHash(RULES), rules: RULES, product: 'alpha', config_sha256: 'x'.repeat(64) })}\n`);
});

test('L1226 plant 5: a hard link the builder made to the snapshot (two names, which every reader refuses) is removed with a refusal, and the next beat writes it fresh', () => {
  const w = world(); doBeat(w);
  const f = w.mac.at(workerRulesPath(w.cfg, 'alpha')); const other = w.mac.at(`${BASE}/elsewhere.json`);
  linkSync(f, other);
  assert.equal(lstatSync(f).nlink, 2);
  assert.match(readSnapshot(f, { ownerUid: w.mac.rootUid, now: Date.parse('2026-11-14T12:00:30Z') }).reason, /2 names/);
  assert.throws(() => doBeat(w), /was not one plain file of root's \(2 names\); it was removed, and nothing new was written/);
  assert.throws(() => lstatSync(f), /ENOENT/, 'root\'s name is gone, so no reader is pointed at the old file');
  assert.equal(lstatSync(other).nlink, 1, 'the other name keeps the old file, which no reader is pointed at');
  doBeat(w);
  assert.equal(lstatSync(f).nlink, 1, 'the next beat writes a new file of one name');
  assert.equal(readSnapshot(f, { ownerUid: w.mac.rootUid, now: Date.parse('2026-11-14T12:00:30Z') }).ok, true);
});

test('L1226 plant 4: anything at the snapshot\'s name but a plain file of root\'s is removed and the write refused; a folder not root\'s is refused', () => {
  // A link at the name.
  let w = world(); doBeat(w);
  const f = workerRulesPath(w.cfg, 'alpha');
  w.mac.unlink(f); symlinkSync('/etc/hosts', w.mac.at(f));
  assert.throws(() => doBeat(w), /was not one plain file of root's \(a link\); it was removed/);
  assert.throws(() => w.mac.lstat(f), /ENOENT/);
  // A plain file at the name with another owner.
  w = world(); doBeat(w);
  w.mac.owners.set(f, { uid: BUILDER_UID, gid: 20 });
  assert.throws(() => doBeat(w), /was not one plain file of root's \(not root's\); it was removed/);
  // The folder there but someone else's: refused, and nothing is written in it.
  w = world(); mkdirSync(w.mac.at(workerRulesDir(w.cfg))); w.mac.owners.set(workerRulesDir(w.cfg), { uid: BUILDER_UID, gid: 20 });
  assert.throws(() => doBeat(w), /is there but is not a folder of root's/);
  assert.throws(() => w.mac.lstat(f), /ENOENT/);
  // The folder root's but open to others: made root's 0755 again before the write.
  w = world(); mkdirSync(w.mac.at(workerRulesDir(w.cfg))); w.mac.owners.set(workerRulesDir(w.cfg), { uid: w.mac.rootUid, gid: 0 }); chmodSync(w.mac.at(workerRulesDir(w.cfg)), 0o777);
  doBeat(w);
  assert.equal(w.mac.lstat(workerRulesDir(w.cfg)).mode & 0o7777, 0o755);
});

test('L1226 plant 3: a base whose folders are not root\'s alone is refused, and nothing is written', () => {
  const w = world(); chmodSync(w.mac.at(BASE), 0o777);
  assert.throws(() => doBeat(w), /is not safe for root to write in/);
  assert.throws(() => w.mac.lstat(workerRulesDir(w.cfg)), /ENOENT/);
});

test('L1226: main refuses without root, with no workerRunner entry, and an unknown command; --dry-run says what it would write and writes nothing', () => {
  const run = (w, argv, plan) => { const out = []; const err = []; const code = main(argv, { io: w.mac, out: (x) => out.push(x), err: (x) => err.push(x), plan }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const withConfig = (w, over = {}) => { writeFileSync(w.mac.at(ROOT_CONFIG_PATH), JSON.stringify({ base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/o/r.git', label: LABEL, runnerConfig: '/x/review.json', workerRunner: { product: 'alpha' }, ...over })); return w; };
  const plan = { readConfig: () => runnerConfig(), now: new Date('2026-11-14T12:00:00Z') };
  assert.equal(run(world(), ['nope']).code, 2);
  assert.equal(run(world(), ['write', '--force']).code, 2);
  const notRoot = world(); notRoot.mac.as = 501;
  assert.match(run(notRoot, ['write']).err, /refused: .*root/);
  const w = withConfig(world());
  const r0 = run(w, ['write', '--dry-run'], plan);
  assert.equal(r0.code, 0, r0.err); assert.match(r0.out, /would write \/Library\/orchestrate\/worker-rules\/alpha\.json/);
  assert.throws(() => w.mac.lstat(workerRulesDir(w.cfg)), /ENOENT/);
  const r1 = run(w, ['write'], plan);
  assert.equal(r1.code, 0, r1.err); assert.equal(JSON.parse(written(w)).product, 'alpha');
  w.mac.loaded.delete(RUNNER);
  const r2 = run(w, ['write'], plan);
  assert.equal(r2.code, 1); assert.match(r2.err, /is not loaded, so no snapshot was written/);
});
