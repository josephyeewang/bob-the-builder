// state-request.mjs — a pause or trip-mode request from the owner's phone, applied to the product (M1 join item 13;
// lead calls L151 M-1, L213, L219). The Front Door writes `state-<id>.json` { product, state: paused | away, until, tz };
// the record keeps it as an inert report; this pass is the one place that turns it into the product's state, after
// checking its text again with the Front Door's own check (M1 outbox.mjs). Only approvals writes a product.
//
// NOT LIVE YET. schedulePass runs this pass (stateRequestStep), but the record still refuses `state-` (shared
// OUTBOX_KINDS, refused until a lead call unrefuses it), so in the real flow no state- report reaches it today; the
// trip push (M1 join item 4) waits on that call too. Nothing moves a product from away back to active at `until`:
// `until` is stored only, and the way back (the owner's "I'm back", a request- file) is lane 2's.
//
//   applyStateRequests(ctx) → { applied: [{ report, state }], answers: [{ report, push }], refused: [{ report, reason }] }
//     Only the newest request per product is applied: newest by the report's own time (the `<id>` in its file name,
//     YYYYMMDD-HHMM, as the Front Door wrote it), ties broken by the report's record id. The product doc keeps
//     `request: { id, at }` of the last one applied, and a report not newer than that is never applied, so a restart or
//     an older report arriving late can't apply again (L219 a).
//     Every request gets one answer to the owner (L219 b): "Confirmed: …" only after the product write went through, a
//     "Not applied: …" sentence for one that was passed over or refused. `answers` holds every answer not yet marked
//     sent: the caller sends each push, then calls markStateAnswerSent(ctx, report). Anything not marked is handed back
//     next pass. A write the record refused is not answered: the report is tried again next pass (it is still newer),
//     and MAIN is alerted once per report and reason.
//   markStateAnswerSent(ctx, report) → { ok } | { ok: false, reason }  kept in ctx.stateDir (state-answers-sent.json);
//     with no stateDir nothing is kept, so every answer is handed back each pass. A lost file means an answer is sent
//     again, never that one is lost.
//
// What each request does to the product (M9 moves.mjs; L219 c):
//   pause, from active or light → paused, return_to the state it left;  from away → paused, return_to away, the away
//   block kept;  while already paused → no change of state, the request recorded, confirmed.
//   away, from active → away { tz, until };  while already away → the away block replaced;  while paused or in light
//   mode → not applied (M9 has no paused → away for a request, and none from light), and the request recorded so it
//   is not applied later by surprise.
//   A product with no record yet is not applied: its record is made by onboarding (onboard.mjs), not by a request.
//   A request whose time is more than a day ahead of the Mini's clock is unreadable: as the newest it would pass over
//   every real request, and as the stored marker hold them all back (L329's class).
//
//   stateRequestStep(ctx) → events   the pass inside schedulePass: applies, then tells the owner each answer as an alert
//     { type: 'state_answer', product, report, text }, the phone push not being wired (approvals_no_push). An answer is
//     marked sent only when the sink took it, so a lost one is told again next pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOutboxFile } from '../M1-front-door/outbox.mjs';
import { writeDoc } from './ask-store.mjs';
import { onceAlerts, safeAlert } from './research-ask.mjs';

export const STATE_REPORT_KIND = 'state-';
const SENT_FILE = 'state-answers-sent.json';
const MAX_SENT = 500;
// The name's time is the owner's own clock in any zone, so only a time past every zone counts as ahead of the Mini's.
const AHEAD_MS = 26 * 3600 * 1000;
// checkOutboxFile has already passed the name; this reads the time out of it.
const TIME_OF = /^state-(\d{8}-\d{4})-[a-z]{2}\.json$/;

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
});

// Newer: by the report's own time, then by its record id.
const newer = (a, b) => !b || a.at > b.at || (a.at === b.at && a.id > b.id);
const stampMs = (t) => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13));

