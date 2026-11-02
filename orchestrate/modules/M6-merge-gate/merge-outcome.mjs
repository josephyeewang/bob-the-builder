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
//     not merged → refused with `reason`, the card put back. `fields` are written with that refusal (the gate's
//       tell_owner mark, L168), never with a merged outcome.
//   Put back: merging → verified, or in_review when the Record refuses verified (no passing verdict for its head), with
//   `reason` added to the card's attempts.merge_refusals (the gate's count). The gate alerts once per refusal; it does
//   not ask the owner. The same reason twice in a row (refusedTwice below; a timeout, an interruption, or GitHub's own
//   405, 409 or 422 from land()) goes to the owner: the Dispatcher asks, once per repeat (attempts.merge_asks), and
//   requests no new merge for the card until the owner answers, so a refusal that will happen again is never retried
//   in a loop of alerts (L110 m-1).
//   The Dispatcher hands over a not-merged reading only once the outcome is known (L85 M-1 a): the PR closed and not
//   merged, or still open past timeouts.merging_open_max_min after the merging write (`openTooLong`). Any other
//   not-merged reading is refused here, so an unknown outcome is never recorded as refused.
//
//   reconcileMerge({ record, alert?, now }, mergeId, { pr, factId }) → { ok, card?, reason? }   (L85 M-1 b)
//     An interrupted merge (refused, reasons include 'interrupted') whose Sensors reading `factId` shows its PR merged
//     with a merge commit at the judged head → merged, and its card (verified or approved) → merged; the gate's next
//     pass runs the post-merge audit as for any merged merge. Merged at another head, or no merge commit: left refused,
//     and told. The Record's writer checks the same reading again. The merge gets reconciled_at (its reasons keep
//     'interrupted' as the history of what happened).
//
// Shared by both callers, the gate's own recover() and the Dispatcher's time limits (L94: one decision function):
//   PR_FACT(n) → 'pr-<n>', Sensors' reading of pull request n.
//   prReadingAfter(record, prNumber, mergeId) → the reading's doc, only when Sensors made it and its observed_at is
//     after the merge's last write by the Record's clock; else null.
//   openTooLong(record, mergeId, now, limitMs) → true once the merge's last write is at least limitMs old (an age the
//     Record can't give counts as too long, so the limit only ever fires rather than waits forever); false when the
//     limit itself is unknown.
//   prReading(pr) → GitHub's pull request answer in the reading's shape { state, merged, merge_commit_sha, head_sha }.
//   refusedTwice(cardDoc) → the reason, when the card's last two merge refusals are the same and the owner has not been
//     asked about the newer one yet (attempts.merge_asks below the list's length); else null.

import { markReverted } from './undo.mjs';
import { factFrom } from '../M9-record/permissions.mjs';

export const PR_FACT = (n) => `pr-${n}`;

export function refusedTwice(doc) {
  const reasons = doc?.attempts?.merge_refusals;
  if (!Array.isArray(reasons) || reasons.length < 2) return null;
  const asked = doc.attempts.merge_asks;
  if (Number.isInteger(asked) && asked >= reasons.length) return null;
  const [a, b] = reasons.slice(-2);
  return typeof b === 'string' && a === b ? b : null;
}
// The refusal for a PR merged at a head the gate did not judge; whoever writes it has told the owner.
export const MERGED_OUTSIDE = 'merged outside the gate, at a head the gate did not judge';
// The same refusal when the alert was not taken (L130 M6): it is not MERGED_OUTSIDE, so the Dispatcher's
// refused-but-merged step tells the owner after a fresh reading.
export const MERGED_OUTSIDE_UNTOLD = `${MERGED_OUTSIDE}; the owner was not told yet`;
/** Whether an alert was taken: anything but false; a throw counts as false (L130). */
export function alertTaken(alert, e) {
  try { return alert(e) !== false; } catch { return false; }
}

export function prReadingAfter(record, prNumber, mergeId) {
  if (prNumber == null) return null;
  const id = PR_FACT(prNumber);
  const f = record.read('fact', id);
  if (!f?.doc || f.corrupt || !factFrom('sensors', { id, createdBy: record.meta?.('fact', id)?.createdBy ?? null }, 'pr-')) return null;
  const seen = Date.parse(f.doc.observed_at ?? '');
  const changed = Date.parse(record.meta?.('merge', mergeId)?.ts ?? '');
  return Number.isFinite(seen) && Number.isFinite(changed) && seen > changed ? f.doc : null;
}

export function openTooLong(record, mergeId, now, limitMs) {
  if (!Number.isFinite(limitMs)) return false;
  const t = Date.parse(record.meta?.('merge', mergeId)?.ts ?? '');
  const at = typeof now === 'function' ? now() : now;
  return Number.isFinite(t) ? at - t >= limitMs : true;
}

