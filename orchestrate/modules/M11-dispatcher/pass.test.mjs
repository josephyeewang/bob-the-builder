import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { STATES, FINAL_STATES } from '../../shared/record.mjs';
import { STOP_QUIET_REASONS } from '../M4-workshop/launcher/review-runner.mjs';
import { dispatcherPass as dispatcherPass0, stopPass as stopPass0, undoStarts, stopProcessGroup, guarded, STOP_FACT, UNSAVED_FACT, LIMIT_FACT, LIMIT_NO_ACCOUNT, LIMIT_NO_RUN, LIMIT_NO_HIT, LIMIT_NO_RESET, LIMIT_RESET_MAX_MS, UNDO_HELD_FACT, PAUSE_FACT, RULES_MISSING_FACT, rulesMissingAlert as rulesMissingAlert0, UNKNOWN_FACT, REVIEW_STOP_FACT, REVIEW_STOP_RUNNER_REASON, REVIEW_STOP_AGAIN_MS, REVIEW_STOP_TELL_FACT, REVIEW_STOP_MAX_ASKS } from './pass.mjs';
import { USAGE_FACT, BAND_FACT } from './usage.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { retellWaits, WAIT_TELL_FACT } from './joe-waits.mjs';
import { KEYS as K } from './keys.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { outbox, isQueued } from './alerts.mjs';
import { writeLog, queueFor, assertDropFirst, lateMark } from './fixtures.test-helper.mjs';
import { REFUSED_FACT, tellRefused, watchWrites } from './refused-writes.mjs';
import { change, parkOnLimit, rulesWith, realEngine, recWith, seed, usageFact, undoEntries, filesOfCommits, T0, MIN, H, iso, withAlerts, setClock } from './fixtures.test-helper.mjs';

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
  const pass = (min = 0, extra = {}) => dispatcherPass({ product: 'p1',
    rec: extra.rec ?? rec, rules: extra.rules ?? rules, now: T0 + min * MIN, account: ACCT, sessions: [...sessions],
    probe: (s) => probes.get(s.id) ?? idle,
    // The launcher starts the session the claim names and reports its process (L72), as M4's does.
    launch: async (x) => { calls.launched.push(x.card.id); const a = launchAnswer(x); if (!a.ok) return a; n += 1; const id = 'sessionId' in a ? a.sessionId : x.sessionId; sessions.push({ id, product: x.product, kind: x.kind, card: x.card.id, pgid: 100 + n }); return { ok: true, sessionId: id, pid: 1000 + n, pidStart: `start-${n}`, pgid: 100 + n, head: 'head' in a ? a.head : 'h'.repeat(40), ...('base' in a ? { base: a.base } : {}), outbox: 'outbox' in a ? a.outbox : `/outbox-root/${x.product}/worker/${id}`, signin: a.signin, configDir: a.configDir, ...('product' in a ? { product: a.product } : {}) }; },
    outboxRoot: extra.outboxRoot,
    stopGroup: extra.stopGroup ?? (async (s) => { calls.stops.push(s.id); const i = sessions.findIndex((x) => x.id === s.id); if (i >= 0) sessions.splice(i, 1); return { ok: true, how: 'SIGTERM' }; }),
    saveWork: async (s) => { calls.saves.push(s.id); return { ok: true }; },
    hostLock: extra.hostLock ?? (() => extra.host ?? null),
    pauseLead: extra.pauseLead ?? (({ product }) => { calls.pauses.push([product, [...calls.stops]]); }),
    startsOff: extra.startsOff ?? null,
    filesOf: extra.filesOf ?? filesOfCommits,
    failureLog: extra.failureLog,
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
  const r = await dispatcherPass({ product: 'p1', rec: sneaky, rules: rulesWith({}, startAnswer(rec)), now: T0, account: ACCT, sessions: [], probe: () => idle,
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
  // A card waits on the usage limit (WAIT_WHO usage) of the account its wait names, parked from its run (MAT-1).
  const w = world([['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }]]);
  parkOnLimit(w.rec, 'T2', { account: ACCT, card: { files: ['src/t2.js'] } });
  parkOnLimit(w.rec, 'T1', { account: ACCT, card: { tier: 1 } });
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
  const w = world([
    ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }],
    ['fact', LIMIT_FACT('acct-b'), { resets_at: iso(T0 + 90 * MIN), observed_at: iso(T0 + MIN) }],
  ]);
  parkOnLimit(w.rec, 'A', { account: ACCT });
  parkOnLimit(w.rec, 'B', { account: 'acct-b' });
  const r1 = await w.pass(31);
  assert.deepEqual(r1.resumed, ['A'], 'only the card on a, whose limit reset');
  assert.equal(w.rec.read('card', 'B').doc.state, 'waiting', "b's limit has not reset");
  const r2 = await w.pass(91);
  assert.deepEqual(r2.resumed, ['B']);
});

test('L97 M-3, MAT-1: a hit from before the run began resumes nothing; a hit with no reset time waits on Joe, told', async () => {
  // C's run began at +15 min; the only reading was taken at +1 min (an earlier limit, reset at +10). D's reading is
  // after its run began but has no reset time (resets_at null, as the writer leaves it when the reset is unknown).
  const w = world([
    ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 10 * MIN), observed_at: iso(T0 + MIN) }],
    ['fact', LIMIT_FACT('acct-d'), { resets_at: null, observed_at: iso(T0 + MIN) }],
  ]);
  parkOnLimit(w.rec, 'C', { ranAt: T0 + 15 * MIN, parkedAt: T0 + 20 * MIN, account: ACCT });
  parkOnLimit(w.rec, 'D', { ranAt: T0, account: 'acct-d' });
  const r = await w.pass(60);
  assert.deepEqual(r.resumed, []);
  assert.deepEqual([w.rec.read('card', 'C').doc.state, w.rec.read('card', 'C').doc.wait.who], ['waiting', 'usage']);
  const d = w.rec.read('card', 'D').doc;
  assert.deepEqual([d.state, d.wait.who, d.wait.what], ['waiting', 'joe', LIMIT_NO_RESET]);
  assert.equal(w.calls.alerts.filter((a) => /card D: account acct-d hit its usage limit but the reset time could not be read/.test(a)).length, 1);
  // A new reading for C's limit, taken after its run began and reset since: C resumes.
  const cur = w.rec.read('fact', LIMIT_FACT(ACCT));
  w.rec.write({ actor: 'sensors', entity: 'fact', id: LIMIT_FACT(ACCT), expectRev: cur.rev, doc: { resets_at: iso(T0 + 50 * MIN), observed_at: iso(T0 + 25 * MIN) } });
  const r2 = await w.pass(61);
  assert.deepEqual(r2.resumed, ['C']);
});

test('audit #125 r1 MAT-A: a reset more than a week after the hit is read as no reset time: the card waits on Joe, told', async () => {
  const DAY = 24 * 60 * MIN;
  const w = world([
    // E: a misread 300 days ahead. F: exactly a week and an hour after its hit (the longest real window, with slack).
    ['fact', LIMIT_FACT('acct-e'), { resets_at: iso(T0 + MIN + 300 * DAY), observed_at: iso(T0 + MIN) }],
    ['fact', LIMIT_FACT('acct-f'), { resets_at: iso(T0 + MIN + LIMIT_RESET_MAX_MS), observed_at: iso(T0 + MIN) }],
  ]);
  parkOnLimit(w.rec, 'E', { ranAt: T0, account: 'acct-e' });
  parkOnLimit(w.rec, 'F', { ranAt: T0, account: 'acct-f' });
  await w.pass(60);
  const e = w.rec.read('card', 'E').doc;
  assert.deepEqual([e.state, e.wait.who, e.wait.what], ['waiting', 'joe', LIMIT_NO_RESET]);
  assert.equal(w.calls.alerts.filter((x) => /card E: account acct-e hit its usage limit but the reset time it gave \(.*\) is more than a week after the hit/.test(x)).length, 1);
  assert.deepEqual([w.rec.read('card', 'F').doc.wait.who], ['usage'], 'a reset at the edge still waits on usage');
});

test('audit #125 r2 m-1, c-2: the far reset is judged against the hit, not now: a reset an hour past the bound waits on Joe though the pass runs 2 h after the hit', async () => {
  assert.equal(LIMIT_RESET_MAX_MS, 7 * 24 * H + H, 'the bound is a week and an hour (the longest real window, with slack)');
  // Judged from now (2 h after the hit), this reset would be inside the bound and the card would wait on usage.
  const w = world([['fact', LIMIT_FACT('acct-g'), { resets_at: iso(T0 + MIN + LIMIT_RESET_MAX_MS + H), observed_at: iso(T0 + MIN) }]]);
  parkOnLimit(w.rec, 'G', { ranAt: T0, account: 'acct-g' });
  await w.pass(2 * 60 + 1);
  const g = w.rec.read('card', 'G').doc;
  assert.deepEqual([g.state, g.wait.who, g.wait.what], ['waiting', 'joe', LIMIT_NO_RESET]);
  assert.equal(w.calls.alerts.filter((x) => /card G: account acct-g hit its usage limit but the reset time it gave .* is more than a week after the hit/.test(x)).length, 1);
});

