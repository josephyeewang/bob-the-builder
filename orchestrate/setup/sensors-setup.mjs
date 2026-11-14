// Setup part 6b: the Sensors' config and their background job (R-0b-169; LEAD-CALLS L1049, L1051). Built the Dispatcher's way
// (dispatcher-setup.mjs): one job, run as `orchestrate`, from the installed copy, by M11's loginJobPlist (M12 sensors-job.mjs).
//
//   the config      <base>/sensors.json, root's 0644, written by `dispatcher-config` beside dispatcher.json: every key
//                   loop.mjs and wiring/sensors-wiring.mjs take (CONFIG_KEYS). All of them come from the Dispatcher's own
//                   config (the Record, its owner, the products file, the rules' state folder, the read token), so the Sensors
//                   write the Record the Dispatcher reads, under the same rules; plus the owner's answer file (layout.mjs
//                   ownerAnswerPath) and the owner's Mac user id, the one user whose answer is believed. The install carries
//                   the file into the copy and every update keeps it, as dispatcher.json: loop.mjs reads its config only from
//                   inside the copy (shared/job-config.mjs, L253).
//   the job         <label>.sensors: node <copy>/modules/M12-sensors/loop.mjs <copy>/sensors.json every 60 s and at load, as
//                   orchestrate, HOME its home and Umask 63 (as the Dispatcher), logs sensors.out.log and sensors.err.log.
//   load            refuses unless the install check passes (every job), the copy's sensors.json is the one this setup would
//                   write, and check-dispatcher has no FAIL: the Sensors open the Dispatcher's Record with its rules and token.
//
// On exactly when the Dispatcher is (the setup config's `dispatcher` entry): the Dispatcher starts nothing without the Sensors'
// readings, and the Sensors have no reader without it. Nothing here names a product or a person.

