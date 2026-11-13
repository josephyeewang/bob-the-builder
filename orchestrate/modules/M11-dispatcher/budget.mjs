// budget.mjs — launch check 12's inputs for the two runners (L83 M-3, L995): M11's own gate, fed from the Dispatcher's
// rules snapshot and a read-only view of the Record, so a runner asks the same start gate the pass asks.
//
//   budget(config, { now, io })                                     → { rules, rec, bandsNow, runningNow }: check12's
//                                                                     inputs (gate.mjs), for the review runner's `budget`
//                                                                     module and the worker runner's
//   writeRulesSnapshot(file, { product, products, state, now, uid })  the Dispatcher's write, after every pass whose own
//                                                                     rules are usable (dispatcher-wiring.mjs, L1001)
//   readRulesSnapshot(file, { uid, now, graceMs, readers, lstat, acl })  the runners' read
//   rulesSnapshotFolderProblem(dir, uid) / rulesAclProblem(path, readers)  the folder's and the access lists' checks (the
//                                                                     access-list read and userName live in
//                                                                     wiring/worker-ports.mjs: no M11 file starts a process)
//
// The rules: the Dispatcher's rules reader (M10 reader.mjs) is the only one that fetches them from GitHub. After each
// pass whose own product's reader state is ok or last_good, the Dispatcher writes the whole product list, and every
// product's usable rules text with its reviewed commit and blob and when it was last fetched, into its product's
// snapshot (setup/layout.mjs dispatcherRulesPath: products/<p>/rules, orchestrate's, 0700, an access list giving read to
// the review user and the owner only; L1002). It writes even when nothing changed, so `written_at` stays fresh; a reader
// that could not reach GitHub stops the writes, and the snapshot then goes stale; any other deny_all (the rules file
// deleted, say) removes it, so the runners refuse at once, as the Dispatcher does (PR-2 r2 M1). budget builds M10's engine over that, as the
// Dispatcher's own is built (dispatcher-wiring.mjs recordAndRules): every product listed, one with no usable rules read
// as deny_all (so, as there, every start on the Mac is refused and the Mac-wide keys combine over every product), the
// real commit and blob, the products' states from the Record, and the engine's own running count refused ("count unknown",
// so its may() passes no editing start; check 12's start gate counts sessions itself, through runningNow). A snapshot that is missing, written or holding a fetch older than the
// reader's own grace (M10 FETCH_GRACE_MS) or ahead of the clock, a link, not the Record owner's, or that others can read
// or write (the file or its folder, by mode or access list) is refused, plainly: check 12 then refuses the start and
// says why. It is read at most once a second, so one check 12 decides on one snapshot; its age is checked on every use.
//
// What it holds: the rules text (policy.yaml) and its commit and blob, the status, the product and the times. The text
// carries account fields (accounts.current, the owner's GitHub id and time zone) and repository paths, and no token: that
// is why it is closed to all but the two runner users (L1001, L1002).
//
// The Record: M9 read-view.mjs recordView, read only, on the same checks as the review runner's own reads. The sessions:
// wiring/worker-ports.mjs sessionsNow, the one reading the Dispatcher's caps count from (L994).

import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { FETCH_GRACE_MS } from '../M10-rules/reader.mjs';
import { makeEngine } from '../M10-rules/engine.mjs';
import { parsePolicy } from '../M10-rules/policy.mjs';
import { ROLES_DIR } from '../M10-rules/roles.mjs';
import { makeRules } from '../../shared/rules.mjs';
import { recordView } from '../M9-record/read-view.mjs';
import { currentBands } from './usage.mjs';
import { signedInAccount } from './tick.mjs';
import { rulesAclProblem, sessionsNow, userName } from '../../wiring/worker-ports.mjs';

// The two access-list reads run /bin/ls and /usr/bin/id, so they live in the wiring: no Dispatcher file starts a process
// (only-send-safe.test.mjs). They are handed on from here for the runners and the tests.
export { rulesAclProblem, userName };

export const SNAPSHOT_FORMAT = 1;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const USABLE = Object.freeze(['ok', 'last_good']);
const HEX40 = /^[0-9a-f]{40}$/;
const RULE_CALLS = Object.freeze(['may', 'get', 'num', 'dec', 'flag', 'classify']);
const NAME = /^[A-Za-z0-9._-]{1,200}$/;
// How long one read of the snapshot is used for (L1001 review m3): one check 12 decides on one snapshot.
export const SNAPSHOT_REUSE_MS = 1000;
// The rights an access-list entry may give are wiring/worker-ports.mjs ACL_READS (reading only).

