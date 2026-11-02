import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResult, applyResult, CHECKED_AGAINST } from './headless-result.mjs';
import { recWith, T0 } from './fixtures.test-helper.mjs';

const res = (subtype, over = {}) => JSON.stringify({ type: 'result', subtype, is_error: subtype !== 'success', ...over });

test('m10: a turn cap or budget cap stop is budget_stop', () => {
  assert.equal(readResult(res('error_max_turns')).outcome, 'budget_stop');
  assert.equal(readResult(res('error_max_budget_usd')).outcome, 'budget_stop');
  assert.equal(readResult(res('error_max_structured_output_retries')).outcome, 'budget_stop');
});

test('m10: success, a failed run, and the shapes of output', () => {
  assert.deepEqual(readResult(res('success')), { outcome: 'success', subtype: 'success' });
  assert.equal(readResult(res('success', { is_error: true })).outcome, 'failed');
  assert.equal(readResult(res('error_during_execution')).outcome, 'failed');
  // stream output: the last line is the result
  assert.equal(readResult(`{"type":"system"}\n${res('error_max_turns')}\n`).outcome, 'budget_stop');
  // an array of messages: the last result in it
  assert.equal(readResult(JSON.stringify([{ type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false }])).outcome, 'success');
});

test('m10: unreadable output is never success', () => {
  for (const s of ['', 'not json', '{"type":"assistant"}', '{"type":"result"}', null, undefined, '[]']) assert.equal(readResult(s).outcome, 'unreadable', String(s));
});

test('m10: a budget stop or unreadable result -> the card waits on Joe with budget_stop; never a fix card', () => {
  for (const out of [res('error_max_budget_usd'), 'garbage']) {
    const rec = recWith([['card', 'C-1', { state: 'running' }]]);
    assert.equal(applyResult(rec, 'C-1', out, { now: T0 }).moved, true);
    const c = rec.read('card', 'C-1').doc;
    assert.equal(c.state, 'waiting');
    assert.equal(c.wait.who, 'joe');
    assert.match(c.wait.what, /^budget_stop/);
    assert.equal(rec.list('card').length, 1);
  }
});

test('m10: a failed run -> failed; success leaves the card to the report intake', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['card', 'C-2', { state: 'running' }]]);
  applyResult(rec, 'C-1', res('error_during_execution'), { now: T0 });
  assert.equal(rec.read('card', 'C-1').doc.state, 'failed');
  assert.equal(applyResult(rec, 'C-2', res('success'), { now: T0 }).moved, false);
  assert.equal(rec.read('card', 'C-2').doc.state, 'running');
});

test('Principle 9: the result shape is marked as not yet checked against a Claude Code version', () => {
  assert.equal(CHECKED_AGAINST, null);
});
