// The Dispatcher's main pass (R-0b-55, R-0b-59, R-0b-64, R-0b-67; design v3 Module 6, v4 A2, G8;
// review 0b-6 M7, M8, M16, M19, m5, m6, m7).
//
// At login and every pass: start what the record says should run, and stop what should not.
//   1. Usage bands (usage.mjs), written as the `band-usage` fact.
//   2. host.lock (m5): "Air is home" never stops orchestrated products; one diary line per change.
//   3. Compactions (M19), counted per card across all its sessions.
//   4. What should stop: a cancelled card (the kill switch: hard stop after timeouts.cancel_grace_min),
//      red band, a paused product, or two compactions (a park: up to timeouts.park_wait_min). Each
//      stop waits for a safe point (transcript.atSafePoint), then: stop the process group (SIGTERM,
//      SIGKILL after 10 s), save unsaved work (M4 save-work, a bundle), move the card.
//   5. Parked work resuming (M8): usage_band -> ready when not red and own building not full;
//      limit_hit -> after the reset, Tier 2 ready, Tier 1 waiting on Joe; usage unknown for over
//      timeouts.usage_unknown_max_min -> waiting on Joe.
//   6. Starts: for each ready card (front of the queue first; in amber Tier 1 before Tier 2):
//      may('start_session') -> startGate -> a rev-checked claim naming the session before it starts
//      (L72: the Dispatcher makes the session id) -> the launcher -> claimed->running with the pid. A
//      launcher refusal releases the claim (the card goes back to ready). Nothing starts during an outage.
//   7. A paused product (m7, G8): once its workers are parked, the Lead is asked to hand off
//      (pauseLead port: lead-restart's WRAP flow), once per pause.
// Product-state starts are M10's `may('start_session')` answer; this file does not repeat them.
// Every outside effect is a port, so tests run on fakes.

import { KEYS, need, minutes, MissingKey, missingFor } from './keys.mjs';
import { currentBands, recordBands } from './usage.mjs';
import { startGate } from './gate.mjs';
import { atSafePoint } from './transcript.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { move, waitOn, note } from './moves.mjs';
import { waitOnJoe } from './joe-waits.mjs';
import { sensorsFact } from './sensor-facts.mjs';
import { tellThen, dropCause, isQueued } from './alerts.mjs';
import { exactReverse } from './undo.mjs';
import { FINAL_STATES, OWNER_WAIT_WHO, PAUSED_WAIT_WHAT } from '../../shared/record.mjs';

export const STOP_FACT = (sid) => `stop-${sid}`;
/** The mark that a stop's unsaved work was told (L130 M9). */
export const UNSAVED_FACT = (sid) => `stop-unsaved-${sid}`;
export const COMPACTION_FACT = (card) => `compactions-${card}`;
export const HOST_FACT = 'host-lock-seen';
export const PAUSE_FACT = (product) => `pause-${product}`;
export const LIMIT_FACT = (account) => `limit-hit-${account}`;
/** What a limit_hit wait that names no account becomes (L110 m-4): it waits on Joe. */
export const LIMIT_NO_ACCOUNT = 'limit_hit: the wait names no account, so the limit reset can\'t be read';
export const UNKNOWN_FACT = 'unknown-usage-alert';
export const RULES_MISSING_FACT = 'rules-missing-alert';
// Used only when timeouts.cancel_grace_min itself is missing (audit MAT-2): Cancel must still stop.
export const CANCEL_GRACE_FLOOR_MS = 2 * 60_000;
export const TERM_WAIT_MS = 10_000;
// Kinds that are never parked; every other kind, an unknown one included, is (audit 0b-6 r2, L27).
const NEVER_PARKED = Object.freeze(['review', 'audit', 'merge', 'undo', 'readonly', 'lead', 'front_door']);
const parkable = (s) => !NEVER_PARKED.includes(s.kind);
const iso = (ms) => new Date(ms).toISOString();
// A port that throws, or does not answer within `ms`, answers { ok: false, reason } for that one session
// (audit 0b-6 r2 MAT-7; r4 MAT-1: one stuck stop must not hold every later one).
// A save (M4 save-work: several git calls) gets longer than a stop; both together fit the step's
// STEP_DEADLINE_MS (tick.mjs).
export const PORT_DEADLINE_MS = 30_000;
export const SAVE_DEADLINE_MS = 75_000;
export async function guarded(f, ms = PORT_DEADLINE_MS) {
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ ok: false, reason: `it did not answer within ${ms} ms` }), ms); });
  try { return await Promise.race([Promise.resolve().then(f), late]); } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; } finally { clearTimeout(timer); }
}

/**
 * Tells Joe once per missing rules value, on the fact `factId` (audit MAT-2; 0b-6 r3 MAT-3: values only
 * the start gate reads are told too, once for the whole tick). A key leaves the fact when a pass no
 * longer reports it; a pass in which some step failed (`complete` false) drops nothing, since that step
 * reported nothing. A value the gate reads only for some cards can be told again when such a card comes
 * back after a pass without one: once per return, never once per pass. Returns the joined key list.
 */
