import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick, runTick, signedInAccount, actOnDead, STEPS, ACCOUNT_FACT, LAST_PASS_FACT, STEP_ERROR_FACT } from './tick.mjs';
import { main } from './main.mjs';
import { MERGE_REQUEST } from './merges.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { USAGE_FACT } from './usage.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, usageFact, T0, MIN, iso } from './fixtures.test-helper.mjs';

const ACCT = 'acct-a';
const HEAD = 'h'.repeat(40);
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const allow = { start_session: { decision: 'allow', reason: 'ok' } };
const card = (id, over = {}) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN), ...over }];
const account = (at = T0) => ['fact', ACCOUNT_FACT, { account: ACCT, observed_at: iso(at) }];
const usage = (at = T0) => ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: at })];

/** A world with every port faked; `over` replaces ports. */
function world(entries = [], { over = {}, rules = rulesWith({}, allow) } = {}) {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...entries]);
  const calls = { alerts: [], launched: [], reviewers: [], order: [] };
  const sessions = [];
  let n = 0;
  const empty = mkdtempSync(join(tmpdir(), 'm11-tick-'));
  const ports = {
    alert: (t) => calls.alerts.push(typeof t === 'string' ? t : t.text),
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [],
    sessions: () => [...sessions], probe: () => idle,
    launch: async ({ card: c, kind, product }) => { calls.launched.push(c.id); const id = `S-${++n}`; sessions.push({ id, product, kind, card: c.id, pgid: 100 + n }); return { ok: true, sessionId: id, pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, startReviewer: async (id) => { calls.reviewers.push(id); return { ok: true }; },
    filesOf: () => [],
    sendFrontDoor: async () => ({ outcome: 'sent' }), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    frontDoorAlive: () => null, frontDoorHandoff: () => null,
    cleanup: { copiesRoot: empty, sealRoot: empty, mirrorFor: () => null },
    ...over,
  };
  const pass = (min = 0, extra = {}) => tick({ rec, rules: extra.rules ?? rules, now: T0 + min * MIN, ports: { ...ports, ...extra.ports } });
  return { rec, calls, sessions, ports, pass };
}

test('MAT-1: one tick runs every step once, in the fixed order, and records the full pass', async () => {
  const w = world([account(), usage()]);
  const r = await w.pass();
  assert.deepEqual(Object.keys(r.steps), STEPS);
  assert.deepEqual(STEPS, ['outage', 'intake', 'leads', 'pass', 'limits', 'merges', 'undo', 'phone', 'cleanup']);
  for (const s of STEPS) assert.equal(r.steps[s].ok, true, `${s}: ${r.steps[s].error}`);
  const last = w.rec.read('fact', LAST_PASS_FACT).doc;
  assert.equal(last.at, iso(T0));
  assert.deepEqual(Object.values(last.steps), STEPS.map(() => 'ok'));
  assert.deepEqual(w.calls.alerts, []);
});

test('MAT-1: a failing step never stops the rest; one alert per distinct error; cleared when it works again', async () => {
  let boom = true;
  const w = world([account(), usage(), card('C-1')], { over: { board: () => { if (boom) throw new Error('board unreadable'); return []; } } });
  const r = await w.pass();
  assert.deepEqual([r.steps.outage.ok, r.steps.outage.error], [false, 'board unreadable']);
  for (const s of STEPS.slice(1)) assert.equal(r.steps[s].ok, true, s);
  assert.deepEqual(w.calls.launched, ['C-1'], 'the main pass still started work');
  assert.equal(w.calls.alerts.length, 1);
  assert.match(w.calls.alerts[0], /outage step failed: board unreadable/);
  assert.equal(w.rec.read('fact', LAST_PASS_FACT).doc.steps.outage, 'failed');
  await w.pass(1);
  assert.equal(w.calls.alerts.length, 1, 'the same error is not alerted again');
  boom = false;
  await w.pass(2);
  assert.equal(w.rec.read('fact', STEP_ERROR_FACT('outage')).doc.error, null);
  boom = true;
  await w.pass(3);
  assert.equal(w.calls.alerts.length, 2, 'a new failure after a clean pass alerts again');
});

test('MAT-1: every step is guarded, not only the first', async () => {
  const thrower = (what) => () => { throw new Error(`${what} broke`); };
  const w = world([account(), usage(), ['card', 'C-9', { state: 'claimed', module: 'M-test', changed_at: iso(T0 - 60 * MIN) }]], {
    over: { board: thrower('board'), outboxSessions: thrower('outbox'), leads: thrower('leads'), sessions: thrower('sessions'), hasSession: thrower('hasSession') } });
  mkdirSync(join(w.ports.cleanup.copiesRoot, 'C-9'));
  w.ports.cleanup.mirrorFor = thrower('mirror');
  const r = await w.pass();
  for (const s of ['outage', 'intake', 'leads', 'pass', 'limits', 'cleanup']) assert.equal(r.steps[s].ok, false, s);
  for (const s of ['merges', 'undo', 'phone']) assert.equal(r.steps[s].ok, true, s);
  assert.equal(w.calls.alerts.length, 6);
  assert.deepEqual(w.calls.alerts.map((a) => a.match(/Dispatcher's (\w+) step/)[1]), ['outage', 'intake', 'leads', 'pass', 'limits', 'cleanup']);
});

test('MIN-9: no signed-in account, or a stale one, starts nothing; the stops still run', async () => {
  for (const [label, facts] of [['missing', []], ['stale', [account(T0 - 16 * MIN)]], ['future', [account(T0 + 5 * MIN)]], ['not a name', [['fact', ACCOUNT_FACT, { account: 7, observed_at: iso(T0) }]]]]) {
    const w = world([usage(), card('C-1'), ...facts]);
    const r = await w.pass();
    assert.deepEqual(w.calls.launched, [], label);
    assert.ok(r.steps.pass.result.notes.some((x) => /nothing starts: the signed-in account/.test(x)), label);
  }
  const fresh = world([usage(), card('C-1'), account(T0 - 14 * MIN)]);
  await fresh.pass();
  assert.deepEqual(fresh.calls.launched, ['C-1']);
  // the age limit is the rules' usage.stale_after_min
  assert.equal(signedInAccount({ rec: recWith([account(T0 - 20 * MIN)]), rules: rulesWith({ [K.staleAfterMin]: 30 }), now: T0 }).account, ACCT);
  assert.match(signedInAccount({ rec: recWith([account()]), rules: rulesWith({ [K.staleAfterMin]: undefined }), now: T0 }).reason, /stale_after_min/);
});

test('M10: outside an outage a dead session\'s safe card goes back to ready and starts; an unsafe one waits on Joe with a link', async () => {
  const gone = (id, c) => ({ id, card: c, alive: false, ended: true, lastWriteAt: T0 - 10 * MIN });
  const live = (id, c) => ({ id, card: c, alive: true, ended: false, lastWriteAt: T0 - MIN });
  const w = world([account(), usage(), card('C-1', { state: 'running', rerun_safe: true }), card('C-2', { state: 'running' }), card('C-3', { state: 'running' })],
    { over: { board: () => [gone('S-1', 'C-1'), gone('S-2', 'C-2'), live('S-3', 'C-3'), live('S-4', 'C-3'), live('S-5', 'C-3')] } });
  const r = await w.pass();
  assert.deepEqual(r.steps.outage.result.acted, [['C-1', 'ready again'], ['C-2', 'waiting on Joe']]);
  assert.deepEqual(w.calls.launched, ['C-1'], 'the safe card started again in the same tick');
  const c2 = w.rec.read('card', 'C-2').doc;
  assert.deepEqual([c2.state, c2.waiting.who, c2.waiting.link], ['waiting', 'joe', 'card C-2']);
  assert.match(c2.waiting.what, /dead_session/);
  // a card that already moved on is left alone
  const rec = recWith([card('C-5', { state: 'in_review' })]);
  assert.deepEqual(actOnDead({ rec, now: T0, restart: ['S-5'], asks: ['C-5'], cards: { 'S-5': 'C-5' } }), []);
  assert.equal(rec.read('card', 'C-5').doc.state, 'in_review');
});

test('M9: a held session restarts at the outage\'s end even though it left the board', async () => {
  const gone = (id, c) => ({ id, card: c, alive: false, ended: true, lastWriteAt: T0 - 10 * MIN });
  let board = [gone('S-1', 'C-1'), gone('S-2', 'C-2')];
  const w = world([account(), usage(), card('C-1', { state: 'running', rerun_safe: true }), card('C-2', { state: 'running', rerun_safe: true })],
    { over: { board: () => board } });
  await w.pass();
  assert.equal(w.rec.read('fact', OUTAGE_FACT).doc.state, 'open');
  assert.deepEqual(w.calls.launched, []);
  board = [];
  await w.pass(1);
  await w.pass(2);
  assert.equal(w.rec.read('fact', OUTAGE_FACT).doc.state, 'ended');
  assert.deepEqual(w.calls.launched.sort(), ['C-1', 'C-2']);
});

test('during an outage no reviewer starts and no merge is requested', async () => {
  const w = world([account(), usage(), ['fact', OUTAGE_FACT, { state: 'open', dead: [] }],
    card('R-1', { state: 'in_review', changed_at: iso(T0 - 60 * MIN) }),
    card('V-1', { state: 'verified', pr: 7, session: 'S-0' }), ['verdict', 'V-1', { session_id: 'S-0', head: HEAD }]],
  { over: { healthy: () => false } });
  const r = await w.pass();
  assert.deepEqual(w.calls.reviewers, []);
  assert.equal(r.steps.limits.result.find(([id]) => id === 'R-1')[1], 'reviewer start failed');
  assert.equal(w.rec.read('merge_request', MERGE_REQUEST('V-1', HEAD)), null);
  // an outage-held reviewer start counts as a failed try, so a long outage hands the card to Joe
  assert.deepEqual(r.steps.merges.result, []);
});

test('the limits and merges steps fall back to "hold" when the main pass did not finish', async () => {
  const w = world([account(), usage(), card('R-1', { state: 'in_review', tier: 1, changed_at: iso(T0 - 60 * MIN) })],
    { over: { sessions: () => { throw new Error('no session list'); } } });
  const r = await w.pass();
  assert.equal(r.steps.pass.ok, false);
  assert.deepEqual(w.calls.reviewers, [], 'a review is a Tier-1 start held while usage is unknown');
  assert.match(r.steps.limits.result[0][1], /reviewer held/);
});

test('MAT-1 end to end: ready -> started with a launch record -> reviewed -> one merge request, over several ticks', async () => {
  const w = world([account(), usage(), card('C-1')]);
  await w.pass(0);
  const sid = w.rec.read('card', 'C-1').doc.session;
  assert.equal(sid, 'S-1');
  assert.equal(w.rec.read('launch', sid).doc.head, HEAD);
  // the worker hands in; review passes (written here as the other modules would)
  const cur = w.rec.read('card', 'C-1');
  w.rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: cur.rev, doc: { ...cur.doc, state: 'verified', pr: 7, head: HEAD, changed_at: iso(T0 + MIN) } });
  assert.equal(w.rec.write({ actor: 'dispatcher', entity: 'verdict', id: 'C-1', expectRev: 0, doc: { session_id: sid, head: HEAD, result: 'pass' } }).ok, true);
  w.sessions.length = 0;
  for (const m of [1, 2, 3]) {
    w.rec.write({ actor: 'dispatcher', entity: 'fact', id: ACCOUNT_FACT, expectRev: w.rec.read('fact', ACCOUNT_FACT).rev, doc: { account: ACCT, observed_at: iso(T0 + m * MIN) } });
    await w.pass(m);
  }
  const mr = w.rec.read('merge_request', MERGE_REQUEST('C-1', HEAD));
  assert.ok(mr, 'merge requested');
  assert.deepEqual([mr.doc.card, mr.doc.pr, mr.doc.session_id, mr.doc.head, mr.doc.rev], ['C-1', 7, 'S-1', HEAD, w.rec.read('card', 'C-1').rev]);
  assert.equal(w.rec.list('merge_request').length, 1, 'one request, not one per tick');
  assert.deepEqual(w.calls.launched, ['C-1'], 'started once');
  assert.deepEqual(w.calls.alerts, []);
});

test('M16: two ticks started together: one runs, one exits with a diary line; the lock is released', async () => {
  const w = world([account(), usage(), card('C-1')]);
  const lockFile = join(mkdtempSync(join(tmpdir(), 'm11-lock-')), 'pass.lock');
  let release;
  const slow = new Promise((r) => { release = r; });
  const launch = w.ports.launch;
  const ports = { ...w.ports, launch: async (x) => { await slow; return launch(x); } };
  const a = runTick({ lockFile, rec: w.rec, rules: rulesWith({}, allow), now: T0, ports });
  const b = await runTick({ lockFile, rec: w.rec, rules: rulesWith({}, allow), now: T0, ports });
  assert.equal(b.ran, false);
  assert.match(b.reason, /another pass runs/);
  assert.match(w.rec.read('fact', 'pass-lock-note').doc.text, /did not run/);
  release();
  assert.equal((await a).ran, true);
  assert.equal((await runTick({ lockFile, rec: w.rec, rules: rulesWith({}, allow), now: T0 + MIN, ports: w.ports })).ran, true);
});

test('main.mjs: runs one tick through a wiring module named in the config; a bad config or wiring exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm11-main-'));
  const wiring = join(dir, 'wiring.mjs');
  const here = new URL('.', import.meta.url).pathname;
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
export const seen = [];
const rec = recWith();
export async function wire(config) {
  seen.push(config);
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: (t) => seen.push(t), board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, startReviewer: async () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
export { rec };
`);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile: join(dir, 'pass.lock') }));
  const logs = [];
  assert.equal(await main([config], { now: T0, log: (s) => logs.push(s) }), 0);
  const mod = await import(wiring);
  assert.equal(mod.seen[0].wiring, wiring);
  assert.equal(mod.rec.read('fact', LAST_PASS_FACT).doc.at, iso(T0));
  assert.deepEqual(logs, []);
  // refusals: no argument, a relative path, a wiring with no wire()
  assert.equal(await main([], { log: (s) => logs.push(s) }), 1);
  const rel = join(dir, 'rel.json');
  writeFileSync(rel, JSON.stringify({ wiring: 'wiring.mjs', lockFile: join(dir, 'x.lock') }));
  assert.equal(await main([rel], { log: (s) => logs.push(s) }), 1);
  const bare = join(dir, 'bare.mjs');
  writeFileSync(bare, 'export const x = 1;\n');
  const cfg2 = join(dir, 'c2.json');
  writeFileSync(cfg2, JSON.stringify({ wiring: bare, lockFile: join(dir, 'y.lock') }));
  assert.equal(await main([cfg2], { log: (s) => logs.push(s) }), 1);
  assert.equal(logs.length, 3);
  assert.match(logs[1], /wiring must be an absolute path/);
  assert.match(logs[2], /no wire\(\)/);
});
