// binding.test.mjs — R-0b-48: a tap counts only as the answer to M2's own box, in a launched Front Door or thinking
// session, read from the tamper-checked copy. The ten-case suite (0 false accepts) is at the top; the rules follow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { env, session, write, box, tap, typed, queuedLine, CONFIG } from './fixtures.test-helper.mjs';
import { createAsk, processSession, releaseSessions, nextBox } from './binding.mjs';
import { askStore } from './ask-store.mjs';
import { LAPSE_MS } from './kinds.mjs';

const MIN = 60_000;
function make(t, id = 'A-1', over = {}) {
  const r = createAsk(t.ctx, { id, kind: 'tap_yes_no', card: 'C-1', title: 'Ship the settings page', ...over });
  assert.equal(r.ok, true, r.reason);
  return t.record.read('ask', id).doc;
}
const run = (t, sid) => processSession(t.ctx, { sessionId: sid, sourcePath: t.log(sid) });
const state = (t, id = 'A-1') => t.record.read('ask', id).doc;

// One genuine round: box then tap, `dt` minutes after the ask was made.
function ask1(t, sid, doc, label = 'Yes', { input = doc.payload, at = t.clock.t + MIN } = {}) {
  const b = box(input, at);
  write(t, sid, b.entry, tap(b.id, input, label, at + MIN));
  t.clock.t = at + 2 * MIN;
  return run(t, sid);
}

test('ten-case suite: one genuine tap counts, nine planted ones give 0 false accepts', () => {
  const cases = {
    genuine: (t, doc) => ask1(t, 'FD-1', doc),
    relayed_line: (t, doc) => { const b = box(doc.payload, t.clock.t + MIN); write(t, 'FD-1', b.entry, typed('[relay] Yes', t.clock.t + 2 * MIN)); t.clock.t += 3 * MIN; return run(t, 'FD-1'); },
    watchdog_in_box: (t, doc) => ask1(t, 'FD-1', doc, '[watchdog] Yes'),
    reworded_question: (t, doc) => { const p = structuredClone(doc.payload); p.questions[0].question += ' please'; return ask1(t, 'FD-1', doc, 'Yes', { input: p }); },
    extra_question: (t, doc) => { const p = structuredClone(doc.payload); p.questions.push({ ...p.questions[0], question: 'Also?' }); return ask1(t, 'FD-1', doc, 'Yes', { input: p }); },
    extra_option: (t, doc) => { const p = structuredClone(doc.payload); p.questions[0].options.push({ label: 'Maybe', description: '' }); return ask1(t, 'FD-1', doc, 'Yes', { input: p }); },
    typed_yes: (t, doc) => { const b = box(doc.payload, t.clock.t + MIN); write(t, 'FD-1', b.entry, typed('Yes', t.clock.t + 2 * MIN)); t.clock.t += 3 * MIN; return run(t, 'FD-1'); },
    other_text: (t, doc) => ask1(t, 'FD-1', doc, 'yes'),
    lead_session: (t, doc) => { session(t, 'L-1', 'lead'); return ask1(t, 'L-1', doc); },
    unlaunched_session: (t, doc) => ask1(t, 'X-9', doc),
  };
  let accepts = 0;
  for (const [name, fn] of Object.entries(cases)) {
    const t = env();
    session(t, 'FD-1');
    const doc = make(t);
    fn(t, doc);
    const s = state(t);
    if (s.state === 'answered') accepts++;
    assert.equal(s.state === 'answered', name === 'genuine', name);
    // A box that is not M2's exact question binds nothing at all (checked when bound, not only when answered).
    if (['reworded_question', 'extra_question', 'extra_option'].includes(name)) {
      assert.ok(s.boxes.length && s.boxes.every((b) => b.status === 'mismatched_question'), name);
      assert.equal(s.state, 'open', name);
    }
  }
  assert.equal(accepts, 1);
});

test('binding a box delivers the ask: open → pushed, first_pushed_at and raised_at set once', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry);
  t.clock.t += 2 * MIN;
  const r = run(t, 'FD-1');
  assert.deepEqual(r.events.map((e) => e.type), ['bound']);
  const s = state(t);
  assert.equal(s.state, 'pushed');
  assert.equal(s.first_pushed_at, s.raised_at);
  assert.equal(s.boxes[0].status, 'bound');
});

