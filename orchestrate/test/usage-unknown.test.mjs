// usage-unknown.test.mjs — with no usage reading at all, the Dispatcher slows down and tells Joe (safety roadmap S22,
// lead call L230). Run: node --test orchestrate/test/usage-unknown.test.mjs
//
// WHY. Nothing writes the real 5-hour and weekly usage numbers yet (R-0b-66 not started; the Sensors loop is #89). So on
// day one the Record has no `usage-<account>` fact at all. The design says unknown is never zero (A8): it counts as amber
// for the work the Dispatcher starts, holds every Tier-1 start, and is told to Joe (L38: no silent hold). M11's own
// tests prove this for a STALE reading through tick(); this file proves it for NO reading, through the real entry point
// main.mjs calls (runTick, with its pass lock), across ticks and past timeouts.usage_unknown_max_min.
//
// WHAT IS REAL. runTick → tick → every step, M11's usage reader and bands, the start gate, the alert outbox and its one
// sender. The fakes are the ones M11's own tick tests use: the Record stand-in (M11 recWith, seeded only by the script
// M9 lets make each entry), the rules (M11 rulesWith, the design's numbers, with M10's real engine for count_approval),
// and the Mac's ports (launcher, sessions, board). Joe is the `alert` port: only what reaches it counts as told.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runTick, ACCOUNT_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { USAGE_FACT, BAND_FACT } from '../modules/M11-dispatcher/usage.mjs';
import { UNKNOWN_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { KEYS as K } from '../modules/M11-dispatcher/keys.mjs';
import { rulesWith, recWith, change, usageFact, undoEntries, filesOfCommits, VALUES, T0, MIN, iso } from '../modules/M11-dispatcher/fixtures.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { fakeAlert } from './fake-alert.test-helper.mjs';

const ACCT = 'acct-a';
const HEAD = 'h'.repeat(40);
const allow = { start_session: { decision: 'allow', reason: 'ok' } };
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const account = (at = T0) => ['fact', ACCOUNT_FACT, { account: ACCT, observed_at: iso(at) }];
const green = (at = T0) => ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: at })];
const card = (id, over = {}) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN), ...over }];
const parked = (id) => card(id, { state: 'waiting', wait: { who: 'dispatcher', what: 'usage_band', since: iso(T0), next_check: iso(T0) } });

const UNKNOWN_TOLD = /the usage band is unknown \(no usage reading for acct-a\)/;
const DAY_TOLD = /usage has been unreadable for over a day/;
// The account reading is Sensors' input; renewed so that only the missing usage reading remains.
const renewAccount = (rec, min) => change(rec, 'fact', ACCOUNT_FACT, { observed_at: iso(T0 + min * MIN) });

/** A Mac with every port faked as M11's tick tests fake it; ticks go through runTick and its lock. */
function mac(entries, { alert = fakeAlert() } = {}) {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...entries]);
  const launched = [];
  const sessions = [];
  let n = 0;
  const dir = tempDir('orch-usage-unknown-');
  const ports = {
    alert,
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [],
    sessions: () => [...sessions], probe: () => idle,
    launch: async ({ card: c, kind, product, sessionId: id }) => { launched.push(c.id); n += 1; sessions.push({ id, product, kind, card: c.id, pgid: 100 + n }); return { ok: true, sessionId: id, pid: 1000 + n, pidStart: `Mon Oct 29 12:0${n % 10}:00 2026`, pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: () => ({ ok: true, requestId: `Q-${++n}` }),
    filesOf: filesOfCommits,
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: dir, sealRoot: dir, mirrorFor: () => null },
  };
  const lockFile = join(dir, 'pass.lock');
  const at = async (min) => {
    const r = await runTick({ lockFile, rec, rules: rulesWith({}, allow), now: T0 + min * MIN, ports });
    assert.equal(r.ran, true, `the tick at +${min} min did not run: ${r.reason}`);
    return r;
  };
  // What reached Joe: each text the alert port answered true for.
  const told = () => alert.texts.map((t) => (typeof t === 'string' ? t : t.text)).filter((_, i) => alert.answers[i] === true);
  return { rec, launched, at, get told() { return told(); } };
}

const notes = (r) => [...(r.steps.pass.result?.refused ?? []), ...(r.steps.pass.result?.notes ?? [])].map((x) => (Array.isArray(x) ? x.join(': ') : String(x)));

// Two worlds per reading, so which card wins a slot never matters: a Tier-1 card alone, and Tier-2 cards alone.
const TIER2 = () => [card('A'), card('B'), card('C'), card('D')];

test('control: with a green reading, a Tier-1 card starts and Tier-2 cards fill the normal editing cap', async () => {
  const one = mac([account(), green(), card('T1', { tier: 1 })]);
  await one.at(0);
  assert.deepEqual(one.launched, ['T1']);
  const many = mac([account(), green(), ...TIER2()]);
  await many.at(0);
  assert.equal(many.launched.length, VALUES[K.editingPerProduct], `the normal cap: ${many.launched.join(', ')}`);
  assert.deepEqual([...one.told, ...many.told], [], 'nothing held, nothing told');
});

