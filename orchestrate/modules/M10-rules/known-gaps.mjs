// known-gaps.mjs — the reasons the first-cutover fit check gives today that are not the rules file's fault (L96 m-D,
// L115). Each label goes on the end of the reason in the check's own output, so Joe reads "known, waits on X" and not
// "your file is wrong". The reason itself still counts: a file with a known gap is still refused. Each label goes when
// what it waits on lands; then this file shrinks, and at none left it is deleted.

export const KNOWN = Object.freeze({
  // yaml-lite has no numbers or flags: the real engine hands `n: 30` over as "30", and `shakedown: true` as "true" (L96).
  text: ' (known: rules numbers and flags arrive as text, L96; waits on step 2)',
  // M11 reads these per-product keys with no product; on the real engine a product key read that way is undefined
  // (L115 M-A). context.* is lane 2's. (usage.red_runs was lane 1's: #79 made it Mac-wide, so its label is gone, L131.)
  scopeContext: ' (known: M11 reads this key without the product, L115; waits on lane 2\'s L104 sweep)',
  // The Dispatcher keys that were NEW_KEYS, which the fit check skipped until #77 r5 MAT-1: M11 reads each with no
  // product, but the rules make it per product, so the real engine gives none (and the pace floor silently takes its
  // default). Whether each becomes Mac-wide in shared/rules.mjs or is read with the product is the lead's call (L144).
  scopeNew: ' (known: M11 reads this key without the product, L144; waits on the lead\'s scope call)',
});
// Each per-product key M11 still reads Mac-wide, and the label naming its owner (L125 c-1, L131), in M11 KEYS order. A key not here gets no
// label and no scope reason, so first-cutover.test's scope test fails on a new gap until it is placed here, and on a
// key here once M11 reads it with the product (then it comes off).
export const SCOPE_OWNERS = Object.freeze({
  'usage.pace_min_share': 'scopeNew',
  'timeouts.cancel_grace_min': 'scopeNew',
  'timeouts.park_wait_min': 'scopeNew',
  'timeouts.dead_quiet_min': 'scopeNew',
  'timeouts.claimed_no_session_min': 'scopeNew',
  'timeouts.checking_max_min': 'scopeNew',
  'timeouts.reporting_max_min': 'scopeNew',
  'timeouts.in_review_no_reviewer_min': 'scopeNew',
  'timeouts.front_door_stuck_min': 'scopeNew',
  'timeouts.usage_unknown_max_min': 'scopeNew',
  'outage.min_dead': 'scopeNew',
  'outage.share': 'scopeNew',
  'context.lead.soft': 'scopeContext',
  'context.lead.hard': 'scopeContext',
  'context.handoff_cap.role': 'scopeContext',
  'context.worker.split_after_compactions': 'scopeContext',
});
/** The scope label for a key M11 reads Mac-wide, naming that key's owner; '' for a key with no known gap. */
export const scopeLabel = (key) => (Object.hasOwn(SCOPE_OWNERS, key) ? KNOWN[SCOPE_OWNERS[key]] : '');

// A rules value the real engine gave as text that would be a number or a flag: "30", "0.5", "true", "false", not "",
// " 3", "3x" or "yes". Lists are left alone; a map's values are converted one level down (caps.per_state).
const NUM = /^(0|[1-9]\d*)(\.\d+)?$/;
const one = (x) => (typeof x !== 'string' ? x : NUM.test(x) ? Number(x) : x === 'true' ? true : x === 'false' ? false : x);
export const numeric = (v) => (typeof v === 'string' ? one(v)
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]))
    : v);

/** `rules` with each value it gives converted by numeric(): the rules as they will read once step 2 lands. */
export const asNumbers = (rules) => ({ get: (k, o) => numeric(rules.get(k, o)), classify: (c) => rules.classify(c) });
