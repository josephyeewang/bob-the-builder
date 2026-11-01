import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dispatcherPass as dispatcherPass0, stopPass as stopPass0, undoStarts, stopProcessGroup, STOP_FACT, UNSAVED_FACT, LIMIT_FACT, LIMIT_NO_ACCOUNT, UNDO_HELD_FACT, PAUSE_FACT, RULES_MISSING_FACT, rulesMissingAlert as rulesMissingAlert0 } from './pass.mjs';
import { USAGE_FACT, BAND_FACT } from './usage.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { retellWaits, WAIT_TELL_FACT } from './joe-waits.mjs';
import { KEYS as K } from './keys.mjs';
import { change, rulesWith, recWith, seed, usageFact, undoEntries, filesOfCommits, T0, MIN, H, iso, withAlerts } from './fixtures.test-helper.mjs';

// Each step runs as the tick runs it: its alerts are queued, then sent once it is done (alerts.mjs, L47).
const dispatcherPass = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => dispatcherPass0({ ...a, alert }));
const stopPass = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => stopPass0({ ...a, alert }));
const rulesMissingAlert = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => rulesMissingAlert0({ ...a, alert }));

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
    // Sensors' reading (L74 families): the Dispatcher reads it, never writes it.
    rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: cur?.rev ?? 0, doc: usageFact({ ...u, account: ACCT, now: at }) });
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
    // The launcher starts the session the claim names and reports its process (L72), as M4's does.
    launch: async (x) => { calls.launched.push(x.card.id); const a = launchAnswer(x); if (!a.ok) return a; n += 1; const id = 'sessionId' in a ? a.sessionId : x.sessionId; sessions.push({ id, product: x.product, kind: x.kind, card: x.card.id, pgid: 100 + n }); return { ok: true, sessionId: id, pid: 1000 + n, pidStart: `start-${n}`, pgid: 100 + n, head: 'head' in a ? a.head : 'h'.repeat(40) }; },
    stopGroup: async (s) => { calls.stops.push(s.id); const i = sessions.findIndex((x) => x.id === s.id); if (i >= 0) sessions.splice(i, 1); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async (s) => { calls.saves.push(s.id); return { ok: true }; },
    hostLock: extra.hostLock ?? (() => extra.host ?? null),
    pauseLead: extra.pauseLead ?? (({ product }) => { calls.pauses.push([product, [...calls.stops]]); }),
    startsOff: extra.startsOff ?? null,
    filesOf: extra.filesOf ?? filesOfCommits,
    alert: (t) => calls.alerts.push(t),
  });
  const setCard = (id, patch) => change(rec, 'card', id, patch);
  const setProduct = (id, state) => change(rec, 'product', id, { state });
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
  // The card is given back by its claim's holder (M9 release); the reason is on that diary line, not on the card.
  const c = w.rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'ready');
  assert.equal(c.claim, undefined);
  const releases = () => w.rec.diary().filter((l) => l.kind === 'claim_release' && l.id === 'C-1');
  assert.match(releases()[0].data.reason, /launcher: check 7: the hook folder is missing/);
  assert.match(r.refused[0][1], /hook folder is missing/);
  w.refuseLaunch(() => { throw new Error('crashed'); });
  await w.pass(1);
  assert.equal(releases().length, 2);
  assert.match(releases()[1].data.reason, /crashed/);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'ready');
});

test('R-0b-55: the claim is rev-checked: a card changed since it was read is not launched', async () => {
  const w = world([card('C-1')]);
  const rec = w.rec;
  const real = rec.ready.bind(rec);
  // another writer changes the card after the pass read the ready list (M9's rec.ready, L72)
  const sneaky = { ...rec, ready: () => { const l = real(); if (l.length) change(rec, 'card', 'C-1', { head: 'b'.repeat(40) }); return l; } };
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
  assert.deepEqual([c.state, c.wait.what], ['waiting', 'usage_band']);
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
  seed(w.rec, 'card', 'C-9', card('C-9')[2]);
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
  const w = world([...undoEntries('U-1')], { usage: RED });
  w.sessions.push({ id: 'R-1', product: 'p1', kind: 'review', card: null }, { id: 'M-1', product: 'p1', kind: 'merge', card: null });
  const r = await w.pass();
  assert.deepEqual(w.calls.stops, []);
  assert.deepEqual(r.started, ['U-1']);
});

test('M8: limit_hit -> after the reset Tier 2 goes back to ready, Tier 1 waits on Joe', async () => {
  // A card waits on the usage limit (WAIT_WHO usage) of the account its wait names.
  const wait = (tier) => ({ state: 'waiting', tier, wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0), account: ACCT } });
  const w = world([['card', 'T2', { ...wait(2), product: 'p1', files: ['src/t2.js'] }], ['card', 'T1', { ...wait(1), product: 'p1' }], ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }]]);
  await w.pass(10);
  assert.equal(w.rec.read('card', 'T2').doc.state, 'waiting');
  w.setUsage(GREEN, T0 + 31 * MIN);
  await w.pass(31);
  assert.ok(['ready', 'running'].includes(w.rec.read('card', 'T2').doc.state));
  const t1 = w.rec.read('card', 'T1').doc;
  assert.deepEqual([t1.state, t1.wait.who], ['waiting', 'joe']);
});

