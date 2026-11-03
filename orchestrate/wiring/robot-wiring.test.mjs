// robot-wiring.test.mjs — the robot job starts from its real entry point with the real wiring (R-0b-162 B; L236, L238).
// Run: node --test orchestrate/wiring/robot-wiring.test.mjs
//
// The boot test runs `node robot-main.mjs <config>` as its own process, as the job would, with the real wiring, Record,
// rules and lock. The only stand-in is GitHub (fake-github.test-helper.mjs through `node --import`). It runs in CI with
// the rest of orchestrate's tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeRules } from '../shared/rules.mjs';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { FIRST, ENTRY } from '../modules/M10-rules/first-cutover.test-helper.mjs';
import { ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { wire, checkUser, lastReturn, dispatcherLate, NOT_WIRED_PASSES, ROBOT_PASSES } from './robot-wiring.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';
import { runPasses, CAUSE, main } from './robot-main.mjs';
import { notWiredText } from './dispatcher-wiring.mjs';
import { fakeGitHubFetch, blobOf } from './fake-github.test-helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WIRING = join(here, 'robot-wiring.mjs');
const MAIN = join(here, 'robot-main.mjs');
const FAKE = join(here, 'fake-github.test-helper.mjs');
const COMMIT = 'a'.repeat(40);
const P = ENTRY.product;
const OWNER_ID = ENTRY.joe_github_id;
const MIN = 60e3;

function world({ extra = {}, issues = [], keyMode = 0o700 } = {}) {
  const dir = tempDir('orch-robot-');
  const f = (n) => join(dir, n);
  writeFileSync(f('products.json'), JSON.stringify([ENTRY]));
  const rulesStateDir = f('rules-state');
  mkdirSync(rulesStateDir, { mode: 0o700 });
  writeFileSync(join(rulesStateDir, 'approved-rules.json'), JSON.stringify({ [P]: [blobOf(FIRST)] }));
  const keyDir = f('keys');
  mkdirSync(keyDir); chmodSync(keyDir, keyMode);
  const token = f('token');
  writeFileSync(token, 'x'.repeat(40), { mode: 0o600 }); chmodSync(token, 0o600);
  const config = { wiring: WIRING, lockFile: f('robot.lock'), product: P, recordRoot: f('record'), ownerUid: process.getuid(),
    productsFile: f('products.json'), rulesStateDir, tokenFile: token, keyDir, ...extra };
  writeFileSync(f('config.json'), JSON.stringify(config));
  const fake = { owner: ENTRY.owner, repo: ENTRY.repo, commit: COMMIT, text: FIRST, issues, logFile: f('github.log') };
  writeFileSync(f('fake-github.json'), JSON.stringify(fake));
  return { dir, f, config, fake };
}

function boot(w) {
  const r = spawnSync(process.execPath, ['--import', FAKE, MAIN, w.f('config.json')], {
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
    doc: { at: new Date(t).toISOString(), steps: {} }, kind: 'full_pass' });
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
  // On time: nothing new. A new stop later: told again.
  lastPass(1); boot(w);
  assert.equal(late(queued(readRecord(w))).length, 1);
  lastPass(DISPATCHER_LATE_MIN + 1); boot(w);
  assert.equal(late(queued(readRecord(w))).length, 2);
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
  const code = await main([w.f('config.json')], { log: (l) => logs.push(l), wireOpts: { deliver, fetchFn: fakeGitHubFetch(w.fake) } });
  assert.equal(code, 0, logs.join('\n'));
  assert.ok(got.includes('the Dispatcher has no full pass on record: nothing is started or merged until it runs'), got.join(' | '));
  // Every pass before it had run: their failures were queued first, so delivery saw them too.
  for (const p of ['gate', 'watch']) assert.ok(got.some((t) => t.startsWith(`the robot job's ${p} pass failed`)), p);
  assert.equal(ROBOT_PASSES.at(-1), 'deliver');
});
