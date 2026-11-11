import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatProbes, EVERY_PASS } from './heartbeat-probes.mjs';
import { LOOP } from '../modules/M12-sensors/loop.mjs';
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
// A reading in the account fact's full form (state-facts writeSignedInAccount, L730): signed_in and its reason.
const said = (fields, min = 0) => [ACCOUNT_FACT, { ...fields, observed_at: seen(min) }];
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

test('account: a name is signed in; signed out only when the reading says so; an empty account is otherwise not known', async () => {
  assert.deepEqual(await setUp([signedIn('b')]).account(), { signedIn: true, login: 'b' });
  assert.deepEqual(await setUp([signedIn('b')], { labels: { b: 'account B' } }).account(), { signedIn: true, login: 'account B' });
  assert.deepEqual(await setUp([said({ account: 'b', signed_in: true })]).account(), { signedIn: true, login: 'b' });
  assert.equal(await setUp([signedIn('a', STALE_MIN + 1)]).account(), null);
  // L730 (#289 r1 M1, reversed): a current empty account is NOT signed out unless the reading says signed_in false.
  assert.equal(await setUp([signedIn(null)]).account(), null, 'an old-form null (a failed read, or nobody): not known');
  assert.equal(await setUp([signedIn('')]).account(), null, 'an empty name: not known');
  assert.deepEqual(await setUp([said({ signed_in: false })]).account(), { signedIn: false, login: null }, 'signed_in false with no account field is said in so many words');
  assert.equal(await setUp([said({ account: null, signed_in: null, reason: 'claude auth status timed out' })]).account(), null, 'could not tell');
  assert.deepEqual(await setUp([said({ account: null, signed_in: false, reason: 'nobody is signed in' })]).account(), { signedIn: false, login: null });
  assert.equal(await setUp([said({ account: 'a', signed_in: null })]).account(), null, 'a name with could-not-tell is not known');
  assert.equal(await setUp([said({ account: 'a', signed_in: false })]).account(), null, 'a name with signed out contradicts itself: not known');
});

test('a reading Sensors did not make does not count: the account, the Front Door and usage, each on its own', async () => {
  const made = recWith([]);
  for (const [id, doc] of [signedIn('a'), reach(true), usage(40, 10)]) {
    const r = made.write({ actor: factFamilyOf(id), entity: 'fact', id, expectRev: 0, doc });
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
  }
  // Who made each fact, as the Record would say; one fact at a time is said to be someone else's (plant H10).
  const probesOf = (by = {}) => heartbeatProbes({ rec: { read: made.read.bind(made), meta: (_e, id) => ({ createdBy: by[id] ?? 'sensors' }) },
    rules: rules(), now: () => T0 });
  const all = probesOf();
  assert.deepEqual(await all.account(), { signedIn: true, login: 'a' });
  assert.equal(await all.frontDoorReachable(), true);
  assert.notEqual(await all.usage(), null);
  assert.equal(await probesOf({ [ACCOUNT_FACT]: 'ledger' }).account(), null);
  assert.equal(await probesOf({ [FACTS.reachable]: 'ledger' }).frontDoorReachable(), null);
  assert.equal(await probesOf({ [USAGE_FACT('a')]: 'ledger' }).usage(), null);
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
  assert.equal(await setUp([said({ account: 'a', signed_in: null }), usage(80, 40)]).usage(), null, 'not known who is signed in: no usage');
  assert.equal(await setUp([said({ account: 'a', signed_in: false }), usage(80, 40)]).usage(), null);
});

test('the Dispatcher\'s last good pass is its own fact, or nothing', async () => {
  assert.equal(await setUp().dispatcherLastGood(), null);
  const at = iso(T0);
  assert.equal(await setUp([[LAST_PASS_FACT, { at }]]).dispatcherLastGood(), at);
});

test('#451 r1 m3: a Record read or meta that throws is not known, never "not reachable" or "signed out"', async () => {
  const boom = () => { throw new Error('the store could not be read'); };
  // Each fact present and current, so a read that did not throw would say true, signed in and a usage.
  const full = () => {
    const rec = recWith([]);
    for (const [id, doc] of [reach(true), signedIn('a'), usage(10, 20)]) assert.equal(rec.write({ actor: factFamilyOf(id), entity: 'fact', id, expectRev: 0, doc }).ok, true);
    return rec;
  };
  const good = heartbeatProbes({ rec: full(), rules: rules(), now: () => T0 });
  assert.equal(await good.frontDoorReachable(), true, 'the control reads every fact');
  assert.equal((await good.account())?.signedIn, true);
  assert.ok(await good.usage());
  for (const rec of [{ read: boom, meta: boom }, { ...full(), read: boom }, { ...full(), meta: boom }]) {
    const p = heartbeatProbes({ rec, rules: rules(), now: () => T0 });
    assert.equal(await p.frontDoorReachable(), null);
    assert.equal(await p.account(), null);
    assert.equal(await p.usage(), null);
  }
});