import { join } from 'node:path';
import { sensorsJobPlist } from '../modules/M12-sensors/sensors-job.mjs';
import { RUN_DEADLINE_MS } from '../modules/M12-sensors/loop.mjs';
import { NODE, installProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { CONFIG_KEYS, checkConfig } from '../wiring/sensors-wiring.mjs';
import { ANSWER_FILE } from '../wiring/owner-answer.mjs';
import { homeOf, ownerAnswerPath } from './layout.mjs';
import { installPaths, keepsNotWarning } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { DISPATCHER_OFF, DISPATCHER_USER, checkDispatcherConfig, copyKeeps, dispatcherConfigFor, dispatcherKeysProblem, fileProblem, planDispatcherConfig, writeAside } from './dispatcher-setup.mjs';

export const SENSORS_JOB = 'sensors';
export const SENSORS_CONFIG = 'sensors.json';
export const SENSORS_MAIN = 'modules/M12-sensors/loop.mjs';
export const SENSORS_WIRING = 'wiring/sensors-wiring.mjs';
/** The longest a healthy Sensors run goes, in seconds: loop.mjs's one time limit (the wiring and the pass) and a minute (daemons check). */
export const SENSORS_RUN_LIMIT_S = Math.ceil(RUN_DEADLINE_MS / 1000) + 60;
/** Where the writer puts the config, in the base (root's): the install carries it into the copy from here. */
export const sensorsSourcePath = (cfg) => join(cfg.base, SENSORS_CONFIG);
/** The owner's answer file as the Sensors read it (the owner's job writes it, owner-answer-setup.mjs). */
export const answerFileOf = (cfg) => join(ownerAnswerPath(cfg), ANSWER_FILE);
// The keys the Sensors share with the Dispatcher: taken from its config, never worked out a second way.
const FROM_DISPATCHER = Object.freeze(['installRoot', 'product', 'recordRoot', 'ownerUid', 'productsFile', 'rulesStateDir', 'tokenFile']);
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The Sensors' config as the job will see it (every path through io.at), in CONFIG_KEYS order. → { config, problems }. Built from
 * the Dispatcher's (dispatcherConfigFor), so a setup that can't build that one can't build this one either, for the same reason.
 */
export function sensorsConfigFor(io, cfg, { keys = CONFIG_KEYS } = {}) {
  if (!cfg.dispatcher) return { config: null, problems: [DISPATCHER_OFF] };
  const d = dispatcherConfigFor(io, cfg);
  if (d.problems.length) return { config: null, problems: d.problems };
  const owner = readUser(io, cfg.owner); const orch = readUser(io, DISPATCHER_USER);
  if (!owner.exists) return { config: null, problems: [`the owner's Mac user ${cfg.owner} was not found`] };
  const value = {
    ...Object.fromEntries(FROM_DISPATCHER.map((k) => [k, d.config[k]])),
    wiring: join(d.config.installRoot, SENSORS_WIRING), answerFile: io.at(answerFileOf(cfg)), answerUid: owner.uid,
  };
  // Both ways, as the Dispatcher's (L871): a key written that the wiring doesn't take, or one it takes that isn't written,
  // would stop every start, so it is told here.
  const untaken = Object.keys(value).filter((k) => !keys.includes(k));
  if (untaken.length) return { config: null, problems: [`the Sensors' wiring doesn't take the config keys ${untaken.join(', ')} that setup writes (use setup and its wiring, wiring/sensors-wiring.mjs, from one checkout)`] };
  const unfilled = keys.filter((k) => value[k] === undefined);
  if (unfilled.length) return { config: null, problems: [`setup doesn't fill the Sensors' config keys ${unfilled.join(', ')}`] };
  const config = Object.fromEntries(keys.map((k) => [k, value[k]]));
  // Checked as loop.mjs's wiring checks it, as orchestrate: so the owner may be neither orchestrate nor root.
  try { checkConfig(config, { selfUid: orch.uid }); } catch (e) { return { config: null, problems: [`the config this would write is one the Sensors refuse (${e.message})`] }; }
  return { config, problems: [] };
}
/** The file's exact text: what the writer writes and what every check compares. */
export const sensorsConfigText = (config) => `${JSON.stringify(config, null, 1)}\n`;

/** The Sensors job's plist text: M12's own builder (M11's layout), with HOME and Umask 63, as the Dispatcher's. */
export function sensorsPlist(cfg) {
  const P = installPaths(cfg); const home = homeOf(cfg, DISPATCHER_USER);
  return sensorsJobPlist({
    label: `${cfg.label}.${SENSORS_JOB}`, node: join(P.installRoot, NODE), script: join(P.installRoot, SENSORS_MAIN), config: join(P.installRoot, SENSORS_CONFIG),
    path: PATH, logDir: P.logDir, workDir: home, userName: DISPATCHER_USER, home, umask: 0o77,
  });
}

const KEEPS_NOT = `the installed copy was made before the Sensors were set up, so its updater does not keep ${SENSORS_CONFIG} and would drop it on the next update: install again (README, part 6)`;

/**
 * The writes `dispatcher-config` adds for sensors.json: { ops, problems, warnings }, the base file, and the copy's when the copy
 * keeps it. Twice does nothing. Root writes in the copy only when the copy is root's alone (as the Dispatcher's writer).
 */
export function planSensorsConfig(io, cfg) {
  const { config, problems } = sensorsConfigFor(io, cfg);
  if (problems.length) return { ops: [], problems, warnings: [] };
  const text = sensorsConfigText(config); const ops = [];
  const write = (f) => ({ text: `write ${f}   (root:wheel 0644)`, run: () => writeAside(io, f, text) });
  const src = sensorsSourcePath(cfg); const inCopy = join(installPaths(cfg).installRoot, SENSORS_CONFIG);
  const keeps = copyKeeps(io, cfg, SENSORS_CONFIG);
  if (fileProblem(io, src, text) !== null) ops.push(write(src));
  if (keeps === true && fileProblem(io, inCopy, text, { inCopy: true }) !== null) {
    const P = installPaths(cfg); const bad = installProblem(io.at(P.installRoot), [], { owner: io.rootUid, top: io.prefix || '/' });
    if (bad) { const why = `the installed copy is not root's alone (${bad}), so root won't write in it; install the copy again (unload the jobs, remove ${P.install}, run install), which carries ${src} into it`; ops.push({ text: `stop: ${why}`, run: () => { throw new Error(why); } }); }
    else ops.push(write(inCopy));
  }
  return { ops, problems: [], warnings: keeps === false ? [keepsNotWarning(cfg, [SENSORS_CONFIG])] : [] };
}

/**
 * `dispatcher-config`: the Dispatcher's writes (planDispatcherConfig, with its live-job check), then the Sensors'. One command
 * writes both, since the Sensors' config is made from the Dispatcher's. A problem in either stops both.
 */
export function planDispatcherAndSensors(io, cfg, opts) {
  const d = planDispatcherConfig(io, cfg, opts);
  if (d.problems.length) return d;
  const s = planSensorsConfig(io, cfg);
  if (s.problems.length) return { ops: [], problems: s.problems };
  return { ...d, ops: [...d.ops, ...s.ops], warnings: [...(d.warnings ?? []), ...s.warnings] };
}
/** The writer's closing check: the Dispatcher's rows, then the Sensors'. */
export const checkDispatcherAndSensors = (io, cfg) => [...checkDispatcherConfig(io, cfg), ...checkSensorsConfig(io, cfg)];

/** Null, or why the copy's sensors.json would not start the Sensors as this setup lays them out. Read only. */
export function sensorsConfigProblem(io, cfg) {
  const { config, problems } = sensorsConfigFor(io, cfg);
  if (problems.length) return problems.join('; ');
  const P = installPaths(cfg); const root = io.at(P.installRoot); const file = join(P.installRoot, SENSORS_CONFIG);
  const keeps = copyKeeps(io, cfg, SENSORS_CONFIG);
  if (keeps === null) return 'the install is not there yet (run the install first)';
  let here = true; try { io.lstatReal(join(root, SENSORS_CONFIG)); } catch { here = false; }
  if (!here) return keeps ? `${file} is not in the copy (run dispatcher-config)` : KEEPS_NOT;
  const bad = installProblem(root, [join(root, SENSORS_CONFIG)], { owner: io.rootUid, top: io.prefix || '/' });
  if (bad) return `${SENSORS_CONFIG} in the copy is not root's alone: ${bad}`;
  const why = fileProblem(io, file, sensorsConfigText(config), { inCopy: true });
  if (why) return why;
  return keeps ? null : KEEPS_NOT;
}

/** The rows the writer's closing check adds for sensors.json: the base file, and, once there is a copy, the copy's. */
export function checkSensorsConfig(io, cfg) {
  const { config, problems } = sensorsConfigFor(io, cfg);
  if (problems.length) return [{ ok: false, what: 'the Sensors\' config can be built from this setup', why: problems.join('; ') }];
  const src = sensorsSourcePath(cfg); const a = fileProblem(io, src, sensorsConfigText(config));
  const b = sensorsConfigProblem(io, cfg);
  return [
    { ok: a === null, what: `${src} is root's 0644 and the config this setup writes`, ...(a ? { why: a } : {}) },
    ...(copyKeeps(io, cfg, SENSORS_CONFIG) === null ? [] : [{ ok: b === null, what: `the copy's ${SENSORS_CONFIG} is that config, and the copy keeps it`, ...(b ? { why: b } : {}) }]),
  ];
}

/** Why the Sensors job may not be loaded now, or null: its config, then check-dispatcher's FAILs (the Record, rules and token are the Dispatcher's). */
export function sensorsLoadProblem(io, cfg) {
  const why = sensorsConfigProblem(io, cfg);
  if (why) return `${why}, so the Sensors job would not start`;
  return dispatcherKeysProblem(io, cfg);
}