test('L97: a card parked on account b\'s limit reads b\'s reading, not the pass\'s account', async () => {
  // Two accounts: the pass runs as a; card B waits on b's limit, card A on a's. a's limit resets at +30 min, b's at +90.
  // The wait names the account (M9 keeps a wait's extra fields; it lets no script put an account on the card).
  const wait = (files, acct) => ({ state: 'waiting', tier: 2, product: 'p1', files, wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0), ...(acct ? { account: acct } : {}) } });
  const w = world([
    ['card', 'A', wait(['src/a.js'], ACCT)], ['card', 'B', wait(['src/b.js'], 'acct-b')],
    ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }],
    ['fact', LIMIT_FACT('acct-b'), { resets_at: iso(T0 + 90 * MIN), observed_at: iso(T0 + MIN) }],
  ]);
  const r1 = await w.pass(31);
  assert.deepEqual(r1.resumed, ['A'], 'only the card on a, whose limit reset');
  assert.equal(w.rec.read('card', 'B').doc.state, 'waiting', "b's limit has not reset");
  const r2 = await w.pass(91);
  assert.deepEqual(r2.resumed, ['B']);
});

test('L97 M-3: a limit reading from before the card began to wait, or with no reset time, resumes nothing', async () => {
  // C waits since +20 min; the only reading was taken at +1 min (an earlier limit, reset at +10). D's reading is new but
  // has no reset time (resets_at null, as the writer leaves it when the reset is unknown).
  const wait = (since, files, acct) => ({ state: 'waiting', tier: 2, product: 'p1', files, wait: { who: 'usage', what: 'limit_hit', since: iso(T0 + since * MIN), next_check: iso(T0 + since * MIN), ...(acct ? { account: acct } : {}) } });
  const w = world([
    ['card', 'C', { ...wait(20, ['src/c.js'], ACCT), changed_at: iso(T0 + 20 * MIN) }],
    ['card', 'D', wait(0, ['src/d.js'], 'acct-d')],
    ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 10 * MIN), observed_at: iso(T0 + MIN) }],
    ['fact', LIMIT_FACT('acct-d'), { resets_at: null, observed_at: iso(T0 + MIN) }],
  ]);
  const r = await w.pass(60);
  assert.deepEqual(r.resumed, []);
  assert.equal(w.rec.read('card', 'C').doc.state, 'waiting');
  assert.equal(w.rec.read('card', 'D').doc.state, 'waiting');
  // A new reading for C's limit, taken after its wait began and reset since: C resumes.
  const cur = w.rec.read('fact', LIMIT_FACT(ACCT));
  w.rec.write({ actor: 'sensors', entity: 'fact', id: LIMIT_FACT(ACCT), expectRev: cur.rev, doc: { resets_at: iso(T0 + 50 * MIN), observed_at: iso(T0 + 25 * MIN) } });
  const r2 = await w.pass(61);
  assert.deepEqual(r2.resumed, ['C']);
});

test('L110 m-4: a limit_hit wait that names no account resumes nothing, never on the pass\'s account; it waits on Joe, one alert', async () => {
  // The pass's account has a reading that has reset: a card whose wait names no account must not be resumed by it.
  const parked = { state: 'waiting', tier: 2, product: 'p1', files: ['src/n.js'], wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'N', parked], ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }]]);
  const r = await w.pass(31);
  assert.deepEqual(r.resumed, []);
  const n = w.rec.read('card', 'N').doc;
  assert.deepEqual([n.state, n.wait.who, n.wait.what], ['waiting', 'joe', LIMIT_NO_ACCOUNT]);
  const told = () => w.calls.alerts.filter((a) => /does not say which account/.test(a));
  assert.equal(told().length, 1);
  await w.pass(32);
  await w.pass(33);
  assert.equal(told().length, 1, 'told once');
  assert.equal(w.rec.read('card', 'N').doc.state, 'waiting');
});

