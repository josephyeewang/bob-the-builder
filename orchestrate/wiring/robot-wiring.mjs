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
//   heartbeat   M13 heartbeatOnce, through the robot App: the same token (one mint a round) and alert repository as
//               deliver (L600). The pinned heartbeat issue and an alert for each red fact go there. What it says about
//               the Mini comes from the Sensors' facts in the Record (heartbeat-probes.mjs, L604), never a probe of its
//               own: a fact with no current reading is "not known", never a pass and never signed out. Without the App
//               keys it is not wired and refuses. The late part runs first either way (L239): when dispatcherLate() says
//               the Dispatcher is late, Joe is told. That alert goes to the job's log and the Record's alert queue before
//               any GitHub call (L730 m1), and `deliver`, below, sends it in the same round. With the App,
//               heartbeatOnce's own Dispatcher alert, decided by the same dispatcherLate() answer (L730 m2), tells it,
//               and the queued copy then leaves unsent. It stays queued when the heartbeat failed, when GitHub lost that
//               one alert (told is per alert, L730 m4), or when Joe closed it while the stop lasts (L730 m3).
//   caught-up   M13 caughtUpOnce. REAL: the idea issues are read with the read-only client, the ideas and the push
//               request are written as the Ledger. See lastReturn() for what "the Mini came back" means here.
//   watch       M12 watchOnce. Needs a Vercel client and M13 alerts: not wired, refuses.
//   deliver     LAST, so every alert the passes above queued goes out in the same round (L242). The alert queue is the
//               Record's, and delivery runs here, never in the Dispatcher (L236, L237): a dead Dispatcher is still told.
//               REAL when the config names the robot App (APP_KEYS, L600): M13 deliverAlertsPass through deliverWith, with
//               the robot's installation token minted once per round (robotToken). Without those keys it refuses, and
//               the alerts stay queued. A test may still inject `deliver({ rec, now })`.
// A pass that refuses fails, and robot-main.mjs tells Joe ("the robot job's <pass> pass failed: not wired yet: …").
//
// The config: the Dispatcher's keys (dispatcher-wiring.mjs) and these.
//   keyDir              the robot key folder (setup: orchestrate's, 0700, no access list). The job starts only when this
//                       process's user owns it. The App's key is token.mjs's default file name inside it.
//   dispatcherLockFile  the Dispatcher's pass lock (its config's lockFile). A Dispatcher whose pass is still running is
//                       not late (audit #137 M6): see dispatcherLate().
//   APP_KEYS, all four or none (L600): appId (the robot App's id), appInstallation (its installation's number on the
//   alert repository), alertRepo (owner/name: where alert issues go; the App must be installed there, and never Bob's
//   repository) and alertOwner (the GitHub login the issues are assigned to). With none, deliver refuses as not wired;
//   with some but not all, or a bad value, the job does not start.
//
// THE STORE-FREE CHANNEL. robotChannel(config) is the same App and alert repository with no Record behind it, for a
// start that failed before the Record opened (L587: robot-main.mjs's catch hands it to M13 store-stopped.mjs). It never
// throws and takes any config, even none.

