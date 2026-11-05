// state-request.test.mjs — M1 join item 13 (L151 M-1, L213, L219): a pause or trip-mode request applied to the product.
//
// The record still refuses `state-` (shared OUTBOX_KINDS), so no real outbox write can store one today. The reports
// below are the shape the record's own create mode keeps (record.mjs applyOutbox: kind, role, session_id, source,
// text), added to the real record's report list by a thin wrapper; every product write still goes through the real
// M9 writer. When a lead call unrefuses state-, these switch to t.record.applyOutbox like research-ask.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outboxFile } from '../M1-front-door/outbox.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { env as m2env, must, PRODUCT } from './fixtures.test-helper.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { schedulePass } from './schedule.mjs';
import { STATE_ANSWERS, applyStateRequests, markStateAnswerTold, stateRequestStep } from './state-request.mjs';

let seq = 0;
function report(id, input, { role = 'front_door', rid, product = PRODUCT, text } = {}) {
  const f = outboxFile('state', id, { product, ...input });
  assert.equal(f.ok, true, f.reason);
  return { id: rid ?? `state-F-${++seq}`, rev: 1, doc: { kind: 'state-', role, session_id: 'F-1', card: null, source: f.name, text: text ?? f.text } };
}

// The real record, with extra reports in its list; write can be swapped to plant a refusal.
function setup({ state = 'active', reports = [], stateDir = true, doc = {} } = {}) {
  const t = m2env();
  if (state !== null) must(t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state, ...doc } }), 'product');
  const extra = [...reports];
  const rec = t.record;
  const box = { write: (w) => rec.write(w) };
  const record = { list: (e) => (e === 'report' ? [...rec.list('report'), ...extra] : rec.list(e)), read: (e, i) => rec.read(e, i), write: (w) => box.write(w), diary: (o) => rec.diary(o) };
  const ctx = { ...t.ctx, now: () => Date.UTC(2026, 10, 3, 12), record, ...(stateDir ? { stateDir: join(tempDir('orch-state-req-'), 'state') } : {}) };
  return { t, ctx, extra, box, product: () => rec.read('product', PRODUCT) };
}
const pass = (s) => applyStateRequests(s.ctx);
const sendAll = (s, r) => { for (const a of r.answers) assert.equal(markStateAnswerTold(s.ctx, a.report, a.push).ok, true); };

test('pause from active: the product is paused, return_to active, and "Confirmed" only after the write', () => {
  const rep = report('20261103-0915-aa', { state: 'paused' });
  const s = setup({ reports: [rep] });
  const r = pass(s);
  const p = s.product();
  assert.equal(p.doc.state, 'paused');
  assert.equal(p.doc.return_to, 'active');
  assert.deepEqual(p.doc.request, { id: rep.id, at: '20261103-0915' });
  assert.deepEqual(r.applied, [{ report: rep.id, state: 'paused' }]);
  assert.deepEqual(r.answers, [{ report: rep.id, push: `Confirmed: ${PRODUCT} is paused.` }]);
  // Handed back until marked sent; never applied twice.
  const again = pass(s);
  assert.deepEqual(again.answers, r.answers, 'not marked sent: handed back');
  assert.deepEqual(again.applied, []);
  assert.equal(s.product().rev, p.rev, 'no second write');
  sendAll(s, again);
  assert.deepEqual(pass(s).answers, []);
  const diary = s.t.record.diary({ since: 0 }).filter((l) => l.writes?.some((w) => w.entity === 'product'));
  assert.equal(diary.at(-1).actor, 'approvals', 'only approvals writes the product');
});

test('pause from light keeps return_to light; trip mode from active stores tz and until', () => {
  const light = setup({ state: 'light', reports: [report('20261103-0915-ab', { state: 'paused' })] });
  pass(light);
  assert.deepEqual([light.product().doc.state, light.product().doc.return_to], ['paused', 'light']);
  const away = setup({ reports: [report('20261103-0915-ac', { state: 'away', until: '2026-11-10', tz: 'Europe/Paris' })] });
  const r = pass(away);
  assert.equal(away.product().doc.state, 'away');
  assert.deepEqual(away.product().doc.away, { tz: 'Europe/Paris', until: '2026-11-10' });
  assert.deepEqual(r.answers.map((a) => a.push), [`Confirmed: trip mode for ${PRODUCT}.`]);
});

