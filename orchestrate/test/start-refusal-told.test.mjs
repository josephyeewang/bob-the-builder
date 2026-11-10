// start-refusal-told.test.mjs — a card the Dispatcher can't start is never held in silence (lead calls L293, L299).
// Run: node --test orchestrate/test/start-refusal-told.test.mjs
//
// WHY. Before L293 only an undo card's refused start reached Joe; every other refusal went to the pass's notes, which
// nobody reads. A card stuck behind a run that never ends, or refused for a bad path, waited without a word (L38: no
// silent hold). The rules now:
//   - queueing (a cap, files another card holds, Tier-1 work first in amber), a usage-band hold the band alert already
//     tells, and a product Joe paused are not told card by card. Once the oldest such card on a product has been in
//     ready a day, Joe gets ONE alert per product and cause, listing the cards (and who holds the slot), then daily;
//     a paused product weekly;
//   - every other reason, and a band reason with no band-level alert, is told on first sight, once per card and cause,
//     then daily.
//
// WHAT IS REAL. runTick → tick → every step, M11's usage reader and bands, the start gate, the alert outbox and its one
// sender. The fakes are the ones M11's own tick tests use (fixtures.test-helper.mjs) and the Mac's ports. Joe is the
// `alert` port: only what reaches it counts as told.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runTick, ACCOUNT_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { USAGE_FACT, BAND_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { KEYS as K } from '../modules/M11-dispatcher/keys.mjs';
import { TOLD_BANDS } from '../modules/M11-dispatcher/pass.mjs';
import { rulesWith, recWith, change, usageFact, setClock, VALUES, T0, MIN, H, D, iso } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';
import { makeEngine } from '../modules/M10-rules/engine.mjs';
import { parsePolicy } from '../modules/M10-rules/policy.mjs';
import { makeRules } from '../shared/rules.mjs';
import { seed } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';

const ACCT = 'acct-a';
const HEAD = 'h'.repeat(40);
const allow = { start_session: { decision: 'allow', reason: 'ok' } };
const active = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const card = (id, over = {}) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], ...over }];
const GREEN = { week: 30, h5: 20 };

/**
 * A Mac whose runs never end: every launched session stays in the sessions list and answers active. Each tick renews
 * the account and usage readings at its own time (`usage` null: no reading at all) and moves the Record's clock.
 */
function mac(entries, { state = 'active', usage = GREEN, rules = {}, answers = allow, classify, sessions: seeded = [], launchOver } = {}) {
  const rec = recWith([['product', 'p1', { state }], ['fact', ACCOUNT_FACT, { account: ACCT, observed_at: iso(T0) }],
    ...(usage ? [['fact', USAGE_FACT(ACCT), usageFact({ ...usage, account: ACCT, now: T0 })]] : []), ...entries]);
  const alert = fakeAlert();
  const launched = [];
  const sessions = [...seeded];
  let n = 0;
  const dir = tempDir('orch-start-refusal-');
  const ports = {
    alert,
    approvals: () => [], board: () => [], healthy: () => true, resume: () => false,
    proposals: () => ({ products: [], ownerUid: 501 }), outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [],
    sessions: () => [...sessions], probe: () => active,
    launch: launchOver ?? (async ({ card: c, kind, product, sessionId: id }) => { launched.push(c.id); n += 1; sessions.push({ id, product, kind, card: c.id, pgid: 100 + n }); return { ok: true, sessionId: id, outbox: `/outbox-root/worker/${id}`, pid: 1000 + n, pidStart: `Mon Oct 29 12:0${n % 10}:00 2026`, pgid: 100 + n, head: HEAD }; }),
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: () => ({ ok: true, requestId: `Q-${++n}` }),
    filesOf: () => [],
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: dir, sealRoot: dir, mirrorFor: () => null },
  };
  const lockFile = join(dir, 'pass.lock');
  const r = rulesWith(rules, answers, { classify });
  const at = async (ms) => {
    const now = T0 + ms;
    setClock(rec, now);
    if (ms > 0) {
      change(rec, 'fact', ACCOUNT_FACT, { observed_at: iso(now) });
      if (usage) change(rec, 'fact', USAGE_FACT(ACCT), usageFact({ ...usage, account: ACCT, now }));
    }
    const res = await runTick({ lockFile, rec, rules: r, now, ports });
    assert.equal(res.ran, true, `the tick at +${ms / MIN} min did not run: ${res.reason}`);
    // The steps this file is about; the others (approvals and so on) have no port here, as in usage-unknown.test.mjs.
    for (const s of ['stops', 'pass', 'limits']) assert.equal(res.steps[s]?.ok, true, `${s}: ${res.steps[s]?.error}`);
    return res;
  };
  const told = () => alert.texts.map((t) => (typeof t === 'string' ? t : t.text)).filter((_, i) => alert.answers[i] === true);
  return { rec, launched, sessions, at, get told() { return told(); } };
}

