import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRestartFrontDoor, makeFrontDoorHandoff, HANDOFF_BUDGET_CHARS } from './restart.mjs';
import { typed, said, asks, result, tool, T0 } from './fixtures.mjs';
import { FAKE } from '../M12-sensors/fakes.mjs';

const at = (min) => () => new Date(T0 + min * 60e3);

test('MAT-1: 260k with a question box open does not restart (250k compaction is the launcher\'s)', () => {
  const entries = [typed(0, 'trip?'), asks(1, 'q-1')];
  const r = shouldRestartFrontDoor({ sizeTokens: 260_000, entries, now: at(60) });
  assert.equal(r.restart, false);
  assert.equal(r.reason, 'question open; compaction at 250k is the launcher\'s');
});

test('not past 150k, unknown size, or mid-turn: no restart', () => {
  const quietDone = [typed(0, 'hi'), said(1, 'hello')];
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 150_000, entries: quietDone, now: at(60) }).restart, false);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: undefined, entries: quietDone, now: at(60) }).restart, false);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: [typed(0, 'hi'), tool(1, 't-1')], now: at(60) }).restart, false);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries: quietDone, now: at(60) }).restart, true);
});

test('MAT-2: a Dispatcher line at minute 10 does not reset quiet', () => {
  const entries = [typed(0, 'pause the test product'), said(1, 'Paused.'), typed(10, '[watchdog] still there?'), said(10, 'Yes.')];
  const r = shouldRestartFrontDoor({ sizeTokens: 200_000, entries, now: at(16) });
  assert.equal(r.restart, true, r.reason);
});

test('MAT-2: a question-box answer at minute 10 does reset quiet', () => {
  const entries = [typed(0, 'trip'), said(1, 'ok'), asks(9, 'q-1'), result(10, 'q-1', 'Europe/Prague'), said(10, 'Recorded.')];
  const r = shouldRestartFrontDoor({ sizeTokens: 200_000, entries, now: at(16) });
  assert.equal(r.restart, false);
  assert.match(r.reason, /last active 6 min ago/);
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries, now: at(25) }).restart, true);
});

test('MAT-2: 200 open asks in the record and no open box → restart; the handoff lists some and points to the rest', () => {
  const entries = [typed(0, 'what is waiting?'), said(1, 'Lots.')];
  assert.equal(shouldRestartFrontDoor({ sizeTokens: 200_000, entries, now: at(30) }).restart, true);
  const openAsks = Array.from({ length: 200 }, (_, i) => ({ id: `ask-${i}`, what: `Approve change number ${i} to the pricing page copy`, link: `https://example.invalid/pr/${i}` }));
  const text = makeFrontDoorHandoff({ entries, openAsks, now: at(30) });
  assert.ok(text.length <= HANDOFF_BUDGET_CHARS, String(text.length));
  assert.match(text, /- and \d+ more: see the waiting list/);
  assert.match(text, /ask-0:/);
  assert.match(text, /Joe \(message, .*\): .*what is waiting\?/);
});

test('MAT-3: a planted GitHub key and a connection-string password come out of the handoff masked', () => {
  const pw = FAKE.dbPassword;
  const entries = [typed(0, `here is the key ${FAKE.github} and postgres://app:${pw}@db.example.invalid/main`), said(1, `Noted ${FAKE.github}`)];
  const text = makeFrontDoorHandoff({ entries, openAsks: [{ id: 'a1', what: `rotate ${FAKE.anthropic}` }], now: at(30) });
  for (const s of [FAKE.github, pw, FAKE.anthropic]) assert.equal(text.includes(s), false);
  assert.match(text, /REDACTED/);
  assert.match(text, /<outside-text source="front-door-turn">/);
  assert.match(text, /<outside-text source="record-ask">/);
});

test('the 9,000-character budget holds; oldest turns go first; R6 six sections present', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push(typed(i * 2, `message ${i} ${'words '.repeat(400)}`), said(i * 2 + 1, `reply ${i} ${'more '.repeat(300)}`));
  const text = makeFrontDoorHandoff({ entries, strikes: 2, rereadList: ['config/front-door.md'], now: at(60) });
  assert.ok(text.length <= HANDOFF_BUDGET_CHARS, String(text.length));
  assert.equal(text.includes('message 6 '), false, 'only the last 5 turns are ever considered');
  assert.match(text, /older message\(s\) left out/);
  assert.match(text, /message 11 /, 'the newest turn survives');
  for (const h of ['## 1. Decisions', '## 2. Open questions', '## 3. Current step', '## 4. Tried and failed', '## 5. Re-read list', '## 6. Don\'t redo']) assert.ok(text.includes(h), h);
  assert.match(text, /strikes: 2/);
  // a single turn larger than the budget is dropped, never sent cut in half
  const huge = makeFrontDoorHandoff({ entries: [typed(0, 'x'.repeat(50_000)), said(1, 'ok')], now: at(60) });
  assert.ok(huge.length <= HANDOFF_BUDGET_CHARS);
  assert.match(huge, /1 older message/);
});
