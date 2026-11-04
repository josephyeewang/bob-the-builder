// stale-now.test.mjs — a pass's `now` read once goes stale (L321, L323). The Store Writer refuses a wait whose since
// is more than 60 s off its own clock, and a tick runs its steps one after another, each up to STEP_DEADLINE_MS, with
// a stop step's saves taking up to SAVE_DEADLINE_MS. So the tick reads its clock before each step, stopPass and
// timeLimits read it again after their slow calls, and a write of a watched kind that is still refused is told to the owner
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
import { waitOn } from './moves.mjs';
import { REFUSED_CAUSES, REFUSED_FACT, REFUSED_KEEP_MAX, REFUSED_LIST_MAX, REFUSED_OVER_MAX, tellRefused, watchWrites } from './refused-writes.mjs';
import { timeLimits } from './merges.mjs';
import { USAGE_FACT } from './usage.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { rulesWith, usageFact, filesOfCommits, recWith, setClock, iso, T0, writeLog, queueFor } from './fixtures.test-helper.mjs';
import { setup, product, readyCard, runCard, seed, sessionClaim } from '../M9-record/fixtures.test-helper.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const PRODUCT = 'sample-app';
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const allow = { start_session: { decision: 'allow', reason: 'ok' } };

// A real Record with two running cards: C-1's session S-1 is alive (its product is paused, so the stops step parks it),
// C-2's session S-2 is gone (the outage step puts it on the owner).
// Options (audit #166's probes): `pause` the product, the `cards` made running, the `live` sessions and the dead `board`.
function world({ pause = true, cards = ['C-1', 'C-2'], live = [{ id: 'S-1', product: PRODUCT, kind: 'editing', card: 'C-1', pgid: 50 }], board } = {}) {
  const E = setup({ prefix: 'm11-stale-', probe: { kill() {}, pidStart: () => 'start' } });
  product(E);
  for (const id of cards) { readyCard(E, id); runCard(E, id, sessionClaim({ session_id: id === 'C-2' ? 'S-2' : 'S-1' })); }
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
  if (pause) {
  const paused = E.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: E.record.read('product', PRODUCT).rev, doc: { state: 'paused', return_to: 'active' } });
  assert.equal(paused.ok, true, paused.reason);
  }
  const fake = fakeAlert();
  const alerts = fake.texts;
  const empty = tempDir('m11-stale-');
  let sessions = [...live];
  const ports = (step) => ({
    alert: fake,
    board: board ?? (() => [{ id: 'S-2', card: 'C-2', alive: false, ended: true, lastWriteAt: E.clock.t - 10 * MIN }]),
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
  test(`L321: a tick whose clock moves ${lag / 1000} s at every read still parks the stopped card and puts the dead one on the owner`, async () => {
    const { E, alerts, ports, card } = world();
    // Every read of the clock is `lag` later: each step, and stopPass after its saves, starts that long after the last.
    const clock = () => (E.clock.t += lag);
    const r = await tick({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t, clock, ports: ports(() => {}) });
    assert.equal(r.steps.stops.ok, true, r.steps.stops.error);
    assert.equal(r.steps.outage.ok, true, r.steps.outage.error);
    assert.deepEqual([card('C-1').state, card('C-1').wait?.what], ['waiting', 'paused'], 'the stopped card is parked');
    assert.equal(E.record.read('fact', STOP_FACT('S-1')).doc.moved, true);
    assert.deepEqual([card('C-2').state, card('C-2').wait?.who], ['waiting', 'joe'], 'the dead card is on the owner');
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

test('L323: a dead session\'s card the Record will not put on the owner is told, not dropped', async () => {
  const { E, alerts, ports, card } = world();
  // No clock, and reading the sessions takes 80 s: the outage step's ask is written at the tick's start time.
  const r = await tick({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t,
    ports: { ...ports(() => {}), sessions: () => { E.clock.t += 80_000; return []; } } });
  assert.equal(card('C-2').state, 'running', 'the ask was refused');
  assert.deepEqual(r.refused.find(([c]) => c === 'joe_wait'), ['joe_wait', 'told']);
  assert.match(alerts.join(' | '), /a card could not be put on you: C-2 \(wait\.since must be now/);
});

test('L321: timeLimits puts a card on the owner after reviewer checks that took 80 s, on the real writer', async () => {
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

// A card parked through the real writer, at `now` on its clock.
const park = (rec, id, now) => { setClock(rec, now); assert.equal(waitOn(rec, id, { who: 'usage', what: 'usage_band', now, kind: 'park_red' }).ok, true); };

test('L323, L332 MAT-1: refusals fold by cause and are kept while their card has not moved; a cause whose step did not finish is left as it is', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['card', 'C-2', { state: 'running' }]]);
  const alert = fakeAlert();
  const told = alert.texts;
  // What the outbox sender does once a copy is delivered: the mark's fields go onto its fact.
  const delivered = () => { for (const [, o] of alert.calls.splice(0)) rec.write({ actor: 'dispatcher', entity: 'fact', id: o.mark.fact, expectRev: rec.read('fact', o.mark.fact)?.rev ?? 0, doc: { ...rec.read('fact', o.mark.fact)?.doc, ...o.mark.fields } }); };
  const running = JSON.stringify(['running', null, null]);
  const item = (id, reason) => ({ entity: 'card', id, kind: 'park_paused', reason, from: running });
  const all = () => true;
  const r1 = tellRefused({ rec, alert, now: T0, refused: new Map([['park', [item('C-1', 'r1'), item('C-2', 'r2')]]]), ran: all });
  assert.deepEqual(r1.find(([c]) => c === 'park'), ['park', 'told']);
  assert.equal(told.length, 1, 'one alert for the cause');
  assert.match(told[0], /C-1 \(r1\); C-2 \(r2\); told again each day while it stays so/);
  delivered();
  assert.deepEqual(rec.read('fact', REFUSED_FACT('park')).doc.items.map((x) => x.id), ['C-1', 'C-2'], 'kept on the fact');
  // No refusal this pass, every step finished, but neither card has moved: still refused (Probe A), quiet within a day.
  assert.deepEqual(tellRefused({ rec, alert, now: T0 + H, refused: new Map(), ran: all }).find(([c]) => c === 'park'), ['park', 'quiet']);
  assert.ok(rec.read('fact', REFUSED_FACT('park')).doc.told_at);
  // C-1 moves on: only C-2 is kept, and told again a day on.
  park(rec, 'C-1', T0 + 25 * H);
  assert.deepEqual(tellRefused({ rec, alert, now: T0 + 25 * H, refused: new Map(), ran: all }).find(([c]) => c === 'park'), ['park', 'told']);
  assert.match(told.at(-1), /could not be parked: C-2 \(r2\);/);
  assert.doesNotMatch(told.at(-1), /C-1/);
  delivered();
  // A write of C-2 the Writer took counts as moved on, even with its state unchanged.
  const r3 = tellRefused({ rec, alert, now: T0 + 26 * H, refused: new Map(), taken: new Map([['park', new Set(['card/C-2'])]]), ran: all });
  assert.deepEqual(r3.find(([c]) => c === 'park'), ['park', 'cleared']);
  assert.deepEqual([rec.read('fact', REFUSED_FACT('park')).doc.told_at, rec.read('fact', REFUSED_FACT('park')).doc.items], [null, []]);
  // A mark with nothing kept (written before items were kept) is left alone while its step did not finish, or when
  // `ran` is left out (L332 c4: no answer is not "ended"), and cleared once every step finished.
  rec.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('park'), expectRev: rec.read('fact', REFUSED_FACT('park')).rev, doc: { told_at: iso(T0 + 26 * H) } });
  assert.deepEqual(tellRefused({ rec, alert, now: T0 + 27 * H, refused: new Map(), ran: (st) => st !== 'stops' }).find(([c]) => c === 'park'), ['park', 'kept']);
  assert.deepEqual(tellRefused({ rec, alert, now: T0 + 27 * H, refused: new Map() }).find(([c]) => c === 'park'), ['park', 'kept']);
  assert.ok(rec.read('fact', REFUSED_FACT('park')).doc.told_at);
  assert.deepEqual(tellRefused({ rec, alert, now: T0 + 28 * H, refused: new Map(), ran: all }).find(([c]) => c === 'park'), ['park', 'cleared']);
});

test('L332 m6: a refused clear keeps the cause, and a throw in one cause does not skip the others', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }]]);
  const alert = fakeAlert();
  const running = JSON.stringify(['running', null, null]);
  tellRefused({ rec, alert, now: T0, ran: () => true, refused: new Map([['park', [{ entity: 'card', id: 'C-1', kind: 'park_paused', reason: 'r', from: running }]]]) });
  for (const [, o] of alert.calls.splice(0)) rec.write({ actor: 'dispatcher', entity: 'fact', id: o.mark.fact, expectRev: rec.read('fact', o.mark.fact).rev, doc: { ...rec.read('fact', o.mark.fact).doc, ...o.mark.fields } });
  park(rec, 'C-1', T0 + H);
  // The Writer refuses the clear: the cause stays marked, and the tick is told (it throws, after every cause is tried).
  const refusing = Object.create(rec);
  Object.defineProperty(refusing, 'write', { value: (x) => (x.kind === 'write_refused_cleared' ? { ok: false, reason: 'refused for the test' } : rec.write(x)) });
  // And the joe_wait cause's alert throws: the causes after it are still tried.
  const throwing = fakeAlert();
  const tellAll = (r, a, refused) => { try { tellRefused({ rec: r, alert: a, now: T0 + H, ran: () => true, refused }); return null; } catch (e) { return e.message; } };
  const err = tellAll(refusing, throwing, new Map());
  assert.match(err, /park: its clear was refused \(refused for the test\)/);
  assert.ok(rec.read('fact', REFUSED_FACT('park')).doc.told_at, 'still marked');
  assert.equal(rec.read('fact', REFUSED_FACT('park')).doc.items.length, 1, 'still kept');
  const bad = Object.assign((t) => { if (/could not be put on you/.test(t)) throw new Error('port down'); return true; }, {});
  const both = new Map([['joe_wait', [{ entity: 'card', id: 'C-9', kind: 'dead_ask', reason: 'r', from: 'absent' }]], ['review_count', [{ entity: 'card', id: 'C-8', kind: 'review_request', reason: 'r', from: 'absent' }]]]);
  const r = recWith();
  const later = fakeAlert();
  const fail = tellAll(r, (t, m) => (/could not be put on you/.test(t) ? bad(t) : later(t, m)), both);
  assert.match(fail, /joe_wait: port down/);
  assert.match(later.texts.join(' | '), /could not be counted, so it would never reach you: C-8/, 'the cause after the throw is still told');
});