test('audit #125 r2 m-2, m-3: a card that has waited on a limit longer than the bound waits on Joe, told once, though each new hit moves the reset ahead', async () => {
  const DAY = 24 * H;
  // A hit dated 3 days after the park, its reset a week later: each reading is in bounds, yet the card never resumes.
  const w = world([['fact', LIMIT_FACT('acct-h'), { resets_at: iso(T0 + 10 * DAY), observed_at: iso(T0 + 3 * DAY) }]]);
  parkOnLimit(w.rec, 'H', { ranAt: T0, account: 'acct-h' });
  await w.pass(LIMIT_RESET_MAX_MS / MIN);
  assert.deepEqual([w.rec.read('card', 'H').doc.wait.who], ['usage'], 'exactly the bound is not over it');
  await w.pass(LIMIT_RESET_MAX_MS / MIN + 1);
  const h = w.rec.read('card', 'H').doc;
  assert.deepEqual([h.state, h.wait.who, h.wait.what], ['waiting', 'joe', LIMIT_NO_RESET]);
  const told = () => w.calls.alerts.filter((x) => /card H: it has waited on account acct-h's usage limit since .*, longer than any real limit window/.test(x));
  assert.equal(told().length, 1);
  await w.pass(LIMIT_RESET_MAX_MS / MIN + 2);
  assert.equal(told().length, 1, 'told once');
});

// A hand-edited Record (L285): the M9 writer always stamps a readable since. The stand-in keeps a re-checked wait's
// since as the writer does (L296), but stores a new wait's since as sent (its one departure, shared/record.mjs), so the
// bad since goes in as a wait on another what, then back: an unreadable since is never kept, so it stays as sent.
const garbleSince = (rec, id, since = 'not a time') => {
  const wait = rec.read('card', id).doc.wait;
  for (const what of ['hand-edited', wait.what]) {
    const r = change(rec, 'card', id, { wait: { ...rec.read('card', id).doc.wait, what, since } });
    assert.ok(r.ok, r.reason);
  }
  assert.deepEqual([rec.read('card', id).doc.wait.what, rec.read('card', id).doc.wait.since], [wait.what, since]);
};

test('L285: a limit wait whose since can\'t be read still ends: both caps count from the run\'s start, never from a hit that moves', async () => {
  const DAY = 24 * H;
  const w = world([['fact', LIMIT_FACT('acct-s'), { resets_at: iso(T0 + 10 * DAY), observed_at: iso(T0 + 3 * DAY) }]]);
  parkOnLimit(w.rec, 'S', { ranAt: T0, account: 'acct-s' });
  parkOnLimit(w.rec, 'U', { ranAt: T0, account: 'acct-u' });   // no hit is ever recorded for acct-u
  garbleSince(w.rec, 'S'); garbleSince(w.rec, 'U');
  await w.pass(24 * 60);
  assert.equal(w.rec.read('card', 'U').doc.wait.who, 'usage', 'exactly the no-hit cap from the run\'s start is not over it');
  await w.pass(24 * 60 + 1);
  assert.deepEqual([w.rec.read('card', 'U').doc.wait.who, w.rec.read('card', 'U').doc.wait.what], ['joe', LIMIT_NO_HIT]);
  // The hit (3 days in) and its reset (10 days in) are each in bounds; counted from the hit the card would wait past
  // its reset with every new hit. Counted from the run's start, a minute past the bound waits on Joe.
  await w.pass(LIMIT_RESET_MAX_MS / MIN);
  assert.equal(w.rec.read('card', 'S').doc.wait.who, 'usage', 'exactly the cap from the run\'s start is not over it');
  await w.pass(LIMIT_RESET_MAX_MS / MIN + 1);
  assert.deepEqual([w.rec.read('card', 'S').doc.wait.who, w.rec.read('card', 'S').doc.wait.what], ['joe', LIMIT_NO_RESET]);
  assert.equal(w.calls.alerts.filter((x) => /card S: it has waited on account acct-s's usage limit since 2\S+Z, longer than any real limit window/.test(x)).length, 1);
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

test('M8: usage unknown for over a day -> parked work waits on Joe; the stretch and the card are each told once', async () => {
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
  // L138 m4: the card's wait on Joe is told through waitOnJoe, besides the stretch's own alert.
  assert.deepEqual(w.calls.alerts.map((t) => (typeof t === 'string' ? t : t.text)).sort(), [
    "card C-1: usage has been unreadable for over a day, so it can't resume by itself; it waits on you",
    'usage has been unreadable for over a day; parked work waits on you']);
});

test('M8 / R-0b-67: unknown usage -> no Tier-1 start; Tier 2 still starts', async () => {
  const w = world([card('C-1', { tier: 1 }), card('C-2')], { usage: null });
  const r = await w.pass();
  assert.deepEqual(r.started, ['C-2']);
  // M10 refuses a Tier-1 start with no usage reading before the band check is reached (L81: start_session is asked
  // what M10 reads, and an unknown band carries no reading time).
  assert.match(r.refused[0][1], /Tier 1 start needs a usage reading/);
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
  assert.equal(l.base, null, 'a launcher that does not say a base records null');
  // L825-2: the commit the launcher started the copy on is recorded as it said it.
  const b = world([card('C-3')]);
  b.refuseLaunch(() => ({ ok: true, base: 'b'.repeat(40) }));
  await b.pass();
  assert.equal(b.rec.read('launch', b.sessions[0].id).doc.base, 'b'.repeat(40));
  // #384 m2: a base that is no commit id is never recorded as the copy's start; the launch is refused and told.
  for (const bad of ['main', 'B'.repeat(40), 7, { sha: 'b'.repeat(40) }]) {
    const m = world([card('C-4')]);
    m.refuseLaunch(() => ({ ok: true, base: bad }));
    await m.pass();
    assert.equal(m.rec.read('launch', m.sessions[0].id), null, String(bad));
    assert.match(m.calls.alerts.join('\n'), /launch was not recorded \(the launch named a malformed base commit\); its merge will be refused/, String(bad));
  }
  // a launcher that names no head: the session runs, the record refuses the launch, the owner is told
  const v = world([card('C-2')]);
  v.refuseLaunch(() => ({ ok: true, head: undefined }));
  await v.pass();
  assert.equal(v.rec.read('launch', v.sessions[0].id), null);
  assert.match(v.calls.alerts.join('\n'), /launch was not recorded .*head.*merge will be refused/);
});

test('L204-a: every start writes its session record, with its own attempt number', async () => {
  // An earlier session of C-1: this start is the card's second, so its push gets its own record line. Another card's
  // session does not count.
  const w = world([card('C-1'), ['session', 'S-old', { state: 'preparing', role: 'worker', product: 'p1', card: 'C-1' }],
    ['session', 'S-other', { state: 'preparing', role: 'worker', product: 'p1', card: 'C-8' }]]);
  await w.pass();
  const sid = w.sessions[0].id;
  const s = w.rec.read('session', sid).doc;
  assert.deepEqual([s.state, s.role, s.product, s.card, s.branch, s.outbox, s.attempt, s.pid, s.pid_start, s.launched_at],
    ['preparing', 'worker', 'p1', 'C-1', 'card/c-1', `/outbox-root/p1/worker/${sid}`, 'a2', 1001, 'start-1', iso(T0)]);
  assert.equal(w.calls.alerts.length, 0);
});

test('L72: a launcher that answers with a session the claim does not name starts nothing and is told', async () => {
  const w = world([card('C-2')]);
  let sid;
  w.refuseLaunch((x) => { sid = x.sessionId; return { ok: true, sessionId: 'S-SOMEONE-ELSE', outbox: '/outbox-root/p1/worker/S-SOMEONE-ELSE' }; });
  const r = await w.pass();
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.refused, [['C-2', 'launcher: it started a session the claim does not name']]);
  const c = w.rec.read('card', 'C-2').doc;
  assert.deepEqual([c.state, c.claim?.session_id], ['claimed', sid], 'the card stays claimed');
  for (const id of [sid, 'S-SOMEONE-ELSE']) for (const entity of ['session', 'launch']) assert.equal(w.rec.read(entity, id), null, `${entity} ${id}`);
  assert.match(w.calls.alerts.join('\n'), new RegExp(`card C-2: the launcher answered with session S-SOMEONE-ELSE, not the claimed ${sid}; the card stays claimed`));
});

// The outboxes a launcher must not be believed about: each is refused, however it is wrong (#219 audit M-1, m-1).
const WRONG_OUTBOXES = [
  ['missing', () => undefined, /was not named/],
  ['not a full path', (sid) => `outbox/worker/${sid}`, /is not a full path/],
  ['another session\'s, such as an older attempt\'s', () => '/outbox-root/p1/worker/SOME-OTHER-SESSION', /is not this session's own folder/],
  ['climbing out', (sid) => `/outbox-root/p1/worker/${sid}/../../../etc`, /is not a plain path/],
  ['climbing back to the same name', (sid) => `/outbox-root/p1/worker/x/../${sid}`, /is not a plain path/],
  ['the reviewer\'s', (sid) => `/outbox-root/p1/reviewer/${sid}`, /is not a worker outbox/],
  ['the top of the disk', () => '/', /is not a plain path/],
];

for (const [name, outbox, why] of WRONG_OUTBOXES) {
  test(`#219 M-1: an outbox that is ${name} is refused: the session is stopped, the claim given back, the owner told`, async () => {
    const w = world([card('C-2')]);
    let sid;
    w.refuseLaunch((x) => { sid = x.sessionId; return { ok: true, outbox: outbox(x.sessionId) }; });
    const r = await w.pass();
    assert.deepEqual(r.started, []);
    assert.deepEqual(w.calls.stops, [sid], 'the session is stopped');
    assert.deepEqual(w.sessions, []);
    const c = w.rec.read('card', 'C-2').doc;
    assert.deepEqual([c.state, c.claim ?? null], ['ready', null], 'the claim is given back');
    assert.equal(w.rec.read('session', sid), null, 'no session record, so nothing can push from it');
    assert.equal(w.rec.read('launch', sid), null, 'no launch record, so nothing can merge from it');
    assert.match(r.refused.map(([, x]) => x).join('\n'), why);
    const said = w.calls.alerts.join('\n');
    assert.match(said, why);
    assert.match(said, new RegExp(`card C-2: session ${sid} was refused: the outbox its launcher named .*it was stopped and the card went back to ready`));
  });
}

test('#219 r2 m-4: the stop of a refused session names the account it started in, the same two fields as a running session', async () => {
  const w = world([card('C-2')]); let asked = null;
  w.refuseLaunch(() => ({ ok: true, outbox: '/', signin: 'acct-2', configDir: '/cfg/acct-2' }));
  await w.pass(0, { stopGroup: async (s) => { asked = s; return { ok: true }; } });
  assert.deepEqual([asked?.signin, asked?.config_dir], ['acct-2', '/cfg/acct-2']);
});

test('#219 M-1: a wrong outbox whose session can\'t be stopped keeps the card claimed, so no second session starts, and says so', async () => {
  const w = world([card('C-2')]);
  let sid;
  w.refuseLaunch((x) => { sid = x.sessionId; return { ok: true, outbox: '/' }; });
  const r = await w.pass(0, { stopGroup: async () => ({ ok: false, reason: 'permission' }) });
  assert.deepEqual(r.started, []);
  const c = w.rec.read('card', 'C-2').doc;
  assert.deepEqual([c.state, c.claim?.session_id], ['claimed', sid]);
  assert.match(w.calls.alerts.join('\n'), /it could not be stopped \(permission\), so the card stays claimed and cannot start twice/);
  assert.equal(w.rec.read('session', sid), null);
  // A stop that throws, or never answers, is no stop either: the claim stays.
  const v = world([card('C-3')]);
  v.refuseLaunch(() => ({ ok: true, outbox: undefined }));
  await v.pass(0, { stopGroup: async () => { throw new Error('gone wrong'); } });
  assert.equal(v.rec.read('card', 'C-3').doc.state, 'claimed');
  assert.match(v.calls.alerts.join('\n'), /could not be stopped \(gone wrong\)/);
});

test('#219 M-1: a stopped session whose claim can\'t be given back says so', async () => {
  const w = world([card('C-2')]);
  w.refuseLaunch(() => ({ ok: true, outbox: undefined }));
  const rec = { ...w.rec, ready: w.rec.ready, list: w.rec.list, read: w.rec.read, write: w.rec.write, meta: w.rec.meta, claim: w.rec.claim, release: () => ({ ok: false, reason: 'the store refused' }) };
  await w.pass(0, { rec });
  assert.match(w.calls.alerts.join('\n'), /it was stopped, but its claim could not be given back \(the store refused\); it lapses at claims.unlaunched_min/);
});

test('#219 M-1: with the outbox root known, the real folder must be the session\'s own, through any link', async () => {
  const root = realpathSync(tempDir('orch-pass-outbox-'));
  // L836: the outboxes are <root>/<product>/<role>/<session id>.
  mkdirSync(join(root, 'p1', 'worker'), { recursive: true });
  // Good: the folder is really there.
  const w = world([card('C-1')]);
  w.refuseLaunch((x) => { const d = join(root, 'p1', 'worker', x.sessionId); mkdirSync(d); return { ok: true, outbox: d }; });
  assert.deepEqual((await w.pass(0, { outboxRoot: root })).started, ['C-1']);
  assert.deepEqual(w.calls.alerts, []);
  // The right name, but outside the root.
  const v = world([card('C-2')]);
  v.refuseLaunch((x) => { const d = join(root, 'elsewhere', 'worker', x.sessionId); mkdirSync(d, { recursive: true }); return { ok: true, outbox: d }; });
  assert.deepEqual((await v.pass(0, { outboxRoot: root })).started, []);
  assert.match(v.calls.alerts.join('\n'), /is not inside the outbox root/);
  // The right name in the right place, but a link to another session's folder.
  const u = world([card('C-3')]);
  const older = join(root, 'p1', 'worker', 'older-attempt');
  mkdirSync(older);
  u.refuseLaunch((x) => { const d = join(root, 'p1', 'worker', x.sessionId); symlinkSync(older, d); return { ok: true, outbox: d }; });
  assert.deepEqual((await u.pass(0, { outboxRoot: root })).started, []);
  assert.match(u.calls.alerts.join('\n'), /is not inside the outbox root/);
  // Named, but not there.
  const t = world([card('C-4')]);
  t.refuseLaunch((x) => ({ ok: true, outbox: join(root, 'p1', 'worker', x.sessionId) }));
  assert.deepEqual((await t.pass(0, { outboxRoot: root })).started, []);
  assert.match(t.calls.alerts.join('\n'), /could not be read \(ENOENT\)/);
  // L836: the right role and session, but in another product's folder, or the old flat place: not this session's own.
  for (const [n, where] of [['C-5', ['p2', 'worker']], ['C-6', ['worker']]]) {
    const o = world([card(n)]);
    o.refuseLaunch((x) => { const d = join(root, ...where, x.sessionId); mkdirSync(d, { recursive: true }); return { ok: true, outbox: d }; });
    assert.deepEqual((await o.pass(0, { outboxRoot: root })).started, [], n);
    assert.match(o.calls.alerts.join('\n'), /is not inside the outbox root/, n);
  }
});

test('#403 r1 A10: the outbox is checked against the product the pass launched, never one the launch answer names', async () => {
  const root = realpathSync(tempDir('orch-pass-outbox-a10-'));
  // The launcher answers with p2's outbox and says it is p2's: the pass still checks against p1, the card's product.
  const o = world([card('C-1')]);
  o.refuseLaunch((x) => {
    assert.equal(x.product, 'p1', 'the pass launches the card\'s own product');
    const d = join(root, 'p2', 'worker', x.sessionId); mkdirSync(d, { recursive: true });
    return { ok: true, outbox: d, product: 'p2' };
  });
  assert.deepEqual((await o.pass(0, { outboxRoot: root })).started, []);
  assert.match(o.calls.alerts.join('\n'), /is not inside the outbox root/);
  // Without the root too: another product's folder is refused by name.
  const v = world([card('C-2')]);
  v.refuseLaunch((x) => ({ ok: true, outbox: `/outbox-root/p2/worker/${x.sessionId}`, product: 'p2' }));
  assert.deepEqual((await v.pass(0)).started, []);
  assert.match(v.calls.alerts.join('\n'), /is not in product p1's own folder/);
});

test('#219 m-2: a record not written and a wrong outbox are two causes: one told today does not hide the other', async () => {
  const wrong = /was refused: the outbox its launcher named/;
  const noRecord = /its session record was not written/;
  const says = (w, re) => w.calls.alerts.filter((a) => re.test(a)).length;
  const refuseRecord = (w) => w.refuseLaunch((x) => {
    assert.equal(w.rec.write({ actor: 'dispatcher', entity: 'session', id: x.sessionId, expectRev: 0, doc: { state: 'preparing', role: 'worker', card: 'C-9' } }).ok, true);
    return { ok: true, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}` };
  });
  // Told once a day however often it repeats.
  const w = world([card('C-1')]);
  w.refuseLaunch(() => ({ ok: true, outbox: undefined }));
  await w.pass();
  await w.pass(1);
  assert.equal(says(w, wrong), 1);
  // A record refused the same day is a different failure, told though the outbox was told within the day. The session
  // itself is good, so it runs on; only its push is lost.
  refuseRecord(w);
  assert.deepEqual((await w.pass(2)).started, ['C-1']);
  assert.equal(says(w, noRecord), 1);
  // And the other way round: a record told today does not hide a wrong outbox.
  const v = world([card('C-2'), ['fact', 'hold-session-record-C-2', { text: 'earlier', told_at: iso(T0) }]]);
  v.refuseLaunch(() => ({ ok: true, outbox: undefined }));
  await v.pass(1);
  assert.equal(says(v, wrong), 1);
});

test('#219 m-2: a later good start clears each cause, so a failure that comes back is told at once', async () => {
  const told = { text: 'earlier', told_at: iso(T0) };
  const w = world([card('C-1'), ['fact', 'hold-session-outbox-C-1', told], ['fact', 'hold-session-record-C-1', told]]);
  assert.deepEqual((await w.pass(1)).started, ['C-1']);
  for (const f of ['hold-session-outbox-C-1', 'hold-session-record-C-1']) assert.equal(w.rec.read('fact', f).doc.told_at, null, f);
  // A start refused for its outbox leaves the record's mark alone: nothing about the record was shown to be good.
  const v = world([card('C-2'), ['fact', 'hold-session-record-C-2', told]]);
  v.refuseLaunch(() => ({ ok: true, outbox: undefined }));
  await v.pass(1);
  assert.equal(v.rec.read('fact', 'hold-session-record-C-2').doc.told_at, iso(T0));
  // A record refused leaves the outbox cleared: that outbox was good.
  const u = world([card('C-3'), ['fact', 'hold-session-outbox-C-3', told]]);
  u.refuseLaunch((x) => { u.rec.write({ actor: 'dispatcher', entity: 'session', id: x.sessionId, expectRev: 0, doc: { state: 'preparing', role: 'worker', card: 'C-9' } }); return { ok: true, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}` }; });
  await u.pass(1);
  assert.equal(u.rec.read('fact', 'hold-session-outbox-C-3').doc.told_at, null);
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

test('L822 planted: a stop its caller aborted sends nothing more: not before SIGTERM, not during the wait, not SIGKILL', async () => {
  const sent = [];
  const kill = (p, s) => sent.push(s);
  // Aborted before it starts: nothing is sent.
  const before = new AbortController();
  before.abort();
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill, alive: () => true, sleep: async () => {}, signal: before.signal }), { ok: false, reason: 'abandoned' });
  assert.deepEqual(sent, []);
  // Aborted while it waits (the caller's port limit): SIGTERM only, no SIGKILL, and it stops waiting.
  const mid = new AbortController();
  let t = 0;
  const sleep = async (ms) => { t += ms; if (t >= 3000) mid.abort(); };
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill, alive: () => true, sleep, signal: mid.signal }), { ok: false, reason: 'abandoned' });
  assert.deepEqual([sent, t], [['SIGTERM'], 3000]);
  // Aborted on the last wait, just before SIGKILL.
  sent.length = 0;
  const last = new AbortController();
  let u = 0;
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill, alive: () => true, sleep: async (ms) => { u += ms; if (u >= 10_000) last.abort(); }, signal: last.signal }), { ok: false, reason: 'abandoned' });
  assert.deepEqual(sent, ['SIGTERM']);
  // #372 m1: the abort and the group's exit at the same step: the exit is told, not 'abandoned'.
  sent.length = 0;
  const both = new AbortController();
  let gone = false;
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill, alive: () => !gone, sleep: async () => { gone = true; both.abort(); }, signal: both.signal }), { ok: true, how: 'SIGTERM' });
  sent.length = 0;
  const atEnd = new AbortController();
  let v = 0;
  assert.deepEqual(await stopProcessGroup({ pgid: 42, kill, alive: () => v < 10_000, sleep: async (ms) => { v += ms; if (v >= 10_000) atEnd.abort(); }, signal: atEnd.signal }), { ok: true, how: 'SIGTERM' });
  assert.deepEqual(sent, ['SIGTERM']);
  // Never aborted: the same as with no signal.
  sent.length = 0;
  assert.equal((await stopProcessGroup({ pgid: 42, kill, alive: () => true, sleep: async () => {}, signal: new AbortController().signal })).how, 'SIGKILL');
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});