test('M8: usage unknown for over a day -> parked work waits on Joe, one alert', async () => {
  const parked = { state: 'waiting', product: 'p1', wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'C-1', { ...parked, tier: 1 }]], { usage: null });
  await w.pass(0);
  // audit 0b-6 r2 MIN-2: while usage is unknown the card stays parked (the gate would hold it anyway)
  assert.equal(w.rec.read('card', 'C-1').doc.wait.what, 'usage_band');
  await w.pass(24 * 60);
  assert.equal(w.rec.read('card', 'C-1').doc.wait.what, 'usage_band', 'a day exactly is not over a day');
  await w.pass(24 * 60 + 1);
  assert.equal(w.rec.read('card', 'C-1').doc.wait.who, 'joe');
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
  // The front of the queue is an undo card (an exact reverse); there is no queue field on a card.
  const w = world([card('C-1'), card('C-2'), card('C-3'), ...undoEntries('U-1', {}, { files: ['src/C-1.js'] })]);
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
  // The Record has no Lead waiter (WAIT_WHO): the split waits on a dependency, needs_split, which the Lead reads.
  assert.deepEqual([c.state, c.wait.who, c.wait.what], ['waiting', 'dependency', 'needs_split']);
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
  // M9 has no running -> ready move: the parked card waits on the pause and goes back to ready when it lifts.
  const parked = w.rec.read('card', 'C-1').doc;
  assert.deepEqual([parked.state, parked.wait.what], ['waiting', 'paused']);
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
  assert.ok(r.notes.some((n) => /nothing but undo cards starts: .*park_wait_min/.test(n)), r.notes.join('; '));
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

// L130 M9: work not saved, whose alert the queue did not take, is told on a later pass, once; the stop stands.
test('L130: an unsaved stop whose alert was not queued is told on the next pass, once', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions: [...w.sessions], probe: () => idle, launch: async () => ({ ok: false }),
    stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: false, reason: 'disk full' }) };
  await dispatcherPass0({ ...base, now: T0 + MIN, alert: () => false });
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'done', 'the stop stands');
  assert.equal(w.rec.read('fact', UNSAVED_FACT(sid))?.doc?.told_at, undefined, 'not marked told');
  const alerts = [];
  await dispatcherPass({ ...base, sessions: [], now: T0 + 2 * MIN, alert: (x) => alerts.push(x) });
  assert.equal(alerts.filter((a) => /not saved: disk full/.test(a)).length, 1, alerts.join(' | '));
  assert.ok(w.rec.read('fact', UNSAVED_FACT(sid)).doc.told_at);
  await dispatcherPass({ ...base, sessions: [], now: T0 + 3 * MIN, alert: (x) => alerts.push(x) });
  assert.equal(alerts.filter((a) => /not saved/.test(a)).length, 1, 'told once');
});

// L130 M3: a limit wait that names no account is put on Joe even when its alert is not queued; the tick's waits step
// tells it once.
test('L130: a no-account limit wait whose alert was not queued waits on Joe, and is told once by the waits step', async () => {
  const parked = { state: 'waiting', tier: 2, product: 'p1', files: ['src/n.js'], wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'N', parked], ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }]]);
  const sessions = [];
  await dispatcherPass0({ rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), now: T0 + 31 * MIN, account: ACCT, sessions, probe: () => idle,
    launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert: () => false });
  assert.deepEqual([w.rec.read('card', 'N').doc.wait.who, w.rec.read('card', 'N').doc.wait.what], ['joe', LIMIT_NO_ACCOUNT]);
  assert.equal(w.rec.read('fact', WAIT_TELL_FACT('N')).doc.told_since, undefined, 'not marked told');
  const alerts = [];
  const waits = (min) => withAlerts(w.rec, T0 + min * MIN, (x) => alerts.push(x), (alert) => retellWaits({ rec: w.rec, alert }));
  await waits(32);
  await waits(33);
  assert.equal(alerts.filter((a) => /does not say which account/.test(a)).length, 1, alerts.join(' | '));
  assert.equal(w.rec.read('fact', WAIT_TELL_FACT('N')).doc.told_since, w.rec.read('card', 'N').doc.wait.since);
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
  const { undoStep: undoStep0, FIX_CARD, REVERSE_FACT, UNDO_CARD } = await import('./undo.mjs');
  const undoStep = (a) => withAlerts(a.rec, a.now, a.alert, (alert) => undoStep0({ ...a, alert }));
  // A failed undo card (M9: a fix card fixes a failed card) and the gate's own not_clean reading.
  const U = 'U-1';
  void UNDO_CARD;
  const w = world([...undoEntries(U, { state: 'failed', failure: { reason: 'the reverse is not clean', at: iso(T0) } }),
    ['fact', REVERSE_FACT(U), { state: 'not_clean', reason: 'a later change touched src/a.js' }],
    card('L-1', { kind: 'lead_daily_card' })]);
  const alerts = [];
  await undoStep({ rec: w.rec, rules: rulesWith(), now: T0, filesOf: () => [], alert: (t) => alerts.push(t) });
  assert.ok(w.rec.read('card', FIX_CARD(U)));
  const r = await w.pass(1);
  assert.deepEqual(r.started, []);
  assert.deepEqual(w.calls.launched, []);
  assert.equal(w.rec.read('card', 'L-1').doc.state, 'ready');
  assert.equal(w.rec.read('card', FIX_CARD(U)).doc.state, 'draft');
});