import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CONFIG_KEYS as DISPATCHER_KEYS, checkConfig, privateFolder, recordAndRules, refusing, notWiredText, REVIEW_CONFIG_KEYS, WORKER_CONFIG_KEYS } from './dispatcher-wiring.mjs';
import { caughtUpOnce, RETURN_GAP_MIN } from '../modules/M13-ledger/caught-up.mjs';
import { makeFactWriter } from '../modules/M12-sensors/facts.mjs';
import { makeMasker } from '../modules/M12-sensors/mask.mjs';
import { LAST_PASS_FACT } from '../modules/M11-dispatcher/tick.mjs';
import { holdAlert, HOLD_FACT } from '../modules/M11-dispatcher/pass.mjs';
import { outbox, dropCause, writeFrom, ALERT_QUEUE_FACT } from '../modules/M11-dispatcher/alerts.mjs';
import { readDoc } from '../shared/record-read.mjs';
import { pidDead } from '../modules/M11-dispatcher/pass-lock.mjs';
import { RUN_DEADLINE_MS as DISPATCHER_RUN_MS, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { aclProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { DISPATCHER_LATE_MIN, heartbeatOnce } from '../modules/M13-ledger/heartbeat.mjs';
import { makeAlerts } from '../modules/M13-ledger/alerts.mjs';
import { heartbeatProbes } from './heartbeat-probes.mjs';
import { deliverWith, githubIssues, repoProblem } from '../modules/M13-ledger/alert-channel.mjs';
import { mintInstallationToken } from '../modules/M6-merge-gate/token.mjs';
import { appMintClient } from '../modules/M6-merge-gate/watch-run.mjs';

// approvalsStateDir is the Dispatcher's alone (M2 runs only in its approvals step), and so are the review runner's keys
// (L639), and the worker and cleanup ports' (L739), so the robot config refuses them.
// The robot App and where its alerts go (L600): all four or none.
export const APP_KEYS = Object.freeze(['appId', 'appInstallation', 'alertRepo', 'alertOwner']);
export const CONFIG_KEYS = Object.freeze([...DISPATCHER_KEYS.filter((k) => k !== 'approvalsStateDir' && !REVIEW_CONFIG_KEYS.includes(k) && !WORKER_CONFIG_KEYS.includes(k)), 'keyDir', 'dispatcherLockFile',
  ...APP_KEYS]);
const PATHS = Object.freeze(['recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'keyDir', 'dispatcherLockFile']);
// The longest a live Dispatcher pass may hold its lock: M11's run deadline, its watchdog's margin, and a minute (audit
// #137 M6). Past this, a live holder is stuck, and the Dispatcher counts as late. It uses M11's default deadline. A
// longer one would make a healthy pass read as stuck, so M11's readConfig refuses one (L802), and so does setup.
export const LIVE_PASS_MAX_MS = DISPATCHER_RUN_MS + WATCHDOG_MARGIN_MS + 60_000;
/**
 * The heartbeat told the hold for `cause`: its told mark is written onto the hold fact as delivery would write it (L746 m-B).
 * The mark is the one holdAlert itself gives, the same the queued copy carries, so it is written whether or not the queue
 * took that copy (L738 self-review), and only when the hold was due: one already told today keeps its time and its daily
 * count. A hold fact that cannot be read is not written over (L781: a failed read is not "absent"). → true when the hold
 * is marked, or needed no mark; false when the mark could not be written; never throws.
 */
export function markToldByBeat(rec, { cause, text, now }) {
  try {
    const fact = HOLD_FACT(cause);
    let mark = null;
    holdAlert({ rec, cause, text, now, alert: (_t, o) => { mark = o?.mark ?? null; return true; } });
    if (!mark || mark.fact !== fact) return true;
    const r = readDoc(rec, 'fact', fact);
    if (r.state === 'failed') return false;
    const base = r.state === 'found' ? r.doc : null;
    return writeFrom(rec, fact, base, { ...(base ?? {}), ...(mark.fields ?? {}) }, mark.kind ?? 'alert_told')?.ok === true;
  } catch { return false; }
}

export const LATE_CAUSE = (since) => `robot-dispatcher-late-${since ?? 'never'}`;
export const ROBOT_PASSES = Object.freeze(['gate', 'heartbeat', 'caught-up', 'watch', 'deliver']);
// What each pass that is not wired yet is waiting for: the port named in its refusal.
export const NOT_WIRED_PASSES = Object.freeze({ gate: 'robot.github (R-0b-02)', heartbeat: `robot.heartbeat: the config names no robot App (${APP_KEYS.join(', ')}; L600)`, watch: 'robot.vercel',
  deliver: `robot.deliver: the config names no robot App (${APP_KEYS.join(', ')}; L600)` });
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDEAS = 100;
const APP_ID = /^[A-Za-z0-9.]{1,64}$/;            // token.mjs's: a numeric App id or an App's client id
const INSTALL_ID = /^[1-9][0-9]{0,19}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Why the config's robot App keys can't be used, or null. `none` is what to answer when no App key is set at all (wire():
 * null, the deliver pass not wired; robotChannel: a reason). Fixed words: no value is echoed but the repository's.
 */
export function appProblem(c, { none = null } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'no config';
  const set = APP_KEYS.filter((k) => c[k] !== undefined);
  if (!set.length) return none;
  if (set.length !== APP_KEYS.length) return `the robot App keys go together, all four or none: ${APP_KEYS.filter((k) => c[k] === undefined).join(', ')} missing`;
  if ((typeof c.appId !== 'string' && !Number.isSafeInteger(c.appId)) || !APP_ID.test(String(c.appId))) return 'appId must be the robot App\'s id';
  if ((typeof c.appInstallation !== 'string' && !Number.isSafeInteger(c.appInstallation)) || !INSTALL_ID.test(String(c.appInstallation))) return 'appInstallation must be the installation\'s number';
  const bad = repoProblem(c.alertRepo);
  if (bad) return `alertRepo: ${bad}`;
  if (typeof c.alertOwner !== 'string' || !LOGIN.test(c.alertOwner)) return 'alertOwner must be a GitHub login';
  return null;
}

/**
 * The robot's installation token as M13's alert channel asks for it: `() => Promise<token.mjs's answer>`. LIMITED: minted
 * on the first ask only, never before, and that one answer, a token or a refusal, is kept for the rest of this process.
 * The robot job is one process per round, so that is at most one mint a round, however many calls or passes use it, and
 * a refused mint is not retried until the next round. A round is far shorter than the token's hour (robot-main.mjs
 * RUN_DEADLINE_MS). Never throws or rejects: a throw becomes { ok: false, reason }. The token stays in memory (R-0b-86).
 */
export function robotToken(c, { fetchFn = globalThis.fetch, uid = process.getuid?.(), now = Date.now, mint = mintInstallationToken } = {}) {
  let p = null;
  return () => (p ??= Promise.resolve()
    .then(() => mint({ keyDir: c.keyDir, appId: c.appId, installationId: c.appInstallation, http: appMintClient({ fetchFn }), uid, scriptsUid: c.ownerUid, now }))
    // A thrown message is masked before it is kept (#288 r1 m1): the reason reaches the job log and the alert queue, and
    // token.mjs's own scrub only covers the mint that ships, not one swapped in. Masked first, then cut.
    .catch((e) => ({ ok: false, reason: `token mint failed: ${makeMasker().maskSecrets(String(e?.message ?? e)).text.slice(0, 200)}` })));
}

/**
 * The store-free alert channel (L587, L600): { gh, owner } for M13 store-stopped.mjs, or null with the reason logged.
 * NEVER THROWS, for any `config`, undefined included: it runs in robot-main.mjs's catch, after the start has already
 * failed. It reads no Record and makes no call: the token is minted on the channel's first use (robotToken, so at most
 * once). It holds the same walls as wire() before any key is read: this process is the config's owner and owns the
 * private key folder (checkUser), and token.mjs checks the key file itself.
 */
export function robotChannel(config, { log = (s) => process.stderr.write(`${s}\n`), fetchFn = globalThis.fetch, uid = process.getuid?.(), now = Date.now,
  mint = mintInstallationToken, check = checkUser } = {}) {
  const none = (why) => { try { log(`robot: no alert channel without the Record: ${why}`); } catch { /* the log is all there is */ } return null; };
  try {
    const bad = appProblem(config, { none: `the config names no robot App (${APP_KEYS.join(', ')})` });
    if (bad) return none(bad);
    if (!Number.isSafeInteger(config.ownerUid) || config.ownerUid < 0) return none('ownerUid must be a Mac user id');
    if (typeof config.keyDir !== 'string' || !isAbsolute(config.keyDir)) return none('keyDir must be an absolute path');
    check({ uid, ownerUid: config.ownerUid, keyDir: config.keyDir });
    const token = robotToken(config, { fetchFn, uid, now, mint });
    return { gh: githubIssues({ repo: config.alertRepo, token, fetchFn }), owner: config.alertOwner };
  } catch (e) {
    let why = 'unknown error';
    try { why = String(e?.message ?? e).slice(0, 200); } catch { /* keep the fixed words */ }
    return none(why);
  }
}

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
 * `since` keys the alert: each stop of the Dispatcher is a new cause and a new heartbeat status, so it is told once, and
 * again each day it lasts (holdAlert's once a day, when the heartbeat's own alert was closed by Joe or not told).
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
 * is not told of stops that have ended. → whether every drop was written. Why not is logged here, by its own line: an
 * unreadable queue (with the Record's reason) or a drop that was not written (audit #346 m2).
 */
export function dropLateAlerts(rec, { log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const prefix = HOLD_FACT(LATE_CAUSE(''));
  // A hold fact is written only once its alert is delivered (pass.mjs holdAlert), so the causes are read from the queue
  // itself: its waiting entries and its listed drops. A queue that can't be read answers false: it is not known that
  // every drop was written (L797; the Record's read never throws, so a failure comes back as a corrupt row, not an error).
  const facts = new Set();
  const q = readDoc(rec, 'fact', ALERT_QUEUE_FACT);
  if (q.state === 'failed') {
    log(`robot: the Dispatcher is on time, but the alert queue could not be read (${String(q.reason).slice(0, 200)}), so its old late alerts were not cleared`);
    return false;
  }
  const d = q.state === 'found' ? q.doc : null;
  for (const m of [...(d?.entries ?? []).map((e) => e?.mark?.fact), ...(d?.dropped_causes ?? []).map((c) => c?.fact)]) {
    if (typeof m === 'string' && m.startsWith(prefix)) facts.add(m);
  }
  let ok = true;
  for (const f of facts) ok = dropCause(rec, f) && ok;
  if (!ok) log('robot: the Dispatcher is on time, but its old late alerts could not all be cleared from the queue (a drop was not written)');
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
  uid = process.getuid?.(), deliver = null, hold = holdAlert, mint = mintInstallationToken } = {}) {
  const c = checkConfig(config, { keys: CONFIG_KEYS, paths: PATHS });
  const appBad = appProblem(c);
  if (appBad) throw new Error(`config: ${appBad}`);
  // Its own live pid in that file would read as a running Dispatcher, every round, for ever (audit #150 Minor 3).
  if (resolve(c.dispatcherLockFile) === resolve(c.lockFile)) throw new Error('dispatcherLockFile is this job\'s own lockFile: it must be the Dispatcher\'s');
  checkUser({ uid, ownerUid: c.ownerUid, keyDir: c.keyDir });
  const { rec, rules, gh, entry } = await recordAndRules(c, { who: 'robot', log, fetchFn, now });

  const ledger = makeFactWriter(rec, { actor: 'ledger', now: () => new Date(now()) });
  const passes = Object.fromEntries(Object.entries(NOT_WIRED_PASSES).map(([p, port]) => [p, refusing(port)]));
  // The robot's token, minted on its first use and shared by every pass that writes, so at most one mint a round.
  const token = c.appId !== undefined ? robotToken(c, { fetchFn, uid, now, mint }) : null;
  if (deliver) passes.deliver = () => deliver({ rec, now });
  else if (token) {
    // One alert repository, for this Record's one product (L298: a Record tells only its own product's repository).
    const send = deliverWith({ recordRoot: c.recordRoot, product: c.product, products: [c.product], repos: { [c.product]: c.alertRepo },
      owner: c.alertOwner, token, fetchFn });
    passes.deliver = () => send({ rec, now });
  }
  let beat = null;
  if (token) {
    const issues = githubIssues({ repo: c.alertRepo, token, fetchFn });
    const when = () => new Date(now());
    // "Rules readable": the product has usable rules (M10's `rules.adopted`: adopted now, or the last good kept after a
    // newer file was refused; nothing refuses in either state).
    const probes = { ...heartbeatProbes({ rec, rules, now }), rulesReadable: async () => rules.get('rules.adopted', { product: c.product }) !== undefined };
    // The pass's own dispatcherLate answer decides the heartbeat's Dispatcher line too: one rule for "late", so a live
    // pass inside its run limit is never red there either (L730 m2; audit #137 M6).
    // TODO(#449, lead follow-up): once M13's alerts.sweep({ product }) is on main, the round makes one makeAlerts per round
    // and calls sweep on that same object at the round's end (a proof never expires). Today each beat makes its own.
    beat = (late) => heartbeatOnce({ product: c.product, writer: ledger, gh: issues, alerts: makeAlerts({ rec, gh: issues, owner: c.alertOwner, now: when, log }),
      owner: c.alertOwner, probes: { ...probes, dispatcherLate: async () => late }, now: when });
  }
  passes.heartbeat = async () => {
    const late = dispatcherLate(rec, { nowMs: now(), holder: lockHolder(c.dispatcherLockFile) });
    if (late) log(`robot: alert: ${late.text}`);
    // The late alert is queued FIRST, before any GitHub call, so a heartbeat that hangs past the pass's time limit can't
    // lose it (L730 m1). With the App, the heartbeat's own Dispatcher alert then tells it, and the queued copy leaves
    // unsent, so it is not told twice (L239). When the heartbeat failed, lost that alert on GitHub, or found it closed by
    // Joe while the stop lasts ('suppressed', L730 m3), the queued copy stays: a broken App never leaves a stopped
    // Dispatcher untold, and holdAlert tells a lasting one again each day. That errs toward telling twice, on purpose: a
    // heartbeat that throws after its Dispatcher alert went out (say the pinned-issue edit fails), or that ends after the
    // pass's time limit, leaves the copy for deliver too (L738 review m2).
    let tell = null;
    if (late) {
      // A refused alert is logged and kept with the pass's failure (audit #137 M1; L130 m12).
      if (hold({ rec, cause: LATE_CAUSE(late.since), text: late.text, alert: outbox(rec, now()), now: now() }) === false) {
        tell = 'the Dispatcher-late alert could not be queued';
        log(`robot: ${tell}`);
      }
    } else dropLateAlerts(rec, { log });   // logs why, when it answers false
    let beaten = null; let failed = null;
    if (beat) { try { beaten = await beat(late); } catch (e) { failed = e; } }
    // Told per alert (L730 m4): only what the Dispatcher alert itself answered counts, not whether every alert went out.
    const answer = beaten?.told?.dispatcher;
    const toldByBeat = typeof answer === 'string' && answer !== 'suppressed';
    if (late && toldByBeat) {
      const fact = HOLD_FACT(LATE_CAUSE(late.since));
      // L746 m-B: the heartbeat's tell is the tell, so the hold is marked told now, as delivery would have marked it; the
      // daily count then starts from it, and Joe closing that issue is answered the next day, not in a minute.
      if (!markToldByBeat(rec, { cause: LATE_CAUSE(late.since), text: late.text, now: now() })) log('robot: the heartbeat told the Dispatcher-late alert, but the hold could not be marked told: the next round queues it again, unless the heartbeat of that round tells it');
      if (!dropCause(rec, fact)) log('robot: the heartbeat told the Dispatcher-late alert, but its queued copy could not be dropped: it may be told twice');
    }
    if (failed) throw Object.assign(failed instanceof Error ? failed : new Error(String(failed)), tell ? { tell } : {});
    if (!beat) throw Object.assign(new Error(notWiredText(NOT_WIRED_PASSES.heartbeat)), tell ? { tell } : {});
    // Neither queued nor told by the heartbeat (GitHub lost it, or Joe closed it while it lasts): the pass fails with the
    // tell, as above, so robot-main logs it as not told and the round's result says so (L738 review m1).
    if (late && tell && !toldByBeat) throw Object.assign(new Error('the Dispatcher-late alert was neither queued nor told by the heartbeat'), { tell });
    return { red: beaten.red };
  };
  passes['caught-up'] = async () => {
    const ret = lastReturn(rec, { nowMs: now() });
    return caughtUpOnce({ rec, gh: { listIdeaIssues: () => ideaIssues(gh, entry) }, writer: ledger, ownerId: entry.joe_github_id,
      product: c.product, lastGoodPass: ret?.downSince ?? null, now: () => new Date(ret ? ret.back : now()) });
  };
  return { rec, passes };
}
