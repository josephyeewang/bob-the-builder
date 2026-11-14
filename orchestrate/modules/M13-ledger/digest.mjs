// digest.mjs — the daily digest of what happened (R-1-29; design v4 §9.2 M13 "turn the diary into the digest", P4.3:
// "everything else goes in the digest"; v3 §4.12 `reports/digest.json`, read by the Front Door's morning push).
//
// Built from the record's diary, the one account of what happened, for a window [from, to) of the record's own times:
//   - merges: every merge that reached `merged` in the window, with its card and pull request;
//   - flags: every merge the post-merge audit flagged (`audit_flagged`) and every card undone (`reverted`) in the window;
//   - waiting: every item waiting now, with who / what / since, from R-0b-77's roll-up (waiting.mjs, not a copy), each
//     marked when its wait began inside the window;
//   - record errors: a diary line whose time can't be read, a merge whose own entry can't be read, and R-0b-77's
//     waiting items with a missing field. Never left out: a line the digest can't place is shown, not dropped (I1).
// Every count is the length of its list, worked out once here; the test recomputes each from the diary a second way.
// A diary that can't be read throws (record.mjs: diary() throws rather than answer "nothing happened"), so the caller
// holds the digest and tells, never sends an empty day.
//
// NOT WIRED YET: nothing writes reports/digest.json or the digest issue; the morning push that reads it is a later row.

import { pastTime } from '../../shared/still-waiting.mjs';
import { waitingItems, waitingLines } from './waiting.mjs';

export const FLAG_MOVES = Object.freeze([
  { entity: 'merge', to: 'audit_flagged', what: 'the post-merge audit flagged it' },
  { entity: 'card', to: 'reverted', what: 'undone' },
]);
const MERGED = 'merged';

/**
 * rec: the product's record; from, to: ms, the window [from, to); now: ms, the clock stored times are read against.
 * → { from, to, merges, flags, waiting, errors, counts }
 */
export function digestOf(rec, { from, to, now }) {
  for (const [k, v] of Object.entries({ from, to, now })) if (!Number.isFinite(v)) throw new TypeError(`digestOf: ${k} must be a time in ms`);
  if (!(from < to)) throw new TypeError('digestOf: from must be before to');
  const inWindow = (t) => t !== null && t >= from && t < to;
  const merges = []; const flags = []; const errors = []; const seen = new Set();
  for (const l of rec.diary({ since: 0 })) {
    const t = pastTime(l?.ts, now);
    const isMerge = l?.entity === 'merge' && l.to_state === MERGED;
    const flag = FLAG_MOVES.find((f) => l?.entity === f.entity && l.to_state === f.to);
    if (!isMerge && !flag) continue;
    if (t === null) { errors.push(`record error: diary line ${l?.seq ?? '?'} (${l?.entity} ${l?.id} → ${l?.to_state}) has a time that can't be read: ${JSON.stringify(l?.ts ?? null)}`); continue; }
    if (!inWindow(t)) continue;
    const at = new Date(t).toISOString();
    if (flag) { flags.push({ entity: l.entity, id: l.id, what: flag.what, at }); continue; }
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const r = rec.read('merge', l.id);
    if (!r?.doc) { errors.push(`record error: merge ${l.id} reached merged at ${at}, but its entry can't be read${r?.reason ? ` (${r.reason})` : ''}`); merges.push({ id: l.id, at, card: null, pr: null }); continue; }
    merges.push({ id: l.id, at, card: r.doc.card ?? null, pr: r.doc.pr ?? null });
  }
  const waiting = waitingItems(rec).map((w) => {
    const t = w.record_error ? null : pastTime(w.since, now);
    return { ...w, began_in_window: inWindow(t) };
  });
  for (const w of waiting) if (w.record_error) errors.push(w.record_error);
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), merges, flags, waiting, errors,
    counts: { merges: merges.length, flags: flags.length, waiting: waiting.length, waiting_began: waiting.filter((w) => w.began_in_window).length, record_errors: errors.length },
  };
}

/** The digest as plain lines, each number copied from `counts`, never worked out again. */
export function digestText(d) {
  const c = d.counts;
  const section = (title, n, lines) => [`${title} (${n})`, ...(lines.length ? lines.map((l) => `- ${l}`) : ['- none'])];
  return [
    `Digest ${d.from} to ${d.to}`,
    '',
    ...section('Merged', c.merges, d.merges.map((m) => `${m.id}: card ${m.card ?? '?'}, PR ${m.pr ?? '?'}, at ${m.at}`)),
    '',
    ...section('Flags', c.flags, d.flags.map((f) => `${f.entity} ${f.id}: ${f.what}, at ${f.at}`)),
    '',
    ...section(`Waiting now, ${c.waiting_began} of them since this window`, c.waiting, waitingLines(d.waiting)),
    '',
    ...section('Record errors', c.record_errors, d.errors),
  ].join('\n') + '\n';
}
