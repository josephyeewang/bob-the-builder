// A card waiting on Joe is told to him at once, and again every day while it still waits (L130, L315: the shared
// still-waiting rule; before L315 it was told once, ever, and a card could sit on Joe for a month without a word).
// Every card waiting on Joe is covered, not only those put there by waitOnJoe: a joe wait written with no tell (M9's
// round cap, writer.mjs; headless-result.mjs budget_stop until it goes through waitOnJoe) is given one here, whose text
// names the card, what it waits on, why, and what Joe can do (L316). A card parked because its product is paused
// (PAUSED_WAIT_WHAT) is not: it resumes by itself when Joe unpauses, and the trip brief shows it apart (L85 m-5).
//
// waitOnJoe records the tell first (fact `wait-tell-<card>`: the text, and `since`, the tick's time it asked at), then
// moves the card to wait, then reads the card back and copies the wait's STORED `since` onto the tell as `wait_since`
// (L138 MAT-1: the Record stamps a wait with its own clock, which need not be the tick's). Then it queues the alert
// through tellThen, whose mark (`told_since` = that stored since) is written only once a copy is delivered.
// retellWaits runs each tick, on stillWaiting: a card still waiting on Joe under that same wait is told again when no
// copy for this wait was delivered, or the last was delivered a day ago (the mark: `told_since`, the wait it told, and
// `told_at`). A queued copy is not queued twice. When the wait ends, a copy still queued is dropped and the mark cleared,
// so a new wait is told afresh. A tell that could not be recorded moves nothing, so the step that
// wanted the wait sees the card again next pass. A wait that could not be written leaves a tell no wait matches, which
// retellWaits ignores. A wait written but not yet copied onto its tell (that write failed) is matched by the Record's
// own window: the Record takes a wait only when its since is within 60 s of the Record's clock, so a joe wait whose
// since is within 60 s of the tell's asked time is the wait it asked for; retellWaits copies it on, then tells.

import { waitOn } from './moves.mjs';
import { tellThen, isQueued, dropCause } from './alerts.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { OWNER_WAIT_WHO, PAUSED_WAIT_WHAT } from '../../shared/record.mjs';

export const WAIT_TELL_FACT = (card) => `wait-tell-${card}`;
const iso = (ms) => new Date(ms).toISOString();
// The Record's window for a wait's since (M9 writer checkWait: within 60 s of its own clock).
const SINCE_WINDOW_MS = 60_000;

/** waitOn with who 'joe', told by `text` (see above). Returns waitOn's answer, or the tell's refusal. */
export function waitOnJoe(rec, id, { text, alert, now, ...wait }) {
  const since = iso(now);
  const cur = rec.read('fact', WAIT_TELL_FACT(id));
  const req = rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(id), expectRev: cur?.rev ?? 0, doc: { since, text }, kind: 'wait_tell' });
  if (!req.ok) return { ok: false, reason: `the tell could not be recorded: ${req.reason}` };
  const w = waitOn(rec, id, { who: 'joe', now, ...wait });
  if (!w.ok) return w;
  const stored = confirm(rec, id, rec.read('card', id)?.doc);
  if (stored) tellThen(alert, text, { fact: WAIT_TELL_FACT(id), fields: { told_since: stored, told_at: iso(now) }, kind: 'wait_told' });
  return w;
}

// The stored since of the wait tell `f` is for, on card doc `c`: its `wait_since` when copied on, else a joe wait
// within the Record's window of its asked time. null when the card waits on no such wait.
function waitOf(f, c) {
  if (c?.state !== 'waiting' || c.wait?.who !== 'joe' || !c.wait.since) return null;
  if (f.wait_since) return c.wait.since === f.wait_since ? f.wait_since : null;
  const gap = Math.abs(Date.parse(c.wait.since) - Date.parse(f.since));
  return Number.isFinite(gap) && gap <= SINCE_WINDOW_MS ? c.wait.since : null;
}

// Copies the stored since of the card's wait onto its tell. Returns it, or null when the card waits on no wait the
// tell is for, or the copy could not be written (the next pass matches by the window and tries again).
function confirm(rec, card, c) {
  const f = rec.read('fact', WAIT_TELL_FACT(card));
  if (!f?.doc?.since) return null;
  const stored = waitOf(f.doc, c);
  if (!stored || f.doc.wait_since === stored) return stored;
  const put = rewriteTell(rec, card, f.rev, { ...f.doc, wait_since: stored });
  return put.ok ? stored : null;
}

// Every write of a card's tell after waitOnJoe's first one, at the rev the caller read (one write site, L112).
const rewriteTell = (rec, card, expectRev, doc) => rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(card), expectRev, doc, kind: 'wait_tell' });

/** The text for a joe wait written with no tell: the card, what it waits on, why, and what Joe can do (L316). */
export function untoldWaitText(card, wait) {
  // The wait's reason says what the owner can do where its site wrote one (the round cap: cancel it, or a new card from
  // the Lead); with none, the general answer.
  const what = wait?.what ?? 'nothing named';
  if (typeof wait?.reason === 'string' && wait.reason) return `card ${card} waits on you (${what}): ${wait.reason}. Answer it through the Front Door`;
  return `card ${card} waits on you (${what}); no reason was recorded. Answer it through the Front Door: say how it goes on, or cancel the card`;
}

// A card waiting on Joe whose wait has no tell for it: one is written, so retellWaits tells it like any other (L316).
function adoptUntold(rec) {
  let cards;
  try { cards = rec.list('card'); } catch { return; }
  for (const { id, doc } of cards) {
    const w = doc?.wait;
    if (doc?.state !== 'waiting' || w?.who !== OWNER_WAIT_WHO || w.what === PAUSED_WAIT_WHAT || !w.since) continue;
    const f = rec.read('fact', WAIT_TELL_FACT(id));
    if (f?.doc?.since && waitOf(f.doc, doc)) continue;
    rewriteTell(rec, id, f?.rev ?? 0, { since: w.since, wait_since: w.since, text: untoldWaitText(id, w) });
  }
}

/** Each tick: every card waiting on Joe is told at once, then daily while the same wait lasts (shared stillWaiting). */
export function retellWaits({ rec, alert, now }) {
  const out = [];
  adoptUntold(rec);
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(WAIT_TELL_FACT('')) || !f.doc?.since) continue;
    const card = f.id.slice(WAIT_TELL_FACT('').length);
    const fact = WAIT_TELL_FACT(card);
    const c = rec.read('card', card)?.doc;
    const at = waitOf(f.doc, c);
    stillWaiting({
      now,
      waiting: !!at,
      // A mark for another wait (its told_since) is no mark for this one: a new wait is told at once.
      read: () => { const d = rec.read('fact', fact)?.doc; return d?.told_since === at ? d : null; },
      tell: ({ told_at }) => {
        if (isQueued(rec, fact)) return true;
        const stored = confirm(rec, card, c);
        if (!stored) return false;
        out.push([card, 'told again: waits on joe']);
        return tellThen(alert, f.doc.text, { fact, fields: { told_since: stored, told_at }, kind: 'wait_told' });
      },
      // The wait ended (or the tell is for no wait): a copy still queued leaves unsent, and a set mark is cleared.
      clear: () => {
        dropCause(rec, fact);
        const d = rec.read('fact', fact);
        if (d?.doc?.told_at != null) rewriteTell(rec, card, d.rev, { ...d.doc, told_at: null });
      },
    });
  }
  return out;
}
