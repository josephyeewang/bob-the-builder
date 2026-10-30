// The Dispatcher's main pass (R-0b-55, R-0b-59, R-0b-64, R-0b-67; design v3 Module 6, v4 A2, G8;
// review 0b-6 M7, M8, M16, M19, m5, m6, m7).
//
// At login and every pass: start what the record says should run, and stop what should not.
//   1. Usage bands (usage.mjs), written as the `usage-band` fact.
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
//      may('start_session') -> startGate -> a rev-checked claim -> the launcher. A launcher refusal
//      puts the card back to ready with the reason. Nothing starts during an outage.
//   7. A paused product (m7, G8): once its workers are parked, the Lead is asked to hand off
//      (pauseLead port: lead-restart's WRAP flow), once per pause.
// Product-state starts are M10's `may('start_session')` answer; this file does not repeat them.
// Every outside effect is a port, so tests run on fakes.

import { KEYS, need, minutes, MissingKey } from './keys.mjs';
import { currentBands, recordBands } from './usage.mjs';
import { startGate } from './gate.mjs';
import { atSafePoint } from './transcript.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { move, waitOn, note } from './moves.mjs';
import { exactReverse } from './undo.mjs';
import { FINAL_STATES } from '../../shared/record.mjs';

export const STOP_FACT = (sid) => `stop-${sid}`;
export const COMPACTION_FACT = (card) => `compactions-${card}`;
export const HOST_FACT = 'host-lock-seen';
export const PAUSE_FACT = (product) => `pause-${product}`;
export const LIMIT_FACT = (account) => `limit-hit-${account}`;
export const UNKNOWN_FACT = 'usage-unknown-alert';
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
export function rulesMissingAlert({ rec, factId = RULES_MISSING_FACT, keys, alert, now, what = 'nothing new starts until they do; stops still run', complete = true }) {
  const seen = [...new Set(keys)].sort();
  const had = String(factDoc(rec, factId)?.doc?.keys ?? '').split(', ').filter(Boolean);
  const fresh = seen.filter((k) => !had.includes(k));
  const keep = complete ? seen : [...new Set([...had, ...seen])].sort();
  // Still missing a day after the last alert: told again, all of them (LEAD-CALLS L38, once per cause per day).
  const last = Date.parse(factDoc(rec, factId)?.doc?.alerted_at ?? factDoc(rec, factId)?.doc?.at ?? '');
  const again = !fresh.length && keep.length && seen.length && Number.isFinite(last) && now - last >= HOLD_REPEAT_MS;
  const tell = fresh.length ? fresh : again ? keep : [];
  if (keep.join(', ') !== had.join(', ') || tell.length) {
    const alertedAt = tell.length ? iso(now) : factDoc(rec, factId)?.doc?.alerted_at ?? null;
    putFact(rec, factId, { keys: keep.join(', ') || null, at: iso(now), alerted_at: alertedAt }, keep.length ? 'rules_missing' : 'rules_missing_cleared');
  }
  if (tell.length) alert(`the rules have no value for ${tell.join(', ')}: ${what}`);
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
  const last = Date.parse(f?.alerted_at ?? '');
  // Once per cause per day (L38): a changing detail in the text does not make it a new cause.
  if (Number.isFinite(last) && now - last < HOLD_REPEAT_MS) return false;
  putFact(rec, HOLD_FACT(cause), { text, alerted_at: iso(now) }, 'hold_alert');
  alert(text);
  return true;
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

const kindOf = (card) => (card.kind === 'undo' ? 'undo' : card.kind === 'script' ? 'script' : 'editing');
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
  if (FINAL_STATES.card.includes(card.state) || (card.state === 'waiting' && card.waiting?.who === 'joe')) return 'card_ended';
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
  const cancelMs = read(() => minutes(rules, KEYS.cancelGraceMin), CANCEL_GRACE_FLOOR_MS);
  const parkMs = read(() => minutes(rules, KEYS.parkWaitMin), Infinity);
  const split = read(() => need(rules, KEYS.splitAfterCompactions), Infinity);
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
    const why = stopReason({ s, card, productDoc, b, compactions, split });
    const sf = factDoc(rec, STOP_FACT(s.id));
    let pending = sf?.doc?.state === 'pending' ? sf.doc : null;
    if (!why && pending && pending.reason !== 'cancel') { putFact(rec, STOP_FACT(s.id), { ...pending, state: 'dropped', dropped_at: iso(now) }, 'stop_dropped'); pending = null; }
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
  due.forEach((d, i) => {
    const { s, pending } = d;
    const stopped = answers[i];
    if (stopped?.ok) { done.push({ ...d, stopped }); return; }
    // One alert per wanted stop, and again each day it fails (audit MIN-4; L38: no silent hold).
    if (!pending.fail_alerted || !(now - Date.parse(pending.fail_alerted_at ?? '') < HOLD_REPEAT_MS)) {
      alert(`session ${s.id} (card ${s.card}) could not be stopped: ${stopped?.reason ?? 'no answer'}`);
      putFact(rec, STOP_FACT(s.id), { ...pending, fail_alerted: true, fail_alerted_at: iso(now) }, 'stop_failed');
    }
    out.stopping.push([s.id, pending.reason]);
  });
  const saves = await Promise.all(done.map(({ s }) => guarded(() => saveWork(s), saveDeadlineMs)));
  for (const [i, { s, pending, late, stopped }] of done.entries()) {
    const saved = saves[i];
    if (!saved?.ok) alert(`session ${s.id} stopped but its unsaved work was not saved: ${saved?.reason ?? 'no answer'}`);
    if (late) note(rec, `stop-note-${s.id}`, `session ${s.id} stopped without a safe point after ${Math.round((now - Date.parse(pending.since)) / 60_000)} min (${pending.reason})`, { now });
    moveAfterStop(rec, s.card, pending.reason, now);
    putFact(rec, STOP_FACT(s.id), { ...pending, state: 'done', stopped_at: iso(now), how: stopped.how, hard: late, saved: !!saved?.ok }, 'stop_done');
    running = running.filter((x) => x.id !== s.id);
    out.stopped.push([s.id, pending.reason]);
  }

  return { ...out, running, bands: b, unknownSince, missing };
}

