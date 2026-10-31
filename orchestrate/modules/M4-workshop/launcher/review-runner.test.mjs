// review-runner.test.mjs — lead call L65: the review runner checks every request itself, writes its own launch
// records, and is the only thing that starts a reviewer or auditor. Every outside effect is a fake; the folders are
// throwaway ones this test's user owns (standing in for the review user).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPass, readReviewStatus, needsRole, rolesFor, RETRY_MS, MAX_FAILED_STARTS, STATUS_STALE_MS, MAX_REQUEST_BYTES } from './review-runner.mjs';
import { runnerLaunchFor } from '../../M9-record/outbox.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const T0 = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;

function world(over = {}) {
  const base = tempDir('m4-runner-');
  const root = join(base, 'review');
  const outboxRoot = join(base, 'outbox');
  mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  mkdirSync(outboxRoot, { mode: 0o755 }); chmodSync(outboxRoot, 0o755);
  const clock = { t: T0 };
  const cards = new Map([['C-1', { state: 'in_review', head: HEAD, tier: 2 }], ['C-9', { state: 'in_review', head: HEAD, tier: 1 }]]);
  const heads = new Map([['C-1', HEAD], ['C-9', HEAD]]);
  const live = [];
  const starts = [];
  const stops = [];
  let n = 0;
  let pid = 1000;
  const ctx = {
    root, outboxRoot, uids: UIDS, reviewHome: join(base, 'review-home'),
    now: () => clock.t, ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: (c) => (cards.has(c) ? { ok: true, doc: cards.get(c) } : { ok: false }),
    currentHead: (c) => heads.get(c),
    sessions: async () => live.slice(),
    stop: async (s) => { stops.push(s); const i = live.findIndex((x) => x.pid === s.pid); if (i >= 0) live.splice(i, 1); },
    start: async (x) => { starts.push(x); const p = ++pid; live.push({ pid: p, sessionId: x.sessionId }); return { ok: true, pid: p }; },
    accountInUse: () => 'a',
    handedIn: () => false,
    ...over,
  };
  const requests = join(root, 'requests');
  let q = 0;
  const ask = (body = {}, name) => {
    const b = { card: 'C-1', head: HEAD, role: 'reviewer', request_id: `q-${++q}`, ...body };
    for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
    const p = join(requests, name ?? `${String(b.request_id).replace(/[^A-Za-z0-9-]/g, '') || 'x'}.json`);
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(b), { mode: 0o644 });
    return p;
  };
  const status = () => JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'));
  const end = (sid) => { const i = live.findIndex((x) => x.sessionId === sid); live.splice(i, 1); };
  return { base, root, outboxRoot, clock, cards, heads, live, starts, stops, ctx, ask, status, end, requests };
}
// The first pass makes the folders; nothing is asked yet.
async function ready(over) { const w = world(over); const r = await runnerPass(w.ctx); assert.equal(r.ok, true, r.error); return w; }
const refusedFor = (r, re) => assert.ok(r.refused.some((x) => re.test(x.reason)), `no refusal like ${re}: ${r.refused.map((x) => x.reason).join(' | ')}`);

test('L65: a good request starts one reviewer, with a session id and launch record of the runner\'s own', async () => {
  const w = await ready();
  // The folders: requests anyone may add to (sticky), launches only review writes.
  assert.equal(lstatSync(w.requests).mode & 0o7777, 0o1733);
  assert.equal(lstatSync(join(w.root, 'launches')).mode & 0o7777, 0o755);
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.started.map((s) => [s.card, s.role, s.session_id]), [['C-1', 'reviewer', 'S-1']]);
  assert.equal(w.starts.length, 1);
  const s = w.starts[0];
  assert.equal(s.sessionId, 'S-1');
  assert.equal(s.outbox, join(w.outboxRoot, 'reviewer', 'S-1'));
  assert.equal(lstatSync(s.outbox).mode & 0o777, 0o755);
  // The request is gone once read.
  assert.deepEqual(readdirSync(w.requests), []);
  // The launch record is the one M9 counts a verdict against.
  const rl = runnerLaunchFor({ root: join(w.root, 'launches'), uids: UIDS, role: 'reviewer', card: 'C-1', head: HEAD, sessionId: 'S-1' });
  assert.equal(rl.ok, true, rl.reason);
  assert.equal(rl.launch.request_id, 'q-1');
  assert.equal(rl.launch.signin, 'a');
  // The status says what runs, written now; the Dispatcher's read takes it.
  const st = readReviewStatus({ file: join(w.root, 'status.json'), now: T0, uid: ME });
  assert.deepEqual(st.running.map((x) => [x.card, x.head, x.role, x.session_id]), [['C-1', HEAD, 'reviewer', 'S-1']]);
  assert.equal(lstatSync(join(w.root, 'status.json')).mode & 0o777, 0o644);
  assert.equal(lstatSync(join(w.root, 'state.json')).mode & 0o777, 0o600);
});

