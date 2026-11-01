// required-keys.mjs — the rules keys the merge gate reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L86 2, 9, 10).
//
// WHY. M10's first-cutover fit check once passed a rules file the gate could not use: no robot id, no go_free, so
// every undo would be refused. The fit check now asks each module that reads the rules, with that module's own list
// and its own reading code, instead of keeping a list of its own.
//
//   REQUIRED_KEYS   the keys the gate can't work without
//   OPTIONAL_KEYS   keys the gate reads but handles when missing (each says what happens)
//   policyProblems(rules, product) → [] when the gate can use these rules, else every reason it can't
//
// gather.mjs does the reads; #67 and #68 edit it, so this file is new and a test reads gather.mjs's text to tie the
// two together until gather imports this list.

import { botId } from './gather.mjs';
import { goFreeKinds } from '../M9-record/ready.mjs';
import { goFreeOn, GO_FREE_KEY } from '../M9-record/ready.mjs';

export const REQUIRED_KEYS = Object.freeze([
  'product_profile.required_checks',      // with none, every change is refused (refusals 1, 2)
  'product_profile.robot.bot_user_id',    // the robot's numeric id: an undo's merge mark is read by it
  GO_FREE_KEY,                            // must name exact_reverse, or every undo is refused (refusal 10)
]);

export const OPTIONAL_KEYS = Object.freeze([
  'product.cutover_stage',                // missing reads as first
  'product_profile.checks_ignored',       // missing ignores none
  'effect_paths',                         // first_customer_visible.new_files_under; missing makes that fact unknown
  'rules.adopted',                        // the engine's own answer, not a key in the file
]);

export function policyProblems(rules, product) {
  const get = (key) => { try { return rules.get(key, { product }); } catch { return undefined; } };
  const out = [];
  const checks = get('product_profile.required_checks');
  // gather.mjs:142 reads a list of check names. An empty list is the fit check's policy line (L96 m-1), not the gate's.
  if (!Array.isArray(checks) || !checks.every((c) => typeof c === 'string' && c)) out.push('M6: product_profile.required_checks must be a list of check names');
  if (botId(get('product_profile.robot')) === null) out.push('M6: product_profile.robot.bot_user_id must be the robot\'s numeric id');
  if (!goFreeKinds(rules, product).includes('exact_reverse') || !goFreeOn(rules, product, 'exact_reverse')) out.push(`M6: ${GO_FREE_KEY}.exact_reverse must be true at the first cutover`);
  return out;
}
