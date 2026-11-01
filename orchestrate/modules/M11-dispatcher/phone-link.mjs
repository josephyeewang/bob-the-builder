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
// - The Front Door itself gone from the session list (audit MAT-10): restart it under its fixed name
//   with its last handoff, at most once every 5 min; an alert if the restart fails, once until it
//   runs again (L63 m4).
// - Two accounts (L63 m2): while it runs on the account in use, a Front Door left on another account
//   is stopped, checked at most once every 5 min; an alert, once, if it can't be stopped.
// - A reading older than 5 min counts as unknown (audit MIN-10).
// The step's memory is the fact `phone-link`. A reading counts once (by its observed_at).

import { KEYS, minutes } from './keys.mjs';
import { note } from './moves.mjs';
import { sensorsFact } from './sensor-facts.mjs';
import { tellThen, dropCause } from './alerts.mjs';

export const LINK_FACT = 'phone-link';
// Once-per-cause marks (L63): a failed Front Door restart, and a Front Door left on another account that won't stop.
export const FD_RESTART_FACT = 'phone-link-restart';
export const FD_STRAY_FACT = 'phone-link-stray';
export const FACTS = Object.freeze({ network: 'network-up', reachable: 'frontdoor-reachable', minibase: 'minibase-running' });
export const RETRY_MS = 5 * 60_000;
export const FALSE_READINGS = 2;
export const ALERT_AFTER_FAILURES = 3;
export const REMOTE_CONTROL = '/remote-control';
export const READING_MAX_AGE_MS = 5 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const toldOn = (rec, fact) => rec.read('fact', fact)?.doc?.told === true;
// The cause cleared: its mark is reset, so the next time it happens Joe is told again.
function clearTold(rec, now, fact) {
  const c = rec.read('fact', fact);
  if (c?.doc?.told) rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: c.rev, doc: { ...c.doc, told: false, changed_at: iso(now) }, kind: 'phone_link' });
}

const reading = (rec, id, now) => {
  const d = sensorsFact(rec, id)?.doc;
  const v = d?.value;
  const seen = Date.parse(d?.observed_at ?? '');
  const current = Number.isFinite(seen) && now - seen <= READING_MAX_AGE_MS && seen <= now + 60_000;
  return { value: current && (v === true || v === false) ? v : 'unknown', at: d?.observed_at ?? null };
};

/**
 * One pass. Ports: `send(text)` = sendSafe to the Front Door -> { outcome }; `restartFrontDoor({
 * handoff })` and `startMinibase()` -> { ok, reason }; `frontDoorAlive()` -> true | false | null (from
 * the session list; null = not known); `strayFrontDoor()` -> { ok, stopped, reason } (two accounts: stops a Front
 * Door left on another account; optional); `lastHandoff()` -> the Front Door's last handoff id or null;
 * `alert(text)`. Returns the list of actions taken.
 */
