// state-request.test.mjs — M1 join item 13 (L151 M-1, L213, L219): a pause or trip-mode request applied to the product.
//
// The record still refuses `state-` (shared OUTBOX_KINDS), so no real outbox write can store one today. The reports
// below are the shape the record's own create mode keeps (record.mjs applyOutbox: kind, role, session_id, source,
// text), added to the real record's report list by a thin wrapper; every product write still goes through the real
// M9 writer. When a lead call unrefuses state-, these switch to t.record.applyOutbox like research-ask.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { outboxFile } from '../M1-front-door/outbox.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { env as m2env, must, PRODUCT } from './fixtures.test-helper.mjs';
import { STATE_ANSWERS, applyStateRequests, markStateAnswerSent } from './state-request.mjs';

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
  const ctx = { ...t.ctx, record, ...(stateDir ? { stateDir: join(tempDir('orch-state-req-'), 'state') } : {}) };
  return { t, ctx, extra, box, product: () => rec.read('product', PRODUCT) };
}
const pass = (s) => applyStateRequests(s.ctx);
const sendAll = (s, r) => { for (const a of r.answers) assert.equal(markStateAnswerSent(s.ctx, a.report).ok, true); };

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

test('L219 a/b: only the newest request applies (its own time, then its id); every older one is told so, a late one too', () => {
  const older = report('20261103-0915-ak', { state: 'away', tz: 'Europe/Paris' });
  const newest = report('20261103-0920-al', { state: 'paused' });
  const s = setup({ reports: [newest, older] });   // listed newest first: order comes from the time, not the list
  const r = pass(s);
  assert.equal(s.product().doc.state, 'paused');
  assert.equal(s.product().doc.away, undefined, 'the older trip request never applied');
  const by = Object.fromEntries(r.answers.map((a) => [a.report, a.push]));
  assert.equal(by[older.id], `Not applied: a newer request for ${PRODUCT} came in.`);
  assert.equal(by[newest.id], `Confirmed: ${PRODUCT} is paused.`);
  // An older report arriving late, after the newer one applied: never applied, and answered.
  sendAll(s, r);
  const late = report('20261103-0900-am', { state: 'away', tz: 'Europe/Paris' });
  s.extra.push(late);
  const rev = s.product().rev;
  const l = pass(s);
  assert.equal(s.product().rev, rev);
  assert.deepEqual(l.answers, [{ report: late.id, push: `Not applied: a newer request for ${PRODUCT} came in.` }]);
  // A tie on time: the higher record id is the newer.
  const a = report('20261103-1200-an', { state: 'away', tz: 'Europe/Paris' }, { rid: 'state-F-a' });
  const b = report('20261103-1200-ao', { state: 'paused' }, { rid: 'state-F-b' });
  const tie = setup({ reports: [b, a] });
  pass(tie);
  assert.deepEqual([tie.product().doc.state, tie.product().doc.request.id], ['paused', 'state-F-b']);
});

test('a restart re-applies nothing: the product\'s request marker holds even with the answers file gone', () => {
  const rep = report('20261103-0915-ap', { state: 'away', tz: 'Europe/Paris' });
  const s = setup({ reports: [rep], stateDir: false });
  pass(s);
  const rev = s.product().rev;
  for (let i = 0; i < 3; i++) {
    const r = pass(s);
    assert.equal(s.product().rev, rev, 'never written again');
    assert.deepEqual(r.answers, [{ report: rep.id, push: `Confirmed: trip mode for ${PRODUCT}.` }], 'no stateDir: the answer is handed back each pass, never lost');
  }
  assert.equal(markStateAnswerSent(s.ctx, rep.id).ok, false);
  // A marker of the wrong shape never holds requests back.
  const bad = setup({ doc: { request: { id: 7 } }, reports: [report('20261103-0915-aq', { state: 'paused' })] });
  pass(bad);
  assert.equal(bad.product().doc.state, 'paused');
});

test('unreadable, wrong role or another product\'s: never applied, "Not applied … Say it again", MAIN alerted once', () => {
  const reps = [
    report('20261103-0915-ar', { state: 'paused' }, { role: 'worker' }),
    report('20261103-0916-as', { state: 'paused' }, { text: '{"product":"x","state":"active"}\n' }),
    report('20261103-0917-at', { state: 'paused' }, { product: 'other-app' }),
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
