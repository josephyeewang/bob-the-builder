import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { takePassLock } from './pass-lock.mjs';
import { RESTART_FACT, HANDOFF_NAME } from './lead-restart.mjs';
import { RULES_MISSING_FACT } from './pass.mjs';
import { tempDir } from '../../shared/test-tmp.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tick, runTick, signedInAccount, actOnDead, STEPS, STEP_DEADLINE_MS, ACCOUNT_FACT, LAST_PASS_FACT, STEP_ERROR_FACT } from './tick.mjs';
import { queueAlert, sendAlerts, ALERT_QUEUE_MAX, ALERT_QUEUE_FACT, ALERT_SEND_MS, ALERT_BUDGET_MS } from './alerts.mjs';
import { main, WATCHDOG_MARGIN_MS, RUN_DEADLINE_MS } from './main.mjs';
import { PR_FACT } from './merges.mjs';
import { OUTAGE_FACT } from './outage.mjs';
import { USAGE_FACT } from './usage.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, change, setClock, usageFact, undoEntries, filesOfCommits, T0, MIN, iso } from './fixtures.test-helper.mjs';

const ACCT = 'acct-a';
const HEAD = 'h'.repeat(40);
const idle = { size: { tokens: 1, turnEnded: false, openTools: [], compactions: 0 }, activity: { state: 'active' } };
const allow = { start_session: { decision: 'allow', reason: 'ok' } };
const card = (id, over = {}) => ['card', id, { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: [`src/${id}.js`], changed_at: iso(T0 - 10 * MIN), ...over }];
const account = (at = T0) => ['fact', ACCOUNT_FACT, { account: ACCT, observed_at: iso(at) }];
const usage = (at = T0) => ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: at })];

// A card ready for its merge request, as the Record holds one (L72): verified at its own head, its worker's launch, and
// Sensors' one PR reading at that head. The card itself has no pr, session or verdict field.
const headOf = (id) => id.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(40, 'e');
const workerLaunch = (id, head) => ['launch', `L-${id}`, { session_id: `S-${id}`, role: 'worker', card: id, head, rev: 1, launched_at: iso(T0 - 60 * MIN) }];
const prAt = (n, head, at = T0 - MIN) => ['fact', PR_FACT(n), { state: 'open', merged: false, head_sha: head, observed_at: iso(at) }];
const mergeReady = (id, n) => [card(id, { state: 'verified', head: headOf(id) }), workerLaunch(id, headOf(id)), prAt(n, headOf(id))];
// An undo card ready for its merge: M9's exact_reverse card (undoEntries), verified at its own head, on PR n.
const undoReady = (id, n) => [...undoEntries(id, { state: 'verified', head: headOf(id) }, { pr: 100 + n }), workerLaunch(id, headOf(id)), prAt(n, headOf(id))];
const requested = (rec, id) => rec.list('merge_request').find((q) => q.doc.card === id) ?? null;

