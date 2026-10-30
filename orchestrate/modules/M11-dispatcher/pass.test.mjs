import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatcherPass, stopProcessGroup, STOP_FACT, LIMIT_FACT } from './pass.mjs';
import { USAGE_FACT, BAND_FACT } from './usage.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, usageFact, T0, MIN, H, iso } from './fixtures.test-helper.mjs';

const ACCT = 'acct-a';
const GREEN = { week: 30, h5: 20 };
const AMBER = { week: 20, h5: 75 };
const RED = { week: 90, h5: 20 };
// M10's answer: a paused product starts nothing. This test file does not decide product state.
const startAnswer = (rec) => ({ start_session: ({ product }) => (rec.read('product', product)?.doc?.state === 'paused'
  ? { decision: 'deny', reason: 'the product is paused' } : { decision: 'allow', reason: 'ok' }) });
const card = (id, over = {}) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN), ...over }];
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const busy = { size: { tokens: 1, turnEnded: false, openTools: ['t1'], compactions: 0 }, activity: { state: 'active' } };

function world(entries = [], { usage = GREEN, over = {} } = {}) {
  const rec = recWith([['product', 'p1', { state: 'active' }], ['product', 'p2', { state: 'active' }], ...entries]);
  const setUsage = (u, at = T0) => {
    const cur = rec.read('fact', USAGE_FACT(ACCT));
    rec.write({ actor: 'dispatcher', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: cur?.rev ?? 0, doc: usageFact({ ...u, account: ACCT, now: at }) });
  };
  if (usage) setUsage(usage);
  const rules = rulesWith(over, startAnswer(rec));
  const calls = { launched: [], stops: [], saves: [], alerts: [], pauses: [] };
  const sessions = [];
  const probes = new Map();
  let n = 0;
  let launchAnswer = () => ({ ok: true });
  const pass = (min = 0, extra = {}) => dispatcherPass({
    rec, rules: extra.rules ?? rules, now: T0 + min * MIN, account: ACCT, sessions: [...sessions],
    probe: (s) => probes.get(s.id) ?? idle,
    launch: async (x) => { calls.launched.push(x.card.id); const a = launchAnswer(x); if (!a.ok) return a; const id = `S-${++n}`; sessions.push({ id, product: x.product, kind: x.kind, card: x.card.id, pgid: 100 + n }); return { ok: true, sessionId: id, pgid: 100 + n, head: 'head' in a ? a.head : 'h'.repeat(40) }; },
    stopGroup: async (s) => { calls.stops.push(s.id); const i = sessions.findIndex((x) => x.id === s.id); if (i >= 0) sessions.splice(i, 1); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async (s) => { calls.saves.push(s.id); return { ok: true }; },
    hostLock: () => extra.host ?? null,
    pauseLead: ({ product }) => { calls.pauses.push([product, [...calls.stops]]); },
    alert: (t) => calls.alerts.push(t),
  });
  const setCard = (id, patch) => { const c = rec.read('card', id); rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: c.rev, doc: { ...c.doc, ...patch } }); };
  const setProduct = (id, state) => { const c = rec.read('product', id); rec.write({ actor: 'dispatcher', entity: 'product', id, expectRev: c.rev, doc: { ...c.doc, state } }); };
  return { rec, calls, sessions, probes, pass, setCard, setProduct, setUsage, refuseLaunch: (f) => { launchAnswer = f; } };
}

test('R-0b-55 / m6: 3 ready cards and 1 paused -> one pass starts exactly the 3, nothing for the paused one', async () => {
  const w = world([card('C-1'), card('C-2'), card('C-3'), card('C-4', { product: 'p2' })]);
  w.setProduct('p2', 'paused');
  const r = await w.pass();
  assert.deepEqual(r.started.sort(), ['C-1', 'C-2', 'C-3']);
  assert.deepEqual(w.calls.launched.sort(), ['C-1', 'C-2', 'C-3']);
  assert.equal(w.rec.read('card', 'C-4').doc.state, 'ready');
  assert.match(r.refused.find(([id]) => id === 'C-4')[1], /paused/);
  for (const id of ['C-1', 'C-2', 'C-3']) assert.equal(w.rec.read('card', id).doc.state, 'running');
  // the next pass starts nothing more
  const r2 = await w.pass(1);
  assert.deepEqual(r2.started, []);
});

