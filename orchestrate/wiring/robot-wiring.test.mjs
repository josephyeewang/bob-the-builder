// robot-wiring.test.mjs — the robot job starts from its real entry point with the real wiring (R-0b-162 B; L236, L238).
// Run: node --test orchestrate/wiring/robot-wiring.test.mjs
//
// The boot test runs `node robot-main.mjs <config>` as its own process, as the job would, with the real wiring, Record,
// rules and lock. The only stand-in is GitHub (fake-github.test-helper.mjs through `node --import`). It runs in CI with
// the rest of orchestrate's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROBOT_KEY_FILE } from '../modules/M6-merge-gate/token.mjs';
import { spawnSync } from 'node:child_process';
import fs, { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installedLayout } from '../shared/job-config.test-helper.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { makeRecord, memoryRecord } from '../shared/record.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { ALERT_QUEUE_FACT, dropCause, outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { HOLD_FACT, holdAlert as holdAlertReal } from '../modules/M11-dispatcher/pass.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { wire as wireOwn, checkUser, lastReturn, dispatcherLate, dropLateAlerts, lockHolder, LIVE_PASS_MAX_MS, NOT_WIRED_PASSES, ROBOT_PASSES, APP_KEYS, pushTokenFor, robotToken, robotChannel, markToldByBeat, SENSORS_CAUSE, dropSensorsAlerts, SWEEP_CAUSES, SWEEP_MARGIN_MS, LATE_CAUSE } from './robot-wiring.mjs';
import { PUSH_NOT_WIRED } from './robot-push.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { pidDead, takePassLock } from '../modules/M11-dispatcher/pass-lock.mjs';
import { tick } from '../modules/M11-dispatcher/tick.mjs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { fakeAlert } from '../test/fake-alert.test-helper.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';
import { runPasses, CAUSE, main, NOT_QUEUED, LOCK_REFUSED, pidState, takeRoundLock, PASS_DEADLINE_MS } from './robot-main.mjs';
// wire as robot-main's main calls it: with the pass limit handed in (#465 r2 M1). A test that leaves it out says so.
const wire = (config, opts = {}) => wireOwn(config, { passDeadlineMs: PASS_DEADLINE_MS, ...opts });
import { fakeIssues, makeAlerts } from '../modules/M13-ledger/alerts.mjs';
import { notWiredText } from './dispatcher-wiring.mjs';
import { UNSENT, readUnsent } from '../modules/M9-record/unsent.mjs';
import { holdAlert } from '../modules/M11-dispatcher/pass.mjs';
import { fakeGitHubFetch, blobOf } from './fake-github.test-helper.mjs';
import { sensorsPass } from '../modules/M12-sensors/loop.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { miniCheck } from '../modules/M1-front-door/trip.mjs';

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

test('L587: a store that won\'t open is told once per reason through the channel, and the job still exits 1', async () => {
  const w = world();
  assert.equal(boot(w).code, 0);
  const diary = join(w.config.recordRoot, 'diary.jsonl');
  rmSync(diary);
  mkdirSync(diary);
  const gh = fakeIssues();
  const run = async (stopChannel) => {
    const logs = [];
    const code = await main([w.configFile], { self: w.main, log: (s) => logs.push(s), wireOpts: stopChannel ? { stopChannel } : {} });
    return { code, logs: logs.join('\n') };
  };
  const first = await run({ gh, owner: 'owner-login' });
  assert.equal(first.code, 1);
  assert.match(first.logs, /robot: not started: .*diary\.jsonl/);
  assert.equal(gh.issues.size, 1);
  assert.match(gh.issues.get(1).body, /store_layout/);
  assert.equal((await run({ gh, owner: 'owner-login' })).code, 1);
  assert.equal(gh.issues.size, 1, 'the next start finds the open issue');
  const bare = await run(null);
  assert.equal(bare.code, 1);
  assert.match(bare.logs, /could not be told: .*R-0b-02/);
});

// L724, L732 m2: a recovery that stops writes does not stop the start (a store write never throws), so the round runs and
// the store keeps its line for the deliver pass. The start's stop path, and its issue, is only for a store that won't open.
// Opening the store sets tmp/ back to 755 and recovers once, so this happens after the open, just before the round's first
// write (the heartbeat's held alert): a torn diary line, as a writer killed mid-append leaves, makes that write recover
// again, and the recovery stops at tmp/, which it may not list.
test('L724: a Record whose recovery stopped still starts the round, keeps one line, and the stop path opens no issue', async () => {
  const w = world();
  assert.equal(boot(w).code, 0);
  const tmp = join(w.config.recordRoot, 'tmp');
  const gh = fakeIssues();
  const logs = [];
  let shut = 0;
  const hold = (args) => { appendFileSync(join(w.config.recordRoot, 'diary.jsonl'), '{"torn'); chmodSync(tmp, 0o000); shut++; return holdAlert(args); };
  try {
    const code = await main([w.configFile], { self: w.main, log: (s) => logs.push(s), wireOpts: { hold, stopChannel: { gh, owner: 'owner-login' } } });
    assert.equal(shut, 1, 'the round reached its first write');
    assert.notEqual(code, 1, logs.join('\n'));
    assert.doesNotMatch(logs.join('\n'), /robot: not started/);
    assert.match(logs.join('\n'), /the Dispatcher-late alert could not be queued/, 'the write was refused: recovery really stopped');
    const kept = readUnsent(w.config.recordRoot).filter((x) => x.event.type === 'recovery_stopped');
    assert.equal(kept.length, 1, 'one line kept for the deliver pass');
    assert.match(readFileSync(join(w.config.recordRoot, UNSENT), 'utf8'), /"cap_key":"recovery_stopped:EACCES:tmp"/, 'kept under the fault\'s stable key');
    assert.equal(gh.issues.size, 0, 'the start\'s stop path is not used for it');
  } finally { chmodSync(tmp, 0o755); }
});

test('L587: a start that fails for any other reason is not told as a stopped Record', async () => {
  const w = world({ keyMode: 0o755 });
  const gh = fakeIssues();
  const logs = [];
  assert.equal(await main([w.configFile], { self: w.main, log: (s) => logs.push(s), wireOpts: { stopChannel: { gh, owner: 'owner-login' } } }), 1);
  assert.equal(gh.issues.size, 0);
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
  // Deliver is after every pass but push, which is last so a slow push never holds up the round's alerts (L1115).
  assert.deepEqual(ROBOT_PASSES.slice(-2), ['deliver', 'push']);
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
  // #465 r2 review m2: what the pass itself said (the sweep's tell) is kept, and the refusal added after it.
  const told = Object.fromEntries(ROBOT_PASSES.map((p) => [p, () => { if (p === 'gate') throw Object.assign(new Error('boom'), { tell: 'the sweep was not run' }); return {}; }]));
  r = await runPasses({ rec, passes: told, now: () => Date.now(), hold: () => false });
  assert.equal(r.gate.tell, `the sweep was not run; ${NOT_QUEUED}`);
  r = await runPasses({ rec, passes: told, now: () => Date.now(), hold: () => { throw new Error('the queue is damaged'); } });
  assert.equal(r.gate.tell, 'the sweep was not run; the queue is damaged');
  assert.equal(r.gate.untold, true, 'a queue that threw: the failure itself was not told (#465 r2 audit c2)');
  // Already told today (null) is not a refusal.
  r = await runPasses({ rec, passes, now: () => Date.now(), hold: () => null });
  assert.equal(r.gate.tell, undefined);
  // #465 r2 audit c2: a pass's own tell beside a failure alert that was queued is not "could not be told".
  r = await runPasses({ rec, passes: told, now: () => Date.now(), hold: () => true });
  assert.deepEqual([r.gate.tell, r.gate.untold], ['the sweep was not run', undefined]);
  r = await runPasses({ rec, passes: told, now: () => Date.now(), hold: () => false });
  assert.equal(r.gate.untold, true);
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

test('L771 Minor 1: two takers over one dead lock: only one breaks it and holds; the other never deletes a live lock', () => {
  const w = world();
  const f = lockOf(w);
  const at = Date.now();
  const DEAD = { pid: 999, taken_at: new Date(at - 60e3).toISOString() };
  const isDead = (p) => p === DEAD.pid;
  const leftover = () => readdirSync(dirname(f)).filter((n) => n.endsWith('.dead') || n.endsWith('.new'));
  // B has read the dead lock and judged it dead; before B acts, A takes the whole lock (breaks the dead one, links its own).
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  let a = null;
  const b = takePassLock(f, { pid: 5002, now: at, dead: (p) => { a ??= takePassLock(f, { pid: 5001, now: at, dead: isDead }); return isDead(p); } });
  assert.deepEqual([a?.ok, a?.broke?.pid], [true, DEAD.pid], 'A broke the dead lock and holds');
  assert.deepEqual([b.ok, b.held?.pid], [false, 5001], `B refuses, naming A: ${b.reason}`);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, 5001, 'A\'s lock is in place, never deleted by B');
  assert.deepEqual(leftover(), [], 'no moved or own file is left');
  a.release();
  assert.equal(existsSync(f), false);
  // A judged it dead; B moved it first and has not linked yet: A finds the move missing, tries the link again and holds;
  // B's link then finds A's live lock and refuses.
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  const bMoved = `${f}.5002.dead`;
  const a2 = takePassLock(f, { pid: 5001, now: at, dead: (p) => { if (existsSync(f)) renameSync(f, bMoved); return isDead(p); } });
  assert.equal(a2.ok, true, a2.reason);
  rmSync(bMoved, { force: true });
  const b2 = takePassLock(f, { pid: 5002, now: at, dead: isDead });
  assert.deepEqual([b2.ok, b2.held?.pid], [false, 5001], b2.reason);
  assert.deepEqual(leftover(), []);
  a2.release();
  // The round's own take: it loses the same race and puts the other's lock back; that holder is a live round of ours, so the
  // round exits 0 (another round runs), never 3 (self-review Minor 1).
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  let a3 = null;
  const r = takeRoundLock(f, { now: at, maxHeldMs: 60e3, state: (p) => { a3 ??= takePassLock(f, { pid: 5001, now: at, dead: isDead }); return isDead(p) ? 'dead' : 'ours'; } });
  assert.equal(a3?.ok, true);
  assert.deepEqual([r.ok, r.code], [false, 0], r.line);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, 5001);
  a3.release();
  // L785 M1: in order (b) the taker that holds tells the broken dead lock (above: a2). Re-run it and check `broke`.
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  const a4 = takePassLock(f, { pid: 5001, now: at, dead: (p) => { if (existsSync(f)) renameSync(f, bMoved); return isDead(p); } });
  rmSync(bMoved, { force: true });
  assert.deepEqual([a4.ok, a4.broke?.pid, a4.broke?.taken_at], [true, DEAD.pid, DEAD.taken_at], 'the holder tells the dead lock another taker broke');
  a4.release();
  // L785 m2: the re-check compares taken_at too. The dead pid is in a lock taken again (a reused pid, a new time) between the
  // judgment and the move: that lock is put back, never deleted.
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  const again = { pid: DEAD.pid, taken_at: new Date(at).toISOString() };
  const r2 = takePassLock(f, { pid: 5002, now: at, dead: (p) => { writeFileSync(f, JSON.stringify(again), { mode: 0o600 }); return isDead(p); } });
  assert.equal(r2.ok, false, 'refused');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), again, 'the lock taken again is put back');
  assert.deepEqual(leftover(), []);
  rmSync(f, { force: true });
});

