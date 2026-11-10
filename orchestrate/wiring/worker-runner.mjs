// Part C, runner step 3: one pass of the owner-side worker runner (owner-ports.mjs, owner-status.mjs's contract). The
// runner is a LaunchAgent of the owner's user. Each pass it reads the requests the Dispatcher wrote, acts on them, checks
// its sessions, and writes its one status file. Every outside effect is a port, so the tests run on fakes; the real
// ports (starting claude through walledLaunchSettings, process groups, M4 save-work, the Lead's wrap-up) are joined in
// a later step, as review-runner-main.mjs does for the review runner.
//
// The runner's memory (`state`, kept by the caller in a file only the runner reads) is the one source for the status:
//   { sessions: [SESSION + { pid, pid_start, head, copy, started_at, ended_at? }], requests: { <sessionId>: { state, at } },
//     answers: { <key>: { ...answer, at } }, seen: { <key>: at } }
// A pass, in order:
//   1. Each session is checked: a process group that is gone (groupGone true) is alive false and ended, and its launch
//      request 'stopped'; one the port can't tell about keeps no alive field (so it still counts as live). A session not
//      live closes its outbox once outboxDrained says intake has taken or told every file, and leaves the listing once
//      its outbox is closed and it ended more than RUNNER_KEEP_USED_UP_MS ago.
//   2. Requests, oldest first. Each is read once and removed (a request is never acted on twice):
//      - refused unread (only noted) when its body's verb or id does not match its file name, its key was answered or
//        seen before, or its asked_at is older than RUNNER_KEEP_USED_UP_MS (#328 r1 m2: a replay, never a new ask); a
//        stop is exempt, since stopSession asks again each pass and a second stop only stops again;
//      - stop-<id>: a launch request not yet seen is 'cancelled' (it never starts); a live session is stopped with
//        stop_requested set first;
//      - launch-<id>: refused when it is older than claimMs (a claim that may have lapsed), when its kind, card or product
//        is not one the runner takes, or when start refuses; otherwise the session is listed 'started' with its answer;
//        a start that does not answer within portMs stays 'waiting' and unanswered, so it is never read as refused;
//      - stopGroup-<id>-<nonce>: stop_requested is set and the status written before the stop (L762), and the answer is
//        ok only once the group is gone; a stop that fails or times out answers ok: false with the flag still set;
//      - saveWork-<id>-<nonce>, pauseLead-<product>-<nonce>: the port's answer, or ok: false at portMs.
//   3. Used-up request entries, answers and seen keys older than RUNNER_KEEP_USED_UP_MS are dropped.
//   4. The status is written. In every status that carries a launch ok or a stopGroup ok, the session stays listed.
// A 'waiting' entry left by a pass that never finished (the runner stopped mid-start) is left as it is: its session may
// have started, so the request is never used up, stopSession never answers true for it, and the claim stays until Joe is
// told (M9 lapseClaims). The caller runs a pass at least every RUNNER_STATUS_EVERY_MS (L769).

import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { PRODUCT_NAME } from '../modules/M10-rules/reader.mjs';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { RUNNER_KEEP_USED_UP_MS, RUNNER_KINDS, RUNNER_ROLE_OF, USED_UP } from './owner-status.mjs';

/** How long the runner waits on one port before it answers for it (never longer than an ask waits, ASK_GIVE_UP_MS). */
export const RUNNER_PORT_MS = 120_000;
/** The status's session fields (owner-status.mjs SESSION), in its order: nothing of the runner's own memory. */
export const STATUS_SESSION_FIELDS = Object.freeze(['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files',
  'outbox', 'uid', 'outbox_open', 'stop_requested', 'alive', 'ended', 'last_write_at', 'size', 'activity']);
