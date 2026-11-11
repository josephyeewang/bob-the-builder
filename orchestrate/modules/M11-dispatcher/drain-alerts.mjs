// drain-alerts.mjs — a worker runner session whose outbox stays undrained is told to the owner (L893, L896). It is a
// tell only: nothing here closes an outbox or moves a file.
//
// WHY. The runner closes an ended session's outbox only once the Record has taken or told every file in it (L852,
// wiring/runner-ports.mjs drainedPort). The drain fails safe: an outbox it can't show drained stays open for ever, and
// before this nobody was told. The runner names the cause in its status once an outbox has stayed undrained past
// RUNNER_DRAIN_HELD_MS (wiring/worker-runner.mjs: `drain_held: { cause, since }`); this relays each one.
//
// The causes are one list (DRAIN_CAUSES), read by the runner (which writes them), the status reader (which refuses any
// other, wiring/owner-status.mjs) and this relay (which words them).
//
// Each held session is its own hold, on the shared still-waiting rule (L315), with `since` = `<session>:<cause>`: told
// at once, again each day while it lasts, and told afresh when its cause changes. A session no longer held (drained, or
// off the status) has its mark cleared, so a return is told afresh. A status that can't be read is said so, on its own
// hold, and clears nothing: it is never read as "nothing held".
//
// Nothing reaches the owner until the worker runner's status reader (wiring/owner-status.mjs ownerSyncPorts) is wired
// into the Dispatcher: until then the tick gives timeLimits no `drainHolds` port.

import { HOLD_FACT, clearHold } from './pass.mjs';
import { idHash } from './intake-facts.mjs';
import { plain, queuedMarks, tellThen } from './alerts.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';

/** Why an ended session's outbox is not drained: the runner's one list (L896). */
export const DRAIN_CAUSES = Object.freeze([
  'fact-id-too-long', 'name-not-utf8', 'name-not-a-fact-id', 'dot-name', 'not-a-plain-file', 'file-unreadable',
  'outbox-unreadable', 'not-taken', 'in-flight', 'hash-mismatch', 'bundle-no-attempt', 'bundle-not-pushed', 'bundle-changed', 'record-unreadable', 'check-late',
  'check-failed', 'other',
]);
const CAUSE_TEXT = Object.freeze({
  'fact-id-too-long': 'a file\'s name is too long for the Record to note it taken',
  'name-not-utf8': 'a file\'s name is not valid UTF-8, so the Record can\'t note it taken',
  'name-not-a-fact-id': 'a file\'s name holds characters the Record can\'t note it taken under',
  'dot-name': 'a file whose name starts with a dot was never taken in',
  'not-a-plain-file': 'it holds something that is not a plain file (a folder or a link)',
  'file-unreadable': 'a file in it can\'t be read',
  'outbox-unreadable': 'the outbox folder itself can\'t be listed',
  'not-taken': 'a file in it was never taken in or told',
  'in-flight': 'a file\'s intake has been in progress for too long',
  'hash-mismatch': 'a file changed after the Record took it',
  'bundle-no-attempt': 'the Record\'s session gives no attempt of this card, so its bundle\'s push can\'t be found',
  'bundle-not-pushed': 'the card\'s bundle has no push of this session\'s attempt that took it',
  'bundle-changed': 'the card\'s bundle changed after its push took it',
  'record-unreadable': 'the Record\'s note of a file, or of the session, can\'t be read',
  'check-late': 'the drain check did not answer within the runner\'s limit',
  'check-failed': 'the drain check failed',
  other: 'the Record\'s note of a file does not match it',
});
if (DRAIN_CAUSES.some((c) => !CAUSE_TEXT[c]) || Object.keys(CAUSE_TEXT).length !== DRAIN_CAUSES.length) throw new Error('every drain cause needs its words');

/** A runner status's `drain_held`: { cause: one of DRAIN_CAUSES, since: ISO }, nothing else (the one check: the status
 * reader refuses any other, and the runner rewrites any other it holds, #425 r1 m4). */
export const drainHeldOk = (h) => !!h && typeof h === 'object' && !Array.isArray(h) && DRAIN_CAUSES.includes(h.cause)
  && typeof h.since === 'string' && Number.isFinite(Date.parse(h.since)) && Object.keys(h).every((k) => k === 'cause' || k === 'since');

const DRAIN_PREFIX = HOLD_FACT('drain-');
/** The hold of one session's undrained outbox. */
export const DRAIN_HOLD_FACT = (session) => `${DRAIN_PREFIX}${idHash(session)}`;
/** The hold of a status that could not be read. */
export const DRAIN_UNKNOWN_FACT = HOLD_FACT('drain-status-unknown');

const heldText = (h) => `worker runner: session ${plain(h.session, 140)} (card ${plain(h.card ?? 'none', 140)}) has ended, but its outbox stays open: ${CAUSE_TEXT[h.cause]}. It is never closed, and the session stays listed, until this clears or is fixed by hand. Do not delete the outbox: a file in it may not be in the Record yet, and an outbox that is gone counts as drained`;

/**
 * `held` is the status reader's drainHolds(): [{ session, card, product, cause, since }], or null with `error` when the
 * status could not be read (a list holding anything else counts as that too). `report(line, fact)` hears a refused drop
 * or write. → how many were queued.
 */
export function relayDrainHolds({ rec, held, error, alert, now, report }) {
  let n = 0;
  const tell = ({ fact, waiting, since, text, what }) => {
    const w = stillWaiting({
      now, waiting, ...(since !== undefined ? { since } : {}),
      read: () => rec.read('fact', fact)?.doc,
      tell: (fields) => tellThen(alert, text, { fact, fields: { text, ...fields }, kind: 'hold_alert' }),
      clear: () => clearHold(rec, fact, now, report),
    });
    if (w.did === 'told') n += 1;
    if (w.did === 'unsent') report(`the ${what} alert could not be queued; it is tried again next pass`, fact);
  };
  // The status reader refuses any other shape, so a bad entry is the reader's contract broken: read as unknown.
  const bad = (h) => !h || typeof h.session !== 'string' || !h.session || !DRAIN_CAUSES.includes(h.cause);
  if (!Array.isArray(held) || held.some(bad)) {
    // Fail closed: say the status is unknown, and clear no session's hold (its outbox may still be stuck).
    const why = Array.isArray(held) ? 'a held outbox in it is not what the status reader gives' : (error ?? 'no reason given');
    tell({ fact: DRAIN_UNKNOWN_FACT, waiting: true, what: 'drain status', text: `worker runner: its status could not be read, so whether an ended session's outbox is stuck open is not known (${plain(why)})` });
    return n;
  }
  tell({ fact: DRAIN_UNKNOWN_FACT, waiting: false, what: 'drain status' });
  const listed = new Set();
  for (const h of held) {
    const fact = DRAIN_HOLD_FACT(h.session);
    listed.add(fact);
    tell({ fact, waiting: true, since: `${h.session}:${h.cause}`, what: 'undrained outbox', text: heldText(h) });
  }
  // A session no longer held: its mark is cleared (and a queued copy dropped), so a return is told afresh.
  const marked = rec.list('fact').map((f) => f.id).filter((id) => id.startsWith(DRAIN_PREFIX) && id !== DRAIN_UNKNOWN_FACT);
  for (const fact of new Set([...marked, ...queuedMarks(rec, DRAIN_PREFIX).filter((id) => id !== DRAIN_UNKNOWN_FACT)])) {
    if (!listed.has(fact)) tell({ fact, waiting: false, what: 'undrained outbox' });
  }
  return n;
}
