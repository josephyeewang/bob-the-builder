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
import { startGate, riskOf } from './gate.mjs';
import { atSafePoint } from './transcript.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { machineId } from '../M9-record/lock.mjs';
import { move, waitOn, note } from './moves.mjs';
import { waitOnJoe } from './joe-waits.mjs';
import { sensorsFact } from './sensor-facts.mjs';
import { tellThen, clearCause, isQueued, writeFrom } from './alerts.mjs';
import { stillWaiting, dueToTell, pastTime, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';
import { exactReverse } from './undo.mjs';
import { cardBranch } from '../M4-workshop/git/branch.mjs';
import { workerOutboxProblem } from '../M4-workshop/git/session-outbox.mjs';
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
/** The other limit_hit waits that can't resume by themselves and wait on Joe (MAT-1, audit #78 r2). */
export const LIMIT_NO_RUN = 'limit_hit: the wait has no time its run began, so no hit can be matched to it';
export const LIMIT_NO_RESET = 'limit_hit: the hit has no readable reset time';
/** The latest a limit can reset after its hit (audit #125 r1 MAT-A). The weekly window is the longest real one, so a
 *  reset more than a week (and an hour's slack) after the hit is a misread, read as no reset time: the card waits on Joe
 *  and he is told, never held in silence until a date that will not come. */
export const LIMIT_RESET_MAX_MS = 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;

// When a card began to wait: its wait's since, or `fallback` when that can't be read (L285), so a cap measured from
// it still ends. The Record writer stamps since and keeps it on a re-check (M9 checkWait), so only a hand-edited
// Record lacks one. The fallback is the run's start (wait.run_started, which every limit wait that gets this far has):
// fixed, and never later than the park. Not the hit's time: each new hit moves it, so a cap counted from it never ends.
// Read by pastTime's rule (#153 audit MAT-1): a since more than 60 s ahead of `now` is not read, so a cap measured from
// it still ends.
const waitedFrom = (doc, fallback, now) => pastTime(doc.wait?.since, now) ?? fallback;
export const LIMIT_NO_HIT = 'limit_hit: no limit hit was recorded for the run in time';
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
// `f` gets an AbortSignal that is aborted when guarded gives up on it (L822, #372 m2), so a port that honours it (a
// stop, say) does nothing more once its answer no longer counts. A port that ignores it is unchanged.
export async function guarded(f, ms = PORT_DEADLINE_MS) {
  let timer;
  const giveUp = new AbortController();
  const late = new Promise((ok) => { timer = setTimeout(() => { giveUp.abort(); ok({ ok: false, timedOut: true, reason: `it did not answer within ${ms} ms` }); }, ms); });
  try { return await Promise.race([Promise.resolve().then(() => f(giveUp.signal)), late]); } catch (e) { return { ok: false, reason: e?.message ?? String(e) }; } finally { clearTimeout(timer); }
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
  // Still missing a day after the last alert: told again, all of them (LEAD-CALLS L38, once per cause per day). A told
  // time that can't be read or lies ahead counts as due (L324, shared dueToTell): before, it was never told again.
  const last = pastTime(doc?.told_at, now);
  const again = !fresh.length && keep.length && seen.length && dueToTell(doc, now, HOLD_REPEAT_MS);
  const tell = fresh.length ? fresh : again ? keep : [];
  const joined = keep.join(', ') || null;
  if (joined !== (doc?.keys ?? null)) putFact(rec, factId, { ...doc, keys: joined, at: iso(now) }, keep.length ? 'rules_missing' : 'rules_missing_cleared', doc);
  const toldNow = () => [...new Set([...told, ...tell])].sort().join(', ');
  // A new key told alone keeps the day clock of the keys told before (audit 0b-6 r6 m-5).
  const at = again || last === null ? iso(now) : doc.told_at;
  if (tell.length) tellThen(alert, `the rules have no value for ${tell.join(', ')}: ${what}`, { fact: factId, fields: { told_keys: toldNow(), told_at: at }, kind: 'rules_missing_told' });
  return seen.join(', ') || null;
}

export const HOLD_FACT = (cause) => `hold-${cause}`;
// The shared still-waiting repeat, one definition (#164 audit c1).
export const HOLD_REPEAT_MS = STILL_WAITING_MS;
const SESSION_OUTBOX_CAUSE = (card) => `session-outbox-${card}`;
const SESSION_RECORD_CAUSE = (card) => `session-record-${card}`;

/**
 * No silent hold (LEAD-CALLS L38): anything that holds or blocks work tells Joe what and why, once per
 * cause per day, on the fact `hold-<cause>`.
 */
export function holdAlert({ rec, cause, text, alert, now, every = HOLD_REPEAT_MS }) {
  const f = factDoc(rec, HOLD_FACT(cause))?.doc;
  // Once per cause per day (L38), or per `every` (a paused product, weekly; L299): a changing detail in the text
  // does not make it a new cause. null, not false: already told today is not a refused alert (L130 m12). A told_at
  // that can't be read, or more than 60 s ahead of now, is not told (shared dueToTell; #157 audit MAT-1).
  if (!dueToTell(f, now, every)) return null;
  // Marked told only once a copy is delivered (audit 0b-6 r5 MAT-2; L47).
  return tellThen(alert, text, { fact: HOLD_FACT(cause), fields: { text, told_at: iso(now) }, kind: 'hold_alert' });
}

/**
 * A refused drop, save, note or clear (L449): said in the step's own lines, heard by `failureLog` (main.mjs logs it), and
 * told through holdAlert, so once a day per cause however often it repeats. The log is what is left if the alert is
 * refused too, so a failing tell never takes it away.
 */
export function refusalReport({ rec, alert, now, lines, failureLog = () => {} }) {
  return (line, cause) => {
    lines.push(line);
    failureLog(line);
    try { holdAlert({ rec, cause: `report-${cause}`, text: `the Dispatcher: ${line}`, alert, now }); }
    catch (e) { failureLog(`${line}: it could not be told (${e?.message ?? e})`); }
  };
}

/**
 * Stops a process group: SIGTERM, then SIGKILL if still alive after 10 s. Ports for tests. `signal` (an AbortSignal,
 * L822): a caller that gives up on the stop (a port limit, say) aborts it, and no signal is sent after that, so a stop
 * it abandoned can't SIGKILL a group later. An aborted stop answers { ok: false, reason: 'abandoned' }: the caller
 * gave up, which says nothing about whether the group still runs (#372 c2). A group seen gone after SIGTERM is still
 * answered { ok: true, how: 'SIGTERM' }, even when the abort came at the same step. An abort during a `sleep` takes
 * effect when that sleep ends (the sleep is the caller's, and is not cut short; #372 c1).
 */
export async function stopProcessGroup({ pgid, kill = (p, s) => process.kill(-p, s), alive, sleep, waitMs = TERM_WAIT_MS, signal }) {
  if (!Number.isInteger(pgid) || pgid <= 1) return { ok: false, reason: 'no process group to stop' };
  const abandoned = { ok: false, reason: 'abandoned' };
  if (signal?.aborted) return abandoned;
  // Any other error (EPERM, say) is an answer, not a throw (audit 0b-6 r2 MAT-7): one session must not end the pass.
  try { kill(pgid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return { ok: true, how: 'gone' }; return { ok: false, reason: e.code ?? e.message }; }
  for (let t = 0; t < waitMs; t += 500) {
    if (!alive(pgid)) return { ok: true, how: 'SIGTERM' };
    if (signal?.aborted) return abandoned;
    await sleep(500);
  }
  if (!alive(pgid)) return { ok: true, how: 'SIGTERM' };
  if (signal?.aborted) return abandoned;
  try { kill(pgid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') return { ok: false, reason: e.code ?? e.message }; }
  return { ok: true, how: 'SIGKILL' };
}

// An undo card is M9's kind exact_reverse (L74); the session kind stays 'undo'.
const isUndo = (card) => card.kind === 'exact_reverse';
const kindOf = (card) => (isUndo(card) ? 'undo' : card.kind === 'script' ? 'script' : 'editing');
// The M10 profile a start is asked for: a script card runs the script profile, every other start a worker.
const startRole = (kind) => (kind === 'script' ? 'script' : 'worker');
// A script session reports role 'script' (its M10 profile, startRole) and follows the worker's safe point (L759).
const roleOf = (s) => s.role ?? (s.kind === 'editing' || s.kind === 'script' ? 'worker' : s.kind);
const factDoc = (rec, id) => rec.read('fact', id);
// `base` is the doc the caller read: only what the caller changed is written, at the version read and again on a
// conflict, so a mark written meanwhile is kept (writeFrom, L335 m-1). `force` names keys written anyway: a clear's told fields.
export const putFact = (rec, id, doc, kind, base, force = []) => writeFrom(rec, id, base, doc, kind, { force });
// The fields a told mark writes on the facts cleared here (L354 item 3).
const TOLD = ['told_cause', 'told_at'];
/** The launch record (shape below, at the start loop). One writer: a research copy's run is recorded the same way. */
// `base` is a commit id or not said (#384 m2): a launch port other than owner-asks (which checks it, launchAnswerWrong)
// could hand on 'main', a number or an object, and the record would say the copy was started on it. Such a launch is
// not recorded, as any refused write: the caller tells it, and its merge is refused.
const BASE_COMMIT = /^[0-9a-f]{40}$/;
export const writeLaunch = (rec, { base, ...rest }) => (base === undefined || base === null || (typeof base === 'string' && BASE_COMMIT.test(base))
  ? writeLaunchRecord(rec, { base, ...rest })
  : { ok: false, reason: 'the launch named a malformed base commit' });
const writeLaunchRecord = (rec, { sessionId, role, kind, card, head, base, rev, product, signin, configDir, copy, now }) => rec.write({ actor: 'dispatcher', entity: 'launch', id: sessionId, expectRev: 0, kind: 'launch',
  doc: { session_id: sessionId, role, kind, card, head: head ?? null, base: base ?? null, rev: rev ?? null, product: product ?? null, signin: signin ?? null, config_dir: configDir ?? null, copy: copy ?? null, launched_at: iso(now) } });

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
// `clock` (ms) is read again once the stops and saves are back (up to PORT_DEADLINE_MS + SAVE_DEADLINE_MS later): the
// park is written at that time, since the Store Writer refuses a wait whose since is more than 60 s off its clock (L321).
// Left out, it is `now`.
export async function stopPass({ rec, rules, now, clock = () => now, account, sessions, probe, stopGroup, saveWork, alert, failureLog = () => {}, portDeadlineMs = PORT_DEADLINE_MS, saveDeadlineMs = SAVE_DEADLINE_MS }) {
  const out = { stopping: [], stopped: [], notes: [] };
  const report = refusalReport({ rec, alert, now, lines: out.notes, failureLog });
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
      if (n > (by[s.id] ?? 0)) { by[s.id] = n; putFact(rec, COMPACTION_FACT(s.card), { card: s.card, by_session: by, at: iso(now) }, 'compactions', cf?.doc); }
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
    if (!why && pending && pending.reason !== 'cancel') { clearCause(rec, STOP_FACT(s.id), () => putFact(rec, STOP_FACT(s.id), { ...pending, state: 'dropped', dropped_at: iso(now) }, 'stop_dropped', pending, ['told_at']), report, { hold: false }); pending = null; }
    if (why && (!pending || RANK[why] > (RANK[pending.reason] ?? 0))) {
      pending = { state: 'pending', reason: why, card: s.card, since: iso(now) };
      putFact(rec, STOP_FACT(s.id), pending, 'stop_wanted', sf?.doc);
    }
    if (!pending) continue;
    // A wanted-since that can't be read or lies ahead (L324) would never come due, so the stop would wait for a safe
    // point for ever. It is restarted from now instead (not counted as late, which would stop at once with no safe
    // point over a bad field): the stop is forced one limit from now at most.
    if (pastTime(pending.since, now) === null) {
      const was = pending;
      pending = { ...pending, since: iso(now), restarted: true };
      putFact(rec, STOP_FACT(s.id), pending, 'stop_wanted', was);
    }
    const limit = pending.reason === 'cancel' ? cancelMs : parkMs;
    const late = now - Date.parse(pending.since) >= limit;
    if (!atSafePoint({ role: roleOf(s), size: p?.size, activity: p?.activity }) && !late) { out.stopping.push([s.id, pending.reason]); continue; }
    due.push({ s, pending, late });
  }
  const answers = await Promise.all(due.map(({ s }) => guarded((signal) => stopGroup(s, { signal }), portDeadlineMs)));
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
    if (dueToTell(pending, now, HOLD_REPEAT_MS)) tellThen(alert, `session ${s.id} (card ${s.card}) could not be stopped: ${stopped?.reason ?? 'no answer'}`, { fact: STOP_FACT(s.id), fields: { told_at: iso(now) }, kind: 'stop_failed' });
  }
  const saves = await Promise.all(done.map(({ s }) => guarded(() => saveWork(s), saveDeadlineMs)));
  const after = Math.max(now, clock());
  for (const [i, { s, pending, late, stopped }] of done.entries()) {
    const saved = saves[i];
    // After a restart (its start time could not be read) the wait was longer than this count: the note says so (L339).
    const counted = `${Math.round((after - Date.parse(pending.since)) / 60_000)} min${pending.restarted ? ' counted from a restart (its start time could not be read, so it waited longer)' : ''}`;
    if (late) note(rec, `stop-note-${s.id}`, `session ${s.id} stopped without a safe point after ${counted} (${pending.reason})`, { now: after });
    // The move's answer is kept on the stop (L323): a park the Record refuses is tried again each pass (reparkStopped)
    // and told to the owner while it lasts (refused-writes.mjs), never dropped.
    const moved = moveAfterStop(rec, s.card, pending.reason, after);
    clearCause(rec, STOP_FACT(s.id), () => putFact(rec, STOP_FACT(s.id), { ...pending, state: 'done', stopped_at: iso(after), how: stopped.how, hard: late, saved: !!saved?.ok, ...(saved?.ok ? {} : { save_reason: saved?.reason ?? 'no answer' }), ...movedFields(moved) }, 'stop_done', pending, ['told_at']), report, { hold: false });
    // Work not saved is told until delivered (L130 M9): the stop is done either way, and tellUnsaved asks again each pass.
    if (!saved?.ok) tellThen(alert, unsavedText(s.id, saved?.reason), { fact: UNSAVED_FACT(s.id), fields: { told_at: iso(now) }, kind: 'unsaved_told' });
    running = running.filter((x) => x.id !== s.id);
    out.stopped.push([s.id, pending.reason]);
  }

  tellUnsaved({ rec, alert, now });
  reparkStopped({ rec, now: Math.max(after, clock()) });
  return { ...out, running, bands: b, unknownSince, missing };
}

// A stop's record of its card's move: moved true, or false with the Record's reason; nothing when no move was due.
const movedFields = (m) => (m == null ? {} : m.ok ? { moved: true } : { moved: false, move_reason: m.reason ?? 'refused' });

// A done stop whose card's park the Record refused (L323) is parked again each pass while its card still runs under
// the stopped session. Each refusal is told through refused-writes.mjs; once the card moves on, by this or anything
// else, the stop says so. A card that runs under another session now was started again: the stop no longer speaks for
// it, and is marked superseded, never parked over the new run (L332 m3).
function reparkStopped({ rec, now }) {
  for (const f of rec.list('fact')) {
    if (!f.id.startsWith(STOP_FACT('')) || f.doc?.state !== 'done' || f.doc.moved !== false) continue;
    const card = rec.read('card', f.doc.card)?.doc;
    const sid = f.id.slice(STOP_FACT('').length);
    const runSid = card?.claim?.session_id;
    if (card?.state === 'running' && typeof runSid === 'string' && runSid !== sid) {
      putFact(rec, f.id, { ...f.doc, moved: 'superseded', move_reason: `the card runs under session ${runSid} now` }, 'stop_moved', f.doc);
      continue;
    }
    const m = card?.state === 'running' ? moveAfterStop(rec, f.doc.card, f.doc.reason, now) : { ok: true };
    if (m?.ok) putFact(rec, f.id, { ...f.doc, moved: true, move_reason: null }, 'stop_moved', f.doc);
    else if (m && m.reason !== f.doc.move_reason) putFact(rec, f.id, { ...f.doc, move_reason: m.reason ?? 'refused' }, 'stop_moved', f.doc);
  }
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
 *   launch({ card, kind, product, sessionId }) -> { ok, pid, pidStart, pgid, head, base, outbox, reason, signin, configDir }
 *                                    (M4 launch, through accountLaunch; it starts claude with the claimed sessionId;
 *                                    `outbox` is the full path of the session's own outbox folder, which it made)
 *   stopGroup(s, { signal }) -> { ok, how }  (stopProcessGroup on the session's group; `signal` aborts when the pass gives up on it)
 *   saveWork(s) -> { ok, reason }    (M4 save-work, inside the worker's lock-down)
 *   hostLock() -> string | null      (the host.lock text; its path is config)
 *   pauseLead({ product }) -> any    (lead-restart's WRAP flow for a paused product)
 *   filesOf(sha) -> [paths]   (the files a merge commit changed: an undo's exact-reverse check; never null, it throws instead)
 *   alert(text)
 * `stops` is the tick's own stopPass result; null when that step failed (then nothing new starts but
 * undo cards); left out, the pass runs stopPass itself.
 */
export async function dispatcherPass({ rec, rules, now, clock = () => now, account, sessions, probe, launch, stopGroup, outboxRoot, saveWork, hostLock = () => null, pauseLead = () => {}, filesOf, alert, failureLog = () => {}, startsOff = null, tellMissing = true, stops, portDeadlineMs = PORT_DEADLINE_MS, saveDeadlineMs = SAVE_DEADLINE_MS, host = hostname() }) {
  const st = stops === undefined ? await stopPass({ rec, rules, now, clock, account, sessions, probe, stopGroup, saveWork, alert, portDeadlineMs, saveDeadlineMs }) : stops;
  const out = { started: [], refused: [], stopping: st?.stopping ?? [], stopped: st?.stopped ?? [], resumed: [], notes: [...(st?.notes ?? [])] };
  const report = refusalReport({ rec, alert, now, lines: out.notes, failureLog });
  const failing = (line) => { out.notes.push(line); failureLog(line); };
  // A tell whose since could not be kept goes in the pass's notes as well as in the owner's text (L343).
  const askJoe = (id, ask) => { const w = waitOnJoe(rec, id, ask); if (w.tell_refused) failing(`card ${id}: ${w.tell_refused}`); return w; };
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
  try { lockText = hostLock(); } catch (e) { lockText = undefined; failing(`host.lock unreadable: ${e?.message ?? e}`); }
  const seen = factDoc(rec, HOST_FACT);
  if (lockText !== undefined && (seen?.doc?.text ?? null) !== (lockText ?? null)) {
    putFact(rec, HOST_FACT, { text: lockText ?? null, at: iso(now) }, 'host_lock', seen?.doc);
    if (lockText && /\bair\b/i.test(lockText)) { note(rec, 'host-lock-note', "who's-home file says Air; ignored for orchestrated products", { now }); out.notes.push('host.lock says Air'); }
  }

  // 5. Resume parked work (M8).
  // A start of the unknown band that can't be read or lies ahead counts as over a day (L324, shared pastTime): told,
  // never waited out.
  const unknownAt = unknownSince ? pastTime(unknownSince, now) : undefined;
  const unknownLong = b.band === 'unknown' && !!unknownSince && (unknownAt === null || now - unknownAt > unknownMaxMs);
  for (const { id, doc } of rec.list('card')) {
    if (doc.state !== 'waiting') continue;
    // A wait's `what` names what it waits on; leaving waiting clears the wait (M9), and the diary keeps the move's kind.
    const what = doc.wait?.what;
    if (what === 'usage_band') {
      // No card waits on Joe silently (L138 m4): this one is told, until delivered, besides the stretch's own alert below.
      if (unknownLong) {
        askJoe(id, { what: 'usage_unknown: usage has been unreadable for over a day', now, kind: 'usage_unknown', alert,
          text: `card ${id}: usage has been unreadable for over a day, so it can't resume by itself; it waits on you` });
        continue;
      }
      // Not while usage is unknown either (audit 0b-6 r2 MIN-2): the gate would hold it, so it would only churn.
      if (b.band !== 'red' && b.band !== 'unknown' && b.own_building !== 'full') { if (move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_usage_band' }).ok) out.resumed.push(id); }
    } else if (what === 'limit_hit') {
      // The limit of the account the card waits on (L97: parked on a's limit, it reads a's fact, not the pass's). The wait names it
      // (`wait.account`, set by whoever parks the card; M9 lets no script put an account on the card itself). Only a
      // hit observed after the card's run began counts (MAT-1, audit #78 r2): an older one is an earlier limit, already
      // reset (L97 M-3). The Record sets `wait.run_started` from the claim when a claimed or running card is parked
      // (M9 guard.mjs), so a hit written before the park still counts. Order is not wholly free: an older hit from the
      // same run can resume a card parked later on a newer one, which is churn (it parks again), not a wrong start.
      // Every limit wait that can't resume by itself waits on Joe, told until delivered (L130), never silently:
      //   - a wait that names no account (L110 m-4: the pass's own account is not necessarily the one the card hit);
      //   - a wait with no run_started (it was not parked from a run, or its claim had no readable time);
      //   - a hit after the run began with no reset time (the worker could not read it, or it was already past), or a
      //     reset more than LIMIT_RESET_MAX_MS after the hit;
      //   - a card that has waited on a limit longer than LIMIT_RESET_MAX_MS since wait.since, whatever the reading says
      //     (audit #125 r2 m-2, m-3): a reset that moves forward with each new hit, or a hit dated in the future, would
      //     otherwise hold it quietly with no end;
      //   - no hit after the run began, timeouts.usage_unknown_max_min after the card began to wait.
      const acct = doc.wait?.account;
      if (typeof acct !== 'string' || !acct) {
        // Told until delivered (L130 M12): the card is waiting on Joe from here on, so this branch never sees it again.
        askJoe(id, { what: LIMIT_NO_ACCOUNT, now, kind: 'limit_no_account', alert,
          text: `card ${id}: it waits on a usage limit but the wait does not say which account's, so it can't resume by itself; it waits on you` });
        continue;
      }
      // The same rule on run_started (#153 audit MAT-1): one in the future is as good as none.
      const runStarted = pastTime(doc.wait?.run_started, now);
      if (runStarted === null) {
        askJoe(id, { what: LIMIT_NO_RUN, now, kind: 'limit_no_run', alert,
          text: `card ${id}: it waits on account ${acct}'s usage limit but the record has no time its run began, so no limit hit can be matched to it; it waits on you` });
        continue;
      }
      const lf = sensorsFact(rec, LIMIT_FACT(acct))?.doc;
      const seen = Date.parse(lf?.observed_at ?? '');
      if (!(seen > runStarted)) {
        if (now - waitedFrom(doc, runStarted, now) > unknownMaxMs) {
          askJoe(id, { what: LIMIT_NO_HIT, now, kind: 'limit_no_hit', alert,
            text: `card ${id}: it has waited on account ${acct}'s usage limit with no limit hit recorded for its run, so it can't resume by itself; it waits on you` });
        }
        continue;
      }
      const resets = Date.parse(lf?.resets_at ?? '');
      // Measured from the hit, never from now, on purpose (audit #125 r2 c-2): when the Mini was off past the reset, the
      // first pass after still judges the reset against the hit's own time.
      if (!Number.isFinite(resets) || resets > seen + LIMIT_RESET_MAX_MS) {
        const why = Number.isFinite(resets) ? `the reset time it gave (${lf.resets_at}) is more than a week after the hit` : 'the reset time could not be read';
        askJoe(id, { what: LIMIT_NO_RESET, now, kind: 'limit_no_reset', alert,
          text: `card ${id}: account ${acct} hit its usage limit but ${why}, so it can't resume by itself; it waits on you` });
        continue;
      }
      if (now < resets) {
        if (now - waitedFrom(doc, runStarted, now) > LIMIT_RESET_MAX_MS) {
          askJoe(id, { what: LIMIT_NO_RESET, now, kind: 'limit_no_reset', alert,
            text: `card ${id}: it has waited on account ${acct}'s usage limit since ${iso(waitedFrom(doc, runStarted, now))}, longer than any real limit window, and the reset it gives (${lf.resets_at}) is still ahead, so it can't resume by itself; it waits on you` });
        }
        continue;
      }
      if (doc.tier === 2) { if (move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_limit_hit' }).ok) out.resumed.push(id); }
      // No card waits on Joe silently (L130): this one is told, until delivered.
      else askJoe(id, { what: 'limit_hit: the limit reset; Tier-1 work does not resume by itself', now, kind: 'limit_reset', alert,
        text: `card ${id}: the usage limit it waited on reset, but Tier-1 work does not resume by itself; it waits on you` });
    } else if (what === PAUSED_WAIT_WHAT) {
      // A card parked for a paused product goes back to ready once the product is no longer paused.
      if (rec.read('product', doc.product)?.doc?.state !== 'paused' && move(rec, 'card', id, { state: 'ready' }, { kind: 'resume_paused' }).ok) out.resumed.push(id);
    }
  }
  // Once per stretch of unread usage, and again each day it lasts (L38).
  const uf = factDoc(rec, UNKNOWN_FACT)?.doc;
  // Compared as text, exactly (L339 m2, L350): a start stored as a number is still this stretch's, so told daily, not
  // every pass; and a short or corrupt start ('2') is no prefix match for an old stretch's mark, so a new stretch is
  // told at once. The mark's since is written from this same value, so equal is the whole test; an empty one never matches.
  const sameStretch = uf?.since != null && String(uf.since) !== '' && String(uf.since) === String(unknownSince);
  if (unknownLong && (!sameStretch || dueToTell(uf, now, HOLD_REPEAT_MS))) {
    tellThen(alert, 'usage has been unreadable for over a day; parked work waits on you', { fact: UNKNOWN_FACT, fields: { since: unknownSince, told_at: iso(now) }, kind: 'usage_unknown_alert' });
  }

  // 6. Starts. When starts are off (no account reading, a rules value missing), undo cards still go
  // through the gate (audit 0b-6 r3 MAT-5, L31): the gate itself refuses what it cannot check.
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); }
  else {
    if (startsOff) out.notes.push(`nothing but undo cards starts: ${startsOff}`);
    await starts({ rec, rules, now, b, running, launch, stopGroup, outboxRoot, out, alert, report, failureLog, onlyUndo: !!startsOff, missing, filesOf, portDeadlineMs, host });
  }
  // The tick tells Joe once for all its steps (`tellMissing` false); run alone, the pass tells him itself.
  out.missing = missing;
  if (tellMissing) await rulesMissingAlert({ rec, keys: missing, alert, now });

  // 7. Paused products: the Lead hands off once its workers are parked.
  for (const { id: product, doc } of rec.list('product')) {
    const pf = factDoc(rec, PAUSE_FACT(product));
    if (doc.state !== 'paused') { clearCause(rec, PAUSE_FACT(product), () => { if (['asked', 'failed'].includes(pf?.doc?.state)) putFact(rec, PAUSE_FACT(product), { state: 'cleared', at: iso(now) }, 'pause_cleared', pf?.doc, TOLD); }, report); continue; }
    if (pf?.doc?.state === 'asked') continue;
    if (running.some((s) => s.product === product && parkable(s))) continue;
    // A failing port is that product's problem, told once, not a failed pass (audit 0b-6 r3 MIN-2).
    // The port's answer is read (L744 2): an ok:false is a failure, told like a throw, never counted as asked.
    const asked = await guarded(async () => { const a = await pauseLead({ product }); return a?.ok === false ? { ok: false, reason: String(a.reason || 'the port said no') } : { ok: true }; }, portDeadlineMs);
    if (!asked.ok) {
      // Once per reason (its numbers out; audit 0b-6 r5 m4), and again each day it fails (L38); told only once sent (r5 MAT-2).
      const cause = String(asked.reason).replace(/\d+/g, 'N');
      if (pf?.doc?.state !== 'failed') putFact(rec, PAUSE_FACT(product), { state: 'failed', reason: asked.reason, at: iso(now) }, 'pause_lead_failed', pf?.doc);
      if (pf?.doc?.told_cause !== cause || dueToTell(pf?.doc, now, HOLD_REPEAT_MS)) {
        tellThen(alert, `the Lead of ${product} could not be asked to hand off: ${asked.reason}; tried again every pass`, { fact: PAUSE_FACT(product), fields: { told_cause: cause, told_at: iso(now) }, kind: 'pause_lead_failed' });
      }
      continue;
    }
    clearCause(rec, PAUSE_FACT(product), () => putFact(rec, PAUSE_FACT(product), { state: 'asked', at: iso(now) }, 'pause_lead', pf?.doc, TOLD), report, { hold: false });
    out.notes.push(`Lead of ${product} asked to hand off`);
  }
  // The tick's later steps (limits, merges) gate their starts on this pass's bands and sessions.
  return { ...out, bands: b, running };
}

// Undo cards' starts, alone, before every other step (L38): the tick's own step, so a failure in the
// main pass cannot keep an undo from starting. The gate still checks each one (L40).
export async function undoStarts({ rec, rules, now, bands = HELD_BANDS, running = [], launch, stopGroup, outboxRoot, filesOf, alert, failureLog = () => {}, portDeadlineMs = PORT_DEADLINE_MS, host = hostname() }) {
  const out = { started: [], refused: [], notes: [] };
  const missing = [];
  if (factDoc(rec, OUTAGE_FACT)?.doc?.state === 'open') { out.notes.push('outage: nothing starts'); return { ...out, missing, running }; }
  const live = [...running];
  await starts({ rec, rules, now, b: bands, running: live, launch, stopGroup, outboxRoot, out, alert, report: refusalReport({ rec, alert, now, lines: out.notes, failureLog }), failureLog, onlyUndo: true, missing, filesOf, portDeadlineMs, host });
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
// A non-undo start held for a reason that clears by itself (L293, L299) is not told card by card on first sight:
//   - queueing: another card holds the slot or the files, or Tier-1 work goes first in amber; a slot frees when a run ends;
//   - the usage band, but only while the band itself is told (TOLD_BANDS, which tick.mjs's band alert reads too; L305);
//   - a product Joe paused.
// Once the oldest such card on a product has been in ready a day, Joe gets ONE alert per product and cause listing the
// held cards (and, for queueing, the cards holding the slot), then daily; a paused product weekly. Every other reason,
// a band reason with no band alert, and a daily pattern that can't be folded, is told on first sight, once per card and
// cause, then daily (L38: no silent hold).
export const TOLD_BANDS = Object.freeze(['red', 'unknown']);
export const PAUSED_REPEAT_MS = 7 * HOLD_REPEAT_MS;
// M10 is asked before the gate, so a full cap is first refused in M10's words (engine.mjs; #157 audit m2), then the gate's.
const QUEUES = [
  ['product-cap', /^the product already runs \d+ (editing worker\(s\) \(cap \d+\)|script\(s\))$|^rules: editing cap reached for \S+ \(\d+\)$/],
  ['mac-cap', /^the Mac already runs \d+ (editing workers \(cap \d+\)|scripts)$|^rules: editing cap reached on this Mac \(\d+\)$/],
  ['files', /^shares .+ with running card \S+$|^a card with no file list runs alone$|^card \S+ has no file list and runs alone$/],
  ['tier1-first', /^queued behind Tier-1 work in amber$/],
];
const BAND_REASONS = /^(the red band|usage is unknown: no Tier-1|ORCHESTRATE has used its share of the week$|no new (scripts|overnight runs) outside the green band$|no Tier-1 production work above the usage line$|rules: .*Tier 1 start needs a usage reading)/;
/** Which fold a held start's reason belongs to, or null if it is told on first sight. `band` is this pass's band. */
export function waitClass(reason, product, band) {
  if (/can't be folded/.test(reason)) return null;
  // M10 is asked first: `product is paused: no starts` (engine.mjs, a state it can't read included; #157 audit m1). The
  // gate's own words are the backstop.
  if (reason === 'rules: product is paused: no starts' || reason === `${product} is paused: only its undo starts`) return 'paused';
  const q = QUEUES.find(([, re]) => re.test(reason));
  if (q) return q[0];
  return BAND_REASONS.test(reason) && TOLD_BANDS.includes(band) ? `band-${band}` : null;
}
const FOLDS = ['paused', ...QUEUES.map(([c]) => c), ...TOLD_BANDS.map((b) => `band-${b}`)];
// Who holds the slot: a shared file names its card; Tier-1 first names the Tier-1 cards it waits behind; otherwise the
// running cards on the product, or on the Mac for a Mac cap.
function holders(reason, product, running, tier1) {
  const named = /with running card (\S+)$|^card (\S+) has no file list/.exec(reason);
  if (named) return [named[1] ?? named[2]];
  if (reason === 'queued behind Tier-1 work in amber') return tier1.get(product) ?? [];
  const on = /^the Mac |on this Mac \(/.test(reason) ? running : running.filter((s) => s.product === product);
  return on.map((s) => s.card).filter(Boolean);
}
const LIST_MAX = 10;
const listed = (ids) => ids.slice(0, LIST_MAX).join(', ') + (ids.length > LIST_MAX ? ` +${ids.length - LIST_MAX} more` : '');
function foldText(g) {
  const n = g.cards.length;
  if (g.cls === 'paused') return `${g.product} is paused; ${n} card(s) are waiting: ${listed(g.cards)}`;
  const why = [...g.why].map(([reason, ids]) => `${listed(ids)} (${reason})`).join('; ');
  const by = [...new Set(g.by)];
  const behind = !by.length ? '' : g.cls === 'tier1-first' ? `; they wait behind Tier-1 card(s) ${listed(by)}` : `; the slot is held by card(s) ${listed(by)}`;
  return `${g.product}: ${n} card(s) held from starting, the oldest for over a day: ${why}${behind}`;
}
/**
 * The one alert per product and cause for held starts (L299), on the shared still-waiting rule (L315): told once the
 * oldest held card has waited a day, again daily (a paused product weekly), and the mark cleared once nothing on that
 * product and cause has waited a day, so a return is told afresh (#157 audit m3). Run on a full pass only: a pass that
 * starts undo cards alone sees no groups and must not clear them.
 */
export const clearHold = (rec, fact, now, report) => clearCause(rec, fact, (moved) => {
  const cur = rec.read('fact', fact)?.doc;
  const was = typeof cur === 'object' ? cur : undefined;
  if (moved || (cur != null && !(typeof cur === 'object' && cur.told_at == null))) putFact(rec, fact, { ...was, told_at: null, cleared_at: iso(now) }, 'hold_cleared', was, ['told_at']);
}, report);

function tellWaits({ rec, groups, alert, now, report }) {
  let products;
  try { products = rec.list('product').map((x) => x.id); } catch { products = []; }
  const keys = new Set([...groups.keys(), ...products.flatMap((p) => FOLDS.map((c) => `${p}-${c}`))]);
  for (const key of keys) {
    const g = groups.get(key);
    const fact = HOLD_FACT(`waits-${key}`);
    stillWaiting({
      now,
      every: g?.cls === 'paused' ? PAUSED_REPEAT_MS : HOLD_REPEAT_MS,
      // A paused fold is the wait of this pause (L324 n4): a re-pause is told on its own clock, not held by the mark
      // of the last pause when no full pass ran in between to clear it (starts off, an outage).
      ...(typeof g?.pausedSince === 'string' ? { since: g.pausedSince } : {}),
      waiting: () => !!g && now - g.oldest >= HOLD_REPEAT_MS,
      read: () => factDoc(rec, fact)?.doc,
      // Marked told only once a copy is delivered (L47), as holdAlert; every field it is given is written.
      tell: (fields) => { const text = foldText(g); return tellThen(alert, text, { fact, fields: { text, ...fields }, kind: 'hold_alert' }); },
      // Called on every pass with nothing to tell (L320 m1): a queued copy is dropped, and written when a mark shows or
      // something was queued, cleared_at moving the version so a mark on its way conflicts (L449 m1, m2).
      clear: () => clearHold(rec, fact, now, report),
    });
  }
}

// Refusals whose words carry a changing detail (a session id, an error message) are one cause per card, keyed by a
// fixed class, not their text (#157 audit m5); any other is keyed by its text with the numbers out.
const FIXED_CAUSES = [['launcher', /^launcher: /], ['claim', /^not claimed: /], ['rules-error', /^rules: (could not be asked|rules error: )/]];
export const causeOf = (reason) => FIXED_CAUSES.find(([, re]) => re.test(reason))?.[0]
  ?? createHash('sha256').update(reason.replace(/\d+/g, 'N')).digest('hex').slice(0, 12);

/** Card kinds the start loop never hands to a session. */
export const NEVER_STARTED = Object.freeze(['lead_daily_card', 'research_copy']);

async function starts({ rec, rules, now, b, running, launch, stopGroup, outboxRoot, out, alert, report, failureLog, onlyUndo = false, missing = [], filesOf, portDeadlineMs = PORT_DEADLINE_MS, host = hostname() }) {
  const amberish = b.band !== 'green' || b.own_building !== 'open';
  // Undo cards first, then (in amber) Tier 1 before Tier 2, then the longest in ready, by the Record's clock.
  // The Record's own ready rule (rec.ready: unclaimed, dependencies merged, a go where one is needed; L72).
  // The Lead's own daily card is never started as a worker (audit MAT-4; M9 lets only the Lead make one). A fix
  // card stays a draft until the Lead plans it, so rec.ready never holds it. A research_copy card is never a worker's
  // either: its commit is the owner's file, copied mechanically (M4 push.mjs pushResearch, L286).
  const ready = rec.ready().filter((c) => !NEVER_STARTED.includes(c.doc.kind));
  const since = (c) => String(rec.meta?.('card', c.id)?.stateSince ?? '');
  ready.sort((x, y) => isUndo(y.doc) - isUndo(x.doc)
    || (amberish ? tierOf(x.doc) - tierOf(y.doc) : 0)
    || since(x).localeCompare(since(y)) || x.id.localeCompare(y.id));
  const tier1Waiting = new Map();
  const groups = new Map();
  for (const { id, rev, doc } of ready) {
    const card = { id, ...doc };
    const product = doc.product;
    if (onlyUndo && !isUndo(doc)) continue;
    // An undo that cannot start is the way out of a bad change: Joe is told why, once per reason and again
    // each day (audit 0b-6 r3 MAT-5). The reason counts with its numbers out, so "runs 2 workers" and
    // "runs 3 workers" are one cause (audit 0b-6 r4).
    // `toldElsewhere`: a missing or unreadable rules value, which the missing-values alert tells once for the tick.
    const refuse = (reason, toldElsewhere = false) => {
      out.refused.push([id, reason]);
      if (!isUndo(doc)) {
        if (toldElsewhere) return;
        const cls = waitClass(reason, product, b?.band);
        if (cls === null) {
          holdAlert({ rec, cause: `start-${id}-${causeOf(reason)}`, text: `card ${id} can't start: ${reason}`, alert, now });
          return;
        }
        // Folded per product and cause; the clock is the oldest ready time, the Record's, so nothing is written per pass.
        // A ready time that can't be read, or more than 60 s ahead of now, counts as a day old: told, never held in
        // silence (shared pastTime; #157 audit MAT-1). A paused card counts from the later of the pause and its ready
        // time (#157 audit m3): a pause over cards long in ready is told a day after the pause, not at once.
        const key = `${product}-${cls}`;
        const g = groups.get(key) ?? { product, cls, why: new Map(), cards: [], by: [], oldest: Infinity };
        let t = pastTime(since({ id }), now) ?? -Infinity;
        if (cls === 'paused') {
          const paused = rec.meta?.('product', product)?.stateSince;
          t = Math.max(t, pastTime(paused, now) ?? -Infinity);
          if (typeof paused === 'string') g.pausedSince = paused;
        }
        g.oldest = Math.min(g.oldest, t);
        g.cards.push(id);
        g.why.set(reason, [...(g.why.get(reason) ?? []), id]);
        if (QUEUES.some(([c]) => c === cls)) g.by.push(...holders(reason, product, running, tier1Waiting));
        groups.set(key, g);
        return;
      }
      const held = factDoc(rec, UNDO_HELD_FACT(id))?.doc;
      const cause = reason.replace(/\d+/g, 'N');
      if (held?.told_cause !== cause || dueToTell(held, now, HOLD_REPEAT_MS)) {
        tellThen(alert, `your undo (card ${id}) is waiting: ${reason}`, { fact: UNDO_HELD_FACT(id), fields: { reason, told_cause: cause, told_at: iso(now) }, kind: 'undo_held' });
      }
    };
    let may;
    // M10's start_session reads product, role, tier (1 or 2), editing and, for Tier 1, the usage reading's time
    // (L81 sweep: asked with the card alone, the real engine refused every start). The tier is the one the start
    // gate holds on (riskOf: the card's and the files' stricter); the role is the M10 profile the card runs.
    try {
      may = rules.may('start_session', { product, card, role: startRole(kindOf(doc)), tier: riskOf(rules, card).tier, editing: true, ...(b?.read_at ? { usage: { read_at: b.read_at } } : {}) });
    } catch (e) { may = { decision: 'refuse', reason: `could not be asked (${e?.message ?? e})` }; }
    if (may.decision !== 'allow') { await refuse(`rules: ${may.reason}`); continue; }
    if (amberish && tierOf(doc) === 2 && tier1Waiting.has(product)) { await refuse('queued behind Tier-1 work in amber'); continue; }
    const kind = kindOf(doc);
    // An undo starts only as the exact reverse of a merge in the record (LEAD-CALLS L40).
    const exact = kind === 'undo' ? exactReverse({ rec, card, filesOf }) : null;
    if (exact && !exact.ok) { await refuse(`it is not an exact reverse: ${exact.reason}`); continue; }
    const g = startGate({ rules, rec, card, kind, product, b, running, exactReverse: !!exact?.ok });
    if (g.missing) missing.push(g.missing);
    if (!g.ok) { if (amberish && tierOf(doc) === 1 && capRefusal(g.reason)) tier1Waiting.set(product, [...(tier1Waiting.get(product) ?? []), id]); await refuse(g.reason, !!g.missing); continue; }
    // The claim names the session before it starts (L72): the launcher starts claude with this id, so a second start
    // can't take the card. The Record stamps claimed_at; rules_rev is the rules the claim was made under.
    const sessionId = randomUUID();
    const rulesRev = may.rev ?? rules.rev;
    const claimDoc = { kind: 'session', session_id: sessionId, host, ...(machineId() == null ? {} : { machine: machineId() }), ...(rulesRev != null ? { rules_rev: rulesRev } : {}) };
    const claim = rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: rev, doc: { ...doc, state: 'claimed', claim: claimDoc }, kind: 'claim' });
    if (!claim.ok) { await refuse(`not claimed: ${claim.reason}`); continue; }
    // A launch has its own time limit (audit 0b-6 r5 m1): one that never answers holds no other start.
    // It may still start a session after the limit, so the card stays claimed, never back to ready (a
    // second start would make two sessions for one card); Joe is told, once a day.
    const l = await guarded(() => launch({ card, kind, product, sessionId }), portDeadlineMs);
    // Late is any answer marked timed out (guarded's own, or a port's), not only guarded's exact words (L744 1).
    if (!l?.ok && (l?.timedOut === true || l?.reason === `it did not answer within ${portDeadlineMs} ms`)) {
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
    // A worker with the wrong outbox, or none, can hand in nothing that is its own, so it does not run (#219 audit M-1,
    // m-1): the session is stopped, and only then is the claim given back, since a session that may still be running
    // must keep its card claimed or a second one would start.
    // Under the role the session runs (L767: a script card's outbox is <root>/script/<id>).
    const outboxWrong = workerOutboxProblem(l.outbox, sessionId, { root: outboxRoot, role: startRole(kind) });
    if (outboxWrong) {
      const stopped = await guarded((signal) => stopGroup({ id: sessionId, product, kind, card: id, pgid: l.pgid, signin: l.signin ?? null, config_dir: l.configDir ?? null }, { signal }), portDeadlineMs);
      const back = stopped?.ok ? rec.release({ card: id, session_id: sessionId, reason: `launcher: its outbox ${outboxWrong}` }) : null;
      const then = !stopped?.ok ? `it could not be stopped (${stopped?.reason ?? 'no answer'}), so the card stays claimed and cannot start twice; it lapses at claims.unlaunched_min once its session is stopped`
        : !back?.ok ? `it was stopped, but its claim could not be given back (${back?.reason ?? 'no answer'}); it lapses at claims.unlaunched_min`
          : 'it was stopped and the card went back to ready';
      out.refused.push([id, `launcher: its outbox ${outboxWrong}`]);
      holdAlert({ rec, cause: SESSION_OUTBOX_CAUSE(id), text: `card ${id}: session ${sessionId} was refused: the outbox its launcher named ${outboxWrong}; ${then}`, alert, now });
      continue;
    }
    clearHold(rec, HOLD_FACT(SESSION_OUTBOX_CAUSE(id)), now, report);
    // claimed -> running adds the process (pid and its start time) to the claim, and nothing else.
    const started = move(rec, 'card', id, { state: 'running', claim: { ...rec.read('card', id)?.doc?.claim, pid: l.pid, pid_start: l.pidStart } }, { kind: 'started' });
    if (!started.ok) holdAlert({ rec, cause: `started-${id}`, text: `card ${id}: session ${sessionId} started but the card could not be marked running (${started.reason})`, alert, now });
    // The launch record (R-0b-55, D12): the Merge Gate merges only a head made by a session it names
    // (refusal 5). `head` is the commit the copy started from; `base` the commit the launcher chose to start it on (L825-2:
    // a Tier 1 card's main_commit, else the mirror's main; null when the launch port does not say); `rev` the card's rev once running; `signin` and
    // `config_dir` the sign-in folder the session started in (R-1-89; null when the launch port does not say); `copy` the
    // worker's copy folder, which cleanup checks it deletes (null when the port does not say).
    // role 'worker' for script cards too (L759): they change files, and the Merge Gate's workerLaunches reads 'worker'.
    const lr = writeLaunch(rec, { sessionId, role: 'worker', kind, card: id, head: l.head, base: l.base, rev: started.rev, product, signin: l.signin, configDir: l.configDir, copy: l.copy, now });
    // A notice only: the merge refusal catches it later; a lost one is in the pass's notes (L130 m4).
    if (!lr.ok && alert(`card ${id}: session ${sessionId} started but its launch was not recorded (${lr.reason}); its merge will be refused`) === false) { out.notes.push(`card ${id}: the launch-not-recorded alert could not be queued`); failureLog(`card ${id}: the launch-not-recorded alert could not be queued`); }
    // The session record (L204-a). M4's push script takes its inputs from it alone (product, card, branch, outbox,
    // attempt), M9's claim break reads its process, and M2 its state. The Dispatcher makes it in preparing (M9: only
    // the Dispatcher makes one, and the workshop moves it on). `attempt` counts this card's sessions, so each start's
    // push has its own record line. With no record the work can never be pushed: the owner is told.
    const attempt = `a${rec.list('session').filter((s) => s.doc?.card === id).length + 1}`;
    const sr = rec.write({ actor: 'dispatcher', entity: 'session', id: sessionId, expectRev: 0, kind: 'session',
      doc: { state: 'preparing', role: 'worker', product: product ?? null, card: id, branch: cardBranch(id), outbox: l.outbox, attempt, host, pid: l.pid ?? null, pid_start: l.pidStart ?? null, launched_at: iso(now) } });
    if (sr.ok) clearHold(rec, HOLD_FACT(SESSION_RECORD_CAUSE(id)), now, report);
    else holdAlert({ rec, cause: SESSION_RECORD_CAUSE(id), text: `card ${id}: session ${sessionId} started, but its session record was not written (${sr.reason}), so its work cannot be pushed`, alert, now });
    running.push({ id: sessionId, product, kind, card: id, pgid: l.pgid, signin: l.signin ?? null, config_dir: l.configDir ?? null });
    // Whether or not the hold was told: an alert still queued for it leaves unsent (audit 0b-6 r8 MAT-1).
    clearCause(rec, UNDO_HELD_FACT(id), () => {
      const held = factDoc(rec, UNDO_HELD_FACT(id))?.doc;
      if (held?.reason) putFact(rec, UNDO_HELD_FACT(id), { reason: null, at: iso(now) }, 'undo_started', held, ['reason', ...TOLD]);
    }, report, { hold: false });
    out.started.push(id);
  }
  if (!onlyUndo) tellWaits({ rec, groups, alert, now, report });
}
