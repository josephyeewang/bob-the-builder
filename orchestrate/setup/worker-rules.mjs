// Root's worker-rules job (L1225, L1226, L1227): the rules snapshot each worker session's hooks read, written by root.
//
// Why root. The worker runner and its sessions both run as the builder user (L1079). While the runner wrote the snapshot
// (runner-main.mjs keepSnapshots, before the runner side of L1226), anything that runs as the builder outside the sessions' deny lines (a product's install
// or test command, a shell form the list misses) could rewrite the rules with a correct hash, and the hooks would take
// it (L1125). Here root writes it, in a folder only root writes, so the builder can't change it by any route; the readers
// (the hooks, and the runner at each start and in check 8: runner-checks.mjs workerSnapshotProblem) take it only when it is root's alone (M4 hooks/snapshot.mjs readSnapshot
// with ownerUid 0: the folder chain, no link, one name, root's, no group or other write).
//
//   the job      <label>.worker-rules: node <copy>/setup/worker-rules.mjs write, as root, at load and every WRITE_EVERY_S
//                (60 s: four beats can be missed inside the snapshot's 5-minute limit). On exactly when the worker runner is
//                (daemons.mjs jobsFor), placed, loaded, checked and taken out the way setup's other jobs are.
//   the source   the copy's worker-runner.json (worker-runner-setup.mjs worker-config writes it), read the way the runner
//                reads it (shared/job-config.mjs readJobConfig: one handle, no link, the whole copy root's alone) and
//                checked by the runner's own check (runner-main.mjs checkRunnerConfig). Each product's `rules` there is
//                the one source (I7): the same object the runner loads as p.rules.
//   the files    <base>/worker-rules/<product>.json (layout.mjs workerRulesPath), root:wheel 0644, written whole beside its
//                name and renamed over it (builder-wall.mjs writeRootFile, shared with the wall's status): a hard link
//                the builder made to an old one (nlink 2, which every reader refuses) is removed with a refusal, and
//                the next beat writes a new file of one name. Known limit (L1238 m5): the builder can hard-link each new
//                file again (macOS lets anyone link a file they can read), and its own sessions are then refused until the
//                next beat. That costs only the builder's own sessions' work (availability), never the rules: the
//                readers' one-name rule, which makes it possible, is what keeps a second name from being a way in.
//                The shape is M4's ({ written_at, hash, rules }, hash = snapshotHash(rules)) plus `product` and
//                `source_sha256`, the sha256 of the installed worker-runner.json's bytes as this job read them, on the one
//                descriptor it checked (shared/job-config.mjs readSha256), so a reader can compare it with the file
//                itself (L1238 m3; a config changed under a running runner is then held).
//
// Liveness (L1227, option C). Worker sessions are spawned detached, each leading its own process group, and are carried
// over when the runner restarts (runner-main.mjs carriedOverProblem): that is intended, so a session does not die with the
// runner. What stops one once the runner is gone is its snapshot going stale: the hooks refuse every call after 5 minutes.
// To keep exactly that, root writes only while launchd shows the worker runner's job running, with a pid whose user is the
// builder and that is not stopped: the pid is read from launchctl's own answer for the job's exact label, never found by a
// process name, and its user and state are read with one ps call. The builder can't forge launchd's answer.
//   What it keeps. A runner that is not loaded, not running, run as anyone but the builder, stopped (state T: the builder
//   can `kill -STOP` its own runner, and launchd still says running; L1238 M1), traced (flag X), a zombie (Z), or whose
//   answer can't be read writes nothing (fail closed) and says why in its log; the snapshot then goes stale within 5
//   minutes, as it did when the runner wrote it.
//   What it doesn't (known limits). A runner whose event loop hangs while the process stays runnable or asleep (state R,
//   S, I or U) is not caught: launchd and ps see a live process, so root keeps the snapshot fresh while no runner work
//   happens. That is on the cutover checklist (L1238). And a pid reused in the moment between the two reads could earn one
//   more beat: at most a minute more on a 5-minute limit.
// Exit: 0 after a write, and 0 when the only reason for writing nothing is that the runner is not loaded or not running
// (the usual state while the runner is off; the reason is still logged). Anything else that writes nothing exits 1.
//
// Commands (root only):  write             one beat: check the runner is running, then write every product's snapshot
//                        write --dry-run   say what one beat would do, writing nothing (root not needed; it still asks
//                                          launchctl and ps about the runner, which any user may, and reads the copy's
//                                          config when it can)

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { BUILDER, JOB_PATH, LAUNCHCTL, ROOT_CONFIG_PATH, workerRulesDir, workerRulesPath } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { realIo, rootProblem } from './mac.mjs';
import { arr, plist, str, writeRootFile } from './builder-wall.mjs';
import { installPaths, parseInstallConfig } from './install.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { snapshotHash } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { readJobConfig, readSha256 } from '../shared/job-config.mjs';
import { checkRunnerConfig } from '../wiring/runner-main.mjs';
import { WORKER_RUNNER_CONFIG, WORKER_RUNNER_JOB } from './worker-runner-setup.mjs';