test('R-0b-55: within the caps: a fourth card waits for the per-product cap', async () => {
  const w = world([card('C-1'), card('C-2'), card('C-3'), card('C-5')]);
  const r = await w.pass();
  assert.equal(r.started.length, 3);
  assert.match(r.refused[0][1], /cap 3/);
});

test('R-0b-55: overlapping files do not start together', async () => {
  const w = world([card('C-1', { files: ['src/a.js'] }), card('C-2', { files: ['src/a.js'] })]);
  const r = await w.pass();
  assert.deepEqual(r.started, ['C-1']);
  assert.match(r.refused[0][1], /shares src\/a\.js/);
});

test('R-0b-55: a launcher refusal puts the card back to ready with the reason', async () => {
  const w = world([card('C-1')]);
  w.refuseLaunch(() => ({ ok: false, reason: 'check 7: the hook folder is missing' }));
  const r = await w.pass();
  assert.deepEqual(r.started, []);
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.match(c.last_refusal, /hook folder is missing/);
  w.refuseLaunch(() => { throw new Error('crashed'); });
  await w.pass(1);
  assert.match(w.rec.read('card', 'C-1').doc.last_refusal, /crashed/);
});

test('R-0b-55: the claim is rev-checked: a card changed since it was read is not launched', async () => {
  const w = world([card('C-1')]);
  const rec = w.rec;
  const real = rec.list.bind(rec);
  // another writer moves the card after the pass listed it
  const sneaky = { ...rec, list: (e) => { const l = real(e); if (e === 'card' && l.length) { const c = rec.read('card', 'C-1'); rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: c.rev, doc: { ...c.doc, note: 'x' } }); } return l; } };
  const r = await dispatcherPass({ rec: sneaky, rules: rulesWith({}, startAnswer(rec)), now: T0, account: ACCT, sessions: [], probe: () => idle,
    launch: async () => { throw new Error('must not launch'); }, stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), alert: () => {} });
  assert.deepEqual(r.started, []);
  assert.match(r.refused[0][1], /not claimed/);
});

test('R-0b-55 / M7: a cancelled running card is stopped at its next safe point; save-work runs, then the card stays cancelled', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  let r = await w.pass(1);
  assert.deepEqual(r.stopping, [[sid, 'cancel']]);
  assert.equal(w.calls.stops.length, 0, 'not mid-tool');
  w.probes.set(sid, idle);
  r = await w.pass(2);
  assert.deepEqual(r.stopped, [[sid, 'cancel']]);
  assert.deepEqual(w.calls.stops, [sid]);
  assert.deepEqual(w.calls.saves, [sid]);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'cancelled');
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.hard, false);
});

test('M7: a cancel is the kill switch: no safe point within the grace -> hard stop, logged', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  await w.pass(1);
  await w.pass(2);
  assert.equal(w.calls.stops.length, 0, 'inside the 2 min grace');
  await w.pass(3);
  assert.deepEqual(w.calls.stops, [sid]);
  assert.deepEqual(w.calls.saves, [sid]);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.hard, true);
  assert.match(w.rec.read('fact', `stop-note-${sid}`).doc.text, /without a safe point after 2 min \(cancel\)/);
});

test('M7: a park waits up to park_wait_min (15) before a hard stop', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.probes.set(sid, busy);
  w.setUsage(RED, T0 + MIN);
  await w.pass(1);
  w.setUsage(RED, T0 + 15 * MIN);
  await w.pass(15);
  assert.equal(w.calls.stops.length, 0);
  w.setUsage(RED, T0 + 16 * MIN);
  await w.pass(16);
  assert.deepEqual(w.calls.stops, [sid]);
  const c = w.rec.read('card', 'C-1').doc;
  assert.deepEqual([c.state, c.waiting.what], ['waiting', 'usage_band']);
});

test('M7: a park whose cause clears before a safe point is dropped; a cancel never is', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.probes.set(sid, busy);
  w.setUsage(RED, T0 + MIN);
  await w.pass(1);
  w.setUsage(GREEN, T0 + 2 * MIN);
  await w.pass(2);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'dropped');
  w.setUsage(GREEN, T0 + 30 * MIN);
  await w.pass(30);
  assert.equal(w.calls.stops.length, 0);
});

