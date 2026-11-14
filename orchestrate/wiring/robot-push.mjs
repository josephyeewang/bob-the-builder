// robot-push.mjs — the robot job's push pass, wired (lane N, N1 part 2; LEAD-CALLS L1077, L1078, L1083, L1115).
//
// WHAT. robot-wiring.mjs's `push` pass: each round, push-pass.mjs pushPass over M4 push.mjs createPushScript, so a finished
// card's bundle becomes its card branch on GitHub and a pull request (never main, never forced: push.mjs). It is wired
// only when every part below is in place; until then the pass is `refusing(<what is missing>)`, it fails, and
// robot-main.mjs tells the owner once a day (I1: no part means no push, and the owner is told).
//
//   pushWiring(c, { rec, rules, entry, token, fetchFn?, now?, uid?, scannerAt?, userOf?, makePush?, testRemote? })
//     → the pass: async () → pushPass's answer | a refusing() port
//
// THE PARTS, each one refusing when missing:
//   token        the round's robot token (robot-wiring.mjs robotToken): no robot App in the config, no push.
//   outside      the outside check this Mac trusts: OUTSIDE_KEYS, all four or none. None: the pass refuses. Some, or a bad
//                value: the job does not start (outsideKeysProblem, asked by wire() with the App keys' check).
//   paths        all from setup/layout.mjs, the one layout definition (I7, L1083): the base is the folder above the
//                robot key folder, and counts only when layout.mjs keysPath(base) is that key folder again. From it: the
//                mirror (mirrorPath), the outboxes (outboxRootPath), the private folder (privatePath). No path is a
//                config key of its own.
//   scanner      `scannerAt(base)` → { bin, version, config, ignoreFile } for push.mjs's gitleaks. Until lane 4's scanner
//                setting lands (#525, L1123) it is null, and the pass refuses. The swap is the one line at SCANNER_AT below.
//   builder      the builder user's Mac uid, read on this Mac from the layout's USERS (setup users-folders.mjs readUser of
//                layout.mjs BUILDER), as setup gives the Dispatcher its workerUid (L1079 (4), L1115): no config key. A
//                worker's bundle must be that user's (push.mjs uids.worker). Never the owner, root, or this job's user.
//   mirror       the product's git mirror, checked as the Dispatcher checks it (worker-ports.mjs mirrorProblem): a plain
//                folder of this job's user that no one else can write. The robot's push is its only writer (L1083): the
//                Dispatcher only reads it (cleanup's ls-tree and merge-base, review-ports filesOf).
//   private      the scripts' private folder (privateFolder: this job's user's, 0700, writable).
//
// THE PORTS createPushScript takes, as built here:
//   productPlace   { repo: `<owner>/<repo>` from the products.json entry, mirror } for this robot's product only (L719 m5)
//   getRobotToken  the round's token, as a string; a refused mint throws, which push.mjs reads as a wait
//   readRun        gate-ports.mjs outsideRun over the keyless publicJson; workflowRule: productWorkflowRule
//   issues         the start gate's shut-gate alert, queued on the Record's alert queue under the gate's own key (holdAlert:
//                  told at once, then once a day), so deliver sends it; no second GitHub writer. A queue that refuses throws,
//                  which start-gate.mjs swallows: the push is refused either way, and pushPass tells that wait.
//   pullRequests   pr-writer.mjs prWriter (secrets masked, no token kept in the Record, L1082); pushPass retries its pending.
//
// THE LIMIT (L1115). One push may stall one git call (safe-git GIT_TIMEOUT_MS) and run one scan (gitleaks SCAN_TIMEOUT_MS),
// so the pass has PUSH_DEADLINE_MS of its own (robot-wiring.mjs PASS_LIMITS_MS), and runs LAST, after deliver, so the
// heartbeat and the alerts of its round never wait on it. Its own alerts go out with the next round's deliver. A push cut
// off by the limit is safe to run again: push.mjs pushes one commit to one branch, never forced, and a rerun of the same
// bundle finds the branch already there (robot-push.test.mjs, the kill-mid-push test).

