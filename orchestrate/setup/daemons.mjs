// Setup part 2b (PR 2): the three background jobs (LaunchDaemons). The plist texts come from review-daemons.mjs (the one
// place that builds them); this file puts them where launchd looks, and loads, lists and unloads them.
//
//   place    write the three plists (four with the hourly watch-only job, when the config has `watch`) into /Library/LaunchDaemons, root:wheel 0644 (launchd refuses any other owner or mode)
//   load     launchctl bootstrap system <plist>, for each job not loaded yet; a job loaded from an OLDER file is reloaded (bootout, then
//            bootstrap); refuses unless the install check passes. It records the fingerprint of each file it loaded
//            (<base>/install/loaded-jobs.json, root's) so `check` can tell a loaded job from a file that has since changed
//   unload   launchctl bootout system/<label>, for each job that is loaded
//   list     launchctl print system/<label>: loaded or not, state, last exit code (read only)
//   check    read only: the files are exactly what review-daemons.mjs builds, root's 0644, no access list; no job file left under
//            another label; each job is loaded, from the file as it is now, and its last run ended with exit 0
//
// Paths inside the plists are the real ones (no test prefix); the plist files themselves sit under io.at().

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { RUNNER_CONFIG, aclProblem, chainProblem, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { homeOf } from './layout.mjs';
import { checkInstall, installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { watchPlist } from './watch-setup.mjs';
import { watchRulesPath } from './layout.mjs';

export const DAEMON_DIR = '/Library/LaunchDaemons';
const LAUNCHCTL = '/bin/launchctl';
export const JOBS = Object.freeze(['review-updater', 'review-account', 'review-runner']);   // load order: the updater first
// The hourly watch-only job (watch-setup.mjs) is a fourth job only when the config has a `watch` entry.
export const jobsFor = (cfg) => (cfg.watch ? [...JOBS, 'watch-only'] : [...JOBS]);
/** `--only <job>`: that one job, or a clear refusal naming the jobs there are (the watch job exists only when the config has a `watch` entry). */
export function onlyJobs(cfg, name) {
  const all = jobsFor(cfg);
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
function changeRecord(io, cfg, fn) { const rec = readRecord(io, cfg); fn(rec); const f = recordPath(cfg); io.rm(f); io.write(f, `${JSON.stringify(rec, null, 1)}\n`, 0o600); io.secureFile(f, { uid: io.rootUid, gid: 0, mode: 0o644 }); }
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
    if (cfg.watch) plists['watch-only'] = watchPlist(io, cfg);
    return { plists, problems };
  } catch (e) { return { plists: {}, problems: [`the job files cannot be built from the owner's Mac user ${cfg.owner} (${e.message}); is its home folder set?`] }; }
}

const launchctl = (io, args) => io.run(LAUNCHCTL, args);
const failText = (r) => (r.stderr.trim() || r.stdout.trim()).slice(0, 200);

/** → { loaded, state, lastExit } for one job. A job launchd does not know is not an error. */
export function jobState(io, cfg, job) {
  const r = launchctl(io, ['print', `system/${labelOf(cfg, job)}`]);
  if (r.status !== 0) return { loaded: false, error: r.status === 113 ? null : failText(r) };
  return { loaded: true, pid: Number(/^\s*pid = (\d+)$/m.exec(r.stdout)?.[1]) || null, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown', lastExit: /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown' };
}

export function planPlace(io, cfg, jobs = jobsFor(cfg)) {
  const P = installPaths(cfg); const ops = []; const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops, problems };
  // The job files go outside the base, into launchd's own folder: it and every folder above it must be root's alone too.
  const above = chainProblem(io.at(DAEMON_DIR), { owner: io.rootUid, top: io.prefix || '/' });
  if (above) return { ops, problems: [`${DAEMON_DIR} is not safe for root to write in (${above}); nothing was changed`] };
  let st = null; try { st = io.lstat(P.logDir); } catch (e) { if (e?.code !== 'ENOENT') return { ops, problems: [`${P.logDir} could not be read (${e?.code ?? e})`] }; }
  if (st === null) ops.push(op(`mkdir ${P.logDir}`, () => io.mkdir(P.logDir, 0o700)), op(`set owner and mode of ${P.logDir}: chown 0:0, chmod 755`, () => io.secure(P.logDir, { uid: io.rootUid, gid: 0, mode: 0o755 })));
  else if (st.isSymbolicLink() || !st.isDirectory()) return { ops, problems: [`${P.logDir} exists but is not a plain folder; nothing was changed`] };
  for (const job of jobs) {
    const f = plistPath(cfg, job);
    let same = false;
    try { const s = io.lstat(f); same = s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && (s.mode & 0o7777) === 0o644 && io.readText(f) === plists[job] && aclProblem([io.at(f)]) === null; } catch { /* not there */ }
    if (same) continue;
    // The old file (or a link in its place) is removed, a new one is made with a private mode, and only then are its owner and mode set
    // through the open handle; launchd refuses a file with any other owner or mode, so a cut-off run leaves a file it will not load.
    ops.push(op(`write ${f}   (root:wheel 0644)`, () => { io.rm(f); io.write(f, plists[job], 0o600); io.secureFile(f, { uid: io.rootUid, gid: 0, mode: 0o644 }); }));
  }
  return { ops, problems };
}