export async function phoneLinkStep({ rec, rules, now, send, restartFrontDoor, startMinibase, frontDoorAlive = () => null, strayFrontDoor = null, lastHandoff = () => null, alert }) {
  const stuckMs = minutes(rules, KEYS.frontDoorStuckMin);
  const cur = rec.read('fact', LINK_FACT);
  const st = { false_streak: 0, attempts: 0, failures: 0, ...(cur?.doc ?? {}) };
  const done = [];
  const save = () => rec.write({ actor: 'dispatcher', entity: 'fact', id: LINK_FACT, expectRev: rec.read('fact', LINK_FACT)?.rev ?? 0, doc: { ...st, changed_at: iso(now) }, kind: 'phone_link' });

  const net = reading(rec, FACTS.network, now);
  if (net.value !== true) {
    // A refusal from before the drop says nothing about after it (audit MIN-14).
    if (st.refused_since || st.false_streak) { Object.assign(st, { refused_since: null, false_streak: 0 }); save(); }
    if (net.value === 'unknown' && st.net_unknown_at !== net.at) { note(rec, 'phone-link-note', 'network state unknown; no action', { now }); st.net_unknown_at = net.at; save(); }
    return net.value === false ? ['network down: nothing done'] : ['network unknown: nothing done'];
  }

  // The Front Door gone: restart it, whether or not anything was sent to it (audit MAT-10). A failed restart is told
  // once per cause (L63 m4), not every 5 minutes; the cause clears when a restart works or it runs again.
  const alive = frontDoorAlive();
  if (alive === true) { clearTold(rec, now, FD_RESTART_FACT); dropCause(rec, FD_RESTART_FACT); }
  if (alive === false) {
    if (now - Date.parse(st.fd_restarted_at ?? '') < RETRY_MS) done.push('Front Door missing; restarted recently, waiting');
    else {
      let r;
      try { r = await restartFrontDoor({ handoff: lastHandoff() }); } catch (e) { r = { ok: false, reason: e.message }; }
      st.fd_restarted_at = iso(now);
      note(rec, 'phone-link-note', 'the Front Door was not running; restarted under its fixed name', { now });
      if (r?.ok) { clearTold(rec, now, FD_RESTART_FACT); dropCause(rec, FD_RESTART_FACT); }
      else if (!toldOn(rec, FD_RESTART_FACT)) tellThen(alert, `the Front Door was not running and did not restart: ${r?.reason ?? 'no answer'}`, { fact: FD_RESTART_FACT, fields: { told: true }, kind: 'front_door_restart' });
      done.push(r?.ok ? 'Front Door was missing; restarted' : 'Front Door was missing; restart failed');
      save();
      return done;
    }
  }

  // Two accounts (L63 m2): while it runs on the account in use, one left running on another account is stopped, checked
  // at most once every 5 minutes. A stop that fails, or an account that can't be told about, is told once per cause.
  if (alive === true && strayFrontDoor && !(now - Date.parse(st.stray_checked_at ?? '') < RETRY_MS)) {
    let r;
    try { r = await strayFrontDoor(); } catch (e) { r = { ok: false, stopped: [], reason: e.message }; }
    st.stray_checked_at = iso(now);
    if (r?.stopped?.length) {
      note(rec, 'phone-link-note', `a Front Door left running on account ${r.stopped.join(', ')} was stopped; it runs on the account in use`, { now });
      done.push('Front Door left on another account; stopped');
    }
    if (r?.ok) { clearTold(rec, now, FD_STRAY_FACT); dropCause(rec, FD_STRAY_FACT); }
    else {
      if (!toldOn(rec, FD_STRAY_FACT)) tellThen(alert, `a Front Door may still run on the other account: ${r?.reason ?? 'no answer'}; two under the one name can confuse the phone`, { fact: FD_STRAY_FACT, fields: { told: true }, kind: 'front_door_stray' });
      done.push('Front Door on another account: not stopped');
    }
  }

  const mb = reading(rec, FACTS.minibase, now);
  if (mb.value === false && !(now - Date.parse(st.minibase_started_at ?? '') < RETRY_MS)) {
    const r = await startMinibase();
    st.minibase_started_at = iso(now);
    done.push(r?.ok ? 'Mini Base started' : 'Mini Base start failed');
    if (!r?.ok) alert(`Mini Base is not running and did not start: ${r?.reason ?? 'no answer'}`);
  }

  const fd = reading(rec, FACTS.reachable, now);
  const fresh = fd.at !== st.reading_at;
  if (fresh) st.reading_at = fd.at;
  if (fd.value === true) {
    if (st.false_streak || st.refused_since) done.push('phone link back');
    Object.assign(st, { false_streak: 0, attempts: 0, failures: 0, told: false, refused_since: null, last_try_at: null });
    save();
    dropCause(rec, LINK_FACT);
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
    const r = await restartFrontDoor({ handoff: lastHandoff() });
    note(rec, 'phone-link-note', `the Front Door was unreachable and could not be reconnected for ${Math.round((now - Date.parse(st.refused_since)) / 60_000)} min; restarted under its fixed name`, { now });
    if (!r?.ok) alert(`the Front Door could not be reconnected or restarted: ${r?.reason ?? 'no answer'}`);
    Object.assign(st, { refused_since: null, attempts: 0, failures: 0, last_try_at: iso(now), restarted_at: iso(now) });
    save();
    return [...done, r?.ok ? 'Front Door restarted' : 'Front Door restart failed'];
  }

  if (st.last_try_at && now - Date.parse(st.last_try_at) < RETRY_MS) { save(); return [...done, 'waiting to try again']; }
  if (st.attempts > 0) st.failures += 1; // the last try did not bring the link back
  // Told only once sent (audit 0b-6 r5 MAT-2).
  if (st.failures >= ALERT_AFTER_FAILURES && !st.told) {
    tellThen(alert, `the phone cannot reach the Front Door; ${st.failures} tries to reconnect it failed`, { fact: LINK_FACT, fields: { told: true }, kind: 'phone_link' });
  }
  const r = await send(REMOTE_CONTROL);
  st.attempts += 1;
  st.last_try_at = iso(now);
  if (r?.outcome === 'sent') st.refused_since = null;
  else st.refused_since ??= iso(now);
  save();
  return [...done, r?.outcome === 'sent' ? 'sent /remote-control' : `/remote-control refused (${r?.outcome ?? 'no answer'})`];
}
