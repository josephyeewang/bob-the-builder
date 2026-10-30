// One full Dispatcher pass: every step, in one fixed order (audit 0b-6 MAT-1, MIN-8; rows 55–60, 63, 64).
//
// The login job runs `main.mjs` every 60 s, which takes the single-instance lock and calls `tick()`.
// The order, and why:
//   0. stops, undo, undo-starts — the safety acts first and alone, each in its own step (LEAD-CALLS L38):
//                  cancels and parks, undo taps into undo cards, and undo cards' starts. No other step's
//                  failure (an unreadable file, a bad rule) can skip them. An undo starts only as the
//                  exact reverse of a merge in the record (L40).
//   1. outage    — first, so a pass during an outage starts nothing and restarts nothing (R-0b-56).
//                  Outside an outage its answer is acted on here: a dead session's card that is safe to
//                  re-run goes back to `ready` (the starts below pick it up); any other waits on Joe.
//   2. intake    — outbox files, so the record is current before anything is decided on it (R-0b-56, 58).
//   3. leads     — the Lead restart from its handoff (R-0b-63), after the intake applied the handoff.
//   4. pass      — resumes and starts (R-0b-55, 59, 64, 67), on the stops step's bands and sessions.
//   5. limits    — time limits and reviewer starts, through the start gate (R-0b-57, 67).
//   6. merges    — merge requests for reviewed changes, through the start gate (R-0b-67, 68).
//   8. phone     — network, phone link, Front Door and Mini Base (R-0b-60).
//   9. cleanup   — last, because it is the slowest (R-0b-57).
// Each step runs in its own try/catch: one failing step never stops the rest. A failing step alerts
// Joe once per distinct error and again each day it lasts (fact `step-error-<step>`), cleared when the step next succeeds. The
// fact `last-full-pass` records when every step last ran and how each ended. Each step also has a
// deadline (STEP_DEADLINE_MS, or the port `stepDeadlineMs`): a port that never answers fails its
// step, and the later steps still run (audit 0b-6 r3 MAT-2). `main.mjs` bounds the whole run.
// A rules value missing in any step (the main pass, or the start gate asked by the limits, the merges
// or a read-only helper) is told to Joe once, for the whole tick, on the fact `rules-missing-alert`
// (audit 0b-6 r3 MAT-3).
// No silent hold (L38): a missing or stale account reading, or a red or unknown usage band, is told to
// Joe once per cause per day (pass.mjs `holdAlert`); a held undo, once per reason per day.
//
// The signed-in account comes from the record fact `signed-in-account` { account, observed_at }
// (Sensors, lane 3). Missing, or older than usage.stale_after_min, means nothing new starts.

import { KEYS, minutes } from './keys.mjs';
import { outageStep, OUTAGE_FACT } from './outage.mjs';
import { intakePass } from './outbox-intake.mjs';
import { leadRestartStep, leadInFlight, handoffVet } from './lead-restart.mjs';
import { dispatcherPass, stopPass, undoStarts, rulesMissingAlert, holdAlert, HELD_BANDS, HOLD_REPEAT_MS } from './pass.mjs';
import { startGate } from './gate.mjs';
import { currentBands } from './usage.mjs';
import { timeLimits, requestMerges } from './merges.mjs';
import { undoStep } from './undo.mjs';
import { phoneLinkStep } from './phone-link.mjs';
import { cleanupPass } from './cleanup.mjs';
import { move, waitOn, note } from './moves.mjs';
import { takePassLock } from './pass-lock.mjs';

export const STEPS = Object.freeze(['stops', 'undo', 'undo-starts', 'outage', 'intake', 'leads', 'pass', 'limits', 'merges', 'phone', 'cleanup']);
export const ACCOUNT_FACT = 'signed-in-account';
export const LAST_PASS_FACT = 'last-full-pass';
export const STEP_ERROR_FACT = (step) => `step-error-${step}`;
export const STEP_DEADLINE_MS = 120_000;
const iso = (ms) => new Date(ms).toISOString();
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

/** The signed-in account, or a reason nothing may start (audit MIN-9). */
export function signedInAccount({ rec, rules, now }) {
  const d = rec.read('fact', ACCOUNT_FACT)?.doc;
  if (!d?.account || typeof d.account !== 'string') return { account: null, reason: 'the signed-in account is not known' };
  let staleMs;
  try { staleMs = minutes(rules, KEYS.staleAfterMin); } catch { return { account: null, reason: `the rules have no value for ${KEYS.staleAfterMin}`, missing: KEYS.staleAfterMin }; }
  const seen = Date.parse(d.observed_at ?? '');
  if (!Number.isFinite(seen) || seen > now + 60_000 || now - seen > staleMs) return { account: null, reason: 'the signed-in account reading is stale' };
  return { account: d.account, reason: null };
}