test('audit MIN-20 (P13): parked work does not resume while the Dispatcher\'s own share of the week is full', async () => {
  const wait = { who: 'dispatcher', what: 'usage_band', since: iso(T0 - MIN), next_check: iso(T0) };
  const w = world([card('C-1', { state: 'waiting', wait: wait })], { usage: { week: 50, h5: 10 } });
  const r = await w.pass(1);
  assert.deepEqual(r.resumed, []);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'waiting');
  w.setUsage({ week: 30, h5: 20 });
  assert.deepEqual((await w.pass(2)).resumed, ['C-1']);
});

test('audit MIN-20 (P30): in red a review session with a card is never parked; an editing one is', async () => {
  const w = world([card('C-1', { state: 'in_review' })], { usage: RED });
  w.sessions.push({ id: 'R-1', product: 'p1', kind: 'review', card: 'C-1', pgid: 50 }, { id: 'E-1', product: 'p1', kind: 'editing', card: 'C-2', pgid: 51 });
  seed(w.rec, 'card', 'C-2', { state: 'running', module: 'M-test', product: 'p1', tier: 2, claim: { kind: 'session', session_id: 'E-1', host: 'test-host' } });
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
  seed(w.rec, 'card', 'C-4', card('C-4')[2]);
  const sessions = w.sessions.filter((s) => s.id === a || s.id === b);
  const stops = [];
  const alerts = [];
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions, launch: async (x) => ({ ok: true, sessionId: x.sessionId, pid: 900, pidStart: 's900', pgid: 900, head: 'h'.repeat(40) }), alert: (x) => alerts.push(x) };
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
  const parked = { state: 'waiting', product: 'p1', tier: 2, files: ['src/p.js'], wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
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
  // A running card ends by failing (M9 has no running -> closed move), or waits on Joe.
  for (const patch of [{ state: 'failed' }, { state: 'waiting', wait: { who: 'joe', what: 'approve' } }]) {
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

// ---- audit 0b-6 round 3 ----

// A cancelled card whose worker sits at a safe point: the first pass stops it, whatever else fails.
const cancelledWorld = async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  w.setCard('C-1', { state: 'cancelled' });
  return { w, sid: w.sessions[0].id };
};

test('audit 0b-6 r3 MAT-1: a host.lock that cannot be read, or rules that cannot be read, never stop the stop loop: a cancel still stops', async () => {
  {
    const { w, sid } = await cancelledWorld();
    const r = await w.pass(1, { hostLock: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    assert.deepEqual(w.calls.stops, [sid]);
    assert.ok(r.notes.some((n) => /host\.lock unreadable: EACCES/.test(n)), r.notes.join(' | '));
  }
  {
    const { w, sid } = await cancelledWorld();
    const good = rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } });
    const broken = { ...good, get: () => { throw new Error('rules file unreadable'); } };
    const r = await w.pass(1, { rules: broken });
    assert.deepEqual(w.calls.stops, [sid]);
    assert.ok(r.notes.some((n) => /nothing but undo cards starts: the rules have no value for the rules \(rules file unreadable\)/.test(n)), r.notes.join(' | '));
    assert.equal(w.calls.alerts.filter((a) => /rules file unreadable/.test(a)).length, 1);
    assert.equal(w.calls.launched.length, 1, 'nothing new started');
  }
});

test('audit 0b-6 r3 MAT-5: with starts off (no account reading, or a rules value missing) an undo card still starts and nothing else does', async () => {
  for (const [label, extra] of [['no account', { startsOff: 'the signed-in account is not known' }], ['park_wait_min missing', { rules: rulesWith({ [K.parkWaitMin]: undefined }) }]]) {
    const w = world([card('C-1'), ...undoEntries('U-1')]);
    if (extra.rules) extra.rules = rulesWith({ [K.parkWaitMin]: undefined }, startAnswer(w.rec));
    const r = await w.pass(0, extra);
    assert.deepEqual(r.started, ['U-1'], label);
    assert.ok(!w.calls.launched.includes('C-1'), label);
  }
});

test('audit 0b-6 r3 MAT-5: an undo that cannot start tells Joe why, once per reason, and the note clears when it starts', async () => {
  const w = world([...undoEntries('U-1')]);
  // The rules refusing it holds an undo (as does an open outage); the undo's own alert says why.
  const rules = rulesWith({}, { start_session: { decision: 'deny', reason: 'the product is paused' } });
  await w.pass(0, { rules });
  await w.pass(1, { rules });
  const told = w.calls.alerts.filter((a) => /your undo \(card U-1\) is waiting: rules: the product is paused/.test(a));
  assert.equal(told.length, 1, w.calls.alerts.join(' | '));
  assert.equal(w.rec.read('fact', UNDO_HELD_FACT('U-1')).doc.reason, 'rules: the product is paused');
  await w.pass(2);
  assert.ok(w.calls.launched.includes('U-1'));
});

test('audit 0b-6 r3 MIN-2: a pauseLead port that throws is told once for that product and does not fail the pass; it is asked again next pass', async () => {
  const w = world([]);
  w.setProduct('p1', 'paused');
  let n = 0;
  const pauseLead = () => { n += 1; throw new Error('Lead not reachable'); };
  const r = await w.pass(0, { pauseLead });
  assert.ok(r.bands, 'the pass finished and gave its bands');
  await w.pass(1, { pauseLead });
  assert.equal(n, 2);
  assert.equal(w.calls.alerts.filter((a) => /could not be asked to hand off: Lead not reachable/.test(a)).length, 1);
  assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'failed');
  await w.pass(2);
  assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'asked');
});