test('a genuine tap: answered, the box answered for good, the choice recorded', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const r = ask1(t, 'FD-1', doc, 'No');
  assert.ok(r.events.some((e) => e.type === 'answered' && e.choice === 'No'));
  const s = state(t);
  assert.equal(s.state, 'answered');
  assert.equal(s.answer.choice, 'No');
  assert.equal(s.answer.approves, false);
  assert.equal(s.boxes[0].status, 'answered');
  // The same result read again changes nothing.
  const before = t.record.read('ask', 'A-1').rev;
  const b = box(doc.payload, t.clock.t);
  write(t, 'FD-1', tap(s.boxes[0].tool_use_id, doc.payload, 'Yes', t.clock.t));
  t.clock.t += MIN;
  run(t, 'FD-1');
  assert.equal(t.record.read('ask', 'A-1').rev, before);
  assert.equal(state(t).answer.choice, 'No');
  assert.ok(b);
});

test('a typed reply releases the box with the fixed line, and the ask goes back to open (M5-2)', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry, typed('yes do it', t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  const r = run(t, 'FD-1');
  assert.ok(r.events.some((e) => e.type === 'released_typed' && e.card === 'C-1'));
  const s = state(t);
  assert.equal(s.state, 'open');
  assert.equal(s.released_typed, true);
  assert.equal(s.boxes[0].reason, 'typed');
  // The next box shows the "Still open" version, which also binds.
  const nb = nextBox(t.ctx, { sessionId: 'FD-1', role: 'front_door' });
  assert.deepEqual(nb.payload, s.payload_still_open);
  ask1(t, 'FD-1', s, 'Yes', { input: nb.payload });
  assert.equal(state(t).state, 'answered');
  assert.equal(state(t).boxes.at(-1).version, 'still_open');
});

test('a message queued while a turn ran also releases the box', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry, queuedLine('yes', t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  run(t, 'FD-1');
  assert.equal(state(t).state, 'open');
});

test('a [watchdog] or [relay] typed line neither counts nor releases', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry, typed('[watchdog] Yes', t.clock.t + 2 * MIN), typed('[relay] Yes', t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  run(t, 'FD-1');
  assert.equal(state(t).state, 'pushed');
  assert.equal(state(t).boxes[0].status, 'bound');
});

test('a declined box releases it; nothing recorded', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry, tap(b.id, doc.payload, null, t.clock.t + 2 * MIN, { isError: true }));
  t.clock.t += 3 * MIN;
  run(t, 'FD-1');
  assert.equal(state(t).state, 'open');
  assert.equal(state(t).boxes[0].reason, 'declined');
});

test('an answer for another question, or two answers, releases instead of counting', () => {
  for (const answers of [{ 'Something else?': 'Yes' }, { a: 'Yes', b: 'Yes' }]) {
    const t = env(); session(t, 'FD-1');
    const doc = make(t);
    const b = box(doc.payload, t.clock.t + MIN);
    write(t, 'FD-1', b.entry, tap(b.id, doc.payload, 'Yes', t.clock.t + 2 * MIN, { answers }));
    t.clock.t += 3 * MIN;
    run(t, 'FD-1');
    assert.equal(state(t).state, 'open');
  }
});

test('a result naming the box from another session does not count', () => {
  const t = env(); session(t, 'FD-1'); session(t, 'TH-1', 'thinking');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry);
  write(t, 'TH-1', tap(b.id, doc.payload, 'Yes', t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  run(t, 'FD-1'); run(t, 'TH-1');
  assert.equal(state(t).state, 'pushed');
});

test('one live box per ask: a second box elsewhere is a mismatched question', () => {
  const t = env(); session(t, 'FD-1'); session(t, 'TH-1', 'thinking');
  const doc = make(t, 'A-1', { origin_session: 'TH-1' });
  write(t, 'FD-1', box(doc.payload, t.clock.t + MIN).entry);
  const b2 = box(doc.payload, t.clock.t + MIN);
  write(t, 'TH-1', b2.entry, tap(b2.id, doc.payload, 'Yes', t.clock.t + 2 * MIN));
  t.clock.t += 3 * MIN;
  run(t, 'FD-1'); const r = run(t, 'TH-1');
  assert.ok(r.events.some((e) => e.type === 'mismatched_question'));
  assert.equal(state(t).state, 'pushed');
});

test('a thinking room binds only its own asks', () => {
  const t = env(); session(t, 'TH-1', 'thinking');
  const doc = make(t);
  ask1(t, 'TH-1', doc);
  assert.equal(state(t).state, 'open');
  assert.equal(nextBox(t.ctx, { sessionId: 'TH-1', role: 'thinking' }), null);
  const t2 = env(); session(t2, 'TH-1', 'thinking');
  const own = make(t2, 'A-1', { origin_session: 'TH-1' });
  ask1(t2, 'TH-1', own);
  assert.equal(state(t2).state, 'answered');
});

test('a box asked before the ask was created binds nothing', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  ask1(t, 'FD-1', doc, 'Yes', { at: t.clock.t - 5 * MIN });
  assert.equal(state(t).state, 'open');
});

