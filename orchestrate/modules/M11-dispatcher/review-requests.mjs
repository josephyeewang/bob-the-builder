// The Dispatcher's side of the review runner (lead call L65). The Dispatcher never starts a reviewer or an auditor:
// it runs as the workers' Mac user, and anything it could start a worker could start too. It only asks, by writing a
// request { card, head, role, request_id } into the runner's requests/ folder, and the runner (M4
// review-runner.mjs, running as `review`) checks the request against the Record and git before starting anything.
// What runs, and the runner's alerts for Joe, come back in the runner's status file; a status that is missing or
// older than 3 minutes is an error, never "no reviewer" (L63).
//
//   reviewPorts({ requests, status, reviewUid, now, newId }) → { requestReview, hasReviewer, reviewAlerts }
//   relayReviewAlerts({ rec, alerts, alert, now })            → tells Joe each runner alert once (a fact per alert)
//
// Writing a file is all this does: no process is started here (only-send-safe.test.mjs).

import { closeSync, constants, fstatSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readReviewStatus, REQUEST_ID, CARD_ID } from '../M4-workshop/launcher/review-runner.mjs';
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

/** The ports the time limits use. `status` is the runner's status.json; `reviewUid` the review user's uid. */
export function reviewPorts({ requests, status, reviewUid, now = () => Date.now(), newId }) {
  const read = () => readReviewStatus({ file: status, now: now(), uid: reviewUid });
  return {
    requestReview: ({ card, head, role }) => writeReviewRequest({ dir: requests, card, head, role, ...(newId ? { newId } : {}) }),
    // Throws when the status can't be trusted: an unclear answer is an error, never a no (L63).
    hasReviewer: (card, role, head) => read().running.some((r) => r.card === card && r.role === role && r.head === head),
    reviewAlerts: () => read().alerts,
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
