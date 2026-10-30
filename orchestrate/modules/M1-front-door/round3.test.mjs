// round3.test.mjs — planted cases for the 0b-8 audit round 3 findings. Each test fails on the code before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joeTurns, checkTapTest } from './transcript.mjs';
import { shouldRestartFrontDoor } from './restart.mjs';
import { outboxFile, checkOutboxFile } from './outbox.mjs';
import { typed, said, asks, result, T0, iso } from './fixtures.mjs';
import { FAKE, run } from '../M12-sensors/fakes.mjs';

const at = (min) => () => new Date(T0 + min * 60e3);
const queuedRaw = (min, attachment) => ({ type: 'attachment', uuid: `q3-${min}`, timestamp: iso(min),
  attachment: { type: 'queued_command', timestamp: iso(min), ...attachment } });

test('0b-8 audit round 3 M-1: a queued image, or a queued message with no origin, is Joe acting; no restart 5 minutes later', () => {
  const base = [typed(0, 'hi'), said(1, 'hello')];
  const image = [...base, queuedRaw(20, { prompt: [{ type: 'image', source: { type: 'base64', data: 'x' } }], origin: { kind: 'human' } }), said(22, 'got it')];
  assert.deepEqual(joeTurns(image).map((t) => t.text), ['hi', '[image]']);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: image, now: at(25) }).restart, false);
  const noOrigin = [...base, queuedRaw(20, { prompt: 'and the other one', commandMode: 'prompt' }), said(22, 'ok')];
  assert.equal(joeTurns(noOrigin).length, 2);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: noOrigin, now: at(25) }).restart, false);
  // still not his: a notice, another session's message, a meta entry
  for (const a of [{ prompt: 'done', origin: { kind: 'task-notification' } }, { prompt: 'from lane 2', origin: { kind: 'peer' } }, { prompt: 'x', isMeta: true }]) {
    assert.equal(joeTurns([...base, queuedRaw(20, a), said(22, 'ok')]).length, 1, JSON.stringify(a.origin ?? a));
  }
});

test('0b-8 audit round 3 M-2: a key in an outbox file name is refused, never written as a record id', () => {
  const pause = JSON.stringify({ product: 'test-product', state: 'paused', until: null, tz: null });
  for (const name of [`state-${FAKE.anthropic}.json`, `request-wrapup-${run(48, 15)}.json`, `state-${FAKE.github}.json`, 'state-trip-1.json']) {
    const c = checkOutboxFile(name, name.startsWith('request') ? '{"request":"wrapup","product":null,"name":null}' : pause);
    assert.equal(c.ok, false, name.slice(0, 12));
    assert.equal(JSON.stringify(c).includes(name.slice(6, 20)), false);
  }
  assert.equal(outboxFile('idea', run(40, 3), 'x').ok, false);
  assert.equal(outboxFile('idea', '20261103-0915-kq', 'x').ok, true);
  assert.equal(checkOutboxFile('state-20261103-0915-kq.json', pause).ok, true);
});

test('0b-8 audit round 3 minor 1: a question that mentions [watchdog] does not hide Joe\'s real answer', () => {
  const q = { ...asks(10, 'call-1', 'Should [watchdog] alerts go to the phone?') };
  const ans = { ...result(20, 'call-1', 'User has answered your questions: "Should [watchdog] alerts go to the phone?"="Yes". You can now continue.'),
    toolUseResult: { questions: [], answers: { 'Should [watchdog] alerts go to the phone?': 'Yes' } } };
  const log = [typed(0, 'hi'), said(1, 'hello'), q, ans, said(21, 'done')];
  assert.equal(joeTurns(log).at(-1).kind, 'answer');
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: log, now: at(25) }).restart, false);
  const typedKeys = { ...result(20, 'call-1', 'x'), toolUseResult: { questions: [], answers: { q: '[watchdog] still running?' } } };
  assert.equal(joeTurns([typed(0, 'hi'), q, typedKeys]).length, 1, 'keys typed into the box are still not Joe');
});