test('L219 c: trip mode while away replaces tz and until; pause while away keeps the away block, return_to away', () => {
  const s = setup({ reports: [report('20261103-0915-ad', { state: 'away', until: '2026-11-10', tz: 'Europe/Paris' })] });
  pass(s);
  s.extra.push(report('20261103-1000-ae', { state: 'away', until: '2026-11-20', tz: 'Asia/Tokyo' }));
  const r = pass(s);
  assert.equal(s.product().doc.state, 'away');
  assert.deepEqual(s.product().doc.away, { tz: 'Asia/Tokyo', until: '2026-11-20' }, 'away → away overwrites');
  assert.ok(r.answers.some((a) => a.push === `Confirmed: trip mode for ${PRODUCT}.` && a.report === s.extra[1].id));
  s.extra.push(report('20261103-1100-af', { state: 'paused' }));
  pass(s);
  const p = s.product().doc;
  assert.deepEqual([p.state, p.return_to, p.away], ['paused', 'away', { tz: 'Asia/Tokyo', until: '2026-11-20' }]);
});

test('pause while paused is confirmed with no change of state; trip mode while paused or from light is not applied, and stays not applied', () => {
  const pp = setup({ state: 'light', reports: [report('20261103-0915-ag', { state: 'paused' })] });
  pass(pp);
  pp.extra.push(report('20261103-1000-ah', { state: 'paused' }));
  const r = pass(pp);
  assert.deepEqual([pp.product().doc.state, pp.product().doc.return_to], ['paused', 'light'], 'return_to unchanged');
  assert.equal(r.answers.find((a) => a.report === pp.extra[1].id).push, `Confirmed: ${PRODUCT} is paused.`);
  // Trip mode while paused: not applied, recorded, so it never applies later by surprise.
  pp.extra.push(report('20261103-1100-ai', { state: 'away', tz: 'Europe/Paris' }));
  const a = pass(pp);
  assert.equal(pp.product().doc.state, 'paused');
  assert.equal(pp.product().doc.away, undefined);
  assert.equal(pp.product().doc.request.id, pp.extra[2].id);
  assert.equal(a.answers.find((x) => x.report === pp.extra[2].id).push, `Not applied: ${PRODUCT} is paused, and trip mode can't be set while it is paused.`);
  assert.deepEqual(a.applied, []);
  const rev = pp.product().rev;
  pass(pp);
  assert.equal(pp.product().rev, rev, 'not tried again');
  const fromLight = setup({ state: 'light', reports: [report('20261103-0915-aj', { state: 'away' })] });
  const l = pass(fromLight);
  assert.equal(fromLight.product().doc.state, 'light');
  assert.deepEqual(l.answers.map((x) => x.push), [`Not applied: ${PRODUCT} is in light mode, and trip mode can't be set from light mode.`]);
});