export const WORKER_RULES_JOB = 'worker-rules';
/** This file, as the job starts it from the installed copy. */
export const WORKER_RULES_SCRIPT = 'setup/worker-rules.mjs';
export const WRITE_EVERY_S = 60;
export const PS = '/bin/ps';
/** The process states ps gives a live runner (macOS ps(1): R runnable, S asleep, I idle, U uninterruptible); T and Z are not. */
const LIVE_STATES = 'RSIU';

export function workerRulesPlist(cfg) {
  const P = installPaths(cfg);
  return plist([
    `<key>Label</key>${str(`${cfg.label}.${WORKER_RULES_JOB}`)}`,
    `<key>ProgramArguments</key>${arr([join(P.installRoot, NODE), join(P.installRoot, WORKER_RULES_SCRIPT), 'write'])}`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key>${str(JOB_PATH)}</dict>`,
    '<key>WorkingDirectory</key><string>/</string>',
    '<key>Umask</key><integer>18</integer>',
    `<key>StartInterval</key><integer>${WRITE_EVERY_S}</integer>`,
    '<key>RunAtLoad</key><true/>',
    `<key>StandardErrorPath</key>${str(join(P.logDir, `${WORKER_RULES_JOB}.err.log`))}`,
  ]);
}

const said = (r) => (String(r?.stderr ?? '').trim() || String(r?.stdout ?? '').trim()).slice(0, 160) || `exit ${r?.status}`;

/**
 * Whether the worker runner's job is running now, by launchd's own answer for its exact label (L1227): → { live: true,
 * pid } or { live: false, why, off? }. `off` is true only when the job is not loaded or not running (main exits 0 for it).
 * `builderUid` is the builder's uid from this Mac. The pid's user and state come from one ps call: a stopped (T), traced
 * (X) or zombie (Z) runner is not live (L1238 M1). Anything launchctl or ps says that can't be read is not live (fail
 * closed), with the reason.
 */
export function runnerLive(io, cfg, builderUid) {
  const label = `${cfg.label}.${WORKER_RUNNER_JOB}`;
  const r = io.run(LAUNCHCTL, ['print', `system/${label}`]);
  if (r.status !== 0) {
    if (/could not find service/i.test(`${r.stderr}\n${r.stdout}`)) return { live: false, why: `the worker runner's job (${label}) is not loaded`, off: true };
    return { live: false, why: `launchctl print system/${label} failed (${said(r)})` };
  }
  // The job's own fields are its top level: one tab in. Nested sections (its endpoints, its environment) are two or more.
  const top = (key) => [...String(r.stdout).matchAll(new RegExp(`^\\t${key} = (.*)$`, 'gm'))].map((m) => m[1]);
  const states = top('state'); const pids = top('pid');
  if (states.length !== 1) return { live: false, why: `launchctl's answer for ${label} has ${states.length} top-level state lines, not one, so it can't be read` };
  if (states[0] !== 'running') return { live: false, why: `the worker runner's job (${label}) is ${states[0].slice(0, 40)}, not running`, off: true };
  if (pids.length !== 1 || !/^[1-9][0-9]{0,9}$/.test(pids[0])) return { live: false, why: `launchctl's answer for ${label} says running but gives ${pids.length === 1 ? `the pid ${JSON.stringify(pids[0].slice(0, 20))}` : `${pids.length} pid lines`}, so it can't be read` };
  const pid = Number(pids[0]);
  const p = io.run(PS, ['-o', 'uid=,stat=', '-p', String(pid)]);
  if (p.status !== 0) return { live: false, why: `the worker runner's pid ${pid} is gone (ps: ${said(p)})` };
  const m = String(p.stdout).trim().match(/^([0-9]+)\s+([A-Za-z+<>]+)$/);
  if (!m) return { live: false, why: `ps gave the worker runner's pid ${pid} the user and state ${JSON.stringify(String(p.stdout).trim().slice(0, 30))}, which can't be read` };
  const [, uid, stat] = m;
  if (Number(uid) !== builderUid) return { live: false, why: `the worker runner's pid ${pid} runs as uid ${uid}, not the ${BUILDER} user's (${builderUid})` };
  if (!LIVE_STATES.includes(stat[0]) || stat.includes('X')) {
    const what = stat[0] === 'T' ? 'stopped' : stat[0] === 'Z' ? 'a zombie' : stat.includes('X') ? 'traced' : 'in a state that is not a live one';
    return { live: false, why: `the worker runner's pid ${pid} is ${what} (ps state ${stat.slice(0, 12)})` };
  }
  return { live: true, pid };
}

/** The snapshot's text for one product: M4's shape, with the product and the sha256 of the config file's bytes. */
export function rulesText(product, rules, sourceSha256, at = new Date()) {
  return `${JSON.stringify({ written_at: at.toISOString(), hash: snapshotHash(rules), rules, product, source_sha256: sourceSha256 })}\n`;
}

/**
 * Writes one product's snapshot, whole or not at all, in root's folder for them, the way the wall's status is written
 * (builder-wall.mjs writeRootFile): the base and the folder root's alone all the way up, and an old name that is not one
 * plain file of root's with one name (a link, a folder, someone else's, a hard link) removed and the write refused. Only
 * root can put anything in this folder, so that is said loudly.
 */
export function writeRules(io, cfg, product, text) {
  writeRootFile(io, cfg, workerRulesDir(cfg), workerRulesPath(cfg, product), text);
}

/**
 * One beat's plan: → { writes: [{ product, path, text }], problems }. A product without rules is skipped, with a problem,
 * and the others are still written (L1242 m2). Otherwise nothing is written when there is any problem: the
 * runner not running (runnerLive), the builder user missing, the config unreadable or one the runner refuses, or a product
 * in it that the setup config does not list. `off` is true when the only reason is the runner not loaded or not running.
 * `readConfig(file)` → { config, sourceSha256 } (a port for tests; the real one is the runner's own reading, as root, of
 * root's copy, and the sha256 of the bytes that one read took).
 */
export const readSource = (io) => (file) => { const config = readJobConfig(io.at(file), { code: [], optionalCode: ['budget'], ownUid: io.rootUid }); return { config, sourceSha256: readSha256(config) }; };
export function planBeat(io, cfg, { readConfig = readSource(io), now = new Date() } = {}) {
  const b = readUser(io, BUILDER);
  if (!b.exists || !Number.isSafeInteger(b.uid) || b.uid <= 0) return { writes: [], problems: [`the ${BUILDER} user is not on this Mac${b.error ? ` (${b.error})` : ''}, so whose the runner's pid is can't be told, so no snapshot was written (its sessions' snapshots go stale within 5 minutes)`] };
  const live = runnerLive(io, cfg, b.uid);
  if (!live.live) return { writes: [], problems: [`${live.why}, so no snapshot was written (its sessions' snapshots go stale within 5 minutes, and the runner holds every start)`], ...(live.off ? { off: true } : {}) };
  const file = join(installPaths(cfg).installRoot, WORKER_RUNNER_CONFIG);
  let c; let sha;
  try {
    ({ config: c, sourceSha256: sha } = readConfig(file)); checkRunnerConfig(c);
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) throw new Error('the sha256 of the bytes read could not be taken');
  } catch (e) { return { writes: [], problems: [`the copy's ${WORKER_RUNNER_CONFIG} can't be used (${e?.message ?? e}), so no snapshot was written`] }; }
  const products = c.products && typeof c.products === 'object' && !Array.isArray(c.products) ? Object.entries(c.products) : [];
  if (!products.length) return { writes: [], problems: [`the copy's ${WORKER_RUNNER_CONFIG} names no product, so no snapshot was written`] };
  const problems = []; const skipped = []; const writes = [];
  for (const [product, p] of products) {
    if (!cfg.products.includes(product)) { problems.push(`the copy's ${WORKER_RUNNER_CONFIG} names ${JSON.stringify(product.slice(0, 40))}, which the setup config does not list`); continue; }
    // A product without rules (the runner's config allows it, and launch check 8 then has no port, so that product's
    // sessions are refused: runner-checks.mjs) gets no snapshot, and its sessions are refused; the others are still written (L1242 m2).
    if (!p?.rules || typeof p.rules !== 'object' || Array.isArray(p.rules)) { skipped.push(`the copy's ${WORKER_RUNNER_CONFIG} has no rules for ${product}, so no snapshot was written for it (its sessions are refused; the other products' are written)`); continue; }
    writes.push({ product, path: workerRulesPath(cfg, product), text: rulesText(product, p.rules, sha, now) });
  }
  // A product the setup config does not list means the copy's config is not the one setup made: nothing is written.
  if (problems.length) return { writes: [], problems: problems.map((x) => `${x}, so no snapshot was written`) };
  return { writes, problems: skipped };
}

