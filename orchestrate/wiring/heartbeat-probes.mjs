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
//
// Sensors alive (L967, L969; #464 r1). Whether the Sensors job itself is still writing: the age of the newest reading it
// wrote among the families its loop writes on every pass, whatever the reading says (EVERY_PASS below; M12 loop.mjs
// LOOP). Its limit is usage.stale_after_min, the same age at which the Dispatcher holds starts for a stale account
// reading (tick.mjs), so the plain "the Sensors job may have stopped" turns red no later than that hold, and one rule
// means the two never disagree: `stale` is decided in milliseconds, as that hold decides it (`now - seen > staleMs`), and
// the minutes are only for the line. The answer, one of:
//   null                                   not known: no limit in the rules, or inside the grace after the Mini
//                                          started (GRACE_MS: its Sensors job has had no time to write yet)
//   { none, limitMin, why }                no reading at all: never written, deleted, or the Record could not be read
//                                          (why 'record'). Not known at first; heartbeat.mjs keeps when it began
//                                          (heartbeat-sensors-none-since) and turns it red past the limit, as the
//                                          Dispatcher's line is red with no pass on record (#464 r1 M1, m2a)
//   { clock, aheadMin, limitMin }          a reading stamped more than FUTURE_MS ahead: the Mini's clock (r1 m2)
//   { ageMin, limitMin, stale, newestAt,   the newest reading; `account` is the signed-in-account reading's own
//     account: { ageMin, stale, at } }     age, the one the Dispatcher holds on, red alone when it is past the limit
//                                          while the others are not (r1 m1)
// Every reading here is the Record's: there is no heartbeat at all without the robot's App token (robot-wiring.mjs builds
// none without one), so a Mini with no App says nothing here, not even "not known" (r1 c3).

import { sensorsFact } from '../modules/M11-dispatcher/sensor-facts.mjs';
import { ACCOUNT_FACT, LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { FACTS, READING_MAX_AGE_MS } from '../modules/M11-dispatcher/phone-link.mjs';
import { KEYS, minutes } from '../modules/M11-dispatcher/keys.mjs';
import { USAGE_FACT, readFact } from '../modules/M11-dispatcher/usage.mjs';
import { uptime } from 'node:os';
import { EVERY_S, RUN_DEADLINE_MS } from '../modules/M12-sensors/loop.mjs';

export const FUTURE_MS = 60_000;
/** After the Mini starts, one Sensors interval and its first pass's time limit, before a missing reading is told (r1 m3). */
export const GRACE_MS = EVERY_S * 1000 + RUN_DEADLINE_MS;
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

/** The families the Sensors loop writes on every pass, each its own fact (no per-account or per-PR suffix). */
export const EVERY_PASS = Object.freeze([ACCOUNT_FACT, FACTS.network, FACTS.reachable, FACTS.minibase]);

export function heartbeatProbes({ rec, rules, now, labels = {}, upMs = () => uptime() * 1000 }) {
  // No age limit in the rules means no reading can be called current, so all of them are not known.
  const staleMs = () => { try { return minutes(rules, KEYS.staleAfterMin); } catch { return null; } };
  const reading = () => {
    const d = sensorsFact(rec, ACCOUNT_FACT)?.doc;
    const ms = staleMs();
    return d && ms !== null && current(d.observed_at, now(), ms) ? d : null;
  };
  return {
    dispatcherLastGood: async () => rec.read('fact', LAST_PASS_FACT)?.doc?.at ?? null,
    // → see "Sensors alive" at the top. A Record read that throws is no reading (why 'record'), never not known for ever
    // (r1 m2a); anything else that throws is the heartbeat's "could not be read" red.
    sensorsAlive: async () => {
      const ms = staleMs();
      if (ms === null) return null;
      const t = now();
      if (!Number.isFinite(t)) throw new Error('the time now is not a time');
      const limitMin = ms / 60_000;
      let at;
      try { at = EVERY_PASS.map((id) => [id, Date.parse(sensorsFact(rec, id)?.doc?.observed_at ?? '')]).filter(([, s]) => Number.isFinite(s)); } catch {
        return { none: true, limitMin, why: 'record' };
      }
      const ahead = at.filter(([, s]) => s > t + FUTURE_MS);
      if (ahead.length) return { clock: true, aheadMin: Math.floor((Math.max(...ahead.map(([, s]) => s)) - t) / 60_000), limitMin };
      // A damaged row reads as no reading (sensorsFact), so say the Record is the cause when one is there (#464 r2 m1).
      if (!at.length) {
        let damaged;
        try { damaged = EVERY_PASS.some((id) => rec.read('fact', id)?.corrupt === true); } catch { damaged = true; }
        return { none: true, limitMin, why: damaged ? 'record' : 'none' };
      }
      const newest = Math.max(...at.map(([, s]) => s));
      const acc = at.find(([id]) => id === ACCOUNT_FACT)?.[1];
      const account = acc === undefined ? { ageMin: null, stale: true, at: null } : { ageMin: Math.max(0, Math.floor((t - acc) / 60_000)), stale: t - acc > ms, at: new Date(acc).toISOString() };
      const stale = t - newest > ms;
      // Just started: readings left from before the Mini went down are old, and the Sensors job has not written yet.
      // Known limit: os.uptime() counts time asleep, so a wake from sleep is not covered and can give one stale notice
      // before the Sensors job's next write clears it (#464 r2 m2).
      if ((stale || account.stale) && upMs() < GRACE_MS) return null;
      return { ageMin: Math.max(0, Math.floor((t - newest) / 60_000)), limitMin, stale, newestAt: new Date(newest).toISOString(), account };
    },
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
