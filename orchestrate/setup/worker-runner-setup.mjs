// Setup's part for the worker runner (L1092, L1112): its background job, run as the builder user (L1079), from the
// installed copy. Built the Dispatcher's way (dispatcher-setup.mjs):
//
//   the job      <label>.worker-runner: node <copy>/wiring/runner-main.mjs <copy>/worker-runner.json, as builder, HOME the
//                builder's home under the base (never a person's under /Users) and Umask 63 (wiring/runner-job.mjs
//                workerRunnerPlist), logs worker-runner.out.log and worker-runner.err.log.
//   load         refuses unless the install check passes (every job) and the copy holds worker-runner.json, root's 0644,
//                which the runner's own check (runner-main.mjs checkRunnerConfig) takes. A job placed without it would
//                start at boot and stop at once, every minute.
//
// Off unless the setup config has a `workerRunner` entry. For the thin slice (L1112 (1)) it names one product, one of the
// config's products. The rules lists the sessions' settings need come from the rules already set up, never a second copy
// in the entry (L1112 (2), I7). Nothing here names a product or a person.

import { join } from 'node:path';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';
import { checkRunnerConfig } from '../wiring/runner-main.mjs';
import { workerRunnerPlist } from '../wiring/runner-job.mjs';
import { BUILDER, homeOf } from './layout.mjs';
import { installPaths } from './install.mjs';

export const WORKER_RUNNER_JOB = 'worker-runner';
export const WORKER_RUNNER_CONFIG = 'worker-runner.json';
export const WORKER_RUNNER_MAIN = 'wiring/runner-main.mjs';
const PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ENTRY_KEYS = Object.freeze(['product']);
export const WORKER_RUNNER_OFF = 'the config does not turn the worker runner\'s job on: add its "workerRunner" entry with the product it runs';

/** The setup config's `workerRunner` entry → the checked entry, or undefined when there is none. One product (L1112 (1)). */
export function parseWorkerRunner(raw, cfg) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: workerRunner must be an object with product');
  const extra = Object.keys(raw).filter((k) => !ENTRY_KEYS.includes(k));
  if (extra.length) throw new Error(`config: workerRunner has keys it does not take: ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(', ')} (setup writes the others itself, and the rules lists come from the rules)`);
  if (!cfg.products.includes(raw.product)) throw new Error('config: workerRunner.product must be one of the config\'s products');
  return Object.freeze({ product: raw.product });
}

/** The job file's text: the runner's own builder (runner-job.mjs), which refuses a person's home and a job without UserName. */
export function workerRunnerJobPlist(cfg) {
  const P = installPaths(cfg); const home = homeOf(cfg, BUILDER);
  return workerRunnerPlist({
    label: `${cfg.label}.${WORKER_RUNNER_JOB}`, node: join(P.installRoot, NODE), script: join(P.installRoot, WORKER_RUNNER_MAIN),
    config: join(P.installRoot, WORKER_RUNNER_CONFIG), path: PATH, logDir: P.logDir, workDir: home, home,
  });
}

/** Null, or why the worker runner's job must not be loaded: the copy's worker-runner.json missing, not root's 0644 plain file, or one the runner refuses. */
export function workerRunnerLoadProblem(io, cfg) {
  const f = join(installPaths(cfg).installRoot, WORKER_RUNNER_CONFIG);
  const stop = (why) => `${f} ${why}, so the worker runner's job would not start`;
  let st; try { st = io.lstat(f); } catch (e) { return stop(e?.code === 'ENOENT' ? 'is not there (run worker-config first)' : `can't be looked at (${e?.code ?? 'error'})`); }
  if (!st.isFile() || st.isSymbolicLink()) return stop('is not a plain file');
  if (st.uid !== io.rootUid || (st.mode & 0o7777) !== 0o644) return stop('is not root\'s 0644');
  let c; try { c = JSON.parse(io.readText(f)); } catch { return stop('is not valid JSON'); }
  try { checkRunnerConfig(c); } catch (e) { return stop(`is one the runner refuses (${e.message})`); }
  return null;
}
