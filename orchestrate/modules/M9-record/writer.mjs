// writer.mjs — the Store Writer: the one thing that writes a product's record (0b-2 R-0b-20 … R-0b-27).
//
// WHY. Every card, ask, claim, wait and fact lives here, and every other module trusts it. So each write is checked,
// under the store lock, against: the rev the caller read; the legal moves (moves.mjs); who may change which fields
// (permissions.mjs); and the conditions on each move (the ready rule, a passing verdict for the current head, a full
// wait, one merge at a time, the round cap). Anything that fails is refused, logged to refusals.jsonl with an alert,
// and leaves no diary line.
//
//   const { record, store } = openRecord({ root, product, ownerUid, rules, alert, outbox: { root, uids, launches } })
//   `outbox.launches` is the review runner's launch records folder (L65): a verdict counts only with a record there.
//   `outbox.treeOf(card, head)`, when given, is the head's tree (L69): sessions at any head with that tree count too. A
//   throw or an answer that is not 40 hex refuses the move to verified. Without it, the trees the launch records at the
//   head name stand in.
//   record is shared/record.mjs's interface (makeRecord), so callers never see this file.
//
// Options only tests pass: `now` (a fake clock), `host`, `probe` (fake process checks), `faultAt` (crash at a step),
// `testNoLock` + `testNoRevCheck` (the mutation race, M-6: the race must be able to fail), `lockTimeoutMs`.

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { CARD_KINDS, ENTITIES, FINAL_STATES, SESSION_ID, STATES, WAIT_FIELDS, WAIT_WHO, isOpen, makeRecord, missingFields, releaseData, timeoutFor } from '../../shared/record.mjs';
import { claimCheck, guardWrite, same } from './guard.mjs';
import { PLAN_INPUTS, TAB_HEARTBEAT_FAMILY, TAB_HEARTBEAT_WRITER, actorName, factFrom, mayCreateKind } from './permissions.mjs';
import { readyCheck } from './ready.mjs';
import { PASSES, headReviews, readOutboxFile, runnerLaunchFor, verdictFields, worstVerdict } from './outbox.mjs';
import { processDead, realProbe } from './lock.mjs';
import { openStore } from './store.mjs';

const MIN = 60000;
// How long a session claim may wait for its process (claims.unlaunched_min, L72) when the rules don't say.
const UNLAUNCHED_MIN_DEFAULT = 5;
const HEX40 = /^[0-9a-f]{40}$/;
const KIND = /^[a-z_]{1,40}$/;
const no = (reason) => ({ ok: false, reason });
const iso = (ms) => new Date(ms).toISOString();
const NEEDS_JOE_SETTERS = ['lead', 'dispatcher', 'merge_gate'];

// How long a tab claim may go without a heartbeat, in minutes, or undefined when the rules set none (L115 m-A): the
// one reading, so lane 3's fit check calls this instead of copying it.
export function heartbeatLimit(rules, product) {
  const n = rules?.num?.('proposals.heartbeat_stale_min', { product });
  return n !== undefined && n >= 1 ? n : undefined;
}