/** A world with every port faked; `over` replaces ports. */
function world(entries = [], { over = {}, rules = rulesWith({}, allow) } = {}) {
  const rec = recWith([['product', 'p1', { state: 'active' }], ...entries]);
  const calls = { alerts: [], launched: [], reviewers: [], order: [] };
  const sessions = [];
  let n = 0;
  const empty = tempDir('m11-tick-');
  const ports = {
    alert: (t) => calls.alerts.push(typeof t === 'string' ? t : t.text),
    board: () => [], healthy: () => true, resume: () => false,
    outboxSessions: () => [], wait: async () => {}, startReadonly: async () => ({ ok: true }), replyToLead: async () => {},
    leads: () => [],
    sessions: () => [...sessions], probe: () => idle,
    // The launcher starts the session the claim names (L72), as M4's does.
    launch: async ({ card: c, kind, product, sessionId: id }) => { calls.launched.push(c.id); n += 1; sessions.push({ id, product, kind, card: c.id, pgid: 100 + n }); return { ok: true, sessionId: id, pid: 1000 + n, pidStart: `Mon Oct 29 12:0${n % 10}:00 2026`, pgid: 100 + n, head: HEAD }; },
    stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), hostLock: () => null, pauseLead: async () => {},
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => false, requestReview: ({ card }) => { calls.reviewers.push(card); return { ok: true, requestId: `Q-${++n}` }; },
    filesOf: filesOfCommits,
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
  assert.deepEqual(STEPS, ['stops', 'undo', 'undo-starts', 'outage', 'intake', 'leads', 'pass', 'limits', 'merges', 'phone', 'cleanup']);
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
  for (const s of STEPS.filter((x) => x !== 'outage')) assert.equal(r.steps[s].ok, true, s);
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
  // The limits step reads the reviewer port for a card in review past its time (a claim with no session is M9's lapse now).
  const w = world([account(), usage(), card('C-9', { state: 'in_review', changed_at: iso(T0 - 60 * MIN) })], {
    over: { board: thrower('board'), outboxSessions: thrower('outbox'), leads: thrower('leads'), sessions: thrower('sessions'), hasReviewer: thrower('hasReviewer') } });
  mkdirSync(join(w.ports.cleanup.copiesRoot, 'C-9'));
  w.ports.cleanup.mirrorFor = thrower('mirror');
  const r = await w.pass();
  // An unreadable session list fails the stops and the undo starts too: neither acts on a guess.
  const failed = ['stops', 'undo-starts', 'outage', 'intake', 'leads', 'pass', 'limits', 'cleanup'];
  for (const s of failed) assert.equal(r.steps[s].ok, false, s);
  for (const s of ['undo', 'merges', 'phone']) assert.equal(r.steps[s].ok, true, s);
  assert.deepEqual(w.calls.alerts.map((a) => a.match(/Dispatcher's ([\w-]+) step/)?.[1]), failed);
});

test('MIN-9: no signed-in account, or a stale one, starts nothing; the stops still run', async () => {
  for (const [label, facts] of [['missing', []], ['stale', [account(T0 - 16 * MIN)]], ['future', [account(T0 + 5 * MIN)]], ['not a name', [['fact', ACCOUNT_FACT, { account: 7, observed_at: iso(T0) }]]]]) {
    const w = world([usage(), card('C-1'), ...facts]);
    const r = await w.pass();
    assert.deepEqual(w.calls.launched, [], label);
    assert.ok(r.steps.pass.result.notes.some((x) => /nothing but undo cards starts: the signed-in account/.test(x)), label);
  }
  const fresh = world([usage(), card('C-1'), account(T0 - 14 * MIN)]);
  await fresh.pass();
  assert.deepEqual(fresh.calls.launched, ['C-1']);
  // the age limit is the rules' usage.stale_after_min
  assert.equal(signedInAccount({ rec: recWith([account(T0 - 20 * MIN)]), rules: rulesWith({ [K.staleAfterMin]: 30 }), now: T0 }).account, ACCT);
  assert.match(signedInAccount({ rec: recWith([account()]), rules: rulesWith({ [K.staleAfterMin]: undefined }), now: T0 }).reason, /stale_after_min/);
});

// The Record has no rerun_safe field (L72 census, a (b) for the lead): no card can be marked safe, so every dead
// session's card waits on Joe, never restarts. The restart path waits on M9 (todo below).
test('M10: outside an outage every dead session\'s card waits on Joe with a link; none restarts', async () => {
  const gone = (id, c) => ({ id, card: c, alive: false, ended: true, lastWriteAt: T0 - 10 * MIN });
  const live = (id, c) => ({ id, card: c, alive: true, ended: false, lastWriteAt: T0 - MIN });
  const w = world([account(), usage(), card('C-1', { state: 'running' }), card('C-2', { state: 'running' }), card('C-3', { state: 'running' })],
    { over: { board: () => [gone('S-1', 'C-1'), gone('S-2', 'C-2'), live('S-3', 'C-3'), live('S-4', 'C-3'), live('S-5', 'C-3')] } });
  const r = await w.pass();
  assert.deepEqual(r.steps.outage.result.acted, [['C-1', 'waiting on Joe'], ['C-2', 'waiting on Joe']]);
  assert.deepEqual(w.calls.launched, [], 'a dead card is never restarted without Joe');
  // L43(a), L38: each card moved is its own alert to Joe.
  for (const c of ['C-1', 'C-2']) assert.equal(w.calls.alerts.filter((a) => new RegExp(`card ${c}: its session stopped .* waits on you`).test(a)).length, 1, w.calls.alerts.join(' | '));
  const c2 = w.rec.read('card', 'C-2').doc;
  assert.deepEqual([c2.state, c2.wait.who, c2.wait.link], ['waiting', 'joe', 'card C-2']);
  assert.match(c2.wait.what, /dead_session/);
  // a card that already moved on is left alone
  const rec = recWith([card('C-5', { state: 'in_review' })]);
  const told = [];
  assert.deepEqual(actOnDead({ rec, now: T0, restart: ['S-5'], asks: ['C-5'], cards: { 'S-5': 'C-5' }, alert: (t) => told.push(t) }), []);
  assert.deepEqual(told, [], 'a card that moved on gets no alert');
  assert.equal(rec.read('card', 'C-5').doc.state, 'in_review');
});

test('M9: a session held through an outage is decided at the outage\'s end even though it left the board', async () => {
  const gone = (id, c) => ({ id, card: c, alive: false, ended: true, lastWriteAt: T0 - 10 * MIN });
  let board = [gone('S-1', 'C-1'), gone('S-2', 'C-2'), gone('S-3', 'C-3')];
  const w = world([account(), usage(), card('C-1', { state: 'running' }), card('C-2', { state: 'running' }), card('C-3', { state: 'running' })],
    { over: { board: () => board } });
  await w.pass();
  assert.equal(w.rec.read('fact', OUTAGE_FACT).doc.state, 'open');
  assert.deepEqual(['C-1', 'C-2', 'C-3'].map((c) => w.rec.read('card', c).doc.state), ['running', 'running', 'running'], 'nothing is decided in the outage');
  board = [];
  await w.pass(1);
  await w.pass(2);
  assert.equal(w.rec.read('fact', OUTAGE_FACT).doc.state, 'ended');
  assert.deepEqual(w.calls.launched, []);
  assert.deepEqual(['C-1', 'C-2', 'C-3'].map((c) => w.rec.read('card', c).doc.state), ['waiting', 'waiting', 'waiting']);
});
test.todo('M10: a dead card marked safe to re-run goes back to ready and starts in the same tick (needs M9 rerun_safe; a (b) for the lead)');

test('during an outage no reviewer starts and no merge is requested', async () => {
  const w = world([account(), usage(), ['fact', OUTAGE_FACT, { state: 'open', dead: [] }],
    card('R-1', { state: 'in_review', changed_at: iso(T0 - 60 * MIN) }),
    ...mergeReady('V-1', 7)],
  { over: { healthy: () => false } });
  const r = await w.pass();
  assert.deepEqual(w.calls.reviewers, []);
  assert.equal(r.steps.limits.result.find(([id]) => id === 'R-1')[1], 'reviewer held: outage');
  assert.equal(requested(w.rec, 'V-1'), null);
  // audit 0b-6 r2 MIN-5: an outage-held start is not a failed try, so a long outage does not hand the card to Joe
  assert.equal(w.rec.read('card', 'R-1').doc.attempts?.reviewer_starts ?? 0, 0);
  for (let i = 1; i <= 3; i += 1) await w.pass(i);
  assert.equal(w.rec.read('card', 'R-1').doc.state, 'in_review');
  assert.match(r.steps.merges.result.find(([id]) => id === 'V-1')[1], /held: outage/);
  // audit 0b-6 r2 MIN-6: no Lead step during an outage
  assert.match(r.steps.leads.result, /outage/);
});

test('the limits and merges steps fall back to "hold" when the main pass did not finish', async () => {
  const w = world([account(), usage(), card('R-1', { state: 'in_review', tier: 1, changed_at: iso(T0 - 60 * MIN) })],
    { over: { sessions: () => { throw new Error('no session list'); } } });
  const r = await w.pass();
  assert.equal(r.steps.pass.ok, false);
  assert.deepEqual(w.calls.reviewers, [], 'a review is a Tier-1 start held while usage is unknown');
  assert.match(r.steps.limits.result[0][1], /reviewer held/);
  // audit 0b-6 r2 MIN-4: a Tier-2 review and a merge request are held too, though "unknown" would let them through
  const v = world([account(), usage(), card('R-2', { state: 'in_review', tier: 2, changed_at: iso(T0 - 60 * MIN) }),
    ...mergeReady('V-1', 7)],
  { over: { sessions: () => { throw new Error('no session list'); } } });
  const r2 = await v.pass();
  assert.deepEqual(v.calls.reviewers, []);
  assert.match(r2.steps.limits.result[0][1], /reviewer held: the main pass did not finish/);
  assert.equal(requested(v.rec, 'V-1'), null);
  assert.equal(v.rec.read('card', 'R-2').doc.attempts?.reviewer_starts ?? 0, 0);
  // L31: an undo is never held by the budget: with no bands, and during an outage, its merge request is still made.
  for (const over of [{ sessions: () => { throw new Error('no session list'); } }, { healthy: () => false }]) {
    const u = world([account(), usage(), ...(over.healthy ? [['fact', OUTAGE_FACT, { state: 'open', dead: [] }]] : []),
      ...undoReady('U-1', 8),
      ...mergeReady('V-2', 9)], { over });
    const r3 = await u.pass();
    assert.notEqual(requested(u.rec, 'U-1'), null, Object.keys(over)[0]);
    assert.equal(requested(u.rec, 'V-2'), null);
    assert.match(r3.steps.merges.result.find(([id]) => id === 'V-2')[1], /merge request held/);
  }
});

test('MAT-1 end to end: ready -> started with a launch record -> reviewed -> one merge request, over several ticks', async () => {
  const w = world([account(), usage(), card('C-1')]);
  await w.pass(0);
  const launches = w.rec.list('launch').filter((l) => l.doc.card === 'C-1');
  assert.equal(launches.length, 1);
  const sid = launches[0].doc.session_id;
  assert.equal(sid, w.sessions[0].id, 'the launch names the session the claim named');
  assert.deepEqual([launches[0].doc.role, launches[0].doc.head], ['worker', HEAD]);
  // The worker hands in at its head, review passes and Sensors reads the PR, each as its own module would. (The
  // stand-in does not check the verdict for verified; the contract test runs this on the real Record.)
  setClock(w.rec, T0 + MIN);
  change(w.rec, 'card', 'C-1', { head: HEAD });
  change(w.rec, 'card', 'C-1', { state: 'in_review' });
  change(w.rec, 'card', 'C-1', { state: 'verified' });
  assert.equal(w.rec.write({ actor: 'sensors', entity: 'fact', id: PR_FACT(7), expectRev: 0, doc: { state: 'open', merged: false, head_sha: HEAD, observed_at: iso(T0 + 2 * MIN) } }).ok, true);
  w.sessions.length = 0;
  for (const m of [1, 2, 3]) {
    w.rec.write({ actor: 'dispatcher', entity: 'fact', id: ACCOUNT_FACT, expectRev: w.rec.read('fact', ACCOUNT_FACT).rev, doc: { account: ACCT, observed_at: iso(T0 + m * MIN) } });
    await w.pass(m);
  }
  const mr = requested(w.rec, 'C-1');
  assert.ok(mr, 'merge requested');
  assert.deepEqual([mr.doc.card, mr.doc.pr, mr.doc.session_id, mr.doc.head, mr.doc.rev], ['C-1', 7, sid, HEAD, w.rec.read('card', 'C-1').rev]);
  assert.equal(w.rec.list('merge_request').length, 1, 'one request, not one per tick');
  assert.deepEqual(w.calls.launched, ['C-1'], 'started once');
  assert.deepEqual(w.calls.alerts, []);
});

test('M16: two ticks started together: one runs, one exits with a diary line; the lock is released', async () => {
  const w = world([account(), usage(), card('C-1')]);
  const lockFile = join(tempDir('m11-lock-'), 'pass.lock');
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
  const dir = tempDir('m11-main-');
  const wiring = join(dir, 'wiring.mjs');
  const here = fileURLToPath(new URL('.', import.meta.url));
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
export const seen = [];
const rec = recWith();
export async function wire(config) {
  seen.push(config);
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: (t) => seen.push(t), board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
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

test('audit 0b-6 r2 MAT-1: `node main.mjs <config>` runs a tick as a script, also through a symlinked folder; with no config it exits 1', () => {
  const dir = tempDir('m11-entry-');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const link = join(dir, 'link');
  symlinkSync(here, link);
  const out = join(dir, 'ran.json');
  const wiring = join(dir, 'wiring.mjs');
  writeFileSync(wiring, `import { writeFileSync } from 'node:fs';
import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
import { LAST_PASS_FACT } from ${JSON.stringify(join(here, 'tick.mjs'))};
const rec = recWith();
process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(rec.read('fact', LAST_PASS_FACT)?.doc ?? null)));
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: () => {}, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
`);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile: join(dir, 'pass.lock') }));
  for (const script of [join(here, 'main.mjs'), join(link, 'main.mjs')]) {
    rmSync(out, { force: true });
    const r = spawnSync(process.execPath, [script, config], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(readFileSync(out, 'utf8'))?.at ?? '', /^\d{4}-/, `a tick ran via ${script === join(here, 'main.mjs') ? 'the real path' : 'the symlink'}`);
  }
  const bare = spawnSync(process.execPath, [join(link, 'main.mjs')], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: main\.mjs <config\.json>/);
});

test('audit 0b-6 r2 MAT-2: a Lead\'s read-only request goes through the start gate in the tick: red, the cap of 4, an outage and no signed-in account hold it; green starts it', async () => {
  const lead = (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'think-q1.md'), 'Is A safe?'); return [{ sessionId: 'L-1', role: 'lead', outbox: dir, uid: process.getuid(), product: 'p1' }]; };
  const root = tempDir('m11-ro-');
  const run = async (name, entries, over = {}, signedIn = true) => {
    const started = [];
    const w = world([...(signedIn ? [account()] : []), ...entries], { over: { outboxSessions: () => lead(join(root, name)), startReadonly: async (x) => { started.push(x.kind); return { ok: true }; }, ...over } });
    const r = await w.pass();
    return { started, fact: w.rec.read('fact', 'intake-applied-L-1-think-q1.md')?.doc, r };
  };
  const red = await run('red', [['fact', USAGE_FACT(ACCT), usageFact({ week: 90, h5: 20, account: ACCT, now: T0 })]]);
  assert.deepEqual(red.started, []);
  assert.match(red.fact.reason, /red band/);
  const four = Array.from({ length: 4 }, (_, i) => ({ id: `R-${i}`, product: 'p1', kind: 'readonly', lead: 'L-1' }));
  const capped = await run('cap', [usage()], { sessions: () => four });
  assert.deepEqual(capped.started, []);
  assert.match(capped.fact.reason, /already has 4 read-only sessions/);
  const out = await run('outage', [usage(), ['fact', OUTAGE_FACT, { id: 'o-1', state: 'open', started_at: iso(T0 - MIN), dead: [], board: 3, healthy_passes: 0 }]], { healthy: () => false });
  assert.deepEqual(out.started, []);
  assert.match(out.fact.reason, /outage/);
  const none = await run('no-account', [usage()], {}, false);
  assert.deepEqual(none.started, []);
  assert.match(none.fact.reason, /signed-in account is not known/);
  const ok = await run('green', [usage()]);
  assert.deepEqual(ok.started, ['think']);
  assert.equal(ok.fact.state, 'applied');
});

