// dispatcher-wiring.mjs — the wiring module the Dispatcher's config names (R-0b-162, LEAD-CALLS L229): the one place
// the tick's ports are joined to the real things. main.mjs imports it and calls `wire(config, { limitedSync })`.
//
// WHY. main.mjs and tick.mjs take every outside effect as a port (M11 README, "The tick's ports"), so the pass can be
// tested without a Mac. Until this file, nothing built those ports: main.mjs named a wiring module that did not exist,
// so the Dispatcher could not start on the Mini at all.
//
// WHAT IS REAL (PR A of R-0b-162):
//   - the Record: M9 openRecord, the Store Writer, at config.recordRoot, owned by config.ownerUid;
//   - the rules: M10's reader (GitHub main, Joe-approved versions only) behind M10's engine and shared/rules.mjs, the
//     same build the day-one test uses; the GitHub client can only read (M6 watch-only readOnlyClient) and takes its
//     token from a private file of this user's (watch-only tokenFile), never from the config itself;
//   - the lock, the deadline and the watchdog: main.mjs's own.
// WHAT IS NOT WIRED YET: every other port. Each one throws `not wired yet: <port>` when called, so the step that needs it
// fails, and tick.mjs tells Joe ("the Dispatcher's <step> step failed: not wired yet: …", once per cause per day) and
// keeps the step's own hold: with no session list nothing starts, stops or merges. Nothing is answered with a made-up
// value (an empty session list would read as "nothing is running"). PRs C and D of R-0b-162 replace these.
//
// THE ALERT PORT. No module sends Joe a message yet (no phone or message channel exists in the code). Until one does,
// the alert port writes the text to stderr (the login job's log) and answers false, "not delivered": every alert stays
// in the record's unsent-alerts queue (alerts.mjs), counted, never marked told. The Record's own store alerts and the
// rules reader's alerts take the same honest answer or go into that queue (below).
//
// The config (one JSON file, main.mjs's argument). Every path is absolute; nothing here names a machine or a product.
//   installRoot, wiring, lockFile, runDeadlineMs   main.mjs's own (see main.mjs); the config, the wiring and main.mjs
//                  must be files of the installed copy at installRoot (shared/job-config.mjs, L253)
//   product        the product this Dispatcher runs (one Record per product, M9)
//   recordRoot     the product's Record folder (M9 store)
//   ownerUid       the Mac user that owns the Record (M9 store checks it)
//   productsFile   M10's products.json: [{ product, owner, repo, joe_github_id }]; it must list `product`
//   rulesStateDir  M10 reader's folder: the last good rules, and approved-rules.json (the stopgap approval list)
//   tokenFile      a GitHub token that can read the product's repository: this user's own file, mode 600
//   approvalsStateDir  M2 Approvals' own folder: what it has told Joe once. Each product gets its own subfolder in it
//                  (<approvalsStateDir>/<product>), so two products never share a told-once mark (L295 MAT-2). At boot
//                  the folder and the product's subfolder are made if missing (the parent must exist) and the start is
//                  refused unless each is a plain folder of this user's, private (no group or other access) and
//                  writable (L295 MAT-1): a folder M2 can't write would turn a product on with Joe never told.
//   reviewRequestsDir  the review runner's requests/ folder, where a review is asked for (M4 review-runner.mjs FOLDERS)
//   reviewStatusFile   the runner's status.json: what runs, and its alerts. Missing, or older than 3 minutes, is an error
//   reviewUid          the review user's Mac user id: the status file and its folder must be that user's. It may be
//                  neither the Dispatcher's own user nor ownerUid (L674)
//   reviewRunnerLog    the runner's log file (M4 review-daemons.mjs RUNNER_LOG in its log folder), named in an alert
//   reviewInstallRoot  the reviewers' installed copy, which root's updater keeps (review-updater.mjs installRoot). Its
//                  own key: the Dispatcher's installRoot may be a copy of this user's, so the two can differ (L639)
//   reviewRoot     the review runner's own folder (review-runner-main.mjs root), whose ended/ records reviewEnded reads.
//                  Its own key, not reviewRequestsDir's parent (L739). It must be there at start; its owner (reviewUid)
//                  is checked on each call, as the other review ports check theirs (L674)
//   mirror         the product's git mirror (setup layout.mjs mirrorPath: orchestrate's, 0755): cleanup and filesOf read
//                  it. At start it must be a plain folder of this user's that no one else can write (worker-ports.mjs)
//   sealRoot       where cleanup seals a copy's bundle it could not prove safe: made if missing, and refused at start
//                  unless a plain folder of this user's, private and writable, the approvals folder's check (L295)
//   hostLockPath   Joe's host.lock (~/Dropbox/99.0 Claude Sync/host.lock in the owner's home, L739). No file there is
//                  "no host claimed"; a file or folder that can't be read is "not known", told, never "no host"
//   hostLockUid    the owner's Mac user id: host.lock is read only when the opened file is that user's, so a link, a hard
//                  link or a swap in the owner's folder never puts another user's file in the Record (L763). It may not
//                  be the Dispatcher's own user (which could then write who the host is), root or the review user; it is
//                  checked before the start makes anything (L805)
//   workerRequestsDir  the worker runner's requests folder (setup layout.mjs workerRunnerPaths: requests, the builder's,
//                  which orchestrate may add files to, L921): a stop request goes there. It must be there at start; its
//                  owner (workerUid), mode and access list are checked on each write (L943 m4)
//   workerStatusFile   the worker runner's status.json in its own folder (runner/status.json): what runs. Missing, stale
//                  or not the worker runner user's makes sessions, board, outboxSessions, probe and stopSession "not known" (a throw)
//   workerUid      the builder user's Mac user id, which the worker runner runs as (wiring/runner-job.mjs, L1079): not
//                  the owner's (hostLockUid), the Dispatcher's own or the review user's, or the start is refused
//
// THE APPROVALS PORT (L270). Approvals' schedule pass runs for this product each tick: it turns the product on the
// first time its rules file says onboarding.state: active (M2 onboard.mjs), which is all the first cutover needs from it.
// Its GitHub writes (a decision's pull request, a review request) and the transcript copies need a GitHub identity that
// can write and the session copies, neither wired yet: `gh` and `copies` refuse. M2 answers each such refusal with an
// alert for that ask, once per ask and cause and again each day while the ask waits (schedule.mjs askOnce, kept in the
// product's subfolder; L309 MAT-2), and the step stays ok. No `push`: no phone channel exists, so M2 says so per ask
// (approvals_no_push), on the same terms.

