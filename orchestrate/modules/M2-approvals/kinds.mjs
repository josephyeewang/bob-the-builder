// kinds.mjs — M2 Approvals' fixed words and its reading of the rules. The ask kinds and box statuses themselves are
// shared names (shared/asks.mjs); this file re-exports them so M2's callers need one import.
//
// FIXED LINES. The Front Door shows these words exactly; they are constants so a test can find them and no AI rewords
// them (0b-5 spec review round 4 M4-1, m4-1; round 5 M5-4, M5-5, M5-2; c4-1).
//
// CONFIG. Nothing counts and nothing is pushed while the owner's GitHub id, the push windows or the decisions folder is
// missing or malformed; the caller alerts once (round 2 m2-6). The zone is the owner's home zone, or the trip zone while
// the product is away (unknown trip zone → home zone: a push is harmless, unlike a merge; round 1 m2).

export { ASK_KINDS, BOX_STATUSES, RELEASE_REASONS, ASK_FIELDS, URGENT_DEFAULT, activeKind } from '../../shared/asks.mjs';
import { ASK_KINDS, URGENT_DEFAULT } from '../../shared/asks.mjs';

export const STILL_OPEN_LINE = 'Still open: a typed answer doesn\'t count, tap a choice';
export const CLOSED_LINE = 'that question had closed; nothing was recorded';
export const typedReplyLine = (card) => `Your typed reply didn't answer the question about ${card}; nothing was recorded. I'll ask again next time — tap a choice.`;
export const otherCardLine = (card) => `The question below is about ${card}`;
export const OTHER_ROOM_LINE = 'you have an open question in your thinking room';
export const UNDO_OPEN_QUESTION_LINE = 'answer or skip the open question first';
export const APPROVE_AGAIN_LINE = 'an Approve given before this message doesn\'t count; Approve again';
export const LETTER_LINE = 'couldn\'t read your choice, Approve with just the letter';
export const GO_EMPTY_LINE = 'Approve with no text to go';

export const LAPSE_MS = 12 * 3600_000;
export const MERGE_APPROVE_MS = 24 * 3600_000;
export const URGENT_REPUSH_MS = 2 * 3600_000;
// A window fires at the first pass at or after its time; a pass this much later is a missed window (the Mini was down),
// which is not replayed (round 1 m2: the "caught up" push on return covers it, R-0b-76).
export const WINDOW_GRACE_MS = 60 * 60_000;

// When this round of an ask lapses: 12 hours after it was raised in this round (raised_reask = reask_count). A lapsed ask
// sent back to open is not raised again until its next push or box, so until then nothing lapses it a second time.
export function lapseAt(doc) {
  const t = Date.parse(doc?.raised_at ?? '');
  return ASK_KINDS[doc?.kind]?.lapse && Number.isFinite(t) && doc.raised_reask === doc.reask_count ? t + LAPSE_MS : Infinity;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// → { ok: true, githubId, homeTz, windows: ['08:00', …], decisionsDir, urgent: [kinds] } | { ok: false, reason }
export function readConfig(rules, product) {
  const get = (k) => rules?.get?.(k, { product });
  const githubId = rules?.num?.('accounts.joe.github_id', { product });   // the one number rule (L96 step 2)
  if (githubId === undefined || githubId <= 0) return { ok: false, reason: 'accounts.joe.github_id is missing or not a number' };
  const homeTz = get('accounts.joe.tz');
  if (!validZone(homeTz)) return { ok: false, reason: 'accounts.joe.tz is missing or not a time zone' };
  const windows = get('approvals.push_windows');
  if (!Array.isArray(windows) || !windows.length || !windows.every((w) => typeof w === 'string' && HHMM.test(w))) return { ok: false, reason: 'approvals.push_windows is missing or not a list of HH:MM times' };
  const decisionsDir = get('approvals.decisions_dir');
  if (typeof decisionsDir !== 'string' || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(decisionsDir) || decisionsDir.split('/').some((s) => s === '.' || s === '..')) return { ok: false, reason: 'approvals.decisions_dir is missing or not a plain folder path' };
  // approvals.urgent may only name urgent-capable tap kinds; anything else is ignored for the default (fail toward fast undo).
  const u = get('approvals.urgent');
  const urgent = Array.isArray(u) && u.length && u.every((k) => Object.hasOwn(ASK_KINDS, k) && ASK_KINDS[k].active && ASK_KINDS[k].channel === 'tap') ? [...new Set(u)] : [...URGENT_DEFAULT];
  return { ok: true, githubId, homeTz, windows: [...new Set(windows)].sort(), decisionsDir, urgent };
}

// The zone the windows are read in: the trip zone while the product is away, else home (round 1 m2).
export function zoneFor(cfg, productDoc) {
  const trip = productDoc?.state === 'away' ? productDoc?.away?.tz : undefined;
  return validZone(trip) ? trip : cfg.homeTz;
}

// The local calendar day and minute-of-day of `ms` in `tz`.
export function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

// The window that is due at `ms`: the latest window at or before now today, if it began no more than WINDOW_GRACE_MS ago
// → { key, start } | null. The key ("YYYY-MM-DD HH:MM", local) is the "sent" mark (round 1 m2: once per local day,
// never replayed).
export function dueWindow(ms, tz, windows) {
  const { day, minute } = localParts(ms, tz);
  const past = windows.map((w) => [w, Number(w.slice(0, 2)) * 60 + Number(w.slice(3))]).filter(([, m]) => m <= minute);
  if (!past.length) return null;
  const [w, m] = past.at(-1);
  // Minutes since the window began, in local wall time; a jump across a clock change only shortens or lengthens the grace.
  const since = (minute - m) * 60_000;
  if (since > WINDOW_GRACE_MS) return null;
  // `start` is when the window began; only asks that existed by then go out in it (the rest wait for the next one).
  return { key: `${day} ${w}`, start: ms - since - (ms % 60_000) };
}
