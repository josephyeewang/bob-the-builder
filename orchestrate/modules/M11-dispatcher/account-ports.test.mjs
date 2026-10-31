// The account switch on the Dispatcher's side (R-1-89 (c), L61): every port that starts a session starts it on the
// account in use; every port that lists, checks or stops one covers both folders; a switch never moves a running
// worker, reviewer or Lead, and the Front Door follows the account in use. Throwaway homes and fake ports only:
// nothing here starts a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { ACCOUNTS, ACCOUNT_FILE, setupSecondFolder, useAccount } from '../M4-workshop/launcher/accounts.mjs';
import { PER_FOLDER_PORTS, accountLaunch, accountPorts, acrossAccounts, inAnyAccount, stopInAccount } from './account-ports.mjs';
import { dispatcherPass as dispatcherPass0 } from './pass.mjs';
import { timeLimits } from './merges.mjs';
import { phoneLinkStep, FACTS } from './phone-link.mjs';
import { USAGE_FACT } from './usage.mjs';
import { rulesWith, recWith, usageFact, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';

const dispatcherPass = (a) => withAlerts(a.rec, a.now, a.alert ?? (() => {}), (alert) => dispatcherPass0({ ...a, alert }));

// A home with both account folders set up the way the Bob script sets them up.
function home({ second = true } = {}) {
  const h = realpathSync(tempDir('m11-acct-'));
  for (const d of ['hooks', 'skills', 'agents', 'commands', 'plugins', 'projects']) mkdirSync(join(h, ACCOUNTS.a, d), { recursive: true });
  if (second) assert.equal(setupSecondFolder({ home: h }).ok, true);
  return { h, A: join(h, ACCOUNTS.a), B: join(h, ACCOUNTS.b) };
}

// Fake per-folder ports: each folder has its own sessions, reviewers, Leads and Front Door, and logs every call with
// the folder it was made in.
function folders(h, A, B) {
  const log = [];
  const st = {
    a: { sessions: [], reviewers: new Set(), leads: [], frontDoor: false, stopFrontDoorOk: true },
    b: { sessions: [], reviewers: new Set(), leads: [], frontDoor: false, stopFrontDoorOk: true },
  };
  let n = 0;
  const inFolder = (ctx) => {
    assert.equal(ctx.configDir, ctx.signin === 'a' ? A : B, 'ctx names the folder of its account');
    const s = st[ctx.signin];
    const did = (what, extra = {}) => { log.push([what, ctx.signin, ...Object.values(extra)]); };
    return {
      launch: async (x) => { did('launch', { card: x.card.id }); const id = `S-${++n}`; s.sessions.push({ id, card: x.card.id, product: x.product, kind: x.kind }); return { ok: true, sessionId: id, pgid: 100 + n, head: 'h'.repeat(40) }; },
      startReviewer: async (card) => { did('startReviewer', { card }); s.reviewers.add(card); return { ok: true }; },
      startReadonly: async (x) => { did('startReadonly', { lead: x.lead }); return { ok: true }; },
      startMinibase: async () => { did('startMinibase'); return { ok: true }; },
      sessions: () => s.sessions.map((x) => ({ ...x })),
      board: () => s.sessions.map((x) => ({ id: x.id, card: x.card, alive: true })),
      outboxSessions: () => s.sessions.map((x) => ({ sessionId: x.id, role: 'worker', card: x.card })),
      leads: () => s.leads.map((l) => ({
        lead: { sessionId: l }, size: 1, outboxNames: [], questionOpen: false,
        stopSession: async (own) => { did('stopSession', { lead: l, own: own?.signin }); s.leads = s.leads.filter((x) => x !== l); return { ok: true }; },
        startLead: async (x, c) => { did('startLead', { lead: l, in: c?.signin }); st[c.signin].leads.push(`${l}+`); return { ok: true }; },
      })),
      hasSession: (card) => s.sessions.some((x) => x.card === card),
      hasReviewer: (card) => s.reviewers.has(card),
      stopGroup: async (x) => { did('stopGroup', { id: x.id }); const i = s.sessions.findIndex((y) => y.id === x.id); if (i < 0) return { ok: false, how: 'not here' }; s.sessions.splice(i, 1); return { ok: true, how: 'SIGTERM' }; },
      frontDoorAlive: () => s.frontDoor,
      restartFrontDoor: async (x) => { did('restartFrontDoor', { handoff: x?.handoff ?? null }); s.frontDoor = true; return { ok: true }; },
      stopFrontDoor: async () => { did('stopFrontDoor'); if (!s.stopFrontDoorOk) return { ok: false, reason: 'still there' }; s.frontDoor = false; return { ok: true }; },
    };
  };
  return { log, st, inFolder, ports: accountPorts({ home: h, inFolder }) };
}

test('R-1-89 / L61: every per-folder port named in the contract is wrapped', () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  const all = Object.values(PER_FOLDER_PORTS).flat().filter((p) => p !== 'stopFrontDoor');
  for (const p of all) assert.equal(typeof f.ports[p], 'function', p);
  assert.deepEqual(Object.keys(f.ports).sort(), all.sort(), 'and nothing else');
});

