// round-cap.test.mjs — the failure ladder's stop, end to end (R-1-75 first half, R-1-24 "stop at the third strike";
// pinned by L1087 before those rows are built). A card that keeps failing is fixed by a chain of fix cards. M9's writer
// numbers each round from the chain (writer.mjs checkNewCard) and creates the one past caps.rounds straight into a wait
// on Joe. This drives the Dispatcher's real start step against the real Record (M9 openRecord in a temp folder):
// rounds 1, 2 and 3 each start, and round 4 never reaches the launcher; it waits on Joe with what he can do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatcherPass } from './pass.mjs';
import { USAGE_FACT } from './usage.mjs';
import { retellWaits } from './joe-waits.mjs';
import { rulesWith, usageFact, withAlerts } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, go, put, must, seed, plan, HEAD, PRODUCT } from '../M9-record/fixtures.test-helper.mjs';

const MIN = 60_000;
const ACCT = 'acct-a';
const HOST = 'mac-a';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };

function world(values) {
  const env = setup({ prefix: 'm11-roundcap-', probe: { kill() {}, pidStart: () => 'start' }, host: HOST, values });
  const rec = env.record;
  product(env);
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  must(rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: env.clock.t }) }), 'usage');
  const launched = [];
  let n = 0;
  const pass = () => withAlerts(rec, env.clock.t, () => {}, (alert) => dispatcherPass({
    rec, rules, now: env.clock.t, account: ACCT, sessions: [], probe: () => idle, host: HOST,
    launch: async (x) => { n += 1; launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, pid: 1000 + n, pidStart: 'start', pgid: 100 + n, head: HEAD, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}` }; },
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: true }), filesOf: () => [], alert,
  }));
  // The attempt failed (its tests failed): the card ends `failed`, the state a fix card fixes. Seeded, as M9's own
  // round-cap tests do; who records a failure is not what this file tests.
  const fail = (id) => seed(env, 'card', id, { ...rec.read('card', id).doc, state: 'failed' });
  // The next round: a fix card of the failed one, through the real writer (which numbers the round), with its go.
  const fixOf = (id, parent) => {
    must(rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'fix', fix_of: parent, ...plan() } }), `fix ${id}`);
    const doc = rec.read('card', id).doc;
    if (doc.state === 'draft') { go(env, id, doc); must(put(rec, 'dispatcher', 'card', id, { state: 'ready' }), `${id} ready`); }
    return rec.read('card', id).doc;
  };
  return { env, rec, launched, pass, fail, fixOf };
}

test('R-1-75 / R-1-24: a card failing three times starts rounds 1-3; round 4 never reaches the launcher and waits on Joe', async () => {
  const w = world();
  readyCard(w.env, 'C-1');
  assert.deepEqual((await w.pass()).started, ['C-1'], 'round 1 starts');
  assert.equal(w.rec.read('card', 'C-1').doc.round, 1);
  w.fail('C-1');

  let parent = 'C-1';
  for (const [id, round] of [['F-2', 2], ['F-3', 3]]) {
    const f = w.fixOf(id, parent);
    assert.equal(f.round, round, `${id} is round ${round}, numbered by the writer from the chain`);
    assert.equal(f.state, 'ready');
    w.env.clock.t += MIN;
    assert.deepEqual((await w.pass()).started, [id], `round ${round} starts`);
    w.fail(id);
    parent = id;
  }

  const f4 = w.fixOf('F-4', parent);
  assert.equal(f4.round, 4);
  assert.equal(f4.state, 'waiting', 'round 4 is created waiting, not ready');
  assert.equal(f4.wait.who, 'joe');
  assert.equal(f4.wait.what, 'round cap');
  assert.match(f4.wait.reason, /round 4 is over the cap of 3; the owner cancels it, or the Lead makes a new card with a new go/);
  w.env.clock.t += MIN;
  const r = await w.pass();
  assert.deepEqual(r.started, [], 'nothing starts at round 4');
  assert.deepEqual(w.launched, ['C-1', 'F-2', 'F-3'], 'the launcher was asked for rounds 1-3 only');
  assert.equal(w.rec.read('card', 'F-4').doc.state, 'waiting');

  // Joe hears it: the waits sweep tells the round-cap wait, with what he can do.
  const got = [];
  w.env.clock.t += MIN;
  await withAlerts(w.rec, w.env.clock.t, (t) => { got.push(typeof t === 'string' ? t : t.text); return true; }, (alert) => retellWaits({ rec: w.rec, alert, now: w.env.clock.t }));
  assert.deepEqual(got, [`card F-4 waits on you (round cap): ${f4.wait.reason}. Answer it through the Front Door`]);
});

test('R-1-75: a round cap of 2 stops before round 3 (the cap is the rules value, not a fixed 3)', async () => {
  const w = world({ 'caps.rounds': 2 });
  readyCard(w.env, 'C-1');
  assert.deepEqual((await w.pass()).started, ['C-1']);
  w.fail('C-1');
  assert.equal(w.fixOf('F-2', 'C-1').state, 'ready');
  w.env.clock.t += MIN;
  assert.deepEqual((await w.pass()).started, ['F-2']);
  w.fail('F-2');
  const f3 = w.fixOf('F-3', 'F-2');
  assert.equal(f3.state, 'waiting');
  assert.match(f3.wait.reason, /round 3 is over the cap of 2/);
  w.env.clock.t += MIN;
  assert.deepEqual((await w.pass()).started, []);
  assert.deepEqual(w.launched, ['C-1', 'F-2']);
});
