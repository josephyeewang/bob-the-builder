// onboard.mjs — a product's record is made the first time its rules file says it is on (LEAD-CALLS L204-b, L209, L221).
//
// WHY. Nothing made a product's record before: every module reads `product` in M9 and finds none, so a newly onboarded
// product never started. The one "on" switch is `onboarding.state: active` in the product's rules file (first-cutover.mjs
// requires it), and Approvals, which owns the product record's states, makes the record from it: state active, written
// as `approvals`, diary kind `onboard`. The Dispatcher's `approvals` step runs the schedule pass that calls this, every
// tick, before its main pass (M11 tick.mjs, L221 MAT-1).
//
//   onboard(ctx) → null | { type: 'onboarded', product } | { type: 'onboard_refused', product, reason }
//                       | { type: 'onboard_near_miss', product, value }
//   onboardNotices(ctx, made)   what Joe is told about it, each once (below)
//   ctx = { record, rules, product, alert, stateDir }
//
// Create-if-missing only (L209 1): a record in any state, a corrupt one included, is never touched, so a product the
// owner paused stays paused whatever its rules file says. Only the exact text `active` turns it on; a missing key, any
// other text or type, or rules that can't be read make nothing. Rules M10 kept from the last good file count (last_good).
//
// What Joe is told (L221 m-1, m-2, c-4), each sentence on ONBOARD_SHOWN (pinned in shared/no-promise.test.mjs):
//   - the record was made: one "now on" notice. It is marked due before it is sent and cleared only once the sink took
//     it, so a lost send is sent again next pass, never lost (a lost clear sends it twice);
//   - the key is there but is not exactly `active` (`Active`, `[active]`, `active `) and there is no record: one alert
//     per distinct value. A missing key stays silent: a product not yet onboarded is normal (L129);
//   - the create was refused: one alert per distinct reason (its numbers out, so a moving rev is one reason). M9's own
//     `refused` alert still goes out from the store each time; this one says which product was not turned on.
// Kept in ctx.stateDir (onboard-notices.json). With no stateDir nothing is kept, so each is told every pass.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ONBOARD_KEY = 'onboarding.state';
const NOTICES = 'onboard-notices.json';
const MAX_SEEN = 200;

const shownValue = (v) => {
  let s;
  try { s = JSON.stringify(v); } catch { s = undefined; }
  if (typeof s !== 'string') s = String(typeof v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

export const ONBOARD_SHOWN = Object.freeze({
  on: (p) => `${p} is now on: its rules file says onboarding.state: active.`,
  nearMiss: (p, v) => `${p} was not turned on: onboarding.state is ${shownValue(v)}, and only the exact word active turns a product on.`,
  refused: (p, reason) => `${p} was not turned on: ${reason}`,
});

export function onboard(ctx) {
  if (ctx.record.read('product', ctx.product) !== null) return null;
  // makeRules().get already answers undefined for rules it can't read (shared/rules.mjs), so no catch here: a get that
  // throws is a broken rules port, and the pass fails loudly through the Dispatcher's step-error alert.
  const on = ctx.rules?.get?.('onboarding.state', { product: ctx.product });
  if (on === undefined) return null;
  if (on !== 'active') return { type: 'onboard_near_miss', product: ctx.product, value: on };
  const w = ctx.record.write({ actor: 'approvals', entity: 'product', id: ctx.product, expectRev: 0, doc: { state: 'active' }, kind: 'onboard' });
  return w.ok ? { type: 'onboarded', product: ctx.product } : { type: 'onboard_refused', product: ctx.product, reason: w.reason };
}

function readNotices(ctx) {
  if (!ctx.stateDir) return { seen: [], due: false };
  try {
    const f = join(ctx.stateDir, NOTICES);
    const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    return { seen: Array.isArray(v?.seen) ? v.seen.filter((x) => typeof x === 'string') : [], due: v?.due === true };
  } catch { return { seen: [], due: false }; }
}

function saveNotices(ctx, n) {
  if (!ctx.stateDir) return;
  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(join(ctx.stateDir, NOTICES), `${JSON.stringify({ seen: n.seen.slice(-MAX_SEEN), due: n.due })}\n`);
}

const sent = (ctx, alert) => { try { return ctx.alert(alert) !== false; } catch { return false; } };

export function onboardNotices(ctx, made) {
  const p = ctx.product;
  const n = readNotices(ctx);
  if (made?.type === 'onboarded') { n.due = true; saveNotices(ctx, n); }
  if (n.due && sent(ctx, { type: 'product_on', product: p, text: ONBOARD_SHOWN.on(p) })) { n.due = false; saveNotices(ctx, n); }
  let key = null;
  let alert = null;
  if (made?.type === 'onboard_near_miss') {
    key = `value:${shownValue(made.value)}`;
    alert = { type: 'onboard_near_miss', product: p, text: ONBOARD_SHOWN.nearMiss(p, made.value) };
  } else if (made?.type === 'onboard_refused') {
    const reason = String(made.reason ?? 'no reason given');
    key = `refused:${reason.replace(/\d+/g, 'N')}`;
    alert = { type: 'onboard_refused', product: p, text: ONBOARD_SHOWN.refused(p, reason) };
  }
  if (!key || n.seen.includes(key)) return;
  if (sent(ctx, alert)) { n.seen.push(key); saveNotices(ctx, n); }
}
