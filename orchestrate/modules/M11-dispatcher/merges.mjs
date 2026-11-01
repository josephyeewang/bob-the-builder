// Open merge attempts and the time limits the Dispatcher enforces each pass (R-0b-57; design v3
// §2.4; review 0b-6 M11, m15, m16, c1; L72, L74 b3).
//
// The Dispatcher never calls GitHub, and never writes a merge's outcome: whether a merge happened is the Merge Gate's
// decision (L74 b3). It keeps the timing: a merge stuck in checking past its limit, or in merging while the gate's
// process is gone, is handed to M6's settleMerge, which writes as merge_gate. It reads Sensors' fact `pr-<n>` =
// { state, merged, merge_commit_sha, head_sha, observed_at } and decides only on a reading observed after the merge's
// last write (the Record's own time, rec.meta); otherwise it waits a pass. An interrupted merge is settled only on a
// final answer (L85 M-1 a): merged, or closed and not merged; a PR still open is waited on until
// timeouts.merging_open_max_min after the merging write, then refused-interrupted and Joe is told. An interrupted merge
// GitHub later shows merged goes to M6's reconcileMerge (L85 M-1 b). Merges are M6's documents:
// { card, pr, state, judged_head, merge_commit, reasons, ... }.
//
// A claimed card whose session never started is the Record's to lapse (lapseClaims, claims.unlaunched_min; tick.mjs),
// not this file's.

import { KEYS, minutes } from './keys.mjs';
import { move, waitOn, note, ageMs } from './moves.mjs';
import { startGate } from './gate.mjs';
import { rolesFor } from '../M4-workshop/launcher/review-runner.mjs';
import { relayReviewAlerts } from './review-requests.mjs';
import { settleMerge, reconcileMerge } from '../M6-merge-gate/merge-outcome.mjs';
import { textAlerts } from './alerts.mjs';
import { sensorsFact as fromSensors } from './sensor-facts.mjs';

export const PR_FACT = (n) => `pr-${n}`;
export const RECONCILED_FACT = (mergeId) => `reconciled-${mergeId}`;
const iso = (ms) => new Date(ms).toISOString();

// A Sensors reading is proof only from Sensors' own family, made by Sensors (L74 addendum).
const sensorsFact = (rec, id) => fromSensors(rec, id, 'pr-');
const fresh = (rec, prNumber, mergeId) => {
  const f = prNumber == null ? null : sensorsFact(rec, PR_FACT(prNumber));
  const seen = Date.parse(f?.doc?.observed_at ?? '');
  const changed = Date.parse(rec.meta('merge', mergeId)?.ts ?? '');
  return Number.isFinite(seen) && Number.isFinite(changed) && seen > changed ? f.doc : null;
};

/**
 * One pass of the time limits. Ports: `gateAlive()` (the Merge Gate's process), `alert(text)`, and the review
 * runner's (L65, review-requests.mjs): `hasReviewer(cardId, role, head)` (throws when the runner's status can't be
 * trusted), `requestReview({ card, head, role })` -> { ok } | { ok: false, reason } (a request the runner checks; the
 * Dispatcher never starts a review itself), and `reviewAlerts()` (the runner's alerts, told to Joe once). A card in
 * review needs a reviewer, and an auditor too on Tier 1 (m-6). `b` = this pass's bands and `running` = the running
 * sessions: a review request goes through the same start gate as every other start (audit MAT-5), so red holds it
 * unless the rules' red_runs lists reviews. `missing` collects rules values the gate lacked, for the tick to tell Joe.
 * `startsHeld` (a reason) skips review requests this pass, uncounted. When the runner's status can't be read, no review
 * is asked for, and the pass ends with that error once the other limits have run, so the tick tells Joe. Returns the
 * list of moves made, for the diary and the tests.
 */
