// robot-wiring.test.mjs — the robot job starts from its real entry point with the real wiring (R-0b-162 B; L236, L238).
// Run: node --test orchestrate/wiring/robot-wiring.test.mjs
//
// The boot test runs `node robot-main.mjs <config>` as its own process, as the job would, with the real wiring, Record,
// rules and lock. The only stand-in is GitHub (fake-github.test-helper.mjs through `node --import`). It runs in CI with
// the rest of orchestrate's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installedLayout } from '../shared/job-config.test-helper.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { makeRecord, memoryRecord } from '../shared/record.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { wire, checkUser, lastReturn, dispatcherLate, dropLateAlerts, lockHolder, LIVE_PASS_MAX_MS, NOT_WIRED_PASSES, ROBOT_PASSES, APP_KEYS, robotToken, robotChannel } from './robot-wiring.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { pidDead, takePassLock } from '../modules/M11-dispatcher/pass-lock.mjs';
import { tick } from '../modules/M11-dispatcher/tick.mjs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { fakeAlert } from '../test/fake-alert.test-helper.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';
import { runPasses, CAUSE, main, NOT_QUEUED, LOCK_REFUSED, pidState, takeRoundLock } from './robot-main.mjs';
import { notWiredText } from './dispatcher-wiring.mjs';
import { fakeGitHubFetch, blobOf } from './fake-github.test-helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-github.test-helper.mjs');
const COMMIT = 'a'.repeat(40);
const P = ENTRY.product;
const OWNER_ID = ENTRY.joe_github_id;
const MIN = 60e3;

function world({ extra = {}, issues = [], keyMode = 0o700 } = {}) {
  // An installed copy of this checkout (L253): the job reads its config through shared/job-config.mjs.
  const L = installedLayout('orch-robot-', { source: true });
  const dir = L.base;
  const f = (n) => join(dir, n);
  writeFileSync(f('products.json'), JSON.stringify([ENTRY]));
  const rulesStateDir = f('rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  writeFileSync(join(rulesStateDir, 'approved-rules.json'), JSON.stringify({ [P]: [blobOf(FIRST)] }));
  const keyDir = f('keys');
  mkdirSync(keyDir); chmodSync(keyDir, keyMode);
  const token = f('token');
  writeFileSync(token, 'x'.repeat(40), { mode: 0o600 }); chmodSync(token, 0o600);
  const config = { installRoot: L.installRoot, wiring: L.path('wiring/robot-wiring.mjs'), lockFile: f('robot.lock'), product: P, recordRoot: f('record'), ownerUid: process.getuid(),
    productsFile: f('products.json'), rulesStateDir, tokenFile: token, keyDir, dispatcherLockFile: f('dispatcher.lock'), ...extra };
  const configFile = L.write('robot.json', config);
  const main = L.path('wiring/robot-main.mjs');
  const fake = { owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: FIRST, issues, logFile: f('github.log') };
  writeFileSync(f('fake-github.json'), JSON.stringify(fake));
  return { dir, f, config, configFile, main, fake };
}

function boot(w) {
  const r = spawnSync(process.execPath, ['--import', FAKE, w.main, w.configFile], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ORCH_FAKE_GITHUB: w.f('fake-github.json') }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, err: r.stderr };
}

const readRecord = (w) => openRecord({ root: w.config.recordRoot, product: P, ownerUid: process.getuid(), rules: fakeRules() }).record;
const queued = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).map((e) => e.text);
const pushes = (rec) => rec.list('fact').filter((x) => x.id.startsWith('push-request-'));

test('R-0b-162 B: `node robot-main.mjs <config>` runs every pass; the ones not wired yet fail and are told, once', () => {
  const w = world({ issues: [{ number: 7, title: 'an idea', body: 'b', user: { id: OWNER_ID } }, { number: 8, title: 'x', body: 'y', user: { id: OWNER_ID + 1 } }] });
  const first = boot(w);
  assert.equal(first.code, 0, first.err);
  assert.doesNotMatch(first.err, /not started/);
  const rec = readRecord(w);
  const q = queued(rec);
  for (const [p, port] of Object.entries(NOT_WIRED_PASSES)) {
    assert.ok(q.includes(`the robot job's ${p} pass failed: ${notWiredText(port)}; the other passes still ran`), `${p} is told: ${q.join(' | ')}`);
    assert.match(first.err, new RegExp(`robot: ${p} failed: not wired yet`));
  }
  // The Dispatcher never ran in this world: that is told too.
  assert.ok(q.includes('the Dispatcher has no full pass on record: nothing is started or merged until it runs'), q.join(' | '));
  // caught-up is real: it ran (no failure told), read the idea issues, and filed Joe's idea only.
  assert.equal(rec.read('fact', HOLD_FACT(CAUSE('caught-up'))), null);
  assert.ok(rec.read('fact', 'idea-issue-7'), 'the owner\'s idea is filed');
  assert.equal(rec.read('fact', 'idea-issue-8'), null, 'an idea from another account is not filed');
  // Once per pass per day: a second round adds nothing to the queue.
  const second = boot(w);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(queued(readRecord(w)), q);
});

