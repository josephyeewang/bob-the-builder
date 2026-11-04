// The account switch's side of the Dispatcher (R-1-89 (c), L61). Every port that starts, lists, checks or stops a
// session goes through here, so each one knows which sign-in folder it acts in:
//   start  (launch, startReadonly, startMinibase, a Lead's startLead): in the account in use (`accounts.mjs
//          use a|b`), read at the start; the result names the folder (`signin`, `configDir`);
//   list   (sessions, board, outboxSessions, leads): once per account folder, merged, each entry tagged with its folder,
//          so after a switch the old account's sessions are still seen;
//   stop   (stopGroup, a Lead's stopSession): through the folder the session runs in, not the one in use;
//   stop everywhere (stopSession, for the Record's lapse of a claim whose session never started, L72): yes only when
//          every folder says that session id is stopped there; any other answer (or an error) is a no (L63);
//   the Front Door: alive only when it runs on the account in use, so after a switch it is restarted there (the old
//          one is stopped first), and the phone shows it under the account in use. It is the one session a switch
//          moves (L62); one left running on the old account is stopped (`strayFrontDoor`).
// A running worker or Lead is never moved: a switch changes only where the next one starts.
// "signin" here is the sign-in folder (a or b), not the usage account the tick's bands read.
// No process is started here (only-send-safe.test.mjs); the wiring hands in the real per-folder ports (`accountPorts`).

import { ACCOUNTS, ACCOUNT_NAMES, accountDir, accountEnv, accountInUse, isSetUp } from '../M4-workshop/launcher/accounts.mjs';

const ctxOf = (home, signin) => ({ signin, configDir: accountDir(home, signin), env: accountEnv(home, signin) });
const where = (n) => `account ${n} (~/${ACCOUNTS[n]})`;
const setUp = (home) => ACCOUNT_NAMES.filter((n) => isSetUp(home, n));
const thenable = (v) => typeof v?.then === 'function';
const why = (e) => e?.message ?? String(e);
const tag = (r, ctx) => (r && typeof r === 'object' ? { ...r, signin: ctx.signin, configDir: ctx.configDir } : r);
function inUse(home) {
  const u = accountInUse({ home });
  return u.account ? { ctx: ctxOf(home, u.account) } : { reason: `no account to start on: ${u.reason}` };
}

/**
 * A start port in the account in use: `startIn(ctx, ...args)` starts in that folder. Refused, with nothing started, when
 * the account in use can't be read. `ctx` = { signin, configDir, env }; `env` is the variables to add to the session's
 * environment (`{ CLAUDE_CONFIG_DIR }` for account b, none for account a: pass it as the launcher's roleEnv `extra`).
 */
export function startInUse({ home, startIn }) {
  return async (...args) => {
    const u = inUse(home);
    if (!u.ctx) return { ok: false, reason: u.reason };
    return tag(await startIn(u.ctx, ...args), u.ctx);
  };
}

/** The worker launch: the inner launch is given `{ ...x, signin, configDir, env }`. */
export function accountLaunch({ home, launch }) {
  return startInUse({ home, startIn: (ctx, x) => launch({ ...x, ...ctx }) });
}

/**
 * A list port over every account folder that is set up, whichever is in use: `listIn(ctx)` lists one folder's own
 * entries. Each entry gets `signin` and `config_dir`. A folder whose list fails fails the whole list, naming the folder,
 * so a session is never missed silently. An entry listed by both folders is an error naming it (L61 (7)): each folder's
 * list must be that folder's own (`claude agents`), never read from the shared `projects/` folder. Works for a list that
 * answers at once or later. `idOf` finds an entry's session id; `what` names the list in errors.
 */
export function acrossAccounts({ home, listIn, idOf = (s) => s?.id, what = 'sessions' }) {
  return () => {
    const names = setUp(home);
    const failed = (n, e) => new Error(`${where(n)}: its ${what} could not be listed (${why(e)})`);
    const lists = names.map((n) => { try { return listIn(ctxOf(home, n)); } catch (e) { throw failed(n, e); } });
    const merge = (all) => {
      const from = new Map();
      const out = [];
      all.forEach((list, i) => {
        const n = names[i];
        if (!Array.isArray(list)) throw failed(n, 'no list');
        for (const s of list) {
          const id = idOf(s);
          if (id !== undefined && id !== null) {
            const first = from.get(id);
            if (first !== undefined && first !== n) throw new Error(`${what}: ${id} is listed by both ${where(first)} and ${where(n)}; each folder's list must be its own`);
            from.set(id, n);
          }
          out.push({ ...s, signin: n, config_dir: accountDir(home, n) });
        }
      });
      return out;
    };
    if (!lists.some(thenable)) return merge(lists);
    return Promise.all(lists.map((l, i) => Promise.resolve(l).catch((e) => { throw failed(names[i], e); }))).then(merge);
  };
}

