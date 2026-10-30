// One full Dispatcher pass: every step, in one fixed order (audit 0b-6 MAT-1, MIN-8; rows 55–60, 63, 64).
//
// The login job runs `main.mjs` every 60 s, which takes the single-instance lock and calls `tick()`.
// The order, and why:
//   1. outage    — first, so a pass during an outage starts nothing and restarts nothing (R-0b-56).
//                  Outside an outage its answer is acted on here: a dead session's card that is safe to
//                  re-run goes back to `ready` (the starts below pick it up); any other waits on Joe.
//   2. intake    — outbox files, so the record is current before anything is decided on it (R-0b-56, 58).
//   3. leads     — the Lead restart from its handoff (R-0b-63), after the intake applied the handoff.
//   4. pass      — stops, parks, resumes and starts (R-0b-55, 59, 64, 67).
//   5. limits    — time limits and reviewer starts, through the start gate (R-0b-57, 67).
//   6. merges    — merge requests for reviewed changes, through the start gate (R-0b-67, 68).
//   7. undo      — undo taps into undo cards (R-0b-68).
//   8. phone     — network, phone link, Front Door and Mini Base (R-0b-60).
//   9. cleanup   — last, because it is the slowest (R-0b-57).
// Each step runs in its own try/catch: one failing step never stops the rest. A failing step alerts
// Joe once per distinct error (fact `step-error-<step>`), cleared when the step next succeeds. The
// fact `last-full-pass` records when every step last ran and how each ended.
//
// The signed-in account comes from the record fact `signed-in-account` { account, observed_at }
// (Sensors, lane 3). Missing, or older than usage.stale_after_min, means nothing new starts.

import { KEYS, minutes } from './keys.mjs';
import { outageStep } from './outage.mjs';
import { intakePass } from './outbox-intake.mjs';
import { leadRestartStep, leadInFlight, handoffVet } from './lead-restart.mjs';
import { dispatcherPass } from './pass.mjs';
import { startGate } from './gate.mjs';
import { currentBands } from './usage.mjs';
import { timeLimits, requestMerges } from './merges.mjs';
import { undoStep } from './undo.mjs';
import { phoneLinkStep } from './phone-link.mjs';
import { cleanupPass } from './cleanup.mjs';
import { move, waitOn, note } from './moves.mjs';
import { takePassLock } from './pass-lock.mjs';

export const STEPS = Object.freeze(['outage', 'intake', 'leads', 'pass', 'limits', 'merges', 'undo', 'phone', 'cleanup']);
export const ACCOUNT_FACT = 'signed-in-account';
export const LAST_PASS_FACT = 'last-full-pass';
export const STEP_ERROR_FACT = (step) => `step-error-${step}`;
const iso = (ms) => new Date(ms).toISOString();
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

/** The signed-in account, or a reason nothing may start (audit MIN-9). */
export function signedInAccount({ rec, rules, now }) {
  const d = rec.read('fact', ACCOUNT_FACT)?.doc;
  if (!d?.account || typeof d.account !== 'string') return { account: null, reason: 'the signed-in account is not known' };
  let staleMs;
  try { staleMs = minutes(rules, KEYS.staleAfterMin); } catch { return { account: null, reason: `the rules have no value for ${KEYS.staleAfterMin}` }; }
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
 * One full pass. `ports` holds every outside effect (see README, "The tick's ports"); each step reads
 * only the ports it needs. Returns { steps: { name: { ok, result | error } } }.
 */
export async function tick({ rec, rules, now, ports: p }) {
  const res = {};
  const alert = p.alert;
  let bands = null;
  let running = [];
  const run = async (step, f) => {
    try {
      res[step] = { ok: true, result: await f() };
      if (rec.read('fact', STEP_ERROR_FACT(step))?.doc?.error) putFact(rec, STEP_ERROR_FACT(step), { error: null, at: iso(now) }, 'step_ok');
    } catch (e) {
      const error = String(e?.message ?? e);
      res[step] = { ok: false, error };
      if (rec.read('fact', STEP_ERROR_FACT(step))?.doc?.error !== error) {
        putFact(rec, STEP_ERROR_FACT(step), { error, at: iso(now) }, 'step_error');
        alert(`the Dispatcher's ${step} step failed: ${error}; the other steps still ran`);
      }
    }
  };

  let outageOpen = false;
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
    const acct = signedInAccount({ rec, rules, now });
    const r = await dispatcherPass({ rec, rules, now, account: acct.account, sessions: p.sessions(), probe: p.probe, launch: p.launch, stopGroup: p.stopGroup,
      saveWork: p.saveWork, hostLock: p.hostLock, pauseLead: p.pauseLead, alert, startsOff: acct.reason });
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
    hasReviewer: p.hasReviewer, startReviewer: p.startReviewer, alert, startsHeld }));
  await run('merges', () => requestMerges({ rec, rules, now, b: bands ?? held, running, startsHeld }));
  await run('undo', () => undoStep({ rec, rules, now, filesOf: p.filesOf, alert }));
  await run('phone', () => phoneLinkStep({ rec, rules, now, send: p.sendFrontDoor, restartFrontDoor: p.restartFrontDoor, startMinibase: p.startMinibase,
    frontDoorAlive: p.frontDoorAlive, lastHandoff: p.frontDoorHandoff, alert }));
  await run('cleanup', () => cleanupPass({ rec, rules, now, ...p.cleanup, alert }));

  putFact(rec, LAST_PASS_FACT, { at: iso(now), steps: Object.fromEntries(STEPS.map((s) => [s, res[s]?.ok ? 'ok' : 'failed'])) }, 'full_pass');
  return { steps: res };
}

/** The login job's entry: one full pass under the single-instance lock (M16). */
export async function runTick({ lockFile, lock = takePassLock, ...args }) {
  const l = lock(lockFile, { now: args.now });
  if (!l.ok) {
    note(args.rec, 'pass-lock-note', `a pass did not run: ${l.reason}`, { now: args.now });
    return { ran: false, reason: l.reason };
  }
  try { return { ran: true, ...(await tick(args)) }; } finally { l.release(); }
}
