// The account switch on the Dispatcher's side (R-1-89 (c)): new sessions start in the named account's folder, the
// session list and stops cover both folders, and a switch never moves a running session. Throwaway homes and fake
// ports only: nothing here starts a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { ACCOUNTS, ACCOUNT_FILE, setupSecondFolder, useAccount } from '../M4-workshop/launcher/accounts.mjs';
import { accountLaunch, acrossAccounts, stopInAccount } from './account-ports.mjs';
import { dispatcherPass as dispatcherPass0 } from './pass.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, recWith, usageFact, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';

const dispatcherPass = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => dispatcherPass0({ ...a, alert }));

// A home with both account folders set up the way the Bob script sets them up.
function home({ second = true } = {}) {
  const h = realpathSync(tempDir('m11-acct-'));
  for (const d of ['hooks', 'skills', 'agents', 'plugins', 'projects']) mkdirSync(join(h, ACCOUNTS.a, d), { recursive: true });
  if (second) assert.equal(setupSecondFolder({ home: h }).ok, true);
  return { h, A: join(h, ACCOUNTS.a), B: join(h, ACCOUNTS.b) };
}

test('R-1-89: the launch port starts each new session in the folder of the account in use', async () => {
  const { h, A, B } = home();
  const seen = [];
  const launch = accountLaunch({ home: h, launch: async (x) => { seen.push(x); return { ok: true, sessionId: `S-${seen.length}` }; } });
  let r = await launch({ card: { id: 'C-1' }, kind: 'build', product: 'p1' });
  assert.deepEqual([r.account, r.configDir], ['a', A]);
  assert.deepEqual(seen[0].env, {}, 'account a runs with the folder variable unset, as today');
  assert.deepEqual([seen[0].account, seen[0].configDir, seen[0].card.id], ['a', A, 'C-1']);
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  r = await launch({ card: { id: 'C-2' }, kind: 'build', product: 'p1' });
  assert.deepEqual([r.account, r.configDir, r.sessionId], ['b', B, 'S-2']);
  assert.deepEqual(seen[1].env, { CLAUDE_CONFIG_DIR: B });
  // A refused launch passes through as it was.
  const no = accountLaunch({ home: h, launch: async () => ({ ok: false, reason: 'check 7' }) });
  assert.deepEqual(await no({ card: { id: 'C-3' } }), { ok: false, reason: 'check 7', account: 'b', configDir: B });
});

