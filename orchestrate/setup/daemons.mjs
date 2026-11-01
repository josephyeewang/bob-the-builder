// Setup part 2b (PR 2): the three background jobs (LaunchDaemons). The plist texts come from review-daemons.mjs (the one
// place that builds them); this file puts them where launchd looks, and loads, lists and unloads them.
//
//   place    write the three plists (four with the hourly watch-only job, when the config has `watch`) into /Library/LaunchDaemons, root:wheel 0644 (launchd refuses any other owner or mode)
//   load     launchctl bootstrap system <plist>, for each job not loaded yet; refuses until the install is there
//   unload   launchctl bootout system/<label>, for each job that is loaded
//   list     launchctl print system/<label>: loaded or not, state, last exit code (read only)
//   check    read only: the files are exactly what review-daemons.mjs builds, root's 0644, no access list; the jobs are loaded
//
// Paths inside the plists are the real ones (no test prefix); the plist files themselves sit under io.at().

import { join } from 'node:path';
import { reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { RUNNER_CONFIG, aclProblem, chainProblem, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';
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

/** The three plist texts, from the layout and the owner's record. → { plists: {job: text}, problems } */
export function plistTexts(io, cfg) {
  const P = installPaths(cfg); const problems = [];
  const owner = readUser(io, cfg.owner);
  if (!owner.exists || !Number.isInteger(owner.uid) || owner.uid <= 0) { problems.push(`the owner's Mac user ${cfg.owner} was not found`); return { plists: {}, problems }; }
  const common = { label: cfg.label, installRoot: P.installRoot, logDir: P.logDir };
  const two = reviewDaemonPlists({ ...common, config: join(P.installRoot, RUNNER_CONFIG), reviewRoot: P.reviewRoot, reviewHome: homeOf(cfg, 'review'), accountCopy: P.accountCopy, ownerHome: owner.home, ownerUid: owner.uid });
  const plists = { 'review-runner': two.runner, 'review-account': two.accountCopy, 'review-updater': updaterPlist(common) };
  if (cfg.watch) plists['watch-only'] = watchPlist(io, cfg);
  return { plists, problems };
}

const launchctl = (io, args) => io.run(LAUNCHCTL, args);
const failText = (r) => (r.stderr.trim() || r.stdout.trim()).slice(0, 200);

/** → { loaded, state, lastExit } for one job. A job launchd does not know is not an error. */
export function jobState(io, cfg, job) {
  const r = launchctl(io, ['print', `system/${labelOf(cfg, job)}`]);
  if (r.status !== 0) return { loaded: false, error: r.status === 113 ? null : failText(r) };
  return { loaded: true, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown', lastExit: /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown' };
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
    // Written whole to a new name, then renamed over, so launchd never reads half a file; removed first if it is a link.
    ops.push(op(`write ${f}   (root:wheel 0644)`, () => { io.rm(f); io.write(f, plists[job], 0o600); io.secureFile(f, { uid: io.rootUid, gid: 0, mode: 0o644 }); }));
  }
  return { ops, problems };
}

export function planLoad(io, cfg, jobs = jobsFor(cfg)) {
  const P = installPaths(cfg); const ops = []; const problems = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) problems.push('the install is not there yet (run the install first), so a job would start against nothing');
  if (cfg.watch && jobs.includes('watch-only')) {
    let r = null; try { r = io.lstat(watchRulesPath(cfg)); } catch { /* below */ }
    if (!r) problems.push(`${watchRulesPath(cfg)} is not there (run watch-rules first), so the hourly watch job would have no rules to judge by`);
  }
  for (const job of jobs) {
    try { io.lstat(plistPath(cfg, job)); } catch { problems.push(`${plistPath(cfg, job)} is not there (run daemons place first)`); continue; }
    const s = jobState(io, cfg, job);
    if (s.error) { problems.push(`could not ask launchd about ${labelOf(cfg, job)}: ${s.error}`); continue; }
    if (s.loaded) continue;
    ops.push(op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${labelOf(cfg, job)} (${failText(r)})`); }));
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
    ops.push(op(`launchctl bootout system/${labelOf(cfg, job)}`, () => { const r = launchctl(io, ['bootout', `system/${labelOf(cfg, job)}`]); if (r.status !== 0) throw new Error(`could not unload ${labelOf(cfg, job)} (${failText(r)})`); }));
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
  if (!s.loaded) return { ops: [], problems: [] };
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops: [], problems };
  const P = installPaths(cfg);
  if (!plists[job].includes(`<string>--install</string><string>${P.installRoot}</string>`)) return { ops: [], problems: [`the ${job} file this would write does not carry --install ${P.installRoot}; nothing was changed`] };
  const place = planPlace(io, cfg, [job]);
  if (place.problems.length) return place;
  const out = op(`launchctl bootout system/${label}`, () => { const r = launchctl(io, ['bootout', `system/${label}`]); if (r.status !== 0) throw new Error(`could not unload ${label} (${failText(r)})`); });
  const inn = op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${label} (${failText(r)}); run: daemons load`); });
  return { ops: [...place.ops, out, inn], problems: [] };
}

export function list(io, cfg, jobs = jobsFor(cfg)) {
  return jobs.map((job) => ({ job, label: labelOf(cfg, job), ...jobState(io, cfg, job) }));
}

/** Read only → [{ ok, what, why? }]. */
export function checkDaemons(io, cfg, jobs = jobsFor(cfg)) {
  const out = []; const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) { item(false, 'the job files can be built', problems[0]); return out; }
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
    const s = jobState(io, cfg, job);
    item(s.loaded, `${labelOf(cfg, job)} is loaded`, s.error ?? 'not loaded');
  }
  return out;
}
