// Setup part 2b (PR 2): the three background jobs (LaunchDaemons). The plist texts come from review-daemons.mjs (the one
// place that builds them); this file puts them where launchd looks, and loads, lists and unloads them.
//
//   place    write the three plists (plus the hourly watch-only job, when the config's `watch` entry has `rulesSha256`, and the robot
//            job, when the config says `"robot": true`, and the Dispatcher and Sensors jobs, when it has a `dispatcher` entry) into /Library/LaunchDaemons, root:wheel 0644 (launchd refuses any other owner or mode)
//            and make each log file launchd opens for a job with a UserName, owned by that user (jobLogs)
//            in the log folder, which it repairs, or refuses if the job's user could change it
//   load     launchctl bootstrap system <plist>, for each job not loaded yet; a job loaded from an OLDER file is reloaded (bootout, then
//            bootstrap); refuses unless the install check passes. It records the fingerprint of each file it loaded
//            (<base>/install/loaded-jobs.json, root's) so `check` can tell a loaded job from a file that has since changed
//   unload   launchctl bootout system/<label>, for each job that is loaded
//   list     launchctl print system/<label>: loaded or not, state, last exit code (read only)
//   check    read only: the files are exactly what review-daemons.mjs builds, root's 0644, no access list; no job file left under
//            another label; each job is loaded, from the file as it is now, its last run ended with exit 0, and no run has been going over 30 minutes;
//            a job with a UserName has its log files, that user's, 0644, in a folder that is root's 0755
//
// Paths inside the plists are the real ones (no test prefix); the plist files themselves sit under io.at().

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { RUNNER_CONFIG, aclProblem, chainProblem, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { homeOf, watchRulesPath } from './layout.mjs';
import { checkInstall, installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { watchPlist, WATCH_NO_HASH } from './watch-setup.mjs';
import { ROBOT_JOB, robotAppKeyItems, robotConfigProblem, robotPlist } from './robot-setup.mjs';
import { DISPATCHER_JOB, DISPATCHER_OFF, DISPATCHER_RUN_LIMIT_S, dispatcherConfigProblem, dispatcherKeysProblem, dispatcherLoadProblem, dispatcherPlist, robotMatchProblem, writeAside } from './dispatcher-setup.mjs';
import { answerRows } from './owner-answer-setup.mjs';
import { SENSORS_JOB, SENSORS_RUN_LIMIT_S, sensorsConfigProblem, sensorsLoadProblem, sensorsPlist } from './sensors-setup.mjs';

// The worker runner's script, as its job starts it from the copy (wiring/runner-job.mjs): an old job is found by it (#528 r2 m7).
const WORKER_RUNNER_SCRIPT = 'wiring/runner-main.mjs';

export const DAEMON_DIR = '/Library/LaunchDaemons';
const LAUNCHCTL = '/bin/launchctl';
export const JOBS = Object.freeze(['review-updater', 'review-account', 'review-runner']);   // load order: the updater first
// The hourly watch-only job (watch-setup.mjs) is a fourth job only when the config's `watch` entry has the rules fingerprint (R6 M-1):
// a repo-only entry (all prove-token needs) leaves the three review jobs exactly as before.
// The robot job (robot-setup.mjs) is one more only when the config says `"robot": true`, so a config without it places exactly what it did.
// The Dispatcher job (dispatcher-setup.mjs) likewise, only when the config has its `dispatcher` entry; it loads before the robot job.
// The Sensors job (sensors-setup.mjs) is on exactly when the Dispatcher is (L1049), and loads after it, before the robot job.
export const jobsFor = (cfg) => [...JOBS, ...(cfg.watch?.rulesSha256 ? ['watch-only'] : []), ...(cfg.dispatcher ? [DISPATCHER_JOB, SENSORS_JOB] : []), ...(cfg.robot ? [ROBOT_JOB] : [])];
/** The jobs a config may turn on or leave off. One left off must not be placed or loaded either (a full check says so). */
export const OPTIONAL_JOBS = Object.freeze(['watch-only', DISPATCHER_JOB, SENSORS_JOB, ROBOT_JOB]);
export const ALL_JOBS = Object.freeze([...JOBS, ...OPTIONAL_JOBS]);
const ROBOT_OFF = 'the config does not turn the robot job on: add "robot": true, with its robot.json among the extras';
/**
 * `--only <job>`: that one job, or a clear refusal naming the jobs there are (the watch job exists only when the config's `watch`
 * entry has the rules fingerprint). `anyKnown` (unload and list): the robot job is taken whatever the config says, so a robot
 * job the config has since turned off can still be taken out alone (audit #292 m3). The watch job keeps its refusal here: its
 * tests pin it, and changing it is outside this change (raised with the lead).
 */
export function onlyJobs(cfg, name, { anyKnown = false } = {}) {
  if (anyKnown && (name === ROBOT_JOB || name === DISPATCHER_JOB || name === SENSORS_JOB)) return [name];
  const all = jobsFor(cfg);
  if (name === 'watch-only' && cfg.watch && !cfg.watch.rulesSha256) throw new Error(WATCH_NO_HASH);
  if (name === ROBOT_JOB && !cfg.robot) throw new Error(ROBOT_OFF);
  if ((name === DISPATCHER_JOB || name === SENSORS_JOB) && !cfg.dispatcher) throw new Error(DISPATCHER_OFF);
  if (!all.includes(name)) throw new Error(`--only names no job of this config: ${JSON.stringify(String(name).slice(0, 60))}; the jobs are ${all.join(', ')}`);
  return [name];
}
const op = (text, run) => ({ text, run });
const plistPath = (cfg, job) => join(DAEMON_DIR, `${cfg.label}.${job}.plist`);
const labelOf = (cfg, job) => `${cfg.label}.${job}`;
const sha = (t) => createHash('sha256').update(t).digest('hex');
const recordPath = (cfg) => join(installPaths(cfg).install, 'loaded-jobs.json');
/** What `load` recorded: job label → fingerprint of the job file it loaded. Anything unreadable is an empty record (every job then counts as not known to match). */
function readRecord(io, cfg) { try { const r = JSON.parse(io.readText(recordPath(cfg))); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; } catch { return {}; } }
function changeRecord(io, cfg, fn) { const rec = readRecord(io, cfg); fn(rec); writeAside(io, recordPath(cfg), `${JSON.stringify(rec, null, 1)}\n`); }   // whole or not at all (L807 m4)
/** A step that asks launchd AFTER a load whether the job is really there: a bootstrap that said yes but left nothing is a failure, not "done" (L150 m2). */
const readBackOp = (io, cfg, job) => op(`read back: ${labelOf(cfg, job)} is loaded`, () => {
  const s = jobState(io, cfg, job);
  if (s.error || !s.loaded) throw new Error(`${labelOf(cfg, job)} is NOT loaded after the load${s.error ? ` (${s.error})` : ''}. Nothing is running it. Run: daemons load`);
});
const fileText = (io, cfg, job) => { try { return io.readText(plistPath(cfg, job)); } catch { return null; } };

/** The three plist texts, from the layout and the owner's record. → { plists: {job: text}, problems } */
export function plistTexts(io, cfg) {
  const P = installPaths(cfg); const problems = [];
  const owner = readUser(io, cfg.owner);
  if (!owner.exists || !Number.isInteger(owner.uid) || owner.uid <= 0) { problems.push(`the owner's Mac user ${cfg.owner} was not found`); return { plists: {}, problems }; }
  const common = { label: cfg.label, installRoot: P.installRoot, logDir: P.logDir };
  try {
    const two = reviewDaemonPlists({ ...common, config: join(P.installRoot, RUNNER_CONFIG), reviewRoot: P.reviewRoot, reviewHome: homeOf(cfg, 'review'), accountCopy: P.accountCopy, ownerHome: owner.home, ownerUid: owner.uid });
    const plists = { 'review-runner': two.runner, 'review-account': two.accountCopy, 'review-updater': updaterPlist(common) };
    if (cfg.watch?.rulesSha256) plists['watch-only'] = watchPlist(io, cfg);
    if (cfg.dispatcher) { plists[DISPATCHER_JOB] = dispatcherPlist(cfg); plists[SENSORS_JOB] = sensorsPlist(cfg); }
    if (cfg.robot) plists[ROBOT_JOB] = robotPlist(cfg);
    return { plists, problems };
  } catch (e) { return { plists: {}, problems: [`the job files cannot be built from the owner's Mac user ${cfg.owner} (${e.message}); is its home folder set?`] }; }
}

/**
 * The Mac user a job file runs as and the log files launchd opens for it: { user, files }, read from the job file itself, so every
 * job that has a UserName is covered without a list. launchd opens these files AS that user, in a folder that is root's, so a file
 * missing or not that user's stops the job before its program starts (exit 78). A job with no UserName runs as root, which needs
 * neither. (The paths come from the base, which layout.mjs limits to plain characters, so nothing in them is escaped.)
 */
export function jobLogs(text) {
  // `\s*`: the file on disk, which load reads, may be laid out on several lines, as `plutil -convert xml1` writes it.
  const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1] ?? null;
  return { user: value('UserName'), files: ['StandardOutPath', 'StandardErrorPath'].map(value).filter(Boolean) };
}
const LOG_MODE = 0o644;
const LOG_FOLDER_MODE = 0o755;

/**
 * The folder holding a job's log files, as it stands: { missing }, { refuse: why }, { fix: why, ino, dev } or {}. launchd must pass
 * through it as the job's user, so it has to be 0755. It must also be root's alone: root gives files in it away by name, so one the
 * job's user could change can't be trusted, and is refused, never repaired. Root's folder with the wrong mode or group is what a
 * cut-off run leaves, and is repaired.
 */
function logFolderState(io, dir) {
  let st; try { st = io.lstat(dir); } catch (e) { return e?.code === 'ENOENT' ? { missing: true } : { refuse: `${dir} could not be read (${e?.code ?? e})` }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { refuse: `${dir} exists but is not a plain folder` };
  const unsafe = chainProblem(dir, { owner: io.rootUid, top: dir, lstat: io.lstat, acl: (seen) => aclProblem(seen.map(io.at)) });
  if (unsafe) return { refuse: `${dir} is not safe for root to give files out in (${unsafe})` };
  const mode = st.mode & 0o7777;
  if (mode !== LOG_FOLDER_MODE) return { fix: `${dir} has mode ${mode.toString(8)}, want ${LOG_FOLDER_MODE.toString(8)}`, ino: st.ino, dev: st.dev };
  return st.gid === 0 ? {} : { fix: `${dir} has group ${st.gid}, want 0`, ino: st.ino, dev: st.dev };
}

/** Why a job's log files would stop it, or null, from the job file's text. The check and `daemons load` both ask here. */
function logProblem(io, text) {
  const { user, files } = jobLogs(text);
  if (user === null || files.length === 0) return null;
  const who = readUser(io, user);
  if (!who.exists) return `the user ${user} does not exist`;
  const why = [];
  for (const dir of new Set(files.map(dirname))) { const s = logFolderState(io, dir); if (s.refuse || s.fix) why.push(s.refuse ?? s.fix); }
  for (const f of files) {
    let st = null; try { st = io.lstat(f); } catch { why.push(`${f} is missing`); continue; }
    if (st.isSymbolicLink() || !st.isFile()) why.push(`${f} is not a plain file`);
    else {
      if (st.uid !== who.uid) why.push(`${f} belongs to uid ${st.uid}, not ${user} (${who.uid})`);
      if ((st.mode & 0o7777) !== LOG_MODE) why.push(`${f} has mode ${(st.mode & 0o7777).toString(8)}, want ${LOG_MODE.toString(8)}`);
    }
  }
  return why.length ? why.join('; ') : null;
}

/** Steps that give a job's log files to its user. An existing file keeps what it holds; a link or anything else in its place stops the run. */
function planLogs(io, text) {
  const ops = []; const problems = [];
  const { user, files } = jobLogs(text);
  if (user === null || files.length === 0) return { ops, problems };
  const who = readUser(io, user);
  if (!who.exists) return { ops, problems: [`the user ${user} does not exist, so its job's log files can't be made (run users-folders first); nothing was changed`] };
  const want = { uid: who.uid, gid: who.gid, mode: LOG_MODE };
  for (const f of files) {
    let st = null; try { st = io.lstat(f); } catch (e) { if (e?.code !== 'ENOENT') { problems.push(`${f} could not be read (${e?.code ?? e})`); continue; } }
    if (st === null) { ops.push(op(`make ${f}   (${user}'s, 0644)`, () => io.writeOwned(f, '', want))); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { problems.push(`${f} exists but is not a plain file; nothing was changed`); continue; }
    if (st.uid === who.uid && (st.mode & 0o7777) === LOG_MODE) continue;
    // Giving away a file with a second name gives away whatever that name is.
    if (st.nlink !== 1) { problems.push(`${f} has ${st.nlink} names (a hard link), so its owner can't be set safely; nothing was changed`); continue; }
    ops.push(op(`set owner and mode of ${f}: ${user}'s, 0644`, () => io.secureFile(f, { ...want, ino: st.ino, dev: st.dev })));
  }
  return { ops, problems };
}

const launchctl = (io, args) => io.run(LAUNCHCTL, args);
const failText = (r) => (r.stderr.trim() || r.stdout.trim()).slice(0, 200);

/** → { loaded, state, lastExit } for one job. A job launchd does not know is not an error. */
export function jobState(io, cfg, job) {
  const r = launchctl(io, ['print', `system/${labelOf(cfg, job)}`]);
  if (r.status !== 0) return { loaded: false, error: r.status === 113 ? null : failText(r) };
  return { loaded: true, pid: Number(/^\s*pid = (\d+)$/m.exec(r.stdout)?.[1]) || null, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown', lastExit: /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown' };
}

/** 'loaded' (launchd runs it), 'placed' (its job file is there, so launchd starts it at boot) or null; throws when launchd can't be asked. */
export function jobLive(io, cfg, job) {
  const s = jobState(io, cfg, job);
  if (s.error) throw new Error(`could not ask launchd about ${labelOf(cfg, job)}: ${s.error}`);
  if (s.loaded) return 'loaded';
  try { io.lstat(plistPath(cfg, job)); return 'placed'; } catch { return null; }
}

/** `daemons place`: launchd starts every job file in its folder at boot, with no load to refuse it, so a job file is placed only when load would start the job (L807 M1). */
export function planPlace(io, cfg, jobs = jobsFor(cfg)) {
  const gate = startProblems(io, cfg, jobs);
  if (!gate.length) return { ...placeSteps(io, cfg, jobs), unchecked: startUnchecked(io, cfg, jobs) };
  // A job file placed before still starts at boot; say so (the gate's own lines stay first, as load's).
  const live = (j) => { try { return jobLive(io, cfg, j); } catch { return null; } };   // the gate already refuses; this line only helps
  // Only a job whose own checks fail: a healthy job starting at boot is fine, and taking the review runner out would stop
  // the very run check-dispatcher waits on (r1 M1). The per-job lists together equal the whole-set gate (startProblems
  // checks each job on its own, plus the install, which every job's list carries), so a broken install names every placed job, as the gate refuses them all (r2 c-1).
  // A job whose only lines are "can't tell without root" is not known to be broken: the gate's own line already says to run
  // with sudo, and telling Joe to unload a healthy job would take it out for nothing (L1043, #479 r1 m2).
  const left = jobs.filter((j) => startChecks(io, cfg, [j]).known.length && live(j) !== null).map((j) => `${j}'s job file ${plistPath(cfg, j)} is still in place and launchd starts it at boot: sudo node setup.mjs daemons unload --only ${j}, then delete it`);
  return { ops: [], problems: [...gate, ...left] };
}

/** The job files and their log files, without the start checks: only planPlace calls it outside the tests of the log files. */
export function placeSteps(io, cfg, jobs = jobsFor(cfg)) {
  const P = installPaths(cfg); const ops = []; const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops, problems };
  // The job files go outside the base, into launchd's own folder: it and every folder above it must be root's alone too.
  const above = chainProblem(io.at(DAEMON_DIR), { owner: io.rootUid, top: io.prefix || '/' });
  if (above) return { ops, problems: [`${DAEMON_DIR} is not safe for root to write in (${above}); nothing was changed`] };
  const folder = logFolderState(io, P.logDir);
  if (folder.refuse) return { ops, problems: [`${folder.refuse}; nothing was changed`] };
  const setFolder = (want) => op(`set owner and mode of ${P.logDir}: chown 0:0, chmod 755`, () => io.secure(P.logDir, { uid: io.rootUid, gid: 0, mode: LOG_FOLDER_MODE, ...want }));
  // Made with its final mode, so a run cut off here leaves a folder launchd can pass through.
  if (folder.missing) ops.push(op(`mkdir ${P.logDir}`, () => io.mkdir(P.logDir, LOG_FOLDER_MODE)), setFolder({}));
  else if (folder.fix) ops.push(setFolder({ ino: folder.ino, dev: folder.dev }));
  for (const job of jobs) {
    const f = plistPath(cfg, job);
    let same = false;
    try { const s = io.lstat(f); same = s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && (s.mode & 0o7777) === 0o644 && io.readText(f) === plists[job] && aclProblem([io.at(f)]) === null; } catch { /* not there */ }
    if (same) continue;
    // Written whole beside the name, given its owner and mode, then renamed over the old file (or a link in its place, which the
    // rename replaces, never follows): a cut-off run leaves the old job file, never none (L807 m4).
    ops.push(op(`write ${f}   (root:wheel 0644)`, () => writeAside(io, f, plists[job])));
  }
  for (const job of jobs) { const logs = planLogs(io, plists[job]); ops.push(...logs.ops); problems.push(...logs.problems); }
  return { ops, problems };
}

/** Null, or why no job may be (re)loaded now: a job must not start against a copy that is not whole and root's alone (L149 m8; the same check as check-install). Used by load AND reload-account (L194 M1). */
function installProblem(io, cfg, { watchOnly = false } = {}) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) return 'the install is not there yet (run the install first), so a job would start against nothing';
  const bad = checkInstall(io, cfg, { watchOnly }).filter((r) => !r.ok);
  return bad.length ? `the install check fails (${bad[0].what}: ${bad[0].why})${bad.length > 1 ? `, and ${bad.length - 1} more` : ''}; fix that first (node setup.mjs check-install${watchOnly ? ' --watch-only' : ''} shows all of it)` : null;
}

