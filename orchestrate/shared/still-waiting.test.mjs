// still-waiting.test.mjs — the told-again rule for anything that still waits (L315). Run: node --test orchestrate/shared/still-waiting.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillWaiting, dueToTell, pastTime, repeatOf, STILL_WAITING_MS, FUTURE_SKEW_MS, StillWaitingError } from './still-waiting.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const H = 60 * 60_000;
const MIN = 60_000;

/** A mark kept in memory, and the alerts sent; `deliver` answers each send. */
function site({ deliver = () => true } = {}) {
  let mark = null;
  const sent = [];
  let clears = 0;
  const at = (now, waiting, opts = {}) => stillWaiting({
    waiting, now, ...opts,
    read: () => mark,
    tell: (fields) => { const ok = deliver(sent.length); sent.push(now); if (ok) mark = { ...mark, ...fields }; return ok; },
    clear: () => { clears += 1; if (mark?.told_at != null) mark = { ...mark, told_at: null }; },
  }).did;
  return { at, sent, get clears() { return clears; }, get mark() { return mark; }, set mark(m) { mark = m; } };
}

/** M11's order: tell queues the alert with its mark; the mark is written only when the queue is delivered. */
function queued() {
  let mark = null;
  let queue = [];
  const delivered = [];
  const run = (now, waiting) => stillWaiting({
    waiting, now,
    read: () => mark,
    tell: (fields) => { queue = [{ text: 'Y still waits', fields }]; return true; },
    clear: () => { queue = []; if (mark?.told_at != null) mark = { ...mark, told_at: null }; },
  }).did;
  const deliver = () => { for (const e of queue) { delivered.push(e.text); mark = { ...mark, ...e.fields }; } queue = []; };
  return { run, deliver, delivered, get queue() { return queue; } };
}

test('STILL_WAITING_MS is a day and FUTURE_SKEW_MS a minute', () => {
  assert.equal(STILL_WAITING_MS, 24 * H);
  assert.equal(FUTURE_SKEW_MS, 60_000);
});

test('told at first, quiet at +2 h, told again at +25 h, and every day after while it still waits', () => {
  const s = site();
  assert.equal(s.at(T0, true), 'told');
  assert.equal(s.at(T0 + 2 * H, true), 'quiet');
  assert.equal(s.at(T0 + 24 * H - 1, true), 'quiet');
  assert.equal(s.at(T0 + 25 * H, true), 'told');
  assert.equal(s.at(T0 + 30 * H, true), 'quiet');
  assert.equal(s.at(T0 + 49 * H, true), 'told');
  assert.equal(s.sent.length, 3);
  assert.equal(s.mark.told_at, new Date(T0 + 49 * H).toISOString(), 'told_at is kept, as the day clock');
});

test('cleared when it ends; idle while nothing waits; told afresh if it comes back after clearing', () => {
  const s = site();
  s.at(T0, true);
  assert.equal(s.at(T0 + H, false), 'cleared');
  assert.equal(s.mark.told_at, null);
  assert.equal(s.at(T0 + 2 * H, false), 'idle', 'nothing left to clear');
  assert.equal(s.clears, 2, 'clear is still called on every pass the wait has ended');
  assert.equal(s.at(T0 + 3 * H, true), 'told', 'back within the day: told at once, not held by the old day clock');
  assert.equal(s.sent.length, 2);
});

test('an alert that was not delivered leaves no mark, so the next pass tells again', () => {
  const s = site({ deliver: (n) => n > 0 });
  assert.equal(s.at(T0, true), 'unsent', 'tell answered false');
  assert.equal(s.mark, null);
  assert.equal(s.at(T0 + 60_000, true), 'told');
  assert.ok(s.mark.told_at);
  assert.equal(s.at(T0 + 2 * 60_000, true), 'quiet');
});

test('a state that can\'t be read counts as still waiting: told', () => {
  const s = site();
  assert.equal(s.at(T0, () => { throw new Error('unreadable'); }), 'told');
  assert.equal(s.at(T0 + 25 * H, () => { throw new Error('unreadable'); }), 'told', 'and again a day later');
});

test('m4: waiting must answer true or false; a Promise from waiting or read throws, named', () => {
  for (const bad of [undefined, null, 0, 1, 'yes', {}, Promise.resolve(true)]) {
    const s = site();
    assert.throws(() => s.at(T0, bad), StillWaitingError, String(bad));
    assert.throws(() => s.at(T0, () => bad), StillWaitingError, `function answering ${String(bad)}`);
  }
  assert.throws(() => stillWaiting({ waiting: async () => false, now: T0, read: () => null, tell: () => true, clear: () => {} }), /waiting answered a Promise/);
  assert.throws(() => stillWaiting({ waiting: true, now: T0, read: async () => null, tell: () => true, clear: () => {} }), StillWaitingError);
});

