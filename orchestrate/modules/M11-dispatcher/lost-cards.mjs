// lost-cards.mjs — a card that can't be read is told to the owner, once then daily (L557). It is a tell only: nothing here
// moves or repairs a card.
//
// WHY. Every pass works from list('card'), and list leaves out a card that can't be read, so such a card is not refused or
// held: it is simply never looked at, and it waits in silence. The diary still holds its id, and read still reports it, so
// this check starts from the diary. It reads each line's writes: a plan writes all its cards in one line, and the line's
// own entity and id name only the first. The diary is walked as askStore already walks it on every read.
//
// The Record puts a changed file back at the first write of a run (recover), and this step runs after the pass, so what
// it finds has usually stood through that. In production the store's own corrupt_read goes only to a log.
//
// A card with a go still asked is M2's to tell, with that go's own words (go_card_unreadable), so it is left out here.
// All lost cards are one hold and one line a day, however many. The list is the wait's `since`, so a change in the list
// is told at once, and the mark clears when the last one reads again.

import { HOLD_FACT, clearHold } from './pass.mjs';
import { listed, tellThen } from './alerts.mjs';
import { goToldCards } from '../M2-approvals/schedule.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';

export const LOST_CARDS_FACT = HOLD_FACT('lost-cards');

const lostText = (lost) => `${lost.length === 1 ? 'card' : 'cards'} ${listed(lost)} can't be read, so no pass looks at ${lost.length === 1 ? 'it' : 'them'}: nothing moves until ${lost.length === 1 ? 'it is' : 'they are'} repaired by hand`;

/**
 * Told through the alert path. A diary that can't be opened throws, so the tick's step failure tells it. A diary with a
 * broken line does not throw: the store stops reading at that line, so a card written after it is not seen here. That
 * hold is M9's to tell (the store's diary_damaged), not this check's.
 */
export function tellLostCards({ rec, alert, now, report }) {
  const told = goToldCards(rec);
  const ids = new Set(rec.diary({ since: 0 }).flatMap((l) => l.writes ?? []).filter((w) => w.entity === 'card').map((w) => w.id));
  const lost = [...ids].filter((id) => { if (told.has(id)) return false; const c = rec.read('card', id); return !c || c.corrupt; }).sort();
  const since = lost.join(' ');
  const w = stillWaiting({
    now,
    ...(lost.length ? { since } : {}),
    waiting: lost.length > 0,
    read: () => rec.read('fact', LOST_CARDS_FACT)?.doc,
    tell: (fields) => { const text = lostText(lost); return tellThen(alert, text, { fact: LOST_CARDS_FACT, fields: { text, ...fields }, kind: 'hold_alert' }); },
    clear: () => clearHold(rec, LOST_CARDS_FACT, now, report),
  });
  if (w.did === 'unsent') report('the lost-cards alert could not be queued; it is tried again next pass');
  return { lost };
}
