// told.mjs — when a message M2 told Joe counts as told recently enough to stay quiet (L309 MAT-2, L315, L317).
//
// Something still waiting (an ask that can't be pushed, a bad rules config, a near-miss value) is told once, then again
// each day while it still waits: a once-ever message would be a silent hold. A told time more than a minute in the
// future (a clock set back, a file from another machine) counts as not told, so Joe is told now (L317).
//
// TEMPORARY (L315): the same day as M11's HOLD_REPEAT_MS (M11 pass.mjs); M2 does not import M11 (M11 imports M2).
// Lane 5's shared stillWaiting primitive replaces this file and absorbs both.

export const REPEAT_MS = 24 * 60 * 60_000;
export const FUTURE_SLACK_MS = 60_000;

// True when `at` (a told time, ms) is a real time, not more than a minute ahead of `now`, and less than a day before it.
export const toldRecently = (at, now) => Number.isFinite(at) && at - now <= FUTURE_SLACK_MS && now - at < REPEAT_MS;