test('L323: watchWrites notes refused writes of a watched kind with their target\'s state, and taken ones, and passes every answer back', () => {
  const answers = { a: { ok: false, reason: 'no' }, b: { ok: true }, c: { ok: false, reason: 'other' } };
  const base = Object.freeze({ write: (x) => answers[x.id], read: (entity, id) => (id === 'a' ? { rev: 1, doc: { state: 'running' } } : null) });
  const w = watchWrites(base);
  assert.deepEqual(w.rec.write({ entity: 'card', id: 'a', kind: 'park_paused' }), { ...answers.a, watched: 'park' });
  assert.equal(w.rec.write({ entity: 'card', id: 'b', kind: 'park_red' }), answers.b);
  assert.equal(w.rec.write({ entity: 'card', id: 'c', kind: 'note' }), answers.c, 'not watched, so no one else tells it');
  assert.deepEqual([...w.refused], [['park', [{ entity: 'card', id: 'a', kind: 'park_paused', reason: 'no', from: JSON.stringify(['running', null, null]) }]]]);
  assert.deepEqual([...w.taken].map(([c, s]) => [c, [...s]]), [['park', ['card/b']]]);
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

test('L332 MAT-1 (Probe A): a dead ask refused at an outage\'s end stays told while the card is stuck, though no pass asks again', async () => {
  const { E, fake, alerts, ports, card, fresh } = world({ pause: false, cards: ['C-2'], live: [], board: () => [] });
  assert.equal(E.record.write({ actor: 'dispatcher', entity: 'fact', id: OUTAGE_FACT, expectRev: 0, kind: 'outage_start', doc: { id: 'outage-x', state: 'open', started_at: new Date(E.clock.t - H).toISOString(), dead: [{ id: 'S-2', card: 'C-2' }], board: 3, healthy_passes: 1, told_id: 'outage-x' } }).ok, true);
  const rules = rulesWith({}, allow);
  const pass = async (opts = {}) => { fake.reset(); fresh(); return tick({ rec: E.record, rules, now: E.clock.t, clock: () => E.clock.t, ...opts, ports: { ...ports(), ...(opts.ports ?? {}) } }); };
  const told = () => alerts.filter((a) => /a card could not be put on you: C-2/.test(a));
  // The outage ends this pass; its ask is written at the tick's start time while reading the sessions takes 80 s.
  const r0 = await pass({ clock: undefined, ports: { sessions: () => { E.clock.t += 80_000; return []; } } });
  assert.deepEqual([r0.refused.find(([c]) => c === 'joe_wait'), told().length, card('C-2').state], [['joe_wait', 'told'], 1, 'running']);
  E.clock.t += 5 * MIN;
  const r1 = await pass();
  assert.equal(card('C-2').state, 'running', 'no later pass asks again');
  assert.deepEqual([r1.refused.find(([c]) => c === 'joe_wait'), told()], [['joe_wait', 'quiet'], []], 'kept, not cleared');
  E.clock.t += 25 * H;
  const r2 = await pass();
  assert.deepEqual([r2.refused.find(([c]) => c === 'joe_wait'), told().length, card('C-2').state], [['joe_wait', 'told'], 1, 'running'], 'told again a day on');
  // The card is put on the owner (any move will do): the cause clears.
  assert.equal(waitOn(E.record, 'C-2', { who: 'joe', what: 'dead session', now: E.clock.t, kind: 'wait' }).ok, true);
  const r3 = await pass();
  assert.deepEqual(r3.refused.find(([c]) => c === 'joe_wait'), ['joe_wait', 'cleared']);
});

// A done stop of C-1 whose park was refused, made by the Dispatcher as stopPass makes it.
const stopFact = (E, sid) => assert.equal(E.record.write({ actor: 'dispatcher', entity: 'fact', id: STOP_FACT(sid), expectRev: 0, kind: 'stop_done',
  doc: { state: 'done', reason: 'needs_split', card: 'C-1', since: new Date(E.clock.t - H).toISOString(), stopped_at: new Date(E.clock.t - 30 * MIN).toISOString(), moved: false, move_reason: 'x' } }).ok, true);

test('L332 m3 (Probe C): a stop whose card now runs under another session is marked superseded, and that run is not parked', async () => {
  const { E, card } = world({ pause: false, cards: ['C-1'], live: [] });
  const cur = E.record.read('card', 'C-1');
  seed(E, 'card', 'C-1', { ...cur.doc, claim: { ...cur.doc.claim, session_id: 'S-9' } });
  stopFact(E, 'S-1');
  stopFact(E, 'S-8');
  const sessions = [{ id: 'S-9', product: PRODUCT, kind: 'editing', card: 'C-1', pgid: 77 }];
  await stopPass({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t, clock: () => E.clock.t, account: 'acct-a', sessions, probe: () => idle,
    alert: fakeAlert(), stopGroup: async () => ({ ok: true, how: 'x' }), saveWork: async () => ({ ok: true }) });
  assert.equal(card('C-1').state, 'running', 'the new run is not parked');
  for (const sid of ['S-1', 'S-8']) {
    const f = E.record.read('fact', STOP_FACT(sid)).doc;
    assert.deepEqual([f.moved, f.move_reason], ['superseded', 'the card runs under session S-9 now'], sid);
  }
  // The stop of the session that still runs it is parked, as before.
  stopFact(E, 'S-9');
  await stopPass({ rec: E.record, rules: rulesWith({}, allow), now: E.clock.t, clock: () => E.clock.t, account: 'acct-a', sessions: [], probe: () => idle,
    alert: fakeAlert(), stopGroup: async () => ({ ok: true, how: 'x' }), saveWork: async () => ({ ok: true }) });
  assert.deepEqual([card('C-1').state, card('C-1').wait?.what, E.record.read('fact', STOP_FACT('S-9')).doc.moved], ['waiting', 'needs_split', true]);
});

test('L332 MAT-2 (Probe D): a parked card whose resume the Record refuses is told, and cleared once it moves', async () => {
  const { E, fake, alerts, ports, card, fresh } = world({ pause: false, cards: ['C-1'], live: [], board: () => [] });
  const { claim, ...rest } = E.record.read('card', 'C-1').doc;
  seed(E, 'card', 'D-1', { ...rest, state: 'failed', failure: 'x' });
  seed(E, 'card', 'C-1', { ...rest, depends_on: ['D-1'], state: 'waiting', wait: { who: 'usage', what: 'usage_band', since: new Date(E.clock.t - H).toISOString(), next_check: new Date(E.clock.t - 1).toISOString(), resume: 'retry', return_to: 'ready' } });
  const rules = rulesWith({}, allow);
  const pass = async () => { fake.reset(); fresh(); return tick({ rec: E.record, rules, now: E.clock.t, clock: () => E.clock.t, ports: ports() }); };
  const r1 = await pass();
  assert.equal(card('C-1').state, 'waiting');
  assert.deepEqual(r1.refused.find(([c]) => c === 'resume'), ['resume', 'told']);
  assert.match(alerts.join(' | '), /a parked card could not be put back in the queue: C-1 \(not ready: dependency D-1 is failed/);
  E.clock.t += 10 * MIN;
  assert.deepEqual((await pass()).refused.find(([c]) => c === 'resume'), ['resume', 'quiet']);
  // The card moves on (now waiting on the owner, not on usage): the cause clears (L352 m3).
  E.clock.t += 10 * MIN;
  assert.equal(waitOn(E.record, 'C-1', { who: 'joe', what: 'moved by the test', now: E.clock.t, kind: 'test_move' }).ok, true);
  assert.deepEqual((await pass()).refused.find(([c]) => c === 'resume'), ['resume', 'cleared']);
  assert.equal(E.record.read('fact', REFUSED_FACT('resume')).doc.told_at, null);
});

test('L332 MAT-2: a time limit\'s end the Record refuses is noted under its own cause', async () => {
  const rec = recWith([['card', 'C-1', { state: 'running', product: 'p1' }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: iso(T0) }]]);
  const refusing = Object.create(rec);
  Object.defineProperty(refusing, 'write', { value: (x) => (x.kind === 'timeout' ? { ok: false, reason: 'refused for the test' } : rec.write(x)) });
  const w = watchWrites(refusing);
  setClock(rec, T0 + 11 * MIN);
  await timeLimits({ rec: w.rec, rules: rulesWith(), now: T0 + 11 * MIN, b: { band: 'green', own_building: 'open' }, running: [], gateAlive: () => true, alert: fakeAlert() });
  assert.deepEqual(w.refused.get('timeout')?.map((x) => [x.entity, x.id, x.reason]), [['card', 'C-1', 'refused for the test'], ['session', 'S-1', 'refused for the test']]);
  // Told, then cleared once both writes are taken (L352 m3).
  const alert = fakeAlert();
  assert.deepEqual(tellRefused({ ...w, rec, alert, now: T0 + 11 * MIN, ran: () => true }).find(([c]) => c === 'timeout'), ['timeout', 'told']);
  assert.match(alert.texts[0], /a session past its time limit could not be ended, or its card could not be failed: C-1 \(refused for the test\); S-1/);
  for (const [, o] of alert.calls.splice(0)) rec.write({ actor: 'dispatcher', entity: 'fact', id: o.mark.fact, expectRev: rec.read('fact', o.mark.fact).rev, doc: { ...rec.read('fact', o.mark.fact).doc, ...o.mark.fields } });
  const w2 = watchWrites(rec);
  setClock(rec, T0 + 12 * MIN);
  await timeLimits({ rec: w2.rec, rules: rulesWith(), now: T0 + 12 * MIN, b: { band: 'green', own_building: 'open' }, running: [], gateAlive: () => true, alert: fakeAlert() });
  assert.equal(rec.read('session', 'S-1').doc.state, 'ended');
  assert.deepEqual(tellRefused({ ...w2, rec, alert, now: T0 + 12 * MIN, ran: () => true }).find(([c]) => c === 'timeout'), ['timeout', 'cleared']);
});

test('L352 c1: a time limit whose card only could not be failed says so', async () => {
  const rec = recWith([['card', 'C-1', { state: 'running', product: 'p1' }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: iso(T0) }]]);
  const refusing = Object.create(rec);
  Object.defineProperty(refusing, 'write', { value: (x) => (x.kind === 'timeout' && x.entity === 'card' ? { ok: false, reason: 'refused for the test' } : rec.write(x)) });
  const w = watchWrites(refusing);
  setClock(rec, T0 + 11 * MIN);
  await timeLimits({ rec: w.rec, rules: rulesWith(), now: T0 + 11 * MIN, b: { band: 'green', own_building: 'open' }, running: [], gateAlive: () => true, alert: fakeAlert() });
  const alert = fakeAlert();
  tellRefused({ ...w, rec, alert, now: T0 + 11 * MIN, ran: () => true });
  assert.match(alert.texts[0], /^the Dispatcher: a card past its time limit could not be failed: C-1 \(refused for the test\); told again/);
});

test('L332 P10, P13: a refused write\'s mark is written only once its alert is delivered, and the tick says which steps finished', async () => {
  const { E, fake, alerts, ports, card, fresh } = world();
  const rules = rulesWith({}, allow);
  let up = false;
  const port = Object.assign((t, e) => (up ? fake(t, e) : false), {});
  const pass = async (opts = {}) => { fake.reset(); fresh(); return tick({ rec: E.record, rules, now: E.clock.t, ...opts, ports: { ...ports(), alert: port, ...(opts.ports ?? {}) } }); };
  // The ask is refused while the alert port is down: told, but not marked.
  await pass({ ports: { sessions: () => { E.clock.t += 80_000; return []; } } });
  assert.equal(card('C-2').state, 'running');
  assert.equal(E.record.read('fact', REFUSED_FACT('joe_wait'))?.doc?.told_at ?? null, null, 'not marked before delivery (P10)');
  // A legacy mark (no list) on another cause, with every step finishing: cleared only because the tick says so (P13).
  E.record.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('review_count'), expectRev: 0, doc: { told_at: new Date(E.clock.t).toISOString() }, kind: 'x' });
  up = true;
  E.clock.t += 5 * MIN;
  const r = await pass({ clock: () => E.clock.t });
  assert.match(alerts.join(' | '), /a card could not be put on you: C-2/, 'told on the next pass that delivers');
  assert.equal(r.refused.find(([c]) => c === 'review_count')[1], 'cleared', JSON.stringify(r.steps));
});

