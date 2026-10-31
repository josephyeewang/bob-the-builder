// The review runner (lead call L65). Reviewers and auditors run as a separate plain Mac user, `review`, so a worker
// can't hand in a reviewer's verdict. No other user can start them: there is no sudo rule. A LaunchDaemon owned by
// root runs this program as `review` once a minute and whenever a request arrives (review-runner.plist). It is the only
// thing that starts a review session.
//
// The Dispatcher only asks. It writes a request { card, head, role, request_id } into requests/, a folder anyone may
// add to (sticky, so no one but review removes another's file). The runner trusts nothing in a request:
//   - the card must be in the Record (read only) and in a state that needs this role (an auditor only on a Tier-1 card);
//   - `head` must be the card's head in the Record and its current head in git (read only);
//   - the role must be reviewer or auditor;
//   - nothing may already be running for that card, head and role;
//   - per card, head and role there is one start; a start that failed (or a session that ended with no verdict) may be
//     tried again after 15 minutes, 3 tries in all, and then Joe is told.
// The runner makes the session id itself, and writes the launch record into launches/, which only review can write.
// A verdict counts only when it matches one of those records (M9 outbox.mjs `runnerLaunchFor`); the Dispatcher's copy
// in the Record never counts. status.json (anyone may read it) lists what is running and the alerts for Joe, with
// `written_at`; the Dispatcher's `hasReviewer` reads it, and a status that is missing or older than 3 minutes is an
// error, never "no reviewer" (L63).
//
// The runner refuses to start anything when `review` is an admin (m-3), and stops any review session it did not start,
// telling Joe (m-7). Every outside effect is a port, so the tests run on fakes: starting claude, git, the Record read,
// the admin check, the session list and the stop. review-runner-main.mjs joins the real ones.
//
// The review folder (`root`), owned by review:
//   requests/    1733   anyone adds a request; only review reads and removes them
//   launches/    0755   the launch records (M9 reads them)
//   status.json  0644   { written_at, ok, error, running, refused, alerts }
//   state.json   0600   the runner's own memory: running sessions, tries per card, head and role, request ids seen

import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { SESSION_ID } from '../../../shared/record.mjs';
import { launchesFolderProblem, reviewUid } from '../../M9-record/outbox.mjs';
import { checkReviewOutbox, reviewOutbox, uidsProblem } from './review-user.mjs';
import { ACCOUNT_NAMES, accountDir, accountEnv } from './accounts.mjs';

export const RETRY_MS = 15 * 60_000;
export const MAX_FAILED_STARTS = 3;
export const STATUS_STALE_MS = 3 * 60_000;
export const MAX_REQUEST_BYTES = 4096;
export const MAX_REQUESTS_PER_PASS = 50;
const KEEP_SEEN = 500;
const KEEP_LIST = 50;
export const REQUEST_NAME = /^[A-Za-z0-9-]{1,64}\.json$/;
export const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
export const CARD_ID = /^[A-Za-z0-9._-]{1,200}$/;
const HEX40 = /^[0-9a-f]{40}$/;
export const FOLDERS = Object.freeze({ requests: 'requests', launches: 'launches', status: 'status.json', state: 'state.json' });
const REQUEST_KEYS = ['card', 'head', 'request_id', 'role'];

const iso = (t) => new Date(t).toISOString();
const keyOf = (card, head, role) => `${card}:${head}:${role}`;

/** Does a card in this state need a session of this role? A reviewer for every card in review; an auditor too on Tier 1 (m-6). */
export function needsRole(doc, role) {
  if (!doc || doc.state !== 'in_review') return false;
  if (role === 'reviewer') return true;
  return role === 'auditor' && doc.tier === 1;
}

/** The roles a card in review needs (the Dispatcher asks for each, the runner checks each). */
export const rolesFor = (doc) => REVIEW_ROLES.filter((r) => needsRole(doc, r));

function folderProblem(path, uid, mode) {
  let st; try { st = lstatSync(path); } catch { return `${path} is missing`; }
  if (st.isSymbolicLink()) return `${path} is a link`;
  if (!st.isDirectory()) return `${path} is not a folder`;
  if (st.uid !== uid) return `${path} is not owned by the review user`;
  if (mode === undefined ? st.mode & 0o022 : (st.mode & 0o7777) !== mode) return mode === undefined ? `${path} can be written by others` : `${path} has mode ${(st.mode & 0o7777).toString(8)}, not ${mode.toString(8)}`;
  return null;
}
function ensureFolder(path, mode) {
  try { lstatSync(path); return; } catch { /* make it */ }
  mkdirSync(path, { mode });
  chmodSync(path, mode);
}