export function planLoad(io, cfg, jobs = jobsFor(cfg)) {
  const P = installPaths(cfg); const ops = []; const problems = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) problems.push('the install is not there yet (run the install first), so a job would start against nothing');
  else {
    // A job must not start against a copy that is not whole and root's alone (L149 m8): the same check as check-install.
    const bad = checkInstall(io, cfg).filter((r) => !r.ok);
    if (bad.length) problems.push(`the install check fails (${bad[0].what}: ${bad[0].why})${bad.length > 1 ? `, and ${bad.length - 1} more` : ''}; fix that first (node setup.mjs check-install shows all of it)`);
  }
  if (cfg.watch && jobs.includes('watch-only')) {
    let r = null; try { r = io.lstat(watchRulesPath(cfg)); } catch { /* below */ }
    if (!r) problems.push(`${watchRulesPath(cfg)} is not there (run watch-rules first), so the hourly watch job would have no rules to judge by`);
  }
  const rec = readRecord(io, cfg);
  for (const job of jobs) {
    const text = fileText(io, cfg, job);
    if (text === null) { problems.push(`${plistPath(cfg, job)} is not there (run daemons place first)`); continue; }
    const s = jobState(io, cfg, job); const label = labelOf(cfg, job); const h = sha(text);
    if (s.error) { problems.push(`could not ask launchd about ${label}: ${s.error}`); continue; }
    if (s.loaded && rec[label] === h) continue;
    // Loaded from an older file (or not by this tool): launchd keeps running what it first read, so take it out and load the file as it is now.
    if (s.loaded) ops.push(op(`launchctl bootout system/${label}   (it was loaded from a different job file than the one on disk)`, () => { const r = launchctl(io, ['bootout', `system/${label}`]); if (r.status !== 0) throw new Error(`could not unload ${label} (${failText(r)})`); }));
    ops.push(op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${label} (${failText(r)})`); }),
      op(`record the fingerprint of ${label}'s job file in ${recordPath(cfg)}`, () => changeRecord(io, cfg, (x) => { x[label] = h; })),
      readBackOp(io, cfg, job));
  }
  return { ops, problems };
}