test('L332 MAT-1: a refused write taken on a later pass, with its card in the same state, clears the cause through the tick', async () => {
  const { E, fake, ports, card, fresh } = world({ pause: false, cards: ['C-1'], live: [], board: () => [] });
  const { claim, ...rest } = E.record.read('card', 'C-1').doc;
  seed(E, 'card', 'C-3', { ...rest, state: 'in_review', head: 'a'.repeat(40) });
  E.clock.t += 3 * H; // in review with no reviewer for longer than its limit
  let refuse = true;
  const rec = Object.create(E.record);
  Object.defineProperty(rec, 'write', { value: (x) => (refuse && x.kind === 'review_request' ? { ok: false, reason: 'refused for the test' } : E.record.write(x)) });
  const rules = rulesWith({}, allow);
  const pass = async () => { fake.reset(); fresh(); return tick({ rec, rules, now: E.clock.t, clock: () => E.clock.t, ports: { ...ports(), hasReviewer: () => false } }); };
  const r1 = await pass();
  assert.deepEqual(r1.refused.find(([c]) => c === 'review_count'), ['review_count', 'told'], JSON.stringify(r1.steps));
  assert.equal(card('C-3').state, 'in_review');
  refuse = false;
  E.clock.t += 3 * H;
  const r2 = await pass();
  assert.equal(card('C-3').state, 'in_review', 'still in review: only the count was written');
  assert.deepEqual(r2.refused.find(([c]) => c === 'review_count'), ['review_count', 'cleared']);
});

