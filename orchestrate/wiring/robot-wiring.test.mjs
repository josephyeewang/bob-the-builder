// robot-wiring.test.mjs — the robot job starts from its real entry point with the real wiring (R-0b-162 B; L236, L238).
// Run: node --test orchestrate/wiring/robot-wiring.test.mjs
//
// The boot test runs `node robot-main.mjs <config>` as its own process, as the job would, with the real wiring, Record,
// rules and lock. The only stand-in is GitHub (fake-github.test-helper.mjs through `node --import`). It runs in CI with
// the rest of orchestrate's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedLayout } from '../shared/job-config.test-helper.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { wire, checkUser, lastReturn, dispatcherLate, lockHolder, LIVE_PASS_MAX_MS, NOT_WIRED_PASSES, ROBOT_PASSES } from './robot-wiring.mjs';
import { pidDead } from '../modules/M11-dispatcher/pass-lock.mjs';
import { tick } from '../modules/M11-dispatcher/tick.mjs';
import { rulesWith } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { fakeAlert } from '../test/fake-alert.test-helper.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';
import { runPasses, CAUSE, main, NOT_QUEUED } from './robot-main.mjs';
import { fakeIssues } from '../modules/M13-ledger/alerts.mjs';
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
  writeFileSync(lockOf(w), JSON.stringify({ pid: process.pid, taken_at: 'T-live' }));
  let r = await run();
  assert.equal(r.code, 0);
  assert.ok(r.logs.some((l) => /robot: another pass runs \(pid \d+\)/.test(l)), r.logs.join('\n'));
  assert.equal(r.delivered, 0, 'no pass ran under another round\'s lock');
  assert.match(readFileSync(lockOf(w), 'utf8'), /T-live/);
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