test('R-0b-162 B (L238): the job refuses to start, loudly, unless it runs as the Record\'s and the key folder\'s owner', async () => {
  // A key folder others can read: exit 1, with the reason in the job's log.
  const open = world({ keyMode: 0o755 });
  const r = boot(open);
  assert.equal(r.code, 1);
  assert.match(r.err, /robot: not started: the robot key folder .* can be read by others \(mode 755\)/);
  // Not the Record's owner.
  const w = world();
  await assert.rejects(wire(w.config, { uid: process.getuid() + 1, fetchFn: fakeGitHubFetch(w.fake) }), /runs only as the Record's owner/);
  // A key folder that belongs to someone else (a stat stand-in: a test can't make another user's folder).
  const stat = { isSymbolicLink: () => false, isDirectory: () => true, uid: process.getuid() + 1, mode: 0o40700 };
  assert.throws(() => checkUser({ uid: process.getuid(), ownerUid: process.getuid(), keyDir: '/k', lstat: () => stat }), /belongs to uid/);
  assert.throws(() => checkUser({ uid: process.getuid(), ownerUid: process.getuid(), keyDir: '/k', lstat: () => ({ ...stat, isSymbolicLink: () => true }) }), /not a plain folder/);
  // An unknown key stops the start too.
  const typo = world({ extra: { keyDirs: '/x' } });
  assert.equal(boot(typo).code, 1);
});

test('R-0b-162 B: caught-up pushes once when the Dispatcher COMES BACK, never while it is still down', async () => {
  const w = world();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec, passes } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), now: () => t, log: () => {} });
  const dispatcherPass = () => rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: new Date(t).toISOString(), started_at: new Date(t).toISOString(), steps: {} }, kind: 'full_pass' });
  const round = () => runPasses({ rec, passes, now: () => t });
  assert.ok(dispatcherPass().ok);
  t += MIN; assert.ok(dispatcherPass().ok);
  // The Dispatcher stops. Thirty minutes later it is still down: nothing is pushed.
  t += 30 * MIN;
  let r = await round();
  assert.ok(r['caught-up'].ok, r['caught-up'].error);
  assert.equal(r['caught-up'].result.returned, false);
  assert.equal(pushes(rec).length, 0, 'no "caught up" while the Dispatcher is still down');
  // It comes back: one push, saying how long it was down.
  t += MIN; assert.ok(dispatcherPass().ok);
  t += MIN; r = await round();
  assert.equal(r['caught-up'].result.pushed, true);
  assert.equal(pushes(rec).length, 1);
  assert.match(pushes(rec)[0].doc.text, /Caught up after 0\.5 h/);
  // The next rounds don't push again.
  t += MIN; assert.ok(dispatcherPass().ok);
  t += MIN; await round();
  assert.equal(pushes(rec).length, 1);
  // A return more than a day old is not looked for.
  assert.equal(lastReturn(rec, { nowMs: t + 2 * 24 * 60 * MIN }), null);
});

test('R-0b-162 B: every pass is named, and a pass that throws does not stop the others', async () => {
  assert.deepEqual([...ROBOT_PASSES].sort(), [...Object.keys(NOT_WIRED_PASSES), 'caught-up'].sort());
  const w = world();
  const { rec } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} });
  const ran = [];
  const passes = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => { ran.push(p); if (p === 'gate') throw new Error('boom'); return p; }]));
  const r = await runPasses({ rec, passes, now: () => Date.now() });
  assert.deepEqual(ran, [...ROBOT_PASSES]);
  assert.equal(r.gate.ok, false);
  assert.ok(queued(rec).includes('the robot job\'s gate pass failed: boom; the other passes still ran'));
  // A pass that never answers is cut off at its deadline and told.
  const stuck = await runPasses({ rec, passes: { ...passes, watch: () => new Promise(() => {}) }, now: () => Date.now(), passDeadlineMs: 50 });
  assert.match(stuck.watch.error, /did not finish within 50 ms/);
  // A pass that answers { refused } failed, and is told.
  const ref = await runPasses({ rec, passes: { ...passes, gate: () => 'ok', deliver: () => ({ sent: 0, refused: 'alert channel not set up: no token' }) }, now: () => Date.now() });
  assert.deepEqual([ref.deliver.ok, ref.deliver.error], [false, 'alert channel not set up: no token']);
  assert.ok(queued(rec).includes('the robot job\'s deliver pass failed: alert channel not set up: no token; the other passes still ran'));
});

test('R-0b-162 B (L239): the heartbeat tells Joe when the Dispatcher\'s last full pass is too old, once per stop', () => {
  const w = world();
  // The Dispatcher's last pass, written as the Dispatcher would, some minutes before the robot job runs.
  const lastPass = (minAgo) => {
    const rec = readRecord(w);
    assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
      doc: { at: new Date(Date.now() - minAgo * MIN).toISOString(), steps: {} }, kind: 'full_pass' }).ok);
  };
  const late = (q) => q.filter((t) => /^the Dispatcher's last full pass was \d+ minutes ago \(late after 15\)/.test(t));
  lastPass(DISPATCHER_LATE_MIN + 25);
  const r = boot(w);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /robot: alert: the Dispatcher's last full pass was 4\d minutes ago \(late after 15\)/);
  assert.equal(late(queued(readRecord(w))).length, 1, queued(readRecord(w)).join(' | '));
  // The same stop is not told again on the next run.
  boot(w);
  assert.equal(late(queued(readRecord(w))).length, 1);
  // On time: nothing new, and the ended stop's alert leaves the queue unsent (L265, audit #137 M5). A new stop later: told again.
  lastPass(1); boot(w);
  assert.equal(late(queued(readRecord(w))).length, 0);
  lastPass(DISPATCHER_LATE_MIN + 1); boot(w);
  assert.equal(late(queued(readRecord(w))).length, 1);
  // The edges, without a process: 15 minutes is on time, 16 is late, a pass from the future is told.
  const rec = readRecord(w);
  const at = Date.parse(rec.read('fact', LAST_PASS_FACT).doc.at);
  assert.equal(dispatcherLate(rec, { nowMs: at + DISPATCHER_LATE_MIN * MIN }), null);
  assert.ok(dispatcherLate(rec, { nowMs: at + (DISPATCHER_LATE_MIN + 1) * MIN }));
  assert.match(dispatcherLate(rec, { nowMs: at - 11 * MIN }).text, /in the future/);
});

test('R-0b-162 B (L242): with the Dispatcher never run, the late alert is queued and delivered in the same round', async () => {
  const w = world();
  const got = [];
  // A stand-in for lane 3's deliverAlertsPass: it takes what is in the Record's queue when it runs.
  const deliver = ({ rec }) => { got.push(...queued(rec)); return { sent: got.length }; };
  const logs = [];
  const code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { deliver, fetchFn: fakeGitHubFetch(w.fake) } });
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(got.includes('the Dispatcher has no full pass on record: nothing is started or merged until it runs'), got.join(' | '));
  // Every pass before it had run: their failures were queued first, so delivery saw them too.
  for (const p of ['gate', 'watch']) assert.ok(got.some((t) => t.startsWith(`the robot job's ${p} pass failed`)), p);
  assert.equal(ROBOT_PASSES.at(-1), 'deliver');
});