const VERBS = Object.freeze(['stop', 'launch', 'stopGroup', 'saveWork', 'pauseLead']);
const NAME = /^(stop|launch|stopGroup|saveWork|pauseLead)-([A-Za-z0-9._-]{1,140})\.json$/;
const NONCE = /^[a-f0-9]{16}$/;
// The product rule is M10's, as owner-asks.mjs checks it before asking.
const productName = (p) => typeof p === 'string' && p.length <= 64 && PRODUCT_NAME.test(p);

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
 * claimMs, portMs?, ports: { start, groupGone, stopGroup, saveWork, pauseLead, outboxDrained, size? }, write(statusDoc),
 * remove(name), note(text) }. → { state, status } (the state to keep, the status last written).
 */
export async function workerRunnerPass(ctx) {
  const { requests = [], now, uid, outboxRoot, claimMs, portMs = RUNNER_PORT_MS, ports, write, remove = () => {}, note = () => {} } = ctx;
  if (!Number.isFinite(now)) throw new Error('the worker runner has no clock');
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the worker runner does not know the owner\'s uid');
  if (typeof outboxRoot !== 'string' || !outboxRoot.startsWith('/')) throw new Error('the worker runner has no outbox root');
  if (!Number.isFinite(claimMs) || claimMs <= 0) throw new Error('the worker runner has no claim timeout');
  const state = structuredClone(ctx.state ?? {});
  state.sessions ??= []; state.requests ??= {}; state.answers ??= {}; state.seen ??= {};
  const find = (id) => state.sessions.find((s) => s.id === id);
  const answer = (key, a) => { state.answers[key] = { ...a, at: now }; };
  const statusDoc = () => ({ written_at: new Date(now).toISOString(), sessions: state.sessions.map(project),
    requests: Object.fromEntries(Object.entries(state.requests).map(([id, r]) => [id, { state: r.state }])),
    answers: Object.fromEntries(Object.entries(state.answers).map(([k, { at, ...a }]) => [k, a])) });
  const flush = () => { const doc = statusDoc(); write(doc); return doc; };

  // 1. The sessions as they are now.
  async function check(s) {
    const g = await within(portMs, () => ports.groupGone(s));
    if (g === true) { s.alive = false; s.ended = true; s.ended_at ??= now; } else if (g === false) { s.alive = true; } else delete s.alive;
    if (!isLive(s) && state.requests[s.id]?.state === 'started') state.requests[s.id] = { state: 'stopped', at: now };
  }
  for (const s of state.sessions) {
    await check(s);
    if (isLive(s) && ports.size) {
      const z = await within(portMs, () => ports.size(s));
      if (z && !z.late && !z.threw && z.size) { s.size = z.size; s.activity = z.activity; if (Number.isFinite(z.lastWriteAt)) s.last_write_at = z.lastWriteAt; } else { delete s.size; delete s.activity; }
    }
    if (!isLive(s) && s.outbox_open) { const d = await within(portMs, () => ports.outboxDrained(s)); if (d === true) s.outbox_open = false; }
  }
  state.sessions = state.sessions.filter((s) => isLive(s) || s.outbox_open || !(now - (s.ended_at ?? now) > RUNNER_KEEP_USED_UP_MS));

  // 2. The requests.
  for (const { name, body } of requests) {
    remove(name);
    const k = requestKey(name);
    const asked = Date.parse(body?.asked_at ?? '');
    if (!k) { note(`request ${String(name).slice(0, 80)} is not a name the Dispatcher writes; not read`); continue; }
    if (body?.refused) { note(`request ${name} was refused unread: ${body.refused}`); continue; }
    if (!bodyMatches(k, body)) { note(`request ${name} says something other than its name; not read`); continue; }
    // A stop is asked again each pass until its launch is used up (stopSession), and asking twice only stops twice: it
    // is never a replay. Every other key is acted on once.
    if (k.verb !== 'stop' && (Object.hasOwn(state.answers, k.key) || Object.hasOwn(state.seen, k.key))) { note(`request ${name} was answered before; a replay is not read`); continue; }
    if (k.verb !== 'stop' && (!Number.isFinite(asked) || now - asked > RUNNER_KEEP_USED_UP_MS)) { note(`request ${name} is older than the runner keeps answers; not read`); continue; }
    if (k.verb !== 'stop') state.seen[k.key] = now;
    if (k.verb === 'stop') await stopRequest(k.id);
    else if (k.verb === 'launch') await launch(k, body.launch, asked);
    else if (k.verb === 'stopGroup') await stopGroup(k);
    else if (k.verb === 'saveWork') await save(k);
    else await pause(k, body.pauseLead);
  }

  async function stopRequest(id) {
    // Only a launch never seen is cancelled. A 'waiting' one may have started before a pass that never finished, so it
    // is never marked used up here (stopSession would then free a claim whose session may run).
    if (!Object.hasOwn(state.requests, id)) { state.requests[id] = { state: 'cancelled', at: now }; return; }
    const s = find(id);
    if (!s || !isLive(s)) return;
    await stopping(s);
  }
  // Set the flag and write it down before acting (L762); the stop's own outcome then settles alive and the request.
  async function stopping(s) {
    s.stop_requested = true; flush();
    const r = await within(portMs, () => ports.stopGroup(s));
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
    state.requests[id] = { state: 'waiting', at: now }; flush();
    const a = await within(portMs, () => ports.start({ card: l.card, kind: l.kind, product: l.product, sessionId: id }));
    if (a?.late) { note(`the start of ${id} did not answer within the runner's limit; it stays waiting, so its claim stays`); return; }
    if (!a || a.threw || a.ok !== true) return refuse(failed(a, 'the start'));
    const role = RUNNER_ROLE_OF[l.kind];
    state.sessions.push({ id, product: l.product, kind: l.kind, card: l.card, lead: null, role, pgid: a.pgid, signin: a.signin, config_dir: a.configDir,
      bundle_files: [], outbox: a.outbox, uid, outbox_open: true, stop_requested: false, alive: true, ended: false,
      pid: a.pid, pid_start: a.pidStart, head: a.head, copy: a.copy, started_at: now });
    state.requests[id] = { state: 'started', at: now };
    answer(k.key, { ok: true, sessionId: id, pid: a.pid, pidStart: a.pidStart, pgid: a.pgid, head: a.head, outbox: a.outbox, signin: a.signin, configDir: a.configDir, copy: a.copy });
  }
  async function stopGroup(k) {
    const s = find(k.id);
    if (!s) return answer(k.key, { ok: false, reason: 'the worker runner did not start that session, or it has left the listing' });
    if (!isLive(s)) { s.stop_requested = true; return answer(k.key, { ok: true, how: 'already gone' }); }
    const r = await stopping(s);
    if (!isLive(s) && s.alive === false) return answer(k.key, { ok: true, how: typeof r?.how === 'string' && r.how ? r.how : 'stopped' });
    answer(k.key, { ok: false, reason: `${failed(r?.ok ? { reason: 'the process group is still there' } : r, 'the stop')}; it may still run` });
  }
  async function save(k) {
    const s = find(k.id);
    if (!s) return answer(k.key, { ok: false, reason: 'the worker runner did not start that session, so it has no copy to save' });
    const r = await within(portMs, () => ports.saveWork(s));
    answer(k.key, r?.ok === true ? { ok: true } : { ok: false, reason: failed(r, 'the save') });
  }
  async function pause(k, p) {
    const r = await within(portMs, () => ports.pauseLead({ product: p.product }));
    answer(k.key, r?.ok === true ? { ok: true } : { ok: false, reason: failed(r, 'the pause') });
  }

  // 3. Forget what is past keeping; a listed session's entry is never dropped (the status needs it).
  const old = (at) => now - at > RUNNER_KEEP_USED_UP_MS;
  for (const [id, r] of Object.entries(state.requests)) if (USED_UP.includes(r.state) && old(r.at) && !find(id)) delete state.requests[id];
  for (const [key, a] of Object.entries(state.answers)) if (old(a.at)) delete state.answers[key];
  for (const [key, at] of Object.entries(state.seen)) if (old(at)) delete state.seen[key];
  // An answer whose session is still listed stays with it (#328 r1 m1): its session is never dropped in the same write.

  // 4. The status.
  return { state, status: flush() };
}

export { VERBS };
