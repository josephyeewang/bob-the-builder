// plan-go.mjs — the Dispatcher asks the owner for a card's go, and turns a go the owner gave into the go record (L440,
// L442, L443).
//
// WHY. M2 can raise and record a go, and M9 refuses to start a card without one, but nothing called M2: a card needing a
// go sat in draft for ever. A Tier-1 go also needs a fresh plan reviewer's pass, and that pass must come from the
// reviewer's own answer, not from anything a session can write to the Record (L87 item 3).
//
//   planGoPass(ctx, { alert, startPlanReview, planReviewAnswer, planRows, planView, mainSha, replyToLead }) → { ok: true, events }
//     ctx: one product's Approvals context (tick.mjs approvalsStep). The ports take { product, card, ... }:
//     startPlanReview({ lead, product, card, fingerprint, plan_sha256, inputs, wording, key }) → { ok: true, session } | { ok: false, reason }
//       key is the same for a card's plan: a port that can use it gives a repeated start the same session
//     planReviewAnswer({ product, card, fingerprint, session }) → { ok: true, answer } | { ok: true } while it works | { ok: false, reason }
//     planRows({ product, card }) → { <row id>: row }      planView({ product }) → a repo view      mainSha({ product }) → sha
//     replyToLead({ lead, text }) → { ok: true } | { ok: false, reason }      leaves a note for the Lead whose session wrote the plan
//   Each port call has a time limit (PLAN_PORT_MS), and so has each call raiseGo makes: the repo view's isDir and the close
//   of an older pull request. A call that hangs costs its card that limit, is told under that card's cause, and the next
//   card still runs. The race has no cancel, so a late call may still finish.
//   The pass has a budget too (`passMs`, the product's deadline; L467). With too little left for one more call it stops
//   calling out: a card that needs a call is told it was not reached, once a day, and one that needs none goes on as usual.
//   Cards go least recently reached first (PLAN_TURN_FACT, noted only after a pass that left a card out). A card whose own calls hung or took a port limit or more goes
//   behind the others next pass (PLAN_SLOW_FACT, oldest first), so the cards that hang can't keep the healthy ones from
//   being reached, and cards that each cost a moderate time, or hang, take turns.
//
// First the answered gos: each approved ask on the card's current plan becomes the go record, once, and a refused one is
// told. An answer on a plan the card has moved on from, or on a plan it already has a go for, is left alone. Then each
// draft card goNeeded (M9, the one definition) says wants a go, and only if it is its own root: a fix card runs on its
// root's go, and waits, told daily, while that go doesn't cover it.
//   Tier 2: raised, no plan check (L443 ruling 4).
//   Tier 1: raised only with a pass. Its plan hash or main commit missing: left alone, invents nothing, told. Else one
//   fresh reviewer per fingerprint, its answer read through the port, the author taken from the Record's latest plan write.
//   A start is marked before the call. If the call timed out it may still have started, so for PLAN_START_HOLD_MS the
//   mark counts as started: no second start, and the owner told daily that it is unconfirmed (L467).
// One ask per card and plan (L450), the time of it kept in a fact. The plan's latest ask says what happens next:
//   Live for over GO_REASK_MS: the owner is told daily, naming the ask. M2 re-pushes a go ask once a day and never lapses it (L523).
//   Live for less, or a go it gave: nothing.
//   Declined: never asked again for this plan. Its Lead is told once, so it can change the plan; a changed plan is a new ask.
//   Expired, no answer: asked again at most once in GO_REASK_MS.
//   Withdrawn for another plan (M2 raiseGo or recordGo, withdrawn_for): the plan has come back, so it is asked. Any other withdrawal:
//   only a changed plan is asked.
//   Used by a go since replaced (plan A, then B, then A again): asked, as M2 allows.
// A declined, expired, withdrawn or unanswered card is in the owner's daily hold tell while it waits.
// A draft card with a go that covers it moves to ready (R-0b-170), in the pass that recorded the go if it can. It stays
// in draft, quietly, while a dependency has yet to merge or the product is paused, and goes on by itself; anything else
// that stops it is told, once a day per card. It is checked first because the Record logs and reports every write it
// refuses. The Record checks again itself and refuses a card no go covers. A go-free card has no go, so its own step moves it.
// Everything that stops a card reaches the owner, once a day per card and reason (holdAlert). One card failing never
// stops the next. Facts sit in the Dispatcher's `hold-` family; a stale mark does no harm, and a new plan gets a new review.

