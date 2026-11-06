// state-request.mjs — a pause or trip-mode request from the owner's phone, applied to the product (M1 join item 13;
// lead calls L151 M-1, L213, L219, L515). The Front Door writes `state-<id>.json` { product, state: paused | away, until, tz };
// the record keeps it as an inert report; this pass is the one place that turns it into the product's state, after
// checking its text again with the Front Door's own check (M1 outbox.mjs). Only approvals writes a product.
//
// NOT LIVE YET. schedulePass runs this pass (stateRequestStep), but the record still refuses `state-` (shared
// OUTBOX_KINDS, refused until a lead call unrefuses it), so in the real flow no state- report reaches it today; the
// trip push (M1 join item 4) waits on that call too. Nothing moves a product from away back to active at `until`:
// `until` is stored only, and the way back (the owner's "I'm back", a request- file) is lane 2's.
//
//   applyStateRequests(ctx) → { applied: [{ report, state }], answers: [{ report, push }], refused: [{ report, reason }] }
//     Requests are ordered by when they reached the Mini: the record's number at the end of the report's id, as a
//     number (L515 A). The time in the file name is the owner's best guess in the owner's zone, so it is kept as
//     information only and orders nothing. Only the newest request per product is applied. The product doc keeps
//     `request: { id, at }` of the last one applied, and a report not newer than that is never applied, so a restart
//     or a replayed report can't apply again. A report for another product is skipped with no answer: its own pass
//     answers it (L515 M7); one naming a product with no record, which no pass answers, is told it has none (L686).
//     Every request gets one answer to the owner (L219 b): "Confirmed: …" only after the product write went through, a
//     "Not applied: …" sentence for one that was passed over or refused. `answers` holds every answer not yet told:
//     the caller tells each, then calls markStateAnswerTold. Anything not marked is handed back next pass. A write the
//     record refused is not answered: the report is tried again next pass (it is still newer), and MAIN is alerted
//     once per report and reason.
//   markStateAnswerTold(ctx, report, push) → { ok } | { ok: false, reason }  one fact per report in the Record,
//     `state-told-<report>` { type: 'state_told', report, answer } (L515 B). A told report is settled: its outcome is
//     final, so one told "no record yet" or "could not be read" is never applied later (L515 M2, M1). Only the one the
//     product itself records can have a new outcome, and then the new answer is told; the same answer never is.
//
// What each request does to the product (M9 moves.mjs; L219 c):
//   pause, from active or light → paused, return_to the state it left;  from away → paused, return_to away, the away
//   block kept;  while already paused → no change of state, the request recorded, confirmed.
//   away, from active → away { tz, until };  while already away → the away block replaced;  while paused or in light
//   mode → not applied (M9 has no paused → away for a request, and none from light), and the request recorded so it
//   is not applied later by surprise.
//   A product with no record yet is not applied: its record is made by onboarding (onboard.mjs), not by a request.
//
//   stateRequestStep(ctx) → events   the pass inside schedulePass: applies, then tells the owner each answer as an alert
//     { type: 'state_answer', product, report, text }, the phone push not being wired (approvals_no_push). An answer is
//     marked told only when the sink took it, so a lost one is told again next pass. A mark the record refuses is
//     alerted to MAIN once and the answer is not told again: a small file in ctx.stateDir holds only those reports, for
//     as long as the Record can't. With no stateDir either, the answer is told each pass. A throw inside the step is
//     alerted once and stops only this step, not the rest of the schedule pass (L515 m3).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOutboxFile } from '../M1-front-door/outbox.mjs';
import { writeDoc } from './ask-store.mjs';
import { onceAlerts, safeAlert } from './research-ask.mjs';

export const STATE_REPORT_KIND = 'state-';
export const STATE_TOLD_FACT = 'state-told-';
const MARK_FILE = 'state-marks-refused.json';
const STEP_FILE = 'state-step-failed.json';
const NOT_SAVED = 'state_refused_state_not_saved';
// checkOutboxFile has already passed the name's shape; this also says the time is a real one. It orders nothing.
const TIME_OF = /^state-(\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-(?:[01]\d|2[0-3])[0-5]\d)-[a-z]{2}\.json$/;

// Every sentence this pass shows the owner (L219 d). Each is pinned in shared/no-promise.test.mjs STATE_APPLY_SHOWN;
// a new or changed one goes red there until someone reads it. None promises an action: "Confirmed" is said only of a
// write that went through, and nothing here says when or how the state ends.
export const STATE_ANSWERS = Object.freeze({
  paused: (p) => `Confirmed: ${p} is paused.`,
  away: (p) => `Confirmed: trip mode for ${p}.`,
  newer: (p) => `Not applied: a newer request for ${p} came in.`,
  awayWhilePaused: (p) => `Not applied: ${p} is paused, and trip mode can't be set while it is paused.`,
  awayFromLight: (p) => `Not applied: ${p} is in light mode, and trip mode can't be set from light mode.`,
  noProduct: (p) => `Not applied: ${p} has no record on the Mini yet.`,
  unreadable: () => 'Not applied: that request could not be read. Say it again.',
  cantTell: (p) => `Not sure: a later request for ${p} came in before this one's answer was saved, so whether it was applied can't be told.`,
});

