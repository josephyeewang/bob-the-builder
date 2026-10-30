import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneLinkStep, FACTS, LINK_FACT, REMOTE_CONTROL } from './phone-link.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, T0, MIN, iso } from './fixtures.test-helper.mjs';

function world({ outcome = 'sent', restartOk = true, minibaseOk = true, alert = null } = {}) {
  const rec = recWith();
  const calls = { sent: [], restarts: 0, minibase: 0, alerts: [] };
  const fact = (id, value, atMin) => {
    const cur = rec.read('fact', id);
    const r = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: { value, observed_at: iso(T0 + atMin * MIN) } });
    if (!r.ok) throw new Error(r.reason);
  };
  const ports = {
    send: async (t) => { calls.sent.push(t); return { outcome: typeof outcome === 'function' ? outcome() : outcome }; },
    restartFrontDoor: async () => { calls.restarts += 1; return restartOk ? { ok: true } : { ok: false, reason: 'did not start' }; },
    startMinibase: async () => { calls.minibase += 1; return minibaseOk ? { ok: true } : { ok: false, reason: 'no' }; },
    alert: alert ?? ((t) => calls.alerts.push(t)),
  };
  const step = (min, rules = rulesWith()) => phoneLinkStep({ rec, rules, now: T0 + min * MIN, ...ports });
  // one reading of every sensor at minute `min`
  const read = (min, { net = true, fd = true, mb = true } = {}) => { fact(FACTS.network, net, min); fact(FACTS.reachable, fd, min); fact(FACTS.minibase, mb, min); };
  const diary = () => rec.read('fact', 'phone-link-note')?.rev ?? 0;
  return { rec, calls, step, read, fact, diary };
}

test('m19: network down -> nothing at all, even with the link and Mini Base down', async () => {
  const w = world();
  for (let m = 0; m < 30; m += 1) { w.read(m, { net: false, fd: false, mb: false }); assert.deepEqual(await w.step(m), ['network down: nothing done']); }
  assert.deepEqual([w.calls.sent.length, w.calls.restarts, w.calls.minibase, w.calls.alerts.length], [0, 0, 0, 0]);
});

test('m19: one false reading waits; the second false reading sends /remote-control through sendSafe', async () => {
  const w = world();
  w.read(0, { fd: false });
  assert.match((await w.step(0)).at(-1), /waiting for a second reading/);
  assert.match((await w.step(1)).at(-1), /waiting for a second reading/, 'the same reading counts once');
  assert.equal(w.calls.sent.length, 0);
  w.read(2, { fd: false });
  assert.equal((await w.step(2)).at(-1), 'sent /remote-control');
  assert.deepEqual(w.calls.sent, [REMOTE_CONTROL]);
});

test('m19: a true reading between two false ones resets the count', async () => {
  const w = world();
  w.read(0, { fd: false }); await w.step(0);
  w.read(1, { fd: true }); await w.step(1);
  w.read(2, { fd: false }); await w.step(2);
  assert.equal(w.calls.sent.length, 0);
});

test('m19: tried again every 5 min while false; one alert after 3 failed tries', async () => {
  const w = world();
  for (let m = 0; m <= 40; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  // sends at minutes 1, 6, 11, 16, 21, 26, 31, 36
  assert.equal(w.calls.sent.length, 8);
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /3 tries to reconnect it failed/);
  assert.equal(w.calls.restarts, 0, 'sends that went through are not "stuck"');
});

test('m19: the alert comes at the fourth send, not before', async () => {
  const w = world();
  for (let m = 0; m <= 11; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.sent.length, 3);
  assert.equal(w.calls.alerts.length, 0);
  for (let m = 12; m <= 16; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.alerts.length, 1);
});

test('m19: unknown is a diary line only', async () => {
  const w = world();
  w.read(0, { fd: 'unknown' });
  assert.match((await w.step(0)).at(-1), /diary line only/);
  await w.step(1); // same reading: no second line
  assert.equal(w.diary(), 1);
  w.read(2, { net: 'unknown', fd: false });
  assert.deepEqual(await w.step(2), ['network unknown: nothing done']);
  assert.equal(w.diary(), 2);
  assert.equal(w.calls.sent.length, 0);
  // a reading with no usable value counts as unknown
  w.fact(FACTS.network, true, 3); w.fact(FACTS.reachable, 'yes', 3);
  assert.match((await w.step(3)).at(-1), /diary line only/);
});

test('L15: refused and unreachable for 10 min -> Front Door restarted, one diary line, no alert', async () => {
  const w = world({ outcome: 'suppressed_awaiting_user' });
  const out = [];
  for (let m = 0; m <= 12; m += 1) { w.read(m, { fd: false }); out.push(...(await w.step(m))); }
  assert.ok(out.includes('/remote-control refused (suppressed_awaiting_user)'));
  assert.equal(w.calls.restarts, 1);
  assert.ok(out.includes('Front Door restarted'));
  assert.equal(w.diary(), 1);
  assert.match(w.rec.read('fact', 'phone-link-note').doc.text, /restarted under its fixed name/);
  assert.equal(w.calls.alerts.length, 0);
});

test('L15: not yet 10 min refused -> no restart', async () => {
  const w = world({ outcome: 'suppressed_busy' });
  for (let m = 0; m <= 10; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.restarts, 0); // first refusal at minute 1, so 10 min is reached at minute 11
  w.read(11, { fd: false }); await w.step(11);
  assert.equal(w.calls.restarts, 1);
});