test('a mark that can\'t be read counts as none: told, never held silent', () => {
  for (const bad of [{ told_at: 'garbage' }, { told_at: 12 }, { told_at: true }, 'text', 42]) {
    const s = site();
    s.mark = bad;
    assert.equal(s.at(T0, true), 'told', JSON.stringify(bad));
  }
  const thrown = stillWaiting({ waiting: true, now: T0, read: () => { throw new Error('no read'); }, tell: () => true, clear: () => {} });
  assert.equal(thrown.did, 'told');
});

test('L317 MAT-1: a told_at more than 60 s in the future is not told: told now, not held until the clock catches up', () => {
  for (const ahead of [FUTURE_SKEW_MS + 1, H, 10 * 24 * H, 30 * 24 * H]) {
    const s = site();
    s.mark = { told_at: new Date(T0 + ahead).toISOString() };
    assert.equal(s.at(T0, true), 'told', `${ahead} ms ahead`);
    assert.equal(s.at(T0 + 2 * H, true), 'quiet', 'and then the day clock runs from the real tell');
  }
  const skew = site();
  skew.mark = { told_at: new Date(T0 + FUTURE_SKEW_MS).toISOString() };
  assert.equal(skew.at(T0, true), 'quiet', 'up to 60 s of clock skew reads as just told');
});

test('pastTime: unreadable or more than 60 s ahead is null', () => {
  assert.equal(pastTime(new Date(T0 - H).toISOString(), T0), T0 - H);
  assert.equal(pastTime(new Date(T0 + FUTURE_SKEW_MS).toISOString(), T0), T0 + FUTURE_SKEW_MS);
  assert.equal(pastTime(new Date(T0 + FUTURE_SKEW_MS + 1).toISOString(), T0), null);
  for (const bad of [undefined, null, '', 'garbage', 12, {}, T0 - H, new Date(T0 - H)]) assert.equal(pastTime(bad, T0), null, `${String(bad)}: ISO text only`);
});

test('MAT-1: an `every` that is not a finite number above 0 is the 24 h default: never "told once", never "every pass"', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', '3600000', 0, -1, null, undefined]) {
    const s = site();
    assert.equal(s.at(T0, true, { every: bad }), 'told', String(bad));
    assert.equal(s.at(T0 + 2 * H, true, { every: bad }), 'quiet', `${String(bad)}: not every pass`);
    assert.equal(s.at(T0 + 25 * H, true, { every: bad }), 'told', `${String(bad)}: again a day later`);
    for (let d = 2; d <= 30; d++) s.at(T0 + d * 24 * H + H, true, { every: bad });
    assert.equal(s.sent.length, 31, `${String(bad)}: once a day for a month`);
    assert.equal(dueToTell({ told_at: new Date(T0).toISOString() }, T0 + 25 * H, bad), true, String(bad));
    assert.equal(repeatOf(bad), STILL_WAITING_MS);
  }
});

test('m3: now must be a finite time in ms; anything else throws, named', () => {
  for (const bad of [undefined, null, NaN, Infinity, '2026-11-03T12:00:00Z', new Date(T0), () => T0]) {
    assert.throws(() => stillWaiting({ waiting: true, now: bad, read: () => null, tell: () => true, clear: () => {} }), StillWaitingError, String(bad));
    assert.throws(() => stillWaiting({ waiting: false, now: bad, read: () => null, tell: () => true, clear: () => {} }), StillWaitingError, `${String(bad)}, wait ended`);
    assert.throws(() => dueToTell(null, bad), StillWaitingError, String(bad));
  }
});

test('m1: a wait that ends while its alert is still queued drops it: it is never delivered', () => {
  const q = queued();
  assert.equal(q.run(T0, true), 'told');
  assert.equal(q.queue.length, 1, 'queued, not yet delivered: no mark');
  assert.equal(q.run(T0 + MIN, false), 'idle', 'ended with no mark written');
  assert.equal(q.queue.length, 0, 'the queued alert was dropped');
  q.deliver();
  assert.deepEqual(q.delivered, []);
});

