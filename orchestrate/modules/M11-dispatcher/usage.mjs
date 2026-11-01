// Usage bands (R-0b-67; design v4 §5.4, rail A8, G3; review 0b-6 M1–M5, M8, M23, m14, m17; lead L13, L14).
//
// Reads the record fact `usage-<account>` that Sensors writes (lane 3, the M5 contract):
//   { account, h5: { used_pct, resets_at }, week: { used_pct, resets_at }, observed_at, source }
// and turns it into two separate values (M3): `band` (green | amber | red | unknown), which Joe's own
// tabs read, and `own_building` (open | amber | full | unknown), which gates only the work the
// Dispatcher itself starts. Writing red into `band` at the reserve line would stop Joe's tabs too.
//
// Unknown is never zero (A8): no fact, the wrong account, a reading older than stale_after_min by its
// own `observed_at` (never the file's time), a window whose reset time has passed (m14), or any field
// that is not a number or a time. Unknown counts as amber for ORCHESTRATE starts and blocks Tier-1
// starts and Tier-1 production merge requests (L14).

import { KEYS, need, minutes } from './keys.mjs';
import { sensorsFact } from './sensor-facts.mjs';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const H5_MS = 5 * 60 * 60_000;

export const BANDS = Object.freeze(['green', 'amber', 'red', 'unknown']);
export const USAGE_FACT = (account) => `usage-${account}`;
export const BAND_FACT = 'band-usage';

const pct = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100;
const time = (s) => (typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) ? Date.parse(s) : NaN);

/** Checks the fact's shape and age. Returns { ok, week, h5, weekResets, reason }. */
export function readFact(fact, { account, now, staleMs }) {
  if (!account) return { ok: false, reason: 'no signed-in account is known' };
  const d = fact?.doc;
  if (!d) return { ok: false, reason: `no usage reading for ${account}` };
  if (d.account !== account) return { ok: false, reason: `the usage reading is for another account (${d.account})` };
  const seen = time(d.observed_at);
  if (!Number.isFinite(seen)) return { ok: false, reason: 'the usage reading has no time' };
  if (seen > now + 60_000) return { ok: false, reason: 'the usage reading is from the future' };
  if (now - seen > staleMs) return { ok: false, reason: 'the usage reading is stale' };
  for (const [name, w, span] of [['5-hour', d.h5, H5_MS], ['week', d.week, WEEK_MS]]) {
    if (!w || !pct(w.used_pct)) return { ok: false, reason: `the ${name} figure is not a percent` };
    const r = time(w.resets_at);
    if (!Number.isFinite(r)) return { ok: false, reason: `the ${name} reset time is missing` };
    if (r <= now) return { ok: false, reason: `the ${name} window has reset since the reading` };
    if (r - now > span) return { ok: false, reason: `the ${name} reset time is further away than the window` };
  }
  return { ok: true, week: d.week.used_pct, h5: d.h5.used_pct, weekResets: time(d.week.resets_at) };
}

/**
 * The bands, from a checked reading. Thresholds come from the rules (Mac-wide, strictest across
 * products); a missing key throws MissingKey and the pass starts nothing.
 */
export function bands({ rules, reading, now }) {
  const t = {
    redPace: need(rules, KEYS.redPace), redWeek: need(rules, KEYS.redWeek), redH5: need(rules, KEYS.redH5),
    amberPace: need(rules, KEYS.amberPace), amberWeek: need(rules, KEYS.amberWeek), amberH5: need(rules, KEYS.amberH5),
    share: need(rules, KEYS.ownBuildingShare), reserve: need(rules, KEYS.reservePct),
    prodAbove: need(rules, KEYS.noTier1ProdAbove), paceMin: need(rules, KEYS.paceMinShare),
  };
  if (!reading.ok) {
    return { band: 'unknown', own_building: 'unknown', pace: null, prodBlocked: true, reason: reading.reason };
  }
  const { week, h5, weekResets } = reading;
  // Share of the week gone, from the weekly reset time (M1). Pace counts only once the floor is
  // passed (L13); before then only the week and 5-hour figures apply.
  const gone = 1 - (weekResets - now) / WEEK_MS;
  const pace = gone >= t.paceMin && gone > 0 ? week / 100 / gone : null;
  const unreserved = 100 - t.reserve;
  const own = week >= unreserved ? 'full' : week >= (t.share / 100) * unreserved ? 'amber' : 'open';
  const why = [];
  let band = 'green';
  if ((pace !== null && pace > t.redPace) || week >= t.redWeek || h5 >= t.redH5) {
    band = 'red';
    if (pace !== null && pace > t.redPace) why.push(`pace ${pace.toFixed(2)}`);
    if (week >= t.redWeek) why.push(`week ${week}%`);
    if (h5 >= t.redH5) why.push(`5-hour ${h5}%`);
  } else if ((pace !== null && pace > t.amberPace) || week >= t.amberWeek || h5 >= t.amberH5) {
    band = 'amber';
    if (pace !== null && pace > t.amberPace) why.push(`pace ${pace.toFixed(2)}`);
    if (week >= t.amberWeek) why.push(`week ${week}%`);
    if (h5 >= t.amberH5) why.push(`5-hour ${h5}%`);
  }
  // Own building never moves `band` (M3: Joe's tabs read band). The review's M2 also lists it as an
  // amber trigger, but its own plant (week 50 → green) needs it kept apart; see README.
  if (own !== 'open') why.push(`own building ${own}`);
  return { band, own_building: own, pace, week, h5, prodBlocked: week > t.prodAbove || h5 > t.prodAbove, reason: why.join(', ') || 'within every line' };
}