test('L65 planted: a forged request is refused for each check, and nothing starts', async () => {
  const cases = [
    ['an old head (the card has moved on)', (w) => w.ask({ head: HEAD2 }), /names head bbbbbbb, but the card's head is aaaaaaa/],
    ['a head the Record says but git does not', (w) => { w.heads.set('C-1', HEAD2); w.ask(); }, /the card's branch is at bbbbbbb/],
    ['an unknown card', (w) => w.ask({ card: 'C-404' }), /card C-404 is not in the Record/],
    ['a wrong role', (w) => w.ask({ role: 'worker' }), /"worker" is not a review role/],
    ['a card not in review', (w) => { w.cards.set('C-1', { state: 'running', head: HEAD }); w.ask(); }, /does not need a reviewer \(it is running\)/],
    ['an auditor for a card that is not Tier 1', (w) => w.ask({ role: 'auditor' }), /does not need a auditor \(it is in_review, tier 2\)/],
    ['a request with an extra field', (w) => w.ask({ session_id: 'mine' }), /must hold exactly card, head, request_id, role/],
    ['a request that is not JSON', (w) => w.ask('{', 'bad.json'), /not JSON/],
    ['a request that is too big', (w) => w.ask({ card: 'C-1', request_id: 'big', role: 'reviewer' + ' '.repeat(MAX_REQUEST_BYTES) }), /too big/],
    ['a request that is a link', (w) => { writeFileSync(join(w.base, 'elsewhere.json'), JSON.stringify({ card: 'C-1', head: HEAD, role: 'reviewer', request_id: 'l' })); symlinkSync(join(w.base, 'elsewhere.json'), join(w.requests, 'l.json')); }, /is a link/],
    ['a request with an odd name', (w) => w.ask({}, 'not ok.json'), /file name/],
  ];
  for (const [what, plant, re] of cases) {
    const w = await ready();
    plant(w);
    const r = await runnerPass(w.ctx);
    assert.equal(w.starts.length, 0, what);
    refusedFor(r, re);
    assert.deepEqual(readdirSync(w.requests), [], `${what}: the request is removed`);
    assert.deepEqual(readdirSync(join(w.root, 'launches')), [], `${what}: no launch record`);
    assert.ok(w.status().refused.length >= 1, `${what}: the status shows the refusal`);
  }
});

test('L65: a duplicate is refused: the same request id, or a second start while one runs, or after one has run', async () => {
  const w = await ready();
  w.ask({ request_id: 'same' });
  await runnerPass(w.ctx);
  w.ask({ request_id: 'same' });
  refusedFor(await runnerPass(w.ctx), /request id same was seen before/);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /a reviewer is already running for card C-1/);
  // It ends having handed in a verdict: no second start for the same head.
  w.ctx.handedIn = () => true;
  w.end('S-1');
  w.ask();
  refusedFor(await runnerPass(w.ctx), /already started for card C-1 at aaaaaaa; one start per head/);
  assert.equal(w.starts.length, 1);
  // A new head is a new review.
  w.cards.set('C-1', { state: 'in_review', head: HEAD2, tier: 2 });
  w.heads.set('C-1', HEAD2);
  w.ask({ head: HEAD2 });
  assert.equal((await runnerPass(w.ctx)).started.length, 1);
});

test('L65: too many starts: a failed start waits 15 minutes, 3 tries in all, then Joe is told once', async () => {
  let tries = 0;
  const w = await ready({ start: async () => { tries += 1; return { ok: false, reason: 'claude would not start' }; } });
  w.ask();
  let r = await runnerPass(w.ctx);
  refusedFor(r, /could not be started: claude would not start/);
  assert.deepEqual(readdirSync(join(w.root, 'launches')), [], 'a failed start leaves no launch record');
  w.clock.t += 10 * MIN;
  w.ask();
  refusedFor(await runnerPass(w.ctx), /failed less than 15 minutes ago/);
  assert.equal(tries, 1);
  for (let i = 2; i <= MAX_FAILED_STARTS; i++) { w.clock.t += RETRY_MS; w.ask(); await runnerPass(w.ctx); }
  assert.equal(tries, MAX_FAILED_STARTS);
  w.clock.t += RETRY_MS;
  w.ask();
  r = await runnerPass(w.ctx);
  refusedFor(r, /3 starts of a reviewer for card C-1 at aaaaaaa failed; Joe is told/);
  assert.equal(tries, MAX_FAILED_STARTS);
  const told = w.status().alerts.filter((a) => /No reviewer could be started for card C-1/.test(a.text));
  assert.equal(told.length, 1, 'told once');
  w.clock.t += RETRY_MS; w.ask(); await runnerPass(w.ctx);
  assert.equal(w.status().alerts.filter((a) => /No reviewer could be started/.test(a.text)).length, 1, 'still once');
});

test('L65: a session that ends with no verdict counts as a failed try, and Joe is told', async () => {
  const w = await ready();
  w.ask();
  await runnerPass(w.ctx);
  w.end('S-1');
  const r = await runnerPass(w.ctx);
  assert.ok(r.alerts.some((a) => /reviewer for card C-1 at aaaaaaa ended without handing in a verdict/.test(a.text)));
  assert.deepEqual(w.status().running, []);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /failed less than 15 minutes ago/);
  w.clock.t += RETRY_MS;
  w.ask();
  assert.equal((await runnerPass(w.ctx)).started.length, 1);
});

