// Part C, runner step 2 (L759): the Dispatcher's side of the four async owner ports (owner-ports.mjs: launch, stopGroup,
// saveWork, pauseLead). Nothing here is wired yet: owner-ports.mjs still hands out refusing ports.
//
// Each ask writes one request file into the runner's requests folder (requestWriter: exclusive) and then reads the
// runner's status (readOwnerStatus, every check of step 1) until the answer to that request is there:
//   <requestsDir>/<key>.json, and the answer in the status at answers[<key>] (owner-status.mjs ANSWER_KEY):
//   - launch-<sessionId>                     { launch: { card, kind, product, sessionId } }   one per claimed id
//   - stopGroup-<sessionId>-<nonce>          { stopGroup: { id, pgid, kind } }
//   - saveWork-<sessionId>-<nonce>           { saveWork: { id, kind, card } }
//   - pauseLead-<product>-<nonce>            { pauseLead: { product } }
// A launch is keyed by its claimed session id alone, so a second ask for it waits on the first. The others carry a fresh
// nonce, so a stop, save or pause asked again later is a new request, never an old answer read twice.
//
// An answer is trusted only when the same status agrees with it; until then the ask keeps waiting (the outcome is not
// known, so it never answers { ok: false }):
//   - launch ok: the request is 'started' (or since 'stopped'), and every field is what this runner must make:
//     sessionId the asked one, outbox <outboxRoot>/<product>/<role>/<id> (worker, or script for a script card: L767, L836), copy <copiesRoot>/<product>/<card>, pid and pgid real, pid_start
//     a non-empty string, head a commit id, signin and configDir non-empty. The session it started is listed while
//     'started' (and may be after), and the listing agrees: card, product, kind, pgid, signin, config_dir and outbox.
//     launch ok: false: the request is 'refused'.
//   - stopGroup ok: the session is listed with stop_requested, no longer live by the status's own rule, and with the
//     process group that was asked to stop.
// A status that can't be read is waited through the same way. The tick's limit (pass.mjs guarded) answers first. So that
// a port the tick has given up on does not poll for ever, each ask stops at its own limit, giveUpMs (default 10 minutes,
// past every tick limit), and answers there as the tick's limit does: { ok: false, timedOut: true, reason }, which
// pass.mjs reads as "not known; it may still happen". pauseLead throws there, as for every failed pause.
//
// The runner's side (reading these requests, the launch wall, writing the answers, removing old request files) is the
// runner's process (runner-launch.mjs and the later loop).

import { randomBytes } from 'node:crypto';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { PRODUCT } from '../shared/product-paths.mjs';
import { CARD_ID } from '../modules/M9-record/outbox.mjs';
import { RUNNER_KINDS, RUNNER_ROLE_OF, live, readOwnerStatus, runnerCopy, runnerOutbox } from './owner-status.mjs';

/** The kinds whose sessions have no work copy, so a stop never reads as unsaved work (owner-ports.mjs saveWork). */
export const NO_COPY_KINDS = Object.freeze(['review', 'audit', 'readonly', 'lead', 'front_door']);
/** How often an ask reads the status while it waits, and when it stops waiting (past any tick limit). */
export const ASK_POLL_MS = 2_000;
export const ASK_GIVE_UP_MS = 600_000;
// A product as a request file may name it: setup's product name (shared/product-paths.mjs PRODUCT, #378 r1 m3), never a path.
const productName = (p) => typeof p === 'string' && PRODUCT.test(p);
const HEAD = /^[0-9a-f]{40}$/;
const LAUNCH_FIELDS = Object.freeze(['sessionId', 'pid', 'pidStart', 'pgid', 'head', 'outbox', 'signin', 'configDir', 'copy']);

const name = (x) => typeof x === 'string' && x.length > 0;
const realPid = (n) => Number.isInteger(n) && n > 1;

/**
 * What is wrong with a start's answer, or null: the one definition both sides use (#358 r1 m1), the runner before it
 * lists a session and the Dispatcher's launch ask before it trusts one. sessionId the asked one, pid and pgid real, a
 * leader start time, head a commit id, outbox <outboxRoot>/<product>/<role>/<sessionId>, copy <copiesRoot>/<product>/<card> (L836), signin and
 * configDir non-empty.
 */
export function launchAnswerWrong(a, { sessionId, kind, card, product, outboxRoot, copiesRoot }) {
  if (a?.sessionId !== undefined && a.sessionId !== sessionId) return 'the answer names another session';
  if (!realPid(a?.pid)) return 'the start named no process';
  if (!realPid(a.pgid)) return 'the start named no process group';
  if (!name(a.pidStart)) return 'the start named no start time for its process';
  if (!HEAD.test(a.head ?? '')) return 'the start named no commit for its copy';
  // A name the places can't be made from is said as such (#378 r1 m3), never as another outbox.
  let outbox; try { outbox = Object.hasOwn(RUNNER_ROLE_OF, kind) && typeof outboxRoot === 'string' ? runnerOutbox({ outboxRoot, product, role: RUNNER_ROLE_OF[kind], sessionId }) : null; } catch (e) { return `the session's outbox can't be named: ${e.message}`; }
  if (!outbox || a.outbox !== outbox) return 'the start named another outbox than the session\'s own';
  let copy; try { copy = typeof copiesRoot === 'string' ? runnerCopy({ copiesRoot, product, card }) : null; } catch (e) { return `the card's copy can't be named: ${e.message}`; }
  if (!copy || a.copy !== copy) return 'the start named another copy than the card\'s';
  if (!name(a.signin) || !name(a.configDir)) return 'the start named no sign-in';
  return null;
}