import { dirname, resolve } from 'node:path';
import { createPushScript } from '../modules/M4-workshop/git/push.mjs';
import { GIT_TIMEOUT_MS } from '../modules/M4-workshop/git/safe-git.mjs';
import { SCAN_TIMEOUT_MS } from '../modules/M4-workshop/git/gitleaks.mjs';
import { holdAlert } from '../modules/M11-dispatcher/pass.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { BUILDER, keysPath, mirrorPath, outboxRootPath, privatePath } from '../setup/layout.mjs';
import { readUser } from '../setup/users-folders.mjs';
import { realIo } from '../setup/mac.mjs';
import { refusing } from './not-wired.mjs';
import { privateFolder } from './private-folder.mjs';
import { mirrorProblem } from './worker-ports.mjs';
import { outsideProblem, outsideRun, productWorkflowRule, publicJson } from './gate-ports.mjs';
import { prWriter } from './pr-writer.mjs';
import { pushPass } from './push-pass.mjs';

export const PUSH_DEADLINE_MS = GIT_TIMEOUT_MS + SCAN_TIMEOUT_MS + 60_000;
// The outside check this Mac trusts for the product (gate-ports.mjs outsideRun): all four or none.
export const OUTSIDE_KEYS = Object.freeze(['outsideRepo', 'outsideWorkflow', 'outsideSlot', 'outsideTag']);
// The port named in each refusal: what the pass waits for.
export const PUSH_NOT_WIRED = Object.freeze({
  app: 'robot.push: the config names no robot App, so there is no key to push with (L600)',
  outside: `robot.push: the config names no outside check (${OUTSIDE_KEYS.join(', ')})`,
  scanner: 'robot.push: the secret scanner\'s paths are not wired (lane 4, #525)',
});
// THE SCANNER PORT (L1115, L1123). Null until lane 4's #525 lands with the scanner's hash check; the swap is this one line:
//   export const SCANNER_AT = (base) => scannerSetting({ base });
// with scannerSetting from ../setup/layout.mjs: lane 4's one setting (paths, version and hash pin). Never assembled here.
export const SCANNER_AT = null;

/** Why the config's outside check keys can't be used, or null. `none` is the answer when no key is set at all. */
export function outsideKeysProblem(c, { none = null } = {}) {
  const set = OUTSIDE_KEYS.filter((k) => c?.[k] !== undefined);
  if (!set.length) return none;
  if (set.length !== OUTSIDE_KEYS.length) return `the outside check keys go together, all four or none: ${OUTSIDE_KEYS.filter((k) => c[k] === undefined).join(', ')} missing`;
  return outsideProblem({ repo: c.outsideRepo, workflowPath: c.outsideWorkflow, slot: c.outsideSlot, tag: c.outsideTag });
}

/** The setup base, from the robot key folder: its parent, counted only when layout.mjs puts the key folder there. → base | null */
export function baseOf(keyDir) {
  if (typeof keyDir !== 'string' || !keyDir.startsWith('/')) return null;
  const base = dirname(resolve(keyDir));
  return keysPath({ base }) === resolve(keyDir) ? base : null;
}

/** The builder user's uid on this Mac (layout.mjs BUILDER), or the reason it can't be used. → { uid } | { why } */
export function builderUid({ userOf, ownerUid, selfUid }) {
  let u;
  try { u = userOf(BUILDER); } catch (e) { return { why: `the ${BUILDER} user could not be read on this Mac (${String(e?.message ?? e).slice(0, 120)})` }; }
  if (!u?.exists) return { why: `the ${BUILDER} user is not on this Mac; setup users-folders makes it (L1079)` };
  const uid = u.uid;
  if (!Number.isSafeInteger(uid) || uid <= 0) return { why: `the ${BUILDER} user's Mac user id is not usable (${uid}); never root's` };
  if (uid === ownerUid) return { why: `the ${BUILDER} user's Mac user id is the owner's (${uid}); workers never run as the owner (L1079)` };
  if (uid === selfUid) return { why: `the ${BUILDER} user's Mac user id is this job's own (${uid}); workers never run as orchestrate (L1079)` };
  return { uid };
}

const realUserOf = (name) => readUser(realIo(), name);