const readOr = (missing) => (f, fallback) => { try { return f(); } catch (e) { missing.push(e instanceof MissingKey ? e.key : `the rules (${e?.message ?? e})`); return fallback; } };
export const HELD_BANDS = Object.freeze({ band: 'unknown', own_building: 'unknown', pace: null, prodBlocked: true, reason: 'the rules lack a band value' });

/**
 * One pass. Ports:
 *   sessions: the running sessions Mac-wide [{ id, product, kind, card, lead, role, pgid, bundle_files }]
 *   probe(s) -> { size, activity }   (transcript size incl. compactions, and the activity tracker)
 *   launch({ card, kind, product }) -> { ok, sessionId, pgid, reason }   (M4 launch)
 *   stopGroup(s) -> { ok, how }      (stopProcessGroup on the session's group)
 *   saveWork(s) -> { ok, reason }    (M4 save-work, inside the worker's lock-down)
 *   hostLock() -> string | null      (the host.lock text; its path is config)
 *   pauseLead({ product }) -> any    (lead-restart's WRAP flow for a paused product)
 *   filesOf(sha) -> [paths] | null   (the files a merge commit changed: an undo's exact-reverse check)
 *   alert(text)
 * `stops` is the tick's own stopPass result; null when that step failed (then nothing new starts but
 * undo cards); left out, the pass runs stopPass itself.
 */
