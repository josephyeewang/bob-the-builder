// R-0b-153: the "waiting" decision. Each planted case from the row, plus the hook half driven through M4's real tracker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waiting, decideWaiting, SCREEN_RULES_CHECKED_ON, Answer } from './waiting.mjs';
import { compileRules } from './match.mjs';
import { ActivityTracker, MemoryStore, State } from '../../M4-workshop/send-safe/activity.mjs';
import { signalFromHook } from '../../M4-workshop/send-safe/claude-signals.mjs';

const BAR = '─'.repeat(60);
const IDLE = `⏺ Done.\n\n${BAR}\n❯ \n${BAR}\n  ? for shortcuts\n`;
const WORKING = `⏺ Reading\n\n✻ Pondering… (3s · esc to interrupt)\n\n${BAR}\n❯ \n${BAR}\n`;
const QUESTION = `${BAR}\n Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n`;
const UNSEEN = '⏺ Pick one of the three plans to continue:\n  plan A\n  plan B\n';
const V = SCREEN_RULES_CHECKED_ON;
const NOW = 10_000;

/** n readings of `text`, 100 ms apart, the newest `age` ms before NOW. */
const readings = (text, n = 3, { age = 0, title = '', gap = 100 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ text, title, at: NOW - age - (n - 1 - i) * gap }));
const ask = (o) => waiting({ version: V, now: NOW, ...o });

test('three idle readings and idle hooks -> free', () => {
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE) }), Answer.FREE);
  assert.equal(ask({ hook: { state: 'idle' }, readings: readings(IDLE) }), Answer.FREE);
});

test('two idle readings -> not free; none or an empty list -> unknown', () => {
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 2) }), Answer.UNKNOWN);
  assert.equal(ask({ hook: 'idle', readings: [] }), Answer.UNKNOWN);
  assert.equal(ask({ hook: 'idle' }), Answer.UNKNOWN);
});

test('the debounce needs its spacing and fresh readings', () => {
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 3, { age: 2000 }) }), Answer.UNKNOWN, 'newest 2 s old holds');
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 3, { age: 1000 }) }), Answer.FREE, '1 s is the edge');
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 3, { gap: 10 }) }), Answer.UNKNOWN, 'too close together');
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 3, { age: -50 }) }), Answer.UNKNOWN, 'from the future');
  const noTime = readings(IDLE).map(({ at, ...r }) => r);
  assert.equal(ask({ hook: 'idle', readings: noTime }), Answer.UNKNOWN);
  assert.equal(waiting({ hook: 'idle', readings: readings(IDLE), version: V }), Answer.UNKNOWN, 'no clock');
});

test('any reading that is not the idle prompt holds; a failed read holds', () => {
  const mixed = readings(IDLE);
  mixed[1] = { ...mixed[1], text: WORKING };
  assert.equal(ask({ hook: 'idle', readings: mixed }), Answer.UNKNOWN);
  const failed = readings(IDLE);
  failed[2] = { error: 'capture failed', at: NOW };
  assert.equal(ask({ hook: 'idle', readings: failed }), Answer.UNKNOWN);
  assert.equal(ask({ hook: 'idle', readings: [...readings(IDLE).slice(0, 2), null] }), Answer.UNKNOWN);
});

test('a question on screen -> waiting at once, whatever the hooks say', () => {
  const one = [...readings(IDLE, 2), { text: QUESTION, title: '', at: NOW }];
  assert.equal(ask({ hook: 'idle', readings: one }), Answer.WAITING);
  assert.equal(ask({ hook: 'active', readings: [{ text: QUESTION, at: NOW }] }), Answer.WAITING);
  assert.equal(ask({ hook: 'idle', readings: readings(QUESTION), version: undefined }), Answer.WAITING);
});

test('hooks saying waiting or blocked -> waiting, even with an idle screen', () => {
  assert.equal(ask({ hook: 'blocked', readings: readings(IDLE) }), Answer.WAITING);
  assert.equal(ask({ hook: 'waiting_input', readings: readings(IDLE) }), Answer.WAITING);
});

test('hooks exited, missing or unrecognised -> unknown', () => {
  for (const hook of ['exited', undefined, null, 'busy', {}]) assert.equal(ask({ hook, readings: readings(IDLE) }), Answer.UNKNOWN, String(hook));
});