// ── Sensors alive (L967, L969) ───────────────────────────────────────────────────────────────────────────────────────

const wrote = (id, min) => [id, { value: true, observed_at: seen(min) }];

test('L969: sensorsAlive is the newest Sensors reading\'s age, held to usage.stale_after_min', async () => {
  assert.deepEqual(await setUp([wrote('network-up', 3)]).sensorsAlive(), { ageMin: 3, limitMin: STALE_MIN, stale: false });
  // The newest of them counts, whatever each reading says (a false or an unknown one is still the job writing).
  assert.deepEqual(await setUp([wrote('network-up', 50), said({ account: null, signed_in: null }, 7), [FACTS.minibase, { value: null, observed_at: seen(40) }]]).sensorsAlive(),
    { ageMin: 7, limitMin: STALE_MIN, stale: false });
  assert.deepEqual(await setUp([wrote('frontdoor-reachable', 45)]).sensorsAlive(), { ageMin: 45, limitMin: STALE_MIN, stale: true }, 'old is still known, and stale');
  for (const id of EVERY_PASS) assert.deepEqual(await setUp([wrote(id, 2)]).sensorsAlive(), { ageMin: 2, limitMin: STALE_MIN, stale: false }, id);
});

test('L969 review m1: stale is decided in milliseconds, as the Dispatcher\'s account hold decides it', async () => {
  const at = (ms) => setUp([['network-up', { value: true, observed_at: iso(T0 - ms) }]]).sensorsAlive();
  assert.deepEqual(await at(STALE_MIN * MIN), { ageMin: STALE_MIN, limitMin: STALE_MIN, stale: false }, 'at the limit is not past it');
  assert.deepEqual(await at(STALE_MIN * MIN + 1000), { ageMin: STALE_MIN, limitMin: STALE_MIN, stale: true }, 'a second past it is stale, though the minutes still read the limit');
});

test('L969: sensorsAlive is not known with no reading yet, no limit in the rules, a reading from the future, or one Sensors did not make', async () => {
  assert.equal(await setUp().sensorsAlive(), null, 'a Mini that has never run the Sensors job');
  assert.equal(await setUp([wrote('network-up', -5)]).sensorsAlive(), null, 'a reading from the future');
  const made = recWith([]);
  assert.equal(made.write({ actor: 'sensors', entity: 'fact', id: 'network-up', expectRev: 0, doc: { value: true, observed_at: seen(1) } }).ok, true);
  const by = (who) => heartbeatProbes({ rec: { read: made.read.bind(made), meta: () => ({ createdBy: who }) }, rules: rules(), now: () => T0 });
  assert.deepEqual(await by('sensors').sensorsAlive(), { ageMin: 1, limitMin: STALE_MIN, stale: false }, 'the control');
  assert.equal(await by('ledger').sensorsAlive(), null, 'a reading Sensors did not make');
  const rec = recWith([]);
  assert.equal(rec.write({ actor: 'sensors', entity: 'fact', id: 'network-up', expectRev: 0, doc: { value: true, observed_at: seen(1) } }).ok, true);
  assert.equal(await heartbeatProbes({ rec, rules: { ...rules(), get: () => undefined, num: () => { throw new Error('no value'); } }, now: () => T0 }).sensorsAlive(), null, 'no usage.stale_after_min');
  assert.equal(await heartbeatProbes({ rec: { read: () => { throw new Error('x'); } }, rules: rules(), now: () => T0 }).sensorsAlive(), null, 'a read that throws');
  // Usage and pull-request readings are per account or per PR, and not written every pass; they do not count.
  assert.equal(await setUp([usage(10, 10, 1)]).sensorsAlive(), null);
});

test('L969: EVERY_PASS is exactly the families the Sensors loop writes every pass with no suffix', () => {
  const every = Object.entries(LOOP).filter(([fam, how]) => !fam.endsWith('-') && /^every pass:/.test(how)).map(([fam]) => fam).sort();
  assert.deepEqual([...EVERY_PASS].sort(), every);
});