import { privateFolder } from './private-folder.mjs';
import { isAbsolute, join } from 'node:path';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { makeReader, readProducts } from '../modules/M10-rules/reader.mjs';
import { PRODUCT } from '../shared/product-paths.mjs';
import { makeEngine } from '../modules/M10-rules/engine.mjs';
import { ROLES_DIR } from '../modules/M10-rules/roles.mjs';
import { makeRules } from '../shared/rules.mjs';
import { readOnlyClient, tokenFile } from '../modules/M6-merge-gate/watch-only.mjs';
import { queueAlert } from '../modules/M11-dispatcher/alerts.mjs';
import { writeRulesSnapshot } from '../modules/M11-dispatcher/budget.mjs';
import { notWiredText, refusing } from './not-wired.mjs';
import { NOT_WIRED_WORKER, cleanupProblem, hostLockOwnerProblem, workerPorts, workerUidProblem } from './worker-ports.mjs';
import { NOT_WIRED_REVIEW, reviewPorts } from './review-ports.mjs';
import { NOT_WIRED_PHONE, phonePorts } from './phone-ports.mjs';

// The review runner's (L615, L639; review-ports.mjs reviewRunner). The Dispatcher's alone: the robot config refuses them.
export const REVIEW_CONFIG_KEYS = Object.freeze(['reviewRequestsDir', 'reviewStatusFile', 'reviewUid', 'reviewRunnerLog', 'reviewInstallRoot']);
// The worker and cleanup ports' (worker-ports.mjs, and filesOf in review-ports.mjs, L739). The Dispatcher's alone too.
// outboxRoot and copiesRoot are the TOP folders (setup layout.mjs outboxRootPath, workerCopiesPath: <base>/outboxes and
// <base>/worker-copies), never a product's: each product's own folder is under them (L836, L887).
// The worker runner's requests folder, status file and Mac user (L921, L925: owner-status.mjs ownerSyncPorts). Its
// outboxes are outboxRoot's, so there is no second outbox key.
export const WORKER_CONFIG_KEYS = Object.freeze(['reviewRoot', 'mirror', 'sealRoot', 'outboxRoot', 'copiesRoot', 'hostLockPath', 'hostLockUid', 'workerRequestsDir', 'workerStatusFile', 'workerUid']);
const UID_KEYS = Object.freeze(['reviewUid', 'hostLockUid', 'workerUid']);
// rulesSnapshotFile: optional, the Dispatcher's alone (the robot job's list leaves it out).
export const CONFIG_KEYS = Object.freeze(['installRoot', 'wiring', 'lockFile', 'runDeadlineMs', 'product', 'recordRoot', 'ownerUid', 'productsFile', 'rulesStateDir', 'tokenFile', 'approvalsStateDir',
  'rulesSnapshotFile', ...REVIEW_CONFIG_KEYS, ...WORKER_CONFIG_KEYS]);