// ---- L27: the fail-open sweep ----

// `edit` may change or drop (null) any seed entry: the merge sweep takes away one input of a merge at a time.
const sweepWorld = (entries, rules, edit = (e) => e) => {
  const stops = [];
  const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 99 }];
  const w = world([account(), ...entries,
    card('X-1', { state: 'cancelled' }),
    ...mergeReady('V-1', 7),
    ...undoReady('U-1', 8),
    card('R-1', { state: 'in_review', changed_at: iso(T0 - 60 * MIN) })].map(edit).filter(Boolean),
  { rules, over: { sessions: () => running, stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; } } });
  return { ...w, stops };
};
const outcome = async (w) => {
  await w.pass();
  return { launched: w.calls.launched, reviewers: w.calls.reviewers, stops: w.stops,
    merges: ['V-1', 'U-1'].filter((id) => requested(w.rec, id)) };
};
const within = (got, base, what) => {
  for (const k of ['launched', 'reviewers', 'merges']) for (const x of got[k]) assert.ok(base[k].includes(x), `${what}: ${k} ${x} is more than with every value present`);
};

test('L27 sweep: with any one rules value missing, the tick does no more than with all present, and a cancel still stops', async () => {
  const { VALUES } = await import('./fixtures.test-helper.mjs');
  const base = await outcome(sweepWorld([usage(), card('C-1')], rulesWith({}, allow)));
  assert.deepEqual(base, { launched: ['C-1'], reviewers: ['R-1'], stops: ['S-X'], merges: ['V-1', 'U-1'] }, 'control');
  for (const key of Object.keys(VALUES)) {
    const got = await outcome(sweepWorld([usage(), card('C-1')], rulesWith({ [key]: undefined }, allow)));
    within(got, base, key);
    assert.deepEqual(got.stops, ['S-X'], `${key}: the cancel did not stop`);
  }
});

test('L27 sweep: a card missing any one field starts no more than the card with every field', async () => {
  // Usage unknown: Tier 2 starts, Tier 1 waits, so a field that decides the tier shows its effect.
  const unknown = ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: T0, observedAgoMin: 120 })];
  const full = card('C-1')[2];
  const base = await outcome(sweepWorld([unknown, card('C-1')], rulesWith({}, allow)));
  assert.deepEqual(base.launched, ['C-1'], 'control: a Tier-2 card starts while usage is unknown');
  for (const field of Object.keys(full).filter((f) => f !== 'module' && f !== 'state')) {
    const { [field]: _, ...rest } = full;
    const got = await outcome(sweepWorld([unknown, ['card', 'C-1', rest]], rulesWith({}, allow)));
    within(got, base, `card without ${field}`);
    if (field === 'tier' || field === 'product') assert.deepEqual(got.launched, [], `card without ${field} started`);
  }
  // A card with no file list runs alone: never next to another worker in the same pass.
  const { files: _f, ...noFiles } = full;
  for (const order of [[['card', 'C-1', noFiles], card('C-2')], [card('C-2'), ['card', 'C-1', noFiles]]]) {
    const got = await outcome(sweepWorld([usage(), ...order], rulesWith({}, allow)));
    assert.equal(got.launched.length, 1, JSON.stringify(got.launched));
  }
  // The cards waiting to merge: without any one input (the PR reading at its head, its worker's launch, its head, its
  // product or tier), no request beyond the control's; without the first three, none at all.
  const control = await outcome(sweepWorld([usage()], rulesWith({}, allow)));
  assert.deepEqual(control.merges, ['V-1', 'U-1'], 'control: both merges are requested');
  const isCard = (e, id) => e[0] === 'card' && e[1] === id;
  for (const [id, n] of [['V-1', 7], ['U-1', 8]]) {
    const without = {
      'the PR reading': (e) => (e[0] === 'fact' && e[1] === PR_FACT(n) ? null : e),
      'the worker launch': (e) => (e[0] === 'launch' && e[2].card === id ? null : e),
      head: (e) => { if (!isCard(e, id)) return e; const { head: _h, ...d } = e[2]; return [e[0], e[1], d]; },
      product: (e) => { if (!isCard(e, id)) return e; const { product: _p, ...d } = e[2]; return [e[0], e[1], d]; },
      tier: (e) => { if (!isCard(e, id)) return e; const { tier: _t, ...d } = e[2]; return [e[0], e[1], d]; },
    };
    for (const [what, edit] of Object.entries(without)) {
      const got = await outcome(sweepWorld([usage()], rulesWith({}, allow), edit));
      within(got, control, `${id} without ${what}`);
      if (['the PR reading', 'the worker launch', 'head'].includes(what)) assert.ok(!got.merges.includes(id), `${id} without ${what} was requested`);
    }
  }
});