test('#372 m2: guarded aborts the signal it hands its port when it gives up, and never when the port answers', async () => {
  let seen;
  const late = await guarded((signal) => { seen = signal; return new Promise(() => {}); }, 20);
  assert.equal(late.timedOut, true);
  assert.equal(seen.aborted, true);
  let quick;
  assert.deepEqual(await guarded((signal) => { quick = signal; return { ok: true }; }, 20), { ok: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(quick.aborted, false);
  // The stops hand the pass's signal to the port.
  const w = world([card('C-1')]);
  await w.pass(0);
  const got = [];
  w.setCard('C-1', { state: 'cancelled' });
  await w.pass(1, { stopGroup: async (s, o) => { got.push(o?.signal instanceof AbortSignal); return { ok: true, how: 'SIGTERM' }; } });
  assert.deepEqual(got, [true]);
});

test('M7: a stop that fails alerts and leaves the card as it was; a failed save alerts but the stop stands', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions: [...w.sessions], probe: () => idle, launch: async () => ({ ok: false }) };
  const alert = fakeAlert({ answer: true });
  const alerts = alert.texts;
  await dispatcherPass({ product: 'p1', ...base, now: T0 + MIN, stopGroup: async () => ({ ok: false, reason: 'permission' }), saveWork: async () => ({ ok: true }), alert });
  assert.match(alerts[0], /could not be stopped: permission/);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'pending');
  await dispatcherPass({ product: 'p1', ...base, now: T0 + 2 * MIN, stopGroup: async () => ({ ok: true, how: 'SIGTERM' }), saveWork: async () => ({ ok: false, reason: 'disk full' }), alert });
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
  await dispatcherPass0({ product: 'p1', ...base, now: T0 + MIN, alert: () => false });
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'done', 'the stop stands');
  assert.equal(w.rec.read('fact', UNSAVED_FACT(sid))?.doc?.told_at, undefined, 'not marked told');
  const alert = fakeAlert({ answer: true });
  const alerts = alert.texts;
  await dispatcherPass({ product: 'p1', ...base, sessions: [], now: T0 + 2 * MIN, alert });
  assert.equal(alerts.filter((a) => /not saved: disk full/.test(a)).length, 1, alerts.join(' | '));
  assert.ok(w.rec.read('fact', UNSAVED_FACT(sid)).doc.told_at);
  await dispatcherPass({ product: 'p1', ...base, sessions: [], now: T0 + 3 * MIN, alert });
  assert.equal(alerts.filter((a) => /not saved/.test(a)).length, 1, 'told once');
});

// L130 M3: a limit wait that names no account is put on Joe even when its alert is not queued; the tick's waits step
// tells it once.
test('L130: a no-account limit wait whose alert was not queued waits on Joe, and is told once by the waits step', async () => {
  const parked = { state: 'waiting', tier: 2, product: 'p1', files: ['src/n.js'], wait: { who: 'usage', what: 'limit_hit', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'N', parked], ['fact', LIMIT_FACT(ACCT), { resets_at: iso(T0 + 30 * MIN), observed_at: iso(T0 + MIN) }]]);
  const sessions = [];
  await dispatcherPass0({ product: 'p1', rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), now: T0 + 31 * MIN, account: ACCT, sessions, probe: () => idle,
    launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert: () => false });
  assert.deepEqual([w.rec.read('card', 'N').doc.wait.who, w.rec.read('card', 'N').doc.wait.what], ['joe', LIMIT_NO_ACCOUNT]);
  assert.equal(w.rec.read('fact', WAIT_TELL_FACT('N')).doc.told_since, undefined, 'not marked told');
  const alerts = [];
  const waits = (min) => withAlerts(w.rec, T0 + min * MIN, (x) => alerts.push(x), (alert) => retellWaits({ rec: w.rec, alert, now: T0 + min * MIN }));
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

test('R-0b-135: a ready research_copy card is never started as a worker (lane 2\'s copier makes its commit, L286); other ready work still starts', async () => {
  const w = world([card('R-C', { kind: 'research_copy', research_ask: 'R-1', files: ['docs/research/research-R-1.md'] }), card('C-1')]);
  const r = await w.pass(1);
  assert.deepEqual(r.started, ['C-1']);
  assert.equal(w.rec.read('card', 'R-C').doc.state, 'ready');
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
  const base = { rec: w.rec, rules: rulesWith({}, startAnswer(w.rec)), account: ACCT, sessions, launch: async (x) => ({ ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 900, pidStart: 's900', pgid: 900, head: 'h'.repeat(40) }), alert: (x) => alerts.push(x) };
  // Pass 1: A's probe throws; B is cancelled and idle.
  let r = await dispatcherPass({ product: 'p1', ...base, now: T0 + MIN, probe: (s) => { if (s.id === a) throw new Error('transcript unreadable'); return idle; },
    stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; }, saveWork: async () => ({ ok: true }) });
  assert.deepEqual(stops, [b], 'B stops although A threw first');
  assert.deepEqual(r.stopping, [[a, 'cancel']], 'a throwing probe is not a safe point');
  assert.ok(r.started.length >= 1, 'starts still run');
  // Pass 2, past the grace: A is hard-stopped; its stop then its save throw and each becomes one alert.
  r = await dispatcherPass({ product: 'p1', ...base, sessions: sessions.filter((s) => s.id === a), now: T0 + 30 * MIN, probe: () => { throw new Error('transcript unreadable'); },
    stopGroup: async () => { throw new Error('EPERM'); }, saveWork: async () => ({ ok: true }) });
  assert.match(alerts.join('\n'), /could not be stopped: EPERM/);
  r = await dispatcherPass({ product: 'p1', ...base, sessions: sessions.filter((s) => s.id === a), now: T0 + 31 * MIN, probe: () => idle,
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

test('L759 (m4): a script session follows the worker safe point, whether it reports role script or no role; only open tools hold its stop', async () => {
  for (const role of ['script', undefined]) {
    const w = world([card('C-1')], { usage: RED });
    w.sessions.push({ id: 'S-1', product: 'p1', kind: 'script', card: 'C-1', ...(role ? { role } : {}) });
    w.probes.set('S-1', busy);
    let r = await w.pass(0);
    assert.deepEqual(r.stopping, [['S-1', 'red']], `${role}: mid-tool waits`);
    // Its turn has not ended (idle.size.turnEnded is false): the Lead's rule would wait; a worker's does not.
    w.probes.set('S-1', idle);
    r = await w.pass(1);
    assert.deepEqual(r.stopped, [['S-1', 'red']], `${role}: no open tool is a safe point`);
  }
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
  for (const m of [1, 2, 3]) await dispatcherPass({ product: 'p1', ...base, now: T0 + m * MIN });
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
    // Built on makeRules, as the real rules are (L148 item 1): a reader that throws makes every value missing through
    // get, num, dec and flag alike, never a get-only stand-in whose num still answers.
    const broken = makeRules({ get rev() { return good.rev; }, may: (a, s) => good.may(a, s), classify: (c) => good.classify(c),
      get: () => { throw new Error('rules file unreadable'); } });
    const r = await w.pass(1, { rules: broken });
    assert.deepEqual(w.calls.stops, [sid]);
    assert.ok(r.notes.some((n) => /nothing but undo cards starts: the rules have no value for .*timeouts\.cancel_grace_min/.test(n)), r.notes.join(' | '));
    assert.equal(w.calls.alerts.filter((a) => /the rules have no value for .*timeouts\.cancel_grace_min/.test(a)).length, 1);
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
  const alert = fakeAlert();
  const alerts = alert.texts;
  const stopped = [];
  const run = (at) => stopPass({ product: 'p1', rec, rules: rulesWith(), now: at, account: ACCT, sessions, probe: () => idle, alert, portDeadlineMs: 50, saveDeadlineMs: 50,
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

// L927: stopPass is given this Dispatcher's product. It acts only on sessions whose own product that is, and hands back
// the Mac-wide list (less what it stopped) for the caps. C-7 is in this Record (cancelled) and in product q9.
test('L927: stopPass stops only its own product\'s sessions, never another\'s C-7, and its running list stays Mac-wide', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled' })]);
  usageInto(rec);
  const sessions = [{ id: 'S-1', product: 'p1', kind: 'editing', card: 'C-7', pgid: 50 }, { id: 'S-9', product: 'q9', kind: 'editing', card: 'C-7', pgid: 51 },
    { id: 'R-1', product: null, kind: 'review', role: 'reviewer', card: 'C-7', pgid: null }];
  const called = [];
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions, probe: (s) => { called.push(`probe ${s.id}`); return idle; }, alert: fakeAlert(),
    stopGroup: async (s) => { called.push(`stop ${s.id}`); return { ok: true, how: 'SIGTERM' }; }, saveWork: async (s) => { called.push(`save ${s.id}`); return { ok: true }; } });
  assert.deepEqual(r.stopped, [['S-1', 'cancel']]);
  assert.deepEqual(called, ['probe S-1', 'stop S-1', 'save S-1'], 'nothing of another product\'s, nor the review runner\'s, is probed, stopped or saved');
  assert.deepEqual(r.running.map((s) => s.id), ['S-9', 'R-1'], 'the caps still see every product');
  assert.equal(rec.read('fact', STOP_FACT('S-9')), null);
  assert.equal(r.missing.some((m) => /q9/.test(m)), false, 'another product\'s rules are not read here');
});

test('L927: dispatcherPass, running its own stop step, passes the product on: another product\'s C-7 is not stopped', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled' })]);
  usageInto(rec);
  const stops = [];
  await dispatcherPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', probe: () => idle, alert: fakeAlert(), launch: async () => ({ ok: false, reason: 'no' }), filesOf: () => [],
    sessions: [{ id: 'S-1', product: 'p1', kind: 'editing', card: 'C-7', pgid: 50 }, { id: 'S-9', product: 'q9', kind: 'editing', card: 'C-7', pgid: 51 }],
    stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; }, saveWork: async () => ({ ok: true }) });
  assert.deepEqual(stops, ['S-1']);
});

// L943 m2: stopPass with no product named (left out, empty, not a string) matches no session, never every one, and says so.
test('L943 m2: stopPass with no product, an empty one or a non-string one stops nothing, and notes why', async () => {
  for (const product of [undefined, '', 7, null]) {
    const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled' })]);
    usageInto(rec);
    const called = []; const log = [];
    const sessions = [{ id: 'S-1', product: 'p1', kind: 'editing', card: 'C-7', pgid: 50 }, { id: 'S-0', kind: 'editing', card: 'C-7', pgid: 52 }];
    const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, ...(product === undefined ? {} : { product }), sessions, probe: (s) => { called.push(`probe ${s.id}`); return idle; },
      alert: fakeAlert(), failureLog: (l) => log.push(l), stopGroup: async (s) => { called.push(`stop ${s.id}`); return { ok: true, how: 'SIGTERM' }; }, saveWork: async () => ({ ok: true }) });
    const what = String(product);
    assert.deepEqual(r.stopped, [], what);
    assert.deepEqual(called, [], `${what}: nothing probed or stopped`);
    assert.equal(rec.read('fact', STOP_FACT('S-1')), null, `${what}: no stop even wanted`);
    assert.deepEqual(r.running.map((s) => s.id), ['S-1', 'S-0'], `${what}: the caps still see every session`);
    assert.ok(r.notes.includes('stops: no product named, so no session is stopped (L943)'), what);
    assert.deepEqual(log, ['stops: no product named, so no session is stopped (L943)'], what);
  }
});

test('r4 MAT-1: the stops are called side by side, not one after another', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-A', { state: 'cancelled' }), card('C-B', { state: 'cancelled' })]);
  usageInto(rec);
  const sessions = [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-A', pgid: 50 }, { id: 'S-B', product: 'p1', kind: 'editing', card: 'C-B', pgid: 51 }];
  const called = new Set();
  // A answers only once B's stop has been called too: one after another, A would time out.
  const waitFor = (id) => new Promise((ok) => { const t = setInterval(() => { if (called.has(id)) { clearInterval(t); ok(); } }, 2); });
  const r = await stopPass({ product: 'p1', rec, rules: rulesWith(), now: T0, account: ACCT, sessions, probe: () => idle, alert: fakeAlert(), portDeadlineMs: 300,
    stopGroup: async (s) => { called.add(s.id); if (s.id === 'S-A') await waitFor('S-B'); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async (s) => { called.add(`save-${s.id}`); if (s.id === 'S-A') await waitFor('save-S-B'); return { ok: true }; } });
  assert.deepEqual(r.stopped.map(([id]) => id).sort(), ['S-A', 'S-B']);
  assert.equal(rec.read('fact', STOP_FACT('S-A')).doc.saved, true, 'the saves ran side by side too');
});

test('r4 MAT-1: a save that never answers is told, and the stopped card still moves', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-A', { state: 'cancelled' })]);
  usageInto(rec);
  const alerts = [];
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [{ id: 'S-A', product: 'p1', kind: 'editing', card: 'C-A', pgid: 50 }], probe: () => idle,
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
    const at = (min) => dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
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
    running: [], launch: async (x) => { launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 4242, pidStart: 's4242', head: 'h'.repeat(40) }; }, filesOf: filesOfCommits, alert: () => {} });
  assert.deepEqual(launched, []);
  assert.deepEqual(r.started, []);
  assert.ok(r.notes.includes('outage: nothing starts'));
  assert.equal(rec.read('card', 'U-1').doc.state, 'ready');
  // Control: the outage over, it starts.
  const cur = rec.read('fact', OUTAGE_FACT);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: OUTAGE_FACT, expectRev: cur.rev, doc: { state: 'ended' } });
  const r2 = await undoStarts({ rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0, bands: { band: 'green', own_building: 'open', prodBlocked: false },
    running: [], launch: async (x) => { launched.push(x.card.id); return { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 4242, pidStart: 's4242', head: 'h'.repeat(40) }; }, filesOf: filesOfCommits, alert: () => {} });
  assert.deepEqual(r2.started, ['U-1']);
});

