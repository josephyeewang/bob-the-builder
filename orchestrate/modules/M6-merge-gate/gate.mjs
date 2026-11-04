// gate.mjs — one pass of the Merge Gate (R-0b-87 to R-0b-90, R-0b-93, R-0b-94, R-0b-96; 0b-9 review rounds 1–3).
//
// WHAT A PASS DOES, in order; each step that can't finish leaves the record as it was, for the next pass.
//   1. Start check. Robot merges are open only while the outside check was green in the last 2 hours and the Mini's
//      tokens are shown unable to write there (M12 robotMergesGreen). Otherwise nothing happens: "outside check not
//      green in 2 h".
//   2. Intake. The newest Dispatcher merge request for a card that has no open merge becomes a merge document
//      (requested → queued). A request the gate already took is never taken twice.
//   3. Audit results. A merged merge with a Sensors audit_run fact for its commit moves to audited_ok / audit_flagged.
//   4. One merge at a time. A merge left in checking or merging by a stopped pass is finished first (recover).
//   5. Held merges go back in the queue to be judged again; they keep their place (queue_since).
//   6. The next queued merge (queueOrder): behind main → catch up (PUT update-branch; a conflict returns it to the
//      builder); otherwise judge (refusals.mjs over gather.mjs). refuse → refused, with every reason; hold → held;
//      a change that can't be judged yet (GitHub unreadable, a check or review still running, main red) is held as
//      waiting and judged again on the next pass (L164); a wait past timeouts.merging_open_max_min is told to the
//      owner once, and one still waiting with GitHub readable after 3 times that is refused for good and told (L184);
//      a pass with GitHub unreadable never refuses;
//      merge → the paired write (merge → checking, card → merging), judged again under the lock, then merging, the
//      merge on GitHub (PUT /pulls/n/merge with the judged head, squash: never a ref write), merged, the card merged,
//      the robot's mark on the merge commit, and a check that the merge commit's first parent is the judged main.
//
//   await gatePass(ctx) → { ran, reason?, problems?, did: [{ merge, step, ... }] }
// ctx = gather.mjs's ctx, plus readFact? (id → doc; default the record's fact) and maxCatchUps? (default 3).
// The gate writes only as merge_gate. It never moves a card it didn't put in merging, except merged.
//
// TOLD UNTIL DELIVERED (L168, L170; the site G pattern of L135). A refusal the owner must hear of is written with
// tell_owner: true and its note; told_at is added only once the merge_refused alert was taken (an answer of false, or a
// throw, is not taken), and each pass sends again for every refused merge that has tell_owner and no told_at. A long
// wait is the same with wait_told_at, told again every 24 h while it lasts (L315), and an interrupted merge's notice
// with interrupted_told_at. ctx.alert must answer true when it has kept the alert (queued it, or stored a
// copy to send later): a sink that keeps a copy and answers false gets one more kept copy on every pass (L182 m3).

