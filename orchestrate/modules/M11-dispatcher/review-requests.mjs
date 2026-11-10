// The Dispatcher's side of the review runner (lead call L65). The Dispatcher never starts a reviewer or an auditor:
// it runs as the workers' Mac user, and anything it could start a worker could start too. It only asks, by writing a
// request { card, head, role, request_id } into the runner's requests/ folder, and the runner (M4
// review-runner.mjs, running as `review`) checks the request against the Record and git before starting anything.
// What runs, and the runner's alerts for Joe, come back in the runner's status file; a status that is missing or
// older than 3 minutes is an error, never "no reviewer" (L63).
//
//   reviewPorts({ requests, status, reviewUid, now, newId, mainHead, installRoot, main, runnerLog })
//                                                             → { requestReview, hasReviewer, planReviewsRunning,
//                                                                 reviewAlerts, startPlanReview, planReviewAnswer }
//   writePlanReviewRequest({ dir, card, fingerprint, key })   → asks for a plan reviewer (L703); its session is the request id
//   mainSeenHead({ installRoot, main, owner, top })           → the mainHead port, from root's record of main (L75 m-2)
//   statusAlerts(status, mainHead, now, { runnerLog })        → the Dispatcher's own alerts from the status (L66)
//   relayReviewAlerts({ rec, alerts, alert, now, report })    → tells each runner alert once, and each hold while it lasts
//   keepReviewHolds(rec, report)                              → a pass whose status could not be read clears nothing
//
// Besides the runner's own alerts, the Dispatcher tells Joe two things it reads in the status (L66), each a hold, told at
// once and then each day it lasts (L315):
//   - a pass that failed (`ok: false`), named by its first error's class (pass.mjs causeOf, L437);
//   - an installed copy whose commit stamp is not main's (or has no stamp), named by the installed commit: reviews then
//     run old code until the copy is updated. `mainHead(installed)` is the wiring's port: `{ commit, since }`, main's commit
//     (40 hex) and, in ms, since when the copy has been behind it. `since` comes from root's own record, which the updater
//     writes after each fetch (M4 install-check.mjs: `behindSince(readMainSeen(mainSeenFile(installRoot)), commit, installed)`):
//     when the updater first saw main ahead of the copy, by its own clock, or its last fetch when it has not yet seen
//     this head. Never a commit's date, which the commit's author sets (L73 point 7(b)). The updater copies main every
//     10 minutes (M4 review-updater.mjs), so a copy behind main is told only once it has stayed behind for
//     STAMP_GRACE_MS (item 20(c)); no stamp, or no `since` (or one dated ahead), is told at once. A plain commit string
//     counts as no `since`. Without the port there is no stamp check. A port that fails or names no commit keeps the
//     stamp hold as it is (`keep`, L437): main can't be read, so nothing is cleared, and that is told on first sight and
//     each day (L465), with the port's error in the words only, so it makes no new trouble. `mainSeenHead` builds the port
//     from that record (L75 m-2), and reviewPorts builds it when given `installRoot` and `main` (main's commit, a port).
//
// Writing a file is all this does: no process is started here (only-send-safe.test.mjs).