// L199 (1): the first cutover's caps.editing_per_product is 0. The real undo start still starts Joe's Undo, one per
// product at a time: a second undo card on the product waits (Joe is told why), and starts once the first has ended.
test('L199: at editing cap 0 the undo start starts one undo per product; the second waits its turn', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...undoEntries('U-1'), ...undoEntries('U-2')]);
  const rules = rulesWith({ [K.editingPerProduct]: 0 }, { start_session: { decision: 'allow', reason: 'ok' } });
  const launched = [];
  const ask = (running) => undoStarts({ rec, rules, now: T0, bands: { band: 'green', own_building: 'open', prodBlocked: false }, running,
    launch: async (x) => { launched.push([x.card.id, x.kind]); return { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 4242, pidStart: 's4242', head: 'h'.repeat(40) }; },
    filesOf: filesOfCommits, alert: fakeAlert() });
  const r = await ask([]);
  assert.deepEqual(r.started, ['U-1']);
  assert.deepEqual(launched, [['U-1', 'undo']]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.refused, [['U-2', 'an undo is already running for p1 (one at a time)']]);
  assert.equal(rec.read('card', 'U-2').doc.state, 'ready');
  // U-1 still running in the Record, gone from the running list (the sessions port lost it): U-2 still waits (#117 m2).
  const r1 = await ask([]);
  assert.deepEqual(r1.refused, [['U-2', 'an undo is already running for p1 (one at a time)']]);
  // The first undo really over: its worker handed it in (in_review), so it no longer runs, and the second starts.
  change(rec, 'card', 'U-1', { state: 'in_review' });
  const r2 = await ask([]);
  assert.deepEqual(r2.started, ['U-2']);
});

// #117 audit m2: a launch that never answers leaves its undo card claimed and out of the running list. A second undo
// on the product in the same pass is refused: the one-undo limit reads the Record, not only the list.
test('#117 m2: an undo launch that times out leaves its card claimed; a second undo in the same pass is refused', { timeout: 10_000 }, async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...undoEntries('U-1'), ...undoEntries('U-2')]);
  const launched = [];
  const r = await undoStarts({ rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0,
    bands: { band: 'green', own_building: 'open', prodBlocked: false }, running: [],
    launch: (x) => { launched.push(x.card.id); return new Promise(() => {}); }, filesOf: filesOfCommits, alert: fakeAlert(), portDeadlineMs: 50 });
  assert.deepEqual(launched, ['U-1']);
  assert.deepEqual(r.started, []);
  assert.equal(rec.read('card', 'U-1').doc.state, 'claimed');
  assert.deepEqual(r.refused.find(([id]) => id === 'U-2'), ['U-2', 'an undo is already running for p1 (one at a time)']);
  assert.equal(rec.read('card', 'U-2').doc.state, 'ready');
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
  const run = (min) => dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle,
    launch: (x) => (x.card.id === 'C-A' ? new Promise(() => {}) : { ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 9, pidStart: 's9', pgid: 9, head: 'h'.repeat(40) }),
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
    const at = (min) => dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, portDeadlineMs: 50,
      pauseLead: () => { throw new Error(`Lead not reachable (pid ${++n})`); }, alert: (t) => (down ? bad(t) : sent.push(t)) });
    await at(0);
    await at(24 * 60 + 1);
    assert.deepEqual(sent, []);
    down = false;
    await at(24 * 60 + 2);
    await at(24 * 60 + 3);
    assert.equal(sent.filter((t) => /^usage has been unreadable/.test(t)).length, 1, sent.join(' | '));
    assert.equal(sent.filter((t) => /^card C-1: usage has been unreadable/.test(t)).length, 1, sent.join(' | '));
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
  const run = (min) => stopPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions, probe: () => (atRest ? idle : busy),
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
  const run = (min, ss = sessions) => stopPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: ss, probe: () => idle,
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
    const at = (min) => dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
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
  const at = (min, rules) => dispatcherPass({ product: 'p1', rec: w.rec, rules, now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle,
    launch: async (x) => ({ ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 300 + min, pidStart: `s${min}`, pgid: 300 + min, head: 'h'.repeat(40) }),
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

// L81 sweep: start_session is asked what M10 reads. The real engine answers here, on its sample policy: a Tier-1 card
// with a fresh usage reading and a Tier-2 card both start; the old question (the card alone) and a stale reading do not.
test('L81: the real M10 engine starts a Tier-1 card on a fresh reading and a Tier-2 card; the old subject is refused', async () => {
  let seen = [];
  const real = (s) => { seen.push(s); return realEngine().may('start_session', s); };
  const w = world([card('C-1', { tier: 1 }), card('C-2')]);
  const r = await w.pass(0, { rules: rulesWith({}, { start_session: real }) });
  assert.deepEqual(r.started.sort(), ['C-1', 'C-2'], JSON.stringify(r.refused));
  const one = seen.find((s) => s.card.id === 'C-1');
  assert.equal(one.role, 'worker');
  assert.equal(one.tier, 1);
  assert.equal(one.editing, true);
  assert.equal(one.product, 'p1');
  assert.equal(one.usage.read_at, iso(T0 - MIN));
  assert.equal(seen.find((s) => s.card.id === 'C-2').tier, 2);
  // The subject the pass used to send: the real engine refuses it.
  assert.equal(realEngine().may('start_session', { card: { id: 'C-3' }, product: 'p1' }).decision, 'deny');
  // A reading older than usage.stale_after_min holds Tier 1; Tier 2 needs none.
  seen = [];
  const w2 = world([card('C-1', { tier: 1 }), card('C-2')]);
  w2.setUsage(GREEN, T0 - 6 * H);
  const r2 = await w2.pass(0, { rules: rulesWith({}, { start_session: real }) });
  assert.deepEqual(r2.started, ['C-2']);
  assert.match(r2.refused.find(([id]) => id === 'C-1')[1], /usage reading/);
});

// L138 m4 and m1: the real outbox, the Record's clock ahead of the tick's. The first pass that puts the card on Joe
// for unread usage has its card tell refused by the outbox; usage is readable again by the next pass, so the stretch
// alert asks nothing more, and the card is told from its recorded tell (retellWaits, as the tick runs it), exactly once.
test('L138 m4: a card put on Joe for unread usage is told after usage is back, exactly once, when its first tell was not taken', async () => {
  const parked = { state: 'waiting', product: 'p1', wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } };
  const w = world([['card', 'C-1', { ...parked, tier: 1 }]], { usage: null });
  const sent = [];
  let refuseCardTell = true;
  const tick = async (min) => {
    const now = T0 + min * MIN;
    setClock(w.rec, now + 1500);
    await withAlerts(w.rec, now, (t) => { sent.push(typeof t === 'string' ? t : t.text); return true; }, async (real) => {
      const alert = Object.assign((t, o) => (refuseCardTell && /^card C-1/.test(t) ? false : real(t, o)), { queues: true });
      await dispatcherPass0({ product: 'p1', rec: w.rec, rules: rulesWith(), now, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
        stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert });
      retellWaits({ rec: w.rec, alert, now });
    });
  };
  await tick(0);
  await tick(24 * 60 + 1);
  assert.equal(w.rec.read('card', 'C-1').doc.wait.who, 'joe');
  assert.deepEqual(sent, ['usage has been unreadable for over a day; parked work waits on you'], 'the card tell was not taken');
  assert.equal(w.rec.read('fact', WAIT_TELL_FACT('C-1')).doc.told_since, undefined);
  refuseCardTell = false;
  w.setUsage(GREEN, T0 + (24 * 60 + 2) * MIN);
  await tick(24 * 60 + 2);
  const cardTells = () => sent.filter((t) => /^card C-1: usage has been unreadable/.test(t)).length;
  assert.equal(cardTells(), 1, sent.join(' | '));
  assert.equal(w.rec.read('fact', WAIT_TELL_FACT('C-1')).doc.told_since, w.rec.read('card', 'C-1').doc.wait.since);
  for (const min of [3, 4, 5]) await tick(24 * 60 + min);
  assert.equal(cardTells(), 1, 'told exactly once (P20)');
});

// Audit #153 MAT-1: a since or run_started more than 60 s ahead reads as none (pastTime's rule), so neither cap is held
// at zero by a time that has not come.
test('audit #153 MAT-1: a limit wait whose since is in the future still ends: both caps count from the run\'s start', async () => {
  const DAY = 24 * H;
  const w = world([['fact', LIMIT_FACT('acct-s'), { resets_at: iso(T0 + 10 * DAY), observed_at: iso(T0 + 3 * DAY) }]]);
  parkOnLimit(w.rec, 'S', { ranAt: T0, account: 'acct-s' });
  parkOnLimit(w.rec, 'U', { ranAt: T0, account: 'acct-u' });
  const future = iso(T0 + 365 * DAY);
  garbleSince(w.rec, 'S', future); garbleSince(w.rec, 'U', future);
  await w.pass(24 * 60);
  assert.equal(w.rec.read('card', 'U').doc.wait.who, 'usage');
  await w.pass(24 * 60 + 1);
  assert.deepEqual([w.rec.read('card', 'U').doc.wait.who, w.rec.read('card', 'U').doc.wait.what], ['joe', LIMIT_NO_HIT]);
  await w.pass(LIMIT_RESET_MAX_MS / MIN);
  assert.equal(w.rec.read('card', 'S').doc.wait.who, 'usage');
  await w.pass(LIMIT_RESET_MAX_MS / MIN + 1);
  assert.deepEqual([w.rec.read('card', 'S').doc.wait.who, w.rec.read('card', 'S').doc.wait.what], ['joe', LIMIT_NO_RESET]);
  assert.equal(w.calls.alerts.filter((x) => /card S: it has waited on account acct-s's usage limit since 2\S+Z, longer/.test(x)).length, 1);
});

test('audit #153 MAT-1: a limit wait whose run_started is in the future is one with no run start: it waits on Joe', async () => {
  const w = world();
  // run_started is the Record's own, copied from the claim on the park: a run claimed by a clock a year ahead.
  parkOnLimit(w.rec, 'R', { ranAt: T0 + 365 * 24 * H, parkedAt: T0, account: 'acct-r' });
  assert.equal(w.rec.read('card', 'R').doc.wait.run_started, iso(T0 + 365 * 24 * H));
  await w.pass(1);
  const r = w.rec.read('card', 'R').doc;
  assert.deepEqual([r.wait.who, r.wait.what], ['joe', LIMIT_NO_RUN]);
});

test('audit #153 MAT-1: the stand-in does not keep a stored since in the future either; it keeps one up to 60 s ahead', () => {
  const w = world();
  parkOnLimit(w.rec, 'F', { ranAt: T0, account: 'acct-f' });
  const recheck = (since) => { const r = change(w.rec, 'card', 'F', { wait: { ...w.rec.read('card', 'F').doc.wait, since, next_check: iso(T0 + 2 * MIN) } }); assert.ok(r.ok, r.reason); };
  garbleSince(w.rec, 'F', iso(T0 + 365 * 24 * H));
  recheck(iso(T0));
  assert.equal(w.rec.read('card', 'F').doc.wait.since, iso(T0), 'the future since is not kept: the since sent is stored');
  garbleSince(w.rec, 'F', iso(T0 + MIN));
  recheck(iso(T0));
  assert.equal(w.rec.read('card', 'F').doc.wait.since, iso(T0 + MIN), 'one 60 s ahead of the clock is kept');
});

// L329's two plants for these sites: a since an hour ahead of the pass that should fire the cap (the unreadable one is
// the L285 test above), and a run_started an hour ahead (an unreadable one can't be stored: the Record drops it).
test('audit #153 MAT-1, L329: a since an hour ahead of the pass still lets each cap fire, and a run_started an hour ahead waits on Joe', async () => {
  const DAY = 24 * H;
  const w = world([['fact', LIMIT_FACT('acct-s'), { resets_at: iso(T0 + 10 * DAY), observed_at: iso(T0 + 3 * DAY) }]]);
  parkOnLimit(w.rec, 'S', { ranAt: T0, account: 'acct-s' });
  parkOnLimit(w.rec, 'U', { ranAt: T0, account: 'acct-u' });
  garbleSince(w.rec, 'U', iso(T0 + (24 * 60 + 1) * MIN + H));
  garbleSince(w.rec, 'S', iso(T0 + LIMIT_RESET_MAX_MS + MIN + H));
  await w.pass(24 * 60 + 1);
  assert.deepEqual([w.rec.read('card', 'U').doc.wait.who, w.rec.read('card', 'U').doc.wait.what], ['joe', LIMIT_NO_HIT]);
  await w.pass(LIMIT_RESET_MAX_MS / MIN + 1);
  assert.deepEqual([w.rec.read('card', 'S').doc.wait.who, w.rec.read('card', 'S').doc.wait.what], ['joe', LIMIT_NO_RESET]);
  const r = world();
  parkOnLimit(r.rec, 'R', { ranAt: T0 + 2 * MIN + H, parkedAt: T0, account: 'acct-r' });
  await r.pass(2);
  assert.deepEqual([r.rec.read('card', 'R').doc.wait.who, r.rec.read('card', 'R').doc.wait.what], ['joe', LIMIT_NO_RUN]);
});

// ---- L324: a told time that lies ahead (a clock that went back, a bad write) or can't be read is due, never "told
// recently". Before, each of these sites trusted it: a refused undo with a future told_at was told 0 times in 10 days.
// L339 m3: also just past the 60 s margin, and a number (ISO text is the only readable form). Each is told; 59 s
// ahead is within the margin, reads as now, and stays quiet.
const BAD_TOLD = (now) => [['future', iso(now + 3 * 24 * H)], ['unreadable', 'garbage'], ['61 s ahead', iso(now + 61_000)], ['a number', now - MIN]];
const TOLD_CASES = (now) => [...BAD_TOLD(now).map(([l, v]) => [l, v, true]), ['59 s ahead', iso(now + 59_000), false]];

test('L324: a failed stop whose told time is ahead or unreadable is told again on the next pass', async () => {
  for (const [label, bad, due] of TOLD_CASES(T0 + 2 * MIN)) {
    const f = world([card('C-3')]);
    await f.pass(0);
    const sid = f.sessions[0].id;
    f.setCard('C-3', { state: 'cancelled' });
    const alert = fakeAlert();
    const base = { rec: f.rec, rules: rulesWith({}, startAnswer(f.rec)), account: ACCT, sessions: [...f.sessions], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: false, reason: 'permission' }), saveWork: async () => ({ ok: true }), alert };
    await dispatcherPass({ product: 'p1', ...base, now: T0 + MIN });
    const told = () => alert.texts.filter((x) => /could not be stopped/.test(x)).length;
    assert.equal(told(), 1, label);
    change(f.rec, 'fact', STOP_FACT(sid), { told_at: bad });
    await dispatcherPass({ product: 'p1', ...base, now: T0 + 2 * MIN });
    assert.equal(told(), due ? 2 : 1, label);
  }
});

test('L324: usage unread for over a day, its told time ahead or unreadable, is told again on the next pass', async () => {
  for (const [label, bad, due] of TOLD_CASES(T0 + 25 * H + MIN)) {
    const w = world([], { usage: null });
    const told = () => w.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
    await w.pass(0);
    await w.pass(25 * 60);
    assert.equal(told(), 1, label);
    change(w.rec, 'fact', UNKNOWN_FACT, { told_at: bad });
    await w.pass(25 * 60 + 1);
    assert.equal(told(), due ? 2 : 1, label);
  }
});

test('L324: a failed Lead hand-off, its told time ahead or unreadable, is told again on the next pass', async () => {
  for (const [label, bad, due] of TOLD_CASES(T0 + MIN)) {
    const w = world();
    w.setProduct('p1', 'paused');
    const alert = fakeAlert();
    const alerts = () => alert.texts.filter((a) => /could not be asked to hand off/.test(a));
    const at = (min) => dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, sessions: [], probe: () => idle, launch: async () => ({ ok: false }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), pauseLead: () => { throw new Error('send failed'); }, alert, filesOf: filesOfCommits });
    await at(0);
    assert.equal(alerts().length, 1, label);
    change(w.rec, 'fact', PAUSE_FACT('p1'), { told_at: bad });
    await at(1);
    assert.equal(alerts().length, due ? 2 : 1, label);
  }
});

