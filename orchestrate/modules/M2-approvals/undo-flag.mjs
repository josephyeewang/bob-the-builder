// undo-flag.mjs — day 1 of the undo route (R-0b-140; L76 Minor 5, L77 m6, LEAD-CALLS L81): the owner tells the Front
// Door "that change was wrong" about a merged docs change, and an [Undo] push reaches the phone within 5 minutes.
//
// THE ROUTE. The skill writes `ask-request-<id>.json` { ask: "undo", product, pr, brief: the owner's words } (M1
// outbox.mjs). The record keeps it as an inert report. This pass, run with the rest of M2's pass, turns a report into an
// `undo` ask (urgent, tap: pushed at once and every 2 hours, schedule.mjs) carrying the Material finding it stands for.
// Joe's one tap binds through binding.mjs's real-turn checks (F2). The Dispatcher then writes the exact_reverse card
// with source { ask } (lane 2's M11 undo step); the Merge Gate serves it first (M6 queueOrder) and its merge takes the
// row's "done" back (M6 undo.mjs).
//
// WHAT FILES A FINDING. Only the owner's own words. A report counts only when it is
//   - from a Front Door session (role front_door; an incident session's or a worker's never),
//   - passes the Front Door's own file check again (a changed or never-checked report opens nothing),
//   - and its brief is in a real turn of the owner's in that session's conversation: typed, queued, or a box answer.
//     M1 transcript.mjs ownerTurns leaves out [watchdog]/[relay]/[dispatcher] lines and text Claude Code injects (a
//     cross-session message, a file's contents), so words a worker typed or the session found in a file don't count.
//     A conversation whose copy was rewritten (transcript-copy.mjs tampered) counts nothing.
// WHAT CAN BE UNDONE ON DAY 1. A change the docs lane merged (the first cutover merges nothing else; M10 engine
// mergeDocsLane), still merged and not reverted. A merge that added a file can't go back through the docs lane, which
// takes no removals: no Undo button is offered; the ask is kept as `undo_by_hand` (no tap, never pushed by schedule.mjs),
// MAIN is alerted to revert it by hand, and the owner's push says so.
//
//   await openUndoFlags(ctx, { entriesOf, addedBy }) → { opened: [{ id, push }], byHand: [{ id, push }], refused: [{ report, reason }] }
//     ctx = { record, product, now, alert, copies? }
//     entriesOf(sessionId) → the session's conversation entries (from M2's own copy) | null when it can't be read
//     addedBy(mergeCommit) → the paths that merge added or renamed to | null when it can't be told (then: by hand)
//   One ask per report (restart-safe: the ask keeps `request`), one undo per merged card.
//   `byHand` is every open undo_by_hand ask whose push is not marked sent, this pass's or an earlier one's: the caller
//   sends each, then calls markByHandPushSent(ctx, id); anything not marked is handed back next pass (L95, audit stack r3
//   Minor 3; L117 M-1). A tap undo's push needs no mark: schedule.mjs pushes every open undo ask itself. MAIN's
//   `undo_by_hand` alert is sent by the pass on every pass until it goes through, then marked main_alert_sent_at
//   (L117 m-2). A report that throws is refused with a fixed reason and the message in `error`, and the pass goes on; an
//   alert sink that throws ends nothing. A refused report is alerted once per report and reason (with ctx.stateDir;
//   stack r3 Minor 2), as research-ask.mjs does.
//   The push names the change by the card's `what`, which no writer can change after the card is made (M9
//   CARD_CREATE_ONLY), never by `brief`, which the Lead may edit (stack r3 Minor 6, the L84 2 class).
//
// The undo ask carries what lane 2's undo step joins on (L81): `pr`, `merge_commit_sha`, `module`, and `card`, the merged
// card. It has no top-level `via`: the channel is read only from the answer (lane 2's shared/approval.mjs).

import { checkOutboxFile } from '../M1-front-door/outbox.mjs';
import { ownerTurns } from '../M1-front-door/transcript.mjs';
import { askStore, markPushSent, markSent, writeDoc } from './ask-store.mjs';
import { createAsk } from './binding.mjs';
import { claimedAsk, onceAlerts, safeAlert } from './research-ask.mjs';
import { undoPushText } from './go-view.mjs';

