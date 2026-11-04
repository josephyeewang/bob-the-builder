// required-keys.mjs — the rules keys Approvals reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L86 2). M10's first-cutover fit check takes this list and runs readConfig, M2's own reader, so the
// two can't disagree; a test reads kinds.mjs's and onboard.mjs's text and fails on a key either reads that isn't listed
// here (L221 m-4). policyProblems checks readConfig's keys only: onboarding.state is never a reason to refuse rules.
//
//   REQUIRED_KEYS / OPTIONAL_KEYS, policyProblems(rules, product) → [] | every reason

import { readConfig } from './kinds.mjs';

export const REQUIRED_KEYS = Object.freeze([
  'accounts.joe.github_id',
  'accounts.joe.tz',
  'approvals.push_windows',     // HH:MM times, read in accounts.joe.tz
  'approvals.decisions_dir',    // the product's folder for decision and go files
]);

export const OPTIONAL_KEYS = Object.freeze([
  'approvals.urgent',           // missing (or naming a kind that can't be urgent) uses the default list
  // Read by onboard.mjs, not readConfig: exactly `active` makes a missing product record (L204-b, L209). Missing makes
  // nothing, which is normal for a product not yet on. The first cutover requires it (M10 first-cutover.mjs), not M2.
  'onboarding.state',
]);

export function policyProblems(rules, product) {
  const r = readConfig(rules, product);
  return r.ok ? [] : [`M2: ${r.reason}`];
}