test('L324: a held undo, its told time ahead or unreadable, is told again on the next pass (was: 0 times in 10 days)', async () => {
  for (const [label, bad, due] of TOLD_CASES(T0 + MIN)) {
    const w = world([...undoEntries('U-1')]);
    const rules = rulesWith({}, { start_session: { decision: 'deny', reason: 'the product waits' } });
    const told = () => w.calls.alerts.filter((a) => /your undo \(card U-1\) is waiting/.test(a)).length;
    await w.pass(0, { rules });
    assert.equal(told(), 1, label);
    change(w.rec, 'fact', UNDO_HELD_FACT('U-1'), { told_at: bad });
    await w.pass(1, { rules });
    assert.equal(told(), due ? 2 : 1, label);
    await w.pass(2, { rules });
    assert.equal(told(), due ? 2 : 1, `${label}: then quiet within the day`);
  }
});

test('L324: missing rule values, their told time ahead or unreadable, are told again on the next pass', async () => {
  for (const [label, bad, due] of TOLD_CASES(T0 + MIN)) {
    const rec = recWith();
    const alert = fakeAlert();
    const alerts = alert.texts;
    const tell = (now) => rulesMissingAlert({ rec, keys: ['a'], alert, now, complete: true });
    await tell(T0);
    assert.equal(alerts.length, 1, label);
    change(rec, 'fact', RULES_MISSING_FACT, { told_at: bad });
    await tell(T0 + MIN);
    assert.equal(alerts.length, due ? 2 : 1, label);
    if (due) assert.match(alerts[1], /no value for a:/);
  }
});

// #157 r2 audit n5 (plant Q11): a held-starts fold that ends while its alert is still queued (never sent) drops it, so
// Joe is not told of a hold that is over.
test('n5: a fold that ends while its alert is still queued drops the queued copy, and the mark stays unset', async () => {
  const w = world([card('C-1', { changed_at: iso(T0 - 2 * 24 * H) })]);
  setClock(w.rec, T0); w.setProduct('p1', 'paused');
  const fact = 'hold-waits-p1-paused';
  // M10's own words for a paused product (the paused fold).
  const m10 = { start_session: ({ product }) => (w.rec.read('product', product)?.doc?.state === 'paused'
    ? { decision: 'deny', reason: 'product is paused: no starts' } : { decision: 'allow', reason: 'ok' }) };
  const at = (now) => { w.setUsage(GREEN, now); return dispatcherPass0({ product: 'p1', rec: w.rec, rules: rulesWith({}, m10), now, account: ACCT, sessions: [], probe: () => idle,
    launch: async (x) => ({ ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 4242, pidStart: 's4242', pgid: 42, head: 'h'.repeat(40) }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert: outbox(w.rec, now) }); };
  await at(T0 + 25 * H);
  assert.equal(isQueued(w.rec, fact), true, 'told: queued, not yet sent');
  setClock(w.rec, T0 + 26 * H); w.setProduct('p1', 'active');
  await at(T0 + 26 * H + MIN);
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'running', 'it started: the fold is over');
  assert.equal(isQueued(w.rec, fact), false, 'the unsent copy is dropped');
  assert.equal(w.rec.read('fact', fact)?.doc?.told_at ?? null, null);
});

// L355 m2: a stop_wanted write is written in two places, the first wanting and the restart of a start time that can't be
// read. Neither answer is read in stopPass: a refusal of either reaches the owner through the tick's watched Record, the
// same way as the rest of stop_record, once a day while it lasts.
test('L355 m2: stop_wanted refused at the first wanting and at a restart: the owner is told, then told again a day on', async () => {
  const stopRefused = (w) => {
    const rec = { ...w.rec, base: w.rec.base ?? w.rec, write: (x) => (x.kind === 'stop_wanted' ? { ok: false, reason: 'busy' } : w.rec.write(x)) };
    return watchWrites(rec);
  };
  const told = fakeAlert();
  const passAndTell = async (w, min) => {
    const watched = stopRefused(w);
    await w.pass(min, { rec: watched.rec });
    await withAlerts(w.rec, T0 + min * MIN, told, (alert) => tellRefused({ rec: w.rec, alert, now: T0 + min * MIN, refused: watched.refused, taken: watched.taken, ran: () => true }));
    return watched;
  };
  // The first wanting.
  let w = world([card('C-1')]);
  await w.pass(0);
  let sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  let seen = await passAndTell(w, 1);
  assert.deepEqual(seen.refused.get('stop_record').map((x) => [x.kind, x.id]), [['stop_wanted', STOP_FACT(sid)]]);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)), null, 'nothing stored');
  assert.equal(told.texts.length, 1);
  assert.match(told.texts[0], new RegExp(`^the Dispatcher: a session stop could not be recorded: ${STOP_FACT(sid)} \\(busy\\)`));
  // Quiet the same day, told again a day on.
  await passAndTell(w, 2);
  assert.equal(told.texts.length, 1, 'once for the day');
  await passAndTell(w, 25 * 60);
  assert.equal(told.texts.length, 2, 'again a day on');
  // The restart of a start time that can't be read.
  w = world([card('C-1')]);
  await w.pass(0);
  sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  await w.pass(1);
  change(w.rec, 'fact', STOP_FACT(sid), { since: 'garbage' });
  const was = w.rec.read('fact', STOP_FACT(sid)).doc;
  told.texts.length = 0;
  seen = await passAndTell(w, 2);
  assert.deepEqual(seen.refused.get('stop_record').map((x) => [x.kind, x.id]), [['stop_wanted', STOP_FACT(sid)]]);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.since, was.since, 'the stored time is unchanged: the refusal is what the owner reads');
  assert.equal(told.texts.length, 1);
  assert.match(told.texts[0], /a session stop could not be recorded/);
});

test('L324: a wanted stop whose since is ahead or unreadable is restarted from now and forced one grace later, not waited out for ever', async () => {
  for (const [label, bad] of [['future', iso(T0 + 30 * 24 * H)], ['unreadable', 'garbage'], ['61 s ahead', iso(T0 + 2 * MIN + 61_000)], ['a number', T0]]) {
    const w = world([card('C-1')]);
    await w.pass(0);
    const sid = w.sessions[0].id;
    w.setCard('C-1', { state: 'cancelled' });
    w.probes.set(sid, busy);
    await w.pass(1);
    change(w.rec, 'fact', STOP_FACT(sid), { since: bad });
    await w.pass(2);
    assert.equal(w.calls.stops.length, 0, `${label}: not stopped at once over a bad field`);
    assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.since, iso(T0 + 2 * MIN), `${label}: restarted from now`);
    await w.pass(4);
    assert.deepEqual(w.calls.stops, [sid], `${label}: forced one grace later`);
    assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.hard, true);
    // Cosmetic (L339): the note says the count is from a restart, so it does not understate the wait.
    assert.match(w.rec.read('fact', `stop-note-${sid}`).doc.text, /without a safe point after 2 min counted from a restart \(its start time could not be read, so it waited longer\) \(cancel\)/);
  }
});

test('L339 m3: a wanted stop whose since is 59 s ahead is within the margin: kept as written, not restarted', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.setCard('C-1', { state: 'cancelled' });
  w.probes.set(sid, busy);
  await w.pass(1);
  const near = iso(T0 + 2 * MIN + 59_000);
  change(w.rec, 'fact', STOP_FACT(sid), { since: near });
  await w.pass(2);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.since, near);
  assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.restarted, undefined);
});

test('L324: an unknown-usage start that is ahead or unreadable counts as over a day: told at once', async () => {
  for (const [label, bad, due] of [['future', iso(T0 + 30 * 24 * H), true], ['unreadable', 'garbage', true], ['61 s ahead', iso(T0 + MIN + 61_000), true],
    ['a number', T0, true], ['59 s ahead (within the margin: now, not over a day)', iso(T0 + MIN + 59_000), false]]) {
    const w = world([], { usage: null });
    const told = () => w.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
    await w.pass(0);
    assert.equal(told(), 0, label);
    change(w.rec, 'fact', BAND_FACT, { unknown_since: bad });
    await w.pass(1);
    assert.equal(told(), due ? 1 : 0, label);
  }
});

test('L350: a new unknown-usage stretch whose start is short or corrupt is told at once, not read as the old stretch', async () => {
  for (const bad of ['2', '2026', T0 + 1]) {
    const w = world([], { usage: null });
    const told = () => w.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
    await w.pass(0);
    await w.pass(25 * 60);
    assert.equal(told(), 1, `${bad}: the first stretch told`);
    change(w.rec, 'fact', BAND_FACT, { unknown_since: bad });
    await w.pass(25 * 60 + 1);
    assert.equal(told(), 2, `${bad}: a new stretch, told at once`);
    await w.pass(25 * 60 + 2);
    assert.equal(told(), 2, `${bad}: then quiet`);
  }
});

test('L355 m6: an unknown-usage stretch recorded with no start is told, not read as just started every pass', async () => {
  // No start: counted from when the band was decided (the first pass), so told once that is over a day old.
  let w = world([], { usage: null });
  const told = (x) => x.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
  await w.pass(0);
  change(w.rec, 'fact', BAND_FACT, { unknown_since: null });
  await w.pass(60);
  assert.equal(told(w), 0, 'within the day of its decided time');
  await w.pass(25 * 60);
  assert.equal(told(w), 1, 'counted from the decided time: told');
  await w.pass(25 * 60 + 1);
  assert.equal(told(w), 1, 'then quiet');
  // No start and no decided time: counts as old enough, told at the next pass, quiet, then again a day on.
  w = world([], { usage: null });
  await w.pass(0);
  change(w.rec, 'fact', BAND_FACT, { unknown_since: '', decided_at: null });
  await w.pass(1);
  assert.equal(told(w), 1, 'neither time: told at once');
  await w.pass(2);
  assert.equal(told(w), 1, 'then quiet');
  await w.pass(25 * 60);
  assert.equal(told(w), 2, 'again a day on');
});

test('L339 m2: an unknown-usage start stored as a number is told once, then daily, not every pass', async () => {
  const w = world([], { usage: null });
  const told = () => w.calls.alerts.filter((a) => /usage has been unreadable for over a day/.test(a)).length;
  await w.pass(0);
  change(w.rec, 'fact', BAND_FACT, { unknown_since: T0 });
  for (let m = 1; m <= 4; m += 1) await w.pass(m);
  assert.equal(told(), 1, 'once in 4 passes (was: every pass)');
  await w.pass(1 + 24 * 60);
  assert.equal(told(), 2, 'again a day on');
});