export const UNDO_ID = /^U-[1-9]\d{0,5}$/;
export const BY_HAND_KIND = 'undo_by_hand';
// The one way to mark a by-hand push sent: the kind is fixed here, so a caller can't leave it out (L117 M-1).
export const markByHandPushSent = (ctx, id) => markPushSent(ctx, id, [BY_HAND_KIND]);
const SHA = /^[0-9a-f]{40}$/;
const iso = (ms) => new Date(ms).toISOString();
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function nextId(record) {
  // Every ask id counts, trusted or not, so a new ask never lands on an existing one.
  const n = record.list('ask').map((a) => /^U-(\d+)$/.exec(String(a.id))?.[1]).filter(Boolean).map(Number);
  return `U-${(n.length ? Math.max(...n) : 0) + 1}`;
}

// Are the owner's words in one of their own turns of this session? Typed, queued or a box answer; never anything else.
export function saidByOwner(entries, brief) {
  if (!Array.isArray(entries)) return false;
  const want = norm(brief);
  if (!want) return false;
  return ownerTurns(entries).some((t) => (t.kind === 'typed' || t.kind === 'answer') && norm(t.text).includes(want));
}

// The merged docs-lane card a pull request number names, or why there is none.
export function mergedDocsChange(record, pr) {
  const ms = record.list('merge').filter((m) => m.doc?.pr === pr && SHA.test(m.doc?.merge_commit ?? ''));
  if (!ms.length) return { ok: false, reason: `pull request #${pr} was not merged by the Merge Gate` };
  if (ms.length > 1) return { ok: false, reason: `pull request #${pr} has more than one merge on record` };
  const m = ms[0];
  const card = record.read('card', m.doc.card);
  if (!card?.doc) return { ok: false, reason: `the card of pull request #${pr} is not in the record` };
  if (card.doc.state === 'reverted') return { ok: false, reason: `pull request #${pr} is already undone` };
  if (card.doc.state !== 'merged' || card.doc.merge_commit !== m.doc.merge_commit) return { ok: false, reason: `pull request #${pr} is not merged and live` };
  if (card.doc.lane !== 'docs') return { ok: false, reason: `pull request #${pr} is not a docs change; on day 1 MAIN undoes it as today` };
  return { ok: true, card, merge: m, commit: m.doc.merge_commit };
}

