import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatProbes } from './heartbeat-probes.mjs';
import { ACCOUNT_FACT, LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { FACTS } from '../modules/M11-dispatcher/phone-link.mjs';
import { USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { KEYS as K } from '../modules/M11-dispatcher/keys.mjs';
import { factFamilyOf } from '../modules/M9-record/permissions.mjs';
import { rulesWith, recWith, T0, MIN, iso } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';

const STALE_MIN = 30;
const rules = () => rulesWith({ [K.staleAfterMin]: STALE_MIN });
const setUp = (facts = [], { labels } = {}) => {
  const rec = recWith([]);
  for (const [id, doc, actor] of facts) {
    const r = rec.write({ actor: actor ?? factFamilyOf(id), entity: 'fact', id, expectRev: 0, doc });
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
  }
  return heartbeatProbes({ rec, rules: rules(), now: () => T0, labels });
};
const seen = (min = 0) => iso(T0 - min * MIN);
const signedIn = (account = 'a', min = 0) => [ACCOUNT_FACT, { account, observed_at: seen(min) }];
const reach = (value, min = 0) => [FACTS.reachable, { value, observed_at: seen(min) }];
const usage = (h5, week, min = 0) => [USAGE_FACT('a'), { account: 'a', observed_at: seen(min),
  h5: { used_pct: h5, resets_at: iso(T0 + 60 * MIN) }, week: { used_pct: week, resets_at: iso(T0 + 2880 * MIN) } }];

test('with no Sensors running, everything the Sensors feed says not known, never a pass', async () => {
  const p = setUp();
  assert.equal(await p.frontDoorReachable(), null);
  assert.equal(await p.account(), null);
  assert.equal(await p.usage(), null);
});

test('Front Door: a current reading is said, an old or undecided one is not known', async () => {
  assert.equal(await setUp([reach(true, 4)]).frontDoorReachable(), true);
  assert.equal(await setUp([reach(false, 4)]).frontDoorReachable(), false);
  assert.equal(await setUp([reach(true, 6)]).frontDoorReachable(), null);
  assert.equal(await setUp([reach(null)]).frontDoorReachable(), null);
  assert.equal(await setUp([reach('yes')]).frontDoorReachable(), null, 'a value that is neither');
  assert.equal(await setUp([reach(true, -5)]).frontDoorReachable(), null, 'a reading from the future');
});

test('account: a name is signed in, a current "nobody" is signed out, an old reading is not known', async () => {
  assert.deepEqual(await setUp([signedIn('b')]).account(), { signedIn: true, login: 'b' });
  assert.deepEqual(await setUp([signedIn('b')], { labels: { b: 'account B' } }).account(), { signedIn: true, login: 'account B' });
  assert.deepEqual(await setUp([signedIn(null)]).account(), { signedIn: false, login: null });
  assert.equal(await setUp([signedIn('a', STALE_MIN + 1)]).account(), null);
});

test('a reading Sensors did not make does not count', async () => {
  const made = recWith([]);
  assert.equal(made.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: 'a', observed_at: seen() } }).ok, true);
  const probesOf = (createdBy) => heartbeatProbes({ rec: { read: made.read.bind(made), meta: () => ({ createdBy }) }, rules: rules(), now: () => T0 });
  assert.deepEqual(await probesOf('sensors').account(), { signedIn: true, login: 'a' });
  assert.equal(await probesOf('ledger').account(), null);
});

test('rules with no age limit: nothing can be called current, so the account is not known, and it does not throw', async () => {
  const rec = recWith([]);
  rec.write({ actor: 'sensors', entity: 'fact', id: ACCOUNT_FACT, expectRev: 0, doc: { account: 'a', observed_at: seen() } });
  const none = { ...rules(), get: () => undefined, num: () => { throw new Error('no value'); } };
  const p = heartbeatProbes({ rec, rules: none, now: () => T0 });
  assert.equal(await p.account(), null);
  assert.equal(await p.usage(), null);
});

test('usage: the fuller window, for the account signed in; a stale or missing one is not known', async () => {
  assert.deepEqual(await setUp([signedIn(), usage(80, 40)]).usage(), { window: '5-hour', pct: 80 });
  assert.deepEqual(await setUp([signedIn(), usage(40, 80)]).usage(), { window: 'weekly', pct: 80 });
  assert.equal(await setUp([signedIn(), usage(80, 40, STALE_MIN + 1)]).usage(), null);
  assert.equal(await setUp([signedIn('b'), usage(80, 40)]).usage(), null, 'another account\'s reading');
  assert.equal(await setUp([usage(80, 40)]).usage(), null);
});

test('the Dispatcher\'s last good pass is its own fact, or nothing', async () => {
  assert.equal(await setUp().dispatcherLastGood(), null);
  const at = iso(T0);
  assert.equal(await setUp([[LAST_PASS_FACT, { at }]]).dispatcherLastGood(), at);
});