// L800 M-A (audit #336 r2 probe Q2): B breaks the dead lock D; before B links again, A (which never saw D) finds the place
// empty and links; B's link then finds A and refuses. A has nothing to tell, so B's refusal must carry the break.
test('L800 M-A: a taker that broke a dead lock and then lost the place to a late taker still carries `broke`', () => {
  const w = world();
  const f = lockOf(w);
  const at = Date.now();
  const DEAD = { pid: 999, taken_at: new Date(at - 60e3).toISOString() };
  const isDead = (p) => p === DEAD.pid;
  const lateTaker = (pid) => {
    // At B's re-read of its moved file the place is empty: A arrives then and links.
    let a = null; const orig = fs.readFileSync;
    fs.readFileSync = function (p, ...r) { if (String(p).endsWith(`.${pid}.dead`) && !a) a = takePassLock(f, { pid: 5001, now: at, dead: isDead }); return orig.call(this, p, ...r); };
    syncBuiltinESMExports();
    return { get a() { return a; }, undo() { fs.readFileSync = orig; syncBuiltinESMExports(); } };
  };
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  let late = lateTaker(5002); let b;
  try { b = takePassLock(f, { pid: 5002, now: at, dead: isDead }); } finally { late.undo(); }
  assert.deepEqual([late.a?.ok, late.a?.broke], [true, null], 'A holds and never saw D');
  assert.equal(b.ok, false, b.reason);
  assert.deepEqual([b.broke?.pid, b.broke?.taken_at], [DEAD.pid, DEAD.taken_at], 'the refusal carries the break');
  late.a.release();
  // The round's own take passes it through, as LOCK_REFUSED or code 0.
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  late = lateTaker(process.pid); let r;
  try { r = takeRoundLock(f, { now: at, maxHeldMs: 60e3, state: (p) => (isDead(p) ? 'dead' : 'ours') }); } finally { late.undo(); }
  assert.equal(late.a?.ok, true);
  assert.deepEqual([r.ok, r.broke?.pid], [false, DEAD.pid], r.line);
  late.a.release();
  // L816 m-1: the generic LOCK_REFUSED refusal carries it too: here the late holder is a process that is not this user's.
  writeFileSync(f, JSON.stringify(DEAD), { mode: 0o600 });
  late = lateTaker(process.pid);
  try { r = takeRoundLock(f, { now: at, maxHeldMs: 60e3, state: (p) => (isDead(p) ? 'dead' : 'foreign') }); } finally { late.undo(); }
  assert.equal(late.a?.ok, true);
  assert.deepEqual([r.ok, r.code, r.broke?.pid], [false, LOCK_REFUSED, DEAD.pid], r.line);
  late.a.release();
  // A refusal with no break carries none.
  writeFileSync(f, JSON.stringify({ pid: 5001, taken_at: new Date(at).toISOString() }), { mode: 0o600 });
  const plain = takePassLock(f, { pid: 5002, now: at, dead: isDead });
  assert.deepEqual([plain.ok, 'broke' in plain], [false, false]);
  rmSync(f, { force: true });
});

// L785 m1: a round whose take moved a live lock and could not put it back (two rounds may run) tells Joe, once a day.
test('L785 m1: robot-main tells a moved, not-put-back live lock through the held alert', async () => {
  const w = world();
  const f = lockOf(w);
  writeFileSync(f, JSON.stringify({ pid: deadPid(), taken_at: 'T-dead' }), { mode: 0o600 });
  // At the take's move: another taker has just broken the dead lock and linked its own (A), and a third (C) links into the
  // place as soon as A's lock is moved out, so the put-back finds C there.
  const realRename = fs.renameSync; let moves = 0;
  fs.renameSync = (src, dst, ...rest) => {
    if (String(src) === f && String(dst).endsWith('.dead') && moves === 0) {
      moves += 1;
      writeFileSync(f, JSON.stringify({ pid: process.pid, taken_at: new Date().toISOString() }));
      realRename(src, dst, ...rest);
      writeFileSync(f, JSON.stringify({ pid: process.pid, taken_at: new Date(Date.now() + 1).toISOString() }));
      return;
    }
    return realRename(src, dst, ...rest);
  };
  syncBuiltinESMExports();
  const logs = []; let code;
  try { code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { deliver: () => ({ sent: 0 }), fetchFn: fakeGitHubFetch(w.fake) } }); }
  finally { fs.renameSync = realRename; syncBuiltinESMExports(); }
  assert.equal(moves, 1, 'the take moved a lock');
  assert.equal(code, 3, logs.join('\n'));
  assert.ok(queued(readRecord(w)).some((t) => /two robot job rounds may be running at once/.test(t)), JSON.stringify(queued(readRecord(w))));
  // L800 m-1: under its own cause, never the late-round one, so a late tell already held that day can't silence it.
  const entries = readRecord(w).read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
  assert.equal(entries.find((e) => /two robot job rounds may be running at once/.test(e.text))?.mark?.fact, HOLD_FACT('robot-lock-moved'), JSON.stringify(entries));
});

// L800 M-A: the round broke the dead lock, then a late round of ours linked into the place: this round exits 0 (another round
// runs) and still tells the stopped round, as the holder never saw it.
test('L800 M-A: robot-main tells a dead lock it broke even when a late round took the place', async () => {
  const w = world();
  const f = lockOf(w);
  writeFileSync(f, JSON.stringify({ pid: deadPid(), taken_at: 'T-dead' }), { mode: 0o600 });
  let late = null; const orig = fs.readFileSync;
  fs.readFileSync = function (p, ...r) {
    if (String(p).startsWith(`${f}.`) && String(p).endsWith('.dead') && !late) late = takePassLock(f, { pid: process.pid, dead: () => false });
    return orig.call(this, p, ...r);
  };
  syncBuiltinESMExports();
  const logs = []; let code;
  try { code = await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { deliver: () => ({ sent: 0 }), fetchFn: fakeGitHubFetch(w.fake) } }); }
  finally { fs.readFileSync = orig; syncBuiltinESMExports(); }
  assert.equal(late?.ok, true, 'the late round holds');
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(queued(readRecord(w)).some((t) => /the last robot job round \(taken T-dead\) was stopped before it finished; another round holds the lock now/.test(t)), JSON.stringify(queued(readRecord(w))));
  // L816 m-2: under the holder's own cause, so a holder and a refuser that both carry the break tell it once that day.
  const entries = readRecord(w).read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
  assert.equal(entries.find((e) => /another round holds the lock now/.test(e.text))?.mark?.fact, HOLD_FACT('robot-run-late'), JSON.stringify(entries));
  late.release();
});

// ── L600 PR 1: the deliver pass and the store-free channel, through the robot App ──────────────────────────────────────

const ALERT_REPO = 'alerts-owner/alerts-repo';
const APP = Object.freeze({ appId: 12345, appInstallation: 678, alertRepo: ALERT_REPO, alertOwner: 'owner-login' });
const KEY_NAME = ROBOT_KEY_FILE;   // token.mjs's default key file name (L734: imported, not copied)

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
  // The passes before it that are not wired reached the alert repository; the Dispatcher that never ran, through the
  // heartbeat's own alert (L600 PR 2).
  assert.match(sent, /heartbeat red: dispatcher/);
  for (const p of ['gate', 'watch']) assert.match(sent, new RegExp(`the robot job's ${p} pass failed`), p);
  assert.doesNotMatch(sent, /the robot job's heartbeat pass failed/);
  assert.ok([...gh.issues.values()].every((i) => i.assignees?.[0] === APP.alertOwner), 'assigned to alertOwner');
  assert.equal(gh.mints(), 1, 'one mint for the whole round');
  assert.deepEqual(gh.writesOutside(), [], 'nothing is written anywhere but the alert repository');
});

// L727: a store that won't open is told through the robot App's own channel, with nothing injected.
test('L727: with the robot App named, a stopped store is told through robotChannel, once, in the alert repository', async () => {
  const w = withKey(world({ extra: APP }));
  assert.equal(boot(w).code, 0);
  const diary = join(w.config.recordRoot, 'diary.jsonl');
  rmSync(diary);
  mkdirSync(diary);
  const gh = appGitHub(w);
  for (let i = 0; i < 2; i++) {
    const logs = [];
    assert.equal(await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn: gh.fetchFn } }), 1, logs.join('\n'));
  }
  const stops = [...gh.issues.values()].filter((i) => /Record has stopped: store_layout/.test(i.title));
  assert.equal(stops.length, 1, 'the second start finds the open issue');
  assert.equal(stops[0].assignees?.[0], APP.alertOwner);
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

