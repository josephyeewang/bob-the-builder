// interactive-holds.mjs — R-0b-175a (d)(4): an interactive session (a Lead, the Front Door, Mini Base) held by the
// owner-side runner is told to the owner once. It is a tell only: nothing here starts, stops or types into a session.
//
// WHY. The runner's hook store (M4 send-safe/hook-store.mjs) holds a session still startup pending past its role's start
// timeout: it never reads idle, nothing is typed into it, and no role is restarted for it. A hook store that can't be
// read holds every send. The runner names each in its status's `held` list ({ sessionId, role, product, reason, since,
// launchId }; the unreadable store's entry names no session); this relays each one.
//
// TOLD ONCE, not daily (the row; L1071 for the like case of a held pause): each entry is its own hold on the shared
// still-waiting rule (L315), with `since` = `<session>:<reason>:<launch id>` and a repeat no pass reaches, so it is told
// once per session, reason and launch. A session no longer held has its mark cleared, so a return is told afresh. A
// status that can't be read is said so, once, on its own hold, and clears nothing: never read as "nothing held".
//
// Nothing reaches the owner until the runner's status reader (wiring/owner-status.mjs ownerSyncPorts.interactiveHolds) is
// wired into the Dispatcher: until then the tick gives timeLimits no `interactiveHolds` port (as drainHolds).

import { HOLD_FACT, clearHold } from './pass.mjs';
import { idHash } from './intake-facts.mjs';
import { plain, queuedMarks, tellThen, unqueuedText } from './alerts.mjs';
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { heldOk } from '../M4-workshop/send-safe/hook-store.mjs';

/** A repeat no pass reaches: told once (still-waiting reads anything not finite above 0 as daily, so it is spelled out). */
export const ONCE_MS = Number.MAX_SAFE_INTEGER;
const PREFIX = HOLD_FACT('interactive-');
/** The hold of one held session; the unreadable store's entry (no session) has its own. */
export const INTERACTIVE_HOLD_FACT = (sessionId) => `${PREFIX}${idHash(sessionId ?? '(hook store)')}`;
/** The hold of a status that could not be read. */
export const INTERACTIVE_UNKNOWN_FACT = HOLD_FACT('interactive-status-unknown');
const ROLE = Object.freeze({ lead: 'Lead', frontDoor: 'Front Door', minibase: 'Mini Base' });

const heldText = (h) => (h.sessionId === null
  ? `owner runner: ${plain(h.reason, 300)}, so no Lead, Front Door or Mini Base session is typed into until it is fixed by hand (since ${plain(h.since, 40)}). Said once`
  : `owner runner: the ${ROLE[h.role]} session ${plain(h.sessionId, 140)}${h.product ? ` (product ${plain(h.product, 140)})` : ''} is held: ${plain(h.reason, 300)} (since ${plain(h.since, 40)}). Nothing is typed into it and it is not restarted; it stays held until it gives a first signal or is started again by hand. Said once`);

/**
 * `held` is the status reader's interactiveHolds(): the runner's `held` list, or null with `error` when the status could
 * not be read (a list holding anything else counts as that too). `report(line, fact)` hears a refused drop or write.
 * → how many were queued.
 */
export function relayInteractiveHolds({ rec, held, error, alert, now, report }) {
  let n = 0;
  const tell = ({ fact, waiting, since, text, what }) => {
    const w = stillWaiting({
      now, waiting, every: ONCE_MS, ...(since !== undefined ? { since } : {}),
      read: () => rec.read('fact', fact)?.doc,
      tell: (fields) => tellThen(alert, text, { fact, fields: { text, ...fields }, kind: 'hold_alert' }),
      clear: () => clearHold(rec, fact, now, report),
    });
    if (w.did === 'told') n += 1;
    if (w.did === 'unsent') report(unqueuedText(what), fact);
  };
  if (!Array.isArray(held) || !held.every(heldOk)) {
    // Fail closed: say the status is unknown, and clear no session's hold (it may still be held).
    const why = Array.isArray(held) ? 'a held session in it is not what the status reader gives' : (error ?? 'no reason given');
    tell({ fact: INTERACTIVE_UNKNOWN_FACT, waiting: true, since: 'unknown', what: 'interactive status', text: `owner runner: its status could not be read, so whether a Lead, Front Door or Mini Base session is held is not known (${plain(why)}). Said once` });
    return n;
  }
  tell({ fact: INTERACTIVE_UNKNOWN_FACT, waiting: false, what: 'interactive status' });
  const listed = new Set();
  for (const h of held) {
    const fact = INTERACTIVE_HOLD_FACT(h.sessionId);
    listed.add(fact);
    tell({ fact, waiting: true, since: `${h.sessionId ?? ''}:${h.reason}:${h.launchId ?? ''}`, what: 'held session', text: heldText(h) });
  }
  // A session no longer held: its mark is cleared (and a queued copy dropped), so a return is told afresh.
  const mine = (id) => id.startsWith(PREFIX) && id !== INTERACTIVE_UNKNOWN_FACT;
  const marked = rec.list('fact').map((f) => f.id).filter(mine);
  for (const fact of new Set([...marked, ...queuedMarks(rec, PREFIX).filter(mine)])) {
    if (!listed.has(fact)) tell({ fact, waiting: false, what: 'held session' });
  }
  return n;
}
