// required-keys.mjs — the rules key the Record's ready check reads for go-free kinds (LEAD-CALLS L86 2, 9).
//
// go_free has two readers that read it differently: goFreeKinds (ready.mjs, also used by M6) takes a list or a map's
// keys, while M11 reads go_free.lead_daily_card as a list of file patterns. Only the map form works for both, so a
// rules file must use the map form; the list form would silently hold every undo in M11.
//
//   REQUIRED_KEYS, policyProblems(rules, product) → [] | every reason

import { goFreeKinds } from './ready.mjs';

export const REQUIRED_KEYS = Object.freeze([
  'approvals.plan_go.go_free',
]);
export const OPTIONAL_KEYS = Object.freeze([]);

export function policyProblems(rules, product) {
  let v;
  try { v = rules.get('approvals.plan_go.go_free', { product }); } catch { v = undefined; }
  if (Array.isArray(v)) return ['M9: approvals.plan_go.go_free must be a map (kind: true), not a list: M11 reads go_free.lead_daily_card from it'];
  if (!v || typeof v !== 'object' || !goFreeKinds(rules, product).length) return ['M9: approvals.plan_go.go_free must be a map naming the kinds that need no go'];
  return [];
}