/**
 * Why these jobs may not start now → problems (none: they may). The one list both place and load refuse on, because a placed
 * job starts at boot without load (L807 M1): the install whole and root's; the watch job's rules; the robot's config and its
 * match with the Dispatcher's; the Dispatcher's config and check-dispatcher. The watch job alone asks only what it uses of the
 * install (L1026): the runner's role map is cutover-night work, and asking for it stopped the watch cutover. Any other job in
 * the list brings the full check.
 */
export function startProblems(io, cfg, jobs) {
  return startChecks(io, cfg, jobs).problems;
}

/** startProblems, and the ones of them that are known: `known` leaves out each line that only says this run could not look without root (L1043). */
function startChecks(io, cfg, jobs) {
  const problems = []; const unknown = new Set();
  const watchOnly = jobs.length > 0 && jobs.every((j) => j === 'watch-only');
  const bad = installProblem(io, cfg, { watchOnly }); if (bad) problems.push(bad);
  if (jobs.includes('watch-only')) {
    let r = null; let denied = null; try { r = io.lstat(watchRulesPath(cfg)); } catch (e) { denied = e?.code === 'EACCES' || e?.code === 'EPERM' ? e.code : null; }
    // L1029: a dry run without root can't look into the folder; that is not the file missing. It is an lstat, so what was
    // refused is the folder, not the file's text (L1043 c1); as root, sudo would not help, so it does not say to use it.
    const asRoot = io.euid?.() === 0;
    if (r) { /* there */ } else if (denied && !asRoot) { const t = `${watchRulesPath(cfg)} can't be looked into without root (run with sudo to check it), so whether the hourly watch job has its rules is not known`; problems.push(t); unknown.add(t); }
    else problems.push(denied ? `${watchRulesPath(cfg)} can't be looked into, even as root (${denied}), so whether the hourly watch job has its rules is not known` : `${watchRulesPath(cfg)} is not there (run watch-rules first), so the hourly watch job would have no rules to judge by`);
  }
  if (jobs.includes(ROBOT_JOB)) {
    const why = robotConfigProblem(io, cfg); if (why) problems.push(`${why}, so the robot job would not start`);
    // With the Dispatcher on, the robot must name its Record and lock, also when only the robot is loaded (self-review M2).
    const apart = why ? null : robotMatchProblem(io, cfg); if (apart) problems.push(`${apart}, so the robot job would not start`);
    // L727: robot.json names the robot App, so its key must be there, or no alert (not even the store-free one) reaches Joe.
    for (const k of robotAppKeyItems(io, cfg)) if (!k.ok) problems.push(`${k.what}: ${k.why}, so the robot job could not send an alert`);
  }
  // The Dispatcher: its config in the copy, then check-dispatcher (L757), before it may start.
  if (jobs.includes(DISPATCHER_JOB)) { const why = dispatcherLoadProblem(io, cfg); if (why) problems.push(why); }
  // The Sensors: their config in the copy, then check-dispatcher (they open the Dispatcher's Record with its rules and token).
  if (jobs.includes(SENSORS_JOB)) { const why = sensorsLoadProblem(io, cfg); if (why && !problems.includes(why)) problems.push(why); }
  return { problems, known: problems.filter((p) => !unknown.has(p)) };
}