test('R-1-89: no account to start on -> nothing starts', async () => {
  const { h } = home({ second: false });
  let called = 0;
  const launch = accountLaunch({ home: h, launch: async () => { called += 1; return { ok: true }; } });
  assert.equal((await launch({ card: { id: 'C-1' } })).ok, true, 'no account file and no second folder: account a starts');
  // The file names b (written by hand, or b's folder removed since), and b's folder is not there.
  for (const text of ['b\n', 'zz\n']) {
    writeFileSync(join(h, ACCOUNT_FILE), text);
    called = 0;
    const r = await launch({ card: { id: 'C-1' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^no account to start on: /);
    assert.match(r.reason, text === 'b\n' ? /account b's folder ~\/\.claude-b is not set up/ : /names neither a nor b/);
    assert.equal(called, 0, 'the inner launch is never asked');
  }
});

test('R-1-89: the session list covers both folders, whichever is in use, and a failing folder fails the list', async () => {
  const { h, A, B } = home();
  const per = { [A]: [{ id: 'S-1', card: 'C-1' }], [B]: [{ id: 'S-2', card: 'C-2' }] };
  const asked = [];
  const sessions = acrossAccounts({ home: h, listIn: (ctx) => { asked.push(ctx.account); return per[ctx.configDir]; } });
  const want = [{ id: 'S-1', card: 'C-1', account: 'a', config_dir: A }, { id: 'S-2', card: 'C-2', account: 'b', config_dir: B }];
  assert.deepEqual(sessions(), want);
  for (const name of ['b', 'a']) {
    assert.equal(useAccount({ home: h, name }).ok, true);
    assert.deepEqual(sessions(), want, `after use ${name}, both folders' sessions are still seen`);
  }
  assert.deepEqual(asked, ['a', 'b', 'a', 'b', 'a', 'b']);
  // A list that answers later (a port that reads a file or asks a program).
  const later = acrossAccounts({ home: h, listIn: async (ctx) => per[ctx.configDir] });
  assert.deepEqual(await later(), want);
  // The same session in both lists (a shared view) is listed once, under the first folder.
  per[B].push({ id: 'S-1', card: 'C-1' });
  assert.deepEqual(sessions(), want);
  // A folder whose list fails: the whole list fails, naming the folder, so no session is missed silently.
  const broken = acrossAccounts({ home: h, listIn: (ctx) => { if (ctx.account === 'b') throw new Error('no answer'); return per[ctx.configDir]; } });
  assert.throws(() => broken(), /account b's sessions could not be listed \(no answer\)/);
  const notList = acrossAccounts({ home: h, listIn: (ctx) => (ctx.account === 'a' ? per[A] : 'oops') });
  assert.throws(() => notList(), /account b's sessions could not be listed \(no list\)/);
  // With no second folder, only the first is asked.
  const one = home({ second: false });
  assert.deepEqual(acrossAccounts({ home: one.h, listIn: () => [{ id: 'S-9' }] })(), [{ id: 'S-9', account: 'a', config_dir: one.A }]);
});

test('R-1-89: a session is stopped through the folder it runs in, not the one in use', async () => {
  const { h, A, B } = home();
  const stops = [];
  const stop = stopInAccount({ home: h, stopIn: async (s, ctx) => { stops.push([s.id, ctx.account, ctx.configDir, ctx.env]); return { ok: true, how: 'SIGTERM' }; } });
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  await stop({ id: 'S-1', account: 'a', config_dir: A });
  await stop({ id: 'S-2', config_dir: B });
  assert.deepEqual(stops, [['S-1', 'a', A, {}], ['S-2', 'b', B, { CLAUDE_CONFIG_DIR: B }]]);
  // A session that names no folder: each folder is tried until one stop works.
  stops.length = 0;
  const pick = stopInAccount({ home: h, stopIn: async (s, ctx) => { stops.push(ctx.account); return ctx.account === 'b' ? { ok: true, how: 'SIGTERM' } : { ok: false, how: 'not here' }; } });
  assert.deepEqual(await pick({ id: 'S-3' }), { ok: true, how: 'SIGTERM' });
  assert.deepEqual(stops, ['a', 'b']);
});

// The whole pass, as the tick runs it, with the three ports wrapped: one fake session list per folder.
function world() {
  const { h, A, B } = home();
  const ACCT = 'acct-a';
  const rec = recWith([['product', 'p1', { state: 'active' }],
    ...['C-1', 'C-2'].map((id) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN) }])]);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: T0 }) });
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  const per = { [A]: [], [B]: [] };
  const calls = { launched: [], stops: [] };
  let n = 0;
  const launch = accountLaunch({ home: h, launch: async (x) => {
    calls.launched.push([x.card.id, x.account, x.env]);
    const id = `S-${++n}`;
    per[x.configDir].push({ id, product: x.product, kind: x.kind, card: x.card.id, pgid: 100 + n });
    return { ok: true, sessionId: id, pgid: 100 + n, head: 'h'.repeat(40) };
  } });
  const sessions = acrossAccounts({ home: h, listIn: (ctx) => per[ctx.configDir].map((s) => ({ ...s })) });
  const stopGroup = stopInAccount({ home: h, stopIn: async (s, ctx) => {
    calls.stops.push([s.id, ctx.account]);
    const i = per[ctx.configDir].findIndex((x) => x.id === s.id);
    if (i < 0) return { ok: false, how: 'not in this folder' };
    per[ctx.configDir].splice(i, 1);
    return { ok: true, how: 'SIGTERM' };
  } });
  const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
  const pass = (min, only) => dispatcherPass({ rec, rules, now: T0 + min * MIN, account: ACCT, sessions: sessions(), probe: () => idle,
    launch: async (x) => (only && x.card.id !== only ? { ok: false, reason: 'not this pass' } : launch(x)),
    stopGroup, saveWork: async () => ({ ok: true }), alert: () => {} });
  const setCard = (id, patch) => { const c = rec.read('card', id); rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: c.rev, doc: { ...c.doc, ...patch } }); };
  return { h, A, B, rec, per, calls, pass, setCard, sessions };
}

test('R-1-89: every launch record names its folder; a switch leaves the running session alone, and stops still reach it', async () => {
  const w = world();
  await w.pass(0, 'C-1');
  assert.deepEqual(w.per[w.A].map((s) => s.id), ['S-1']);
  const l1 = w.rec.read('launch', 'S-1').doc;
  assert.deepEqual([l1.account, l1.config_dir, l1.card], ['a', w.A, 'C-1']);
  // Switch while S-1 runs: the next session starts on b; S-1 is not stopped, moved or re-recorded.
  assert.equal(useAccount({ home: w.h, name: 'b' }).ok, true);
  await w.pass(1);
  assert.deepEqual(w.calls.launched, [['C-1', 'a', {}], ['C-2', 'b', { CLAUDE_CONFIG_DIR: w.B }]]);
  const l2 = w.rec.read('launch', 'S-2').doc;
  assert.deepEqual([l2.account, l2.config_dir, l2.card], ['b', w.B, 'C-2']);
  assert.deepEqual(w.calls.stops, [], 'a switch stops nothing');
  assert.deepEqual(w.per[w.A].map((s) => s.id), ['S-1'], 'S-1 still runs in the first folder');
  assert.deepEqual(w.rec.read('launch', 'S-1').doc, l1, 'its launch record is unchanged');
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'running');
  // Both sessions are seen after the switch, each under its own folder.
  assert.deepEqual(w.sessions().map((s) => [s.id, s.account]), [['S-1', 'a'], ['S-2', 'b']]);
  // The old account's session is still stoppable: a cancel stops it through the first folder.
  w.setCard('C-1', { state: 'cancelled' });
  await w.pass(2);
  assert.deepEqual(w.calls.stops, [['S-1', 'a']]);
  assert.deepEqual(w.per[w.A], []);
  assert.deepEqual(w.per[w.B].map((s) => s.id), ['S-2']);
});
