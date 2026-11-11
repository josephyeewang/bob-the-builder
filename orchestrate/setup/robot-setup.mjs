// Setup part 5: the robot job (R-0b-162 B; LEAD-CALLS L236, L238, L610). The one job that holds the robot's write key.
//
//   the job <label>.robot   runs as `orchestrate` (the Record's owner and the key folder's, L238), from the installed copy,
//                           `wiring/robot-main.mjs <copy>/robot.json`, every 60 s and once at load (M11 login-job.mjs, the
//                           one builder of the Dispatcher-shaped jobs, with its own log names); placed, loaded, listed and
//                           checked with the other jobs by daemons.mjs, with the same log rule
//   robot.json              its config, carried into the copy as one of the install's extras (so the updater keeps it on
//                           every update, like review.json); root's 0644. Setup checks the values it knows itself (the
//                           wiring, the install, the Record's owner, the key folder, the two lock files); the job's own
//                           start check (robot-wiring.mjs wire) checks the rest, and a refused start is exit 1 in the job's
//                           last run, which `daemons check` fails on
//   the two locks           (L740, audit #292 M1) the robot's lock is at one place setup owns, `<orchestrate home>/robot.lock`
//                           (as keyDir is `<base>/keys`). Each lock path must be written plainly (no `.`, `..` or `//`), and
//                           its folder must exist as a plain folder, not a link, written by no group or other and with no
//                           access list, with every folder above it root's: the robot's orchestrate's, the Dispatcher's
//                           orchestrate's or root's. So no worker can plant a lock, and a lock that can't be taken is found
//                           here. robot-main is the other half: any lock it cannot take is a non-zero exit, which `check`
//                           fails on.
//
// Off unless the config says `"robot": true`. Nothing here names a product or a person.

