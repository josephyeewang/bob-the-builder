// The account switch's side of the Dispatcher (R-1-89 (c)). The wiring wraps three of the tick's ports with these:
//   launch:   every new session starts in the account named in use (`accounts.mjs use a|b`), read at the launch, and
//             the launch result says which folder it used, so the launch record names it;
//   sessions: (and any other port that lists background sessions) runs once per account folder and the lists are
//             merged, each session tagged with its folder, so after a switch the old account's sessions are still seen;
//   stop:     a session is stopped through the folder it runs in, not the one in use.
// A running session is never moved: a switch changes only which folder the next launch uses.
// No process is started here (only-send-safe.test.mjs); the wiring hands in the real ports.

import { ACCOUNT_NAMES, accountDir, accountEnv, accountInUse, isSetUp } from '../M4-workshop/launcher/accounts.mjs';

const ctxOf = (home, account) => ({ account, configDir: accountDir(home, account), env: accountEnv(home, account) });

/**
 * `launch(x)` -> the inner launch, given `{ ...x, account, configDir, env }`: `env` is the variables to add to the
 * session's environment (`{ CLAUDE_CONFIG_DIR }` for account b, none for account a: pass it as roleEnv's `extra`).
 * Refused, with nothing started, when the account in use can't be read.
 */
export function accountLaunch({ home, launch }) {
  return async (x) => {
    const use = accountInUse({ home });
    if (!use.account) return { ok: false, reason: `no account to start on: ${use.reason}` };
    const ctx = ctxOf(home, use.account);
    const r = await launch({ ...x, ...ctx });
    return r && typeof r === 'object' ? { ...r, account: ctx.account, configDir: ctx.configDir } : r;
  };
}

/**
 * A list port over every account folder that is set up, whichever is in use: `listIn(ctx)` lists one folder's
 * sessions. Each session gets `account` and `config_dir`. A folder whose list fails fails the whole list (the step
 * fails and Joe is told), so a session is never missed silently. Works for a list that answers at once or later.
 */
export function acrossAccounts({ home, listIn }) {
  return () => {
    const names = ACCOUNT_NAMES.filter((n) => isSetUp(home, n));
    const lists = names.map((n) => {
      try { return listIn(ctxOf(home, n)); } catch (e) { throw new Error(`account ${n}'s sessions could not be listed (${e?.message ?? e})`); }
    });
    const merge = (all) => {
      const seen = new Set();
      const out = [];
      all.forEach((list, i) => {
        if (!Array.isArray(list)) throw new Error(`account ${names[i]}'s sessions could not be listed (no list)`);
        for (const s of list) {
          if (s?.id !== undefined && seen.has(s.id)) continue;
          seen.add(s?.id);
          out.push({ ...s, account: names[i], config_dir: accountDir(home, names[i]) });
        }
      });
      return out;
    };
    return lists.some((l) => typeof l?.then === 'function') ? Promise.all(lists).then(merge) : merge(lists);
  };
}

/**
 * `stop(s)` -> `stopIn(s, ctx)` in the folder the session runs in. A session that names no account (listed before this
 * wrapper) is tried in each folder until one stop works.
 */
export function stopInAccount({ home, stopIn }) {
  return async (s) => {
    const named = ACCOUNT_NAMES.find((n) => n === s?.account) ?? ACCOUNT_NAMES.find((n) => accountDir(home, n) === s?.config_dir);
    if (named) return stopIn(s, ctxOf(home, named));
    let last = { ok: false, how: 'the session names no account, and no folder\'s stop worked' };
    for (const n of ACCOUNT_NAMES.filter((x) => isSetUp(home, x))) {
      const r = await stopIn(s, ctxOf(home, n));
      if (r?.ok) return r;
      last = r ?? last;
    }
    return last;
  };
}