test('tell or clear that throws does not break the caller: tell is unsent (told again next pass), clear is passed back', () => {
  let mark = null;
  const boom = () => { throw new Error('boom'); };
  const r1 = stillWaiting({ waiting: true, now: T0, read: () => mark, tell: boom, clear: () => {} });
  assert.equal(r1.did, 'unsent');
  assert.equal(r1.error.message, 'boom');
  const r2 = stillWaiting({ waiting: true, now: T0 + MIN, read: () => mark, tell: (f) => { mark = f; return true; }, clear: () => {} });
  assert.equal(r2.did, 'told');
  const r3 = stillWaiting({ waiting: false, now: T0 + 2 * MIN, read: () => mark, tell: () => true, clear: boom });
  assert.equal(r3.did, 'cleared');
  assert.equal(r3.error.message, 'boom');
});

test('a corrupt mark when the wait ends is cleared too', () => {
  for (const bad of [{ told_at: 'garbage' }, 'text', 42]) {
    let cleared = 0;
    const r = stillWaiting({ waiting: false, now: T0, read: () => bad, tell: () => true, clear: () => { cleared += 1; } });
    assert.equal(r.did, 'cleared', JSON.stringify(bad));
    assert.equal(cleared, 1);
  }
});

test('m5: `since` names the wait; a mark of another wait is told at once, not held by the old mark', () => {
  const s = site();
  assert.equal(s.at(T0, true, { since: 'w1' }), 'told');
  assert.equal(s.mark.since, 'w1', 'kept on the mark');
  assert.equal(s.at(T0 + H, true, { since: 'w1' }), 'quiet');
  // It ended and came back between passes: a new wait.
  assert.equal(s.at(T0 + 2 * H, true, { since: 'w2' }), 'told');
  assert.equal(s.at(T0 + 3 * H, true, { since: 'w2' }), 'quiet');
  assert.equal(dueToTell({ told_at: new Date(T0).toISOString() }, T0 + H, undefined, 'w1'), true, 'a mark with no since, asked for w1');
});

test('m6: `after` tells only once the wait is `limit` old; a since that can\'t be read or is in the future is told now', () => {
  const s = site();
  const since = new Date(T0).toISOString();
  assert.equal(s.at(T0 + H, true, { after: { since, limit: 24 * H } }), 'idle', 'an hour old: not yet');
  assert.equal(s.at(T0 + 24 * H, true, { after: { since, limit: 24 * H } }), 'told');
  assert.equal(s.at(T0 + 30 * H, true, { after: { since, limit: 24 * H } }), 'quiet');
  for (const bad of ['garbage', undefined, null, T0, new Date(T0 + 30 * 24 * H).toISOString()]) {
    const b = site();
    assert.equal(b.at(T0, true, { after: { since: bad, limit: 24 * H } }), 'told', String(bad));
  }
  for (const badLimit of [NaN, Infinity, 'abc', -1, null]) {
    const b = site();
    assert.equal(b.at(T0 + 23 * H, true, { after: { since, limit: badLimit } }), 'idle', `${String(badLimit)}: the 24 h default`);
    assert.equal(b.at(T0 + 24 * H, true, { after: { since, limit: badLimit } }), 'told', String(badLimit));
  }
  const zero = site();
  assert.equal(zero.at(T0, true, { after: { since, limit: 0 } }), 'told', 'a limit of 0 tells at once');
});

test('`every` sets the repeat (a paused product, weekly)', () => {
  const s = site();
  const week = 7 * 24 * H;
  s.at(T0, true, { every: week });
  assert.equal(s.at(T0 + 3 * 24 * H, true, { every: week }), 'quiet');
  assert.equal(s.at(T0 + week, true, { every: week }), 'told');
});

test('tell\'s answer is passed back, and the mark it gets is { told_at } (and since, when given) only', () => {
  let got;
  const r = stillWaiting({ waiting: true, now: T0, read: () => null, tell: (f) => { got = f; return 'queued'; }, clear: () => {} });
  assert.deepEqual(r, { did: 'told', answer: 'queued' });
  const withSince = [];
  stillWaiting({ waiting: true, now: T0, since: 'w', read: () => null, tell: (f) => { withSince.push(f); return true; }, clear: () => {} });
  assert.deepEqual(withSince, [{ told_at: new Date(T0).toISOString(), since: 'w' }]);
  assert.deepEqual(got, { told_at: new Date(T0).toISOString() });
});

test('dueToTell alone', () => {
  assert.equal(dueToTell(null, T0), true);
  assert.equal(dueToTell({ told_at: new Date(T0 - H).toISOString() }, T0), false);
  assert.equal(dueToTell({ told_at: new Date(T0 - 24 * H).toISOString() }, T0), true);
});