test('audit #144 r2 n1: a config that names no installRoot is refused by main, which says installRoot', async () => {
  const L = installedLayout('orch-robot-noroot-', { files: { 'wiring/w.mjs': 'export async function wire() { return {}; }\n' } });
  const self = L.write('wiring/robot-main.mjs', 'export {};\n');
  // Everything else as a working config has it: only the reader can refuse this one (a job that read its own file
  // first and returned it when it named no installRoot would go on to the wiring instead).
  const config = L.write('job.json', { wiring: L.path('wiring/w.mjs') });
  const lines = [];
  assert.equal(await main([config], { self, log: (s) => lines.push(s) }), 1);
  assert.match(lines.join('\n'), /installRoot must be a full path/);
});

test('L639: the robot config refuses the review runner\'s keys, which are the Dispatcher\'s alone', async () => {
  const { REVIEW_CONFIG_KEYS } = await import('./dispatcher-wiring.mjs');
  const { CONFIG_KEYS: ROBOT } = await import('./robot-wiring.mjs');
  assert.equal(REVIEW_CONFIG_KEYS.length, 5);
  const { checkConfig } = await import('./dispatcher-wiring.mjs');
  const base = { product: P, ownerUid: process.getuid() };
  assert.equal(checkConfig(base, { keys: ROBOT, paths: [] }), base);
  for (const k of REVIEW_CONFIG_KEYS) {
    assert.ok(!ROBOT.includes(k), k);
    assert.throws(() => checkConfig({ ...base, [k]: '/x' }, { keys: ROBOT, paths: [] }), new RegExp(`config: unknown key ${k}`));
  }
});

// ---- the #137 follow-up (L265; audit-pr137 M1-M7, M9) ----

const lockOf = (w) => w.config.lockFile;
const deadPid = () => { let p = 999_999; while (!pidDead(p)) p -= 1; return p; };

test('L265 M2 (P7, P5, P6a/b): a live holder runs nothing; a dead holder\'s lock is broken and told; a late round is told, exits 2 and keeps its lock', async () => {
  const w = world();
  const run = async (opts = {}, cfg = w.configFile) => { const logs = []; let delivered = 0;
    const deliver = opts.deliver ?? (() => { delivered += 1; return { sent: 0 }; });
    const code = await main([cfg], { self: w.main, log: (l) => logs.push(l), wireOpts: { deliver, fetchFn: fakeGitHubFetch(w.fake) }, ...opts.main });
    return { code, logs, delivered }; };
  // P7: a live holder (this test's own pid): exit 0, a log line, no pass runs, the lock is left as it was.
  // (L740: the holder's time must be readable and inside the longest a round may run, or it is refused, exit 3.)
  const liveAt = new Date().toISOString();
  writeFileSync(lockOf(w), JSON.stringify({ pid: process.pid, taken_at: liveAt }));
  let r = await run();
  assert.equal(r.code, 0);
  assert.ok(r.logs.some((l) => /robot: another pass runs \(pid \d+\)/.test(l)), r.logs.join('\n'));
  assert.equal(r.delivered, 0, 'no pass ran under another round\'s lock');
  assert.equal(JSON.parse(readFileSync(lockOf(w), 'utf8')).taken_at, liveAt);
  // P5: a dead holder: its lock is broken, the stopped round is told, and this round runs.
  writeFileSync(lockOf(w), JSON.stringify({ pid: deadPid(), taken_at: 'T-dead' }));
  r = await run();
  assert.equal(r.code, 0, r.logs.join('\n'));
  assert.equal(r.delivered, 1);
  assert.ok(queued(readRecord(w)).some((t) => /the last robot job round \(taken T-dead\) was stopped before it finished/.test(t)));
  assert.equal(existsSync(lockOf(w)), false, 'a round that finished releases its lock');
  // P6a/b: a round past its deadline: told, exit 2, and the lock stays (M7: the pass may still run).
  const slow = world({ extra: { runDeadlineMs: 300 } });
  const logs = [];
  const code = await main([slow.configFile], { self: slow.main, log: (l) => logs.push(l), wireOpts: { deliver: () => new Promise(() => {}), fetchFn: fakeGitHubFetch(slow.fake) } });
  assert.equal(code, 2, logs.join('\n'));
  assert.ok(logs.some((l) => /the round did not finish within 300 ms/.test(l)));
  assert.ok(queued(readRecord(slow)).includes('a robot job round did not finish within 300 ms and was stopped; the next round starts in a minute'));
  assert.equal(existsSync(slow.config.lockFile), true, 'the late round keeps its lock');
});