import { closeSync, constants, fstatSync, linkSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readReviewStatus, planAnswerFor, PLAN_REQUEST_ID, REQUEST_ID, CARD_ID } from '../M4-workshop/launcher/review-runner.mjs';
import { behindSince, mainSeenFile, readMainSeen } from '../M4-workshop/launcher/install-check.mjs';
import { RUNNER_LOG } from '../M4-workshop/launcher/review-daemons.mjs';
import { PLAN_REVIEW_ROLE, REVIEW_ROLES } from '../../shared/review-roles.mjs';
import { tellThen, clearCause, writeFrom, queuedMarks } from './alerts.mjs';
import { causeOf } from './pass.mjs';
import { stillWaiting, pastTime, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * One request file, given its name only once it is whole (the runner wakes on the folder and must never read half of
 * one), and never written over. → { ok, requestId } | { ok: false, reason }
 */
export function writeReviewRequest({ dir, card, head, role, newId = randomUUID }) {
  if (typeof card !== 'string' || !CARD_ID.test(card)) return { ok: false, reason: 'not a card id' };
  if (typeof head !== 'string' || !HEX40.test(head)) return { ok: false, reason: 'the card names no head (40 hex)' };
  if (!REVIEW_ROLES.includes(role)) return { ok: false, reason: `"${role}" is not a review role` };
  const id = newId();
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return { ok: false, reason: 'the request id is not letters, digits and dashes' };
  const w = writeRequestFile(dir, id, { card, head, role, request_id: id });
  return w.ok ? { ok: true, requestId: id } : w;
}

// One request file: written whole under a hidden name, then given its own name, never over another. `same`: a file
// already under that name may be this very request (a plan's id is its key's hash), and counts as written only when it
// is (L735 m1-r2): a plain file of the Dispatcher's own, holding these very bytes. Anyone may write the requests folder
// and work the name out, so any other file there is said, never taken as asked. → { ok, exists? } | { ok: false, reason }
function writeRequestFile(dir, id, body, { same = false, uid = process.getuid() } = {}) {
  const tmp = join(dir, `.${id}.tmp`);
  const final = join(dir, `${id}.json`);
  const text = JSON.stringify(body);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); writeSync(fd, text); } finally { closeSync(fd); }
    try { linkSync(tmp, final); } catch (e) {
      if (!same || e?.code !== 'EEXIST') throw e;
      const why = ownRequest(final, text, uid);
      return why ? { ok: false, reason: `another file stands under this plan's request name, so the request was not written (${why}); the runner can't be asked until it is gone` } : { ok: true, exists: true };
    }
  } catch (e) {
    return { ok: false, reason: `the request could not be written (${e?.code ?? e?.message ?? e})` };
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  return { ok: true };
}

// Why the file under a request's name is not this very request, or null when it is: read by descriptor, never a link.
function ownRequest(file, text, uid) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return `it can't be opened (${e?.code ?? e?.message})`; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'it is not a plain file';
    if (st.uid !== uid) return `it is uid ${st.uid}'s, not the Dispatcher's`;
    const want = Buffer.from(text);
    if (st.size !== want.length) return 'it holds another request';
    const got = Buffer.alloc(want.length);
    let n = 0;
    while (n < got.length) { const r = readSync(fd, got, n, got.length - n, n); if (r === 0) break; n += r; }
    return n === want.length && got.equals(want) ? null : 'it holds another request';
  } catch (e) { return `it can't be read (${e?.code ?? e?.message})`; } finally { closeSync(fd); }
}

/**
 * Asks the runner for a plan reviewer (L703): a request { card, fingerprint, request_id, role: plan_reviewer }. The
 * request id is the sha256 of plan-go's `key` (card and fingerprint), so asking again for the same plan names the same
 * request: one still waiting is left as it is, and one the runner already took is refused there as seen, never started
 * twice. The session plan-go keeps is that request id; the runner's launch records carry it, and planReviewAnswer reads
 * by it. The runner checks the request against the Record (a Tier-1 draft whose plan has this fingerprint) and starts
 * the reviewer itself, retrying its own failed starts. → { ok: true, session } | { ok: false, reason }
 */
export function writePlanReviewRequest({ dir, card, fingerprint, key, uid = process.getuid() }) {
  if (typeof card !== 'string' || !CARD_ID.test(card)) return { ok: false, reason: 'not a card id' };
  if (typeof fingerprint !== 'string' || !HEX64.test(fingerprint)) return { ok: false, reason: 'the plan names no fingerprint (64 hex)' };
  if (typeof key !== 'string' || !key) return { ok: false, reason: 'the start names no key' };
  // The one id the runner takes for this plan (L726 m1): the key plan-go gives must be the card and plan it names.
  const id = PLAN_REQUEST_ID(card, fingerprint);
  if (key !== `${card}-${fingerprint}`) return { ok: false, reason: 'the start\'s key is not its card and plan' };
  const w = writeRequestFile(dir, id, { card, fingerprint, request_id: id, role: PLAN_REVIEW_ROLE }, { same: true, uid });
  return w.ok ? { ok: true, session: id } : w;
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

/**
 * The Dispatcher's own holds from a status (readReviewStatus's answer), in the shape the relay takes: listed on every
 * pass they last, so each is told again each day and cleared when it ends (L315). `since` names this trouble: another
 * class of error, or another installed commit, is told at once. A failure's class is its first error's (L437), as
 * pass.mjs causeOf reads it: `A` and `A; B` are one trouble, and numbers in the text don't make a new one.
 */
export const STAMP_GRACE_MS = 30 * 60_000;
export const MAIN_UNREAD = 'Main can\'t be read, so whether its installed copy is behind can\'t be checked.';
const MAIN_UNREAD_SINCE = 'main-unreadable';
// One trouble, whatever varies from pass to pass (L458): the first error, without the detail in brackets or an id.
const failureClass = (why) => causeOf(why
  .replace(/\((?:[^()]|\([^()]*\))*(?:\)|$)/g, '').split('; ')[0]
  .replace(/\bsession \S+/g, 'session').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'id').trim());
