// Setup part 6: the Dispatcher's config and its background job (R-0b-162; LEAD-CALLS L748, L757). Built the robot job's way
// (robot-setup.mjs): one job, run as `orchestrate`, from the installed copy, by M11's loginJobPlist.
//
//   the config      <base>/dispatcher.json, root's 0644, written by `dispatcher-config` from the setup config: every key
//                   main.mjs and wiring/dispatcher-wiring.mjs take (CONFIG_KEYS). Setup knows most of them (the copy, the
//                   lock, the Record's folder and owner, the review runner's files, the five worker keys of dispatcherKeys);
//                   the owner names the rest in the setup config's `dispatcher` entry (the product, M10's products file and
//                   state folder, the read token's file, M2's state folder). The install carries the file into the copy, and
//                   every update keeps it (it is one of the updater's `keep`), as review.json. main.mjs reads the config
//                   only from inside the copy (shared/job-config.mjs, L253), which is why it goes there and not elsewhere.
//                   Run again once a copy is there, the writer also puts the file in the copy, when the copy keeps it.
//   the job         <label>.dispatcher: node <copy>/modules/M11-dispatcher/main.mjs <copy>/dispatcher.json every 60 s and
//                   at load, as orchestrate, HOME its home and Umask 63 (as the robot job), logs dispatcher.out.log and
//                   dispatcher.err.log. Its lock is <orchestrate home>/dispatcher.lock, which only orchestrate can write.
//   load            refuses unless the install check passes (every job), the copy's dispatcher.json is the one this setup
//                   would write, and check-dispatcher has no FAIL (L757: check-install and check-dispatcher first). A NOT
//                   TRIED line (host.lock in a folder macOS guards) does not stop the load: only the job's own read can
//                   prove it, so the job must be loaded to try (README, the Mini's steps).
//
// Off unless the setup config has a `dispatcher` entry. Nothing here names a product or a person.

import { join, posix } from 'node:path';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { NODE, UPDATER_CONFIG, currentCopy, installProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { RUNNER_LOG } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { FOLDERS } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { CONFIG_KEYS, checkConfig } from '../wiring/dispatcher-wiring.mjs';
import { homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { checkDispatcherKeys, dispatcherKeysOn } from './dispatcher-check.mjs';

export const DISPATCHER_JOB = 'dispatcher';
export const DISPATCHER_CONFIG = 'dispatcher.json';
export const DISPATCHER_MAIN = 'modules/M11-dispatcher/main.mjs';
export const DISPATCHER_WIRING = 'wiring/dispatcher-wiring.mjs';
export const DISPATCHER_USER = 'orchestrate';
export const DISPATCHER_LOCK = 'dispatcher.lock';
/** Where the writer puts the config, in the base (root's): the install carries it into the copy from here. */
export const dispatcherSourcePath = (cfg) => join(cfg.base, DISPATCHER_CONFIG);
/** The Dispatcher's pass lock as the job sees it: in orchestrate's home, which only orchestrate can write (L757). */
export const dispatcherLockOf = (io, cfg) => io.at(join(homeOf(cfg, DISPATCHER_USER), DISPATCHER_LOCK));
/** The Record's folder of a product (the folder table's `products/<product>/store`, orchestrate's). */
export const recordRootOf = (cfg, product) => join(cfg.base, 'products', product, 'store');

// The keys only the owner can name; every other key setup writes itself.
export const OWNER_KEYS = Object.freeze(['product', 'productsFile', 'rulesStateDir', 'tokenFile', 'approvalsStateDir']);
const OWNER_PATHS = Object.freeze(OWNER_KEYS.filter((k) => k !== 'product'));
const PLAIN_PATH = (p) => typeof p === 'string' && p.startsWith('/') && p !== '/' && posix.normalize(p) === p && !p.endsWith('/') && !/[\u0000-\u001f\u007f]/.test(p) && p.length <= 300;
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const DISPATCHER_OFF = 'the config does not turn the Dispatcher job on: add its "dispatcher" entry (README, part 6)';

/**
 * The setup config's `dispatcher` entry → the checked entry, or undefined when there is none. `cfg` is the parsed setup config.
 * Exactly the owner's keys (OWNER_KEYS), plus an optional runDeadlineMs; the product one of the config's products; each path
 * full and plain and outside the install. The Dispatcher can't start without hostLockPath, so the entry needs it too.
 */
export function parseDispatcher(raw, cfg) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`config: dispatcher must be an object with ${OWNER_KEYS.join(', ')}`);
  const extra = Object.keys(raw).filter((k) => !OWNER_KEYS.includes(k) && k !== 'runDeadlineMs');
  if (extra.length) throw new Error(`config: dispatcher has keys it does not take: ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(', ')} (setup writes the others itself)`);
  if (!cfg.products.includes(raw.product)) throw new Error('config: dispatcher.product must be one of the config\'s products');
  const install = `${installPaths(cfg).install}/`;
  for (const k of OWNER_PATHS) {
    if (!PLAIN_PATH(raw[k])) throw new Error(`config: dispatcher.${k} must be a full path, written plainly (no . or .., no doubled or trailing /)`);
    if (`${raw[k]}/`.startsWith(install)) throw new Error(`config: dispatcher.${k} must not be inside the install, which only root writes`);
  }
  if (raw.runDeadlineMs !== undefined && !(Number.isSafeInteger(raw.runDeadlineMs) && raw.runDeadlineMs > 0)) throw new Error('config: dispatcher.runDeadlineMs must be a positive whole number of milliseconds');
  if (cfg.hostLockPath === undefined) throw new Error('config: a dispatcher entry needs hostLockPath (the full path of the owner\'s host.lock)');
  return Object.freeze(Object.fromEntries([...OWNER_KEYS, ...(raw.runDeadlineMs !== undefined ? ['runDeadlineMs'] : [])].map((k) => [k, raw[k]])));
}

