// stop-reaches-owner.test.mjs — L583: a Record that stops itself reaches the owner.
//
// WHY. recovery_stopped went through a plain send, which only logs in production, so a store that refused every write told
// nobody. It is now kept in the unsent file once a day and sent by the delivery pass, as in L575. A store_layout stop is
// not kept (see store.mjs recoverOrStop); robot-wiring.test.mjs runs its path. This uses the real store and real delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { fakeIssues } from '../modules/M13-ledger/alerts.mjs';
import { deliverAlertsPass } from '../modules/M13-ledger/alert-channel.mjs';
import { openRecordWithStore } from '../modules/M9-record/writer.mjs';
import { readUnsent } from '../modules/M9-record/unsent.mjs';
import { PRODUCT, UID, setup } from '../modules/M9-record/fixtures.test-helper.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Recovery lists tmp/, so a tmp/ it may not read stops it, outside any one document's skip. Opening sets the folder's mode
// back, so this comes after the open.
const noTmp = (env) => chmodSync(join(env.root, 'tmp'), 0o000);
const opened = (env, alert = fakeAlert({ answer: false })) => {
  chmodSync(join(env.root, 'tmp'), 0o755);
  const o = openRecordWithStore({ root: env.root, product: PRODUCT, ownerUid: UID, rules: env.rules, alert, now: () => env.clock.t });
  noTmp(env);
  return o;
};
const kept = (env) => readUnsent(env.root).filter((x) => x.event.type === 'recovery_stopped');
const tryWrite = (o) => {
  try { const r = o.record.write({ actor: 'dispatcher', entity: 'fact', id: 'stop-hb-T-3-1', expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-3' } }); return r.ok ? 'written' : r.reason; } catch (e) { return e.message; }
};
function stopped() {
  const env = setup({ prefix: 'orch-stopped-', extra: { alert: fakeAlert({ answer: false }) } });
  return { env, restore: () => chmodSync(join(env.root, 'tmp'), 0o755) };
}
const sent = (alert) => alert.texts.filter((x) => x.type === 'recovery_stopped');

test('L583: recovery_stopped reaches the owner through the delivery pass, with the Record refusing writes', async () => {
  const { env, restore } = stopped();
  try {
    const o = opened(env);
    assert.match(tryWrite(o), /recovery stopped/, 'writes refuse');
    assert.equal(kept(env).length, 1);
    const gh = fakeIssues();
    const r = await deliverAlertsPass({ rec: o.record, now: () => env.clock.t, recordRoot: env.root, product: PRODUCT, products: [PRODUCT],
      repos: { [PRODUCT]: 'acme/product-1' }, owner: 'owner-login', issuesFor: () => gh, lockWaitMs: 30 });
    assert.equal(r.refused, undefined);
    const issues = [...gh.issues.values()].filter((x) => /recovery_stopped/.test(x.body));
    assert.equal(issues.length, 1);
    assert.match(issues[0].body, /recovery stopped/);
    assert.equal(kept(env).length, 0, 'delivered, so no longer waiting');
    tryWrite(opened(env));
    assert.equal(kept(env).length, 0, 'a delivered line still holds for the day');
  } finally { restore(); }
});

test('L583: every write and open in a day keep one line; the next day keeps another', () => {
  const { env, restore } = stopped();
  try {
    const o = opened(env);
    for (let i = 0; i < 4; i++) tryWrite(o);
    tryWrite(opened(env));
    assert.equal(kept(env).length, 1);
    env.clock.t += DAY + 1;
    tryWrite(opened(env));
    assert.equal(kept(env).length, 2);
  } finally { restore(); }
});

test('L583: an alert that arrives keeps nothing, and a lost one is still sent again on each try', () => {
  const { env, restore } = stopped();
  try {
    const good = fakeAlert({ answer: true });
    tryWrite(opened(env, good));
    assert.equal(kept(env).length, 0);
    assert.equal(sent(good).length, 1);
    for (const mode of [{ answer: false }, { throws: 'down' }]) {
      const lost = fakeAlert(mode);
      const o = opened(env, lost);
      tryWrite(o); tryWrite(o);
      assert.equal(sent(lost).filter((x) => !x.resent).length, 2, 'not delivered, so asked again');
    }
    assert.equal(kept(env).length, 1, 'kept once');
  } finally { restore(); }
});

test('L583: a stop carries its type and reason on the error, for a job that has no store to tell from', () => {
  const { env, restore } = stopped();
  try {
    let err;
    try { opened(env).store.transaction(() => {}); } catch (e) { err = e; }
    assert.equal(err?.stop?.type, 'recovery_stopped');
    assert.match(err?.stop?.reason, /recovery stopped/);
  } finally { restore(); }
});
