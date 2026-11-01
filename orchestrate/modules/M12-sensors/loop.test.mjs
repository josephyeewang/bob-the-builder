// R-0b-169: the Sensors' loop, run over the REAL M9 record (a record in a temp folder), and M11's own readers over what
// it wrote. No stand-in for the record or for M11; the only fakes are the outside world (the ports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../M9-record/fixtures.test-helper.mjs';
import { sensorsPass, timed, EVERY_S, PROBE_DEADLINE_MS, RUN_DEADLINE_MS, main } from './loop.mjs';
import { signedInAccount } from '../M11-dispatcher/tick.mjs';
import { readFact, USAGE_FACT } from '../M11-dispatcher/usage.mjs';
import { FACTS, READING_MAX_AGE_MS } from '../M11-dispatcher/phone-link.mjs';
import { rulesWith } from '../M11-dispatcher/fixtures.test-helper.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const usage = (now) => ({ source: 'test', h5: { used_pct: 20, resets_at: iso(now + 60 * MIN) }, week: { used_pct: 30, resets_at: iso(now + 3 * 24 * 60 * MIN) } });
const goodPorts = (now) => ({ whoIsSignedIn: async () => 'acct-a', readUsage: async () => usage(now), probes: { network: async () => true, reachable: async () => true, minibase: async () => true } });
const world = () => { const w = setup({ prefix: 'm12-loop-' }); return { rec: w.record, w }; };
const fact = (rec, id) => rec.read('fact', id)?.doc;

test('a pass writes all five readings into the real record, each stamped, and M11 reads them as good', async () => {
  const { rec } = world();
  const r = await sensorsPass({ rec, ports: goodPorts(T0), now: () => new Date(T0) });
  assert.deepEqual(r.problems, []);
  assert.equal(fact(rec, 'signed-in-account').account, 'acct-a');
  for (const k of Object.values(FACTS)) assert.deepEqual([fact(rec, k).value, fact(rec, k).observed_at], [true, iso(T0)], k);
  assert.deepEqual(signedInAccount({ rec, rules: rulesWith(), now: T0 + MIN }), { account: 'acct-a', reason: null });
  const u = readFact(rec.read('fact', USAGE_FACT('acct-a')), { account: 'acct-a', now: T0 + MIN, staleMs: 15 * MIN });
  assert.equal(u.ok, true, u.reason);
});

test('observed_at is the time taken just BEFORE the read, not after (a slow read looks older, never newer)', async () => {
  const { rec } = world();
  let t = T0;
  const ports = goodPorts(T0);
  ports.probes.network = async () => { t += 4_000; return true; };
  await sensorsPass({ rec, ports, now: () => new Date(t) });
  assert.equal(fact(rec, FACTS.network).observed_at, iso(T0), 'dated before the 4 s read');
});

test('PLANT a read that throws → written as unknown (null) WITH its time, and M11 sees unknown', async () => {
  const { rec } = world();
  const ports = goodPorts(T0);
  ports.probes.network = async () => { throw new Error('boom'); };
  ports.whoIsSignedIn = async () => { throw new Error('no claude'); };
  const r = await sensorsPass({ rec, ports, now: () => new Date(T0 + MIN) });
  assert.deepEqual([fact(rec, FACTS.network).value, fact(rec, FACTS.network).observed_at], [null, iso(T0 + MIN)]);
  assert.deepEqual([fact(rec, 'signed-in-account').account, fact(rec, 'signed-in-account').observed_at], [null, iso(T0 + MIN)]);
  assert.ok(r.problems.some((p) => /network-up.*failed/.test(p)));
  assert.equal(signedInAccount({ rec, rules: rulesWith(), now: T0 + MIN }).account, null);
});

// FOUND BY RUNNING ON THE REAL RECORD (R-0b-169): M9 permissions.mjs:64 makes a Sensors fact CREATE-ONLY
// (`sensors: createOnly()`), so the second pass's rewrite of `network-up` etc. is refused ("sensors may not change
// fact"). Lane 3's writers and M11 both use one fixed id per reading, updated in place; lane 3's tests used the
// in-memory record, which allows it. Until M9 lets the Sensors update a fact, the loop works exactly once per record.
// The two `todo` tests below are the proof it is fixed: they fail today (a todo failure does not fail the run) and pass
// when M9 allows the update. The test after them proves the refusal is never silent.
const BLOCKED = 'blocked on M9 permissions.mjs: facts are create-only for the Sensors (see lane4-to-lead.md, R-0b-169)';

