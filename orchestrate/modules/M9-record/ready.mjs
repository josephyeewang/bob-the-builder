// ready.mjs — the one ready rule: may this card start now? (0b-2 M-2, m-3, R2-M4, R2-M5, R2-m2, R3-M3, R3-m2)
//
// WHY. "Ready" decides what a worker builds next, so a card that skips the owner's go, or starts before the change it builds
// on is merged, is work the owner never agreed to. Every move into `ready` and the ready list call this one function, so the
// two can't drift. It fails closed: anything missing or unreadable is "not ready", with the reason.
//
//   readyCheck(card, view, { rules, product }) → { ok: true } | { ok: false, reason, waiting? }
//     waiting: the ordinary wait for a dependency that can still merge, or a paused product to resume, which nobody has
//     to act on. Set only when the wait can end by itself; anything else is said, so a card never sits quietly (L490).
//     card = { id, doc }; view = { get(entity, id) → { id, doc } | corrupt | null, list(entity), createdBy(entity, id) }
//
// A card may start when all of these hold:
//   - its round is within rules caps.rounds;
//   - every dependency exists, is readable, and is `merged` or `closed` (never `reverted`, never only `in_review`),
//     and following dependencies never comes back to this card;
//   - its product's state lets work start (no product document reads as `paused`);
//   - The owner's go matches the plan (the fingerprint of the ROOT card's id and this card's plan inputs), or the card's kind
//     is go-free in the rules AND the card was created by the one actor allowed to make that kind.

import { planFingerprint } from '../../shared/plan-fingerprint.mjs';
import { mayCreateKind } from './permissions.mjs';
import { OPEN_CARD_STATES } from '../../shared/record.mjs';

const MAX_CHAIN = 64;

// The card kinds that may be go-free, and how each one's value says so (L115 M-C, m-F). A key's presence is never
// enough: `exact_reverse: false` must not let an undo merge with no go (M6 gather.mjs reads this list).
//   flag     — go-free only when the value is exactly true (rules.flag);
//   patterns — go-free only when the value is a non-empty list of file patterns ([] means the product has no such card).
export const GO_FREE = Object.freeze({ exact_reverse: 'flag', research_copy: 'flag', lead_daily_card: 'patterns' });
// The rules map that names them (one home; lane 3's required-keys check imports it from here).
export const GO_FREE_KEY = 'approvals.plan_go.go_free';

export function goFreeOn(rules, product, kind) {
  if (!Object.hasOwn(GO_FREE, kind)) return false;
  const key = `${GO_FREE_KEY}.${kind}`;
  if (GO_FREE[kind] === 'flag') return rules?.flag?.(key, { product }) === true;
  const v = rules?.get?.(key, { product });
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');
}

export function goFreeKinds(rules, product) {
  return Object.keys(GO_FREE).filter((k) => goFreeOn(rules, product, k));
}

// The round-1 card a fix descends from (R2-M5): its go covers every fix round.
export function rootOf(card, view) {
  let cur = card;
  const seen = new Set([card.id]);
  for (let i = 0; i < MAX_CHAIN; i++) {
    const parent = cur.doc?.fix_of;
    if (parent === undefined || parent === null) return { ok: true, root: cur };
    if (typeof parent !== 'string' || seen.has(parent)) return { ok: false, reason: `fix chain of ${card.id} loops` };
    seen.add(parent);
    const p = view.get('card', parent);
    if (!p || p.corrupt || !p.doc) return { ok: false, reason: `fix chain of ${card.id}: card ${parent} is missing or unreadable` };
    cur = p;
  }
  return { ok: false, reason: `fix chain of ${card.id} is longer than ${MAX_CHAIN}` };
}

function depsCheck(card, view) {
  const deps = card.doc.depends_on ?? [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) return { ok: false, reason: 'depends_on is not a list of card ids' };
  // A cycle through any path back to this card is refused, whatever state the cards are in.
  const stack = [...deps];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === card.id) return { ok: false, reason: `dependency cycle back to ${card.id}` };
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 10000) return { ok: false, reason: 'dependency graph too large' };
    const d = view.get('card', id);
    const next = d && !d.corrupt && Array.isArray(d.doc?.depends_on) ? d.doc.depends_on : [];
    for (const n of next) if (typeof n === 'string') stack.push(n);
  }
  for (const id of deps) {
    const d = view.get('card', id);
    if (!d) return { ok: false, reason: `dependency ${id} does not exist` };
    if (d.corrupt) return { ok: false, reason: `dependency ${id} is unreadable` };
    if (d.doc.state === 'merged' || d.doc.state === 'closed') continue;
    if (OPEN_CARD_STATES.includes(d.doc.state)) return { ok: false, waiting: true, reason: `dependency ${id} is ${d.doc.state}, not merged` };
    // Any other state will never merge (failed, cancelled, closed with no answer, reverted; L490): it can't be waited
    // out, so the card waits on the owner.
    return { ok: false, joe: true, reason: `dependency ${id} is ${d.doc.state}; the owner decides what happens to this card` };
  }
  return { ok: true };
}

