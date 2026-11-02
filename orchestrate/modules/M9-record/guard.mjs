// guard.mjs — the one check of who may write what: the fields an actor may set (permissions.mjs) and the moves it may
// make (moves.mjs), with the fields a move itself ends (L72).
//
// WHY. The Store Writer (writer.mjs) and the test stand-in every other module's tests use (shared/record.mjs
// memoryRecord) both call this, so a stand-in can never accept a write the real Record refuses on these grounds. A
// stand-in looser than the real thing let the Dispatcher's card moves pass every test while the real Record refused
// all of them (L72).
//
//   guardWrite({ entity, id, actor, old, doc, createdBy }) → { ok: true, doc, moving, from, to, changed, cleared } | { ok: false, reason }
//   `old` is the document as stored now, or null to create. `doc` is not changed; the answer's doc has the ended
//   fields taken out. The Store Writer's other checks (the ready rule, the claim, waits, verdicts, merges) stay in
//   writer.mjs: they need the whole record.

import { canonicalJson } from '../../shared/plan-fingerprint.mjs';
import { SESSION_ID, STATES } from '../../shared/record-names.mjs';
import { CREATE_STATES, INTERNAL_MOVES, moveActors } from './moves.mjs';
import { ATTEMPTS, WRITERS, actorName, factFamilyOf, fieldsAllowed } from './permissions.mjs';

const no = (reason) => ({ ok: false, reason });
export const same = (a, b) => { try { return canonicalJson(a ?? null) === canonicalJson(b ?? null); } catch { return false; } };
const WAITING = Object.freeze(['waiting', 'waiting_input', 'waiting_limit']);

// A card's `attempts` (L74): every key changed must be a listed one, written by its own role, in its shape.
function attemptsProblem(name, before, after) {
  if (after !== undefined && (!after || typeof after !== 'object' || Array.isArray(after))) return 'attempts must be an object';
  const a = before ?? {}; const b = after ?? {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[k], b[k])) continue;
    const spec = Object.hasOwn(ATTEMPTS, k) ? ATTEMPTS[k] : null;
    if (!spec) return `attempts.${k} is not a listed count`;
    if (spec.writer !== name) return `${name} may not change attempts.${k} (it is ${spec.writer}'s)`;
    const v = b[k];
    if (v === undefined) continue;
    if (spec.shape === 'count' && !(Number.isInteger(v) && v >= 0)) return `attempts.${k} must be a whole number`;
    if (spec.shape === 'reasons' && !(Array.isArray(v) && v.every((x) => typeof x === 'string' && x))) return `attempts.${k} must be a list of reasons`;
  }
  return null;
}

// `createdBy` is the actor of the document's first diary line (the store keeps it); a fact row marked `own` may change
// only a fact its role created (L74). It is required for such an update: a caller that can't say refuses.
export function guardWrite({ entity, id, actor, old, doc, createdBy }) {
  const name = actorName(actor);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('doc must be an object');
  const out = structuredClone(doc);
  const stateful = Object.hasOwn(STATES, entity);
  if (stateful && !STATES[entity].includes(out.state)) return no(`unknown ${entity} state "${out.state}"`);
  const row = Object.hasOwn(WRITERS[entity] ?? {}, name) ? WRITERS[entity][name] : null;

  // ---------- create ----------
  if (!old) {
    const allowed = fieldsAllowed(entity, actor, { create: true });
    if (!allowed) return no(`${name} may not create ${entity}`);
    if (entity === 'fact') {
      const owner = factFamilyOf(id);
      if (owner !== name) return no(owner ? `fact ${id} is in ${owner}'s family, not ${name}'s` : `fact ${id} is in no family; ${name} may not create it`);
    }
    if (allowed !== '*') { const extra = Object.keys(out).filter((f) => !allowed.has(f)); if (extra.length) return no(`${name} may not set ${extra.join(', ')} on a new ${entity}`); }
    if (stateful && !(CREATE_STATES[entity]?.[out.state] ?? []).includes(name)) return no(`${name} may not create a ${entity} in ${out.state}`);
    return { ok: true, doc: out, moving: false, from: null, to: out.state, changed: Object.keys(out), cleared: [] };
  }

  // ---------- update ----------
  if (row?.own && actorName(createdBy ?? '') !== name) return no(`${name} may change only a ${entity} it created; ${id ?? 'this one'} was created by ${createdBy ?? 'an unknown writer'}`);
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
  // On an entity with no states (a fact), `state` is an ordinary field: a change to it alone is a change.
  const changed = [...keys].filter((k) => !(stateful && k === 'state') && !cleared.includes(k) && !same(old[k], out[k]));
  const allowed = fieldsAllowed(entity, actor, { state: from });
  if (!allowed) return no(`${name} may not change ${entity}`);
  if (allowed !== '*') { const bad = changed.filter((f) => !allowed.has(f)); if (bad.length) return no(`${name} may not change ${bad.join(', ')} on ${entity}${id === undefined ? '' : ` ${id}`}`); }
  if (entity === 'card' && changed.includes('attempts')) { const p = attemptsProblem(name, old.attempts, out.attempts); if (p) return no(p); }
  if (!moving && !changed.length) return no('nothing changed');
  return { ok: true, doc: out, moving, from, to, changed, cleared };
}