/**
 * What startProblems could not look at without root, so a dry run says so instead of reading as a pass (#305 r1 m4): the
 * robot App's key in the orchestrate-only key folder. A real run is root's (setup refuses it otherwise), so this is empty.
 */
export function startUnchecked(io, cfg, jobs) {
  if (!jobs.includes(ROBOT_JOB)) return [];
  return robotAppKeyItems(io, cfg).filter((k) => k.skip).map((k) => `the robot App's key: ${k.what} — ${k.why}`);
}

export function planLoad(io, cfg, jobs = jobsFor(cfg)) {
  const ops = []; const problems = startProblems(io, cfg, jobs);
  const rec = readRecord(io, cfg);
  for (const job of jobs) {
    const text = fileText(io, cfg, job);
    if (text === null) { problems.push(`${plistPath(cfg, job)} is not there (run daemons place first)`); continue; }
    const logs = logProblem(io, text);
    if (logs) { problems.push(`${labelOf(cfg, job)} could not start: ${logs} (run daemons place first)`); continue; }
    const s = jobState(io, cfg, job); const label = labelOf(cfg, job); const h = sha(text);
    if (s.error) { problems.push(`could not ask launchd about ${label}: ${s.error}`); continue; }
    if (s.loaded && rec[label] === h) continue;
    // Loaded from an older file (or not by this tool): launchd keeps running what it first read, so take it out and load the file as it is now.
    if (s.loaded) ops.push(op(`launchctl bootout system/${label}   (it was loaded from a different job file than the one on disk)`, () => { const r = launchctl(io, ['bootout', `system/${label}`]); if (r.status !== 0) throw new Error(`could not unload ${label} (${failText(r)})`); }));
    ops.push(op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${label} (${failText(r)})`); }),
      op(`record the fingerprint of ${label}'s job file in ${recordPath(cfg)}`, () => changeRecord(io, cfg, (x) => { x[label] = h; })),
      readBackOp(io, cfg, job));
  }
  return { ops, problems, unchecked: startUnchecked(io, cfg, jobs) };
}