export async function rulesMissingAlert({ rec, factId = RULES_MISSING_FACT, keys, alert, now, what = 'nothing new starts until they do; stops still run', complete = true }) {
  const seen = [...new Set(keys)].sort();
  const doc = factDoc(rec, factId)?.doc;
  const list = (v) => String(v ?? '').split(', ').filter(Boolean);
  const had = list(doc?.keys);
  const keep = complete ? seen : [...new Set([...had, ...seen])].sort();
  // Told keys are marked only once the alert went through (audit 0b-6 r5 MAT-2). Only those still in the
  // last recorded set count, so a key that left is told again when it comes back.
  const told = list(doc?.told_keys).filter((k) => had.includes(k));
  const fresh = seen.filter((k) => !told.includes(k));
  // Still missing a day after the last alert: told again, all of them (LEAD-CALLS L38, once per cause per day).
  const last = Date.parse(doc?.told_at ?? '');
  const again = !fresh.length && keep.length && seen.length && Number.isFinite(last) && now - last >= HOLD_REPEAT_MS;
  const tell = fresh.length ? fresh : again ? keep : [];
  const joined = keep.join(', ') || null;
  if (joined !== (doc?.keys ?? null)) putFact(rec, factId, { ...doc, keys: joined, at: iso(now) }, keep.length ? 'rules_missing' : 'rules_missing_cleared');
  const toldNow = () => [...new Set([...told, ...tell])].sort().join(', ');
  // A new key told alone keeps the day clock of the keys told before (audit 0b-6 r6 m-5).
  const at = again || !Number.isFinite(last) ? iso(now) : doc.told_at;
  if (tell.length) tellThen(alert, `the rules have no value for ${tell.join(', ')}: ${what}`, { fact: factId, fields: { told_keys: toldNow(), told_at: at }, kind: 'rules_missing_told' });
  return seen.join(', ') || null;
}

export const HOLD_FACT = (cause) => `hold-${cause}`;
export const HOLD_REPEAT_MS = 24 * 60 * 60_000;

/**
 * No silent hold (LEAD-CALLS L38): anything that holds or blocks work tells Joe what and why, once per
 * cause per day, on the fact `hold-<cause>`.
 */
export function holdAlert({ rec, cause, text, alert, now }) {
  const f = factDoc(rec, HOLD_FACT(cause))?.doc;
  const last = Date.parse(f?.told_at ?? '');
  // Once per cause per day (L38): a changing detail in the text does not make it a new cause.
  // null, not false: already told today is not a refused alert (L130 m12).
  if (Number.isFinite(last) && now - last < HOLD_REPEAT_MS) return null;
  // Marked told only once a copy is delivered (audit 0b-6 r5 MAT-2; L47).
  return tellThen(alert, text, { fact: HOLD_FACT(cause), fields: { text, told_at: iso(now) }, kind: 'hold_alert' });
}

