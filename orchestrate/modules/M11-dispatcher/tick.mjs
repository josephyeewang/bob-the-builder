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
//                  re-run has its claim broken by the Record (breakIfDead: back to `ready`, the starts below
//                  pick it up); any other waits on Joe. Then the Record lapses claims whose session never
//                  started (lapseClaims, claims.unlaunched_min), once that session id is stopped (L72).
//   2. intake    — outbox files, so the record is current before anything is decided on it (R-0b-56, 58).
//   3. leads     — the Lead restart from its handoff (R-0b-63), after the intake applied the handoff.
//      approvals — M2's schedule pass per product (L221 MAT-1): run-outs, pushes, and a product record made when its
//                  rules file turns it on, before the pass so that product can start this tick. Outage or not.
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

import { tellRefused, watchWrites } from './refused-writes.mjs';
import { KEYS, minutes, need, MissingKey, missingFor } from './keys.mjs';
import { sensorsFact } from './sensor-facts.mjs';
import { outageStep, OUTAGE_FACT } from './outage.mjs';
import { intakePass } from './outbox-intake.mjs';
import { leadRestartStep, leadInFlight, handoffVet } from './lead-restart.mjs';
import { dispatcherPass, stopPass, undoStarts, rulesMissingAlert, holdAlert, HELD_BANDS, HOLD_REPEAT_MS, TOLD_BANDS } from './pass.mjs';
import { startGate } from './gate.mjs';
import { currentBands } from './usage.mjs';
import { timeLimits, requestMerges } from './merges.mjs';
import { undoStep } from './undo.mjs';
import { phoneLinkStep } from './phone-link.mjs';
import { cleanupPass } from './cleanup.mjs';
import { move, note } from './moves.mjs';
import { waitOnJoe, retellWaits } from './joe-waits.mjs';
import { outbox, tellThen, sendAlerts, dropCause } from './alerts.mjs';
import { takePassLock } from './pass-lock.mjs';
import { dueToTell } from '../../shared/still-waiting.mjs';
import { schedulePass } from '../M2-approvals/schedule.mjs';

export const STEPS = Object.freeze(['stops', 'undo', 'undo-starts', 'outage', 'intake', 'leads', 'approvals', 'pass', 'limits', 'merges', 'waits', 'phone', 'cleanup']);
// One product's Approvals pass gets this long (or the port `approvalsProductMs`); a hung one counts as failed and the
// next product still runs (L221, lane 2's ask 2). The step's own deadline still bounds them all.
export const APPROVALS_PRODUCT_MS = 30_000;

// M2's alerts are objects ({ type, ... }); the tick's outbox takes one line of text. The line is built from known
// fields only, so nothing else an alert carries (a GitHub answer, a token) reaches Joe's phone; a type this list does
// not know still becomes a line, never dropped (L221, lane 2's ask 5). Outbox's false ("not queued") is passed back,
// so M2's `=== false` checks (configAlert, the onboard notices) keep working.
const ALERT_FIELDS = [['ask', 'ask'], ['card', 'card'], ['session', 'session'], ['kind', 'kind'], ['pr', 'PR']];
const plain = (v, n = 200) => String(v).replace(/[\r\n\t]+/g, ' ').slice(0, n);
/** The outbox `alert` handed to one product's approvals pass: its alerts, as text, into the step's own outbox. */
export function approvalsAlerts(alert, product) { return (a) => alert(approvalsAlertText(product, a)); }
export function approvalsAlertText(product, a) {
  if (typeof a === 'string') return `Approvals, ${plain(product, 80)}: ${plain(a, 400)}`;
  if (typeof a?.text === 'string') return plain(a.text, 400);
  const type = typeof a?.type === 'string' && /^[a-z_]{1,60}$/.test(a.type) ? a.type.replace(/_/g, ' ') : 'an alert of an unknown type';
  const parts = ALERT_FIELDS.filter(([k]) => ['string', 'number'].includes(typeof a?.[k])).map(([k, label]) => `${label} ${plain(a[k], 80)}`);
  if (Array.isArray(a?.items)) parts.push(`${a.items.length} item${a.items.length === 1 ? '' : 's'}`);
  const reason = typeof a?.reason === 'string' ? `: ${plain(a.reason)}` : '';
  return `Approvals, ${plain(product, 80)}: ${type}${parts.length ? ` (${parts.join(', ')})` : ''}${reason}`;
}