test('L65 m-6: a Tier-1 card gets an auditor as well as a reviewer', async () => {
  assert.equal(needsRole({ state: 'in_review', tier: 1 }, 'auditor'), true);
  assert.equal(needsRole({ state: 'in_review', tier: 2 }, 'auditor'), false);
  assert.deepEqual(rolesFor({ state: 'in_review', tier: 1 }), ['reviewer', 'auditor']);
  assert.deepEqual(rolesFor({ state: 'in_review', tier: 3 }), ['reviewer']);
  assert.deepEqual(rolesFor({ state: 'verified', tier: 1 }), []);
  const w = await ready();
  w.ask({ card: 'C-9', role: 'reviewer' });
  w.ask({ card: 'C-9', role: 'auditor' });
  const r = await runnerPass(w.ctx);
  assert.deepEqual(r.started.map((s) => s.role).sort(), ['auditor', 'reviewer']);
  assert.equal(runnerLaunchFor({ root: join(w.root, 'launches'), uids: UIDS, role: 'auditor', card: 'C-9', head: HEAD, sessionId: r.started.find((s) => s.role === 'auditor').session_id }).ok, true);
});

test('L65 planted m-3: the runner starts nothing while the review user is an admin, or when that can\'t be checked', async () => {
  for (const isAdmin of [async () => true, async () => { throw new Error('dseditgroup failed'); }, async () => undefined]) {
    const w = await ready();
    w.ask();
    w.ctx.isAdmin = isAdmin;
    const r = await runnerPass(w.ctx);
    assert.equal(r.ok, false);
    assert.match(r.error, /review user is an admin/);
    assert.equal(w.starts.length, 0);
    assert.equal(w.status().ok, false);
    assert.ok(w.status().alerts.some((a) => /admin Mac user/.test(a.text)));
    // The request waits for a pass that may start it.
    assert.equal(readdirSync(w.requests).length, 1);
  }
});

test('L65 m-7: a review session the runner did not start is stopped, and Joe is told', async () => {
  const w = await ready();
  w.ask();
  await runnerPass(w.ctx);
  w.live.push({ pid: 77, sessionId: 'not-mine' });
  const r = await runnerPass(w.ctx);
  assert.deepEqual(w.stops.map((s) => s.pid), [77]);
  assert.ok(r.alerts.some((a) => /did not start was found \(process 77, session not-mine\) and stopped/.test(a.text)));
  // Its own session is left alone.
  assert.deepEqual(w.live.map((s) => s.sessionId), ['S-1']);
  // A stop that fails is said too.
  w.live.push({ pid: 78 });
  w.ctx.stop = async () => { throw new Error('no'); };
  assert.ok((await runnerPass(w.ctx)).alerts.some((a) => /process 78\) and could not be stopped/.test(a.text)));
});