test('M8 / R-0b-67: red parks running editing work at a safe point and holds claims; it resumes on the first pass that is not red', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-9', expectRev: 0, doc: card('C-9')[2] });
  w.setUsage(RED, T0 + MIN);
  const r = await w.pass(1);
  assert.equal(r.stopped.length, 1);
  assert.deepEqual(r.started, [], 'red holds claims');
  assert.equal(w.rec.read('card', 'C-9').doc.state, 'ready');
  assert.equal(w.rec.read('fact', BAND_FACT).doc.band, 'red');
  w.setUsage(RED, T0 + 2 * MIN);
  assert.deepEqual((await w.pass(2)).resumed, []);
  w.setUsage(GREEN, T0 + 3 * MIN);
  const r3 = await w.pass(3);
  assert.deepEqual(r3.resumed, ['C-1']);
  assert.ok(r3.started.includes('C-1') && r3.started.includes('C-9'));
});

test('R-0b-67 / R-0b-68: in red, review / audit / merge sessions keep running and an undo card still starts', async () => {
  const w = world([card('U-1', { kind: 'undo', queue: 'front', go_free: true })], { usage: RED });
  w.sessions.push({ id: 'R-1', product: 'p1', kind: 'review', card: null }, { id: 'M-1', product: 'p1', kind: 'merge', card: null });
  const r = await w.pass();
  assert.deepEqual(w.calls.stops, []);
  assert.deepEqual(r.started, ['U-1']);
});

test('M8: limit_hit -> after the reset Tier 2 goes back to ready, Tier 1 waits on Joe', async () => {
  const wait = (tier) => ({ state: 'waiting', tier, account: ACCT, waiting: { who: 'dispatcher', what: 'limit_hit', since: iso(T0), next_check: iso(T0) } });
  const w = world([['card', 'T2', { ...wait(2), product: 'p1', files: ['src/t2.js'] }], ['card', 'T1', { ...wait(1), product: 'p1' }], ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN) }]]);
  await w.pass(10);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'waiting');
  w.setUsage(GREEN, T0 + 31 * MIN);
  await w.pass(31);
  assert.ok(['ready', 'running'].includes(w.rec.read('card', 'T2').doc.state));
  const t1 = w.rec.read('card', 'T1').doc;
  assert.deepEqual([t1.state, t1.waiting.who], ['waiting', 'joe']);
});

test('M8: usage unknown for over a day -> parked work waits on Joe, one alert', async () => {
  const parked = { state: 'waiting', product: 'p1', waiting: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'C-1', { ...parked, tier: 1 }]], { usage: null });
  await w.pass(0);
  // audit 0b-6 r2 MIN-2: while usage is unknown the card stays parked (the gate would hold it anyway)
  assert.equal(w.rec.read('card', 'C-1').doc.waiting.what, 'usage_band');
  await w.pass(24 * 60);
  assert.equal(w.rec.read('card', 'C-1').doc.waiting.what, 'usage_band', 'a day exactly is not over a day');
  await w.pass(24 * 60 + 1);
  assert.equal(w.rec.read('card', 'C-1').doc.waiting.who, 'joe');
  await w.pass(24 * 60 + 2);
  assert.equal(w.calls.alerts.length, 1);
});

test('M8 / R-0b-67: unknown usage -> no Tier-1 start; Tier 2 still starts', async () => {
  const w = world([card('C-1', { tier: 1 }), card('C-2')], { usage: null });
  const r = await w.pass();
  assert.deepEqual(r.started, ['C-2']);
  assert.match(r.refused[0][1], /unknown/);
});

test('R-0b-67: in amber Tier 1 goes first, and Tier 2 queues behind a Tier-1 card the caps hold', async () => {
  const w = world([card('A2', { changed_at: iso(T0 - 60 * MIN) }), card('B1', { tier: 1 }), card('C1', { tier: 1 })], { usage: AMBER });
  const r = await w.pass();
  // amber caps: 2 per product
  assert.deepEqual(r.started, ['B1', 'C1']);
  assert.match(r.refused.find(([id]) => id === 'A2')[1], /cap 2/);
  const w2 = world([card('A2', { changed_at: iso(T0 - 60 * MIN) }), card('B1', { tier: 1 }), card('C1', { tier: 1 }), card('D1', { tier: 1 })], { usage: AMBER });
  const r2 = await w2.pass();
  assert.deepEqual(r2.started, ['B1', 'C1']);
  assert.match(r2.refused.find(([id]) => id === 'A2')[1], /queued behind Tier-1 work in amber/);
});

