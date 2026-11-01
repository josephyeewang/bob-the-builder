// A card the Dispatcher puts on Joe is told to him (L130: no card waits on Joe silently).
//
// waitOnJoe records the tell first (fact `wait-tell-<card>`: the wait's `since` and the alert's text), then moves the
// card to wait, then queues the alert through tellThen, whose mark (`told_since`) is written only once a copy is
// delivered. retellWaits runs each tick: a card still waiting on Joe under that same wait, with no delivered mark for
// it, is told again (the same queue entry, not a second one). A tell that could not be recorded moves nothing, so the
// step that wanted the wait sees the card again next pass; a wait that could not be written leaves a tell whose `since`
// no wait has, which retellWaits ignores.

import { waitOn } from './moves.mjs';
import { tellThen, isQueued } from './alerts.mjs';

export const WAIT_TELL_FACT = (card) => `wait-tell-${card}`;
const iso = (ms) => new Date(ms).toISOString();

/** waitOn with who 'joe', told by `text` (see above). Returns waitOn's answer, or the tell's refusal. */
export function waitOnJoe(rec, id, { text, alert, now, ...wait }) {
  const since = iso(now);
  const cur = rec.read('fact', WAIT_TELL_FACT(id));
  const req = rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(id), expectRev: cur?.rev ?? 0, doc: { since, text }, kind: 'wait_tell' });
  if (!req.ok) return { ok: false, reason: `the tell could not be recorded: ${req.reason}` };
  const w = waitOn(rec, id, { who: 'joe', now, ...wait });
  if (w.ok) tellThen(alert, text, { fact: WAIT_TELL_FACT(id), fields: { told_since: since }, kind: 'wait_told' });
  return w;
}

/** Each tick: every card still waiting on Joe under a wait whose alert was not delivered is told again. */
export function retellWaits({ rec, alert }) {
  const out = [];
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(WAIT_TELL_FACT('')) || !f.doc?.since || f.doc.told_since === f.doc.since) continue;
    const card = f.id.slice(WAIT_TELL_FACT('').length);
    const c = rec.read('card', card)?.doc;
    if (c?.state !== 'waiting' || c.wait?.who !== 'joe' || c.wait.since !== f.doc.since || isQueued(rec, WAIT_TELL_FACT(card))) continue;
    tellThen(alert, f.doc.text, { fact: WAIT_TELL_FACT(card), fields: { told_since: f.doc.since }, kind: 'wait_told' });
    out.push([card, 'told again: waits on joe']);
  }
  return out;
}