export async function openUndoFlags(ctx, { entriesOf, addedBy } = {}) {
  const { record, product, now } = ctx;
  const failed = { n: 0 };
  const alert = safeAlert(ctx, failed);
  const st = askStore(record);
  const asks = record.list('ask');
  const done = new Set(asks.map((a) => a.doc?.request).filter(Boolean));
  const undone = new Set(asks.filter((a) => a.doc?.kind === 'undo' || a.doc?.kind === BY_HAND_KIND).map((a) => a.doc.card));
  const opened = []; const refused = [];
  for (const rep of record.list('report')) {
    const d = rep.doc;
    if (!d || d.kind !== 'ask-request-' || done.has(rep.id) || claimedAsk(d.text) !== 'undo') continue;
    const no = (reason, error) => { refused.push({ report: rep.id, reason, ...(error === undefined ? {} : { error }) }); };
    try {
      if (d.role !== 'front_door') { no('an undo comes only from the owner, through the Front Door'); continue; }
      const r = checkOutboxFile(String(d.source ?? ''), String(d.text ?? ''));
      if (!r.ok) { no(r.reason); continue; }
      if (r.kind !== 'ask-request' || r.doc.ask !== 'undo') { no('not an undo request'); continue; }
      if (r.doc.product !== product) { no('that product is not this record\'s'); continue; }
      const sid = String(d.session_id ?? '');
      if (ctx.copies?.tampered?.(sid)) { no('that conversation\'s copy was changed, so nothing in it counts'); continue; }
      let entries = null;
      try { entries = typeof entriesOf === 'function' ? await entriesOf(sid) : null; } catch { entries = null; }
      if (!saidByOwner(entries, r.doc.brief)) { no('those words are not in a turn of the owner\'s own'); continue; }
      const found = mergedDocsChange(record, r.doc.pr);
      if (!found.ok) { no(found.reason); continue; }
      const { card, commit } = found;
      if (undone.has(card.id)) { no(`card ${card.id} already has its undo`); continue; }
      let added = null;
      try { added = typeof addedBy === 'function' ? await addedBy(commit) : null; } catch { added = null; }
      const title = card.doc.what ?? card.id;
      const id = nextId(record);
      const t = now();
      const finding = { severity: 'Material', merged: true, live: true, by: 'owner', words: r.doc.brief, at: iso(t) };
      const join = { pr: r.doc.pr, merge_commit_sha: commit, module: card.doc.module ?? null, finding, request: rep.id };
      if (!Array.isArray(added) || added.length) {
        // Day 1: a removal can't go through the docs lane, and an unknown file list is treated the same way.
        const files = Array.isArray(added) ? added : [];
        const doc = { kind: BY_HAND_KIND, product, card: card.id, title, state: 'open', created_at: iso(t), origin_session: sid, ...join,
          added_files: files, files_known: Array.isArray(added),
          by_hand: { who: 'MAIN', what: `revert pull request #${r.doc.pr} by hand, first, before anything else merges` } };
        const w = writeDoc(record, 'ask', { id, rev: 0 }, doc);
        if (!w.ok) { no(`the record refused the ask: ${w.reason}`); continue; }
        done.add(rep.id); undone.add(card.id);
        continue;
      }
      const c = createAsk(ctx, { id, kind: 'undo', card: card.id, title, origin_session: sid, extra: join });
      if (!c.ok) { no(`the undo ask was not opened: ${c.reason}`); continue; }
      done.add(rep.id); undone.add(card.id);
      opened.push({ id, push: undoPushText({ card: card.id, title, pr: r.doc.pr }) });
    } catch (e) {
      no('the pass failed on it', String(e?.message ?? e));
    }
  }
  if (st.untrusted.length) alert({ kind: 'untrusted_ask', items: st.untrusted });
  onceAlerts(ctx, refused, { file: 'undo-refused.json', make: (f) => ({ type: 'undo_request_refused', ...f }), alert,
    notSaved: 'undo_refused_state_not_saved' });
  // MAIN's alert for every open by-hand ask not yet told, rebuilt from the ask; marked only once it went through (L117 m-2).
  const handAsks = askStore(record).asks().filter((a) => a.doc.kind === BY_HAND_KIND && a.doc.product === product && a.doc.state === 'open');
  // A write that throws here is counted in alerts_failed and the pass goes on (L124 m-2); the ask is alerted again next pass.
  for (const a of handAsks.filter((x) => !x.doc.main_alert_sent_at)) {
    const files = Array.isArray(a.doc.added_files) ? a.doc.added_files : [];
    try {
      if (alert({ type: 'undo_by_hand', ask: a.id, card: a.doc.card, pr: a.doc.pr, commit: a.doc.merge_commit_sha, files })) {
        const m = markSent(ctx, a.id, [BY_HAND_KIND], 'main_alert_sent_at');
        if (!m.ok) alert({ type: 'undo_by_hand_mark_failed', ask: a.id, reason: m.reason });
      }
    } catch { failed.n += 1; }
  }
  // Every open by-hand ask whose push is not marked sent, rebuilt from what the ask holds (trusted asks only).
  const byHand = askStore(record).asks()
    .filter((a) => a.doc.kind === BY_HAND_KIND && a.doc.product === product && a.doc.state === 'open' && !a.doc.push_sent_at)
    .map((a) => ({ id: a.id, push: undoPushText({ card: a.doc.card, title: a.doc.title, pr: a.doc.pr,
      addedFiles: Array.isArray(a.doc.added_files) ? a.doc.added_files : [], unknownFiles: a.doc.files_known !== true }) }));
  return { opened, byHand, refused, ...(failed.n ? { alerts_failed: failed.n } : {}) };
}
