// required-keys.mjs — the rules keys Approvals reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L86 2). M10's first-cutover fit check takes this list and runs readConfig, M2's own reader, so the
// two can't disagree; a test reads kinds.mjs's text and fails on a key readConfig reads that isn't listed here.
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
]);

export function policyProblems(rules, product) {
  const r = readConfig(rules, product);
  return r.ok ? [] : [`M2: ${r.reason}`];
}
