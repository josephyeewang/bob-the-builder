// hook-store.test.mjs — R-0b-175a: the interactive sessions' hook lines, read owner-side into a saved tracker, and the
// launch-label rulings. Real files in a temp folder, the runner's own writeStatus; hand-written hook lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeStatus } from '../../../wiring/runner-files.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { State } from './activity.mjs';
import { Guard, Outcome, sendSafe } from './guard.mjs';
import { HELD_FIELDS, START_TIMEOUT_S, heldOk, hookStore, nodeHookFs, parseHookLine, signalFromLine } from './hook-store.mjs';

const T0 = Date.parse('2026-11-13T12:00:00Z');
const HASH = 'a'.repeat(64);

function world({ startTimeoutS = {} } = {}) {
  const dir = tempDir('m4-hook-store-');
  mkdirSync(join(dir, 'hooks'), { mode: 0o700 });
  let t = T0;
  const clock = { now: () => t, at: (ms) => { t = ms; } };
  const open = () => hookStore({ dir, fs: nodeHookFs(), saveFile: (f, text, { mode }) => writeStatus(f, text, { mode }), now: clock.now, startTimeoutS });
  const file = (id) => join(dir, 'hooks', `${id}.jsonl`);
  const line = (id, x) => appendFileSync(file(id), `${JSON.stringify({ at: t, ...x })}\n`);
  const raw = (id, text) => appendFileSync(file(id), text);
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { dir, clock, open, file, line, raw, done };
}

const start = (L) => ({ launchId: L, event: 'session-start', source: 'startup' });
const prompt = (L, watchdog) => ({ launchId: L, event: 'user-prompt-submit', ...(watchdog === undefined ? {} : { watchdog }), promptHash: HASH });

test('R-0b-175a (b): a runner restart sees every line written while it was down', () => {
  const w = world();
  try {
    const a = w.open();
    assert.equal(a.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' }), true);
    w.line('lead-1', start('L1'));
    assert.equal(a.tick(), 1);
    assert.equal(a.store.get('lead-1').activity.state, State.IDLE);
    // The runner is down: two lines arrive.
    w.line('lead-1', prompt('L1', false));
    w.line('lead-1', { launchId: 'L1', event: 'pre-tool-use', toolName: 'Bash', toolUseId: 't1' });
    const b = w.open();
    assert.equal(b.tick(), 2, 'only the two new lines, from the saved offset');
    assert.equal(b.store.get('lead-1').activity.state, State.ACTIVE);
    assert.equal(b.tick(), 0, 'nothing applied twice');
    const saved = JSON.parse(readFileSync(join(w.dir, 'activity.json'), 'utf8'));
    assert.equal(saved.sessions['lead-1'].hook_offset, statSync(w.file('lead-1')).size);
    assert.equal(statSync(join(w.dir, 'activity.json')).mode & 0o777, 0o600);
  } finally { w.done(); }
});

test('R-0b-175a (a): a torn line waits for its end; a malformed line is skipped and counted, and never blocks the file', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('fd-1', { role: 'frontDoor', product: null, launchId: 'L1' });
    const whole = JSON.stringify({ at: T0, ...start('L1') });
    w.raw('fd-1', whole.slice(0, 20));
    assert.equal(s.tick(), 0, 'no ending newline: not applied yet');
    assert.equal(s.store.get('fd-1').firstSignalAt, null);
    w.raw('fd-1', `${whole.slice(20)}\n`);
    assert.equal(s.tick(), 1, 'the finished line is applied');
    assert.equal(s.store.get('fd-1').activity.state, State.IDLE);
    w.raw('fd-1', 'not a line\n');
    w.line('fd-1', { launchId: 'L1', event: 'made-up' });
    w.line('fd-1', { launchId: 'L1', event: 'stop', extra: 1 });
    w.line('fd-1', prompt('L1', false));
    assert.equal(s.tick(), 1, 'the good line after three bad ones');
    assert.equal(s.store.get('fd-1').bad_lines, 3);
    assert.equal(s.store.get('fd-1').activity.state, State.ACTIVE);
  } finally { w.done(); }
});