/**
 * The approvals step: M2's schedule pass (schedule.mjs) for each product the port `approvals()` lists, one at a time,
 * each with its own deadline and its own try (L221 MAT-1). A product whose pass throws or runs late is failed, the
 * others still run, and the step then fails with one stable line naming the failed products, sorted, each with a short
 * cause (numbers out), so the tick's step-error alert tells it once per distinct set. A pass that answers `ok: false`
 * (a bad approvals config) is not failed here: M2 has told Joe itself (approvals_config), again each day while it stands.
 *   approvals() → [{ product, gh, owner, repo, stateDir, push, copies }]   per product, everything M2 reaches outside
 */
export async function approvalsStep({ rec, rules, now, alert, approvals, productMs = APPROVALS_PRODUCT_MS, pass = schedulePass }) {
  if (typeof approvals !== 'function') throw new Error('the approvals port is missing');
  const list = await approvals();
  if (!Array.isArray(list)) throw new Error('the approvals port did not answer a list');
  const results = [];
  const failed = [];
  for (const x of list) {
    const product = typeof x?.product === 'string' && x.product ? x.product : null;
    if (!product) { failed.push(['(a product with no name)', 'no product named']); continue; }
    let timer;
    try {
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`it did not finish within ${productMs} ms`)), productMs); });
      const ctx = { ...x, record: rec, rules, product, now: () => now, alert: approvalsAlerts(alert, product) };
      const r = await Promise.race([Promise.resolve().then(() => pass(ctx)), late]);
      results.push({ product, ok: r?.ok === true, ...(r?.ok === true ? {} : { reason: r?.reason }), events: Array.isArray(r?.events) ? r.events.length : 0 });
    } catch (e) {
      failed.push([product, plain(e?.message ?? e, 120).replace(/\d+/g, 'N')]);
      results.push({ product, ok: false, failed: true });
    } finally { clearTimeout(timer); }
  }
  if (failed.length) {
    const named = failed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pr, why]) => `${pr} (${why})`);
    throw new Error(`the Approvals pass failed for ${named.join(', ')}`);
  }
  return results;
}
export const ACCOUNT_FACT = 'signed-in-account';
export const LAST_PASS_FACT = 'last-full-pass';
export const STEP_ERROR_FACT = (step) => `step-error-${step}`;
export const STEP_DEADLINE_MS = 120_000;
const iso = (ms) => new Date(ms).toISOString();
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

/** The signed-in account, or a reason nothing may start (audit MIN-9). */
export function signedInAccount({ rec, rules, now }) {
  const d = sensorsFact(rec, ACCOUNT_FACT)?.doc;
  if (!d?.account || typeof d.account !== 'string') return { account: null, reason: 'the signed-in account is not known' };
  let staleMs;
  try { staleMs = minutes(rules, KEYS.staleAfterMin); } catch { return { account: null, reason: `the rules have no value for ${KEYS.staleAfterMin}`, missing: KEYS.staleAfterMin }; }
  const seen = Date.parse(d.observed_at ?? '');
  if (!Number.isFinite(seen) || seen > now + 60_000 || now - seen > staleMs) return { account: null, reason: 'the signed-in account reading is stale' };
  return { account: d.account, reason: null };
}

/**
 * Acts on the outage step's answer (M10): a safe card's claim is broken by the Record, which itself checks the owner is
 * provably dead (breakIfDead: pid and pid_start, the session, no recent activity; L72), and goes back to ready; any
 * other card waits on Joe. Each card moved gets its own alert (L43(a), L38: no silent move); a card that already moved
 * on is left alone, with no alert. A break the Record refuses is listed with its reason, never forced.
 */