const iso = (ms) => new Date(ms).toISOString();

/** Why the folder `dir` can't hold a snapshot, or null: a plain folder of `uid`'s, not a link, that group and others can
 * neither read nor write (L1002: the access list is what lets the two runner users read). */
export function rulesSnapshotFolderProblem(dir, uid, { lstat = lstatSync } = {}) {
  let st;
  try { st = lstat(dir); } catch (e) { return `the rules snapshot's folder ${dir} can't be read (${e?.code ?? e})`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `the rules snapshot's folder ${dir} is not a plain folder`;
  if (st.uid !== uid) return `the rules snapshot's folder ${dir} is not the Dispatcher's user's (uid ${st.uid})`;
  if (st.mode & 0o077) return `the rules snapshot's folder ${dir} can be read or written by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}


/**
 * The Dispatcher's write (L1001): `state(p)` is M10 reader.state. Written only when `product`'s own state is ok or
 * last_good; with it, the whole list `products` and the rules of each whose state is usable (one with none is read as
 * deny_all by the runners, as by the Dispatcher's engine; L1001 review M1), each with when it was last fetched (L1001
 * review M2: the runners' grace counts from that fetch, as the reader's own does). Atomic: a new file beside it (0600, made
 * exclusive), synced, renamed over, and the folder synced. → { ok: true } or { ok: false, usable, reason, removed? |
 * removeFailed? }; never throws. `usable` is whether the own rules were usable on this one read of them (L1042 c2: the
 * Dispatcher alerts on that, never on a second read at another time).
 *
 * The last snapshot is dropped (dropSnapshot) on every failure but two: GitHub not reached (it goes stale, L1001), and a
 * folder that is not safe (nothing is touched there; the runners refuse it anyway). So a write that fails while the rules
 * are usable never leaves the runners deciding on older rules than the Dispatcher's (L1042 m1).
 */
// M10 reader.mjs refreshOne's words for a launch that could not reach GitHub (the only refusal left to go stale).
const UNREACHED = /^GitHub unreachable: /;
export function writeRulesSnapshot(file, { product, products, state, now = Date.now(), uid = process.getuid() }) {
  if (typeof file !== 'string' || !isAbsolute(file)) return { ok: false, usable: false, reason: 'the rules snapshot needs a full path' };
  let tmp = null;
  let usable = false;
  let why;
  try {
    const own = state(product);
    usable = USABLE.includes(own?.status);
    if (!usable) {
      if (UNREACHED.test(String(own?.reason ?? ''))) {
        const said = `${product}'s rules are ${own.status} (${String(own.reason).slice(0, 200)}), so no snapshot is written (it goes stale)`;
        // An emptied one is what an earlier pass left when it could not remove the snapshot: removed now (L1042 m1).
        if (!emptiedSnapshot(file)) return { ok: false, usable, reason: said };
        try { rmSync(file); } catch (e) { return { ok: false, usable, reason: `${said}; the emptied one an earlier pass left still can't be removed (${e?.code ?? e?.message ?? e}), and the runners refuse it` }; }
        return { ok: false, usable, removed: true, reason: `${said}; the emptied one an earlier pass left is removed` };
      }
      // Any other refusal (the rules file or main deleted, a reader error, no rules ever adopted) is the Dispatcher
      // refusing now, so the runners refuse at once, as it does (PR-2 r2 M1). A reason in other words is dropped too.
      return dropped(file, usable, `${product}'s rules are ${own?.status ?? 'not known'}${own?.reason ? ` (${String(own.reason).slice(0, 200)})` : ''}`);
    }
    why = 'the rules snapshot could not be written';
    if (!Array.isArray(products) || !products.includes(product) || !products.every((p) => typeof p === 'string' && NAME.test(p)) || new Set(products).size !== products.length) return dropped(file, usable, `the product list does not name ${product} once, by plain names`);
    const rules = {};
    for (const p of products) {
      const s = state(p);
      if (!USABLE.includes(s?.status)) continue;
      if (typeof s.text !== 'string' || !HEX40.test(s.commit ?? '') || !HEX40.test(s.blob ?? '') || !Number.isFinite(s.fetchedAt)) {
        if (p === product) return dropped(file, usable, `${product}'s rules state carries no text, commit, blob and fetch time`);
        continue;
      }
      rules[p] = { status: s.status, text: s.text, commit: s.commit, blob: s.blob, fetched_at: iso(s.fetchedAt) };
    }
    const dir = dirname(file);
    const bad = rulesSnapshotFolderProblem(dir, uid);
    if (bad) return { ok: false, usable, reason: `${bad}, so nothing is written there, and the runners refuse it` };
    const body = Buffer.from(`${JSON.stringify({ format: SNAPSHOT_FORMAT, product, written_at: iso(now), products, rules })}\n`, 'utf8');
    if (body.length > MAX_SNAPSHOT_BYTES) return dropped(file, usable, `the rules snapshot would be ${body.length} bytes, over ${MAX_SNAPSHOT_BYTES}`);
    tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.new`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      let off = 0;
      while (off < body.length) off += writeSync(fd, body, off, body.length - off);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, file);
    tmp = null;
    const dfd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
    return { ok: true };
  } catch (e) {
    return dropped(file, usable, `${why ?? `${product}'s rules could not be read`} (${e?.code ?? e?.message ?? e})`);
  } finally {
    if (tmp) { try { rmSync(tmp, { force: true }); } catch { /* the next write makes its own */ } }
  }
}

// Whether `file` is an empty plain file: only dropSnapshot leaves one (every write is a whole JSON line). Never throws.
function emptiedSnapshot(file) {
  try { const st = lstatSync(file); return st.isFile() && st.size === 0; } catch { return false; }
}

// The last snapshot dropped, so the runners refuse at once. One that can't be removed is emptied in place instead
// (opened as itself, never through a link, and only while it is the file's one name), which the runners refuse just the
// same and a later pass removes, even one that can't reach GitHub (L1042 m1). → { removed } | { emptied } | { failed }.
function dropSnapshot(file) {
  try { rmSync(file, { force: true }); return { removed: true }; } catch (e) {
    const code = e?.code ?? e?.message ?? e;
    let fd = null;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) return { failed: code };
      ftruncateSync(fd, 0);
      fsyncSync(fd);
      return { emptied: code };
    } catch { return { failed: code }; } finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
  }
}

// What dropping it answers, said once, with what it means for the runners (L1042 c1: one consequence per reason).
function dropped(file, usable, why) {
  const d = dropSnapshot(file);
  if (d.removed) return { ok: false, usable, removed: true, reason: `${why}, so the rules snapshot is removed: the runners refuse at once` };
  if (d.emptied) return { ok: false, usable, removeFailed: true, reason: `${why}; the rules snapshot could not be removed (${d.emptied}), so it is emptied instead: the runners refuse at once, and a later pass removes it` };
  return { ok: false, usable, removeFailed: true, reason: `${why}; the last rules snapshot could not be removed or emptied (${d.failed}): the runners may use it for up to ${Math.round(FETCH_GRACE_MS / 1000)} s from its last fetch` };
}

/**
 * Why snapshot `s` (a read one) can't be used at `now`, or null: written, or holding a fetch, more than `graceMs` ago, or
 * ahead of the clock (L1001 review M2: the reader's own grace counts from its last fetch, so the runners' does too).
 */
export function snapshotAgeProblem(s, now, graceMs = FETCH_GRACE_MS) {
  const where = `the Dispatcher's rules snapshot ${s.file}`;
  const sec = Math.round(graceMs / 1000);
  if (s.writtenAtMs > now) return `${where} was written at ${s.writtenAt}, ahead of this Mac's clock`;
  if (now - s.writtenAtMs > graceMs) return `${where} is stale: written at ${s.writtenAt}, over ${sec} s ago (the Dispatcher's rules reader has not had usable rules since, or it has not run)`;
  for (const [p, r] of Object.entries(s.rules)) {
    const at = Date.parse(r.fetched_at);
    if (at > now) return `${where} holds rules for ${p} fetched at ${r.fetched_at}, ahead of this Mac's clock`;
    if (now - at > graceMs) return `${where} is stale: the rules for ${p} were last fetched at ${r.fetched_at}, over ${sec} s ago`;
  }
  return null;
}