// The record's number at the end of a report id (`state-<session>-<n>`), one count across every session; null if none.
const seqOf = (id) => {
  const m = /-(\d+)$/.exec(String(id));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};
const newer = (a, b) => !b || seqOf(a.id) > seqOf(b.id);

const toldId = (report) => `${STATE_TOLD_FACT}${report}`;
function toldMark(record, report) {
  const f = record.read('fact', toldId(report));
  return f ? { rev: f.rev, answer: typeof f.doc?.answer === 'string' ? f.doc.answer : null } : null;
}

export function markStateAnswerTold(ctx, report, push) {
  if (typeof report !== 'string' || !report || typeof push !== 'string' || !push) return { ok: false, reason: 'which report and answer' };
  try {
    const cur = toldMark(ctx.record, report);
    const w = writeDoc(ctx.record, 'fact', { id: toldId(report), rev: cur?.rev ?? 0 }, { type: 'state_told', report, answer: push });
    return w.ok ? { ok: true } : { ok: false, reason: String(w.reason) };
  } catch (e) { return { ok: false, reason: String(e?.message ?? e) }; }
}

// The product doc a request makes, or the answer it gets instead.
function nextDoc(cur, req, at) {
  const { product, state, until, tz } = req;
  const from = cur.state;
  const base = { ...cur, request: at };
  if (state === 'paused') {
    if (from === 'paused') return { doc: base, answer: STATE_ANSWERS.paused(product) };
    return { doc: { ...base, state: 'paused', return_to: from }, answer: STATE_ANSWERS.paused(product) };
  }
  if (from === 'paused') return { doc: base, answer: STATE_ANSWERS.awayWhilePaused(product), notApplied: true };
  if (from === 'light') return { doc: base, answer: STATE_ANSWERS.awayFromLight(product), notApplied: true };
  return { doc: { ...base, state: 'away', away: { tz, until } }, answer: STATE_ANSWERS.away(product) };
}

