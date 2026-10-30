// ready.mjs — the one ready rule: may this card start now? (0b-2 M-2, m-3, R2-M4, R2-M5, R2-m2, R3-M3, R3-m2)
//
// WHY. "Ready" decides what a worker builds next, so a card that skips the owner's go, or starts before the change it builds
// on is merged, is work the owner never agreed to. Every move into `ready` and the ready list call this one function, so the
// two can't drift. It fails closed: anything missing or unreadable is "not ready", with the reason.
//
//   readyCheck(card, view, { rules, product }) → { ok: true } | { ok: false, reason }
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

const MAX_CHAIN = 64;

export function goFreeKinds(rules, product) {
  const v = rules.get('approvals.plan_go.go_free', { product });
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
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
    // A dependency that will never merge (cancelled, no answer, failed) can't be waited out: the card waits on the owner.
    if (['cancelled', 'closed_no_answer', 'failed'].includes(d.doc.state)) return { ok: false, joe: true, reason: `dependency ${id} is ${d.doc.state}; the owner decides what happens to this card` };
    if (d.doc.state !== 'merged' && d.doc.state !== 'closed') return { ok: false, reason: `dependency ${id} is ${d.doc.state}, not merged` };
  }
  return { ok: true };
}

function productCheck(card, view, rules, product) {
  const p = view.get('product', card.doc.product);
  const state = p && !p.corrupt && typeof p.doc?.state === 'string' ? p.doc.state : 'paused';
  const start = rules.get(`product_state_rules.${state}.start`, { product });
  if (typeof start !== 'string' || !start) return { ok: false, reason: `the rules say nothing about starting work in a ${state} product` };
  if (start === 'none') return { ok: false, reason: `product ${card.doc.product} is ${state}${p ? '' : ' (no product record)'}; no work starts` };
  return { ok: true };
}

function goCheck(card, view, rules, product) {
  const kind = card.doc.kind;
  if (goFreeKinds(rules, product).includes(kind)) {
    const creator = view.createdBy('card', card.id);
    if (creator && mayCreateKind(creator, kind)) return { ok: true };
    return { ok: false, reason: `a ${kind} card made by ${creator ?? 'an unknown writer'} needs the owner's go` };
  }
  const r = rootOf(card, view);
  if (!r.ok) return r;
  const d = card.doc;
  const fp = planFingerprint({ product: d.product, card_id: r.root.id, tier: d.tier, files: d.files, done_when: d.done_when, plan_sha256: d.plan_sha256, main_commit: d.main_commit });
  if (!fp.ok) return { ok: false, reason: `plan can't be fingerprinted: ${fp.reason}` };
  const go = view.list('go').find((g) => g.doc?.plan_fingerprint === fp.sha256 && g.doc?.product === d.product && g.doc?.card_id === r.root.id);
  return go ? { ok: true, go: go.id } : { ok: false, reason: `no go from the owner matches this plan (fingerprint ${fp.sha256.slice(0, 12)})` };
}

export function readyCheck(card, view, { rules, product }) {
  try {
    if (!card?.doc || typeof card.doc !== 'object') return { ok: false, reason: 'no card' };
    if (card.doc.product !== product) return { ok: false, reason: `card belongs to product ${card.doc.product}, not ${product}` };
    const cap = rules.get('caps.rounds', { product });
    if (!Number.isInteger(cap) || cap < 1) return { ok: false, reason: 'no round cap in the rules (caps.rounds)' };
    if (!Number.isInteger(card.doc.round) || card.doc.round < 1) return { ok: false, reason: 'card has no round' };
    if (card.doc.round > cap) return { ok: false, reason: `round ${card.doc.round} is over the cap of ${cap}` };
    for (const check of [depsCheck(card, view), productCheck(card, view, rules, product), goCheck(card, view, rules, product)]) if (!check.ok) return check;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `ready check failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}
