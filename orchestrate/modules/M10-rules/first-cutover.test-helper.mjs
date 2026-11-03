// first-cutover.test-helper.mjs — the one home of the first-cutover rules fixture (R-0b-106a): M10's generic sample
// made into a first-cutover entry, with no product names. M10's first-cutover test and the day-one test
// (orchestrate/test/day-one.test.mjs, L96) both read it from here, so the two can never test different files.
//
//   SAMPLE          M10's generic sample rules file (fixtures/policy.yaml), as text
//   FIRST           the sample made into a first-cutover entry, as text (goes through the real parsePolicy)
//   ENTRY           its products.json line
//   PENDING         reasons the real readers give today on any rules file (known gaps in the readers, not the file)
//   fit(text, entry?, existing?)   firstCutoverProblems less PENDING
//   swap(text, from, to)           one text change that must find its target
//   MODULE_PART, TIMEOUT_MINUTES   the pieces FIRST adds to the sample

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstCutoverProblems } from './first-cutover.mjs';
import { scopeLabel } from './known-gaps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
export const swap = (t, from, to) => { assert.ok(t.includes(from), `text has ${from}`); return t.replace(from, to); };
export const ENTRY = { product: 'sample-app', owner: 'sample-org', repo: 'sample-app', joe_github_id: 1000001 };


// Reasons the real readers give today on any rules file, each a known gap in the readers, not in the file, and labeled
// so in the check's own output (known-gaps.mjs; L96 m-D, L115). They go as these land:
//   - M11's Mac-wide reads of per-product keys (L115 M-A, L131, L144): lane 2's L104 sweep passes the product at the
//     three context.* reads left (the time limits and context.worker.split_after_compactions went with #68). (usage.red_runs's went with #79, and the Dispatcher-wide
//     NEW_KEYS with #94, which made them Mac-wide in shared/rules.mjs.)
//   (Numbers and flags as text went with #94: M11 reads through num/dec/flag, L148.)
// The test 'the pending reasons are exactly these' then fails, and this list is cut to what is left; at [] the todo
// test below passes.
export const SCOPE = (k) => `M11: ${k} is read without the product, so the real engine gives none${scopeLabel(k)}`;
// (The six per-product time limits M11 read without the product went with #68: merges.mjs and pass.mjs read each for
// its product, and timeouts.claimed_no_session_min is no longer read; L144, lane 2's L104 O-1 step 2.)
export const PENDING = Object.freeze([
  SCOPE('context.lead.soft'), SCOPE('context.lead.hard'), SCOPE('context.handoff_cap.role'),
]);
export const fit = (...a) => firstCutoverProblems(...a).filter((x) => !PENDING.includes(x));

// The keys the merge gate (M6), Approvals (M2), the Record (M9) and the Dispatcher (M11) read (L86): go_free in the
// map form, the only one both of its readers can use.
export const MODULE_PART = `
product_profile:
  required_checks: [build, test]
  robot:
    bot_user_id: 1000099
approvals:
  plan_go:
    go_free:
      exact_reverse: true
      lead_daily_card: []
  push_windows: ['08:00', '17:00']
  decisions_dir: docs/decisions
proposals:
  heartbeat_stale_min: 30
  outbox: /srv/sample-app/proposals
outage:
  min_dead: 2
  share: 0.5
context:
  lead:
    soft: 120000
    hard: 160000
  handoff_cap:
    role: 3
  worker:
    split_after_compactions: 2
claims:
  stuck_min: 30
`;

// The Dispatcher's single minute limits (M11 keys.mjs), each a whole number under timeouts.
export const TIMEOUT_MINUTES = ['cancel_grace_min: 10', 'park_wait_min: 60', 'dead_quiet_min: 20',
  'checking_max_min: 60', 'reporting_max_min: 30', 'in_review_no_reviewer_min: 60', 'front_door_stuck_min: 30',
  'usage_unknown_max_min: 30'].map((l) => `  ${l}\n`).join('');

// The sample made into a first-cutover entry: no lead lane, no editing, no import list, the modules' keys given.
export const FIRST = [
  (t) => swap(t, '  lead:\n    - docs/blueprint/**\n', ''),
  (t) => swap(t, 'editing_per_product: 3', 'editing_per_product: 0'),
  (t) => swap(t, '    package_imports: [nodemailer, twilio]\n', ''),
  (t) => swap(t, '  shakedown_workers: 1\n', '  shakedown_workers: 1\n  per_state:\n    active: 1\n    away: 1\n    paused: 0\n    light: 1\n'),
  (t) => swap(t, '  stale_after_min: 15\n', '  stale_after_min: 15\n  red_runs: [undo]\n'),
  // The Dispatcher's keys that were NEW_KEYS, which the fit check skipped until #77 r5 MAT-1 (they had no values here).
  (t) => swap(t, '  shakedown_workers: 1\n', '  shakedown_workers: 1\n  shakedown: true\n'),
  (t) => swap(t, '      own_building_share: 70\n', '      own_building_share: 70\n      editing_per_product: 1\n      editing_per_mac: 2\n'),
  (t) => swap(t, '  red_runs: [undo]\n', '  red_runs: [undo]\n  pace_min_share: 0.143\n'),
  (t) => swap(t, '\ntimeouts:\n', `\ntimeouts:\n${TIMEOUT_MINUTES}`),
  (t) => `${t}${MODULE_PART}`,
].reduce((t, f) => f(t), SAMPLE);
