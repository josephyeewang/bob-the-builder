// drain-alerts.test.mjs — L896: an ended worker runner session whose outbox stays undrained is told to the owner, once
// per cause and then daily, through timeLimits' drainHolds port and the real alert queue. A status that can't be read
// is told as such and clears nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLimits } from './merges.mjs';
import { DRAIN_CAUSES, DRAIN_HOLD_FACT, DRAIN_UNKNOWN_FACT, relayDrainHolds } from './drain-alerts.mjs';
import { rulesWith, recWith, T0, MIN, withAlerts } from './fixtures.test-helper.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';

const R = rulesWith();
const DAY = 24 * 60 * MIN;
const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const held = (session, cause, card = 'C-1') => ({ session, card, product: 'p1', cause, since: new Date(T0).toISOString() });

function world() {
  const rec = recWith();
  // As the tick runs it: queued, then sent, the told mark written only once a copy is delivered.
  const run = async (at, drainHolds, deliver = true) => {
    const got = [];
    await withAlerts(rec, at, (t) => { got.push(t); return deliver; },
      (alert) => timeLimits({ rec, rules: R, now: at, b: GREEN, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), drainHolds, alert }));
    return got;
  };
  return { rec, run };
}

test('L896: an undrained outbox is told at once, again each day it lasts, afresh when its cause changes, and again once it returns', async () => {
  const w = world();
  const got = await w.run(T0, () => [held(S1, 'not-taken')]);
  assert.equal(got.length, 1);
  assert.match(got[0], new RegExp(`^worker runner: session ${S1} \\(card C-1\\) has ended, but its outbox stays open: a file in it was never taken in or told\\.`));
  assert.ok(w.rec.read('fact', DRAIN_HOLD_FACT(S1))?.doc?.told_at, 'marked once delivered');
  assert.deepEqual(await w.run(T0 + MIN, () => [held(S1, 'not-taken')]), [], 'quiet inside the day');
  assert.deepEqual(await w.run(T0 + DAY - MIN, () => [held(S1, 'not-taken')]), []);
  assert.equal((await w.run(T0 + DAY + MIN, () => [held(S1, 'not-taken')])).length, 1, 'told again a day on');
  const c = await w.run(T0 + DAY + 2 * MIN, () => [held(S1, 'hash-mismatch')]);
  assert.equal(c.length, 1, 'a new cause is told at once');
  assert.match(c[0], /a file changed after the Record took it/);
  // Drained: its mark cleared, so a return is told afresh at once.
  assert.deepEqual(await w.run(T0 + DAY + 3 * MIN, () => []), []);
  assert.equal(w.rec.read('fact', DRAIN_HOLD_FACT(S1))?.doc?.told_at ?? null, null, 'the mark is cleared');
  assert.equal((await w.run(T0 + DAY + 4 * MIN, () => [held(S1, 'hash-mismatch')])).length, 1, 'a return is told afresh');
});

test('L896: each session is its own hold; one going does not clear another', async () => {
  const w = world();
  assert.equal((await w.run(T0, () => [held(S1, 'in-flight'), held(S2, 'dot-name', 'C-2')])).length, 2);
  assert.deepEqual(await w.run(T0 + MIN, () => [held(S2, 'dot-name', 'C-2')]), []);
  assert.ok(w.rec.read('fact', DRAIN_HOLD_FACT(S2)).doc.told_at, 'S2 still marked');
  assert.deepEqual(await w.run(T0 + 2 * MIN, () => [held(S2, 'dot-name', 'C-2')]), [], 'and still quiet');
});

test('L896: not delivered is not marked, so it is sent again next pass', async () => {
  const w = world();
  assert.equal((await w.run(T0, () => [held(S1, 'not-taken')], false)).length, 1);
  assert.equal(w.rec.read('fact', DRAIN_HOLD_FACT(S1))?.doc?.told_at, undefined);
  assert.equal((await w.run(T0 + MIN, () => [held(S1, 'not-taken')])).length, 1, 'sent again');
});

