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
// since is within 60 s of the tell's asked time is the wait it asked for; retellWaits copies it on, then tells, and
// tells with the refusal in the text if the copy is refused again.
// A card that already waits on Joe for the same `what` keeps its stored since (L296, M9 guard.mjs keptSince), so the
// tell's asked time is that kept since, not now (audit #153 m1): the window then matches it, and the new tell is sent.

import { waitOn } from './moves.mjs';
import { tellThen, isQueued } from './alerts.mjs';
import { keptSince } from '../M9-record/guard.mjs';

// Two kinds of write on that fact. `wait_tell` records the tell before the card moves; if it is refused nothing has moved,
// so refused-writes.mjs tells it (L386: nothing else would). `wait_tell_copy` only copies the since on, with the card
// already waiting: it is told in the card's own text (tell_refused), so it must not read as "could not be put on you".
export const WAIT_TELL_FACT = (card) => `wait-tell-${card}`;
const iso = (ms) => new Date(ms).toISOString();
// The Record's window for a wait's since (M9 writer checkWait: within 60 s of its own clock).
const SINCE_WINDOW_MS = 60_000;

/** waitOn with who 'joe', told by `text` (see above). Returns waitOn's answer, or the tell's refusal. */
export function waitOnJoe(rec, id, { text, alert, now, ...wait }) {
  const card = rec.read('card', id)?.doc;
  const since = (card?.state === 'waiting' ? keptSince({ wait: { who: 'joe', what: wait.what }, kept: card.wait, nowMs: now }) : null) ?? iso(now);
  const cur = rec.read('fact', WAIT_TELL_FACT(id));
  const req = rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(id), expectRev: cur?.rev ?? 0, doc: { since, text }, kind: 'wait_tell' });
  if (!req.ok) return { ok: false, reason: `the tell could not be recorded: ${req.reason}`, ...(req.watched ? { watched: req.watched } : {}) };
  const w = waitOn(rec, id, { who: 'joe', now, ...wait });
  if (!w.ok) return w;
  // The wait just written is this tell's: its stored since is copied on as it is, not matched by the window, which the
  // Writer judges on its own clock, not the tick's (audit #153 r2 m1-r).
  // A refused copy still tells (L338): this tell knows its since, and the window may never match it again. The refusal
  // is in the text Joe reads and in the answer, never dropped (L323).
  const c = rec.read('card', id)?.doc;
  const ours = waitOf({}, c, true);
  if (!ours) return w;
  const { stored, refused } = copyOn(rec, id, c, true);
  const why = stored ? null : notKept(refused);
  tellThen(alert, why ? `${text} (${why})` : text, { fact: WAIT_TELL_FACT(id), fields: { told_since: ours }, kind: 'wait_told' });
  return why ? { ...w, tell_refused: why } : w;
}

// What the owner reads when the copy was refused (L338): the tell knows its since, so it is told anyway.
const notKept = (refused) => `this card's tell could not be kept with its wait (${refused ?? 'no answer'}); it may not be told again if this copy is lost`;

// The stored since of the wait tell `f` is for, on card doc `c`: its `wait_since` when copied on, else a joe wait
// within the Record's window of its asked time (any joe wait, when `ours`). null when the card waits on no such wait.
function waitOf(f, c, ours = false) {
  if (c?.state !== 'waiting' || c.wait?.who !== 'joe' || !c.wait.since) return null;
  if (ours) return c.wait.since;
  if (f.wait_since) return c.wait.since === f.wait_since ? f.wait_since : null;
  const gap = Math.abs(Date.parse(c.wait.since) - Date.parse(f.since));
  return Number.isFinite(gap) && gap <= SINCE_WINDOW_MS ? c.wait.since : null;
}

// Copies the stored since of the card's wait onto its tell. Returns { stored }, or { stored: null, refused } when the
// copy could not be written. `ours`: the caller just wrote this card's joe wait for this tell, so its since is taken
// without the window.
function copyOn(rec, card, c, ours) {
  const f = rec.read('fact', WAIT_TELL_FACT(card));
  if (!f?.doc?.since) return { stored: null, refused: 'the tell is not on the Record' };
  const stored = waitOf(f.doc, c, ours);
  if (!stored || f.doc.wait_since === stored) return { stored, refused: null };
  const put = rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(card), expectRev: f.rev, doc: { ...f.doc, wait_since: stored }, kind: 'wait_tell_copy' });
  return put?.ok ? { stored, refused: null } : { stored: null, refused: String(put?.reason ?? 'no answer').slice(0, 300) };
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
    // A refused copy still tells (L405 m1, as waitOnJoe since L338): the since in hand is the window's match.
    const { stored, refused } = copyOn(rec, card, c, false);
    const why = stored ? null : notKept(refused);
    tellThen(alert, why ? `${f.doc.text} (${why})` : f.doc.text, { fact: WAIT_TELL_FACT(card), fields: { told_since: stored ?? at }, kind: 'wait_told' });
    out.push([card, why ? `told again: waits on joe; ${why}` : 'told again: waits on joe']);
  }
  return out;
}