export async function timeLimits({ rec, rules, now, b, running = [], gateAlive, hasReviewer, requestReview, reviewAlerts, alert, startsHeld = null, missing = [] }) {
  const done = [];
  const statusErrors = [];
  const lim = {
    checking: minutes(rules, KEYS.checkingMaxMin), reporting: minutes(rules, KEYS.reportingMaxMin), inReview: minutes(rules, KEYS.inReviewNoReviewerMin),
    mergingOpen: minutes(rules, KEYS.mergingOpenMaxMin),
  };
  for (const { id, doc } of rec.list('card')) {
    // The clock is the card's last write: a review request writes its count, so the next one is a full limit later.
    if (doc.state !== 'in_review' || ageMs(rec, 'card', id, now, { since: 'write' }) < lim.inReview) continue;
    const want = [];
    let unclear = false;
    for (const role of rolesFor(doc)) {
      let has;
      try { has = await hasReviewer(id, role, doc.head); } catch (e) { unclear = true; statusErrors.push(e?.message ?? String(e)); break; }
      if (has !== true && has !== false) { unclear = true; statusErrors.push(`hasReviewer gave no yes or no for card ${id}`); break; }
      if (!has) want.push(role);
    }
    if (unclear) { done.push([id, 'review not asked: the review runner\'s status could not be read']); continue; }
    if (!want.length) continue;
    // An outage, or a pass with no bands, holds the request without counting it as a failure (audit 0b-6 r2 MIN-4, MIN-5).
    if (startsHeld) { done.push([id, `reviewer held: ${startsHeld}`]); continue; }
    // A count that drives a decision lives in the card's attempts, the Dispatcher's own key (L74).
    const fails = doc.attempts?.reviewer_starts ?? 0;
    if (fails >= 2) {
      if (waitOn(rec, id, { who: 'joe', what: 'no reviewer could be asked for', now }).ok) { alert(`card ${id}: no reviewer could be asked for twice`); done.push([id, 'in_review->waiting']); }
      continue;
    }
    const g = startGate({ rules, rec, card: { id, ...doc }, kind: 'review', product: doc.product, b, running });
    // `missing` collects rules values the gate lacked, so the tick tells Joe once (audit 0b-6 r3 MAT-3).
    if (!g.ok) { if (g.missing) missing.push(g.missing); done.push([id, `reviewer held: ${g.reason}`]); continue; }
    const said = [];
    let failed = false;
    for (const role of want) {
      let r;
      try { r = await requestReview({ card: id, head: doc.head, role }); } catch (e) { r = { ok: false, reason: e?.message ?? String(e) }; }
      if (r?.ok) said.push(`${role} requested`);
      else { failed = true; said.push(`${role} request failed: ${r?.reason ?? 'no answer'}`); }
    }
    // review_requests goes up on every request, so this write always changes the card and its write time, the clock of
    // the next request, moves (L85 m-1): a second success in a row would otherwise change nothing and be refused.
    move(rec, 'card', id, { attempts: { ...(doc.attempts ?? {}), reviewer_starts: failed ? fails + 1 : 0, review_requests: (doc.attempts?.review_requests ?? 0) + 1 } }, { kind: 'review_request' });
    done.push([id, said.join(', ')]);
  }
  // A session that has said it is reporting but handed in nothing in time: its card fails.
  for (const { id, doc } of rec.list('session')) {
    if (doc.state !== 'reporting' || ageMs(rec, 'session', id, now) < lim.reporting) continue;
    const card = doc.card ? rec.read('card', doc.card) : null;
    if (card && card.doc.state === 'running' && move(rec, 'card', doc.card, { state: 'failed', failure: 'no_report' }, { kind: 'timeout' }).ok) done.push([doc.card, 'reporting->failed']);
    move(rec, 'session', id, { state: 'ended', reason: 'no_report' }, { kind: 'timeout' });
  }
  for (const { id, doc } of rec.list('merge')) {
    if (doc.state === 'checking' && ageMs(rec, 'merge', id, now) >= lim.checking) {
      done.push(...settled(rec, id, settleMerge({ record: rec, alert: textAlerts(alert), now }, id, { reason: 'timeout' }), { now, alert }));
    } else if (doc.state === 'merging' && !gateAlive()) {
      const pr = fresh(rec, doc.pr, id);
      if (!pr) { done.push([id, 'waiting for a fresh PR reading']); continue; }
      // Never refused while the outcome is unknown: GitHub may still be finishing the merge (L85 M-1 a).
      const final = pr.merged === true || pr.state === 'closed';
      const openTooLong = !final && ageMs(rec, 'merge', id, now, { since: 'write' }) >= lim.mergingOpen;
      if (!final && !openTooLong) { done.push([id, 'merge outcome not known yet: the PR is still open']); continue; }
      const r = settleMerge({ record: rec, alert: textAlerts(alert), now }, id, { pr, reason: 'interrupted', openTooLong });
      if (openTooLong && r.ok && r.outcome === 'refused') alert(`merge ${id}: the Merge Gate stopped mid-merge and PR ${doc.pr} is still open after ${Math.round(lim.mergingOpen / 60_000)} min; recorded as interrupted, and the card goes back to be merged again`);
      done.push(...settled(rec, id, r, { now, alert }));
    } else if (doc.state === 'refused' && (doc.reasons ?? []).includes('interrupted') && !rec.read('fact', RECONCILED_FACT(id))) {
      // GitHub later shows an interrupted merge merged: M6's reconcile records it merged when it was merged at the judged
      // head (L85 M-1 b). Otherwise it stays refused, the owner is told once, and the note keeps it from being told again.
      const pr = fresh(rec, doc.pr, id);
      if (pr?.merged === true) {
        const r = reconcileMerge({ record: rec, alert: textAlerts(alert), now }, id, { pr, factId: PR_FACT(doc.pr) });
        if (r.ok) { done.push([id, 'interrupted, then merged: reconciled']); if (r.card) done.push([r.card, '->merged']); continue; }
        if (!r.told) alert(`merge ${id} was recorded as interrupted but PR ${doc.pr} shows merged, and it could not be recorded merged (${r.reason}); check the card and its audit`);
        note(rec, RECONCILED_FACT(id), `merge ${id} was recorded as interrupted but PR ${doc.pr} shows merged; the owner was told`, { now });
        done.push([id, 'refused but merged: told']);
      }
    }
  }
  if (reviewAlerts) {
    let list = null;
    try { list = await reviewAlerts(); } catch (e) { statusErrors.push(e?.message ?? String(e)); }
    if (list) relayReviewAlerts({ rec, alerts: list, alert, now });
  }
  if (statusErrors.length) throw new Error(`no review was asked for: ${statusErrors[0]}`);
  return done;
}

