// The Dispatcher's side of the review runner (lead call L65). The Dispatcher never starts a reviewer or an auditor:
// it runs as the workers' Mac user, and anything it could start a worker could start too. It only asks, by writing a
// request { card, head, role, request_id } into the runner's requests/ folder, and the runner (M4
// review-runner.mjs, running as `review`) checks the request against the Record and git before starting anything.
// What runs, and the runner's alerts for Joe, come back in the runner's status file; a status that is missing or
// older than 3 minutes is an error, never "no reviewer" (L63).
//
//   reviewPorts({ requests, status, reviewUid, now, newId, mainHead, installRoot, main, runnerLog })
//                                                             → { requestReview, hasReviewer, reviewAlerts }
//   mainSeenHead({ installRoot, main, owner, top })           → the mainHead port, from root's record of main (L75 m-2)
//   statusAlerts(status, mainHead, now, { runnerLog })        → the Dispatcher's own alerts from the status (L66)
//   relayReviewAlerts({ rec, alerts, alert, now })            → tells each runner alert once, and each hold while it lasts
//
// Besides the runner's own alerts, the Dispatcher tells Joe two things it reads in the status (L66), each once:
//   - a pass that failed (`ok: false`), once per cause (its error text);
//   - an installed copy whose commit stamp is not main's (or has no stamp), once per installed commit: reviews then run
//     old code until the copy is updated. `mainHead(installed)` is the wiring's port: `{ commit, since }`, main's commit
//     (40 hex) and, in ms, since when the copy has been behind it. `since` comes from root's own record, which the updater
//     writes after each fetch (M4 install-check.mjs: `behindSince(readMainSeen(mainSeenFile(installRoot)), commit)`):
//     when the updater first saw main ahead of the copy, by its own clock, or its last fetch when it has not yet seen
//     this head. Never a commit's date, which the commit's author sets (L73 point 7(b)). The updater copies main every
//     10 minutes (M4 review-updater.mjs), so a copy behind main is told only once it has stayed behind for
//     STAMP_GRACE_MS (item 20(c)); no stamp, or no `since` (or one dated ahead), is told at once. A plain commit string
//     counts as no `since`. Without the port, or when it fails, there is no stamp check. `mainSeenHead` builds the port
//     from that record (L75 m-2), and reviewPorts builds it when given `installRoot` and `main` (main's commit, a port).
//
// Writing a file is all this does: no process is started here (only-send-safe.test.mjs).

import { closeSync, constants, fstatSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readReviewStatus, REQUEST_ID, CARD_ID } from '../M4-workshop/launcher/review-runner.mjs';
import { behindSince, mainSeenFile, readMainSeen } from '../M4-workshop/launcher/install-check.mjs';
import { RUNNER_LOG } from '../M4-workshop/launcher/review-daemons.mjs';
import { REVIEW_ROLES } from '../../shared/review-roles.mjs';
import { tellThen, clearTold, queuedFacts } from './alerts.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';

const HEX40 = /^[0-9a-f]{40}$/;

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
  const tmp = join(dir, `.${id}.tmp`);
  const final = join(dir, `${id}.json`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); writeSync(fd, JSON.stringify({ card, head, role, request_id: id })); } finally { closeSync(fd); }
    linkSync(tmp, final);
  } catch (e) {
    return { ok: false, reason: `the request could not be written (${e?.code ?? e?.message ?? e})` };
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  return { ok: true, requestId: id };
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

/**
 * The Dispatcher's own holds from a status (readReviewStatus's answer), in the shape the relay takes: listed on every
 * pass they last, so each is told again each day and cleared when it ends (L315). `since` names this trouble: another
 * error, or another installed commit, is told at once.
 */
export const STAMP_GRACE_MS = 30 * 60_000;
const AHEAD_MS = 5 * 60_000;

export function statusAlerts(s, mainHead, now = Date.now(), { runnerLog } = {}) {
  const out = [];
  if (s?.ok === false) {
    const why = typeof s.error === 'string' && s.error ? s.error.slice(0, 300) : 'no reason given';
    out.push({ id: 'runner-failed', hold: true, since: sha(why), text: `Its last pass failed: ${why}.` });
  }
  let head = null;
  try { head = mainHead ? mainHead(s?.installed_commit ?? null) : null; } catch { head = null; }
  const main = typeof head === 'string' ? head : head?.commit;
  if (typeof main === 'string' && HEX40.test(main) && s?.installed_commit !== main) {
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
  return () => {
    const commit = main();
    return { commit, since: behindSince(readMainSeen(mainSeenFile(installRoot), { owner, top }), commit) };
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
    reviewAlerts: () => { const s = read(); return [...s.alerts, ...s.holds.map((h) => ({ ...h, hold: true })), ...statusAlerts(s, mainHead, now(), { runnerLog })]; },
  };
}

/** The fact that marks one runner alert as sent to Joe: its id and time, so the same trouble coming back later is sent again. */
export const REVIEW_ALERT_FACT = (a) => `review-alert-${createHash('sha256').update(`${a.id}|${a.at}`).digest('hex').slice(0, 24)}`;

// The mark of one hold, in pass.mjs's hold- family: one per id, so a hold that ends clears its own mark (L315).
const REVIEW_HOLD_PREFIX = 'hold-review-';
export const REVIEW_HOLD_FACT = (id) => `${REVIEW_HOLD_PREFIX}${sha(id)}`;

/**
 * Each runner alert to Joe once, and each hold (`hold: true`) at once, then each day while it is listed, through the
 * outbox (marked once a copy is delivered). A hold no longer listed is cleared, its queued copy dropped, so its return is
 * told afresh. Only a status that was read gets here: a read that failed clears nothing. Returns how many were queued.
 */
export function relayReviewAlerts({ rec, alerts, alert, now }) {
  let n = 0;
  const listed = new Set();
  const tell = ({ fact, waiting, since, text }) => stillWaiting({
    now, waiting, ...(since !== undefined ? { since } : {}),
    read: () => rec.read('fact', fact)?.doc,
    tell: (fields) => tellThen(alert, text, { fact, fields, kind: 'hold_alert' }),
    clear: () => clearTold(rec, fact),
  });
  for (const a of alerts ?? []) {
    if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') continue;
    if (a.hold) {
      const fact = REVIEW_HOLD_FACT(a.id);
      listed.add(fact);
      if (tell({ fact, waiting: true, since: typeof a.since === 'string' ? a.since : undefined, text: `review runner: ${a.text.slice(0, 500)}` }).did === 'told') n += 1;
      continue;
    }
    const fact = REVIEW_ALERT_FACT(a);
    if (rec.read('fact', fact)?.doc?.told_at) continue;
    // Only an alert the queue took is counted (L130 c1).
    if (tellThen(alert, `review runner: ${a.text.slice(0, 500)}`, { fact: REVIEW_ALERT_FACT(a), fields: { told_at: new Date(now).toISOString() }, kind: 'review_alert' }) !== false) n += 1;
  }
  const marked = rec.list('fact').map((f) => f.id);
  for (const fact of new Set([...marked, ...queuedFacts(rec)])) {
    if (fact.startsWith(REVIEW_HOLD_PREFIX) && !listed.has(fact)) tell({ fact, waiting: false });
  }
  return n;
}
