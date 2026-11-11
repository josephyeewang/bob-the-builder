// Part C, runner step 3: one pass of the owner-side worker runner (owner-ports.mjs, owner-status.mjs's contract). The
// runner is a LaunchAgent of the owner's user. Each pass it reads the requests the Dispatcher wrote, acts on them, checks
// its sessions, and writes its one status file. Every outside effect is a port, so the tests run on fakes; the real
// ports are runner-loop.mjs's (process groups) and runner-ports.mjs's (the start through walledLaunchSettings, M4
// save-work, the Lead's wrap-up, the drain and the size), joined in runner-main.mjs (step 5).
//
// The runner's memory (`state`) is the one source for the status. `keep(state)` keeps it (in a file only the runner reads)
// and is called before every status write, so a runner that dies mid-pass never comes back with a status ahead of its
// memory (self-review M3: a 'waiting' entry written but not kept would let a stop cancel a launch whose start was on).
//   { sessions: [SESSION + { pid, pid_start, head, copy, started_at, ended_at? }], requests: { <sessionId>: { state, at } },
//     answers: { <key>: { ...answer, at } }, seen: { <key>: at } }
// A pass, in order:
//   0. Starts that were still on when an earlier pass ended (`pending`, kept by the caller in memory) are settled.
//   1. Each session is checked: a process group that is gone (groupGone true) is alive false and ended, and its launch
//      request 'stopped'; one the port can't tell about keeps no alive field (so it still counts as live). Ended is
//      final: an ended session is never checked again (a reused process group must not bring it back, self-review M1).
//      A session not live closes its outbox once outboxDrained says intake has taken or told every file, and leaves the
//      listing once its outbox is closed, it ended more than RUNNER_KEEP_USED_UP_MS ago, and no kept answer names it.
//      An outbox not drained for RUNNER_DRAIN_HELD_MS is listed with `drain_held: { cause, since }` (L896): the cause is
//      outboxDrained's (a DRAIN_CAUSES name; a late or failed check is its own), since the first pass it was seen, a new
//      since when the cause changes. The Dispatcher tells each one (M11 drain-alerts.mjs). Drained, it goes.
//   2. Requests, oldest first. Each is read once and removed (a request is never acted on twice):
//      - refused unread (only noted) when its body's verb or id does not match its file name, its key was answered or
//        seen before, or its asked_at is older than RUNNER_KEEP_USED_UP_MS or later than now by more than CLOCK_SKEW_MS
//        (#328 r1 m2: a replay, never a new ask); a
//        stop is exempt, since stopSession asks again each pass and a second stop only stops again;
//      - stop-<id>: a launch request not yet seen is 'cancelled' (it never starts); a live session is stopped with
//        stop_requested set first;
//      - launch-<id>: refused when it is older than claimMs (a claim that may have lapsed), when its kind, card or product
//        is not one the runner takes, or when start refuses; otherwise the session is listed 'started' with its answer.
//        The start's answer is checked as the reader checks a listed session (checkSession) before it is listed: one the
//        reader would refuse is stopped, and refused once its group is gone (self-review M2). A start still on after
//        startWaitMs stays 'waiting' and unanswered, and is settled by a later pass when it answers (step 0);
//      - stopGroup-<id>-<nonce>: stop_requested is set and the status written before the stop (L762), and the answer is
//        ok only once the group is gone; a stop that fails or times out answers ok: false with the flag still set; one
//        that names another process group than the listed one is refused;
//      - saveWork-<id>-<nonce>, pauseLead-<product>-<nonce>: the port's answer, or ok: false at portMs.
//   3. Used-up request entries, answers and seen keys older than RUNNER_KEEP_USED_UP_MS are dropped.
//   4. The status is written. In every status that carries a launch ok or a stopGroup ok, the session stays listed.
// A 'waiting' entry left by a runner that stopped mid-start (so no pending start is held for it) is left as it is: its
// session may have started, so the request is never used up, stopSession never answers true for it, and the claim stays
// until Joe is told (M9 lapseClaims). It, and a start still on, is noted at most every RUNNER_NOTE_EVERY_MS (#358 r1 m6).
// A start leaves `pending` only once a memory holding its result has been kept (#358 r1 m3, #362 r1 M1): a keep that
// fails leaves it there, so the next pass settles it again from the memory last kept.
// A launch for a card that already has a live session, or a start still waiting, is refused (#358 r1 m4).
// The ports' contract (#358 r1 m5), which the real ports (runner-loop.mjs processGroupPorts) keep: a port is waited on
// for at most RUNNER_PORT_MS only if it is async; a synchronous one blocks the pass for as long as it runs, so a
// synchronous real port must bound itself well inside that wait (#362 r2 c-a: groupGone's ps, at most RUNNER_PS_MS); groupGone answers true only when the leader (pid and pid_start)
// is certainly gone, false when it is there, and throws when it can't tell; EPERM (another user's process) is never gone;
// stopGroup signals only a group whose leader's pid_start is the session's.
// Time (self-review M4, step-4 review M4, #358 r1 M1): the status is written after every port wait (a start's: by the request's own write),
// each step-0 settle, each session's check and each request, and no port is waited on longer than RUNNER_PORT_MS, so no
// two writes in a pass are further apart than one port's wait (a port that blocks the process itself, a synchronous one,
// is bounded only by its own limit). Each write is stamped written_at from the clock at that write, not the pass's start;
// `now` stays the pass's one time for the age rules. The caller runs a pass at least every RUNNER_STATUS_EVERY_MS (L769).