// L386 m1: all seven of dispatcherPass's asks go through askJoe, so none loses a refused copy from the pass's notes.
const DAY_MIN = 24 * 60;
const ASK_SITES = [
  ['usage_unknown', () => world([['card', 'K', { state: 'waiting', product: 'p1', tier: 1, wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } }]], { usage: null }), DAY_MIN + 1, (w) => w.pass(0)],
  [LIMIT_NO_ACCOUNT, () => world(), 1, (w) => parkOnLimit(w.rec, 'K', {})],
  [LIMIT_NO_RUN, () => world(), 1, (w) => parkOnLimit(w.rec, 'K', { ranAt: T0 + 365 * 24 * H, parkedAt: T0, account: 'acct-k' })],
  [LIMIT_NO_HIT, () => world(), DAY_MIN + 1, (w) => parkOnLimit(w.rec, 'K', { account: 'acct-k' })],
  [`${LIMIT_NO_RESET} (no reset time)`, () => world([['fact', LIMIT_FACT('acct-k'), { observed_at: iso(T0 + MIN) }]]), 2, (w) => parkOnLimit(w.rec, 'K', { account: 'acct-k' })],
  [`${LIMIT_NO_RESET} (past the cap)`, () => world([['fact', LIMIT_FACT('acct-k'), { resets_at: iso(T0 + 10 * DAY_MIN * MIN), observed_at: iso(T0 + 3 * DAY_MIN * MIN) }]]), LIMIT_RESET_MAX_MS / MIN + 1, (w) => parkOnLimit(w.rec, 'K', { account: 'acct-k' })],
  ['limit_reset', () => world([['fact', LIMIT_FACT('acct-k'), { resets_at: iso(T0 + 5 * MIN), observed_at: iso(T0 + MIN) }]]), 6, (w) => parkOnLimit(w.rec, 'K', { account: 'acct-k', card: { tier: 1 } })],
];
for (const [name, make, min, park] of ASK_SITES) {
  test(`L343, L386 m1: ${name} puts a refused copy of its since in the pass's notes and the text the owner reads`, async () => {
    const w = make();
    await park(w);
    const rec = { ...w.rec, base: w.rec.base ?? w.rec, write: (x) => (x.doc?.wait_since ? { ok: false, reason: 'busy' } : w.rec.write(x)) };
    const out = await w.pass(min, { rec });
    assert.equal(w.rec.read('card', 'K').doc.wait?.who, 'joe', name);
    assert.ok(out.notes.some((n) => /^card K: this card's tell could not be kept with its wait \(busy\)/.test(n)), JSON.stringify(out.notes));
    assert.ok(w.calls.alerts.some((x) => /^card K: .*could not be kept with its wait \(busy\)/.test(x)), JSON.stringify(w.calls.alerts));
  });
}

test('L343: a limit wait put on the owner whose tell could not keep its since says so in the notes and in the text they read', async () => {
  const w = world();
  parkOnLimit(w.rec, 'R', { ranAt: T0 + 365 * 24 * H, parkedAt: T0, account: 'acct-r' });
  const rec = { ...w.rec, base: w.rec.base ?? w.rec, write: (x) => (x.doc?.wait_since ? { ok: false, reason: 'busy' } : w.rec.write(x)) };
  const out = await w.pass(1, { rec });
  assert.deepEqual(w.rec.read('card', 'R').doc.wait.what, LIMIT_NO_RUN);
  assert.ok(out.notes.some((n) => /^card R: this card's tell could not be kept with its wait \(busy\)/.test(n)), JSON.stringify(out.notes));
  assert.ok(w.calls.alerts.some((x) => /card R: .*could not be kept with its wait \(busy\)/.test(x)), JSON.stringify(w.calls.alerts));
});

// L354: at each clear site the queued alert leaves before the clear is written, by the order the writes really ran in;
// a drop that fails is told, and the clear waits for the next pass where there is one.
test('L354 stop dropped: the queued copy leaves first; a refused drop is in the notes and the stop still drops', async () => {
  for (const refuseDrop of [false, true]) {
    const w = world([card('C-1')]);
    await w.pass(0);
    const sid = w.sessions[0].id;
    w.probes.set(sid, busy);
    w.setUsage(RED, T0 + MIN);
    await w.pass(1);
    w.setUsage(GREEN, T0 + 2 * MIN);
    queueFor(w.rec, STOP_FACT(sid), 'told_at', iso(T0), T0);
    const log = [];
    const r = await w.pass(2, { rec: writeLog(w.rec, log, { refuseDrop }) });
    assertDropFirst(log, `stop_dropped:${STOP_FACT(sid)}`);
    assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'dropped');
    assert.equal(r.notes.some((n) => /could not be dropped.*cleared anyway/.test(n)), refuseDrop, r.notes.join(' | '));
  }
});

test('L354 stop done: the queued copy leaves first; a refused drop is in the notes and the stop still stands', async () => {
  for (const refuseDrop of [false, true]) {
    const w = world([card('C-1')]);
    await w.pass(0);
    const sid = w.sessions[0].id;
    w.setCard('C-1', { state: 'cancelled' });
    queueFor(w.rec, STOP_FACT(sid), 'told_at', iso(T0), T0);
    const log = [];
    const r = await w.pass(1, { rec: writeLog(w.rec, log, { refuseDrop }) });
    assertDropFirst(log, `stop_done:${STOP_FACT(sid)}`);
    assert.equal(w.rec.read('fact', STOP_FACT(sid)).doc.state, 'done');
    assert.equal(r.notes.some((n) => /could not be dropped/.test(n)), refuseDrop, r.notes.join(' | '));
  }
});

test('L354 pause cleared: the queued copy leaves first; a refused drop holds the clear for the next pass, and says so', async () => {
  const failed = async () => {
    const w = world([]);
    w.setProduct('p1', 'paused');
    await w.pass(0, { pauseLead: () => { throw new Error('Lead not reachable'); } });
    w.setProduct('p1', 'active');
    queueFor(w.rec, PAUSE_FACT('p1'), 'told_at', iso(T0), T0);
    return w;
  };
  const a = await failed();
  const log = [];
  await a.pass(1, { rec: writeLog(a.rec, log) });
  assertDropFirst(log, `pause_cleared:${PAUSE_FACT('p1')}`);
  assert.equal(a.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'cleared');
  const b = await failed();
  const r = await b.pass(1, { rec: writeLog(b.rec, [], { refuseDrop: true }) });
  assert.equal(b.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'failed', 'held');
  assert.ok(r.notes.some((n) => /could not be dropped.*next pass/.test(n)), r.notes.join(' | '));
  await b.pass(2);
  assert.equal(b.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'cleared', 'the next pass clears it');
});

test('L354 pause asked: the queued copy leaves first; a refused drop is in the notes and the ask is still recorded', async () => {
  for (const refuseDrop of [false, true]) {
    const w = world([]);
    w.setProduct('p1', 'paused');
    await w.pass(0, { pauseLead: () => { throw new Error('Lead not reachable'); } });
    queueFor(w.rec, PAUSE_FACT('p1'), 'told_at', iso(T0), T0);
    const log = [];
    const r = await w.pass(1, { rec: writeLog(w.rec, log, { refuseDrop }) });
    assertDropFirst(log, `pause_lead:${PAUSE_FACT('p1')}`);
    assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'asked');
    assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.reason, undefined, 'the failure\'s reason does not outlive it');
    // A drop that worked: the old failure's told fields left with it. One refused: its alert can still go out and mark.
    if (!refuseDrop) assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.told_at, undefined);
    assert.equal(r.notes.some((n) => /could not be dropped/.test(n)), refuseDrop, r.notes.join(' | '));
  }
});

test('L449: a refused drop at pause asked reaches the log and one alert, and is not told again within a day', async () => {
  const w = world([]);
  w.setProduct('p1', 'paused');
  await w.pass(0, { pauseLead: () => { throw new Error('Lead not reachable'); } });
  const rec = writeLog(w.rec, [], { refuseDrop: true });
  const logged = [];
  const dropTold = () => w.calls.alerts.filter((t) => /could not be dropped/.test(typeof t === 'string' ? t : t.text));
  const run = async (min) => {
    const pf = w.rec.read('fact', PAUSE_FACT('p1'));
    assert.equal(w.rec.write({ actor: 'dispatcher', entity: 'fact', id: PAUSE_FACT('p1'), expectRev: pf.rev, doc: { ...pf.doc, state: 'failed', at: iso(T0 + min * MIN) }, kind: 'pause_lead_failed' }).ok, true);
    queueFor(w.rec, PAUSE_FACT('p1'), 'told_at', iso(T0), T0);
    await w.pass(min, { rec, failureLog: (l) => logged.push(l) });
  };
  await run(1);
  assert.equal(logged.filter((l) => /could not be dropped/.test(l)).length, 1, logged.join(' | '));
  assert.equal(dropTold().length, 1);
  await run(60);
  await run(23 * 60);
  assert.equal(logged.filter((l) => /could not be dropped/.test(l)).length, 3, 'the log hears every one');
  assert.equal(dropTold().length, 1);
  await run(25 * 60);
  assert.equal(dropTold().length, 2);
});

test('L449 m3: a told mark landing on a fact whose read had no told fields does not outlive pause cleared', async () => {
  const w = world([]);
  w.setProduct('p1', 'paused');
  await w.pass(0, { pauseLead: () => { throw new Error('Lead not reachable'); } });
  change(w.rec, 'fact', PAUSE_FACT('p1'), { told_at: undefined, told_cause: undefined });
  w.setProduct('p1', 'active');
  await w.pass(1, { rec: lateMark(w.rec, 'pause_cleared', PAUSE_FACT('p1'), { told_at: iso(T0), told_cause: 'c' }) });
  const doc = w.rec.read('fact', PAUSE_FACT('p1')).doc;
  assert.deepEqual([doc.state, doc.told_at ?? null, doc.told_cause ?? null], ['cleared', null, null], JSON.stringify(doc));
});

test('L449 m1, m2: a fold clear with nothing to clear writes nothing; one with a copy queued writes, so a mark on its way conflicts', async () => {
  const fact = 'hold-waits-p1-paused';
  const w = world([]);
  const log = [];
  await w.pass(0, { rec: writeLog(w.rec, log) });
  await w.pass(1, { rec: writeLog(w.rec, log) });
  assert.deepEqual(log.filter((l) => l.startsWith('hold_cleared:')), []);
  queueFor(w.rec, fact, 'told_at', iso(T0), T0);
  await w.pass(2, { rec: writeLog(w.rec, log) });
  assertDropFirst(log, `hold_cleared:${fact}`);
  assert.equal(w.rec.read('fact', fact).doc.told_at, null);
});

test('L449 m1, m2: a refused-write clear with nothing to clear writes nothing; one with a copy queued writes, even with no fact yet', () => {
  const fact = REFUSED_FACT('park');
  const w = world([]);
  const log = [];
  const run = (min) => tellRefused({ rec: writeLog(w.rec, log), alert: fakeAlert(), now: T0 + min * MIN, refused: new Map(), ran: () => true });
  run(0);
  run(1);
  assert.deepEqual(log.filter((l) => l.endsWith(fact)), []);
  queueFor(w.rec, fact, 'told_at', iso(T0), T0);
  run(2);
  assertDropFirst(log, `write_refused_cleared:${fact}`);
  assert.equal(w.rec.read('fact', fact).doc.told_at, null);
});

test('L354 undo started: the queued copy leaves first; a refused drop is in the notes and the hold still clears', async () => {
  for (const refuseDrop of [false, true]) {
    const w = world([...undoEntries('U-1')]);
    await w.pass(0, { rules: rulesWith({}, { start_session: { decision: 'deny', reason: 'the product is paused' } }) });
    queueFor(w.rec, UNDO_HELD_FACT('U-1'), 'told_at', iso(T0), T0);
    const log = [];
    const r = await w.pass(1, { rec: writeLog(w.rec, log, { refuseDrop }) });
    assertDropFirst(log, `undo_started:${UNDO_HELD_FACT('U-1')}`);
    assert.equal(w.rec.read('fact', UNDO_HELD_FACT('U-1')).doc.reason, null);
    assert.equal(r.notes.some((n) => /could not be dropped/.test(n)), refuseDrop, r.notes.join(' | '));
  }
});

test('L354 fold over: the queued copy leaves first, and a late mark is cleared; a refused drop holds the clear and says so', async () => {
  const over = async (refuseDrop) => {
    const w = world([card('C-1', { changed_at: iso(T0 - 2 * 24 * H) })]);
    setClock(w.rec, T0); w.setProduct('p1', 'paused');
    const fact = 'hold-waits-p1-paused';
    const m10 = { start_session: ({ product }) => (w.rec.read('product', product)?.doc?.state === 'paused'
      ? { decision: 'deny', reason: 'product is paused: no starts' } : { decision: 'allow', reason: 'ok' }) };
    const at = (rec, now) => { w.setUsage(GREEN, now); return dispatcherPass0({ product: 'p1', rec, rules: rulesWith({}, m10), now, account: ACCT, sessions: [], probe: () => idle,
      launch: async (x) => ({ ok: true, sessionId: x.sessionId, outbox: `/outbox-root/${x.product}/worker/${x.sessionId}`, pid: 4242, pidStart: 's4242', pgid: 42, head: 'h'.repeat(40) }),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert: outbox(w.rec, now) }); };
    await at(w.rec, T0 + 25 * H);
    assert.equal(isQueued(w.rec, fact), true);
    assert.equal(w.rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: 0, doc: { told_at: iso(T0) } }).ok, true);
    setClock(w.rec, T0 + 26 * H); w.setProduct('p1', 'active');
    const log = [];
    const r = await at(writeLog(w.rec, log, { refuseDrop }), T0 + 26 * H + MIN);
    return { w, fact, log, r };
  };
  const a = await over(false);
  assertDropFirst(a.log, `hold_cleared:${a.fact}`);
  assert.equal(a.w.rec.read('fact', a.fact).doc.told_at, null);
  const b = await over(true);
  assert.equal(b.log.includes(`hold_cleared:${b.fact}`), false, 'held');
  assert.ok(b.r.notes.some((n) => /could not be dropped.*next pass/.test(n)), b.r.notes.join(' | '));
});

test('L354 item 4: a late mark survives a write that only changes other fields; the same mark does not survive a clear', async () => {
  const w = world([card('C-1')]);
  await w.pass(0);
  const sid = w.sessions[0].id;
  w.probes.set(sid, busy);
  w.setUsage(RED, T0 + MIN);
  await w.pass(1);
  const f = STOP_FACT(sid);
  // A mark lands after the pass has read the stop, while its since is rewritten.
  const before = w.rec.read('fact', f);
  w.rec.write({ actor: 'dispatcher', entity: 'fact', id: f, expectRev: before.rev, doc: { ...before.doc, since: 'unreadable' } });
  let fired = false;
  const late = { ...w.rec, read: (e, id) => {
    const got = w.rec.read(e, id);
    if (!fired && e === 'fact' && id === f && got?.doc?.since === 'unreadable') {
      fired = true;
      return got;
    }
    if (fired === true && e === 'fact' && id === f) { fired = 'done'; change(w.rec, 'fact', f, { told_at: iso(T0) }); return w.rec.read(e, id); }
    return got;
  } };
  await w.pass(2, { rec: late });
  assert.equal(fired, 'done');
  assert.equal(w.rec.read('fact', f).doc.told_at, iso(T0), 'the rewrite of since kept the mark');
  assert.notEqual(w.rec.read('fact', f).doc.since, 'unreadable');
  w.setUsage(GREEN, T0 + 3 * MIN);
  await w.pass(3);
  assert.equal(w.rec.read('fact', f).doc.state, 'dropped');
});