export async function dispatcherPass({ rec, rules, now, account, sessions, probe, launch, stopGroup, saveWork, hostLock = () => null, pauseLead = () => {}, filesOf, alert, startsOff = null, tellMissing = true, stops, portDeadlineMs = PORT_DEADLINE_MS, saveDeadlineMs = SAVE_DEADLINE_MS }) {
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
  let host;
  try { host = hostLock(); } catch (e) { host = undefined; out.notes.push(`host.lock unreadable: ${e?.message ?? e}`); }
  const seen = factDoc(rec, HOST_FACT);
  if (host !== undefined && (seen?.doc?.text ?? null) !== (host ?? null)) {
    putFact(rec, HOST_FACT, { text: host ?? null, at: iso(now) }, 'host_lock');
    if (host && /\bair\b/i.test(host)) { note(rec, 'host-lock-note', "who's-home file says Air; ignored for orchestrated products", { now }); out.notes.push('host.lock says Air'); }
  }

  // 5. Resume parked work (M8).
  const unknownLong = b.band === 'unknown' && unknownSince && now - Date.parse(unknownSince) > unknownMaxMs;
  for (const { id, doc } of rec.list('card')) {
    if (doc.state !== 'waiting') continue;
    const what = doc.waiting?.what;
    if (what === 'usage_band') {
      if (unknownLong) { waitOn(rec, id, { who: 'joe', what: 'usage_unknown: usage has been unreadable for over a day', now, kind: 'usage_unknown' }); continue; }
      // Not while usage is unknown either (audit 0b-6 r2 MIN-2): the gate would hold it, so it would only churn.
      if (b.band !== 'red' && b.band !== 'unknown' && b.own_building !== 'full') { move(rec, 'card', id, { state: 'ready', waiting: null, resumed_from: 'usage_band' }, { now, kind: 'resume' }); out.resumed.push(id); }
    } else if (what === 'limit_hit') {
      const lf = factDoc(rec, LIMIT_FACT(doc.account ?? account))?.doc;
      const resets = Date.parse(lf?.resets_at ?? '');
      if (!Number.isFinite(resets) || now < resets) continue;
      if (doc.tier === 2) { move(rec, 'card', id, { state: 'ready', waiting: null, resumed_from: 'limit_hit' }, { now, kind: 'resume' }); out.resumed.push(id); }
      else waitOn(rec, id, { who: 'joe', what: 'limit_hit: the limit reset; Tier-1 work does not resume by itself', now, kind: 'limit_reset' });
    }
  }
  // Once per stretch of unread usage, and again each day it lasts (L38).
  const uf = factDoc(rec, UNKNOWN_FACT)?.doc;
  if (unknownLong && (!uf?.since?.startsWith?.(unknownSince) || !(now - Date.parse(uf?.at ?? '') < HOLD_REPEAT_MS))) {
    putFact(rec, UNKNOWN_FACT, { since: unknownSince, at: iso(now) }, 'usage_unknown_alert');
    alert('usage has been unreadable for over a day; parked work waits on you');
  }

  // 6. Starts. When starts are off (no account reading, a rules value missing), undo cards still go
  // through the gate (audit 0b-6 r3 MAT-5, L31): the gate itself refuses what it cannot check.
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); }
  else {
    if (startsOff) out.notes.push(`nothing but undo cards starts: ${startsOff}`);
    await starts({ rec, rules, now, b, running, launch, out, alert, onlyUndo: !!startsOff, missing, filesOf });
  }
  // The tick tells Joe once for all its steps (`tellMissing` false); run alone, the pass tells him itself.
  out.missing = missing;
  if (tellMissing) rulesMissingAlert({ rec, keys: missing, alert, now });

  // 7. Paused products: the Lead hands off once its workers are parked.
  for (const { id: product, doc } of rec.list('product')) {
    const pf = factDoc(rec, PAUSE_FACT(product));
    if (doc.state !== 'paused') { if (['asked', 'failed'].includes(pf?.doc?.state)) putFact(rec, PAUSE_FACT(product), { state: 'cleared', at: iso(now) }, 'pause_cleared'); continue; }
    if (pf?.doc?.state === 'asked') continue;
    if (running.some((s) => s.product === product && parkable(s))) continue;
    // A failing port is that product's problem, told once, not a failed pass (audit 0b-6 r3 MIN-2).
    const asked = await guarded(async () => { await pauseLead({ product }); return { ok: true }; }, portDeadlineMs);
    if (!asked.ok) {
      // Once per reason, and again each day it fails (L38).
      if (pf?.doc?.reason !== asked.reason || !(now - Date.parse(pf?.doc?.at ?? '') < HOLD_REPEAT_MS)) { putFact(rec, PAUSE_FACT(product), { state: 'failed', reason: asked.reason, at: iso(now) }, 'pause_lead_failed'); alert(`the Lead of ${product} could not be asked to hand off: ${asked.reason}; tried again every pass`); }
      continue;
    }
    putFact(rec, PAUSE_FACT(product), { state: 'asked', at: iso(now) }, 'pause_lead');
    out.notes.push(`Lead of ${product} asked to hand off`);
  }
  // The tick's later steps (limits, merges) gate their starts on this pass's bands and sessions.
  return { ...out, bands: b, running };
}

// Undo cards' starts, alone, before every other step (L38): the tick's own step, so a failure in the
// main pass cannot keep an undo from starting. The gate still checks each one (L40).
export async function undoStarts({ rec, rules, now, bands = HELD_BANDS, running = [], launch, filesOf, alert }) {
  const out = { started: [], refused: [], notes: [] };
  const missing = [];
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); return { ...out, missing, running }; }
  const live = [...running];
  await starts({ rec, rules, now, b: bands, running: live, launch, out, alert, onlyUndo: true, missing, filesOf });
  return { ...out, missing, running: live };
}

function moveAfterStop(rec, cardId, reason, now) {
  if (!cardId) return;
  if (reason === 'cancel') return move(rec, 'card', cardId, { stopped_at: iso(now) }, { now, kind: 'cancel_stopped' });
  if (reason === 'card_ended') return move(rec, 'card', cardId, { stopped_at: iso(now) }, { now, kind: 'ended_stopped' });
  if (reason === 'needs_split') return waitOn(rec, cardId, { who: 'lead', what: 'needs_split', now, kind: 'needs_split' });
  if (reason === 'red') return waitOn(rec, cardId, { who: 'dispatcher', what: 'usage_band', now, kind: 'park_red' });
  return move(rec, 'card', cardId, { state: 'ready', parked_for: 'paused' }, { now, kind: 'park_paused' });
}

// Only an explicit Tier 2 is Tier 2 (audit MAT-3).
const tierOf = (c) => (c.tier === 2 ? 2 : 1);
const capRefusal = (r) => /cap|already runs|shares |runs alone/.test(r);