/** One request file, read without following a link or waiting on a pipe; it is always removed after. → { ok, req } | { ok: false, reason } */
export function readRequest(dir, name) {
  const p = join(dir, name);
  const out = (() => {
    if (!REQUEST_NAME.test(name)) return { ok: false, reason: 'the file name is not letters, digits and dashes with .json' };
    let fd;
    try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, reason: e?.code === 'ELOOP' ? 'it is a link' : `it can't be read (${e?.code ?? e})` }; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: 'it is not a plain file' };
      if (st.nlink !== 1) return { ok: false, reason: 'it has more than one name' };
      if (st.size > MAX_REQUEST_BYTES) return { ok: false, reason: 'it is too big' };
      let req; try { req = JSON.parse(readFileSync(fd, 'utf8')); } catch { return { ok: false, reason: 'it is not JSON' }; }
      if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, reason: 'it is not an object' };
      const keys = Object.keys(req).sort();
      if (keys.join() !== REQUEST_KEYS.join()) return { ok: false, reason: `it must hold exactly ${REQUEST_KEYS.join(', ')}` };
      if (typeof req.card !== 'string' || !CARD_ID.test(req.card)) return { ok: false, reason: 'the card id is not a plain id' };
      if (typeof req.head !== 'string' || !HEX40.test(req.head)) return { ok: false, reason: 'the head is not 40 hex' };
      if (typeof req.role !== 'string' || req.role.length > 40) return { ok: false, reason: 'the role is not a short word' };
      if (typeof req.request_id !== 'string' || !REQUEST_ID.test(req.request_id)) return { ok: false, reason: 'the request id is not letters, digits and dashes' };
      return { ok: true, req };
    } finally { closeSync(fd); }
  })();
  try { unlinkSync(p); } catch { /* gone already */ }
  return out;
}

function readState(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return { ok: true, state: { running: [], attempts: {}, seen: [], alerts: [], told: [] } }; return { ok: false, reason: `the runner's state can't be read (${e?.code ?? e})` }; }
  try {
    const s = JSON.parse(text);
    if (!Array.isArray(s.running) || !s.attempts || typeof s.attempts !== 'object' || !Array.isArray(s.seen)) throw new Error('shape');
    return { ok: true, state: { alerts: [], told: [], ...s } };
  } catch { return { ok: false, reason: 'the runner\'s state is not what the runner writes' }; }
}
// A new file put in place in one step, so a reader never sees half of it.
function writeWhole(path, value, mode) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
/** The launch record: written under a temp name, then given its real name only if that name is free (never written over). */
function writeLaunch(dir, sid, doc) {
  const tmp = join(dir, `.${sid}.json.tmp`);
  const final = join(dir, `${sid}.json`);
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644, flag: 'wx' });
  try { chmodSync(tmp, 0o644); linkSync(tmp, final); } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  return final;
}

/**
 * One pass. `ctx`:
 *   root, outboxRoot, uids (the M9 map; both review roles name the review user), reviewHome (review's home folder)
 *   now(), ownUid(), newId() (default randomUUID)
 *   isAdmin() → true | false; a throw counts as an admin (m-3)
 *   readCard(card) → { ok, doc } (the Record, read only)      currentHead(card, doc) → 40 hex (git, read only)
 *   sessions() → [{ pid, sessionId? }] the review sessions alive now     stop({ pid, sessionId })
 *   start({ role, card, head, sessionId, outbox, configDir, env, signin }) → { ok, pid } | { ok: false, reason }
 *   accountInUse() → 'a' | 'b' (which sign-in folder of review's to start on)
 *   handedIn({ role, sessionId, outbox }) → true when the ended session left a verdict
 * Returns { ok, error?, started: [...], refused: [...], stopped: [...], alerts: [...] } (also what status.json shows).
 */
