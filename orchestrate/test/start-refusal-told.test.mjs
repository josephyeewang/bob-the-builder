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
import { runTick, ACCOUNT_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { USAGE_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { KEYS as K } from '../modules/M11-dispatcher/keys.mjs';
import { rulesWith, recWith, change, usageFact, setClock, VALUES, T0, MIN, H, D, iso } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

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
function mac(entries, { state = 'active', usage = GREEN, rules = {}, answers = allow, sessions: seeded = [] } = {}) {
  const rec = recWith([['product', 'p1', { state }], ['fact', ACCOUNT_FACT, { account: ACCT, observed_at: iso(T0) }],
    ...(usage ? [['fact', USAGE_FACT(ACCT), usageFact({ ...usage, account: ACCT, now: T0 })]] : []), ...entries]);
  const alert = fakeAlert();
  const launched = [];
  const sessions = [...seeded];
  let n = 0;
  const dir = tempDir('orch-start-refusal-');
  const ports = {
    alert,
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [],
    sessions: () => [...sessions], probe: () => active,
    launch: async ({ card: c, kind, product, sessionId: id }) => { launched.push(c.id); n += 1; sessions.push({ id, product, kind, card: c.id, pgid: 100 + n }); return { ok: true, sessionId: id, pid: 1000 + n, pidStart: `Mon Oct 29 12:0${n % 10}:00 2026`, pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: () => ({ ok: true, requestId: `Q-${++n}` }),
    filesOf: () => [],
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: dir, sealRoot: dir, mirrorFor: () => null },
  };
  const lockFile = join(dir, 'pass.lock');
  const r = rulesWith(rules, answers);
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
  const WAITED = /^p1: 1 card\(s\) have waited over a day to start \(the product already runs 3 editing worker\(s\) \(cap 3\)\): D; the slot is held by card A, card B, card C$/;
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
  assert.deepEqual(m.told, ['p1: 1 card(s) have waited over a day to start (shares src/shared.js with running card A): B; the slot is held by card A']);
});

test('fold: fifteen cards held in a red band give one band alert, then after a day ONE alert listing ten and "+5 more"', async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
  const m = mac(ids.map((id) => card(id, { title: `fix ${id}` })), { usage: { week: 90, h5: 20 } });
  const first = await m.at(0);
  assert.equal(refused(first).length, 15);
  assert.ok(refused(first).every((r) => /: the red band: nothing new starts$/.test(r)), refused(first).join(' | '));
  const BAND = /^the usage band is red/;
  assert.equal(count(m.told, BAND), 1, `the band alert tells the red band: ${m.told.join(' | ')}`);
  assert.equal(m.told.length, 1, `and nothing card by card: ${m.told.join(' | ')}`);
  await m.at(D);
  const listing = ids.slice(0, 10).map((id) => `${id} (fix ${id})`).join(', ');
  const FOLD = `p1: 15 card(s) have waited over a day to start (the red band: nothing new starts): ${listing} +5 more`;
  assert.equal(m.told.filter((t) => t === FOLD).length, 1, m.told.join(' | '));
  assert.equal(m.told.filter((t) => !BAND.test(t)).length, 1, `one alert for fifteen cards: ${m.told.join(' | ')}`);
});

// L299 point 1: a band reason is held from card-by-card telling only while a band-level alert really fires for it.
// Each reason the start path can give, through the real tick: either the band alert is queued and no card is told,
// or the card is told on first sight.
const BAND_CASES = [
  { name: 'red band', usage: { week: 90, h5: 20 }, card: {}, reason: /^the red band: nothing new starts$/, band: /^the usage band is red/ },
  { name: 'no usage reading, Tier 1 (the start gate)', usage: null, card: { tier: 1 }, reason: /^usage is unknown: no Tier-1 start$/, band: /^the usage band is unknown/ },
  { name: 'no usage reading, Tier 1 (M10: a Tier-1 start needs a usage reading)', usage: null, answers: {}, card: { tier: 1 }, reason: /^rules: .*Tier 1 start needs a usage reading/, band: /^the usage band is unknown/ },
  { name: 'no usage reading, Tier-1 production work', usage: null, card: { tier: 1, risky: ['production_data'] }, reason: /^usage is unknown: no Tier-1 production work$/, band: /^the usage band is unknown/ },
  { name: 'Tier-1 production work above the usage line (a red band)', usage: { week: 91, h5: 20 }, card: { tier: 1, risky: ['production_data'] }, reason: /^no Tier-1 production work above the usage line$/, band: /^the usage band is red/ },
  { name: 'ORCHESTRATE has used its share (no band alert)', usage: { week: 50, h5: 20 }, card: {}, reason: /^ORCHESTRATE has used its share of the week$/, band: null },
  { name: 'a script outside the green band (amber: no band alert)', usage: { week: 30, h5: 75 }, card: { kind: 'script' }, reason: /^no new scripts outside the green band$/, band: null },
];
for (const c of BAND_CASES) {
  test(`band reason, ${c.name}: ${c.band ? 'the band alert is queued and no card is told' : 'the card is told on first sight'}`, async () => {
    const m = mac([card('X', c.card)], { usage: c.usage, ...(c.answers ? { answers: c.answers } : {}) });
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

test('paused product through M10 (its own words): folded the same way', async () => {
  const m = mac([card('A')], { state: 'paused', answers: {} });
  const first = await m.at(0);
  assert.deepEqual(refused(first), ['A: rules: product is paused']);
  assert.deepEqual(m.told, []);
  await m.at(D);
  assert.deepEqual(m.told, ['p1 is paused; 1 card(s) are waiting: A']);
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
