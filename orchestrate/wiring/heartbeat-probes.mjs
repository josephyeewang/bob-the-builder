// heartbeat-probes.mjs — what the robot job's heartbeat (M13 heartbeatOnce) is told about the Mini, read from the Record.
//
// WHY THE RECORD. The Sensors job already reads who is signed in, whether the Front Door answers and the usage, and
// writes each as a fact (M12 loop.mjs). The robot job runs as `orchestrate`, whose user has no business in the owner's
// home folder, where the account file and `claude auth status` live. So nothing is probed twice: these only read.
//
// heartbeatProbes({ rec, rules, now, labels }) → the `probes` heartbeatOnce takes. `rulesReadable` is the wiring's own.
//
//   true / false / a value   what a current reading says
//   null                     NOT KNOWN: no reading, an old one, or one that says it couldn't tell. Never a pass, and
//                            never "no". Until the Sensors job runs, every reading here is null.
//
// Each reading counts only if Sensors made it (M11 sensorsFact), and is held to the same age limit as M11's reader of it:
// the phone link's for the Front Door, usage.stale_after_min for the account and the usage.
//
// Account. `signed-in-account` holds the account and `signed_in` (true, false, or null for "could not tell", with its
// reason). Signed out is reported only when a current reading says signed_in false in so many words. An empty or missing
// account in any other reading is not known (null), never signed out (L730, #289 r1 M1): an old-form fact with no
// signed_in field, or a read that failed, cannot tell "nobody" from "unreadable".
// `labels` turn a or b into the private config's label; an account with no label is shown as its letter.
//
// Usage. heartbeatOnce takes one window at a time, so it gets the fuller of the two.

import { sensorsFact } from '../modules/M11-dispatcher/sensor-facts.mjs';
import { ACCOUNT_FACT, LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { FACTS, READING_MAX_AGE_MS } from '../modules/M11-dispatcher/phone-link.mjs';
import { KEYS, minutes } from '../modules/M11-dispatcher/keys.mjs';
import { USAGE_FACT, readFact } from '../modules/M11-dispatcher/usage.mjs';

const FUTURE_MS = 60_000;
const current = (at, nowMs, maxMs) => {
  const seen = Date.parse(at ?? '');
  return Number.isFinite(seen) && seen <= nowMs + FUTURE_MS && nowMs - seen <= maxMs;
};

// The one reading of the account fact: the account signed in, 'out' when the reading says signed_in false in so many
// words, or null (not known) for anything else (L730, #289 r1 M1).
const whoOf = (d) => {
  const named = typeof d?.account === 'string' && d.account !== '';
  if (!named) return d?.signed_in === false ? 'out' : null;
  return d.signed_in === false || d.signed_in === null ? null : { account: d.account };
};

// A read of the Record that throws is not known (null), never "not reachable" or "signed out": heartbeatOnce counts a
// probe that throws as red, which for these would be a loud false alarm (#451 r1 m3).
const orNull = (fn) => async () => { try { return await fn(); } catch { return null; } };

export function heartbeatProbes({ rec, rules, now, labels = {} }) {
  // No age limit in the rules means no reading can be called current, so all of them are not known.
  const staleMs = () => { try { return minutes(rules, KEYS.staleAfterMin); } catch { return null; } };
  const reading = () => {
    const d = sensorsFact(rec, ACCOUNT_FACT)?.doc;
    const ms = staleMs();
    return d && ms !== null && current(d.observed_at, now(), ms) ? d : null;
  };
  return {
    dispatcherLastGood: async () => rec.read('fact', LAST_PASS_FACT)?.doc?.at ?? null,
    frontDoorReachable: orNull(() => {
      const d = sensorsFact(rec, FACTS.reachable)?.doc;
      if (!d || !current(d.observed_at, now(), READING_MAX_AGE_MS)) return null;
      return d.value === true || d.value === false ? d.value : null;
    }),
    account: orNull(() => {
      const who = whoOf(reading());
      if (who === null) return null;
      if (who === 'out') return { signedIn: false, login: null };
      return { signedIn: true, login: Object.hasOwn(labels, who.account) ? labels[who.account] : who.account };
    }),
    usage: orNull(() => {
      // Only for an account the reading says is signed in (whoOf, as account() above).
      const account = whoOf(reading())?.account;
      if (!account) return null;
      const r = readFact(sensorsFact(rec, USAGE_FACT(account)), { account, now: now(), staleMs: staleMs() });
      if (!r.ok) return null;
      return r.h5 > r.week ? { window: '5-hour', pct: r.h5 } : { window: 'weekly', pct: r.week };
    }),
  };
}
