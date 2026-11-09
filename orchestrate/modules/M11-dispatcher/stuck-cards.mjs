// stuck-cards.mjs — a card past its time limit is told to the owner, once then daily (L569). It is a tell only: nothing
// here moves a card, and a limit's `then:` is not applied. Moving cards by the clock stays out of the first cutover.
//
// WHY. The rules give each state a time limit and the Record can list what is past one (rec.overdue), but nothing read
// that list, so a card that stopped in one of these states sat in silence (a silent hold, L501).
//
// The list is L569's five states: ready, running, in_review, verified, approved. `merged` stays quiet: no code moves
// merged to closed, so every merged card would be told for ever. An entry the Record marks corrupt is always told,
// whatever it names, because it says the limits themselves can't be worked out.
//
// All stuck cards are one hold and one line a day, however many. The list is the wait's `since`, so a change in the list
// is told at once, and the mark clears when the last one moves on.

import { HOLD_FACT, clearHold } from './pass.mjs';
import { listed, plain, tellThen } from './alerts.mjs';
import { pastTime, stillWaiting } from '../../shared/still-waiting.mjs';

export const STUCK_CARDS_FACT = HOLD_FACT('stuck-cards');
export const STUCK_STATES = Object.freeze(['ready', 'running', 'in_review', 'verified', 'approved']);

const stuck = (o) => o.entity === 'card' && STUCK_STATES.includes(o.state);
const nameOf = (o, now) => `${o.id} (${o.state}${pastTime(o.since, now) === null ? ', its start time can\'t be read' : ''})`;
const keyOf = (o) => `${o.entity}:${o.id}:${o.corrupt ? 'corrupt' : `${o.state}:${o.since}`}`;

/** Each reason once, with how many it covers and what they are. */
function brokenText(broken) {
  const by = new Map();
  for (const o of broken) by.set(o.reason ?? 'no reason given', [...(by.get(o.reason ?? 'no reason given') ?? []), o]);
  return [...by].map(([reason, list]) => {
    const names = list.filter((o) => o.id).map((o) => `${o.entity} ${o.id}`);
    const what = [list.length > 1 ? String(list.length) : '', listed(names)].filter(Boolean).join(': ');
    return what ? `${plain(reason)} (${what})` : plain(reason);
  }).join('; ');
}

function stuckText(late, broken, now) {
  const parts = [];
  if (late.length) {
    const one = late.length === 1;
    parts.push(`${one ? 'card' : 'cards'} ${listed(late.map((o) => nameOf(o, now)))} ${one ? 'is' : 'are'} past the time limit, and nothing moves ${one ? 'it' : 'them'} by itself: ${one ? 'it waits' : 'they wait'} for you`);
  }
  if (broken.length) parts.push(`the time limits could not be worked out: ${brokenText(broken)}`);
  return parts.join('; ');
}

/** Told through the alert path. A step that throws is told by the tick's step failure. */
export function tellStuckCards({ rec, alert, now, report }) {
  const all = rec.overdue(now);
  const broken = all.filter((o) => o.corrupt);
  const late = all.filter((o) => !o.corrupt && stuck(o));
  const held = [...late, ...broken];
  const since = held.map(keyOf).sort().join(' ');
  const w = stillWaiting({
    now,
    ...(held.length ? { since } : {}),
    waiting: held.length > 0,
    read: () => rec.read('fact', STUCK_CARDS_FACT)?.doc,
    tell: (fields) => { const text = stuckText(late, broken, now); return tellThen(alert, text, { fact: STUCK_CARDS_FACT, fields: { text, ...fields }, kind: 'hold_alert' }); },
    clear: () => clearHold(rec, STUCK_CARDS_FACT, now, report),
  });
  if (w.did === 'unsent') report('the stuck-cards alert could not be queued; it is tried again next pass');
  return { stuck: late.map((o) => o.id), broken: broken.length };
}
