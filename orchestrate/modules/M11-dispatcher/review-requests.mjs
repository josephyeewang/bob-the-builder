// The Dispatcher's side of the review runner (lead call L65). The Dispatcher never starts a reviewer or an auditor:
// it runs as the workers' Mac user, and anything it could start a worker could start too. It only asks, by writing a
// request { card, head, role, request_id } into the runner's requests/ folder, and the runner (M4
// review-runner.mjs, running as `review`) checks the request against the Record and git before starting anything.
// What runs, and the runner's alerts for Joe, come back in the runner's status file; a status that is missing or
// older than 3 minutes is an error, never "no reviewer" (L63).
//
//   reviewPorts({ requests, status, reviewUid, now, newId, mainHead, installRoot, main })
//                                                             → { requestReview, hasReviewer, reviewAlerts }
//   mainSeenHead({ installRoot, main, owner, top })           → the mainHead port, from root's record of main (L75 m-2)
//   statusAlerts(status, mainHead, now)                       → the Dispatcher's own alerts from the status (L66)
//   relayReviewAlerts({ rec, alerts, alert, now })            → tells Joe each runner alert once (a fact per alert)
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
import { REVIEW_ROLES } from '../../shared/review-roles.mjs';
import { tellThen } from './alerts.mjs';

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
 * The Dispatcher's own alerts from a status (readReviewStatus's answer), in the runner's alert shape. `at` is fixed, so
 * each is told once per id (REVIEW_ALERT_FACT keys on id and at).
 */
export const STAMP_GRACE_MS = 30 * 60_000;
const AHEAD_MS = 5 * 60_000;

export function statusAlerts(s, mainHead, now = Date.now()) {
  const out = [];
  if (s?.ok === false) {
    const why = typeof s.error === 'string' && s.error ? s.error.slice(0, 300) : 'no reason given';
    out.push({ id: `runner-failed-${sha(why)}`, at: 'once', text: `Its last pass failed: ${why}.` });
  }
  let head = null;
  try { head = mainHead ? mainHead(s?.installed_commit ?? null) : null; } catch { head = null; }
  const main = typeof head === 'string' ? head : head?.commit;
  if (typeof main === 'string' && HEX40.test(main) && s?.installed_commit !== main) {
    const at = s?.installed_commit ?? null;
    const since = Number.isFinite(head?.since) && head.since <= now + AHEAD_MS ? head.since : null;
    // Behind main for less than the grace: the updater has not had its turn yet.
    if (at && since !== null && now - since < STAMP_GRACE_MS) return out;
    out.push({ id: `stamp-${at ?? 'none'}`, at: 'once', text: at
      ? `Its installed copy is at ${at.slice(0, 7)}, but main is at ${main.slice(0, 7)}: reviews run the old code until the copy is updated.`
      : 'Its installed copy has no commit stamp where it is read, installed-commit at the top of the <name>.v-<commit> folder the copy\'s link names (beside orchestrate/, not inside it), so whether reviews run main\'s code can\'t be told. An install from before the copy\'s layout changed has none there; the review runner\'s log says what to do.' });
  }
  return out;
}

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
 * uses `mainHead`, or, given `installRoot` and `main`, mainSeenHead's.
 */
export function reviewPorts({ requests, status, reviewUid, now = () => Date.now(), newId, mainHead, installRoot, main }) {
  if (!mainHead && installRoot && main) mainHead = mainSeenHead({ installRoot, main });
  const read = () => readReviewStatus({ file: status, now: now(), uid: reviewUid });
  return {
    requestReview: ({ card, head, role }) => writeReviewRequest({ dir: requests, card, head, role, ...(newId ? { newId } : {}) }),
    // Throws when the status can't be trusted: an unclear answer is an error, never a no (L63).
    hasReviewer: (card, role, head) => read().running.some((r) => r.card === card && r.role === role && r.head === head),
    reviewAlerts: () => { const s = read(); return [...s.alerts, ...statusAlerts(s, mainHead, now())]; },
  };
}

/** The fact that marks one runner alert as sent to Joe: its id and time, so the same trouble coming back later is sent again. */
export const REVIEW_ALERT_FACT = (a) => `review-alert-${createHash('sha256').update(`${a.id}|${a.at}`).digest('hex').slice(0, 24)}`;

/** Each runner alert to Joe once, through the outbox (marked once a copy is delivered). Returns how many were queued. */
export function relayReviewAlerts({ rec, alerts, alert, now }) {
  let n = 0;
  for (const a of alerts ?? []) {
    if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') continue;
    const fact = REVIEW_ALERT_FACT(a);
    if (rec.read('fact', fact)?.doc?.told_at) continue;
    tellThen(alert, `review runner: ${a.text.slice(0, 500)}`, { fact: REVIEW_ALERT_FACT(a), fields: { told_at: new Date(now).toISOString() }, kind: 'review_alert' });
    n += 1;
  }
  return n;
}