test('L1115: the push pass refuses until every part is there; some outside check keys, or a bad one, stop the start', async () => {
  const OUTSIDE = { outsideRepo: 'owner-x/outside', outsideWorkflow: '.github/workflows/outside-check.yml', outsideSlot: 'product 1', outsideTag: 'abcd1234' };
  // No App: the push says so.
  const none = world();
  const a = await wire(none.config, { fetchFn: fakeGitHubFetch(none.fake), log: () => {} });
  assert.throws(() => a.passes.push(), (e) => e.message === notWiredText(NOT_WIRED_PASSES.push));
  // The App and the outside check named, no owner's Mac user id: the push says so (#536 r1 m3).
  const noOwner = world({ extra: { ...APP, ...OUTSIDE } });
  const n = await wire(noOwner.config, { fetchFn: fakeGitHubFetch(noOwner.fake), log: () => {} });
  assert.throws(() => n.passes.push(), (e) => e.message === notWiredText(PUSH_NOT_WIRED.owner));
  // A hostLockUid that is root's or this job's own user: the job does not start (the Dispatcher's own check).
  for (const uid of [0, process.getuid()]) {
    const w = world({ extra: { ...APP, ...OUTSIDE, hostLockUid: uid } });
    await assert.rejects(wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), /config: hostLockUid is/);
  }
  // With it too: the next missing part is the scanner's paths (lane 4, #525), still refusing.
  const both = world({ extra: { ...APP, ...OUTSIDE, hostLockUid: process.getuid() + 2 } });
  const b = await wire(both.config, { fetchFn: fakeGitHubFetch(both.fake), log: () => {} });
  assert.throws(() => b.passes.push(), /not wired yet: robot\.push: the secret scanner's paths are not wired/);
  // Some but not all, or a bad value: the job does not start.
  for (const k of Object.keys(OUTSIDE)) {
    const { [k]: _, ...three } = OUTSIDE;
    const w = world({ extra: three });
    await assert.rejects(wire(w.config, { fetchFn: fakeGitHubFetch(w.fake), log: () => {} }), new RegExp(`config: the outside check keys go together, all four or none: ${k} missing`));
  }
  const bad = world({ extra: { ...OUTSIDE, outsideSlot: 'slot one' } });
  await assert.rejects(wire(bad.config, { fetchFn: fakeGitHubFetch(bad.fake), log: () => {} }), /config: outsideSlot must be/);
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

// ── L600 PR 2: the heartbeat pass, through the robot App, reading the Sensors' facts from the Record (L604) ─────────────

const pinnedOf = (gh) => [...gh.issues.values()].find((i) => /mini_alive_at:/.test(i.body ?? ''));
const isoAt = (ms) => new Date(ms).toISOString();

test('L600 PR 2: with the robot App the heartbeat runs: its pinned issue in the alert repository; with no Sensors, not known, never signed out', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const logs = [];
  assert.equal(await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn: gh.fetchFn } }), 0, logs.join('\n'));
  assert.doesNotMatch(logs.join('\n'), /robot: heartbeat failed/);
  const pinned = pinnedOf(gh);
  assert.ok(pinned, 'the pinned heartbeat issue is in the alert repository');
  assert.match(pinned.body, /Front Door reachable from the phone: unknown/);
  assert.match(pinned.body, /signed-in account: unknown/);
  assert.match(pinned.body, /M10 Rules usable: yes/);
  const rec = readRecord(w);
  assert.ok(!rec.list('fact').some((x) => x.id.startsWith('signed-out-') && x.doc?.signed_out === true), 'not known is never signed out');
  assert.equal(gh.mints(), 1, 'the heartbeat and deliver share the round\'s one mint');
  assert.deepEqual(gh.writesOutside(), [], 'nothing is written anywhere but the alert repository');
});

test('L604 PR 2 (L730 M1): a current Sensors reading is told; signed out only when the reading says so; an empty account and an old one are not known', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let t = Date.parse('2026-11-03T10:00:00Z');
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => t, log: () => {} });
  const sense = (id, doc) => { const r = rec.write({ actor: 'sensors', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc }); assert.ok(r.ok, `${id}: ${r.reason}`); };
  const dispatcherPass = () => assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: isoAt(t), started_at: isoAt(t), steps: {} }, kind: 'full_pass' }).ok);
  dispatcherPass();
  sense('signed-in-account', { account: 'b', observed_at: isoAt(t) });
  sense('frontdoor-reachable', { value: true, observed_at: isoAt(t) });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /signed-in account: b/);
  assert.match(pinnedOf(gh).body, /Front Door reachable from the phone: yes/);
  // Reversed in L730 (#289 r1 M1): a current empty account is not "nobody". It may be a read that failed, so it is not
  // known: no signed-out fact, no alert.
  t += MIN; dispatcherPass();
  sense('signed-in-account', { account: null, observed_at: isoAt(t) });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /signed-in account: unknown/);
  assert.equal(rec.read('fact', `signed-out-${P.replace(/[^A-Za-z0-9_-]/g, '-')}`)?.doc?.signed_out, undefined);
  assert.ok(![...gh.issues.values()].some((i) => /heartbeat red: signed-out/.test(i.title)), 'no signed-out alert');
  // A current reading that says nobody is signed in, in so many words: the signed-out fact, and its alert.
  t += MIN; dispatcherPass();
  sense('signed-in-account', { account: null, signed_in: false, reason: 'nobody is signed in', observed_at: isoAt(t) });
  await passes.heartbeat();
  assert.equal(rec.read('fact', `signed-out-${P.replace(/[^A-Za-z0-9_-]/g, '-')}`)?.doc?.signed_out, true);
  assert.ok([...gh.issues.values()].some((i) => /heartbeat red: signed-out/.test(i.title)), 'the signed-out alert is raised');
  // An hour on, both readings are past their age limits: not known, and the signed-out fact is not moved.
  t += 60 * MIN; dispatcherPass();
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /signed-in account: unknown/);
  assert.match(pinnedOf(gh).body, /Front Door reachable from the phone: unknown/);
  assert.equal(rec.read('fact', `signed-out-${P.replace(/[^A-Za-z0-9_-]/g, '-')}`)?.doc?.signed_out, true);
  assert.equal(gh.mints(), 1, 'one mint for the process');
});

test('L600 PR 2 (L239): with the robot App a late Dispatcher is told by the heartbeat\'s own alert, and not queued a second time', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const logs = [];
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, log: (l) => logs.push(l) });
  await passes.heartbeat();
  assert.ok([...gh.issues.values()].some((i) => /heartbeat red: dispatcher/.test(i.title)), 'the heartbeat raised the Dispatcher alert');
  assert.match(logs.join('\n'), /robot: alert: the Dispatcher has no full pass on record/);
  assert.ok(!queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), queued(rec).join(' | '));
});

test('L600 PR 2 (L239): with the robot App, a Dispatcher alert GitHub refuses is queued instead, so Joe is still told', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // GitHub refuses every new alert issue; the pinned heartbeat issue and its comments still go through, so the beat
  // ends and reports the alert as not told (plant H5: the fallback skipped).
  const alertPost = (init) => { try { return init.method === 'POST' && /heartbeat red/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (alertPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {} });
  const out = await passes.heartbeat();
  assert.ok(out.red.includes('alert-not-told'), JSON.stringify(out));
  assert.ok(![...gh.issues.values()].some((i) => /heartbeat red: dispatcher/.test(i.title)), 'GitHub took no Dispatcher alert');
  assert.ok(queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'the late alert is queued for deliver');
});

// ── L730 (#289 r1): the audit's probes A-E, as tests ─────────────────────────────────────────────────────────────────

const T730 = Date.parse('2026-11-03T10:00:00Z');
const dPass = (rec, at) => assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
  doc: { at: isoAt(at), started_at: isoAt(at), steps: {} }, kind: 'full_pass' }).ok);
const sensed = (rec, id, doc) => { const r = rec.write({ actor: 'sensors', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc }); assert.ok(r.ok, `${id}: ${r.reason}`); };

test('L730 m1 (probe A): a heartbeat that hangs on GitHub past the pass deadline still leaves the late Dispatcher queued', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const fetchFn = (url, init = {}) => (new URL(url).pathname.startsWith(`/repos/${ALERT_REPO}`) ? new Promise(() => {}) : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {} });
  await runPasses({ rec, passes, now: () => Date.now(), passDeadlineMs: 1500 });
  const q = queued(rec);
  assert.ok(q.some((t) => /heartbeat pass failed: it did not finish/.test(t)), q.join(' | '));
  assert.ok(q.some((t) => /the Dispatcher has no full pass on record/.test(t)), 'queued before any GitHub call');
});

test('L730 M2 (probe B): usage not known, everything else current: not known, never all green', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => T730, log: () => {} });
  dPass(rec, T730);
  sensed(rec, 'signed-in-account', { account: 'a', observed_at: isoAt(T730) });
  sensed(rec, 'frontdoor-reachable', { value: true, observed_at: isoAt(T730) });
  await passes.heartbeat();
  const body = pinnedOf(gh).body;
  assert.doesNotMatch(body, /All green/);
  assert.doesNotMatch(body, /ok {4}usage/);
  assert.match(body, /not known: usage/);
});

test('L730 M1 (probe C): a Sensors account read that fails is not known: no signed-out fact, no alert, and the trip check is not NO', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => T730, log: () => {} });
  dPass(rec, T730);
  const sp = await sensorsPass({ rec, now: () => new Date(T730), ports: { whoIsSignedIn: async () => { throw new Error('claude auth status timed out'); },
    probes: { reachable: async () => true } } });
  assert.equal(sp.wrote['signed-in-account'].unknown, true, 'Sensors itself calls it unknown');
  await passes.heartbeat();
  assert.equal(rec.read('fact', `signed-out-${P.replace(/[^A-Za-z0-9_-]/g, '-')}`)?.doc?.signed_out, undefined);
  assert.ok(![...gh.issues.values()].some((i) => /heartbeat red: signed-out/.test(i.title)), 'no signed-out alert');
  assert.match(pinnedOf(gh).body, /signed-in account: unknown/);
  const trip = miniCheck({ facts: makeFactWriter(rec, { actor: 'ledger' }), heartbeatProduct: P, now: () => new Date(T730) });
  assert.notEqual(trip.items[1].state, 'red', JSON.stringify(trip.items[1]));
});

