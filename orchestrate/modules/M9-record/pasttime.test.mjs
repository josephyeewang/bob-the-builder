// pasttime.test.mjs — L329 (L321 sweep): every stored time the M9 writer reads for "has this claim lapsed / is this
// owner dead" goes through shared pastTime. A time that can't be read, or lies an hour ahead (a clock that went back, a
// bad write), counts for nothing: a claim lapses, a dead owner's claim is broken, never held for ever by that time.
// Two plants per site: one unreadable, one 1 h ahead. A heartbeat's own time is the store's write stamp, which the
// writer always sets, so only the 1 h ahead plant applies to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iso, must, product, readyCard, claimCard, runCard, seed, setup } from './fixtures.test-helper.mjs';

const MIN = 60_000;
const err = (code) => Object.assign(new Error(code), { code });
const deadProbe = { kill: () => { throw err('ESRCH'); }, pidStart: () => '2026-10-01T11:00:00Z' };
const plants = (now) => [['unreadable', 'not a time'], ['1 h ahead', iso(now + 60 * MIN)]];
// The card's claim with claimed_at replaced, put straight into the store (the writer always stamps it itself).
const plantClaim = (env, id, claimed_at) => {
  const d = env.record.read('card', id).doc;
  seed(env, 'card', id, { ...d, claim: { ...d.claim, claimed_at } });
};

for (const [name, at] of plants(Date.parse('2026-10-01T12:00:00Z'))) {
  test(`L329 writer.mjs lapseClaims: a never-launched session claim whose claimed_at is ${name} lapses now`, () => {
    const env = setup({ prefix: 'm9-pasttime-' });
    product(env); readyCard(env, 'C-1');
    claimCard(env, 'C-1');
    const t0 = env.clock.t;
    assert.deepEqual(env.record.lapseClaims(t0 + MIN, { stopSession: () => true }).lapsed, [], 'control: not at the limit');
    plantClaim(env, 'C-1', at);
    const r = env.record.lapseClaims(t0 + MIN, { stopSession: () => true });
    assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']], 'lapsed now, not never');
  });

  test(`L329 writer.mjs lapseClaims: a tab claim whose claimed_at is ${name} hits the running limit now, even with a fresh heartbeat`, () => {
    const env = setup({ prefix: 'm9-pasttime-' });
    product(env); readyCard(env, 'C-1');
    claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
    const t0 = env.clock.t;
    env.clock.t = t0 + 4 * MIN;
    must(env.record.write({ actor: 'dispatcher', entity: 'fact', id: 'tab-heartbeat-T-1', expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-1', at: iso(env.clock.t) } }), 'beat');
    assert.deepEqual(env.record.lapseClaims(t0 + 5 * MIN).lapsed, [], 'control: a fresh beat holds it');
    plantClaim(env, 'C-1', at);
    const r = env.record.lapseClaims(t0 + 5 * MIN);
    assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']]);
    assert.equal(env.record.diary().at(-1).data.why, 'running limit');
  });

  test(`L329 writer.mjs deadness: a dead owner whose last_activity is ${name} loses the claim (not "recent activity")`, () => {
    const env = setup({ prefix: 'm9-pasttime-', probe: deadProbe });
    product(env); readyCard(env, 'C-1');
    runCard(env, 'C-1');
    const t = env.clock.t;
    env.clock.t = t - 600 * MIN;   // the session record was last written 10 hours ago
    seed(env, 'session', 'S-1', { state: 'ended', role: 'worker', pid: 4242, pid_start: '2026-10-01T11:00:00Z', card: null, last_activity: at === 'not a time' ? at : iso(t + 60 * MIN) });
    env.clock.t = t;
    must(env.record.breakIfDead({ card: 'C-1' }), 'broken');
    assert.equal(env.record.read('card', 'C-1').doc.state, 'ready');
  });
}

test('L329 writer.mjs lapseClaims: a heartbeat stamped 1 h ahead keeps no tab claim alive', () => {
  const env = setup({ prefix: 'm9-pasttime-' });
  product(env); readyCard(env, 'C-1');
  claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  const t0 = env.clock.t;
  env.clock.t = t0 + 70 * MIN;   // the Mac's clock ran an hour ahead while the beat was written
  must(env.record.write({ actor: 'dispatcher', entity: 'fact', id: 'tab-heartbeat-T-1', expectRev: 0, doc: { type: 'tab_heartbeat', claim_id: 'T-1', at: iso(env.clock.t) } }), 'beat');
  env.clock.t = t0 + 10 * MIN + 1;
  const r = env.record.lapseClaims(t0 + 10 * MIN + 1);
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']]);
  assert.equal(env.record.diary().at(-1).data.why, 'heartbeat stale');
});

// L362 m3, the plants that survived the audit of #180.
test('L362 P6c writer.mjs lapseClaims: a claimed_at 30 s ahead is kept', () => {
  const env = setup({ prefix: 'm9-pasttime-' });
  product(env); readyCard(env, 'C-1');
  claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  const t0 = env.clock.t;
  plantClaim(env, 'C-1', iso(t0 + 30_000));
  assert.deepEqual(env.record.lapseClaims(t0).lapsed, [], 'a small drift is no lapse');
});

test('L362 P7 writer.mjs lapseClaims: a tab claim with no readable claimed_at and no beat lapses as stale, not held as recent', () => {
  const env = setup({ prefix: 'm9-pasttime-' });
  product(env); readyCard(env, 'C-1');
  claimCard(env, 'C-1', { kind: 'tab', claim_id: 'T-1', host: 'mac-a' });
  plantClaim(env, 'C-1', null);
  const r = env.record.lapseClaims(env.clock.t);
  assert.deepEqual(r.lapsed.map((x) => [x.card, x.to]), [['C-1', 'ready']]);
  assert.equal(env.record.diary().at(-1).data.why, 'heartbeat stale');
});

test('L362 P6c writer.mjs lapseClaims: a session claim whose claimed_at is 30 s ahead is kept', () => {
  const env = setup({ prefix: 'm9-pasttime-' });
  product(env); readyCard(env, 'C-1');
  claimCard(env, 'C-1');
  const t0 = env.clock.t;
  plantClaim(env, 'C-1', iso(t0 + MIN + 30_000));
  assert.deepEqual(env.record.lapseClaims(t0 + MIN, { stopSession: () => true }).lapsed, [], 'a small drift is no lapse');
});