/** Reads the fact and works out the bands. */
export function currentBands({ rec, rules, account, now }) {
  const staleMs = minutes(rules, KEYS.staleAfterMin);
  const reading = readFact(account ? sensorsFact(rec, USAGE_FACT(account)) : null, { account, now, staleMs });
  return bands({ rules, reading, now });
}

/**
 * What each band lets the Dispatcher start (rail G3, review M3, M4, M23, m2, m17). `kind` is one of
 * editing | script | overnight | readonly | review | audit | merge | undo | undo_merge | lead | front_door.
 * Running work is never stopped by amber; red parks running cards elsewhere (pass.mjs).
 */
export function mayStart({ b, kind, tier, risky = [], repair = false, redRuns }) {
  // Fail closed (audit 0b-6 MAT-3): only an explicit Tier 2 is Tier 2. A missing or unknown tier counts
  // as Tier 1 for every hold. `tier: null` means "no card" (a Lead's read-only session).
  const t1 = tier !== 2 && tier !== null;
  const tier1Prod = t1 && (risky.includes('production_data') || risky.includes('schema') || repair);
  const finishing = ['review', 'audit', 'merge'].includes(kind);
  // An undo, and the merge request for a finished undo (audit 0b-6 r2 MAT-4), are never held.
  if (kind === 'undo' || kind === 'undo_merge') return { ok: true };
  if (tier1Prod && b.band === 'unknown') return { ok: false, reason: 'usage is unknown: no Tier-1 production work' };
  if (tier1Prod && b.prodBlocked) return { ok: false, reason: 'no Tier-1 production work above the usage line' };
  if (kind === 'lead' || kind === 'front_door') return { ok: true };
  if (finishing) {
    if (b.band === 'red' && !redRuns.includes(`${kind}s`)) return { ok: false, reason: `the red band holds ${kind}s` };
    if (kind !== 'merge' && t1 && b.band === 'unknown') return { ok: false, reason: 'usage is unknown: no Tier-1 start' };
    return { ok: true };
  }
  if (b.band === 'red') return { ok: false, reason: 'the red band: nothing new starts' };
  if (t1 && b.band === 'unknown') return { ok: false, reason: 'usage is unknown: no Tier-1 start' };
  if (kind === 'readonly') return { ok: true };
  // Own building: new editing workers, scripts and overnight runs the Dispatcher starts.
  if (b.own_building === 'full') return { ok: false, reason: 'ORCHESTRATE has used its share of the week' };
  const amberish = b.band !== 'green' || b.own_building !== 'open';
  if ((kind === 'script' || kind === 'overnight') && amberish) return { ok: false, reason: `no new ${kind === 'script' ? 'scripts' : 'overnight runs'} outside the green band` };
  if (kind === 'editing') return { ok: true, amberCaps: amberish };
  return kind === 'script' || kind === 'overnight' ? { ok: true } : { ok: false, reason: `unknown kind ${kind}` };
}

/** Writes the `band-usage` fact when the band or own-building value changed; keeps unknown_since. */
export function recordBands({ rec, b, now, account }) {
  const cur = rec.read('fact', BAND_FACT);
  const prev = cur?.doc;
  const unknownSince = b.band === 'unknown' ? (prev?.band === 'unknown' && prev.unknown_since ? prev.unknown_since : new Date(now).toISOString()) : null;
  if (prev && prev.band === b.band && prev.own_building === b.own_building) return { ok: true, unchanged: true, unknownSince };
  const doc = { band: b.band, own_building: b.own_building, reason: b.reason, account: account ?? null, decided_at: new Date(now).toISOString(), unknown_since: unknownSince };
  const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: BAND_FACT, expectRev: cur?.rev ?? 0, doc, kind: 'usage_band' });
  return { ...w, unknownSince };
}

export const _test = { WEEK_MS, H5_MS };
