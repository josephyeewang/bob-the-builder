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
// The config: the Dispatcher's keys (dispatcher-wiring.mjs) and two more.
//   keyDir              the robot key folder (setup: orchestrate's, 0700, no access list). The job starts only when this
//                       process's user owns it.
//   dispatcherLockFile  the Dispatcher's pass lock (its config's lockFile). A Dispatcher whose pass is still running is
//                       not late (audit #137 M6): see dispatcherLate().

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_KEYS as DISPATCHER_KEYS, checkConfig, privateFolder, recordAndRules, refusing, notWiredText, REVIEW_CONFIG_KEYS } from './dispatcher-wiring.mjs';
import { caughtUpOnce, RETURN_GAP_MIN } from '../modules/M13-ledger/caught-up.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { holdAlert, HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { outbox, dropCause, ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { pidDead } from '../modules/M11-dispatcher/pass-lock.mjs';
import { RUN_DEADLINE_MS as DISPATCHER_RUN_MS, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { DISPATCHER_LATE_MIN } from '../modules/M13-ledger/heartbeat.mjs';

// approvalsStateDir is the Dispatcher's alone (M2 runs only in its approvals step), and so are the review runner's keys
// (L639), so the robot config refuses them.
export const CONFIG_KEYS = Object.freeze([...DISPATCHER_KEYS.filter((k) => k !== 'approvalsStateDir' && !REVIEW_CONFIG_KEYS.includes(k)), 'keyDir', 'dispatcherLockFile']);
const PATHS = Object.freeze(['recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'keyDir', 'dispatcherLockFile']);
// The longest a live Dispatcher pass may hold its lock: M11's run deadline, its watchdog's margin, and a minute (audit
// #137 M6). Past this, a live holder is stuck, and the Dispatcher counts as late. It uses M11's default deadline. Nothing
// stops the Dispatcher's config from setting a longer one, so setup must not: a healthy pass would then read as stuck.
export const LIVE_PASS_MAX_MS = DISPATCHER_RUN_MS + WATCHDOG_MARGIN_MS + 60_000;
export const LATE_CAUSE = (since) => `robot-dispatcher-late-${since ?? 'never'}`;
export const ROBOT_PASSES = Object.freeze(['gate', 'heartbeat', 'caught-up', 'watch', 'deliver']);
// What each pass that is not wired yet is waiting for: the port named in its refusal.
export const NOT_WIRED_PASSES = Object.freeze({ gate: 'robot.github (R-0b-02)', heartbeat: 'robot.issues (L235)', watch: 'robot.vercel',
  deliver: 'robot.deliver (L237)' });
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDEAS = 100;

/** Refuses unless this process runs as the Record's owner AND owns the robot key folder, private to it, no access list. */
export function checkUser({ uid, ownerUid, keyDir, lstat = lstatSync, acl = aclProblem }) {
  if (uid !== ownerUid) throw new Error(`the robot job runs only as the Record's owner (uid ${ownerUid}), not uid ${uid}`);
  privateFolder({ path: keyDir, uid, what: 'the robot key folder', lstat });
  // An inherited "everyone may read" access list would pass the mode check and give every key file put inside it to any
  // user (audit #137 M3). Setup refuses one too; this is the second wall.
  const a = acl([keyDir]);
  if (a) throw new Error(`the robot key folder: ${a}`);
}

/**
 * The Dispatcher's most recent return, from the Record's diary: two of its passes (`last-full-pass` writes) in a row where
 * more than RETURN_GAP_MIN passed between the first one ENDING (its diary line's time) and the next one STARTING (its
 * `started_at`), the later one within the last day. → { downSince, back } (ISO, ms) | null. `at` is no start: it is the
 * last step's time, about the pass's end (L321), so a gap measured to it counts the pass's own length (audit #150 M1): a
 * slow pass is not an outage. A pass with no `started_at`, from before it was written, is no return.
 * WHY. caught-up.mjs was written to run inside the Dispatcher's own pass, where "now is more than 15 minutes after the
 * last good pass" means "the Mini has just come back". In this job that same test would be true for every minute the
 * Dispatcher is still DOWN, and the one push for the return (keyed by downSince) would go out mid-outage, saying
 * "caught up". So the return is read from the Dispatcher's own pass times, and caughtUpOnce is asked as of the pass that
 * came back. A return more than a day old is not looked for (the job's first run must not report old history).
 */
export function lastReturn(rec, { nowMs, gapMin = RETURN_GAP_MIN, withinMs = DAY_MS }) {
  const at = []; const start = []; const end = [];
  for (const l of rec.diary({ since: 0 })) {
    if (l.actor !== 'dispatcher') continue;
    for (const w of l.writes ?? []) {
      if (w.entity !== 'fact' || w.id !== LAST_PASS_FACT) continue;
      const t = Date.parse(w.doc?.at);
      if (!Number.isFinite(t)) continue;
      const e = Date.parse(l.ts);
      const s = Date.parse(w.doc?.started_at);
      at.push(t); start.push(s); end.push(Number.isFinite(e) && e >= t ? e : t);
    }
  }
  for (let i = at.length - 1; i > 0; i--) {
    if (nowMs - at[i] > withinMs) break;
    if (start[i] - end[i - 1] > gapMin * 60e3) return { downSince: new Date(at[i - 1]).toISOString(), back: at[i] };
  }
  return null;
}

/**
 * Who holds the Dispatcher's pass lock: { live, takenAt (ms | null) }, or null when no one does (or it can't be read:
 * that is not a running pass). `live` is true unless the pid surely does not exist (pass-lock.mjs pidDead).
 */
export function lockHolder(file, { read = (f) => readFileSync(f, 'utf8'), dead = pidDead } = {}) {
  let held; try { held = JSON.parse(read(file)); } catch { return null; }
  const pid = held?.pid;
  const t = Date.parse(held?.taken_at ?? '');
  return { live: Number.isInteger(pid) && pid > 0 && !dead(pid), takenAt: Number.isFinite(t) ? t : null };
}

/**
 * Is the Dispatcher late? (audit #137 M6, the lead's ruling) Late = no full pass (the `last-full-pass` fact, dated about a
 * pass's END) within M13's DISPATCHER_LATE_MIN, AND its pass lock not held by a live process; a live holder longer than
 * LIVE_PASS_MAX_MS is stuck, and counts as late too. Also late: no full pass on record (unless the first one is running),
 * or one more than 10 minutes in the future (heartbeat.mjs's own rule). → null when on time, else { since (ms | null), text }.
 * `since` keys the alert: each stop of the Dispatcher is told once (and again each day it lasts).
 */
export function dispatcherLate(rec, { nowMs, lateMin = DISPATCHER_LATE_MIN, holder = null }) {
  const held = holder?.live ? (holder.takenAt === null ? Infinity : nowMs - holder.takenAt) : null;
  const running = held !== null && held <= LIVE_PASS_MAX_MS;
  const stuck = held !== null && !running
    ? ` (a Dispatcher pass has held its lock for ${Number.isFinite(held) ? `${Math.round(held / 60e3)} minutes` : 'an unknown time'}, longer than any pass may run)` : '';
  const at = Date.parse(rec.read('fact', LAST_PASS_FACT)?.doc?.at ?? '');
  if (!Number.isFinite(at)) return running ? null : { since: null, text: `the Dispatcher has no full pass on record: nothing is started or merged until it runs${stuck}` };
  const min = Math.round((nowMs - at) / 60e3);
  if (min < -10) return { since: at, text: `the Dispatcher's last full pass is dated ${-min} minutes in the future: check the Mini's clock` };
  if (min <= lateMin || running) return null;
  return { since: at, text: `the Dispatcher's last full pass was ${min} minutes ago (late after ${lateMin}): nothing new is started or merged until it runs again${stuck}` };
}

/**
 * The Dispatcher is on time: every late alert still queued leaves unsent (L130, audit 0b-6 r7 M2; audit #137 M5), so the owner
 * is not told of stops that have ended. → whether every drop was written.
 */
export function dropLateAlerts(rec) {
  const prefix = HOLD_FACT(LATE_CAUSE(''));
  // A hold fact is written only once its alert is delivered (pass.mjs holdAlert), so the causes are read from the queue
  // itself: its waiting entries and its listed drops.
  const facts = new Set();
  let d = null; try { d = rec.read('fact', ALERT_QUEUE_FACT)?.doc; } catch { return false; }
  for (const m of [...(d?.entries ?? []).map((e) => e?.mark?.fact), ...(d?.dropped_causes ?? []).map((c) => c?.fact)]) {
    if (typeof m === 'string' && m.startsWith(prefix)) facts.add(m);
  }
  let ok = true;
  for (const f of facts) ok = dropCause(rec, f) && ok;
  return ok;
}

/** The open `idea` issues (caught-up.mjs's listIdeaIssues), one read. A list that could be cut off is refused, not used. */
export async function ideaIssues(gh, { owner, repo }) {
  const r = await gh.get(`/repos/${owner}/${repo}/issues?labels=idea&state=open&per_page=${MAX_IDEAS}`);
  if (r?.status !== 200 || !Array.isArray(r.json)) throw new Error(`the idea issues could not be read (HTTP ${r?.status})`);
  if (r.json.length >= MAX_IDEAS) throw new Error(`${MAX_IDEAS} or more open idea issues: the list could be cut off, so none are filed`);
  return r.json.filter((i) => !i.pull_request);
}

export async function wire(config, { log = (s) => process.stderr.write(`${s}\n`), fetchFn = globalThis.fetch, now = () => Date.now(),
  uid = process.getuid?.(), deliver = null, hold = holdAlert } = {}) {
  const c = checkConfig(config, { keys: CONFIG_KEYS, paths: PATHS });
  // Its own live pid in that file would read as a running Dispatcher, every round, for ever (audit #150 Minor 3).
  if (resolve(c.dispatcherLockFile) === resolve(c.lockFile)) throw new Error('dispatcherLockFile is this job\'s own lockFile: it must be the Dispatcher\'s');
  checkUser({ uid, ownerUid: c.ownerUid, keyDir: c.keyDir });
  const { rec, gh, entry } = await recordAndRules(c, { who: 'robot', log, fetchFn, now });

  const ledger = makeFactWriter(rec, { actor: 'ledger', now: () => new Date(now()) });
  const passes = Object.fromEntries(Object.entries(NOT_WIRED_PASSES).map(([p, port]) => [p, refusing(port)]));
  if (deliver) passes.deliver = () => deliver({ rec, now });
  passes.heartbeat = async () => {
    const late = dispatcherLate(rec, { nowMs: now(), holder: lockHolder(c.dispatcherLockFile) });
    let tell = null;
    if (late) {
      log(`robot: alert: ${late.text}`);
      // A refused alert is logged and kept with the pass's failure (audit #137 M1; L130 m12).
      if (hold({ rec, cause: LATE_CAUSE(late.since), text: late.text, alert: outbox(rec, now()), now: now() }) === false) {
        tell = 'the Dispatcher-late alert could not be queued';
        log(`robot: ${tell}`);
      }
    } else if (!dropLateAlerts(rec)) log('robot: the Dispatcher is on time, but its old late alerts could not be cleared from the queue');
    throw Object.assign(new Error(notWiredText(NOT_WIRED_PASSES.heartbeat)), tell ? { tell } : {});
  };
  passes['caught-up'] = async () => {
    const ret = lastReturn(rec, { nowMs: now() });
    return caughtUpOnce({ rec, gh: { listIdeaIssues: () => ideaIssues(gh, entry) }, writer: ledger, ownerId: entry.joe_github_id,
      product: c.product, lastGoodPass: ret?.downSince ?? null, now: () => new Date(ret ? ret.back : now()) });
  };
  return { rec, passes };
}