// What M6's settleMerge did, for the list. A card put back with the same refusal reason a second time goes to Joe
// (the reasons are the gate's attempts.merge_refusals).
function settled(rec, id, r, { now, alert }) {
  if (!r.ok) return [[id, `not settled: ${r.reason}`]];
  if (r.outcome === 'merged') return [[id, 'merged']];
  const out = [[id, `refused:${rec.read('merge', id)?.doc?.reasons?.[0] ?? 'unknown'}`]];
  if (!r.card) return out;
  out.push([r.card.id, `->${r.card.to}`]);
  const card = rec.read('card', r.card.id);
  const reasons = card?.doc?.attempts?.merge_refusals ?? [];
  const last = reasons.at(-1);
  if (last && reasons.indexOf(last) !== reasons.length - 1) {
    const pr = rec.read('merge', id)?.doc?.pr;
    if (waitOn(rec, r.card.id, { who: 'joe', what: `merge refused twice: ${last}`, now, link: pr != null ? `PR ${pr}` : undefined }).ok) {
      alert(`card ${r.card.id}: the merge was refused twice for the same reason (${last})`);
      out.push([r.card.id, 'waiting on joe']);
    }
  }
  return out;
}

// One record per request, never changed (L74: merge_request is create-only): a new rev of the card is a new request.
export const MERGE_REQUEST = (card, head, rev) => `mr-${card}-${String(head).slice(0, 12)}-${rev}`;
const READY_TO_MERGE = ['verified', 'approved'];

