// told.test.mjs — when a told time counts as told recently enough to stay quiet (L309 MAT-2, L315, L317).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toldRecently, REPEAT_MS, FUTURE_SLACK_MS } from './told.mjs';

test('told under a day ago is quiet; a day or more, or a time over a minute ahead, or no time, tells', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const H = 60 * 60_000;
  assert.equal(REPEAT_MS, 24 * H);
  assert.equal(FUTURE_SLACK_MS, 60_000);
  assert.equal(toldRecently(now - 2 * H, now), true);
  assert.equal(toldRecently(now - REPEAT_MS + 1, now), true);
  assert.equal(toldRecently(now - REPEAT_MS, now), false);
  assert.equal(toldRecently(now - 25 * H, now), false);
  assert.equal(toldRecently(now + 30_000, now), true, 'a few seconds ahead: clocks differ a little');
  assert.equal(toldRecently(now + 61_000, now), false);
  assert.equal(toldRecently(now + 30 * 24 * H, now), false, '30 days ahead');
  for (const bad of [undefined, null, NaN, Infinity, '2026-11-03']) assert.equal(toldRecently(bad, now), false);
});