test('L896: a status that can\'t be read is told on its own hold and clears no session\'s hold; read again, that hold clears', async () => {
  const w = world();
  await w.run(T0, () => [held(S1, 'not-taken')]);
  for (const [i, port] of [() => { throw new Error('the status is 9 minutes old'); }, async () => { throw new Error('EIO'); }, () => null, () => 'x', () => ({}),
    () => [held(S1, 'not-taken'), { session: S2, cause: 'no-such-cause' }], () => [null], () => [{ cause: 'not-taken' }], () => [{ session: '', cause: 'not-taken' }]].entries()) {
    const got = await w.run(T0 + (i + 1) * MIN, port);
    if (i === 0) {
      assert.equal(got.length, 1, 'told once');
      assert.match(got[0], /^worker runner: its status could not be read, so whether an ended session's outbox is stuck open is not known \(the status is 9 minutes old\)/);
    } else assert.deepEqual(got, [], `the same unknown, quiet inside the day (${i})`);
    assert.ok(w.rec.read('fact', DRAIN_HOLD_FACT(S1)).doc.told_at, `S1's hold is kept (${i})`);
  }
  assert.ok(w.rec.read('fact', DRAIN_UNKNOWN_FACT).doc.told_at);
  assert.deepEqual(await w.run(T0 + 20 * MIN, () => [held(S1, 'not-taken')]), [], 'readable again: S1 still quiet, nothing new');
  assert.equal(w.rec.read('fact', DRAIN_UNKNOWN_FACT)?.doc?.told_at ?? null, null, 'the unknown hold is cleared');
  // A bad entry is told with its own words.
  const v = world();
  const got = await v.run(T0, () => [{ session: S2, cause: 'no-such-cause' }]);
  assert.match(got[0], /a held outbox in it is not what the status reader gives/);
});

test('L896: every cause in the one list has its own words; no drainHolds port tells nothing', async () => {
  const seen = new Set();
  for (const cause of DRAIN_CAUSES) {
    const alert = fakeAlert();
    const rec = recWith();
    assert.equal(relayDrainHolds({ rec, held: [held(S1, cause)], alert, now: T0, report: (l) => assert.fail(l) }), 1, cause);
    const text = alert.texts[0];
    assert.doesNotMatch(text, /undefined/, cause);
    seen.add(text);
  }
  assert.equal(seen.size, DRAIN_CAUSES.length, 'no two causes share words');
  const w = world();
  assert.deepEqual(await w.run(T0, undefined), []);
  assert.deepEqual(w.rec.list('fact').filter((f) => f.id.startsWith('hold-drain-')), []);
});

test('L896: an alert that can\'t be queued is reported, and tried again next pass', () => {
  const rec = recWith();
  const lines = [];
  const alert = fakeAlert({ answer: false });
  assert.equal(relayDrainHolds({ rec, held: [held(S1, 'not-taken')], alert, now: T0, report: (l) => lines.push(l) }), 0);
  assert.deepEqual(lines, ['the undrained outbox alert could not be queued; it is tried again next pass']);
  const ok = fakeAlert();
  assert.equal(relayDrainHolds({ rec, held: [held(S1, 'not-taken')], alert: ok, now: T0 + MIN, report: (l) => assert.fail(l) }), 1);
});

test('#425 r1 m3: a copy queued but not delivered, then drained, is dropped: nothing is sent', async () => {
  const w = world();
  assert.equal((await w.run(T0, () => [held(S1, 'not-taken')], false)).length, 1, 'tried, not delivered');
  assert.equal(w.rec.read('fact', DRAIN_HOLD_FACT(S1))?.doc?.told_at, undefined, 'not marked');
  assert.deepEqual(await w.run(T0 + MIN, () => []), [], 'drained: the queued copy is not sent');
  assert.deepEqual(await w.run(T0 + 2 * MIN, () => []), []);
});

test('#425 r1 c2, m1: the session and card are told as plain text; the alert says not to delete the outbox', () => {
  const alert = fakeAlert();
  relayDrainHolds({ rec: recWith(), held: [{ session: 'S\nX\tY\rZ', card: 'C\n1', product: 'p1', cause: 'not-taken', since: new Date(T0).toISOString() }], alert, now: T0, report: (l) => assert.fail(l) });
  const [text] = alert.texts;
  assert.doesNotMatch(text, /[\r\n\t]/, 'no line breaks or tabs (alerts.mjs plain)');
  assert.match(text, /^worker runner: session S X Y Z \(card/);
  assert.match(text, /\(card C 1\)/);
  assert.match(text, /Do not delete the outbox: a file in it may not be in the Record yet, and an outbox that is gone counts as drained$/);
  const a = fakeAlert();
  relayDrainHolds({ rec: recWith(), held: [held(S1, 'outbox-unreadable')], alert: a, now: T0, report: (l) => assert.fail(l) });
  assert.match(a.texts[0], /its outbox stays open: the outbox folder itself can't be listed\./);
});

// #425 r1 M2: a relay that throws is reported as itself; the time-limits step ends as it would have without it, and a
// review-status error is still the one it throws. The review relay beside it is wrapped the same way (the class).
test('#425 r1 M2: a drain or review relay that throws is reported, and changes nothing else in the step', async () => {
  const boom = (alert, lead) => (t, o) => { if (String(t).startsWith(lead)) throw new Error('queue write refused'); return alert(t, o); };
  const base = { rules: R, now: T0, b: GREEN, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }) };
  for (const [lead, over] of [['worker runner:', { drainHolds: () => [held(S1, 'not-taken')] }],
    ['review runner:', { reviewAlerts: () => [{ id: 'gave-up-x', at: new Date(T0).toISOString(), text: 'card C-1: 3 starts failed' }] }]]) {
    const rec = recWith();
    const logged = [];
    const got = [];
    const done = await withAlerts(rec, T0, (t) => { got.push(t); return true; },
      (alert) => timeLimits({ rec, ...base, ...over, alert: boom(alert, lead), failureLog: (l) => logged.push(l) }));
    const plainRun = await withAlerts(recWith(), T0, () => true, (alert) => timeLimits({ rec: recWith(), ...base, alert }));
    assert.deepEqual(done, plainRun, `${lead} the step's answer is unchanged`);
    assert.equal(logged.length, 1, lead);
    assert.match(logged[0], lead === 'worker runner:' ? /^the undrained-outbox relay failed: queue write refused$/ : /^the review alert relay failed: queue write refused$/);
    assert.ok(got.some((t) => t.startsWith('the Dispatcher: the ')), `${lead} the failure is told`);
    // With a review-status error too, that error is still the one thrown.
    await assert.rejects(() => withAlerts(recWith(), T0, () => true, (alert) => timeLimits({ rec: recWith(), ...base, ...over,
      hasReviewer: () => { throw new Error('the review runner\'s status is 4 minutes old'); },
      rec: (() => { const r = recWith([['card', 'C-1', { state: 'in_review', head: 'a'.repeat(40), tier: 2, product: 'p1', changed_at: new Date(T0 - 60 * MIN).toISOString() }]]); return r; })(),
      alert: boom(alert, lead) })), /no review was asked for: /, lead);
  }
});