test('R-0b-55: the front of the queue starts first', async () => {
  const w = world([card('C-1'), card('C-2'), card('C-3'), card('U-1', { queue: 'front', files: ['src/C-1.js'] })]);
  const r = await w.pass();
  assert.equal(r.started[0], 'U-1');
  assert.ok(!r.started.includes('C-1'), 'shares a file with the front card');
});

test('M19 / R-0b-64: two compactions across two sessions of one card -> stopped at a safe point, waiting on the Lead (needs_split); one -> nothing', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const s1 = w.sessions[0].id;
  w.probes.set(s1, { ...idle, size: { ...idle.size, compactions: 1 } });
  assert.deepEqual((await w.pass(1)).stopped, []);
  // the worker restarts from its bundle as a new session of the same card
  w.sessions.splice(0, 1, { id: 'S-9', product: 'p1', kind: 'editing', card: 'C-1', pgid: 999 });
  w.probes.set('S-9', { ...idle, size: { ...idle.size, compactions: 1 } });
  const r = await w.pass(2);
  assert.deepEqual(r.stopped, [['S-9', 'needs_split']]);
  const c = w.rec.read('card', 'C-1').doc;
  assert.deepEqual([c.state, c.waiting.who, c.waiting.what], ['waiting', 'lead', 'needs_split']);
});

test('M19: the same compaction read twice counts once', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const s1 = w.sessions[0].id;
  w.probes.set(s1, { ...idle, size: { ...idle.size, compactions: 1 } });
  await w.pass(1); await w.pass(2); await w.pass(3);
  assert.equal(w.calls.stops.length, 0);
});

test('m7 / G8: a running Tier-1 worker on a product moved to paused is parked at a safe point, then the Lead hands off', async () => {
  const w = world([card('C-1', { tier: 1 })]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.probes.set(sid, busy);
  w.setProduct('p1', 'paused');
  await w.pass(1);
  assert.deepEqual(w.calls.pauses, [], 'the Lead waits until the worker is parked');
  w.probes.set(sid, idle);
  await w.pass(2);
  assert.deepEqual(w.calls.stops, [sid]);
  assert.deepEqual(w.calls.pauses, [['p1', [sid]]], 'worker stopped first, then the Lead asked to hand off');
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'ready');
  await w.pass(3);
  assert.equal(w.calls.pauses.length, 1, 'once per pause');
  assert.equal(w.calls.launched.length, 1, 'the paused product starts nothing');
  w.setProduct('p1', 'active');
  await w.pass(4);
  assert.equal(w.calls.launched.length, 2);
  w.setProduct('p1', 'paused');
  w.probes.set(w.sessions[0].id, idle);
  await w.pass(5);
  assert.equal(w.calls.pauses.length, 2, 'a new pause asks again');
});

test('m5: host.lock saying Air keeps products running; one diary line per change', async () => {
  const w = world([card('C-1')]);
  await w.pass(0, { host: 'Air' });
  await w.pass(1, { host: 'Air' });
  await w.pass(2, { host: 'Air' });
  assert.equal(w.rec.read('fact', 'host-lock-note').rev, 1);
  assert.equal(w.calls.stops.length, 0);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'running');
  await w.pass(3, { host: 'Mini' });
  await w.pass(4, { host: 'Air' });
  assert.equal(w.rec.read('fact', 'host-lock-note').rev, 2);
});

test('M9: during an outage nothing starts', async () => {
  const w = world([card('C-1'), ['fact', OUTAGE_FACT, { state: 'open' }]]);
  const r = await w.pass();
  assert.deepEqual(r.started, []);
});

test('the time limits come from the rules', async () => {
  const w = world([card('C-1')], { over: { [K.cancelGraceMin]: 5 } });
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  await w.pass(1); await w.pass(5);
  assert.equal(w.calls.stops.length, 0);
  await w.pass(6);
  assert.equal(w.calls.stops.length, 1);
  // audit MAT-2: a missing key no longer throws; the pass still runs its stops, starts nothing, alerts once
  const m = world([card('C-2')], { over: { [K.parkWaitMin]: undefined } });
  const r = await m.pass();
  assert.deepEqual(r.started, []);
  assert.ok(r.notes.some((n) => /nothing starts: .*park_wait_min/.test(n)), r.notes.join('; '));
  await m.pass(1);
  assert.equal(m.calls.alerts.filter((a) => /park_wait_min/.test(a)).length, 1, 'one alert, not one per pass');
});