/** Acts on the outage step's answer (M10): safe cards go back to ready; any other card waits on Joe. */
export function actOnDead({ rec, now, restart, asks, cards = {} }) {
  const done = [];
  for (const sid of restart) {
    const cardId = cards[sid];
    const cur = cardId ? rec.read('card', cardId) : null;
    if (!cur || !['running', 'claimed'].includes(cur.doc.state)) continue;
    if (move(rec, 'card', cardId, { state: 'ready', session: null, restarted_from: sid }, { now, kind: 'dead_restart' }).ok) done.push([cardId, 'ready again']);
  }
  for (const cardId of asks) {
    const cur = rec.read('card', cardId);
    if (!cur || !['running', 'claimed'].includes(cur.doc.state)) continue;
    if (waitOn(rec, cardId, { who: 'joe', what: 'dead_session: its session stopped and the card is not marked safe to re-run', now, link: `card ${cardId}`, kind: 'dead_ask' }).ok) done.push([cardId, 'waiting on Joe']);
  }
  return done;
}

/**
 * The alert port as every step gets it (audit 0b-6 r4 MAT-2): an alert that throws or rejects never
 * fails a step, or skips the steps after it. An alert that fails is not lost (audit 0b-6 r5 MAT-2): its
 * text goes on the fact `alert-unsent`, and the next pass sends it again before its steps run
 * (`resendAlerts`), until it goes through. So a step that marks a cause "told" before its alert fails
 * still tells Joe, a pass later. The queue keeps at most ALERT_QUEUE_MAX texts, the newest; the oldest
 * dropped are counted in the next text sent.
 */
export const ALERT_QUEUE_FACT = 'alert-unsent';
export const ALERT_QUEUE_MAX = 50;
function queueAlert(rec, text, e, now) {
  try {
    const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
    const all = [...(Array.isArray(d.texts) ? d.texts : []).filter((t) => t !== text), text];
    const over = Math.max(0, all.length - ALERT_QUEUE_MAX);
    putFact(rec, ALERT_QUEUE_FACT, { texts: all.slice(over), dropped: (d.dropped ?? 0) + over, error: String(e?.message ?? e), at: iso(now) }, 'alert_failed');
  } catch { /* the record is unwritable too: the pass itself fails and tells */ }
}
export function safeAlert(rec, alert, now) {
  return (text) => {
    const failed = (e) => queueAlert(rec, text, e, now);
    try { const r = alert(text); if (typeof r?.then === 'function') r.then(null, failed); } catch (e) { failed(e); }
  };
}

/** Sends again every alert a past pass could not send (see `safeAlert`); one that fails again stays queued. */
export function resendAlerts(rec, alert, now) {
  const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc;
  const texts = Array.isArray(d?.texts) ? d.texts : [];
  if (!texts.length) return 0;
  putFact(rec, ALERT_QUEUE_FACT, { texts: [], dropped: 0, error: null, at: iso(now) }, 'alert_resent');
  const send = safeAlert(rec, alert, now);
  texts.forEach((t, i) => send(i === 0 && d.dropped ? `${t} (${d.dropped} older alerts could not be sent and were dropped)` : t));
  return texts.length;
}

/**
 * One full pass. `ports` holds every outside effect (see README, "The tick's ports"); each step reads
 * only the ports it needs. Returns { steps: { name: { ok, result | error } } }.
 */