/** Unload the jobs that are loaded; none loaded → nothing to do, no error. Runner first, so nothing starts while the updater goes. */
export function planUnload(io, cfg, jobs = ALL_JOBS) {
  const ops = []; const problems = [];
  for (const job of [...jobs].reverse()) {
    const s = jobState(io, cfg, job);
    if (s.error) { problems.push(`could not ask launchd about ${labelOf(cfg, job)}: ${s.error}`); continue; }
    if (!s.loaded) continue;
    ops.push(op(`launchctl bootout system/${labelOf(cfg, job)}`, () => { const r = launchctl(io, ['bootout', `system/${labelOf(cfg, job)}`]); if (r.status !== 0) throw new Error(`could not unload ${labelOf(cfg, job)} (${failText(r)})`); }),
      op(`forget ${labelOf(cfg, job)} in ${recordPath(cfg)}`, () => changeRecord(io, cfg, (x) => { delete x[labelOf(cfg, job)]; })));
  }
  return { ops, problems };
}

/**
 * Runbook A8: the account job reloaded so its file carries `--install <the installed copy>` (copy-to refuses without it).
 * A job that is not loaded gives NO steps and a problem (exit 1): either nothing has loaded it yet, or an earlier reload stopped
 * half way; either way the instruction is "run: daemons load". A loaded one gets its file rewritten (only if it differs), then
 * unloaded and loaded again. Nothing else is touched. Like load, it refuses unless the install check passes (L194 M1).
 * Run again with nothing to change (the file is as built AND the job was loaded from it), it does nothing: unloading would only
 * stop a pass that may be running, and the job would come back exactly as it was (L194 m1).
 */