const AHEAD_MS = 5 * 60_000;

export function statusAlerts(s, mainHead, now = Date.now(), { runnerLog } = {}) {
  const out = [];
  if (s?.ok === false) {
    const why = typeof s.error === 'string' && s.error ? s.error.slice(0, 300) : 'no reason given';
    out.push({ id: 'runner-failed', hold: true, since: failureClass(why), text: `Its last pass failed: ${why}.` });
  }
  let head = null;
  let readError = '';
  let leads = false;
  // An error marked `lead` names the real trouble (root's updater may have stopped), so it comes first (audit #263 c1).
  try { head = mainHead ? mainHead(s?.installed_commit ?? null) : null; } catch (e) { head = null; leads = e?.lead === true; readError = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 100); }
  const main = typeof head === 'string' ? head : head?.commit;
  if (mainHead && !(typeof main === 'string' && HEX40.test(main))) return [...out, { id: 'stamp', hold: true, keep: true, since: MAIN_UNREAD_SINCE, text: !readError ? MAIN_UNREAD : leads ? `${readError} ${MAIN_UNREAD}` : `${MAIN_UNREAD} The read said: ${readError}` }];
  if (main && s?.installed_commit !== main) {
    const at = s?.installed_commit ?? null;
    const since = Number.isFinite(head?.since) && head.since <= now + AHEAD_MS ? head.since : null;
    // Behind main for less than the grace: the updater has not had its turn yet.
    if (at && since !== null && now - since < STAMP_GRACE_MS) return out;
    out.push({ id: 'stamp', hold: true, since: at ?? 'none', text: at
      ? `Its installed copy is at ${at.slice(0, 7)}, but main is at ${main.slice(0, 7)}: reviews run the old code until the copy is updated.`
      : `Its installed copy has no commit stamp (the file that says which commit of main the copy was made from), so whether reviews run main's code can't be told. A copy installed before the copy's layout changed has none; the review runner says what to do in its log, ${logWhere(runnerLog)}.` });
  }
  return out;
}

// Where the review runner's log is: the path the wiring passes, or the file's name and the folder it is in.
const logWhere = (p) => (typeof p === 'string' && p.startsWith('/') ? p : `${RUNNER_LOG}, in the folder the Mac setup chose for the review jobs' logs`);

/**
 * The mainHead port statusAlerts takes (L75 m-2): main's commit (`main()`, the wiring's) and since when the copy has
 * been behind it, from root's record beside the copy (`readMainSeen`: root's alone, or no `since`, so a behind copy is
 * told at once). `owner` and `top` stand in for root and `/` in a test.
 */
export function mainSeenHead({ installRoot, main, owner = 0, top = '/' }) {
  return (installed) => {
    const commit = main();
    return { commit, since: behindSince(readMainSeen(mainSeenFile(installRoot), { owner, top }), commit, installed) };
  };
}

/**
 * The ports the time limits use. `status` is the runner's status.json; `reviewUid` the review user's uid. The stamp check
 * uses `mainHead`, or, given `installRoot` and `main`, mainSeenHead's. `runnerLog` is the review runner's log file
 * (`<logDir>/` M4 review-daemons.mjs RUNNER_LOG), which the no-stamp alert names.
 */