test('L515 A: only the newest request by arrival applies; every older one is told so, a replayed one too', () => {
  const older = report('20261103-0915-ak', { state: 'away', tz: 'Europe/Paris' });
  const newest = report('20261103-0920-al', { state: 'paused' });
  const s = setup({ reports: [newest, older] });   // listed newest first: order comes from the record's number, not the list
  const r = pass(s);
  assert.equal(s.product().doc.state, 'paused');
  assert.equal(s.product().doc.away, undefined, 'the older trip request never applied');
  const by = Object.fromEntries(r.answers.map((a) => [a.report, a.push]));
  assert.equal(by[older.id], `Not applied: a newer request for ${PRODUCT} came in.`);
  assert.equal(by[newest.id], `Confirmed: ${PRODUCT} is paused.`);
  // A report numbered before the one applied: never applied, and answered.
  sendAll(s, r);
  const late = report('20261103-0900-am', { state: 'away', tz: 'Europe/Paris' }, { rid: 'state-F-0' });
  s.extra.push(late);
  const rev = s.product().rev;
  const l = pass(s);
  assert.equal(s.product().rev, rev);
  assert.deepEqual(l.answers, [{ report: late.id, push: `Not applied: a newer request for ${PRODUCT} came in.` }]);
  // The same minute, and numbers that sort the other way as text: 10 is after 9.
  const a = report('20261103-1200-an', { state: 'away', tz: 'Europe/Paris' }, { rid: 'state-F-9' });
  const b = report('20261103-1200-ao', { state: 'paused' }, { rid: 'state-F-10' });
  const tie = setup({ reports: [b, a] });
  pass(tie);
  assert.deepEqual([tie.product().doc.state, tie.product().doc.request.id], ['paused', 'state-F-10']);
});

test('a restart re-applies nothing: the product\'s request marker holds, and an unmarked answer is handed back, never lost', () => {
  const rep = report('20261103-0915-ap', { state: 'away', tz: 'Europe/Paris' });
  const s = setup({ reports: [rep], stateDir: false });
  pass(s);
  const rev = s.product().rev;
  for (let i = 0; i < 3; i++) {
    const r = pass(s);
    assert.equal(s.product().rev, rev, 'never written again');
    assert.deepEqual(r.answers, [{ report: rep.id, push: `Confirmed: trip mode for ${PRODUCT}.` }], 'handed back each pass until it is marked');
  }
  assert.equal(markStateAnswerTold(s.ctx, rep.id).ok, false, 'a mark names its answer');
  // A marker of the wrong shape never holds requests back.
  const bad = setup({ doc: { request: { id: 7 } }, reports: [report('20261103-0915-aq', { state: 'paused' })] });
  pass(bad);
  assert.equal(bad.product().doc.state, 'paused');
});

test('unreadable or wrong role: never applied, "Not applied … Say it again", MAIN alerted once', () => {
  const reps = [
    report('20261103-0915-ar', { state: 'paused' }, { role: 'worker' }),
    report('20261103-0916-as', { state: 'paused' }, { text: '{"product":"x","state":"active"}\n' }),
    report('20261103-3500-at', { state: 'paused' }),
  ];
  const s = setup({ reports: reps });
  const r = pass(s);
  assert.equal(s.product().doc.state, 'active');
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.answers.map((a) => a.push), reps.map(() => 'Not applied: that request could not be read. Say it again.'));
  assert.equal(r.refused.length, 3);
  const alerts = s.t.alerts.filter((a) => a.kind === 'state_request_refused');
  assert.equal(alerts.length, 3);
  pass(s);
  assert.equal(s.t.alerts.filter((a) => a.kind === 'state_request_refused').length, 3, 'once per report and reason');
});

test('no product record: not applied and told; a refused write is not answered and is tried again next pass', () => {
  const none = setup({ state: null, reports: [report('20261103-0915-au', { state: 'paused' })] });
  assert.deepEqual(pass(none).answers.map((a) => a.push), [`Not applied: ${PRODUCT} has no record on the Mini yet.`]);
  assert.equal(none.product(), null, 'a request never creates the product');
  const rep = report('20261103-0915-av', { state: 'paused' });
  const s = setup({ reports: [rep] });
  s.box.write = () => ({ ok: false, reason: 'planted refusal' });
  const r = pass(s);
  assert.deepEqual(r.answers, [], '"Confirmed" never goes out before the write');
  assert.match(r.refused[0].reason, /planted refusal/);
  assert.equal(s.t.alerts.filter((a) => a.kind === 'state_request_refused').length, 1);
  s.box.write = (w) => s.t.record.write(w);
  const again = pass(s);
  assert.equal(s.product().doc.state, 'paused', 'applied on the next pass');
  assert.deepEqual(again.answers, [{ report: rep.id, push: `Confirmed: ${PRODUCT} is paused.` }]);
});