// ---------- the claim (L72) ----------
// The claim has two steps: ready → claimed names the session before it starts (the Dispatcher makes the id and the
// launcher starts claude with it), so no second start can take the card; claimed → running adds the process once the
// start reports it. The claim is stamped claimed_at here. rules_rev is the rules the claim was made under (L74).
// Otherwise a write never changes a claim (R2-M6, R3-M4); a claimed or running card has one, any other card none.
// Both the Store Writer and the stand-in call this, so neither takes a claim the other refuses.
const CLAIM_FIELDS = Object.freeze({ session: ['kind', 'session_id', 'host', 'claimed_at', 'rules_rev'], tab: ['kind', 'claim_id', 'host', 'claimed_at', 'rules_rev'] });
function checkClaim(claim, nowMs) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return no('a claim needs its owner');
  if (claim.kind === 'session') {
    if (typeof claim.session_id !== 'string' || !SESSION_ID.test(claim.session_id)) return no('a session claim needs a session_id the session can hand in with (letters, digits, dashes; at most 128)');
    if (claim.pid !== undefined || claim.pid_start !== undefined) return no('a session claim gets its pid at claimed → running, once the session has started');
  } else if (claim.kind === 'tab') {
    if (typeof claim.claim_id !== 'string' || !claim.claim_id) return no('a tab claim needs claim_id');
  } else return no('claim.kind must be session or tab');
  const extra = Object.keys(claim).filter((k) => !CLAIM_FIELDS[claim.kind].includes(k));
  if (extra.length) return no(`a ${claim.kind} claim has no ${extra.join(', ')}`);
  if (typeof claim.host !== 'string' || !claim.host) return no('a claim needs the host');
  if (claim.rules_rev !== undefined && !(typeof claim.rules_rev === 'string' && claim.rules_rev) && !Number.isInteger(claim.rules_rev)) return no('claim.rules_rev names the rules it was made under');
  return { ok: true, claim: { ...claim, claimed_at: new Date(nowMs).toISOString() } };
}
// claimed → running: a session claim gains pid and pid_start and nothing else; a tab claim is unchanged.
function checkStart(before, after) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return no('a running card has a claim');
  if (before.kind !== 'session') return same(before, after) ? { ok: true } : no('a tab claim does not change at claimed → running');
  if (!Number.isInteger(after.pid) || after.pid <= 0) return no('claimed → running needs the session\'s pid');
  if (typeof after.pid_start !== 'string' || !after.pid_start) return no('claimed → running needs pid_start');
  const { pid, pid_start, ...rest } = after;   // eslint-disable-line no-unused-vars
  if (!same(rest, before)) return no('claimed → running only adds pid and pid_start to the claim');
  return { ok: true };
}
/** A card write's claim, after guardWrite: { ok: true, claim? } (claim = the stamped claim to store) | { ok: false, reason }. */
export function claimCheck({ old, doc, from, to, changed, nowMs }) {
  let claim;
  if (old && to === 'claimed' && from === 'ready') {
    const c = checkClaim(doc.claim, nowMs);
    if (!c.ok) return c;
    claim = c.claim;
  } else if (old && from === 'claimed' && to === 'running') {
    const c = checkStart(old.claim ?? {}, doc.claim);
    if (!c.ok) return c;
  } else if (old && changed.includes('claim')) return no('a claim is set only by ready → claimed, and given its pid only by claimed → running');
  const has = !!(claim ?? doc.claim);
  if ((to === 'claimed' || to === 'running') && !has) return no(`a ${to} card has a claim`);
  if (!(to === 'claimed' || to === 'running') && has) return no(`a ${to} card has no claim`);
  return claim ? { ok: true, claim } : { ok: true };
}