export function planReloadAccount(io, cfg) {
  const job = 'review-account'; const label = labelOf(cfg, job);
  const s = jobState(io, cfg, job);
  if (s.error) return { ops: [], problems: [`could not ask launchd about ${label}: ${s.error}`] };
  if (!s.loaded) {
    // Not loaded AND this tool once loaded it (the fingerprint is still recorded): an earlier reload stopped between the unload and
    // the load, so the job is NOT running. Saying "nothing to do" there would be a false "done" (L150 m2).
    const rec0 = readRecord(io, cfg);
    if (rec0 && rec0[label] !== undefined) return { ops: [], problems: [`${label} is NOT loaded now, though it was loaded before (an earlier reload probably stopped half way). Nothing is running it. Run: daemons load`] };
    return { ops: [], problems: [`the account job (${label}) is not loaded, so there is nothing to reload. Run: daemons load`] };
  }
  const bad = installProblem(io, cfg); if (bad) return { ops: [], problems: [bad] };
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops: [], problems };
  const P = installPaths(cfg);
  if (!plists[job].includes(`<string>--install</string><string>${P.installRoot}</string>`)) return { ops: [], problems: [`the ${job} file this would write does not carry --install ${P.installRoot}; nothing was changed`] };
  const place = planPlace(io, cfg, [job]);
  if (place.problems.length) return place;
  const out = op(`launchctl bootout system/${label}`, () => { const r = launchctl(io, ['bootout', `system/${label}`]); if (r.status !== 0) throw new Error(`could not unload ${label} (${failText(r)})`); });
  const inn = op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${label} (${failText(r)}); run: daemons load`); });
  const text = plists[job]; const h = sha(text);
  if (place.ops.length === 0 && (readRecord(io, cfg) ?? {})[label] === h) return { ops: [], problems: [] };   // already loaded from this very file (m1)
  const rec = op(`record the fingerprint of ${label}'s job file in ${recordPath(cfg)}`, () => changeRecord(io, cfg, (x) => { x[label] = h; }));
  return { ops: [...place.ops, out, inn, rec, readBackOp(io, cfg, job)], problems: [] };
}