import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { PRODUCT } from '../shared/product-paths.mjs';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { CLOCK_SKEW_MS, RUNNER_KEEP_USED_UP_MS, RUNNER_KINDS, RUNNER_ROLE_OF, RUNNER_STATUS_EVERY_MS, UNDO_COMMIT, USED_UP, checkSession } from './owner-status.mjs';
import { launchAnswerWrong } from './owner-asks.mjs';
import { DRAIN_CAUSES, drainHeldOk } from '../modules/M11-dispatcher/drain-alerts.mjs';
import { FUTURE_SKEW_MS } from '../shared/still-waiting.mjs';

/** How long the runner waits on one port before it answers for it, or (a start) leaves it to a later pass. Under the
 * status rewrite cadence, so a hung port never leaves the status unwritten for longer (L769). */
export const RUNNER_PORT_MS = 10_000;
if (RUNNER_PORT_MS >= RUNNER_STATUS_EVERY_MS) throw new Error('RUNNER_PORT_MS must be under RUNNER_STATUS_EVERY_MS');
/** How often a start still on, or a 'waiting' entry with none held, is noted again (#358 r1 m6). */
export const RUNNER_NOTE_EVERY_MS = 10 * 60_000;
/** How long an ended session's outbox may stay undrained before its cause is listed for the owner (L896): intake takes a
 * hand-in within a few Dispatcher passes, so half an hour is a stuck file, not a slow one. */
export const RUNNER_DRAIN_HELD_MS = 30 * 60_000;
/** The status's session fields (owner-status.mjs SESSION), in its order: nothing of the runner's own memory. */
export const STATUS_SESSION_FIELDS = Object.freeze(['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files',
  'outbox', 'uid', 'outbox_open', 'stop_requested', 'alive', 'ended', 'last_write_at', 'size', 'activity', 'drain_held']);
const VERBS = Object.freeze(['stop', 'launch', 'stopGroup', 'saveWork', 'pauseLead']);
const NAME = /^(stop|launch|stopGroup|saveWork|pauseLead)-([A-Za-z0-9._-]{1,140})\.json$/;
const NONCE = /^[a-f0-9]{16}$/;
// The product rule is setup's (shared/product-paths.mjs PRODUCT, #378 r1 m3), as owner-asks.mjs checks it before asking.
const productName = (p) => typeof p === 'string' && PRODUCT.test(p);

const late = (ms) => new Promise((resolve) => { const t = setTimeout(() => resolve({ late: true }), ms); t.unref?.(); });
/** A port's answer within ms, or { late: true }; a throw is { threw: message }. */
async function within(ms, fn) {
  try { return await Promise.race([Promise.resolve().then(fn), late(ms)]); } catch (e) { return { threw: e?.message ?? String(e) }; }
}
const failed = (r, what) => (r?.late ? `${what} did not answer within the runner's limit` : r?.threw ? `${what} failed (${r.threw})` : r?.reason ? String(r.reason) : `${what} gave no answer`);

