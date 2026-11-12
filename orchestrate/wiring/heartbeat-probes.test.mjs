import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatProbes, EVERY_PASS, FUTURE_MS, GRACE_MS } from './heartbeat-probes.mjs';
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
const UP = () => 3_600_000;
const sensorsOf = (facts, over = {}) => {
  const rec = recWith([]);
  for (const [id, doc, actor] of facts) assert.equal(rec.write({ actor: actor ?? factFamilyOf(id), entity: 'fact', id, expectRev: 0, doc }).ok, true, id);
  return heartbeatProbes({ rec, rules: rules(), now: () => T0, upMs: UP, ...over }).sensorsAlive();
};
const fresh = (min, acc = min) => ({ ageMin: min, limitMin: STALE_MIN, stale: min > STALE_MIN, newestAt: seen(min),
  account: acc === null ? { ageMin: null, stale: true, at: null } : { ageMin: acc, stale: acc > STALE_MIN, at: seen(acc) } });

test('L969: sensorsAlive is the newest Sensors reading\'s age, held to usage.stale_after_min, with the account reading\'s own', async () => {
  assert.deepEqual(await sensorsOf([wrote('network-up', 3), signedIn('a', 3)]), fresh(3));
  // The newest of them counts, whatever each reading says (a false or an unknown one is still the job writing).
  assert.deepEqual(await sensorsOf([wrote('network-up', 50), said({ account: null, signed_in: null }, 7), [FACTS.minibase, { value: null, observed_at: seen(40) }]]), fresh(7));
  assert.deepEqual(await sensorsOf([wrote('frontdoor-reachable', 45), signedIn('a', 45)]), fresh(45), 'old is still known, and stale');
  for (const id of EVERY_PASS) assert.equal((await sensorsOf([wrote(id, 2)])).ageMin, 2, id);
});

test('#464 r1 m1: the account reading alone past the limit, or never written, is its own stale', async () => {
  assert.deepEqual(await sensorsOf([wrote('network-up', 1), signedIn('a', STALE_MIN + 5)]), fresh(1, STALE_MIN + 5));
  assert.deepEqual(await sensorsOf([wrote('network-up', 1)]), fresh(1, null), 'no account reading at all');
  const made = (by) => heartbeatProbes({ rec: (() => { const r = recWith([]); for (const [id, doc] of [wrote('network-up', 1), signedIn('a', 1)]) r.write({ actor: factFamilyOf(id), entity: 'fact', id, expectRev: 0, doc }); return { read: r.read.bind(r), meta: (_e, id) => ({ createdBy: id === ACCOUNT_FACT ? by : 'sensors' }) }; })(), rules: rules(), now: () => T0, upMs: UP }).sensorsAlive();
  assert.equal((await made('sensors')).account.stale, false, 'the control');
  assert.equal((await made('ledger')).account.stale, true, 'an account fact Sensors did not make is no account reading');
});

test('L969 review m1: stale is decided in milliseconds, as the Dispatcher\'s account hold decides it', async () => {
  const at = async (ms) => { const r = await sensorsOf([['network-up', { value: true, observed_at: iso(T0 - ms) }], [ACCOUNT_FACT, { account: 'a', observed_at: iso(T0 - ms) }]]); return [r.ageMin, r.stale, r.account.stale]; };
  assert.deepEqual(await at(STALE_MIN * MIN), [STALE_MIN, false, false], 'at the limit is not past it');
  assert.deepEqual(await at(STALE_MIN * MIN + 1000), [STALE_MIN, true, true], 'a second past it is stale, though the minutes still read the limit');
});

