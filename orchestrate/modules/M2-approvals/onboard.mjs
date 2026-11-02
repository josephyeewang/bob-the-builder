// onboard.mjs — a product's record is made the first time its rules file says it is on (LEAD-CALLS L204-b, L209).
//
// WHY. Nothing made a product's record before: every module reads `product` in M9 and finds none, so a newly onboarded
// product never started. The one "on" switch is `onboarding.state: active` in the product's rules file (first-cutover.mjs
// requires it), and Approvals, which owns the product record's states, makes the record from it: state active, written
// as `approvals`, diary kind `onboard`.
//
//   onboard(ctx) → null | { type: 'onboarded', product } | { type: 'onboard_refused', product, reason }
//   ctx = { record, rules, product }
//
// Create-if-missing only (L209 1): a record in any state, a corrupt one included, is never touched, so a product the
// owner paused stays paused whatever its rules file says. Only the exact text `active` turns it on; a missing key, any
// other text or type, or rules that can't be read make nothing. Rules M10 kept from the last good file count (last_good).

export const ONBOARD_KEY = 'onboarding.state';

export function onboard(ctx) {
  if (ctx.record.read('product', ctx.product) !== null) return null;
  let on;
  try { on = ctx.rules?.get?.(ONBOARD_KEY, { product: ctx.product }); } catch { return null; }
  if (on !== 'active') return null;
  const w = ctx.record.write({ actor: 'approvals', entity: 'product', id: ctx.product, expectRev: 0, doc: { state: 'active' }, kind: 'onboard' });
  return w.ok ? { type: 'onboarded', product: ctx.product } : { type: 'onboard_refused', product: ctx.product, reason: w.reason };
}