/**
 * The Dispatcher's config as the job will see it (every path through io.at), in CONFIG_KEYS order. → { config, problems }.
 * The uids come from the Mac's user records: orchestrate's owns the Record (the job runs as it), review's is the runner's.
 */
export function dispatcherConfigFor(io, cfg) {
  const d = cfg.dispatcher;
  if (!d) return { config: null, problems: [DISPATCHER_OFF] };
  const problems = [];
  const orch = readUser(io, DISPATCHER_USER); const rev = readUser(io, 'review');
  if (!orch.exists) problems.push(`the ${DISPATCHER_USER} user does not exist (run users-folders first)`);
  if (!rev.exists) problems.push('the review user does not exist (run users-folders first)');
  if (problems.length) return { config: null, problems };
  const P = installPaths(cfg); const root = io.at(P.installRoot);
  let k; try { k = dispatcherKeysOn(io, cfg); } catch (e) { return { config: null, problems: [e.message] }; }
  const at = (p) => io.at(p);
  const value = {
    installRoot: root, wiring: join(root, DISPATCHER_WIRING), lockFile: dispatcherLockOf(io, cfg), runDeadlineMs: d.runDeadlineMs,
    product: d.product, recordRoot: at(recordRootOf(cfg, d.product)), ownerUid: orch.uid,
    productsFile: at(d.productsFile), rulesStateDir: at(d.rulesStateDir), tokenFile: at(d.tokenFile), approvalsStateDir: at(d.approvalsStateDir),
    reviewRequestsDir: at(join(k.reviewRoot, FOLDERS.requests)), reviewStatusFile: at(join(k.reviewRoot, FOLDERS.status)), reviewUid: rev.uid,
    reviewRunnerLog: at(join(P.logDir, RUNNER_LOG)), reviewInstallRoot: root,
    reviewRoot: at(k.reviewRoot), mirror: at(k.mirror), sealRoot: at(k.sealRoot), hostLockPath: at(k.hostLockPath), hostLockUid: k.hostLockUid,
  };
  // Every key the Dispatcher reads is written; only runDeadlineMs may be left to main.mjs's default. A key the wiring adds
  // and this doesn't fill is told here, never dropped (the Dispatcher would refuse to start on it).
  const unfilled = CONFIG_KEYS.filter((key) => value[key] === undefined && key !== 'runDeadlineMs');
  if (unfilled.length) return { config: null, problems: [`setup doesn't fill the Dispatcher's config keys ${unfilled.join(', ')}`] };
  const config = Object.fromEntries(CONFIG_KEYS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  try { checkConfig(config); } catch (e) { return { config: null, problems: [`the config this would write is one the Dispatcher refuses (${e.message})`] }; }
  return { config, problems: [] };
}
/** The file's exact text: what the writer writes and what every check compares. */
export const dispatcherConfigText = (config) => `${JSON.stringify(config, null, 1)}\n`;

/** The Dispatcher job's plist text: M11's own builder, as the robot job's, with HOME and Umask 63. */
export function dispatcherPlist(cfg) {
  const P = installPaths(cfg); const home = homeOf(cfg, DISPATCHER_USER);
  return loginJobPlist({
    label: `${cfg.label}.${DISPATCHER_JOB}`, node: join(P.installRoot, NODE), script: join(P.installRoot, DISPATCHER_MAIN), config: join(P.installRoot, DISPATCHER_CONFIG),
    path: PATH, logDir: P.logDir, workDir: home, userName: DISPATCHER_USER, logName: DISPATCHER_JOB, home, umask: 0o77,
  });
}

/** Whether the installed copy's updater keeps dispatcher.json: true, false, or null when there is no copy (or no readable updater.json). */
function copyKeeps(io, cfg) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) return null;
  try { const u = JSON.parse(io.readText(join(P.installRoot, UPDATER_CONFIG))); return Array.isArray(u?.keep) && u.keep.includes(DISPATCHER_CONFIG); } catch { return null; }
}
const KEEPS_NOT = `the installed copy was made before the Dispatcher was set up, so its updater does not keep ${DISPATCHER_CONFIG} and would drop it on the next update: install again (README, part 6)`;