/**
 * The Record's `stopSession(sessionId)` for a claim whose session never started (M9 lapseClaims, L72): the claim lapses,
 * and the card goes back to ready, only once this says yes, so the card can't run twice. `stopIn(ctx, sessionId)` ->
 * true when that folder has stopped the session or never ran it. Yes only when every set-up folder says true at once;
 * any other answer (false, null, undefined, a promise, an error) from any folder is a no, never read as "not there"
 * (L63): after a switch the old account is still asked. The Record calls this synchronously, so it must answer at once.
 */
export function stopEverywhere({ home, stopIn }) {
  return (sessionId) => {
    const folders = setUp(home);
    if (!folders.length) return false;
    for (const n of folders) {
      let r;
      try { r = stopIn(ctxOf(home, n), sessionId); } catch { return false; }
      if (r !== true) return false;
    }
    return true;
  };
}

/** The folder a listed session runs in, by its `signin` or its `config_dir`; null if it names neither. */
function folderOf(home, s) {
  return ACCOUNT_NAMES.find((n) => n === s?.signin) ?? ACCOUNT_NAMES.find((n) => accountDir(home, n) === s?.config_dir) ?? null;
}

/**
 * `stop(s)` -> `stopIn(s, ctx)` in the folder the session runs in. A session that names no folder (listed before this
 * wrapper) is tried in each folder until one stop works.
 */
export function stopInAccount({ home, stopIn }) {
  return async (s) => {
    const named = folderOf(home, s);
    if (named) return stopIn(s, ctxOf(home, named));
    let last = { ok: false, how: 'the session names no account, and no folder\'s stop worked' };
    for (const n of setUp(home)) {
      const r = await stopIn(s, ctxOf(home, n));
      if (r?.ok) return r;
      last = r ?? last;
    }
    return last;
  };
}

/**
 * The Leads over both folders. Each Lead's `stopSession()` stops it through its own folder (`stopSession(ctx)`), and its
 * `startLead(x)` starts the next one in the account in use (`startLead(x, ctx)`), so a Lead restarted after a switch
 * comes back on the account in use.
 */
export function acrossLeads({ home, listIn }) {
  const list = acrossAccounts({ home, listIn, idOf: (l) => l?.lead?.sessionId, what: 'Leads' });
  const wrap = (ls) => ls.map((l) => {
    const own = ctxOf(home, l.signin);
    return { ...l, stopSession: () => l.stopSession(own), startLead: startInUse({ home, startIn: (ctx, x) => l.startLead(x, ctx) }) };
  });
  return () => { const r = list(); return thenable(r) ? r.then(wrap) : wrap(r); };
}

/**
 * The Front Door, the one session that moves on a switch (L62): spec (d) needs it under the account in use in the phone
 * app. `aliveIn(ctx)` -> true | false | null (null = not known); `restartIn(ctx, x)` and `stopIn(ctx)` -> { ok, reason }.
 * - `frontDoorAlive()` is true only when it runs on the account in use. When it runs only on another account it says
 *   false, so the phone step restarts it. An alive check that fails or answers late is an error naming the folder,
 *   never a silent null (L63 m1): the phone step fails and Joe is told.
 * - `restartFrontDoor(x)` first stops the one still running on another account (one it can't tell about, or can't stop,
 *   refuses the restart, so two never run under the one fixed name), then starts it on the account in use.
 * - `strayFrontDoor()` (L63 m2): while it runs on the account in use, a Front Door left running on another account is
 *   stopped. -> { ok, stopped: [account], reason }; ok false (with the reason) when one can't be told about or stopped.
 */