// ---- audit 0b-6 round 3 ----

test('audit 0b-6 r3 MAT-2: a port that never answers fails its own step at the deadline; the later steps still run; one alert', async () => {
  const w = world([account(), usage(), card('C-1')], { over: { launch: () => new Promise(() => {}), stepDeadlineMs: 100 } });
  const r = await w.pass();
  assert.equal(r.steps.pass.ok, false);
  assert.match(r.steps.pass.error, /did not finish within 100 ms/);
  for (const s of STEPS.filter((x) => x !== 'pass')) assert.equal(r.steps[s].ok, true, s);
  assert.equal(w.calls.alerts.length, 1, w.calls.alerts.join(' | '));
  assert.match(w.calls.alerts[0], /pass step failed: it did not finish/);
  assert.equal(w.rec.read('fact', LAST_PASS_FACT).doc.steps.pass, 'failed');
});

test('audit 0b-6 r3 MAT-2: `node main.mjs` stuck on a port exits 2 at the run deadline, even with a timer left open, and the next start breaks the lock', () => {
  const dir = tempDir('m11-stuck-');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const wiring = join(dir, 'wiring.mjs');
  writeFileSync(wiring, `import { recWith, rulesWith, usageFact } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
import { ACCOUNT_FACT } from ${JSON.stringify(join(here, 'tick.mjs'))};
import { USAGE_FACT } from ${JSON.stringify(join(here, 'usage.mjs'))};
const now = Date.now();
const rec = recWith([['product', 'p1', { state: 'active' }], ['fact', ACCOUNT_FACT, { account: 'a', observed_at: new Date(now).toISOString() }],
  ['fact', USAGE_FACT('a'), usageFact({ week: 30, h5: 20, account: 'a', now })],
  ['card', 'C-1', { state: 'ready', module: 'M-test', product: 'p1', tier: 2, files: ['src/a.js'], changed_at: new Date(now - 600000).toISOString() }]]);
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith({}, { start_session: { decision: 'allow', reason: 'ok' } }), ports: { stepDeadlineMs: 600000, alert: (t) => process.stderr.write('ALERT ' + t + '\\n'), board: noop, healthy: () => true,
    outboxSessions: noop, wait: async () => {}, leads: noop, sessions: noop, probe: () => null,
    launch: () => new Promise(() => { setInterval(() => {}, 1000); }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
`);
  const lockFile = join(dir, 'pass.lock');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile, runDeadlineMs: 300 }));
  const r = spawnSync(process.execPath, [join(here, 'main.mjs'), config], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, 'the script did not exit by itself');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /did not finish within 300 ms/);
  assert.match(r.stderr, /ALERT a Dispatcher pass did not finish within 300 ms and was stopped/, 'Joe is told (L38)');
  assert.ok(JSON.parse(readFileSync(lockFile, 'utf8')).pid, 'the stuck run left its lock');
  const l = takePassLock(lockFile);
  assert.equal(l.ok, true, l.reason);
  l.release();
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ wiring, lockFile, runDeadlineMs: -1 }));
  assert.equal(spawnSync(process.execPath, [join(here, 'main.mjs'), join(dir, 'bad.json')], { encoding: 'utf8' }).status, 1);
});

test('audit 0b-6 r3 MAT-3 sweep: with any one rules value missing, either the tick does exactly what it does with all present, or one alert names the value; the undo merge is always requested', async () => {
  const { VALUES } = await import('./fixtures.test-helper.mjs');
  const told = (w, key) => w.calls.alerts.filter((a) => a.includes('have no value for') && a.includes(key));
  const ctl = sweepWorld([usage(), card('C-1')], rulesWith({}, allow));
  const base = await outcome(ctl);
  assert.deepEqual(ctl.calls.alerts, [], 'control: no alert');
  for (const key of Object.keys(VALUES)) {
    const w = sweepWorld([usage(), card('C-1')], rulesWith({ [key]: undefined }, allow));
    const got = await outcome(w);
    assert.ok(got.merges.includes('U-1'), `${key}: the undo merge was held`);
    const same = JSON.stringify(got) === JSON.stringify(base);
    assert.ok(same || told(w, key).length === 1, `${key}: did less (${JSON.stringify(got)}) with ${told(w, key).length} alerts naming it: ${w.calls.alerts.join(' | ')}`);
    const before = w.calls.alerts.length;
    await w.pass(1);
    assert.equal(w.calls.alerts.length, before, `${key}: alerted again on the next pass`);
  }
});

test('audit 0b-6 r3 MAT-3: a value only the gate reads is told once for the whole tick, though the pass, the limits and the merges all ask; cleared once it is back', async () => {
  const w = sweepWorld([usage(), card('C-1')], rulesWith({ [K.perState]: undefined }, allow));
  await w.pass();
  const named = w.calls.alerts.filter((a) => a.includes(K.perState));
  assert.equal(named.length, 1, w.calls.alerts.join(' | '));
  assert.equal(w.rec.read('fact', RULES_MISSING_FACT).doc.keys, K.perState);
  await w.pass(1, { rules: rulesWith({}, allow) });
  assert.equal(w.rec.read('fact', RULES_MISSING_FACT).doc.keys, null);
});

test('audit 0b-6 r3 MIN-1: a failing outage step still holds reviews and merges while the record says an outage is open', async () => {
  const open = ['fact', OUTAGE_FACT, { id: 'o-1', state: 'open', started_at: iso(T0 - MIN), dead: [], board: 3, healthy_passes: 0 }];
  const w = sweepWorld([usage(), open], rulesWith({}, allow));
  w.ports.board = () => { throw new Error('board unreadable'); };
  const got = await outcome(w);
  assert.deepEqual([got.reviewers, got.merges.filter((m) => m !== 'U-1')], [[], []]);
  assert.deepEqual(got.stops, ['S-X'], 'the cancel still stops');
});

// L31: the safety acts (a cancel, a red park, an undo start, an undo merge, the Lead's restart) are held
// by no band. One world per band; two ticks each (audit 0b-6 r3 MAT-6, with MAT-4's queued request).
test('audit 0b-6 r3 MAT-6 / MAT-4: in green, amber, red, unknown and with no account: a cancel stops, red parks, an undo starts and is merged, a large Lead with a queued request restarts', async () => {
  const bands = {
    green: [account(), usage()],
    amber: [account(), ['fact', USAGE_FACT(ACCT), usageFact({ week: 20, h5: 75, account: ACCT, now: T0 })]],
    red: [account(), ['fact', USAGE_FACT(ACCT), usageFact({ week: 90, h5: 20, account: ACCT, now: T0 })]],
    unknown: [account(), ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: T0, observedAgoMin: 120 })]],
    'no account': [usage()],
  };
  const root = tempDir('m11-l31-');
  for (const [band, facts] of Object.entries(bands)) {
    const outbox = join(root, band.replace(' ', '-'));
    mkdirSync(outbox);
    writeFileSync(join(outbox, 'think-q1.md'), 'Is A safe?');
    const sent = [];
    const starts = [];
    let endedAt = T0;
    const lead = { sessionId: 'L-1', product: 'p1' };
    const stops = [];
    const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }, { id: 'S-E', product: 'p1', kind: 'editing', card: 'E-1', pgid: 99 }];
    const w = world([...facts,
      card('X-1', { state: 'cancelled' }), card('E-1', { state: 'running' }),
      ...undoEntries('U-2'),
      ...undoReady('U-1', 8)],
    { over: {
      sessions: () => running,
      stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; },
      outboxSessions: () => [{ sessionId: 'L-1', role: 'lead', outbox, uid: process.getuid(), product: 'p1' }],
      leads: () => [{ lead, outboxNames: readdirSync(outbox), questionOpen: false,
        size: { tokens: 300_000, turnEnded: true, endedAt, openTools: [], compactions: 0 },
        send: async (t) => { sent.push(t); return { outcome: 'sent' }; },
        stopSession: async () => ({ ok: true }), startLead: async (x) => { starts.push(x); return { ok: true, sessionId: 'L-2' }; } }],
    } });
    const r1 = await w.pass(0);
    assert.ok(stops.includes('S-X'), `${band}: the cancel did not stop`);
    assert.equal(stops.includes('S-E'), band === 'red', `${band}: the red park`);
    assert.ok(w.calls.launched.includes('U-2'), `${band}: the undo card did not start (${JSON.stringify(r1.steps.pass.result?.refused)})`);
    assert.ok(requested(w.rec, 'U-1'), `${band}: the undo merge was not requested`);
    assert.deepEqual(r1.steps.leads.result, [['L-1', 'WRAP sent']], `${band}: ${JSON.stringify(r1.steps.leads.result)}`);
    assert.match(sent[0], /queued in your outbox do not carry over/);
    writeFileSync(join(outbox, HANDOFF_NAME('L-1')), 'the hand-off');
    endedAt = T0 + MIN;
    const r2 = await w.pass(2);
    assert.deepEqual(r2.steps.leads.result, [['L-1', 'restarted']], `${band}: ${JSON.stringify(r2.steps.leads.result)}`);
    assert.equal(w.rec.read('fact', RESTART_FACT('L-1')).doc.phase, 'done');
    assert.equal(starts.length, 1);
  }
});