export function reviewPorts({ requests, status, reviewUid, now = () => Date.now(), newId, mainHead, installRoot, main, runnerLog }) {
  if (!mainHead && installRoot && main) mainHead = mainSeenHead({ installRoot, main });
  const read = () => readReviewStatus({ file: status, now: now(), uid: reviewUid });
  return {
    requestReview: ({ card, head, role }) => writeReviewRequest({ dir: requests, card, head, role, ...(newId ? { newId } : {}) }),
    // Throws when the status can't be trusted: an unclear answer is an error, never a no (L63).
    hasReviewer: (card, role, head) => read().running.some((r) => r.card === card && r.role === role && r.head === head),
    // The plan reviewers the runner says run (L688): they run as the review user, so the Dispatcher's own session list
    // never sees them. Throws when the status can't be trusted, so the tick counts them as at the cap, never as none.
    planReviewsRunning: () => read().running.filter((r) => r?.role === PLAN_REVIEW_ROLE).map(({ card, session_id: sessionId, started_at: startedAt, request_id: requestId }) => ({ card, session_id: sessionId, started_at: startedAt, ...(typeof requestId === 'string' ? { request_id: requestId } : {}) })),
    reviewAlerts: () => { const s = read(); return [...s.alerts, ...s.holds.map((h) => ({ ...h, hold: true })), ...statusAlerts(s, mainHead, now(), { runnerLog })]; },
    // The plan reviewer (L703): asked by a request, its answer read from the runner's own ended record beside the status,
    // so the Dispatcher never reads the reviewer's outbox. A record it can't trust throws, never "still working".
    startPlanReview: ({ card, fingerprint, key }) => writePlanReviewRequest({ dir: requests, card, fingerprint, key }),
    planReviewAnswer: ({ card, fingerprint, session }) => planAnswerFor({ root: dirname(status), uid: reviewUid, card, fingerprint, session }),
  };
}

/** The fact that marks one runner alert as sent to Joe: its id and time, so the same trouble coming back later is sent again. */
export const REVIEW_ALERT_FACT = (a) => `review-alert-${createHash('sha256').update(`${a.id}|${a.at}`).digest('hex').slice(0, 24)}`;

// The mark of one hold, in pass.mjs's hold- family: one per id, so a hold that ends clears its own mark (L315).
const REVIEW_HOLD_PREFIX = 'hold-review-';
export const REVIEW_HOLD_FACT = (id) => `${REVIEW_HOLD_PREFIX}${sha(id)}`;

// A hold that comes and goes is one trouble, not a new one each time (L437). Its mark clears only after this long off
// the list, and a `since` told in the last STILL_WAITING_MS is not told again, whatever happened to the mark between.
export const HOLD_ABSENT_MS = 60 * 60_000;
const NO_SINCE = 'none'; // the key in since_times of a hold with no `since`
const markOf = (rec, fact) => { try { return rec.read('fact', fact)?.doc ?? null; } catch { return null; } };
// Every write here is from the mark read (writeFrom, L288 MAT-4), so a told mark landing between read and write stays.
// A refused one reaches the log and the owner (L354 item 6).
const writeMark = (rec, fact, base, doc, kind, report, opts) => {
  const r = writeFrom(rec, fact, base, doc, kind, opts);
  if (r?.ok !== true) report(`${fact} could not be written (${r?.reason ?? 'no answer'})`, fact);
};
const backOnList = (rec, fact, mark, report) => {
  if (mark?.absent_since === undefined) return;
  const { absent_since: _, ...rest } = mark;
  writeMark(rec, fact, mark, rest, 'hold_back', report);
};
// The hold has ended: its queued copy leaves first, then the mark clears, told_at winning over a mark on its way, and
// cleared_at moving the version so that mark conflicts (L354, L449). since_times stays: it outlasts a clear.
const clearHold = (rec, fact, now, report) => clearCause(rec, fact, (moved) => {
  const cur = markOf(rec, fact);
  if (!moved && (cur === null || (typeof cur === 'object' && cur.told_at == null))) return;
  const was = typeof cur === 'object' ? cur : undefined;
  writeMark(rec, fact, was ?? undefined, { ...was, told_at: null, cleared_at: new Date(now).toISOString() }, 'hold_cleared', report, { force: ['told_at'] });
}, report);
// The sinces told in the last day, by when. A time that can't be read or lies ahead is not kept: told, never held back.
const recentSinces = (mark, now) => Object.fromEntries(Object.entries(mark?.since_times ?? {}).filter(([, at]) => {
  const t = pastTime(at, now);
  return t !== null && now - t < STILL_WAITING_MS;
}));