test('a second pass replaces the first reading (M11 reads the new time)', { todo: BLOCKED }, async () => {
  const { rec } = world();
  await sensorsPass({ rec, ports: goodPorts(T0), now: () => new Date(T0) });
  await sensorsPass({ rec, ports: goodPorts(T0 + MIN), now: () => new Date(T0 + MIN) });
  assert.equal(fact(rec, FACTS.network).observed_at, iso(T0 + MIN));
});

test('a failed read replaces an old GOOD value with unknown, so M11 never keeps acting on the old good one', { todo: BLOCKED }, async () => {
  const { rec } = world();
  await sensorsPass({ rec, ports: goodPorts(T0), now: () => new Date(T0) });
  const ports = goodPorts(T0 + MIN); ports.probes.network = async () => { throw new Error('boom'); };
  await sensorsPass({ rec, ports, now: () => new Date(T0 + MIN) });
  assert.deepEqual([fact(rec, FACTS.network).value, fact(rec, FACTS.network).observed_at], [null, iso(T0 + MIN)]);
});

test('a write the record refuses is never silent: every reading that was not written is named in the pass\'s problems', async () => {
  const { rec } = world();
  await sensorsPass({ rec, ports: goodPorts(T0), now: () => new Date(T0) });
  const r = await sensorsPass({ rec, ports: goodPorts(T0 + MIN), now: () => new Date(T0 + MIN) });
  for (const [id, w] of Object.entries(r.wrote)) assert.ok(w.ok || r.problems.some((p) => p.startsWith(`${id}: not written`)), `${id} was neither written nor reported`);
});

test('PLANT a read that never answers → unknown at the deadline, the other readings still written', async () => {
  const { rec } = world();
  const ports = goodPorts(T0);
  ports.probes.reachable = () => new Promise(() => {});
  const r = await sensorsPass({ rec, ports, now: () => new Date(T0), deadlineMs: 30 });
  assert.equal(fact(rec, FACTS.reachable).value, null);
  assert.equal(fact(rec, FACTS.network).value, true);
  assert.ok(r.problems.some((p) => /did not answer within 30 ms/.test(p)));
});

test('a usage read that fails is written as a reading with no figures (M11: unknown), never skipped', async () => {
  const { rec } = world();
  const ports = goodPorts(T0); ports.readUsage = async () => { throw new Error('screen unreadable'); };
  await sensorsPass({ rec, ports, now: () => new Date(T0) });
  const d = fact(rec, USAGE_FACT('acct-a'));
  assert.deepEqual([d.h5.used_pct, d.week.used_pct, d.observed_at], [null, null, iso(T0)]);
  assert.match(readFact(rec.read('fact', USAGE_FACT('acct-a')), { account: 'acct-a', now: T0, staleMs: 15 * MIN }).reason, /not a percent/);
});

test('no usage source yet (R-0b-66): written as unknown and said so; nobody signed in: no usage fact', async () => {
  const { rec } = world();
  const ports = goodPorts(T0); delete ports.readUsage;
  const r = await sensorsPass({ rec, ports, now: () => new Date(T0) });
  assert.equal(fact(rec, USAGE_FACT('acct-a')).h5.used_pct, null);
  assert.ok(r.problems.some((p) => /no usage source yet/.test(p)));
  const { rec: rec2 } = world();
  const p2 = goodPorts(T0); p2.whoIsSignedIn = async () => null;
  const r2 = await sensorsPass({ rec: rec2, ports: p2, now: () => new Date(T0) });
  assert.equal(rec2.list('fact').some((f) => f.id.startsWith('usage-')), false);
  assert.ok(r2.problems.some((p) => /no signed-in account/.test(p)));
});

test('the beat: a pass every EVERY_S seconds keeps every reading fresh for M11 (needs two passes inside its age limit)', () => {
  assert.equal(EVERY_S, 60);
  assert.ok(2 * EVERY_S * 1000 + PROBE_DEADLINE_MS + 20_000 < READING_MAX_AGE_MS, 'a missed pass must not make a reading unknown');
  assert.ok(RUN_DEADLINE_MS < EVERY_S * 1000 * 2);
});

test('timed: a late answer is dropped and a thrown error becomes a reason', async () => {
  assert.deepEqual(await timed(() => 5, 50, 'x'), { value: 5, failed: false, reason: null });
  assert.equal((await timed(() => new Promise(() => {}), 20, 'x')).failed, true);
  assert.match((await timed(() => { throw new Error('bad'); }, 50, 'x')).reason, /x failed \(bad\)/);
});

test('main refuses a missing config or a wiring without wire(), exit 1', async () => {
  const lines = [];
  assert.equal(await main([], { log: (s) => lines.push(s) }), 1);
  assert.equal(await main(['/no/such/file.json'], { log: (s) => lines.push(s) }), 1);
  assert.ok(lines.every((l) => /sensors: not started/.test(l)));
});