test('L730 m2 (probe D): a live Dispatcher pass inside its run limit is on time for the heartbeat too: no "dispatcher" red', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  writeFileSync(w.config.dispatcherLockFile, JSON.stringify({ pid: process.pid, taken_at: isoAt(T730 - 18 * MIN) }));
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => T730, log: () => {} });
  dPass(rec, T730 - 20 * MIN);
  assert.equal(dispatcherLate(rec, { nowMs: T730, holder: lockHolder(w.config.dispatcherLockFile) }), null);
  const out = await passes.heartbeat();
  assert.ok(!out.red.includes('dispatcher'), JSON.stringify(out.red));
  assert.ok(![...gh.issues.values()].some((i) => /heartbeat red: dispatcher/.test(i.title)));
  // #137 M6 stays fixed: the same pass stuck past its limit is late, in both.
  writeFileSync(w.config.dispatcherLockFile, JSON.stringify({ pid: process.pid, taken_at: isoAt(T730 - LIVE_PASS_MAX_MS - MIN) }));
  assert.ok((await passes.heartbeat()).red.includes('dispatcher'));
});

test('L730 m3 (probe E): Joe closes the Dispatcher alert while it still holds: the next day it is told again, through the queue', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let t = T730;
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => t, log: () => {} });
  await passes.heartbeat();
  const issue = [...gh.issues.values()].find((i) => /heartbeat red: dispatcher/.test(i.title));
  assert.ok(issue);
  assert.ok(!queued(rec).some((q) => /Dispatcher/.test(q)), 'told by the heartbeat: not queued too');
  Object.assign(issue, { state: 'closed', closed_by: { type: 'User', login: 'owner-login' } });
  t += 25 * 60 * MIN;
  await passes.heartbeat();
  assert.ok(queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'closed while it lasts: told again, once a day');
  // The same day again: holdAlert's once a day, not every pass (the copy already waiting is the one told).
  t += 10 * MIN;
  await passes.heartbeat();
  assert.equal(queued(rec).filter((q) => /the Dispatcher has no full pass on record/.test(q)).length, 1);
});

test('L730 m4: one alert GitHub lost does not make the Dispatcher alert not told', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // Only the front-door alert is refused; the Dispatcher alert goes through.
  const fdPost = (init) => { try { return init.method === 'POST' && /heartbeat red: front-door/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (fdPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, now: () => T730, log: () => {} });
  sensed(rec, 'frontdoor-reachable', { value: false, observed_at: isoAt(T730) });
  const out = await passes.heartbeat();
  assert.ok(out.red.includes('alert-not-told'), JSON.stringify(out));
  assert.ok([...gh.issues.values()].some((i) => /heartbeat red: dispatcher/.test(i.title)));
  assert.ok(!queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'told by its own alert: not queued too');
});

// L746 m-B (probe R2-289-A): the heartbeat's own tell marks the hold told, so Joe closing that issue during a lasting stop
// is answered the next day (the daily repeat, L730 m3), not by a new issue a minute later.
test('L746 m-B: Joe closes the heartbeat Dispatcher alert; the next round tells nothing new; a day later it is told again', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let t = T730;
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => t, log: () => {} });
  const open = () => [...gh.issues.values()].filter((i) => i.state === 'open' && !/mini_alive_at:/.test(i.body ?? ''));
  await passes.heartbeat(); await passes.deliver();
  const issue = [...gh.issues.values()].find((i) => /heartbeat red: dispatcher/.test(i.title));
  assert.ok(issue, 'round 1 opens the heartbeat issue');
  assert.deepEqual(queued(rec), [], 'and the queued copy is dropped');
  Object.assign(issue, { state: 'closed', closed_by: { type: 'User', login: 'owner-login' } });
  const n = gh.issues.size;
  for (let i = 0; i < 3; i += 1) { t += MIN; await passes.heartbeat(); await passes.deliver(); }
  assert.ok(!queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'told within the day: nothing queued');
  assert.equal(gh.issues.size, n, 'no new issue in the minutes after Joe closed it');
  assert.deepEqual(open().map((i) => i.title), [], 'nothing open');
  t += 24 * 60 * MIN; await passes.heartbeat(); await passes.deliver();
  assert.ok(open().length >= 1, 'a day later the lasting stop is told again');
});

// L738 self-review of m-B: when the queue refused the alert there is no queued copy, so the heartbeat's tell is marked as
// holdAlert would mark it, only when the hold was due; one already told today keeps its time.
test('L746 m-B: with no queued copy the heartbeat tell still marks the hold, once a day, never resetting the count', async () => {
  const w = world();
  const { rec } = await wire(w.config, { now: () => T730, log: () => {} });
  const cause = 'robot-dispatcher-late-test';
  assert.equal(markToldByBeat(rec, { cause, text: 'late', now: T730 }), true);
  assert.equal(Date.parse(rec.read('fact', HOLD_FACT(cause))?.doc?.told_at), T730, 'the hold is marked told by the heartbeat');
  assert.equal(markToldByBeat(rec, { cause, text: 'late', now: T730 + MIN }), true);
  assert.equal(Date.parse(rec.read('fact', HOLD_FACT(cause))?.doc?.told_at), T730, 'told a minute ago: its time is kept, so the daily repeat still comes');
  assert.equal(markToldByBeat(rec, { cause, text: 'late', now: T730 + 25 * 60 * MIN }), true);
  assert.equal(Date.parse(rec.read('fact', HOLD_FACT(cause))?.doc?.told_at), T730 + 25 * 60 * MIN, 'a day on, the new tell is marked');
  assert.equal(markToldByBeat({ read: () => { throw new Error('x'); } }, { cause, text: 'late', now: T730 }), false, 'never throws');
});

// L781 (the fold of #289, L955): a hold fact that cannot be read is "not known", not "absent", so the mark never writes a
// fresh hold over it (that would lose its daily count and its first-told time).
test('L955: markToldByBeat writes nothing over a hold fact whose read failed, and says so', async () => {
  const w = world();
  const { rec } = await wire(w.config, { now: () => T730, log: () => {} });
  const cause = 'robot-dispatcher-late-unreadable'; const fact = HOLD_FACT(cause);
  const writes = [];
  // A plain wrapper (the Record is frozen, so a Proxy that swaps read would throw, and the catch would hide the case).
  const broken = { ...rec,
    read: (e, id) => (e === 'fact' && id === fact ? { id, entity: e, corrupt: true, reason: 'bad bytes' } : rec.read(e, id)),
    write: (...a) => { writes.push(a); return rec.write(...a); } };
  assert.equal(markToldByBeat(broken, { cause, text: 'late', now: T730 }), false);
  assert.deepEqual(writes.filter(([o]) => o?.id === fact), [], 'nothing written to the unreadable hold');
});

// L955 plants P7 and P9 (the fold of #289): the rules line and a heartbeat that fails.
test('L955: rules that could not be read and adopted are "M10 Rules usable: no" on the heartbeat, never yes', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // Every read of the product's repository fails, so no rules are adopted; the alert repository and the mint still work.
  const fetchFn = (url, init = {}) => { const path = new URL(url).pathname;
    return path.startsWith('/repos/') && !path.startsWith(`/repos/${ALERT_REPO}`) ? Promise.resolve({ status: 500, json: async () => ({}) }) : gh.fetchFn(url, init); };
  const { passes } = await wire(w.config, { fetchFn, log: () => {} });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /M10 Rules usable: no/);
});

test('L955: a heartbeat that fails makes the pass fail with its reason, and the late Dispatcher stays queued', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const fetchFn = (url, init = {}) => (new URL(url).pathname.startsWith(`/repos/${ALERT_REPO}`) ? Promise.reject(new Error('alert repository unreachable')) : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {} });
  await assert.rejects(passes.heartbeat(), (e) => { assert.match(e.message, /alert repository unreachable/); return true; });
  assert.ok(queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'the late alert is still queued for deliver');
});

test('L738 review m1: a late alert the queue refused and the heartbeat did not tell fails the pass with the tell', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const alertPost = (init) => { try { return init.method === 'POST' && /heartbeat red/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (alertPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, hold: () => false, log: () => {} });
  await assert.rejects(passes.heartbeat(), (e) => { assert.match(e.message, /neither queued nor told/); assert.equal(e.tell, 'the Dispatcher-late alert could not be queued'); return true; });
  assert.ok(!queued(rec).some((q) => /Dispatcher/.test(q)), 'the queue really refused it');
  // Told by the heartbeat: the refused queue alone does not fail the pass.
  const w2 = withKey(world({ extra: APP }));
  const told = await wire(w2.config, { fetchFn: appGitHub(w2).fetchFn, hold: () => false, log: () => {} });
  await told.passes.heartbeat();
});

test('#451 r1 m1: a pinned issue GitHub will not open, or will not edit, fails the heartbeat pass', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let refuse = 'open';
  const isPinned = (init) => { try { return /mini_alive_at:/.test(JSON.parse(init.body).body ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => {
    const no = isPinned(init) && ((refuse === 'open' && init.method === 'POST') || (refuse === 'edit' && init.method === 'PATCH'));
    return no ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init);
  };
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {} });
  await assert.rejects(passes.heartbeat(), /the pinned heartbeat issue was not posted/);
  assert.equal(pinnedOf(gh), undefined, 'GitHub really took no pinned issue');
  assert.ok(queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)) || [...gh.issues.values()].some((i) => /heartbeat red: dispatcher/.test(i.title)), 'the late alert is still told one way');
  refuse = null;
  await passes.heartbeat();
  const before = pinnedOf(gh).body;
  refuse = 'edit';
  await assert.rejects(passes.heartbeat(), /the pinned heartbeat issue was not posted/);
  assert.equal(pinnedOf(gh).body, before, 'the edit was really refused');
});