const USAGE = 'usage: node setup/worker-rules.mjs write [--dry-run]   (as root; the worker-rules job runs it every minute)';

export function main(argv, { io = realIo(), out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`), plan = {} } = {}) {
  const [cmd, ...rest] = argv; const dry = rest.includes('--dry-run');
  if (cmd !== 'write' || rest.some((a) => a !== '--dry-run')) { err(USAGE); return 2; }
  if (!dry) { const p = rootProblem(io); if (p) { err(`refused: ${p}`); return 2; } }
  let cfg;
  try {
    let raw; try { raw = JSON.parse(io.readConfig(ROOT_CONFIG_PATH, { strict: true })); } catch (e) { throw new Error(e instanceof SyntaxError ? 'the config is not valid JSON' : e.message); }
    cfg = parseInstallConfig(raw);
  } catch (e) { err(`refused: ${e.message}`); return 2; }
  if (!cfg.workerRunner) { err('refused: the config has no workerRunner entry, so there is no worker runner to write rules for'); return 2; }
  const { writes, problems, off } = planBeat(io, cfg, plan);
  for (const p of problems) err(p);
  if (!writes.length) return off ? 0 : 1;
  if (dry) { for (const w of writes) out(`would write ${w.path}   (root:wheel 0644)`); return problems.length ? 1 : 0; }
  let bad = 0;
  for (const w of writes) {
    try { writeRules(io, cfg, w.product, w.text); } catch (e) { bad += 1; err(`${w.product}'s rules snapshot was not written: ${e?.message ?? e}`); }
  }
  return bad || problems.length ? 1 : 0;
}

const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (self === import.meta.url) process.exitCode = main(process.argv.slice(2));
