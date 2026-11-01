// merge-outcome.mjs — the Merge Gate's answer for a merge its own pass can't finish (L74 b3).
//
// WHY. Whether a merge happened is the gate's decision, so only merge_gate writes a merge's outcome and the card's
// merged or put-back move. The Dispatcher keeps the timing (a merge stuck in checking, or merging while the gate's
// process is gone) and calls this; it never writes a merge or a merge_refusals itself.
//
//   settleMerge({ record, alert?, now }, mergeId, { pr?, reason }) → { ok, outcome?, card?, reason? }
//     pr = Sensors' pr-<n> reading { merged, merge_commit_sha, head_sha } observed after the merge's last write, or
//     null (no reading needed: a checking merge past its time limit is refused with `reason`).
//     merged at the judged head → merged (checking goes through merging first), the card merging → merged with its
//       merge_commit, and an undo card marks what it undid; the gate's next pass posts the marks.
//     merged at another head → refused ("merged outside the gate"), told, the card put back.
//     not merged → refused with `reason`, the card put back.
//   Put back: merging → verified, or in_review when the Record refuses verified (no passing verdict for its head), with
//   `reason` added to the card's attempts.merge_refusals (the gate's count; the same reason twice goes to the owner,
//   which the Dispatcher asks).
// A refused merge stays refused (the Record has no move out of it): when its PR later shows merged, the Dispatcher
// tells the owner once instead of rewriting it.

import { markReverted } from './undo.mjs';

const ACTOR = 'merge_gate';
const SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 7);

export function settleMerge({ record, alert = () => {}, now }, id, { pr = null, reason } = {}) {
  const iso = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const m = record.read('merge', id);
  if (!m?.doc || m.corrupt) return { ok: false, reason: `merge ${id} can't be read` };
  if (m.doc.state !== 'checking' && m.doc.state !== 'merging') return { ok: false, reason: `merge ${id} is ${m.doc.state}, not checking or merging` };
  const write = (entity, cur, fields) => record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev, doc: { ...cur.doc, ...fields }, kind: 'merge_outcome' });
  const told = (r, what) => { if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: id, to: what, reason: r.reason }); return r.ok; };

  if (pr?.merged === true && SHA.test(pr.merge_commit_sha ?? '') && pr.head_sha === m.doc.judged_head) {
    let cur = m;
    if (cur.doc.state === 'checking') { if (!told(write('merge', cur, { state: 'merging' }), 'merging')) return { ok: false, reason: 'the move to merging was refused' }; cur = record.read('merge', id); }
    if (!told(write('merge', cur, { state: 'merged', merge_commit: pr.merge_commit_sha, merged_at: iso() }), 'merged')) return { ok: false, reason: 'the move to merged was refused' };
    const card = m.doc.card ? record.read('card', m.doc.card) : null;
    if (card?.doc?.state === 'merging') {
      if (told(write('card', card, { state: 'merged', merge_commit: pr.merge_commit_sha }), 'merged') && card.doc.kind === 'exact_reverse') markReverted({ record, alert }, card.id);
    }
    return { ok: true, outcome: 'merged', card: m.doc.card ?? null };
  }
  let why = reason;
  if (pr?.merged === true) {
    why = 'merged outside the gate, at a head the gate did not judge';
    alert({ type: 'merge_gate_unsure', merge: id, note: `pull request #${m.doc.pr} merged at ${short(pr.head_sha)}, not the judged ${short(m.doc.judged_head)}` });
  }
  if (typeof why !== 'string' || !why) return { ok: false, reason: 'a refusal needs its reason' };
  if (!told(write('merge', m, { state: 'refused', reasons: [why] }), 'refused')) return { ok: false, reason: 'the refusal was refused' };
  return { ok: true, outcome: 'refused', card: putBack(record, m.doc.card, why, told) };
}

function putBack(record, cardId, why, told) {
  const card = cardId ? record.read('card', cardId) : null;
  if (card?.doc?.state !== 'merging') return null;
  const attempts = { ...(card.doc.attempts ?? {}), merge_refusals: [...(card.doc.attempts?.merge_refusals ?? []), why] };
  const at = (to) => record.write({ actor: ACTOR, entity: 'card', id: card.id, expectRev: card.rev, doc: { ...card.doc, state: to, attempts }, kind: 'merge_refused' });
  const r = at('verified');
  if (r.ok) return { id: card.id, to: 'verified' };
  const r2 = at('in_review');
  told(r2, 'in_review');
  return r2.ok ? { id: card.id, to: 'in_review' } : null;
}