/** The key a request file names, and what its body must say: → { verb, key, id, product?, nonce? } or null. */
export function requestKey(name) {
  const m = NAME.exec(name ?? '');
  if (!m) return null;
  const [, verb, rest] = m;
  if (verb === 'stop' || verb === 'launch') return REQUEST_ID.test(rest) ? { verb, key: `${verb}-${rest}`, id: rest } : null;
  const at = rest.lastIndexOf('-');
  if (at < 1) return null;
  const head = rest.slice(0, at); const nonce = rest.slice(at + 1);
  if (!NONCE.test(nonce)) return null;
  if (verb === 'pauseLead') return productName(head) ? { verb, key: `${verb}-${rest}`, product: head, nonce } : null;
  return REQUEST_ID.test(head) ? { verb, key: `${verb}-${rest}`, id: head, nonce } : null;
}

/** Does the body say what its name says? (#328 r1 m2: a body linked in under another name is not that ask.) */
function bodyMatches(k, body) {
  if (!body || typeof body !== 'object') return false;
  const b = body[k.verb];
  if (k.verb === 'stop') return body.stop === k.id;
  if (!b || typeof b !== 'object') return false;
  if (k.verb === 'launch') return b.sessionId === k.id;
  if (k.verb === 'pauseLead') return b.product === k.product;
  return b.id === k.id;
}

const project = (s) => Object.fromEntries(STATUS_SESSION_FIELDS.filter((f) => s[f] !== undefined).map((f) => [f, s[f]]));
const isLive = (s) => s.alive === true || (s.alive !== false && s.ended !== true);

/**
 * One pass. ctx: { state, requests: [{ name, body }] (read by readRequest, oldest first), now, uid, outboxRoot, copiesRoot,
 * claimMs, portMs?, clock? (the time of each write; default the pass's now), ports: { start, groupGone, stopGroup, saveWork, pauseLead, outboxDrained, size? }, write(statusDoc),
 * keep(state) (called before every write), pending (a Map the caller holds across passes: starts still on), realpath?,
 * remove(name), note(text) }. → { state, status } (the state to keep, the status last written).
 */