test('L354 item 3: a mark landing as a clear is written does not outlive the clear', async () => {
  const told = { told_at: iso(T0), told_cause: 'c' };
  const check = async (w, fact, kind, min) => {
    await w.pass(min, { rec: lateMark(w.rec, kind, fact, told) });
    const doc = w.rec.read('fact', fact).doc;
    assert.equal(doc.told_at ?? null, null, `${kind}: ${JSON.stringify(doc)}`);
  };
  const parked = async () => {
    const w = world([card('C-1')]);
    await w.pass(0);
    const sid = w.sessions[0].id;
    w.probes.set(sid, busy);
    w.setUsage(RED, T0 + MIN);
    await w.pass(1);
    return { w, sid };
  };
  const a = await parked();
  a.w.setUsage(GREEN, T0 + 2 * MIN);
  await check(a.w, STOP_FACT(a.sid), 'stop_dropped', 2);
  const b = world([card('C-1')]);
  await b.pass(0);
  const sid = b.sessions[0].id;
  b.setCard('C-1', { state: 'cancelled' });
  await check(b, STOP_FACT(sid), 'stop_done', 1);
  const down = async () => {
    const w = world([]);
    w.setProduct('p1', 'paused');
    await w.pass(0, { pauseLead: () => { throw new Error('Lead not reachable'); }, alert: () => false });
    return w;
  };
  const c = await down();
  c.setProduct('p1', 'active');
  await check(c, PAUSE_FACT('p1'), 'pause_cleared', 1);
  await check(await down(), PAUSE_FACT('p1'), 'pause_lead', 1);
  const u = world([...undoEntries('U-1')]);
  await u.pass(0, { rules: rulesWith({}, { start_session: { decision: 'deny', reason: 'the product is paused' } }), alert: () => false });
  await check(u, UNDO_HELD_FACT('U-1'), 'undo_started', 1);
});

// L744 1: a launch answer marked timed out, in any words, is late: the card stays claimed and is never given back.
test('L744 1: a launch that answers timed out in its own words keeps the card claimed, never back to ready', { timeout: 10_000 }, async () => {
  const w = world([card('C-A')]);
  const alert = fakeAlert();
  const r = await dispatcherPass({ product: 'p1', rec: w.rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), now: T0, account: ACCT, sessions: [], probe: () => idle,
    launch: async () => ({ ok: false, timedOut: true, reason: 'the launcher gave up waiting for claude' }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), filesOf: filesOfCommits, alert, portDeadlineMs: 5_000 });
  assert.equal(w.rec.read('card', 'C-A').doc.state, 'claimed');
  assert.equal(w.rec.diary().filter((l) => l.kind === 'claim_release' && l.id === 'C-A').length, 0, 'not given back');
  assert.ok(r.refused.some(([id, why]) => id === 'C-A' && /launcher: the launcher gave up waiting/.test(why)), JSON.stringify(r.refused));
  assert.equal(alert.texts.filter((a) => /card C-A: the launcher the launcher gave up waiting for claude; the card stays claimed/.test(a)).length, 1, alert.texts.join(' | '));
});

// L744 2: what pauseLead answers is read: ok:false is a failure, told once like a throw, and not counted as asked.
test('L744 2: a pauseLead that answers ok:false is told once and not counted as asked; a later plain answer is', async () => {
  const w = world([]);
  w.setProduct('p1', 'paused');
  const no = () => ({ ok: false, reason: 'the Lead session is gone' });
  await w.pass(0, { pauseLead: no });
  assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'failed');
  await w.pass(1, { pauseLead: no });
  assert.equal(w.calls.alerts.filter((a) => /the Lead of p1 could not be asked to hand off: the Lead session is gone/.test(a)).length, 1, w.calls.alerts.join(' | '));
  await w.pass(2, { pauseLead: async () => ({ ok: false }) });
  assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'failed', 'ok:false with no reason is a failure too');
  await w.pass(3);
  assert.equal(w.rec.read('fact', PAUSE_FACT('p1')).doc.state, 'asked');
});

test('L767: a script card\'s outbox is <root>/<product>/script/<id>; the worker folder is refused for it, as the script folder is for an editing card', async () => {
  const ok = world([card('C-2', { kind: 'script' })]);
  ok.refuseLaunch((x) => ({ ok: true, outbox: `/outbox-root/${x.product}/script/${x.sessionId}` }));
  assert.equal((await ok.pass()).started.length, 1, 'a script card under its own folder starts');
  const wrong = world([card('C-2', { kind: 'script' })]);
  const r = await wrong.pass();
  assert.deepEqual(r.started, []); assert.match(r.refused.map(([, x]) => x).join('\n'), /is not a script outbox/);
  const editing = world([card('C-2')]);
  editing.refuseLaunch((x) => ({ ok: true, outbox: `/outbox-root/${x.product}/script/${x.sessionId}` }));
  assert.match((await editing.pass()).refused.map(([, x]) => x).join('\n'), /is not a worker outbox/);
});

// L946, L947: the stop step asks the review runner to end a reviewer or auditor (product null) only for a card of this
// Record at the very head it reviews, cancelled or ended; by card, role and head, never a request id.
const HD = 'c'.repeat(40);
const OLD_HD = 'd'.repeat(40);
const rv = (id, role, cardId, head = HD) => ({ id, product: null, kind: role === 'auditor' ? 'audit' : 'review', role, card: cardId, head, lead: null, pgid: null, bundle_files: [] });

test('L946: a reviewer or auditor of this Record\'s cancelled or ended card at its head is asked to stop by card, role and head; nothing else is', async () => {
  const rec = recWith([['product', 'p1', { state: 'paused' }], card('C-7', { state: 'cancelled', head: HD }), card('C-8', { state: 'failed', head: HD }),
    card('C-9', { state: 'in_review', head: HD }), card('C-6', { state: 'cancelled', head: HD, product: 'q9' }), card('C-5', { state: 'waiting', head: HD, wait: { who: 'joe', what: 'x', since: iso(T0) } })]);
  usageInto(rec);
  const sessions = [rv('R-1', 'reviewer', 'C-7'), rv('A-1', 'auditor', 'C-7'), rv('R-2', 'reviewer', 'C-8'), rv('R-old', 'reviewer', 'C-7', OLD_HD),
    rv('R-live', 'reviewer', 'C-9'), rv('R-q9', 'reviewer', 'C-6'), rv('R-none', 'reviewer', 'C-404'), rv('R-joe', 'reviewer', 'C-5'),
    { ...rv('R-nohead', 'reviewer', 'C-7'), head: undefined }, { id: 'E-1', product: null, kind: 'editing', card: 'C-7', head: HD }];
  const asked = [];
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions, probe: () => idle, alert: fakeAlert(),
    stopGroup: async () => { throw new Error('no worker here'); }, saveWork: async () => ({ ok: true }), stopReview: (x) => { asked.push(x); return { ok: true, name: 'stop-1.json' }; } });
  assert.deepEqual(asked, [{ card: 'C-7', role: 'reviewer', head: HD, reason: 'cancel' }, { card: 'C-7', role: 'auditor', head: HD, reason: 'cancel' }, { card: 'C-8', role: 'reviewer', head: HD, reason: 'card_final' }],
    'exactly the three, each by card, role and head: not an older head, a live card (its product paused: no matter), another product\'s card, a card not here, one waiting on Joe, a row with no head, nor a non-review row');
  assert.deepEqual(r.reviewStops, [['R-1', 'cancel', 'asked'], ['A-1', 'cancel', 'asked'], ['R-2', 'card_ended', 'asked']]);
  assert.deepEqual(r.stopped, [], 'the review runner\'s sessions are not stopGroup\'s');
  const f = rec.read('fact', REVIEW_STOP_FACT('R-1')).doc;
  assert.equal(f.state, 'asked');
  assert.deepEqual([f.card, f.role, f.head, f.reason, f.asked_at, f.tries], ['C-7', 'reviewer', HD, 'cancel', iso(T0), 1]);
  assert.equal(Object.keys(f).some((k) => /request/.test(k)), false, 'no request id kept (L947)');
});

test('L946: a stop is asked again only after REVIEW_STOP_AGAIN_MS while listed, and marked done once the session is gone', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  let asked = 0;
  const run = (at, sessions) => stopPass({ rec, rules: rulesWith(), now: at, account: ACCT, product: 'p1', sessions, probe: () => idle, alert: fakeAlert(),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => { asked += 1; return { ok: true }; } });
  assert.equal(REVIEW_STOP_AGAIN_MS, 5 * MIN);
  await run(T0, [rv('R-1', 'reviewer', 'C-7')]);
  const r1 = await run(T0 + 4 * MIN, [rv('R-1', 'reviewer', 'C-7')]);
  assert.equal(asked, 1, 'not again within 5 minutes');
  assert.deepEqual(r1.reviewStops, [['R-1', 'cancel', 'waiting']]);
  await run(T0 + 5 * MIN, [rv('R-1', 'reviewer', 'C-7')]);
  assert.equal(asked, 2, 'again at 5 minutes');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.tries, 2);
  await run(T0 + 6 * MIN, []);
  assert.equal(asked, 2);
  const f = rec.read('fact', REVIEW_STOP_FACT('R-1')).doc;
  assert.deepEqual([f.state, f.done_at], ['done', iso(T0 + 6 * MIN)]);
  await run(T0 + 20 * MIN, []);
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.done_at, iso(T0 + 6 * MIN), 'done stays done');
});

test('L946: a stop that can\'t be asked is said each pass, told to Joe once a day, tried again next pass, and holds no worker stop', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD }), card('C-1', { state: 'cancelled' })]);
  usageInto(rec);
  const alert = fakeAlert({ answer: true });
  const log = [];
  let asked = 0;
  const stopped = [];
  const run = (at, answer) => stopPass({ rec, rules: rulesWith(), now: at, account: ACCT, product: 'p1', sessions: [{ id: 'S-1', product: 'p1', kind: 'editing', card: 'C-1', pgid: 50 }, rv('R-1', 'reviewer', 'C-7')],
    probe: () => idle, alert, failureLog: (l) => log.push(l), stopGroup: async (s) => { stopped.push(s.id); return { ok: true, how: 'SIGTERM' }; }, saveWork: async () => ({ ok: true }),
    stopReview: () => { asked += 1; return answer; } });
  const r = await run(T0, { ok: false, reason: 'the folder is full' });
  assert.deepEqual(stopped, ['S-1'], 'the worker stop still runs');
  assert.deepEqual(r.reviewStops, [['R-1', 'cancel', 'failed']]);
  assert.ok(r.notes.some((n) => /reviewer R-1 for cancelled card C-7 could not be asked to stop: the folder is full/.test(n)), r.notes.join(' | '));
  assert.equal(log.filter((l) => /R-1/.test(l)).length, 1);
  assert.equal(alert.texts.filter((t) => /^a review session could not be asked to stop: the reviewer R-1 for cancelled card C-7 \(the folder is full\)$/.test(t)).length, 1, alert.texts.join(' | '));
  await run(T0 + MIN, { ok: false, reason: 'the folder is full' });
  assert.equal(asked, 2, 'tried again on the next pass, not 5 minutes on');
  assert.equal(log.filter((l) => /R-1/.test(l)).length, 2, 'said each pass');
  assert.equal(alert.texts.filter((t) => /R-1/.test(t)).length, 1, 'told once a day');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'failing');
  assert.ok(rec.read('fact', REVIEW_STOP_TELL_FACT).doc.told_at);
  await run(T0 + 2 * MIN, { ok: true });
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'asked');
  assert.ok(rec.read('fact', REVIEW_STOP_TELL_FACT).doc.told_at, 'told_at stays once none fails (L962 m1)');
  // A throw or no port at all is a failure too, never an ask.
  const rec2 = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec2);
  for (const stopReview of [() => { throw new Error('boom'); }, undefined]) {
    const r2 = await stopPass({ rec: rec2, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('R-9', 'reviewer', 'C-7')], probe: () => idle, alert: fakeAlert(),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview });
    assert.deepEqual(r2.reviewStops, [['R-9', 'cancel', 'failed']], String(stopReview));
    assert.ok(r2.notes.some((n) => (stopReview ? /boom/ : /no stopReview port is wired/).test(n)), r2.notes.join(' | '));
  }
});

// The card names no product, so only the "no product named" gate keeps its reviewer running.
test('L946: with no product named, no reviewer is asked to stop either (L943 m2); dispatcherPass hands its stopReview on', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD, product: null })]);
  usageInto(rec);
  const asked = [];
  const stopReview = (x) => { asked.push(x); return { ok: true }; };
  for (const product of [undefined, '']) {
    const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, ...(product === undefined ? {} : { product }), sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle,
      alert: fakeAlert(), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview });
    assert.deepEqual(r.reviewStops, []);
  }
  assert.deepEqual(asked, []);
  await dispatcherPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle, alert: fakeAlert(),
    launch: async () => ({ ok: false, reason: 'no' }), filesOf: () => [], stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview });
  assert.deepEqual(asked, [{ card: 'C-7', role: 'reviewer', head: HD, reason: 'cancel' }]);
});

test('L946: asks are made at once (a hung one is a failure, never an ask, and holds no other); one tell names every failure', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD }), card('C-8', { state: 'failed', head: HD })]);
  usageInto(rec);
  const alert = fakeAlert({ answer: true });
  const started = [];
  const at = [];
  const t = Date.now();
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7'), rv('A-1', 'auditor', 'C-7'), rv('R-2', 'reviewer', 'C-8')],
    probe: () => idle, alert, portDeadlineMs: 150, stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    stopReview: (x) => { started.push(x.role); at.push(Date.now()); return x.role === 'auditor' ? { ok: true } : new Promise(() => {}); } });
  assert.ok(Math.max(...at) - Math.min(...at) < 75, `every ask starts before any times out (spread ${Math.max(...at) - Math.min(...at)} ms)`);
  assert.ok(Date.now() - t < 1000, 'two hung asks take one deadline');
  assert.deepEqual(started.sort(), ['auditor', 'reviewer', 'reviewer']);
  assert.deepEqual(r.reviewStops, [['R-1', 'cancel', 'failed'], ['A-1', 'cancel', 'asked'], ['R-2', 'card_ended', 'failed']]);
  const tells = alert.texts.filter((x) => /could not be asked to stop/.test(x));
  assert.equal(tells.length, 1, 'one tell for both');
  assert.match(tells[0], /^2 review sessions could not be asked to stop: the reviewer R-1 for cancelled card C-7 \(.+\); the reviewer R-2 for ended card C-8 \(.+\)$/);
});

