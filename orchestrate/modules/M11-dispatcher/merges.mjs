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

import { KEYS, minutes, MissingKey, missingFor } from './keys.mjs';
import { move, ageMs } from './moves.mjs';
import { waitOnJoe } from './joe-waits.mjs';
import { startGate } from './gate.mjs';
import { rolesFor } from '../M4-workshop/launcher/review-runner.mjs';
import { relayReviewAlerts } from './review-requests.mjs';
import { settleMerge, reconcileMerge, prReadingAfter, openTooLong as tooLongOpen, PR_FACT, MERGED_OUTSIDE, MERGED_OUTSIDE_UNTOLD, refusedTwice } from '../M6-merge-gate/merge-outcome.mjs';
import { textAlerts, tellThen, alertText, heldAlerts, isQueued } from './alerts.mjs';
import { sensorsFact as fromSensors } from './sensor-facts.mjs';
import { FINAL_STATES } from '../../shared/record.mjs';

// The pull request reading and the open-too-long clock are M6's, shared with the gate's own recover() (L94).
export { PR_FACT };
export const RECONCILED_FACT = (mergeId) => `reconciled-${mergeId}`;
/**
 * What M6 said while reconciling an interrupted merge that GitHub shows merged (L138 MAT-3): { text, at }, and
 * `told_at` once a copy is delivered. The merge is merged by then, so nothing else would ask again: each pass re-tells
 * a text with no told_at that is not already queued.
 */
export const RECONCILE_TELL_FACT = (mergeId) => `merge-reconcile-tell-${mergeId}`;
/** The note that Joe was told a stopped merge has had no fresh PR reading past its limit (L89), so he is told once. */
export const UNREAD_FACT = (mergeId) => `merge-unread-${mergeId}`;
/** The note that Joe was told a repeat refusal could not be put on him (L116 M-1), once per card per refusal count. */
export const ASK_REFUSED_FACT = (cardId, refusals) => `merge-ask-refused-${cardId}-${refusals}`;
const iso = (ms) => new Date(ms).toISOString();
// A told note's fields (the shape moves.mjs note() writes), as the mark of the alert it records: the one way this file
// says the owner was told is tellThen, so the note is written only once the alert is delivered (L127; sendAlerts).
const noted = (text, now) => ({ text, at: iso(now) });

// The held alerts of a reconcile made (MAT-3): the text is recorded, then told through tellThen, whose mark (told_at)
// is written only once a copy is delivered; retellReconciles asks again each pass until then. A text the Record would
// not keep has no fact to ask again from, so it is told now either way, and the list says when that was not taken.
function tellReconcile(rec, id, text, { alert, now }) {
  const f = RECONCILE_TELL_FACT(id);
  const cur = rec.read('fact', f);
  const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: f, expectRev: cur?.rev ?? 0, doc: { text, at: iso(now) }, kind: 'note' });
  if (!w.ok) return [id, alert(text) === false ? `reconciled, not told: ${w.reason}, and the alert was not taken` : `reconciled, told once: ${w.reason}`];
  tellThen(alert, text, { fact: RECONCILE_TELL_FACT(id), fields: { told_at: iso(now) }, kind: 'note' });
  return [id, 'reconciled: told until delivered'];
}
function retellReconciles(rec, { alert, now }) {
  const out = [];
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(RECONCILE_TELL_FACT('')) || !f.doc?.text || f.doc.told_at || isQueued(rec, f.id)) continue;
    const mergeId = f.id.slice(RECONCILE_TELL_FACT('').length);
    tellThen(alert, f.doc.text, { fact: RECONCILE_TELL_FACT(mergeId), fields: { told_at: iso(now) }, kind: 'note' });
    out.push([mergeId, 'reconciled: told again']);
  }
  return out;
}