import { dirname, isAbsolute, join, posix } from 'node:path';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { NODE, aclProblem, chainProblem, installProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { CONFIG_KEYS as ROBOT_KEYS, appProblem } from '../wiring/robot-wiring.mjs';
// The robot App's key file name: token.mjs owns it (L1471) and mints from it when the wiring names no keyFile (it names none).
import { ROBOT_KEY_FILE } from '../modules/M6-merge-gate/token.mjs';
import { homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { keyFileItems } from './watch-setup.mjs';

export const ROBOT_JOB = 'robot';
export const ROBOT_CONFIG = 'robot.json';
export const ROBOT_MAIN = 'wiring/robot-main.mjs';
export const ROBOT_WIRING = 'wiring/robot-wiring.mjs';
export const ROBOT_USER = 'orchestrate';
export const ROBOT_LOCK = 'robot.lock';
/** Where the robot's round lock lives, as the job sees it: in orchestrate's home, a folder only orchestrate can write (L740). */
export const robotLockOf = (io, cfg) => io.at(join(homeOf(cfg, ROBOT_USER), ROBOT_LOCK));

/**
 * Why a lock file's folder would let the lock be planted or never taken, or null (L740). `file` is as the job sees it (io.at);
 * `owners`: the uids that may own its folder, read through io.lstat as the job folders are; every folder above it must be root's,
 * walked as baseChainProblem walks the base's.
 */
export function lockFolderProblem(io, file, owners) {
  const pre = io.prefix || '';
  if (pre && !file.startsWith(`${pre}/`)) return `it is not under ${pre}`;
  const dir = dirname(file.slice(pre.length));
  let st; try { st = io.lstat(dir); } catch { return `its folder ${dir} is missing`; }
  if (st.isSymbolicLink()) return `its folder ${dir} is a link`;
  if (!st.isDirectory()) return `its folder ${dir} is not a folder`;
  if (!owners.includes(st.uid)) return `its folder ${dir} is owned by uid ${st.uid}, which may not hold this lock`;
  if (st.mode & 0o022) return `its folder ${dir} can be written by its group or others`;
  const above = chainProblem(io.at(dirname(dir)), { owner: io.rootUid, top: pre || '/' });   // as baseChainProblem: root's, up to /
  if (above) return `a folder above it: ${above}`;
  const acl = aclProblem([io.at(dir)]);
  return acl ? `its folder: ${acl}` : null;
}
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Said wherever the config turns the robot on but its extras carry no robot.json. */
export const ROBOT_NO_CONFIG = `config: "robot": true needs the robot's config among the extras, as a file named ${ROBOT_CONFIG} (the install carries it into the copy, and every update keeps it)`;

/** The robot job's plist text. Built by M11's loginJobPlist, so its beat, PATH and user rules are the Dispatcher's; plus HOME and Umask 63. */
export function robotPlist(cfg) {
  const P = installPaths(cfg);
  return loginJobPlist({
    label: `${cfg.label}.${ROBOT_JOB}`, node: join(P.installRoot, NODE), script: join(P.installRoot, ROBOT_MAIN), config: join(P.installRoot, ROBOT_CONFIG),
    path: PATH, logDir: P.logDir, workDir: homeOf(cfg, ROBOT_USER), userName: ROBOT_USER, logName: ROBOT_JOB,
    home: homeOf(cfg, ROBOT_USER), umask: 0o77,   // as the watch job, which runs as the same user: what it makes is its own alone
  });
}

/** `"robot": true` must come with a robot.json among the extras. → the parsed flag, or throws. */
export function parseRobot(raw, extras) {
  if (raw === undefined || raw === false) return false;
  if (raw !== true) throw new Error('config: robot must be true or false');
  if (!extras.some((e) => posix.basename(e) === ROBOT_CONFIG)) throw new Error(ROBOT_NO_CONFIG);
  return true;
}

/**
 * Why the robot's config in the copy would not start the job as setup laid it out, or null. Read only. Checks only what setup
 * itself knows; the job's own start checks the rest. Every path is the one the job will see (io.at), as review.json's installRoot.
 */
export function robotConfigProblem(io, cfg) {
  return robotConfigRead(io, cfg).problem;
}

/**
 * When the copy's robot.json names the robot App (its four keys, all good): the key-file items for its key in the robot key
 * folder; [] when it names none or cannot be read (robotConfigProblem says why). Root to look, else a skip.
 */
export function robotAppKeyItems(io, cfg) {
  const { config } = robotConfigRead(io, cfg);
  if (!config || config.appId === undefined || appProblem(config) !== null) return [];
  return keyFileItems(io, join(cfg.base, 'keys', ROBOT_KEY_FILE));
}

function robotConfigRead(io, cfg) {
  let config = null;
  const problem = robotConfigCheck(io, cfg, (c) => { config = c; });
  return { problem, config };
}

function robotConfigCheck(io, cfg, seen) {
  const P = installPaths(cfg); const root = io.at(P.installRoot); const file = join(root, ROBOT_CONFIG);
  let here = true; try { io.lstatReal(file); } catch { here = false; }
  if (!here) return `${join(P.installRoot, ROBOT_CONFIG)} is not in the copy (it comes in as one of the install's extras)`;
  const bad = installProblem(root, [file], { owner: io.rootUid, top: io.prefix || '/' });
  if (bad) return `${ROBOT_CONFIG} in the copy is not root's alone: ${bad}`;
  let c; try { c = JSON.parse(io.readText(join(P.installRoot, ROBOT_CONFIG))); } catch { return `${ROBOT_CONFIG} in the copy is not JSON`; }   // never the parser's words: they quote the file
  if (!c || typeof c !== 'object' || Array.isArray(c)) return `${ROBOT_CONFIG} in the copy is not a JSON object`;
  seen(c);
  const why = [];
  const extra = Object.keys(c).filter((k) => !ROBOT_KEYS.includes(k));
  if (extra.length) why.push(`it has keys the robot job does not take: ${extra.slice(0, 5).join(', ')}`);
  const orch = readUser(io, ROBOT_USER);
  const want = { wiring: join(root, ROBOT_WIRING), keyDir: io.at(join(cfg.base, 'keys')), ...('installRoot' in c ? { installRoot: root } : {}) };
  for (const [k, v] of Object.entries(want)) if (c[k] !== v) why.push(`${k} must be ${v}`);
  if (!orch.exists) why.push(`the ${ROBOT_USER} user does not exist (run users-folders first)`);
  else if (c.ownerUid !== orch.uid) why.push(`ownerUid must be ${orch.uid}, ${ROBOT_USER}'s (the Record's owner; the job refuses to run as anyone else)`);
  const plain = {};
  for (const k of ['lockFile', 'dispatcherLockFile']) {
    if (typeof c[k] !== 'string' || !isAbsolute(c[k])) why.push(`${k} must be a full path`);
    else if (posix.normalize(c[k]) !== c[k] || c[k].split('/').includes('..') || c[k].endsWith('/')) why.push(`${k} must be written plainly, with no . or .. and no doubled /`);
    else plain[k] = c[k];
  }
  if (typeof c.lockFile === 'string' && c.lockFile === c.dispatcherLockFile) why.push("lockFile is the Dispatcher's lock (dispatcherLockFile): the robot needs a lock of its own");
  for (const k of Object.keys(plain)) if (plain[k] === root || plain[k].startsWith(`${root}/`) || plain[k].startsWith(`${io.at(P.install)}/`)) { why.push(`${k} is inside the install, which only root can write`); delete plain[k]; }
  const wantLock = robotLockOf(io, cfg);
  if (typeof c.lockFile === 'string' && c.lockFile !== wantLock) why.push(`lockFile must be ${wantLock}, in ${ROBOT_USER}'s home, a folder only it can write`);
  else if (plain.lockFile && orch.exists) { const bad = lockFolderProblem(io, plain.lockFile, [orch.uid]); if (bad) why.push(`lockFile: ${bad}`); }
  if (plain.dispatcherLockFile && orch.exists) {
    const bad = lockFolderProblem(io, plain.dispatcherLockFile, [orch.uid, io.rootUid]);
    if (bad) why.push(`dispatcherLockFile: ${bad}`);
  }
  if (c.runDeadlineMs !== undefined && !(Number.isFinite(c.runDeadlineMs) && c.runDeadlineMs > 0)) why.push('runDeadlineMs must be a positive number');
  // L727: the robot App's four keys (appId, appInstallation, alertRepo, alertOwner) go together, all or none; the wiring's
  // own rule, so setup and the job can't disagree. None is allowed: the deliver pass then refuses as not wired.
  const app = appProblem(c); if (app) why.push(app);
  return why.length ? `${ROBOT_CONFIG} in the copy does not match this setup: ${why.join('; ')}` : null;
}