// L386: a refused tell moves nothing, so no card write is ever tried and nothing else would tell it.
const tellWorld = () => {
  const w = world({ pause: false, cards: [], live: [], board: () => [] });
  const { E, ports, fake, fresh } = w;
  readyCard(E, 'C-8');
  seed(E, 'card', 'C-9', { ...E.record.read('card', 'C-8').doc, state: 'waiting', wait: { who: 'usage', what: 'limit_hit', since: iso(E.clock.t), next_check: iso(E.clock.t), account: 'acct-a', resume: 'retry', return_to: 'ready' } });
  const state = { refuse: (x) => x.kind === 'wait_tell' };
  const rec = Object.create(E.record);
  Object.defineProperty(rec, 'write', { value: (x) => (state.refuse(x) ? { ok: false, reason: 'refused for the test' } : E.record.write(x)) });
  const rules = rulesWith({}, allow);
  const pass = async () => { fake.reset(); fresh(); return tick({ rec, rules, now: E.clock.t, clock: () => E.clock.t, ports: ports() }); };
  return { ...w, pass, state };
};
const askCause = (r) => r.refused.find(([c]) => c === 'joe_wait');

test('L386: a refused tell at limit_no_run is told at once, quiet at +1 h, told again at +24 h, and cleared once it lands', async () => {
  const { E, alerts, card, pass, state } = tellWorld();
  const told = () => alerts.filter((x) => /a card could not be put on you: C-9 \(refused for the test\)/.test(x));
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'told']);
  assert.equal(told().length, 1, alerts.join(' | '));
  assert.equal(card('C-9').wait.who, 'usage', 'nothing moved');
  E.clock.t += H;
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'quiet']);
  assert.equal(told().length, 0, alerts.join(' | '));
  E.clock.t += 24 * H;
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'told']);
  assert.equal(told().length, 1, alerts.join(' | '));
  state.refuse = () => false;
  E.clock.t += MIN;
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'cleared']);
  assert.equal(card('C-9').wait.who, 'joe');
  assert.ok(alerts.some((x) => /^card C-9: it waits on account acct-a's usage limit/.test(x)), alerts.join(' | '));
});