test('every answer the pass gives is one of STATE_ANSWERS (the list shared/no-promise.test.mjs pins)', () => {
  const s = setup({ reports: [report('20261103-0915-aw', { state: 'paused' }), report('20261103-0914-ax', { state: 'away' }),
    report('20261103-0913-ay', { state: 'paused' }, { role: 'worker' })] });
  const allowed = new Set(Object.values(STATE_ANSWERS).map((f) => f(PRODUCT)));
  for (const a of pass(s).answers) assert.ok(allowed.has(a.push), a.push);
});

// L219 + L221's class: the pass is run by what runs in production, and its answers reach the owner.
const told = (s, opts) => {
  s.ctx.alert = fakeAlert(opts);
  return () => s.ctx.alert.texts.filter((a) => a.type === 'state_answer');
};

test('schedulePass applies a pause, tells the owner once, and the product it reads is the paused one', async () => {
  const rep = report('20261103-0915-aa', { state: 'paused' });
  const s = setup({ reports: [rep] });
  const seen = told(s);
  const r = await schedulePass(s.ctx);
  assert.equal(r.ok, true, r.reason);
  assert.equal(s.product().doc.state, 'paused');
  assert.deepEqual(r.events.filter((e) => e.type === 'state_applied'), [{ type: 'state_applied', report: rep.id, state: 'paused' }]);
  assert.deepEqual(seen(), [{ type: 'state_answer', product: PRODUCT, report: rep.id, text: STATE_ANSWERS.paused(PRODUCT) }]);
  await schedulePass(s.ctx);
  assert.equal(seen().length, 1, 'told once');
});

for (const [name, opts] of [['answers false', { answer: false }], ['answers nothing', { answer: () => undefined }], ['throws', { throws: new Error('down') }]]) {
  test(`schedulePass: a sink that ${name} leaves the answer unmarked, so it is told again next pass`, async () => {
    const rep = report('20261103-0915-ab', { state: 'paused' });
    const s = setup({ reports: [rep] });
    const seen = told(s, opts);
    const r = await schedulePass(s.ctx);
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.events.filter((e) => e.type === 'state_answer_not_told'), [{ type: 'state_answer_not_told', report: rep.id }]);
    await schedulePass(s.ctx);
    assert.equal(seen().length, 2);
  });
}

test('L515 A: the name\'s time orders nothing: one dated far ahead neither wins nor holds a later request back', () => {
  const ahead = report('20991103-0915-aa', { state: 'away', tz: 'Asia/Tokyo', until: '2099-11-20' });
  const s = setup({ reports: [ahead] });
  sendAll(s, pass(s));
  assert.equal(s.product().doc.state, 'away', 'arrival decides, and the owner is told');
  assert.deepEqual(s.product().doc.request, { id: ahead.id, at: '20991103-0915' }, 'the time is kept as information');
  const real = report('20261103-0915-ab', { state: 'paused' });
  s.extra.push(real);
  assert.deepEqual(pass(s).answers, [{ report: real.id, push: STATE_ANSWERS.paused(PRODUCT) }]);
  assert.equal(s.product().doc.state, 'paused');
});

test('a newest report at or before the product\'s marker is never applied, even with the marked report gone from the list', () => {
  const s = setup({ doc: { request: { id: 'state-F-999999', at: '20261103-0900' } }, reports: [report('20261103-0915-ap', { state: 'paused' })] });
  assert.deepEqual(pass(s).answers.map((a) => a.push), [STATE_ANSWERS.newer(PRODUCT)]);
  assert.equal(s.product().doc.state, 'active');
});

test('a report with no record number can\'t be ordered: unreadable, never applied', () => {
  const s = setup({ reports: [report('20261103-0915-aq', { state: 'paused' }, { rid: 'state-F-x' })] });
  assert.deepEqual(pass(s).answers.map((a) => a.push), [STATE_ANSWERS.unreadable()]);
  assert.equal(s.product().doc.state, 'active');
});