test('audit 0b-6 r3 MAT-3: the pass alone tells Joe of a missing value once; a new missing value is told by itself', async () => {
  const w = world([card('C-1')]);
  const r1 = rulesWith({ [K.perState]: undefined }, startAnswer(w.rec));
  await w.pass(0, { rules: r1 });
  await w.pass(1, { rules: r1 });
  assert.equal(w.calls.alerts.filter((a) => a.includes(K.perState)).length, 1, w.calls.alerts.join(' | '));
  const r2 = rulesWith({ [K.perState]: undefined, [K.parkWaitMin]: undefined }, startAnswer(w.rec));
  await w.pass(2, { rules: r2 });
  const last = w.calls.alerts.at(-1);
  assert.ok(last.includes(K.parkWaitMin) && !last.includes(K.perState), last);
  // One of the two comes back: nothing new is missing, so nothing is told.
  const told = () => w.calls.alerts.filter((a) => a.startsWith('the rules have no value')).length;
  const before = told();
  await w.pass(2.5, { rules: rulesWith({ [K.parkWaitMin]: undefined }, startAnswer(w.rec)) });
  assert.equal(told(), before, w.calls.alerts.join(' | '));
  await w.pass(3);
  assert.equal(w.rec.read('fact', RULES_MISSING_FACT).doc.keys, null);
});

test('audit 0b-6 r3 MAT-3: the missing-values alert names only keys not told before; a shrinking set tells nothing', async () => {
  const rec = recWith();
  const alerts = [];
  const tell = (keys, complete = true) => rulesMissingAlert({ rec, keys, alert: (t) => alerts.push(t), now: T0, complete });
  await tell(['a', 'b']);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /no value for a, b:/);
  await tell(['b']);
  assert.equal(alerts.length, 1, 'one key came back: nothing to tell');
  assert.equal(rec.read('fact', RULES_MISSING_FACT).doc.keys, 'b');
  await tell(['b', 'c']);
  assert.match(alerts.at(-1), /no value for c:/);
  await tell([], false);
  assert.equal(rec.read('fact', RULES_MISSING_FACT).doc.keys, 'b, c', 'an incomplete tick keeps what it did not read');
  assert.equal(alerts.length, 2);
});

test('audit 0b-6 r6 m-5: a new missing value told alone keeps the day clock of the values told before', async () => {
  const rec = recWith();
  const alerts = [];
  const tell = (keys, at) => rulesMissingAlert({ rec, keys, alert: (t) => alerts.push(t), now: at });
  await tell(['a'], T0);
  await tell(['a', 'b'], T0 + 12 * H);
  assert.match(alerts.at(-1), /no value for b:/);
  await tell(['a', 'b'], T0 + 24 * H);
  assert.equal(alerts.length, 3, alerts.join(' | '));
  assert.match(alerts.at(-1), /no value for a, b:/, 'a day after a was first told, both are told again');
});

// Audit 0b-6 r4 MAT-1: a time limit on every stop and save, and the stops side by side.
test('r4 MAT-1: a stop that never answers holds no other stop; it is told, and again a day later', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-A', { state: 'cancelled' }), card('C-B', { state: 'cancelled' })]);
  usageInto(rec);
  const sessions = [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-A', pgid: 50 }, { id: 'S-B', product: 'p1', kind: 'editing', card: 'C-B', pgid: 51 }];
  const alerts = [];
  const stopped = [];
  const run = (at) => stopPass({ rec, rules: rulesWith(), now: at, account: ACCT, sessions, probe: () => idle, alert: (t) => alerts.push(t), portDeadlineMs: 50, saveDeadlineMs: 50,
    stopGroup: (s) => (s.id === 'S-A' ? new Promise(() => {}) : (stopped.push(s.id), { ok: true, how: 'SIGTERM' })),
    saveWork: async () => ({ ok: true }) });
  const r = await run(T0);
  assert.deepEqual(r.stopped, [['S-B', 'cancel']]);
  assert.deepEqual(r.stopping, [['S-A', 'cancel']]);
  assert.equal(alerts.length, 1, alerts.join(' | '));
  assert.match(alerts[0], /session S-A \(card C-A\) could not be stopped: it did not answer within 50 ms/);
  await run(T0 + MIN);
  assert.equal(alerts.length, 1, 'once while it lasts');
  await run(T0 + 25 * H);
  assert.equal(alerts.length, 2, 'again a day later');
});

