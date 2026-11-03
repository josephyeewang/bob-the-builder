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

import { isAbsolute } from 'node:path';
import { openRecord } from '../modules/M9-record/writer.mjs';
import { makeReader, readProducts } from '../modules/M10-rules/reader.mjs';
import { makeEngine } from '../modules/M10-rules/engine.mjs';
import { ROLES_DIR } from '../modules/M10-rules/roles.mjs';
import { makeRules } from '../shared/rules.mjs';
import { readOnlyClient, tokenFile } from '../modules/M6-merge-gate/watch-only.mjs';
import { queueAlert } from '../modules/M11-dispatcher/alerts.mjs';

export const CONFIG_KEYS = Object.freeze(['installRoot', 'wiring', 'lockFile', 'runDeadlineMs', 'product', 'recordRoot', 'ownerUid', 'productsFile', 'rulesStateDir', 'tokenFile']);
const PATHS = Object.freeze(['recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile']);
const NAME = /^[A-Za-z0-9._-]+$/;

// The ports PRs C and D wire (M11 README, "The tick's ports"). Each throws when called: never a stand-in answer.
export const NOT_WIRED = Object.freeze(['board', 'healthy', 'resume', 'outboxSessions', 'wait', 'startReadonly', 'replyToLead', 'leads',
  'sessions', 'probe', 'launch', 'stopGroup', 'saveWork', 'hostLock', 'pauseLead', 'gateAlive', 'stopSession', 'hasReviewer',
  'requestReview', 'reviewAlerts', 'filesOf', 'sendFrontDoor', 'restartFrontDoor', 'startMinibase', 'frontDoorAlive',
  'strayFrontDoor', 'frontDoorHandoff', 'approvals']);
export const NOT_WIRED_CLEANUP = Object.freeze(['mirrorFor', 'git', 'saveWork']);
export const notWiredText = (port) => `not wired yet: ${port} (R-0b-162)`;
export const refusing = (port) => () => { throw new Error(notWiredText(port)); };

// `keys` and `paths`: the robot job's wiring (robot-wiring.mjs) checks its own config with its own lists.
export function checkConfig(c, { keys = CONFIG_KEYS, paths = PATHS } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config: must be an object');
  // A misspelt key would be ignored and its default used instead, so an unknown key stops the start.
  const extra = Object.keys(c).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`config: unknown key ${extra.join(', ')}`);
  if (typeof c.product !== 'string' || !NAME.test(c.product)) throw new Error('config: product must be a product name (letters, digits, . _ -)');
  for (const k of paths) if (typeof c[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (!Number.isSafeInteger(c.ownerUid) || c.ownerUid < 0) throw new Error('config: ownerUid must be a Mac user id');
  return c;
}

/** The alert port until a channel to Joe exists: logged, and answered "not delivered", so it stays queued. */
export function logOnlyAlert(log) {
  return async (text) => { log(`dispatcher: alert not sent (no channel to Joe is wired yet): ${text}`); return false; };
}

/**
 * The Record and the rules, built the one way both jobs use (this file and robot-wiring.mjs). `c` is a checked config
 * with product, recordRoot, ownerUid, productsFile, rulesStateDir and tokenFile; `who` names the job in its log lines.
 * → { rec, rules, gh (read-only), entry (the product's products.json entry) }
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
    running: refusing('running'),
    rolesDir: ROLES_DIR,
    clock: now,
  });
  const rules = makeRules(engine);
  // The store's own alerts (a refused write, a store fault) go to the log, "not delivered": the store keeps them in its
  // own unsent file and tells them again. Never into the record's queue: the store alerts from inside its own writes.
  const storeAlert = (e) => { log(`${who}: record alert not sent: ${JSON.stringify(e)}`); return false; };
  ({ record: rec } = openRecord({ root: c.recordRoot, product: c.product, ownerUid: c.ownerUid, rules, alert: storeAlert, now }));
  await reader.refresh();
  return { rec, rules, gh, entry };
}

export async function wire(config, { limitedSync, log = (s) => process.stderr.write(`${s}\n`), fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  void limitedSync;   // the synchronous ports (PRs C, D) run their commands through it
  const c = checkConfig(config);
  const { rec, rules } = await recordAndRules(c, { who: 'dispatcher', log, fetchFn, now });
  const ports = { alert: logOnlyAlert(log) };
  for (const k of NOT_WIRED) ports[k] = refusing(k);
  // cleanupPass reads a missing copies folder as "nothing to clean" (cleanup.mjs), which would pass in silence. So the
  // folder itself refuses: the tick spreads this object into the step, and the read throws inside the step.
  ports.cleanup = Object.defineProperty(Object.fromEntries(NOT_WIRED_CLEANUP.map((k) => [k, refusing(`cleanup.${k}`)])), 'copiesRoot',
    { enumerable: true, get: refusing('cleanup.copiesRoot') });
  return { rec, rules, ports };
}