export function openRecord({ root, product, ownerUid, rules, alert = () => {}, now = () => Date.now(), host = hostname(),
  probe = realProbe, outbox = {}, profileVersion = null, faultAt, testNoLock = false, testNoRevCheck = false, lockTimeoutMs } = {}) {
  if (typeof product !== 'string' || !/^[A-Za-z0-9._-]+$/.test(product)) throw new Error('the record needs its product name');
  if (!rules || typeof rules.get !== 'function') throw new Error('the record needs the rules (shared/rules.mjs)');
  const store = openStore({ root, ownerUid, alert, now, host, probe, faultAt, testNoLock, lockTimeoutMs });
  const get = (key) => rules.get(key, { product });
  // Rules numbers through the one conversion (L96 step 2): text or an integer, else missing.
  const num = (key) => rules.num(key, { product });
  const timeouts = () => ({ timeouts: get('timeouts') });

  // A view over the record for the ready rule: inside a transaction it reads the locked index, outside it reads the store.
  const txView = (tx, override) => ({
    get(entity, id) {
      if (override && override.entity === entity && override.id === id) return { id, doc: override.doc };
      const e = tx.lookup(entity, id);
      return e ? { id, doc: e.doc } : null;
    },
    list(entity) { return tx.list(entity).map((e) => ({ id: e.id, doc: e.doc })); },
    createdBy(entity, id) { return tx.lookup(entity, id)?.createdBy ?? null; },
  });
  const storeView = {
    get: (entity, id) => store.read(entity, id),
    list: (entity) => store.list(entity),
    createdBy: (entity, id) => store.meta(entity, id)?.createdBy ?? null,
  };

  // ---- waits (R-0b-27, m-1, R2-m1, R2-m9, R2-m10) ----
  function checkWait(wait, { entity, state, from, card, nowMs }) {
    if (!wait || typeof wait !== 'object' || Array.isArray(wait)) return no(`a move into ${state} needs a wait (who, what, since, next_check)`);
    const missing = WAIT_FIELDS.filter((f) => wait[f] === undefined || wait[f] === null || wait[f] === '');
    if (missing.length) return no(`wait is missing ${missing.join(', ')}`);
    if (!WAIT_WHO.includes(wait.who)) return no(`wait.who must be one of ${WAIT_WHO.join(', ')}`);
    if (typeof wait.what !== 'string' || !wait.what.trim()) return no('wait.what must say what it waits on');
    if (wait.who === 'date' && !(typeof wait.reason === 'string' && wait.reason.trim())) return no('a wait on a date needs a reason');
    const since = Date.parse(wait.since);
    if (!Number.isFinite(since) || Math.abs(since - nowMs) > MIN) return no('wait.since must be now (within 60 s)');
    const next = Date.parse(wait.next_check);
    if (!Number.isFinite(next) || next <= nowMs) return no('wait.next_check must be in the future');
    const limit = timeoutFor(timeouts(), entity, state);
    if (limit === undefined || limit === null) return no(`the rules have no time limit for ${entity} ${state}`);
    const maxMin = limit.minutes ?? limit.recheck_max_min;
    if (next > nowMs + maxMin * MIN) return no(`wait.next_check is later than ${maxMin} minutes from now`);
    const out = { ...wait, since: iso(nowMs) };
    if (card) {
      if (wait.resume !== 'retry' && wait.resume !== 'continue') return no('a card wait needs resume: retry or continue');
      if (from === 'running' && wait.resume !== 'retry') return no('a running card waits only with resume: retry (its claim ends)');
      if (wait.resume === 'retry' && wait.return_to !== 'ready') return no('resume: retry returns to ready');
      if (wait.resume === 'continue' && wait.return_to !== from) return no(`resume: continue returns to ${from}`);
      // An approved card waits only to come back to approved (L116, L123 m-3): a retry would send it to ready, past
      // the owner's Approve and its review.
      if (from === 'approved' && !(wait.resume === 'continue' && wait.return_to === 'approved')) return no('an approved card waits only with resume: continue, back to approved');
    }
    return { ok: true, wait: out };
  }

  // The checks for one document. Returns the document to write, or a refusal.
  function check(tx, w, actor, ctx = {}) {
    const name = actorName(actor);
    const { entity, id } = w;
    if (!ENTITIES.includes(entity)) return no(`unknown entity "${entity}"`);
    if (!w.doc || typeof w.doc !== 'object' || Array.isArray(w.doc)) return no('doc must be an object');
    // A doc nested thousands deep would be stored, then overflow the stack on every later write to it, freezing the card
    // for everyone (0b-2 audit round 3 MAT-B). Measured without recursion.
    if (deeperThan(w.doc, MAX_DOC_DEPTH)) return no(`doc is nested deeper than ${MAX_DOC_DEPTH} levels`);
    const missing = missingFields(entity, w.doc);
    if (missing.length) return no(`${entity} is missing ${missing.join(', ')}`);
    const cur = tx.current(entity, id);
    if (cur?.tampered) return no(cur.reason);
    if (!testNoRevCheck && !ctx.stateChecked && (cur?.rev ?? 0) !== w.expectRev) {
      const holder = entity === 'card' && cur?.doc?.claim ? `; claimed by ${cur.doc.claim.session_id ?? cur.doc.claim.claim_id} on ${cur.doc.claim.host}` : '';
      return no(`changed since read (rev ${cur?.rev ?? 0}, expected ${w.expectRev})${holder}`);
    }
    const nowMs = now();
    if (!cur && testNoRevCheck && w.expectRev !== 0) return no('no such document');
    // Who may set which fields and make which move: the one check the test stand-in makes too (guard.mjs, L72).
    const g = guardWrite({ entity, id, actor, old: cur?.doc ?? null, doc: w.doc, createdBy: cur?.createdBy ?? null });
    if (!g.ok) return g;
    const doc = g.doc;

    // ---------- create ----------
    if (!cur) {
      if (entity === 'product' && id !== product) return no(`this record is product ${product}'s`);
      if (entity === 'ask') { if (doc.reask_count !== undefined && doc.reask_count !== 0) return no('a new ask starts at reask_count 0'); doc.reask_count = 0; }
      if (entity === 'merge_request') {
        const c = tx.lookup('card', doc.card);
        if (!c) return no(`merge request for missing card ${doc.card}`);
        const okState = c.doc.state === 'approved' || (c.doc.state === 'verified' && !c.doc.needs_joe && !c.doc.approval_required);
        if (!okState) return no(`card ${doc.card} is ${c.doc.state}${c.doc.needs_joe || c.doc.approval_required ? ' and needs the owner' : ''}; no merge request yet`);
        if (c.doc.claim) return no(`card ${doc.card} still has a claim`);
      }
      if (entity === 'card') {
        const r = checkNewCard(tx, id, doc, name, nowMs);
        if (!r.ok) return r;
      }
      return { ok: true, write: { entity, id, doc }, kind: w.kind };
    }

    // ---------- update ----------
    const old = cur.doc;
    const { from, to, moving, changed } = g;

    if (entity === 'card') { const r = checkCardUpdate(tx, { id, old, doc, from, to, moving, changed, name, nowMs, ctx }); if (!r.ok) return r; }
    if (entity === 'ask') { const r = checkAsk(old, doc, from, to, moving, changed); if (!r.ok) return r; }
    if (entity === 'session') { const r = checkSession(tx, old, doc, from, to, moving, nowMs, id); if (!r.ok) return r; }
    if (entity === 'merge') { const r = checkMerge(tx, id, old, doc, from, to, moving, ctx, w); if (!r.ok) return r; }
    if (entity === 'product') { const r = checkProduct(old, doc, from, to, moving); if (!r.ok) return r; }
    return { ok: true, write: { entity, id, doc }, kind: w.kind, cur };
  }

  function checkNewCard(tx, id, doc, name, nowMs) {
    if (!CARD_KINDS.includes(doc.kind)) return no(`unknown card kind "${doc.kind}"`);
    if (!mayCreateKind(name, doc.kind)) return no(`${name} may not create a ${doc.kind} card`);
    if (doc.product !== product) return no(`a card in this record belongs to product ${product}`);
    if (doc.state !== 'draft') return no('a card is created in draft');
    if (doc.depends_on !== undefined && (!Array.isArray(doc.depends_on) || doc.depends_on.some((d) => typeof d !== 'string'))) return no('depends_on must be a list of card ids');
    if (doc.claim !== undefined || doc.wait !== undefined) return no('a new card has no claim or wait');
    if (doc.needs_joe === false) delete doc.needs_joe;
    if (doc.kind === 'fix') {
      const parent = typeof doc.fix_of === 'string' ? tx.lookup('card', doc.fix_of) : null;
      if (!parent) return no('a fix card names the card it fixes (fix_of)');
      // Only a card that failed gets a fix, and only one: the next round fixes the fix (0b-2 audit MAT-2), so the round
      // cap can't be stepped round by naming the root again.
      if (parent.doc.state !== 'failed') return no(`a fix card fixes a failed card; ${doc.fix_of} is ${parent.doc.state}`);
      if (tx.list('card').some((c) => c.doc.kind === 'fix' && c.doc.fix_of === doc.fix_of)) return no(`${doc.fix_of} already has a fix card; the next round fixes that one`);
      let root = parent;
      for (let i = 0; i < 64 && typeof root.doc.fix_of === 'string'; i++) root = tx.lookup('card', root.doc.fix_of) ?? root;
      // The plan inputs are the root's, unchanged (R3-m2): the go covers only that plan.
      const diff = PLAN_INPUTS.filter((f) => !same(doc[f], root.doc[f]));
      if (diff.length) return no(`a fix card's ${diff.join(', ')} must equal its root card's`);
      // The round comes from the chain, never from the caller (M-8).
      doc.round = (Number.isInteger(parent.doc.round) ? parent.doc.round : 1) + 1;
    } else {
      if (doc.fix_of !== undefined) return no('only a fix card names fix_of');
      doc.round = 1;
    }
    if (doc.kind === 'exact_reverse') {
      const src = doc.source;
      const ask = typeof src?.ask === 'string' ? tx.lookup('ask', src.ask) : null;
      const fact = typeof src?.fact === 'string' ? tx.lookup('fact', src.fact) : null;
      // The answer must be the Undo choice, approving (L85 m-2): an answered Keep, or no answer, is no go for a reverse.
      const undoChoice = ask?.doc?.choices?.[0] ?? 'Undo';
      const askOk = ask && ask.doc.kind === 'undo' && (ask.doc.state === 'answered' || ask.doc.state === 'consumed')
        && ask.doc.answer?.choice === undoChoice && ask.doc.answer?.approves === true;
      const factOk = factFrom('sensors', fact, 'undo-issue-') && fact.doc.type === 'undo_issue' && fact.doc.authenticated === true;
      if (!askOk && !factOk) return no('an exact_reverse card needs an answered Undo ask or an authenticated audit issue (source)');
      // One reverse per piece of evidence (0b-2 audit MAT-2): one answered Undo is never the go for many cards.
      const key = askOk ? ['ask', src.ask] : ['fact', src.fact];
      if (tx.list('card').some((c) => c.doc.kind === 'exact_reverse' && c.doc.source?.[key[0]] === key[1])) return no(`${key[0]} ${key[1]} already has its exact_reverse card`);
    }
    if (doc.kind === 'research_copy') {
      const ask = typeof doc.research_ask === 'string' ? tx.lookup('ask', doc.research_ask) : null;
      if (!ask || ask.doc.kind !== 'research' || !isOpen('ask', ask.doc.state)) return no('a research_copy card needs an open research ask (research_ask)');
      if (tx.list('card').some((c) => c.doc.kind === 'research_copy' && c.doc.research_ask === doc.research_ask)) return no(`ask ${doc.research_ask} already has its research_copy card`);
    }
    const cap = num('caps.rounds');
    if (cap === undefined || cap < 1) return no('no round cap in the rules (caps.rounds)');
    if (doc.round > cap) {
      const t = timeoutFor(timeouts(), 'card', 'waiting');
      if (!t) return no('the rules have no card waiting limit');
      doc.state = 'waiting';
      doc.wait = { who: 'joe', what: 'round cap', since: iso(nowMs), next_check: iso(nowMs + (t.minutes ?? t.recheck_max_min) * MIN), resume: null, return_to: null,
        reason: `round ${doc.round} is over the cap of ${cap}; the owner cancels it, or the Lead makes a new card with a new go` };
    }
    return { ok: true };
  }

  const MERGE_DONE = Object.freeze(['merged', 'audited_ok', 'audit_flagged']);
  const MAX_DOC_DEPTH = 32;
  function deeperThan(value, max) {
    const stack = [[value, 1]];
    while (stack.length) {
      const [v, d] = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (d > max) return true;
      for (const k of Object.keys(v)) stack.push([v[k], d + 1]);
    }
    return false;
  }

  function checkCardUpdate(tx, { id, old, doc, from, to, moving, changed, name, nowMs, ctx }) {
    if (old.kind === 'fix' && PLAN_INPUTS.some((f) => changed.includes(f))) return no('a fix card\'s plan is its root card\'s; it never changes');
    // The Lead edits the plan only of a card kind it may make (0b-2 audit MAT-1): a go-free card (exact_reverse,
    // research_copy) gets to ready with no go, so a changed plan on one would run with no go at all.
    if (PLAN_INPUTS.some((f) => changed.includes(f)) && !mayCreateKind(name, old.kind)) return no(`${name} may not change the plan of a ${old.kind} card`);
    // Nor its brief, desired outcome or merge request (round 2 m5); needs_joe is a flag any setter may raise on any card.
    if (['brief', 'desired', 'merge_requested'].some((f) => changed.includes(f)) && !mayCreateKind(name, old.kind)) return no(`${name} may not change a ${old.kind} card's brief, desired or merge request`);
    if (changed.includes('needs_joe')) {
      if (doc.needs_joe === true && !NEEDS_JOE_SETTERS.includes(name)) return no(`${name} may not set needs_joe`);
      if (doc.needs_joe !== true && name !== 'approvals') return no('only approvals clears needs_joe');
    }
    // The claim: set by ready → claimed, given its process by claimed → running; otherwise never changed by a write
    // (R2-M6, R3-M4, L72). One check, in guard.mjs, that the stand-in makes too.
    const cl = claimCheck({ old, doc, from, to, changed, nowMs });
    if (!cl.ok) return cl;
    if (cl.claim) doc.claim = cl.claim;
    // The wait.
    if (to === 'waiting') {
      if (moving || changed.includes('wait')) {
        if (!moving && old.wait?.return_to === null) return no('a round-cap wait changes only by cancel or closed_no_answer');
        const r = checkWait(doc.wait, { entity: 'card', state: 'waiting', from: moving ? from : old.wait?.return_to === 'ready' && old.wait?.resume === 'retry' ? 'ready' : old.wait?.return_to, card: true, nowMs });
        if (!r.ok) return r;
        if (!moving && (r.wait.resume !== old.wait?.resume || r.wait.return_to !== old.wait?.return_to)) return no('a re-check keeps the wait\'s resume and return_to');
        // The head the card waits on is the writer's, never the caller's (L123 m-4): set when the wait begins and kept
        // on a re-check, so the way back can tell whether a new head was pushed while it waited.
        const { head: _given, ...given } = r.wait;
        const waitHead = moving ? old.head : old.wait?.head;
        doc.wait = waitHead === undefined ? given : { ...given, head: waitHead };
      }
    } else if (changed.includes('wait')) return no('only a waiting card has a wait');
    if (moving && from === 'waiting' && to !== 'closed_no_answer' && to !== 'cancelled') {
      if (old.wait?.return_to === null || old.wait?.return_to === undefined) return no('this wait has no way back (round cap): only cancelled or closed_no_answer');
      // A card that waited from approved and got a new head meanwhile goes back through review, never straight back to
      // approved: the owner's Approve was for the old head (L123 m-4).
      const headMoved = old.wait.return_to === 'approved' && doc.head !== old.wait.head;
      if (headMoved && to === 'approved') return no('the head changed while the card waited: it goes back to in_review, not approved');
      if (!(headMoved && to === 'in_review') && to !== old.wait.return_to) return no(`a wait returns only to ${old.wait.return_to}`);
    }
    // The head: only the push script, and a new head after verification sends the card back to review (R2-M7, R3-m6).
    if (changed.includes('head')) {
      if (typeof doc.head !== 'string' || !HEX40.test(doc.head)) return no('head must be a 40-hex commit');
      if (from === 'merging') return no('no push while the card is merging');
      if ((from === 'verified' || from === 'approved') && to !== 'in_review') return no('a new head on a verified card sends it back to in_review');
      if (from !== 'verified' && from !== 'approved' && moving) return no('a head change makes no other move');
    } else if (name === 'workshop' && moving) return no('the push script moves a card only with a new head');
    if (moving && to === 'ready') { const r = readyCheck({ id, doc }, txView(tx, { entity: 'card', id, doc }), { rules, product }); if (!r.ok) return no(`not ready: ${r.reason}`); }
    if (moving && to === 'claimed') { const r = readyCheck({ id, doc }, txView(tx, { entity: 'card', id, doc }), { rules, product }); if (!r.ok) return no(`can't claim: ${r.reason}`); }
    if (moving && from === 'running' && to === 'in_review' && name === 'dispatcher' && old.claim?.kind !== 'tab') return no('a session\'s hand-in comes from its own outbox');
    // Every way into verified or approved needs a passing verdict for the head the card has now: a head pushed while the
    // card waited would otherwise come back verified unreviewed (0b-2 audit round 3 MAT-A).
    if (moving && (to === 'verified' || to === 'approved')) { const r = verdictFor(tx, id, doc); if (!r.ok) return r; }
    if (moving && to === 'merging') {
      if (!ctx.mergeChecking) return no('a card moves to merging only in the same write as its merge enters checking');
      if (from === 'verified' && (doc.needs_joe || doc.approval_required)) return no('this card needs the owner\'s Approve before it merges');
    }
    // merged needs its evidence: this card's merge document, merged (or already audited after), with the same commit
    // (0b-2 audit MIN-4, round 2 m4).
    if (moving && to === 'merged') {
      if (typeof doc.merge_commit !== 'string' || !HEX40.test(doc.merge_commit)) return no('a merged card names its merge commit (merge_commit)');
      if (!tx.list('merge').some((m) => m.doc.card === id && MERGE_DONE.includes(m.doc.state) && m.doc.merge_commit === doc.merge_commit)) return no(`no merged merge document for ${id} at ${doc.merge_commit.slice(0, 7)}`);
    }
    // The dispatcher's report fields go with their move (0b-2 audit MIN-3).
    if (name === 'dispatcher') {
      if (changed.includes('failure') && !(moving && to === 'failed')) return no('the dispatcher sets failure only on a move into failed');
      if (['summary', 'report_ref'].some((f) => changed.includes(f)) && !(moving && from === 'running' && to === 'in_review' && old.claim?.kind === 'tab')) return no('the dispatcher sets summary and report_ref only on a tab\'s hand-in');
    }
    return { ok: true };
  }

  // in_review → verified (R2-M7): the review of this head passed, judged as the Merge Gate judges it (L68): every
  // reviewer the review runner launched on this card at this head has its say, read from the runner's own records and
  // each session's verdict file in review's outbox (L44, L65, L66 M1), never from the Record's rows. One reviewer must
  // have passed, none failed and none be unsettled. An auditor that failed (or whose verdict can't be counted) holds it
  // back too; one still running does not (the Merge Gate waits for it on a Tier-1 change).
  // The passes are M9's one definition, the Merge Gate's too (L69 point 6). The head's tree comes from `outbox.treeOf`
  // when it is set (git, read only; wired at the cutover), so a review at another head with the same tree counts (L69
  // point 4); without it, the trees the launch records at this head name stand in.
  function verdictFor(tx, cardId, doc) {
    if (typeof doc.head !== 'string' || !HEX40.test(doc.head)) return no('the card has no head to verify');
    let tree;
    if (typeof outbox.treeOf === 'function') {
      try { tree = outbox.treeOf(cardId, doc.head); } catch (e) { return no(`the tree of head ${doc.head.slice(0, 7)} could not be read (${e?.message ?? e})`); }
      if (typeof tree !== 'string' || !HEX40.test(tree)) return no(`the tree of head ${doc.head.slice(0, 7)} could not be read`);
    }
    const hr = headReviews({ launches: outbox.launches, outboxRoot: outbox.root, uids: outbox.uids, card: cardId, head: doc.head, tree });
    if (!hr.ok) return no(`the review of head ${doc.head.slice(0, 7)} could not be read: ${hr.reason}`);
    const auditorsDone = hr.sessions.filter((s) => s.role !== 'auditor' || s.ended === true || s.problem);
    const p = worstVerdict(hr.sessions, 'reviewer', PASSES.reviewer)
      ?? worstVerdict(auditorsDone, 'auditor', PASSES.auditor, { needPass: false });
    return p ? no(`${p} for head ${doc.head.slice(0, 7)}`) : { ok: true };
  }

  function checkAsk(old, doc, from, to, moving, changed) {
    const before = old.reask_count ?? 0;
    const after = doc.reask_count ?? 0;
    // The first lapse: back to open with the count 0 → 1. An ask already open (its box was released) lapses in place,
    // which it says by setting lapsed_at in the same write (0b-5 M5-2).
    const firstLapse = to === 'open' && before === 0 && after === 1 && (moving || (typeof doc.lapsed_at === 'string' && doc.lapsed_at !== old.lapsed_at));
    if (changed.includes('reask_count') && !firstLapse) return no('reask_count goes up by one, only with a first lapse back to open');
    if (moving && from === 'answered' && to === 'open' && !firstLapse) return no('an answered ask goes back to open only on its first lapse');
    if (moving && to === 'expired' && after !== 1) return no('an ask expires only after its one re-ask');
    return { ok: true };
  }

  function checkSession(tx, old, doc, from, to, moving, nowMs, id) {
    if (to === 'waiting_input' || to === 'waiting_limit') {
      if (moving || !same(old.wait, doc.wait)) { const r = checkWait(doc.wait, { entity: 'session', state: to, from, card: false, nowMs }); if (!r.ok) return r; doc.wait = r.wait; }
    } else if (doc.wait !== undefined) return no(`a ${to} session has no wait`);
    if (moving && to === 'recycling' && old.role !== 'lead') return no('only the Lead\'s session recycles');
    if (moving && from === 'waiting_limit' && to === 'running') {
      if (old.role === 'lead') return no('the Lead never resumes after a usage limit (G2)');
      const c = typeof old.card === 'string' ? tx.lookup('card', old.card) : null;
      if (c?.doc.tier === 1) return no('a Tier-1 card\'s session never resumes after a usage limit (G2)');
    }
    if (moving && from === 'quarantined' && to === 'ended') {
      const c = typeof old.card === 'string' ? tx.lookup('card', old.card) : null;
      const cardFinal = c && FINAL_STATES.card.includes(c.doc.state);
      const asked = tx.list('ask').some((a) => a.doc.session === id && a.doc.state === 'consumed');
      if (!cardFinal && !asked) return no('a quarantined session ends only once its card is final or the owner has answered about it');
    }
    return { ok: true };
  }

  function checkMerge(tx, id, old, doc, from, to, moving, ctx, w) {
    // A merge's card is fixed when it is made, and the pair's merge must itself be entering checking; otherwise a merge
    // already checking could be re-pointed to put a second card into merging (0b-2 audit round 3 m-B).
    if (old && old.card !== doc.card) return no('a merge\'s card is set when it is made and never changes');
    if (ctx.cardMerging && !(moving && to === 'checking')) return no('the paired merge must be entering checking');
    if (moving && to === 'checking') {
      if (!ctx.cardMerging || ctx.cardMerging !== doc.card) return no('a merge enters checking only in the same write as its card moves to merging');
      const busy = tx.list('merge').filter((m) => m.id !== id && (m.doc.state === 'checking' || m.doc.state === 'merging'));
      if (busy.length) return no(`one merge at a time: ${busy[0].id} is ${busy[0].doc.state}`);
    }
    // refused → merged (L85 M-1 b): only an interrupted merge, only with a Sensors pr- reading of this merge's PR that
    // shows it merged, at the head the gate judged, with this merge commit.
    if (moving && from === 'refused') {
      if (!(old.reasons ?? []).includes('interrupted')) return no('only an interrupted merge is reconciled');
      if (typeof doc.merge_commit !== 'string' || !HEX40.test(doc.merge_commit)) return no('a reconciled merge names its merge commit (merge_commit)');
      if (doc.judged_head !== old.judged_head) return no('a merge\'s judged head never changes');
      const f = typeof w.data?.fact === 'string' ? tx.lookup('fact', w.data.fact) : null;
      if (!factFrom('sensors', f, 'pr-') || f.id !== `pr-${old.pr}`) return no('a reconcile comes from the Sensors reading of this merge\'s PR (data.fact)');
      if (f.doc.merged !== true || f.doc.head_sha !== old.judged_head || f.doc.merge_commit_sha !== doc.merge_commit) return no('the PR reading does not show this PR merged at the judged head with this commit');
    }
    if (moving && from === 'merged') {
      const f = typeof w.data?.fact === 'string' ? tx.lookup('fact', w.data.fact) : null;
      if (!factFrom('sensors', f, 'audit-run-') || f.doc.type !== 'audit_run') return no('an audit result comes from a Sensors audit_run fact (data.fact)');
      if (!doc.merge_commit || f.doc.commit !== doc.merge_commit) return no('the audit_run fact is for another commit');
      const want = f.doc.conclusion === 'success' ? 'audited_ok' : 'audit_flagged';
      if (to !== want) return no(`the audit concluded ${f.doc.conclusion}, so the merge is ${want}`);
    }
    return { ok: true };
  }

  function checkProduct(old, doc, from, to, moving) {
    if (moving && to === 'paused' && doc.return_to !== from) return no('pausing records the state to return to (return_to)');
    if (moving && from === 'paused' && to !== old.return_to) return no(`a paused product returns only to ${old.return_to}`);
    if (!moving && !same(old.return_to, doc.return_to)) return no('return_to changes only with a pause');
    return { ok: true };
  }

  function meta(actor, kind, data) {
    return { actor, kind: typeof kind === 'string' && KIND.test(kind) ? kind : 'write', data: data ?? null, rules_rev: rules.rev ?? null, profile_version: profileVersion };
  }

  function refuse(event, reason) {
    store.refuse({ ...event, reason });
    return no(reason);
  }

  // One write, or the merge-check pair (merge → checking with its card → merging), all checked before any is written.
  function applyWrite(tx, w, actor, ctx = {}) {
    // The diary line's data is held to the same depth as a doc, or one deep value breaks every diary read (round 4 m-2).
    if (deeperThan(w.data ?? null, MAX_DOC_DEPTH)) return no(`data is nested deeper than ${MAX_DOC_DEPTH} levels`);
    const also = w.also ?? [];
    if (!Array.isArray(also) || also.length > 1) return no('a write carries at most one paired document');
    let pairCtx = {};
    if (also.length) {
      const a = also[0];
      const pairOk = w.entity === 'merge' && w.doc?.state === 'checking' && a?.entity === 'card' && a?.doc?.state === 'merging' && w.doc?.card === a.id;
      if (!pairOk) return no('the only paired write is a merge entering checking with its card moving to merging');
      if (typeof a.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(a.id) || !Number.isInteger(a.expectRev)) return no('bad paired write');
      pairCtx = { cardMerging: a.id, mergeChecking: true };
    }
    const checked = [check(tx, w, actor, { ...ctx, cardMerging: pairCtx.cardMerging })];
    if (also.length) checked.push(check(tx, also[0], actor, { mergeChecking: true }));
    const bad = checked.find((c) => !c.ok);
    if (bad) return bad;
    const kind = w.kind ?? (checked[0].write.entity === 'card' && checked[0].write.doc.state === 'claimed' && checked[0].cur?.doc.state === 'ready' ? 'claim' : undefined);
    const r = tx.commit(checked.map((c) => c.write), meta(actor, kind, w.data));
    return { ok: true, rev: r.rev, seq: r.seq };
  }

  function write(w) {
    try {
      return store.transaction((tx) => {
        const r = applyWrite(tx, w, w.actor);
        return r.ok ? r : refuse({ actor: w.actor, entity: w.entity, id: w.id }, r.reason);
      });
    } catch (e) { return refuse({ actor: w?.actor, entity: w?.entity, id: w?.id }, `${e?.caller ? '' : 'store error: '}${String(e?.message ?? e).slice(0, 200)}`); }
  }

  // ---- the outbox (R-0b-20, M-3, R2-M8 … R2-M10, R3-M4) ----
  function applyParsed(tx, tag, f) {
    const actor = `${tag.role}:${tag.sessionId}`;
    const entity = f.spec.entity;
    if (f.spec.mode === 'create') {
      // Created once per file content, even if the "seen" note was lost in a crash after the write.
      if (tx.list(entity).some((e) => e.doc.source_key === f.key)) return { ok: true, skipped: true };
      const id = `${f.kind}${tag.sessionId}-${tx.nextSeq()}`;
      const doc = { kind: f.kind, role: tag.role, session_id: tag.sessionId, card: tag.card ?? null, source: basename(f.realpath), source_key: f.key, sha256: f.sha256, text: f.body };
      return applyWrite(tx, { entity, id, expectRev: 0, doc, kind: 'outbox' }, actor);
    }
    const h = f.header;
    const fields = h.fields ?? {};
    if (f.kind === 'handin-') {
      if (typeof tag.card !== 'string' || h.id !== tag.card) return no('a hand-in names only the session\'s own card');
      if (h.from_state !== 'running' || h.to_state !== 'in_review') return no('a hand-in moves running → in_review');
      const cur = tx.current('card', h.id);
      if (!cur || cur.tampered) return no(cur?.reason ?? `no card ${h.id}`);
      if (cur.doc.state !== 'running') return no(`card ${h.id} is ${cur.doc.state}, not running`);
      if (cur.doc.claim?.kind !== 'session' || cur.doc.claim.session_id !== tag.sessionId) return no(`session ${tag.sessionId} does not hold card ${h.id}`);
      if (Object.hasOwn(fields, 'state')) return no('state is set by the move');
      return applyWrite(tx, { entity: 'card', id: h.id, expectRev: cur.rev, doc: { ...cur.doc, ...fields, state: 'in_review' }, kind: 'handin', data: { file: basename(f.realpath) } }, actor, { stateChecked: true });
    }
    if (f.kind === 'verdict-') {
      if (typeof tag.card !== 'string' || h.card !== tag.card) return no('a verdict names only the session\'s own card');
      const c = tx.current('card', tag.card);
      if (!c || c.tampered) return no(c?.reason ?? `no card ${tag.card}`);
      // A verdict is matched on its card, its head and the session the runner launched (below), never on the card's
      // revision (L68): the Dispatcher writes the card on every review request, so a long review would go stale.
      const vf = verdictFields(h);
      if (!vf.ok) return no(vf.reason);
      // L44, L65: only a session the review runner launched as this role, on this card, at this exact head, may give a
      // verdict. The runner's own record is the proof; a launch the Dispatcher wrote into the Record is not.
      const rl = runnerLaunchFor({ root: outbox.launches, uids: outbox.uids, role: tag.role, card: tag.card, head: fields.head, sessionId: tag.sessionId });
      if (!rl.ok) return no(`no launch of ${tag.role} session ${tag.sessionId} on ${tag.card} at head ${fields.head.slice(0, 7)} from the review runner (${rl.reason}): a verdict counts only from a session the runner launched, for the head it was launched on`);
      // One verdict per session (D12, 0b-9 M6): a reviewer that changes its mind is a new launch, never a second file.
      if (tx.list('verdict').some((v) => v.doc.session_id === tag.sessionId)) return no(`session ${tag.sessionId} has already given its verdict; a second is refused`);
      const id = `verdict-${tag.sessionId}-${tx.nextSeq()}`;
      // For display: what counts is read again from the file each time (L66 M1).
      const doc = { session_id: tag.sessionId, role: tag.role, card: tag.card, card_rev: c.rev, head: vf.head, pass: vf.pass, notes: vf.notes, checklist: vf.checklist, material: vf.material, text: f.body, source_key: f.key, outbox_uid: f.owner_uid, runner_launch: rl.key };
      return applyWrite(tx, { entity: 'verdict', id, expectRev: 0, doc, kind: 'verdict' }, actor);
    }
    if (f.kind === 'roadmap-') {
      if (typeof h.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(h.id) || h.id.length > 200) return no('bad card id');
      if (!Number.isInteger(h.expectRev) || h.expectRev < 0) return no('the header needs expectRev');
      const cur = tx.lookup('card', h.id);
      const base = h.expectRev === 0 ? { state: 'draft' } : (cur?.doc ?? {});
      const doc = { ...base, ...fields };
      if (h.to_state !== undefined) doc.state = h.to_state;
      return applyWrite(tx, { entity: 'card', id: h.id, expectRev: h.expectRev, doc, kind: 'roadmap' }, actor);
    }
    return no(`outbox kind ${f.kind} has no record rule`);
  }

  function applyOutbox(tag, file) {
    const f = readOutboxFile({ outboxRoot: outbox.root, uids: outbox.uids, tag, file });
    try {
      return store.transaction((tx) => {
        if (tx.seen(f.key)) return { ok: true, skipped: true };
        const ev = { actor: `${tag.role}:${tag.sessionId}`, file: basename(String(file)) };
        if (!f.ok) { tx.markSeen(f.key, 'refused'); return refuse({ ...ev, outbox: true }, f.reason); }
        // A hand-in whose refusal fact is already down was refused before a kill stopped the seen mark: it stays refused,
        // never re-judged, so a session told "refused" can't find it applied later (round 11 confirm m1).
        const refusedId = f.kind === 'handin-' ? `outbox-refused-${tag.sessionId}-${createHash('sha256').update(f.key).digest('hex').slice(0, 12)}` : null;
        const told = refusedId ? tx.lookup('fact', refusedId) : null;
        if (told) { tx.markSeen(f.key, 'refused'); return refuse({ ...ev, outbox: true }, told.doc?.reason ?? 'refused'); }
        // A store error (a damaged diary, a lost lock) is not the file's fault: the file stays unseen and is tried again on
        // the next pass, so nothing an AI handed in is lost; the owner is alerted once per file (round 3 m-D, round 4 MAT-1).
        let r, storeErr;
        try {
          r = applyParsed(tx, tag, f);
          // A refused hand-in becomes a fact the session's watcher reads at once (R3-M4). The fact goes down before the file is
          // marked seen, so a kill between them can't lose it; a store error writing it leaves the file unseen to try again (round 11 m1, confirm m2).
          if (!r.ok && refusedId) tx.commit([{ entity: 'fact', id: refusedId, doc: { type: 'outbox_refused', session: tag.sessionId, file: ev.file, reason: r.reason } }], meta('dispatcher', 'outbox_refused'));
        } catch (e) {
          // A throw from the file's own content (not the store, not the disk) refuses the file like any other refusal (round 5 m-1).
          if (e?.store === true || typeof e?.code === 'string') storeErr = e;
          else r = no(`the file could not be applied: ${String(e?.message ?? e).slice(0, 200)}`);
        }
        if (storeErr) {
          const reason = `store error: ${String(storeErr?.message ?? storeErr).slice(0, 200)}; the file will be tried again`;
          const once = `store_error:${f.key}`;
          if (tx.seen(once)) return no(reason);
          tx.markSeen(once, 'alerted');
          return refuse({ ...ev, outbox: true }, reason);
        }
        if (r.ok) { tx.markSeen(f.key, 'applied'); return r; }
        tx.markSeen(f.key, 'refused');
        return refuse({ ...ev, outbox: true }, r.reason);
      });
    } catch (e) { return refuse({ actor: `${tag?.role}:${tag?.sessionId}`, outbox: true }, `store error: ${String(e?.message ?? e).slice(0, 200)}`); }
  }

  // ---- claims (R-0b-23, M-5, R2-M6, R2-m5, R3-M4) ----
  function endClaim(tx, entry, to, kind, data, extra = {}) {
    const doc = { ...entry.doc, ...extra, state: to };
    delete doc.claim;
    return tx.commit([{ entity: 'card', id: entry.id, doc }], meta('dispatcher', kind, data));
  }

  function release({ card, session_id: sid, reason } = {}) {
    try {
      return store.transaction((tx) => {
        const c = tx.current('card', card);
        if (!c || c.tampered) return no(c?.reason ?? `no card ${card}`);
        if (c.doc.state !== 'claimed') return no(`card ${card} is ${c.doc.state}, not claimed`);
        const holder = c.doc.claim?.session_id ?? c.doc.claim?.claim_id;
        if (typeof sid !== 'string' || holder !== sid) return refuse({ actor: 'dispatcher', entity: 'card', id: card }, `only the claim's holder (${holder}) may release it`);
        const r = endClaim(tx, c, 'ready', 'claim_release', releaseData(sid, reason));
        return { ok: true, rev: r.rev, seq: r.seq };
      });
    } catch (e) { return no(`store error: ${String(e?.message ?? e).slice(0, 200)}`); }
  }

  // G1: dead only when (a) the process, (b) the session and (c) recent activity all say so.
  function deadness(tx, claim, p, nowMs, stuckMin) {
    if (!processDead(claim, p)) return { dead: false, why: 'process alive' };
    const s = tx.lookup('session', claim.session_id);
    if (!s) return { dead: false, why: 'no session record' };
    const sessionDead = s.doc.state === 'ended' || s.doc.state === 'quarantined' || processDead({ pid: s.doc.pid, pid_start: s.doc.pid_start }, p);
    if (!sessionDead) return { dead: false, why: 'session alive' };
    const last = Math.max(Date.parse(s.doc.last_activity) || 0, Date.parse(s.ts) || 0);
    if (nowMs - last <= stuckMin * MIN) return { dead: false, why: 'recent activity' };
    return { dead: true, why: 'process and session dead, no recent activity' };
  }

  function breakIfDead({ card } = {}, p = probe) {
    try {
      const out = store.transaction((tx) => {
        const c = tx.current('card', card);
        if (!c || c.tampered) return no(c?.reason ?? `no card ${card}`);
        if (c.doc.state !== 'claimed' && c.doc.state !== 'running') return no(`card ${card} is ${c.doc.state}; only a claimed or running card's claim is broken`);
        const claim = c.doc.claim;
        if (claim?.kind !== 'session') return no('a tab claim is never broken; it lapses');
        if (claim.host !== host) return no(`claim is from host ${claim.host}; never broken from here`);
        if (!Number.isInteger(claim.pid)) return no('this claim has no process yet; it lapses at claims.unlaunched_min, never broken');
        const stuckMin = num('claims.stuck_min');
        if (stuckMin === undefined || stuckMin < 1) return no('the rules set no claims.stuck_min, so no claim is broken');
        const nowMs = now();
        const mine = deadness(tx, claim, p, nowMs, stuckMin);
        if (!mine.dead) return no(`owner not provably dead (${mine.why})`);
        // Whether many dead claims at once are an outage (and none is broken) is the Dispatcher's one rule (M11
        // outage.mjs, L72 (ii)); this breaks only the claim it is given, once its own owner is provably dead.
        const r = endClaim(tx, c, 'ready', 'claim_break', { session_id: claim.session_id, pid: claim.pid, why: mine.why });
        return { ok: true, rev: r.rev, seq: r.seq, broke: { session_id: claim.session_id, why: mine.why } };
      });
      // Each break is told to the owner, once the write is down (L43).
      if (!out.ok) return out;
      store.alert({ type: 'claim_broken', card, session_id: out.broke.session_id, why: out.broke.why });
      return { ok: true, rev: out.rev, seq: out.seq };
    } catch (e) { return no(`store error: ${String(e?.message ?? e).slice(0, 200)}`); }
  }

  // A session claim with no process yet that has not reached running within claims.unlaunched_min lapses (L72), but only
  // once `stopSession(session_id)` answers true: whatever was started under that id is stopped (or nothing ran), so the
  // card can't run twice. With no stopSession, or an answer that is not true, the claim stays and the owner is told once
  // a day. stopSession runs before the lock is taken, and the lapse checks the claim is still that one.
  function lapseClaims(nowArg, { stopSession } = {}) {
    const nowMs = Number.isFinite(nowArg) ? nowArg : now();
    // Through the typed reader (L148 item 2): the claims map stays text on a real install ("30"). Missing means the
    // default; set but not a positive whole number refuses the pass.
    let unlaunchedMin;
    try {
      const raw = get('claims.unlaunched_min');
      unlaunchedMin = raw === undefined || raw === null ? UNLAUNCHED_MIN_DEFAULT : num('claims.unlaunched_min');
    } catch (e) { return no(`the rules could not be read (${String(e?.message ?? e).slice(0, 200)})`); }
    if (unlaunchedMin === undefined || unlaunchedMin < 1) return no('claims.unlaunched_min must be a whole number of minutes');
    const stopped = new Set();
    const held = [];
    for (const c of store.list('card')) {
      const claim = c.doc.claim;
      if (c.doc.state !== 'claimed' || claim?.kind !== 'session' || Number.isInteger(claim.pid)) continue;
      if (!(nowMs > Date.parse(claim.claimed_at) + unlaunchedMin * MIN)) continue;
      let ok = false, why = 'no way to stop a session was given';
      if (typeof stopSession === 'function') { try { ok = stopSession(claim.session_id) === true; if (!ok) why = 'stopSession did not say it stopped'; } catch (e) { why = String(e?.message ?? e).slice(0, 200); } }
      if (ok) stopped.add(`${c.id}\u0000${claim.session_id}`);
      else held.push({ card: c.id, session_id: claim.session_id, why });
    }
    try {
      return store.transaction((tx) => {
        for (const h of held) {
          // One alert per card per day (L38).
          const key = `alert:unlaunched_held:${h.card}:${iso(nowMs).slice(0, 10)}`;
          if (!tx.seen(key)) { store.alert({ type: 'unlaunched_claim_held', ...h }); tx.markSeen(key, 'alerted'); }
        }
        const t = timeouts();
        const running = timeoutFor(t, 'card', 'running');
        const waitT = timeoutFor(t, 'card', 'waiting');
        // The one reading of the heartbeat limit (heartbeatLimit, L115 m-A). Missing or not a positive whole number:
        // staleness is not judged (the claim holds to the running limit, so the card can't start twice), and the owner is
        // told once a day.
        const stale = heartbeatLimit(rules, product);
        if (stale === undefined && tx.list('card').some((e) => e.doc.claim?.kind === 'tab' && (e.doc.state === 'claimed' || e.doc.state === 'running'))) {
          const key = `alert:heartbeat_stale_unreadable:${iso(nowMs).slice(0, 10)}`;
          const staleRaw = get('proposals.heartbeat_stale_min');
          if (!tx.seen(key)) { store.alert({ type: 'heartbeat_stale_unreadable', key: 'proposals.heartbeat_stale_min', value: staleRaw === undefined ? null : String(staleRaw).slice(0, 40) }); tx.markSeen(key, 'alerted'); }
        }
        const lapsed = [];
        for (const e of tx.list('card')) {
          const claim = e.doc.claim;
          if (!claim || (e.doc.state !== 'claimed' && e.doc.state !== 'running')) continue;
          // Check the file before writing over it: a hand-edited card is quarantined and alerted, not silently replaced (round 3 m-C).
          const chk = tx.current('card', e.id);
          if (!chk || chk.tampered) continue;
          if (claim.kind === 'session') {
            if (e.doc.state !== 'claimed') continue;
            // A claimed session claim has no process yet (its pid comes with claimed → running): it lapses at
            // claims.unlaunched_min, once its session id was stopped above (the same claim). A running one is never lapsed
            // here; a dead owner's claim is broken (breakIfDead).
            if (stopped.has(`${e.id}\u0000${claim.session_id}`)) {
              const r = endClaim(tx, e, 'ready', 'claim_lapse', { why: 'never launched', after_min: unlaunchedMin, session_id: claim.session_id });
              lapsed.push({ card: e.id, to: 'ready', seq: r.seq });
            }
            continue;
          }
          // A tab claim: its heartbeat or the running limit. A heartbeat counts only from the Dispatcher's own family,
          // written by the Dispatcher (L74 addendum, L77 (5)): another role's `tab_heartbeat` keeps no claim alive.
          const beats = tx.list('fact').filter((x) => factFrom(TAB_HEARTBEAT_WRITER, x, TAB_HEARTBEAT_FAMILY) && x.doc.type === 'tab_heartbeat' && x.doc.claim_id === claim.claim_id).map((x) => Date.parse(x.ts));
          const lastBeat = Math.max(Date.parse(claim.claimed_at) || 0, ...beats);
          const staleHit = stale >= 1 && nowMs - lastBeat > stale * MIN;
          const limitHit = !!running?.minutes && nowMs - (Date.parse(claim.claimed_at) || 0) > running.minutes * MIN;
          if (!staleHit && !limitHit) continue;
          const why = staleHit ? 'heartbeat stale' : 'running limit';
          if (e.doc.state === 'claimed') {
            const r = endClaim(tx, e, 'ready', 'claim_lapse', { why });
            lapsed.push({ card: e.id, to: 'ready', seq: r.seq });
          } else {
            if (!waitT) continue;
            const wait = { who: 'dependency', what: 'tab claim lapsed', since: iso(nowMs), next_check: iso(nowMs + (waitT.minutes ?? waitT.recheck_max_min) * MIN), resume: 'retry', return_to: 'ready' };
            const r = endClaim(tx, e, 'waiting', 'claim_lapse', { why }, { wait });
            lapsed.push({ card: e.id, to: 'waiting', seq: r.seq });
          }
        }
        return { ok: true, lapsed };
      });
    } catch (e) { return no(`store error: ${String(e?.message ?? e).slice(0, 200)}`); }
  }

  // ---- read side ----
  function ready() {
    return store.list('card').filter((c) => c.doc.state === 'ready' && !c.doc.claim && readyCheck(c, storeView, { rules, product }).ok);
  }

  function overdue(nowArg) {
    const nowMs = Number.isFinite(nowArg) ? nowArg : now();
    const t = timeouts();
    const out = [];
    for (const entity of Object.keys(STATES)) {
      for (const d of store.list(entity)) {
        const lim = timeoutFor(t, entity, d.doc.state);
        if (lim === null) continue;
        const since = store.meta(entity, d.id)?.stateSince;
        if (lim === undefined) { out.push({ entity, id: d.id, state: d.doc.state, since, limit: null, corrupt: true, reason: `the rules have no time limit for ${entity} ${d.doc.state}` }); continue; }
        if (lim.minutes) {
          if (nowMs > Date.parse(since) + lim.minutes * MIN) out.push({ entity, id: d.id, state: d.doc.state, since, limit: lim.minutes, then: lim.then });
        } else if (d.doc.wait?.next_check && nowMs > Date.parse(d.doc.wait.next_check)) {
          out.push({ entity, id: d.id, state: d.doc.state, since, limit: 'next_check', next_check: d.doc.wait.next_check });
        }
      }
    }
    return out;
  }

  const impl = {
    read: (entity, id) => store.read(entity, id),
    list: (entity) => store.list(entity),
    diary: (opts) => store.lines(opts),
    // The Record's own times (L72): the Dispatcher's limits read these, never a field a script stamps.
    meta: (entity, id) => { const m = store.meta(entity, id); return m ? { ts: m.ts, stateSince: m.stateSince, createdBy: m.createdBy } : null; },
    write, applyOutbox, ready, overdue, release, breakIfDead, lapseClaims,
  };
  return { record: makeRecord(impl), store, impl, recover: () => store.recover() };
}