test('R-0b-55: every start writes its launch record; a launch the record refuses alerts', async () => {
  const w = world([card('C-1')]);
  const r = await w.pass();
  assert.deepEqual(r.started, ['C-1']);
  const sid = w.sessions[0].id;
  const l = w.rec.read('launch', sid).doc;
  assert.deepEqual([l.session_id, l.role, l.card, l.head, l.rev, l.launched_at], [sid, 'worker', 'C-1', 'h'.repeat(40), w.rec.read('card', 'C-1').rev, iso(T0)]);
  assert.equal(w.calls.alerts.length, 0);
  // a launcher that names no head: the session runs, the record refuses the launch, Joe is told
  const v = world([card('C-2')]);
  v.refuseLaunch(() => ({ ok: true, head: undefined }));
  await v.pass();
  assert.equal(v.rec.read('launch', v.sessions[0].id), null);
  assert.match(v.calls.alerts.join('\n'), /launch was not recorded .*head.*merge will be refused/);
});

test('M7: the stop sequence: SIGTERM, then SIGKILL after 10 s', async () => {
  const sent = [];
  let t = 0;
  const kill = (p, s) => sent.push([p, s]);
  const sleep = async (ms) => { t += ms; };
  let r = await stopProcessGroup({ pgid: 42, kill, alive: () => t < 3000, sleep });
  assert.deepEqual([r.how, sent], ['SIGTERM', [[42, 'SIGTERM']]]);
  sent.length = 0; t = 0;
  r = await stopProcessGroup({ pgid: 42, kill, alive: () => true, sleep });
  assert.deepEqual([r.how, sent, t], ['SIGKILL', [[42, 'SIGTERM'], [42, 'SIGKILL']], 10_000]);
  assert.equal((await stopProcessGroup({ pgid: 1, kill, alive: () => true, sleep })).ok, false, 'never signals group 1');
  const gone = await stopProcessGroup({ pgid: 42, kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, alive: () => false, sleep });
  assert.equal(gone.how, 'gone');
});

test('M7: a stop that fails alerts and leaves the card as it was; a failed save alerts but the stop stands', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions: [...w.sessions], probe: () => idle, launch: async () => ({ ok: false }) };
  const alerts = [];
  await dispatcherPass({ ...base, now: T0 + MIN, stopGroup: async () => ({ ok: false, reason: 'permission' }), saveWork: async () => ({ ok: true }), alert: (x) => alerts.push(x) });
  assert.match(alerts[0], /could not be stopped: permission/);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'pending');
  await dispatcherPass({ ...base, now: T0 + 2 * MIN, stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: false, reason: 'disk full' }), alert: (x) => alerts.push(x) });
  assert.match(alerts[1], /not saved: disk full/);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'done');
});

test('audit MAT-2: a cancel still stops when the rules lack a value: cancel_grace_min missing uses the 2 min floor', async () => {
  for (const key of [K.cancelGraceMin, K.parkWaitMin, K.redRuns]) {
    const w = world([card('C-1')]);
    await w.pass(0);
    const sid = w.sessions[0].id;
    w.setCard('C-1', { state: 'cancelled' });
    w.probes.set(sid, busy);
    const rules = rulesWith({ [key]: undefined }, startAnswer(w.rec));
    await w.pass(1, { rules });
    assert.equal(w.calls.stops.length, 0, `${key}: inside the grace`);
    await w.pass(3, { rules });
    assert.deepEqual(w.calls.stops, [sid], key);
    assert.equal(w.rec.read('card', 'C-1').doc.state, 'cancelled');
  }
});

