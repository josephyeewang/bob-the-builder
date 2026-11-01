// Setup part 2b (PR 2): the three background jobs (LaunchDaemons). The plist texts come from review-daemons.mjs (the one
// place that builds them); this file puts them where launchd looks, and loads, lists and unloads them.
//
//   place    write the three plists into /Library/LaunchDaemons, root:wheel 0644 (launchd refuses any other owner or mode)
//   load     launchctl bootstrap system <plist>, for each job not loaded yet; refuses until the install is there
//   unload   launchctl bootout system/<label>, for each job that is loaded
//   list     launchctl print system/<label>: loaded or not, state, last exit code (read only)
//   check    read only: the files are exactly what review-daemons.mjs builds, root's 0644, no access list; the jobs are loaded
//
// Paths inside the plists are the real ones (no test prefix); the plist files themselves sit under io.at().

import { join } from 'node:path';
import { reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { RUNNER_CONFIG, aclProblem, currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';

export const DAEMON_DIR = '/Library/LaunchDaemons';
const LAUNCHCTL = '/bin/launchctl';
export const JOBS = Object.freeze(['review-updater', 'review-account', 'review-runner']);   // load order: the updater first
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
  return { plists: { 'review-runner': two.runner, 'review-account': two.accountCopy, 'review-updater': updaterPlist(common) }, problems };
}

const launchctl = (io, args) => io.run(LAUNCHCTL, args);
const failText = (r) => (r.stderr.trim() || r.stdout.trim()).slice(0, 200);

/** → { loaded, state, lastExit } for one job. A job launchd does not know is not an error. */
export function jobState(io, cfg, job) {
  const r = launchctl(io, ['print', `system/${labelOf(cfg, job)}`]);
  if (r.status !== 0) return { loaded: false, error: r.status === 113 ? null : failText(r) };
  return { loaded: true, state: /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown', lastExit: /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? 'unknown' };
}

export function planPlace(io, cfg) {
  const P = installPaths(cfg); const ops = []; const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) return { ops, problems };
  let st = null; try { st = io.lstat(P.logDir); } catch (e) { if (e?.code !== 'ENOENT') return { ops, problems: [`${P.logDir} could not be read (${e?.code ?? e})`] }; }
  if (st === null) ops.push(op(`mkdir ${P.logDir}`, () => io.mkdir(P.logDir, 0o700)), op(`chown 0:0 ${P.logDir}`, () => io.chown(P.logDir, io.rootUid, 0)), op(`chmod 755 ${P.logDir}`, () => io.chmod(P.logDir, 0o755)));
  else if (st.isSymbolicLink() || !st.isDirectory()) return { ops, problems: [`${P.logDir} exists but is not a plain folder; nothing was changed`] };
  for (const job of JOBS) {
    const f = plistPath(cfg, job);
    let same = false;
    try { const s = io.lstat(f); same = s.isFile() && !s.isSymbolicLink() && s.uid === io.rootUid && (s.mode & 0o7777) === 0o644 && io.readText(f) === plists[job] && aclProblem([io.at(f)]) === null; } catch { /* not there */ }
    if (same) continue;
    // Written whole to a new name, then renamed over, so launchd never reads half a file; removed first if it is a link.
    ops.push(op(`write ${f}   (root:wheel 0644)`, () => { io.rm(f); io.write(f, plists[job], 0o600); io.chown(f, io.rootUid, 0); io.chmod(f, 0o644); }));
  }
  return { ops, problems };
}

export function planLoad(io, cfg) {
  const P = installPaths(cfg); const ops = []; const problems = [];
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) problems.push('the install is not there yet (run the install first), so a job would start against nothing');
  for (const job of JOBS) {
    try { io.lstat(plistPath(cfg, job)); } catch { problems.push(`${plistPath(cfg, job)} is not there (run daemons place first)`); continue; }
    const s = jobState(io, cfg, job);
    if (s.error) { problems.push(`could not ask launchd about ${labelOf(cfg, job)}: ${s.error}`); continue; }
    if (s.loaded) continue;
    ops.push(op(`launchctl bootstrap system ${io.at(plistPath(cfg, job))}`, () => { const r = launchctl(io, ['bootstrap', 'system', io.at(plistPath(cfg, job))]); if (r.status !== 0) throw new Error(`could not load ${labelOf(cfg, job)} (${failText(r)})`); }));
  }
  return { ops, problems };
}

/** Unload the jobs that are loaded; none loaded → nothing to do, no error. Runner first, so nothing starts while the updater goes. */
export function planUnload(io, cfg) {
  const ops = []; const problems = [];
  for (const job of [...JOBS].reverse()) {
    const s = jobState(io, cfg, job);
    if (s.error) { problems.push(`could not ask launchd about ${labelOf(cfg, job)}: ${s.error}`); continue; }
    if (!s.loaded) continue;
    ops.push(op(`launchctl bootout system/${labelOf(cfg, job)}`, () => { const r = launchctl(io, ['bootout', `system/${labelOf(cfg, job)}`]); if (r.status !== 0) throw new Error(`could not unload ${labelOf(cfg, job)} (${failText(r)})`); }));
  }
  return { ops, problems };
}

export function list(io, cfg) {
  return JOBS.map((job) => ({ job, label: labelOf(cfg, job), ...jobState(io, cfg, job) }));
}

/** Read only → [{ ok, what, why? }]. */
export function checkDaemons(io, cfg) {
  const out = []; const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const { plists, problems } = plistTexts(io, cfg);
  if (problems.length) { item(false, 'the job files can be built', problems[0]); return out; }
  for (const job of JOBS) {
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