test('L15: the restart failing alerts', async () => {
  const w = world({ outcome: 'suppressed_awaiting_user', restartOk: false });
  for (let m = 0; m <= 12; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /could not be reconnected or restarted/);
});

test('L15: a send that goes through clears the refused clock', async () => {
  let n = 0;
  const w = world({ outcome: () => (n++ === 1 ? 'sent' : 'suppressed_busy') });
  for (let m = 0; m <= 14; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  // refused at 1, sent at 6, refused again at 11: the clock starts again at 11
  assert.equal(w.calls.restarts, 0);
});

test('L15: the time comes from the rules', async () => {
  const w = world({ outcome: 'suppressed_busy' });
  const R = rulesWith({ [K.frontDoorStuckMin]: 3 });
  for (let m = 0; m <= 4; m += 1) { w.read(m, { fd: false }); await w.step(m, R); }
  assert.equal(w.calls.restarts, 1);
  await assert.rejects(() => world().step(0, rulesWith({ [K.frontDoorStuckMin]: undefined })), /front_door_stuck_min/);
});

test('the link coming back resets everything', async () => {
  const w = world();
  for (let m = 0; m <= 16; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.alerts.length, 1);
  w.read(17, { fd: true });
  assert.deepEqual(await w.step(17), ['phone link back']);
  const st = w.rec.read('fact', LINK_FACT).doc;
  assert.deepEqual([st.false_streak, st.attempts, st.failures, st.told], [0, 0, 0, false]);
  // a new outage alerts again
  for (let m = 18; m <= 36; m += 1) { w.read(m, { fd: false }); await w.step(m); }
  assert.equal(w.calls.alerts.length, 2);
});

test('Mini Base down with the network up: started again at most every 5 min; a failed start alerts', async () => {
  const w = world({ minibaseOk: false });
  for (let m = 0; m <= 10; m += 1) { w.read(m, { mb: false }); await w.step(m); }
  assert.equal(w.calls.minibase, 3); // minutes 0, 5, 10
  assert.equal(w.calls.alerts.length, 3);
  const ok = world();
  ok.read(0, { mb: false }); assert.ok((await ok.step(0)).includes('Mini Base started'));
  ok.read(1, { mb: true }); await ok.step(1);
  assert.equal(ok.calls.minibase, 1);
});

test('audit MAT-10: the Front Door gone is restarted with its last handoff, at most once per 5 min; a failed restart alerts', async () => {
  const rec = recWith();
  const handoffs = [];
  const alerts = [];
  let ok = true;
  const fact = (id, value, min) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc: { value, observed_at: iso(T0 + min * MIN) } });
  const step = (min, alive) => {
    for (const id of [FACTS.network, FACTS.reachable, FACTS.minibase]) fact(id, true, min);
    return phoneLinkStep({ rec, rules: rulesWith(), now: T0 + min * MIN, send: async () => ({ outcome: 'sent' }), startMinibase: async () => ({ ok: true }),
      restartFrontDoor: async (x) => { handoffs.push(x.handoff); return ok ? { ok: true } : { ok: false, reason: 'did not start' }; },
      frontDoorAlive: () => alive, lastHandoff: () => 'fd-handoff-7', alert: (t) => alerts.push(t) });
  };
  assert.deepEqual(await step(0, true), []);
  assert.equal(handoffs.length, 0);
  assert.deepEqual(await step(1, false), ['Front Door was missing; restarted']);
  assert.deepEqual(handoffs, ['fd-handoff-7']);
  assert.deepEqual(await step(5, false), ['Front Door missing; restarted recently, waiting']);
  assert.equal(handoffs.length, 1);
  ok = false;
  assert.deepEqual(await step(6, false), ['Front Door was missing; restart failed']);
  assert.equal(handoffs.length, 2);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /did not restart: did not start/);
  assert.equal((await step(7, null)).includes('Front Door was missing; restarted'), false); // unknown is not missing
  assert.equal(handoffs.length, 2);
});

test('audit 0b-6 r3 MIN-5 (J8): a reading older than 5 min is unknown, not used', async () => {
  const w = world();
  w.read(0, { net: false });
  assert.deepEqual(await w.step(4), ['network down: nothing done']);
  assert.deepEqual(await w.step(6), ['network unknown: nothing done']);
});

test('audit 0b-6 r3 MIN-5 (J9): the network dropping clears the refused clock and the false count', async () => {
  const w = world();
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: LINK_FACT, expectRev: 0, doc: { false_streak: 1, attempts: 0, failures: 0, refused_since: iso(T0 - 9 * MIN) } });
  w.read(0, { net: false });
  await w.step(0);
  const d = w.rec.read('fact', LINK_FACT).doc;
  assert.deepEqual([d.refused_since, d.false_streak], [null, 0]);
});

// Audit 0b-6 r5 MAT-2: the link alert is marked told only once sent.
test('r5 MAT-2: a link alert that fails is told at the next try, once', async () => {
  for (const bad of [() => { throw new Error('down'); }, () => Promise.reject(new Error('down'))]) {
    const sent = [];
    let down = true;
    const w = world({ alert: (t) => (down ? bad(t) : sent.push(t)) });
    for (let m = 0; m <= 16; m += 1) { w.read(m, { fd: false }); await w.step(m); }
    down = false;
    for (let m = 17; m <= 40; m += 1) { w.read(m, { fd: false }); await w.step(m); }
    assert.equal(sent.filter((t) => /tries to reconnect it failed/.test(t)).length, 1, sent.join(' | '));
  }
});