/** Stops a process group: SIGTERM, then SIGKILL if still alive after 10 s. Ports for tests. */
export async function stopProcessGroup({ pgid, kill = (p, s) => process.kill(-p, s), alive, sleep, waitMs = TERM_WAIT_MS }) {
  if (!Number.isInteger(pgid) || pgid <= 1) return { ok: false, reason: 'no process group to stop' };
  // Any other error (EPERM, say) is an answer, not a throw (audit 0b-6 r2 MAT-7): one session must not end the pass.
  try { kill(pgid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return { ok: true, how: 'gone' }; return { ok: false, reason: e.code ?? e.message }; }
  for (let t = 0; t < waitMs; t += 500) { if (!alive(pgid)) return { ok: true, how: 'SIGTERM' }; await sleep(500); }
  if (!alive(pgid)) return { ok: true, how: 'SIGTERM' };
  try { kill(pgid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return { ok: false, reason: e.code ?? e.message }; }
  return { ok: true, how: 'SIGKILL' };
}

// An undo card is M9's kind exact_reverse (L74); the session kind stays 'undo'.
const isUndo = (card) => card.kind === 'exact_reverse';
const kindOf = (card) => (isUndo(card) ? 'undo' : card.kind === 'script' ? 'script' : 'editing');
const roleOf = (s) => s.role ?? (s.kind === 'editing' || s.kind === 'script' ? 'worker' : s.kind);
const factDoc = (rec, id) => rec.read('fact', id);
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

// A stronger reason replaces a pending weaker one (audit MIN-2): cancel > needs_split > the rest.
const RANK = { cancel: 3, needs_split: 2, card_ended: 1, red: 1, paused: 1 };

/** Why this running session should stop now, or null. */
function stopReason({ s, card, productDoc, b, compactions, split }) {
  if (!card) return null;
  if (card.state === 'cancelled') return 'cancel';
  if (!parkable(s)) return null;
  // A worker whose card has ended, or now waits on Joe, has nothing left to do (audit MIN-3).
  if (FINAL_STATES.card.includes(card.state) || (card.state === 'waiting' && card.wait?.who === OWNER_WAIT_WHO)) return 'card_ended';
  if (compactions >= split) return 'needs_split';
  if (b.band === 'red') return 'red';
  if (productDoc?.state === 'paused') return 'paused';
  return null;
}

/**
 * Steps 1, 3 and 4 alone: the bands, the compactions and the stops (cancels and parks). The tick runs
 * this as its own first step (LEAD-CALLS L38), so no other step's failure, an unreadable file or a bad
 * rule, can skip a cancel. Returns { stopping, stopped, running, bands, unknownSince, missing }.
 */
export async function stopPass({ rec, rules, now, account, sessions, probe, stopGroup, saveWork, alert, portDeadlineMs = PORT_DEADLINE_MS, saveDeadlineMs = SAVE_DEADLINE_MS }) {
  const out = { stopping: [], stopped: [] };
  // A missing rules value starts nothing, but every stop still runs (audit MAT-2): Cancel needs no band.
  // Any other failure reading the rules (an unreadable file) is treated the same, never thrown before
  // the stop loop (audit 0b-6 r3 MAT-1).
  const missing = [];
  const read = readOr(missing);
  // Cancel grace, park wait and the compaction split are per-product keys (L131: each governs one product's session),
  // which the real rules answer only for a named product. They are read for every product in the Record and every
  // running session's product, so a product that lacks one starts nothing, as before, and a session is timed by its
  // own product's value.
  const limits = new Map();
  const limitsFor = (product) => {
    const k = product;
    if (!limits.has(k)) {
      const readFor = (key, f, fallback) => { try { return f(); } catch (e) { missing.push(e instanceof MissingKey ? missingFor(e.key, product) : `the rules (${e?.message ?? e})`); return fallback; } };
      limits.set(k, {
        cancelMs: readFor(KEYS.cancelGraceMin, () => minutes(rules, KEYS.cancelGraceMin, { product }), CANCEL_GRACE_FLOOR_MS),
        parkMs: readFor(KEYS.parkWaitMin, () => minutes(rules, KEYS.parkWaitMin, { product }), Infinity),
        split: readFor(KEYS.splitAfterCompactions, () => need(rules, KEYS.splitAfterCompactions, { product }), Infinity),
      });
    }
    return limits.get(k);
  };
  let products = [];
  try { products = rec.list('product').map((x) => x.id); } catch { products = []; }
  for (const product of new Set([...products, ...sessions.map((s) => s.product)].filter(Boolean))) limitsFor(product);
  const b = read(() => currentBands({ rec, rules, account, now }), HELD_BANDS);
  const { unknownSince } = recordBands({ rec, b, now, account });

  // 3 + 4. Compactions and stops. Which sessions stop is decided first; then every stop is called at
  // once, then every save, each with its own time limit (audit 0b-6 r4 MAT-1): the step takes at most
  // two port deadlines however many sessions stop, and one stuck stop holds no other.
  let running = [...sessions];
  const due = [];
  for (const s of sessions) {
    const card = s.card ? rec.read('card', s.card)?.doc : null;
    // A probe that throws reads as "not at a safe point", so the late hard stop still applies (MAT-7).
    let p = null;
    try { p = probe(s); } catch { p = null; }
    let compactions = 0;
    if (s.card) {
      const cf = factDoc(rec, COMPACTION_FACT(s.card));
      const by = { ...(cf?.doc?.by_session ?? {}) };
      const n = p?.size?.compactions ?? 0;
      if (n > (by[s.id] ?? 0)) { by[s.id] = n; putFact(rec, COMPACTION_FACT(s.card), { card: s.card, by_session: by, at: iso(now) }, 'compactions'); }
      compactions = Object.values(by).reduce((a, x) => a + x, 0);
    }
    const productDoc = rec.read('product', s.product)?.doc;
    // A session names its product; else its card does. With neither, nothing is read: no product's value applies, so a
    // cancel still stops after the floor and nothing parks or splits on a limit.
    const own = s.product ?? card?.product;
    const { cancelMs, parkMs, split } = own ? limitsFor(own) : { cancelMs: CANCEL_GRACE_FLOOR_MS, parkMs: Infinity, split: Infinity };
    const why = stopReason({ s, card, productDoc, b, compactions, split });
    const sf = factDoc(rec, STOP_FACT(s.id));
    let pending = sf?.doc?.state === 'pending' ? sf.doc : null;
    if (!why && pending && pending.reason !== 'cancel') { putFact(rec, STOP_FACT(s.id), { ...pending, state: 'dropped', dropped_at: iso(now) }, 'stop_dropped'); dropCause(rec, STOP_FACT(s.id)); pending = null; }
    if (why && (!pending || RANK[why] > (RANK[pending.reason] ?? 0))) {
      pending = { state: 'pending', reason: why, card: s.card, since: iso(now) };
      putFact(rec, STOP_FACT(s.id), pending, 'stop_wanted');
    }
    if (!pending) continue;
    const limit = pending.reason === 'cancel' ? cancelMs : parkMs;
    const late = now - Date.parse(pending.since) >= limit;
    if (!atSafePoint({ role: roleOf(s), size: p?.size, activity: p?.activity }) && !late) { out.stopping.push([s.id, pending.reason]); continue; }
    due.push({ s, pending, late });
  }
  const answers = await Promise.all(due.map(({ s }) => guarded(() => stopGroup(s), portDeadlineMs)));
  const done = [];
  const failed = [];
  due.forEach((d, i) => {
    const stopped = answers[i];
    if (stopped?.ok) done.push({ ...d, stopped });
    else { failed.push({ ...d, stopped }); out.stopping.push([d.s.id, d.pending.reason]); }
  });
  // One alert per wanted stop, and again each day it fails (audit MIN-4; L38: no silent hold); told only
  // once delivered (r5 MAT-2). Queued, never waited on: a safety step does not wait on a send (L47).
  for (const { s, pending, stopped } of failed) {
    if (!(now - Date.parse(pending.told_at ?? '') < HOLD_REPEAT_MS)) tellThen(alert, `session ${s.id} (card ${s.card}) could not be stopped: ${stopped?.reason ?? 'no answer'}`, { fact: STOP_FACT(s.id), fields: { told_at: iso(now) }, kind: 'stop_failed' });
  }
  const saves = await Promise.all(done.map(({ s }) => guarded(() => saveWork(s), saveDeadlineMs)));
  for (const [i, { s, pending, late, stopped }] of done.entries()) {
    const saved = saves[i];
    if (late) note(rec, `stop-note-${s.id}`, `session ${s.id} stopped without a safe point after ${Math.round((now - Date.parse(pending.since)) / 60_000)} min (${pending.reason})`, { now });
    moveAfterStop(rec, s.card, pending.reason, now);
    putFact(rec, STOP_FACT(s.id), { ...pending, state: 'done', stopped_at: iso(now), how: stopped.how, hard: late, saved: !!saved?.ok, ...(saved?.ok ? {} : { save_reason: saved?.reason ?? 'no answer' }) }, 'stop_done');
    dropCause(rec, STOP_FACT(s.id));
    // Work not saved is told until delivered (L130 M9): the stop is done either way, and tellUnsaved asks again each pass.
    if (!saved?.ok) tellThen(alert, unsavedText(s.id, saved?.reason), { fact: UNSAVED_FACT(s.id), fields: { told_at: iso(now) }, kind: 'unsaved_told' });
    running = running.filter((x) => x.id !== s.id);
    out.stopped.push([s.id, pending.reason]);
  }

  tellUnsaved({ rec, alert, now });
  return { ...out, running, bands: b, unknownSince, missing };
}

// A done stop whose work was not saved, with no delivered alert for it, is told again (L130 M9).
const unsavedText = (sid, reason) => `session ${sid} stopped but its unsaved work was not saved: ${reason ?? 'no answer'}`;
function tellUnsaved({ rec, alert, now }) {
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(STOP_FACT('')) || f.doc?.state !== 'done' || f.doc.saved !== false) continue;
    const sid = f.id.slice(STOP_FACT('').length);
    if (f.id !== STOP_FACT(sid) || rec.read('fact', UNSAVED_FACT(sid))?.doc?.told_at) continue;
    if (!isQueued(rec, UNSAVED_FACT(sid))) tellThen(alert, unsavedText(sid, f.doc.save_reason), { fact: UNSAVED_FACT(sid), fields: { told_at: iso(now) }, kind: 'unsaved_told' });
  }
}