test('L386: a refused tell whose card has moved on clears, as nothing will ever write that fact', async () => {
  const { E, pass } = tellWorld();
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'told']);
  const w = waitOn(E.record, 'C-9', { who: 'dependency', what: 'another_wait', now: E.clock.t });
  assert.equal(w.ok, true, w.reason);
  E.clock.t += MIN;
  assert.deepEqual(askCause(await pass()), ['joe_wait', 'cleared']);
});

test('L386: a refused copy of a since is told in the card\'s own text, not as "could not be put on you"', async () => {
  const { alerts, card, pass, state } = tellWorld();
  state.refuse = (x) => x.kind === 'wait_tell_copy';
  const r = await pass();
  assert.equal(card('C-9').wait.who, 'joe', 'the card is on the owner');
  assert.notEqual(askCause(r)[1], 'told', alerts.join(' | '));
  assert.doesNotMatch(alerts.join(' | '), /a card could not be put on you/);
  assert.match(alerts.join(' | '), /card C-9: .*could not be kept with its wait \(refused for the test\)/);
});

test('L405 c1: a cause told with nothing kept stays kept while any step that makes its writes did not finish', () => {
  const told = () => {
    const rec = recWith([['fact', REFUSED_FACT('joe_wait'), { told_at: iso(T0), items: [] }]]);
    return { rec, alert: fakeAlert() };
  };
  const did = ({ rec, alert }, ran) => tellRefused({ rec, alert, now: T0 + H, refused: new Map(), ran }).find(([c]) => c === 'joe_wait')[1];
  for (const step of ['outage', 'pass', 'limits', 'merges']) assert.equal(did(told(), (s) => s !== step), 'kept', step);
  assert.equal(did(told(), () => true), 'cleared');
});

