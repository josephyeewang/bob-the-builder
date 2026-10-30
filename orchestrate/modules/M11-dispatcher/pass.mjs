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
const PARKABLE = ['editing', 'script', 'overnight'];
const iso = (ms) => new Date(ms).toISOString();

/** Stops a process group: SIGTERM, then SIGKILL if still alive after 10 s. Ports for tests. */
export async function stopProcessGroup({ pgid, kill = (p, s) => process.kill(-p, s), alive, sleep, waitMs = TERM_WAIT_MS }) {
  if (!Number.isInteger(pgid) || pgid <= 1) return { ok: false, reason: 'no process group to stop' };
  try { kill(pgid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return { ok: true, how: 'gone' }; throw e; }
  for (let t = 0; t < waitMs; t += 500) { if (!alive(pgid)) return { ok: true, how: 'SIGTERM' }; await sleep(500); }
  if (!alive(pgid)) return { ok: true, how: 'SIGTERM' };
  try { kill(pgid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
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
  if (!PARKABLE.includes(s.kind)) return null;
  // A worker whose card has ended, or now waits on Joe, has nothing left to do (audit MIN-3).
  if (FINAL_STATES.card.includes(card.state) || (card.state === 'waiting' && card.waiting?.who === 'joe')) return 'card_ended';
  if (compactions >= split) return 'needs_split';
  if (b.band === 'red') return 'red';
  if (productDoc?.state === 'paused') return 'paused';
  return null;
}

/**
 * One pass. Ports:
 *   sessions: the running sessions Mac-wide [{ id, product, kind, card, lead, role, pgid, bundle_files }]
 *   probe(s) -> { size, activity }   (transcript size incl. compactions, and the activity tracker)
 *   launch({ card, kind, product }) -> { ok, sessionId, pgid, reason }   (M4 launch)
 *   stopGroup(s) -> { ok, how }      (stopProcessGroup on the session's group)
 *   saveWork(s) -> { ok, reason }    (M4 save-work, inside the worker's lock-down)
 *   hostLock() -> string | null      (the host.lock text; its path is config)
 *   pauseLead({ product }) -> any    (lead-restart's WRAP flow for a paused product)
 *   alert(text)
 */
export async function dispatcherPass({ rec, rules, now, account, sessions, probe, launch, stopGroup, saveWork, hostLock = () => null, pauseLead = () => {}, alert, startsOff = null }) {
  const out = { started: [], refused: [], stopping: [], stopped: [], resumed: [], notes: [] };
  // A missing rules value starts nothing, but every stop still runs (audit MAT-2): Cancel needs no band.
  const missing = [];
  const read = (f, fallback) => { try { return f(); } catch (e) { if (!(e instanceof MissingKey)) throw e; missing.push(e.key); return fallback; } };
  const cancelMs = read(() => minutes(rules, KEYS.cancelGraceMin), CANCEL_GRACE_FLOOR_MS);
  const parkMs = read(() => minutes(rules, KEYS.parkWaitMin), Infinity);
  const split = read(() => need(rules, KEYS.splitAfterCompactions), Infinity);
  const unknownMaxMs = read(() => minutes(rules, KEYS.usageUnknownMaxMin), Infinity);

  // 1. Bands.
  const b = read(() => currentBands({ rec, rules, account, now }), { band: 'unknown', own_building: 'unknown', pace: null, prodBlocked: true, reason: 'the rules lack a band value' });
  const { unknownSince } = recordBands({ rec, b, now, account });
  if (missing.length) {
    const key = [...new Set(missing)].sort().join(', ');
    if (factDoc(rec, RULES_MISSING_FACT)?.doc?.keys !== key) {
      putFact(rec, RULES_MISSING_FACT, { keys: key, at: iso(now) }, 'rules_missing');
      alert(`the rules have no value for ${key}: nothing new starts until they do; stops still run`);
    }
    startsOff ??= `the rules have no value for ${key}`;
  } else if (factDoc(rec, RULES_MISSING_FACT)?.doc?.keys) putFact(rec, RULES_MISSING_FACT, { keys: null, at: iso(now) }, 'rules_missing_cleared');

  // 2. host.lock (m5).
  const host = hostLock();
  const seen = factDoc(rec, HOST_FACT);
  if ((seen?.doc?.text ?? null) !== (host ?? null)) {
    putFact(rec, HOST_FACT, { text: host ?? null, at: iso(now) }, 'host_lock');
    if (host && /\bair\b/i.test(host)) { note(rec, 'host-lock-note', "who's-home file says Air; ignored for orchestrated products", { now }); out.notes.push('host.lock says Air'); }
  }

  // 3 + 4. Compactions and stops.
  let running = [...sessions];
  for (const s of sessions) {
    const card = s.card ? rec.read('card', s.card)?.doc : null;
    const p = probe(s);
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
    const stopped = await stopGroup(s);
    if (!stopped?.ok) {
      // One alert per wanted stop, not one per pass (audit MIN-4).
      if (!pending.fail_alerted) { alert(`session ${s.id} (card ${s.card}) could not be stopped: ${stopped?.reason ?? 'no answer'}`); pending = { ...pending, fail_alerted: true }; putFact(rec, STOP_FACT(s.id), pending, 'stop_failed'); }
      out.stopping.push([s.id, pending.reason]); continue;
    }
    const saved = await saveWork(s);
    if (!saved?.ok) alert(`session ${s.id} stopped but its unsaved work was not saved: ${saved?.reason ?? 'no answer'}`);
    if (late) note(rec, `stop-note-${s.id}`, `session ${s.id} stopped without a safe point after ${Math.round((now - Date.parse(pending.since)) / 60_000)} min (${pending.reason})`, { now });
    moveAfterStop(rec, s.card, pending.reason, now);
    putFact(rec, STOP_FACT(s.id), { ...pending, state: 'done', stopped_at: iso(now), how: stopped.how, hard: late, saved: !!saved?.ok }, 'stop_done');
    running = running.filter((x) => x.id !== s.id);
    out.stopped.push([s.id, pending.reason]);
  }

  // 5. Resume parked work (M8).
  const unknownLong = b.band === 'unknown' && unknownSince && now - Date.parse(unknownSince) > unknownMaxMs;
  for (const { id, doc } of rec.list('card')) {
    if (doc.state !== 'waiting') continue;
    const what = doc.waiting?.what;
    if (what === 'usage_band') {
      if (unknownLong) { waitOn(rec, id, { who: 'joe', what: 'usage_unknown: usage has been unreadable for over a day', now, kind: 'usage_unknown' }); continue; }
      if (b.band !== 'red' && b.own_building !== 'full') { move(rec, 'card', id, { state: 'ready', waiting: null, resumed_from: 'usage_band' }, { now, kind: 'resume' }); out.resumed.push(id); }
    } else if (what === 'limit_hit') {
      const lf = factDoc(rec, LIMIT_FACT(doc.account ?? account))?.doc;
      const resets = Date.parse(lf?.resets_at ?? '');
      if (!Number.isFinite(resets) || now < resets) continue;
      if (doc.tier === 2) { move(rec, 'card', id, { state: 'ready', waiting: null, resumed_from: 'limit_hit' }, { now, kind: 'resume' }); out.resumed.push(id); }
      else waitOn(rec, id, { who: 'joe', what: 'limit_hit: the limit reset; Tier-1 work does not resume by itself', now, kind: 'limit_reset' });
    }
  }
  if (unknownLong && !factDoc(rec, UNKNOWN_FACT)?.doc?.since?.startsWith?.(unknownSince)) {
    putFact(rec, UNKNOWN_FACT, { since: unknownSince, at: iso(now) }, 'usage_unknown_alert');
    alert('usage has been unreadable for over a day; parked work waits on you');
  }

  // 6. Starts.
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); }
  else if (startsOff) { out.notes.push(`nothing starts: ${startsOff}`); }
  else await starts({ rec, rules, now, b, running, launch, out, alert });

  // 7. Paused products: the Lead hands off once its workers are parked.
  for (const { id: product, doc } of rec.list('product')) {
    const pf = factDoc(rec, PAUSE_FACT(product));
    if (doc.state !== 'paused') { if (pf?.doc?.state === 'asked') putFact(rec, PAUSE_FACT(product), { state: 'cleared', at: iso(now) }, 'pause_cleared'); continue; }
    if (pf?.doc?.state === 'asked') continue;
    if (running.some((s) => s.product === product && PARKABLE.includes(s.kind))) continue;
    await pauseLead({ product });
    putFact(rec, PAUSE_FACT(product), { state: 'asked', at: iso(now) }, 'pause_lead');
    out.notes.push(`Lead of ${product} asked to hand off`);
  }
  // The tick's later steps (limits, merges) gate their starts on this pass's bands and sessions.
  return { ...out, bands: b, running };
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

async function starts({ rec, rules, now, b, running, launch, out, alert }) {
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
    const refuse = (reason) => { out.refused.push([id, reason]); };
    const may = rules.may('start_session', { card, product });
    if (may.decision !== 'allow') { refuse(`rules: ${may.reason}`); continue; }
    if (amberish && tierOf(doc) === 2 && tier1Waiting.has(product)) { refuse('queued behind Tier-1 work in amber'); continue; }
    const kind = kindOf(doc);
    const g = startGate({ rules, rec, card, kind, product, b, running });
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
    out.started.push(id);
  }
}