test('audit 0b-6 r3 MAT-3: a value only the reviewer start asks for is told once over two ticks (the pass does not tell, or clear, it by itself)', async () => {
  const w = world([account(), usage(), card('C-1', { state: 'in_review', changed_at: iso(T0 - 30 * MIN) })], { rules: rulesWith({ [K.redRuns]: undefined }, allow) });
  await w.pass();
  await w.pass(1);
  assert.equal(w.calls.alerts.filter((a) => a.includes(K.redRuns)).length, 1, w.calls.alerts.join(' | '));
  assert.deepEqual(w.calls.reviewers, [], 'the reviewer start is held');
});

// L38 (3): no silent hold. Each failure point, planted alone, gives exactly one alert over two ticks, and
// one more a day later while it lasts. The facts are refreshed before the later tick so only the planted
// cause remains.
function l38Cases() {
  const red = (at) => ['fact', USAGE_FACT(ACCT), usageFact({ week: 90, h5: 20, account: ACCT, now: at })];
  const unread = (at) => ['fact', USAGE_FACT(ACCT), usageFact({ week: 30, h5: 20, account: ACCT, now: at, observedAgoMin: 120 })];
  const deny = { start_session: { decision: 'deny', reason: 'the product is paused' } };
  const cases = [
    ['account missing', (at) => [usage(at)], {}, /nothing new starts but undo cards: the signed-in account is not known/],
    ['account stale', (at) => [usage(at), account(at - 16 * MIN)], {}, /nothing new starts but undo cards: the signed-in account reading is stale/],
    ['band red', (at) => [account(at), red(at)], {}, /the usage band is red/],
    ['band unknown', (at) => [account(at), unread(at)], {}, /the usage band is unknown/],
    ['rules value missing', (at) => [account(at), usage(at)], { cards: [card('C-1')], rules: rulesWith({ [K.perState]: undefined }, allow) }, new RegExp(`have no value for ${K.perState.replace(/\./g, '\\.')}`)],
    // A cancel whose stop never answers: the stops step hangs on every tick.
    ['a step that hangs', (at) => [account(at), usage(at)], { cards: [card('X-1', { state: 'cancelled' })],
      over: { sessions: () => [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }], stopGroup: () => new Promise(() => {}), stepDeadlineMs: 50 } }, /stops step failed: it did not finish within 50 ms/],
    ['a step that throws', (at) => [account(at), usage(at)], { over: { board: () => { throw new Error('board unreadable'); } } }, /outage step failed: board unreadable/],
    ['an undo held', (at) => [account(at), usage(at)], { cards: undoEntries('U-9'), rules: rulesWith({}, deny) }, /your undo \(card U-9\) is waiting: rules: the product is paused/],
  ];
  return cases;
}

test('L38 sweep: each hold or failure is told exactly once over two ticks, and once more a day later', async () => {
  const H25 = 25 * 60;
  const cases = l38Cases();
  const ctl = world([account(), usage()]);
  await ctl.pass(0);
  await ctl.pass(1);
  assert.deepEqual(ctl.calls.alerts, [], 'control: nothing held, nothing told');
  for (const [label, facts, opt, told] of cases) {
    const w = world([...facts(T0), ...(opt.cards ?? [])], { over: opt.over ?? {}, ...(opt.rules ? { rules: opt.rules } : {}) });
    await w.pass(0);
    await w.pass(1);
    assert.equal(w.calls.alerts.length, 1, `${label}: ${w.calls.alerts.join(' | ')}`);
    assert.match(w.calls.alerts[0], told, label);
    // Each reading renewed by its own writer (Sensors' usage, the Dispatcher's account): change() picks the one allowed.
    for (const [entity, id, doc] of facts(T0 + H25 * MIN)) change(w.rec, entity, id, doc);
    await w.pass(H25);
    const later = w.calls.alerts.slice(1);
    assert.equal(later.filter((a) => told.test(a)).length, 1, `${label}, a day later: ${later.join(' | ')}`);
    // Usage unread for a day is its own, documented cause (parked work then waits on Joe), told once.
    const escalation = /usage has been unreadable for over a day/;
    const others = later.filter((a) => !told.test(a));
    assert.ok(others.length === 0 || (['account missing', 'account stale', 'band unknown'].includes(label) && others.length === 1 && escalation.test(others[0])), `${label}: ${others.join(' | ')}`);
  }
});

// Audit 0b-6 r5 MAT-2 sweep: every hold and failure, planted alone, with the alert port failing on the
// first tick (throwing, then rejecting) and working after: exactly one alert names it over three ticks.
// A cause marked told before its send went through would be silent for a day here.
test('r5 MAT-2 sweep: each hold or failure whose first alert fails is told exactly once once alerts work', async () => {
  for (const [how, bad] of [['throws', () => { throw new Error('no network'); }], ['rejects', () => Promise.reject(new Error('no network'))]]) {
    for (const [label, facts, opt, told] of l38Cases()) {
      let down = true;
      const sent = [];
      const w = world([...facts(T0), ...(opt.cards ?? [])], { over: { ...(opt.over ?? {}), alert: (t) => (down ? bad(t) : sent.push(t)) }, ...(opt.rules ? { rules: opt.rules } : {}) });
      await w.pass(0);
      await new Promise((ok) => setImmediate(ok));
      assert.deepEqual(sent, [], `${how}, ${label}: control, nothing got through while alerts were down`);
      down = false;
      await w.pass(1);
      await w.pass(2);
      assert.equal(sent.filter((a) => told.test(a)).length, 1, `${how}, ${label}: ${sent.join(' | ')}`);
    }
  }
});

