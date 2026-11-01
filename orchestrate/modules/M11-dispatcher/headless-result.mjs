// What a headless worker's final result means for its card (R-0b-65; review 0b-6 m10).
//
// A worker started with `--output-format json` ends with one result object. A turn cap or a budget
// cap stop ("at 2x it stops and needs Joe") -> the card waits on Joe with cause budget_stop, never a
// fix card. Anything unreadable is treated as a stop that needs Joe, not as success.
//
// Capability note (Principle 9): the result shape (type 'result', subtype success /
// error_max_turns / error_max_budget_usd / error_during_execution, is_error) is CHECKED AGAINST
// NOTHING YET. Whether --max-budget-usd is enforced on a subscription login is unverified; the live
// proof records both with date and Claude Code version. Void at the next pin.

import { waitOn, move } from './moves.mjs';

export const CHECKED_AGAINST = null;
const CAP_STOPS = ['error_max_turns', 'error_max_budget_usd'];

/** Reads the last JSON object in the output. -> { outcome: 'success' | 'budget_stop' | 'failed' | 'unreadable', subtype } */
export function readResult(stdout) {
  let r = null;
  const text = String(stdout ?? '').trim();
  try { r = JSON.parse(text); } catch {
    const last = text.split('\n').filter((l) => l.trim()).pop();
    try { r = JSON.parse(last ?? ''); } catch { r = null; }
  }
  if (Array.isArray(r)) r = [...r].reverse().find((x) => x?.type === 'result') ?? null;
  if (!r || r.type !== 'result' || typeof r.subtype !== 'string') return { outcome: 'unreadable', subtype: null };
  if (CAP_STOPS.includes(r.subtype) || /^error_max_/.test(r.subtype)) return { outcome: 'budget_stop', subtype: r.subtype };
  if (r.subtype === 'success' && r.is_error !== true) return { outcome: 'success', subtype: r.subtype };
  return { outcome: 'failed', subtype: r.subtype };
}

/** Applies the result to the card. Success leaves the card to the report intake. */
export function applyResult(rec, cardId, stdout, { now }) {
  const r = readResult(stdout);
  if (r.outcome === 'success') return { ...r, moved: false };
  if (r.outcome === 'budget_stop' || r.outcome === 'unreadable') {
    const what = r.outcome === 'budget_stop' ? 'budget_stop' : 'budget_stop: the worker\'s result could not be read';
    return { ...r, moved: waitOn(rec, cardId, { who: 'joe', what, now, kind: 'budget_stop' }).ok };
  }
  return { ...r, moved: move(rec, 'card', cardId, { state: 'failed', failure: `worker ended: ${r.subtype}` }, { kind: 'worker_failed' }).ok };
}