test('r4 MAT-1: the stops are called side by side, not one after another', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-A', { state: 'cancelled' }), card('C-B', { state: 'cancelled' })]);
  usageInto(rec);
  const sessions = [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-A', pgid: 50 }, { id: 'S-B', product: 'p1', kind: 'editing', card: 'C-B', pgid: 51 }];
  const called = new Set();
  // A answers only once B's stop has been called too: one after another, A would time out.
  const waitFor = (id) => new Promise((ok) => { const t = setInterval(() => { if (called.has(id)) { clearInterval(t); ok(); } }, 2); });
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, sessions, probe: () => idle, alert: () => {}, portDeadlineMs: 300,
    stopGroup: async (s) => { called.add(s.id); if (s.id === 'S-A') await waitFor('S-B'); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async (s) => { called.add(`save-${s.id}`); if (s.id === 'S-A') await waitFor('save-S-B'); return { ok: true }; } });
  assert.deepEqual(r.stopped.map(([id]) => id).sort(), ['S-A', 'S-B']);
  assert.equal(rec.read('fact', STOP_FACT('S-A')).doc.saved, true, 'the saves ran side by side too');
});

test('r4 MAT-1: a save that never answers is told, and the stopped card still moves', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-A', { state: 'cancelled' })]);
  usageInto(rec);
  const alerts = [];
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, sessions: [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-A', pgid: 50 }], probe: () => idle,
    alert: (t) => alerts.push(t), saveDeadlineMs: 50, stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: () => new Promise(() => {}) });
  assert.deepEqual(r.stopped, [['S-A', 'cancel']]);
  assert.match(alerts.join(' | '), /S-A stopped but its unsaved work was not saved: it did not answer within 50 ms/);
  assert.equal(rec.read('fact', STOP_FACT('S-A')).doc.saved, false);
});

test('r4 Minor: a Lead hand-off that fails, or never answers, is told again a day later', async () => {
  for (const pauseLead of [() => { throw new Error('send failed'); }, () => new Promise(() => {})]) {
    const w = world();
    w.setProduct('p1', 'paused');
    const alerts = () => w.calls.alerts.filter((a) => /could not be asked to hand off/.test(a));
    const at = (min) => dispatcherPass({ rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), pauseLead, alert: (t) => w.calls.alerts.push(t), filesOf: filesOfCommits, portDeadlineMs: 50 });
    await at(0);
    await at(1);
    assert.equal(alerts().length, 1, alerts().join(' | '));
    await at(25 * 60);
    assert.equal(alerts().length, 2, 'again a day later');
  }
});

test('r4 Minor: a held undo whose reason changes only in a number is one cause', async () => {
  const w = world([...undoEntries('U-1')]);
  let n = 0;
  const rules = rulesWith({}, { start_session: () => ({ decision: 'deny', reason: `the product waits ${++n} min` }) });
  await w.pass(0, { rules });
  await w.pass(1, { rules });
  await w.pass(2, { rules });
  assert.equal(w.calls.alerts.filter((a) => /your undo \(card U-1\) is waiting/.test(a)).length, 1, w.calls.alerts.join(' | '));
  // A different reason is a new cause.
  await w.pass(3, { rules: rulesWith({}, { start_session: { decision: 'deny', reason: 'another reason' } }) });
  assert.equal(w.calls.alerts.filter((a) => /your undo \(card U-1\) is waiting/.test(a)).length, 2);
});

test('r4 MAT-5: during an outage the undo starts start nothing', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], ['fact', OUTAGE_FACT, { state: 'open' }], ...undoEntries('U-1')]);
  const launched = [];
  const r = await undoStarts({ rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0, bands: { band: 'green', own_building: 'open', prodBlocked: false },
    running: [], launch: async (x) => { launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, pid: 4242, pidStart: 's4242', head: 'h'.repeat(40) }; }, filesOf: filesOfCommits, alert: () => {} });
  assert.deepEqual(launched, []);
  assert.deepEqual(r.started, []);
  assert.ok(r.notes.includes('outage: nothing starts'));
  assert.equal(rec.read('card', 'U-1').doc.state, 'ready');
  // Control: the outage over, it starts.
  const cur = rec.read('fact', OUTAGE_FACT);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: OUTAGE_FACT, expectRev: cur.rev, doc: { state: 'ended' } });
  const r2 = await undoStarts({ rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0, bands: { band: 'green', own_building: 'open', prodBlocked: false },
    running: [], launch: async (x) => { launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, pid: 4242, pidStart: 's4242', head: 'h'.repeat(40) }; }, filesOf: filesOfCommits, alert: () => {} });
  assert.deepEqual(r2.started, ['U-1']);
});