test('#451 r1 m2: an alert GitHub lost is a failed item of the heartbeat pass, which robot-main logs', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const alertPost = (init) => { try { return init.method === 'POST' && /heartbeat red/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (alertPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { passes } = await wire(w.config, { fetchFn, log: () => {} });
  const out = await passes.heartbeat();
  assert.ok(out.red.includes('alert-not-told'));
  assert.ok(out.failed >= 1, JSON.stringify(out));
  const logs = [];
  await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn } });
  assert.match(logs.join('\n'), /robot: heartbeat ran, and \d+ of its items failed/);
  // An all-told pass names no failed items.
  const w2 = withKey(world({ extra: APP }));
  const ok = await (await wire(w2.config, { fetchFn: appGitHub(w2).fetchFn, log: () => {} })).passes.heartbeat();
  assert.equal(ok.failed, undefined, JSON.stringify(ok));
});

test('#451 L967: an alert lost outside the per-kind list (usage) still makes the pass one failed item, which robot-main logs', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // GitHub refuses only the usage alert; every per-kind alert (dispatcher, rules, front door, signed out) goes out.
  const usagePost = (init) => { try { return init.method === 'POST' && /Claude usage past/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (usagePost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {} });
  const at = new Date().toISOString();
  const sense = (id, doc) => { const r = rec.write({ actor: 'sensors', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc }); assert.ok(r.ok, `${id}: ${r.reason}`); };
  assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at, started_at: at, steps: {} }, kind: 'full_pass' }).ok);
  sense('signed-in-account', { account: 'a', signed_in: true, observed_at: at });
  sense(USAGE_FACT('a'), { account: 'a', observed_at: at, h5: { used_pct: 60, resets_at: new Date(Date.now() + 3600e3).toISOString() },
    week: { used_pct: 10, resets_at: new Date(Date.now() + 2 * 86400e3).toISOString() } });
  const out = await passes.heartbeat();
  assert.ok(out.red.includes('alert-not-told'), JSON.stringify(out));
  assert.match(pinnedOf(gh).body, /usage: 60 %/, 'the usage reading was current, so its alert was the one asked for');
  assert.equal(out.failed, 1, JSON.stringify(out));
  const logs = [];
  await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn } });
  assert.match(logs.join('\n'), /robot: heartbeat ran, and 1 of its items failed/);
});

// L977: one alerts object a round, and the sweep on it after the heartbeat, so an alert issue whose number the Record
// lost is closed once its cause clears (#449).
test('L977: an alert issue whose number the Record lost is closed by the next round\'s sweep once its cause clears', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let t = Date.parse('2026-11-03T10:00:00Z');
  const round = () => wire(w.config, { fetchFn: gh.fetchFn, now: () => t, log: () => {} });
  const first = await round();
  const { rec } = first;
  const sense = (id, doc) => { const r = rec.write({ actor: 'sensors', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc }); assert.ok(r.ok, `${id}: ${r.reason}`); };
  const dispatcherPass = () => assert.ok(rec.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: isoAt(t), started_at: isoAt(t), steps: {} }, kind: 'full_pass' }).ok);
  dispatcherPass();
  sense('signed-in-account', { account: null, signed_in: false, reason: 'nobody is signed in', observed_at: isoAt(t) });
  await first.passes.heartbeat();
  const out = [...gh.issues.values()].find((i) => /heartbeat red: signed-out/.test(i.title));
  assert.ok(out, 'the signed-out alert is raised');
  // The Record loses where that issue is (as when its write was refused): its clear will find nothing to close.
  const f = rec.list('fact').find((x) => x.doc?.kind === 'fact.alert' && x.doc?.issue === out.number);
  assert.ok(f, 'the alert\'s own fact');
  assert.ok(rec.write({ actor: 'ledger', entity: 'fact', id: f.id, expectRev: f.rev, doc: { ...f.doc, issue: null } }).ok);
  // The next round (its own process, its own alerts object): signed in again, so the clear answers 'none' and the sweep
  // after the beat closes the issue.
  t += 5 * MIN; dispatcherPass();
  sense('signed-in-account', { account: 'b', observed_at: isoAt(t) });
  const second = await round();
  const r = await second.passes.heartbeat();
  assert.deepEqual(r.sweep.closed, [out.number], JSON.stringify(r.sweep));
  assert.equal(r.sweep.why, null);
  assert.equal(gh.issues.get(out.number).state, 'closed');
  assert.ok(!queued(rec).some((q) => /alert sweep/.test(q)), 'no trouble to tell');
});

test('L977: a sweep that says why is round trouble, one queued entry under its own cause, not one per pass; what it did is logged; the heartbeat\'s answer is unchanged', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // GitHub won't say who the robot is: any bot counts as the robot, so the sweep closes nothing and says why.
  const fetchFn = async (url, init = {}) => (new URL(url).pathname === '/app' ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const logs = [];
  const { rec, passes } = await wire(w.config, { fetchFn, log: (l) => logs.push(l) });
  const r = await passes.heartbeat();
  assert.match(String(r.sweep?.why), /login is not known/);
  assert.deepEqual(r.red, ['dispatcher', 'robot-login-unknown'], 'the beat\'s own answer: the Dispatcher never ran and the login is unknown, nothing from the sweep');
  assert.equal(r.failed, undefined, 'a sweep with a why is not a failed heartbeat');
  assert.match(logs.join('\n'), /robot: alert sweep: closed \[\], failed \[\], kept \[\]; the robot's own login is not known/);
  assert.ok(queued(rec).some((q) => /^the robot job's alert sweep: the robot's own login is not known/.test(q)), queued(rec).join(' | '));
  // Under its own kind's cause, which marks it (#465 r1 m2, m5 P5).
  const entries = rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
  assert.equal(entries.find((e) => /alert sweep/.test(e.text))?.mark?.fact, HOLD_FACT(SWEEP_CAUSES.login), JSON.stringify(entries));
  assert.equal(r.sweep.tell, undefined, 'queued: nothing to say it was not');
  await passes.heartbeat();
  assert.equal(queued(rec).filter((q) => /alert sweep/.test(q)).length, 1, 'once, not every pass');
});

test('L977 review: a sweep that throws, or runs past its limit, is told masked and never fails the heartbeat; no pass is named sweep', async () => {
  const causes = Object.values(SWEEP_CAUSES);
  assert.equal(new Set(causes).size, causes.length, 'one cause per kind');
  assert.ok(!ROBOT_PASSES.some((p) => causes.includes(CAUSE(p))), 'no sweep cause is a pass\'s');
  const TOK = 'ghs_'.padEnd(40, 'z');
  for (const [name, broken, want, cause] of [
    ['throws', async () => { throw new Error(`list broke with ${TOK}`); }, /^it stopped: /, SWEEP_CAUSES.list],
    ['hangs', () => new Promise(() => {}), /^it did not finish within 50 ms/, SWEEP_CAUSES.timeout],
  ]) {
    const w = withKey(world({ extra: APP }));
    const gh = appGitHub(w);
    // The pinned issue is the beat's last write: only GitHub's open-issue list after it, the sweep's, breaks.
    let pinned = false;
    const fetchFn = async (url, init = {}) => {
      const u = new URL(url); const method = init.method ?? 'GET';
      if (pinned && u.pathname === `/repos/${ALERT_REPO}/issues` && method === 'GET') return broken();
      const res = await gh.fetchFn(url, init);
      if (method !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) pinned = true;
      return res;
    };
    const logs = [];
    const { rec, passes } = await wire(w.config, { fetchFn, log: (l) => logs.push(l), sweepDeadlineMs: 50 });
    const r = await passes.heartbeat();
    assert.ok(pinned, `${name}: the beat posted its pinned issue`);
    assert.equal(r.failed, undefined, name);
    assert.match(r.sweep.why, want, name);
    assert.ok(!logs.join('\n').includes(TOK) && !queued(rec).join('\n').includes(TOK), `${name}: the token is masked`);
    assert.ok(queued(rec).some((q) => /^the robot job's alert sweep: it (stopped|did not finish)/.test(q)), `${name}: ${queued(rec).join(' | ')}`);
    const entries = rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? [];
    assert.equal(entries.find((e) => /alert sweep/.test(e.text))?.mark?.fact, HOLD_FACT(cause), `${name}: ${JSON.stringify(entries)}`);
  }
});

// #465 r1: a round whose alert issue lost its number in the Record, so the next round's sweep has an issue to close.
// `wrap(fetchFn, state, clock)` wraps the second round's GitHub; `state.pinned` turns true once that round's beat posted.
async function orphanRound({ wrap = (f) => f, wireOpts = {} } = {}) {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
  const first = await wire(w.config, { fetchFn: gh.fetchFn, now: () => clock.t, log: () => {} });
  const rec0 = first.rec;
  const sense = (id, doc) => assert.ok(rec0.write({ actor: 'sensors', entity: 'fact', id, expectRev: rec0.read('fact', id)?.rev ?? 0, doc }).ok);
  const dispatcherPass = () => assert.ok(rec0.write({ actor: 'dispatcher', entity: 'fact', id: LAST_PASS_FACT, expectRev: rec0.read('fact', LAST_PASS_FACT)?.rev ?? 0,
    doc: { at: isoAt(clock.t), started_at: isoAt(clock.t), steps: {} }, kind: 'full_pass' }).ok);
  dispatcherPass();
  sense('signed-in-account', { account: null, signed_in: false, reason: 'nobody is signed in', observed_at: isoAt(clock.t) });
  await first.passes.heartbeat();
  const out = [...gh.issues.values()].find((i) => /heartbeat red: signed-out/.test(i.title));
  const f = rec0.list('fact').find((x) => x.doc?.kind === 'fact.alert' && x.doc?.issue === out.number);
  assert.ok(rec0.write({ actor: 'ledger', entity: 'fact', id: f.id, expectRev: f.rev, doc: { ...f.doc, issue: null } }).ok);
  clock.t += 5 * MIN; dispatcherPass();
  sense('signed-in-account', { account: 'b', observed_at: isoAt(clock.t) });
  const state = { pinned: false };
  const inner = wrap(gh.fetchFn, state, clock);
  const fetchFn = async (url, init = {}) => {
    const res = await inner(url, init);
    if ((init.method ?? 'GET') !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) state.pinned = true;
    return res;
  };
  const logs = [];
  const second = await wire(w.config, { fetchFn, now: () => clock.t, log: (l) => logs.push(l), ...wireOpts });
  return { ...second, gh, out, logs, state, clock };
}
const sweepEntries = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => /alert sweep/.test(e.text));
const listCall = (url, init) => (init.method ?? 'GET') === 'GET' && new URL(url).pathname === `/repos/${ALERT_REPO}/issues`;

test('#465 r1 m3: a close GitHub refused during the sweep is told under its own cause', async () => {
  const o = await orphanRound({ wrap: (f, st) => async (url, init = {}) => {
    if (st.pinned && (init.method ?? 'GET') === 'PATCH' && /"state":"closed"/.test(String(init.body ?? ''))) return { status: 500, json: async () => ({}) };
    return f(url, init);
  } });
  const r = await o.passes.heartbeat();
  assert.deepEqual(r.sweep.failed, [o.out.number], JSON.stringify(r.sweep));
  assert.match(r.sweep.why, new RegExp(`GitHub refused to close issue #${o.out.number}; it is tried again a day on`));
  assert.deepEqual(sweepEntries(o.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.close)], JSON.stringify(sweepEntries(o.rec)));
  assert.equal(r.failed, undefined, 'the heartbeat is not failed by it');
});

test('#465 r1 m5 (P8), c3: the Record refusing to keep where an alert is during the sweep is told; trouble the beat left is not the sweep\'s', async () => {
  for (const when of ['sweep', 'beat']) {
    // M13's own object, whose cacheTrouble says the Record refused a cache write: from the sweep on, or already after the beat.
    let swept = false;
    const alertsOf = (o) => { const a = makeAlerts(o); return { ...a, sweep: async (x) => { swept = true; return a.sweep(x); }, cacheTrouble: () => (when === 'beat' || swept ? 'the store is full' : a.cacheTrouble()) }; };
    const o = await orphanRound({ wireOpts: { alertsOf } });
    const r = await o.passes.heartbeat();
    const causes = sweepEntries(o.rec).map((e) => e.mark?.fact);
    if (when === 'sweep') {
      assert.match(String(r.sweep.why), /the Record refused to keep where an alert is, this round \(the store is full\)/, JSON.stringify(r.sweep));
      assert.ok(causes.includes(HOLD_FACT(SWEEP_CAUSES.cache)), JSON.stringify(causes));
    } else assert.ok(!causes.includes(HOLD_FACT(SWEEP_CAUSES.cache)), `the beat's own trouble, told by its own report: ${JSON.stringify(causes)} ${JSON.stringify(r.sweep)}`);
  }
});

test('#465 r1 m4, m5 (P9): a sweep trouble the queue refuses, or throws on, is logged and said in the sweep\'s tell', async () => {
  for (const how of ['false', 'throws']) {
    const hold = (a) => { if (String(a.cause).startsWith('robot-sweep-')) { if (how === 'false') return false; throw new Error('queue broke'); } return holdAlert(a); };
    const o = await orphanRound({ wrap: (f, st) => async (url, init = {}) => (st.pinned && listCall(url, init) ? { status: 500, json: async () => ({}) } : f(url, init)), wireOpts: { hold } });
    const r = await o.passes.heartbeat();
    assert.ok(r.sweep.why, how);
    assert.ok(String(r.sweep.tell).startsWith(`the alert sweep's trouble: ${SWEEP_CAUSES.list} could not be queued`), `${how}: ${JSON.stringify(r.sweep)}`);
    assert.ok(o.logs.some((l) => l.startsWith(`robot: the alert sweep's trouble (${SWEEP_CAUSES.list}) could not be queued`)), `${how}: ${o.logs.join(' | ')}`);
    assert.equal(r.failed, undefined, how);
  }
});

test('#465 r1 m1: the sweep\'s limit is what the heartbeat pass has left, less the margin; with none left it is not run', async () => {
  // A pass limit that leaves 50 ms: a hanging list is cut at 50, not at the sweep's own 30 s.
  const hang = (f, st) => async (url, init = {}) => (st.pinned && listCall(url, init) ? new Promise(() => {}) : f(url, init));
  const a = await orphanRound({ wrap: hang, wireOpts: { passDeadlineMs: SWEEP_MARGIN_MS + 50 } });
  const ra = await a.passes.heartbeat();
  assert.match(ra.sweep.why, /^it did not finish within 50 ms/);
  assert.deepEqual(sweepEntries(a.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.timeout)]);
  // The beat took two minutes of a one-minute pass: the sweep is not run, GitHub is not asked, and it says why.
  let listed = 0;
  const slow = (f, st, clock) => async (url, init = {}) => {
    if (st.pinned && listCall(url, init)) listed += 1;
    const res = await f(url, init);
    if ((init.method ?? 'GET') !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) clock.t += 2 * MIN;
    return res;
  };
  const b = await orphanRound({ wrap: slow, wireOpts: { passDeadlineMs: MIN } });
  const rb = await b.passes.heartbeat();
  assert.match(rb.sweep.why, /^it was not run: the heartbeat pass had 0 ms of its 60000 left/);
  assert.equal(listed, 0, 'GitHub\'s list was not read');
  assert.deepEqual(sweepEntries(b.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.timeout)]);
  assert.equal(rb.failed, undefined);
});