const readOr = (missing) => (f, fallback) => { try { return f(); } catch (e) { missing.push(e instanceof MissingKey ? e.key : `the rules (${e?.message ?? e})`); return fallback; } };
export const HELD_BANDS = Object.freeze({ band: 'unknown', own_building: 'unknown', pace: null, prodBlocked: true, reason: 'the rules lack a band value' });

/**
 * One pass. Ports:
 *   sessions: the running sessions Mac-wide [{ id, product, kind, card, lead, role, pgid, bundle_files }]
 *   probe(s) -> { size, activity }   (transcript size incl. compactions, and the activity tracker)
 *   launch({ card, kind, product, sessionId }) -> { ok, pid, pidStart, pgid, head, reason, signin, configDir }
 *                                    (M4 launch, through accountLaunch; it starts claude with the claimed sessionId)
 *   stopGroup(s) -> { ok, how }      (stopProcessGroup on the session's group)
 *   saveWork(s) -> { ok, reason }    (M4 save-work, inside the worker's lock-down)
 *   hostLock() -> string | null      (the host.lock text; its path is config)
 *   pauseLead({ product }) -> any    (lead-restart's WRAP flow for a paused product)
 *   filesOf(sha) -> [paths] | null   (the files a merge commit changed: an undo's exact-reverse check)
 *   alert(text)
 * `stops` is the tick's own stopPass result; null when that step failed (then nothing new starts but
 * undo cards); left out, the pass runs stopPass itself.
 */