test('a tap after the 12-hour lapse is closed; nothing recorded', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const at = t.clock.t + MIN;
  const b = box(doc.payload, at);
  write(t, 'FD-1', b.entry);
  t.clock.t = at + MIN; run(t, 'FD-1');
  write(t, 'FD-1', tap(b.id, doc.payload, 'Yes', at + LAPSE_MS + MIN));
  t.clock.t = at + LAPSE_MS + 2 * MIN;
  const r = run(t, 'FD-1');
  assert.ok(r.events.some((e) => e.type === 'closed'));
  assert.notEqual(state(t).state, 'answered');
});

test('the ask withdrawn while its box is open: the tap is closed (m4-1)', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry);
  t.clock.t += 2 * MIN; run(t, 'FD-1');
  const cur = t.record.read('ask', 'A-1');
  assert.equal(t.record.write({ actor: 'approvals', entity: 'ask', id: 'A-1', expectRev: cur.rev, doc: { ...cur.doc, state: 'withdrawn' } }).ok, true);
  write(t, 'FD-1', tap(b.id, doc.payload, 'Yes', t.clock.t + MIN));
  t.clock.t += 2 * MIN;
  const r = run(t, 'FD-1');
  assert.ok(r.events.some((e) => e.type === 'closed'));
  assert.equal(state(t).state, 'withdrawn');
  assert.equal(state(t).boxes[0].reason, 'withdrawn');
});

test('a rewritten log is tampered: the box is released, the later tap never counts, one alert', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry);
  t.clock.t += 2 * MIN; run(t, 'FD-1');
  writeFileSync(t.log('FD-1'), readFileSync(t.log('FD-1'), 'utf8').replace('Ship', 'Shop'));
  write(t, 'FD-1', tap(b.id, doc.payload, 'Yes', t.clock.t + MIN));
  t.clock.t += 2 * MIN;
  run(t, 'FD-1'); run(t, 'FD-1');
  assert.equal(state(t).state, 'open');
  assert.equal(state(t).boxes[0].reason, 'tampered');
  assert.equal(t.alerts.filter((a) => a.type === 'transcript_tampered').length, 1);
});

test('L135 B: a tamper alert that is lost (false, or a throw) is told again next pass, then once delivered never again', () => {
  for (const lost of [false, 'throws']) {
    const t = env(); session(t, 'FD-1');
    const doc = make(t);
    const b = box(doc.payload, t.clock.t + MIN);
    write(t, 'FD-1', b.entry);
    t.clock.t += 2 * MIN; run(t, 'FD-1');
    writeFileSync(t.log('FD-1'), readFileSync(t.log('FD-1'), 'utf8').replace('Ship', 'Shop'));
    t.sink.answer = lost;
    const pass = () => { try { return run(t, 'FD-1'); } catch (e) { assert.equal(lost, 'throws', String(e)); return { events: [] }; } };
    for (let i = 0; i < 2; i++) {
      const r = pass();
      assert.ok(!r.events.some((e) => e.type === 'tampered'), `${lost}: no "tampered" event while the alert is lost`);
      assert.equal(t.ctx.copies.sync('FD-1', t.log('FD-1')).untold, true, `${lost}: still untold`);
    }
    assert.equal(state(t).boxes[0].reason, 'tampered', `${lost}: the box is released all the same`);
    t.sink.answer = true;
    assert.ok(pass().events.some((e) => e.type === 'tampered'), `${lost}: told once delivered`);
    pass(); pass();
    assert.equal(t.alerts.filter((a) => a.type === 'transcript_tampered').length, 1, `${lost}: one delivered alert, not one per pass`);
    assert.equal(t.ctx.copies.sync('FD-1', t.log('FD-1')).untold, false);
  }
});

test('a newer Front Door replaces the old one: its box is released (m2-5)', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  write(t, 'FD-1', box(doc.payload, t.clock.t + MIN).entry);
  t.clock.t += 2 * MIN; run(t, 'FD-1');
  session(t, 'FD-2');
  const ev = releaseSessions(t.ctx);
  assert.deepEqual(ev.map((e) => e.reason), ['session_replaced']);
  assert.equal(state(t).state, 'open');
});