export const prReading = (pr) => ({ state: pr?.state ?? null, merged: pr?.merged === true, merge_commit_sha: pr?.merge_commit_sha ?? null, head_sha: pr?.head?.sha ?? null });

const ACTOR = 'merge_gate';
const SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 7);

export function settleMerge({ record, alert = () => {}, now }, id, { pr = null, reason, openTooLong = false, fields = {} } = {}) {
  const iso = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const m = record.read('merge', id);
  if (!m?.doc || m.corrupt) return { ok: false, reason: `merge ${id} can't be read` };
  if (m.doc.state !== 'checking' && m.doc.state !== 'merging') return { ok: false, reason: `merge ${id} is ${m.doc.state}, not checking or merging` };
  const write = (entity, cur, fields) => record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev, doc: { ...cur.doc, ...fields }, kind: 'merge_outcome' });
  const told = (r, what) => { if (!r.ok) alert({ type: 'merge_gate_write_refused', merge: id, to: what, reason: r.reason }); return r.ok; };

  if (pr && pr.merged !== true && pr.state !== 'closed' && !openTooLong) return { ok: false, reason: `merge ${id}'s outcome is not known yet: PR ${m.doc.pr} is still open` };
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
    why = alertTaken(alert, { type: 'merge_gate_unsure', merge: id, note: `pull request #${m.doc.pr} merged at ${short(pr.head_sha)}, not the judged ${short(m.doc.judged_head)}` }) ? MERGED_OUTSIDE : MERGED_OUTSIDE_UNTOLD;
  }
  if (typeof why !== 'string' || !why) return { ok: false, reason: 'a refusal needs its reason' };
  if (!told(write('merge', m, { ...fields, state: 'refused', reasons: [why] }), 'refused')) return { ok: false, reason: 'the refusal was refused' };
  return { ok: true, outcome: 'refused', card: putBack(record, m.doc.card, why, told) };
}

export function reconcileMerge({ record, alert = () => {}, now }, id, { pr, factId } = {}) {
  const iso = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const m = record.read('merge', id);
  if (!m?.doc || m.corrupt) return { ok: false, reason: `merge ${id} can't be read` };
  if (m.doc.state !== 'refused' || !(m.doc.reasons ?? []).includes('interrupted')) return { ok: false, reason: `merge ${id} is not an interrupted merge` };
  if (pr?.merged !== true) return { ok: false, reason: `PR ${m.doc.pr} does not show merged` };
  if (!SHA.test(pr.merge_commit_sha ?? '') || pr.head_sha !== m.doc.judged_head) {
    // told is the alert's own answer (L130 M4): the caller tells the owner itself when it was not taken.
    const told = alertTaken(alert, { type: 'merge_gate_unsure', merge: id, note: `pull request #${m.doc.pr} merged at ${short(pr.head_sha)}, not the judged ${short(m.doc.judged_head)}, or with no merge commit; merge ${id} stays refused` });
    return { ok: false, told, reason: `merged at ${short(pr.head_sha)}, not the judged ${short(m.doc.judged_head)}, or with no merge commit` };
  }
  const w = record.write({ actor: ACTOR, entity: 'merge', id, expectRev: m.rev, doc: { ...m.doc, state: 'merged', merge_commit: pr.merge_commit_sha, merged_at: iso(), reconciled_at: iso() }, kind: 'merge_outcome', data: { fact: factId } });
  if (!w.ok) { alert({ type: 'merge_gate_write_refused', merge: id, to: 'merged', reason: w.reason }); return { ok: false, reason: `the reconcile was refused: ${w.reason}` }; }
  const card = m.doc.card ? record.read('card', m.doc.card) : null;
  if (!card?.doc) return { ok: true, card: null };
  if (card.doc.state !== 'verified' && card.doc.state !== 'approved') {
    alert({ type: 'merge_gate_unsure', merge: id, note: `merge ${id} is recorded merged, but card ${card.id} is ${card.doc.state}; check it` });
    return { ok: true, card: null };
  }
  const c = record.write({ actor: ACTOR, entity: 'card', id: card.id, expectRev: card.rev, doc: { ...card.doc, state: 'merged', merge_commit: pr.merge_commit_sha }, kind: 'merge_outcome' });
  if (!c.ok) { alert({ type: 'merge_gate_write_refused', card: card.id, to: 'merged', reason: c.reason }); return { ok: true, card: null }; }
  if (card.doc.kind === 'exact_reverse') markReverted({ record, alert }, card.id);
  return { ok: true, card: card.id };
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
