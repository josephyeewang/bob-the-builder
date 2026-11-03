// still-waiting.mjs — the one way to tell Joe about something that still waits (lead call L315, from the told-once class
// audit, audit-class-toldonce.md).
//
// WHY. Fifteen holds on main told Joe once, ever, and then went quiet while the thing still waited: a card on Joe for a
// month, a Lead that won't start, a phone that can't reach the Front Door. Each site kept its own once-mark
// (`told_since`, `start_failed_told`, `told: true`), and a once-mark can't say "still". This is the one rule, so no site
// keeps its own: told at once, then again every `every` (24 h) while it still waits, and the mark cleared when it ends,
// so a wait that comes back is told afresh. Something that can't be read counts as "tell": a hold is never silent
// because its state or its mark was unreadable (L38).
//
//   stillWaiting({ waiting, read, tell, clear, now, every })
//     waiting: true | false, or a function answering it (one that throws counts as still waiting).
//     read():  the mark (the object `tell` last wrote, `{ told_at }`), or null; one that throws counts as no mark.
//     tell(fields): sends the alert and writes `fields` ({ told_at }) onto the mark, ideally only once a copy is
//              delivered (M11: tellThen). Its answer is passed back; false means not sent.
//     clear(): ends the mark (M11: write told_at null and dropCause, so a queued copy leaves unsent).
//     → { did: 'told' | 'quiet' | 'cleared' | 'idle', answer? }
//   dueToTell(mark, now, every) → whether a still-waiting thing with this mark is told now.
//   pastTime(value, now) → the time, or null when it can't be read or is more than 60 s ahead of now. Any clock a
//              site reads for "how long has this waited" goes through it, so a future time is told, never waited out.
//
// It imports nothing: each module plugs in its own alert path and its own Record writes.

export const STILL_WAITING_MS = 24 * 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

// A time more than this ahead of now can't be true (a clock that went back, or a bad write): it counts as unreadable
// (L317 MAT-1). Within it, a little clock skew between writers reads as now.
export const FUTURE_SKEW_MS = 60_000;

/** A time in ms, or null when it can't be read or is more than FUTURE_SKEW_MS ahead of `now` (L317 MAT-1). */
export function pastTime(value, now) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t <= now + FUTURE_SKEW_MS ? t : null;
}

/** Told now? No mark, a told_at that can't be read or lies in the future, or one `every` old. */
export function dueToTell(mark, now, every = STILL_WAITING_MS) {
  const t = pastTime(mark?.told_at, now);
  return t === null || now - t >= every;
}

export function stillWaiting({ waiting, read, tell, clear, now, every = STILL_WAITING_MS }) {
  let still;
  try { still = typeof waiting === 'function' ? waiting() : waiting; } catch { still = true; }
  let mark;
  try { mark = read(); } catch { mark = null; }
  if (still === false) {
    if (mark?.told_at == null) return { did: 'idle' };
    clear();
    return { did: 'cleared' };
  }
  if (!dueToTell(mark, now, every)) return { did: 'quiet' };
  const answer = tell({ told_at: iso(now) });
  return { did: 'told', answer };
}
