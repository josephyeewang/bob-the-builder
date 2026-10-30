// trip.mjs — the facts half of trip mode (R-0b-83; design v4 §7.2 R2; review-0b-8 MAT-8, MAT-9, minors 9, 10, 11).
//
// "I'm away until Friday" → the skill writes one `state-` file per product (away, until, tz; outbox.mjs) and replies
// "Checking the Mini, I'll send it in a minute." The Ledger then pushes the brief this file builds to Joe's phone,
// once per new set of state files (nextTripPush; lead call L22), and also writes it to a read-only file the skill can
// quote if Joe asks before the push arrives (the pass's wiring into lane 2's loop is a join item). This file decides
// the words; it reads the record and facts and writes nothing.
//
// Freshness without a clock (0b-8 audit round 3 M-3): the Front Door knows the date but not the time, so it can't
// test a brief's age. The brief's first line names the ids of the state files it answers (stateIds: the newest
// state file per product, written for this request); the skill quotes only a brief that names every id it wrote,
// which proves the brief was made after the request, and it repeats the made time so Joe sees its age.
//
// Mini check: each item is green only from a fact newer than an hour (FRESH_MIN); a missing or stale fact reads
// "unknown", never green. Merge hours: stated only for products on the Merge Gate (MAT-8); the Merge Gate, not this
// file, enforces them. Freeze wording only when Joe says the Mini is going off (minor 9).

import { cleanOutside } from '../M12-sensors/escape.mjs';
import { POWER_FACT } from '../M12-sensors/power-source.mjs';
import { STATUS_FACT } from '../M13-ledger/heartbeat.mjs';
import { waitingItems } from '../M13-ledger/waiting.mjs';
import { checkTimeZone } from './timezone.mjs';

export const FRESH_MIN = 60;
export const AIR_FACT = 'air-health';
export const AIR_FRESH_H = 24;
export const MERGE_HOURS = '07:00–22:00';
const OPEN_ASK = ['open', 'pushed'];

// A time in the future is a wrong clock: unknown, never fresh (round 2 minor 8).
const ageMin = (iso, now) => { const t = Date.parse(iso ?? ''); const a = Number.isFinite(t) ? (now - t) / 60e3 : Infinity; return a < -5 ? Infinity : Math.max(a, 0); };

export function miniCheck({ facts, heartbeatProduct, now = () => new Date() }) {
  const t = now().getTime();
  const hb = facts.get(STATUS_FACT(heartbeatProduct));
  const pw = facts.get(POWER_FACT);
  const hbFresh = hb && ageMin(hb.at, t) <= FRESH_MIN;
  const pwFresh = pw && ageMin(pw.at, t) <= FRESH_MIN;
  const stale = 'unknown (no fact from the last hour)';
  const items = [
    ['online', !hbFresh ? null : hb.front_door_reachable === true,
      !hbFresh ? stale : hb.front_door_reachable === true ? `yes, heartbeat ${Math.round(ageMin(hb.at, t))} min ago, Front Door reachable` : 'NO: the Front Door does not answer through the phone link'],
    ['logged in', !hbFresh ? null : Boolean(hb.signed_in && hb.login),
      !hbFresh ? stale : hb.signed_in && hb.login ? `yes, as ${hb.login}` : 'NO: the Mini is signed out of Claude'],
    ['battery backup', !pwFresh || pw.ups_present === null || pw.ups_present === undefined ? null : pw.ups_present === true,
      !pwFresh || pw.ups_present == null ? stale : pw.ups_present ? `yes${pw.on_ups_power ? ' (running on it now)' : ''}` : 'NO: no battery backup seen'],
  ].map(([name, green, text]) => ({ name, state: green === null ? 'unknown' : green ? 'green' : 'red', text }));
  return { green: items.every((i) => i.state === 'green'), items };
}


