// stale-now.test.mjs — a pass's `now` read once goes stale (L321, L323). The Store Writer refuses a wait whose since
// is more than 60 s off its own clock, and a tick runs its steps one after another, each up to STEP_DEADLINE_MS, with
// a stop step's saves taking up to SAVE_DEADLINE_MS. So the tick reads its clock before each step, stopPass and
// timeLimits read it again after their slow calls, and a write of a watched kind that is still refused is told to Joe
// (refused-writes.mjs), once a day while it lasts. All on the real Store Writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, ACCOUNT_FACT, LAST_PASS_FACT } from './tick.mjs';
import { main } from './main.mjs';
import { installedLayout } from '../../shared/job-config.test-helper.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopPass, STOP_FACT } from './pass.mjs';
import { REFUSED_FACT, tellRefused, watchWrites } from './refused-writes.mjs';
import { timeLimits } from './merges.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, usageFact, filesOfCommits, recWith, seed as seedFake, T0 } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, runCard, seed } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const PRODUCT = 'sample-app';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const allow = { start_session: { decision: 'allow', reason: 'ok' } };

// A real Record with two running cards: C-1's session S-1 is alive (its product is paused, so the stops step parks it),
// C-2's session S-2 is gone (the outage step puts it on Joe).
function world() {
  const E = setup({ prefix: 'm11-stale-', probe: { kill() {}, pidStart: () => 'start' } });
  product(E);
  for (const id of ['C-1', 'C-2']) { readyCard(E, id); runCard(E, id); }
  const sensors = (id, doc) => {
    const cur = E.record.read('fact', id);
    const r = E.record.write({ actor: 'sensors', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc });
    assert.ok(r.ok || r.reason === 'nothing changed', r.reason);
  };
  const fresh = () => {
    sensors(ACCOUNT_FACT, { account: 'acct-a', observed_at: new Date(E.clock.t).toISOString() });
    sensors(USAGE_FACT('acct-a'), usageFact({ week: 30, h5: 20, account: 'acct-a', now: E.clock.t }));
  };
  fresh();
  const pause = E.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: E.record.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } });
  assert.equal(pause.ok, true, pause.reason);
  const fake = fakeAlert();
  const alerts = fake.texts;
  const empty = tempDir('m11-stale-');
  let sessions = [{ id: 'S-1', product: PRODUCT, kind: 'editing', card: 'C-1', pgid: 50 }];
  const ports = (step) => ({
    alert: fake,
    board: () => [{ id: 'S-2', card: 'C-2', alive: false, ended: true, lastWriteAt: E.clock.t - 10 * MIN }],
    healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {}, leads: () => [],
    sessions: () => sessions, probe: () => idle,
    launch: async () => ({ ok: false, reason: 'no launches in this test' }),
    stopGroup: async () => { sessions = []; return { ok: true, how: 'SIGTERM' }; },
    saveWork: async () => { step(); return { ok: true }; },
    hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: () => ({ ok: true }),
    filesOf: filesOfCommits,
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: empty, sealRoot: empty, mirrorFor: () => null },
    approvals: () => [],
  });
  const card = (id) => E.record.read('card', id).doc;
  return { E, fake, alerts, ports, card, fresh };
}

for (const lag of [61_000, 80_000, 125_000]) {
  test(`L321: a tick whose clock moves ${lag / 1000} s at every read still parks the stopped card and puts the dead one on Joe`, async () => {
    const { E, alerts, ports, card } = world();
    // Every read of the clock is `lag` later: each step, and stopPass after its saves, starts that long after the last.
    const clock = () => (E.clock.t += lag);
    const r = await tick({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t, clock, ports: ports(() => {}) });
    assert.equal(r.steps.stops.ok, true, r.steps.stops.error);
    assert.equal(r.steps.outage.ok, true, r.steps.outage.error);
    assert.deepEqual([card('C-1').state, card('C-1').wait?.what], ['waiting', 'paused'], 'the stopped card is parked');
    assert.equal(E.record.read('fact', STOP_FACT('S-1')).doc.moved, true);
    assert.deepEqual([card('C-2').state, card('C-2').wait?.who], ['waiting', 'joe'], 'the dead card is on Joe');
    assert.match(alerts.join(' | '), /card C-2: its session stopped/);
    assert.deepEqual(r.refused.filter(([, did]) => did !== 'idle'), [], 'no write refused');
  });
}