test('L515 M5: a pause sent after a flight west, with an earlier local clock, still pauses', () => {
  const s = setup({ reports: [report('20261103-0900-ac', { state: 'away', tz: 'America/Los_Angeles' })] });
  sendAll(s, pass(s));
  s.extra.push(report('20261103-0600-ad', { state: 'paused' }));
  assert.deepEqual(pass(s).answers.map((a) => a.push), [STATE_ANSWERS.paused(PRODUCT)]);
  assert.equal(s.product().doc.state, 'paused');
});

test('L515 M7: another product\'s report gets no answer and no alert here; its own pass answers it', () => {
  const s = setup({ reports: [report('20261103-0915-ae', { state: 'paused' }, { product: 'other-app' })] });
  const r = pass(s);
  assert.deepEqual([r.answers, r.refused, r.applied], [[], [], []]);
  assert.equal(s.product().doc.state, 'active');
});

test('L515 M2: told "no record yet" is final: once the product exists it is not applied, and a later request is', () => {
  const rep = report('20261103-0915-af', { state: 'paused' });
  const s = setup({ state: null, reports: [rep] });
  sendAll(s, pass(s));
  must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'active' } }), 'onboard');
  assert.deepEqual(pass(s).answers, []);
  assert.equal(s.product().doc.state, 'active');
  const next = report('20261103-0916-ag', { state: 'paused' });
  s.extra.push(next);
  assert.deepEqual(pass(s).answers, [{ report: next.id, push: STATE_ANSWERS.paused(PRODUCT) }]);
  assert.equal(s.product().doc.state, 'paused');
});

test('L515 M2: not yet told "no record yet" stays open, and the owner is told what really happened', () => {
  const rep = report('20261103-0915-ah', { state: 'paused' });
  const s = setup({ state: null, reports: [rep] });
  pass(s);
  must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'active' } }), 'onboard');
  assert.deepEqual(pass(s).answers, [{ report: rep.id, push: STATE_ANSWERS.paused(PRODUCT) }]);
});

test('L515 M3: the told mark is the Record\'s: past any number of reports nothing is told twice, with no state file', () => {
  const reps = Array.from({ length: 505 }, () => report('20261103-0915-ai', { state: 'paused' }));
  const s = setup({ reports: reps, stateDir: false });
  const seen = told(s);
  stateRequestStep(s.ctx);
  assert.equal(seen().length, 505);
  assert.equal(s.t.record.list('fact').filter((f) => f.id.startsWith('state-told-')).length, 505);
  stateRequestStep(s.ctx);
  assert.equal(seen().length, 505);
});

test('L515 B: a changed outcome is told, the same one never: the answer the product records moves on', () => {
  const rep = report('20261103-0915-aj', { state: 'paused' });
  const s = setup({ reports: [rep] });
  sendAll(s, pass(s));
  assert.deepEqual(pass(s).answers, []);
  const cur = s.product();
  must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: cur.rev, doc: { ...cur.doc, request_answer: STATE_ANSWERS.awayWhilePaused(PRODUCT) } }), 'changed');
  const r = pass(s);
  assert.deepEqual(r.answers, [{ report: rep.id, push: STATE_ANSWERS.awayWhilePaused(PRODUCT) }]);
  sendAll(s, r);
  assert.deepEqual(pass(s).answers, []);
});

test('L515 m6: a re-tell with the stored answer gone says what the product is, not always "paused"; a told one stays as told', () => {
  const rep = report('20261103-0915-ak', { state: 'away', tz: 'Europe/Paris' });
  const s = setup({ reports: [rep] });
  pass(s);
  const drop = () => { const c = s.product(); const { request_answer, ...rest } = c.doc; must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: c.rev, doc: rest }), 'other writer'); };
  drop();
  assert.deepEqual(pass(s).answers.map((a) => a.push), [STATE_ANSWERS.away(PRODUCT)]);
  sendAll(s, pass(s));
  const c = s.product();
  must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: c.rev, doc: { ...c.doc, state: 'active' } }), 'the trip ended');
  assert.deepEqual(pass(s).answers, [], 'nothing to re-tell: the mark holds what was told');
});