test('L946: a failing stop is done once its session is gone, one no longer due stays as it is, and the worker stops\' facts and these never touch', async () => {
  const UUID = '0b0e7c1e-0000-4000-8000-000000000001';
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD }), card('C-9', { state: 'in_review', head: HD }),
    ['fact', REVIEW_STOP_FACT('R-9'), { state: 'asked', card: 'C-9', role: 'reviewer', head: HD, reason: 'cancel', asked_at: iso(T0 - H), tries: 1 }],
    ['fact', STOP_FACT(UUID), { state: 'done', card: 'C-1', moved: true, saved: true, stopped_at: iso(T0 - H) }]]);
  usageInto(rec);
  const run = (at, sessions, answer) => stopPass({ rec, rules: rulesWith(), now: at, account: ACCT, product: 'p1', sessions, probe: () => idle, alert: fakeAlert({ answer: true }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => answer });
  await run(T0, [rv('R-1', 'reviewer', 'C-7'), rv('R-9', 'reviewer', 'C-9')], { ok: false, reason: 'no' });
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'failing');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-9')).doc.asked_at, iso(T0 - H), 'listed, no longer due: left as it is');
  const workerBefore = JSON.stringify(rec.read('fact', STOP_FACT(UUID)).doc);
  await run(T0 + MIN, [], { ok: true });
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'done');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-9')).doc.state, 'done');
  assert.equal(JSON.stringify(rec.read('fact', STOP_FACT(UUID)).doc), workerBefore, 'a worker stop is not the review sweep\'s');
  for (const id of [REVIEW_STOP_FACT('R-1'), REVIEW_STOP_TELL_FACT]) {
    const d = rec.read('fact', id)?.doc ?? {};
    assert.equal('moved' in d || 'saved' in d, false, `${id} carries nothing reparkStopped or tellUnsaved reads`);
  }
});

// L960: ended is M9's REVIEW_OVER, not FINAL_STATES. A closed card's auditor does work M9 keeps (closed can still be
// reverted), so it is not stopped; a reverted or closed_no_answer card's is.
test('L960: an auditor on a closed card is not asked to stop; one on a reverted or closed_no_answer card is', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'closed', head: HD }), card('C-8', { state: 'reverted', head: HD }), card('C-9', { state: 'closed_no_answer', head: HD })]);
  usageInto(rec);
  const asked = [];
  const r = await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('A-7', 'auditor', 'C-7'), rv('A-8', 'auditor', 'C-8'), rv('A-9', 'auditor', 'C-9')],
    probe: () => idle, alert: fakeAlert(), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: (x) => { asked.push(x.card); return { ok: true }; } });
  assert.deepEqual(asked, ['C-8', 'C-9'], 'the closed card\'s auditor runs on');
  assert.deepEqual(r.reviewStops, [['A-8', 'card_ended', 'asked'], ['A-9', 'card_ended', 'asked']]);
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('A-7')), null);
});

// L962 m1: a stop that fails, works, waits and fails again is told once a day, not on each failure.
test('L962 m1: fail, ask, wait, fail again over a day is told to Joe once', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  const alert = fakeAlert({ answer: true });
  // A new reviewer each round (one the runner did stop is gone), so no session reaches REVIEW_STOP_MAX_ASKS.
  const run = (min, answer, sid) => stopPass({ rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions: [rv(sid, 'reviewer', 'C-7')], probe: () => idle, alert,
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => answer });
  for (let k = 0; k < 20; k += 1) {
    await run(k * 6, { ok: false, reason: 'busy' }, `R-${k}`);
    await run(k * 6 + 1, { ok: true }, `R-${k}`);
  }
  assert.equal(alert.texts.filter((t) => /could not be asked to stop/.test(t)).length, 1, alert.texts.join(' | '));
  await run(25 * H / MIN, { ok: false, reason: 'busy' }, 'R-99');
  assert.equal(alert.texts.filter((t) => /could not be asked to stop/.test(t)).length, 2, 'again a day on');
});

// L962 m5: still listed after REVIEW_STOP_MAX_ASKS stop files, the runner could not stop it: said once, then left alone.
test('L962 m5: a session still listed after REVIEW_STOP_MAX_ASKS asks is given up on, said once, and done once it goes', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  let asked = 0;
  const notes = [];
  const alert = fakeAlert({ answer: true });
  const run = (min, sessions = [rv('R-1', 'reviewer', 'C-7')]) => stopPass({ rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions, probe: () => idle, alert,
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => { asked += 1; return { ok: true }; } });
  assert.equal(REVIEW_STOP_MAX_ASKS, 6);
  for (let k = 0; k < 10; k += 1) { const r = await run(k * 5); notes.push(...r.notes.filter((n) => /still running after/.test(n))); }
  assert.equal(asked, 6, 'six stop files, then no more');
  assert.equal(notes.length, 1, 'said once');
  assert.match(notes[0], /reviewer R-1 for cancelled card C-7 is still running after 6 stop requests; it is not asked again/);
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'given_up');
  // #458 r1 m-b: Joe is told once, as the runner shows no stop of its own here.
  const tells = alert.texts.filter((t) => /still running after 6 stop requests/.test(t));
  assert.equal(tells.length, 1, alert.texts.join(' | '));
  assert.match(tells[0], /the reviewer R-1 for cancelled card C-7 is still running after 6 stop requests; it is not asked again; the review runner showed no answer/);
  assert.doesNotMatch(notes[0], /the review runner tells Joe/, 'no claim the runner tells him');
  await run(60, []);
  // Told only once the given_up fact is written (#458 self-review m2): a refused write tells nothing; the next pass does, once.
  const rec2 = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec2);
  let frozen = false;
  const refusing = { ...rec2, write: (w) => (frozen && w.entity === 'fact' && w.id === REVIEW_STOP_FACT('R-1') ? { ok: false, reason: 'read-only' } : rec2.write(w)) };
  const alert2 = fakeAlert({ answer: true });
  const go = (min) => stopPass({ rec: refusing, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle, alert: alert2,
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => ({ ok: true }) });
  for (let k = 0; k < 6; k += 1) await go(k * 5);
  frozen = true;
  await go(40);
  const toldOf = () => alert2.texts.filter((t) => /still running after 6 stop requests/.test(t)).length;
  assert.equal(toldOf(), 0, 'the given_up write was refused: not told');
  frozen = false;
  await go(45); await go(50);
  assert.equal(toldOf(), 1, 'written on the next pass: told once');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'done');
});

// L968: once the review runner's row shows its own answer, the stop step asks no more; the cap is the backstop for a runner
// that never shows one (an older install, a stop file it never reached).
test('L968: a runner that shows its stop (stopped, wanted or failed) is not asked again; the fact says what it showed, and is done once it goes', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  let asked = 0;
  const run = (min, sessions) => stopPass({ rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions, probe: () => idle, alert: fakeAlert(),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => { asked += 1; return { ok: true }; } });
  const shown = (s) => [{ ...rv('R-1', 'reviewer', 'C-7'), ...(s ? { runner_stop: s } : {}) }];
  await run(0, shown());
  assert.equal(asked, 1);
  for (const [k, s] of [[5, 'wanted'], [10, 'wanted'], [15, 'failed'], [40, 'failed']]) {
    const r = await run(k, shown(s));
    assert.deepEqual(r.reviewStops, [['R-1', 'cancel', `runner_${s}`]], `${k}`);
  }
  assert.equal(asked, 1, 'never asked again once the runner showed it');
  const f = rec.read('fact', REVIEW_STOP_FACT('R-1')).doc;
  assert.deepEqual([f.state, f.runner, f.taken_at, f.asks], ['taken', 'failed', iso(T0 + 15 * MIN), 1], 'written once per answer shown, the asks kept');
  // The answer gone from the row while the session is still listed (L968 r1 m2): asked again at once, the cap still counting.
  const back = await run(42, shown());
  assert.deepEqual(back.reviewStops, [['R-1', 'cancel', 'asked']]);
  assert.equal(asked, 2);
  const g = rec.read('fact', REVIEW_STOP_FACT('R-1')).doc;
  assert.deepEqual([g.state, g.asks, g.runner, g.taken_at], ['asked', 2, undefined, undefined], 'the dropped answer is not kept');
  await run(45, []);
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'done');
  // Shown before any ask (a stop the runner made for another's request): nothing is asked at all.
  const r2 = await run(50, [{ ...rv('R-2', 'reviewer', 'C-7'), runner_stop: 'stopped' }]);
  assert.deepEqual(r2.reviewStops, [['R-2', 'cancel', 'runner_stopped']]);
  assert.equal(asked, 2, 'R-2 is never asked');
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-2')).doc.state, 'taken');
  // #458 r1 m-a: a taken fact is swept to done once its session is no longer listed.
  await run(55, []);
  assert.equal(rec.read('fact', REVIEW_STOP_FACT('R-2')).doc.state, 'done', 'taken, then gone: done');
  // A failing ask the runner then shows ends the failure: it is no longer failing.
  const failRec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(failRec);
  const go = (min, sessions, stopReview) => stopPass({ rec: failRec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions, probe: () => idle, alert: fakeAlert(),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview });
  await go(0, shown(), () => ({ ok: false, reason: 'the folder is gone' }));
  assert.equal(failRec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'failing');
  const r3 = await go(5, shown('stopped'), () => { throw new Error('must not be asked'); });
  assert.deepEqual(r3.reviewStops, [['R-1', 'cancel', 'runner_stopped']]);
  assert.equal(failRec.read('fact', REVIEW_STOP_FACT('R-1')).doc.state, 'taken');
});
// Without runner_stop the cap still ends the asking (L962 m5 above): the backstop stays.

// L962 m2: a fact write the Record refuses is said, so a stop file sent on every pass is never silent.
test('L962 m2: a refused review-stop fact write is said in the notes and the failure log', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  // The Record is frozen: a stand-in in front of it refuses this one fact's writes.
  const refusing = { ...rec, write: (w) => (w.entity === 'fact' && w.id === REVIEW_STOP_FACT('R-1') ? { ok: false, reason: 'the store is read-only' } : rec.write(w)) };
  const log = [];
  const r = await stopPass({ rec: refusing, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle, alert: fakeAlert(), failureLog: (l) => log.push(l),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => ({ ok: true }) });
  const line = /review stop fact stop-review-R-1 could not be written \(the store is read-only\); its stop file is written again on each pass until it is/;
  assert.ok(r.notes.some((n) => line.test(n)), r.notes.join(' | '));
  assert.ok(log.some((n) => line.test(n)));
});

// L962 m1: a tell not yet sent (the port down) is dropped from the queue once no stop fails, so it never goes out late.
test('L962 m1: a queued tell is dropped on the first pass with no failing stop', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state: 'cancelled', head: HD })]);
  usageInto(rec);
  const run = (min, answer, alert) => stopPass({ rec, rules: rulesWith(), now: T0 + min * MIN, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle, alert,
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: () => answer });
  await run(0, { ok: false, reason: 'busy' }, fakeAlert({ answer: false }));
  assert.equal(isQueued(rec, REVIEW_STOP_TELL_FACT), true, 'the port lost it, so it waits in the queue');
  await run(1, { ok: true }, fakeAlert({ answer: false }));
  assert.equal(isQueued(rec, REVIEW_STOP_TELL_FACT), false, 'dropped once none fails');
});

// L976: an undo's launch names the commit it reverses, found from the card's source (M6 undoneBy, via exactReverse),
// never from a field on the card; no other launch names one.
test('L976: the undo launch carries the reversed commit from its source; an editing launch carries none', async () => {
  const SHA = 'a'.repeat(40);
  const w = world([
    ['card', 'T-1', { state: 'merged', module: 'M-test', product: 'p1', tier: 2, files: ['src/a.js'], merge_commit: SHA }],
    ['merge', 'MG-1', { state: 'audited_ok', card: 'T-1', pr: 7, merge_commit: SHA, product: 'p1' }],
    ['ask', 'A-1', { state: 'answered', kind: 'undo', product: 'p1', card: 'T-1' }],
    // A look-alike field on the card is never read: the commit comes from the source.
    card('U-1', { kind: 'exact_reverse', source: { ask: 'A-1' }, files: ['src/a.js'], merge_commit: 'b'.repeat(40) }),
    card('C-1')]);
  const asked = [];
  w.refuseLaunch((x) => { asked.push(x); return { ok: true }; });
  await w.pass(0, { filesOf: () => ['src/a.js'] });
  const by = Object.fromEntries(asked.map((x) => [x.card.id, x]));
  assert.ok(by['U-1'] && by['C-1'], `both started: ${Object.keys(by)}`);
  assert.equal(by['U-1'].kind, 'undo');
  assert.equal(by['U-1'].undoCommit, SHA, 'the source\'s merge commit');
  assert.equal(by['C-1'].kind, 'editing');
  assert.equal('undoCommit' in by['C-1'], false, 'an editing launch names no reversed commit');
});

// L1000: each card state pinned to the reason its reviewer's stop carries. Only a cancel and a state no move leads out of
// may be quiet (the runner's STOP_QUIET_REASONS); every other state asks no stop at all.
test('L1000: every card state is pinned to its review stop reason: cancelled is cancel, failed, closed_no_answer and reverted are card_final, and no other state is stopped', async () => {
  const want = { cancelled: 'cancel', failed: 'card_final', closed_no_answer: 'card_final', reverted: 'card_final' };
  assert.deepEqual(Object.values(REVIEW_STOP_RUNNER_REASON).every((x) => STOP_QUIET_REASONS.includes(x)), true, 'each word is one the runner keeps quiet');
  for (const state of STATES.card) {
    const extra = state === 'waiting' ? { wait: { who: 'joe', what: 'x', since: iso(T0) } } : {};
    const rec = recWith([['product', 'p1', { state: 'active' }], card('C-7', { state, head: HD, ...extra })]);
    usageInto(rec);
    const asked = [];
    await stopPass({ rec, rules: rulesWith(), now: T0, account: ACCT, product: 'p1', sessions: [rv('R-1', 'reviewer', 'C-7')], probe: () => idle, alert: fakeAlert(),
      stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), stopReview: (x) => { asked.push(x.reason); return { ok: true, name: 'stop-1.json' }; } });
    assert.deepEqual(asked, want[state] ? [want[state]] : [], state);
    if (want[state] === 'card_final') assert.equal(FINAL_STATES.card.includes(state), true, `${state} is final`);
  }
});