test('#465 r1 m5 (P14): a slow sweep does not hold back the late alert\'s mark and drop', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let pinned = false; let release; let hanging = false;
  const gate = new Promise((r) => { release = r; });
  const fetchFn = async (url, init = {}) => {
    if (pinned && listCall(url, init)) { hanging = true; await gate; }
    const res = await gh.fetchFn(url, init);
    if ((init.method ?? 'GET') !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) pinned = true;
    return res;
  };
  const { rec, passes } = await wire(w.config, { fetchFn, log: () => {}, sweepDeadlineMs: 20_000 });
  const hb = passes.heartbeat();
  for (let i = 0; i < 400 && !hanging; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(hanging, 'the sweep is waiting on GitHub\'s list');
  const late = dispatcherLate(rec, { nowMs: Date.now(), holder: null });
  assert.ok(rec.read('fact', HOLD_FACT(LATE_CAUSE(late.since)))?.doc?.told_at, `the late alert's hold is marked told while the sweep still waits: ${rec.list('fact').map((f) => f.id).join(', ')}`);
  assert.ok(!queued(rec).some((q) => /the Dispatcher has no full pass on record/.test(q)), 'and its queued copy dropped');
  release();
  const r = await hb;
  assert.equal(r.failed, undefined);
});

test('#465 r1 c2: a sweep answer that is not the shape, or none, is the sweep\'s trouble, never a failed heartbeat', async () => {
  for (const [name, answer, want] of [['no lists', { swept: true }, null], ['nothing', null, /^it answered no result$/], ['a number', 3, /^it answered no result$/]]) {
    const alertsOf = (o) => ({ ...makeAlerts(o), sweep: async () => answer });
    const o = await orphanRound({ wireOpts: { alertsOf } });
    const r = await o.passes.heartbeat();
    assert.equal(r.failed, undefined, name);
    assert.deepEqual([r.sweep.closed, r.sweep.failed, r.sweep.kept], [[], [], []], name);
    if (want) assert.match(String(r.sweep.why), want, name); else assert.equal(r.sweep.why, null, name);
  }
});

test('#465 r1: a beat that throws still has its sweep run, and the pass still fails with the beat\'s own error', async () => {
  let swept = 0;
  const alertsOf = (o) => { const a = makeAlerts(o); return { ...a, sweep: async (x) => { swept += 1; return a.sweep(x); } }; };
  const o = await orphanRound({ wrap: (f, st) => async (url, init = {}) => { if ((init.method ?? 'GET') !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) throw new Error('pinned edit broke'); return f(url, init); }, wireOpts: { alertsOf } });
  await assert.rejects(o.passes.heartbeat(), /pinned edit broke/);
  assert.equal(swept, 1, 'the sweep ran');
});

test('#465 r2 M1: robot-main, run as its own process with the App named, wires and runs the sweep with its pass limit', () => {
  // The job as launchd starts it: a wire that imported robot-main back would wait on its top-level main for ever (exit 13),
  // and one not handed the pass limit would not run the sweep and queue that.
  const w = withKey(world({ extra: APP }));
  writeFileSync(w.f('fake-github.json'), JSON.stringify({ ...w.fake, app: { installation: APP.appInstallation, alertRepo: ALERT_REPO } }));
  const r = boot(w);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /it was not run/);
  const rec = readRecord(w);
  // Neither queued nor, once delivered, held as told: the sweep had no trouble, and the heartbeat pass did not fail.
  assert.deepEqual(sweepEntries(rec), []);
  assert.equal(rec.read('fact', HOLD_FACT(SWEEP_CAUSES.timeout)), null);
  assert.doesNotMatch(r.err, /robot: heartbeat failed/);
  assert.ok(!queued(rec).some((t) => /heartbeat pass failed/.test(t)), queued(rec).join(' | '));
  assert.match(readFileSync(w.f('github.log'), 'utf8'), new RegExp(`GET /repos/${ALERT_REPO}/issues`), 'the alert repository was read');
});

test('#465 r2 M1: wire handed no pass limit does not run the sweep, and says so under the limit cause', async () => {
  let swept = 0;
  const alertsOf = (o) => { const a = makeAlerts(o); return { ...a, sweep: async (x) => { swept += 1; return a.sweep(x); } }; };
  const o = await orphanRound({ wireOpts: { passDeadlineMs: undefined, alertsOf } });
  const r = await o.passes.heartbeat();
  assert.equal(swept, 0);
  assert.match(r.sweep.why, /^it was not run: it was given no heartbeat pass limit/);
  assert.deepEqual(sweepEntries(o.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.timeout)]);
  assert.equal(r.failed, undefined);
});