/** Unload the jobs that are loaded; none loaded → nothing to do, no error. Runner first, so nothing starts while the updater goes. */
export function planUnload(io, cfg, jobs = jobsFor(cfg)) {
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
 * A job that is not loaded gives NO steps and no error: there is nothing running on an old file. A loaded one gets its file
 * rewritten (only if it differs), then unloaded and loaded again. Nothing else is touched.
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
    return { ops: [], problems: [] };
  }
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops: [], problems };
  const P = installPaths(cfg);
  if (!plists[job].includes(`<string>--install</string><string>${P.installRoot}</string>`)) return { ops: [], problems: [`the ${job} file this would write does not carry --install ${P.installRoot}; nothing was changed`] };
  const place = planPlace(io, cfg, [job]);
  if (place.problems.length) return place;
  const out = op(`launchctl bootout system/${label}`, () => { const r = launchctl(io, ['bootout', `system/${label}`]); if (r.status !== 0) throw new Error(`could not unload ${label} (${failText(r)})`); });
  const inn = op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${label} (${failText(r)}); run: daemons load`); });
  const text = plists[job]; const h = sha(text);
  const rec = op(`record the fingerprint of ${label}'s job file in ${recordPath(cfg)}`, () => changeRecord(io, cfg, (x) => { x[label] = h; }));
  return { ops: [...place.ops, out, inn, rec, readBackOp(io, cfg, job)], problems: [] };
}

export function list(io, cfg, jobs = jobsFor(cfg)) {
  return jobs.map((job) => ({ job, label: labelOf(cfg, job), ...jobState(io, cfg, job) }));
}

/** Read only → [{ ok, what, why? }]. */
const NEVER = '(never exited)';
export const FIRST_RUN_LIMIT_S = 30 * 60;
/** Seconds the process has been running (`ps -o etime=`: [[dd-]hh:]mm:ss), or null if it cannot be read. */
function runningSeconds(io, pid) {
  const r = io.run('/bin/ps', ['-o', 'etime=', '-p', String(pid)]);
  const m = r.status === 0 ? /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout) : null;
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}
export function checkDaemons(io, cfg, jobs = jobsFor(cfg)) {
  const out = []; const item = (ok, what, why, skip = false) => { if (!skip) out.push({ ok, what, ...(ok ? {} : { why }) }); };
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) { item(false, 'the job files can be built', problems[0]); return out; }
  // A job file under another label is a second copy of a job that launchd may be running too (a changed label leaves the old one behind).
  let names = []; try { names = io.list(DAEMON_DIR); } catch { /* the folder itself is checked by place */ }
  const stray = names.filter((n) => { const m = /^(.+)\.(review-updater|review-account|review-runner)\.plist$/.exec(n); return m && m[1] !== cfg.label; });
  item(stray.length === 0, `no job file in ${DAEMON_DIR} under another label than ${cfg.label}`, `${stray.join(', ')}: a leftover set of jobs (take them out with daemons unload under the old label, then delete the files)`);
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
    item(s.loaded, `${label} is loaded`, s.error ?? 'not loaded');
    if (!s.loaded) continue;
    const text = fileText(io, cfg, job);
    item(text !== null && rec[label] === sha(text), `${label} was loaded from the job file as it is now`, 'it runs an older definition than the file on disk (or was not loaded by this tool); run daemons load, which reloads it');
    item(s.lastExit === '0', `${label}'s last run ended well (exit 0)`, s.lastExit === NEVER ? undefined : `last exit code ${s.lastExit}; look in ${installPaths(cfg).logDir}`, s.lastExit === NEVER);
    if (s.lastExit === NEVER) {
      // It has not finished a run yet. Every job starts at load and then runs on a timer, so this is fine only while its first run is young.
      const age = s.pid ? runningSeconds(io, s.pid) : null;
      item(age !== null && age <= FIRST_RUN_LIMIT_S, `${label} is on its first run, and not for long (at most ${FIRST_RUN_LIMIT_S / 60} minutes)`,
        age === null ? `it is loaded but has no running process and has never finished a run; look in ${installPaths(cfg).logDir}` : `its first run has been going for ${Math.round(age / 60)} minutes and has not ended; look in ${installPaths(cfg).logDir}`);
    }
  }
  return out;
}