// The worker session that made the card's work: its newest worker launch (the Dispatcher's own launch records).
function workerSession(rec, cardId) {
  const mine = rec.list('launch').filter((l) => l.doc?.role === 'worker' && l.doc.card === cardId && typeof l.doc.session_id === 'string');
  mine.sort((x, y) => String(y.doc.launched_at ?? '').localeCompare(String(x.doc.launched_at ?? '')));
  return mine[0]?.doc.session_id ?? null;
}
// The card's pull request: the one Sensors reading whose head is the card's head (a card carries no PR number; no
// script may write one on it).
function prOf(rec, head) {
  const hits = rec.list('fact').filter((f) => /^pr-\d+$/.test(f.id) && f.doc?.head_sha === head && sensorsFact(rec, f.id));
  return hits.length === 1 ? Number(hits[0].id.slice(3)) : hits.length ? { many: hits.length } : null;
}

/**
 * Merge requests (R-0b-67, R-0b-68; review 0b-6 M23, D12). For each card the review passed (verified, or approved),
 * naming its head, with no request for this head and rev yet, the Dispatcher stores a
 * `merge_request` { card, pr, session_id, head, rev, requested_at }: the Merge Gate merges only a change with a stored
 * request matching session, head and rev (refusal 11). The request goes through the start gate as kind 'merge', so
 * red holds it unless red_runs lists merges, and no Tier-1 production change is requested above the usage line or
 * while usage is unknown. An undo (exact_reverse) card's request goes as 'undo_merge', which no band holds (R-0b-68),
 * even when this pass has no bands (`startsHeld`, a reason): then every other request is held (L31).
 * `session_id` is the worker session that made the head (its launch record); `pr` is Sensors' reading for the head.
 * The review itself is not read here (L72): the Record lets a card into verified or approved only with a passing
 * verdict for the head it has now, counted from the review sessions' own files (M9 verdictFor), and the Merge Gate
 * counts them again. The Record's verdict rows are not proof, so the Dispatcher does not read them.
 */
export function requestMerges({ rec, rules, now, b, running = [], startsHeld = null, missing = [] }) {
  const done = [];
  for (const { id, rev, doc } of rec.list('card')) {
    if (!READY_TO_MERGE.includes(doc.state)) continue;
    // The card must name its own head (audit 0b-6 r2 MIN-9): no head is no merge.
    if (!doc.head) { done.push([id, 'not ready: the card names no head']); continue; }
    const session = workerSession(rec, id);
    const pr = prOf(rec, doc.head);
    if (pr == null || typeof pr !== 'number' || !session) {
      done.push([id, pr?.many ? `not ready: ${pr.many} pull requests show head ${doc.head.slice(0, 7)}` : 'not ready: needs a pull request and its session']);
      continue;
    }
    const mid = MERGE_REQUEST(id, doc.head, rev);
    if (rec.read('merge_request', mid)) continue;
    const again = rec.list('merge_request').some((q) => q.doc?.card === id);
    // An undo is never held by the band (audit 0b-6 r2 MAT-4, L31): it is the way out of a bad change.
    // When this pass has no bands (an outage, or the main pass failed), only undos are requested.
    if (startsHeld && doc.kind !== 'exact_reverse') { done.push([id, `merge request held: ${startsHeld}`]); continue; }
    const g = startGate({ rules, rec, card: { id, ...doc }, kind: doc.kind === 'exact_reverse' ? 'undo_merge' : 'merge', product: doc.product, b, running });
    if (!g.ok) { if (g.missing) missing.push(g.missing); done.push([id, `merge request held: ${g.reason}`]); continue; }
    const w = rec.write({ actor: 'dispatcher', entity: 'merge_request', id: mid, expectRev: 0, kind: 'merge_request',
      doc: { card: id, pr, session_id: session, head: doc.head, rev, product: doc.product ?? null, requested_at: iso(now) } });
    done.push([id, w.ok ? (again ? 'merge requested again' : 'merge requested') : `merge request not recorded: ${w.reason}`]);
  }
  return done;
}