test('audit MAT-4: a fix card the undo step writes is never started as a worker; nor is any card for the Lead', async () => {
  const { undoStep, FIX_CARD, REVERSE_FACT, UNDO_CARD } = await import('./undo.mjs');
  const U = UNDO_CARD('A-1');
  const w = world([['card', U, { state: 'merged', kind: 'undo', pr: 7, product: 'p1', module: 'M-test', tier: 2 }],
    ['fact', REVERSE_FACT(U), { state: 'not_clean', reason: 'a later change touched src/a.js' }],
    card('L-1', { for: 'lead' })]);
  const alerts = [];
  undoStep({ rec: w.rec, rules: rulesWith(), now: T0, filesOf: () => [], alert: (t) => alerts.push(t) });
  assert.ok(w.rec.read('card', FIX_CARD(U)));
  const r = await w.pass(1);
  assert.deepEqual(r.started, []);
  assert.deepEqual(w.calls.launched, []);
  assert.equal(w.rec.read('card', 'L-1').doc.state, 'ready');
  assert.equal(w.rec.read('card', FIX_CARD(U)).doc.state, 'waiting');
});

test('audit MIN-20 (P13): parked work does not resume while the Dispatcher\'s own share of the week is full', async () => {
  const wait = { who: 'dispatcher', what: 'usage_band', since: iso(T0 - MIN), next_check: iso(T0) };
  const w = world([card('C-1', { state: 'waiting', waiting: wait })], { usage: { week: 50, h5: 10 } });
  const r = await w.pass(1);
  assert.deepEqual(r.resumed, []);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'waiting');
  w.setUsage({ week: 30, h5: 20 });
  assert.deepEqual((await w.pass(2)).resumed, ['C-1']);
});

test('audit MIN-20 (P30): in red a review session with a card is never parked; an editing one is', async () => {
  const w = world([card('C-1', { state: 'in_review' })], { usage: RED });
  w.sessions.push({ id: 'R-1', product: 'p1', kind: 'review', card: 'C-1', pgid: 50 }, { id: 'E-1', product: 'p1', kind: 'editing', card: 'C-2', pgid: 51 });
  w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-2', expectRev: 0, doc: { state: 'running', module: 'M-test', product: 'p1', tier: 2 } });
  await w.pass(0);
  w.setUsage(RED, T0 + 16 * MIN);
  await w.pass(16);
  assert.deepEqual(w.calls.stops, ['E-1']);
});

test('audit MIN-20 (P33): the stop stops waiting as soon as the group is gone after SIGTERM', async () => {
  let t = 0;
  const r = await stopProcessGroup({ pgid: 42, kill: () => {}, alive: () => t < 1500, sleep: async (ms) => { t += ms; } });
  assert.equal(r.how, 'SIGTERM');
  assert.equal(t, 1500);
});

test('audit 0b-6 r2 MAT-7: a session whose probe, stop or save throws does not end the pass; a cancelled one after it still stops and starts still run', async () => {
  const w = world([card('C-1'), card('C-2'), card('C-3')]);
  await w.pass(0);
  const [a, b] = w.sessions.map((s) => s.id);
  w.setCard('C-1', { state: 'cancelled' });
  w.setCard('C-2', { state: 'cancelled' });
  w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-4', expectRev: 0, doc: card('C-4')[2] });
  const sessions = w.sessions.filter((s) => s.id === a || s.id === b);
  const stops = [];
  const alerts = [];
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions, launch: async () => ({ ok: true, sessionId: 'S-new', pgid: 900, head: 'h'.repeat(40) }), alert: (x) => alerts.push(x) };
  // Pass 1: A's probe throws; B is cancelled and idle.
  let r = await dispatcherPass({ ...base, now: T0 + MIN, probe: (s) => { if (s.id === a) throw new Error('transcript unreadable'); return idle; },
    stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; }, saveWork: async () => ({ ok: true }) });
  assert.deepEqual(stops, [b], 'B stops although A threw first');
  assert.deepEqual(r.stopping, [[a, 'cancel']], 'a throwing probe is not a safe point');
  assert.ok(r.started.length >= 1, 'starts still run');
  // Pass 2, past the grace: A is hard-stopped; its stop then its save throw and each becomes one alert.
  r = await dispatcherPass({ ...base, sessions: sessions.filter((s) => s.id === a), now: T0 + 30 * MIN, probe: () => { throw new Error('transcript unreadable'); },
    stopGroup: async () => { throw new Error('EPERM'); }, saveWork: async () => ({ ok: true }) });
  assert.match(alerts.join('\n'), /could not be stopped: EPERM/);
  r = await dispatcherPass({ ...base, sessions: sessions.filter((s) => s.id === a), now: T0 + 31 * MIN, probe: () => idle,
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => { throw new Error('disk gone'); } });
  assert.deepEqual(r.stopped, [[a, 'cancel']]);
  assert.match(alerts.join('\n'), /not saved: disk gone/);
});

