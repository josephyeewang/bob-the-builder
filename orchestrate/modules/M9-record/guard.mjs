// guard.mjs — the one check of who may write what: the fields an actor may set (permissions.mjs) and the moves it may
// make (moves.mjs), with the fields a move itself ends (L72).
//
// WHY. The Store Writer (writer.mjs) and the test stand-in every other module's tests use (shared/record.mjs
// memoryRecord) both call this, so a stand-in can never accept a write the real Record refuses on these grounds. A
// stand-in looser than the real thing let the Dispatcher's card moves pass every test while the real Record refused
// all of them (L72).
//
//   guardWrite({ entity, actor, old, doc }) → { ok: true, doc, moving, from, to, changed, cleared } | { ok: false, reason }
//   `old` is the document as stored now, or null to create. `doc` is not changed; the answer's doc has the ended
//   fields taken out. The Store Writer's other checks (the ready rule, the claim, waits, verdicts, merges) stay in
//   writer.mjs: they need the whole record.

import { canonicalJson } from '../../shared/plan-fingerprint.mjs';
import { STATES } from '../../shared/record-names.mjs';
import { CREATE_STATES, INTERNAL_MOVES, moveActors } from './moves.mjs';
import { actorName, fieldsAllowed } from './permissions.mjs';

const no = (reason) => ({ ok: false, reason });
export const same = (a, b) => { try { return canonicalJson(a ?? null) === canonicalJson(b ?? null); } catch { return false; } };
const WAITING = Object.freeze(['waiting', 'waiting_input', 'waiting_limit']);

export function guardWrite({ entity, id, actor, old, doc }) {
  const name = actorName(actor);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('doc must be an object');
  const out = structuredClone(doc);
  const stateful = Object.hasOwn(STATES, entity);
  if (stateful && !STATES[entity].includes(out.state)) return no(`unknown ${entity} state "${out.state}"`);

  // ---------- create ----------
  if (!old) {
    const allowed = fieldsAllowed(entity, actor, { create: true });
    if (!allowed) return no(`${name} may not create ${entity}`);
    if (allowed !== '*') { const extra = Object.keys(out).filter((f) => !allowed.has(f)); if (extra.length) return no(`${name} may not set ${extra.join(', ')} on a new ${entity}`); }
    if (stateful && !(CREATE_STATES[entity]?.[out.state] ?? []).includes(name)) return no(`${name} may not create a ${entity} in ${out.state}`);
    return { ok: true, doc: out, moving: false, from: null, to: out.state, changed: Object.keys(out), cleared: [] };
  }

  // ---------- update ----------
  const from = old.state;
  const to = out.state;
  const moving = stateful && from !== to;
  if (moving) {
    if (INTERNAL_MOVES[entity]?.[from]?.includes(to)) return no(`${entity} ${from} → ${to} is made only by a claim break or lapse`);
    const actors = moveActors(entity, from, to);
    if (!actors) return no(`illegal move: ${entity} ${from} → ${to}`);
    if (!actors.includes(name)) return no(`${name} may not move ${entity} ${from} → ${to}`);
  }
  // Fields the move itself ends: the claim when a card leaves claimed or running (R3-M4), the wait when it leaves a
  // waiting state, a paused product's return_to.
  const cleared = [];
  if (entity === 'card' && moving && (from === 'claimed' || from === 'running') && to !== 'claimed' && to !== 'running') { delete out.claim; cleared.push('claim'); }
  if (moving && WAITING.includes(from)) { delete out.wait; cleared.push('wait'); }
  if (entity === 'product' && moving && from === 'paused') { delete out.return_to; cleared.push('return_to'); }

  const keys = new Set([...Object.keys(old), ...Object.keys(out)]);
  const changed = [...keys].filter((k) => k !== 'state' && !cleared.includes(k) && !same(old[k], out[k]));
  const allowed = fieldsAllowed(entity, actor, { state: from });
  if (!allowed) return no(`${name} may not change ${entity}`);
  if (allowed !== '*') { const bad = changed.filter((f) => !allowed.has(f)); if (bad.length) return no(`${name} may not change ${bad.join(', ')} on ${entity}${id === undefined ? '' : ` ${id}`}`); }
  if (!moving && !changed.length) return no('nothing changed');
  return { ok: true, doc: out, moving, from, to, changed, cleared };
}
