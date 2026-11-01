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
  checkingMaxMin: 'timeouts.checking_max_min',
  // how long an interrupted merge's PR may still show open before it is refused-interrupted (L85 M-1 a)
  mergingOpenMaxMin: 'timeouts.merging_open_max_min',
  reportingMaxMin: 'timeouts.reporting_max_min',
  inReviewNoReviewerMin: 'timeouts.in_review_no_reviewer_min',
  frontDoorStuckMin: 'timeouts.front_door_stuck_min',
  usageUnknownMaxMin: 'timeouts.usage_unknown_max_min',
  // claims (L72): the quiet time before a dead owner's claim is broken (M9 breakIfDead reads it; read here so a missing
  // value is told). A claim whose session never started lapses at M9's claims.unlaunched_min, which has a default.
  claimsStuckMin: 'claims.stuck_min',
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
  KEYS.cancelGraceMin, KEYS.parkWaitMin, KEYS.deadQuietMin, KEYS.checkingMaxMin, KEYS.mergingOpenMaxMin,
  KEYS.reportingMaxMin, KEYS.inReviewNoReviewerMin, KEYS.frontDoorStuckMin, KEYS.usageUnknownMaxMin, KEYS.outageMinDead, KEYS.outageShare,
]);

// The only defaults: the lead's L13 pace floor (one day of seven), and shakedown on until the
// rules say off (review M14). Every other missing key refuses.
const DEFAULTS = Object.freeze({ [KEYS.paceMinShare]: 0.143, [KEYS.shakedown]: true });

export class MissingKey extends Error {
  constructor(key) { super(`the rules have no value for ${key}`); this.key = key; }
}

/** A number (or the given type) from the rules, or throws MissingKey. */
export function need(rules, key, { product, type = 'number' } = {}) {
  let v = rules.get(key, product ? { product } : {});
  if (v === undefined && Object.hasOwn(DEFAULTS, key)) v = DEFAULTS[key];
  const ok = type === 'number' ? typeof v === 'number' && Number.isFinite(v) && v >= 0
    : type === 'boolean' ? typeof v === 'boolean'
      : type === 'list' ? Array.isArray(v) && v.every((x) => typeof x === 'string')
        : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : false;
  if (!ok) throw new MissingKey(key);
  return v;
}

/** Minutes from the rules, as milliseconds. */
export const minutes = (rules, key, opts) => need(rules, key, opts) * 60_000;