/**
 * The runners' read: → { ok: true, file, product, products, writtenAt, writtenAtMs, rules: { [p]: { status, text, commit,
 * blob, fetched_at } } } or { ok: false, reason }; never throws. `uid` is the Dispatcher's user (the Record's owner), `now`
 * ms, `readers` the user names the access lists may let read (the review user and the owner; L1002).
 */
export function readRulesSnapshot(file, { uid, now = Date.now(), graceMs = FETCH_GRACE_MS, readers = [], lstat = lstatSync, acl = (p) => rulesAclProblem(p, readers) } = {}) {
  const no = (reason) => ({ ok: false, reason: `the Dispatcher's rules snapshot ${file} ${reason}` });
  if (typeof file !== 'string' || !isAbsolute(file)) return { ok: false, reason: 'no rules snapshot is named (dispatcherRules)' };
  const folder = rulesSnapshotFolderProblem(dirname(file), uid, { lstat });
  if (folder) return { ok: false, reason: folder };
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) {
    return no(e?.code === 'ENOENT' ? 'is missing: the Dispatcher has not written it yet' : e?.code === 'ELOOP' ? 'is a link' : `can't be opened (${e?.code ?? e})`);
  }
  let text;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return no('is not a plain file');
    if (st.nlink !== 1) return no(`has ${st.nlink} names`);
    if (st.uid !== uid) return no(`is not the Dispatcher's user's (uid ${st.uid})`);
    if (st.mode & 0o077) return no(`can be read or written by group or others (mode ${(st.mode & 0o777).toString(8)})`);
    if (st.size > MAX_SNAPSHOT_BYTES) return no(`is over ${MAX_SNAPSHOT_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    if (off !== st.size) return no('was cut short while it was read');
    text = buf.toString('utf8');
  } catch (e) { return no(`can't be read (${e?.code ?? e})`); } finally { closeSync(fd); }
  // The access lists, after the file was opened as a plain file: the folder's (its entries are what the file inherits)
  // and the file's own (L1001 review m1).
  for (const p of [dirname(file), file]) { const bad = acl(p); if (bad) return { ok: false, reason: `the Dispatcher's rules snapshot is refused: ${bad}` }; }
  let d;
  try { d = JSON.parse(text); } catch { return no('is not JSON'); }
  if (!d || typeof d !== 'object' || d.format !== SNAPSHOT_FORMAT) return no(`is not format ${SNAPSHOT_FORMAT}`);
  if (typeof d.product !== 'string' || !d.product) return no('names no product');
  const at = Date.parse(d.written_at ?? '');
  if (!Number.isFinite(at) || iso(at) !== d.written_at) return no('has no written_at time');
  const list = d.products;
  if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && NAME.test(p)) || new Set(list).size !== list.length) return no('holds no product list');
  if (!list.includes(d.product)) return no(`does not list its own product ${d.product}`);
  if (!d.rules || typeof d.rules !== 'object' || Array.isArray(d.rules)) return no('holds no rules');
  for (const [p, r] of Object.entries(d.rules)) {
    if (!list.includes(p)) return no(`holds rules for ${p}, which it does not list`);
    const f = Date.parse(r?.fetched_at ?? '');
    if (!r || !USABLE.includes(r.status) || typeof r.text !== 'string' || !HEX40.test(r.commit ?? '') || !HEX40.test(r.blob ?? '') || !Number.isFinite(f) || iso(f) !== r.fetched_at) return no(`holds rules for ${p} that are not a usable text, commit, blob and fetch time`);
  }
  if (!Object.hasOwn(d.rules, d.product)) return no(`holds no rules for its own product ${d.product}`);
  const s = { ok: true, file, product: d.product, products: list, writtenAt: d.written_at, writtenAtMs: at, rules: d.rules };
  const old = snapshotAgeProblem(s, now, graceMs);
  return old ? { ok: false, reason: old } : s;
}