/** A pass whose status could not be read tells nothing and clears nothing: time off the list starts again (L437). */
export function keepReviewHolds(rec, report) {
  for (const { id } of rec.list('fact')) if (id.startsWith(REVIEW_HOLD_PREFIX)) backOnList(rec, id, markOf(rec, id), report);
}

/**
 * Each runner alert to Joe once, and each hold (`hold: true`) at once, then each day while it is listed, through the
 * outbox (marked once a copy is delivered). A hold whose `since` was told in the last day is not told again (L437). A
 * hold off the list for HOLD_ABSENT_MS is cleared, its queued copy dropped, so a later return is told. A `keep` hold
 * counts as listed, under the `since` it was last told by, if any. What it needs could not be read, so it is told on
 * first sight and each day in its own words, never silent (L458, L465). Only a status that was read gets here; a read
 * that failed goes to keepReviewHolds. `report(line, fact)` hears a refused drop or write. Returns how many were queued.
 */
export function relayReviewAlerts({ rec, alerts, alert, now, report }) {
  let n = 0;
  const listed = new Set();
  const tell = ({ fact, waiting, since, text }) => stillWaiting({
    now, waiting, ...(since !== undefined ? { since } : {}),
    read: () => rec.read('fact', fact)?.doc,
    tell: (fields) => {
      const since_times = { ...recentSinces(markOf(rec, fact), now), [since ?? NO_SINCE]: fields.told_at };
      return tellThen(alert, text, { fact, fields: { ...fields, since_times }, kind: 'hold_alert' });
    },
    clear: () => clearHold(rec, fact, now, report),
  });
  for (const a of alerts ?? []) {
    if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') continue;
    if (a.hold) {
      const fact = REVIEW_HOLD_FACT(a.id);
      listed.add(fact);
      const mark = markOf(rec, fact);
      backOnList(rec, fact, mark, report);
      const since = (a.keep && mark?.told_at ? mark.since : undefined) ?? (typeof a.since === 'string' ? a.since : undefined);
      if (recentSinces(mark, now)[since ?? NO_SINCE] !== undefined) continue;
      if (tell({ fact, waiting: true, since, text: `review runner: ${a.text.slice(0, 500)}` }).did === 'told') n += 1;
      continue;
    }
    const fact = REVIEW_ALERT_FACT(a);
    if (rec.read('fact', fact)?.doc?.told_at) continue;
    // Only an alert the queue took is counted (L130 c1).
    if (tellThen(alert, `review runner: ${a.text.slice(0, 500)}`, { fact: REVIEW_ALERT_FACT(a), fields: { told_at: new Date(now).toISOString() }, kind: 'review_alert' }) !== false) n += 1;
  }
  const queued = queuedMarks(rec, REVIEW_HOLD_PREFIX);
  const marked = rec.list('fact').map((f) => f.id).filter((id) => id.startsWith(REVIEW_HOLD_PREFIX));
  for (const fact of new Set([...marked, ...queued])) {
    if (listed.has(fact)) continue;
    const mark = markOf(rec, fact);
    const object = typeof mark === 'object' && mark !== null;
    if (!queued.includes(fact) && (mark === null || (object && mark.told_at == null))) continue; // nothing to clear
    const gone = pastTime(mark?.absent_since, now);
    if (gone === null) writeMark(rec, fact, object ? mark : undefined, { ...(object ? mark : {}), absent_since: new Date(now).toISOString() }, 'hold_absent', report);
    else if (now - gone >= HOLD_ABSENT_MS) tell({ fact, waiting: false });
  }
  return n;
}