/**
 * Null, or why a root file is not exactly `want`: root's 0644, a plain file with one name, this text. `inCopy`: the file is in
 * the installed copy, read by its real path as the copy's checks read it (install-check.mjs), not through the base's folders.
 */
function fileProblem(io, file, want, { inCopy = false } = {}) {
  const lstat = inCopy ? (p) => io.lstatReal(io.at(p)) : (p) => io.lstat(p);
  let st; try { st = lstat(file); } catch { return `${file} is not there`; }
  if (st.isSymbolicLink() || !st.isFile()) return `${file} is not a plain file`;
  if (st.uid !== io.rootUid) return `${file} is owned by uid ${st.uid}, not root`;
  if ((st.mode & 0o7777) !== 0o644) return `${file} has mode ${(st.mode & 0o7777).toString(8)}, want 644`;
  if (st.nlink !== 1) return `${file} has ${st.nlink} names`;
  let t; try { t = io.readText(file); } catch { return `${file} can't be read`; }
  return t === want ? null : `${file} is not the config this setup writes now (run dispatcher-config)`;
}

/** `dispatcher-config`: write <base>/dispatcher.json, and the copy's when the copy keeps it. → { ops, problems }. Twice does nothing. */
export function planDispatcherConfig(io, cfg) {
  const { config, problems } = dispatcherConfigFor(io, cfg);
  if (problems.length) return { ops: [], problems };
  const text = dispatcherConfigText(config); const ops = [];
  const write = (f) => ({ text: `write ${f}   (root:wheel 0644)`, run: () => { io.rm(f); io.write(f, text, 0o600); io.secureFile(f, { uid: io.rootUid, gid: 0, mode: 0o644 }); } });
  const src = dispatcherSourcePath(cfg);
  if (fileProblem(io, src, text)) ops.push(write(src));
  // The copy is root's (and every folder above it), so writing in it through its link is root writing in root's folders.
  const inCopy = join(installPaths(cfg).installRoot, DISPATCHER_CONFIG);
  if (copyKeeps(io, cfg) === true && fileProblem(io, inCopy, text, { inCopy: true })) ops.push(write(inCopy));
  return { ops, problems: [] };
}