/**
 * Check 12's inputs for a runner (L995). `config`: { recordRoot, recordUid, dispatcherRules (the snapshot's full path),
 * workerStatusFile, workerUid, outboxRoot, reviewStatusFile, reviewUid } (sessionsNow's keys; workerUid is the owner's,
 * reviewUid the review user's, the two the access lists may let read). Nothing is read here: the snapshot is read when
 * the rules are used (at most once a second, its age checked on every use), and the engine is built again when it
 * changes, so a long-running runner never decides on a snapshot gone stale. A refused snapshot is a throw, which check
 * 12's port turns into a refused start with its reason (launcher: "the check failed: ..."). `io`: readSnapshot,
 * userName, and sessionsNow's ports, for a test.
 */
export function budget(config, { now = Date.now, io = {} } = {}) {
  const c = config ?? {};
  // What the running count reads (wiring/worker-ports.mjs sessionsNow): checked here, so a config without it loads no budget.
  for (const k of ['recordRoot', 'dispatcherRules', 'workerStatusFile', 'reviewStatusFile', 'outboxRoot']) if (typeof c[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`budget: ${k} must be a full path`);
  for (const k of ['recordUid', 'workerUid', 'reviewUid']) if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`budget: ${k} must be a uid`);
  const rec = recordView({ recordRoot: c.recordRoot, recordUid: c.recordUid });
  // The two users the access lists may let read; a name that can't be told leaves only the other (and then any entry for
  // it is refused, so check 12 refuses, never passes).
  const nameOf = io.userName ?? userName;
  const readers = [...new Set([c.reviewUid, c.workerUid].map((u) => nameOf(u)).filter(Boolean))];
  let seen = null;    // { at, s }: the last snapshot read, and when
  let built = null;   // { key, rules }
  const current = () => {
    const t = now();
    if (!seen || t - seen.at >= SNAPSHOT_REUSE_MS || t < seen.at) {
      const s = (io.readSnapshot ?? readRulesSnapshot)(c.dispatcherRules, { uid: c.recordUid, now: t, readers });
      if (!s.ok) { seen = null; throw new Error(s.reason); }
      seen = { at: t, s };
    }
    const s = seen.s;
    const old = snapshotAgeProblem(s, t);
    if (old) throw new Error(old);
    const key = JSON.stringify([s.products, Object.entries(s.rules).map(([p, r]) => [p, r.commit, r.blob, r.status])]);
    if (built?.key !== key) {
      const states = {};
      for (const [p, r] of Object.entries(s.rules)) {
        const parsed = parsePolicy(r.text);
        if (!parsed.ok) throw new Error(`the Dispatcher's rules snapshot holds rules for ${p} the checker refuses: ${parsed.reason}`);
        states[p] = Object.freeze({ status: r.status, policy: parsed.policy, commit: r.commit, blob: r.blob });
      }
      const deny = Object.freeze({ status: 'deny_all', policy: null });
      // As the Dispatcher's engine (dispatcher-wiring.mjs recordAndRules): every product listed, one with no usable rules
      // deny_all; the product's state from the Record's product document (none is paused); the running count refused
      // ("count unknown") until that engine's is wired.
      const engine = makeEngine({
        products: [...s.products],
        rulesState: (p) => states[p] ?? deny,
        productState: (p) => rec.read('product', p)?.doc ?? null,
        running: () => { throw new Error('the running count is not wired for the rules engine (as the Dispatcher\'s)'); },
        rolesDir: ROLES_DIR,
        clock: now,
      });
      built = { key, rules: makeRules(engine) };
    }
    return built.rules;
  };
  const rules = Object.freeze({
    // A snapshot refused is a throw from the key reads (check 12 refuses on it with the reason). may and classify answer
    // as shared/rules.mjs makeRules promises instead, never throwing: a deny, and Tier 1 "unclassifiable" (review r2 m2).
    ...Object.fromEntries(RULE_CALLS.map((k) => [k, (...a) => {
      let r;
      try { r = current(); } catch (e) {
        if (k !== 'may' && k !== 'classify') throw e;
        const refused = () => { throw e; };
        return makeRules({ may: refused, get: refused, classify: refused, rev: null })[k](...a);
      }
      return r[k](...a);
    }])),
    // As makeRules's: null when there is no rules version to name, never a throw (PR-2 r2 m2).
    get rev() { try { return current().rev; } catch { return null; } },
  });
  return Object.freeze({
    rules,
    rec,
    bandsNow: () => {
      const t = now();
      const acct = signedInAccount({ rec, rules, now: t });
      return currentBands({ rec, rules, account: acct.account, now: t });
    },
    runningNow: () => sessionsNow(c, rec, { now, io }),
  });
}