function readSent(ctx) {
  if (!ctx.stateDir) return {};
  try {
    const f = join(ctx.stateDir, SENT_FILE);
    const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function markStateAnswerSent(ctx, report) {
  if (typeof report !== 'string' || !report) return { ok: false, reason: 'which report' };
  if (!ctx.stateDir) return { ok: false, reason: 'no stateDir: nothing is kept, so the answer is handed back next pass' };
  const sent = readSent(ctx);
  sent[report] = true;
  const keys = Object.keys(sent);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SENT))) delete sent[k];
  try {
    mkdirSync(ctx.stateDir, { recursive: true });
    writeFileSync(join(ctx.stateDir, SENT_FILE), `${JSON.stringify(sent)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e?.code ?? e?.message ?? e) }; }
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
  const sent = readSent(ctx);
  const refused = [];   // alerted to MAIN once per report and reason
  const answers = [];
  const applied = [];
  const answer = (report, push) => { if (!sent[report]) answers.push({ report, push }); };

  // Every state- report, checked; the readable ones in order, oldest first.
  const ok = [];
  for (const rep of record.list('report')) {
    const d = rep.doc;
    if (rep.corrupt || !d || d.kind !== STATE_REPORT_KIND) continue;
    const no = (reason) => { refused.push({ report: rep.id, reason }); answer(rep.id, STATE_ANSWERS.unreadable()); };
    try {
      if (d.role !== 'front_door') { no('a state request comes only from the Front Door'); continue; }
      const r = checkOutboxFile(String(d.source ?? ''), String(d.text ?? ''));
      if (!r.ok) { no(r.reason); continue; }
      if (r.kind !== 'state') { no('not a state request'); continue; }
      if (r.doc.product !== product) { no('that product is not this record\'s'); continue; }
      const t = TIME_OF.exec(String(d.source))?.[1];
      if (!t) { no('the request has no time in its name'); continue; }
      if (stampMs(t) > ctx.now() + AHEAD_MS) { no('the request\'s time lies in the future'); continue; }
      ok.push({ rep, req: r.doc, at: { id: rep.id, at: t } });
    } catch (e) {
      refused.push({ report: rep.id, reason: 'the pass failed on it', error: String(e?.message ?? e) });
    }
  }
  ok.sort((a, b) => (newer(a.at, b.at) ? 1 : newer(b.at, a.at) ? -1 : 0));

  const cur = record.read('product', product);
  const last = ok.at(-1);
  const curDoc = cur && !cur.corrupt && cur.doc && typeof cur.doc === 'object' ? cur.doc : null;
  // A marker of the wrong shape counts as none, so it can never hold every later request back.
  const r0 = curDoc?.request;
  const stored = r0 && typeof r0.id === 'string' && typeof r0.at === 'string' ? r0 : null;
  for (const x of ok) {
    if (x !== last) { answer(x.rep.id, STATE_ANSWERS.newer(product)); continue; }
    // The newest one: answered as applied if the product already records it (or a newer one), else applied now.
    if (stored && !newer(x.at, stored)) {
      if (stored.id === x.at.id) answer(x.rep.id, curDoc.request_answer ?? STATE_ANSWERS.paused(product));
      else answer(x.rep.id, STATE_ANSWERS.newer(product));
      continue;
    }
    if (!curDoc) { answer(x.rep.id, STATE_ANSWERS.noProduct(product)); continue; }
    const n = nextDoc(curDoc, x.req, x.at);
    const w = writeDoc(record, 'product', { id: product, rev: cur.rev }, { ...n.doc, request_answer: n.answer });
    if (!w.ok) { refused.push({ report: x.rep.id, reason: `the record refused the product write: ${w.reason}` }); continue; }
    if (!n.notApplied) applied.push({ report: x.rep.id, state: n.doc.state });
    answer(x.rep.id, n.answer);
  }
  onceAlerts(ctx, refused, { file: 'state-refused.json', make: (f) => ({ kind: 'state_request_refused', ...f }), alert,
    notSaved: 'state_refused_state_not_saved' });
  return { applied, answers, refused, ...(failed.n ? { alerts_failed: failed.n } : {}) };
}

export function stateRequestStep(ctx) {
  const r = applyStateRequests(ctx);
  const events = r.applied.map((a) => ({ type: 'state_applied', ...a }));
  for (const { report, push } of r.answers) {
    let took = false;
    try { took = ctx.alert({ type: 'state_answer', product: ctx.product, report, text: push }) === true; } catch { took = false; }
    if (!took) { events.push({ type: 'state_answer_not_told', report }); continue; }
    const m = markStateAnswerSent(ctx, report);
    if (!m.ok) events.push({ type: 'state_answer_not_marked', report, reason: m.reason });
  }
  return events;
}
