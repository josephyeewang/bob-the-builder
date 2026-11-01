// The [Undo] tap (R-0b-68; design v4 D8; review 0b-6 M21; L72, L74).
//
// M11 acts only on an `ask` of kind undo that approvals marked `answered` by a tap with the choice Undo, that M2
// counted (shared/approval.mjs answerCounts: M10's count_approval answers "ask" at the tap's tier, L81), and whose card is merged with a merge commit the record holds. It
// writes one undo card per ask: M9's kind exact_reverse, its `source` naming the ask (the reversed commit comes from
// the source, never from a field on the card: M6 undo.mjs undoneBy), with the reversed commit's files, created in
// draft and moved to ready (go-free). The Record lets one exact_reverse card per ask, so asking again is harmless; the
// ask itself is approvals' to close (answered → consumed is approvals' move, and M2 has no consume call yet: told to
// the lead). The exact reverse pull request is M6's (lane 1, 0b-9), not M11's.
// Not clean (D8): when M6 records that an exact reverse is impossible (fact `reverse-<undo card>`, merge_gate's own,
// with state not_clean), M11 writes a fix card for the failed undo card (M9: a fix card fixes a failed card, its plan the
// root's; it stays a draft, so the start loop never picks it up) and alerts Joe, once. While the undo card has not
// failed, the Lead is told instead.

import { note, move } from './moves.mjs';
import { holdAlert } from './pass.mjs';
import { undoneBy } from '../M6-merge-gate/undo.mjs';
import { factFrom, PLAN_INPUTS } from '../M9-record/permissions.mjs';
import { answerCounts } from '../../shared/approval.mjs';

export const UNDO_CARD = (askId) => `undo-${askId}`;
export const FIX_CARD = (undoId) => `fix-${undoId}`;
export const REVERSE_FACT = (undoId) => `reverse-${undoId}`;
const MERGED = ['merged', 'audited_ok', 'audit_flagged'];
const SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 7);

// The merge that made `cardId`'s merge commit, or null.
function mergeOf(rec, cardId, commit) {
  return rec.list('merge').find((m) => m.doc?.card === cardId && MERGED.includes(m.doc.state) && m.doc.merge_commit === commit) ?? null;
}

/**
 * One pass. `filesOf(merge_commit)` -> [paths] the commit changed (read from the mirror) or null. `alert(text)`.
 * Returns [[askId or card id, what happened]]. Each tap is read on its own (audit 0b-6 r4 MAT-4): one that throws holds
 * no other. A tap that is not acted on is told to Joe, once per tap and reason and again each day (L38: no silent hold).
 */
export async function undoStep({ rec, rules, now, filesOf, alert }) {
  const out = [];
  for (const { id, doc } of rec.list('ask')) {
    if (doc.kind !== 'undo' || doc.state !== 'answered') continue;
    const held = async (cause, what) => {
      out.push([id, what]);
      try { holdAlert({ rec, cause: `undo-tap-${id}-${cause}`, text: `your Undo tap (ask ${id}, card ${doc.card ?? '?'}) is not acted on: ${what}`, alert, now }); }
      catch { /* the record is unwritable: the step's own error says so */ }
    };
    try { await tap({ rec, rules, now, filesOf, alert, out, held, id, doc }); }
    catch (e) { await held('error', `it could not be read (${e?.message ?? e})`); }
  }
  fixCards({ rec, now, alert, out });
  return out;
}