test('R-1-89 / L61: every start port starts on the account in use, and says which', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  for (const [name, inUse, dir] of [['a', 'a', A], ['b', 'b', B]]) {
    assert.equal(useAccount({ home: h, name }).ok, true);
    f.log.length = 0;
    const r = await Promise.all([
      f.ports.launch({ card: { id: `C-${name}` }, kind: 'build', product: 'p1' }),
      f.ports.startReviewer(`C-${name}`),
      f.ports.startReadonly({ lead: 'L-1' }),
      f.ports.startMinibase(),
    ]);
    for (const x of r) assert.deepEqual([x.ok, x.signin, x.configDir], [true, inUse, dir]);
    assert.deepEqual(f.log.map(([what, folder]) => [what, folder]), ['launch', 'startReviewer', 'startReadonly', 'startMinibase'].map((w) => [w, inUse]));
  }
  // The launcher is handed the folder variable for b only (account a runs with it unset).
  const seen = [];
  const launch = accountLaunch({ home: h, launch: async (x) => { seen.push(x.env); return { ok: true }; } });
  await launch({ card: { id: 'C-1' } });
  assert.equal(useAccount({ home: h, name: 'a' }).ok, true);
  await launch({ card: { id: 'C-2' } });
  assert.deepEqual(seen, [{ CLAUDE_CONFIG_DIR: B }, {}]);
});

