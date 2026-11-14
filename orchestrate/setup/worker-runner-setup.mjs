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
import { NODE, RUNNER_CONFIG, UPDATER_CONFIG, currentCopy, installProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { FOLDERS as REVIEW_FOLDERS } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { checkProducts } from '../modules/M10-rules/reader.mjs';
import { checkRunnerConfig } from '../wiring/runner-main.mjs';
import { fullPath, workerRunnerPlist } from '../wiring/runner-job.mjs';
import { BUILDER, WORKER_RUNNER_CONFIG, WORKER_STATUS_FILE, homeOf, keysPath, mirrorPath, outboxRootPath, privatePath, proposalsParentOf, storePath, workerCopiesPath, workerRunnerPaths } from './layout.mjs';
import { installPaths, keepsNotWarning } from './install.mjs';
import { readUser } from './users-folders.mjs';
import { rulesProblems } from './review-config.mjs';
import { keysDiffer, writeAside } from './dispatcher-setup.mjs';

export const WORKER_RUNNER_JOB = 'worker-runner';
export { WORKER_RUNNER_CONFIG }; // one definition: layout.mjs
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

/**
 * Null, or why the worker runner's job must not be loaded: the copy's worker-runner.json missing, not root's 0644 plain file,
 * one the runner refuses, or not exactly what worker-config writes now (`built` is a port for tests).
 */
export function workerRunnerLoadProblem(io, cfg, { built = () => workerRunnerConfigFor(io, cfg) } = {}) {
  const f = join(installPaths(cfg).installRoot, WORKER_RUNNER_CONFIG);
  const stop = (why) => `${f} ${why}, so the worker runner's job would not start`;
  let st; try { st = io.lstat(f); } catch (e) { return stop(e?.code === 'ENOENT' ? 'is not there (run worker-config first)' : `can't be looked at (${e?.code ?? 'error'})`); }
  if (!st.isFile() || st.isSymbolicLink()) return stop('is not a plain file');
  if (st.uid !== io.rootUid || (st.mode & 0o7777) !== 0o644) return stop('is not root\'s 0644');
  let c; try { c = JSON.parse(io.readText(f)); } catch { return stop('is not valid JSON'); }
  try { checkRunnerConfig(c); } catch (e) { return stop(`is one the runner refuses (${e.message})`); }
  // The text setup would write now: a file from an older setup, or by hand, names other folders or other rules (I7).
  const b = built();
  if (b.problems.length) return stop(`can't be compared with the config setup builds (${b.problems.join('; ')})`);
  if (io.readText(f) !== workerRunnerConfigText(b.config)) return stop(`is not the config worker-config writes now${keysDiffer(io.readText(f), workerRunnerConfigText(b.config))} (run worker-config)`);
  return null;
}

// ───────────────────────────────────────────── the config (L1112)
//
// `worker-config` writes <copy>/worker-runner.json, root's 0644, for the entry's one product (L1112 (1)). Every value has
// one source (I7), none typed into the entry:
//   the layout     the runner's folders (layout.mjs workerRunnerPaths), the top outbox and copies roots, the builder's home,
//                  the Record's folder, the robot keys, the private folder, the proposals folders, the snapshot's place
//   the Mac        the uids: orchestrate's (the requests' writer and the Record's owner), review's (check 12), the owner's home
//   review.json    the installed copy's review runner config (review-config.mjs, the owner's input): the rules, the pin and
//                  the pinned claude, the hooks, the machine-wide file, the Bob folder and list, the account copy, check 12's
//                  module and rules. It must be the full file (add-to-install run) and name this product's Record, since the
//                  rules in it are that product's
//   products.json  the Dispatcher's (its `dispatcher` entry's productsFile): the product's GitHub owner/name
// The deny lists (runner-main.mjs DENY_KEYS and secrets) are slip-catchers only: the wall is ownership and mode (L1112 (3),
// BUILD-RULES). secrets: the rules' secrets.paths and production env_files that are full plain paths (the hooks hold the
// rest), the private folder, the Dispatcher's rules-state and approvals folders, and the owner's home.
// Written into the copy only, as add-to-install writes there: it is built from the copy's own review.json, which a first
// install does not yet have in full. The copy's updater keeps it (install.mjs updaterConfigFor) once the entry is on at
// install; a copy made before that never gets it, which the command says.

export const WORKER_CLAIM_MS = 600_000;
const plainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The worker runner's config as its job will see it (every path through io.at). → { config, problems }. `userOf` is a port for tests. */
export function workerRunnerConfigFor(io, cfg, { userOf = (n) => readUser(io, n) } = {}) {
  const w = cfg.workerRunner;
  if (!w) return { config: null, problems: [WORKER_RUNNER_OFF] };
  if (!cfg.dispatcher) return { config: null, problems: ['the worker runner needs the Dispatcher\'s entry too: its products.json names the product\'s repository, and its rules-state and approvals folders go on the sessions\' deny list (L1112)'] };
  const product = w.product;
  const at = (p) => io.at(p); const P = installPaths(cfg); const root = at(P.installRoot);
  const problems = [];
  const user = (n, what) => { const u = userOf(n); if (!u?.exists || !Number.isInteger(u.uid) || u.uid <= 0) { problems.push(`the Mac user ${n} (${what}) does not exist (run users-folders first)`); return null; } return u; };
  const orch = user('orchestrate', 'the Record\'s owner'); const rev = user('review', 'the review runner\'s user'); const owner = user(cfg.owner, 'the owner');
  user(BUILDER, 'the worker runner\'s user, L1079');
  if (owner && !fullPath(owner.home)) problems.push(`the owner's Mac user ${cfg.owner} has no plain home folder (${String(owner.home).slice(0, 80)})`);
  // The review runner's installed config: the rules and the copy's own places, from the one file that names them.
  const rcFile = join(root, RUNNER_CONFIG); let rc = null;
  try { rc = JSON.parse(io.readText(rcFile)); } catch (e) { problems.push(`the copy's ${RUNNER_CONFIG} can't be read (${e?.code ?? e?.message}); install, then review-config and add-to-install first`); }
  const recordRoot = at(storePath(cfg, product));
  if (rc) {
    if (!plainObj(rc)) { problems.push(`the copy's ${RUNNER_CONFIG} is not a JSON object`); rc = null; }
    else {
      if (rc.claudeBin === undefined || rc.hooksDir === undefined) problems.push(`the copy's ${RUNNER_CONFIG} has no claudeBin or hooksDir: it is the --for-install form; run review-config and add-to-install first`);
      problems.push(...rulesProblems(rc.rules, `the copy's ${RUNNER_CONFIG}`));
      if (rc.recordRoot !== recordRoot) problems.push(`the copy's ${RUNNER_CONFIG} is for another product's Record (${String(rc.recordRoot).slice(0, 120)}, not ${recordRoot}), so its rules are not ${product}'s`);
    }
  }
  // The product's repository, from the Dispatcher's products.json (M10's own check of it).
  let repo = null;
  try {
    const entry = checkProducts(JSON.parse(io.readText(at(cfg.dispatcher.productsFile)))).find((p) => p.product === product);
    if (!entry) problems.push(`${cfg.dispatcher.productsFile} does not list ${product}`); else repo = `${entry.owner}/${entry.repo}`;
  } catch (e) { problems.push(`${cfg.dispatcher.productsFile} can't be used (${e?.code ?? e?.message})`); }
  if (problems.length) return { config: null, problems };

  const W = workerRunnerPaths(cfg); const home = at(homeOf(cfg, BUILDER));
  const prodRules = rc.rules.production;
  const fromRules = [...rc.rules.secrets.paths, ...prodRules.env_files].filter(fullPath);
  const secrets = [...new Set([...fromRules, at(privatePath(cfg)), at(cfg.dispatcher.rulesStateDir), at(cfg.dispatcher.approvalsStateDir), owner.home])];
  const opt = (k) => (rc[k] !== undefined ? { [k]: rc[k] } : {});
  const config = {
    installRoot: root, requestsDir: at(W.requests), statusFile: at(join(W.state, WORKER_STATUS_FILE)), orchestrateUid: orch.uid,
    outboxRoot: at(outboxRootPath(cfg)), copiesRoot: at(workerCopiesPath(cfg)), home, path: PATH, claudeBin: rc.claudeBin,
    recordRoot, recordUid: orch.uid, claimMs: WORKER_CLAIM_MS,
    products: { [product]: {
      repo, mirror: at(mirrorPath(cfg)), rules: rc.rules,
      render: {
        paths: {
          deny: { record: recordRoot, ssh: join(home, '.ssh'), gh: join(home, '.config', 'gh'), claudeHome: join(home, '.claude'), robotKeys: at(keysPath(cfg)), secrets },
          hooksDir: rc.hooksDir, node: join(root, NODE), ...(rc.bobFolder !== undefined ? { bobFolder: rc.bobFolder } : {}),
          snapshot: at(join(W.snapshots, `${product}.json`)),
        },
        // The rules' lists (L1112 (2)): read from the rules, never repeated. Every product's proposals folder, as setup makes them.
        rulesHosts: [...prodRules.hosts], productionFiles: [...prodRules.env_files],
        proposalOutboxes: cfg.products.map((p) => at(join(proposalsParentOf(cfg), p))),
      },
    } },
    ...opt('pin'), ...opt('machineWide'), ...opt('accountCopy'), ...opt('bobManifest'),
    // Check 12 (L1001): M11's module and the Dispatcher's rules, as the review runner names them, with the review runner's status.
    ...(rc.budget !== undefined ? { budget: rc.budget, dispatcherRules: rc.dispatcherRules, reviewStatusFile: at(join(P.reviewRoot, REVIEW_FOLDERS.status)), reviewUid: rev.uid } : {}),
  };
  try { checkRunnerConfig(config); } catch (e) { return { config: null, problems: [`the config this would write is one the worker runner refuses (${e.message})`] }; }
  return { config, problems: [] };
}
/** The file's exact text: what the writer writes and what load compares. */
export const workerRunnerConfigText = (config) => `${JSON.stringify(config, null, 1)}\n`;

/** Whether the copy's updater keeps worker-runner.json: true, false, or null when there is no copy or no readable updater.json. */
function copyKeepsWorker(io, cfg) {
  const P = installPaths(cfg);
  const cur = currentCopy(io.at(P.installRoot), { owner: io.rootUid });
  if (cur.missing || cur.problem || !cur.link) return null;
  try { const u = JSON.parse(io.readText(join(P.installRoot, UPDATER_CONFIG))); return Array.isArray(u?.keep) && u.keep.includes(WORKER_RUNNER_CONFIG); } catch { return null; }
}

/**
 * `worker-config`: write <copy>/worker-runner.json. → { ops, problems, warnings }. Twice does nothing. The runner reads its
 * config once, at start: a changed file reaches a loaded job only when it is unloaded and loaded again, which the step says.
 */
export function planWorkerRunnerConfig(io, cfg) {
  const { config, problems } = workerRunnerConfigFor(io, cfg);
  if (problems.length) return { ops: [], problems };
  const P = installPaths(cfg); const f = join(P.installRoot, WORKER_RUNNER_CONFIG); const text = workerRunnerConfigText(config);
  const keeps = copyKeepsWorker(io, cfg);
  if (keeps === null) return { ops: [], problems: ['the install is not there yet (run the install first)'] };
  if (keeps === false) return { ops: [], problems: [keepsNotWarning(cfg, [WORKER_RUNNER_CONFIG])] };
  const bad = installProblem(io.at(P.installRoot), [], { owner: io.rootUid, top: io.prefix || '/' });
  if (bad) return { ops: [], problems: [`the installed copy is not root's alone (${bad}), so root won't write in it; install the copy again`] };
  let same = false; try { same = io.readText(f) === text; } catch { /* not there: written below */ }
  const restart = `the runner reads it once, at start: a loaded job takes it after daemons unload --only ${WORKER_RUNNER_JOB}, then daemons load --only ${WORKER_RUNNER_JOB}`;
  return { ops: same ? [] : [{ text: `write ${f}   (root:wheel 0644; ${restart})`, run: () => writeAside(io, f, text) }], problems: [], warnings: [] };
}