test('a version mismatch or no version -> unknown', () => {
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE), version: '2.1.323' }), Answer.UNKNOWN);
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE), version: undefined }), Answer.UNKNOWN);
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE), version: '' }), Answer.UNKNOWN);
  assert.match(decideWaiting({ hook: 'idle', readings: readings(IDLE), version: '2.0.0', now: NOW }).why, /rules checked on 2\.1\.322/);
  assert.equal(decideWaiting({ hook: 'idle', readings: readings(IDLE), now: NOW }).why, 'no Claude Code version');
});

test('a question wording no rule knows under a ✳ title -> unknown, never free', () => {
  assert.equal(ask({ hook: 'idle', readings: readings(UNSEEN, 3, { title: '✳ Claude Code' }) }), Answer.UNKNOWN);
});

test('idle only from the text-region prompt rule, never a title', () => {
  // A working title over an idle prompt box: the title rule outranks it, so not free.
  assert.equal(ask({ hook: 'idle', readings: readings(IDLE, 3, { title: '⠂ Claude Code' }) }), Answer.UNKNOWN);
  // A rule set where some other rule says idle: still not free.
  const rules = [{ id: 'other_idle', state: 'idle', contains: ['done'] }];
  assert.equal(waiting({ hook: 'idle', readings: readings(IDLE), version: V, now: NOW, rules: compileRules(rules) }), Answer.UNKNOWN);
});

// ── The hook half through M4's real tracker ──

function session() {
  const store = new MemoryStore();
  store.set('s', { id: 's', activity: { state: State.IDLE, at: 0 }, firstSignalAt: 1 });
  const tracker = new ActivityTracker(store, { now: () => NOW });
  const hook = (event, payload = {}) => tracker.applySignal('s', signalFromHook(event, payload, NOW));
  return { hook, state: () => store.get('s').activity.state };
}

test('a helper finishing while the parent shows a question stays waiting', () => {
  const s = session();
  s.hook('user-prompt-submit', { prompt: 'go' });
  s.hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'parent' });
  s.hook('permission-request', { tool_name: 'Bash', tool_use_id: 'parent' });
  s.hook('pre-tool-use', { tool_name: 'Read', tool_use_id: 'helper' });
  s.hook('post-tool-use', { tool_name: 'Read', tool_use_id: 'helper' });
  s.hook('notification', { notification_type: 'agent_completed' });
  assert.equal(s.state(), State.BLOCKED, 'helper traffic never clears the parent (tracker kept as built)');
  assert.equal(ask({ hook: s.state(), readings: readings(QUESTION) }), Answer.WAITING);
});

test('an Esc during work never leaves it stuck on working', () => {
  const s = session();
  s.hook('user-prompt-submit', { prompt: 'go' });
  s.hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 't1' });
  // The person presses Esc: Claude fires no Stop hook, so the tracker still says active.
  assert.equal(s.state(), State.ACTIVE);
  assert.equal(ask({ hook: s.state(), readings: readings(IDLE) }), Answer.FREE, 'the idle screen frees it');
  assert.equal(ask({ hook: s.state(), readings: readings(WORKING) }), Answer.UNKNOWN, 'still working on screen: hold');
});

test('a hook-cleared block with the question still on screen stays waiting', () => {
  const s = session();
  s.hook('user-prompt-submit', { prompt: 'go' });
  s.hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'b' });
  s.hook('permission-request', { tool_name: 'Bash', tool_use_id: 'b' });
  s.hook('stop'); // a turn boundary clears the hook half
  assert.equal(s.state(), State.IDLE);
  assert.equal(ask({ hook: s.state(), readings: readings(QUESTION) }), Answer.WAITING);
});

test('an answered question clears only once the idle screen shows', () => {
  const s = session();
  s.hook('user-prompt-submit', { prompt: 'go' });
  s.hook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q' });
  assert.equal(s.state(), State.WAITING_INPUT);
  assert.equal(ask({ hook: s.state(), readings: readings(IDLE) }), Answer.WAITING);
  s.hook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q' });
  s.hook('stop');
  assert.equal(s.state(), State.IDLE);
  const ASKING = `${BAR}\n☐ Colour\n\nWhich colour?\n\n❯ 1. Red\n  2. Blue\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
  assert.equal(ask({ hook: s.state(), readings: readings(ASKING) }), Answer.WAITING, 'box still drawn');
  assert.equal(ask({ hook: s.state(), readings: [...readings(ASKING, 1, { age: 200 }), ...readings(IDLE, 2)] }), Answer.WAITING);
  assert.equal(ask({ hook: s.state(), readings: readings(IDLE) }), Answer.FREE);
});