test('M10 must allow the channel: a refused count_approval counts nothing', () => {
  const t = env({ answers: { count_approval: () => ({ decision: 'deny', reason: 'no' }) } }); session(t, 'FD-1');
  const doc = make(t);
  ask1(t, 'FD-1', doc);
  assert.equal(state(t).state, 'open');
  assert.ok(t.alerts.some((a) => a.type === 'approval_not_counted'));
});

test('missing owner settings: nothing counts, and the lines wait until they are fixed', () => {
  const t = env({ values: { 'approvals.push_windows': undefined } }); session(t, 'FD-1');
  const doc = make(t);
  const r = ask1(t, 'FD-1', doc);
  assert.equal(r.ok, false);
  assert.equal(state(t).state, 'open');
  t.ctx.rules = env().ctx.rules;   // settings fixed
  run(t, 'FD-1');
  assert.equal(state(t).state, 'answered');
  assert.ok(CONFIG['approvals.push_windows']);
});

test('only asks M2 wrote are trusted', () => {
  const t = env(); session(t, 'FD-1');
  make(t);
  const cur = t.record.read('ask', 'A-1');
  // Another writer touching an ask is refused by M9; a seeded one (past the writer) is not trusted by M2.
  assert.equal(t.record.write({ actor: 'dispatcher', entity: 'ask', id: 'A-1', expectRev: cur.rev, doc: cur.doc }).ok, false);
  t.store.transaction((tx) => tx.commit([{ entity: 'ask', id: 'A-1', doc: { ...cur.doc, state: 'pushed' } }], { actor: 'test', kind: 'seed' }));
  const st = askStore(t.record);
  assert.equal(st.ask('A-1'), null);
  assert.deepEqual(st.untrusted, ['ask/A-1']);
});

test('next box: urgent first (undo, then repair), then this card, then the oldest; a released non-urgent ask waits a reply', () => {
  const t = env(); session(t, 'FD-1');
  make(t, 'A-old', { card: 'C-9' });
  t.clock.t += MIN; make(t, 'A-mine', { card: 'C-5' });
  t.clock.t += MIN; createAsk(t.ctx, { id: 'R-1', kind: 'incident_repair', card: 'C-7', title: 'Repair' });
  t.clock.t += MIN; createAsk(t.ctx, { id: 'U-1', kind: 'undo', card: 'C-8', title: 'Undo' });
  const order = [];
  const pick = (o) => nextBox(t.ctx, { sessionId: 'FD-1', role: 'front_door', card: 'C-5', ...o })?.ask;
  order.push(pick());
  assert.deepEqual(order, ['U-1']);
  assert.equal(pick({ releasedThisReply: ['U-1'] }), 'U-1');   // urgent may come straight back (m5-1)
  for (const id of ['U-1', 'R-1']) { const c = t.record.read('ask', id); t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: c.rev, doc: { ...c.doc, state: 'withdrawn' } }); }
  assert.equal(pick(), 'A-mine');
  assert.equal(pick({ releasedThisReply: ['A-mine'] }), 'A-old');
  assert.equal(nextBox(t.ctx, { sessionId: 'W-1', role: 'worker' }), null);
});

test('an entry in this log that claims another session is ignored', () => {
  const t = env(); session(t, 'FD-1');
  const doc = make(t);
  const b = box(doc.payload, t.clock.t + MIN);
  write(t, 'FD-1', b.entry, { ...tap(b.id, doc.payload, 'Yes', t.clock.t + 2 * MIN), sessionId: 'FD-0' });
  t.clock.t += 3 * MIN;
  run(t, 'FD-1');
  assert.equal(state(t).state, 'pushed');
});

test('a tap dated before its box was bound counts nothing; a box and tap in a side chain or meta entry bind nothing', () => {
  {
    const t = env(); session(t, 'FD-1'); const doc = make(t);
    const at = t.clock.t + 2 * MIN;
    const b = box(doc.payload, at);
    write(t, 'FD-1', b.entry, tap(b.id, doc.payload, 'Yes', at - MIN));
    t.clock.t = at + MIN; run(t, 'FD-1');
    assert.notEqual(state(t).state, 'answered', 'answer before bind');
  }
  for (const flag of ['isSidechain', 'isMeta']) {
    const t = env(); session(t, 'FD-1'); const doc = make(t);
    const at = t.clock.t + MIN;
    const b = box(doc.payload, at);
    write(t, 'FD-1', { ...b.entry, [flag]: true }, { ...tap(b.id, doc.payload, 'Yes', at + MIN), [flag]: true });
    t.clock.t = at + 2 * MIN; run(t, 'FD-1');
    assert.deepEqual([state(t).state, state(t).boxes.length], ['open', 0], flag);
  }
});
