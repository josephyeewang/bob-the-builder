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
// since is within 60 s of the tell's asked time is the wait it asked for; retellWaits copies it on, then tells, and
// tells with the refusal in the text if the copy is refused again.
// A card that already waits on Joe for the same `what` keeps its stored since (L296, M9 guard.mjs keptSince), so the
// tell's asked time is that kept since, not now (audit #153 m1): the window then matches it, and the new tell is sent.

import { waitOn } from './moves.mjs';
import { tellThen, isQueued, dropCause, clearCause } from './alerts.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { OWNER_WAIT_WHO, PAUSED_WAIT_WHAT } from '../../shared/record.mjs';
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
  // A copy still queued for the card's last wait (on Joe too) is about a wait that has ended: it leaves unsent (L355 m4).
  // A refused drop is in the answer (L359): the new tell, once queued, replaces that copy in place (one entry per cause),
  // so the old text goes out only when this tell is not queued either.
  const dropped = dropCause(rec, WAIT_TELL_FACT(id));
  const kept = (answer) => (dropped ? answer : { ...answer, old_copy_kept: 'a reminder still queued for the last wait could not be dropped' });
  // The wait just written is this tell's: its stored since is copied on as it is, not matched by the window, which the
  // Writer judges on its own clock, not the tick's (audit #153 r2 m1-r).
  // A refused copy still tells (L338): this tell knows its since, and the window may never match it again. The refusal
  // is in the text Joe reads and in the answer, never dropped (L323).
  const c = rec.read('card', id)?.doc;
  const ours = waitOf({}, c, true);
  if (!ours) return kept(w);
  const { stored, refused } = copyOn(rec, id, c, true);
  const why = stored ? null : notKept(refused);
  tellThen(alert, why ? `${text} (${why})` : text, { fact: WAIT_TELL_FACT(id), fields: { told_since: ours, told_at: iso(now) }, kind: 'wait_told' });
  return kept(why ? { ...w, tell_refused: why } : w);
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
  const put = rewriteTell(rec, card, f.rev, { ...f.doc, wait_since: stored });
  return put?.ok ? { stored, refused: null } : { stored: null, refused: String(put?.reason ?? 'no answer').slice(0, 300) };
}

// Every write of a card's tell after waitOnJoe's first one, at the rev the caller read (one write site, L112).
const rewriteTell = (rec, card, expectRev, doc) => rec.write({ actor: 'dispatcher', entity: 'fact', id: WAIT_TELL_FACT(card), expectRev, doc, kind: 'wait_tell_copy' });

/** The text for a joe wait written with no tell: the card, what it waits on, why, and what Joe can do (L316). */
export function untoldWaitText(card, wait) {
  // The wait's reason says what the owner can do where its site wrote one (the round cap: cancel it, or a new card from
  // the Lead); with none, the general answer.
  const what = wait?.what ?? 'nothing named';
  if (typeof wait?.reason === 'string' && wait.reason) return `card ${card} waits on you (${what}): ${wait.reason}. Answer it through the Front Door`;
  return `card ${card} waits on you (${what}); no reason was recorded. Answer it through the Front Door: say how it goes on, or cancel the card`;
}

// A card waiting on Joe whose wait has no tell for it: one is written, so retellWaits tells it like any other (L316).
// A copy still queued for an older wait leaves unsent first (L355 m4). Returns the writes the Record refused (L323, L355
// m1): without its tell the card would never be told, so retellWaits throws them, and the tick tells Joe daily.
function adoptUntold(rec) {
  const refused = [];
  let cards;
  try { cards = rec.list('card'); } catch { return refused; }
  for (const { id, doc } of cards) {
    const w = doc?.wait;
    if (doc?.state !== 'waiting' || w?.who !== OWNER_WAIT_WHO || w.what === PAUSED_WAIT_WHAT || !w.since) continue;
    const f = rec.read('fact', WAIT_TELL_FACT(id));
    if (f?.doc?.since && waitOf(f.doc, doc)) continue;
    const text = untoldWaitText(id, w);
    // A refused drop is thrown and told too (L359): the old wait's text would go out as if it were this one's.
    if (!dropCause(rec, WAIT_TELL_FACT(id))) refused.push(`${text} (a reminder still queued for its last wait could not be dropped)`);
    const put = rewriteTell(rec, id, f?.rev ?? 0, { since: w.since, wait_since: w.since, text });
    if (!put.ok) refused.push(`${text} (its reminder could not be recorded: ${put.reason ?? 'no reason'})`);
  }
  return refused;
}

/** Each tick: every card waiting on Joe is told at once, then daily while the same wait lasts (shared stillWaiting). */
export function retellWaits({ rec, alert, now }) {
  const out = [];
  const refused = adoptUntold(rec);
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
        // A refused copy still tells (L405 m1, as waitOnJoe since L338): the since in hand is the window's match.
        const { stored, refused: copyRefused } = copyOn(rec, card, c, false);
        const why = stored ? null : notKept(copyRefused);
        out.push([card, why ? `told again: waits on joe; ${why}` : 'told again: waits on joe']);
        return tellThen(alert, why ? `${f.doc.text} (${why})` : f.doc.text, { fact, fields: { told_since: stored ?? at, told_at }, kind: 'wait_told' });
      },
      // The wait ended (or the tell is for no wait): a copy still queued leaves unsent, then a set mark is cleared. A
      // refused drop or clear is in the step's answer: a mark counts only for the wait it names (L355 m1, L359).
      clear: () => clearCause(rec, fact, () => {
        const d = rec.read('fact', fact);
        if (d?.doc?.told_at == null) return;
        const put = rewriteTell(rec, card, d.rev, { ...d.doc, told_at: null });
        if (!put.ok) out.push([card, `told mark not cleared: ${put.reason ?? 'no reason'}`]);
      }, (line) => out.push([card, line])),
    });
  }
  // Thrown after every other card is told: the tick's step error tells Joe at once, and daily while it lasts.
  if (refused.length) throw new Error(`cards wait on you whose reminder could not be kept right: ${refused.join('; ')}`);
  return out;
}