export function actOnDead({ rec, rules, now, restart, asks, cards = {}, alert = () => {}, missing = [] }) {
  const done = [];
  for (const sid of restart) {
    const cardId = cards[sid];
    const cur = cardId ? rec.read('card', cardId) : null;
    if (!cur || !['running', 'claimed'].includes(cur.doc.state)) continue;
    // No claim is broken without claims.stuck_min (M9 refuses too). It is a per-product key, read for the card's own
    // product (L110 m-2); the missing value is told with the others.
    try { need(rules, KEYS.claimsStuckMin, { product: cur.doc.product }); } catch (e) {
      if (!(e instanceof MissingKey)) throw e;
      const what = missingFor(e.key, cur.doc.product);
      if (!missing.includes(what)) missing.push(what);
      done.push([cardId, `not restarted: the rules have no ${e.key} for ${cur.doc.product ?? 'its product'}`]);
      continue;
    }
    const broke = rec.breakIfDead({ card: cardId });
    if (broke.ok) {
      done.push([cardId, 'ready again']);
      // A notice only: the card is back in the queue whatever the answer; a lost one is in the diary (L130 m1).
      if (alert(`card ${cardId}: its session ${sid} stopped; the card is marked safe to re-run, so it is back in the queue`) === false) done.push([cardId, 'not told: the alert could not be queued']);
    } else done.push([cardId, `not restarted: ${broke.reason}`]);
  }
  for (const cardId of asks) {
    const cur = rec.read('card', cardId);
    if (!cur || !['running', 'claimed'].includes(cur.doc.state)) continue;
    // Told until delivered (L130 M1): waitOnJoe records the tell, and retellWaits asks again while it is not delivered.
    const w = waitOnJoe(rec, cardId, { what: 'dead_session: its session stopped and the card is not marked safe to re-run', now, link: `card ${cardId}`, kind: 'dead_ask',
      alert, text: `card ${cardId}: its session stopped and the card is not marked safe to re-run, so it waits on you` });
    if (w.ok) done.push([cardId, w.tell_refused ? `waiting on Joe; ${w.tell_refused}` : 'waiting on Joe']);
  }
  return done;
}

/**
 * One full pass. `ports` holds every outside effect (see README, "The tick's ports"); each step reads
 * only the ports it needs. Returns { steps: { name: { ok, result | error } } }.
 */