import { goNeeded, readyCheck } from '../M9-record/ready.mjs';
import { PLAN_INPUTS } from '../M9-record/permissions.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { goFingerprint, raiseGo, recordGo } from '../M2-approvals/go.mjs';
import { PLAN_REVIEW_WORDING, readPlanReview } from '../M3-lead/lead-wording.mjs';
import { activeKind } from '../../shared/asks.mjs';
import { planPass } from '../../shared/plan-review.mjs';
import { pastTime } from '../../shared/still-waiting.mjs';
import { move } from './moves.mjs';
import { guarded, holdAlert, HOLD_FACT } from './pass.mjs';

// The read-only cap counts a Lead's sessions; plan reviewers count together under this name.
export const PLAN_REVIEW_LEAD = 'plan-review';
// Past this with no answer, the owner hears the reviewer is still silent.
export const PLAN_REVIEW_SLOW_MS = 60 * 60 * 1000;
export const PLAN_REVIEW_FACT = (card) => HOLD_FACT(`plan-review-${card}`);
export const PLAN_ASK_FACT = (card) => HOLD_FACT(`plan-ask-${card}`);
// An ask that ran out with no answer is asked again no sooner than this after the last one.
export const GO_REASK_MS = 24 * 60 * 60 * 1000;
// One port call's limit. Several hung cards must fit the product's 30 s (tick.mjs APPROVALS_PRODUCT_MS).
export const PLAN_PORT_MS = 5_000;
// The pass stops calling out with less than this many port limits left: a little over one, so the last call and the
// notes after it finish before the deadline ends the pass.
const PLAN_LAST_CALL = 1.2;
export const PLAN_SLOW_FACT = (card) => HOLD_FACT(`plan-slow-${card}`);
export const PLAN_TURN_FACT = (card) => HOLD_FACT(`plan-turn-${card}`);
export const PLAN_START_HOLD_MS = 24 * 60 * 60 * 1000;
const PLAN_PORTS = ['startPlanReview', 'planReviewAnswer', 'planRows', 'planView', 'mainSha', 'replyToLead'];
// The words every unwired port throws (wiring/dispatcher-wiring.mjs): told once per product, not once per card.
const NOT_WIRED = /not wired yet: /;
class TimedOut extends Error {}
class OutOfTime extends Error {}
const cause = (card, why) => `plan-go-${card}-${why}`;
// A card id has no dot (M3 lead-wording ID), so a product's cause can't be a card's.
const whole = (product) => `product.${product}`;
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
  const st = askStore(ctx.record);
  for (const a of st.asks()) {
    if (a.doc.product !== ctx.product || !activeKind(a.doc.kind)?.go) continue;
    if (a.doc.state !== 'answered' || a.doc.answer?.approves !== true) continue;
    const card = a.doc.card;
    try {
      const fp = goFingerprint(ctx, card);
      const go = st.go(`go-${card}`)?.doc;
      // A plan the card has moved on from, or one another ask has already given a go to: nothing is left to record.
      if (fp.ok && (fp.fingerprint !== a.doc.fingerprint || (go?.plan_fingerprint === fp.fingerprint && go.ask !== a.id))) continue;
      const r = recordGo(ctx, a.id);
      if (r.ok) events.push(`go ${r.go}`);
      else tell(card, 'record', `the owner's go on card ${card} could not be recorded: ${short(r.reason)}`);
    } catch (e) { tell(card, 'record', `the owner's go on card ${card} could not be recorded: ${short(e?.message ?? e)}`); }
  }
}