// L40: a missing rules value holds an undo only when the undo needs it to stay safe. The undo's own check
// (the exact reverse of a merge in the record, with the same files) decides; either way Joe is told.
test('L40: with a cap value missing an exact-reverse undo starts and Joe is told the value; one the undo needs holds it; a wrong or unrecorded reverse holds', async () => {
  const runOne = async (rules, entries, over = {}) => {
    const w = world([account(), usage(), ...entries], { rules, over });
    const r = await w.pass(0);
    return { w, r };
  };
  // perState is a cap value: the exact reverse needs no cap to stay safe.
  {
    const { w, r } = await runOne(rulesWith({ [K.perState]: undefined }, allow), undoEntries('U-3'));
    assert.ok(w.calls.launched.includes('U-3'), JSON.stringify(r.steps['undo-starts'].result));
    assert.ok(w.calls.alerts.some((a) => a.includes(`have no value for ${K.perState}`)), w.calls.alerts.join(' | '));
  }
  // leadDailyCard decides whether two edits may run at once: without it the undo holds, and is told.
  {
    const { w } = await runOne(rulesWith({ [K.leadDailyCard]: undefined }, allow), undoEntries('U-4'));
    assert.ok(!w.calls.launched.includes('U-4'));
    assert.ok(w.calls.alerts.some((a) => a.includes(`have no value for ${K.leadDailyCard}`)), w.calls.alerts.join(' | '));
    assert.ok(w.calls.alerts.some((a) => /your undo \(card U-4\) is waiting/.test(a)), w.calls.alerts.join(' | '));
  }
  // A file list that is not the reversed commit's: held, and told.
  {
    const e = undoEntries('U-5');
    const [, id, doc] = e.find((x) => x[0] === 'card' && x[1] === 'U-5');
    const { w } = await runOne(rulesWith({}, allow), e.map((x) => (x[0] === 'card' && x[1] === id ? ['card', id, { ...doc, files: [...doc.files, 'src/other.js'] }] : x)));
    assert.ok(!w.calls.launched.includes('U-5'));
    assert.ok(w.calls.alerts.some((a) => /your undo \(card U-5\) is waiting: it is not an exact reverse: its file list does not match the reversed commit/.test(a)), w.calls.alerts.join(' | '));
  }
  // No merge in the record for it: held, and told.
  {
    const { w } = await runOne(rulesWith({}, allow), undoEntries('U-6').filter((x) => x[0] !== 'merge'));
    assert.ok(!w.calls.launched.includes('U-6'));
    assert.ok(w.calls.alerts.some((a) => /your undo \(card U-6\) is waiting: it is not an exact reverse: it is not the reverse of a merge in the record/.test(a)), w.calls.alerts.join(' | '));
  }
  // The commit's files cannot be read: held, and told.
  {
    const { w } = await runOne(rulesWith({}, allow), undoEntries('U-7'), { filesOf: () => { throw new Error('mirror unreadable'); } });
    assert.ok(!w.calls.launched.includes('U-7'));
    assert.ok(w.calls.alerts.some((a) => /your undo \(card U-7\) is waiting: .*files could not be read/.test(a)), w.calls.alerts.join(' | '));
  }
  // Control: every value present, the exact reverse starts with no alert.
  {
    const { w } = await runOne(rulesWith({}, allow), undoEntries('U-8'));
    assert.ok(w.calls.launched.includes('U-8'));
    assert.deepEqual(w.calls.alerts, []);
  }
});

test('L38: with the main pass failing (its session list unreadable), a cancel still stops and an undo card still starts, in their own steps', async () => {
  let calls = 0;
  const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }];
  const stops = [];
  // The first read (the stops step) answers; every later one throws.
  const w = world([account(), usage(), card('X-1', { state: 'cancelled' }), ...undoEntries('U-1')], { over: {
    sessions: () => { calls += 1; if (calls > 1) throw new Error('session list unreadable'); return running; },
    stopGroup: async (s) => { stops.push(s.id); return { ok: true, how: 'SIGTERM' }; } } });
  const r = await w.pass();
  assert.equal(r.steps.pass.ok, false, 'control: the main pass failed');
  assert.deepEqual(stops, ['S-X']);
  assert.deepEqual(r.steps['undo-starts'].result.started, ['U-1']);
  assert.ok(w.calls.launched.includes('U-1'));
});

test('L38: the account-age rule missing is told even when every step that reads the bands fails', async () => {
  const w = world([account(), usage()], { rules: rulesWith({ [K.staleAfterMin]: undefined }, allow), over: { sessions: () => { throw new Error('session list unreadable'); } } });
  const r = await w.pass();
  for (const s of ['stops', 'undo-starts', 'pass']) assert.equal(r.steps[s].ok, false, `control: ${s} failed`);
  assert.equal(w.calls.alerts.filter((a) => a.includes(`have no value for ${K.staleAfterMin}`)).length, 1, w.calls.alerts.join(' | '));
});

// Audit 0b-6 r4 MAT-2: the alert port that throws or rejects skips nothing.
test('r4 MAT-2: an alert that throws, or rejects, skips no step: a cancel that fails to stop, then the undo still starts', async () => {
  for (const [label, alert] of [['throws', () => { throw new Error('no network'); }], ['rejects', () => Promise.reject(new Error('no network'))]]) {
    const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }];
    const w = world([account(), usage(), card('X-1', { state: 'cancelled' }), ...undoEntries('U-1')], { over: {
      alert, sessions: () => running, stopGroup: async () => ({ ok: false, reason: 'EPERM' }), board: () => { throw new Error('board unreadable'); } } });
    const r = await w.pass();
    assert.deepEqual(Object.keys(r.steps), STEPS, label);
    for (const s of STEPS.filter((x) => x !== 'outage')) assert.equal(r.steps[s].ok, true, `${label}: ${s} ${r.steps[s].error ?? ''}`);
    assert.equal(r.steps.outage.ok, false, `${label}: control, the outage step failed and its alert failed too`);
    assert.ok(w.calls.launched.includes('U-1'), label);
    await new Promise((ok) => setImmediate(ok));
    assert.match(w.rec.read('fact', 'unsent-alerts')?.doc?.error ?? '', /no network/, label);
  }
});

// Audit 0b-6 r5 MAT-2: a cause is marked told before its alert goes out, so an alert that fails would
// silence that cause for a day. It is queued instead and sent again on the next pass.
test('r5 MAT-2: an alert that fails once is sent on the next pass, for a hold and for a failed stop', async () => {
  for (const [label, bad] of [['throws', () => { throw new Error('no network'); }], ['rejects', () => Promise.reject(new Error('no network'))]]) {
    let down = true;
    const sent = [];
    const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }];
    const w = world([usage(), card('X-1', { state: 'cancelled' })], { over: {
      alert: (t) => (down ? bad(t) : sent.push(t)), sessions: () => running, stopGroup: async () => ({ ok: false, reason: 'EPERM' }) } });
    await w.pass();
    await new Promise((ok) => setImmediate(ok));
    assert.deepEqual(sent, [], `${label}: control, nothing got through while alerts were down`);
    // Both are causes told through tellThen: not queued, and not marked told, so their own step tells again.
    assert.match(w.rec.read('fact', 'unsent-alerts')?.doc?.error ?? '', /no network/, label);
    assert.ok(!w.rec.read('fact', 'stop-S-X')?.doc?.told_at && !w.rec.read('fact', 'hold-account')?.doc?.told_at, `${label}: marked told although unsent`);
    down = false;
    await w.pass(1);
    assert.equal(sent.filter((t) => /could not be stopped/.test(t)).length, 1, `${label}: ${sent.join(' | ')}`);
    assert.equal(sent.filter((t) => /signed-in account/.test(t)).length, 1, `${label}: ${sent.join(' | ')}`);
    assert.deepEqual(w.rec.read('fact', 'unsent-alerts')?.doc?.entries, [], `${label}: the queue is empty once sent`);
  }
});