test('L740: every lock the round cannot take exits 3 and names the lock and the cause; only a current round of ours exits 0', async () => {
  const w = world();
  const run = async (cfg) => { const logs = []; let delivered = 0;
    const code = await main([cfg], { self: w.main, log: (l) => logs.push(l), wireOpts: { deliver: () => { delivered += 1; return { sent: 0 }; }, fetchFn: fakeGitHubFetch(w.fake) } });
    return { code, logs, delivered }; };
  const refused = (r, cause, file = lockOf(w)) => {
    assert.equal(r.code, LOCK_REFUSED, r.logs.join('\n'));
    assert.equal(r.delivered, 0, 'no pass ran');
    const line = r.logs.find((l) => l.startsWith('robot: cannot take its lock '));
    assert.ok(line, r.logs.join('\n'));
    assert.ok(line.includes(file), `names the lock: ${line}`);
    assert.match(line, cause);
  };
  // Audit A1: the lock's folder does not exist (ENOENT). Never a quiet exit 0.
  const gone = join(dirname(w.configFile), 'no-such-folder', 'robot.lock');
  const cfgGone = join(dirname(w.configFile), 'robot-gone.json');
  writeFileSync(cfgGone, JSON.stringify({ ...JSON.parse(readFileSync(w.configFile, 'utf8')), lockFile: gone }), { mode: 0o600 });
  refused(await run(cfgGone), /could not take the pass lock: ENOENT/, gone);
  // A lock that can't be read.
  writeFileSync(lockOf(w), 'not json');
  refused(await run(w.configFile), /unreadable/);
  // Audit A2: a planted lock naming a live process that is not this user's (pid 1, launchd/init).
  if (pidState(1) === 'foreign') {
    writeFileSync(lockOf(w), JSON.stringify({ pid: 1, taken_at: new Date().toISOString() }));
    refused(await run(w.configFile), /another pass runs \(pid 1\), a process that is not this job's user's/);
  }
  // A lock with no pid at all.
  writeFileSync(lockOf(w), JSON.stringify({ taken_at: new Date().toISOString() }));
  refused(await run(w.configFile), /not this job's user's/);
  // Ours and alive, but held longer than any round may run (a reused pid, or a round that outlived its watchdog).
  writeFileSync(lockOf(w), JSON.stringify({ pid: process.pid, taken_at: new Date(Date.now() - 3 * 60 * 60e3).toISOString() }));
  refused(await run(w.configFile), /held 180 minutes, longer than any round may run/);
  // L754 (#312 Minor): the lock is never broken on its own, so the line says how to clear it, with its path.
  refused(await run(w.configFile), new RegExp(`if no robot round is running \\(check pid ${process.pid} is not one\\), delete ${lockOf(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  // Ours and alive, with no readable time, or one in the future.
  writeFileSync(lockOf(w), JSON.stringify({ pid: process.pid, taken_at: 'T-live' }));
  refused(await run(w.configFile), /no readable time/);
  writeFileSync(lockOf(w), JSON.stringify({ pid: process.pid, taken_at: new Date(Date.now() + 10 * 60e3).toISOString() }));
  refused(await run(w.configFile), /in the future/);
  // Every refusal left the lock as it was found.
  assert.match(readFileSync(lockOf(w), 'utf8'), new RegExp(String(process.pid)));
  rmSync(lockOf(w));
});

test("L740: pidState: this user's live pid is ours, a pid that is gone is dead, any other answer is foreign", () => {
  assert.equal(pidState(process.pid), 'ours');
  assert.equal(pidState(deadPid()), 'dead');
  assert.equal(pidState(5, { kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } }), 'foreign');
  for (const p of [undefined, null, 0, -1, 1.5, '7']) assert.equal(pidState(p), 'foreign', String(p));
});

test('L265 M1, P16: an alert the queue refuses, or a queue that throws, is logged and kept with the failure; the later passes still run', async () => {
  const w = world();
  const { rec } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} });
  const ran = [];
  const passes = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => { ran.push(p); if (p === 'gate') throw new Error('boom'); return {}; }]));
  // P16: holdAlert throws.
  let r = await runPasses({ rec, passes, now: () => Date.now(), hold: () => { throw new Error('the queue is damaged'); } });
  assert.deepEqual(ran, [...ROBOT_PASSES], 'every pass ran');
  assert.deepEqual([r.gate.ok, r.gate.tell], [false, 'the queue is damaged']);
  // M1: holdAlert answers false (the queue refused it).
  r = await runPasses({ rec, passes, now: () => Date.now(), hold: () => false });
  assert.equal(r.gate.tell, NOT_QUEUED);
  // Already told today (null) is not a refusal.
  r = await runPasses({ rec, passes, now: () => Date.now(), hold: () => null });
  assert.equal(r.gate.tell, undefined);
  // In main: the failed pass's line says it could not be told, and a stopped round whose alert is refused says so.
  writeFileSync(lockOf(w), JSON.stringify({ pid: deadPid(), taken_at: 'T0' }));
  const logs = [];
  const code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), hold: () => false, wireOpts: { fetchFn: fakeGitHubFetch(w.fake) } });
  assert.equal(code, 0);
  assert.ok(logs.includes(`robot: the stopped round ${NOT_QUEUED}`), logs.join('\n'));
  assert.ok(logs.some((l) => /robot: gate failed: not wired yet.*\(and could not be told: could not be queued\)/.test(l)), logs.join('\n'));
  // The heartbeat's own late alert (robot-wiring.mjs): refused → logged, and kept with the heartbeat's failure.
  const hw = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: (l) => logs.push(l), hold: () => false });
  const hr = await runPasses({ rec: hw.rec, passes: hw.passes, now: () => Date.now(), hold: () => null });
  assert.equal(hr.heartbeat.tell, 'the Dispatcher-late alert could not be queued');
  assert.ok(logs.includes('robot: the Dispatcher-late alert could not be queued'));
});

test('L265 M7, M9: a pass past its own limit keeps the lock; any `refused` fails the pass; failed items are logged', async () => {
  const w = world();
  const logs = [];
  const code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), passDeadlineMs: 50, wireOpts: { deliver: () => new Promise(() => {}), fetchFn: fakeGitHubFetch(w.fake) } });
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(logs.some((l) => /robot: deliver failed: it did not finish within 50 ms/.test(l)));
  assert.ok(logs.includes('robot: a pass ran past its time limit and may still be running; the lock stays until this process exits'));
  assert.equal(existsSync(lockOf(w)), true);
  rmSync(lockOf(w));
  const { rec } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} });
  const base = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => ({})]));
  for (const refused of [true, { why: 'x' }, 'no token']) {
    const r = await runPasses({ rec, passes: { ...base, deliver: () => ({ refused }) }, now: () => Date.now() });
    assert.equal(r.deliver.ok, false, JSON.stringify(refused));
  }
  const l2 = [];
  assert.equal(await main([w.configFile], { self: w.main, log: (l) => l2.push(l), wireOpts: { deliver: () => ({ sent: 2, failed: 3 }), fetchFn: fakeGitHubFetch(w.fake) } }), 0);
  assert.ok(l2.includes('robot: deliver ran, and 3 of its items failed'), l2.join('\n'));
});

test('L265 M3: the key folder check refuses group bits, a file, and an access list', () => {
  const w = world();
  const user = { uid: process.getuid(), ownerUid: process.getuid() };
  chmodSync(w.config.keyDir, 0o750);
  assert.throws(() => checkUser({ ...user, keyDir: w.config.keyDir }), /can be read by others \(mode 750\)/);
  chmodSync(w.config.keyDir, 0o700);
  assert.doesNotThrow(() => checkUser({ ...user, keyDir: w.config.keyDir }));
  const file = w.f('keyfile'); writeFileSync(file, '', { mode: 0o600 });
  assert.throws(() => checkUser({ ...user, keyDir: file }), /is not a plain folder/);
  assert.throws(() => checkUser({ ...user, keyDir: w.config.keyDir, acl: (ps) => `${ps[0]} has an access list (ACL)` }), /the robot key folder: .* has an access list/);
});

test('L265 M5, M6: a running Dispatcher pass is not late (a 20-minute live pass), a stuck one is; late alerts leave the queue once it is on time', async () => {
  const w = world();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec, passes } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), now: () => t, log: () => {} });
  const pass = (atMs, startMs = atMs) => { const r = rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: new Date(atMs).toISOString(), started_at: new Date(startMs).toISOString(), steps: {} }, kind: 'full_pass' }); assert.ok(r.ok, JSON.stringify(r)); };
  pass(t);
  const now = t + 21 * MIN;
  const live = (minAgo) => ({ live: true, takenAt: now - minAgo * MIN });
  assert.equal(dispatcherLate(rec, { nowMs: now, holder: live(20) }), null, 'a live 20-minute pass is not late');
  assert.ok(dispatcherLate(rec, { nowMs: now, holder: null }), 'no holder: late');
  assert.ok(dispatcherLate(rec, { nowMs: now, holder: { live: false, takenAt: now - 20 * MIN } }), 'a dead holder: late');
  assert.match(dispatcherLate(rec, { nowMs: now + 30 * MIN, holder: live(LIVE_PASS_MAX_MS / MIN + 1 + 30) }).text, /held its lock for \d+ minutes, longer than any pass may run/);
  assert.match(dispatcherLate(rec, { nowMs: now, holder: { live: true, takenAt: null } }).text, /an unknown time/);
  // The lock file, read as the wiring reads it.
  writeFileSync(w.f('dispatcher.lock'), JSON.stringify({ pid: process.pid, taken_at: new Date(now - 20 * MIN).toISOString() }));
  assert.deepEqual(lockHolder(w.f('dispatcher.lock')), { live: true, takenAt: now - 20 * MIN });
  writeFileSync(w.f('dispatcher.lock'), JSON.stringify({ pid: deadPid(), taken_at: 'x' }));
  assert.deepEqual(lockHolder(w.f('dispatcher.lock')), { live: false, takenAt: null });
  writeFileSync(w.f('dispatcher.lock'), 'not json');
  assert.equal(lockHolder(w.f('dispatcher.lock')), null);
  rmSync(w.f('dispatcher.lock'));
  // M5: late (no holder) → queued; the Dispatcher passes again → the late alert leaves the queue unsent.
  t = now;
  const lateQ = () => queued(rec).filter((x) => /^the Dispatcher's last full pass was/.test(x));
  await passes.heartbeat().catch(() => {});
  assert.equal(lateQ().length, 1);
  pass(t);
  await passes.heartbeat().catch(() => {});
  assert.equal(lateQ().length, 0, 'the ended stop is no longer queued');
  // Caught-up's gap counts from a pass's END: a 20-minute pass followed at once by the next is not a return; a real stop is.
  t += MIN; const start = t;
  t += 20 * MIN; pass(t, start);               // started 20 min ago, written (ended) now
  t += MIN; pass(t);
  assert.notEqual(lastReturn(rec, { nowMs: t })?.back, t, 'a slow pass is not an outage (the return found, if any, is the earlier real stop)');
  t += 20 * MIN; pass(t);
  assert.equal(lastReturn(rec, { nowMs: t })?.back, t);
});

// ---- audit #150 r1 (L613) ----

const noPorts = () => { const noop = () => [];
  return { alert: fakeAlert(), board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop, sessions: noop, probe: () => null,
    proposals: () => ({ products: [], ownerUid: 501 }),
    launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hasSession: () => true, gateAlive: () => true,
    hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop, sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }),
    startMinibase: async () => ({ ok: true }), cleanup: { copiesRoot: '/none', sealRoot: '/none', mirrorFor: () => null }, approvals: () => [] }; };

test('audit #150 M1: on stamps the real tick writes, one slow pass with no gap is no return; a real stop is', async () => {
  const w = world();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), now: () => t, log: () => {} });
  const realPass = (stepMs) => tick({ rec, rules: rulesWith(), now: t, clock: () => { t += stepMs; return t; }, ports: noPorts() });
  await realPass(1000);
  t += MIN;
  await realPass(2 * MIN);   // about 26 minutes long
  const f = rec.read('fact', LAST_PASS_FACT).doc;
  assert.ok(Date.parse(f.at) - Date.parse(f.started_at) > 15 * MIN, 'the pass ran longer than the gap limit');
  assert.equal(lastReturn(rec, { nowMs: t }), null, 'no gap, so no return');
  t += 20 * MIN;
  const back = t;
  await realPass(1000);
  const r = lastReturn(rec, { nowMs: t });
  assert.equal(r?.back, Date.parse(rec.read('fact', LAST_PASS_FACT).doc.at), 'the return is the pass after the real stop');
  assert.ok(r.back > back);
});

test('audit #150 M1: a pass with no started_at, from before it was written, is no return', async () => {
  const w = world();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), now: () => t, log: () => {} });
  const old = () => assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: new Date(t).toISOString(), steps: {} }, kind: 'full_pass' }).ok);
  old(); t += 30 * MIN; old();
  assert.equal(lastReturn(rec, { nowMs: t }), null);
});

test('audit #150 M2: a kept lock keeps the watchdog; a round that ends clean stops it', async () => {
  const dogs = []; const startDog = (ms) => { const d = { ms, stopped: 0, terminate() { d.stopped += 1; } }; dogs.push(d); return d; };
  const run = async (deliver) => { const w = world(); dogs.length = 0;
    const code = await main([w.configFile], { self: w.main, log: () => {}, watchdog: true, startDog, passDeadlineMs: 20, wireOpts: { deliver, fetchFn: fakeGitHubFetch(w.fake) } });
    return { code, lock: existsSync(w.config.lockFile) }; };
  assert.deepEqual(await run(() => new Promise(() => {})), { code: 0, lock: true });
  assert.equal(dogs.at(-1).stopped, 0, 'the lock stays, so the watchdog must');
  assert.deepEqual(await run(() => ({ sent: 0 })), { code: 0, lock: false });
  assert.equal(dogs.at(-1).stopped, 1);
});

test('audit #150 r2 Minor 2: a late round (exit 2) keeps the lock and its watchdog', async () => {
  const dogs = []; const startDog = (ms) => { const d = { ms, stopped: 0, terminate() { d.stopped += 1; } }; dogs.push(d); return d; };
  const w = world({ extra: { runDeadlineMs: 50 } });
  const code = await main([w.configFile], { self: w.main, log: () => {}, watchdog: true, startDog, passDeadlineMs: 60_000, wireOpts: { deliver: () => new Promise(() => {}), fetchFn: fakeGitHubFetch(w.fake) } });
  assert.equal(code, 2); assert.equal(existsSync(w.config.lockFile), true);
  assert.equal(dogs.length, 2, 'the config\'s own limit restarts the watchdog once');
  assert.equal(dogs[1].ms > 50, true); assert.equal(dogs[1].stopped, 0, 'the lock stays, so the watchdog must');
});

test('audit #150 Minor 3: dispatcherLockFile set to the job\'s own lockFile is refused, written two ways', async () => {
  const w = world();
  await assert.rejects(wire({ ...w.config, dispatcherLockFile: w.config.lockFile }, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), /own lockFile/);
  await assert.rejects(wire({ ...w.config, dispatcherLockFile: `${dirname(w.config.lockFile)}/./x/../${w.config.lockFile.split('/').at(-1)}` }, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), /own lockFile/);
});

test('audit #150 P26: a config with no dispatcherLockFile is refused', async () => {
  const w = world(); const { dispatcherLockFile: _, ...config } = w.config;
  await assert.rejects(wire(config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), /dispatcherLockFile/);
});

test('audit #150 P21: the wired heartbeat reads the lock file its config names: a live holder is no late alert, no holder is', async () => {
  const w = world();
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec, passes } = await wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), now: () => t, log: () => {} });
  assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: 0, doc: { at: new Date(t).toISOString(), started_at: new Date(t).toISOString(), steps: {} }, kind: 'full_pass' }).ok);
  t += 21 * MIN;
  const lateQ = () => queued(rec).filter((x) => /^the Dispatcher's last full pass was/.test(x));
  writeFileSync(w.config.dispatcherLockFile, JSON.stringify({ pid: process.pid, taken_at: new Date(t - 20 * MIN).toISOString() }));
  await passes.heartbeat().catch(() => {});
  assert.equal(lateQ().length, 0, 'a live 20-minute pass');
  rmSync(w.config.dispatcherLockFile);
  await passes.heartbeat().catch(() => {});
  assert.equal(lateQ().length, 1, 'no holder');
});

// L754 (#312 Minors): the holder read once. A round of ours that releases its lock while this one looks is still exit 0
// (before, a second read found it gone: exit 3 "no readable time"); and a lock is never seen half-written.
test('L754: a holder that releases while the round looks is still a running round of ours (exit 0); a lock appears whole', () => {
  const w = world();
  const f = lockOf(w);
  const at = Date.now();
  writeFileSync(f, JSON.stringify({ pid: process.pid, taken_at: new Date(at).toISOString() }));
  const r = takeRoundLock(f, { now: at + 1000, maxHeldMs: 60e3, state: () => { rmSync(f, { force: true }); return 'ours'; } });
  assert.deepEqual([r.ok, r.code], [false, 0], r.line);
  assert.match(r.line, /another pass runs/);
  const held = takePassLock(f, { pid: 4242, now: at });
  assert.equal(held.ok, true);
  const b = takePassLock(f, { pid: 4343, now: at, dead: () => false });
  assert.deepEqual([b.ok, b.held?.pid, b.held?.taken_at], [false, 4242, new Date(at).toISOString()], 'the holder as read is handed back');
  const st = lstatSync(f);
  assert.deepEqual([st.nlink, st.mode & 0o777], [1, 0o600], 'one name, 0600');
  assert.deepEqual(readdirSync(dirname(f)).filter((n) => n.endsWith('.new')), [], 'no file of its own is left');
  held.release();
  assert.equal(existsSync(f), false);
  // The lock path itself is never created empty and written after (a reader in between saw "unreadable"): only linked.
  const opened = []; const real = fs.openSync;
  fs.openSync = (path, ...rest) => { opened.push(String(path)); return real(path, ...rest); };
  syncBuiltinESMExports();
  try { const t = takePassLock(f, { pid: 4444, now: at }); assert.equal(t.ok, true); t.release(); }
  finally { fs.openSync = real; syncBuiltinESMExports(); }
  assert.ok(opened.length >= 1, 'the take was seen');
  assert.ok(!opened.includes(f), `the lock is linked into place, never opened to be written: ${opened.join(', ')}`);
  // A holder that releases between the refused link and the read (self-review Minor): the take tries the link again and gets
  // the lock, never "unreadable" (which was exit 3 for a round of ours).
  writeFileSync(f, JSON.stringify({ pid: 4545, taken_at: new Date(at).toISOString() }));
  const realRead = fs.readFileSync; let gone = 0;
  fs.readFileSync = (path, ...rest) => { if (String(path) === f && gone === 0) { gone += 1; rmSync(f, { force: true }); } return realRead(path, ...rest); };
  syncBuiltinESMExports();
  let again;
  try { again = takePassLock(f, { pid: 4646, now: at, dead: () => false }); } finally { fs.readFileSync = realRead; syncBuiltinESMExports(); }
  assert.equal(gone, 1, 'the release happened between the link and the read');
  assert.equal(again.ok, true, again.reason);
  again.release();
});

// ── L600 PR 1: the deliver pass and the store-free channel, through the robot App ──────────────────────────────────────

const ALERT_REPO = 'alerts-owner/alerts-repo';
const APP = Object.freeze({ appId: 12345, appInstallation: 678, alertRepo: ALERT_REPO, alertOwner: 'owner-login' });
const KEY_NAME = 'robot-app.pem';   // token.mjs's default key file name

// The robot App's key, in the key folder under token.mjs's default name, the scripts' user's own, mode 600.
let KEY_TEXT = null;
function withKey(w) {
  KEY_TEXT ??= generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(join(w.config.keyDir, KEY_NAME), KEY_TEXT, { mode: 0o600 });
  return w;
}

/**
 * GitHub for one round of the robot job: the product repository's reads (fakeGitHubFetch), the App's token request and
 * GET /app, and an issues store for the alert repository. `mintStatus` answers the token request. Every call is in `calls`.
 */
function appGitHub(w, { mintStatus = 201 } = {}) {
  const reads = fakeGitHubFetch(w.fake);
  const calls = []; const issues = new Map();
  const TOKEN = 'ghs_'.padEnd(40, 'q');
  const res = (status, json = null) => ({ status, json: async () => json });
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET'; const path = `${u.pathname}${u.search}`;
    calls.push(`${method} ${path}`);
    if (u.host !== 'api.github.com') throw new Error('no test reaches the network');
    if (path === `/app/installations/${APP.appInstallation}/access_tokens` && method === 'POST') return mintStatus === 201 ? res(201, { token: TOKEN, expires_at: '2099-01-01T00:00:00Z' }) : res(mintStatus, {});
    if (path === '/app') return res(200, { slug: 'robot' });
    const base = `/repos/${ALERT_REPO}`;
    if (!u.pathname.startsWith(base)) return reads(url, init);
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return res(401, {});
    const rest = u.pathname.slice(base.length);
    const body = init.body ? JSON.parse(init.body) : {};
    if (rest === '/issues' && method === 'GET') return res(200, [...issues.values()].filter((i) => i.state === 'open'));
    if (rest === '/issues' && method === 'POST') {
      const number = issues.size + 1;
      issues.set(number, { number, state: 'open', title: body.title, body: body.body, assignees: body.assignees, user: { login: 'robot[bot]', type: 'Bot' } });
      return res(201, { number });
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    const i = m && issues.get(Number(m[1]));
    if (!i) return res(404, {});
    if (m[2] && method === 'POST') return res(201, { created_at: new Date().toISOString() });
    if (m[2]) return res(200, []);
    if (method === 'PATCH') { Object.assign(i, body); return res(200, i); }
    return res(200, i);
  };
  return { fetchFn, calls, issues, mints: () => calls.filter((c) => c.endsWith('/access_tokens')).length,
    writesOutside: () => calls.filter((c) => !c.startsWith('GET') && !c.includes(ALERT_REPO) && !c.endsWith('/access_tokens')) };
}

test('L600 PR 1: with the robot App named, the real deliver pass sends the round\'s queued alerts as issues, with one mint', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const logs = [];
  const code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn: gh.fetchFn } });
  assert.equal(code, 0, logs.join('\n'));
  assert.doesNotMatch(logs.join('\n'), /robot: deliver (failed|ran, and)/);
  const sent = [...gh.issues.values()].map((i) => `${i.title}\n${i.body}`).join('\n---\n');
  // The passes before it that are not wired, and the Dispatcher that never ran, all reached the alert repository.
  assert.match(sent, /the Dispatcher has no full pass on record/);
  for (const p of ['gate', 'heartbeat', 'watch']) assert.match(sent, new RegExp(`the robot job's ${p} pass failed`), p);
  assert.ok([...gh.issues.values()].every((i) => i.assignees?.[0] === APP.alertOwner), 'assigned to alertOwner');
  assert.equal(gh.mints(), 1, 'one mint for the whole round');
  assert.deepEqual(gh.writesOutside(), [], 'nothing is written anywhere but the alert repository');
});

test('L600 PR 1: a refused mint fails the deliver pass, told and kept in the queue, and is not asked again that round', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w, { mintStatus: 401 });
  const logs = [];
  assert.equal(await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn: gh.fetchFn } }), 0);
  assert.match(logs.join('\n'), /robot: deliver failed: alert channel not set up: GitHub refused the token request \(401\)/);
  assert.equal(gh.mints(), 1);
  assert.equal(gh.issues.size, 0);
  const q = queued(readRecord(w));
  assert.ok(q.some((t) => /^the robot job's deliver pass failed: alert channel not set up/.test(t)), q.join(' | '));
  assert.ok(q.includes('the Dispatcher has no full pass on record: nothing is started or merged until it runs'), 'still queued, not lost');
});

