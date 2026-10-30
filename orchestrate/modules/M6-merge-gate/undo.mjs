// undo.mjs — the Merge Gate's half of the undo route (R-0b-95; v4 §8 D8; 0b-9 round 2 R2-M2, R2-M3).
//
// THE ROUTE. The audit flags a merge (R-0b-93/94: an audit_run fact concluding failure → audit_flagged, and the issue);
// the Dispatcher makes an undo card (kind exact_reverse, `reverses` = the flagged merge commit; lane 2); the gate
// serves undo cards first in its queue (gate.mjs queueOrder) and merges one with no review, request or Approve, but only
// when M10 recomputes the change as the exact reverse (refusals.mjs: the exemptions are lost otherwise, and M10's own
// "ask" for a reverse of a merge whose audit passed still needs the Approve). The row's "done" is taken back by the
// reverse itself: the merge being undone set it in docs/blueprint/rows/, so its exact reverse unsets it.
// A change that can't be reversed cleanly is refused here (refusal 9); the Lead's fix card and telling Joe are lane 2's.
//
// WHAT IS UNDONE comes from the undo card's source, never from a field on the card (the record lets no one set one):
// an answered Undo ask names the card (its merge_commit is the commit); an authenticated audit issue names the commit
// (`commit`) or the card (`card`). The same answer feeds the judge (gather.mjs) and the reverted mark below.
//   undoneBy(record, card) → { commit, card } | null     card = the undo card's { id, doc }
//   markReverted({ record, alert }, undoCardId) → { ok, card?, reason? }
//     after an undo card merges, the card it undid is marked reverted (merged or closed → reverted, merge_gate)

const SHA = /^[0-9a-f]{40}$/;

export function undoneBy(record, card) {
  if (card?.doc?.kind !== 'exact_reverse') return null;
  const src = card.doc.source ?? {};
  const byCard = (id) => { const c = typeof id === 'string' ? record.read('card', id) : null; return c && SHA.test(c.doc?.merge_commit ?? '') ? { commit: c.doc.merge_commit, card: c.id } : null; };
  if (typeof src.ask === 'string') { const a = record.read('ask', src.ask); return a?.doc?.kind === 'undo' ? byCard(a.doc.card) : null; }
  if (typeof src.fact === 'string') {
    const f = record.read('fact', src.fact);
    if (f?.doc?.type !== 'undo_issue') return null;
    if (SHA.test(f.doc.commit ?? '')) { const cs = record.list('card').filter((c) => c.doc?.merge_commit === f.doc.commit); return { commit: f.doc.commit, card: cs.length === 1 ? cs[0].id : null }; }
    return byCard(f.doc.card);
  }
  return null;
}

export function markReverted({ record, alert = () => {} }, undoCardId) {
  const no = (reason) => { alert({ type: 'undo_not_marked', card: undoCardId, reason }); return { ok: false, reason }; };
  const u = record.read('card', undoCardId);
  if (!u?.doc || u.doc.kind !== 'exact_reverse' || u.doc.state !== 'merged') return no('not a merged undo card');
  const d = undoneBy(record, u);
  if (!d) return no('the undo card\'s source names no reversed commit');
  if (!d.card) return no(`no single card has ${d.commit.slice(0, 7)} as its merge commit`);
  const c = record.read('card', d.card);
  if (c.doc.state === 'reverted') return { ok: true, card: c.id };
  if (c.doc.state !== 'merged' && c.doc.state !== 'closed') return no(`card ${c.id} is ${c.doc.state}, not merged or closed`);
  const r = record.write({ actor: 'merge_gate', entity: 'card', id: c.id, expectRev: c.rev, doc: { ...c.doc, state: 'reverted' } });
  return r.ok ? { ok: true, card: c.id } : no(`the record refused: ${r.reason}`);
}