// Does this brief answer these state files? True only when its first line lists every id (round 3 M-3).
export function briefAnswers(text, ids) {
  const m = /; answers state files: ([0-9a-z, -]+)\.$/.exec(String(text ?? '').split('\n')[0]);
  if (!m || !Array.isArray(ids) || !ids.length) return false;
  const listed = new Set(m[1].split(', '));
  return ids.every((id) => listed.has(id));
}

// Lead call L22: the brief goes to Joe's phone as a push, once per new set of away files. states: [{ id, state }], the
// newest checked state file per product; only "away" ones count, so a plain pause never pushes a trip brief (0b-8
// audit round 5 M-1). lastPushedIds: the ids of the last brief pushed; lastFailedIds: the ids of the last failure
// pushed; build(ids) → the brief text. Returns { text, ids } to push, or null (nothing new). A brief that can't be
// built, or doesn't name every id, returns { text, ids, failed: true }: the Ledger pushes it and stores its ids as
// lastFailedIds, NOT lastPushedIds, so it keeps trying every pass and pushes the real brief once it builds (0b-8
// audit round 8 M-1); the failure itself is pushed once per id set (round 7 minor 1).
export const TRIP_FAILED_TEXT = 'The Mini could not build it. It tries again every few minutes and pushes the brief when it can.';
// The failure names the ids on its first line like a brief does, so the brief file can hold it and the skill quotes it
// when Joe says "brief" (0b-8 audit round 9 M-1: in the two-reply fallback a failure was otherwise never seen).
const failedText = (ids) => `Trip brief failed; answers state files: ${ids.join(', ')}.\n${TRIP_FAILED_TEXT}`;
export function nextTripPush({ states, lastPushedIds = [], lastFailedIds = [], build }) {
  const away = (Array.isArray(states) ? states : []).filter((s) => s?.state === 'away').map((s) => String(s.id));
  const ids = [...new Set(away)].sort();
  if (!ids.length) return null;
  const badId = ids.some((i) => !/^\d{8}-\d{4}-[a-z]{2}$/.test(i)); // a wiring bug: say so, never go quiet (round 9 minor 2)
  const last = new Set(Array.isArray(lastPushedIds) ? lastPushedIds : []);
  if (ids.every((x) => last.has(x))) return null;
  const failedBefore = new Set(Array.isArray(lastFailedIds) ? lastFailedIds : []);
  const fail = () => (ids.every((x) => failedBefore.has(x)) ? null : { text: badId ? failedText(['(not a file id)']) : failedText(ids), ids, failed: true });
  if (badId) return fail();
  let text;
  try { text = build(ids); } catch { return fail(); } // the reason is not quoted: it could carry record text
  return briefAnswers(text, ids) ? { text, ids } : fail();
}

// The one wording for "the Mini is turning off"; the skill says it word for word, because once the Mini is off it
// can't push a brief (0b-8 audit round 5 M-2; a test checks the skill carries it).
export const FREEZE_TEXT = 'The Mini is turning off: products freeze (nothing starts, nothing merges); the digest issue and the GitHub view stay as they were at the last update; the outside check will open one "heartbeat stale" issue. MAIN is not affected.';

export function airCheck({ facts, now = () => new Date() }) {
  // Dated by the Air's own check (M12-sensors/air-health.mjs; lead call L23), never by Joe's word or the take-in time.
  const a = facts.get(AIR_FACT);
  const h = ageMin(a?.checked_at, now().getTime()) / 60;
  const passed = a && Number.isInteger(a.red_count) && a.red_count === 0 && h <= AIR_FRESH_H;
  if (passed) return { passed: true, text: `Air health check: passed (0 red, checked on the Air ${a.checked_at}).` };
  const last = a?.checked_at ? `${a.checked_at}, ${a.red_count} red` : 'never';
  return { passed: false, text: `Air health check: not passed in the last ${AIR_FRESH_H} h; last check on the Air: ${last}.\n  Step: on the Air, open Claude Code, type /configaudit and press Return; it sends the result to the Mini itself.` };
}