export async function runnerPass(ctx) {
  const now = ctx.now();
  const newId = ctx.newId ?? randomUUID;
  const result = { ok: true, error: null, started: [], refused: [], stopped: [], alerts: [] };
  // Who we are and where we write come first: a runner that is not review, or a folder that is not review's, writes nothing.
  const mapBad = uidsProblem(ctx.uids);
  const who = mapBad ? { ok: false, reason: mapBad } : reviewUid(ctx.uids);
  if (!who.ok) return { ...result, ok: false, error: `the review user is not set up: ${who.reason}`, wrote: false };
  const uid = who.uid;
  let own; try { own = ctx.ownUid(); } catch { own = null; }
  if (own !== uid) return { ...result, ok: false, error: `the review runner runs only as the review user (uid ${uid}), not uid ${own}`, wrote: false };
  const rootBad = folderProblem(ctx.root, uid);
  if (rootBad) return { ...result, ok: false, error: `the review folder: ${rootBad}`, wrote: false };

  const P = { requests: join(ctx.root, FOLDERS.requests), launches: join(ctx.root, FOLDERS.launches), status: join(ctx.root, FOLDERS.status), state: join(ctx.root, FOLDERS.state) };
  const st = readState(P.state);
  const state = st.ok ? st.state : { running: [], attempts: {}, seen: [], alerts: [], told: [] };
  // `at` is the alert's time; the Dispatcher tells each id and time once, so a trouble that keeps the state from being
  // saved passes the time it began (the file's), not this pass's.
  const alert = (id, text, at = iso(now)) => {
    if (state.told.includes(id)) return;
    state.told = [...state.told, id].slice(-KEEP_SEEN);
    const a = { id, at, text };
    state.alerts = [...state.alerts, a].slice(-KEEP_LIST);
    result.alerts.push(a);
  };
  const fail = (error) => { result.ok = false; result.error = result.error ? `${result.error}; ${error}` : error; };
  const finish = () => {
    const status = { written_at: iso(now), ok: result.ok, error: result.error,
      running: state.running.map(({ card, head, role, session_id, started_at }) => ({ card, head, role, session_id, started_at })),
      refused: [...(state.refused ?? []), ...result.refused].slice(-KEEP_LIST), alerts: state.alerts };
    state.refused = status.refused;
    // A corrupt state is never written over: Joe looks at it first (the status says why).
    if (st.ok) writeWhole(P.state, state, 0o600);
    writeWhole(P.status, status, 0o644);
    return { ...result, wrote: true, status };
  };
  if (!st.ok) {
    let since = iso(now);
    try { since = lstatSync(P.state).mtime.toISOString(); } catch { /* keep now */ }
    fail(st.reason);
    alert('state-corrupt', `The review runner's memory file can't be read, so it starts nothing: ${st.reason}.`, since);
    return finish();
  }

  // m-3: an admin can become anyone, so a review user that is an admin keeps nothing apart.
  let admin; try { admin = await ctx.isAdmin(); } catch { admin = true; }
  if (admin !== false) { fail('the review user is an admin (or that could not be checked), so no review starts'); alert('review-admin', 'The review user is an admin Mac user (or the check failed). No reviewer or auditor starts until it is a standard user.'); return finish(); }
  // A trouble that has cleared may be told again if it comes back.
  state.told = state.told.filter((t) => t !== 'review-admin' && t !== 'state-corrupt');

  try {
    ensureFolder(P.requests, 0o1733);
    ensureFolder(P.launches, 0o755);
  } catch (e) { fail(`the review folders could not be made (${e?.code ?? e?.message})`); return finish(); }
  const reqBad = folderProblem(P.requests, uid, 0o1733) ?? launchesFolderProblem(P.launches, uid);
  if (reqBad) { fail(`the review folders: ${reqBad}`); return finish(); }

  // The sessions alive now. One the runner did not start is stopped, and Joe is told (m-7); one that ended leaves `running`.
  let live;
  try { live = await ctx.sessions(); } catch (e) { fail(`the review sessions could not be listed (${e?.message ?? e}), so none starts`); return finish(); }
  const mine = new Set(state.running.map((r) => r.pid));
  for (const s of live) {
    if (mine.has(s.pid)) continue;
    let stopped = true;
    try { await ctx.stop(s); } catch { stopped = false; }
    result.stopped.push({ pid: s.pid, sessionId: s.sessionId ?? null, stopped });
    alert(`stray-${s.pid}-${s.sessionId ?? ''}`, `A review session the review runner did not start was found (process ${s.pid}${s.sessionId ? `, session ${s.sessionId}` : ''}) and ${stopped ? 'stopped' : 'could not be stopped'}.`);
  }
  const alive = new Set(live.map((s) => s.pid));
  for (const r of state.running.filter((x) => !alive.has(x.pid))) {
    const k = keyOf(r.card, r.head, r.role);
    const a = state.attempts[k] ?? { failures: 0 };
    let verdict = false;
    try { verdict = await ctx.handedIn({ role: r.role, sessionId: r.session_id, outbox: reviewOutbox({ outboxRoot: ctx.outboxRoot, role: r.role, sessionId: r.session_id }) }); } catch { verdict = false; }
    if (verdict) state.attempts[k] = { ...a, started: true, ended_at: iso(now) };
    else {
      // A session that ended with nothing handed in counts as a failed start: one more try after the wait, 3 in all.
      state.attempts[k] = { ...a, started: false, failures: (a.failures ?? 0) + 1, last_failed_at: iso(now) };
      alert(`ended-${r.session_id}`, `The ${r.role} for card ${r.card} at ${r.head.slice(0, 7)} ended without handing in a verdict.`);
    }
  }
  state.running = state.running.filter((x) => alive.has(x.pid));

  // The requests, oldest name first, at most 50 a pass; each is removed once read.
  let names = [];
  try { names = readdirSync(P.requests).filter((n) => !n.startsWith('.')).sort().slice(0, MAX_REQUESTS_PER_PASS); } catch (e) { fail(`the requests could not be listed (${e?.code ?? e})`); }
  for (const name of names) {
    const got = readRequest(P.requests, name);
    const refuse = (reason, req = got.req) => result.refused.push({ at: iso(now), request: name, card: req?.card ?? null, role: req?.role ?? null, request_id: req?.request_id ?? null, reason });
    if (!got.ok) { refuse(`the request ${got.reason}`); continue; }
    const { card, head, role, request_id: rid } = got.req;
    if (state.seen.includes(rid)) { refuse(`request id ${rid} was seen before`); continue; }
    state.seen = [...state.seen, rid].slice(-KEEP_SEEN);
    if (!REVIEW_ROLES.includes(role)) { refuse(`"${role}" is not a review role`); continue; }
    let c; try { c = await ctx.readCard(card); } catch (e) { c = { ok: false, reason: e?.message ?? String(e) }; }
    if (!c?.ok) { refuse(`card ${card} is not in the Record${c?.reason ? ` (${c.reason})` : ''}`); continue; }
    if (!needsRole(c.doc, role)) { refuse(`card ${card} does not need a ${role} (it is ${c.doc?.state ?? 'in no state'}${role === 'auditor' ? `, tier ${c.doc?.tier ?? 'none'}` : ''})`); continue; }
    if (c.doc.head !== head) { refuse(`the request names head ${head.slice(0, 7)}, but the card's head is ${String(c.doc.head ?? 'none').slice(0, 7)}`); continue; }
    let gitHead; try { gitHead = await ctx.currentHead(card, c.doc); } catch (e) { gitHead = null; refuse(`the card's head in git could not be read (${e?.message ?? e})`); continue; }
    if (gitHead !== head) { refuse(`the request names head ${head.slice(0, 7)}, but the card's branch is at ${String(gitHead ?? 'nothing').slice(0, 7)}`); continue; }
    const k = keyOf(card, head, role);
    if (state.running.some((r) => keyOf(r.card, r.head, r.role) === k)) { refuse(`a ${role} is already running for card ${card} at ${head.slice(0, 7)}`); continue; }
    const a = state.attempts[k] ?? { failures: 0 };
    if (a.started) { refuse(`a ${role} was already started for card ${card} at ${head.slice(0, 7)}; one start per head`); continue; }
    if ((a.failures ?? 0) >= MAX_FAILED_STARTS) {
      refuse(`${MAX_FAILED_STARTS} starts of a ${role} for card ${card} at ${head.slice(0, 7)} failed; Joe is told`);
      alert(`gave-up-${k}`, `No ${role} could be started for card ${card} at ${head.slice(0, 7)} after ${MAX_FAILED_STARTS} tries (last: ${a.last_reason ?? 'ended with no verdict'}).`);
      continue;
    }
    if (a.last_failed_at && now - Date.parse(a.last_failed_at) < RETRY_MS) { refuse(`the last start of a ${role} for card ${card} failed less than 15 minutes ago`); continue; }

    // Start it: the session id is the runner's own, the outbox is made fresh, the launch record is written before the start.
    const sid = newId();
    const failStart = (reason) => {
      state.attempts[k] = { ...a, started: false, failures: (a.failures ?? 0) + 1, last_failed_at: iso(now), last_reason: reason };
      refuse(`the ${role} could not be started: ${reason}`);
      if (state.attempts[k].failures >= MAX_FAILED_STARTS) alert(`gave-up-${k}`, `No ${role} could be started for card ${card} at ${head.slice(0, 7)} after ${MAX_FAILED_STARTS} tries (last: ${reason}).`);
    };
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) { failStart('the new session id is not letters, digits and dashes'); continue; }
    let acct; try { acct = await ctx.accountInUse(); } catch (e) { acct = null; }
    if (!ACCOUNT_NAMES.includes(acct)) { failStart('the account in use could not be read'); continue; }
    let outbox;
    try {
      ensureFolder(join(ctx.outboxRoot, role), 0o755);
      outbox = reviewOutbox({ outboxRoot: ctx.outboxRoot, role, sessionId: sid });
      mkdirSync(outbox, { mode: 0o755 });   // never there before: a session id is never reused
      chmodSync(outbox, 0o755);
    } catch (e) { failStart(`its outbox could not be made (${e?.code ?? e?.message})`); continue; }
    const ob = checkReviewOutbox({ outboxRoot: ctx.outboxRoot, role, sessionId: sid, uid });
    if (!ob.ok) { failStart(ob.reason); continue; }
    const configDir = accountDir(ctx.reviewHome, acct);
    let recPath;
    try {
      recPath = writeLaunch(P.launches, sid, { session_id: sid, role, card, head, request_id: rid, launched_at: iso(now), signin: acct, config_dir: configDir });
    } catch (e) { failStart(`its launch record could not be written (${e?.code ?? e?.message})`); continue; }
    let r;
    try { r = await ctx.start({ role, card, head, sessionId: sid, outbox, configDir, env: accountEnv(ctx.reviewHome, acct), signin: acct }); } catch (e) { r = { ok: false, reason: e?.message ?? String(e) }; }
    if (!r?.ok || !Number.isInteger(r.pid)) {
      try { unlinkSync(recPath); } catch { /* gone */ }
      failStart(r?.reason ?? 'the start gave no process id');
      continue;
    }
    state.attempts[k] = { ...a, started: true, started_at: iso(now), session_id: sid };
    state.running.push({ card, head, role, session_id: sid, pid: r.pid, started_at: iso(now) });
    result.started.push({ card, head, role, session_id: sid, signin: acct });
  }
  return finish();
}