test('L600 PR 1: without the App keys deliver is not wired; some but not all, or a bad value, stops the start', async () => {
  const none = world();
  const { passes } = await wire(none.config, { fetchFn: fakeGitHubFetch(none.fake), log: () => {} });
  assert.throws(() => passes.deliver(), (e) => e.message === notWiredText(NOT_WIRED_PASSES.deliver));
  assert.match(NOT_WIRED_PASSES.deliver, /appId, appInstallation, alertRepo, alertOwner/);
  for (const k of APP_KEYS) {
    const { [k]: _, ...three } = APP;
    const w = world({ extra: three });
    await assert.rejects(wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), new RegExp(`all four or none: ${k} missing`));
  }
  for (const [k, v, why] of [['appId', 'not an id!', /appId/], ['appId', true, /appId/], ['appInstallation', '0', /appInstallation/], ['appInstallation', 1.5, /appInstallation/],
    ['alertRepo', 'no-slash', /alertRepo/], ['alertRepo', 'someone/bob-the-builder', /never go to Bob/], ['alertOwner', 'bad login!', /alertOwner/]]) {
    const w = world({ extra: { ...APP, [k]: v } });
    await assert.rejects(wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), why, `${k}=${v}`);
  }
  // Through the real entry point: exit 1, the reason in the job's log.
  const { alertOwner: _o, ...three } = APP;
  const r = boot(world({ extra: three }));
  assert.equal(r.code, 1);
  assert.match(r.err, /robot: not started: config: the robot App keys go together, all four or none: alertOwner missing/);
});