// Audit 0b-6 r7 M3: the cap counts only entries that waited through a failed send. A burst queued while
// sending works is all sent; once the port fails, the newest ALERT_QUEUE_MAX held entries stay.
test('r7 M3: a burst is all sent while the port works; only entries held by a failed send are capped', async () => {
  const rec = recWith([]);
  for (let i = 0; i < ALERT_QUEUE_MAX + 5; i += 1) queueAlert(rec, `t${i}`, { now: T0 });
  queueAlert(rec, 't10', { now: T0 });
  queueAlert(rec, 'stop A first', { now: T0, mark: { fact: 'stop-A', fields: { told_at: 'x' } } });
  queueAlert(rec, 'stop A again', { now: T0, mark: { fact: 'stop-A', fields: { told_at: 'y' } } });
  let d = rec.read('fact', ALERT_QUEUE_FACT).doc;
  let texts = d.entries.map((e) => e.text);
  assert.equal(texts.length, ALERT_QUEUE_MAX + 6, 'nothing dropped before a send failed');
  assert.equal(new Set(texts).size, texts.length);
  assert.ok(!texts.includes('stop A first') && texts.at(-1) === 'stop A again', texts.join(' | '));
  assert.equal(d.dropped ?? 0, 0);
  const got = [];
  const r = await sendAlerts(rec, (t) => got.push(t), T0, { sendMs: 100, budgetMs: 60_000 });
  assert.equal(r.sent, ALERT_QUEUE_MAX + 6);
  assert.ok(got.every((t) => !/could not be sent/.test(t)), got[0]);
  assert.equal(rec.read('fact', 'stop-A').doc.told_at, 'y', 'the mark of the copy delivered');
  // The port is down. Each failed send holds the one entry it tried (r8 MAT-2), so the cap starts dropping
  // only once more than ALERT_QUEUE_MAX entries have each failed; the oldest failed go first.
  for (let i = 0; i < ALERT_QUEUE_MAX + 6; i += 1) queueAlert(rec, `u${i}`, { now: T0 });
  await sendAlerts(rec, () => false, T0, { sendMs: 100 });
  d = rec.read('fact', ALERT_QUEUE_FACT).doc;
  assert.equal(d.entries.length, ALERT_QUEUE_MAX + 6, 'one failed send drops nothing');
  for (let i = 1; i < ALERT_QUEUE_MAX + 6; i += 1) await sendAlerts(rec, () => false, T0, { sendMs: 100 });
  d = rec.read('fact', ALERT_QUEUE_FACT).doc;
  texts = d.entries.map((e) => e.text);
  assert.equal(texts.length, ALERT_QUEUE_MAX);
  assert.equal(d.dropped, 6);
  assert.ok(d.entries.every((e) => e.held && e.tries === 1));
  assert.ok(!texts.includes('u5') && texts.includes('u6') && texts.includes('u55'), 'the oldest failed go: ' + texts.slice(0, 3).join(' | '));
  // A new entry queued while the port is down is not held yet, so it is never dropped before its first try.
  queueAlert(rec, 'fresh', { now: T0 });
  assert.equal(rec.read('fact', ALERT_QUEUE_FACT).doc.entries.length, ALERT_QUEUE_MAX + 1);
  const later = [];
  await sendAlerts(rec, (t) => later.push(t), T0, { sendMs: 100, budgetMs: 60_000 });
  assert.match(later[0], /6 older alerts could not be sent/);
  assert.ok(later.slice(1).every((t) => !/could not be sent/.test(t)), 'the count rides on one copy');
  assert.ok(later.includes('fresh'));
  assert.deepEqual(rec.read('fact', ALERT_QUEUE_FACT).doc.entries, []);
});

// L47: no safety step waits on a send. The alert port hangs for good: the failed stop is told, the undo
// still starts, the tick ends near the send deadline, and the port is first called after every stop and
// start. Once the port works, each cause is delivered once and only then marked told.
test('L47: a send that hangs delays no safety act and loses no alert', async () => {
  const order = [];
  let hang = true;
  const sent = [];
  const running = [{ id: 'S-X', product: 'p1', kind: 'editing', card: 'X-1', pgid: 98 }];
  const w = world([usage(), card('X-1', { state: 'cancelled' }), ...undoEntries('U-1')], { over: {
    alert: (t) => { order.push('alert'); return hang ? new Promise(() => {}) : sent.push(t); },
    sessions: () => running,
    stopGroup: async () => { order.push('stop'); return { ok: false, reason: 'EPERM' }; },
    launch: async ({ card: c }) => { order.push(`launch ${c.id}`); return { ok: true, sessionId: 'S-U', pgid: 200, head: HEAD }; },
    alertSendMs: 50, stepDeadlineMs: 5000 } });
  const t0 = Date.now();
  const r = await w.pass();
  assert.ok(Date.now() - t0 < 2000, `the tick took ${Date.now() - t0} ms`);
  for (const s of ['stops', 'undo', 'undo-starts']) assert.equal(r.steps[s].ok, true, `${s}: ${r.steps[s].error ?? ''}`);
  assert.ok(order.includes('launch U-1'), order.join(', '));
  assert.ok(order.lastIndexOf('stop') < order.indexOf('alert') && order.indexOf('launch U-1') < order.indexOf('alert'), order.join(', '));
  assert.equal(order.filter((x) => x === 'alert').length, 1, 'a hung send ends the round');
  assert.deepEqual(r.alerts, { sent: 0, failed: 1, left: w.rec.read('fact', 'unsent-alerts').doc.entries.length });
  assert.match(w.rec.read('fact', 'unsent-alerts').doc.error, /did not answer within 50 ms/);
  assert.ok(!w.rec.read('fact', 'stop-S-X')?.doc?.told_at, 'marked told although unsent');
  hang = false;
  await w.pass(1, { ports: { alertSendMs: 50 } });
  await w.pass(2, { ports: { alertSendMs: 50 } });
  assert.equal(sent.filter((x) => /S-X \(card X-1\) could not be stopped/.test(x)).length, 1, sent.join(' | '));
  assert.equal(sent.filter((x) => /signed-in account/.test(x)).length, 1, sent.join(' | '));
  assert.ok(w.rec.read('fact', 'stop-S-X').doc.told_at);
  assert.deepEqual(w.rec.read('fact', 'unsent-alerts').doc.entries, []);
});

// Audit 0b-6 r5 MAT-1: the watchdog starts before the wiring loads, so a wiring that never finishes
// (an import that waits forever, a wire() that never answers, a wire() that blocks the thread) still ends.
test('r5 MAT-1: `node main.mjs` with a wiring that never finishes is ended by the watchdog', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const [label, body] of [
    ['import waits', 'await new Promise(() => {}); export async function wire() { return {}; }'],
    ['wire() never answers', 'export function wire() { return new Promise(() => {}); }'],
    ['wire() blocks', 'export function wire() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return {}; }'],
  ]) {
    const dir = tempDir('m11-wiring-hang-');
    const wiring = join(dir, 'wiring.mjs');
    writeFileSync(wiring, `setInterval(() => {}, 1000);\n${body}\n`);
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ wiring, lockFile: join(dir, 'pass.lock'), runDeadlineMs: 200 }));
    const started = Date.now();
    const r = spawnSync(process.execPath, [join(here, 'main.mjs'), config], { encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL' });
    assert.ok(Date.now() - started < 30_000, `${label}: ended by the watchdog, not by the test's own limit`);
    assert.ok(r.stderr.includes(`the pass was blocked past ${200 + WATCHDOG_MARGIN_MS} ms; the watchdog ends it`), `${label}: ${r.status} ${r.signal} ${r.stderr}`);
  }
});