export function list(io, cfg, jobs = null) {
  // A job the config leaves off is listed too while launchd still has it loaded, so nothing loaded goes unseen.
  if (jobs === null) jobs = ALL_JOBS.filter((j) => jobsFor(cfg).includes(j) || jobState(io, cfg, j).loaded);
  return jobs.map((job) => ({ job, label: labelOf(cfg, job), ...jobState(io, cfg, job) }));
}

/** Read only → [{ ok, what, why? }]. */
const NEVER = '(never exited)';
export const FIRST_RUN_LIMIT_S = 30 * 60;
// How long one run of `job` may go before it reads as stuck: a Dispatcher pass may run to its deadline and watchdog margin
// (self-review m5); the others, FIRST_RUN_LIMIT_S.
const runLimitS = (job) => (job === DISPATCHER_JOB ? DISPATCHER_RUN_LIMIT_S : job === SENSORS_JOB ? SENSORS_RUN_LIMIT_S : FIRST_RUN_LIMIT_S);
const UNREADABLE = 'unreadable';
/** Seconds the process has been running (`ps -o etime=`: [[dd-]hh:]mm:ss); null if there is no such process any more (ps failed or printed nothing: it ended between the two reads); UNREADABLE if ps answered with something this cannot parse (L180 m5b). */
function runningSeconds(io, pid) {
  const r = io.run('/bin/ps', ['-o', 'etime=', '-p', String(pid)]);
  if (r.status !== 0 || r.stdout.trim() === '') return null;
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout);
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : UNREADABLE;
}
export function checkDaemons(io, cfg, jobs = jobsFor(cfg)) {
  const out = []; const item = (ok, what, why, skip = false) => { if (!skip) out.push({ ok, what, ...(ok ? {} : { why }) }); };
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) { item(false, 'the job files can be built', problems[0]); return out; }
  // A job file under another label is a second copy of a job that launchd may be running too (a changed label leaves the old one behind).
  // It is about the whole set, so a check narrowed with --only leaves it out.
  let names = []; try { names = io.list(DAEMON_DIR); } catch { /* the folder itself is checked by place */ }
  const subset = jobs.length < jobsFor(cfg).length;
  const strayRe = new RegExp(`^([^.].*)\\.(${ALL_JOBS.join('|')})\\.plist$`);   // a hidden file is no job file (r2 review)
  const stray = subset ? [] : names.filter((n) => { const m = strayRe.exec(n); return m && m[1] !== cfg.label; });
  item(stray.length === 0, `no job file in ${DAEMON_DIR} under another label than ${cfg.label}`, `${stray.join(', ')}: a leftover set of jobs (take them out with daemons unload under the old label, then delete the files)`, subset);
  // A side file a cut-off write left (writeAside: `.<label>.<job>.plist.new`) (r1 m1). This label's, for each job checked
  // (under --only too, r2 N4), gets a paste-ready rm, each path single-quoted (r2 N2); another label's only under the whole
  // set, and only named: setup cannot tell it wrote that one, so the line says to check first (r2 N3).
  const ownSide = new Set((subset ? jobs : ALL_JOBS).map((j) => `.${cfg.label}.${j}.plist.new`));
  const sideRe = new RegExp(`^\\.(.+)\\.(${ALL_JOBS.join('|')})\\.plist\\.new$`);
  const own = names.filter((n) => ownSide.has(n)).sort();
  const other = subset ? [] : names.filter((n) => !ownSide.has(n) && sideRe.test(n)).sort();
  const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
  const sideWhy = [
    ...(own.length ? [`${own.map((n) => join(DAEMON_DIR, n)).join(', ')}: left by a write that was cut off; delete ${own.length === 1 ? 'it' : 'them'}: sudo rm ${own.map((n) => q(join(DAEMON_DIR, n))).join(' ')}`] : []),
    ...(other.length ? [`${other.map((n) => join(DAEMON_DIR, n)).join(', ')}: under another label than ${cfg.label}; check ${other.length === 1 ? 'it is' : 'they are'} setup's (a write cut off under an old label) before deleting ${other.length === 1 ? 'it' : 'them'}`] : []),
  ];
  item(sideWhy.length === 0, `no half-written job file${subset ? ` for ${jobs.join(', ')}` : ''} in ${DAEMON_DIR}`, sideWhy.join('; '));   // --only: the row names its jobs, as every row then does
  // The worker runner's job from before L1079 (#528 r1 m9): a LaunchAgent of the owner's, in the owner's own
  // ~/Library/LaunchAgents. Left there it starts a second runner, as the owner, at the owner's next login. Named by its
  // file, whatever its label; a folder that can't be listed is said, never read as "none there".
  if (!subset) {
    const u = readUser(io, cfg.owner); const dir = u.exists && u.home ? join(u.home, 'Library', 'LaunchAgents') : null;
    let agents = null; let why = null;
    if (!dir) why = `the owner ${cfg.owner}'s home could not be read from this Mac, so its LaunchAgents were not looked at`;
    else {
      // Found by what it starts, not by its file's name (#528 r2 m7): every job file there is read, and one that names the
      // worker runner's script is the old runner, under any label. One that can't be read is said, never read as "not it".
      let names = null;
      try { names = io.list(dir).filter((n) => n.endsWith('.plist') && !n.startsWith('.')).sort(); } catch (e) { if (e?.code !== 'ENOENT') why = `${dir} could not be listed (${e?.code ?? 'error'}), so whether the old worker runner's job is left there is not known`; else agents = []; }
      if (names) {
        agents = []; const unread = [];
        for (const n of names) { let t; try { t = io.readText(join(dir, n)); } catch (e) { unread.push([n, e?.code ?? 'error']); continue; } if (t.includes(WORKER_RUNNER_SCRIPT)) agents.push(n); }
        if (unread.length) why = `${unread.map(([n, code]) => `${join(dir, n)} could not be read (${code})`).join(', ')}, so whether ${unread.length === 1 ? 'it is' : 'one is'} the old worker runner's job is not known`;
      }
    }
    item(why === null && agents.length === 0, `no worker runner job left in the owner's LaunchAgents (since L1079 it runs as the builder user, never as the owner)`,
      why ?? `${agents.map((n) => join(dir, n)).join(', ')}: the old worker runner, which would start a second runner as ${cfg.owner}. As ${cfg.owner}: launchctl bootout gui/$(id -u)/<its label>, then delete the file (README, "Moving the workers to the builder user", step 1)`);
  }
  // Each job the config leaves off: none placed or loaded (listed only when there is one).
  const offWhy = { 'watch-only': 'the config names no rules fingerprint', [ROBOT_JOB]: 'the config does not turn the robot job on', [DISPATCHER_JOB]: 'the config has no dispatcher entry', [SENSORS_JOB]: 'the config has no dispatcher entry' };
  for (const off of subset ? [] : OPTIONAL_JOBS.filter((j) => !jobsFor(cfg).includes(j))) {
    const s = jobState(io, cfg, off); let placed = false; try { io.lstat(plistPath(cfg, off)); placed = true; } catch { /* none */ }
    item(!s.loaded && !placed, `no ${labelOf(cfg, off)} job is placed or loaded (${offWhy[off]})`, `${s.loaded ? `it is loaded: take it out with sudo node setup.mjs daemons unload --only ${off}, then` : 'its file is there:'} delete ${plistPath(cfg, off)}`, !s.loaded && !placed);
  }
  if (jobs.includes(ROBOT_JOB)) {
    const why = robotConfigProblem(io, cfg) ?? robotMatchProblem(io, cfg); item(why === null, `the robot job's config in the copy (robot.json) matches this setup`, why);
    // A key that needs root to look at is listed as NEEDS ROOT, never dropped (audit #305 n3): a check without sudo is not a pass.
    for (const k of robotAppKeyItems(io, cfg)) if (k.skip) out.push({ ok: true, skip: true, what: `the robot App's key: ${k.what}`, why: k.why }); else item(k.ok, `the robot App's key: ${k.what}`, k.why);
  }
  if (jobs.includes(DISPATCHER_JOB)) { const why = dispatcherConfigProblem(io, cfg); item(why === null, `the Dispatcher's config in the copy (dispatcher.json) is the one this setup writes`, why); }
  if (jobs.includes(SENSORS_JOB)) { const why = sensorsConfigProblem(io, cfg); item(why === null, `the Sensors' config in the copy (sensors.json) is the one this setup writes`, why); }
  // The Sensors read who is signed in and the usage from the owner's answer: stale, and the Dispatcher starts nothing (L1051).
  if (jobs.includes(SENSORS_JOB)) out.push(...answerRows(io, cfg));
  // check-dispatcher's FAILs only: a NOT TRIED line (no root to look) is not one, so check without sudo stays quiet on it (L807 m3).
  if (jobs.includes(DISPATCHER_JOB) || jobs.includes(SENSORS_JOB)) { const why = dispatcherKeysProblem(io, cfg); item(why === null, 'check-dispatcher has no FAIL', why); }
  const rec = readRecord(io, cfg);
  for (const job of jobs) {
    const f = plistPath(cfg, job); const why = [];
    let st = null; try { st = io.lstat(f); } catch { why.push('missing'); }
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) why.push('is not a plain file');
      else {
        if (st.uid !== io.rootUid) why.push(`owner is uid ${st.uid}, not root`);
        if ((st.mode & 0o7777) !== 0o644) why.push(`mode is ${(st.mode & 0o7777).toString(8)}, want 644`);
        if (io.readText(f) !== plists[job]) why.push('differs from what review-daemons.mjs builds');
        const acl = aclProblem([io.at(f)]); if (acl) why.push(acl);
      }
    }
    item(why.length === 0, `${f} is root's 0644 and exactly the built job file`, why.join('; '));
    const s = jobState(io, cfg, job); const label = labelOf(cfg, job);
    const { user, files } = jobLogs(plists[job]);
    if (user !== null && files.length) { const logs = logProblem(io, plists[job]); item(logs === null, `${label}'s log files are ${user}'s, 0644, so launchd can open them`, logs ? `${logs}; run daemons place` : undefined); }
    item(s.loaded, `${label} is loaded`, s.error ?? 'not loaded');
    if (!s.loaded) continue;
    const text = fileText(io, cfg, job);
    item(text !== null && rec[label] === sha(text), `${label} was loaded from the job file as it is now`, 'it runs an older definition than the file on disk (or was not loaded by this tool); run daemons load, which reloads it');
    item(s.lastExit === '0', `${label}'s last run ended well (exit 0)`, s.lastExit === NEVER ? undefined : `last exit code ${s.lastExit}; look in ${installPaths(cfg).logDir}`, s.lastExit === NEVER);
    if (s.pid && s.lastExit !== NEVER) {
      // A later run that hangs leaves the job running, and launchd starts no new run while one is going: the last exit would stay green.
      const age = runningSeconds(io, s.pid);
      item(age === null || (age !== UNREADABLE && age <= runLimitS(job)), `${label}'s current run is not stuck (at most ${Math.ceil(runLimitS(job) / 60)} minutes)`, age === UNREADABLE ? `ps answered with something that could not be read, so how long this run has been going is not known; look in ${installPaths(cfg).logDir}` : `this run has been going for ${Math.round(age / 60)} minutes and has not ended; look in ${installPaths(cfg).logDir}`);
    }
    if (s.lastExit === NEVER) {
      // It has not finished a run yet. Every job starts at load and then runs on a timer, so this is fine only while its first run is young.
      const age = s.pid ? runningSeconds(io, s.pid) : null;
      item(age !== null && age !== UNREADABLE && age <= runLimitS(job), `${label} is on its first run, and not for long (at most ${Math.ceil(runLimitS(job) / 60)} minutes)`,
        age === null ? `it is loaded but has no running process and has never finished a run; look in ${installPaths(cfg).logDir}` : age === UNREADABLE ? `ps answered with something that could not be read, so how long the first run has been going is not known; look in ${installPaths(cfg).logDir}` : `its first run has been going for ${Math.round(age / 60)} minutes and has not ended; look in ${installPaths(cfg).logDir}`);
    }
  }
  return out;
}