export const UNDO_HELD_FACT = (card) => `undo-held-${card}`;

async function starts({ rec, rules, now, b, running, launch, out, alert, onlyUndo = false, missing = [], filesOf }) {
  const amberish = b.band !== 'green' || b.own_building !== 'open';
  // A card meant for the Lead to plan (for: 'lead') is never started as a worker (audit MAT-4).
  const ready = rec.list('card').filter((c) => c.doc.state === 'ready' && c.doc.for !== 'lead');
  ready.sort((x, y) => (y.doc.queue === 'front') - (x.doc.queue === 'front')
    || (amberish ? tierOf(x.doc) - tierOf(y.doc) : 0)
    || String(x.doc.changed_at ?? '').localeCompare(String(y.doc.changed_at ?? '')) || x.id.localeCompare(y.id));
  const tier1Waiting = new Set();
  for (const { id, rev, doc } of ready) {
    const card = { id, ...doc };
    const product = doc.product;
    if (onlyUndo && doc.kind !== 'undo') continue;
    // An undo that cannot start is the way out of a bad change: Joe is told why, once per reason and again
    // each day (audit 0b-6 r3 MAT-5). The reason counts with its numbers out, so "runs 2 workers" and
    // "runs 3 workers" are one cause (audit 0b-6 r4).
    const refuse = (reason) => {
      out.refused.push([id, reason]);
      const held = factDoc(rec, UNDO_HELD_FACT(id))?.doc;
      const cause = reason.replace(/\d+/g, 'N');
      if (doc.kind === 'undo' && (held?.cause !== cause || !(now - Date.parse(held?.at ?? '') < HOLD_REPEAT_MS))) {
        putFact(rec, UNDO_HELD_FACT(id), { reason, cause, at: iso(now) }, 'undo_held');
        alert(`your undo (card ${id}) is waiting: ${reason}`);
      }
    };
    let may;
    try { may = rules.may('start_session', { card, product }); } catch (e) { may = { decision: 'refuse', reason: `could not be asked (${e?.message ?? e})` }; }
    if (may.decision !== 'allow') { refuse(`rules: ${may.reason}`); continue; }
    if (amberish && tierOf(doc) === 2 && tier1Waiting.has(product)) { refuse('queued behind Tier-1 work in amber'); continue; }
    const kind = kindOf(doc);
    // An undo starts only as the exact reverse of a merge in the record (LEAD-CALLS L40).
    const exact = kind === 'undo' ? exactReverse({ rec, card, filesOf }) : null;
    if (exact && !exact.ok) { refuse(`it is not an exact reverse: ${exact.reason}`); continue; }
    const g = startGate({ rules, rec, card, kind, product, b, running, exactReverse: !!exact?.ok });
    if (g.missing) missing.push(g.missing);
    if (!g.ok) { if (amberish && tierOf(doc) === 1 && capRefusal(g.reason)) tier1Waiting.add(product); refuse(g.reason); continue; }
    const claim = rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: rev, doc: { ...doc, state: 'claimed', claimed_at: iso(now), changed_at: iso(now), rules_rev: may.rev ?? rules.rev ?? null }, kind: 'claim' });
    if (!claim.ok) { refuse(`not claimed: ${claim.reason}`); continue; }
    let l;
    try { l = await launch({ card, kind, product }); } catch (e) { l = { ok: false, reason: e.message }; }
    if (!l?.ok) {
      move(rec, 'card', id, { state: 'ready', last_refusal: l?.reason ?? 'the launcher gave no answer' }, { now, kind: 'launch_refused' });
      refuse(`launcher: ${l?.reason ?? 'no answer'}`);
      continue;
    }
    const started = move(rec, 'card', id, { state: 'running', session: l.sessionId }, { now, kind: 'started' });
    // The launch record (R-0b-55, D12): the Merge Gate merges only a head made by a session it names
    // (refusal 5). `head` is the commit the copy started from; `rev` the card's rev once running.
    const lr = rec.write({ actor: 'dispatcher', entity: 'launch', id: l.sessionId, expectRev: rec.read('launch', l.sessionId)?.rev ?? 0, kind: 'launch',
      doc: { session_id: l.sessionId, role: 'worker', kind, card: id, head: l.head ?? null, rev: started.rev ?? null, product: product ?? null, launched_at: iso(now) } });
    if (!lr.ok) alert(`card ${id}: session ${l.sessionId} started but its launch was not recorded (${lr.reason}); its merge will be refused`);
    running.push({ id: l.sessionId, product, kind, card: id, pgid: l.pgid });
    if (factDoc(rec, UNDO_HELD_FACT(id))?.doc?.reason) putFact(rec, UNDO_HELD_FACT(id), { reason: null, at: iso(now) }, 'undo_started');
    out.started.push(id);
  }
}
