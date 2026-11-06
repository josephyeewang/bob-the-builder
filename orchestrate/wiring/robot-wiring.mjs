// robot-wiring.mjs — the wiring module the robot job's config names (R-0b-162 B; LEAD-CALLS L236, L238). robot-main.mjs
// imports it and calls `wire(config)`.
//
// WHY A JOB OF ITS OWN. Every pass that needs a client able to WRITE outside (merge on GitHub, edit Joe's alert issues,
// read Vercel with a token) runs here, never in the Dispatcher: one process holds the write tokens, a crash here
// does not stop the Dispatcher (or the reverse), and the heartbeat still reports a Dispatcher that has died. The job runs
// as orchestrate, the Mac user that owns the Record and the robot key folder; the workers run as the owner's own user
// and cannot read that folder (0700). The startup check below refuses any other arrangement, loudly.
//
// THE PASSES, in order (ROBOT_PASSES):
//   gate        M6 gatePass. Needs the robot's GitHub client (a token minted from the robot App's key, M6 token.mjs).
//               No robot App exists yet (R-0b-02): not wired, refuses.
//   heartbeat   M13 heartbeatOnce. Needs a GitHub client that edits issues (M13 alerts.mjs), from lane 3's delivery
//               adapter (L235) and the robot token: not wired, refuses. One part is real now (L239): when the Dispatcher's
//               last full pass is older than M13's DISPATCHER_LATE_MIN, or missing, Joe is told (dispatcherLate(), below).
//               heartbeatOnce itself is not called yet: its account probe is not wired, and a probe that throws makes it
//               write a signed-out fact the Dispatcher would act on.
//               It goes to the job's log and the Record's alert queue; `deliver`, below, sends it in the same round.
//   caught-up   M13 caughtUpOnce. REAL: the idea issues are read with the read-only client, the ideas and the push
//               request are written as the Ledger. See lastReturn() for what "the Mini came back" means here.
//   watch       M12 watchOnce. Needs a Vercel client and M13 alerts: not wired, refuses.
//   deliver     LAST, so every alert the passes above queued goes out in the same round (L242). The alert queue is the
//               Record's, and delivery runs here, never in the Dispatcher (L236, L237): a dead Dispatcher is still told.
//               The port is lane 3's M13 deliverAlertsPass, injected as `deliver({ rec, now })`; until it lands, it
//               refuses, and the alerts stay queued.
// A pass that refuses fails, and robot-main.mjs tells Joe ("the robot job's <pass> pass failed: not wired yet: …").
//
// The config: the Dispatcher's keys (dispatcher-wiring.mjs) and one more.
//   keyDir         the robot key folder (setup: orchestrate's, 0700). The job starts only when this process's user owns it.

import { lstatSync } from 'node:fs';
import { CONFIG_KEYS as DISPATCHER_KEYS, REVIEW_CONFIG_KEYS, checkConfig, privateFolder, recordAndRules, refusing } from './dispatcher-wiring.mjs';
import { caughtUpOnce, RETURN_GAP_MIN } from '../modules/M13-ledger/caught-up.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { holdAlert } from '../modules/M11-dispatcher/pass.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';
import { notWiredText } from './dispatcher-wiring.mjs';

