// Every rules key the Dispatcher reads, in one place (design v4 §14.1.6; review 0b-6). The numbers
// live only in the rules file: this file names them and never holds a value, except the two
// defaults the lead set (L13 `usage.pace_min_share`; the review's fail-closed `caps.shakedown`).
//
// A key the rules don't answer is a refusal, never a guess: `need()` throws `MissingKey`, and the
// pass turns that into "start nothing" with a diary line. Mac-wide keys come back as the strictest
// value across products (rail A6); that is the rules' job, not this file's.

export const KEYS = Object.freeze({
  // usage bands (§5.4, review M1–M3, M23)
  redPace: 'usage.bands.red.pace',
  redWeek: 'usage.bands.red.week',
  redH5: 'usage.bands.red.h5',
  amberPace: 'usage.bands.amber.pace',
  amberWeek: 'usage.bands.amber.week',
  amberH5: 'usage.bands.amber.h5',
  ownBuildingShare: 'usage.bands.amber.own_building_share',
  amberEditingPerProduct: 'usage.bands.amber.editing_per_product',
  amberEditingPerMac: 'usage.bands.amber.editing_per_mac',
  reservePct: 'usage.reserve_pct.until_phase_2',
  noTier1ProdAbove: 'usage.no_tier1_prod_above',
  staleAfterMin: 'usage.stale_after_min',
  paceMinShare: 'usage.pace_min_share',
  redRuns: 'usage.red_runs',
  // caps (§14.1.6, review M14, M20)
  editingPerProduct: 'caps.editing_per_product',
  editingPerMac: 'caps.editing_per_mac',
  perState: 'caps.per_state',
  shakedown: 'caps.shakedown',
  shakedownWorkers: 'caps.shakedown_workers',
  scriptsPerProduct: 'caps.scripts_per_product',
  scriptsPerMac: 'caps.scripts_per_mac',
  readonlyPerSession: 'caps.readonly_per_session',
  // the Lead's daily card's files (review M13)
  leadDailyCard: 'approvals.plan_go.go_free.lead_daily_card',
  // time limits, in minutes (v3 §2.4, review M7, M9, M11)
  cancelGraceMin: 'timeouts.cancel_grace_min',
  parkWaitMin: 'timeouts.park_wait_min',
  deadQuietMin: 'timeouts.dead_quiet_min',
  claimedNoSessionMin: 'timeouts.claimed_no_session_min',
  checkingMaxMin: 'timeouts.checking_max_min',
  reportingMaxMin: 'timeouts.reporting_max_min',
  inReviewNoReviewerMin: 'timeouts.in_review_no_reviewer_min',
  frontDoorStuckMin: 'timeouts.front_door_stuck_min',
  usageUnknownMaxMin: 'timeouts.usage_unknown_max_min',
  // outage (review M9)
  outageMinDead: 'outage.min_dead',
  outageShare: 'outage.share',
  // session size (§5.5, review M17–M19)
  leadSoft: 'context.lead.soft',
  leadHard: 'context.lead.hard',
  handoffCapRole: 'context.handoff_cap.role',
  splitAfterCompactions: 'context.worker.split_after_compactions',
});

// Keys §14.1.6 does not have yet. Lane 1 adds them to the rules schema; until then a test passes
// them through `fakeRules({ values })`.
export const NEW_KEYS = Object.freeze([
  KEYS.paceMinShare, KEYS.shakedown, KEYS.amberEditingPerProduct, KEYS.amberEditingPerMac,
  KEYS.cancelGraceMin, KEYS.parkWaitMin, KEYS.deadQuietMin, KEYS.claimedNoSessionMin, KEYS.checkingMaxMin,
  KEYS.reportingMaxMin, KEYS.inReviewNoReviewerMin, KEYS.frontDoorStuckMin, KEYS.usageUnknownMaxMin, KEYS.outageMinDead, KEYS.outageShare,
]);

// The only defaults: the lead's L13 pace floor (one day of seven), and shakedown on until the
// rules say off (review M14). Every other missing key refuses.
const DEFAULTS = Object.freeze({ [KEYS.paceMinShare]: 0.143, [KEYS.shakedown]: true });

export class MissingKey extends Error {
  constructor(key) { super(`the rules have no value for ${key}`); this.key = key; }
}

// The keys whose value may have a fraction: shares, paces and percentages. They are read with dec(); every other
// number (a cap, a count, minutes, a token size) is a whole number, read with num() (L123). The rules file is text, so
// `1.0` there is the text "1.0": a decimal, never a whole number.
export const DECIMAL_KEYS = Object.freeze([
  KEYS.redPace, KEYS.redWeek, KEYS.redH5, KEYS.amberPace, KEYS.amberWeek, KEYS.amberH5, KEYS.ownBuildingShare,
  KEYS.reservePct, KEYS.noTier1ProdAbove, KEYS.paceMinShare, KEYS.outageShare,
]);

/**
 * A value from the rules, typed, or throws MissingKey (L123). Numbers go through rules.num() or rules.dec() and the
 * flag through rules.flag(), so the text the rules file gives ("30", "0.5", "false") reads as the value it names, and
 * anything else is missing. A default applies only when the rules have no value at all, never over a bad one.
 */
export function need(rules, key, { product, type = 'number' } = {}) {
  const opts = product ? { product } : {};
  const raw = rules.get(key, opts);
  if (raw === undefined && Object.hasOwn(DEFAULTS, key)) return DEFAULTS[key];
  let v;
  if (type === 'number') v = DECIMAL_KEYS.includes(key) ? rules.dec(key, opts) : rules.num(key, opts);
  else if (type === 'boolean') v = rules.flag(key, opts);
  else if (type === 'list') v = Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? raw : undefined;
  else if (type === 'object') v = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
  if (v === undefined) throw new MissingKey(key);
  return v;
}

/** Minutes from the rules (a whole number), as milliseconds. */
export const minutes = (rules, key, opts) => need(rules, key, opts) * 60_000;
