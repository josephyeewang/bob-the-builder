import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, readSize, readTranscriptFile, atSafePoint } from './transcript.mjs';

const asst = (usage, { side = false, stop = 'end_turn', tools = [], model = 'claude-x' } = {}) => ({
  type: 'assistant', isSidechain: side,
  message: { model, stop_reason: stop, usage, content: [{ type: 'text', text: 'ok' }, ...tools.map((id) => ({ type: 'tool_use', id, name: 'Bash' }))] },
});
const user = (results = [], side = false) => ({ type: 'user', isSidechain: side, message: { content: results.length ? results.map((id) => ({ type: 'tool_result', tool_use_id: id })) : 'hi' } });
const u = (i, cc, cr, out = 999) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out });
const boundary = { type: 'system', subtype: 'compact_boundary' };
const lines = (...es) => es.map((e) => JSON.stringify(e)).join('\n');

test('R-0b-62 / M17: five planted transcripts give the expected sizes', () => {
  const cases = [
    // 1. plain: the last assistant entry, never a sum, output excluded
    [lines(user(), asst(u(10, 100, 1000)), user(), asst(u(20, 200, 30_000))), 30_220],
    // 2. a helper (sidechain) entry after the main one is ignored
    [lines(user(), asst(u(5, 5, 50_000)), asst(u(1, 1, 999_999), { side: true })), 50_010],
    // 3. after a compaction boundary, only later entries count; before any, unknown
    [lines(user(), asst(u(1, 1, 380_000)), boundary, user()), null],
    [lines(user(), asst(u(1, 1, 380_000)), boundary, user(), asst(u(3, 4, 40_000))), 40_007],
    // 4. a synthetic entry and a compaction summary are skipped
    [lines(user(), asst(u(7, 0, 120_000)), asst(u(0, 0, 0), { model: '<synthetic>' }), { ...asst(u(9, 9, 9)), isCompactSummary: true }), 120_007],
    // 5. a half-written last line and missing fields
    [`${lines(user(), asst({ input_tokens: 260_000 }))}\n{"type":"assist`, 260_000],
  ];
  cases.forEach(([text, want], i) => assert.equal(readSize(parseTranscript(text)).tokens, want, `case ${i + 1}`));
});

test('M19: compaction boundaries are counted', () => {
  assert.equal(readSize(parseTranscript(lines(user(), boundary, asst(u(1, 1, 1)), boundary))).compactions, 2);
  assert.equal(readSize(parseTranscript(lines(user(), asst(u(1, 1, 1))))).compactions, 0);
  // a "compact_boundary" that is not a system entry is not one
  assert.equal(readSize(parseTranscript(lines({ type: 'user', subtype: 'compact_boundary' }))).compactions, 0);
});

test('M18: turn ended and open tool calls', () => {
  const ended = readSize(parseTranscript(lines(user(), asst(u(1, 1, 1)))));
  assert.equal(ended.turnEnded, true);
  const midTool = readSize(parseTranscript(lines(user(), asst(u(1, 1, 1), { stop: 'tool_use', tools: ['t1'] }))));
  assert.equal(midTool.turnEnded, false);
  assert.deepEqual(midTool.openTools, ['t1']);
  const answered = readSize(parseTranscript(lines(user(), asst(u(1, 1, 1), { stop: 'tool_use', tools: ['t1'] }), user(['t1']))));
  assert.deepEqual(answered.openTools, []);
  assert.equal(answered.turnEnded, false); // the last entry is the tool result: the turn goes on
  // a helper's open tool is not the main chain's
  assert.deepEqual(readSize(parseTranscript(lines(asst(u(1, 1, 1), { side: true, tools: ['h1'] }), asst(u(1, 1, 1))))).openTools, []);
  // a stop reason other than end_turn is not a finished turn
  assert.equal(readSize(parseTranscript(lines(user(), asst(u(1, 1, 1), { stop: 'max_tokens' })))).turnEnded, false);
  // a turn that ended but still has an open tool is not ended
  assert.equal(readSize(parseTranscript(lines(asst(u(1, 1, 1), { tools: ['t9'] })))).turnEnded, false);
});

test('M7: the safe point for a worker and for the Lead', () => {
  const free = { openTools: [], turnEnded: false };
  const busy = { openTools: ['t1'], turnEnded: false };
  assert.equal(atSafePoint({ role: 'worker', size: free }), true);
  assert.equal(atSafePoint({ role: 'worker', size: busy }), false);
  assert.equal(atSafePoint({ role: 'worker', size: free, activity: { state: 'blocked' } }), false);
  assert.equal(atSafePoint({ role: 'worker', size: null }), false);
  assert.equal(atSafePoint({ role: 'worker', size: busy, activity: { state: 'exited' } }), true);
  const done = { openTools: [], turnEnded: true };
  assert.equal(atSafePoint({ role: 'lead', size: done, activity: { state: 'idle' } }), true);
  assert.equal(atSafePoint({ role: 'lead', size: done, activity: { state: 'waiting_input' } }), false);
  assert.equal(atSafePoint({ role: 'lead', size: done, activity: { state: 'active' } }), false);
  assert.equal(atSafePoint({ role: 'front_door', size: free, activity: { state: 'idle' } }), false);
});

test('an unreadable file is unknown, not zero', () => {
  assert.equal(readTranscriptFile('/nowhere', { read: () => { throw new Error('gone'); } }), null);
  assert.equal(readTranscriptFile('x', { read: () => lines(asst(u(1, 2, 3))) }).tokens, 6);
});