const refused = (res) => (res.steps.pass.result?.refused ?? []).map(([id, why]) => `${id}: ${why}`);
const count = (texts, re) => texts.filter((t) => re.test(t)).length;

test('queueing: a card stuck behind runs that never end is told once after a day, naming the cards holding the slot, then daily', async () => {
  const cap = VALUES[K.editingPerProduct];
  const m = mac([card('A'), card('B'), card('C'), card('D')]);
  const first = await m.at(0);
  assert.deepEqual(m.launched, ['A', 'B', 'C'].slice(0, cap), 'the cap fills, in ready order');
  assert.deepEqual(refused(first), [`D: the product already runs ${cap} editing worker(s) (cap ${cap})`]);
  for (const ms of [MIN, 2 * MIN, H, 12 * H, D - MIN]) await m.at(ms);
  assert.deepEqual(m.told, [], `a slot frees when a run ends, so a day of queueing is not news: ${m.told.join(' | ')}`);
  await m.at(D);
  const WAITED = /^p1: 1 card\(s\) held from starting, the oldest for over a day: D \(the product already runs 3 editing worker\(s\) \(cap 3\)\); the slot is held by card\(s\) A, B, C$/;
  assert.equal(count(m.told, WAITED), 1, m.told.join(' | '));
  assert.deepEqual(m.told.filter((t) => !WAITED.test(t)), [], 'nothing else told');
  await m.at(D + MIN);
  await m.at(D + 12 * H);
  assert.equal(count(m.told, WAITED), 1, 'not again the same day');
  await m.at(2 * D);
  assert.equal(count(m.told, WAITED), 2, `again a day later while it lasts: ${m.told.join(' | ')}`);
  assert.deepEqual(m.launched, ['A', 'B', 'C'], 'the held card never started');
});

test('queueing: a card stuck behind files a running card holds names that card', async () => {
  const m = mac([card('A', { files: ['src/shared.js'] }), card('B', { files: ['src/shared.js'] })]);
  const first = await m.at(0);
  assert.deepEqual(m.launched, ['A']);
  assert.deepEqual(refused(first), ['B: shares src/shared.js with running card A']);
  await m.at(D - MIN);
  assert.deepEqual(m.told, []);
  await m.at(D);
  assert.deepEqual(m.told, ['p1: 1 card(s) held from starting, the oldest for over a day: B (shares src/shared.js with running card A); the slot is held by card(s) A']);
});

test('fold: fifteen cards held in a red band give one band alert, then after a day ONE alert listing ten and "+5 more"', async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
  const m = mac(ids.map((id) => card(id)), { usage: { week: 90, h5: 20 } });
  const first = await m.at(0);
  assert.equal(refused(first).length, 15);
  assert.ok(refused(first).every((r) => /: the red band: nothing new starts$/.test(r)), refused(first).join(' | '));
  const BAND = /^the usage band is red/;
  assert.equal(count(m.told, BAND), 1, `the band alert tells the red band: ${m.told.join(' | ')}`);
  assert.equal(m.told.length, 1, `and nothing card by card: ${m.told.join(' | ')}`);
  await m.at(D);
  const listing = ids.slice(0, 10).join(', ');
  const FOLD = `p1: 15 card(s) held from starting, the oldest for over a day: ${listing} +5 more (the red band: nothing new starts)`;
  assert.equal(m.told.filter((t) => t === FOLD).length, 1, m.told.join(' | '));
  assert.equal(m.told.filter((t) => !BAND.test(t)).length, 1, `one alert for fifteen cards: ${m.told.join(' | ')}`);
});