test('L321: stopPass parks after a save of 61, 80 or 125 s, and keeps the old refusal without the clock', async () => {
  for (const lag of [61_000, 80_000, 125_000]) {
    for (const withClock of [true, false]) {
      const { E, ports, card } = world();
      const now = E.clock.t;
      const p = ports(() => { E.clock.t += lag; });
      await stopPass({ rec: E.record, rules: rulesWith({}, allow), now, ...(withClock ? { clock: () => E.clock.t } : {}), account: 'acct-a',
        sessions: p.sessions(), probe: p.probe, alert: fakeAlert(), stopGroup: p.stopGroup, saveWork: p.saveWork });
      const stop = E.record.read('fact', STOP_FACT('S-1')).doc;
      const what = `${lag / 1000} s, ${withClock ? 'with' : 'without'} the clock`;
      if (withClock) {
        assert.equal(card('C-1').state, 'waiting', what);
        assert.equal(stop.moved, true, what);
        // Parked at the stop itself, at the time after the saves: not refused first and re-parked at the pass's end.
        assert.deepEqual([card('C-1').wait.since, stop.move_reason], [stop.stopped_at, undefined], what);
      } else {
        assert.equal(card('C-1').state, 'running', what);
        assert.deepEqual([stop.moved, stop.move_reason], [false, 'wait.since must be now (within 60 s)'], `${what}: the refusal is kept on the stop`);
      }
    }
  }
});