test('L65 m-5: the session starts in review\'s own sign-in folder for the account in use', async () => {
  const w = await ready({ accountInUse: () => 'b' });
  w.ask();
  await runnerPass(w.ctx);
  const s = w.starts[0];
  assert.equal(s.signin, 'b');
  assert.equal(s.configDir, join(w.ctx.reviewHome, '.claude-b'));
  assert.deepEqual(s.env, { CLAUDE_CONFIG_DIR: join(w.ctx.reviewHome, '.claude-b') });
  const rec = JSON.parse(readFileSync(join(w.root, 'launches', 'S-1.json'), 'utf8'));
  assert.equal(rec.signin, 'b');
  assert.equal(rec.config_dir, join(w.ctx.reviewHome, '.claude-b'));
  // Account a is review's default folder.
  const a = await ready();
  a.ask();
  await runnerPass(a.ctx);
  assert.equal(a.starts[0].configDir, join(a.ctx.reviewHome, '.claude'));
  assert.deepEqual(a.starts[0].env, {});
  // An account that can't be read starts nothing.
  const x = await ready({ accountInUse: () => null });
  x.ask();
  refusedFor(await runnerPass(x.ctx), /the account in use could not be read/);
  assert.equal(x.starts.length, 0);
});

test('L65: a runner that is not the review user, or a folder that is not review\'s, writes nothing', async () => {
  const w = world({ ownUid: () => OTHER });
  let r = await runnerPass(w.ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /runs only as the review user/);
  assert.equal(existsSync(join(w.root, 'status.json')), false);
  // The review user said to be another uid: the folder (this user's) is not review's.
  const v = world({ uids: { ...UIDS, reviewer: OTHER + 1, auditor: OTHER + 1 }, ownUid: () => OTHER + 1 });
  r = await runnerPass(v.ctx);
  assert.match(r.error, /not owned by the review user/);
  assert.equal(existsSync(join(v.root, 'status.json')), false);
  // A role map that leaves a role out, or shares the review user.
  const { scout: _s, ...noScout } = UIDS;
  assert.match((await runnerPass(world({ uids: noScout }).ctx)).error, /leaves out scout/);
  assert.match((await runnerPass(world({ uids: { ...UIDS, worker: ME } }).ctx)).error, /shared with worker/);
  // A folder others can write.
  const g = world();
  chmodSync(g.root, 0o775);
  assert.match((await runnerPass(g.ctx)).error, /can be written by others/);
  // A requests folder with the wrong mode.
  const m = await ready();
  chmodSync(m.requests, 0o1777);
  assert.match((await runnerPass(m.ctx)).error, /mode 1777, not 1733/);
});

test('L65: a corrupt memory file starts nothing and is not written over', async () => {
  const w = await ready();
  writeFileSync(join(w.root, 'state.json'), '{', { mode: 0o600 });
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /state is not what the runner writes/);
  assert.equal(w.starts.length, 0);
  assert.equal(readFileSync(join(w.root, 'state.json'), 'utf8'), '{');
});

test('L65 planted: a status that is missing, stale, or writable by others is an error, never "no reviewer"', async () => {
  const w = await ready();
  const file = join(w.root, 'status.json');
  assert.deepEqual(readReviewStatus({ file, now: T0 + STATUS_STALE_MS, uid: ME }).running, []);
  assert.throws(() => readReviewStatus({ file, now: T0 + STATUS_STALE_MS + 1, uid: ME }), /4 minutes old|3 minutes old/);
  assert.throws(() => readReviewStatus({ file: join(w.root, 'nope.json'), now: T0, uid: ME }), /status is missing/);
  assert.throws(() => readReviewStatus({ file, now: T0, uid: OTHER }), /not owned by the review user/);
  chmodSync(file, 0o666);
  assert.throws(() => readReviewStatus({ file, now: T0, uid: ME }), /written by others/);
  chmodSync(file, 0o644);
  writeFileSync(join(w.base, 'x.json'), JSON.stringify({ running: [] }));
  assert.throws(() => readReviewStatus({ file: join(w.base, 'x.json'), now: T0, uid: ME }), /not what the runner writes/);
  // No uid to check the owner against is an error, never a skipped check.
  for (const uid of [undefined, null, '501', -1]) assert.throws(() => readReviewStatus({ file, now: T0, uid }), /uid is not known/, String(uid));
  // A status dated ahead of the clock does not stay fresh.
  assert.throws(() => readReviewStatus({ file, now: T0 - STATUS_STALE_MS - 1, uid: ME }), /dated in the future/);
});
