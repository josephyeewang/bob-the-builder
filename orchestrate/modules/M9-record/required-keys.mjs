// required-keys.mjs — the rules keys the Record reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L86 2, 9; L96 M-1, m-2).
//
// WHY. The fit check once passed a rules file with which the Record would hold every card: no round cap, or no
// "may work start" line for a product state. So the Record's list holds every key ready.mjs and writer.mjs read
// (a drift test reads both files), and policyProblems runs the real readyCheck on one go-free card per state.
//
// go_free has two readers that read it differently: goFreeKinds (ready.mjs, also used by M6) takes the kinds, and
// M11 reads go_free.lead_daily_card as a list of file patterns. Only the map form works for both. The map may name
// only the kinds below, each with the value shape it says; any other key (`ordinary: true` would let the Lead's own
// cards skip the owner's go) or value is refused.
//
//   REQUIRED_KEYS, OPTIONAL_KEYS, GO_FREE, policyProblems(rules, product) → [] | every reason

import { goFreeKinds, readyCheck } from './ready.mjs';
import { CARD_CREATORS } from './permissions.mjs';
import { PRODUCT_STATES } from '../M10-rules/policy.mjs';
import { compile } from '../M10-rules/paths.mjs';

const GO_FREE_KEY = 'approvals.plan_go.go_free';

export const REQUIRED_KEYS = Object.freeze([
  GO_FREE_KEY,
  'caps.rounds',                                                     // ready.mjs, writer.mjs: no cap, no card is ready
  ...PRODUCT_STATES.map((s) => `product_state_rules.${s}.start`),   // ready.mjs: no line, no card starts in that state
  'timeouts',                                                        // writer.mjs: every state's time limit
  'proposals.heartbeat_stale_min',                                   // writer.mjs: a tab claim with no fresh heartbeat lapses
]);
export const OPTIONAL_KEYS = Object.freeze([
  'claims.stuck_min',   // writer.mjs: missing breaks no dead session's claim (it fails slow: the running limit ends it)
]);

// The kinds a go_free map may name, and the value each must have. `flag` = exactly true or false (false: needs a go).
export const GO_FREE = Object.freeze({
  exact_reverse: 'flag',
  research_copy: 'flag',
  lead_daily_card: 'patterns',   // M11's list of the daily card's files; [] when the Lead is not on the product
});

// Exactly true or false, as the rules file writes it (yaml-lite gives text). Replaced by rules.flag once M10 has it.
const flagOf = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

// Is this kind go-free in the rules? A known kind, with a value of its shape: a flag kind exactly true, a pattern kind a
// list. The value-reading rule that goFreeKinds (ready.mjs, lane 1's) is to adopt; until then the fit check holds
// files where the two would differ.
export function goFreeOn(rules, product, kind) {
  let v;
  try { v = rules.get(GO_FREE_KEY, { product }); } catch { return false; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, kind)) return false;
  if (GO_FREE[kind] === 'flag') return flagOf(v[kind]) === true;
  if (GO_FREE[kind] === 'patterns') return Array.isArray(v[kind]);
  return false;
}

function patternProblem(p) {
  if (typeof p !== 'string' || /[^\x20-\x7e]/.test(p)) return 'is not a plain-ASCII pattern';
  try { compile(p); return null; } catch (e) { return `can't be read: ${e.message}`; }
}

export function policyProblems(rules, product) {
  const get = (key) => { try { return rules.get(key, { product }); } catch { return undefined; } };
  const out = [];
  const v = get(GO_FREE_KEY);
  if (Array.isArray(v)) out.push(`M9: ${GO_FREE_KEY} must be a map (kind: true), not a list: M11 reads go_free.lead_daily_card from it`);
  else if (!v || typeof v !== 'object') out.push(`M9: ${GO_FREE_KEY} must be a map naming the kinds that need no go`);
  else {
    for (const [kind, value] of Object.entries(v)) {
      const shape = GO_FREE[kind];
      if (!shape) out.push(`M9: ${GO_FREE_KEY}.${kind} is not a go-free kind (only ${Object.keys(GO_FREE).join(', ')})`);
      else if (shape === 'flag' && flagOf(value) === undefined) out.push(`M9: ${GO_FREE_KEY}.${kind} must be true or false`);
      else if (shape === 'patterns') {
        if (!Array.isArray(value)) out.push(`M9: ${GO_FREE_KEY}.${kind} must be a list of file patterns`);
        else for (const p of value) { const why = patternProblem(p); if (why) out.push(`M9: ${GO_FREE_KEY}.${kind}: "${p}" ${why}`); }
      }
    }
  }
  // The real ready rule, on an undo card (made by the one actor that may make it) in each product state. A key the
  // fit check already names as missing is not said again; "no work starts" is a state's answer, not a gap; and
  // whether the undo needs a go is the go_free checks' to say (here and in M6).
  const absent = (k) => { const x = get(k); return x === undefined || x === null; };
  const byReason = new Map();
  // Only when the undo is go-free: otherwise the go_free checks have already said why, and the card would stop at the go.
  for (const state of goFreeKinds(rules, product).includes('exact_reverse') ? PRODUCT_STATES : []) {
    if (absent('caps.rounds') || absent(`product_state_rules.${state}.start`)) continue;
    const card = { id: 'C-fit', doc: { product, kind: 'exact_reverse', round: 1, depends_on: [] } };
    const view = {
      get: (entity) => (entity === 'product' ? { id: product, doc: { state } } : null),
      list: () => [],
      createdBy: () => Object.keys(CARD_CREATORS).find((a) => CARD_CREATORS[a].includes('exact_reverse')) ?? null,
    };
    const r = readyCheck(card, view, { rules, product });
    if (r.ok || / no work starts$/.test(r.reason) || /needs the owner's go$/.test(r.reason)) continue;
    const reason = r.reason.replace(` in a ${state} product`, '');
    byReason.set(reason, [...(byReason.get(reason) ?? []), state]);
  }
  for (const [reason, states] of byReason) out.push(`M9: no card is ever ready in a ${states.join(' or ')} product: ${reason}`);
  // writer.mjs's own rule for the tab heartbeat limit (a whole number of minutes, at least 1).
  const stale = get('proposals.heartbeat_stale_min');
  if (!Number.isInteger(stale) || stale < 1) out.push('M9: proposals.heartbeat_stale_min must be a whole number of minutes, at least 1');
  return [...new Set(out)];
}
