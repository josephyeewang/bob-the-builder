// trip.mjs — the facts half of trip mode (R-0b-83; design v4 §7.2 R2; review-0b-8 MAT-8, MAT-9, minors 9, 10, 11).
//
// "I'm away until Friday" → the skill writes one `state-` file per product (away, until, tz; outbox.mjs) and replies
// with the brief this file builds. The Front Door has no shell, so a Ledger pass writes the brief to a read-only file
// the skill reads and quotes (the pass's wiring into lane 2's loop is a join item). This file decides the words; it
// reads the record and facts and writes nothing.
//
// Mini check: each item is green only from a fact newer than an hour (FRESH_MIN); a missing or stale fact reads
// "unknown", never green. Merge hours: stated only for products on the Merge Gate (MAT-8); the Merge Gate, not this
// file, enforces them. Freeze wording only when Joe says the Mini is going off (minor 9).

import { cleanOutside } from '../M12-sensors/escape.mjs';
import { POWER_FACT } from '../M12-sensors/power-source.mjs';
import { STATUS_FACT } from '../M13-ledger/heartbeat.mjs';

export const FRESH_MIN = 60;
export const AIR_FACT = 'air-health';
export const AIR_TOLD_FRESH_H = 24;
export const MERGE_HOURS = '07:00–22:00';
const OPEN_ASK = ['open', 'pushed'];

const ageMin = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (now - t) / 60e3 : Infinity; };

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

export function airCheck({ facts, now = () => new Date() }) {
  const a = facts.get(AIR_FACT);
  const h = ageMin(a?.told_at, now().getTime()) / 60;
  const passed = a && Number.isInteger(a.red_count) && a.red_count === 0 && h <= AIR_TOLD_FRESH_H;
  if (passed) return { passed: true, text: `Air health check: passed (0 red, you told me ${a.told_at}).` };
  const last = a?.told_at ? `${a.told_at}, ${a.red_count} red` : 'never';
  return { passed: false, text: `Air health check: not known to the Mini; last result you told me: ${last}.\n  Step: on the Air, open Claude Code, type /configaudit and press Return; reply here with how many red items it shows.` };
}

// products: [{ name, on_merge_gate }]. tz: a checked IANA name or null. askExpiryH: from the rules (risky asks keep
// their own time limit while away).
export function buildTripBrief({ products, until = null, tz = null, rec, facts, heartbeatProduct, miniGoingOff = false, askExpiryH = 12, now = () => new Date() }) {
  const out = [];
  out.push(`Trip mode: ${products.map((p) => p.name).join(', ') || 'no products'} set to away${until ? ` until ${until}` : ''}. Only your tap brings a product back to active.`);

  out.push('', 'Time zone:');
  if (!tz) out.push('- Which time zone will you be in? Name a city, such as Europe/Prague. Until you answer, number work holds; [Undo] still runs.');
  for (const p of products) {
    if (!p.on_merge_gate) out.push(`- ${p.name} still merges the way you run it today; the hours rule starts at the second cutover.`);
    else if (tz) out.push(`- ${p.name}: number work merges only ${MERGE_HOURS} ${tz}; a go you don't answer holds; [Undo] still runs.`);
  }

  const goes = rec.list('go').filter(({ doc }) => doc && (doc.state === 'waiting' || doc.wait));
  const asks = rec.list('ask').filter(({ doc }) => doc && OPEN_ASK.includes(doc.state));
  const link = (doc, what) => (doc.link ? doc.link : `RECORD ERROR: no ${what} link in the record`);
  out.push('', `Waiting on your go (${goes.length}):`);
  for (const { id, doc } of goes) out.push(`- ${id}: ${cleanOutside(String(doc.wait?.what ?? doc.what ?? ''), 'record-ask')} (${link(doc, 'roadmap row')})`);
  if (!goes.length) out.push('- none');
  out.push('', `Open risky-act asks (${asks.length}); they still expire after ${askExpiryH} h while you are away:`);
  for (const { id, doc } of asks) out.push(`- ${id}: ${cleanOutside(String(doc.what ?? doc.wait?.what ?? ''), 'record-ask')} (${link(doc, 'pull request')})`);
  if (!asks.length) out.push('- none');

  out.push('');
  if (miniGoingOff) {
    out.push('The Mini is turning off: products freeze (nothing starts, nothing merges); the digest issue and the GitHub view stay as they were at the last update; the outside check will open one "heartbeat stale" issue. MAIN is not affected.');
  } else {
    const m = miniCheck({ facts, heartbeatProduct, now });
    out.push(`Mini check: ${m.green ? 'green' : 'NOT green'}`);
    for (const i of m.items) out.push(`- ${i.name}: ${i.text}`);
  }
  out.push('', airCheck({ facts, now }).text);
  return out.join('\n') + '\n';
}