test('#465 r2 m5: a sweep mark the Record refuses is told under the mark cause', async () => {
  const alertsOf = (o) => {
    const inner = makeFactWriter(o.rec, { actor: 'ledger', now: o.now });
    const writer = { ...inner, put: (id, doc) => (doc?.kind === 'fact.alert-sweep-list' ? { ok: false, reason: 'the store is full' } : inner.put(id, doc)) };
    return makeAlerts({ ...o, writer });
  };
  const o = await orphanRound({ wireOpts: { alertsOf } });
  const r = await o.passes.heartbeat();
  assert.match(String(r.sweep.why), /the Record refused the sweep's mark \(the store is full\)/, JSON.stringify(r.sweep));
  assert.deepEqual(sweepEntries(o.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.mark)]);
  assert.equal(r.failed, undefined);
});

test('#465 r2 m4: a why naming the login and a refused mark is queued under both causes', async () => {
  const why = 'the robot\'s own login is not known, so its issues can\'t be told from another app\'s; nothing more was closed; the Record refused the sweep\'s list mark, so a key it tried may wait up to an hour';
  const alertsOf = (o) => ({ ...makeAlerts(o), sweep: async () => ({ swept: false, closed: [], failed: [], kept: [], why }) });
  const o = await orphanRound({ wireOpts: { alertsOf } });
  const r = await o.passes.heartbeat();
  assert.deepEqual(sweepEntries(o.rec).map((e) => e.mark?.fact).sort(), [HOLD_FACT(SWEEP_CAUSES.login), HOLD_FACT(SWEEP_CAUSES.mark)].sort());
  assert.equal(r.failed, undefined);
});

test('#465 r2 m5: the sweep\'s limit runs from the pass\'s start, not from when the job was wired', async () => {
  let swept = 0;
  const alertsOf = (o) => { const a = makeAlerts(o); return { ...a, sweep: async (x) => { swept += 1; return a.sweep(x); } }; };
  const o = await orphanRound({ wireOpts: { passDeadlineMs: MIN, alertsOf } });
  o.clock.t += 2 * MIN;   // the round's earlier passes took longer than a whole pass limit
  const r = await o.passes.heartbeat();
  assert.equal(swept, 1, JSON.stringify(r.sweep));
  assert.doesNotMatch(String(r.sweep.why), /not run|did not finish/);
});

test('#465 r2 m6: a sweep cause the queue refused joins the tell of a heartbeat pass that fails', async () => {
  const hold = (a) => (String(a.cause).startsWith('robot-sweep-') ? false : holdAlert(a));
  const o = await orphanRound({ wrap: (f, st) => async (url, init = {}) => {
    if ((init.method ?? 'GET') !== 'GET' && /mini_alive_at:/.test(String(init.body ?? ''))) throw new Error('pinned edit broke');
    return f(url, init);
  }, wireOpts: { hold, passDeadlineMs: undefined } });
  const e = await o.passes.heartbeat().then(() => null, (x) => x);
  assert.match(String(e?.message), /pinned edit broke/);
  assert.match(String(e?.tell), new RegExp(`the alert sweep's trouble: ${SWEEP_CAUSES.timeout} could not be queued`));
});

