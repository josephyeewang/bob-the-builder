// known-gaps.mjs — the reasons the first-cutover fit check gives today that are not the rules file's fault (L96 m-D,
// L115). Each label goes on the end of the reason in the check's own output, so Joe reads "known, waits on X" and not
// "your file is wrong". The reason itself still counts: a file with a known gap is still refused. Each label goes when
// what it waits on lands; then this file shrinks, and at none left it is deleted.

export const KNOWN = Object.freeze({
  // M11 reads these per-product keys with no product; on the real engine a product key read that way is undefined
  // (L115 M-A). context.* is lane 2's. (usage.red_runs was lane 1's: #79 made it Mac-wide, so its label is gone, L131.)
  scopeContext: ' (known: M11 reads this key without the product, L115; waits on lane 2\'s L104 sweep)',
  // Dispatcher time limits that were NEW_KEYS, which the fit check skipped until #77 r5 MAT-1: M11 reads each with no
  // product (merges.mjs, pass.mjs), but the rules make it per product, so the real engine gives none. #94 made the
  // Dispatcher-wide ones Mac-wide in shared/rules.mjs (L131); these stay per product, and lane 2 passes the product.
  scopeNew: ' (known: M11 reads this key without the product, L144; waits on lane 2\'s L104 O-1 step 2)',
});
// Each per-product key M11 still reads Mac-wide, and the label naming its owner (L125 c-1, L131), in M11 KEYS order. A key not here gets no
// label and no scope reason, so first-cutover.test's scope test fails on a new gap until it is placed here, and on a
// key here once M11 reads it with the product (then it comes off).
export const SCOPE_OWNERS = Object.freeze({
  'timeouts.cancel_grace_min': 'scopeNew',
  'timeouts.park_wait_min': 'scopeNew',
  'timeouts.claimed_no_session_min': 'scopeNew',
  'timeouts.checking_max_min': 'scopeNew',
  'timeouts.reporting_max_min': 'scopeNew',
  'timeouts.in_review_no_reviewer_min': 'scopeNew',
  'context.lead.soft': 'scopeContext',
  'context.lead.hard': 'scopeContext',
  'context.handoff_cap.role': 'scopeContext',
  'context.worker.split_after_compactions': 'scopeContext',
});
/** The scope label for a key M11 reads Mac-wide, naming that key's owner; '' for a key with no known gap. */
export const scopeLabel = (key) => (Object.hasOwn(SCOPE_OWNERS, key) ? KNOWN[SCOPE_OWNERS[key]] : '');
