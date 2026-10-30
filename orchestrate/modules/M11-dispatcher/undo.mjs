// The [Undo] tap (R-0b-68; design v4 D8; review 0b-6 M21).
//
// M11 acts only on an `ask` that is `answered`, `via: tap`, that M2 counted (rules.may
// ('count_approval') allows it), and that names { pr, merge_commit_sha } matching a merged attempt
// in the record. It writes one `kind: undo` card per ask (asking again is harmless), go-free, with
// the reversed commit's files, at the front of the queue; then the ask -> consumed. The exact
// reverse pull request is M6's (lane 1, 0b-9), not M11's.
// Not clean (D8): when M6 records that an exact reverse is impossible (fact `reverse-<undo card>`
// with state not_clean), M11 writes a fix card at the front of the Lead's queue and alerts Joe, once.

import { note } from './moves.mjs';

export const UNDO_CARD = (askId) => `undo-${askId}`;
export const FIX_CARD = (undoId) => `fix-${undoId}`;
export const REVERSE_FACT = (undoId) => `reverse-${undoId}`;
const MERGED = ['merged', 'audited_ok', 'audit_flagged'];
const SHA = /^[0-9a-f]{40}$/;
const iso = (ms) => new Date(ms).toISOString();

/**
 * One pass. `filesOf(merge_commit_sha)` -> [paths] the commit changed (read from the mirror) or
 * null. `alert(text)`. Returns [[askId or card id, what happened]].
 */
export function undoStep({ rec, rules, now, filesOf, alert }) {
  const out = [];
  for (const { id, rev, doc } of rec.list('ask')) {
    if (doc.kind !== 'undo' || doc.state !== 'answered') continue;
    if (doc.via !== 'tap') { out.push([id, 'not a tap: nothing']); continue; }
    const counted = rules.may('count_approval', { ask: { id, ...doc } });
    if (counted.decision !== 'allow') { out.push([id, `not counted: ${counted.reason}`]); continue; }
    if (doc.pr == null || !SHA.test(String(doc.merge_commit_sha))) { out.push([id, 'names no merged PR']); continue; }
    const attempt = rec.list('merge').find((m) => m.doc.pr === doc.pr && m.doc.merge_commit_sha === doc.merge_commit_sha && MERGED.includes(m.doc.state));
    if (!attempt) { out.push([id, 'no merged attempt matches']); continue; }
    const cardId = UNDO_CARD(id);
    if (!rec.read('card', cardId)) {
      const files = filesOf(doc.merge_commit_sha);
      if (!Array.isArray(files)) { out.push([id, 'the reversed commit\'s files could not be read']); continue; }
      const w = rec.write({ actor: 'dispatcher', entity: 'card', id: cardId, expectRev: 0, kind: 'undo_card',
        doc: { state: 'ready', kind: 'undo', go_free: true, queue: 'front', files, pr: doc.pr, merge_commit_sha: doc.merge_commit_sha,
          product: attempt.doc.product ?? doc.product ?? null, reverses: attempt.id, from_ask: id, changed_at: iso(now) } });
      if (!w.ok) { out.push([id, `undo card not recorded: ${w.reason}`]); continue; }
    }
    rec.write({ actor: 'dispatcher', entity: 'ask', id, expectRev: rev, doc: { ...doc, state: 'consumed', consumed_at: iso(now), card: cardId }, kind: 'ask_consumed' });
    out.push([id, 'undo card written']);
  }
  // D8: an exact reverse M6 could not make.
  for (const { id, doc } of rec.list('card')) {
    if (doc.kind !== 'undo') continue;
    const r = rec.read('fact', REVERSE_FACT(id))?.doc;
    if (r?.state !== 'not_clean' || rec.read('card', FIX_CARD(id))) continue;
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: FIX_CARD(id), expectRev: 0, kind: 'undo_fix_card',
      doc: { state: 'ready', kind: 'fix', for: 'lead', queue: 'front', product: doc.product ?? null, about: id, pr: doc.pr ?? null,
        what: `the undo of PR ${doc.pr} could not be an exact reverse: ${r.reason ?? 'no reason given'}`, changed_at: iso(now) } });
    if (w.ok) {
      alert(`Undo of PR ${doc.pr} could not be done as an exact reverse; a fix card is first in the Lead's queue`);
      note(rec, `undo-note-${id}`, `undo ${id} not clean; fix card ${FIX_CARD(id)} written`, { now });
      out.push([id, 'fix card written']);
    }
  }
  return out;
}
