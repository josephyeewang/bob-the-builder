// rules.test-helper.mjs — the rules M9's tests run under: a full set of time limits and a rules fake. Kept apart from
// fixtures.test-helper.mjs so the child processes (child.test-helper.mjs) can load it without the test runner.

import { FINAL_STATES, STATES } from '../../shared/record.mjs';
import { fakeRules } from '../../shared/rules.mjs';

export const PRODUCT = 'sample-app';
export const HEAD = 'a'.repeat(40);
export const HEAD2 = 'b'.repeat(40);
export const UID = process.getuid();

// Every non-final state gets a limit; the ones with no natural limit say why (A4).
export function fullTimeouts(overrides = {}) {
  const t = {};
  for (const [entity, states] of Object.entries(STATES)) {
    t[entity] = {};
    for (const s of states) {
      if (FINAL_STATES[entity].includes(s)) continue;
      t[entity][s] = { minutes: 60, then: 'alert' };
    }
  }
  t.card.draft = { no_limit_reason: 'the Lead plans at its own pace', recheck_max_min: 1440 };
  t.card.waiting = { no_limit_reason: 'waits on someone else', recheck_max_min: 1440 };
  t.card.merged = { no_limit_reason: 'waits for the nightly audit', recheck_max_min: 1440 };
  for (const s of STATES.product) t.product[s] = { no_limit_reason: 'Joe sets it', recheck_max_min: 1440 };
  for (const [e, rows] of Object.entries(overrides)) Object.assign(t[e], rows);
  return t;
}

export function rulesFor(values = {}) {
  return fakeRules({ values: {
    timeouts: fullTimeouts(),
    'caps.rounds': 3,
    'claims.stuck_min': 30,
    'proposals.heartbeat_stale_min': 10,
    'approvals.plan_go.go_free': ['lead_daily_card', 'exact_reverse'],
    'product_state_rules.light.start': 'some',
    'product_state_rules.active.start': 'all',
    'product_state_rules.away.start': 'some',
    'product_state_rules.paused.start': 'none',
    ...values,
  } });
}