const PATHS = Object.freeze(['recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'approvalsStateDir', ...[...REVIEW_CONFIG_KEYS, ...WORKER_CONFIG_KEYS].filter((k) => !UID_KEYS.includes(k))]);

// The ports PRs C and D wire (M11 README, "The tick's ports"), each named in the port file that will answer it. A port
// on a list throws when called: never a stand-in answer. To wire one, change its port file; this file doesn't change.
export const PORT_GROUPS = Object.freeze([
  Object.freeze({ notWired: NOT_WIRED_WORKER, build: workerPorts }),
  Object.freeze({ notWired: NOT_WIRED_REVIEW, build: reviewPorts }),
  Object.freeze({ notWired: NOT_WIRED_PHONE, build: phonePorts }),
]);
export { notWiredText, refusing };
// Every port the tick needs from the wiring. A port's wiring moves between the port files; this list changes only when the
// tick starts reading a new port. Options with defaults are not ports. `alert` and `approvals` are answered here.
// `outboxRoot` is a port, not an option (#403 r1 M1): without it the pass checks a launch's outbox by its name only, so
// it is answered from the config's own outboxRoot (worker-ports.mjs, L887), never left to a default. `product` is one too
// (L927): the stop step acts only on this Dispatcher's product's sessions, so it is the config's, never a default.
const WIRED_HERE = Object.freeze(['alert', 'approvals']);
export const TICK_PORTS = Object.freeze([...WIRED_HERE, 'cleanup', 'board', 'filesOf', 'frontDoorAlive', 'frontDoorHandoff', 'gateAlive', 'hasReviewer', 'healthy',
  'hostLock', 'launch', 'leads', 'mainSha', 'outboxRoot', 'outboxSessions', 'pauseLead', 'planReviewAnswer', 'planReviewsRunning', 'planRows', 'planView', 'probe', 'product', 'proposals', 'replyToLead', 'requestReview',
  'restartFrontDoor', 'resume', 'reviewAlerts', 'reviewEnded', 'saveWork', 'sendFrontDoor', 'sessions', 'startMinibase', 'startPlanReview', 'startReadonly',
  'stopGroup', 'stopReview', 'stopSession', 'strayFrontDoor', 'wait']);

// `keys` and `paths`: the robot job's wiring (robot-wiring.mjs) checks its own config with its own lists.
export function checkConfig(c, { keys = CONFIG_KEYS, paths = PATHS, selfUid = process.getuid() } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config: must be an object');
  // A misspelt key would be ignored and its default used instead, so an unknown key stops the start.
  const extra = Object.keys(c).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`config: unknown key ${extra.join(', ')}`);
  // Setup's product rule (shared/product-paths.mjs PRODUCT, #378 r1 m3): the name its folders are made under.
  if (typeof c.product !== 'string' || !PRODUCT.test(c.product)) throw new Error('config: product must be a product name (lower case letters, digits and -, a letter or digit first)');
  for (const k of paths) if (typeof c[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.rulesSnapshotFile !== undefined && (typeof c.rulesSnapshotFile !== 'string' || !isAbsolute(c.rulesSnapshotFile))) throw new Error('config: rulesSnapshotFile must be an absolute path');
  if (!Number.isSafeInteger(c.ownerUid) || c.ownerUid < 0) throw new Error('config: ownerUid must be a Mac user id');
  // host.lock's owner, with the rest of the config: before wire() makes any folder or opens the Record (L805 m1). The
  // Dispatcher's own user is this process's; workerPorts checks it again with the start's selfUid.
  if (keys.includes('hostLockUid')) { const bad = hostLockOwnerProblem(c.hostLockUid, selfUid, c.reviewUid); if (bad) throw new Error(`config: ${bad}`); }
  // The worker runner's user, the builder user and never the owner (L1079), before wire() makes a folder (L943 m3).
  if (keys.includes('workerUid')) { const bad = workerUidProblem(c, selfUid); if (bad) throw new Error(`config: ${bad}`); }
  return c;
}

// privateFolder lives in private-folder.mjs (L739: worker-ports.mjs uses it too, without importing this file).
export { privateFolder };

/** The product's own approvals folder, <approvalsStateDir>/<product>, checked (and made) with its parent at boot. */
export function approvalsDir(c, { uid = process.getuid() } = {}) {
  const what = 'the approvals state folder (approvalsStateDir)';
  privateFolder({ path: c.approvalsStateDir, uid, what, create: true, writable: true });
  return privateFolder({ path: join(c.approvalsStateDir, c.product), uid, what: "the product's approvals state folder", create: true, writable: true });
}

export const APPROVALS_NOT_WIRED = Object.freeze({ gh: ['get', 'post', 'put', 'patch'], copies: ['sync', 'told', 'pending', 'done'] });
/** One product's approvals context (tick.mjs approvalsStep): its own checked state folder; GitHub writes and copies refuse. */
export function approvalsFor(c, entry, stateDir) {
  const refuse = (group) => Object.freeze(Object.fromEntries(APPROVALS_NOT_WIRED[group].map((k) => [k, refusing(`approvals.${group}`)])));
  return { product: c.product, owner: entry.owner, repo: entry.repo, stateDir, gh: refuse('gh'), copies: refuse('copies') };
}

/** The alert port until a channel to Joe exists: logged, and answered "not delivered", so it stays queued. */
export function logOnlyAlert(log) {
  return async (text) => { log(`dispatcher: alert not sent (no channel to Joe is wired yet): ${text}`); return false; };
}

/**
 * The Record and the rules, built the one way both jobs use (this file and robot-wiring.mjs). `c` is a checked config
 * with product, recordRoot, ownerUid, productsFile, rulesStateDir and tokenFile; `who` names the job in its log lines.
 * → { rec, rules, gh (read-only), entry (the product's products.json entry), reader (M10's, refreshed once), products }
 */
export async function recordAndRules(c, { who, log, fetchFn, now }) {
  const products = readProducts(c.productsFile);
  const entry = products.find((p) => p.product === c.product);
  if (!entry) throw new Error(`config: ${c.productsFile} does not list the product ${c.product}`);
  // M6's reader words its refusals for the watch-only week; here they name this config key instead.
  const readToken = tokenFile(c.tokenFile);
  const token = () => { try { return readToken(); } catch (e) { throw new Error(String(e?.message ?? e).replace('the watch-only token file', 'the GitHub token file (tokenFile)')); } };
  const gh = readOnlyClient({ token, fetchFn });

  let rec = null;
  // The reader's alert, by kind and product: into the record's queue once the record is open (the reader is first
  // asked in refresh(), below, after it is). False, "not delivered", before then, and when the Record refuses the entry
  // or the queue's cap drops it (queueAlert answers null, turned into false here): the reader then asks again on the next pass.
  const readerAlert = (a) => (rec ? queueAlert(rec, `the rules for ${a.product} could not be used (${a.reason})${a.detail ? `: ${a.detail}` : ''}`, { now: now() }) ?? false : false);
  const reader = makeReader({ gh, stateDir: c.rulesStateDir, products, alert: readerAlert, now });
  const engine = makeEngine({
    products: products.map((p) => p.product),
    rulesState: (p) => reader.state(p),
    // The engine reads the product's state from the Record's product document; none reads as paused (no starts).
    productState: (p) => rec?.read('product', p)?.doc ?? null,
    // How many editing sessions run: the session list, not wired yet. A throw is "count unknown", which the engine refuses.
    // TO-DO (L322, in the change that wires this): in M11 pass.mjs a Tier-1 card M10 refuses with its cap words
    // ("editing cap reached for <p> (<n>)", "... on this Mac (<n>)") is refused at the rules.may step and never reaches
    // capRefusal / tier1Waiting, so Tier-2 cards are not held behind it in amber. Make that step count it (capRefusal
    // reading M10's words), with a test. Until this is wired every start is refused here as "count unknown", so no card
    // gets the cap words.
    running: refusing('running'),
    rolesDir: ROLES_DIR,
    clock: now,
  });
  const rules = makeRules(engine);
  // The store's own alerts go to the log, "not delivered". Those the store keeps (`alertOrKeep`: a step never redone) stay in
  // its unsent file and are told again; a refused write (`say`) is the log only. Never into the record's queue: the store
  // alerts from inside its own writes.
  const storeAlert = (e) => { log(`${who}: record alert not sent: ${JSON.stringify(e)}`); return false; };
  ({ record: rec } = openRecord({ root: c.recordRoot, product: c.product, ownerUid: c.ownerUid, rules, alert: storeAlert, now }));
  await reader.refresh();
  return { rec, rules, gh, entry, reader, products: products.map((p) => p.product) };
}

/**
 * The tick's ports: refusing ones for every name on a group's list, then whatever each group's port file answers. Each port
 * has one home, or the start stops: a port both answered and listed, on two lists, answered by two files, a port the tick
 * doesn't read, one neither answered nor listed, or a file answering `alert` or `approvals`. The cleanup group follows
 * the same rules (cleanupProblem). So no port can look wired while it isn't, and none can be replaced or lost in silence.
 * A port file gets `ctx`: { config, rec, rules, gh, entry, stateDir, log, limitedSync, fetchFn, now, selfUid }; `gh` is the
 * read-only GitHub client the rules reader uses (L615). `selfUid` is this process's user; main.mjs passes none, and a test
 * stands in for it (L674).
 */
export async function wire(config, { limitedSync, log = (s) => process.stderr.write(`${s}\n`), fetchFn = globalThis.fetch, now = () => Date.now(), groups = PORT_GROUPS, selfUid = process.getuid() } = {}) {
  const c = checkConfig(config);
  // Before the Record opens: a state folder M2 can't use stops the start, so no product is turned on untold (L295 MAT-1).
  const stateDir = approvalsDir(c);
  const { rec, rules, gh, entry, reader, products } = await recordAndRules(c, { who: 'dispatcher', log, fetchFn, now });
  // Launch check 12's rules for the two runners (L1001, M11 budget.mjs): one launch is one pass, and every pass whose own
  // rules are usable (ok or last_good) writes the snapshot again, changed or not, so its written_at stays fresh. One that
  // could not reach GitHub leaves it to go stale; any other refusal removes it, so the runners refuse at once (PR-2 r2 M1).
  // A write, or a removal, that fails is logged and queued; a write that fails while the rules are usable drops the last
  // snapshot too, so the runners never decide on older rules than this pass's (L1042 m1).
  if (c.rulesSnapshotFile) {
    const w = writeRulesSnapshot(c.rulesSnapshotFile, { product: c.product, products, state: (p) => reader.state(p), now: now() });
    // Alerted on the write's own read of the rules (L1042 c2); each reason says once what it means for the runners (c1).
    if (!w.ok && (w.removeFailed || w.usable)) {
      log(`dispatcher: ${w.reason}`);
      try { queueAlert(rec, `check 12's rules for the runners could not be kept: ${w.reason}`, { now: now() }); } catch (e) { log(`dispatcher: that could not be queued (${e?.message ?? e})`); }
    } else if (!w.ok) log(`dispatcher: ${w.reason}`);
  }
  const ports = { alert: logOnlyAlert(log) };
  for (const { notWired } of groups) for (const k of notWired) ports[k] = refusing(k);
  ports.approvals = () => [approvalsFor(c, entry, stateDir)];
  const ctx = Object.freeze({ config: c, rec, rules, gh, entry, stateDir, log, limitedSync, fetchFn, now, selfUid });
  const stopOn = (why, names) => { if (names.length) throw new Error(`${why}: ${names.join(', ')}`); };
  const lists = groups.flatMap((g) => g.notWired);
  const listed = new Set(lists);
  stopOn('these ports are on two lists', lists.filter((k, i) => lists.indexOf(k) !== i));
  stopOn('no tick step reads these ports', lists.filter((k) => !TICK_PORTS.includes(k)));
  const answers = new Set();
  for (const { build } of groups) {
    const answered = build(ctx);
    const names = Object.keys(answered);
    stopOn('these ports are wired but still listed as not wired', names.filter((k) => listed.has(k)));
    stopOn('only the wiring answers these ports', names.filter((k) => WIRED_HERE.includes(k)));
    stopOn('two port files answer these ports', names.filter((k) => answers.has(k)));
    stopOn('no tick step reads these ports', names.filter((k) => !TICK_PORTS.includes(k)));
    for (const k of names) answers.add(k);
    Object.assign(ports, answered);
  }
  stopOn('nothing answers or lists these ports, which the tick needs', TICK_PORTS.filter((k) => !WIRED_HERE.includes(k) && !listed.has(k) && !answers.has(k)));
  const cleanup = cleanupProblem(ports.cleanup);
  if (cleanup) throw new Error(cleanup);
  return { rec, rules, ports };
}