/**
 * The four async owner ports. `writeRequest(name, text)` is requestWriter(requestsDir); `sleep(ms)` waits; `nonce()`
 * gives a fresh hex word. stat, open and realpath go to readOwnerStatus as in step 1.
 */
export function ownerAsyncPorts({ statusFile, uid, outboxRoot, copiesRoot, writeRequest, clock = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  nonce = () => randomBytes(8).toString('hex'), pollMs = ASK_POLL_MS, giveUpMs = ASK_GIVE_UP_MS, stat, open, realpath }) {
  if (typeof writeRequest !== 'function') throw new Error('the asks need the requests folder\'s writer');
  if (!name(copiesRoot) || !copiesRoot.startsWith('/')) throw new Error('the copies folder is not known, so a launch answer can\'t be checked');
  const status = () => readOwnerStatus({ file: statusFile, now: clock(), uid, outboxRoot, realpath, stat, open });

  // Write the request, then wait for an answer `accept` takes. accept(answer, status) -> the port's answer, or undefined
  // while the status does not yet agree.
  // Nothing after the request is written throws: a clock that fails is waited through, and the reads alone count the time
  // (so a stuck or failing clock still stops at the limit).
  async function ask(key, body, accept) {
    const start = clock();
    writeRequest(`${key}.json`, `${JSON.stringify({ ...body, asked_at: new Date(start).toISOString() })}\n`);
    let last = 'no answer yet';
    for (let n = 0; ; n += 1) {
      let waited = n * pollMs;
      try {
        const s = status();
        const a = Object.hasOwn(s.answers, key) ? s.answers[key] : undefined;
        if (a) { const out = accept(a, s); if (out) return out; last = 'an answer the rest of its status does not bear out'; }
      } catch (e) { last = e?.message ?? String(e); }
      try { const t = clock() - start; if (t > waited) waited = t; } catch { /* the reads alone count */ }
      if (waited >= giveUpMs) return { ok: false, timedOut: true, reason: `the worker runner did not answer ${key} within ${giveUpMs} ms (${last})` };
      await sleep(pollMs);
    }
  }
  const told = (a) => ({ ok: false, reason: a.reason });

  return {
    launch: async ({ card, kind, product, sessionId } = {}) => {
      // Before the request is written a throw reads as refused (owner-ports.mjs).
      if (!REQUEST_ID.test(sessionId ?? '')) throw new Error('the launch names no session id the runner takes');
      if (!RUNNER_KINDS.includes(kind)) throw new Error(`the worker runner does not start ${JSON.stringify(kind)} sessions`);
      // No leading dot (#328 r1 c1): '.' would name copiesRoot itself, as review-runner.mjs refuses too.
      if (!CARD_ID.test(card ?? '') || card.startsWith('.') || !productName(product)) throw new Error('the launch names no card or product');
      return ask(`launch-${sessionId}`, { launch: { card, kind, product, sessionId } }, (a, s) => {
        const state = Object.hasOwn(s.requests, sessionId) ? s.requests[sessionId].state : undefined;
        if (a.ok === false) return state === 'refused' ? told(a) : undefined;
        const right = (state === 'started' || state === 'stopped') && a.sessionId === sessionId && !launchAnswerWrong(a, { sessionId, kind, card, product, outboxRoot, copiesRoot });
        // The session the answer names is the one the status lists (review M2): listed while started, and agreeing.
        const x = s.sessions.find((y) => y.id === sessionId);
        const agrees = x ? x.card === card && x.product === product && x.kind === kind && x.pgid === a.pgid && x.signin === a.signin
          && x.config_dir === a.configDir && x.outbox === a.outbox : state === 'stopped';
        return right && agrees ? { ok: true, ...Object.fromEntries(LAUNCH_FIELDS.map((f) => [f, a[f]])) } : undefined;
      });
    },
    stopGroup: async (session) => {
      const { id, pgid, kind } = session ?? {};
      if (!REQUEST_ID.test(id ?? '')) return { ok: false, reason: 'the stop names no session id' };
      if (!RUNNER_KINDS.includes(kind)) return { ok: false, reason: `the worker runner did not start ${JSON.stringify(kind)} sessions` };
      return ask(`stopGroup-${id}-${nonce()}`, { stopGroup: { id, pgid, kind } }, (a, s) => {
        if (a.ok === false) return told(a);
        const x = s.sessions.find((y) => y.id === id);
        // Gone by the status's own rule (review M1: no alive field is not gone), and the group that was asked to stop.
        return x && x.stop_requested === true && !live(x) && (pgid === undefined || pgid === null || x.pgid === pgid) && name(a.how) ? { ok: true, how: a.how } : undefined;
      });
    },
    saveWork: async (session) => {
      const { id, kind, card } = session ?? {};
      if (NO_COPY_KINDS.includes(kind)) return { ok: true };
      if (kind === 'overnight') return { ok: false, reason: 'no runner starts overnight sessions yet, so none saves one' };
      if (!RUNNER_KINDS.includes(kind)) return { ok: false, reason: `no runner saves ${JSON.stringify(kind)} sessions` };
      if (!REQUEST_ID.test(id ?? '')) return { ok: false, reason: 'the save names no session id' };
      return ask(`saveWork-${id}-${nonce()}`, { saveWork: { id, kind, card: card ?? null } }, (a) => (a.ok ? { ok: true } : told(a)));
    },
    pauseLead: async ({ product } = {}) => {
      if (!productName(product)) throw new Error('the pause names no product');
      const r = await ask(`pauseLead-${product}-${nonce()}`, { pauseLead: { product } }, (a) => (a.ok ? { ok: true } : told(a)));
      if (!r.ok) throw new Error(r.reason);
      return r;
    },
  };
}