// #465 r2 audit m2: the other two failing-pass paths carry the sweep's refused cause too. No pass limit, so the sweep is
// not run and holds its timeout cause, which this queue refuses.
test('#465 r2 audit m2: a sweep cause the queue refused joins the tell when the late alert was neither queued nor told', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const alertPost = (init) => { try { return init.method === 'POST' && /heartbeat red/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (alertPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { passes } = await wire(w.config, { fetchFn, hold: () => false, log: () => {}, passDeadlineMs: undefined });
  const e = await passes.heartbeat().then(() => null, (x) => x);
  assert.match(String(e?.message), /neither queued nor told/);
  assert.equal(e.tell, `the Dispatcher-late alert could not be queued; the alert sweep's trouble: ${SWEEP_CAUSES.timeout} could not be queued`);
});

test('#465 r2 audit m2: a sweep cause the queue refused joins the tell when the pinned issue was not posted', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const isPinned = (init) => { try { return /mini_alive_at:/.test(JSON.parse(init.body).body ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (isPinned(init) && init.method === 'POST' ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const hold = (a) => (String(a.cause).startsWith('robot-sweep-') ? false : holdAlert(a));
  const { passes } = await wire(w.config, { fetchFn, hold, log: () => {}, passDeadlineMs: undefined });
  const e = await passes.heartbeat().then(() => null, (x) => x);
  assert.match(String(e?.message), /the pinned heartbeat issue was not posted/);
  assert.equal(e.tell, `the alert sweep's trouble: ${SWEEP_CAUSES.timeout} could not be queued`);
  // #465 r2 audit c2: in main, the heartbeat's own failure alert is queued, so its line does not say "could not be told".
  const logs = [];
  await main([w.configFile], { self: w.main, log: (l) => logs.push(l), wireOpts: { fetchFn, hold, passDeadlineMs: undefined } });
  const line = logs.find((l) => /^robot: heartbeat failed: the pinned heartbeat issue was not posted/.test(l));
  assert.ok(line, logs.join('\n'));
  assert.doesNotMatch(line, /could not be told/);
  assert.match(line, new RegExp(`\\(its failure is queued; the alert sweep's trouble: ${SWEEP_CAUSES.timeout} could not be queued\\)$`));
});

test('#465 r2 audit m3: a heartbeat with an alert GitHub lost still answers the sweep\'s status', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  const alertPost = (init) => { try { return init.method === 'POST' && /heartbeat red/.test(JSON.parse(init.body).title ?? ''); } catch { return false; } };
  const fetchFn = async (url, init = {}) => (alertPost(init) ? { status: 500, json: async () => ({}) } : gh.fetchFn(url, init));
  const { passes } = await wire(w.config, { fetchFn, log: () => {} });
  const out = await passes.heartbeat();
  assert.ok(out.red.includes('alert-not-told'), JSON.stringify(out));
  assert.ok(out.failed >= 1, JSON.stringify(out));
  assert.equal(typeof out.sweep, 'object', JSON.stringify(out));
  assert.notEqual(out.sweep, null, JSON.stringify(out));
  assert.equal(typeof out.sweep.swept, 'boolean', JSON.stringify(out.sweep));
});

test('#465 r2 audit m1: a per-key sweep mark the Record refuses (the close landed) is told under the mark cause', async () => {
  const alertsOf = (o) => {
    const inner = makeFactWriter(o.rec, { actor: 'ledger', now: o.now });
    const writer = { ...inner, put: (id, doc) => (doc?.kind === 'fact.alert-sweep' ? { ok: false, reason: 'the store is full' } : inner.put(id, doc)) };
    return makeAlerts({ ...o, writer });
  };
  const o = await orphanRound({ wireOpts: { alertsOf } });
  const r = await o.passes.heartbeat();
  assert.deepEqual(r.sweep.closed, [o.out.number], JSON.stringify(r.sweep));
  assert.equal(o.gh.issues.get(o.out.number).state, 'closed', 'the close itself landed');
  assert.match(String(r.sweep.why), /the Record refused the mark of /, JSON.stringify(r.sweep));
  assert.deepEqual(sweepEntries(o.rec).map((e) => e.mark?.fact), [HOLD_FACT(SWEEP_CAUSES.mark)]);
  assert.equal(r.failed, undefined);
});

test('L969: the robot heartbeat tells a stopped Sensors job by name: green while it writes, red with its alert past usage.stale_after_min', async () => {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  // The clock stays put and the readings are dated back: the rules reader calls its rules unusable 5 minutes after its
  // last fetch (M10 reader FETCH_GRACE_MS), which one robot round, one process, never reaches.
  const t = Date.parse('2026-11-03T10:00:00Z');
  const { rec, passes } = await wire(w.config, { fetchFn: gh.fetchFn, now: () => t, log: () => {} });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /Sensors job last wrote a reading: none yet \(for 0 min; red after 15 min\)/, 'no Sensors reading yet: not known at first, never red');
  assert.ok(![...gh.issues.values()].some((i) => /heartbeat red: sensors/.test(i.title)));
  sensed(rec, 'network-up', { value: true, observed_at: isoAt(t - 2 * MIN) });
  sensed(rec, 'signed-in-account', { account: 'a', signed_in: true, observed_at: isoAt(t - 2 * MIN) });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /ok {4}Sensors job last wrote a reading: 2 min ago \(red after 15 min\)/);
  sensed(rec, 'network-up', { value: true, observed_at: isoAt(t - 18 * MIN) });
  sensed(rec, 'signed-in-account', { account: 'a', signed_in: true, observed_at: isoAt(t - 18 * MIN) });
  await passes.heartbeat();
  assert.match(pinnedOf(gh).body, /M10 Rules usable: yes/, 'the limit was there to read');
  const al = [...gh.issues.values()].find((i) => /heartbeat red: sensors/.test(i.title));
  assert.ok(al, 'red, with its own alert');
  assert.match(al.body, /The Sensors job has written no reading for 18 minutes \(red after 15\)/);
  sensed(rec, 'network-up', { value: true, observed_at: isoAt(t) });
  sensed(rec, 'signed-in-account', { account: 'a', signed_in: true, observed_at: isoAt(t) });
  await passes.heartbeat();
  assert.equal(al.state, 'closed', 'cleared once it writes again');
});

// #464 deviation 3 part b (L1024): the Sensors hold, as the Dispatcher's. One robot round is one process, so each round
// wires afresh (the rules reader's own grace, as in L969 above), on one Record and one stand-in GitHub. upMs is fixed
// past the restart grace (m-C), so the test does not lean on this Mac's own uptime. The heartbeat's answers come from
// the real alerts on that GitHub: Joe closing the alert issue is what makes the next raise 'suppressed'.
function sensorsRounds({ wireOpts = {} } = {}) {
  const w = withKey(world({ extra: APP }));
  const gh = appGitHub(w);
  let lose = false;   // GitHub answers 500 to every issue call: the heartbeat's alerts are lost
  const fetchFn = async (url, init = {}) => (lose && /\/issues/.test(String(url)) ? new Response('{}', { status: 500 }) : gh.fetchFn(url, init));
  const round = async (t) => {
    const { rec, passes } = await wire(w.config, { fetchFn, now: () => t, log: () => {}, upMs: () => 3_600_000, ...wireOpts });
    let r = null; let err = null;
    try { r = await passes.heartbeat(); } catch (e) { err = e; }
    return { rec, r, err };
  };
  const sensorsIssue = () => [...gh.issues.values()].filter((i) => /heartbeat red: sensors/.test(i.title)).at(-1);   // the newest
  const closeByJoe = () => Object.assign(sensorsIssue(), { state: 'closed', closed_by: { login: 'owner-login', type: 'User' } });
  const reopen = () => Object.assign(sensorsIssue(), { state: 'open', closed_by: null });
  return { w, gh, round, issue: sensorsIssue, closeByJoe, reopen, loseGitHub: (v) => { lose = v; } };
}
const T464 = Date.parse('2026-11-03T10:00:00Z');
const stopAt = (rec, ms) => { sensed(rec, 'network-up', { value: true, observed_at: isoAt(ms) }); sensed(rec, 'signed-in-account', { account: 'a', signed_in: true, observed_at: isoAt(ms) }); };
const sensorsHolds = (rec) => (rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).filter((e) => String(e?.mark?.fact).startsWith('hold-robot-sensors-'));
// The job stops (newest reading 18 minutes before T464); the first round opens the heartbeat's alert and Joe closes it.
async function stoppedAndClosed(s) {
  const { rec } = await s.round(T464);
  stopAt(rec, T464 - 18 * MIN);
  const opened = await s.round(T464);
  assert.ok(s.issue(), 'the heartbeat opened its Sensors alert');
  assert.deepEqual(sensorsHolds(opened.rec), [], 'opened by the heartbeat itself: no hold');
  s.closeByJoe();
  return opened.rec;
}

test('#464 dev 3 (b): Joe closed the Sensors alert while the stop lasts: its hold is queued once a day for that stop, with the alert\'s text', async () => {
  const s = sensorsRounds();
  await stoppedAndClosed(s);
  const one = await s.round(T464 + MIN);
  assert.equal(one.err, null, String(one.err?.message));
  const q = sensorsHolds(one.rec);
  assert.deepEqual(q.map((e) => e.mark.fact), ['hold-robot-sensors-2026-11-03T09-42-00.000Z'], 'one cause per stop, named by its status');
  assert.equal(SENSORS_CAUSE('red:sensors:2026-11-03T09:42:00.000Z'), 'robot-sensors-2026-11-03T09-42-00.000Z');
  assert.match(q[0].text, /^The Sensors job has written no reading for 19 minutes \(red after 15\)/, 'the heartbeat alert\'s own text');
  assert.equal(s.issue().state, 'closed', 'Joe\'s close stands');
  // Delivered (deliver marks the hold told and the copy leaves the queue): not again that day, again the next.
  assert.ok(markToldByBeat(one.rec, { cause: 'robot-sensors-2026-11-03T09-42-00.000Z', text: q[0].text, now: T464 + MIN }));
  assert.ok(dropCause(one.rec, q[0].mark.fact));
  const later = await s.round(T464 + 60 * MIN);
  assert.equal(later.err, null, String(later.err?.message));
  assert.deepEqual(sensorsHolds(later.rec), [], 'told today already: not queued again');
  const nextDay = await s.round(T464 + 25 * 60 * MIN);
  assert.deepEqual(sensorsHolds(nextDay.rec).map((e) => e.mark.fact), ['hold-robot-sensors-2026-11-03T09-42-00.000Z'], 'still stopped a day on: told again');
});

test('#464 dev 3 (b): a new stop is a new cause, told the same day, and the ended stop\'s queued hold leaves unsent', async () => {
  const s = sensorsRounds();
  await stoppedAndClosed(s);
  const one = await s.round(T464 + MIN);
  const first = sensorsHolds(one.rec);
  assert.equal(first.length, 1);
  // The first stop's hold was told today, and its copy is still waiting when the job stops again.
  assert.ok(markToldByBeat(one.rec, { cause: 'robot-sensors-2026-11-03T09-42-00.000Z', text: first[0].text, now: T464 + MIN }));
  stopAt(one.rec, T464 + 10 * MIN);
  const changed = await s.round(T464 + 30 * MIN);   // the alert's status changed: the heartbeat tells the new stop itself
  assert.equal(changed.err, null, String(changed.err?.message));
  assert.deepEqual(sensorsHolds(changed.rec), [], 'the old stop\'s copy leaves; the new stop was told by the heartbeat');
  s.closeByJoe();
  const two = await s.round(T464 + 31 * MIN);
  assert.equal(two.err, null, String(two.err?.message));
  assert.deepEqual(sensorsHolds(two.rec).map((e) => e.mark.fact), ['hold-robot-sensors-2026-11-03T10-10-00.000Z'], 'Joe closed the new stop\'s alert too: its hold is told the same day');
});

test('#464 dev 3 (b): once the Sensors line is green, every queued Sensors hold leaves unsent', async () => {
  const s = sensorsRounds();
  await stoppedAndClosed(s);
  const one = await s.round(T464 + MIN);
  assert.equal(sensorsHolds(one.rec).length, 1);
  // Another kind's hold waits too (a sweep's trouble): it is not the Sensors line's to drop.
  assert.notEqual(holdAlertReal({ rec: one.rec, cause: SWEEP_CAUSES.list, text: 'the list failed', alert: outbox(one.rec, T464), now: T464 }), false);
  stopAt(one.rec, T464 + 7 * MIN);
  const green = await s.round(T464 + 8 * MIN);
  assert.equal(green.err, null, String(green.err?.message));
  assert.deepEqual(sensorsHolds(green.rec), [], 'green again: the hold leaves unsent');
  assert.ok((green.rec.read('fact', ALERT_QUEUE_FACT)?.doc?.entries ?? []).some((e) => e?.mark?.fact === HOLD_FACT(SWEEP_CAUSES.list)), 'only Sensors holds leave');
});

test('#464 dev 3 (b): a failed beat drops no Sensors hold', async () => {
  let broken = false;
  const s = sensorsRounds();
  await stoppedAndClosed(s);
  const one = await s.round(T464 + MIN);
  assert.equal(sensorsHolds(one.rec).length, 1);
  stopAt(one.rec, T464 + 7 * MIN);
  const { passes } = await wire(s.w.config, { fetchFn: s.gh.fetchFn, now: () => T464 + 8 * MIN, log: () => {}, upMs: () => 3_600_000,
    alertsOf: (o) => ({ ...makeAlerts(o), clear: async () => { broken = true; throw new Error('GitHub broke'); } }) });
  await assert.rejects(passes.heartbeat());
  assert.ok(broken);
  assert.equal(sensorsHolds(one.rec).length, 1, 'not known to be green: kept');
});

test('#464 dev 3 (b): the heartbeat\'s own tell is the tell: no hold while its alert is open, and a waiting copy leaves once Joe reopens it', async () => {
  const s = sensorsRounds();
  const { rec } = await s.round(T464);
  stopAt(rec, T464 - 18 * MIN);
  for (const t of [T464, T464 + MIN, T464 + 2 * MIN]) assert.deepEqual(sensorsHolds((await s.round(t)).rec), [], 'opened, then updated: no hold');
  s.closeByJoe();
  assert.equal(sensorsHolds((await s.round(T464 + 3 * MIN)).rec).length, 1);
  s.reopen();
  const back = await s.round(T464 + 4 * MIN);
  assert.equal(back.err, null, String(back.err?.message));
  assert.deepEqual(sensorsHolds(back.rec), [], 'the open alert tells it: the queued copy leaves');
});

test('#464 dev 3 (b): GitHub losing the Sensors alert queues no hold and drops none', async () => {
  const fresh = sensorsRounds();
  const { rec } = await fresh.round(T464);
  stopAt(rec, T464 - 18 * MIN);
  fresh.loseGitHub(true);
  const lost = await fresh.round(T464);
  assert.deepEqual(sensorsHolds(lost.rec), [], 'lost, never closed by Joe: no hold');
  const s = sensorsRounds();
  await stoppedAndClosed(s);
  assert.equal(sensorsHolds((await s.round(T464 + MIN)).rec).length, 1);
  s.loseGitHub(true);
  const still = await s.round(T464 + 2 * MIN);
  assert.equal(sensorsHolds(still.rec).length, 1, 'lost this round: the waiting copy stays');
});

test('#464 dev 3 (b): a Sensors hold the queue refused fails the pass, with its tell', async () => {
  const s = sensorsRounds({ wireOpts: { hold: (o) => (o.cause.startsWith('robot-sensors-') ? false : holdAlertReal(o)) } });
  await stoppedAndClosed(s);
  const one = await s.round(T464 + MIN);
  assert.ok(one.err, 'the pass failed');
  assert.match(String(one.err.tell), /the Sensors hold alert could not be queued/);
});

test('#464 m-C: wire passes upMs to the heartbeat probes: just after a restart a stale reading is not red', async () => {
  for (const [up, red] of [[0, false], [3_600_000, true]]) {
    const w = withKey(world({ extra: APP }));
    const gh = appGitHub(w);
    const o = { fetchFn: gh.fetchFn, now: () => T464, log: () => {}, upMs: () => up };
    const { rec } = await wire(w.config, o);
    stopAt(rec, T464 - 18 * MIN);
    await (await wire(w.config, o)).passes.heartbeat();
    assert.equal([...gh.issues.values()].some((i) => /heartbeat red: sensors/.test(i.title)), red, `up ${up} ms`);
  }
});

test('#536 r2 Q21: the push\'s token getter mints with the scope it is given, never the installation\'s whole token', async () => {
  const asked = [];
  const c = { keyDir: '/k', appId: '1', appInstallation: 2, ownerUid: 3 };
  const get = pushTokenFor(c, { uid: 7001, now: () => 0, mint: async (o) => { asked.push(o.scope); return { ok: true, token: 'x' }; } });
  const scope = { repositories: ['test-repo'], permissions: { contents: 'write', pull_requests: 'write' } };
  assert.deepEqual(await get(scope)(), { ok: true, token: 'x' });
  assert.deepEqual(asked, [scope]);
});
