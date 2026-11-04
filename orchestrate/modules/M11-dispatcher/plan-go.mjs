// plan-go.mjs — the Dispatcher asks the owner for a card's go, and turns a go the owner gave into the go record (L440,
// L442, L443).
//
// WHY. M2 can raise and record a go, and M9 refuses to start a card without one, but nothing called M2: a card needing a
// go sat in draft for ever. A Tier-1 go also needs a fresh plan reviewer's pass, and that pass must come from the
// reviewer's own answer, not from anything a session can write to the Record (L87 item 3).
//
//   planGoPass(ctx, { alert, startPlanReview, planReviewAnswer, planRows, planView, mainSha, replyToLead }) → { ok: true, events }
//     ctx: one product's Approvals context (tick.mjs approvalsStep). The ports take { product, card, ... }:
//     startPlanReview({ lead, product, card, fingerprint, plan_sha256, inputs, wording }) → { ok: true, session } | { ok: false, reason }
//     planReviewAnswer({ product, card, fingerprint, session }) → { ok: true, answer } | { ok: true } while it works | { ok: false, reason }
//     planRows({ product, card }) → { <row id>: row }      planView({ product }) → a repo view      mainSha({ product }) → sha
//     replyToLead({ lead, text })      leaves a note for the Lead whose session wrote the plan
//
// First the answered gos: each approved ask becomes the go record, once, and a refused one is told. Then each draft card
// goNeeded (M9, the one definition) says wants a go, and only if it is its own root: a fix card runs on its root's go.
//   Tier 2: raised, no plan check (L443 ruling 4).
//   Tier 1: raised only with a pass. Its plan hash or main commit missing: left alone, invents nothing, told. Else one
//   fresh reviewer per fingerprint, its answer read through the port, the author taken from the Record's latest plan write.
// One ask per card and plan (L450), the time of it kept in a fact. The plan's latest ask says what happens next:
//   live, or a go it gave: nothing.
//   Declined: never asked again for this plan. Its Lead is told once, so it can change the plan; a changed plan is a new ask.
//   Expired, no answer: asked again at most once in GO_REASK_MS.
//   Withdrawn: only a changed plan is asked.
//   Used by a go since replaced (plan A, then B, then A again): asked, as M2 allows.
// A declined, expired or withdrawn card is in the owner's daily hold tell while it waits.
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
export const PLAN_ASK_FACT = (card) => HOLD_FACT(`plan-ask-${card}`);
// An ask that ran out with no answer is asked again no sooner than this after the last one.
export const GO_REASK_MS = 24 * 60 * 60 * 1000;
const cause = (card, why) => `plan-go-${card}-${why}`;
// The step's one write: its notes on a card's plan facts.
const noteFact = (rec, id, rev, doc) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rev, doc });
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
    const w = noteFact(rec, id, fact?.rev ?? 0, doc);
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

// The Lead hears once per plan that the owner declined it, and the mark is kept only once it has heard.
async function tellLead(ctx, ports, tell, c, fp) {
  const rec = ctx.record;
  const id = PLAN_ASK_FACT(c.id);
  const fact = rec.read('fact', id);
  if (fact?.doc?.fingerprint === fp.fingerprint && fact.doc.lead_heard_at) return;
  const failed = (why) => tell(c.id, 'lead', `the Lead could not be told the owner declined card ${c.id}'s plan: ${short(why)}`);
  const lead = namedSession(planAuthor(rec.diary(), c.id));
  if (!lead) { failed('no named session wrote the plan'); return; }
  try {
    const r = await ports.replyToLead({ lead, text: `The owner declined the plan for card ${c.id}. It won't be asked again until the plan changes.` });
    if (r?.ok === false) { failed(r.reason); return; }
  } catch (e) { failed(e?.message ?? e); return; }
  const doc = { ...(fact?.doc?.fingerprint === fp.fingerprint ? fact.doc : { fingerprint: fp.fingerprint }), lead_heard_at: new Date(ctx.now()).toISOString() };
  const w = noteFact(rec, id, fact?.rev ?? 0, doc);
  if (!w.ok) failed(`told, but that could not be noted, so it may be told again: ${w.reason}`);
}

// May this plan be asked (again)? The plan's latest ask decides; see the top of this file.
async function mayAsk(ctx, ports, tell, st, c, fp) {
  const asked = st.asks().filter((a) => a.doc.card === c.id && a.doc.fingerprint === fp.fingerprint && activeKind(a.doc.kind)?.go);
  if (!asked.length) return true;
  const stamp = (a) => pastTime(a.doc.created_at, ctx.now()) ?? 0;
  const last = asked.reduce((a, b) => (stamp(b) >= stamp(a) ? b : a));
  const { state, answer } = last.doc;
  if (state === 'consumed') return st.go(`go-${c.id}`)?.doc.ask !== last.id;
  if (state === 'answered' && answer?.approves !== true) {
    tell(c.id, 'declined', `the owner declined card ${c.id}'s plan, so it waits until the Lead changes the plan`);
    await tellLead(ctx, ports, tell, c, fp);
    return false;
  }
  if (state === 'withdrawn') { tell(c.id, 'withdrawn', `the ask for a go on card ${c.id} was withdrawn, so it waits until its plan changes`); return false; }
  if (state !== 'expired') return false;
  const fact = ctx.record.read('fact', PLAN_ASK_FACT(c.id))?.doc;
  const times = [fact?.fingerprint === fp.fingerprint ? pastTime(fact.asked_at, ctx.now()) : null, pastTime(last.doc.created_at, ctx.now())].filter((t) => t !== null);
  if (times.length && ctx.now() - Math.max(...times) >= GO_REASK_MS) return true;
  tell(c.id, 'expired', times.length ? `the ask for a go on card ${c.id} ran out with no answer; it is asked again once a day`
    : `the ask for a go on card ${c.id} ran out with no answer, and when it was asked can't be read, so it waits`);
  return false;
}

function noteAsked(ctx, tell, c, fp) {
  const rec = ctx.record;
  const id = PLAN_ASK_FACT(c.id);
  const w = noteFact(rec, id, rec.read('fact', id)?.rev ?? 0, { fingerprint: fp.fingerprint, asked_at: new Date(ctx.now()).toISOString() });
  if (!w.ok) tell(c.id, 'noted', `card ${c.id} was asked for a go, but that could not be noted: ${short(w.reason)}`);
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
  if (!await mayAsk(ctx, ports, tell, st, c, fp)) return;
  let planCheck;
  if (d.tier === 1) {
    planCheck = await reviewed(ctx, ports, tell, c, fp);
    if (!planCheck) return;
  }
  const r = await raiseGo(ctx, { cardId: c.id, rows: await ports.planRows({ product, card: c.id }), view: await ports.planView({ product }), mainSha: await ports.mainSha({ product }), planCheck });
  if (r.ok && !r.existing) { events.push(`asked ${r.id}`); noteAsked(ctx, tell, c, fp); }
  else if (!r.ok) tell(c.id, 'raise', `card ${c.id} could not be asked for a go: ${short(r.reason)}`);
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
