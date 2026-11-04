// plan-go.mjs — the Dispatcher asks the owner for a card's go, and turns a go the owner gave into the go record (L440,
// L442, L443).
//
// WHY. M2 can raise and record a go, and M9 refuses to start a card without one, but nothing called M2: a card needing a
// go sat in draft for ever. A Tier-1 go also needs a fresh plan reviewer's pass, and that pass must come from the
// reviewer's own answer, not from anything a session can write to the Record (L87 item 3).
//
//   planGoPass(ctx, { alert, startPlanReview, planReviewAnswer, planRows, planView, mainSha }) → { ok: true, events }
//     ctx: one product's Approvals context (tick.mjs approvalsStep). The ports take { product, card, ... }:
//     startPlanReview({ lead, product, card, fingerprint, plan_sha256, inputs, wording }) → { ok: true, session } | { ok: false, reason }
//     planReviewAnswer({ product, card, fingerprint, session }) → { ok: true, answer } | { ok: true } while it works | { ok: false, reason }
//     planRows({ product, card }) → { <row id>: row }      planView({ product }) → a repo view      mainSha({ product }) → sha
//
// First the answered gos: each approved ask becomes the go record, once, and a refused one is told. Then each draft card
// goNeeded (M9, the one definition) says wants a go, and only if it is its own root: a fix card runs on its root's go.
//   Tier 2: raised, no plan check (L443 ruling 4).
//   Tier 1: raised only with a pass. Its plan hash or main commit missing: left alone, invents nothing, told. Else one
//   fresh reviewer per fingerprint, its answer read through the port, the author taken from the Record's latest plan write.
// A plan already asked once is never raised again here, whatever became of the ask: "not now" must not come back on the
// next pass (raiseGo's re-ask is for a person who chooses to ask again).
// Everything that stops a card reaches the owner, once a day per card and reason (holdAlert). One card failing never
// stops the next. Facts sit in the Dispatcher's `hold-` family; a stale mark does no harm, and a new plan gets a new review.

import { goNeeded } from '../M9-record/ready.mjs';
import { PLAN_INPUTS } from '../M9-record/permissions.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { goFingerprint, raiseGo, recordGo } from '../M2-approvals/go.mjs';
import { PLAN_REVIEW_WORDING, readPlanReview } from '../M3-lead/lead-wording.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { planPass } from '../../shared/plan-review.mjs';
import { pastTime } from '../../shared/still-waiting.mjs';
import { holdAlert, HOLD_FACT } from './pass.mjs';

// The read-only cap counts a Lead's sessions; plan reviewers count together under this name.
export const PLAN_REVIEW_LEAD = 'plan-review';
// Past this with no answer, the owner hears the reviewer is still silent.
export const PLAN_REVIEW_SLOW_MS = 60 * 60 * 1000;
export const PLAN_REVIEW_FACT = (card) => HOLD_FACT(`plan-review-${card}`);
const cause = (card, why) => `plan-go-${card}-${why}`;
const short = (v) => String(v ?? 'no reason given').replace(/\s+/g, ' ').slice(0, 300);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The session after the `role:` of an actor; a script actor, or a role with no session, names none.
export function namedSession(actor) {
  const a = String(actor ?? '');
  const at = a.indexOf(':');
  return at > 0 && at < a.length - 1 ? a.slice(at + 1) : null;
}

// Who last wrote this card's plan: the actor on the latest diary line that changed a plan input (the creating line counts).
export function planAuthor(lines, cardId) {
  let prev = null;
  let author = null;
  for (const l of lines) {
    for (const w of l.writes ?? []) {
      if (w.entity !== 'card' || w.id !== cardId) continue;
      if (prev === null || PLAN_INPUTS.some((f) => !same(prev[f], w.doc?.[f]))) author = l.actor;
      prev = w.doc ?? {};
    }
  }
  return author;
}

// Answered gos become go records. An ask the owner turned down stays as it is.
function recordGos(ctx, tell, events) {
  for (const a of askStore(ctx.record).asks()) {
    if (a.doc.product !== ctx.product || !activeKind(a.doc.kind)?.go) continue;
    if (a.doc.state !== 'answered' || a.doc.answer?.approves !== true) continue;
    const r = recordGo(ctx, a.id);
    if (r.ok) events.push(`go ${r.go}`);
    else tell(a.doc.card, 'record', `the owner's go on card ${a.doc.card} could not be recorded: ${short(r.reason)}`);
  }
}