// `clock` (ms): read before each step, so each step's `now` is the time it starts, never before the tick's own (L321:
// steps run one after another, each up to STEP_DEADLINE_MS, and the Store Writer refuses a wait whose since is more
// than 60 s off its clock). Left out, it is the tick's fixed `now`.
export async function tick({ rec, rules, now, clock = () => now, ports: p }) {
  // Every refused write of a watched kind is noted, and told at the end of the pass (refused-writes.mjs, L323).
  const base = rec;
  const watched = watchWrites(rec);
  rec = watched.rec;
  const res = {};
  // Every alert is queued (alerts.mjs, L47): no step sends or waits on a send.
  const alert = outbox(rec, now);
  const sendOpts = { ...(p.alertSendMs !== undefined && { sendMs: p.alertSendMs }) };
  // What past passes left queued, the broken-lock alert among them, starts going out now, alongside the
  // safety acts (audit 0b-6 r7 M1): a pass killed in any step, the first safety act included, still tells.
  // Nothing awaits it until the safety acts are done, and what it delivered is marked only then, so no
  // safety act has a fact changed under it. The port is called first, in this tick's first microtask, so
  // it must start its send and return at once (README, "The tick's ports").
  const early = sendAlerts(rec, p.alert, now, { ...sendOpts, later: true });
  let bands = null;
  let running = [];
  const deadline = p.stepDeadlineMs ?? STEP_DEADLINE_MS;
  // A time limit on each stop, save and Lead hand-off call; the defaults are pass.mjs's.
  const portDeadlines = Object.fromEntries([['portDeadlineMs', p.portDeadlineMs], ['saveDeadlineMs', p.saveDeadlineMs]].filter(([, v]) => v !== undefined));
  const run = async (step, f) => {
    now = Math.max(now, clock());
    let timer;
    try {
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`it did not finish within ${deadline} ms`)), deadline); });
      res[step] = { ok: true, result: await Promise.race([Promise.resolve().then(f), late]) };
      if (rec.read('fact', STEP_ERROR_FACT(step))?.doc?.error) { putFact(rec, STEP_ERROR_FACT(step), { error: null, at: iso(now) }, 'step_ok'); dropCause(rec, STEP_ERROR_FACT(step)); }
    } catch (e) {
      const error = String(e?.message ?? e);
      res[step] = { ok: false, error };
      const seen = rec.read('fact', STEP_ERROR_FACT(step))?.doc;
      // Once per distinct error, and again each day it lasts (L38: no silent hold). The error counts with its
      // numbers out, so a changing pid or count is one cause (audit 0b-6 r5 m4). Told only once sent (r5 MAT-2).
      const cause = error.replace(/\d+/g, 'N');
      if (seen?.error !== error) putFact(rec, STEP_ERROR_FACT(step), { ...seen, error, at: iso(now) }, 'step_error');
      // A told_at that can't be read or lies ahead is told now (L329: shared dueToTell), not kept quiet until it passes.
      if (seen?.told_cause !== cause || dueToTell(seen, now, HOLD_REPEAT_MS)) {
        tellThen(alert, `the Dispatcher's ${step} step failed: ${error}; the other steps still ran`, { fact: STEP_ERROR_FACT(step), fields: { told_cause: cause, told_at: iso(now) }, kind: 'step_error' });
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
    stops = await stopPass({ rec, rules, now, clock, account: acct.account, sessions: p.sessions(), probe: p.probe, stopGroup: p.stopGroup, saveWork: p.saveWork, alert, ...portDeadlines });
    missing.push(...stops.missing);
    return stops;
  });
  await run('undo', () => undoStep({ rec, rules, now, filesOf: p.filesOf, alert }));
  await run('undo-starts', async () => {
    const r = await undoStarts({ rec, rules, now, bands: stops?.bands ?? HELD_BANDS, running: stops?.running ?? p.sessions(), launch: p.launch, filesOf: p.filesOf, alert, ...portDeadlines });
    missing.push(...r.missing);
    if (stops) stops.running = r.running;
    return { started: r.started, refused: r.refused, notes: r.notes };
  });

  // The early send finishes, and is marked, before any other step, so it never races a later step's writes.
  const first = await early;
  first.settle();
  // A failing outage step falls back on the record (audit 0b-6 r3 MIN-1): an open outage still holds. Read again
  // once the step has run (L172 follow-up): a step that opened the outage and then threw never set outageOpen, and
  // the read before it saw no outage. The shared Record's read never throws: a fact it can't read comes back as
  // { corrupt: true } with no doc, which is not an open outage (L182 m2). The catch is only for a Record that throws.
  const outageInRecord = () => { try { return rec.read('fact', OUTAGE_FACT)?.doc?.state === 'open'; } catch { return true; } };
  let outageOpen = outageInRecord();
  await run('outage', async () => {
    const board = p.board();
    const o = outageStep({ rec, rules, board, now, healthy: p.healthy(), resume: p.resume?.() ?? false, alert });
    outageOpen = o.outage;
    const acted = o.outage ? [] : actOnDead({ rec, rules, now, restart: o.restart, asks: o.asks, cards: o.cards, alert, missing });
    // A claim whose session never started lapses (the Record stops that session id first; L72). Not in an outage.
    const lapse = o.outage ? null : rec.lapseClaims(now, { stopSession: p.stopSession });
    if (lapse && !lapse.ok) throw new Error(`claims could not be lapsed: ${lapse.reason}`);
    return { ...o, acted, lapsed: lapse?.lapsed ?? [] };
  });
  if (!outageOpen) outageOpen = outageInRecord();
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
  // Approvals (M2's schedule pass), per product (L221 MAT-1). Before the main pass, so a product its rules file just
  // turned on has its record when the pass reads it and can start this tick. Not before the undo steps: an undo tap is
  // recorded by M2's binding from the Front Door's session (processSession), not here; this pass only lapses, expires,
  // pushes, retries a close and onboards, and the undo steps neither need it nor are needed by it. Runs during an
  // outage too: it starts no session, and asks still lapse and go out on time. Not in `complete` below: M2 tells its
  // own config problems (approvals_config) and reports no missing rules value to the tick.
  await run('approvals', () => approvalsStep({ rec, rules, now, alert, approvals: p.approvals, ...(p.approvalsProductMs !== undefined && { productMs: p.approvalsProductMs }) }));
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
  await run('limits', () => timeLimits({ rec, rules, now, clock, b: bands ?? held, running, gateAlive: p.gateAlive,
    hasReviewer: p.hasReviewer, requestReview: p.requestReview, reviewAlerts: p.reviewAlerts, alert, startsHeld, missing }));
  await run('merges', () => requestMerges({ rec, rules, now, b: bands ?? held, running, startsHeld, missing, alert }));
  // A card put on Joe whose alert was not delivered is told again (L130).
  await run('waits', () => retellWaits({ rec, alert }));
  // A step that failed did not report what it lacked, so nothing already told is dropped this tick.
  const complete = ['stops', 'undo-starts', 'pass', 'limits', 'merges'].every((s) => res[s]?.ok);
  try { await rulesMissingAlert({ rec, keys: missing, alert, now, complete }); } catch (e) { alert(`the Dispatcher could not record missing rules values: ${e?.message ?? e}`); }
  // No silent hold (L38). The band is not told while the account is unknown: that hold is the account's.
  try {
    // A missing rules value is told by the missing-values alert, not twice.
    if (acct.reason && !acct.missing) holdAlert({ rec, cause: 'account', text: `nothing new starts but undo cards: ${acct.reason}`, alert, now });
    const band = stops?.bands ?? bands;
    // One list with the start pass (L305): a held start is folded only under a band this alert tells.
    if (!acct.reason && band && TOLD_BANDS.includes(band.band)) {
      holdAlert({ rec, cause: `band-${band.band}`, text: `the usage band is ${band.band}${band.reason ? ` (${band.reason})` : ''}: work it holds waits; stops and undo still run`, alert, now });
    }
  } catch (e) { alert(`the Dispatcher could not record a hold: ${e?.message ?? e}`); }
  await run('phone', () => phoneLinkStep({ rec, rules, now, send: p.sendFrontDoor, restartFrontDoor: p.restartFrontDoor, startMinibase: p.startMinibase,
    frontDoorAlive: p.frontDoorAlive, strayFrontDoor: p.strayFrontDoor, lastHandoff: p.frontDoorHandoff, alert }));
  await run('cleanup', () => cleanupPass({ rec, rules, now, ...p.cleanup, alert }));

  putFact(rec, LAST_PASS_FACT, { at: iso(now), steps: Object.fromEntries(STEPS.map((s) => [s, res[s]?.ok ? 'ok' : 'failed'])) }, 'full_pass');
  // Refused writes (L323): told after every step, before this pass's own alerts go out.
  // watchWrites' whole answer, its refusals and the writes it saw taken, so neither can be left out alone.
  let refused = [];
  try { refused = tellRefused({ ...watched, rec: base, alert, now: Math.max(now, clock()), ran: (step) => res[step]?.ok === true }); }
  catch (e) { alert(`the Dispatcher could not tell its refused writes: ${e?.message ?? e}`); }
  // The one sender (alerts.mjs) again, last: this pass's own alerts.
  const last = await sendAlerts(rec, p.alert, now, sendOpts);
  const alerts = { sent: first.sent + last.sent, failed: first.failed + last.failed, left: last.left };
  return { steps: res, alerts, refused };
}

/** The login job's entry: one full pass under the single-instance lock (M16). */
export async function runTick({ lockFile, lock = takePassLock, ...args }) {
  const l = lock(lockFile, { now: args.now });
  // A lock left by a dead pass: the last run was killed (the run deadline, the watchdog in main.mjs, a
  // crash) before it finished. Joe is told, once a day (L38); this pass runs as usual.
  if (l.ok && l.broke) {
    try { holdAlert({ rec: args.rec, cause: 'run-late', text: `the last Dispatcher pass (taken ${l.broke.taken_at ?? 'at an unknown time'}) was stopped before it finished; this pass runs as usual`, alert: outbox(args.rec, args.now), now: args.now }); }
    catch { /* the record is unwritable: the pass itself will fail and tell */ }
  }
  if (!l.ok) {
    note(args.rec, 'pass-lock-note', `a pass did not run: ${l.reason}`, { now: args.now });
    return { ran: false, reason: l.reason };
  }
  try { return { ran: true, ...(await tick(args)) }; } finally { l.release(); }
}