export async function workerRunnerPass(ctx) {
  const { requests = [], now, uid, outboxRoot, copiesRoot, claimMs, portMs = RUNNER_PORT_MS, ports, write, keep, pending, realpath, remove = () => {}, note = () => {} } = ctx;
  const clock = typeof ctx.clock === 'function' ? ctx.clock : () => now;
  if (typeof keep !== 'function') throw new Error('the worker runner has nowhere to keep its memory');
  if (!(pending instanceof Map)) throw new Error('the worker runner holds no list of starts still on');
  if (!Number.isFinite(now)) throw new Error('the worker runner has no clock');
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the worker runner does not know the owner\'s uid');
  if (typeof outboxRoot !== 'string' || !outboxRoot.startsWith('/')) throw new Error('the worker runner has no outbox root');
  if (!Number.isFinite(claimMs) || claimMs <= 0) throw new Error('the worker runner has no claim timeout');
  if (typeof copiesRoot !== 'string' || !copiesRoot.startsWith('/')) throw new Error('the worker runner has no copies root, so a start\'s copy can\'t be checked');
  const state = structuredClone(ctx.state ?? {});
  state.sessions ??= []; state.requests ??= {}; state.answers ??= {}; state.seen ??= {};
  // A drain_held in memory the status reader would refuse is dropped before any status is written, so one damaged field
  // can't make every status read fail (#425 r1 m4, r2 m2): it stands only as a cause and a time, on an ended session
  // whose outbox is open (owner-status.mjs checkSession). On such a session it was told, so its first sight is set past
  // the limit and heldOpen holds the real cause in this same pass; nothing else is published first (r2 c1).
  for (const s of state.sessions) {
    if (s?.drain_held === undefined) continue;
    const open = s.outbox_open === true && !isLive(s);
    if (open && drainHeldOk(s.drain_held)) continue;
    delete s.drain_held;
    if (open) s.undrained_since = now - RUNNER_DRAIN_HELD_MS;
  }
  const find = (id) => state.sessions.find((s) => s.id === id);
  const answer = (key, a) => { state.answers[key] = { ...a, at: now }; };
  const statusDoc = () => ({ written_at: new Date(Math.max(now, clock())).toISOString(), sessions: state.sessions.map(project),
    requests: Object.fromEntries(Object.entries(state.requests).map(([id, r]) => [id, { state: r.state }])),
    answers: Object.fromEntries(Object.entries(state.answers).map(([k, { at, ...a }]) => [k, a])) });
  // The memory is kept first, then the status written: a status never runs ahead of what the runner will remember.
  // A settled start leaves `pending` only after a keep that holds it succeeded (#358 r1 m3, #362 r1 M1).
  const settled = new Set();
  const flush = () => { keep(structuredClone(state)); for (const id of settled) pending.delete(id); settled.clear(); const doc = statusDoc(); write(doc); return doc; };
  // Every port wait is followed by a write (step-4 review M4), so no two writes are further apart than one port's wait.
  const wait = async (fn) => { const r = await within(portMs, fn); flush(); return r; };

  // 0. Starts that answered since the last pass; a 'waiting' entry with no start held for it is told.
  for (const [id, p] of [...pending]) if (p.done) { await settle(p); settled.add(id); flush(); }
  // Noted at most every RUNNER_NOTE_EVERY_MS, whether a start is still held or none is (#358 r1 m6).
  for (const [id, r] of Object.entries(state.requests)) {
    if (r.state !== 'waiting' || (Number.isFinite(r.told) && now - r.told < RUNNER_NOTE_EVERY_MS)) continue;
    r.told = now;
    note(r.running === true ? `${mayRun(id, r.pgid)}; it stays waiting, so its claim stays until the owner is told`
      : pending.has(id) ? `the start of ${id} is still on; it stays waiting, so its claim stays` : `the start of ${id} was on when the runner last stopped; it stays waiting, so its claim stays until the owner is told`);
  }

  // An outbox the drain did not close: its cause listed once it has stayed so for RUNNER_DRAIN_HELD_MS (L896).
  function heldOpen(s, d) {
    const asked = d && typeof d === 'object';
    const check = asked && d.late ? 'check-late' : asked && 'threw' in d ? 'check-failed' : null;
    const cause = check ?? (DRAIN_CAUSES.includes(d?.cause) ? d.cause : 'other');
    // One already held whose first sight is not kept (a memory without it) is past the limit: it was told before. A
    // first sight more than FUTURE_SKEW_MS ahead (a clock set back) is past it too: a future time is told, never waited
    // out (still-waiting pastTime, L317 MAT-1; #425 r1 M1).
    const first = s.undrained_since;
    if (!Number.isFinite(first) || first > now + FUTURE_SKEW_MS) s.undrained_since = s.drain_held || Number.isFinite(first) ? now - RUNNER_DRAIN_HELD_MS : now;
    if (now - s.undrained_since < RUNNER_DRAIN_HELD_MS) return;
    // A late or failed check, or a Record that could not be read, tells nothing new of a cause already held (#425 r1 m1,
    // m2): that one stays, so a slow pass or a cause that flips with a failing read does not tell the owner again.
    if ((check || cause === 'record-unreadable') && s.drain_held) return;
    if (s.drain_held?.cause !== cause) s.drain_held = { cause, since: new Date(now).toISOString() };
  }
  // 1. The sessions as they are now. Ended is final (M1).
  async function check(s) {
    if (s.ended === true) { s.alive = false; return; }
    const g = await wait(() => ports.groupGone(s));
    if (g === true) { s.alive = false; s.ended = true; s.ended_at ??= now; } else if (g === false) { s.alive = true; } else delete s.alive;
    if (!isLive(s) && state.requests[s.id]?.state === 'started') state.requests[s.id] = { state: 'stopped', at: now };
  }
  for (const s of state.sessions) {
    await check(s);
    if (isLive(s) && ports.size) {
      const z = await wait(() => ports.size(s));
      if (z && !z.late && !z.threw && z.size) { s.size = z.size; s.activity = z.activity; if (Number.isFinite(z.lastWriteAt)) s.last_write_at = z.lastWriteAt; } else { delete s.size; delete s.activity; }
    }
    if (!isLive(s) && s.outbox_open) {
      const d = await wait(() => ports.outboxDrained(s));
      if (d === true) { s.outbox_open = false; delete s.undrained_since; delete s.drain_held; } else heldOpen(s, d);
    }
    flush();
  }
  // A session leaves only once no kept answer names it (#328 r1 m1): an ok is never read with its session gone.
  const named = new Set(Object.keys(state.answers).map((key) => requestKey(`${key}.json`)?.id).filter(Boolean));
  state.sessions = state.sessions.filter((s) => isLive(s) || s.outbox_open || named.has(s.id) || !(now - (s.ended_at ?? now) > RUNNER_KEEP_USED_UP_MS));

  // 2. The requests.
  for (const { name, body } of requests) {
    // One still being written (#433 r1 m1, runner-files.mjs REQUEST_SETTLE_MS) is left as it is, for the next pass.
    if (body?.notYet) continue;
    // Removed before it is acted on (its body was read by the caller), so it is never acted on twice; one that can't be
    // removed is left for the owner and not acted on (m6).
    try { remove(name); } catch (e) { note(`request ${String(name).slice(0, 80)} could not be removed (${e?.message ?? e}); not read`); continue; }
    const k = requestKey(name);
    const asked = Date.parse(body?.asked_at ?? '');
    if (!k) { note(`request ${String(name).slice(0, 80)} is not a name the Dispatcher writes; not read`); continue; }
    if (body?.refused) { note(`request ${name} was refused unread: ${body.refused}`); continue; }
    if (!bodyMatches(k, body)) { note(`request ${name} says something other than its name; not read`); continue; }
    // A stop is asked again each pass until its launch is used up (stopSession), and asking twice only stops twice: it
    // is never a replay, so its key is never kept as seen. Every other key is acted on once.
    if (Object.hasOwn(state.answers, k.key) || Object.hasOwn(state.seen, k.key)) { note(`request ${name} was answered before; a replay is not read`); continue; }
    if (k.verb !== 'stop' && (!Number.isFinite(asked) || now - asked > RUNNER_KEEP_USED_UP_MS)) { note(`request ${name} is older than the runner keeps answers; not read`); continue; }
    if (k.verb !== 'stop' && asked - now > CLOCK_SKEW_MS) { note(`request ${name} is dated later than now; not read`); continue; }
    if (k.verb !== 'stop') state.seen[k.key] = Math.max(now, asked); // kept a day past its own date too (#358 r1 m2)
    if (k.verb === 'stop') await stopRequest(k.id);
    else if (k.verb === 'launch') await launch(k, body.launch, asked);
    else if (k.verb === 'stopGroup') await stopGroup(k, body.stopGroup);
    else if (k.verb === 'saveWork') await save(k);
    else await pause(k, body.pauseLead);
    flush();
  }

  async function stopRequest(id) {
    // Only a launch never seen is cancelled. A 'waiting' one may have started before a pass that never finished, so it
    // is never marked used up here (stopSession would then free a claim whose session may run).
    if (!Object.hasOwn(state.requests, id)) { state.requests[id] = { state: 'cancelled', at: now }; return; }
    // A start that may have left claude running (#364 r2 n2) is not signalled: its leader's start time was never read,
    // so a reused group number can't be told from it, and a wrong kill would hit some other process of the owner's.
    // The note names the group, so the owner can check and stop it by hand; the claim stays held.
    const r = state.requests[id];
    if (r.state === 'waiting' && r.running === true) { note(`a stop was asked for ${id}, but ${mayRun(id, r.pgid).replace(/^the start of \S+ /, 'its start ')}, which the runner can't tell from a reused number, so it is not signalled; the owner checks that group and stops it`); return; }
    const s = find(id);
    if (!s || !isLive(s)) return;
    await stopping(s);
  }
  // Set the flag and write it down before acting (L762); the stop's own outcome then settles alive and the request.
  function mayRun(id, g) { return `the start of ${id} may have left claude running in process group ${g ?? 'unknown'}`; }
  async function stopping(s) {
    s.stop_requested = true; flush();
    const r = await wait(() => ports.stopGroup(s));
    await check(s);
    return r;
  }
  async function launch(k, l, asked) {
    const id = k.id;
    const refuse = (reason) => { state.requests[id] = { state: 'refused', at: now }; answer(k.key, { ok: false, reason }); };
    if (Object.hasOwn(state.requests, id)) { if (state.requests[id].state === 'cancelled') answer(k.key, { ok: false, reason: 'a stop request reached it first' }); return; }
    if (now - asked > claimMs) return refuse('the launch request is older than the claim timeout');
    if (!RUNNER_KINDS.includes(l.kind)) return refuse(`the worker runner does not start ${JSON.stringify(l.kind)} sessions`);
    if (typeof l.card !== 'string' || !CARD_ID.test(l.card) || l.card.startsWith('.') || !productName(l.product)) return refuse('the launch names no card or product the runner takes');
    // An undo names the commit it reverses (L976); no other launch names one.
    if (l.kind === 'undo' && !(typeof l.undo_commit === 'string' && UNDO_COMMIT.test(l.undo_commit))) return refuse('the undo launch names no reversed commit');
    if (l.kind !== 'undo' && l.undo_commit !== undefined) return refuse('only an undo launch names a reversed commit');
    // One session per card's copy (#358 r1 m4): a live listed one, or a start that may be on, holds it.
    if (state.sessions.some((s) => s.card === l.card && isLive(s)) || Object.values(state.requests).some((r) => r.state === 'waiting' && r.card === l.card)) return refuse(`card ${l.card} already has a session the runner started, or a start still on`);
    state.requests[id] = { state: 'waiting', at: now, card: l.card, product: l.product }; flush();
    // The other live sessions (#378 r1 M1): the listed ones, and the waiting starts of an earlier run (this run's own
    // starts are made from this config, so they deny every product in it). One not known to have reached claude is
    // marked so: no settings file then means no claude was started with it.
    const live = [...state.sessions.filter(isLive).map((s) => ({ id: s.id, product: s.product })),
      ...Object.entries(state.requests).filter(([q, r]) => q !== id && r?.state === 'waiting' && !pending.has(q)).map(([q, r]) => ({ id: q, product: r.product, unstarted: true }))];
    // The start is held across passes: one still on after portMs is settled by a later pass (step 0), never lost.
    const p = { key: k.key, id, l, done: false, a: undefined };
    p.on = Promise.resolve().then(() => ports.start({ card: l.card, kind: l.kind, product: l.product, sessionId: id, live, ...(l.kind === 'undo' ? { undoCommit: l.undo_commit } : {}) }))
      .then((a) => { p.a = a; }, (e) => { p.a = { threw: e?.message ?? String(e) }; }).finally(() => { p.done = true; });
    pending.set(id, p);
    await Promise.race([p.on, late(portMs)]);
    if (!p.done) { state.requests[id].told = now; note(`the start of ${id} is still on; it stays waiting, so its claim stays`); return; }
    await settle(p); settled.add(id);
  }
  // A start's answer: listed only when the reader would take it (M2); one it would refuse is stopped, then refused.
  async function settle({ key, id, l, a }) {
    if (state.requests[id]?.state !== 'waiting') return;
    const refuse = (reason) => { state.requests[id] = { state: 'refused', at: now }; answer(key, { ok: false, reason }); };
    // A start whose claude may still run (#364 r1 m3) is not refused: the request stays waiting, so its claim stays.
    // Its process group is kept in the waiting row and named in every note (#364 r2 n2), so the owner can find it.
    if (a?.ok === false && a.running === true) {
      const g = Number.isInteger(a.pgid) && a.pgid > 1 ? a.pgid : null;
      state.requests[id] = { ...state.requests[id], running: true, pgid: g, told: now };
      note(`${mayRun(id, g)} (${a.reason}); it stays waiting, so its claim stays`); return;
    }
    if (!a || a.threw || a.ok !== true) return refuse(failed(a, 'the start'));
    const s = { id, product: l.product, kind: l.kind, card: l.card, lead: null, role: RUNNER_ROLE_OF[l.kind], pgid: a.pgid, signin: a.signin, config_dir: a.configDir,
      bundle_files: [], outbox: a.outbox, uid, outbox_open: true, stop_requested: false, alive: true, ended: false,
      pid: a.pid, pid_start: a.pidStart, head: a.head, base: a.base, copy: a.copy, started_at: now };
    let wrong = null;
    try { checkSession(project(s), { uid, outboxRoot, realpath }); } catch (e) { wrong = e.message; }
    if (!wrong) wrong = launchAnswerWrong(a, { sessionId: id, kind: l.kind, card: l.card, product: l.product, outboxRoot, copiesRoot });
    // The runner tells a reused process group number from its own only by the leader's start time (step-4 review M3).
    if (!wrong && !(a.pid === a.pgid && typeof a.pidStart === 'string' && a.pidStart)) wrong = `session ${id}'s start named no group leader with a start time`;
    if (!wrong) {
      state.sessions.push(s); state.requests[id] = { state: 'started', at: now };
      return answer(key, { ok: true, sessionId: id, pid: a.pid, pidStart: a.pidStart, pgid: a.pgid, head: a.head, ...(a.base !== undefined ? { base: a.base } : {}), outbox: a.outbox, signin: a.signin, configDir: a.configDir, copy: a.copy });
    }
    note(`the start of ${id} answered what the status can't carry (${wrong}); it is stopped`);
    if (!(Number.isInteger(a.pgid) && a.pgid > 1)) { note(`the start of ${id} named no process group, so it can't be stopped; it stays waiting, so its claim stays`); return; }
    await wait(() => ports.stopGroup({ ...s, stop_requested: true }));
    const g = await wait(() => ports.groupGone(s));
    if (g === true) return refuse(`the start answered what the runner can't list (${wrong}); it was stopped`);
    note(`the start of ${id} could not be shown stopped; it stays waiting, so its claim stays`);
  }
  async function stopGroup(k, g) {
    const s = find(k.id);
    if (!s) return answer(k.key, { ok: false, reason: 'the worker runner did not start that session, or it has left the listing' });
    if (g?.pgid !== undefined && g.pgid !== null && g.pgid !== s.pgid) return answer(k.key, { ok: false, reason: 'the stop names another process group than the session\'s' });
    if (!isLive(s)) { s.stop_requested = true; return answer(k.key, { ok: true, how: 'already gone' }); }
    const r = await stopping(s);
    if (!isLive(s) && s.alive === false) return answer(k.key, { ok: true, how: typeof r?.how === 'string' && r.how ? r.how : 'stopped' });
    answer(k.key, { ok: false, reason: `${failed(r?.ok ? { reason: 'the process group is still there' } : r, 'the stop')}; it may still run` });
  }
  async function save(k) {
    const s = find(k.id);
    if (!s) return answer(k.key, { ok: false, reason: 'the worker runner did not start that session, so it has no copy to save' });
    const r = await wait(() => ports.saveWork(s));
    answer(k.key, r?.ok === true ? { ok: true } : { ok: false, reason: failed(r, 'the save') });
  }
  async function pause(k, p) {
    const r = await wait(() => ports.pauseLead({ product: p.product }));
    answer(k.key, r?.ok === true ? { ok: true } : { ok: false, reason: failed(r, 'the pause') });
  }

  // 3. Forget what is past keeping; a listed session's entry is never dropped (the status needs it).
  const old = (at) => now - at > RUNNER_KEEP_USED_UP_MS;
  for (const [id, r] of Object.entries(state.requests)) if (USED_UP.includes(r.state) && old(r.at) && !find(id)) delete state.requests[id];
  // 'waiting' entries are never dropped: each may be a session that runs (they are noted each pass instead).
  for (const [key, a] of Object.entries(state.answers)) if (old(a.at)) delete state.answers[key];
  for (const [key, at] of Object.entries(state.seen)) if (old(at)) delete state.seen[key];

  // 4. The status.
  return { state, status: flush() };
}

export { VERBS };
