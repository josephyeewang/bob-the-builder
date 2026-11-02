// required-keys.mjs — the rules keys the Record reads, and whether a product's rules give it what it needs
// (LEAD-CALLS L86 2, 9; L96 M-1, m-2).
//
// WHY. The fit check once passed a rules file with which the Record would hold every card: no round cap, or no
// "may work start" line for a product state. So the Record's list holds every key ready.mjs and writer.mjs read
// (a drift test reads both files), and policyProblems runs the real readyCheck on one go-free card per state.
//
// go_free is read per kind: goFreeOn (ready.mjs, also used by M6) reads go_free.<kind> for each kind, and M11 reads
// go_free.lead_daily_card as a list of file patterns. Only the map form works for both. The map may name only the
// kinds in ready.mjs's GO_FREE, each with the value shape it says; any other key (`ordinary: true` would let the Lead's
// own cards skip the owner's go) or value is refused. GO_FREE, GO_FREE_KEY, goFreeOn and heartbeatLimit are #79's, in
// ready.mjs and writer.mjs; this file imports them and holds no copy (L123).
//
//   REQUIRED_KEYS, OPTIONAL_KEYS, policyProblems(rules, product) → [] | every reason

import { GO_FREE, GO_FREE_KEY, goFreeKinds, readyCheck } from './ready.mjs';
import { heartbeatLimit } from './writer.mjs';
import { CARD_CREATORS } from './permissions.mjs';
import { PRODUCT_STATES } from '../M10-rules/policy.mjs';
import { compile } from '../M10-rules/paths.mjs';

export const REQUIRED_KEYS = Object.freeze([
  GO_FREE_KEY,
  'caps.rounds',                                                     // ready.mjs, writer.mjs: no cap, no card is ready
  ...PRODUCT_STATES.map((s) => `product_state_rules.${s}.start`),   // ready.mjs: no line, no card starts in that state
  'timeouts',                                                        // writer.mjs: every state's time limit
  'proposals.heartbeat_stale_min',                                   // writer.mjs: a tab claim with no fresh heartbeat lapses
]);
export const OPTIONAL_KEYS = Object.freeze([
  'claims.stuck_min',   // writer.mjs: missing breaks no dead session's claim (it fails slow: the running limit ends it)
  'claims.unlaunched_min',   // writer.mjs: missing uses UNLAUNCHED_MIN_DEFAULT; set but not a positive whole number refuses
]);

// A pattern as the reason prints it: text in quotes; anything else (a map, a list, null) is named, never converted, since
// yaml-lite's maps have no prototype and can't be turned into text (L125 m-1).
const shown = (p) => (typeof p === 'string' ? `"${p}"` : 'a non-text entry');
function patternProblem(p) {
  if (typeof p !== 'string' || /[^\x20-\x7e]/.test(p)) return 'is not a plain-ASCII pattern';
  try { compile(p); return null; } catch (e) { return `can't be read: ${e.message}`; }
}

export function policyProblems(rules, product) {
  const get = (key) => { try { return rules.get(key, { product }); } catch { return undefined; } };
  // A flag kind's value, read the way goFreeOn reads it (rules.flag on go_free.<kind>).
  const flagAt = (kind) => { try { return rules.flag(`${GO_FREE_KEY}.${kind}`, { product }); } catch { return undefined; } };
  const out = [];
  const v = get(GO_FREE_KEY);
  if (Array.isArray(v)) out.push(`M9: ${GO_FREE_KEY} must be a map (kind: true), not a list: M11 reads go_free.lead_daily_card from it`);
  else if (!v || typeof v !== 'object') out.push(`M9: ${GO_FREE_KEY} must be a map naming the kinds that need no go`);
  else {
    for (const [kind, value] of Object.entries(v)) {
      const shape = GO_FREE[kind];
      if (!shape) out.push(`M9: ${GO_FREE_KEY}.${kind} is not a go-free kind (only ${Object.keys(GO_FREE).join(', ')})`);
      else if (shape === 'flag' && flagAt(kind) === undefined) out.push(`M9: ${GO_FREE_KEY}.${kind} must be true or false`);
      else if (shape === 'patterns') {
        if (!Array.isArray(value)) out.push(`M9: ${GO_FREE_KEY}.${kind} must be a list of file patterns`);
        else for (const p of value) { const why = patternProblem(p); if (why) out.push(`M9: ${GO_FREE_KEY}.${kind}: ${shown(p)} ${why}`); }
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
  // The tab heartbeat limit, read by writer.mjs's own heartbeatLimit (L115 m-A, L123): a whole number of minutes, at least 1.
  if (heartbeatLimit(rules, product) === undefined) out.push('M9: proposals.heartbeat_stale_min must be a whole number of minutes, at least 1');
  return [...new Set(out)];
}