test('R-0b-175a (a): no file the store writes holds prompt text; a line carrying one is refused', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('mb-1', { role: 'minibase', product: null, launchId: 'L1' });
    w.line('mb-1', start('L1'));
    w.line('mb-1', { launchId: 'L1', event: 'user-prompt-submit', prompt: 'PLANTED-PROMPT-TEXT', watchdog: false });
    w.line('mb-1', prompt('L1', false));
    s.tick();
    assert.equal(s.store.get('mb-1').bad_lines, 1);
    assert.equal(parseHookLine(JSON.stringify({ at: 1, event: 'stop', prompt: 'x' })), null);
    assert.equal('prompt' in signalFromLine({ at: 1, event: 'user-prompt-submit', launchId: 'L1' }), false);
    for (const f of readdirSync(w.dir)) {
      if (f === 'hooks') continue;
      assert.equal(readFileSync(join(w.dir, f), 'utf8').includes('PLANTED-PROMPT-TEXT'), false, f);
    }
  } finally { w.done(); }
});

test('R-0b-175a (a): a watchdog-flagged prompt, or one with no flag, never lifts a block; the person\'s does', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    w.line('lead-1', start('L1'));
    w.line('lead-1', { launchId: 'L1', event: 'permission-request', toolName: 'Bash', toolUseId: 't1' });
    s.tick();
    assert.equal(s.store.get('lead-1').activity.state, State.BLOCKED);
    w.line('lead-1', prompt('L1', true));
    w.line('lead-1', prompt('L1'));
    s.tick();
    assert.equal(s.store.get('lead-1').activity.state, State.BLOCKED, 'flagged or unflagged: still blocked');
    w.line('lead-1', prompt('L1', false));
    s.tick();
    assert.equal(s.store.get('lead-1').activity.state, State.ACTIVE, 'the person answered');
  } finally { w.done(); }
});

test('R-0b-175a (d)(1): a line with an old launch id is dropped; a labelled hook at a record with none is dropped and counted', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L2' });
    w.line('lead-1', start('L1'));
    s.tick();
    assert.equal(s.store.get('lead-1').firstSignalAt, null, 'the old label is ignored');
    s.addSession('lead-2', { role: 'lead', product: 'p2' });
    w.clock.at(T0 + 5_000);
    w.line('lead-2', start('L9'));
    s.tick();
    const r = s.store.get('lead-2');
    assert.equal(r.dropped_hooks, 1);
    assert.equal(r.dropped_hook_at, T0 + 5_000);
    assert.equal(r.firstSignalAt, null);
  } finally { w.done(); }
});

test('R-0b-175a (d)(2): startup ends startup pending; compact mid-turn is dropped; clear on a pending record stays pending', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('a', { role: 'lead', product: 'p1', launchId: 'L1' });
    w.line('a', { launchId: 'L1', event: 'session-start', source: 'clear' });
    s.tick();
    assert.equal(s.store.get('a').firstSignalAt, null, 'clear is never a first signal');
    w.line('a', start('L1'));
    s.tick();
    assert.ok(s.store.get('a').firstSignalAt, 'startup ends startup pending');
    w.line('a', prompt('L1', false));
    s.tick();
    assert.equal(s.store.get('a').activity.state, State.ACTIVE);
    w.line('a', { launchId: 'L1', event: 'session-start', source: 'compact' });
    w.line('a', { launchId: 'L1', event: 'session-start', source: 'startup' });
    s.tick();
    assert.equal(s.store.get('a').activity.state, State.ACTIVE, 'a session-start mid-turn never reads idle');
  } finally { w.done(); }
});

test('R-0b-175a (d)(2): a Lead, a Front Door and a Mini Base left startup pending past their timeout are held, never restarted', () => {
  const w = world({ startTimeoutS: { frontDoor: 30 } });
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    s.addSession('fd-1', { role: 'frontDoor', product: null, launchId: 'F1' });
    s.addSession('mb-1', { role: 'minibase', product: null, launchId: 'M1' });
    w.clock.at(T0 + 31_000);
    assert.deepEqual(s.held().map((h) => h.sessionId), ['fd-1'], 'the Front Door\'s own 30 s');
    w.clock.at(T0 + START_TIMEOUT_S * 1000 + 1);
    const held = s.held();
    assert.deepEqual(held.map((h) => h.sessionId).sort(), ['fd-1', 'lead-1', 'mb-1']);
    for (const h of held) { assert.ok(heldOk(h), JSON.stringify(h)); assert.deepEqual(Object.keys(h), HELD_FIELDS); }
    assert.equal(held.find((h) => h.sessionId === 'lead-1').launchId, 'L1');
    for (const id of ['lead-1', 'fd-1', 'mb-1']) {
      const r = s.store.get(id);
      assert.equal(r.firstSignalAt, null);
      assert.equal(r.launched_at, T0, 'no new launch');
    }
    // A first signal, late, ends the hold.
    w.line('mb-1', start('M1'));
    s.tick();
    assert.deepEqual(s.held().map((h) => h.sessionId).sort(), ['fd-1', 'lead-1']);
  } finally { w.done(); }
});