// Audit 0b-6 r4 MAT-3: a port that blocks the thread itself. No timer in the main thread can fire, so
// the watchdog thread ends the process; the next start breaks the lock and tells Joe.
test('r4 MAT-3: `node main.mjs` blocked inside a synchronous port is ended by the watchdog; the next pass tells Joe', async () => {
  const dir = tempDir('m11-blocked-');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const wiring = join(dir, 'wiring.mjs');
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
const rec = recWith([['product', 'p1', { state: 'active' }]]);
export async function wire() {
  const noop = () => [];
  // The session list blocks the thread for a minute: no promise or timer can cut it short.
  const block = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return []; };
  return { rec, rules: rulesWith(), ports: { alert: () => {}, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: block, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
`);
  const lockFile = join(dir, 'pass.lock');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile, runDeadlineMs: 200 }));
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(here, 'main.mjs'), config], { encoding: 'utf8', timeout: 40_000 });
  assert.equal(r.signal, 'SIGKILL', `${r.status} ${r.stderr}`);
  assert.ok(Date.now() - started < 30_000, 'ended by the watchdog, not by the port giving up after a minute');
  assert.ok(r.stderr.includes(`the pass was blocked past ${200 + WATCHDOG_MARGIN_MS} ms; the watchdog ends it`), r.stderr);
  assert.ok(JSON.parse(readFileSync(lockFile, 'utf8')).pid, 'the killed run left its lock');
  // The next start breaks the dead lock and tells Joe, once a day.
  const w = world([account(), usage()]);
  const n = await runTick({ lockFile, rec: w.rec, rules: rulesWith({}, allow), now: T0, ports: w.ports });
  assert.equal(n.ran, true);
  assert.equal(w.calls.alerts.filter((a) => /the last Dispatcher pass .* was stopped before it finished/.test(a)).length, 1, w.calls.alerts.join(' | '));
  // Control: a lock released normally is not told.
  assert.equal((await runTick({ lockFile, rec: w.rec, rules: rulesWith({}, allow), now: T0 + MIN, ports: w.ports })).ran, true);
  assert.equal(w.calls.alerts.filter((a) => /was stopped before it finished/.test(a)).length, 1);
});

test('r4 MAT-3: main() ends its watchdog when the pass finishes, so a normal run is never killed', async () => {
  const dir = tempDir('m11-dog-');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const wiring = join(dir, 'wiring.mjs');
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
const rec = recWith();
export async function wire() {
  const noop = () => [];
  return { rec, rules: rulesWith(), ports: { alert: () => {}, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: noop, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
`);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile: join(dir, 'pass.lock') }));
  // In this process: a watchdog left running would kill the test run itself 5.2 s after the start.
  assert.equal(await main([config], { now: T0, log: () => {}, watchdog: true, runDeadlineMs: 200 }), 0);
  await new Promise((ok) => setTimeout(ok, 6_000));
  assert.ok(true, 'still alive past the watchdog time');
});

// Audit 0b-6 r5 m4: a step error that changes only in a number is one cause; and the error is on record even
// while its alert cannot be sent (r5 MAT-2).
test('r5 m4: a step error that changes only in a number is told once; an untold error is still recorded', { timeout: 10_000 }, async () => {
  let n = 0;
  const w = world([account(), usage()], { over: { board: () => { throw new Error(`board unreadable (pid ${++n})`); } } });
  await w.pass(0);
  await w.pass(1);
  await w.pass(2);
  assert.equal(w.calls.alerts.filter((a) => /outage step failed: board unreadable/.test(a)).length, 1, w.calls.alerts.join(' | '));
  const down = world([account(), usage()], { over: { board: () => { throw new Error('board unreadable'); }, alert: () => { throw new Error('no network'); } } });
  await down.pass(0);
  const f = down.rec.read('fact', 'step-error-outage')?.doc;
  assert.equal(f?.error, 'board unreadable');
  assert.ok(!f?.told_at, 'not marked told');
});

// Audit 0b-6 r7 M1: a pass blocked inside a safety step, every time. The alert the next start queues (the
// lock it broke) still reaches the working port, because the tick's first send starts alongside the safety
// steps instead of after them.
test('r7 M1: a pass blocked every time still delivers the broken-lock alert to a working port', { timeout: 120_000 }, () => {
  const dir = tempDir('m11-r7m1-');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sent = join(dir, 'sent.txt');
  const wiring = join(dir, 'wiring.mjs');
  writeFileSync(wiring, `import { recWith, rulesWith } from ${JSON.stringify(join(here, 'fixtures.test-helper.mjs'))};
import { appendFileSync } from 'node:fs';
const rec = recWith([['product', 'p1', { state: 'active' }]]);
export async function wire() {
  const noop = () => [];
  const block = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return []; };
  return { rec, rules: rulesWith(), ports: { alert: async (t) => { appendFileSync(${JSON.stringify(sent)}, t + '\\n'); return true; }, board: noop, healthy: () => true, outboxSessions: noop, wait: async () => {}, leads: noop,
    sessions: block, probe: () => null, launch: async () => ({ ok: false }), stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }),
    hasSession: () => true, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), filesOf: noop,
    sendFrontDoor: async () => ({}), restartFrontDoor: async () => ({ ok: true }), startMinibase: async () => ({ ok: true }),
    cleanup: { copiesRoot: ${JSON.stringify(dir)}, sealRoot: ${JSON.stringify(dir)}, mirrorFor: () => null } } };
}
`);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ wiring, lockFile: join(dir, 'pass.lock'), runDeadlineMs: 200 }));
  for (let i = 0; i < 2; i += 1) {
    const r = spawnSync(process.execPath, [join(here, 'main.mjs'), config], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
  }
  let got = '';
  try { got = readFileSync(sent, 'utf8'); } catch { /* nothing sent */ }
  assert.match(got, /was stopped before it finished/, 'the broken-lock alert reached the working port');
});

// Audit 0b-6 r7 M2: a copy of an alert out while its cause clears marks nothing, so the next time the cause
// comes back it is told. Here the stops step fails while the port is down, then works (the port is back and
// the early send delivers the old copy alongside the step), then fails again within the day.
test('r7 M2: a step error that cleared while its alert was out is told again when it comes back', async () => {
  let broken = true;
  let down = true;
  const sent = [];
  const w = world([account(), usage()], { over: {
    sessions: () => { if (broken) throw new Error('no session list'); return []; },
    alert: async (t) => { if (down) throw new Error('no network'); sent.push(t); return true; } } });
  await w.pass(0);
  assert.equal(sent.length, 0);
  broken = false; down = false;
  await w.pass(1);
  assert.ok(!w.rec.read('fact', STEP_ERROR_FACT('stops'))?.doc?.told_cause, 'a cleared cause carries no told mark');
  const before = sent.filter((t) => /stops step failed/.test(t)).length;
  broken = true;
  await w.pass(2);
  assert.equal(sent.filter((t) => /stops step failed/.test(t)).length, before + 1, sent.join(' | '));
});

// Audit 0b-6 r7 m1: every step at its deadline, plus both sends at their budget, ends inside the run deadline,
// and the watchdog leaves the late send its time.
test('r7 m1: the run deadline holds every step and both sends; the watchdog margin holds the late send', () => {
  assert.ok(RUN_DEADLINE_MS >= STEPS.length * STEP_DEADLINE_MS + 2 * ALERT_BUDGET_MS, `${RUN_DEADLINE_MS}`);
  assert.ok(ALERT_BUDGET_MS >= ALERT_SEND_MS);
  assert.ok(WATCHDOG_MARGIN_MS > ALERT_SEND_MS, `${WATCHDOG_MARGIN_MS}`);
});

// Audit 0b-6 r8 MAT-2: a failed send holds only the entry it tried. One text the port always refuses, or one
// timeout, ahead of a burst of more than ALERT_QUEUE_MAX drops nothing while the port takes everything else.
test('r8 MAT-2: a refused text or one timeout ahead of a burst drops nothing while the port works', async () => {
  for (const how of ['refused', 'timeout']) {
    const rec = recWith([]);
    queueAlert(rec, 'bad', { now: T0 });
    for (let i = 0; i < 60; i += 1) queueAlert(rec, `b${i}`, { now: T0 });
    const got = [];
    let once = true;
    const port = (t) => {
      if (how === 'refused' ? t.startsWith('bad') : once) { once = false; return how === 'refused' ? false : new Promise(() => {}); }
      got.push(t); return true;
    };
    for (let pass = 0; pass < 4; pass += 1) await sendAlerts(rec, port, T0, { sendMs: 30, budgetMs: 60_000 });
    const d = rec.read('fact', ALERT_QUEUE_FACT).doc;
    assert.equal(d.dropped ?? 0, 0, how);
    assert.ok(got.every((t) => !/could not be sent/.test(t)), `${how}: ${got[0]}`);
    for (let i = 0; i < 60; i += 1) assert.ok(got.includes(`b${i}`), `${how}: b${i} lost`);
    if (how === 'refused') assert.deepEqual(d.entries.map((e) => e.text), ['bad']);
    else assert.ok(got.includes('bad'));
  }
});