test('#464 r1 M1, m2a: no reading at all, deleted readings, or a Record that throws is "none", for the heartbeat to count', async () => {
  assert.deepEqual(await sensorsOf([]), { none: true, limitMin: STALE_MIN, why: 'none' }, 'a Mini that has never run the Sensors job');
  assert.deepEqual(await sensorsOf([usage(10, 10, 1)]), { none: true, limitMin: STALE_MIN, why: 'none' }, 'usage is not written every pass: it does not count');
  const made = recWith([]);
  assert.equal(made.write({ actor: 'sensors', entity: 'fact', id: 'network-up', expectRev: 0, doc: { value: true, observed_at: seen(1) } }).ok, true);
  const by = (who) => heartbeatProbes({ rec: { read: made.read.bind(made), meta: () => ({ createdBy: who }) }, rules: rules(), now: () => T0, upMs: UP }).sensorsAlive();
  assert.equal((await by('sensors')).ageMin, 1, 'the control');
  assert.equal((await by('ledger')).none, true, 'a reading Sensors did not make');
  const boom = () => { throw new Error('the store could not be read'); };
  for (const rec of [{ read: boom }, { read: made.read.bind(made), meta: boom }]) {
    assert.deepEqual(await heartbeatProbes({ rec, rules: rules(), now: () => T0, upMs: UP }).sensorsAlive(), { none: true, limitMin: STALE_MIN, why: 'record' });
  }
  const damaged = { read: (_e, id) => (id === 'network-up' ? { id, doc: null, corrupt: true } : null), meta: () => ({ createdBy: 'sensors' }) };
  assert.deepEqual(await heartbeatProbes({ rec: damaged, rules: rules(), now: () => T0, upMs: UP }).sensorsAlive(), { none: true, limitMin: STALE_MIN, why: 'record' }, 'r2 m1: a damaged reading names the Record');
  const gone = recWith([]);
  assert.equal(gone.write({ actor: 'sensors', entity: 'fact', id: 'network-up', expectRev: 0, doc: { value: true, observed_at: seen(1) } }).ok, true);
  let deleted = false;
  const p = heartbeatProbes({ rec: { read: (e, id) => (deleted ? null : gone.read(e, id)), meta: gone.meta?.bind(gone) }, rules: rules(), now: () => T0, upMs: UP });
  assert.equal((await p.sensorsAlive()).ageMin, 1);
  deleted = true;
  assert.equal((await p.sensorsAlive()).none, true, 'deleted readings take the same path');
});

test('#464 r1 m2: a reading stamped more than FUTURE_MS ahead is the clock, not a reading', async () => {
  assert.deepEqual(await sensorsOf([wrote('network-up', -5), signedIn('a', 1)]), { clock: true, aheadMin: 5, limitMin: STALE_MIN });
  assert.equal((await sensorsOf([['network-up', { value: true, observed_at: iso(T0 + FUTURE_MS) }], signedIn('a')])).clock, undefined, 'up to FUTURE_MS ahead is a reading');
  assert.equal((await sensorsOf([['network-up', { value: true, observed_at: iso(T0 + FUTURE_MS + 1) }], signedIn('a')])).clock, true);
});

test('#464 r1 m3: inside the grace after the Mini started, a stale reading is not known; after it, stale', async () => {
  const old = [wrote('network-up', 120), signedIn('a', 120)];
  assert.equal(await sensorsOf(old, { upMs: () => GRACE_MS - 1 }), null, 'just started');
  assert.equal((await sensorsOf(old, { upMs: () => GRACE_MS })).stale, true);
  assert.equal((await sensorsOf([wrote('network-up', 1)], { upMs: () => 0 })), null, 'an account reading not yet written, just after the start');
  assert.equal((await sensorsOf([wrote('network-up', 1), signedIn('a', 1)], { upMs: () => 0 })).stale, false, 'a current one is said at once');
  assert.ok(GRACE_MS >= 60_000, 'at least one Sensors interval');
});

test('L969: sensorsAlive is not known with no limit in the rules; a clock that is not a time throws (r1 c1)', async () => {
  const rec = recWith([]);
  assert.equal(rec.write({ actor: 'sensors', entity: 'fact', id: 'network-up', expectRev: 0, doc: { value: true, observed_at: seen(1) } }).ok, true);
  assert.equal(await heartbeatProbes({ rec, rules: { ...rules(), get: () => undefined, num: () => { throw new Error('no value'); } }, now: () => T0, upMs: UP }).sensorsAlive(), null, 'no usage.stale_after_min');
  await assert.rejects(heartbeatProbes({ rec, rules: rules(), now: () => NaN, upMs: UP }).sensorsAlive(), /not a time/);
});

test('L969: EVERY_PASS is exactly the families the Sensors loop writes every pass with no suffix', () => {
  const every = Object.entries(LOOP).filter(([fam, how]) => !fam.endsWith('-') && /^every pass:/.test(how)).map(([fam]) => fam).sort();
  assert.deepEqual([...EVERY_PASS].sort(), every);
});