test('R-0b-175a (d)(3): beginLaunch on a terminated session: startup pending under the new label, a send after its first hook not refused', async () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    w.line('lead-1', start('L1'));
    s.tick();
    s.tracker.applyRuntimeObservation('lead-1', { alive: false });
    assert.equal(s.store.get('lead-1').terminated, true);
    assert.equal(s.beginLaunch('lead-1', 'L2'), true);
    assert.equal(existsSync(w.file('lead-1')), false, 'the old launch\'s file is gone');
    const r = s.store.get('lead-1');
    assert.equal(r.terminated, undefined);
    assert.equal(r.firstSignalAt, null);
    assert.equal(r.launchId, 'L2');
    const sent = [];
    const guard = new Guard({ store: { getSession: (id) => s.getSession(id) }, messenger: { send: async (id, t) => sent.push(t) } });
    assert.equal((await sendSafe(guard, 'lead-1', 'x')).outcome, Outcome.SUPPRESSED_STARTUP_PENDING);
    w.line('lead-1', start('L1'));
    assert.equal((await sendSafe(guard, 'lead-1', 'x')).outcome, Outcome.SUPPRESSED_STARTUP_PENDING, 'an old-label hook is ignored');
    w.line('lead-1', start('L2'));
    // The send's own live read applies the new line.
    assert.equal((await sendSafe(guard, 'lead-1', 'x')).outcome, Outcome.SENT);
    assert.equal(sent.length, 1);
  } finally { w.done(); }
});

test('R-0b-175a (b)(d)(4): a store that can\'t be read holds every send, is listed held, and is never written over', async () => {
  const w = world();
  try {
    writeFileSync(join(w.dir, 'activity.json'), '{ not the store', { mode: 0o600 });
    w.clock.at(T0 + 1000);
    const s = w.open();
    assert.ok(s.broken);
    assert.equal(s.tick(), 0);
    assert.equal(s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' }), false);
    const held = s.held();
    assert.equal(held.length, 1);
    assert.ok(heldOk(held[0]));
    assert.equal(held[0].sessionId, null);
    assert.equal(held[0].since, new Date(T0 + 1000).toISOString());
    const guard = new Guard({ store: { getSession: (id) => s.getSession(id) }, messenger: { send: async () => assert.fail('typed') } });
    assert.equal((await sendSafe(guard, 'lead-1', 'x')).outcome, Outcome.SUPPRESSED_UNKNOWN);
    assert.equal(readFileSync(join(w.dir, 'activity.json'), 'utf8'), '{ not the store', 'left for a fix by hand');
  } finally { w.done(); }
});

test('R-0b-175a (a): the session-end line applied -> its hook file gone; a clear session-end keeps it', () => {
  const w = world();
  try {
    const s = w.open();
    s.addSession('lead-1', { role: 'lead', product: 'p1', launchId: 'L1' });
    w.line('lead-1', start('L1'));
    w.line('lead-1', { launchId: 'L1', event: 'session-end', reason: 'clear' });
    s.tick();
    assert.equal(existsSync(w.file('lead-1')), true);
    w.line('lead-1', { launchId: 'L0', event: 'session-end', reason: 'other' });
    s.tick();
    assert.equal(existsSync(w.file('lead-1')), true, 'an old label\'s end ends nothing');
    w.line('lead-1', { launchId: 'L1', event: 'session-end', reason: 'other' });
    s.tick();
    assert.equal(existsSync(w.file('lead-1')), false);
    assert.equal(s.store.get('lead-1').activity.state, State.EXITED);
    assert.equal(s.store.get('lead-1').hook_offset, 0, 'a new file is read from the start');
  } finally { w.done(); }
});

test('R-0b-175a (a): heldOk takes only the runner\'s shape', () => {
  const ok = { sessionId: 'a', role: 'lead', product: 'p1', reason: 'r', since: new Date(T0).toISOString(), launchId: 'L1' };
  assert.ok(heldOk(ok));
  assert.ok(heldOk({ ...ok, sessionId: null, role: null, product: null, launchId: null }));
  for (const bad of [{ ...ok, role: 'worker' }, { ...ok, extra: 1 }, { ...ok, since: 'soon' }, { ...ok, reason: '' }, { ...ok, sessionId: null }, (({ launchId, ...x }) => x)(ok)]) assert.equal(heldOk(bad), false, JSON.stringify(bad));
});