export function pushWiring(c, { rec, rules, entry, token, fetchFn = globalThis.fetch, now = () => Date.now(), uid = process.getuid?.(),
  scannerAt = SCANNER_AT, userOf = realUserOf, makePush = createPushScript, testRemote, hold = holdAlert } = {}) {
  if (testRemote !== undefined && !process.env.NODE_TEST_CONTEXT) throw new Error('pushWiring: testRemote is for tests only');
  if (typeof token !== 'function') return refusing(PUSH_NOT_WIRED.app);
  if (outsideKeysProblem(c, { none: 'none' }) !== null) return refusing(PUSH_NOT_WIRED.outside);
  const base = baseOf(c.keyDir);
  if (!base) return refusing(`robot.push: the robot key folder (keyDir) ${c.keyDir} is not where setup's layout puts it, so the push's folders can't be found from it (L1083)`);
  if (typeof scannerAt !== 'function') return refusing(PUSH_NOT_WIRED.scanner);
  let scanner;
  try { scanner = scannerAt(base); } catch (e) { return refusing(`robot.push: the secret scanner's paths could not be read (${String(e?.message ?? e).slice(0, 120)})`); }
  if (!scanner || ['bin', 'version', 'config', 'ignoreFile'].some((k) => typeof scanner[k] !== 'string' || !scanner[k])) return refusing('robot.push: the secret scanner\'s paths are incomplete (bin, version, config, ignoreFile)');
  const who = builderUid({ userOf, ownerUid: c.ownerUid, selfUid: uid });
  if (who.why) return refusing(`robot.push: ${who.why}`);
  const mirror = mirrorPath({ base });
  const badMirror = mirrorProblem(mirror, uid);
  if (badMirror) return refusing(`robot.push: ${badMirror}`);
  let privateDir;
  try { privateDir = privateFolder({ path: privatePath({ base }), uid, what: 'the scripts\' private folder', writable: true }); } catch (e) { return refusing(`robot.push: ${String(e?.message ?? e).slice(0, 200)}`); }
  if (typeof entry?.owner !== 'string' || typeof entry?.repo !== 'string') return refusing('robot.push: the products list names no owner and repo for this product');
  const repo = `${entry.owner}/${entry.repo}`;
  const outboxRoot = outboxRootPath({ base });

  // The round's token as push.mjs and the PR writer ask for it: a string, or a throw saying why not.
  const getToken = async () => {
    const r = await token();
    if (r?.ok === true && typeof r.token === 'string' && r.token) return r.token;
    throw new Error(r?.reason ?? 'no robot token');
  };
  const issues = {
    upsert: async ({ key, title, body }) => {
      if (hold({ rec, cause: key, text: `${title}: ${body}`, alert: outbox(rec, now()), now: now() }) === false) throw new Error(`the start gate's alert ${key} could not be queued`);
    },
  };
  // The PR writer masks secret-shaped text with its own masker (L1082): no mask is handed in.
  const prs = prWriter({ record: rec, fetchFn, now });
  const cache = {};   // the start gate's one-read-an-hour cache, for this round (one process per round)
  const pushCard = makePush({
    record: rec,
    rules,
    productPlace: (p) => (p === c.product ? { repo, mirror } : null),
    outsideWorkflow: c.outsideWorkflow,
    privateDir,
    scanner,
    getRobotToken: getToken,
    readRun: outsideRun({ getJson: publicJson({ fetchFn }), repo: c.outsideRepo, workflowPath: c.outsideWorkflow, slot: c.outsideSlot, tag: c.outsideTag, product: c.product }),
    workflowRule: productWorkflowRule({ rules, product: c.product }),
    issues,
    pullRequests: prs,
    gateCache: cache,
    now,
    uids: { worker: who.uid },
    ownerUid: c.ownerUid,
    outboxRoot,
    ...(testRemote ? { testRemote } : {}),
  });

  return async () => {
    const r = await pushPass({ rec, product: c.product, outboxRoot, pushCard, alert: outbox(rec, now()), now, prs, getToken, repos: [repo], hold });
    // A hold the queue refused is the pass's failure, so robot-main's own tell carries it (push-pass.mjs I5).
    if (r.untold.length) throw Object.assign(new Error(`the push pass's alerts could not be queued: ${r.untold.join(', ')}`), { tell: `untold: ${r.untold.join(', ')}` });
    return r;
  };
}