// The pass a Tier-1 go needs, or null with the reason told. Starts the reviewer the first time this plan is seen.
async function reviewed(ctx, ports, tell, c, fp) {
  const rec = ctx.record;
  const id = PLAN_REVIEW_FACT(c.id);
  const fact = rec.read('fact', id);
  const f = fact?.doc;
  if (f?.fingerprint !== fp.fingerprint || typeof f?.session !== 'string' || !f.session) {
    const marked = f?.fingerprint === fp.fingerprint ? pastTime(f.starting_at, ctx.now()) : null;
    if (marked !== null && ctx.now() - marked < PLAN_START_HOLD_MS) { tell(c.id, 'unconfirmed', `the plan reviewer for card ${c.id} may have started, but that was never confirmed, so none is started again for now and the card can't be asked for a go`); return null; }
    const at = new Date(ctx.now()).toISOString();
    const mark = noteFact(rec, id, fact?.rev ?? 0, { fingerprint: fp.fingerprint, starting_at: at });
    if (!mark.ok) { tell(c.id, 'start-marked', `no plan reviewer was started for card ${c.id}: the start could not be noted first: ${short(mark.reason)}`); return null; }
    // A clear no means nothing started, so the next pass may try. Any other failure keeps the mark: it may have.
    const unmark = () => noteFact(rec, id, rec.read('fact', id)?.rev ?? 0, { fingerprint: fp.fingerprint });
    let s;
    try {
      s = await ports.startPlanReview({ lead: PLAN_REVIEW_LEAD, product: ctx.product, card: c.id, fingerprint: fp.fingerprint, plan_sha256: fp.plan_sha256,
        inputs: fp.inputs, wording: PLAN_REVIEW_WORDING, key: `${c.id}-${fp.fingerprint}` });
    } catch (e) {
      if (e instanceof OutOfTime || NOT_WIRED.test(String(e?.message))) unmark();
      throw e;
    }
    if (s?.ok !== true || typeof s.session !== 'string' || !s.session) { if (s?.ok === false) unmark(); tell(c.id, 'start', `no plan reviewer could start for card ${c.id}, so it can't be asked for a go: ${short(s?.reason)}`); return null; }
    const w = noteFact(rec, id, rec.read('fact', id)?.rev ?? 0, { fingerprint: fp.fingerprint, session: s.session, started_at: at });
    if (!w.ok) tell(c.id, 'start-noted', `the plan reviewer for card ${c.id} started but could not be noted, so another may start: ${short(w.reason)}`);
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
  if (!author) { tell(c.id, 'author', actor ? `card ${c.id}'s plan was last written by ${short(actor)}, not a named session, so its review can't count` : `the diary doesn't say who wrote card ${c.id}'s plan, so its review can't count`); return null; }
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
    if (r?.ok !== true) { failed(r?.reason); return; }
  } catch (e) {
    if (NOT_WIRED.test(String(e?.message)) || e instanceof OutOfTime) throw e;
    failed(e?.message ?? e);
    return;
  }
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
  if (state === 'open' || state === 'pushed') {
    const since = [last.doc.first_pushed_at, last.doc.raised_at, last.doc.created_at].map((t) => pastTime(t, ctx.now())).find((t) => t !== null);
    if (since === undefined || ctx.now() - since >= GO_REASK_MS) tell(c.id, 'unanswered', `card ${c.id} is waiting for your go: ask ${last.id} has no answer yet`);
    return false;
  }
  if (state === 'consumed') return st.go(`go-${c.id}`)?.doc.ask !== last.id;
  if (state === 'answered' && answer?.approves !== true) {
    tell(c.id, 'declined', `the owner declined card ${c.id}'s plan, so it waits until the Lead changes the plan`);
    await tellLead(ctx, ports, tell, c, fp);
    return false;
  }
  if (state === 'withdrawn' && last.doc.withdrawn_for) return true;
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

function goReady(ctx, tell, view, c, events) {
  const can = readyCheck(c, view, { rules: ctx.rules, product: ctx.product });
  if (!can.ok && can.waiting) return;
  const r = can.ok ? move(ctx.record, 'card', c.id, { state: 'ready' }, { kind: 'go_ready' }) : can;
  if (r.ok) events.push(`ready ${c.id}`);
  else tell(c.id, 'ready', `card ${c.id} has its go but can't start: ${short(r.reason)}`);
}

async function raiseFor(ctx, ports, tell, view, st, c, events) {
  const { product, rules } = ctx;
  const n = goNeeded(c, view, rules, product);
  if (!n.needed) { if (n.go) goReady(ctx, tell, view, c, events); return; }
  if (!n.root) { tell(c.id, 'chain', `card ${c.id} can't be asked for a go: ${short(n.reason)}`); return; }
  if (n.root.id !== c.id) { tell(c.id, 'root', `card ${c.id} runs on root card ${n.root.id}'s go, so it waits: ${short(n.reason)}`); return; }
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
  const rows = await ports.planRows({ product, card: c.id });
  const repo = await ports.planView({ product });
  const mainSha = await ports.mainSha({ product });
  const r = await raiseGo(limitedCtx(ctx, ports), { cardId: c.id, rows, view: repo && { isDir: (sha, f) => ports.timed('isDir', () => repo.isDir(sha, f)) }, mainSha, planCheck });
  if (r.cause instanceof OutOfTime) throw r.cause;
  if (r.ok && !r.existing) { events.push(`asked ${r.id}`); noteAsked(ctx, tell, c, fp); }
  else if (!r.ok) tell(c.id, 'raise', `card ${c.id} could not be asked for a go: ${short(r.reason)}`);
}

// What raiseGo reaches outside, each call limited. M2 closes a pull request and catches what the call throws, so running out
// of time is asked before the call (`checkTime`), and that throw goes through M2 to the card's own try.
const limitedCtx = (ctx, ports) => ({ ...ctx, checkTime: ports.checkTime, gh: { patch: (...a) => ports.limit('closing a pull request', () => ctx.gh.patch(...a)) } });

// A call that hangs or throws becomes a throw naming it, which the card's own try tells; with the pass's time nearly gone,
// no call is made at all. `counted` is how the pass sees what each card cost it: its calls, how long they took, how many hung.
function limited(ports) {
  const portMs = ports.portMs ?? PLAN_PORT_MS;
  const ends = Date.now() + (ports.passMs ?? portMs * 6);
  const counted = { calls: 0, ms: 0, timeouts: 0 };
  const checkTime = () => { if (ends - Date.now() < portMs * PLAN_LAST_CALL) throw new OutOfTime('the pass ran out of time'); };
  const limit = async (name, f) => {
    counted.calls += 1;
    const from = Date.now();
    const r = await guarded(async () => ({ value: await f() }), portMs);
    counted.ms += Date.now() - from;
    if ('value' in r) return r.value;
    if (!/^it did not answer within /.test(r.reason)) throw new Error(`${name}: ${r.reason}`);
    counted.timeouts += 1;
    throw new TimedOut(`${name}: ${r.reason}`);
  };
  const timed = async (name, f) => { checkTime(); return limit(name, f); };
  return { ...ports, portMs, counted, checkTime, limit, timed, ...Object.fromEntries(PLAN_PORTS.map((n) => [n, (x) => timed(n, () => ports[n](x))])) };
}

// The cards of this product waiting in draft, least recently reached first, so cards that each cost a moderate time take
// turns (L480); those that were slow last time go behind the rest, the longest ago first.
function inTurn(ctx, cards) {
  const at = (id, field) => pastTime(ctx.record.read('fact', id)?.doc?.[field], ctx.now());
  const place = (c) => {
    const slow = at(PLAN_SLOW_FACT(c.id), 'slow_at');
    return slow === null ? [0, at(PLAN_TURN_FACT(c.id), 'reached_at') ?? -1] : [1, slow];
  };
  return cards.filter((c) => !c.corrupt && c.doc && c.doc.product === ctx.product && c.doc.state === 'draft')
    .map((c) => [place(c), c]).sort(([a], [b]) => a[0] - b[0] || a[1] - b[1]).map(([, c]) => c);
}

// The record's diary is never compacted, so turns are noted only when the order matters: at the end of a pass that left a
// card not reached or not finished, for the cards that made a call. A pass that reaches every card writes none, and a crash
// mid-pass only costs one pass's order.
function noteReached(ctx, tell, c) {
  const rec = ctx.record;
  const id = PLAN_TURN_FACT(c.id);
  const w = noteFact(rec, id, rec.read('fact', id)?.rev ?? 0, { reached_at: new Date(ctx.now()).toISOString() });
  if (!w.ok) tell(c.id, 'turn-noted', `card ${c.id}'s turn in the plan-go order could not be noted: ${short(w.reason)}`);
}

function noteSlow(ctx, tell, c, slow) {
  const rec = ctx.record;
  const id = PLAN_SLOW_FACT(c.id);
  const f = rec.read('fact', id);
  if (!slow && !f?.doc?.slow_at) return;
  const w = noteFact(rec, id, f?.rev ?? 0, { slow_at: slow ? new Date(ctx.now()).toISOString() : null });
  if (!w.ok) tell(c.id, 'slow-noted', `card ${c.id}'s turn in the plan-go order could not be noted: ${short(w.reason)}`);
}

export async function planGoPass(ctx, unlimited) {
  const rec = ctx.record;
  const ports = limited(unlimited);
  const { alert } = ports;
  const tell = (card, why, text) => holdAlert({ rec, cause: cause(card, why), text, alert, now: ctx.now() });
  const events = [];
  try { recordGos(ctx, tell, events); } catch (e) { tell(whole(ctx.product), 'record', `product ${ctx.product}'s answered gos could not be read: ${short(e?.message ?? e)}`); }
  const view = { get: (e, id) => rec.read(e, id), list: (e) => rec.list(e), createdBy: (e, id) => rec.meta(e, id)?.createdBy ?? null };
  const st = askStore(rec);
  // The cards whose own calls cost this pass its time. A card that used the pass up goes behind the rest, or it would go
  // first every tick and the cards after it would never be reached.
  const slow = [];
  const reached = [];
  let leftOut = false;
  for (const c of inTurn(ctx, rec.list('card'))) {
    const was = { ...ports.counted };
    const ownSlow = () => ports.counted.timeouts > was.timeouts || ports.counted.ms - was.ms >= ports.portMs;
    try { await raiseFor(ctx, ports, tell, view, st, c, events); } catch (e) {
      const why = short(e?.message ?? e);
      if (e instanceof OutOfTime) {
        leftOut = true;
        if (!ownSlow()) {
          const started = ports.counted.calls > was.calls;
          tell(c.id, started ? 'unfinished' : 'reached', `card ${c.id} was not ${started ? 'finished' : 'reached'}: slow calls on ${slow.length ? slow.join(', ') : 'other cards'} used up this pass's time. It is tried again next pass`);
          continue;
        }
        tell(c.id, 'own-time', `card ${c.id} was not finished: this card's own calls were slow and used up this pass's time. It goes behind the other cards next pass`);
      } else if (NOT_WIRED.test(why)) tell(whole(ctx.product), 'wiring', `no go can be asked on product ${ctx.product}: ${why}`);
      else tell(c.id, 'failed', `asking for a go on card ${c.id} failed: ${why}`);
    } finally { if (ports.counted.calls > was.calls) reached.push(c); }
    if (ownSlow()) slow.push(c.id);
    noteSlow(ctx, tell, c, ownSlow());
  }
  if (leftOut) for (const c of reached) noteReached(ctx, tell, c);
  return { ok: true, events };
}