// L299 point 1: a band reason is held from card-by-card telling only while a band-level alert really fires for it.
// Each reason the start path can give, through the real tick: either the band alert is queued and no card is told,
// or the card is told on first sight.
// L305: the start pass folds a band hold only under a band tick's band alert tells, and both read TOLD_BANDS. Driven
// from the list itself: every band the usage reader can give, with a reading that gives it. A band added to the list
// (or to the reader) with no reading here fails, and each band's alert fires exactly when the list says it does.
const READINGS = { green: GREEN, amber: { week: 30, h5: 75 }, red: { week: 90, h5: 20 }, unknown: null };
test('L305: every band in TOLD_BANDS makes the band alert fire, and no other band does', async () => {
  for (const band of TOLD_BANDS) assert.ok(Object.hasOwn(READINGS, band), `no reading here gives the band ${band}`);
  for (const [band, usage] of Object.entries(READINGS)) {
    const m = mac([card('X')], { usage });
    const res = await m.at(0);
    assert.equal(res.steps.stops.result?.bands?.band ?? m.rec.read('fact', BAND_FACT)?.doc?.band, band, `the reading for ${band}`);
    const fired = count(m.told, new RegExp(`^the usage band is ${band}`));
    assert.equal(fired, TOLD_BANDS.includes(band) ? 1 : 0, `${band}: ${m.told.join(' | ')}`);
  }
});

const PROD = () => ({ tier: 1, risky: ['production_data'], reasons: { production_data: ['src/X.js'] } });
const BAND_CASES = [
  { name: 'red band', usage: { week: 90, h5: 20 }, card: {}, reason: /^the red band: nothing new starts$/, band: /^the usage band is red/ },
  // M10 is asked first and holds a Tier-1 start with no reading in its own words; the gate's "usage is unknown: no
  // Tier-1 start" is the backstop behind it (S22's test reads either). Both are folded while the unknown band is told.
  { name: 'no usage reading, Tier 1', usage: null, card: { tier: 1 }, reason: /^(rules: .*Tier 1 start needs a usage reading|usage is unknown: no Tier-1 start)/, band: /^the usage band is unknown/ },
  { name: 'Tier-1 production work above the usage line (a red band)', usage: { week: 91, h5: 20 }, card: { tier: 1 }, classify: PROD, reason: /^no Tier-1 production work above the usage line$/, band: /^the usage band is red/ },
  { name: 'ORCHESTRATE has used its share (no band alert)', usage: { week: 50, h5: 20 }, card: {}, reason: /^ORCHESTRATE has used its share of the week$/, band: null },
  { name: 'a script outside the green band (amber: no band alert)', usage: { week: 30, h5: 75 }, card: { kind: 'script' }, reason: /^no new scripts outside the green band$/, band: null },
];
for (const c of BAND_CASES) {
  test(`band reason, ${c.name}: ${c.band ? 'the band alert is queued and no card is told' : 'the card is told on first sight'}`, async () => {
    const m = mac([card('X', c.card)], { usage: c.usage, classify: c.classify });
    const res = await m.at(0);
    const why = refused(res).find((r) => r.startsWith('X: '))?.slice(3);
    assert.match(why ?? '', c.reason, refused(res).join(' | '));
    if (c.band) {
      assert.equal(count(m.told, c.band), 1, m.told.join(' | '));
      assert.deepEqual(m.told.filter((t) => /card X|X\b/.test(t) && !c.band.test(t)), [], `no card-by-card tell: ${m.told.join(' | ')}`);
    } else {
      assert.deepEqual(m.told, [`card X can't start: ${why}`]);
      await m.at(MIN);
      assert.equal(m.told.length, 1, 'once, not every tick');
    }
  });
}

test('paused product: no tell on first sight; after a day one alert per product, then weekly, not daily', async () => {
  const m = mac([card('A'), card('B')], { state: 'paused' });
  const first = await m.at(0);
  assert.deepEqual(refused(first), ['A: p1 is paused: only its undo starts', 'B: p1 is paused: only its undo starts']);
  await m.at(H);
  assert.deepEqual(m.told, [], 'Joe paused it himself: not told on first sight');
  await m.at(D);
  const PAUSED = 'p1 is paused; 2 card(s) are waiting: A, B';
  assert.deepEqual(m.told, [PAUSED]);
  for (const ms of [2 * D, 4 * D, 7 * D + D - MIN]) await m.at(ms);
  assert.equal(m.told.length, 1, `not daily: ${m.told.join(' | ')}`);
  await m.at(8 * D);
  assert.deepEqual(m.told, [PAUSED, PAUSED], 'again a week later');
});