test('L386: the watcher notes a refused tell with its card\'s state, not its fact\'s', () => {
  const base = keptWorld(['C-1']).rec;
  const inner = Object.create(base);
  Object.defineProperty(inner, 'write', { value: () => ({ ok: false, reason: 'r' }) });
  const watched = watchWrites(inner);
  watched.rec.write({ actor: 'dispatcher', entity: 'fact', id: 'wait-tell-C-1', expectRev: 0, doc: { since: iso(T0), text: 't' }, kind: 'wait_tell' });
  assert.deepEqual(watched.refused.get('joe_wait'), [{ entity: 'fact', id: 'wait-tell-C-1', kind: 'wait_tell', reason: 'r', from: running }]);
});

test('L386: a refused tell tried only once stays told while its card has not moved, then clears when it does', () => {
  // The outage step asks about a dead session once, so no later refusal keeps this alive.
  const w = keptWorld(['C-1']);
  const tell = { entity: 'fact', id: 'wait-tell-C-1', kind: 'wait_tell', reason: 'r', from: running };
  assert.equal(tellRefused({ rec: w.rec, alert: w.alert, now: T0, refused: new Map([['joe_wait', [tell]]]), ran: () => true }).find(([c]) => c === 'joe_wait')[1], 'told');
  const again = (now) => tellRefused({ rec: w.rec, alert: w.alert, now, refused: new Map(), ran: () => true }).find(([c]) => c === 'joe_wait')[1];
  w.delivered();
  assert.equal(again(T0 + H), 'quiet');
  assert.deepEqual(w.rec.read('fact', REFUSED_FACT('joe_wait')).doc.items.map((x) => x.id), ['wait-tell-C-1']);
  park(w.rec, 'C-1', T0 + 2 * H);
  assert.equal(again(T0 + 2 * H), 'cleared');
});

test('L386: a tell taken does not clear a card write still refused, and the ask cause waits on every step that writes a tell', () => {
  assert.deepEqual(REFUSED_CAUSES.joe_wait.steps, ['outage', 'pass', 'limits', 'merges']);
  const w = keptWorld(['C-1']);
  w.tell(w.rec, T0, new Map([['joe_wait', [{ ...w.item('C-1'), kind: 'dead_ask' }]]]));
  const r = tellRefused({ rec: w.rec, alert: w.alert, now: T0 + MIN, refused: new Map(), taken: new Map([['joe_wait', new Set(['fact/wait-tell-C-1'])]]), ran: () => true });
  assert.deepEqual(r.find(([c]) => c === 'joe_wait'), ['joe_wait', 'quiet']);
});