test('L600 PR 1: robotToken mints on the first ask only, keeps that one answer, and never rejects', async () => {
  const c = { keyDir: '/k', ownerUid: 501, ...APP };
  // What the mint is asked is kept and checked out here: an assert inside the mint would be swallowed, since robotToken
  // never rejects. The process runs as a uid that is not the owner's, so the two cannot be swapped unseen (plant P8).
  let n = 0; let asked = null;
  const t = robotToken(c, { uid: 7001, mint: async (o) => { n += 1; asked = o; return { ok: true, token: 'x' }; } });
  assert.equal(n, 0, 'nothing is minted before it is asked for');
  const [a, b] = await Promise.all([t(), t()]);
  assert.equal(await t(), a); assert.equal(a, b);
  assert.deepEqual(a, { ok: true, token: 'x' });
  assert.equal(n, 1);
  assert.equal(asked.uid, 7001, 'the mint is asked as this process');
  assert.equal(asked.scriptsUid, 501, 'with the config\'s owner as the one who owns the key folder');
  assert.equal(asked.installationId, 678);
  let m = 0;
  const bad = robotToken(c, { mint: () => { m += 1; throw new Error('boom'); } });
  assert.deepEqual(await bad(), { ok: false, reason: 'token mint failed: boom' });
  assert.deepEqual(await bad(), { ok: false, reason: 'token mint failed: boom' });
  assert.equal(m, 1, 'a refused mint is not retried in the same process');
});

