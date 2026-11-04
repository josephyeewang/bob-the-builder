// still-waiting.mjs — the one way to tell Joe about something that still waits (lead call L315, from the told-once class
// audit, audit-class-toldonce.md; settled in #164 r2, L320).
//
// WHY. Fifteen holds on main told Joe once, ever, and then went quiet while the thing still waited: a card on Joe for a
// month, a Lead that won't start, a phone that can't reach the Front Door. Each site kept its own once-mark
// (`told_since`, `start_failed_told`, `told: true`), and a once-mark can't say "still". This is the one rule, so no site
// keeps its own: told at once, then again every `every` (24 h) while it still waits, and the mark cleared when it ends,
// so a wait that comes back is told afresh. Something that can't be read counts as "tell": a hold is never silent
// because its state, its mark or its start time was unreadable (L38, L317).
//
//   stillWaiting({ waiting, read, tell, clear, now, every, since, after })
//     now:     the time in ms, a finite number; anything else throws StillWaitingError (a caller's bug, made loud).
//     waiting: true or false, or a function answering it. A function that throws counts as still waiting. Any other
//              answer (a Promise, a count, undefined) throws StillWaitingError: an async or vague answer must not
//              silently mean "still waiting" for ever, or "ended".
//     read():  the mark (the object `tell` last wrote), or null. One that throws counts as no mark: told. A Promise
//              throws StillWaitingError.
//     tell(fields): sends the alert and writes EVERY field of `fields` ({ told_at, since? }) onto the mark, unchanged
//              (a mark missing `since` reads as another wait's, so it is told every pass). It MUST write the mark only
//              once a copy is delivered, never before: in M11 the alert is queued with the mark (tellThen) and the
//              outbox sender writes it after delivery. Its answer is passed back; false means not sent ('unsent').
//              A tell that throws is thrown on (L324 n1): a swallowed throw, with a caller that ignores `did`, would
//              be a silent hold.
//     clear(): called on EVERY pass where the wait has ended (or has not yet reached `after.limit`), mark or none, so
//              an alert still queued for it is dropped before it is sent (M11: dropCause, then told_at null only if a
//              mark is set). It must be cheap when there is nothing to clear. A clear that throws is thrown on.
//     every:   the repeat in ms. Anything not a finite number above 0 (NaN, Infinity, 'abc', 0, -1, null) is the
//              default STILL_WAITING_MS: a bad setting must never mean "told once" nor "told every pass".
//     since:   optional id of this wait (its start time as ISO text, say): text, or StillWaitingError (L324 n2: a NaN
//              or a Date never equals the stored one, so it would be told every pass). Kept on the mark and compared as
//              text: a mark naming another wait (or none) is told at once, not held by the old mark.
//     after:   optional { since, limit }: tell only once the wait is `limit` ms old (24 h if limit isn't a finite
//              number ≥ 0), counted from `since` (an ISO time) by pastTime's rule: a since that can't be read or is in
//              the future counts as old enough, told now, never "never". Before then it counts as not yet waiting.
//     → { did: 'told' | 'unsent' | 'quiet' | 'cleared' | 'idle', answer? }
//        'unsent': tell answered false (the mark is unchanged, so the next pass tells again).
//        'cleared': the wait ended with a mark in place; 'idle': it ended with none (clear was still called).
//   dueToTell(mark, now, every, since) → whether a still-waiting thing with this mark is told now.
//   pastTime(value, now) → the time in ms, or null when it can't be read or is more than FUTURE_SKEW_MS (60 s) ahead
//              of now. It takes ISO time text only: a number (ms) or a Date reads as unreadable. Any clock a site reads
//              for "how long has this waited" goes through it, so a future time is told, never waited out.
//
// It imports nothing: each module plugs in its own alert path and its own Record writes.

export const STILL_WAITING_MS = 24 * 60 * 60_000;
// A time more than this ahead of now can't be true (a clock that went back, or a bad write): it counts as unreadable
// (L317 MAT-1). Within it, a little clock skew between writers reads as now.
export const FUTURE_SKEW_MS = 60_000;

export class StillWaitingError extends Error {
  constructor(message) { super(message); this.name = 'StillWaitingError'; }
}

const iso = (ms) => new Date(ms).toISOString();
const isPromise = (x) => x != null && typeof x.then === 'function';
const checkSince = (since) => {
  if (since !== undefined && typeof since !== 'string') throw new StillWaitingError(`since must be text, not ${since === null ? 'null' : typeof since}`);
};
const checkNow = (now) => {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new StillWaitingError(`now must be a finite time in ms, not ${typeof now === 'number' ? now : typeof now}`);
};
/** The repeat to use: `every` when it is a finite number above 0, else the default (#164 audit MAT-1). */
export const repeatOf = (every) => (typeof every === 'number' && Number.isFinite(every) && every > 0 ? every : STILL_WAITING_MS);

/** A time in ms, or null when it can't be read (ISO text only) or is more than FUTURE_SKEW_MS ahead of `now`. */
export function pastTime(value, now) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t <= now + FUTURE_SKEW_MS ? t : null;
}

/** Told now? No mark, a told_at that can't be read or lies in the future, one `every` old, or a mark of another wait. */
export function dueToTell(mark, now, every, since) {
  checkNow(now);
  checkSince(since);
  if (since !== undefined && (typeof mark?.since !== 'string' || mark.since !== since)) return true;
  const t = pastTime(mark?.told_at, now);
  return t === null || now - t >= repeatOf(every);
}

export function stillWaiting({ waiting, read, tell, clear, now, every, since, after }) {
  checkNow(now);
  checkSince(since);
  let still;
  try { still = typeof waiting === 'function' ? waiting() : waiting; } catch { still = true; }
  if (isPromise(still)) throw new StillWaitingError('waiting answered a Promise: it must answer true or false now');
  if (typeof still !== 'boolean') throw new StillWaitingError(`waiting must be true or false, not ${still === null ? 'null' : typeof still}`);
  if (still && after) {
    const limit = typeof after.limit === 'number' && Number.isFinite(after.limit) && after.limit >= 0 ? after.limit : STILL_WAITING_MS;
    const t = pastTime(after.since, now);
    if (t !== null && now - t < limit) still = false;
  }
  let mark;
  try { mark = read(); } catch { mark = null; }
  if (isPromise(mark)) throw new StillWaitingError('read answered a Promise: it must answer the mark now');
  if (!still) {
    clear();
    // 'idle': nothing was set (no mark, or one already cleared); anything else, a corrupt mark included, was cleared.
    return { did: mark == null || (typeof mark === 'object' && mark.told_at == null) ? 'idle' : 'cleared' };
  }
  if (!dueToTell(mark, now, every, since)) return { did: 'quiet' };
  const answer = tell({ told_at: iso(now), ...(since !== undefined ? { since } : {}) });
  return { did: answer === false ? 'unsent' : 'told', answer };
}
