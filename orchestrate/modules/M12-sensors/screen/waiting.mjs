// The "waiting" decision sendSafe will ask (R-0b-153): free only when the hooks say free AND fresh screen readings
// show the session at its idle prompt. Pure, no I/O. Nothing calls it until R-0b-153a wires it into sendSafe.
//
// Modified from herdr (Apache-2.0), commit ee5bfb5041bb3e4a49d591c72308aae3c81ecdde: see ../third_party/herdr/NOTICE.
// Source: src/pane/agent_detection.rs (PendingIdleConfirmation: 3 confirmations 100 ms apart), ported from Rust to
// JavaScript and made stricter:
//   - herdr's 700 ms cap lets idle through unconfirmed; ours never does: fewer than 3 spaced idle readings is never free;
//   - herdr confirms "plain" idle (any idle state); ours counts only the text-region prompt rule (live_prompt_box), never
//     a title, and any blocked reading answers "waiting" at once;
//   - no history is kept between calls: the readings are only the ones the current send took, so the debounce always
//     starts from nothing;
//   - herdr lets the screen alone decide; ours also needs the hook half (M4's tracker) to say the session isn't waiting.
//     A hook clearing "blocked" changes only that half: the answer stays waiting until the screen agrees.
// Applies to interactive roles only.

import { matchScreen } from './match.mjs';

/** Claude Code version the screen rules were last checked against. Any other version reads unknown (hold). */
export const SCREEN_RULES_CHECKED_ON = '2.1.322';
/** herdr's AGENT_PENDING_IDLE_RECHECK and AGENT_PENDING_IDLE_CONFIRMATIONS. */
export const RECHECK_MS = 100;
export const CONFIRMATIONS = 3;
/** Ours: a gap a little under RECHECK_MS still counts (timers fire a few ms early); below this the readings are too close. */
export const MIN_GAP_MS = 90;
/** Ours: the newest reading must be at most this old. */
export const MAX_AGE_MS = 1000;
/** The one rule that may say a session is at its prompt. */
export const IDLE_RULE = 'live_prompt_box';

export const Answer = Object.freeze({ FREE: 'free', WAITING: 'waiting', UNKNOWN: 'unknown' });

// The hook states, by name (the tracker's State values in M4 send-safe/activity.mjs; kept as strings so this
// file stays free of M4 imports).
const HOOK_WAITING = new Set(['waiting_input', 'blocked']);
const HOOK_OK = new Set(['idle', 'active']); // active: an Esc mid-turn fires no Stop hook, so the screen decides

const answerWith = (answer, why) => ({ answer, why });

/**
 * hook:     the tracker's state for the session ('idle' | 'active' | 'waiting_input' | 'blocked' | 'exited'), or { state }.
 * readings: the screen readings this send took, oldest first: { text, title, at } each, or { error } for a failed read.
 * version:  the session's claude_code_version. now: ms clock, same base as each reading's `at`.
 * → { answer: free | waiting | unknown, why }. Only "free" may type.
 */
export function decideWaiting({ hook, readings, version, now, rules } = {}) {
  const hookState = typeof hook === 'string' ? hook : hook?.state;
  if (HOOK_WAITING.has(hookState)) return answerWith(Answer.WAITING, `the hooks say ${hookState}`);
  const list = Array.isArray(readings) ? readings : [];
  const read = list.map((r) => (r && typeof r === 'object' && !r.error ? matchScreen(r, rules ? { rules } : undefined) : null));
  // Any blocked reading answers waiting at once (herdr: a visible blocker is never held back).
  const blocked = read.findIndex((m) => m?.state === 'blocked');
  if (blocked >= 0) return answerWith(Answer.WAITING, `the screen shows a question (${read[blocked].rule})`);
  if (!HOOK_OK.has(hookState)) return answerWith(Answer.UNKNOWN, hookState ? `the hooks say ${hookState}` : 'no hook state');
  if (typeof version !== 'string' || !version) return answerWith(Answer.UNKNOWN, 'no Claude Code version');
  if (version !== SCREEN_RULES_CHECKED_ON) return answerWith(Answer.UNKNOWN, `Claude Code ${version}, rules checked on ${SCREEN_RULES_CHECKED_ON}`);
  if (!Number.isFinite(now)) return answerWith(Answer.UNKNOWN, 'no clock');
  if (read.length < CONFIRMATIONS) return answerWith(Answer.UNKNOWN, `${read.length} of ${CONFIRMATIONS} readings`);
  if (read.some((m) => m === null)) return answerWith(Answer.UNKNOWN, 'a screen read failed');
  for (const [i, m] of read.entries()) {
    if (m.state !== 'idle' || m.rule !== IDLE_RULE) return answerWith(Answer.UNKNOWN, `reading ${i + 1} reads ${m.state}${m.rule ? ` (${m.rule})` : ''}`);
  }
  const at = list.map((r) => r.at);
  if (!at.every(Number.isFinite)) return answerWith(Answer.UNKNOWN, 'a reading has no time');
  for (let i = 1; i < at.length; i++) {
    if (at[i] - at[i - 1] < MIN_GAP_MS) return answerWith(Answer.UNKNOWN, 'readings taken too close together');
  }
  const newest = at[at.length - 1];
  if (newest > now) return answerWith(Answer.UNKNOWN, 'a reading from the future');
  if (now - newest > MAX_AGE_MS) return answerWith(Answer.UNKNOWN, `the newest reading is ${now - newest} ms old`);
  return answerWith(Answer.FREE, `${read.length} idle readings and the hooks say ${hookState}`);
}

/** The bare answer: 'free' | 'waiting' | 'unknown'. */
export function waiting(input) {
  return decideWaiting(input).answer;
}
