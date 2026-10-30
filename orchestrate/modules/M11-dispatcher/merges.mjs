// Open merge attempts and the time limits the Dispatcher enforces each pass (R-0b-57; design v3
// §2.4; review 0b-6 M11, m15, m16, c1).
//
// The Dispatcher never calls GitHub. It reads Sensors' fact `pr-<n>` = { state, merged,
// merge_commit_sha, head_sha, observed_at } and decides only on a fact observed after the attempt's
// last change; otherwise it waits a pass. Merge attempts are `merge` entries:
// { card, pr, state, head_sha, merge_commit_sha, reason, changed_at }.

import { KEYS, minutes } from './keys.mjs';
import { move, waitOn, note, ageMs } from './moves.mjs';
import { startGate } from './gate.mjs';

export const PR_FACT = (n) => `pr-${n}`;
const fresh = (fact, attempt) => {
  const seen = Date.parse(fact?.doc?.observed_at ?? '');
  const changed = Date.parse(attempt.changed_at ?? '');
  return Number.isFinite(seen) && Number.isFinite(changed) && seen > changed ? fact.doc : null;
};

/**
 * One pass of the time limits. Ports: `hasSession(cardId)` (a live session for the card),
 * `gateAlive()` (the Merge Gate's process), `hasReviewer(cardId)`, `startReviewer(cardId)` -> { ok },
 * `alert(text)`. `b` = this pass's bands and `running` = the running sessions: a reviewer start goes
 * through the same start gate as every other start (audit MAT-5), so red holds it unless the rules'
 * red_runs lists reviews. Returns the list of moves made, for the diary and the tests.
 */
export async function timeLimits({ rec, rules, now, b, running = [], hasSession, gateAlive, hasReviewer, startReviewer, alert }) {
  const done = [];
  const lim = {
    claimed: minutes(rules, KEYS.claimedNoSessionMin), checking: minutes(rules, KEYS.checkingMaxMin),
    reporting: minutes(rules, KEYS.reportingMaxMin), inReview: minutes(rules, KEYS.inReviewNoReviewerMin),
  };
  for (const { id, doc } of rec.list('card')) {
    if (doc.state === 'claimed' && !hasSession(id) && ageMs(doc, now) >= lim.claimed) {
      if (move(rec, 'card', id, { state: 'ready', claim: null }, { now, kind: 'timeout' }).ok) done.push([id, 'claimed->ready']);
    }
    if (doc.state === 'in_review' && !hasReviewer(id) && ageMs(doc, now) >= lim.inReview) {
      const fails = doc.reviewer_start_failures ?? 0;
      if (fails >= 2) {
        if (waitOn(rec, id, { who: 'joe', what: 'no reviewer could be started', now }).ok) { alert(`card ${id}: no reviewer could be started twice`); done.push([id, 'in_review->waiting']); }
        continue;
      }
      const g = startGate({ rules, rec, card: { id, ...doc }, kind: 'review', product: doc.product, b, running });
      if (!g.ok) { done.push([id, `reviewer held: ${g.reason}`]); continue; }
      let r;
      try { r = await startReviewer(id); } catch (e) { r = { ok: false, reason: e.message }; }
      move(rec, 'card', id, r?.ok ? { reviewer_start_failures: 0 } : { reviewer_start_failures: fails + 1 }, { now, kind: 'reviewer_start' });
      done.push([id, r?.ok ? 'reviewer started' : 'reviewer start failed']);
    }
  }
  // A session that has said it is reporting but handed in nothing in time: its card fails.
  for (const { id, doc } of rec.list('session')) {
    if (doc.state !== 'reporting' || ageMs(doc, now) < lim.reporting) continue;
    const card = doc.card ? rec.read('card', doc.card) : null;
    if (card && card.doc.state === 'running' && move(rec, 'card', doc.card, { state: 'failed', reason: 'no_report' }, { now, kind: 'timeout' }).ok) done.push([doc.card, 'reporting->failed']);
    move(rec, 'session', id, { state: 'ended', reason: 'no_report' }, { now, kind: 'timeout' });
  }
  for (const { id, doc } of rec.list('merge')) {
    if (doc.state === 'checking' && ageMs(doc, now) >= lim.checking) {
      done.push(...refuse(rec, id, doc, 'timeout', { now, alert }));
    } else if (doc.state === 'merging' && !gateAlive()) {
      const pr = fresh(rec.read('fact', PR_FACT(doc.pr)), doc);
      if (!pr) { done.push([id, 'waiting for a fresh PR reading']); continue; }
      if (pr.merged === true) done.push(...merged(rec, id, doc, pr, { now, alert }));
      else done.push(...refuse(rec, id, doc, 'interrupted', { now, alert }));
    } else if (doc.state === 'refused' && doc.reason === 'interrupted') {
      // Reconcile both ways: GitHub wins.
      const pr = fresh(rec.read('fact', PR_FACT(doc.pr)), doc);
      if (pr?.merged === true) {
        done.push(...merged(rec, id, doc, pr, { now, alert }));
        note(rec, `reconciled-${id}`, `merge ${id} was recorded as interrupted but PR ${doc.pr} shows merged; recorded as merged`, { now });
      }
    }
  }
  return done;
}