async function tap({ rec, rules, now, filesOf, alert, out, held, id, doc }) {
  // The tap's one undo card (the Record lets one exact_reverse card per ask, under any id): this step names it
  // UNDO_CARD(ask); one the Lead queued by hand for the same ask is the same card. Done already once past draft.
  const have = rec.read('card', UNDO_CARD(id)) ?? rec.list('card').find((c) => c.doc.kind === 'exact_reverse' && c.doc.source?.ask === id) ?? null;
  const cardId = have?.id ?? UNDO_CARD(id);
  if (have && have.doc.state !== 'draft') return;
  const a = doc.answer;
  if (a?.channel !== 'tap') return await held('not-tap', 'not a tap: nothing');
  // "Keep" is an answer too: only the Undo choice (the ask's first) undoes.
  if (a.choice !== (doc.choices?.[0] ?? 'Undo') || a.approves !== true) return;
  // The one approval check M2 made when it recorded the answer, asked again now (L81).
  const counted = answerCounts(rules, doc, { approves: true });
  if (!counted.ok) return await held('not-counted', `not counted: ${counted.reason}`);
  const target = typeof doc.card === 'string' ? rec.read('card', doc.card) : null;
  const commit = target?.doc?.merge_commit;
  if (!SHA.test(String(commit ?? ''))) return await held('no-merge', 'its card has no merge commit in the record');
  const m = mergeOf(rec, target.id, commit);
  if (!m) return await held('no-merge', 'no merged attempt matches');
  if (!have) {
    const files = filesOf(commit);
    if (!Array.isArray(files)) return await held('files', 'the reversed commit\'s files could not be read');
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: cardId, expectRev: 0, kind: 'undo_card',
      doc: { state: 'draft', kind: 'exact_reverse', source: { ask: id }, files, product: target.doc.product ?? null, module: target.doc.module ?? null,
        what: `undo PR ${m.doc.pr ?? '?'} (merge ${short(commit)} of card ${target.id})` } });
    if (!w.ok) {
      // Joe tapped Undo: a card that cannot be written (say, its module is unknown) is told to him, once a day.
      out.push([id, `undo card not recorded: ${w.reason}`]);
      holdAlert({ rec, cause: `undo-tap-${id}-not-recorded`, text: `your Undo of PR ${m.doc.pr ?? '?'} could not be queued: ${w.reason}; the Lead has to queue it by hand`, alert, now });
      return;
    }
  }
  // draft → ready: an exact_reverse card is go-free (M9 ready rule). A refusal is told; the next pass tries again.
  const r = move(rec, 'card', cardId, { state: 'ready' }, { kind: 'undo_ready' });
  if (!r.ok) {
    out.push([id, `undo card not ready: ${r.reason}`]);
    holdAlert({ rec, cause: `undo-tap-${id}-not-ready`, text: `your Undo of PR ${m.doc.pr ?? '?'} is queued but can't start: ${r.reason}`, alert, now });
    return;
  }
  out.push([id, 'undo card written']);
}

// D8: an exact reverse M6 could not make. Only the gate's own reverse- fact counts (L74 addendum).
function fixCards({ rec, now, alert, out }) {
  for (const { id, doc } of rec.list('card')) {
    if (doc.kind !== 'exact_reverse') continue;
    const fid = REVERSE_FACT(id);
    const f = rec.read('fact', fid);
    if (f?.doc?.state !== 'not_clean' || !factFrom('merge_gate', { id: fid, createdBy: rec.meta?.('fact', fid)?.createdBy ?? null }, 'reverse-')) continue;
    if (rec.read('card', FIX_CARD(id))) continue;
    const why = `the undo (card ${id}) could not be an exact reverse: ${f.doc.reason ?? 'no reason given'}`;
    if (doc.state !== 'failed') {
      // The Record gives a fix card only to a failed card: until this one fails, the Lead is told, once a day.
      holdAlert({ rec, cause: `undo-not-clean-${id}`, text: `${why}; the Lead plans the fix once the undo card has failed`, alert, now });
      continue;
    }
    const plan = Object.fromEntries(PLAN_INPUTS.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]));
    const w = rec.write({ actor: 'dispatcher', entity: 'card', id: FIX_CARD(id), expectRev: 0, kind: 'undo_fix_card',
      // A draft, never `ready` (audit MAT-4): the Lead plans it; the start loop never picks it up.
      doc: { state: 'draft', kind: 'fix', fix_of: id, product: doc.product ?? null, module: doc.module ?? null, what: why, ...plan } });
    if (w.ok) {
      alert(`${why}; a fix card waits for the Lead`);
      note(rec, `undo-note-${id}`, `undo ${id} not clean; fix card ${FIX_CARD(id)} written`, { now });
      out.push([id, 'fix card written']);
    } else out.push([id, `fix card not recorded: ${w.reason}`]);
  }
}

/**
 * An undo card's own correctness check (LEAD-CALLS L40): it reverses a merge in the record (its source names a card
 * merged at that commit: M6 undoneBy, the gate's own reading), and its file list is the reversed commit's, read again
 * now. Only then may it start while a rules value is missing; it is asked of every undo start, so there is one rule.
 */
export function exactReverse({ rec, card, filesOf }) {
  const d = undoneBy(rec, { id: card.id, doc: card });
  if (!d || !d.card || !mergeOf(rec, d.card, d.commit)) return { ok: false, reason: 'it is not the reverse of a merge in the record' };
  let files;
  try { files = typeof filesOf === 'function' ? filesOf(d.commit) : null; } catch { files = null; }
  if (!Array.isArray(files) || !Array.isArray(card.files)) return { ok: false, reason: 'the reversed commit\'s files could not be read' };
  const set = (l) => [...new Set(l.map(String))].sort().join('\n');
  if (set(files) !== set(card.files)) return { ok: false, reason: 'its file list does not match the reversed commit' };
  return { ok: true };
}