test('audit 0b-6 r2 MAT-7: stopProcessGroup answers { ok: false } on EPERM instead of throwing, at SIGTERM and at SIGKILL', async () => {
  const eperm = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill: eperm, alive: () => true, sleep: async () => {} }), { ok: false, reason: 'EPERM' });
  let n = 0;
  const second = (p, sig) => { n += 1; if (sig === 'SIGKILL') eperm(); };
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill: second, alive: () => true, sleep: async () => {}, waitMs: 1000 }), { ok: false, reason: 'EPERM' });
  assert.equal(n, 2);
});

test('audit 0b-6 r2 / L27: a running session of a kind the Dispatcher does not know is parked in red, like editing work', async () => {
  const w = world([card('C-1')], { usage: RED });
  w.sessions.push({ id: 'X-1', product: 'p1', kind: 'nightly', card: 'C-1' });
  const r = await w.pass();
  // An unknown role waits for the stricter safe point (a finished turn); the stop is wanted all the same.
  assert.deepEqual(r.stopping, [['X-1', 'red']]);
  assert.equal(w.rec.read('fact', STOP_FACT('X-1')).doc.reason, 'red');
});

test('audit 0b-6 r2 MAT-8 (P4): in amber a card with no tier sorts as Tier 1, ahead of Tier 2 and with the Tier-1 hold', async () => {
  const w = world([card('A2', { changed_at: iso(T0 - 60 * MIN) }), card('B0', { tier: undefined }), card('C1', { tier: 1 }), card('D0', { tier: undefined })], { usage: AMBER });
  const r = await w.pass();
  assert.deepEqual(r.started, ['B0', 'C1']);
  assert.match(r.refused.find(([id]) => id === 'A2')[1], /queued behind Tier-1 work in amber/);
});

test('audit 0b-6 r2 MIN-2: a usage_band card resumes in green, not while usage is unknown', async () => {
  const parked = { state: 'waiting', product: 'p1', tier: 2, files: ['src/p.js'], waiting: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'C-1', parked]], { usage: null });
  assert.deepEqual((await w.pass(0)).resumed, []);
  w.setUsage(GREEN, T0 + MIN);
  assert.deepEqual((await w.pass(1)).resumed, ['C-1']);
});

test('audit 0b-6 r2 MIN-10 (round 1 MIN-2, 3, 4): a cancel replaces a pending park; a card that ended or waits on Joe stops its worker; a failing stop alerts once', async () => {
  // Rank: a red park is pending (mid-tool), then the card is cancelled: the stop is now a cancel.
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.probes.set(sid, busy);
  w.setUsage(RED, T0 + MIN);
  await w.pass(1);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.reason, 'red');
  w.setCard('C-1', { state: 'cancelled' });
  await w.pass(2);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.reason, 'cancel');
  // Ended: in green, a worker whose card is done, or now waits on Joe, is stopped.
  for (const patch of [{ state: 'closed' }, { state: 'failed' }, { state: 'waiting', waiting: { who: 'joe', what: 'approve' } }]) {
    const e = world([card('C-2')]);
    await e.pass(0);
    const s2 = e.sessions[0].id;
    e.setCard('C-2', patch);
    const r = await e.pass(1);
    assert.deepEqual(r.stopped, [[s2, 'card_ended']], JSON.stringify(patch));
  }
  // Once: a stop that keeps failing alerts on the first pass only.
  const f = world([card('C-3')]);
  await f.pass(0);
  f.setCard('C-3', { state: 'cancelled' });
  const alerts = [];
  const base = { rec: f.rec, rules: rulesWith({}, startAnswer(f.rec)), account: ACCT, sessions: [...f.sessions], probe: () => idle, launch: async () => ({ ok: false }),
    stopGroup: async () => ({ ok: false, reason: 'permission' }), saveWork: async () => ({ ok: true }), alert: (x) => alerts.push(x) };
  for (const m of [1, 2, 3]) await dispatcherPass({ ...base, now: T0 + m * MIN });
  assert.equal(alerts.filter((x) => /could not be stopped/.test(x)).length, 1);
});