// products: [{ name, on_merge_gate }]. tz: a checked IANA name or null. askExpiryH: from the rules (risky asks keep
// their own time limit while away).
export function buildTripBrief({ products, until = null, tz: tzIn = null, stateIds = [], rec, facts, heartbeatProduct, miniGoingOff = false, askExpiryH = 12, now = () => new Date() }) {
  const out = [];
  const made = now();
  const z = tzIn === null ? null : checkTimeZone(tzIn);
  const tz = z?.ok ? z.tz : null; // a zone that fails the check is no zone (round 2 minor 9)
  const ids = stateIds.filter((i) => /^\d{8}-\d{4}-[a-z]{2}$/.test(String(i)));
  out.push(`Brief made ${made.toISOString()}; answers state files: ${ids.join(', ') || 'none'}.`);
  out.push(`Trip mode: ${products.map((p) => p.name).join(', ') || 'no products'} set to away${until ? ` until ${until}` : ''}. Only your tap brings a product back to active.`);

  out.push('', 'Time zone:');
  // "Holds" is said only for a product the Merge Gate actually holds; before the second cutover nothing holds number
  // work, and saying so would make Joe believe it was held (0b-8 audit round 7 M-1).
  if (!tz) out.push('- Which time zone will you be in? Name a city, such as Europe/Prague.');
  for (const p of products) {
    if (typeof p.on_merge_gate !== 'boolean') out.push(`- ${p.name}: Merge Gate status unknown; ask before you leave.`);
    else if (!p.on_merge_gate) out.push(`- ${p.name} still merges the way you run it today; the hours rule starts at the second cutover.`);
    else if (tz) out.push(`- ${p.name}: number work merges only ${MERGE_HOURS} ${tz}; a go you don't answer holds; [Undo] still runs.`);
    else out.push(`- ${p.name}: number work holds until you answer; [Undo] still runs.`);
  }

  // M13's one waiting list (card, ask, go, merge, claim), only what waits on Joe (round 2 M-3, minor 12); an item with a
  // record error is shown, since it might be his. Risky asks have their own section below.
  const asks = rec.list('ask').filter(({ doc }) => doc && OPEN_ASK.includes(doc.state));
  const askIds = new Set(asks.map((a) => a.id));
  let goes; let listError = null;
  try { goes = waitingItems(rec).filter((i) => (i.record_error || String(i.who ?? '').toLowerCase() === 'joe') && !(i.entity === 'ask' && askIds.has(i.id))); } catch { goes = []; listError = 'RECORD ERROR: the waiting list could not be read'; }
  const link = (doc, what) => (doc?.link ? doc.link : `RECORD ERROR: no ${what} link in the record`);
  out.push('', `Waiting on your go (${listError ? 'unknown' : goes.length}):`);
  if (listError) out.push(`- ${listError}`);
  for (const i of goes) {
    const doc = rec.read(i.entity, i.id)?.doc;
    out.push(`- ${i.entity} ${i.id}: ${i.record_error ?? cleanOutside(String(i.what ?? ''), 'record-ask')} (${link(doc, i.entity === 'go' ? 'roadmap row' : 'record')})`);
  }
  if (!goes.length && !listError) out.push('- none');
  out.push('', `Open risky-act asks (${asks.length}); they still expire after ${askExpiryH} h while you are away:`);
  for (const { id, doc } of asks) out.push(`- ${id}: ${cleanOutside(String(doc.what ?? doc.wait?.what ?? ''), 'record-ask')} (${link(doc, 'pull request')})`);
  if (!asks.length) out.push('- none');

  out.push('');
  if (miniGoingOff) {
    out.push(FREEZE_TEXT);
  } else {
    const m = miniCheck({ facts, heartbeatProduct, now });
    out.push(`Mini check: ${m.green ? 'green' : 'NOT green'}`);
    for (const i of m.items) out.push(`- ${i.name}: ${i.text}`);
  }
  out.push('', airCheck({ facts, now }).text);
  return out.join('\n') + '\n';
}