export function applyStateRequests(ctx) {
  const { record, product } = ctx;
  const failed = { n: 0 };
  const alert = safeAlert(ctx, failed);
  const refused = [];   // alerted to MAIN once per report and reason
  const answers = [];
  const applied = [];
  const answer = (report, push, mark, named) => { if (mark?.answer !== push) answers.push({ report, push, ...(named ? { product: named } : {}) }); };

  // Every state- report of this product, checked; the readable ones in the order they reached the Mini, oldest first.
  const ok = [];
  for (const rep of record.list('report')) {
    const d = rep.doc;
    if (rep.corrupt || !d || d.kind !== STATE_REPORT_KIND) continue;
    try {
      const mark = toldMark(record, rep.id);
      const no = (reason) => { refused.push({ report: rep.id, reason }); answer(rep.id, mark?.answer ?? STATE_ANSWERS.unreadable(), mark); };
      if (d.role !== 'front_door') { no('a state request comes only from the Front Door'); continue; }
      const r = checkOutboxFile(String(d.source ?? ''), String(d.text ?? ''));
      if (!r.ok) { no(r.reason); continue; }
      if (r.kind !== 'state') { no('not a state request'); continue; }
      if (r.doc.product !== product) {
        // Another product's request: its own pass answers it. A product with no record has no pass that will, so any
        // pass answers it (L606 M1, L686); the told mark is one per report, so it is told once across every pass.
        if (!mark && record.read('product', String(r.doc.product)) === null) answer(rep.id, STATE_ANSWERS.noProduct(r.doc.product), null, r.doc.product);
        continue;
      }
      const t = TIME_OF.exec(String(d.source))?.[1];
      if (!t) { no('the request has no real time in its name'); continue; }
      if (seqOf(rep.id) === null) { no('the report has no record number'); continue; }
      ok.push({ rep, req: r.doc, mark, at: { id: rep.id, at: t } });
    } catch (e) {
      refused.push({ report: rep.id, reason: 'the pass failed on it', error: String(e?.message ?? e) });
    }
  }
  ok.sort((a, b) => seqOf(a.at.id) - seqOf(b.at.id));

  const cur = record.read('product', product);
  const last = ok.at(-1);
  const curDoc = cur && !cur.corrupt && cur.doc && typeof cur.doc === 'object' ? cur.doc : null;
  // A marker of the wrong shape counts as none, so it can never hold every later request back.
  const r0 = curDoc?.request;
  const stored = r0 && typeof r0.id === 'string' && seqOf(r0.id) !== null ? r0 : null;
  // What the product write decided for a report whose answer is not yet marked told (L606 M2): the request it replaced
  // and the ones it passed over. A later pass reads its answer here, so one that applied is never told "Not applied".
  // Kept only while the report has no told mark; one it doesn't hold is told it can't be told, never the opposite.
  const untoldWas = curDoc?.request_untold && typeof curDoc.request_untold === 'object' && !Array.isArray(curDoc.request_untold) ? curDoc.request_untold : {};
  const hasUntold = curDoc?.request_untold === untoldWas;
  const untold = {};
  const unmarked = new Set(ok.filter((x) => !x.mark).map((x) => x.rep.id));
  if (stored && unmarked.has(stored.id)) untold[stored.id] = typeof curDoc.request_answer === 'string' ? curDoc.request_answer : STATE_ANSWERS.cantTell(product);
  for (const x of ok) {
    const id = x.rep.id;
    // The one the product records: its answer is the product's, and may have changed since it was told.
    if (stored?.id === id) {
      const was = curDoc.state === 'away' ? STATE_ANSWERS.away(product) : STATE_ANSWERS.paused(product);
      answer(id, curDoc.request_answer ?? x.mark?.answer ?? was, x.mark);
      continue;
    }
    if (x.mark) continue;   // settled: told once, its outcome is final and it is never applied later
    // Older than the one recorded: decided by an earlier pass. Every product write carries forward the unmarked ones it
    // decided, so one not there was never applied; a doc written before that list says nothing, so it can't be told.
    // The chosen answer goes into the new list too, so a later write keeps it (m1-r3). This is the one carry-forward of
    // the list: the loop runs oldest first, so every unmarked report older than the stored one passes here before the write.
    if (stored && !newer(x.at, stored)) { untold[id] = typeof untoldWas[id] === 'string' ? untoldWas[id] : hasUntold ? STATE_ANSWERS.newer(product) : STATE_ANSWERS.cantTell(product); answer(id, untold[id]); continue; }
    if (x !== last) { untold[id] = STATE_ANSWERS.newer(product); answer(id, STATE_ANSWERS.newer(product)); continue; }
    if (!curDoc) { answer(id, STATE_ANSWERS.noProduct(product)); continue; }
    const n = nextDoc(curDoc, x.req, x.at);
    const w = writeDoc(record, 'product', { id: product, rev: cur.rev }, { ...n.doc, request_answer: n.answer, request_untold: untold });
    if (!w.ok) { refused.push({ report: id, reason: `the record refused the product write: ${w.reason}` }); continue; }
    if (!n.notApplied) applied.push({ report: id, state: n.doc.state });
    answer(id, n.answer);
  }
  onceAlerts(ctx, refused, { file: 'state-refused.json', make: (f) => ({ kind: 'state_request_refused', ...f }), alert, notSaved: NOT_SAVED });
  return { applied, answers, refused, ...(failed.n ? { alerts_failed: failed.n } : {}) };
}

const refusalAlerts = (ctx, refused, file) => onceAlerts(ctx, refused, { file, make: (f) => ({ kind: 'state_request_refused', ...f }),
  alert: safeAlert(ctx, { n: 0 }), notSaved: NOT_SAVED });
function readHeld(ctx, file) {
  if (!ctx.stateDir) return null;
  try {
    const f = join(ctx.stateDir, file);
    if (!existsSync(f)) return null;
    const v = JSON.parse(readFileSync(f, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
// The fixed reason the held file keeps: it names the answer, so a new answer for the report is still told.
const markRefused = (push) => `the owner was told, but the record refused the told mark: ${push}`;

function tellAnswers(ctx) {
  const r = applyStateRequests(ctx);
  const events = r.applied.map((a) => ({ type: 'state_applied', ...a }));
  const held = readHeld(ctx, MARK_FILE);
  const stuck = [];
  for (const { report, push, product: named } of r.answers) {
    const reason = markRefused(push);
    if (held?.[report] !== reason) {
      let took = false;
      try { took = ctx.alert({ type: 'state_answer', product: named ?? ctx.product, report, text: push }) === true; } catch { took = false; }
      if (!took) { events.push({ type: 'state_answer_not_told', report }); continue; }
    }
    const m = markStateAnswerTold(ctx, report, push);
    if (m.ok) continue;
    events.push({ type: 'state_answer_not_marked', report, reason: m.reason });
    stuck.push({ report, reason, error: m.reason });
  }
  if (stuck.length || held) refusalAlerts(ctx, stuck, MARK_FILE);
  return events;
}

export function stateRequestStep(ctx) {
  try {
    const events = tellAnswers(ctx);
    if (readHeld(ctx, STEP_FILE)) refusalAlerts(ctx, [], STEP_FILE);
    return events;
  } catch (e) {
    const error = String(e?.message ?? e);
    refusalAlerts(ctx, [{ report: 'state step', reason: 'the state request step failed', error }], STEP_FILE);
    return [{ type: 'state_step_failed', error }];
  }
}