test('L323: a refused park is told at once, quiet at +2 h, told again at +25 h, and cleared once the card is parked', async () => {
  const { E, fake, alerts, ports, card, fresh } = world();
  const rules = rulesWith({}, allow);
  // No clock: the tick's `now` stays where it started, while each save takes 80 s on the Record's clock. Every park
  // the pass writes after a save, or at its end, is refused.
  const slow = async (opts = {}) => {
    fake.reset();
    fresh();
    return tick({ rec: E.record, rules, now: E.clock.t, ...opts, ports: { ...ports(() => { E.clock.t += 80_000; }), ...(opts.ports ?? {}) } });
  };
  const told = () => alerts.filter((a) => /could not be parked: C-1 \(wait\.since must be now/.test(a));
  await slow();
  assert.equal(card('C-1').state, 'running');
  assert.equal(told().length, 1, alerts.join(' | '));
  assert.ok(E.record.read('fact', REFUSED_FACT('park')).doc.told_at, 'marked once delivered');
  // The session is gone now; each pass tries the park again (reparkStopped) and is refused again while it is stale.
  // Reading the sessions takes 80 s on the Record's clock, inside the stops step.
  const stale = { ports: { sessions: () => { E.clock.t += 80_000; return []; } } };
  E.clock.t += 2 * H;
  // A pass whose clock is late by 80 s at its end: the re-park, written at the tick's start time, is refused again.
  await slow({ ...stale, clock: () => E.clock.t - 80_000 });
  assert.equal(card('C-1').state, 'running');
  assert.deepEqual(told(), [], 'quiet two hours on');
  E.clock.t += 23 * H;
  await slow({ ...stale, clock: () => E.clock.t - 80_000 });
  assert.equal(told().length, 1, 'told again a day on');
  // With the real clock, the next pass parks it, and the refusal is cleared.
  E.clock.t += H;
  const r = await slow({ ...stale, clock: () => E.clock.t });
  assert.deepEqual([card('C-1').state, card('C-1').wait?.what], ['waiting', 'paused']);
  assert.equal(E.record.read('fact', STOP_FACT('S-1')).doc.moved, true);
  assert.deepEqual(r.refused.find(([c]) => c === 'park'), ['park', 'cleared']);
  assert.equal(E.record.read('fact', REFUSED_FACT('park')).doc.told_at, null);
});

test('L323: a dead session\'s card the Record will not put on Joe is told, not dropped', async () => {
  const { E, alerts, ports, card } = world();
  // No clock, and reading the sessions takes 80 s: the outage step's ask is written at the tick's start time.
  const r = await tick({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t,
    ports: { ...ports(() => {}), sessions: () => { E.clock.t += 80_000; return []; } } });
  assert.equal(card('C-2').state, 'running', 'the ask was refused');
  assert.deepEqual(r.refused.find(([c]) => c === 'joe_wait'), ['joe_wait', 'told']);
  assert.match(alerts.join(' | '), /a card could not be put on you: C-2 \(wait\.since must be now/);
});

test('L321: timeLimits puts a card on Joe after reviewer checks that took 80 s, on the real writer', async () => {
  for (const withClock of [true, false]) {
    const { E, card } = world();
    const doc = { ...E.record.read('card', 'C-1').doc, state: 'in_review', head: 'a'.repeat(40), attempts: { reviewer_starts: 2 } };
    delete doc.claim;
    seed(E, 'card', 'C-1', doc);
    E.clock.t += 3 * H;
    const now = E.clock.t;
    const r = await timeLimits({ rec: E.record, rules: rulesWith({}, allow), now, ...(withClock ? { clock: () => E.clock.t } : {}),
      b: { band: 'green', own_building: 'open' }, running: [], gateAlive: () => true, alert: fakeAlert(),
      hasReviewer: async () => { E.clock.t += 80_000; return false; }, requestReview: () => ({ ok: true }), reviewAlerts: async () => [] });
    const what = withClock ? 'with the clock' : 'without the clock';
    assert.equal(card('C-1').state, withClock ? 'waiting' : 'in_review', `${what}: ${JSON.stringify(r)}`);
  }
});

test('L323: refusals fold by cause, a cause whose step did not finish is left as it is, and one with none is cleared', () => {
  const rec = recWith();
  const alert = fakeAlert();
  const told = alert.texts;
  // What the outbox sender does once a copy is delivered: the mark's fields go onto its fact.
  const delivered = () => { for (const [, o] of alert.calls.splice(0)) rec.write({ actor: 'dispatcher', entity: 'fact', id: o.mark.fact, expectRev: rec.read('fact', o.mark.fact)?.rev ?? 0, doc: { ...rec.read('fact', o.mark.fact)?.doc, ...o.mark.fields } }); };
  const refused = new Map([['park', [{ id: 'C-1', reason: 'r1' }, { id: 'C-2', reason: 'r2' }]]]);
  const r1 = tellRefused({ rec, alert, now: T0, refused });
  assert.deepEqual(r1.find(([c]) => c === 'park'), ['park', 'told']);
  assert.equal(told.length, 1, 'one alert for the cause');
  assert.match(told[0], /C-1 \(r1\); C-2 \(r2\)/);
  delivered();
  // The stops step did not finish: no refusals seen is not "ended".
  const r2 = tellRefused({ rec, alert, now: T0 + H, refused: new Map(), ran: (s) => s !== 'stops' });
  assert.equal(r2.find(([c]) => c === 'park'), undefined);
  assert.ok(rec.read('fact', REFUSED_FACT('park')).doc.told_at);
  const r3 = tellRefused({ rec, alert, now: T0 + 2 * H, refused: new Map() });
  assert.deepEqual(r3.find(([c]) => c === 'park'), ['park', 'cleared']);
  assert.equal(rec.read('fact', REFUSED_FACT('park')).doc.told_at, null);
});

test('L323: watchWrites notes only refused writes of a watched kind, and passes every answer back', () => {
  const answers = { a: { ok: false, reason: 'no' }, b: { ok: true }, c: { ok: false, reason: 'other' } };
  const base = Object.freeze({ write: (x) => answers[x.id], read: () => 'kept' });
  const w = watchWrites(base);
  assert.equal(w.rec.read(), 'kept');
  assert.deepEqual(w.rec.write({ id: 'a', kind: 'park_paused' }), answers.a);
  w.rec.write({ id: 'b', kind: 'park_red' });
  w.rec.write({ id: 'c', kind: 'note' });
  assert.deepEqual([...w.refused], [['park', [{ id: 'a', reason: 'no' }]]]);
});

test('L321: main hands its own clock to the tick, which reads it before each step', async () => {
  const L = installedLayout('m11-stale-main-', { dirs: ['wiring'] });
  const self = L.write('modules/M11-dispatcher/main.mjs', 'export {};\n');
  const wiring = L.path('wiring/wiring.mjs');
  const here = fileURLToPath(new URL('.', import.meta.url));
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
import { fakeAlert } from ${JSON.stringify(join(here, '..', '..', 'test', 'fake-alert.test-helper.mjs'))};
const rec = recWith();
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: fakeAlert(), board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(L.base)}, sealRoot: ${JSON.stringify(L.base)}, mirrorFor: () => null }, approvals: () => [] } };
}
export { rec };
`);
  const config = L.path('config.json');
  writeFileSync(config, JSON.stringify({ installRoot: L.installRoot, wiring, lockFile: join(L.base, 'pass.lock') }));
  let t = T0;
  const reads = [];
  assert.equal(await main([config], { self, now: T0, clock: () => { t += MIN; reads.push(t); return t; }, log: () => {} }), 0);
  const { rec } = await import(wiring);
  // The full-pass record is written after the last step, at that step's time: well past the tick's start.
  assert.ok(reads.length >= 13, `the clock was read before each step (${reads.length})`);
  const at = rec.read('fact', LAST_PASS_FACT).doc.at;
  assert.ok(reads.map((x) => new Date(x).toISOString()).includes(at) && Date.parse(at) >= T0 + 13 * MIN, at);
});
