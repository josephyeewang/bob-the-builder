// diary-damaged-told.test.mjs — L575: a Record that stops taking writes because its diary is damaged reaches the owner.
//
// WHY. `diary_damaged` went through plain `say`, which only logs in production, and every write then refused: the whole
// Record stopped and nobody heard. Both sites now keep the alert in the store's unsent file, once a day, since every open
// finds the damage again and each kept line is one GitHub issue. This runs the real store and M13's real delivery pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { fakeIssues } from '../modules/M13-ledger/alerts.mjs';
import { deliverAlertsPass } from '../modules/M13-ledger/alert-channel.mjs';
import { openRecordWithStore } from '../modules/M9-record/writer.mjs';
import { readUnsent } from '../modules/M9-record/unsent.mjs';
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

// The same on a real full disk (audit #242 r1 P15). It mounts its own 2 MB RAM disk as the user (no sudo, nothing
// installed), fills it, and detaches it in finally. Off unless ORCH_FULLDISK_TEST=1, and never in CI (L647).
test('L620: on a real full RAM disk the damage reaches the owner and the round is not clean', { skip: process.env.ORCH_FULLDISK_TEST !== '1' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { appendFileSync, cpSync, rmSync } = await import('node:fs');
  const dev = execFileSync('hdiutil', ['attach', '-nomount', 'ram://4096'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  assert.match(dev, /^\/dev\/disk[0-9]+$/, `hdiutil gave ${dev}`);
  const name = `orch-l620-${process.pid}`;
  try {
    execFileSync('diskutil', ['erasevolume', 'HFS+', name, dev], { stdio: 'ignore' });
    const mounted = join('/', 'Volumes', name);
    const env = logOnly();
    brokenMiddle(env);
    const root = join(mounted, 'store');
    cpSync(env.root, root, { recursive: true });
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
    rmSync(filler, { force: true });
  } finally {
    try { execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' }); } catch { /* detached already */ }
  }
});