// The real M10 engine, asked for start_session as the Dispatcher asks it (#157 audit m1, m2: a fake with the wrong words
// hid that the paused and cap folds never ran). `run` is M10's running count: a number, or a function of its query.
const M10 = fileURLToPath(new URL('../modules/M10-rules/', import.meta.url));
const POLICY = parsePolicy(readFileSync(join(M10, 'fixtures/policy.yaml'), 'utf8')).policy;
function realM10({ state = 'active', run = 0 } = {}) {
  const e = makeRules(makeEngine({
    products: ['p1'], productState: () => ({ state }), running: typeof run === 'function' ? run : () => run,
    rulesState: () => ({ status: 'ok', policy: POLICY, commit: 'c'.repeat(40), blob: 'b'.repeat(40) }),
    rolesDir: join(M10, 'roles'), clock: () => T0,
  }));
  return { start_session: (q) => e.may('start_session', q) };
}

test('paused product through the real M10 (its own words): folded the same way, weekly', async () => {
  const m = mac([card('A')], { state: 'paused', answers: realM10({ state: 'paused' }) });
  const first = await m.at(0);
  assert.deepEqual(refused(first), ['A: rules: product is paused: no starts']);
  await m.at(D - MIN);
  assert.deepEqual(m.told, []);
  await m.at(D);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: A']);
  await m.at(3 * D);
  assert.equal(m.told.length, 1, 'weekly, not daily');
});

test('caps through the real M10 (its own words), product and Mac: folded, told once after a day, then daily', async () => {
  const onP2 = [{ id: 's9', product: 'p2', kind: 'editing', card: 'R1', pgid: 900 }];
  for (const [name, run, reason, sessions, by] of [
    ['product', 3, 'rules: editing cap reached for p1 (3)', [], ''],
    ['Mac', (q) => (q?.product ? 0 : 5), 'rules: editing cap reached on this Mac (5)', onP2, '; the slot is held by card(s) R1'],
  ]) {
    const m = mac([card('A'), card('B')], { answers: realM10({ run }), sessions });
    const first = await m.at(0);
    assert.deepEqual(refused(first), [`A: ${reason}`, `B: ${reason}`], name);
    await m.at(H); await m.at(D - MIN);
    assert.deepEqual(m.told, [], `${name}: queueing is not news within the day: ${m.told.join(' | ')}`);
    await m.at(D);
    assert.deepEqual(m.told, [`p1: 2 card(s) held from starting, the oldest for over a day: A, B (${reason})${by}`], name);
    await m.at(D + 12 * H);
    assert.equal(m.told.length, 1, name);
    await m.at(2 * D);
    assert.equal(m.told.length, 2, `${name}: daily while it lasts`);
  }
});

test('Mac-cap fold through the gate names every card on the Mac holding the slot, ten at most', async () => {
  // Twelve sessions on the Mac (none on p1) fill the Mac cap; the card on p1 waits.
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, product: 'p2', kind: 'editing', card: `R${String(i + 1).padStart(2, '0')}`, pgid: 500 + i }));
  const m = mac([card('A')], { sessions, rules: { [K.editingPerMac]: '12' } });
  const first = await m.at(0);
  const why = refused(first).find((x) => x.startsWith('A: '));
  assert.match(why ?? '', /^A: the Mac already runs 12 editing workers/, refused(first).join(' | '));
  await m.at(D);
  const fold = m.told.filter((t) => t.startsWith('p1: '));
  assert.equal(fold.length, 1, m.told.join(' | '));
  assert.match(fold[0], /the slot is held by card\(s\) R01, R02, R03, R04, R05, R06, R07, R08, R09, R10 \+2 more$/);
});

test('tier1-first: a Tier-2 card queued behind Tier-1 work in amber is folded, naming the Tier-1 card', async () => {
  const sessions = ['X1', 'X2', 'X3'].map((c, i) => ({ id: `s${i}`, product: 'p1', kind: 'editing', card: c, pgid: 600 + i }));
  const m = mac([card('T', { tier: 1 }), card('W')], { sessions, usage: { week: 30, h5: 75 }, classify: (q) => ({ tier: q?.card?.tier ?? q?.tier ?? 2, risky: false, reasons: ['test'] }) });
  const first = await m.at(0);
  assert.ok(refused(first).includes('W: queued behind Tier-1 work in amber'), refused(first).join(' | '));
  await m.at(D);
  const fold = m.told.filter((t) => /queued behind Tier-1 work in amber/.test(t));
  assert.deepEqual(fold, ['p1: 1 card(s) held from starting, the oldest for over a day: W (queued behind Tier-1 work in amber); they wait behind Tier-1 card(s) T'], m.told.join(' | '));
});