// approvalsStateDir is the Dispatcher's alone (M2 runs only in its approvals step), and so are the review runner's keys
// (L639), so the robot config refuses them.
export const CONFIG_KEYS = Object.freeze([...DISPATCHER_KEYS.filter((k) => k !== 'approvalsStateDir' && !REVIEW_CONFIG_KEYS.includes(k)), 'keyDir']);
const PATHS = Object.freeze(['recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'keyDir']);
export const ROBOT_PASSES = Object.freeze(['gate', 'heartbeat', 'caught-up', 'watch', 'deliver']);
// What each pass that is not wired yet is waiting for: the port named in its refusal.
export const NOT_WIRED_PASSES = Object.freeze({ gate: 'robot.github (R-0b-02)', heartbeat: 'robot.issues (L235)', watch: 'robot.vercel',
  deliver: 'robot.deliver (L237)' });
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDEAS = 100;

/** Refuses unless this process runs as the Record's owner AND owns the robot key folder, private to it. */
export function checkUser({ uid, ownerUid, keyDir, lstat = lstatSync }) {
  if (uid !== ownerUid) throw new Error(`the robot job runs only as the Record's owner (uid ${ownerUid}), not uid ${uid}`);
  privateFolder({ path: keyDir, uid, what: 'the robot key folder', lstat });
}

/**
 * The Dispatcher's most recent return, from the Record's diary: the newest two of its passes (`last-full-pass` writes)
 * more than RETURN_GAP_MIN apart, the later one within the last day. → { downSince, back } (ISO, ms) | null.
 * WHY. caught-up.mjs was written to run inside the Dispatcher's own pass, where "now is more than 15 minutes after the
 * last good pass" means "the Mini has just come back". In this job that same test would be true for every minute the
 * Dispatcher is still DOWN, and the one push for the return (keyed by downSince) would go out mid-outage, saying
 * "caught up". So the return is read from the Dispatcher's own pass times, and caughtUpOnce is asked as of the pass that
 * came back. A return more than a day old is not looked for (the job's first run must not report old history).
 */
export function lastReturn(rec, { nowMs, gapMin = RETURN_GAP_MIN, withinMs = DAY_MS }) {
  const at = [];
  for (const l of rec.diary({ since: 0 })) {
    if (l.actor !== 'dispatcher') continue;
    for (const w of l.writes ?? []) if (w.entity === 'fact' && w.id === LAST_PASS_FACT) { const t = Date.parse(w.doc?.at); if (Number.isFinite(t)) at.push(t); }
  }
  for (let i = at.length - 1; i > 0; i--) {
    if (nowMs - at[i] > withinMs) break;
    if (at[i] - at[i - 1] > gapMin * 60e3) return { downSince: new Date(at[i - 1]).toISOString(), back: at[i] };
  }
  return null;
}

/**
 * Is the Dispatcher late? Its last full pass (the `last-full-pass` fact) older than M13's DISPATCHER_LATE_MIN, missing,
 * or more than 10 minutes in the future (heartbeat.mjs's own rule). → null when on time, else { since (ms | null), text }.
 * `since` keys the alert: each stop of the Dispatcher is told once (and again each day it lasts).
 */
export function dispatcherLate(rec, { nowMs, lateMin = DISPATCHER_LATE_MIN }) {
  const at = Date.parse(rec.read('fact', LAST_PASS_FACT)?.doc?.at ?? '');
  if (!Number.isFinite(at)) return { since: null, text: 'the Dispatcher has no full pass on record: nothing is started or merged until it runs' };
  const min = Math.round((nowMs - at) / 60e3);
  if (min < -10) return { since: at, text: `the Dispatcher's last full pass is dated ${-min} minutes in the future: check the Mini's clock` };
  if (min <= lateMin) return null;
  return { since: at, text: `the Dispatcher's last full pass was ${min} minutes ago (late after ${lateMin}): nothing new is started or merged until it runs again` };
}

/** The open `idea` issues (caught-up.mjs's listIdeaIssues), one read. A list that could be cut off is refused, not used. */
export async function ideaIssues(gh, { owner, repo }) {
  const r = await gh.get(`/repos/${owner}/${repo}/issues?labels=idea&state=open&per_page=${MAX_IDEAS}`);
  if (r?.status !== 200 || !Array.isArray(r.json)) throw new Error(`the idea issues could not be read (HTTP ${r?.status})`);
  if (r.json.length >= MAX_IDEAS) throw new Error(`${MAX_IDEAS} or more open idea issues: the list could be cut off, so none are filed`);
  return r.json.filter((i) => !i.pull_request);
}

export async function wire(config, { log = (s) => process.stderr.write(`${s}\n`), fetchFn = globalThis.fetch, now = () => Date.now(),
  uid = process.getuid?.(), deliver = null } = {}) {
  const c = checkConfig(config, { keys: CONFIG_KEYS, paths: PATHS });
  checkUser({ uid, ownerUid: c.ownerUid, keyDir: c.keyDir });
  const { rec, gh, entry } = await recordAndRules(c, { who: 'robot', log, fetchFn, now });

  const ledger = makeFactWriter(rec, { actor: 'ledger', now: () => new Date(now()) });
  const passes = Object.fromEntries(Object.entries(NOT_WIRED_PASSES).map(([p, port]) => [p, refusing(port)]));
  if (deliver) passes.deliver = () => deliver({ rec, now });
  passes.heartbeat = async () => {
    const late = dispatcherLate(rec, { nowMs: now() });
    if (late) {
      log(`robot: alert: ${late.text}`);
      holdAlert({ rec, cause: `robot-dispatcher-late-${late.since ?? 'never'}`, text: late.text, alert: outbox(rec, now()), now: now() });
    }
    throw new Error(notWiredText(NOT_WIRED_PASSES.heartbeat));
  };
  passes['caught-up'] = async () => {
    const ret = lastReturn(rec, { nowMs: now() });
    return caughtUpOnce({ rec, gh: { listIdeaIssues: () => ideaIssues(gh, entry) }, writer: ledger, ownerId: entry.joe_github_id,
      product: c.product, lastGoodPass: ret?.downSince ?? null, now: () => new Date(ret ? ret.back : now()) });
  };
  return { rec, passes };
}