// A record that keeps the product write but refuses every told mark.
const noMarks = (s) => { const w = s.box.write; s.box.write = (x) => (x.entity === 'fact' ? { ok: false, reason: 'planted refusal' } : w(x)); };

test('L515 M4: a told mark the record refuses alerts MAIN once and the owner is not told again; a working record then takes it', () => {
  const rep = report('20261103-0915-am', { state: 'paused' });
  const s = setup({ reports: [rep] });
  const seen = told(s);
  noMarks(s);
  const main = () => s.ctx.alert.texts.filter((a) => a.kind === 'state_request_refused');
  const ev = stateRequestStep(s.ctx);
  assert.deepEqual(ev.filter((e) => e.type === 'state_answer_not_marked').map((e) => e.report), [rep.id]);
  for (let i = 0; i < 4; i++) stateRequestStep(s.ctx);
  assert.equal(seen().length, 1, 'told once');
  assert.equal(main().length, 1, 'MAIN told once');
  assert.equal(main()[0].report, rep.id);
  assert.match(main()[0].error, /planted refusal/);
  s.box.write = (w) => s.t.record.write(w);
  stateRequestStep(s.ctx);
  stateRequestStep(s.ctx);
  assert.equal(seen().length, 1);
  assert.equal(s.t.record.read('fact', `state-told-${rep.id}`).doc.answer, STATE_ANSWERS.paused(PRODUCT));
  assert.equal(main().length, 1);
  assert.equal(readFileSync(join(s.ctx.stateDir, 'state-marks-refused.json'), 'utf8'), '{}\n', 'the file holds only what is still stuck');
});

test('L515 M4: a new answer for a report whose mark is stuck is still told', () => {
  const rep = report('20261103-0915-an', { state: 'paused' });
  const s = setup({ reports: [rep] });
  const seen = told(s);
  noMarks(s);
  stateRequestStep(s.ctx);
  const cur = s.product();
  must(s.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: cur.rev, doc: { ...cur.doc, request_answer: STATE_ANSWERS.awayWhilePaused(PRODUCT) } }), 'changed');
  stateRequestStep(s.ctx);
  assert.deepEqual(seen().map((a) => a.text), [STATE_ANSWERS.paused(PRODUCT), STATE_ANSWERS.awayWhilePaused(PRODUCT)]);
});

test('L515 m3: a throw in the state step is alerted once and the rest of the schedule pass still runs', async () => {
  const s = setup();
  const seen = fakeAlert(); s.ctx.alert = seen;
  const list = s.ctx.record.list;
  let bad = true;
  s.ctx.record.list = (e) => { if (e === 'report' && bad) throw new Error('planted list failure'); return list(e); };
  const failed = () => seen.texts.filter((a) => a.kind === 'state_request_refused');
  const r = await schedulePass(s.ctx);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.events.filter((e) => e.type === 'state_step_failed'), [{ type: 'state_step_failed', error: 'planted list failure' }]);
  await schedulePass(s.ctx);
  assert.equal(failed().length, 1, 'once');
  bad = false;
  await schedulePass(s.ctx);
  bad = true;
  await schedulePass(s.ctx);
  assert.equal(failed().length, 2, 'told again after it had cleared');
});

test('L515 m4: the step runs before schedulePass reads the product, so the window follows the state just written', async () => {
  const s = setup({ reports: [report('20261103-0915-ao', { state: 'paused' })] });
  const log = [];
  const { read, write } = s.ctx.record;
  s.ctx.record.read = (e, i) => { if (e === 'product') log.push('read'); return read(e, i); };
  s.ctx.record.write = (w) => { if (w.entity === 'product') log.push('write'); return write(w); };
  const r = await schedulePass(s.ctx);
  assert.equal(r.ok, true, r.reason);
  assert.ok(log.lastIndexOf('read') > log.indexOf('write') && log.includes('write'), log.join(' '));
});