export async function tick({ rec, rules, now, ports: p }) {
  const res = {};
  const alert = safeAlert(rec, p.alert, now);
  let bands = null;
  let running = [];
  const deadline = p.stepDeadlineMs ?? STEP_DEADLINE_MS;
  // A time limit on each stop, save and Lead hand-off call; the defaults are pass.mjs's.
  const portDeadlines = Object.fromEntries([['portDeadlineMs', p.portDeadlineMs], ['saveDeadlineMs', p.saveDeadlineMs]].filter(([, v]) => v !== undefined));
  const run = async (step, f) => {
    let timer;
    try {
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`it did not finish within ${deadline} ms`)), deadline); });
      res[step] = { ok: true, result: await Promise.race([Promise.resolve().then(f), late]) };
      if (rec.read('fact', STEP_ERROR_FACT(step))?.doc?.error) putFact(rec, STEP_ERROR_FACT(step), { error: null, at: iso(now) }, 'step_ok');
    } catch (e) {
      const error = String(e?.message ?? e);
      res[step] = { ok: false, error };
      const seen = rec.read('fact', STEP_ERROR_FACT(step))?.doc;
      // Once per distinct error, and again each day it lasts (L38: no silent hold).
      if (seen?.error !== error || !(now - Date.parse(seen?.at ?? '') < HOLD_REPEAT_MS)) {
        putFact(rec, STEP_ERROR_FACT(step), { error, at: iso(now) }, 'step_error');
        alert(`the Dispatcher's ${step} step failed: ${error}; the other steps still ran`);
      }
    } finally { clearTimeout(timer); }
  };
  // Rules values missing anywhere this tick: told once, at the end.
  const missing = [];
  let acct;
  try { acct = signedInAccount({ rec, rules, now }); } catch (e) { acct = { account: null, reason: `the signed-in account could not be read (${e?.message ?? e})` }; }
  if (acct.missing) missing.push(acct.missing);

  // The safety acts, first and alone (L38).
  let stops = null;
  await run('stops', async () => {
    stops = await stopPass({ rec, rules, now, account: acct.account, sessions: p.sessions(), probe: p.probe, stopGroup: p.stopGroup, saveWork: p.saveWork, alert, ...portDeadlines });
    missing.push(...stops.missing);
    return stops;
  });
  await run('undo', () => undoStep({ rec, rules, now, filesOf: p.filesOf, alert }));
  await run('undo-starts', async () => {
    const r = await undoStarts({ rec, rules, now, bands: stops?.bands ?? HELD_BANDS, running: stops?.running ?? p.sessions(), launch: p.launch, filesOf: p.filesOf, alert });
    missing.push(...r.missing);
    if (stops) stops.running = r.running;
    return { started: r.started, refused: r.refused, notes: r.notes };
  });

  // Alerts a past pass could not send go out now, after the safety acts (audit 0b-6 r5 MAT-2).
  try { resendAlerts(rec, p.alert, now); } catch { /* the record is unreadable: the steps below fail and tell */ }
  let outageOpen = false;
  // A failing outage step falls back on the record (audit 0b-6 r3 MIN-1): an open outage still holds.
  try { outageOpen = rec.read('fact', OUTAGE_FACT)?.doc?.state === 'open'; } catch { outageOpen = true; }
  await run('outage', async () => {
    const board = p.board();
    const o = outageStep({ rec, rules, board, now, healthy: p.healthy(), resume: p.resume?.() ?? false, alert });
    outageOpen = o.outage;
    return { ...o, acted: o.outage ? [] : actOnDead({ rec, now, restart: o.restart, asks: o.asks, cards: o.cards }) };
  });
  // A Lead's read-only helper goes through the one start gate (audit 0b-6 r2 MAT-2): the red band, the
  // read-only cap per Lead and an outage hold it here, whatever the wiring port does.
  const startReadonly = async (x) => {
    if (outageOpen) return { ok: false, reason: 'outage: nothing starts' };
    const acct = signedInAccount({ rec, rules, now });
    if (!acct.account) return { ok: false, reason: acct.reason };
    const g = startGate({ rules, rec, card: null, kind: 'readonly', product: x.product, b: currentBands({ rec, rules, account: acct.account, now }), running: p.sessions(), lead: x.lead });
    if (!g.ok && g.missing) missing.push(g.missing);
    return g.ok ? p.startReadonly(x) : { ok: false, reason: g.reason };
  };
  await run('intake', () => intakePass({ rec, now, sessions: p.outboxSessions(), wait: p.wait, alert, note: (text) => note(rec, 'intake-note', text, { now }),
    startReadonly, replyToLead: p.replyToLead, vet: handoffVet(rules), ...(p.intakeFs ?? {}) }));
  // During an outage no WRAP is sent and no new Lead starts (audit 0b-6 r2 MIN-6).
  await run('leads', async () => {
    if (outageOpen) return 'outage: the Lead step waits';
    const out = [];
    for (const l of p.leads()) {
      const inFlight = leadInFlight({ rec, sessionId: l.lead.sessionId, outboxNames: l.outboxNames, questionOpen: l.questionOpen });
      out.push([l.lead.sessionId, await leadRestartStep({ rec, rules, now, lead: l.lead, size: l.size, inFlight, send: l.send, stopSession: l.stopSession, startLead: l.startLead, alert })]);
    }
    return out;
  });
  await run('pass', async () => {
    const r = await dispatcherPass({ rec, rules, now, account: acct.account, sessions: p.sessions(), probe: p.probe, launch: p.launch, stopGroup: p.stopGroup,
      saveWork: p.saveWork, hostLock: p.hostLock, pauseLead: p.pauseLead, filesOf: p.filesOf, alert, startsOff: acct.reason, tellMissing: false, stops, ...portDeadlines });
    missing.push(...r.missing);
    bands = r.bands;
    running = r.running;
    return r;
  });
  // Without this pass's bands nothing the bands gate is started or requested (fail closed, audit 0b-6
  // r2 MIN-4): "unknown" would still let reviews and merges through while the real band may be red.
  // The time limits themselves still run.
  const held = { band: 'unknown', own_building: 'unknown', pace: null, prodBlocked: true, reason: 'the main pass did not finish' };
  const startsHeld = outageOpen ? 'outage' : bands ? null : 'the main pass did not finish';
  await run('limits', () => timeLimits({ rec, rules, now, b: bands ?? held, running, hasSession: p.hasSession, gateAlive: p.gateAlive,
    hasReviewer: p.hasReviewer, startReviewer: p.startReviewer, alert, startsHeld, missing }));
  await run('merges', () => requestMerges({ rec, rules, now, b: bands ?? held, running, startsHeld, missing }));
  // A step that failed did not report what it lacked, so nothing already told is dropped this tick.
  const complete = ['stops', 'undo-starts', 'pass', 'limits', 'merges'].every((s) => res[s]?.ok);
  try { rulesMissingAlert({ rec, keys: missing, alert, now, complete }); } catch (e) { alert(`the Dispatcher could not record missing rules values: ${e?.message ?? e}`); }
  // No silent hold (L38). The band is not told while the account is unknown: that hold is the account's.
  try {
    // A missing rules value is told by the missing-values alert, not twice.
    if (acct.reason && !acct.missing) holdAlert({ rec, cause: 'account', text: `nothing new starts but undo cards: ${acct.reason}`, alert, now });
    const band = stops?.bands ?? bands;
    if (!acct.reason && band && ['red', 'unknown'].includes(band.band)) {
      holdAlert({ rec, cause: `band-${band.band}`, text: `the usage band is ${band.band}${band.reason ? ` (${band.reason})` : ''}: work it holds waits; stops and undo still run`, alert, now });
    }
  } catch (e) { alert(`the Dispatcher could not record a hold: ${e?.message ?? e}`); }
  await run('phone', () => phoneLinkStep({ rec, rules, now, send: p.sendFrontDoor, restartFrontDoor: p.restartFrontDoor, startMinibase: p.startMinibase,
    frontDoorAlive: p.frontDoorAlive, lastHandoff: p.frontDoorHandoff, alert }));
  await run('cleanup', () => cleanupPass({ rec, rules, now, ...p.cleanup, alert }));

  putFact(rec, LAST_PASS_FACT, { at: iso(now), steps: Object.fromEntries(STEPS.map((s) => [s, res[s]?.ok ? 'ok' : 'failed'])) }, 'full_pass');
  return { steps: res };
}

/** The login job's entry: one full pass under the single-instance lock (M16). */
export async function runTick({ lockFile, lock = takePassLock, ...args }) {
  const l = lock(lockFile, { now: args.now });
  // A lock left by a dead pass: the last run was killed (the run deadline, the watchdog in main.mjs, a
  // crash) before it finished. Joe is told, once a day (L38); this pass runs as usual.
  if (l.ok && l.broke) {
    try { holdAlert({ rec: args.rec, cause: 'run-late', text: `the last Dispatcher pass (taken ${l.broke.taken_at ?? 'at an unknown time'}) was stopped before it finished; this pass runs as usual`, alert: safeAlert(args.rec, args.ports.alert, args.now), now: args.now }); }
    catch { /* the record is unwritable: the pass itself will fail and tell */ }
  }
  if (!l.ok) {
    note(args.rec, 'pass-lock-note', `a pass did not run: ${l.reason}`, { now: args.now });
    return { ran: false, reason: l.reason };
  }
  try { return { ran: true, ...(await tick(args)) }; } finally { l.release(); }
}