test('R-1-89: no account to start on -> no start port starts anything', async () => {
  const { h } = home({ second: false });
  const f = folders(h, join(h, ACCOUNTS.a), join(h, ACCOUNTS.b));
  assert.equal((await f.ports.startMinibase()).ok, true, 'no account file and no second folder: account a starts');
  for (const text of ['b\n', 'zz\n']) {
    writeFileSync(join(h, ACCOUNT_FILE), text);
    f.log.length = 0;
    for (const p of ['launch', 'startReviewer', 'startReadonly', 'startMinibase', 'restartFrontDoor']) {
      const r = await f.ports[p](p === 'launch' ? { card: { id: 'C-1' } } : 'C-1');
      assert.equal(r.ok, false, p);
      assert.match(r.reason, text === 'b\n' ? /^no account to start on: account b's folder ~\/\.claude-b is not set up/ : /^no account to start on: .*names neither a nor b/, p);
    }
    assert.deepEqual(f.log, [], 'no folder port is asked');
  }
});

test('R-1-89 / L61: the lists cover both folders after a switch; a session in both is an error; a failure names its folder', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  await f.ports.launch({ card: { id: 'C-1' }, kind: 'build', product: 'p1' });
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  await f.ports.launch({ card: { id: 'C-2' }, kind: 'build', product: 'p1' });
  f.st.a.leads.push('L-a');
  f.st.b.leads.push('L-b');
  for (const name of ['b', 'a']) {
    assert.equal(useAccount({ home: h, name }).ok, true);
    assert.deepEqual(f.ports.sessions().map((s) => [s.id, s.signin, s.config_dir]), [['S-1', 'a', A], ['S-2', 'b', B]]);
    assert.deepEqual(f.ports.board().map((s) => [s.id, s.signin]), [['S-1', 'a'], ['S-2', 'b']]);
    assert.deepEqual(f.ports.outboxSessions().map((s) => [s.sessionId, s.signin]), [['S-1', 'a'], ['S-2', 'b']]);
    assert.deepEqual(f.ports.leads().map((l) => [l.lead.sessionId, l.signin]), [['L-a', 'a'], ['L-b', 'b']]);
  }
  // The same session in both folders' lists: an error naming it (each folder's list must be its own).
  f.st.b.sessions.push({ ...f.st.a.sessions[0] });
  for (const p of ['sessions', 'board']) assert.throws(() => f.ports[p](), new RegExp(`^Error: ${p}: S-1 is listed by both account a \\(~/\\.claude\\) and account b \\(~/\\.claude-b\\)`));
  assert.throws(() => f.ports.outboxSessions(), /outboxSessions: S-1 is listed by both/);
  f.st.b.sessions.pop();
  f.st.b.leads.push('L-a');
  assert.throws(() => f.ports.leads(), /Leads: L-a is listed by both/);
  // A list that fails, at once or later, fails the whole list and names the folder.
  const broken = acrossAccounts({ home: h, listIn: (ctx) => { if (ctx.signin === 'b') throw new Error('no answer'); return []; } });
  assert.throws(() => broken(), /^Error: account b \(~\/\.claude-b\): its sessions could not be listed \(no answer\)$/);
  const late = acrossAccounts({ home: h, listIn: async (ctx) => { if (ctx.signin === 'b') throw new Error('timed out'); return []; } });
  await assert.rejects(late(), /^Error: account b \(~\/\.claude-b\): its sessions could not be listed \(timed out\)$/);
  const notList = acrossAccounts({ home: h, listIn: (ctx) => (ctx.signin === 'a' ? [] : 'oops') });
  assert.throws(() => notList(), /account b \(~\/\.claude-b\): its sessions could not be listed \(no list\)/);
  // With no second folder, only the first is asked.
  const one = home({ second: false });
  assert.deepEqual(acrossAccounts({ home: one.h, listIn: () => [{ id: 'S-9' }] })(), [{ id: 'S-9', signin: 'a', config_dir: one.A }]);
});

test('R-1-89 / L61: the check ports say yes for a session in either folder, whichever is in use', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  await f.ports.launch({ card: { id: 'C-1' }, kind: 'build', product: 'p1' });
  await f.ports.startReviewer('C-1');
  for (const name of ['b', 'a']) {
    assert.equal(useAccount({ home: h, name }).ok, true);
    assert.equal(f.ports.hasSession('C-1'), true, `after use ${name}`);
    assert.equal(f.ports.hasReviewer('C-1'), true, `after use ${name}`);
    assert.equal(f.ports.hasSession('C-9'), false);
    assert.equal(f.ports.hasReviewer('C-9'), false);
  }
  // Unknown in one folder and no in the other: unknown. A failing or late check names its folder.
  assert.equal(inAnyAccount({ home: h, checkIn: (ctx) => (ctx.signin === 'a' ? false : null) })('C-1'), null);
  assert.equal(inAnyAccount({ home: h, checkIn: (ctx) => (ctx.signin === 'a' ? null : true) })('C-1'), true);
  assert.throws(() => inAnyAccount({ home: h, checkIn: (ctx) => { if (ctx.signin === 'b') throw new Error('x'); return false; }, what: 'hasSession' })('C-1'), /^Error: account b \(~\/\.claude-b\): hasSession could not be checked \(x\)$/);
  assert.throws(() => inAnyAccount({ home: h, checkIn: async () => true })('C-1'), /must answer at once/);
});