// L352: a kept refusal is never cleared by what can't be read: a target, a kept list or its entries, or the overflow.
const running = JSON.stringify(['running', null, null]);
const keptWorld = (ids = ['C-1']) => {
  const rec = recWith(ids.map((id) => ['card', id, { state: 'running' }]));
  const alert = fakeAlert();
  const delivered = () => { for (const [, o] of alert.calls.splice(0)) rec.write({ actor: 'dispatcher', entity: 'fact', id: o.mark.fact, expectRev: rec.read('fact', o.mark.fact)?.rev ?? 0, doc: { ...rec.read('fact', o.mark.fact)?.doc, ...o.mark.fields } }); };
  const tell = (r, now, refused = new Map()) => { const out = tellRefused({ rec: r, alert, now, refused, ran: () => true }); delivered(); return out.find(([c]) => c === 'park')[1]; };
  const item = (id, from = running) => ({ entity: 'card', id, kind: 'park_paused', reason: 'r', from });
  return { rec, alert, tell, item, delivered, fact: () => rec.read('fact', REFUSED_FACT('park')) };
};

test('L352 MAT-1: a kept refusal whose target can\'t be read now, or could not be read when refused, is still refused', () => {
  // Now: the card's read throws on a later pass.
  const a = keptWorld();
  assert.equal(a.tell(a.rec, T0, new Map([['park', [a.item('C-1')]]])), 'told');
  const blind = Object.create(a.rec);
  Object.defineProperty(blind, 'read', { value: (e, id) => { if (e === 'card') throw new Error('unreadable'); return a.rec.read(e, id); } });
  assert.equal(a.tell(blind, T0 + H), 'quiet');
  assert.equal(a.tell(blind, T0 + 25 * H), 'told');
  assert.equal(a.fact().doc.items.length, 1);
  // Then: refused while unreadable; the read works again with the card as it was.
  const b = keptWorld();
  assert.equal(b.tell(b.rec, T0, new Map([['park', [b.item('C-1', 'unreadable')]]])), 'told');
  assert.equal(b.tell(b.rec, T0 + 25 * H), 'told');
  assert.equal(b.fact().doc.items.length, 1);
  // A write of it taken still clears it.
  assert.equal(tellRefused({ rec: b.rec, alert: b.alert, now: T0 + 26 * H, refused: new Map(), taken: new Map([['park', new Set(['card/C-1'])]]), ran: () => true }).find(([c]) => c === 'park')[1], 'cleared');
});

test('L352 MAT-2: a kept list that is not a list, or holds an entry that can\'t be read, is told as unreadable, not cleared', () => {
  for (const items of ['garbage', { a: 1 }, [{ entity: 'card', id: 'C-1' }]]) {
    const w = keptWorld();
    w.rec.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('park'), expectRev: 0, doc: { items, told_at: iso(T0) } });
    const did = w.tell(w.rec, T0 + 25 * H);
    assert.equal(did, 'told', JSON.stringify(items));
    assert.match(w.alert.texts.at(-1), /the kept list could not be read; at least 1 more refused write was not listed/, JSON.stringify(items));
    assert.equal(w.fact().doc.more, 1, 'counted, so it is not cleared later');
    assert.equal(w.tell(w.rec, T0 + 26 * H), 'quiet');
    assert.equal(w.tell(w.rec, T0 + 50 * H), 'told');
    assert.ok(w.fact().doc.told_at);
  }
  // An unreadable `more` count is at least one.
  const w = keptWorld();
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('park'), expectRev: 0, doc: { items: [], more: 'x', told_at: iso(T0) } });
  assert.equal(w.tell(w.rec, T0 + 25 * H), 'told');
  assert.equal(w.fact().doc.more, 1);
});