import { robotMergesGreen } from '../M12-sensors/outside-watch.mjs';
import { gatherFacts, botId } from './gather.mjs';
import { judge, WAITING_HOLD } from './refusals.mjs';
import { MARK_CONTEXT, markDescription, markable, NEEDS_JOE_CONTEXT, needsJoeDescription } from './mark.mjs';
import { isOpen } from '../../shared/record.mjs';
import { markReverted } from './undo.mjs';
import { factFrom } from '../M9-record/permissions.mjs';
import { settleMerge, openTooLong, prReading, prReadingAfter, MERGED_OUTSIDE, MERGED_OUTSIDE_UNTOLD, alertTaken } from './merge-outcome.mjs';
import { KEYS, minutes, MissingKey } from '../M11-dispatcher/keys.mjs';
import { stillWaiting, pastTime, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

export const ACTOR = 'merge_gate';
export const NOT_GREEN_LINE = 'outside check not green in 2 h';
export const FRESHNESS_FACT = 'blueprint_freshness_alarm';
const STEPPED_ASIDE = 'stepped_aside';
export const MAX_CATCH_UPS = 3;
const SHA = /^[0-9a-f]{40}$/;
// GitHub's own "no" to a merge call: not mergeable (405), the head moved (409), or a request it won't process (422).
// Only these refuse at once; anything else leaves the outcome unknown (L94).
export const MERGE_NO = Object.freeze([405, 409, 422]);
const DONE = ['merged', 'audited_ok', 'audit_flagged'];
const short = (s) => String(s ?? '').slice(0, 7);
// What a refusal's alert tells the owner happens next.
export const FINAL_NOTE = 'refused for a reason about the change itself; it won\'t be retried until the card changes';
// The cap on a wait (L184): refused for good after WAIT_CAP_TIMES × the wait limit. The wait limit is
// timeouts.merging_open_max_min; until the rules carry that key, waiting reads DEFAULT_WAIT_LIMIT_MIN (the open-merge
// timer in recover has no default: with no key it still waits for GitHub's final answer).
export const WAIT_CAP_TIMES = 3;
export const DEFAULT_WAIT_LIMIT_MIN = 30;
export const waitCapNote = (limitMs) => `waited ${Math.round((WAIT_CAP_TIMES * limitMs) / 60_000)} min or more to be judged and was never judged, with GitHub readable; refused for good so the owner can act on what it waited on. It won't be retried until the card changes`;
// A catch-up GitHub accepted (202) whose head never moves (L190 B1): capped as a wait is, timed from the request.
export const CATCH_UP_STUCK = 'GitHub accepted the branch update but the head never moved';
// The fields a wait keeps (L164, L184). Cleared when the merge leaves the wait for a catch-up or the merge call (L190 M1):
// a new wait after that gets its own clock and its own notice.
// `wait_reading` names the interrupted merge a queued one waits on a reading after (L315 S-M6b).
const WAIT_CLEARED = Object.freeze({ re_audit_at: null, waiting_on: null, waiting_since: null, wait_told_at: null, wait_told_since: null, stuck_since: null, wait_reading: null });
// A wait the owner was told of is told again this often while it lasts (L315: never told once ever while still waiting), by
// the shared stillWaiting rule.
export const WAIT_RETELL_MS = STILL_WAITING_MS;
export const GITHUB_UNREADABLE_NOTE = 'GitHub can\'t be read';

/**
 * One answer to "was GitHub unreadable this pass", for serve and for check under the lock (L190 M2).
 * outage: the pull request, main or the head's checks or statuses could not be read: hold this one and stop the queue.
 * unreadable: that, or another read that FAILED (gather's unreadReads: main's checks, the reviewed tree, the go check,
 * the Approve check, the undo's checks, the carry-over, the compare, the threads, the rules at main; L186, L187, L205),
 * or a compare with no answer. Failed is gather's failedRead: a 4xx other than 401/403/429 was answered. A pass with
 * GitHub unreadable neither starts the wait cap's clock nor refuses at the cap. A read that was answered but came back
 * incomplete (a count that doesn't match its list) is not unreadable, so it counts toward the cap (L190 M3, M4).
 */
export function passUnreadable(facts) {
  const failed = (k) => (facts?.unreadReads ?? []).includes(k);
  const outage = !!facts?.card && (!facts.pr || !SHA.test(facts.main?.sha ?? '') || failed('checks') || failed('statuses'));
  // A carry-over or compare read that failed is in unreadReads (L205); one GitHub answered with a 4xx other than 401,
  // 403 and 429 is not (#108 r2 Minor 1), so that wait counts toward the cap.
  const unreadable = !!facts?.card && (outage || (facts.unreadReads ?? []).length > 0 || facts.threads?.unreadable === true
    || (facts.compareStatus === null && facts.compareAnswered !== true));
  return { outage, unreadable };
}
// A merge whose check just before merging did not finish (L231): a refused write under the lock, or a stopped pass.
export const CHECK_CUT_NOTE = 'the gate\'s check just before merging did not finish (a write was refused, or the pass stopped); nothing was merged, and the card goes back and is asked for again';
export const GITHUB_NO_NOTE ='GitHub refused the merge; the card goes back and is asked for again, and the same refusal twice goes to the owner';

// The order the queue is served in: undo first, the lead's daily card when the blueprint's freshness alarm is on,
// then Tier 1, then Tier 2; ties go to whoever has waited longest (queue_since, kept through holds and catch-ups).
export function queueOrder(merges, { cardOf, freshnessAlarm = false } = {}) {
  const rank = (m) => {
    const c = cardOf(m.doc.card);
    if (c?.kind === 'exact_reverse') return 0;
    if (c?.kind === 'lead_daily_card' && freshnessAlarm) return 1;
    return (m.doc.tier ?? c?.tier) === 1 ? 2 : 3;
  };
  return [...merges].sort((a, b) => rank(a) - rank(b) || String(a.doc.queue_since).localeCompare(String(b.doc.queue_since)) || (a.id < b.id ? -1 : 1));
}

export async function gatePass(ctx) {
  const { record, product, gh, owner, repo, now } = ctx;
  const alert = ctx.alert ?? (() => {});
  const iso = () => new Date(now()).toISOString();
  const did = [];
  const base = `/repos/${owner}/${repo}`;
  const readFact = ctx.readFact ?? ((id) => record.read('fact', id)?.doc ?? null);

  // Rewrites a document it just read, so it passes that read's rev: an update, never a create (L118 c3).
  const write = (entity, cur, fields, extra = {}) => record.write({ ...extra, actor: ACTOR, entity, id: cur.id, expectRev: cur.rev, doc: { ...(cur.doc ?? {}), ...fields } });
  const fresh = (entity, id) => record.read(entity, id);
  const step = (m, name, more = {}) => { did.push({ merge: m.id, step: name, ...more }); };
  const move = (m, state, fields = {}) => {
    const r = write('merge', fresh('merge', m.id), { state, ...fields });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: state, reason: r.reason });
    else step(m, state, fields.reasons ? { reasons: fields.reasons } : {});
    return r.ok;
  };

  // An audit result is proof only from Sensors' own family, made by Sensors (L74 addendum): never a fact found by its
  // type alone, which any role may write into its own family.
  const auditRuns = () => record.list('fact').filter((x) => x.doc?.type === 'audit_run'
    && factFrom('sensors', { id: x.id, createdBy: record.meta?.('fact', x.id)?.createdBy ?? null }, 'audit-run-'));

  const merges = () => record.list('merge').filter((m) => m.doc && !m.corrupt);

  // 1b. A refusal whose alert was lost is told again (L168), gate open or shut (L358): the start gate stops merging,
  // not telling. These two only send an alert and write their own told mark: no GitHub call, no other state change.
  for (const m of merges().filter((x) => x.doc.state === 'refused' && x.doc.tell_owner === true && !x.doc.told_at)) tellRefused(m);
  for (const m of merges().filter((x) => x.doc.state === 'refused' && typeof x.doc.interrupted_note === 'string' && !x.doc.interrupted_told_at)) tellInterrupted(m);

  const start = robotMergesGreen({ read: readFact, product, now });
  if (!start.open) return { ran: false, reason: NOT_GREEN_LINE, problems: start.problems, did };

  // 2. Intake.
  const taken = new Set(merges().map((m) => m.doc.request));
  const byCard = new Map();
  for (const q of record.list('merge_request')) {
    if (!q.doc || q.corrupt || taken.has(q.id)) continue;
    const prev = byCard.get(q.doc.card);
    if (!prev || String(q.doc.requested_at) > String(prev.doc.requested_at)) byCard.set(q.doc.card, q);
  }
  for (const [cardId, q] of [...byCard].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (merges().some((m) => m.doc.card === cardId && isOpen('merge', m.doc.state))) continue;
    const id = `merge-${q.id}`;
    if (fresh('merge', id)) continue;
    const r = record.write({ actor: ACTOR, entity: 'merge', id, expectRev: 0, doc: { state: 'requested', card: cardId, pr: q.doc.pr, request: q.id, requested_at: q.doc.requested_at, catch_ups: [] } });
    if (!r.ok) { alert({ type: 'merge_gate_write_refused', merge: id, to: 'requested', reason: r.reason }); continue; }
    step({ id }, 'requested');
    // A change sent back keeps its place (r3-m5): the earliest of the request's queue_since and this card's earlier merges.
    const since = [q.doc.queue_since, q.doc.requested_at, ...merges().filter((m) => m.doc.card === cardId).map((m) => m.doc.queue_since)]
      .filter((x) => typeof x === 'string' && Number.isFinite(Date.parse(x))).sort()[0] ?? iso();
    move({ id }, 'queued', { queue_since: since });
  }

  // 3a. A merge whose card write or statuses a stopped pass left behind: finished now (R-0b-94), before the audit
  // result moves it on, and also after (a late mark means the audit needs running again; the alert says so).
  for (const m of merges().filter((x) => ['merged', 'audited_ok', 'audit_flagged'].includes(x.doc.state) && SHA.test(x.doc.merge_commit ?? ''))) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state === 'merging' || !m.doc.marked_at || m.doc.late_mark_alert === 'owed' || revertUnsettled(m, card)) await complete(m, m.doc.merge_commit);
    // A parent check whose alert was lost is done again (L168 M-4).
    const latest = fresh('merge', m.id);
    if (latest && !latest.doc.parent_checked_at) await parentCheck(latest, latest.doc.merge_commit);
  }

  // 3. Audit results (R-0b-93): only a Sensors audit_run fact for the merge commit moves a merged merge. An audit_run
  // another writer made is not one (L118 m9): M9 would refuse the move anyway, and taking it first would hide the real one.
  for (const m of merges().filter((x) => x.doc.state === 'merged' && SHA.test(x.doc.merge_commit ?? ''))) {
    const f = auditRuns().find((x) => x.doc.commit === m.doc.merge_commit && ['success', 'failure'].includes(x.doc.conclusion));
    if (!f) continue;
    const to = f.doc.conclusion === 'success' ? 'audited_ok' : 'audit_flagged';
    const r = record.write({ actor: ACTOR, entity: 'merge', id: m.id, expectRev: m.rev, doc: { ...m.doc, state: to, audited_at: iso() }, data: { fact: f.id } });
    if (r.ok) step(m, to); else alert({ type: 'merge_gate_write_refused', merge: m.id, to, reason: r.reason });
  }

  // 4. One at a time: finish a merge a stopped pass left behind.
  const busy = merges().find((m) => m.doc.state === 'checking' || m.doc.state === 'merging');
  if (busy) { await recover(busy); return { ran: true, did }; }

  // 5. Held merges are judged again, in their place.
  for (const m of merges().filter((x) => x.doc.state === 'held')) move(m, 'queued', { hold: null });

  // 6. The next queued merge.
  const cardOf = (id) => fresh('card', id)?.doc ?? null;
  const queue = queueOrder(merges().filter((m) => m.doc.state === 'queued' || m.doc.state === 'catching_up'), { cardOf, freshnessAlarm: readFact(FRESHNESS_FACT)?.on === true });
  for (const m of queue) {
    const out = await serve(m);
    if (out !== STEPPED_ASIDE) break;
  }
  return { ran: true, did };

  // Returns STEPPED_ASIDE when this merge left the front without taking the lock or starting a catch-up, so the next
  // in the queue is served in the same pass (R-0b-90: a Tier-1 change held for the hours steps aside).
  async function serve(m) {
    if (!markable(m.doc.card)) {
      const reasons = ['the card id is too long for the robot\'s mark (80 characters at most)'];
      if (move(m, 'refused', { reasons, tell_owner: true, tell_note: FINAL_NOTE })) tellRefused(fresh('merge', m.id));
      return STEPPED_ASIDE;
    }
    // This PR is already merged under another merge (an interrupted one, reconciled): nothing is left to merge.
    const landed = merges().find((x) => x.id !== m.id && x.doc.pr === m.doc.pr && DONE.includes(x.doc.state));
    if (landed) { move(m, 'refused', { reasons: [`pull request #${m.doc.pr} is already merged (${landed.id})`] }); return STEPPED_ASIDE; }
    // An interrupted merge of this PR may still land on GitHub (L102): no merge or catch-up call goes out for it again
    // until Sensors has read the PR after that refusal and seen it not merged. A reading that shows merged is the
    // Dispatcher's reconcile to record, never a second merge.
    // This wait has a clock and a told mark like any other (L315 S-M6b, closing L190 minor c): told after the wait limit,
    // then every WAIT_RETELL_MS while it lasts, and cleared when the reading lands. It is never refused at the cap: the
    // earlier merge may still land, and refusing this one then would be wrong. It stays queued.
    const cut = merges().find((x) => x.id !== m.id && x.doc.pr === m.doc.pr && x.doc.state === 'refused' && (x.doc.reasons ?? []).includes('interrupted')
      && ((r) => !r || r.merged === true)(prReadingAfter(record, x.doc.pr, x.id, now())));
    if (cut) {
      const why = `merge ${cut.id} of this pull request was interrupted; waiting for a reading of the pull request after it`;
      let cur = fresh('merge', m.id) ?? m;
      if (cur.doc.wait_reading !== cut.id) {
        // A merge catching up keeps its catch-up clock (stuck_since) through this wait (L356 MAT-2): the wait borrows
        // only the told clock, and gives it back when the reading lands.
        const keep = cur.doc.state === 'catching_up' ? { stuck_since: cur.doc.stuck_since } : {};
        const w = write('merge', cur, { ...WAIT_CLEARED, ...keep, waiting_on: [why], waiting_since: iso(), wait_reading: cut.id });
        if (!w.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'wait_reading', reason: w.reason });
        cur = fresh('merge', m.id) ?? cur;
      }
      step(m, 'waiting', { reasons: [why] });
      waitedLong(cur, waitLimit(cur, [why]));
      return STEPPED_ASIDE;
    }
    // The reading landed: that wait is over, and a later wait gets its own clock and notice. A merge that was catching
    // up goes back to its catch-up wait as it was (L356 MAT-2): its stuck_since was kept, and its wait is timed from it
    // again (catchUp starts both at the same moment). A clear that can't be written steps aside and is tried again next
    // pass, rather than going on from a record that still says it waits.
    if (m.doc.wait_reading) {
      const cu = fresh('merge', m.id) ?? m;
      const back = cu.doc.state === 'catching_up' ? { waiting_on: [CATCH_UP_STUCK], waiting_since: cu.doc.stuck_since ?? null, stuck_since: cu.doc.stuck_since ?? null } : {};
      const w = write('merge', cu, { ...WAIT_CLEARED, ...back });
      if (!w.ok) { alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'wait_reading_cleared', reason: w.reason }); return STEPPED_ASIDE; }
      m = fresh('merge', m.id) ?? m;
    }
    if (m.doc.state === 'catching_up') {
      await finishCatchUp(m);
      // Caught up: served now, before younger changes can put it behind main again.
      const now = fresh('merge', m.id);
      return now?.doc?.state === 'queued' ? serve(now) : STEPPED_ASIDE;
    }
    const facts = await gatherFacts(ctx, m);
    // GitHub unreadable: hold this one and stop, rather than hold the whole queue in one pass. A check or status list
    // too long to read is a fact (refusal 1, final), not GitHub down (L187 c1); one cut off is a wait that counts toward
    // the cap (L190 M3). A compare that fails while the pull request, main and the checks read is this change's, not
    // GitHub down: it holds this one and the queue goes on (L187), as a failed thread read does.
    const { outage, unreadable } = passUnreadable(facts);
    // Behind main: catch up first (R-0b-89), never judge a head that can't land as judged.
    if ((facts.compareStatus === 'behind' || facts.compareStatus === 'diverged') && facts.pr?.state === 'open' && SHA.test(facts.pr?.head?.sha ?? '')) {
      if ((m.doc.catch_ups ?? []).length >= (ctx.maxCatchUps ?? MAX_CATCH_UPS)) { move(m, 'returned_to_builder', { reasons: [`caught up ${MAX_CATCH_UPS} times and still behind main`] }); return STEPPED_ASIDE; }
      return catchUp(m, facts.pr.head.sha);
    }
    const v = judge(facts);
    if (v.decision === 'refuse') { refuse(m, facts, v); return outage ? undefined : STEPPED_ASIDE; }
    if (v.decision === 'hold') { hold(m, v, unreadable); return outage ? undefined : STEPPED_ASIDE; }
    return take(m, facts);
  }

  async function catchUp(m, head) {
    // Leaving a wait clears its clock (L190 M1); the catch-up's own wait starts now (B1), with nothing told yet.
    const at = iso();
    if (!move(m, 'catching_up', { catch_up_from: head, ...WAIT_CLEARED, waiting_on: [CATCH_UP_STUCK], waiting_since: at, stuck_since: at })) return;
    let r;
    try { r = await gh.put(`${base}/pulls/${m.doc.pr}/update-branch`, { expected_head_sha: head }); } catch (e) { r = { status: 0 }; }
    if (r?.status === 202) return step(m, 'catch_up_asked');
    // 422: a conflict, or the head moved under us. Either way the builder takes it back.
    move(fresh('merge', m.id), 'returned_to_builder', { reasons: [`catching up with main failed (${r?.status})`] });
    return STEPPED_ASIDE;
  }

  // L190 B1: a catch-up GitHub accepted but whose head never moves is a wait like any other (L184): told once past the
  // wait limit, refused for good at WAIT_CAP_TIMES times it, timed from the request. A pass where the pull request can't
  // be read is an outage pass: it neither refuses nor stops the clock.
  async function finishCatchUp(m) {
    let r;
    try { r = await gh.get(`${base}/pulls/${m.doc.pr}`); } catch { r = null; }
    const after = r?.status === 200 ? r.json?.head?.sha : undefined;
    // The pull request could not be read: an outage pass. It never refuses, but the wait is still told after the limit
    // and every 24 h (L356 MAT-3: 48 h of failed reads used to tell nothing).
    if (!SHA.test(after ?? '')) {
      const cur = fresh('merge', m.id) ?? m;
      waitedLong(cur, waitLimit(cur, [CATCH_UP_STUCK]), { outage: true });
      return;
    }
    if (after === m.doc.catch_up_from) return catchUpWaits(m);   // GitHub hasn't made the commit yet
    const catchUps = [...(m.doc.catch_ups ?? []), { pr: m.doc.pr, before_sha: m.doc.catch_up_from, after_sha: after }];
    move(m, 'queued', { catch_ups: catchUps, catch_up_from: null, ...WAIT_CLEARED });
  }

  function catchUpWaits(m) {
    const cur = fresh('merge', m.id) ?? m;
    const limit = waitLimit(cur, [CATCH_UP_STUCK]);
    // Through pastTime (L329, L321): a stuck_since that is absent, can't be read, or is in the future is old enough, so
    // the cap fires on this pass (L353: an absent one is never "start the clock"; that would hold the catch-up a whole
    // WAIT_CAP_TIMES × the limit more). Only where the cap can't be judged (no limit) is the clock restamped, so it can
    // be judged once the rules answer.
    const stuck = pastTime(cur.doc.stuck_since, now());
    if (limit === undefined) {
      if (stuck !== null) return;
      const at = iso();
      // (L356: absent-is-old is this clock's rule only. hold()'s stuck_since ?? iso() and the cut wait's waiting_since
      // still start fresh: there an empty time is the cleared or outage-only state, not lost data.)
      const w = write('merge', cur, { stuck_since: at });   // only the cap's clock: never waiting_since or the told mark (L330)
      if (!w.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'catch_up_clock', reason: w.reason });
      return;
    }
    if (stuck === null || now() - stuck >= WAIT_CAP_TIMES * limit) {
      if (move(cur, 'refused', { reasons: [CATCH_UP_STUCK], catch_up_from: null, tell_owner: true, tell_note: waitCapNote(limit) })) tellRefused(fresh('merge', m.id));
      return;
    }
    waitedLong(cur, limit);
  }

  function refuse(m, facts, v) {
    const reasons = v.refusals.map((x) => `${x.n}: ${x.reason}`);
    // The owner's Approve is missing: say so on the card, so M2 asks for it (refusal 8).
    const card = fresh('card', m.doc.card);
    if (v.refusals.some((x) => x.n === 8) && facts.approve?.needed && card && card.doc.needs_joe !== true) write('card', card, { needs_joe: true });
    if (move(m, 'refused', { reasons, tell_owner: true, tell_note: FINAL_NOTE })) tellRefused(fresh('merge', m.id));
  }

  // Told once delivered: told_at is the mark, and 3b sends again until it is down.
  function tellRefused(m) {
    if (!m?.doc || m.doc.state !== 'refused' || m.doc.told_at) return;
    const taken = alertTaken(alert, { type: 'merge_refused', merge: m.id, card: m.doc.card, reasons: m.doc.reasons ?? [], note: m.doc.tell_note ?? FINAL_NOTE });
    if (!taken) return;
    const r = write('merge', m, { told_at: iso() });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'told', reason: r.reason });
  }

  // A hold. A waiting one (L164) keeps the time it began waiting (waiting_since) and what it waits on, so the owner hears
  // of a wait past the wait limit, once (wait_told_at); any other hold starts that clock again.
  // The cap (L184): a wait the gate can't end by itself (a tree too big to read, main red, GitHub never working out
  // mergeable, a check that never runs, a review that never ends...) is refused for good after WAIT_CAP_TIMES × the wait
  // limit, told once, with what it waited on as the reasons. Its clock (stuck_since) starts at the first waiting pass
  // with GitHub readable: a pass with GitHub unreadable (passUnreadable: any read that FAILED, L186, L187, L190) neither
  // starts it, nor refuses, nor stops it, so an outage alone never refuses a change for good (L164), and an outage in the
  // middle of a long wait doesn't start it again. Only a read that succeeds and comes back incomplete counts toward the cap.
  // `unreadable` has no default: every caller says (L190 M2, a caller missed when this function's inputs changed).
  // Answers whether the merge moved (held, or refused at the cap): check() must not leave one in checking (L231).
  function hold(m, v, unreadable) {
    if (typeof unreadable !== 'boolean') throw new Error('hold() needs to be told whether GitHub was readable this pass (L190 M2)');
    const outage = unreadable;
    const cur = fresh('merge', m.id) ?? m;
    const waiting = v.hold === WAITING_HOLD;
    const waitingOn = v.refusals.map((x) => `${x.n}: ${x.reason}`);
    const fields = waiting
      ? { hold: v.hold, re_audit_at: v.refusals.find((x) => x.reAudit)?.reAudit ?? null, waiting_on: waitingOn, waiting_since: cur.doc.waiting_since ?? iso(), wait_told_at: cur.doc.wait_told_at ?? null, wait_told_since: cur.doc.wait_told_since ?? null, stuck_since: cur.doc.stuck_since ?? (outage ? null : iso()) }
      : { hold: v.hold, re_audit_at: null, waiting_on: null, waiting_since: null, wait_told_at: null, wait_told_since: null, stuck_since: null };
    // The limit is asked once per hold (L188 follow-up): rules that can't answer are told once a pass, not twice.
    const limit = waiting ? waitLimit(cur, waitingOn) : undefined;
    if (waiting && !outage) {
      // Through pastTime (L329): a stuck_since that can't be read, or is in the future, is old enough, so the cap fires
      // on this pass; restarting the clock would hold the merge another WAIT_CAP_TIMES × the limit without a word. Only
      // where the cap can't be judged (no limit) is a bad clock restamped, so it can be judged once the rules answer.
      const stuck = pastTime(fields.stuck_since, now());
      if (limit === undefined && stuck === null) fields.stuck_since = iso();
      if (limit !== undefined && (stuck === null || now() - stuck >= WAIT_CAP_TIMES * limit)) {
        const reasons = waitingOn;
        if (!move(cur, 'refused', { ...fields, hold: null, reasons, tell_owner: true, tell_note: waitCapNote(limit) })) return false;
        tellRefused(fresh('merge', m.id));
        return true;
      }
    }
    if (!move(cur, 'held', fields)) return false;
    if (waiting) waitedLong(fresh('merge', m.id), limit, { outage });
    return true;
  }

  // Told after the wait limit, then again every WAIT_RETELL_MS while it still waits, outage passes included (L315
  // S-M6a: an outage never starts the cap, so without this the owner heard of it once, ever). Cleared with WAIT_CLEARED.
  // Through the shared stillWaiting (L315): told once the wait is `limit` old (a start time that can't be read, or in the
  // future, is told now), then every WAIT_RETELL_MS. Its clear does nothing here: the wait's end writes WAIT_CLEARED.
  function waitedLong(m, limit, { outage = false } = {}) {
    if (!m?.doc || limit === undefined) return;
    const t = now();
    // since names this wait (L356 m5): a mark left by another wait (another waiting_since) never quiets this one.
    const since = typeof m.doc.waiting_since === 'string' ? m.doc.waiting_since : '';
    stillWaiting({ now: t, waiting: true, since, after: { since, limit },
      read: () => ({ told_at: m.doc.wait_told_at ?? null, ...(typeof m.doc.wait_told_since === 'string' ? { since: m.doc.wait_told_since } : {}) }),
      clear: () => {}, tell: (mark) => tellWaitedLong(m, limit, outage, t, mark) });
  }

  function tellWaitedLong(m, limit, outage, t, mark) {
    const since = pastTime(m.doc.waiting_since, t);
    const again = pastTime(m.doc.wait_told_at, t) !== null;
    const how = again && since !== null ? `for ${Math.floor((t - since) / 3_600_000)} h` : `for ${Math.round(limit / 60_000)} min or more`;
    const taken = alertTaken(alert, { type: 'merge_waiting_long', merge: m.id, card: m.doc.card, pr: m.doc.pr, waiting_since: m.doc.waiting_since ?? null, waiting_on: m.doc.waiting_on ?? [], outage,
      note: `merge ${m.id} has waited to be judged ${how}${outage ? `, and ${GITHUB_UNREADABLE_NOTE} right now` : ''}: ${(m.doc.waiting_on ?? []).join('; ')}. It is judged again on every pass, and you are told again every 24 h while it waits` });
    // The mark is written only once the alert was taken (stillWaiting's tell rule).
    if (!taken) return false;
    const r = write('merge', m, { wait_told_at: mark.told_at, wait_told_since: mark.since ?? null });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'wait_told', reason: r.reason });
    return true;
  }

  // The wait limit in ms: timeouts.merging_open_max_min, or DEFAULT_WAIT_LIMIT_MIN while the rules lack it (L184; the
  // owner is told once per merge that the default is in use); undefined when the rules could not answer.
  function waitLimit(m, waitingOn) {
    const limit = mergingLimit(m);
    if (limit === undefined || Number.isFinite(limit)) return limit;
    tellLimitMissing(m, 'waiting', `merge ${m.id} is waiting to be judged (${waitingOn.join('; ')}), and the rules have no ${KEYS.mergingOpenMaxMin}, so the gate uses its own default of ${DEFAULT_WAIT_LIMIT_MIN} min: a wait is told after ${DEFAULT_WAIT_LIMIT_MIN} min and refused after ${WAIT_CAP_TIMES * DEFAULT_WAIT_LIMIT_MIN} min, and an open merge after the merge call is never recorded as interrupted. Add the limit to the rules file`);
    return DEFAULT_WAIT_LIMIT_MIN * 60_000;
  }

  // timeouts.merging_open_max_min in ms; NaN when the rules lack it (MissingKey); undefined when the rules could not
  // answer at all, told as merge_gate_unsure, so a broken rules engine is never reported as a missing key (L164 m2).
  function mergingLimit(m) {
    // A per-product key: the real engine answers it only for a named product (L110 M-1).
    try { return minutes(ctx.rules, KEYS.mergingOpenMaxMin, { product: ctx.product }); } catch (e) {
      if (e instanceof MissingKey) return NaN;
      alert({ type: 'merge_gate_unsure', merge: m.id, note: `the rules could not answer ${KEYS.mergingOpenMaxMin}: ${String(e?.message ?? e).slice(0, 200)}; trying again next pass` });
      return undefined;
    }
  }

  async function take(m, facts) {
    const head = facts.pr.head.sha;
    const card = fresh('card', m.doc.card);
    const mm = fresh('merge', m.id);
    // The wait clock (waiting_since, stuck_since) comes along into checking (L231): a wait seen again under the lock
    // is the same wait, so it goes on from when it began and can reach the cap at once. That is meant.
    const pair = record.write({ actor: ACTOR, entity: 'merge', id: mm.id, expectRev: mm.rev, doc: { ...mm.doc, state: 'checking', judged_head: head, judged_main: facts.main.sha, tier: facts.tier, needs_joe: facts.approve?.needed !== false || card.doc.needs_joe === true },
      also: [{ entity: 'card', id: card.id, expectRev: card.rev, doc: { ...card.doc, state: 'merging' } }] });
    if (!pair.ok) { alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'checking', reason: pair.reason }); return; }
    step(m, 'checking');
    return check(fresh('merge', m.id));
  }

  // Under the lock, everything is read and judged again: the merge happens only on what was judged a moment ago.
  async function check(m) {
    const facts = await gatherFacts(ctx, m);
    const v = judge(facts);
    const head = facts.pr?.head?.sha;
    if (v.decision !== 'merge' || head !== m.doc.judged_head) {
      const reasons = v.decision === 'merge' ? ['the head moved while the merge was being checked'] : v.refusals.map((x) => `${x.n}: ${x.reason}`);
      const left = v.decision === 'hold' ? hold(m, v, passUnreadable(facts).unreadable) : move(m, 'refused', { reasons });
      if (!left) cutShort(m, reasons);
      return putBack(m, 'verified');
    }
    if (!move(m, 'merging', { judged_main: facts.main.sha, ...WAIT_CLEARED })) return;
    return land(fresh('merge', m.id));
  }

  // L231: under the lock, the move out of checking was refused. Left in checking, the next pass's recover() would refuse
  // it with no word of why, and the write-refused alert alone can be lost, so Joe would never hear of the wait or the
  // cap. It ends now, refused with what the check found, told until delivered (3b). The card goes back and is asked
  // for again, so a wait ended this way is judged again, never refused for good. If this write is refused too,
  // recover() refuses and tells the same way next pass.
  function cutShort(m, reasons) {
    const cur = fresh('merge', m.id);
    if (cur?.doc?.state !== 'checking') return;
    if (move(cur, 'refused', { ...WAIT_CLEARED, hold: null, reasons, tell_owner: true, tell_note: CHECK_CUT_NOTE })) tellRefused(fresh('merge', m.id));
  }

  async function land(m) {
    let r;
    try { r = await gh.put(`${base}/pulls/${m.doc.pr}/merge`, { sha: m.doc.judged_head, merge_method: 'squash' }); } catch (e) { r = { status: 0, json: { message: String(e?.message ?? e).slice(0, 200) } }; }
    const sha = r?.json?.sha;
    if (r?.status === 200 && r.json?.merged === true && SHA.test(sha ?? '')) return finish(m, sha);
    if (MERGE_NO.includes(r?.status)) {
      const why = `GitHub refused the merge (${r.status}${r.json?.message ? `: ${String(r.json.message).slice(0, 200)}` : ''})`;
      const out = settleMerge({ record, alert, now }, m.id, { reason: why, fields: { tell_owner: true, tell_note: GITHUB_NO_NOTE } });
      if (out.ok) { step(m, 'refused', { reasons: [why] }); tellRefused(fresh('merge', m.id)); }
      return;
    }
    // No answer, a 5xx, or a 200 that doesn't say merged: GitHub may still be finishing the merge (L94). The merge stays
    // merging; each pass's recover() reads the pull request and settles it once the outcome is known.
    alert({ type: 'merge_gate_unsure', merge: m.id, note: `GitHub gave no clear answer to the merge (${r?.status || 'no answer'}); it stays merging until GitHub shows what happened` });
    step(m, 'outcome_unknown', { status: r?.status ?? 0 });
  }

  async function finish(m, sha) {
    if (!move(m, 'merged', { merge_commit: sha, merged_at: iso() })) return;
    await complete(fresh('merge', m.id), sha);
    await parentCheck(m, sha);
  }

  // The merge must sit right on the main that was judged; if main moved in between, say so (the merge stands).
  // parent_checked_at on the merge records that the parent matched or the owner was told; an alert that answers false
  // or throws leaves it unmarked, and the next pass checks again until it is delivered (L168 M-4, the site G pattern).
  async function parentCheck(m, sha) {
    let done;
    try {
      const k = await ctx.view.commit(sha);
      done = k?.parents?.[0] === m.doc.judged_main
        || alertTaken(alert, { type: 'merge_parent_moved', merge: m.id, commit: sha, judged_main: m.doc.judged_main, parent: k?.parents?.[0] ?? null, ask_owner: 'Undo?' });
    } catch { done = alertTaken(alert, { type: 'merge_parent_moved', merge: m.id, commit: sha, judged_main: m.doc.judged_main, parent: null }); }
    if (!done) return;
    const cur = fresh('merge', m.id);
    if (!cur || cur.doc?.parent_checked_at) return;
    const r = write('merge', cur, { parent_checked_at: iso() });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'parent_checked', reason: r.reason });
  }

  // An undo card that merged marks the card it undid reverted. That is tried again on later passes until it holds or the
  // owner was told why it can't (the "undo_not_marked" alert delivered); revert_settled_at on the merge records either.
  // Without it, a lost alert after the card went merged would never be asked again (L135 site G).
  function revertUnsettled(m, card) { return card?.doc?.kind === 'exact_reverse' && card.doc.state === 'merged' && !m.doc.revert_settled_at; }
  function settleRevert(m, cardId) {
    const u = markReverted({ record, alert }, cardId);
    if (u.ok) step(m, 'reverted', { card: u.card });
    if (u.ok || u.told) {
      const r = write('merge', fresh('merge', m.id), { revert_settled_at: iso() });
      if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'revert_settled', reason: r.reason });
    }
  }

  // After a merge is recorded: the card goes merged (and an undo marks what it undid), and the two statuses go on the
  // merge commit: the robot's mark (R-0b-94) and the needs-joe answer the GitHub-side checker reads. Each part is redone
  // on later passes until it holds (posting a status twice is harmless); marked_at records that both were posted.
  async function complete(m, sha) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state === 'merging') {
      const c = write('card', card, { state: 'merged', merge_commit: sha });
      if (!c.ok) alert({ type: 'merge_gate_write_refused', card: card.id, to: 'merged', reason: c.reason });
      else if (card.doc.kind === 'exact_reverse') settleRevert(m, card.id);
    } else if (revertUnsettled(m, card)) settleRevert(m, card.id);
    if (m.doc.marked_at) { tellLateMark(fresh('merge', m.id), sha); return; }
    let posts;
    try {
      posts = [
        { context: MARK_CONTEXT, description: markDescription({ card: m.doc.card, head: m.doc.judged_head }) },
        { context: NEEDS_JOE_CONTEXT, description: needsJoeDescription({ needsJoe: m.doc.needs_joe !== false, tier: m.doc.tier === 2 ? 2 : 1 }) },
      ];
    } catch (e) { alert({ type: 'merge_mark_failed', merge: m.id, commit: sha, reason: e.message }); return; }
    for (const p of posts) {
      let s;
      try { s = await gh.post(`${base}/statuses/${sha}`, { state: 'success', ...p }); } catch { s = { status: 0 }; }
      if (s?.status !== 201) { alert({ type: 'merge_mark_failed', merge: m.id, commit: sha, context: p.context, status: s?.status }); return; }
    }
    // An audit that already ran on this commit read it with no mark: it needs running again. The alert is owed in the
    // same write as the mark, and cleared only once the alert is taken (L130 m17), so a lost alert is sent next pass.
    const late = m.doc.state !== 'merged' || auditRuns().some((x) => x.doc.commit === sha);
    const r = write('merge', fresh('merge', m.id), { marked_at: iso(), ...(late ? { late_mark_alert: 'owed' } : {}) });
    if (r.ok) {
      step(m, 'marked');
      tellLateMark(fresh('merge', m.id), sha);
    } else alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'marked', reason: r.reason });
  }

  // Sends an owed late-mark alert; only an alert that was taken (not false, no throw) clears the debt.
  function tellLateMark(m, sha) {
    if (m?.doc?.late_mark_alert !== 'owed') return;
    let taken;
    try { taken = alert({ type: 'merge_marked_after_audit', merge: m.id, commit: sha, ask_owner: 'Re-run the audit on this commit?' }) !== false; } catch { taken = false; }
    if (taken) {
      const r = write('merge', m, { late_mark_alert: 'told' });
      if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'late mark told', reason: r.reason });
    }
  }

  // A merge in checking or merging, found at the start of a pass: a stopped pass, or a merge call with no clear answer.
  // checking: no merge call has gone out (land runs only after the move to merging), so it merged only if someone else
  // merged it; otherwise it is refused at once. merging: decided by M6's settleMerge, the same function the Dispatcher
  // uses (L94), on GitHub's answer read now: merged at the judged head → merged (then the marks and the parent check);
  // merged at another head → refused, told; closed, or still open past timeouts.merging_open_max_min after the merge's
  // last write → refused 'interrupted', told once, and reconciled if GitHub later shows it merged; open under the
  // limit → left merging for the next pass.
  async function recover(m) {
    let pr = null;
    try { const r = await gh.get(`${base}/pulls/${m.doc.pr}`); if (r?.status === 200) pr = r.json; } catch { pr = null; }
    if (!pr) { alert({ type: 'merge_gate_unsure', merge: m.id, note: 'GitHub could not say whether the pull request merged; trying again next pass' }); return; }
    if (m.doc.state === 'checking') {
      if (pr.merged === true && SHA.test(pr.merge_commit_sha ?? '') && pr.head?.sha === m.doc.judged_head) {
        if (!move(m, 'merging')) return;
        return finish(fresh('merge', m.id), pr.merge_commit_sha);
      }
      if (pr.merged === true) {
        // MERGED_OUTSIDE says the owner was told, so it is written only when the alert was taken (L130 M6).
        const said = alertTaken(alert, { type: 'merge_gate_unsure', merge: m.id, note: `pull request #${pr.number} merged at ${short(pr.head?.sha)}, not the judged ${short(m.doc.judged_head)}` });
        move(m, 'refused', { reasons: [said ? MERGED_OUTSIDE : MERGED_OUTSIDE_UNTOLD] });
        putBack(m, 'verified');
        return;
      }
      // Told until delivered (L231): this is where a check cut short by a refused write, or a stopped pass, ends.
      if (move(m, 'refused', { reasons: ['GitHub did not merge the judged head'], tell_owner: true, tell_note: CHECK_CUT_NOTE })) tellRefused(fresh('merge', m.id));
      putBack(m, 'verified');
      return;
    }
    const reading = prReading(pr);
    const final = reading.merged || reading.state === 'closed';
    // A pull request GitHub shows merged or closed is settled whatever the rules say: the limit is asked only while it is
    // open, so rules that can't answer never keep a final merge, and the gate behind it, waiting (L188 m6).
    const limit = final ? null : mergingLimit(m);
    if (limit === undefined) return;
    const tooLong = !final && openTooLong(record, m.id, now, limit);
    if (!final && !tooLong) {
      if (!Number.isFinite(limit)) tellLimitMissing(m, 'open');
      step(m, 'outcome_unknown', { reasons: [Number.isFinite(limit) ? 'the pull request is still open' : `the pull request is still open, and the rules have no ${KEYS.mergingOpenMaxMin}`] });
      return;
    }
    // The note is written with the refusal itself (L356 m1), so a refused or lost second write can't leave an
    // interrupted merge with nothing for 3b to send.
    const note = tooLong ? { interrupted_note: `pull request #${m.doc.pr} is still open ${Math.round(limit / 60_000)} min after the merge call, with no merge; recorded as interrupted, the card goes back to be merged again, and a later merge of this pull request is recorded when Sensors sees it`, interrupted_told_at: null } : {};
    const out = settleMerge({ record, alert, now }, m.id, { pr: reading, reason: 'interrupted', openTooLong: tooLong, fields: note });
    if (!out.ok) { alert({ type: 'merge_gate_unsure', merge: m.id, note: `the merge could not be settled: ${out.reason}` }); return; }
    if (out.outcome === 'merged') {
      step(m, 'merged');
      const mm = fresh('merge', m.id);
      await complete(mm, reading.merge_commit_sha);
      await parentCheck(mm, reading.merge_commit_sha);
      return;
    }
    step(m, 'refused', { reasons: fresh('merge', m.id)?.doc?.reasons ?? [] });
    if (!tooLong) return;
    // Told until delivered (L315 S-M6b): the note is on the merge, and 3b sends it again until it is taken.
    tellInterrupted(fresh('merge', m.id));
  }

  function tellInterrupted(m) {
    if (!m?.doc || m.doc.state !== 'refused' || typeof m.doc.interrupted_note !== 'string' || m.doc.interrupted_told_at) return;
    if (!alertTaken(alert, { type: 'merge_interrupted', merge: m.id, card: m.doc.card, pr: m.doc.pr, note: m.doc.interrupted_note })) return;
    const r = write('merge', m, { interrupted_told_at: iso() });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'interrupted_told', reason: r.reason });
  }

  // With no timeouts.merging_open_max_min, an open merge is never refused as interrupted: it waits for GitHub's final
  // answer, and a waiting hold is timed by DEFAULT_WAIT_LIMIT_MIN (L184), so the owner is told once per merge that the
  // rules lack the limit (L148 item 5). The told fact is written
  // only once the alert was taken (as MERGED_OUTSIDE, L130 M6); a refused alert, or a refused fact write, tells again
  // next pass. Each of the two notes is told once per merge (L188): `told` lists which ('waiting' while it waits to be
  // judged, 'open' when its pull request is open after the merge call), so being told one doesn't skip the other. A
  // fact with no `told` is from before the waiting note, so it stands for 'open'.
  function tellLimitMissing(m, when, note = `pull request #${m.doc.pr} is still open after the merge call, and the rules have no ${KEYS.mergingOpenMaxMin}, so it is never recorded as interrupted; it waits for GitHub's final answer. Add the limit to the rules file`) {
    const id = MERGE_LIMIT_TOLD_FACT(m.id);
    const f = record.read('fact', id);
    const ours = f?.doc && !f.corrupt && factFrom(ACTOR, { id, createdBy: record.meta?.('fact', id)?.createdBy ?? null }, MERGE_LIMIT_TOLD_FAMILY);
    const told = ours ? (Array.isArray(f.doc.told) ? f.doc.told : ['open']) : [];
    // The waiting note is told once: that wait is refused at the cap, so it ends. The open note has no end while the rules
    // lack the limit (it waits for GitHub's final answer), so it is told again every WAIT_RETELL_MS while still open
    // (L315 minor). `told_by` keeps each note's last time; a fact without it dates the open note by told_at.
    const toldBy = ours && f.doc.told_by && typeof f.doc.told_by === 'object' ? f.doc.told_by : {};
    const again = told.includes(when);
    if (again && when !== 'open') return;
    const send = (at) => {
      const said = alertTaken(alert, { type: 'merge_limit_missing', merge: m.id, card: m.doc.card, pr: m.doc.pr, again, note: again ? `still: ${note}. You are told again every 24 h while it stays open` : note });
      if (!said) return false;
      const r = record.write({ actor: ACTOR, entity: 'fact', id, expectRev: f?.rev ?? 0, doc: { type: 'merge_limit_told', merge: m.id, key: KEYS.mergingOpenMaxMin, told: again ? told : [...told, when], told_at: at, told_by: { ...toldBy, [when]: at } } });
      if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: m.id, to: 'told', reason: r.reason });
      return true;
    };
    if (when !== 'open') { send(iso()); return; }
    // The open note through the shared stillWaiting: its mark is this note's last time (a fact without told_by dates it
    // by told_at). Its clear does nothing: the note stops when the merge settles, which ends the calls.
    stillWaiting({ now: now(), waiting: true, read: () => (again ? { told_at: toldBy.open ?? f.doc.told_at ?? null } : null), clear: () => {}, tell: ({ told_at }) => send(told_at) });
  }

  function putBack(m, to) {
    const card = fresh('card', m.doc.card);
    if (card?.doc?.state !== 'merging') return;
    const r = write('card', card, { state: to });
    if (!r.ok) alert({ type: 'merge_gate_write_refused', card: card.id, to, reason: r.reason });
  }
}

export { botId };

// The fact that says the owner was told a merge waits with no merging limit in the rules (L148 item 5).
export const MERGE_LIMIT_TOLD_FAMILY = 'merge-limit-told-';
export const MERGE_LIMIT_TOLD_FACT = (mergeId) => `${MERGE_LIMIT_TOLD_FAMILY}${mergeId}`;