// The pass a Tier-1 go needs, or null with the reason told. Starts the reviewer the first time this plan is seen.
async function reviewed(ctx, ports, tell, c, fp) {
  const rec = ctx.record;
  const id = PLAN_REVIEW_FACT(c.id);
  const fact = rec.read('fact', id);
  const f = fact?.doc;
  if (f?.fingerprint !== fp.fingerprint || typeof f?.session !== 'string' || !f.session) {
    const s = await ports.startPlanReview({ lead: PLAN_REVIEW_LEAD, product: ctx.product, card: c.id, fingerprint: fp.fingerprint, plan_sha256: fp.plan_sha256,
      inputs: fp.inputs, wording: PLAN_REVIEW_WORDING });
    if (s?.ok !== true || typeof s.session !== 'string' || !s.session) { tell(c.id, 'start', `no plan reviewer could start for card ${c.id}, so it can't be asked for a go: ${short(s?.reason)}`); return null; }
    const doc = { fingerprint: fp.fingerprint, session: s.session, started_at: new Date(ctx.now()).toISOString() };
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: fact?.rev ?? 0, doc });
    if (!w.ok) tell(c.id, 'start', `the plan reviewer for card ${c.id} started but could not be noted, so another may start: ${short(w.reason)}`);
    return null;
  }
  const a = await ports.planReviewAnswer({ product: ctx.product, card: c.id, fingerprint: fp.fingerprint, session: f.session });
  if (a?.ok !== true) { tell(c.id, 'answer', `the plan reviewer's answer on card ${c.id} could not be read: ${short(a?.reason)}`); return null; }
  if (a.answer === undefined || a.answer === null) {
    const since = pastTime(f.started_at, ctx.now());
    if (since === null || ctx.now() - since >= PLAN_REVIEW_SLOW_MS) tell(c.id, 'slow', `the plan reviewer on card ${c.id} has not answered yet, so it can't be asked for a go`);
    return null;
  }
  const review = readPlanReview(a.answer);
  if (review.ok !== true) { tell(c.id, 'answer', `the plan reviewer's answer on card ${c.id} could not be read: ${short(review.reason)}`); return null; }
  if (review.pass !== true) { tell(c.id, 'question', `the plan reviewer did not pass card ${c.id}: ${short(review.question)}`); return null; }
  const actor = planAuthor(rec.diary(), c.id);
  const author = namedSession(actor);
  if (!author) { tell(c.id, 'author', `card ${c.id}'s plan was last written by ${short(actor)}, not a named session, so its review can't count`); return null; }
  const p = planPass(review, { card: c.id, fingerprint: fp.fingerprint, plan_sha256: fp.plan_sha256, reviewer_session: f.session, author_session: author });
  if (!p.ok) { tell(c.id, 'pass', `the plan review of card ${c.id} can't count: ${short(p.reason)}`); return null; }
  return p.pass;
}

async function raiseFor(ctx, ports, tell, view, st, c, events) {
  const { product, rules } = ctx;
  const n = goNeeded(c, view, rules, product);
  if (!n.needed) return;
  if (!n.root) { tell(c.id, 'chain', `card ${c.id} can't be asked for a go: ${short(n.reason)}`); return; }
  if (n.root.id !== c.id) return;
  const d = c.doc;
  if (d.tier === 1 && (!d.plan_sha256 || !d.main_commit)) { tell(c.id, 'plan', `card ${c.id} is Tier 1 but its plan hash or main commit is missing, so it can't be asked for a go`); return; }
  const fp = goFingerprint(ctx, c.id);
  if (!fp.ok) { tell(c.id, 'plan', `card ${c.id} can't be asked for a go: ${short(fp.reason)}`); return; }
  if (st.asks().some((a) => a.doc.card === c.id && a.doc.fingerprint === fp.fingerprint && activeKind(a.doc.kind)?.go)) return;
  let planCheck;
  if (d.tier === 1) {
    planCheck = await reviewed(ctx, ports, tell, c, fp);
    if (!planCheck) return;
  }
  const r = await raiseGo(ctx, { cardId: c.id, rows: await ports.planRows({ product, card: c.id }), view: await ports.planView({ product }), mainSha: await ports.mainSha({ product }), planCheck });
  if (r.ok) events.push(`asked ${r.id}`);
  else tell(c.id, 'raise', `card ${c.id} could not be asked for a go: ${short(r.reason)}`);
}

export async function planGoPass(ctx, ports) {
  const rec = ctx.record;
  const { alert } = ports;
  const tell = (card, why, text) => holdAlert({ rec, cause: cause(card, why), text, alert, now: ctx.now() });
  const events = [];
  recordGos(ctx, tell, events);
  const view = { get: (e, id) => rec.read(e, id), list: (e) => rec.list(e), createdBy: (e, id) => rec.meta(e, id)?.createdBy ?? null };
  const st = askStore(rec);
  for (const c of rec.list('card')) {
    if (c.corrupt || !c.doc || c.doc.product !== ctx.product || c.doc.state !== 'draft') continue;
    try { await raiseFor(ctx, ports, tell, view, st, c, events); } catch (e) { tell(c.id, 'failed', `asking for a go on card ${c.id} failed: ${short(e?.message ?? e)}`); }
  }
  return { ok: true, events };
}
