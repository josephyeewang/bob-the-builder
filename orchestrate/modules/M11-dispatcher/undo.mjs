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
import { holdAlert } from './pass.mjs';

export const UNDO_CARD = (askId) => `undo-${askId}`;
export const FIX_CARD = (undoId) => `fix-${undoId}`;
export const REVERSE_FACT = (undoId) => `reverse-${undoId}`;
const MERGED = ['merged', 'audited_ok', 'audit_flagged'];
const SHA = /^[0-9a-f]{40}$/;
const iso = (ms) => new Date(ms).toISOString();
// The module an undo belongs to: the merged card's own (a card must name its module).
const moduleOf = (rec, attempt) => (attempt.card ? rec.read('card', attempt.card)?.doc?.module : null) ?? attempt.module ?? null;

/**
 * One pass. `filesOf(merge_commit_sha)` -> [paths] the commit changed (read from the mirror) or
 * null. `alert(text)`. Returns [[askId or card id, what happened]].
 * Each tap is read on its own (audit 0b-6 r4 MAT-4): one that throws holds no other. A tap that is
 * not acted on is told to Joe, once per tap and reason and again each day (L38: no silent hold).
 */
export function undoStep({ rec, rules, now, filesOf, alert }) {
  const out = [];
  for (const { id, rev, doc } of rec.list('ask')) {
    if (doc.kind !== 'undo' || doc.state !== 'answered') continue;
    const held = (cause, what) => {
      out.push([id, what]);
      try { holdAlert({ rec, cause: `undo-tap-${id}-${cause}`, text: `your Undo tap (ask ${id}, PR ${doc.pr ?? '?'}) is not acted on: ${what}`, alert, now }); }
      catch { /* the record is unwritable: the step's own error says so */ }
    };
    try { tap({ rec, rules, now, filesOf, alert, out, held, id, rev, doc }); }
    catch (e) { held('error', `it could not be read (${e?.message ?? e})`); }
  }
  fixCards({ rec, now, alert, out });
  return out;
}

function tap({ rec, rules, now, filesOf, alert, out, held, id, rev, doc }) {
  if (doc.via !== 'tap') return held('not-tap', 'not a tap: nothing');
  const counted = rules.may('count_approval', { ask: { id, ...doc } });
  if (counted.decision !== 'allow') return held('not-counted', `not counted: ${counted.reason}`);
  if (doc.pr == null || !SHA.test(String(doc.merge_commit_sha))) return held('no-pr', 'names no merged PR');
  const attempt = rec.list('merge').find((m) => m.doc.pr === doc.pr && m.doc.merge_commit_sha === doc.merge_commit_sha && MERGED.includes(m.doc.state));
  if (!attempt) return held('no-merge', 'no merged attempt matches');
  const cardId = UNDO_CARD(id);
  if (!rec.read('card', cardId)) {
    const files = filesOf(doc.merge_commit_sha);
    if (!Array.isArray(files)) return held('files', 'the reversed commit\'s files could not be read');
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: cardId, expectRev: 0, kind: 'undo_card',
      doc: { state: 'ready', kind: 'undo', go_free: true, queue: 'front', files, pr: doc.pr, merge_commit_sha: doc.merge_commit_sha,
        product: attempt.doc.product ?? doc.product ?? null, module: moduleOf(rec, attempt.doc) ?? doc.module ?? null, reverses: attempt.id, from_ask: id, changed_at: iso(now) } });
    if (!w.ok) {
      // Joe tapped Undo: a card that cannot be written (say, its module is unknown) is told to him, once a day.
      out.push([id, `undo card not recorded: ${w.reason}`]);
      holdAlert({ rec, cause: `undo-tap-${id}-not-recorded`, text: `your Undo of PR ${doc.pr} could not be queued: ${w.reason}; the Lead has to queue it by hand`, alert, now });
      return;
    }
  }
  rec.write({ actor: 'dispatcher', entity: 'ask', id, expectRev: rev, doc: { ...doc, state: 'consumed', consumed_at: iso(now), card: cardId }, kind: 'ask_consumed' });
  out.push([id, 'undo card written']);
}

// D8: an exact reverse M6 could not make.
function fixCards({ rec, now, alert, out }) {
  for (const { id, doc } of rec.list('card')) {
    if (doc.kind !== 'undo') continue;
    const r = rec.read('fact', REVERSE_FACT(id))?.doc;
    if (r?.state !== 'not_clean' || rec.read('card', FIX_CARD(id))) continue;
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: FIX_CARD(id), expectRev: 0, kind: 'undo_fix_card',
      // Waiting on the Lead, never `ready` (audit MAT-4): the Lead plans it; the start loop never picks it up.
      doc: { state: 'waiting', kind: 'fix', for: 'lead', queue: 'front', product: doc.product ?? null, module: doc.module ?? null, about: id, pr: doc.pr ?? null,
        waiting: { who: 'lead', what: `plan the fix: the undo of PR ${doc.pr} could not be an exact reverse`, since: iso(now), next_check: iso(now + 60 * 60_000) },
        what: `the undo of PR ${doc.pr} could not be an exact reverse: ${r.reason ?? 'no reason given'}`, changed_at: iso(now) } });
    if (w.ok) {
      alert(`Undo of PR ${doc.pr} could not be done as an exact reverse; a fix card is first in the Lead's queue`);
      note(rec, `undo-note-${id}`, `undo ${id} not clean; fix card ${FIX_CARD(id)} written`, { now });
      out.push([id, 'fix card written']);
    }
  }
}

/**
 * An undo card's own correctness check (LEAD-CALLS L40): it reverses a merge in the record (same PR,
 * same merge commit, merged), and its file list is the reversed commit's, read again now. Only then may
 * it start while a rules value is missing; it is asked of every undo start, so there is one rule.
 */
export function exactReverse({ rec, card, filesOf }) {
  const m = typeof card.reverses === 'string' ? rec.read('merge', card.reverses)?.doc : null;
  if (!m || !MERGED.includes(m.state) || m.pr !== card.pr || m.merge_commit_sha !== card.merge_commit_sha) return { ok: false, reason: 'it is not the reverse of a merge in the record' };
  let files;
  try { files = typeof filesOf === 'function' ? filesOf(card.merge_commit_sha) : null; } catch { files = null; }
  if (!Array.isArray(files) || !Array.isArray(card.files)) return { ok: false, reason: 'the reversed commit\'s files could not be read' };
  const set = (l) => [...new Set(l.map(String))].sort().join('\n');
  if (set(files) !== set(card.files)) return { ok: false, reason: 'its file list does not match the reversed commit' };
  return { ok: true };
}