function merged(rec, id, doc, pr, { now, alert }) {
  const out = [];
  const w = move(rec, 'merge', id, { state: 'merged', merge_commit_sha: pr.merge_commit_sha ?? null, merged_head_sha: pr.head_sha ?? null }, { now, kind: 'merge_outcome' });
  if (!w.ok) return out;
  out.push([id, 'merged']);
  if (pr.head_sha !== doc.head_sha) alert(`PR ${doc.pr} merged at ${pr.head_sha}, not the checked ${doc.head_sha}; the audit judges it`);
  if (doc.card && rec.read('card', doc.card)) move(rec, 'card', doc.card, { state: 'merged' }, { now, kind: 'merge_outcome' });
  return out;
}

// A refusal sends the card back to `verified` (or `in_review` when its verdict is for another head);
// the same reason a second time goes to Joe.
function refuse(rec, id, doc, reason, { now, alert }) {
  const out = [];
  if (!move(rec, 'merge', id, { state: 'refused', reason }, { now, kind: 'merge_outcome' }).ok) return out;
  out.push([id, `refused:${reason}`]);
  const card = doc.card ? rec.read('card', doc.card) : null;
  if (!card) return out;
  const seen = card.doc.merge_refusals ?? [];
  if (seen.includes(reason)) {
    if (waitOn(rec, doc.card, { who: 'joe', what: `merge refused twice: ${reason}`, now, link: doc.pr ? `PR ${doc.pr}` : undefined }).ok) {
      alert(`card ${doc.card}: the merge was refused twice for the same reason (${reason})`);
      out.push([doc.card, 'waiting on joe']);
    }
    return out;
  }
  const verdict = rec.read('verdict', doc.card)?.doc;
  const back = verdict && verdict.head === doc.head_sha ? 'verified' : 'in_review';
  move(rec, 'card', doc.card, { state: back, merge_refusals: [...seen, reason] }, { now, kind: 'merge_refused' });
  out.push([doc.card, `->${back}`]);
  return out;
}

export const MERGE_REQUEST = (card, head) => `mr-${card}-${String(head).slice(0, 12)}`;
const READY_TO_MERGE = ['verified', 'approved'];

/**
 * Merge requests (R-0b-67, R-0b-68; review 0b-6 M23, D12). For each card the review passed (verified,
 * or approved), whose verdict is for the card's current head and who has no request for that head
 * yet, the Dispatcher stores a `merge_request` { card, pr, session_id, head, rev, requested_at }: the
 * Merge Gate merges only a change with a stored request matching session, head and rev (refusal 11).
 * The request goes through the start gate as kind 'merge', so red holds it unless red_runs lists
 * merges, and no Tier-1 production change is requested above the usage line or while usage is unknown.
 * `session_id` is the worker session that made the head; `rev` is the card's record rev.
 */
export function requestMerges({ rec, rules, now, b, running = [] }) {
  const done = [];
  for (const { id, rev, doc } of rec.list('card')) {
    if (!READY_TO_MERGE.includes(doc.state)) continue;
    const verdict = rec.read('verdict', id)?.doc;
    if (!verdict?.head || doc.pr == null || !doc.session) { done.push([id, 'not ready: needs a verdict, a pull request and its session']); continue; }
    if (doc.head != null && doc.head !== verdict.head) { done.push([id, 'the verdict is for another head']); continue; }
    const mid = MERGE_REQUEST(id, verdict.head);
    if (rec.read('merge_request', mid)) continue;
    const g = startGate({ rules, rec, card: { id, ...doc }, kind: 'merge', product: doc.product, b, running });
    if (!g.ok) { done.push([id, `merge request held: ${g.reason}`]); continue; }
    const w = rec.write({ actor: 'dispatcher', entity: 'merge_request', id: mid, expectRev: 0, kind: 'merge_request',
      doc: { card: id, pr: doc.pr, session_id: doc.session, head: verdict.head, rev, product: doc.product ?? null, requested_at: new Date(now).toISOString() } });
    done.push([id, w.ok ? 'merge requested' : `merge request not recorded: ${w.reason}`]);
  }
  return done;
}