export async function dispatcherPass({ rec, rules, now, account, sessions, probe, launch, stopGroup, saveWork, hostLock = () => null, pauseLead = () => {}, filesOf, alert, startsOff = null, tellMissing = true, stops, portDeadlineMs = PORT_DEADLINE_MS, saveDeadlineMs = SAVE_DEADLINE_MS, host = hostname() }) {
  const st = stops === undefined ? await stopPass({ rec, rules, now, account, sessions, probe, stopGroup, saveWork, alert, portDeadlineMs, saveDeadlineMs }) : stops;
  const out = { started: [], refused: [], stopping: st?.stopping ?? [], stopped: st?.stopped ?? [], resumed: [], notes: [] };
  const missing = [...(st?.missing ?? [])];
  const read = readOr(missing);
  const unknownMaxMs = read(() => minutes(rules, KEYS.usageUnknownMaxMin), Infinity);
  let b = st?.bands;
  let unknownSince = st?.unknownSince;
  if (!st) {
    b = read(() => currentBands({ rec, rules, account, now }), HELD_BANDS);
    ({ unknownSince } = recordBands({ rec, b, now, account }));
    startsOff ??= 'the stop step did not finish';
  }
  let running = st ? [...st.running] : [...sessions];
  if (missing.length) startsOff ??= `the rules have no value for ${[...new Set(missing)].sort().join(', ')}`;

  // 2. host.lock (m5). An unreadable file is "not known" and changes nothing (audit 0b-6 r3 MAT-1).
  let lockText;
  try { lockText = hostLock(); } catch (e) { lockText = undefined; out.notes.push(`host.lock unreadable: ${e?.message ?? e}`); }
  const seen = factDoc(rec, HOST_FACT);
  if (lockText !== undefined && (seen?.doc?.text ?? null) !== (lockText ?? null)) {
    putFact(rec, HOST_FACT, { text: lockText ?? null, at: iso(now) }, 'host_lock');
    if (lockText && /\bair\b/i.test(lockText)) { note(rec, 'host-lock-note', "who's-home file says Air; ignored for orchestrated products", { now }); out.notes.push('host.lock says Air'); }
  }

  // 5. Resume parked work (M8).
  const unknownLong = b.band === 'unknown' && unknownSince && now - Date.parse(unknownSince) > unknownMaxMs;
  for (const { id, doc } of rec.list('card')) {
    if (doc.state !== 'waiting') continue;
    // A wait's `what` names what it waits on; leaving waiting clears the wait (M9), and the diary keeps the move's kind.
    const what = doc.wait?.what;
    if (what === 'usage_band') {
      // No card waits on Joe silently (L138 m4): this one is told, until delivered, besides the stretch's own alert below.
      if (unknownLong) {
        waitOnJoe(rec, id, { what: 'usage_unknown: usage has been unreadable for over a day', now, kind: 'usage_unknown', alert,
          text: `card ${id}: usage has been unreadable for over a day, so it can't resume by itself; it waits on you` });
        continue;
      }
      // Not while usage is unknown either (audit 0b-6 r2 MIN-2): the gate would hold it, so it would only churn.
      if (b.band !== 'red' && b.band !== 'unknown' && b.own_building !== 'full') { if (move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_usage_band' }).ok) out.resumed.push(id); }
    } else if (what === 'limit_hit') {
      // The limit of the account the card waits on (L97: parked on a's limit, it reads a's fact, not the pass's). The wait names it
      // (`wait.account`, set by whoever parks the card; M9 lets no script put an account on the card itself). Only a
      // reading taken after the card began to wait: an older one is an earlier limit, already reset (L97 M-3). A reading
      // with no reset time (`resets_at` null) or no `observed_at` resumes nothing.
      // The writer that parks a card on a limit (a follow-up, after the worker-exit wiring) must park it first and write
      // `limit-hit-<account>` after (L110 m-3): the Record stamps `wait.since` at the park, so a reading written before
      // it counts as an earlier limit and the card never resumes. (The other way: keep the reading's `observed_at` on
      // the wait and compare against that.)
      // A wait that names no account resumes nothing (L110 m-4): the pass's own account is not the one the card hit,
      // necessarily, so it is never read in its place. The card waits on Joe instead, with one alert.
      const acct = doc.wait?.account;
      if (typeof acct !== 'string' || !acct) {
        // Told until delivered (L130 M12): the card is waiting on Joe from here on, so this branch never sees it again.
        waitOnJoe(rec, id, { what: LIMIT_NO_ACCOUNT, now, kind: 'limit_no_account', alert,
          text: `card ${id}: it waits on a usage limit but the wait does not say which account's, so it can't resume by itself; it waits on you` });
        continue;
      }
      const lf = sensorsFact(rec, LIMIT_FACT(acct))?.doc;
      const seen = Date.parse(lf?.observed_at ?? '');
      const resets = Date.parse(lf?.resets_at ?? '');
      if (!(seen > Date.parse(doc.wait?.since ?? '')) || !Number.isFinite(resets) || now < resets) continue;
      if (doc.tier === 2) { if (move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_limit_hit' }).ok) out.resumed.push(id); }
      // No card waits on Joe silently (L130): this one is told, until delivered.
      else waitOnJoe(rec, id, { what: 'limit_hit: the limit reset; Tier-1 work does not resume by itself', now, kind: 'limit_reset', alert,
        text: `card ${id}: the usage limit it waited on reset, but Tier-1 work does not resume by itself; it waits on you` });
    } else if (what === PAUSED_WAIT_WHAT) {
      // A card parked for a paused product goes back to ready once the product is no longer paused.
      if (rec.read('product', doc.product)?.doc?.state !== 'paused' && move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_paused' }).ok) out.resumed.push(id);
    }
  }
  // Once per stretch of unread usage, and again each day it lasts (L38).
  const uf = factDoc(rec, UNKNOWN_FACT)?.doc;
  if (unknownLong && (!uf?.since?.startsWith?.(unknownSince) || !(now - Date.parse(uf?.told_at ?? '') < HOLD_REPEAT_MS))) {
    tellThen(alert, 'usage has been unreadable for over a day; parked work waits on you', { fact: UNKNOWN_FACT, fields: { since: unknownSince, told_at: iso(now) }, kind: 'usage_unknown_alert' });
  }

  // 6. Starts. When starts are off (no account reading, a rules value missing), undo cards still go
  // through the gate (audit 0b-6 r3 MAT-5, L31): the gate itself refuses what it cannot check.
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); }
  else {
    if (startsOff) out.notes.push(`nothing but undo cards starts: ${startsOff}`);
    await starts({ rec, rules, now, b, running, launch, out, alert, onlyUndo: !!startsOff, missing, filesOf, portDeadlineMs, host });
  }
  // The tick tells Joe once for all its steps (`tellMissing` false); run alone, the pass tells him itself.
  out.missing = missing;
  if (tellMissing) await rulesMissingAlert({ rec, keys: missing, alert, now });

  // 7. Paused products: the Lead hands off once its workers are parked.
  for (const { id: product, doc } of rec.list('product')) {
    const pf = factDoc(rec, PAUSE_FACT(product));
    if (doc.state !== 'paused') { if (['asked', 'failed'].includes(pf?.doc?.state)) putFact(rec, PAUSE_FACT(product), { state: 'cleared', at: iso(now) }, 'pause_cleared'); dropCause(rec, PAUSE_FACT(product)); continue; }
    if (pf?.doc?.state === 'asked') continue;
    if (running.some((s) => s.product === product && parkable(s))) continue;
    // A failing port is that product's problem, told once, not a failed pass (audit 0b-6 r3 MIN-2).
    const asked = await guarded(async () => { await pauseLead({ product }); return { ok: true }; }, portDeadlineMs);
    if (!asked.ok) {
      // Once per reason (its numbers out; audit 0b-6 r5 m4), and again each day it fails (L38); told only once sent (r5 MAT-2).
      const cause = String(asked.reason).replace(/\d+/g, 'N');
      if (pf?.doc?.state !== 'failed') putFact(rec, PAUSE_FACT(product), { state: 'failed', reason: asked.reason, at: iso(now) }, 'pause_lead_failed');
      if (pf?.doc?.told_cause !== cause || !(now - Date.parse(pf?.doc?.told_at ?? '') < HOLD_REPEAT_MS)) {
        tellThen(alert, `the Lead of ${product} could not be asked to hand off: ${asked.reason}; tried again every pass`, { fact: PAUSE_FACT(product), fields: { told_cause: cause, told_at: iso(now) }, kind: 'pause_lead_failed' });
      }
      continue;
    }
    putFact(rec, PAUSE_FACT(product), { state: 'asked', at: iso(now) }, 'pause_lead');
    dropCause(rec, PAUSE_FACT(product));
    out.notes.push(`Lead of ${product} asked to hand off`);
  }
  // The tick's later steps (limits, merges) gate their starts on this pass's bands and sessions.
  return { ...out, bands: b, running };
}

// Undo cards' starts, alone, before every other step (L38): the tick's own step, so a failure in the
// main pass cannot keep an undo from starting. The gate still checks each one (L40).
export async function undoStarts({ rec, rules, now, bands = HELD_BANDS, running = [], launch, filesOf, alert, portDeadlineMs = PORT_DEADLINE_MS, host = hostname() }) {
  const out = { started: [], refused: [], notes: [] };
  const missing = [];
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); return { ...out, missing, running }; }
  const live = [...running];
  await starts({ rec, rules, now, b: bands, running: live, launch, out, alert, onlyUndo: true, missing, filesOf, portDeadlineMs, host });
  return { ...out, missing, running: live };
}

// A cancelled or ended card is not written: its stop is the stop fact's (stopped_at there). A parked card waits, with
// resume retry (a running card's claim ends, so it starts again from ready): the Record has no running -> ready move
// outside a release, a break or a lapse (L72). The Record's waiters are joe, usage, dependency, incident and date:
// a card too big for one session waits on a dependency (the Lead's split), a paused product's card on Joe.
function moveAfterStop(rec, cardId, reason, now) {
  if (!cardId || reason === 'cancel' || reason === 'card_ended') return null;
  if (rec.read('card', cardId)?.doc?.state !== 'running') return null;
  if (reason === 'needs_split') return waitOn(rec, cardId, { who: 'dependency', what: 'needs_split', now, kind: 'needs_split' });
  if (reason === 'red') return waitOn(rec, cardId, { who: 'usage', what: 'usage_band', now, kind: 'park_red' });
  return waitOn(rec, cardId, { who: OWNER_WAIT_WHO, what: PAUSED_WAIT_WHAT, now, kind: 'park_paused' });
}

// Only an explicit Tier 2 is Tier 2 (audit MAT-3).
const tierOf = (c) => (c.tier === 2 ? 2 : 1);
const capRefusal = (r) => /cap|already runs|shares |runs alone/.test(r);

export const UNDO_HELD_FACT = (card) => `undo-held-${card}`;

async function starts({ rec, rules, now, b, running, launch, out, alert, onlyUndo = false, missing = [], filesOf, portDeadlineMs = PORT_DEADLINE_MS, host = hostname() }) {
  const amberish = b.band !== 'green' || b.own_building !== 'open';
  // Undo cards first, then (in amber) Tier 1 before Tier 2, then the longest in ready, by the Record's clock.
  // The Record's own ready rule (rec.ready: unclaimed, dependencies merged, a go where one is needed; L72).
  // The Lead's own daily card is never started as a worker (audit MAT-4; M9 lets only the Lead make one). A fix
  // card stays a draft until the Lead plans it, so rec.ready never holds it.
  const ready = rec.ready().filter((c) => c.doc.kind !== 'lead_daily_card');
  const since = (c) => String(rec.meta?.('card', c.id)?.stateSince ?? '');
  ready.sort((x, y) => isUndo(y.doc) - isUndo(x.doc)
    || (amberish ? tierOf(x.doc) - tierOf(y.doc) : 0)
    || since(x).localeCompare(since(y)) || x.id.localeCompare(y.id));
  const tier1Waiting = new Set();
  for (const { id, rev, doc } of ready) {
    const card = { id, ...doc };
    const product = doc.product;
    if (onlyUndo && !isUndo(doc)) continue;
    // An undo that cannot start is the way out of a bad change: Joe is told why, once per reason and again
    // each day (audit 0b-6 r3 MAT-5). The reason counts with its numbers out, so "runs 2 workers" and
    // "runs 3 workers" are one cause (audit 0b-6 r4).
    const refuse = (reason) => {
      out.refused.push([id, reason]);
      const held = factDoc(rec, UNDO_HELD_FACT(id))?.doc;
      const cause = reason.replace(/\d+/g, 'N');
      if (isUndo(doc) && (held?.told_cause !== cause || !(now - Date.parse(held?.told_at ?? '') < HOLD_REPEAT_MS))) {
        tellThen(alert, `your undo (card ${id}) is waiting: ${reason}`, { fact: UNDO_HELD_FACT(id), fields: { reason, told_cause: cause, told_at: iso(now) }, kind: 'undo_held' });
      }
    };
    let may;
    try { may = rules.may('start_session', { card, product }); } catch (e) { may = { decision: 'refuse', reason: `could not be asked (${e?.message ?? e})` }; }
    if (may.decision !== 'allow') { await refuse(`rules: ${may.reason}`); continue; }
    if (amberish && tierOf(doc) === 2 && tier1Waiting.has(product)) { await refuse('queued behind Tier-1 work in amber'); continue; }
    const kind = kindOf(doc);
    // An undo starts only as the exact reverse of a merge in the record (LEAD-CALLS L40).
    const exact = kind === 'undo' ? exactReverse({ rec, card, filesOf }) : null;
    if (exact && !exact.ok) { await refuse(`it is not an exact reverse: ${exact.reason}`); continue; }
    const g = startGate({ rules, rec, card, kind, product, b, running, exactReverse: !!exact?.ok });
    if (g.missing) missing.push(g.missing);
    if (!g.ok) { if (amberish && tierOf(doc) === 1 && capRefusal(g.reason)) tier1Waiting.add(product); await refuse(g.reason); continue; }
    // The claim names the session before it starts (L72): the launcher starts claude with this id, so a second start
    // can't take the card. The Record stamps claimed_at; rules_rev is the rules the claim was made under.
    const sessionId = randomUUID();
    const rulesRev = may.rev ?? rules.rev;
    const claimDoc = { kind: 'session', session_id: sessionId, host, ...(rulesRev != null ? { rules_rev: rulesRev } : {}) };
    const claim = rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: rev, doc: { ...doc, state: 'claimed', claim: claimDoc }, kind: 'claim' });
    if (!claim.ok) { await refuse(`not claimed: ${claim.reason}`); continue; }
    // A launch has its own time limit (audit 0b-6 r5 m1): one that never answers holds no other start.
    // It may still start a session after the limit, so the card stays claimed, never back to ready (a
    // second start would make two sessions for one card); Joe is told, once a day.
    const l = await guarded(() => launch({ card, kind, product, sessionId }), portDeadlineMs);
    if (!l?.ok && l?.reason === `it did not answer within ${portDeadlineMs} ms`) {
      out.refused.push([id, `launcher: ${l.reason}`]);
      holdAlert({ rec, cause: `launch-late-${id}`, text: `card ${id}: the launcher ${l.reason}; the card stays claimed so it cannot start twice (it lapses at claims.unlaunched_min once its session is stopped)`, alert, now });
      continue;
    }
    // A refused launch started nothing: the claim's holder gives it back (M9 release), and the refusal is in the diary.
    if (!l?.ok) {
      const back = rec.release({ card: id, session_id: sessionId, reason: `launcher: ${l?.reason ?? 'no answer'}` });
      if (!back?.ok) holdAlert({ rec, cause: `release-${id}`, text: `card ${id}: the launcher refused (${l?.reason ?? 'no answer'}) and its claim could not be given back (${back?.reason ?? 'no answer'}); it lapses at claims.unlaunched_min`, alert, now });
      await refuse(`launcher: ${l?.reason ?? 'no answer'}`);
      continue;
    }
    // The launcher must start the session it was given: a different id is a session the claim doesn't name.
    if (l.sessionId !== undefined && l.sessionId !== sessionId) {
      out.refused.push([id, 'launcher: it started a session the claim does not name']);
      holdAlert({ rec, cause: `launch-other-${id}`, text: `card ${id}: the launcher answered with session ${l.sessionId}, not the claimed ${sessionId}; the card stays claimed`, alert, now });
      continue;
    }
    // claimed -> running adds the process (pid and its start time) to the claim, and nothing else.
    const started = move(rec, 'card', id, { state: 'running', claim: { ...rec.read('card', id)?.doc?.claim, pid: l.pid, pid_start: l.pidStart } }, { kind: 'started' });
    if (!started.ok) holdAlert({ rec, cause: `started-${id}`, text: `card ${id}: session ${sessionId} started but the card could not be marked running (${started.reason})`, alert, now });
    // The launch record (R-0b-55, D12): the Merge Gate merges only a head made by a session it names
    // (refusal 5). `head` is the commit the copy started from; `rev` the card's rev once running; `signin` and
    // `config_dir` the sign-in folder the session started in (R-1-89; null when the launch port does not say); `copy` the
    // worker's copy folder, which cleanup checks it deletes (null when the port does not say).
    const lr = rec.write({ actor: 'dispatcher', entity: 'launch', id: sessionId, expectRev: 0, kind: 'launch',
      doc: { session_id: sessionId, role: 'worker', kind, card: id, head: l.head ?? null, rev: started.rev ?? null, product: product ?? null, signin: l.signin ?? null, config_dir: l.configDir ?? null, copy: l.copy ?? null, launched_at: iso(now) } });
    // A notice only: the merge refusal catches it later; a lost one is in the pass's notes (L130 m4).
    if (!lr.ok && alert(`card ${id}: session ${sessionId} started but its launch was not recorded (${lr.reason}); its merge will be refused`) === false) out.notes.push(`card ${id}: the launch-not-recorded alert could not be queued`);
    running.push({ id: sessionId, product, kind, card: id, pgid: l.pgid, signin: l.signin ?? null, config_dir: l.configDir ?? null });
    if (factDoc(rec, UNDO_HELD_FACT(id))?.doc?.reason) putFact(rec, UNDO_HELD_FACT(id), { reason: null, at: iso(now) }, 'undo_started');
    // Whether or not the hold was told: an alert still queued for it leaves unsent (audit 0b-6 r8 MAT-1).
    dropCause(rec, UNDO_HELD_FACT(id));
    out.started.push(id);
  }
}