/**
 * Null, or why the copy's dispatcher.json would not start the Dispatcher as this setup lays it out. Read only. The file must be
 * root's alone in the copy and exactly the text the writer writes now, and the copy must keep it. With the robot job on, the
 * robot's config must name the same Record and the Dispatcher's own lock (else the two would take different locks).
 */
export function dispatcherConfigProblem(io, cfg) {
  const { config, problems } = dispatcherConfigFor(io, cfg);
  if (problems.length) return problems.join('; ');
  const P = installPaths(cfg); const root = io.at(P.installRoot); const file = join(P.installRoot, DISPATCHER_CONFIG);
  const keeps = copyKeeps(io, cfg);
  if (keeps === null) return 'the install is not there yet (run the install first)';
  let here = true; try { io.lstatReal(join(root, DISPATCHER_CONFIG)); } catch { here = false; }
  if (!here) return keeps ? `${file} is not in the copy (run dispatcher-config)` : KEEPS_NOT;
  const bad = installProblem(root, [join(root, DISPATCHER_CONFIG)], { owner: io.rootUid, top: io.prefix || '/' });
  if (bad) return `${DISPATCHER_CONFIG} in the copy is not root's alone: ${bad}`;
  const why = fileProblem(io, file, dispatcherConfigText(config), { inCopy: true });
  if (why) return why;
  if (!keeps) return KEEPS_NOT;
  if (cfg.robot) {
    let r; try { r = JSON.parse(io.readText(join(P.installRoot, 'robot.json'))); } catch { return 'the robot job is on, but the copy\'s robot.json can\'t be read, so it can\'t be held to the same Record and lock'; }
    const differ = ['product', 'recordRoot', 'ownerUid', 'productsFile', 'rulesStateDir', 'tokenFile'].filter((k) => r?.[k] !== config[k]);
    if (r?.dispatcherLockFile !== config.lockFile) differ.push(`dispatcherLockFile (must be ${config.lockFile}, the Dispatcher's lock)`);
    if (differ.length) return `the copy's robot.json and ${DISPATCHER_CONFIG} must name the same Record and lock; they differ in ${differ.join(', ')}`;
  }
  return null;
}

/** The rows the writer's closing check prints: the base file, and, once there is a copy, the copy's (the job reads the copy's). */
export function checkDispatcherConfig(io, cfg) {
  const { config, problems } = dispatcherConfigFor(io, cfg);
  if (problems.length) return [{ ok: false, what: 'the Dispatcher\'s config can be built from this setup', why: problems.join('; ') }];
  const src = dispatcherSourcePath(cfg); const a = fileProblem(io, src, dispatcherConfigText(config));
  const b = dispatcherConfigProblem(io, cfg);
  return [
    { ok: a === null, what: `${src} is root's 0644 and the config this setup writes`, ...(a ? { why: a } : {}) },
    ...(copyKeeps(io, cfg) === null ? [] : [{ ok: b === null, what: `the copy's ${DISPATCHER_CONFIG} is that config, and the copy keeps it`, ...(b ? { why: b } : {}) }]),
  ];
}

/** Why the Dispatcher job may not be loaded now, or null: its config, then check-dispatcher's FAILs (NOT TRIED does not stop it). */
export function dispatcherLoadProblem(io, cfg) {
  const why = dispatcherConfigProblem(io, cfg);
  if (why) return `${why}, so the Dispatcher job would not start`;
  const bad = checkDispatcherKeys(io, cfg).filter((r) => !r.ok && !r.notTried);
  return bad.length ? `check-dispatcher FAILs (${bad[0].what}: ${bad[0].why})${bad.length > 1 ? `, and ${bad.length - 1} more` : ''}; fix that first (node setup.mjs check-dispatcher shows all of it)` : null;
}
