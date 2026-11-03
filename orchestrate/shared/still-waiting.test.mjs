// still-waiting.test.mjs — the told-again rule for anything that still waits (L315). Run: node --test orchestrate/shared/still-waiting.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillWaiting, dueToTell, pastTime, STILL_WAITING_MS, FUTURE_SKEW_MS } from './still-waiting.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const H = 60 * 60_000;

/** A mark kept in memory, and the alerts sent; `deliver` answers each send. */
function site({ deliver = () => true } = {}) {
  let mark = null;
  const sent = [];
  const at = (now, waiting, opts = {}) => stillWaiting({
    waiting, now, ...opts,
    read: () => mark,
    tell: (fields) => { const ok = deliver(sent.length); sent.push(now); if (ok) mark = { ...mark, ...fields }; return ok; },
    clear: () => { mark = { ...mark, told_at: null }; },
  }).did;
  return { at, sent, get mark() { return mark; }, set mark(m) { mark = m; } };
}

test('STILL_WAITING_MS is a day', () => assert.equal(STILL_WAITING_MS, 24 * H));

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
  assert.equal(s.at(T0 + 2 * H, false), 'idle', 'cleared once, not every pass');
  assert.equal(s.at(T0 + 3 * H, true), 'told', 'back within the day: told at once, not held by the old day clock');
  assert.equal(s.sent.length, 2);
});

test('an alert that was not delivered leaves no mark, so the next pass tells again', () => {
  const s = site({ deliver: (n) => n > 0 });
  assert.equal(s.at(T0, true), 'told');
  assert.equal(s.mark, null);
  assert.equal(s.at(T0 + 60_000, true), 'told');
  assert.ok(s.mark.told_at);
  assert.equal(s.at(T0 + 2 * 60_000, true), 'quiet');
});

test('a state that can\'t be read counts as still waiting: told', () => {
  const s = site();
  assert.equal(s.at(T0, () => { throw new Error('unreadable'); }), 'told');
  assert.equal(s.at(T0 + 25 * H, undefined), 'told', 'anything but an explicit false waits');
  assert.equal(s.at(T0 + 50 * H, () => null), 'told');
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
  for (const bad of [undefined, null, '', 'garbage', 12, {}]) assert.equal(pastTime(bad, T0), null, String(bad));
});

test('`every` sets the repeat (a paused product, weekly)', () => {
  const s = site();
  const week = 7 * 24 * H;
  s.at(T0, true, { every: week });
  assert.equal(s.at(T0 + 3 * 24 * H, true, { every: week }), 'quiet');
  assert.equal(s.at(T0 + week, true, { every: week }), 'told');
});

test('tell\'s answer is passed back, and the mark it gets is { told_at } only', () => {
  let got;
  const r = stillWaiting({ waiting: true, now: T0, read: () => null, tell: (f) => { got = f; return 'queued'; }, clear: () => {} });
  assert.deepEqual(r, { did: 'told', answer: 'queued' });
  assert.deepEqual(got, { told_at: new Date(T0).toISOString() });
});

test('dueToTell alone', () => {
  assert.equal(dueToTell(null, T0), true);
  assert.equal(dueToTell({ told_at: new Date(T0 - H).toISOString() }, T0), false);
  assert.equal(dueToTell({ told_at: new Date(T0 - 24 * H).toISOString() }, T0), true);
});