function productCheck(card, view, rules, product) {
  const p = view.get('product', card.doc.product);
  const readable = Boolean(p) && !p.corrupt && typeof p.doc?.state === 'string';
  const state = readable ? p.doc.state : 'paused';
  const start = rules.get(`product_state_rules.${state}.start`, { product });
  if (typeof start !== 'string' || !start) return { ok: false, reason: `the rules say nothing about starting work in a ${state} product` };
  // An undo is never held by the product's state: pausing is often the moment the owner wants one, and M10 and M11's
  // start gate already let it through, so this check alone was stopping it (L595). A record that can't be read still refuses.
  if (start === 'none' && readable && card.doc.kind === 'exact_reverse') return { ok: true };
  // Only a state read off the record can be waited out: a missing or unreadable record is said (L490 m7).
  if (start === 'none') return { ok: false, waiting: readable, reason: `product ${card.doc.product} is ${state}${readable ? '' : p ? ' (its record can\'t be read)' : ' (no product record)'}; no work starts` };
  return { ok: true };
}

// Does this card still want the owner's go? The one definition (L443): `needed` is exactly the case where the go check
// below refuses, so nothing that raises a go can disagree with what ready enforces.
//   → { needed: false, go? } | { needed: true, root, reason }   root is null when the fix chain can't be followed
// A fix card's `root` is another card: it runs on that card's go, and only the root is ever asked for one.
export function goNeeded(card, view, rules, product) {
  const kind = card.doc.kind;
  // A go-free kind made by the wrong creator isn't refused outright (L450): it is an ordinary card, ok on the owner's go.
  let wrong = null;
  if (goFreeKinds(rules, product).includes(kind)) {
    const creator = view.createdBy('card', card.id);
    if (creator && mayCreateKind(creator, kind)) return { needed: false };
    wrong = `a ${kind} card made by ${creator ?? 'an unknown writer'} needs the owner's go`;
  }
  const r = rootOf(card, view);
  const root = r.ok ? r.root : null;
  const reasonOf = (why) => (wrong ? `${wrong}: ${why}` : why);
  if (!r.ok) return { needed: true, root, reason: reasonOf(r.reason) };
  const d = card.doc;
  const fp = planFingerprint({ product: d.product, card_id: root.id, tier: d.tier, files: d.files, done_when: d.done_when, plan_sha256: d.plan_sha256, main_commit: d.main_commit });
  if (!fp.ok) return { needed: true, root, reason: reasonOf(`plan can't be fingerprinted: ${fp.reason}`) };
  const go = view.list('go').find((g) => g.doc?.plan_fingerprint === fp.sha256 && g.doc?.product === d.product && g.doc?.card_id === root.id);
  return go ? { needed: false, go: go.id } : { needed: true, root, reason: reasonOf(`no go from the owner matches this plan (fingerprint ${fp.sha256.slice(0, 12)})`) };
}

function goCheck(card, view, rules, product) {
  const n = goNeeded(card, view, rules, product);
  if (n.needed) return { ok: false, reason: n.reason };
  return n.go ? { ok: true, go: n.go } : { ok: true };
}

export function readyCheck(card, view, { rules, product }) {
  try {
    if (!card?.doc || typeof card.doc !== 'object') return { ok: false, reason: 'no card' };
    if (card.doc.product !== product) return { ok: false, reason: `card belongs to product ${card.doc.product}, not ${product}` };
    const cap = rules.num('caps.rounds', { product });
    if (cap === undefined || cap < 1) return { ok: false, reason: 'no round cap in the rules (caps.rounds)' };
    if (!Number.isInteger(card.doc.round) || card.doc.round < 1) return { ok: false, reason: 'card has no round' };
    if (card.doc.round > cap) return { ok: false, reason: `round ${card.doc.round} is over the cap of ${cap}` };
    for (const check of [depsCheck(card, view), productCheck(card, view, rules, product), goCheck(card, view, rules, product)]) if (!check.ok) return check;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `ready check failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}