const fresh = (rec, prNumber, mergeId) => prReadingAfter(rec, prNumber, mergeId);
const LANDED = ['checking', 'merging', 'merged', 'audited_ok', 'audit_flagged'];
const landedElsewhere = (rec, id, doc) => rec.list('merge').some((m) => m.id !== id && m.doc?.pr === doc.pr && LANDED.includes(m.doc.state));
// A Sensors reading is proof only from Sensors' own family, made by Sensors (L74 addendum).
const sensorsFact = (rec, id) => fromSensors(rec, id, 'pr-');

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
  done.push(...retellReconciles(rec, { alert, now }));
  // The limits are per-product keys, which the real engine answers only for a named product (L110, the M-1 class):
  // each is read for its card's product, where it is used, once per product per pass (L116 m2). A key the product's
  // rules lack skips only the step that needs it: that entry is listed, untouched, and the key goes back, with the
  // product, for the tick to tell Joe. Settling a merge GitHub has already finished needs no limit at all.
  const read = new Map();
  const limOf = (cardId, name) => {
    const product = cardId ? rec.read('card', cardId)?.doc?.product ?? null : null;
    const k = `${product}\0${name}`;
    if (!read.has(k)) {
      let v;
      try { v = { ms: minutes(rules, KEYS[name], { product: product ?? undefined }) }; } catch (e) {
        if (!(e instanceof MissingKey)) throw e;
        const what = missingFor(e.key, product);
        if (!missing.includes(what)) missing.push(what);
        v = { none: `no time limit: the rules have no ${e.key} for ${product ?? 'its product'}` };
      }
      read.set(k, v);
    }
    return read.get(k);
  };
  for (const { id, doc } of rec.list('card')) {
    if (doc.state !== 'in_review') continue;
    const lim = limOf(id, 'inReviewNoReviewerMin');
    if (lim.none) { done.push([id, lim.none]); continue; }
    // The clock is the card's last write: a review request writes its count, so the next one is a full limit later.
    if (ageMs(rec, 'card', id, now, { since: 'write' }) < lim.ms) continue;
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
      if (waitOnJoe(rec, id, { what: 'no reviewer could be asked for', now, alert, text: `card ${id}: no reviewer could be asked for twice` }).ok) done.push([id, 'in_review->waiting']);
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
    if (doc.state !== 'reporting') continue;
    // A session that names no card has no product, so no product's limit applies; it is listed, and no rules value is
    // said to be missing (L116 m7).
    if (!doc.card) { done.push([id, 'no time limit: the session names no card, so no product\'s limit applies']); continue; }
    const lim = limOf(doc.card, 'reportingMaxMin');
    if (lim.none) { done.push([id, lim.none]); continue; }
    if (ageMs(rec, 'session', id, now) < lim.ms) continue;
    const card = doc.card ? rec.read('card', doc.card) : null;
    if (card && card.doc.state === 'running' && move(rec, 'card', doc.card, { state: 'failed', failure: 'no_report' }, { kind: 'timeout' }).ok) done.push([doc.card, 'reporting->failed']);
    move(rec, 'session', id, { state: 'ended', reason: 'no_report' }, { kind: 'timeout' });
  }
  for (const { id, doc } of rec.list('merge')) {
    if (doc.state === 'checking') {
      const lim = limOf(doc.card, 'checkingMaxMin');
      if (lim.none) { done.push([id, lim.none]); continue; }
      if (ageMs(rec, 'merge', id, now) >= lim.ms) done.push(...settled(rec, id, settleMerge({ record: rec, alert: textAlerts(alert), now }, id, { reason: 'timeout' }), { now, alert }));
    } else if (doc.state === 'merging' && !gateAlive()) {
      const pr = fresh(rec, doc.pr, id);
      if (!pr) {
        // No reading since the merge's last write, so the outcome is unknown and the merge stays merging (never refused
        // on no word). Past the merging limit, Joe is told once (L89): the Sensors may not be reading this PR at all.
        const lim = limOf(doc.card, 'mergingOpenMaxMin');
        if (lim.none) { done.push([id, `waiting for a fresh PR reading; ${lim.none}`]); continue; }
        const since = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 60_000)} min` : 'longer than the merging limit');
        if (tooLongOpen(rec, id, now, lim.ms) && !rec.read('fact', UNREAD_FACT(id))) {
          // The note is the alert's mark, written once it is delivered (L127): a queue that refused it is retried next pass.
          const say = `merge ${id}: the Merge Gate stopped mid-merge and PR ${doc.pr} has had no fresh reading for ${since(ageMs(rec, 'merge', id, now, { since: 'write' }))}; it stays merging until the Sensors read the PR (check that they are running)`;
          const why = `merge ${id}: no fresh reading of PR ${doc.pr} past the merging limit; the owner was told`;
          tellThen(alert, say, { fact: UNREAD_FACT(id), fields: noted(why, now), kind: 'note' });
        }
        done.push([id, 'waiting for a fresh PR reading']); continue;
      }
      // Never refused while the outcome is unknown: GitHub may still be finishing the merge (L85 M-1 a). A final answer
      // (merged, or closed and not merged) is settled with no limit read (L116 m2).
      const final = pr.merged === true || pr.state === 'closed';
      let openMs = null;
      if (!final) {
        const lim = limOf(doc.card, 'mergingOpenMaxMin');
        if (lim.none) { done.push([id, `merge outcome not known yet: the PR is still open; ${lim.none}`]); continue; }
        openMs = lim.ms;
      }
      const openTooLong = !final && tooLongOpen(rec, id, now, openMs);
      if (!final && !openTooLong) { done.push([id, 'merge outcome not known yet: the PR is still open']); continue; }
      const r = settleMerge({ record: rec, alert: textAlerts(alert), now }, id, { pr, reason: 'interrupted', openTooLong });
      // A notice only: the card goes back to be merged again whatever the answer; a lost one is in the list (L130 m3).
      if (openTooLong && r.ok && r.outcome === 'refused' && alert(`merge ${id}: the Merge Gate stopped mid-merge and PR ${doc.pr} is still open after ${Math.round(openMs / 60_000)} min; recorded as interrupted, and the card goes back to be merged again`) === false) done.push([id, 'not told: the alert could not be queued']);
      done.push(...settled(rec, id, r, { now, alert }));
    } else if (doc.state === 'refused' && !(doc.reasons ?? []).includes(MERGED_OUTSIDE) && !rec.read('fact', RECONCILED_FACT(id)) && !landedElsewhere(rec, id, doc)) {
      // A refused merge whose PR GitHub later shows merged, by a reading after the refusal. An interrupted one goes to
      // M6's reconcile, which records it merged when it was merged at the judged head (L85 M-1 b). Any other refusal, or
      // a reconcile that can't be made, stays refused and the owner is told once (L94 point 3: no refusal wording is
      // silent); the note keeps it from being told again. Skipped when another merge of the same PR is under way or
      // merged: that merge is the PR's record, so this one is neither reconciled nor told (the PR is merged once).
      // MERGED_OUTSIDE_UNTOLD was written on a merged answer whose alert was not taken (L130 M6): it needs no newer reading.
      const untold = (doc.reasons ?? []).includes(MERGED_OUTSIDE_UNTOLD);
      const pr = untold ? { merged: true } : fresh(rec, doc.pr, id);
      if (pr?.merged === true) {
        let text = untold
          ? `merge ${id}: PR ${doc.pr} merged outside the gate, at a head the gate did not judge; check the card and its audit`
          : `merge ${id} was refused (${(doc.reasons ?? []).join('; ') || 'no reason given'}) but PR ${doc.pr} shows merged; check the card and its audit`;
        if ((doc.reasons ?? []).includes('interrupted')) {
          // M6's alerts are held until its answer is known (L127): a reconcile made sends them as they are; one not made
          // sends them as the one told alert, with this file's own line when M6 did not say why itself.
          const said = [];
          const r = reconcileMerge({ record: rec, alert: heldAlerts(said), now }, id, { pr, factId: PR_FACT(doc.pr) });
          if (r.ok) {
            done.push([id, 'interrupted, then merged: reconciled']);
            if (r.card) done.push([r.card, '->merged']);
            if (said.length) done.push(tellReconcile(rec, id, said.map((e) => alertText(e)).join('; '), { alert, now }));
            continue;
          }
          const own = r.told ? [] : [`merge ${id} was recorded as interrupted but PR ${doc.pr} shows merged, and it could not be recorded merged (${r.reason}); check the card and its audit`];
          text = [...said.map((e) => alertText(e)), ...own].join('; ');
        }
        const why = `merge ${id} was recorded as refused but PR ${doc.pr} shows merged; the owner was told`;
        const said = tellThen(alert, text, { fact: RECONCILED_FACT(id), fields: noted(why, now), kind: 'note' }) !== false;
        done.push([id, said ? 'refused but merged: told' : 'refused but merged: not told yet, asked again next pass']);
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

// The one way a card whose merge was refused twice in a row for the same reason goes to Joe (L110 m-1), used by both
// paths that see it: a merge this file settles, and requestMerges, which sees the gate's own refusals (a timeout, an
// interruption, GitHub's 405, 409 or 422) before it would request the card again. Joe is asked once per repeat:
// attempts.merge_asks is set to the number of reasons in the same write, and the card waits until he answers.
// What counts: only a refusal the gate records in attempts.merge_refusals. The gate's put-backs that are not
// refusals (check() finding the card not ready, recover() putting back a merge left in checking) add no reason, so
// they never count toward a repeat (L116 m7 ruling). The reasons carry over to a new head: after a new head, one
// refusal that matches the last one before it asks Joe at once (L116 c3; reasons that alternate never ask).
// When the Record refuses the ask (an approved card, until M9 lets approved wait; a rev race), Joe is told once per
// card and refusal count, so no card stalls without him knowing (L116 M-1).
function askOnRepeat(rec, id, { now, alert, pr }) {
  const card = rec.read('card', id);
  const why = card?.doc ? refusedTwice(card.doc) : null;
  if (!why) return null;
  const n = card.doc.attempts.merge_refusals.length;
  const w = waitOnJoe(rec, id, { what: `merge refused twice: ${why}`, now, link: pr != null ? `PR ${pr}` : undefined,
    attempts: { merge_asks: n }, alert, text: `card ${id}: the merge was refused twice for the same reason (${why})` });
  if (!w.ok) {
    const told = ASK_REFUSED_FACT(id, n);
    if (!rec.read('fact', told)) {
      const say = `card ${id}: the merge was refused twice for the same reason (${why}), but the card could not be put on you to decide (${w.reason}); it is not merged or asked for again until you look at it`;
      tellThen(alert, say, { fact: ASK_REFUSED_FACT(id, n), fields: noted(`card ${id}: the ask after ${n} refusals was refused (${w.reason}); the owner was told`, now), kind: 'note' });
    }
    return [id, `not sent to joe: ${w.reason}`];
  }
  return [id, 'waiting on joe'];
}

// What M6's settleMerge did, for the list. A card put back with the same refusal reason twice in a row goes to Joe.
function settled(rec, id, r, { now, alert }) {
  if (!r.ok) return [[id, `not settled: ${r.reason}`]];
  if (r.outcome === 'merged') return [[id, 'merged']];
  const out = [[id, `refused:${rec.read('merge', id)?.doc?.reasons?.[0] ?? 'unknown'}`]];
  if (!r.card) return out;
  out.push([r.card.id, `->${r.card.to}`]);
  const asked = askOnRepeat(rec, r.card.id, { now, alert, pr: rec.read('merge', id)?.doc?.pr });
  if (asked) out.push(asked);
  return out;
}

// One record per request, never changed (L74: merge_request is create-only). The id is the card, its head and how many
// of this card's merges at this head have ENDED other than merged (L129, L138 MAT-2): a merge that ended is a new
// request, an edit to the card at the same head is not. Every way the gate puts a card back ends its merge (a refusal
// settleMerge records, check() refusing or holding at the lock, recover() in checking, refusal 8), so none of them
// leaves the card waiting on a request already taken. The repeat ask still counts only attempts.merge_refusals (L116 m7).
// The gate reads the id only as a key (its own merge names it; gather reads it back by id).
export const MERGE_REQUEST = (card, head, ended) => `mr-${card}-${String(head).slice(0, 12)}-r${ended}`;
const READY_TO_MERGE = ['verified', 'approved'];
// A merge that ended without merging: a final merge state that a merged merge never reaches (M9: merged moves only to
// audited_ok or audit_flagged).
export const ENDED_UNMERGED = Object.freeze(FINAL_STATES.merge.filter((s) => !['audited_ok', 'audit_flagged'].includes(s)));
/**
 * `card`'s merges at `head` that ended without merging (the head is the one each request named): how many, and the
 * newest card rev any of their requests was made at (null when none ended).
 */
export function endedMerges(rec, card, head) {
  let n = 0;
  let rev = null;
  for (const m of rec.list('merge')) {
    if (m.doc?.card !== card || !ENDED_UNMERGED.includes(m.doc.state)) continue;
    const q = rec.read('merge_request', m.doc.request)?.doc;
    if (q?.head !== head) continue;
    n += 1;
    if (Number.isInteger(q.rev) && (rev === null || q.rev > rev)) rev = q.rev;
  }
  return { n, rev };
}

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
export function requestMerges({ rec, rules, now, b, running = [], startsHeld = null, missing = [], alert }) {
  // No quiet default (L116 m4): a card sent to Joe is told through this alert, so a caller must give one.
  if (typeof alert !== 'function') throw new TypeError('requestMerges needs an alert');
  const done = [];
  for (const { id, rev, doc } of rec.list('card')) {
    if (!READY_TO_MERGE.includes(doc.state)) continue;
    // The same refusal twice in a row: Joe is asked, and no new request is made (L110 m-1).
    if (refusedTwice(doc)) {
      const pr = doc.head ? prOf(rec, doc.head) : null;
      const asked = askOnRepeat(rec, id, { now, alert, pr: typeof pr === 'number' ? pr : null });
      // askOnRepeat re-reads the card, and the gate is another process: a newer, different refusal recorded since
      // this list was read leaves nothing to ask, and `asked` is null (audit r5 P-F, merges-ask.test.mjs).
      if (asked) done.push(asked);
      continue;
    }
    // The card must name its own head (audit 0b-6 r2 MIN-9): no head is no merge.
    if (!doc.head) { done.push([id, 'not ready: the card names no head']); continue; }
    const session = workerSession(rec, id);
    const pr = prOf(rec, doc.head);
    if (pr == null || typeof pr !== 'number' || !session) {
      done.push([id, pr?.many ? `not ready: ${pr.many} pull requests show head ${doc.head.slice(0, 7)}` : 'not ready: needs a pull request and its session']);
      continue;
    }
    const ended = endedMerges(rec, id, doc.head);
    const mid = MERGE_REQUEST(id, doc.head, ended.n);
    if (rec.read('merge_request', mid)) continue;
    // A merge the gate ended while the card did not change (refused on what it judged, say a red check) is not asked
    // for again on every pass: each would be refused, and told to Joe, the same way. Any put-back changes the card (it went
    // through merging), and so do refusal 8's needs_joe and Joe's Approve, so each of those is asked for again.
    if (ended.rev !== null && rev <= ended.rev) { done.push([id, 'not requested again: the gate ended its merge and the card has not changed since']); continue; }
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