test('exactly ten cards are listed with no "+"', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
  const m = mac(ids.map((id) => card(id)), { state: 'paused' });
  await m.at(D);
  assert.deepEqual(m.told, [`p1 is paused; 10 card(s) are waiting: ${ids.join(', ')}`]);
});

test('MAT-1: a ready time more than 60 s ahead, or one that can\'t be read, is told at once, not waited out', async () => {
  for (const at of [iso(T0 + 30 * D), iso(T0 + 2 * MIN)]) {
    const m = mac([card('A', { files: ['src/s.js'] }), card('B', { files: ['src/s.js'], changed_at: at })]);
    await m.at(0);
    assert.deepEqual(m.told, ['p1: 1 card(s) held from starting, the oldest for over a day: B (shares src/s.js with running card A); the slot is held by card(s) A'], at);
    for (const t of [MIN, H]) await m.at(t);
    assert.equal(m.told.length, 1, `${at}: not every pass`);
  }
});

test('the day counts from the card\'s ready time, not from when the Dispatcher first saw it', async () => {
  const m = mac([card('A', { files: ['src/s.js'], changed_at: iso(T0 - 21 * H) }), card('B', { files: ['src/s.js'], changed_at: iso(T0 - 20 * H) })]);
  await m.at(0);
  await m.at(3 * H);
  assert.deepEqual(m.told, []);
  await m.at(4 * H);
  assert.equal(m.told.length, 1, 'B has been in ready a day four hours after first sight');
});

test('a fold mark that can\'t be read, or lies in the future, counts as not told', async () => {
  for (const told_at of ['garbage', iso(T0 + 30 * D), 12]) {
    const m = mac([card('A', { files: ['src/s.js'] }), card('B', { files: ['src/s.js'] }), ['fact', 'hold-waits-p1-files', { text: 'old', told_at }]]);
    await m.at(D);
    assert.equal(m.told.length, 1, `${told_at}: ${m.told.join(' | ')}`);
  }
});

test('m3: a pause counts from the pause; an unpause clears the mark, so a re-pause is told a day later, not a week', async () => {
  // Cards in ready for ten days, then paused: told a day after the pause, not on the first pass.
  const m = mac([card('A', { changed_at: iso(T0 - 10 * D) })], { state: 'active' });
  const r0 = await m.at(0);
  assert.deepEqual(m.launched, ['A']);
  seed(m.rec, 'card', 'B', { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: ['src/B.js'], changed_at: iso(T0 - 10 * D) });
  setClock(m.rec, T0 + H); change(m.rec, 'product', 'p1', { state: 'paused' });
  await m.at(2 * H);
  assert.deepEqual(m.told, [], `paused an hour ago: ${m.told.join(' | ')}`);
  await m.at(H + D);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: B']);
  setClock(m.rec, T0 + 2 * D); change(m.rec, 'product', 'p1', { state: 'active' });
  await m.at(2 * D + H);
  assert.equal(m.rec.read('fact', 'hold-waits-p1-paused')?.doc?.told_at, null, 'the unpause cleared the mark');
  seed(m.rec, 'card', 'C', { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: ['src/C.js'], changed_at: iso(T0 + 2 * D + 2 * H) });
  setClock(m.rec, T0 + 2 * D + 2 * H); change(m.rec, 'product', 'p1', { state: 'paused' });
  await m.at(3 * D + 3 * H);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: B', 'p1 is paused; 1 card(s) are waiting: C'], 'a day after the re-pause');
  void r0;
});