test('L352 m1, L361, L366 m-A: refusals past the kept cap stay by id, one alert lists 20, and they clear when they move', () => {
  assert.deepEqual([REFUSED_KEEP_MAX, REFUSED_LIST_MAX], [200, 20]);
  const ids = Array.from({ length: REFUSED_KEEP_MAX + 2 }, (_, i) => `C-${i + 1}`);
  const w = keptWorld(ids);
  assert.equal(w.tell(w.rec, T0, new Map([['park', ids.map((id) => w.item(id))]])), 'told');
  const first = w.alert.texts.at(-1);
  assert.deepEqual([w.fact().doc.items.length, w.fact().doc.over.map((x) => x.id), w.fact().doc.more], [REFUSED_KEEP_MAX, ['C-1', 'C-2'], 0]);
  assert.match(first, /C-202 \(r\); and 182 more still refused; told again/);
  assert.doesNotMatch(first, /C-182 \(|resets this reminder/);
  assert.match(first, /C-183 \(/);
  for (const id of ids) park(w.rec, id, T0 + H);
  assert.equal(w.tell(w.rec, T0 + H), 'cleared');
  assert.deepEqual([w.fact().doc.items, w.fact().doc.over, w.fact().doc.more], [[], [], 0]);
});

test('L366 m-A: the same refusals past the cap, repeated each pass, keep a steady count, and an entry past it shows no reason', () => {
  const ids = Array.from({ length: REFUSED_KEEP_MAX + 2 }, (_, i) => `C-${i + 1}`);
  const w = keptWorld(ids);
  for (let pass = 0; pass < 5; pass += 1) w.tell(w.rec, T0 + pass * MIN, new Map([['park', ids.map((id) => w.item(id))]]));
  assert.deepEqual([w.fact().doc.items.length, w.fact().doc.over.length, w.fact().doc.more], [REFUSED_KEEP_MAX, 2, 0]);
  // The kept ones move, so the two kept by id alone come into the alert's list.
  for (const id of ids.slice(2)) park(w.rec, id, T0 + 25 * H);
  assert.equal(w.tell(w.rec, T0 + 25 * H), 'told');
  assert.match(w.alert.texts.at(-1), /could not be parked: C-1; C-2; told again/);
});

test('L366 m-A: a write refused twice in a pass counts once', () => {
  const ids = Array.from({ length: REFUSED_KEEP_MAX + 2 }, (_, i) => `C-${i + 1}`);
  const w = keptWorld(ids);
  w.tell(w.rec, T0, new Map([['park', [...ids, ...ids].map((id) => w.item(id))]]));
  assert.deepEqual([w.fact().doc.items.length, w.fact().doc.over.length, w.fact().doc.more], [REFUSED_KEEP_MAX, 2, 0]);
  const small = keptWorld(['C-1', 'C-2']);
  small.tell(small.rec, T0, new Map([['park', ['C-1', 'C-2', 'C-1'].map((id) => small.item(id))]]));
  assert.deepEqual(small.fact().doc.items.map((x) => x.id).sort(), ['C-1', 'C-2']);
});

test('L366 m-A: refusals past both lists are a steady "at least", name who resets it, and keep the cause when the rest move', () => {
  const ids = Array.from({ length: REFUSED_KEEP_MAX + REFUSED_OVER_MAX + 3 }, (_, i) => `C-${i + 1}`);
  const w = keptWorld(ids);
  for (let pass = 0; pass < 3; pass += 1) w.tell(w.rec, T0 + pass * MIN, new Map([['park', ids.map((id) => w.item(id))]]));
  assert.deepEqual([w.fact().doc.items.length, w.fact().doc.over.length, w.fact().doc.more], [REFUSED_KEEP_MAX, REFUSED_OVER_MAX, 3]);
  const first = w.alert.texts.at(-1);
  assert.match(first, /at least 3 more refused writes were not listed, so once the listed ones are fixed the lead resets this reminder \(fact /);
  assert.ok(first.includes(REFUSED_FACT('park')), 'names the fact to reset');
  for (const id of ids) park(w.rec, id, T0 + 25 * H);
  assert.equal(w.tell(w.rec, T0 + 25 * H), 'told');
  assert.match(w.alert.texts.at(-1), /could not be parked: at least 3 more refused writes were not listed/);
  assert.ok(w.fact().doc.told_at);
});

test('L366 m-B: "the kept list could not be read" stays on the fact through a quiet pass, for the next alert', () => {
  for (const doc of [{ items: 'x' }, { items: [], over: 'x' }, { items: [], over: [{ id: 1 }] }]) {
    const w = keptWorld();
    w.rec.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('park'), expectRev: 0, doc: { ...doc, told_at: iso(T0) } });
    assert.equal(w.tell(w.rec, T0 + H), 'quiet');
    assert.deepEqual([w.fact().doc.unreadable, w.fact().doc.more], [true, 1], JSON.stringify(doc));
    assert.equal(w.tell(w.rec, T0 + 2 * H), 'quiet');
    assert.equal(w.fact().doc.more, 1, 'read clean now, so not counted again');
    assert.equal(w.tell(w.rec, T0 + 25 * H), 'told');
    assert.match(w.alert.texts.at(-1), /the kept list could not be read; at least 1 more refused write was not listed/);
  }
});

test('L366 m-C: a cause holding only a count is told on time through passes whose steps did not finish', () => {
  const w = keptWorld();
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: REFUSED_FACT('park'), expectRev: 0, doc: { items: [], more: 1, told_at: iso(T0) } });
  const out = tellRefused({ rec: w.rec, alert: w.alert, now: T0 + 25 * H, refused: new Map(), ran: () => false });
  assert.equal(out.find(([c]) => c === 'park')[1], 'told');
});

test('L352 m2: a kept list the Record will not write throws for its cause, so the tick is told', () => {
  const w = keptWorld();
  const refusing = Object.create(w.rec);
  Object.defineProperty(refusing, 'write', { value: (x) => (x.kind === 'write_refused_kept' ? { ok: false, reason: 'refused for the test' } : w.rec.write(x)) });
  assert.throws(() => tellRefused({ rec: refusing, alert: w.alert, now: T0, refused: new Map([['park', [w.item('C-1')]]]), ran: () => true }), /park: its list could not be kept \(refused for the test\)/);
});

test('L354 item 2: a cause whose queued alert cannot be dropped stays, and the step fails saying so', () => {
  const rec = recWith();
  const fact = REFUSED_FACT('park');
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: 0, doc: { told_at: new Date(now).toISOString(), items: [] } }).ok, true);
  queueFor(rec, fact, 'told_at', new Date(now).toISOString(), now);
  assert.throws(() => tellRefused({ rec: writeLog(rec, [], { refuseDrop: true }), alert: fakeAlert(), now, refused: new Map(), ran: () => true }), /park: its queued alert could not be dropped/);
  assert.notEqual(rec.read('fact', fact).doc.told_at, null, 'not cleared');
});