test('R-1-89 / L61: after a switch, the time limits still see the old account\'s reviewer and start no second one', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  const rec = recWith([['card', 'C-1', { state: 'in_review', module: 'M-test', product: 'p1', tier: 2, files: ['src/a.js'], changed_at: iso(T0 - 600 * MIN) }]]);
  await f.ports.startReviewer('C-1');
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  f.log.length = 0;
  const done = await timeLimits({ rec, rules: rulesWith(), now: T0, b: { band: 'green' }, running: [], hasSession: f.ports.hasSession, gateAlive: () => true,
    hasReviewer: f.ports.hasReviewer, startReviewer: f.ports.startReviewer, alert: () => {} });
  assert.deepEqual(done, []);
  assert.deepEqual(f.log, [], 'no second reviewer started');
  assert.equal(rec.read('card', 'C-1').doc.state, 'in_review');
});

test('R-1-89 / L61: stops go through the session\'s own folder; a Lead restarted after a switch comes back on the account in use', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  await f.ports.launch({ card: { id: 'C-1' }, kind: 'build', product: 'p1' });
  f.st.a.leads.push('L-1');
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  f.log.length = 0;
  const [s] = f.ports.sessions();
  assert.deepEqual(await f.ports.stopGroup(s), { ok: true, how: 'SIGTERM' });
  const [l] = f.ports.leads();
  assert.equal((await l.stopSession()).ok, true);
  assert.equal((await l.startLead({ handoff: 'handoff-L-1' })).ok, true);
  assert.deepEqual(f.log, [['stopGroup', 'a', 'S-1'], ['stopSession', 'a', 'L-1', 'a'], ['startLead', 'a', 'L-1', 'b']]);
  assert.deepEqual([f.st.a.leads, f.st.b.leads], [[], ['L-1+']]);
  // stopInAccount on a session that names no folder: tried in each until one works.
  const tried = [];
  const pick = stopInAccount({ home: h, stopIn: async (x, ctx) => { tried.push(ctx.signin); return ctx.signin === 'b' ? { ok: true } : { ok: false, how: 'not here' }; } });
  assert.deepEqual(await pick({ id: 'S-3' }), { ok: true });
  assert.deepEqual(tried, ['a', 'b']);
  // By its folder when it names only that.
  tried.length = 0;
  await pick({ id: 'S-4', config_dir: A });
  assert.deepEqual(tried, ['a']);
});

test('R-1-89 / L61: the Front Door follows the account in use: after a switch it is stopped on the old one and restarted on the new', async () => {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  f.st.a.frontDoor = true;
  assert.equal(f.ports.frontDoorAlive(), true);
  assert.equal(useAccount({ home: h, name: 'b' }).ok, true);
  assert.equal(f.ports.frontDoorAlive(), false, 'running on the old account only counts as not running');
  // The phone step, as the tick runs it, restarts it with its handoff.
  const rec = recWith();
  for (const id of [FACTS.network, FACTS.reachable, FACTS.minibase]) rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: 0, doc: { value: true, observed_at: iso(T0) } });
  const alerts = [];
  f.log.length = 0;
  const done = await withAlerts(rec, T0, (t) => alerts.push(t), (alert) => phoneLinkStep({ rec, rules: rulesWith(), now: T0, send: async () => ({ outcome: 'sent' }),
    restartFrontDoor: f.ports.restartFrontDoor, startMinibase: f.ports.startMinibase, frontDoorAlive: f.ports.frontDoorAlive, lastHandoff: () => 'handoff-fd', alert }));
  assert.deepEqual(done, ['Front Door was missing; restarted']);
  assert.deepEqual(f.log, [['stopFrontDoor', 'a'], ['restartFrontDoor', 'b', 'handoff-fd']]);
  assert.deepEqual([f.st.a.frontDoor, f.st.b.frontDoor], [false, true]);
  assert.equal(f.ports.frontDoorAlive(), true);
  assert.deepEqual(alerts, []);
  // The old one won't stop: no second Front Door is started, and the reason says where it still runs.
  assert.equal(useAccount({ home: h, name: 'a' }).ok, true);
  f.st.b.stopFrontDoorOk = false;
  f.log.length = 0;
  const r = await f.ports.restartFrontDoor({ handoff: 'h' });
  assert.deepEqual(r, { ok: false, reason: 'the Front Door still runs on account b (~/.claude-b) and did not stop (still there)' });
  assert.deepEqual(f.log, [['stopFrontDoor', 'b']]);
  // Can't tell about the other account: not restarted either.
  const unsure = accountPorts({ home: h, inFolder: (ctx) => ({ ...f.inFolder(ctx), frontDoorAlive: () => (ctx.signin === 'b' ? null : false) }) });
  assert.match((await unsure.restartFrontDoor({})).reason, /^can't tell whether the Front Door still runs on account b/);
  assert.equal(unsure.frontDoorAlive(), null);
  // Not running anywhere: false, and the restart starts it on the account in use with nothing to stop.
  f.st.b.frontDoor = false;
  assert.equal(f.ports.frontDoorAlive(), false);
  f.log.length = 0;
  assert.equal((await f.ports.restartFrontDoor({ handoff: 'h' })).signin, 'a');
  assert.deepEqual(f.log, [['restartFrontDoor', 'a', 'h']]);
});