test('r4 Minor: usage unread for over a day is told again each day it lasts', async () => {
  const w = world([], { usage: null });
  const told = () => w.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
  await w.pass(0);
  await w.pass(25 * 60);
  assert.equal(told(), 1, w.calls.alerts.join(' | '));
  await w.pass(26 * 60);
  assert.equal(told(), 1);
  await w.pass(50 * 60);
  assert.equal(told(), 2, 'again a day later');
});

function usageInto(rec) {
  rec.write({ actor: 'sensors', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ ...GREEN, account: ACCT, now: T0 }) });
}

// Audit 0b-6 r5 m1: a launch has its own time limit. One that never answers holds no other start; its card
// stays claimed (a late answer may still start a session, so it never goes back to ready) and Joe is told.
test('r5 m1: a launch that never answers holds no other start; its card stays claimed and is told once a day', { timeout: 10_000 }, async () => {
  const w = world([card('C-A'), card('C-B', { product: 'p2', files: ['src/b.js'] })]);
  const run = (min) => dispatcherPass({ rec: w.rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle,
    launch: (x) => (x.card.id === 'C-A' ? new Promise(() => {}) : { ok: true, sessionId: x.sessionId, pid: 9, pidStart: 's9', pgid: 9, head: 'h'.repeat(40) }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert: (t) => w.calls.alerts.push(t), portDeadlineMs: 50 });
  const r = await run(0);
  assert.deepEqual(r.started.map((x) => (Array.isArray(x) ? x[0] : x)), ['C-B'], JSON.stringify(r));
  assert.equal(w.rec.read('card', 'C-A').doc.state, 'claimed');
  assert.equal(w.calls.alerts.filter((a) => /card C-A: the launcher it did not answer within 50 ms/.test(a)).length, 1, w.calls.alerts.join(' | '));
});

// Audit 0b-6 r5 MAT-2 and m4: the pass's own alert sites with the alert failing first, and a Lead hand-off
// reason that changes only in a number.
test('r5 MAT-2: usage unknown and a failed Lead hand-off, with the first alert failing, are each told once once alerts work', { timeout: 10_000 }, async () => {
  for (const bad of [() => { throw new Error('down'); }, () => Promise.reject(new Error('down'))]) {
    const parked = { state: 'waiting', product: 'p1', wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
    const w = world([['card', 'C-1', { ...parked, tier: 1 }]], { usage: null });
    w.setProduct('p2', 'paused');
    const sent = [];
    let down = true;
    let n = 0;
    const at = (min) => dispatcherPass({ rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, portDeadlineMs: 50,
      pauseLead: () => { throw new Error(`Lead not reachable (pid ${++n})`); }, alert: (t) => (down ? bad(t) : sent.push(t)) });
    await at(0);
    await at(24 * 60 + 1);
    assert.deepEqual(sent, []);
    down = false;
    await at(24 * 60 + 2);
    await at(24 * 60 + 3);
    assert.equal(sent.filter((t) => /usage has been unreadable/.test(t)).length, 1, sent.join(' | '));
    assert.equal(sent.filter((t) => /could not be asked to hand off/.test(t)).length, 1, sent.join(' | '));
  }
});

// Audit 0b-6 r7 M2, the stop site: a failed stop's alert, still queued when the stop is dropped, leaves unsent.
// Otherwise a later delivery would mark a new stop of the same session as told before that one ever failed.
test('r7 M2: a dropped stop takes its queued alert with it; the next failed stop of that session is told', async () => {
  const w = world([card('C-1', { state: 'running', claim: { kind: 'session', session_id: 'S-A', host: 'test-host' } })]);
  const sessions = [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-1', pgid: 50 }];
  let atRest = true;
  let up = false;
  const got = [];
  const run = (min) => stopPass({ rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions, probe: () => (atRest ? idle : busy),
    stopGroup: async () => ({ ok: false, reason: 'EPERM' }), saveWork: async () => ({ ok: true }), portDeadlineMs: 50, saveDeadlineMs: 50,
    alert: (t) => { if (!up) throw new Error('no network'); got.push(t); return true; } });
  w.setUsage(RED, T0);
  await run(0);
  assert.equal(got.length, 0);
  w.setUsage(GREEN, T0 + MIN);
  await run(1);
  assert.equal(w.rec.read('fact', STOP_FACT('S-A')).doc.state, 'dropped');
  // Wanted again, not yet at a safe point; the port is back.
  w.setUsage(RED, T0 + 2 * MIN);
  atRest = false; up = true;
  await run(2);
  assert.equal(got.length, 0, 'the alert of the dropped stop is not sent');
  assert.ok(!w.rec.read('fact', STOP_FACT('S-A')).doc.told_at, 'the new stop is not marked told');
  atRest = true;
  w.setUsage(RED, T0 + 3 * MIN);
  await run(3);
  assert.equal(got.filter((t) => /S-A \(card C-1\) could not be stopped/.test(t)).length, 1, got.join(' | '));
});

// Audit 0b-6 r7 M2, the stop site: a stop that failed while the port was down and then succeeded leaves its
// queued "could not be stopped" alert unsent, so the port coming back does not report a stop that went through.
test('r7 M2: a stop that went through takes its queued failure alert with it', async () => {
  const w = world([card('C-1', { state: 'running', claim: { kind: 'session', session_id: 'S-A', host: 'test-host' } })]);
  const sessions = [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-1', pgid: 50 }];
  let up = false;
  let works = false;
  const got = [];
  const run = (min, ss = sessions) => stopPass({ rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: ss, probe: () => idle,
    stopGroup: async () => (works ? { ok: true, how: 'term' } : { ok: false, reason: 'EPERM' }), saveWork: async () => ({ ok: true }), portDeadlineMs: 50, saveDeadlineMs: 50,
    alert: (t) => { if (!up) throw new Error('no network'); got.push(t); return true; } });
  w.setUsage(RED, T0);
  await run(0);
  works = true;
  await run(1);
  assert.equal(w.rec.read('fact', STOP_FACT('S-A')).doc.state, 'done');
  up = true;
  await run(2, []);
  assert.equal(got.filter((t) => /could not be stopped/.test(t)).length, 0, got.join(' | '));
  assert.ok(!w.rec.read('fact', STOP_FACT('S-A')).doc.told_at);
});

// Audit 0b-6 r7 M2, the pause sites: a failed hand-off's alert, still queued when the product is unpaused or
// its Lead is asked after all, leaves unsent. A late copy would report a hand-off that no longer fails, and
// its mark would hide the next real failure of that product for a day.
test('r7 M2: a hand-off alert queued while the port was down leaves when the pause clears or the Lead is asked', async () => {
  for (const how of ['unpaused', 'asked']) {
    const w = world([]);
    w.setProduct('p2', 'paused');
    const sent = [];
    let down = true;
    let fails = true;
    const at = (min) => dispatcherPass({ rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, portDeadlineMs: 50,
      pauseLead: () => { if (fails) throw new Error('Lead not reachable'); }, alert: (t) => { if (down) throw new Error('down'); sent.push(t); return true; } });
    const told = () => sent.filter((t) => /could not be asked to hand off/.test(t)).length;
    await at(0);
    if (how === 'unpaused') w.setProduct('p2', 'active'); else fails = false;
    await at(1);
    down = false;
    await at(2);
    assert.equal(told(), 0, `${how}: ${sent.join(' | ')}`);
    if (how === 'unpaused') {
      // Paused again within the day, and the hand-off fails again: told.
      w.setProduct('p2', 'paused');
      fails = true;
      await at(3);
      assert.equal(told(), 1, `${how}: ${sent.join(' | ')}`);
    }
  }
});

// Audit 0b-6 r8 MAT-1: an undo held while the port was down was never marked told, so when it started the
// queued alert was not dropped (the drop sat behind the told field). The stale copy then marked the hold told,
// and a second hold of that card the same day went untold. Now the drop runs whenever the undo starts.
test('r8 MAT-1: a held undo that starts before its alert is sent leaves no stale alert; a second hold that day is told', async () => {
  const w = world([...undoEntries('U-1')]);
  const deny = rulesWith({}, { start_session: { decision: 'deny', reason: 'the product is paused' } });
  const allow = rulesWith({}, startAnswer(w.rec));
  let down = true;
  const sent = [];
  const at = (min, rules) => dispatcherPass({ rec: w.rec, rules, now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle,
    launch: async (x) => ({ ok: true, sessionId: x.sessionId, pid: 300 + min, pidStart: `s${min}`, pgid: 300 + min, head: 'h'.repeat(40) }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, portDeadlineMs: 50,
    alert: (t) => { if (down) throw new Error('down'); sent.push(t); return true; } });
  const told = () => sent.filter((t) => /your undo \(card U-1\) is waiting/.test(t)).length;
  await at(0, deny);
  await at(1, allow);
  assert.equal(w.rec.read('card', 'U-1').doc.state, 'running');
  down = false;
  await at(2, allow);
  assert.equal(told(), 0, sent.join(' | '));
  assert.ok(!w.rec.read('fact', UNDO_HELD_FACT('U-1'))?.doc?.told_at, 'the stale copy wrote no told mark');
  // The card comes back (a restart) and is held again the same day: told.
  // M9 has no running -> ready move: the card waits on Joe, then goes back to ready (its claim ended at the wait).
  w.setCard('U-1', { state: 'waiting', wait: { who: 'joe', what: 'restart' } });
  w.setCard('U-1', { state: 'ready' });
  await at(3, deny);
  assert.equal(told(), 1, sent.join(' | '));
});