test('L324 n4: a re-pause with no full pass since the unpause is told a day after the re-pause, not a week after the last tell', async () => {
  const m = mac([card('A', { changed_at: iso(T0 - 10 * D) })], { state: 'active' });
  await m.at(0);
  seed(m.rec, 'card', 'B', { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: ['src/B.js'], changed_at: iso(T0 - 10 * D) });
  setClock(m.rec, T0 + H); change(m.rec, 'product', 'p1', { state: 'paused' });
  await m.at(H + D);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: B']);
  assert.equal(m.rec.read('fact', 'hold-waits-p1-paused').doc.since, iso(T0 + H), 'the mark names this pause');
  // Unpaused and re-paused with no full pass between (starts off, an outage): the old mark is never cleared.
  setClock(m.rec, T0 + 2 * D); change(m.rec, 'product', 'p1', { state: 'active' });
  setClock(m.rec, T0 + 3 * D); change(m.rec, 'product', 'p1', { state: 'paused' });
  await m.at(3 * D + H);
  assert.equal(m.told.length, 1, 'an hour after the re-pause: quiet');
  await m.at(4 * D + H);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: B', 'p1 is paused; 1 card(s) are waiting: B'], 'a day after the re-pause');
  await m.at(5 * D + H);
  assert.equal(m.told.length, 2, 'then weekly');
});

test('MAT-1: a first-sight hold mark more than 60 s in the future counts as not told', async () => {
  const m = mac([card('A'), ['fact', 'hold-start-A-launcher', { text: 'old', told_at: iso(T0 + 30 * D) }]], { launchOver: async () => ({ ok: false, reason: 'busy' }) });
  await m.at(0);
  assert.deepEqual(m.told, ["card A can't start: launcher: busy"]);
});

test('m5: a launcher refusal whose words change each time is one cause per card, told once a day', async () => {
  const m = mac([card('A')], { launchOver: async () => ({ ok: false, reason: `busy with session ${randomUUID()}` }) });
  for (const t of [0, MIN, 2 * MIN, 3 * MIN]) await m.at(t);
  const mine = m.told.filter((t) => /^card A can't start: launcher: busy with session /.test(t));
  assert.equal(mine.length, 1, `${m.told.join(' | ')} || ${JSON.stringify(m.rec.list('fact').map((f) => f.id))}`);
});

// #157 r2 audit n5 (plant Q12): a rules error whose words change each time (an error message) is one cause per card,
// keyed by its fixed class, not its text: told once a day, not once per pass.
test('n5: a rules error whose words change each time is one cause per card, told once a day', async () => {
  const m = mac([card('A')], { answers: { start_session: () => { throw new Error(`engine down: ${randomUUID()}`); } } });
  for (const t of [0, MIN, 2 * MIN, 3 * MIN]) await m.at(t);
  const mine = () => m.told.filter((t) => /^card A can't start: rules: (could not be asked|rules error: )/.test(t));
  assert.equal(mine().length, 1, m.told.join(' | '));
  await m.at(D + 4 * MIN);
  assert.equal(mine().length, 2, 'again a day later');
});

test('first sight: a daily pattern that can\'t be folded is told at once, naming the pattern, then not again that day', async () => {
  const W = 'W';
  const m = mac([card(W, { state: 'running', files: ['src/a.js'] }), card('D', { kind: 'daily', files: [] })],
    { rules: { [K.leadDailyCard]: ['src/\ud800*'] }, sessions: [{ id: 's-w', product: 'p1', kind: 'editing', card: W, pgid: 99 }] });
  const res = await m.at(0);
  const why = refused(res).find((r) => r.startsWith('D: '))?.slice(3);
  assert.match(why ?? '', /can't be folded, so it counts as every file\) with running card W$/, refused(res).join(' | '));
  assert.deepEqual(m.told.filter((t) => /^card D can't start: /.test(t)), [`card D can't start: ${why}`], m.told.join(' | '));
  await m.at(MIN);
  assert.equal(count(m.told, /^card D can't start/), 1, 'once per card and cause');
});

test('first sight: a card with a path that is not well formed is told at once, then daily while it lasts', async () => {
  const m = mac([card('P', { files: ['src/a\ud800.js'] })]);
  const res = await m.at(0);
  assert.deepEqual(refused(res), ['P: the card names a path that is not well formed ("src/a\\ud800.js")']);
  const TOLD = /^card P can't start: the card names a path that is not well formed/;
  assert.equal(count(m.told, TOLD), 1, m.told.join(' | '));
  await m.at(MIN);
  await m.at(D - MIN);
  assert.equal(count(m.told, TOLD), 1, 'not every tick');
  await m.at(D);
  assert.equal(count(m.told, TOLD), 2, 'again a day later');
});