export function frontDoorPorts({ home, aliveIn, restartIn, stopIn }) {
  const ask = (n) => {
    let r;
    try { r = aliveIn(ctxOf(home, n)); } catch (e) { throw new Error(`${where(n)}: whether the Front Door runs could not be checked (${why(e)})`); }
    if (thenable(r)) throw new Error(`${where(n)}: whether the Front Door runs could not be checked (the port must answer at once)`);
    return r;
  };
  const frontDoorAlive = () => {
    const u = inUse(home);
    if (!u.ctx) return null;
    const here = ask(u.ctx.signin);
    if (here === true) return true;
    if (here !== false) return null; // not known on the account in use: no restart, so two never run there
    const elsewhere = setUp(home).filter((n) => n !== u.ctx.signin).map(ask);
    return elsewhere.includes(true) || elsewhere.every((a) => a === false) ? false : null;
  };
  // Stops every Front Door running on an account other than the one in use. -> { ok, stopped, reason }.
  const stopElsewhere = async (u) => {
    const stopped = [];
    for (const n of setUp(home).filter((m) => m !== u.ctx.signin)) {
      let a;
      try { a = ask(n); } catch (e) { return { ok: false, stopped, reason: why(e) }; }
      if (a === false) continue;
      if (a !== true) return { ok: false, stopped, reason: `can't tell whether a Front Door runs on ${where(n)}` };
      let r;
      try { r = await stopIn(ctxOf(home, n)); } catch (e) { r = { ok: false, reason: why(e) }; }
      if (!r?.ok) return { ok: false, stopped, reason: `the Front Door still runs on ${where(n)} and did not stop (${r?.reason ?? 'no answer'})` };
      stopped.push(n);
    }
    return { ok: true, stopped };
  };
  const restartFrontDoor = async (x) => {
    const u = inUse(home);
    if (!u.ctx) return { ok: false, reason: u.reason };
    const s = await stopElsewhere(u);
    if (!s.ok) return { ok: false, reason: `${s.reason}; not restarted, so two don't run` };
    return tag(await restartIn(u.ctx, x), u.ctx);
  };
  const strayFrontDoor = async () => {
    const u = inUse(home);
    if (!u.ctx) return { ok: false, stopped: [], reason: u.reason };
    return stopElsewhere(u);
  };
  return { frontDoorAlive, restartFrontDoor, strayFrontDoor };
}

// The per-folder ports the wiring gives `accountPorts`, by kind. The README's contract row lists the same.
export const PER_FOLDER_PORTS = Object.freeze({
  start: ['launch', 'startReadonly', 'startMinibase'],
  list: ['sessions', 'board', 'outboxSessions', 'leads'],
  stop: ['stopGroup', 'stopSession'],
  frontDoor: ['frontDoorAlive', 'restartFrontDoor', 'stopFrontDoor'],
});

/**
 * Every session port of the tick, through the account layer. `inFolder(ctx)` -> that folder's own ports (the names in
 * PER_FOLDER_PORTS; a Lead from its `leads()` has `stopSession(ctx)` and `startLead(x, ctx)`). The wiring spreads the
 * result over its other ports: `{ ...others, ...accountPorts({ home, inFolder }) }`.
 */
export function accountPorts({ home, inFolder }) {
  const get = (ctx, name) => {
    const f = inFolder(ctx)?.[name];
    if (typeof f !== 'function') throw new Error(`${where(ctx.signin)} has no ${name} port`);
    return f;
  };
  const start = (name) => startInUse({ home, startIn: (ctx, ...a) => get(ctx, name)(...a) });
  const list = (name, idOf) => acrossAccounts({ home, listIn: (ctx) => get(ctx, name)(), idOf, what: name });
  return {
    launch: accountLaunch({ home, launch: (x) => get(x, 'launch')(x) }),
    startReadonly: start('startReadonly'),
    startMinibase: start('startMinibase'),
    sessions: list('sessions'),
    board: list('board'),
    outboxSessions: list('outboxSessions', (s) => s?.sessionId),
    leads: acrossLeads({ home, listIn: (ctx) => get(ctx, 'leads')() }),
    stopSession: stopEverywhere({ home, stopIn: (ctx, sid) => get(ctx, 'stopSession')(sid) }),
    stopGroup: stopInAccount({ home, stopIn: (s, ctx) => get(ctx, 'stopGroup')(s) }),
    ...frontDoorPorts({ home, aliveIn: (ctx) => get(ctx, 'frontDoorAlive')(), restartIn: (ctx, x) => get(ctx, 'restartFrontDoor')(x), stopIn: (ctx) => get(ctx, 'stopFrontDoor')() }),
  };
}