// The whole pass, as the tick runs it, with the ports wrapped.
function world() {
  const { h, A, B } = home();
  const f = folders(h, A, B);
  const ACCT = 'acct-a';
  const rec = recWith([['product', 'p1', { state: 'active' }],
    ...['C-1', 'C-2'].map((id) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN) }])]);
  rec.write({ actor: 'dispatcher', entity: 'fact', id: USAGE_FACT(ACCT), expectRev: 0, doc: usageFact({ week: 30, h5: 20, account: ACCT, now: T0 }) });
  const rules = rulesWith({}, { start_session: () => ({ decision: 'allow', reason: 'ok' }) });
  const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
  const pass = (min, only) => dispatcherPass({ rec, rules, now: T0 + min * MIN, account: ACCT, sessions: f.ports.sessions(), probe: () => idle,
    launch: async (x) => (only && x.card.id !== only ? { ok: false, reason: 'not this pass' } : f.ports.launch(x)),
    stopGroup: f.ports.stopGroup, saveWork: async () => ({ ok: true }), alert: () => {} });
  const setCard = (id, patch) => { const c = rec.read('card', id); rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: c.rev, doc: { ...c.doc, ...patch } }); };
  return { h, A, B, rec, f, pass, setCard };
}

test('R-1-89: every launch record names its folder; a switch leaves the running session alone, and stops still reach it', async () => {
  const w = world();
  await w.pass(0, 'C-1');
  const l1 = w.rec.read('launch', 'S-1').doc;
  assert.deepEqual([l1.signin, l1.config_dir, l1.card], ['a', w.A, 'C-1']);
  // Switch while S-1 runs: the next session starts on b; S-1 is not stopped, moved or re-recorded.
  assert.equal(useAccount({ home: w.h, name: 'b' }).ok, true);
  await w.pass(1);
  const l2 = w.rec.read('launch', 'S-2').doc;
  assert.deepEqual([l2.signin, l2.config_dir, l2.card], ['b', w.B, 'C-2']);
  assert.deepEqual(w.f.log.map(([what, folder, card]) => [what, folder, card]), [['launch', 'a', 'C-1'], ['launch', 'b', 'C-2']], 'a switch stops nothing');
  assert.deepEqual(w.f.st.a.sessions.map((s) => s.id), ['S-1'], 'S-1 still runs in the first folder');
  assert.deepEqual(w.rec.read('launch', 'S-1').doc, l1, 'its launch record is unchanged');
  assert.equal(w.rec.read('card', 'C-1').doc.state, 'running');
  // The old account's session is still stoppable: a cancel stops it through the first folder.
  w.setCard('C-1', { state: 'cancelled' });
  await w.pass(2);
  assert.deepEqual(w.f.log.at(-1), ['stopGroup', 'a', 'S-1']);
  assert.deepEqual(w.f.st.a.sessions, []);
  assert.deepEqual(w.f.st.b.sessions.map((s) => s.id), ['S-2']);
});
