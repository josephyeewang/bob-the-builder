// diary-damaged-told.test.mjs — L575: a Record that stops taking writes because its diary is damaged reaches the owner.
//
// WHY. `diary_damaged` went through plain `say`, which only logs in production, and every write then refused: the whole
// Record stopped and nobody heard. Both sites now keep the alert in the store's unsent file, once a day, since every open
// finds the damage again and each kept line is one GitHub issue. This runs the real store and M13's real delivery pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { fakeIssues } from '../modules/M13-ledger/alerts.mjs';
import { deliverAlertsPass } from '../modules/M13-ledger/alert-channel.mjs';
import { openRecordWithStore } from '../modules/M9-record/writer.mjs';
import { HELD_FLAG, heldHolders, makeHeldFlag, readHeldFlag, readUnsent, setHeldFlag } from '../modules/M9-record/unsent.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { PRODUCT, UID, seed, setup } from '../modules/M9-record/fixtures.test-helper.mjs';

const DAY = 24 * 60 * 60 * 1000;
const PRODUCT_REPO = { [PRODUCT]: 'acme/product-1' };
const card = (n) => ({ state: 'draft', product: PRODUCT, module: 'M1', kind: 'ordinary', round: n });
const opened = (env, extra = {}) => openRecordWithStore({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert: fakeAlert({ answer: false }), now: () => env.clock.t, ...extra });
// Damage also makes recover() move later documents aside, each with its own tamper alert: only this alert is followed here.
const kept = (env) => readUnsent(env.root).filter((x) => x.event.type === 'diary_damaged');
const told = (gh) => [...gh.issues.values()].filter((x) => /diary_damaged/.test(x.body));
const logOnly = (extra = {}) => setup({ prefix: 'orch-damaged-', extra: { alert: fakeAlert({ answer: false }), ...extra } });
// A write the rules allow, so what stops it can only be the store. The answer, whether the write returned it or threw it.
const tryWrite = (o) => {
  try { const r = o.record.write({ actor: 'dispatcher', entity: 'fact', id: 'stop-hb-T-3-1', expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-3' } }); return r.ok ? 'written' : r.reason; } catch (e) { return e.message; }
};
const deliver = (env, o, gh) => deliverAlertsPass({ rec: o.record, now: () => env.clock.t, recordRoot: env.root, product: PRODUCT, products: [PRODUCT],
  repos: PRODUCT_REPO, owner: 'owner-login', issuesFor: () => gh, lockWaitMs: 30 });

function brokenMiddle(env) {
  for (const n of [1, 2, 3]) seed(env, 'card', `C-${n}`, card(n));
  const diary = join(env.root, 'diary.jsonl');
  const lines = readFileSync(diary, 'utf8').trim().split('\n');
  lines[1] = 'this is not a diary line';
  writeFileSync(diary, `${lines.join('\n')}\n`);
}

test('L575: a broken middle line reaches the owner through the delivery pass, with the Record refusing writes', async () => {
  const env = logOnly();
  brokenMiddle(env);
  const o = opened(env);
  assert.ok(o.store.damaged(), 'the diary reads as damaged');
  assert.match(tryWrite(o), /diary is damaged/, 'writes refuse');
  assert.equal(kept(env).length, 1);
  const gh = fakeIssues();
  const r = await deliver(env, o, gh);
  assert.equal(r.refused, undefined);
  assert.equal(told(gh).length, 1);
  assert.equal(told(gh)[0].assignee, 'owner-login');
  assert.match(told(gh)[0].body, /reason: /);
  assert.deepEqual(kept(env), [], 'delivered, so it leaves the file');
  assert.match(tryWrite(o), /diary is damaged/, 'telling the owner mended nothing: writes still refuse');
});

test('L575: every open finds the damage, and the owner hears once a day, not once per open', async () => {
  const env = logOnly();
  brokenMiddle(env);
  for (let i = 0; i < 30; i += 1) { assert.ok(opened(env).store.damaged()); env.clock.t += 60_000; }
  assert.equal(kept(env).length, 1, '30 opens, one line');
  const gh = fakeIssues();
  await deliver(env, opened(env), gh);
  assert.equal(told(gh).length, 1);
  for (let i = 0; i < 30; i += 1) assert.ok(opened(env).store.damaged());
  assert.deepEqual(kept(env), [], 'a delivered line still counts for the day');
  await deliver(env, opened(env), gh);
  assert.equal(told(gh).length, 1, 'no second issue that day');
  env.clock.t += DAY;
  for (let i = 0; i < 5; i += 1) assert.ok(opened(env).store.damaged());
  assert.equal(kept(env).length, 1, 'still damaged the next day: told again, once');
  await deliver(env, opened(env), gh);
  assert.deepEqual(kept(env), []);
  assert.equal(told(gh).length, 2, 'two tellings in two days');
});

test('L575: a time ahead of now on a kept line never holds the next day\'s telling back', () => {
  const env = logOnly();
  brokenMiddle(env);
  env.clock.t += 10 * DAY;
  assert.ok(opened(env).store.damaged());
  assert.equal(kept(env).length, 1);
  env.clock.t -= 10 * DAY; // the Mac's clock comes back: the line now lies ahead of now
  assert.ok(opened(env).store.damaged());
  assert.equal(kept(env).length, 2, 'a line from the future is no telling today');
});

test('L575: a failed cut-back reaches the owner through the delivery pass, once a day', async () => {
  const env = logOnly();
  seed(env, 'card', 'C-1', card(1));
  const o = opened(env, { faultAt: 'cutback_fails' });
  assert.match(tryWrite(o), /append failed partway/);
  assert.match(String(o.store.damaged()), /could not be cut back/);
  assert.deepEqual(kept(env).map((x) => x.event.reason), ['a failed diary append could not be cut back']);
  const gh = fakeIssues();
  const r = await deliver(env, o, gh);
  assert.equal(r.refused, undefined);
  assert.equal(told(gh).length, 1);
  assert.match(told(gh)[0].body, /could not be cut back/);
  // The next write's recovery cuts the part-line itself. With the disk still failing, that write fails the same way.
  assert.match(tryWrite(opened(env, { faultAt: 'cutback_fails' })), /append failed partway/);
  assert.match(tryWrite(o), /append failed partway/);
  assert.deepEqual(kept(env), [], 'the same fault the same day: no second line');
  env.clock.t += DAY;
  assert.match(tryWrite(o), /append failed partway/);
  assert.equal(kept(env).length, 1, 'still failing the next day: told again');
});

test('L575: a different fault the same day is its own telling', () => {
  const env = logOnly();
  seed(env, 'card', 'C-1', card(1));
  assert.match(tryWrite(opened(env, { faultAt: 'cutback_fails' })), /append failed partway/);
  assert.equal(tryWrite(opened(env)), 'written', 'the part-line is cut');
  brokenMiddle(env);
  assert.ok(opened(env).store.damaged());
  assert.equal(new Set(kept(env).map((x) => x.event.reason)).size, 2);
});

test('L575: once the disk works again, the next write cuts the part-line and the Record carries on', () => {
  const env = logOnly();
  seed(env, 'card', 'C-1', card(1));
  const o = opened(env, { faultAt: 'cutback_fails' });
  assert.match(tryWrite(o), /append failed partway/);
  assert.ok(o.store.damaged());
  const well = opened(env);
  assert.equal(tryWrite(well), 'written');
  assert.equal(well.store.damaged(), null);
  assert.equal(kept(env).length, 1, 'the owner was still told once');
});

// ---- L620: a full disk. keep() can't write the warning, so the store holds it in memory; the pass must still tell it ----
const heldRefusal = /store's warnings could not be written to its disk \(is it full\?\) and are held in this process only/;

test('L620: on a full disk the damage is held in memory, the delivery pass tells the owner, and the round is not clean', async () => {
  const env = logOnly();
  brokenMiddle(env);
  const o = opened(env, { faultAt: 'unsent_fails' });
  assert.ok(o.store.damaged());
  assert.match(tryWrite(o), /diary is damaged/);
  assert.deepEqual(kept(env), [], 'nothing reached the file');
  assert.equal(o.record.heldHere().held.filter((x) => x.event.type === 'diary_damaged').length, 1);
  const gh = fakeIssues();
  const r = await deliver(env, o, gh);
  assert.equal(told(gh).length, 1, 'told on a full disk');
  assert.equal(told(gh)[0].assignee, 'owner-login');
  assert.match(r.refused ?? '', heldRefusal, 'a round that holds a warning on no disk is never clean');
});

// ---- #260 r2 M1: a Dispatcher's held warning outlives its process, through the held flag ----

// The Dispatcher's side runs in its own process, which holds the warning on a full disk, tries once more at exit
// (main.mjs's flushHeld, the disk still full) and ends. The robot's pass, in this process, then tells it.
const here = (p) => pathToFileURL(fileURLToPath(new URL(p, import.meta.url))).href;
function dispatcherHolds(root, text, { fault = true } = {}) {
  const src = `
    import { openRecordWithStore } from ${JSON.stringify(here('../modules/M9-record/writer.mjs'))};
    import { PRODUCT, UID, rulesFor } from ${JSON.stringify(here('../modules/M9-record/rules.test-helper.mjs'))};
    import { fakeAlert } from ${JSON.stringify(here('./fake-alert.test-helper.mjs'))};
    import { flushHeld } from ${JSON.stringify(here('../modules/M11-dispatcher/main.mjs'))};
    const o = openRecordWithStore({ root: process.argv[1], product: PRODUCT, ownerUid: UID, rules: rulesFor(), alert: fakeAlert({ answer: false }), now: () => Date.parse('2026-11-05T08:00:00Z'), ...(process.argv[3] === 'fault' ? { faultAt: 'unsent_fails' } : {}) });
    o.record.keepAlert(process.argv[2], 'q6-k');
    flushHeld(o.record, (s) => console.log(s));`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;   // a plain child, not a test file reporting to this runner
  return execFileSync(process.execPath, ['--input-type=module', '-e', src, root, text, fault ? 'fault' : 'real'], { encoding: 'utf8', env });
}

// (a) on a real full disk, both formats the host may use (L664): the store is opened while there is room (its flag
// takes its block), the disk is filled, a Dispatcher process holds a warning and exits, and the robot's round tells it
// with the disk still full: the flag was set and cleared in place. Off unless ORCH_FULLDISK_TEST=1, never in CI.
for (const [fmt, size] of [['HFS+', 4096], ['APFS', 65536]]) {
  test(`#260 r2 M1 a: on a real full ${fmt} RAM disk, a Dispatcher's held warning reaches the owner after it exits`, { skip: process.env.ORCH_FULLDISK_TEST !== '1' }, async () => {
    const { appendFileSync, cpSync, rmSync } = await import('node:fs');
    const dev = execFileSync('hdiutil', ['attach', '-nomount', `ram://${size}`], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    const name = `orch-flag-${process.pid}`;
    try {
      assert.match(dev, /^\/dev\/disk[0-9]+$/, `hdiutil gave ${dev}`);
      execFileSync('diskutil', ['erasevolume', fmt, name, dev], { stdio: 'ignore' });
      const mounted = join('/', 'Volumes', name);
      const env = logOnly();
      const root = join(mounted, 'store');
      cpSync(env.root, root, { recursive: true });
      const env2 = { ...env, root };
      opened(env2).store.damaged();
      assert.equal(readFileSync(join(root, 'held-flag')).length, 4096, 'the flag took its block while there was room');
      const filler = join(mounted, 'filler');
      try { for (;;) appendFileSync(filler, Buffer.alloc(65536, 120)); } catch { /* full */ }
      try { for (;;) appendFileSync(filler, Buffer.alloc(4096, 120)); } catch { /* fuller */ }
      try { for (;;) appendFileSync(filler, 'x'); } catch { /* really full */ }
      const log = dispatcherHolds(root, `#260 r2 ${fmt}: an alert the Dispatcher could not queue`, { fault: false });
      // A second pass on the same full disk merges into the flag in place (#260 r3 M1).
      dispatcherHolds(root, `#260 r3 ${fmt}: a second pass's alert`, { fault: false });
      const flag = readHeldFlag(root);
      const robot = opened(env2);
      const gh = fakeIssues();
      const r = await deliver(env2, robot, gh);
      console.log(`#260 r2 ${fmt}: dispatcher said ${JSON.stringify(log.trim())}; flag ${JSON.stringify(flag?.flag ?? null)}; pass ${JSON.stringify(r)}; flag after ${JSON.stringify(readHeldFlag(root))}`);
      assert.equal(flag?.flag?.held, 1, 'the flag was set on the full disk');
      assert.equal(heldHolders(flag?.flag).length, 2, 'and the second pass merged in on the full disk');
      assert.ok([...gh.issues.values()].some((x) => x.body.includes(`#260 r2 ${fmt}: an alert`)), 'told');
      assert.match(r.refused ?? '', /2 processes on this store held 2 warning\(s\) in all in their memory only/);
      assert.equal(readHeldFlag(root), null, 'cleared in place on the full disk');
      rmSync(filler, { force: true });
    } finally {
      try { execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' }); } catch { /* detached already */ }
    }
  });
}

test('#260 r2 M1 (Q6): a warning a Dispatcher held on a full disk is told by the robot\'s next round after it exits, then the flag is down', async () => {
  const env = logOnly();
  const log = dispatcherHolds(env.root, 'Q6: an alert the Dispatcher could not queue');
  assert.match(log, /dispatcher: 1 warning\(s\) the store could not write are held in this process only and end with it; the held flag tells the robot's alert pass/);
  assert.equal(readUnsent(env.root).length, 0, 'nothing reached the file');
  const robot = opened(env);
  const gh = fakeIssues();
  const r = await deliver(env, robot, gh);
  assert.ok([...gh.issues.values()].some((x) => /Q6: an alert the Dispatcher could not queue/.test(x.body)), 'told');
  assert.match(r.refused ?? '', /process \d+ on this store held 1 warning\(s\) in its memory only/, 'the told round is not clean');
  assert.equal(readHeldFlag(env.root), null);
  env.clock.t += 5 * 60_000;
  const r2 = await deliver(env, robot, gh);
  assert.equal(r2.refused, undefined, 'the next round is clean');
});

// ---- #260 r3 M1: several processes hold on one full-disk spell; the flag keeps every one ----

const bodiesOf = (gh) => [...gh.issues.values()].map((x) => x.body).join('\n----\n');

test('#260 r3 M1 (S1): two Dispatcher passes each hold a warning on a full disk; the robot round tells the first and names both, with the total', async () => {
  const env = logOnly();
  opened(env).store.damaged();
  dispatcherHolds(env.root, 'S1-A: the first pass could not queue this');
  const pidA = readHeldFlag(env.root).flag.pid;
  dispatcherHolds(env.root, 'S1-B: the second pass could not queue this');
  const f = readHeldFlag(env.root).flag;
  assert.deepEqual(heldHolders(f).map((h) => h.pid).length, 2, 'the second pass merged in, it did not overwrite');
  const pidB = f.also[0].pid;
  assert.notEqual(pidA, pidB);
  assert.equal(f.pid, pidA, 'the first pass stays first');
  assert.match(f.event.text, /S1-A/);
  const gh = fakeIssues();
  const r = await deliver(env, opened(env), gh);
  assert.match(bodiesOf(gh), /S1-A/, 'the first warning is told');
  assert.match(r.refused ?? '', new RegExp(`2 processes on this store held 2 warning\\(s\\) in all in their memory only.*process ${pidA}.*process ${pidB}.*the first is told this round, and the others are lost if those processes have stopped`));
  assert.equal(readHeldFlag(env.root), null, 'cleared once told');
});

test('#260 r3 M1 (S2): a robot process that holds its own warning does not wipe the Dispatcher\'s flag; both are told', async () => {
  const env = logOnly();
  opened(env).store.damaged();
  dispatcherHolds(env.root, 'S2-A: the Dispatcher could not queue this');
  const pidA = readHeldFlag(env.root).flag.pid;
  let full = true;
  const robot = opened(env, { faultAt: { step: 'unsent_fails', while: () => full } });
  robot.record.keepAlert('S2-R: the robot could not queue this', 'S2-R');
  const mid = readHeldFlag(env.root).flag;
  assert.deepEqual(heldHolders(mid).map((h) => h.pid), [pidA, process.pid], 'the robot merged in behind the Dispatcher');
  full = false;
  const gh = fakeIssues();
  const r = await deliver(env, robot, gh);
  assert.match(bodiesOf(gh), /S2-R/, 'the robot\'s own is told');
  assert.match(bodiesOf(gh), /S2-A/, 'the Dispatcher\'s is told');
  assert.match(r.refused ?? '', new RegExp(`process ${pidA} on this store held 1 warning\\(s\\) in its memory only`), 'the round is not clean');
  assert.equal(readHeldFlag(env.root), null);
});

// R1b (audit #260 r4 m1): another writer's merge, built from a read taken just before this writer's update, lands just
// after it and puts this writer's older entry back. The settle re-read must see the stale copy and merge again.
test('#260 r4 m1 (R1b): a stale merge that undoes a holder\'s new count is caught by the settle re-read, so no warning is left uncounted', async () => {
  const env = logOnly();
  opened(env).store.damaged();
  const ev = (text) => ({ type: 'alert_not_queued', text });
  const A1 = { pid: 41, token: 'tA', at: 'T1', held: 1, dropped: 0, id: 'W1', event: ev('R1b-W1') };
  setHeldFlag(env.root, A1);
  const v1 = readHeldFlag(env.root).raw;
  const side = tempDir('orch-r4side-'); makeHeldFlag(side); writeFileSync(join(side, HELD_FLAG), v1);
  setHeldFlag(side, { pid: 42, token: 'tB', at: 'T2', held: 1, dropped: 0, id: 'WB', event: ev('R1b-WB') }, { settleMs: 0 });
  const bWrites = readFileSync(join(side, HELD_FLAG));
  setHeldFlag(env.root, { ...A1, held: 2 }, { afterWrite: (i) => { if (i === 0) writeFileSync(join(env.root, HELD_FLAG), bWrites); } });
  const f = readHeldFlag(env.root).flag;
  assert.equal(f.held, 2, 'A holds 2, not the stale 1');
  assert.deepEqual(f.total, { holders: 2, held: 3, dropped: 0 });
  const gh = fakeIssues();
  const r = await deliver(env, opened(env), gh);
  assert.match(r.refused ?? '', /2 processes on this store held 3 warning\(s\) in all/);
});

// The same on a real full disk (audit #242 r1 P15). It mounts its own 2 MB RAM disk as the user (no sudo, nothing
// installed), fills it, and detaches it in finally. Off unless ORCH_FULLDISK_TEST=1, and never in CI (L647).
test('L620: on a real full RAM disk the damage reaches the owner and the round is not clean', { skip: process.env.ORCH_FULLDISK_TEST !== '1' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { appendFileSync, cpSync, rmSync } = await import('node:fs');
  const dev = execFileSync('hdiutil', ['attach', '-nomount', 'ram://4096'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  const name = `orch-l620-${process.pid}`;
  try {
    assert.match(dev, /^\/dev\/disk[0-9]+$/, `hdiutil gave ${dev}`);   // inside the try, so a bad name is still detached (#260 r1 c2)
    execFileSync('diskutil', ['erasevolume', 'HFS+', name, dev], { stdio: 'ignore' });
    const mounted = join('/', 'Volumes', name);
    const env = logOnly();
    brokenMiddle(env);
    const root = join(mounted, 'store');
    cpSync(env.root, root, { recursive: true });
    // An unsent file with history, ending part-way into a block, as any store that has run a while has: on a full disk
    // a write into that block's room lands only part of a line (#260 r1 M1). An empty file owns no block to land in.
    let seeded = '';
    for (let i = 0; seeded.length < 3800; i += 1) seeded += `${JSON.stringify({ id: `seed${String(i).padStart(4, '0')}`, outcome: 'sent', at: '2026-11-01T00:00:00Z' })}\n`;
    writeFileSync(join(root, 'unsent-alerts.jsonl'), seeded);
    const filler = join(mounted, 'filler');
    const chunk = Buffer.alloc(4096, 120);
    try { for (;;) appendFileSync(filler, chunk); } catch { /* full */ }
    try { for (;;) appendFileSync(filler, 'x'); } catch { /* really full */ }
    const env2 = { ...env, root };
    let o; let err = null;
    try { o = opened(env2); o.store.damaged(); } catch (e) { err = e.message; }
    assert.equal(err, null, 'the store opens on a full disk');
    const held = o.record.heldHere();
    const gh = fakeIssues();
    const r = await deliver(env2, o, gh);
    console.log(`L620 real full disk: held ${JSON.stringify(held.held.map((x) => x.event.type))} dropped ${held.dropped}; on file ${readUnsent(root).length}; pass ${JSON.stringify(r)}; issues ${[...gh.issues.values()].map((x) => x.title).join(' | ')}`);
    assert.equal(told(gh).length, 1, 'told on a full disk');
    assert.match(r.refused ?? '', heldRefusal);
    assert.match(r.refused ?? '', /the store's disk is full \(ENOSPC\)/);
    const text = readFileSync(join(root, 'unsent-alerts.jsonl'), 'utf8');
    assert.ok(text.startsWith(seeded) && text.endsWith('\n'), 'no part line was left on the file');
    // The disk frees: the held line goes back to the file, is sent from there, and the round is clean.
    rmSync(filler, { force: true });
    const r2 = await deliver(env2, o, gh);
    console.log(`L620 real full disk, freed: pass ${JSON.stringify(r2)}; held ${o.record.heldHere().held.length}`);
    assert.equal(o.record.heldHere().held.length, 0);
    assert.equal(r2.refused, undefined);
  } finally {
    try { execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' }); } catch { /* detached already */ }
  }
});

test('#260 r2 M1 b: main() tries the store\'s held lines once more as the Dispatcher exits, and logs what is still held', async () => {
  const { installedLayout } = await import('../shared/job-config.test-helper.mjs');
  const { main } = await import('../modules/M11-dispatcher/main.mjs');
  const L = installedLayout('orch-flush-', { dirs: ['wiring'] });
  const self = L.write('modules/M11-dispatcher/main.mjs', 'export {};\n');
  const m11 = fileURLToPath(new URL('../modules/M11-dispatcher/', import.meta.url));
  const wiring = L.path('wiring/wiring.mjs');
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(m11, 'fixtures.test-helper.mjs'))};
const base = recWith();
const rec = { ...base, read: (...a) => base.read(...a), write: (...a) => base.write(...a), heldHere: () => ({ held: [{ id: 'h1', event: { type: 'diary_damaged' } }], dropped: 2, disk: 'full' }) };
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: () => {}, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    proposals: () => ({ products: [], ownerUid: 501 }),
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(L.base)}, sealRoot: ${JSON.stringify(L.base)}, mirrorFor: () => null }, approvals: () => [] } };
}
`);
  const config = L.path('config.json');
  writeFileSync(config, JSON.stringify({ installRoot: L.installRoot, wiring, lockFile: join(L.base, 'pass.lock') }));
  const logs = [];
  const code = await main([config], { self, now: Date.parse('2026-11-05T08:00:00Z'), log: (s) => logs.push(s) });
  assert.equal(code, 0, logs.join(' | '));
  // This line comes only from heldHere's answer, so it also shows heldHere was asked.
  assert.ok(logs.includes('dispatcher: 1 warning(s) the store could not write and 2 lost count(s) are held in this process only and end with it; the held flag tells the robot\'s alert pass'), logs.join(' | '));
});

test('#260 r2 M1 b: the exit flush never throws; an error or a throw is logged', async () => {
  const { flushHeld } = await import('../modules/M11-dispatcher/main.mjs');
  const logs = [];
  flushHeld({ heldHere: () => ({ error: 'boom' }) }, (s) => logs.push(s));
  flushHeld({ heldHere: () => { throw new Error('bang'); } }, (s) => logs.push(s));
  flushHeld({ heldHere: () => ({ held: [], dropped: 0, disk: null }) }, (s) => logs.push(s));
  flushHeld({}, (s) => logs.push(s));
  assert.deepEqual(logs, ['dispatcher: what the store holds in memory could not be read: boom', 'dispatcher: the store\'s held warnings could not be tried again: bang']);
});