test('no usage reading: nothing Tier-1 starts, Tier-2 work runs under the lower amber cap, and the band reads unknown', async () => {
  assert.ok(VALUES[K.amberEditingPerProduct] < VALUES[K.editingPerProduct], 'the fixture must make amber slower than green');
  const one = mac([account(), card('T1', { tier: 1 })]);
  assert.equal(one.rec.read('fact', USAGE_FACT(ACCT)), null, 'the world has no usage reading at all');
  for (const min of [0, 1, 2]) {
    const r = await one.at(min);
    for (const [s, v] of Object.entries(r.steps)) assert.equal(v.ok, true, `${s}: ${v.error}`);
    // Held twice over: M10 needs a usage reading's time for any Tier-1 start, and M11's band gate holds Tier 1 on unknown.
    assert.ok(notes(r).some((x) => /^T1: (rules: .*Tier 1 start needs a usage reading|usage is unknown: no Tier-1 start)/.test(x)), notes(r).join(' | '));
  }
  assert.deepEqual(one.launched, [], 'a Tier-1 card started with no usage reading');
  const many = mac([account(), ...TIER2()]);
  for (const min of [0, 1, 2]) await many.at(min);
  assert.equal(many.launched.length, VALUES[K.amberEditingPerProduct], `Tier-2 starts are held to the amber cap: ${many.launched.join(', ')}`);
  const band = many.rec.read('fact', BAND_FACT).doc;
  assert.deepEqual([band.band, band.own_building, band.reason], ['unknown', 'unknown', 'no usage reading for acct-a']);
  assert.equal(band.unknown_since, iso(T0));
});

test('no usage reading: Joe is told once, not every tick, and once more a day later while it lasts', async () => {
  const m = mac([account(), card('A')]);
  await m.at(0);
  await m.at(1);
  await m.at(2);
  assert.equal(m.told.filter((t) => UNKNOWN_TOLD.test(t)).length, 1, m.told.join(' | '));
  assert.deepEqual(m.told.filter((t) => !UNKNOWN_TOLD.test(t)), [], 'nothing else told');
  const later = 25 * 60;
  renewAccount(m.rec, later);
  await m.at(later);
  assert.equal(m.told.filter((t) => UNKNOWN_TOLD.test(t)).length, 2, `a day later: ${m.told.join(' | ')}`);
});

test('no usage reading past timeouts.usage_unknown_max_min: parked work waits on Joe, and Joe is told', async () => {
  const limit = VALUES[K.usageUnknownMaxMin];
  const m = mac([account(), parked('W')]);
  await m.at(0);
  assert.equal(m.rec.read('card', 'W').doc.state, 'waiting');
  assert.equal(m.rec.read('card', 'W').doc.wait.who, 'dispatcher', 'before the limit the card stays the Dispatcher\'s to resume');
  assert.ok(!m.told.some((t) => DAY_TOLD.test(t)), 'not told before the limit');
  const past = limit + 1;
  renewAccount(m.rec, past);
  await m.at(past);
  const w = m.rec.read('card', 'W').doc;
  assert.deepEqual([w.state, w.wait.who], ['waiting', 'joe'], JSON.stringify(w.wait));
  assert.match(w.wait.what, /^usage_unknown/);
  assert.equal(m.told.filter((t) => /card W: usage has been unreadable for over a day, so it can't resume by itself; it waits on you/.test(t)).length, 1, m.told.join(' | '));
  assert.equal(m.told.filter((t) => /^usage has been unreadable for over a day; parked work waits on you/.test(t)).length, 1, m.told.join(' | '));
  assert.ok(m.rec.read('fact', UNKNOWN_FACT)?.doc?.told_at, 'the stretch is marked told');
  // The next tick tells neither again.
  await m.at(past + 1);
  assert.equal(m.told.filter((t) => DAY_TOLD.test(t)).length, 2, m.told.join(' | '));
});

test('no usage reading: an unknown-band alert that is lost is sent again on the next tick, and then only once', async () => {
  const alert = fakeAlert({ answer: (_, n) => n !== 0 });
  const m = mac([account(), card('A')], { alert });
  await m.at(0);
  assert.equal(alert.answers[0], false, 'the first alert was the one lost');
  assert.deepEqual(m.told, [], 'nothing reached Joe on the first tick');
  await m.at(1);
  await m.at(2);
  await m.at(3);
  assert.equal(m.told.filter((t) => UNKNOWN_TOLD.test(t)).length, 1, m.told.join(' | '));
});

test('no usage reading: Joe\'s Undo still starts (the band never holds an undo)', async () => {
  const m = mac([account(), ...undoEntries('U-1')]);
  await m.at(0);
  assert.deepEqual(m.launched, ['U-1']);
});