/**
 * The Dispatcher's read of status.json (for `hasReviewer`): the list of review sessions running, or a throw when the
 * status is missing, unreadable, not the runner's shape or older than 3 minutes (L63: never read as "none").
 * `stat` lets a test stand in for the file's owner. → { running, alerts, ok, error }
 */
export function readReviewStatus({ file, now, uid, stat = lstatSync }) {
  // The owner check is never skipped: a status anyone could write would say what runs.
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the review user\'s uid is not known, so its status can\'t be checked');
  let st;
  try { st = stat(file); } catch { throw new Error('the review runner\'s status is missing'); }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('the review runner\'s status is not a plain file');
  if (st.uid !== uid) throw new Error('the review runner\'s status is not owned by the review user');
  if (st.mode & 0o022) throw new Error('the review runner\'s status can be written by others');
  let s;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('the review runner\'s status can\'t be read'); }
  const at = Date.parse(s?.written_at ?? '');
  if (!Number.isFinite(at) || !Array.isArray(s.running)) throw new Error('the review runner\'s status is not what the runner writes');
  if (now - at > STATUS_STALE_MS) throw new Error(`the review runner's status is ${Math.round((now - at) / 60_000)} minutes old; the runner may be stopped`);
  if (at - now > STATUS_STALE_MS) throw new Error('the review runner\'s status is dated in the future; a clock is wrong');
  return { running: s.running, alerts: Array.isArray(s.alerts) ? s.alerts : [], ok: s.ok === true, error: s.error ?? null };
}
