// A card the Dispatcher puts on Joe through waitOnJoe is told to him until a copy is delivered (L130). Not every wait
// on Joe goes through here yet: M4 headless-result.mjs budget_stop (L138 m5) is open, on the alert inventory.
//
// waitOnJoe records the tell first (fact `wait-tell-<card>`: the text, and `since`, the tick's time it asked at), then
// moves the card to wait, then reads the card back and copies the wait's STORED `since` onto the tell as `wait_since`
// (L138 MAT-1: the Record stamps a wait with its own clock, which need not be the tick's). Then it queues the alert
// through tellThen, whose mark (`told_since` = that stored since) is written only once a copy is delivered.
// retellWaits runs each tick: a card still waiting on Joe under that same wait, with no delivered mark for it, is told
// again (the same queue entry, not a second one). A tell that could not be recorded moves nothing, so the step that
// wanted the wait sees the card again next pass. A wait that could not be written leaves a tell no wait matches, which
// retellWaits ignores. A wait written but not yet copied onto its tell (that write failed) is matched by the Record's
// own window: the Record takes a wait only when its since is within 60 s of the Record's clock, so a joe wait whose
// since is within 60 s of the tell's asked time is the wait it asked for; retellWaits copies it on, then tells.

import { waitOn } from './moves.mjs';
import { tellThen, isQueued } from './alerts.mjs';

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
  if (stored) tellThen(alert, text, { fact: WAIT_TELL_FACT(id), fields: { told_since: stored }, kind: 'wait_told' });
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
  const put = rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(card), expectRev: f.rev, doc: { ...f.doc, wait_since: stored }, kind: 'wait_tell' });
  return put.ok ? stored : null;
}

/** Each tick: every card still waiting on Joe under a wait whose alert was not delivered is told again. */
export function retellWaits({ rec, alert }) {
  const out = [];
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(WAIT_TELL_FACT('')) || !f.doc?.since) continue;
    const card = f.id.slice(WAIT_TELL_FACT('').length);
    const c = rec.read('card', card)?.doc;
    const at = waitOf(f.doc, c);
    if (!at || f.doc.told_since === at || isQueued(rec, WAIT_TELL_FACT(card))) continue;
    const stored = confirm(rec, card, c);
    if (!stored) continue;
    tellThen(alert, f.doc.text, { fact: WAIT_TELL_FACT(card), fields: { told_since: stored }, kind: 'wait_told' });
    out.push([card, 'told again: waits on joe']);
  }
  return out;
}
