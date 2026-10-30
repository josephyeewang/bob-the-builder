// Network and phone link (R-0b-60; design v4 R4; review 0b-6 m19, M22; lead call L15).
//
// Built on Sensors' facts (lane 3), each { value: true | false | 'unknown', observed_at }:
//   network-up, frontdoor-reachable (the phone can reach the Front Door), minibase-running.
// - Network down: do nothing at all (no sends, no restarts; the outage step holds the workers).
// - frontdoor-reachable false on 2 readings in a row with the network up: send /remote-control to
//   the Front Door through sendSafe; again every 5 min while it stays false; one alert after 3
//   failed tries.
// - unknown: a diary line only.
// - L15: refused (sendSafe would not type, e.g. the Front Door waits on an answer) and unreachable
//   for timeouts.front_door_stuck_min (10) -> restart the Front Door under its fixed name. Its open
//   asks live in the record and come back after the restart. One diary line; an alert only if the
//   restart fails.
// - minibase-running false with the network up: start it again through the launcher, at most once
//   every 5 min.
// The step's memory is the fact `phone-link`. A reading counts once (by its observed_at).

import { KEYS, minutes } from './keys.mjs';
import { note } from './moves.mjs';

export const LINK_FACT = 'phone-link';
export const FACTS = Object.freeze({ network: 'network-up', reachable: 'frontdoor-reachable', minibase: 'minibase-running' });
export const RETRY_MS = 5 * 60_000;
export const FALSE_READINGS = 2;
export const ALERT_AFTER_FAILURES = 3;
export const REMOTE_CONTROL = '/remote-control';
const iso = (ms) => new Date(ms).toISOString();

const reading = (rec, id) => {
  const d = rec.read('fact', id)?.doc;
  const v = d?.value;
  return { value: v === true || v === false ? v : 'unknown', at: d?.observed_at ?? null };
};

/**
 * One pass. Ports: `send(text)` = sendSafe to the Front Door -> { outcome }; `restartFrontDoor()`
 * and `startMinibase()` -> { ok, reason }; `alert(text)`. Returns the list of actions taken.
 */
export async function phoneLinkStep({ rec, rules, now, send, restartFrontDoor, startMinibase, alert }) {
  const stuckMs = minutes(rules, KEYS.frontDoorStuckMin);
  const cur = rec.read('fact', LINK_FACT);
  const st = { false_streak: 0, attempts: 0, failures: 0, ...(cur?.doc ?? {}) };
  const done = [];
  const save = () => rec.write({ actor: 'dispatcher', entity: 'fact', id: LINK_FACT, expectRev: cur?.rev ?? 0, doc: { ...st, changed_at: iso(now) }, kind: 'phone_link' });

  const net = reading(rec, FACTS.network);
  if (net.value !== true) {
    if (net.value === 'unknown' && st.net_unknown_at !== net.at) { note(rec, 'phone-link-note', 'network state unknown; no action', { now }); st.net_unknown_at = net.at; save(); }
    return net.value === false ? ['network down: nothing done'] : ['network unknown: nothing done'];
  }

  const mb = reading(rec, FACTS.minibase);
  if (mb.value === false && !(now - Date.parse(st.minibase_started_at ?? '') < RETRY_MS)) {
    const r = await startMinibase();
    st.minibase_started_at = iso(now);
    done.push(r?.ok ? 'Mini Base started' : 'Mini Base start failed');
    if (!r?.ok) alert(`Mini Base is not running and did not start: ${r?.reason ?? 'no answer'}`);
  }

  const fd = reading(rec, FACTS.reachable);
  const fresh = fd.at !== st.reading_at;
  if (fresh) st.reading_at = fd.at;
  if (fd.value === true) {
    if (st.false_streak || st.refused_since) done.push('phone link back');
    Object.assign(st, { false_streak: 0, attempts: 0, failures: 0, alerted: false, refused_since: null, last_try_at: null });
    save();
    return done;
  }
  if (fd.value === 'unknown') {
    if (fresh) note(rec, 'phone-link-note', 'phone link state unknown; no action', { now });
    save();
    return [...done, 'link unknown: diary line only'];
  }
  if (fresh) st.false_streak += 1;
  if (st.false_streak < FALSE_READINGS) { save(); return [...done, 'link down once; waiting for a second reading']; }

  // L15: the Front Door refused and unreachable for too long -> restart it.
  if (st.refused_since && now - Date.parse(st.refused_since) >= stuckMs) {
    const r = await restartFrontDoor();
    note(rec, 'phone-link-note', `the Front Door was unreachable and could not be reconnected for ${Math.round((now - Date.parse(st.refused_since)) / 60_000)} min; restarted under its fixed name`, { now });
    if (!r?.ok) alert(`the Front Door could not be reconnected or restarted: ${r?.reason ?? 'no answer'}`);
    Object.assign(st, { refused_since: null, attempts: 0, failures: 0, last_try_at: iso(now), restarted_at: iso(now) });
    save();
    return [...done, r?.ok ? 'Front Door restarted' : 'Front Door restart failed'];
  }

  if (st.last_try_at && now - Date.parse(st.last_try_at) < RETRY_MS) { save(); return [...done, 'waiting to try again']; }
  if (st.attempts > 0) st.failures += 1; // the last try did not bring the link back
  if (st.failures >= ALERT_AFTER_FAILURES && !st.alerted) {
    alert(`the phone cannot reach the Front Door; ${st.failures} tries to reconnect it failed`);
    st.alerted = true;
  }
  const r = await send(REMOTE_CONTROL);
  st.attempts += 1;
  st.last_try_at = iso(now);
  if (r?.outcome === 'sent') st.refused_since = null;
  else st.refused_since ??= iso(now);
  save();
  return [...done, r?.outcome === 'sent' ? 'sent /remote-control' : `/remote-control refused (${r?.outcome ?? 'no answer'})`];
}