test('#288 r1 m1: a mint that throws a token-shaped message has it masked before the reason is kept', async () => {
  const c = { keyDir: '/k', ownerUid: 501, ...APP };
  const secret = `gh${'s'}_${'S'.repeat(36)}`;   // built here so no token-shaped text sits in the source
  const r = await robotToken(c, { mint: () => { throw new Error(`upstream said ${secret}`); } })();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^token mint failed: upstream said /);
  assert.equal(r.reason.includes(secret), false, 'the token-shaped text is masked');
  assert.equal(r.reason.includes('SSSSSSSS'), false, 'no part of it is left');
});

test('L587/L600 PR 1: robotChannel never throws, takes any config, and mints only when the channel is used', async () => {
  const logs = [];
  const log = (s) => logs.push(s);
  for (const c of [undefined, null, 'x', [], {}, { ownerUid: 1 }]) {
    assert.equal(robotChannel(c, { log }), null);
  }
  assert.equal(logs.length, 6);
  assert.ok(logs.every((l) => /^robot: no alert channel without the Record: /.test(l)), logs.join('\n'));
  // A config whose reads throw, and a log that throws: still null, still no throw.
  const hostile = new Proxy({}, { get() { throw new Error('read me not'); }, ownKeys() { throw new Error('no keys'); } });
  assert.equal(robotChannel(hostile, { log: () => { throw new Error('log down'); } }), null);
  const w = withKey(world({ extra: APP }));
  const { alertRepo: _r, ...three } = { ...w.config };
  logs.length = 0;
  assert.equal(robotChannel(three, { log }), null);
  assert.match(logs[0], /all four or none: alertRepo missing/);
  // The same walls as wire(): not the owner, or a key folder others can read.
  assert.equal(robotChannel(w.config, { log, uid: process.getuid() + 1 }), null);
  assert.match(logs.at(-1), /runs only as the Record's owner/);
  const open = withKey(world({ extra: APP, keyMode: 0o755 }));
  assert.equal(robotChannel(open.config, { log }), null);
  assert.match(logs.at(-1), /can be read by others/);
  // A good config: a channel, and no call to GitHub until it is used; then one mint for the look and the send.
  const gh = appGitHub(w);
  const ch = robotChannel(w.config, { log, fetchFn: gh.fetchFn });
  assert.equal(ch.owner, APP.alertOwner);
  assert.equal(gh.calls.length, 0, 'made no call');
  // Plant P6: a mint started at once runs a tick later, so the call count above cannot see it. A spy mint and one
  // turn of the event loop (every pending promise step has run by then) show it was never asked.
  let asked = 0;
  assert.ok(robotChannel(w.config, { log, fetchFn: gh.fetchFn, mint: async () => { asked += 1; return { ok: false, reason: 'spy' }; } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 0, 'building the channel asks for no mint');
  // What M13 store-stopped.mjs (lane 1, #250) does with it: look for the open issue, then open one.
  const marker = '<!-- orch:store_stopped x -->';
  assert.equal(await ch.gh.findOpen((l) => l === marker), null);
  assert.equal(await ch.gh.open({ title: 't', body: `store_layout\n\n${marker}`, assignee: ch.owner }), 1);
  assert.equal(await ch.gh.findOpen((l) => l === marker), 1);
  assert.equal(gh.mints(), 1);
  assert.equal(gh.issues.size, 1);
  assert.match(gh.issues.get(1).body, /store_layout/);
  assert.deepEqual(gh.issues.get(1).assignees, [APP.alertOwner]);
});

// L797: the Record's read never throws, so a queue it can't read came back as a corrupt row, which read as an empty
// queue: nothing was dropped and the pass answered true ("every drop written"). It must answer false and drop nothing.
test('L797: dropLateAlerts answers false and drops nothing when the alert queue cannot be read; an absent queue is true', () => {
  const real = memoryRecord();
  let failQueue = false; let writes = 0;
  const rec = makeRecord({
    read: (e, id) => { if (failQueue && e === 'fact' && id === ALERT_QUEUE_FACT) throw new Error('SQLITE_BUSY'); return real.read(e, id); },
    list: (e) => real.list(e),
    write: (w) => { writes++; return real.write(w); },
    diary: (o) => real.diary(o),
  });
  assert.equal(dropLateAlerts(rec), true, 'no queue at all: nothing to drop');
  failQueue = true;
  assert.equal(rec.read('fact', ALERT_QUEUE_FACT)?.corrupt, true, 'the real wrapper answers a corrupt row, not a throw');
  const logs = [];
  assert.equal(dropLateAlerts(rec, { log: (l) => logs.push(l) }), false);
  assert.equal(writes, 0, 'nothing written or dropped');
  // Its own line, with the Record's reason, never the drop-failed one (audit #346 m2).
  assert.deepEqual(logs, ['robot: the Dispatcher is on time, but the alert queue could not be read (record error: SQLITE_BUSY), so its old late alerts were not cleared']);
});
