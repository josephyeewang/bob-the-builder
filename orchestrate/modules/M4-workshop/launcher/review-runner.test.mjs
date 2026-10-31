// review-runner.test.mjs — lead call L65: the review runner checks every request itself, writes its own launch
// records, and is the only thing that starts a reviewer or auditor. Every outside effect is a fake; the folders are
// throwaway ones this test's user owns (standing in for the review user).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runnerPass, readReviewStatus, needsRole, rolesFor, RETRY_MS, INTAKE_WAIT_MS, SWEEP_AFTER_MS, MAX_FAILED_STARTS, STATUS_STALE_MS, MAX_REQUEST_BYTES, MAX_STARTS_PER_PASS, MAX_PENDING, CARD_ID, readRequest } from './review-runner.mjs';
import { headReviews, runnerEnded, runnerLaunchFor, runnerLaunches, sessionVerdict } from '../../M9-record/outbox.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME };
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const T0 = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;
const CLAUDE = '/pinned/claude';

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
    root, outboxRoot, uids: UIDS, reviewHome: join(base, 'review-home'), claudeBin: CLAUDE,
    // The command of a live process: a fake claude for each live session (with its session id), nothing for any other.
    processName: (p) => { const s = live.find((x) => x.pid === p); return s ? `${CLAUDE} --session-id ${s.sessionId ?? 'x'}` : null; },
    now: () => clock.t, ownUid: () => ME, newId: () => `S-${++n}`,
    isAdmin: async () => false,
    readCard: (c) => (cards.has(c) ? { ok: true, doc: cards.get(c) } : { ok: false }),
    currentHead: (c) => heads.get(c),
    sessions: async () => live.slice(),
    stop: async (s) => { stops.push(s); const i = live.findIndex((x) => x.pid === s.pid); if (i >= 0) live.splice(i, 1); },
    start: async (x) => { starts.push(x); const p = ++pid; live.push({ pid: p, sessionId: x.sessionId }); return { ok: true, pid: p }; },
    accountInUse: () => 'a',
    handedIn: () => ({ ok: false, none: true }),
    verdictTaken: () => ({ ok: true }),
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
  // The runner's ended record of a session, as the Merge Gate reads it (M9 `runnerEnded`).
  const ended = (sid, { role = 'reviewer', card = 'C-1', head = HEAD } = {}) => runnerEnded({ root: join(root, 'ended'), uids: UIDS, role, card, head, sessionId: sid });
  return { base, root, outboxRoot, clock, cards, heads, live, starts, stops, ctx, ask, status, end, ended, requests };
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

test('L66 starvation: a file whose name is not a request\'s is moved aside unread, every pass, with no cap', async () => {
  const w = await ready();
  // More junk names than the old 50-a-pass read, all sorting before the real request.
  for (let i = 0; i < 120; i++) writeFileSync(join(w.requests, `0 junk ${i}.json`), 'x', { mode: 0o644 });
  writeFileSync(join(w.requests, '!.json'), 'x', { mode: 0o644 });
  w.ask();
  const r = await runnerPass(w.ctx);
  refusedFor(r, /121 file\(s\) whose names are not a request's were moved aside to rejected\//);
  assert.deepEqual(r.started.map((s) => s.card), ['C-1'], 'the real request starts in the same pass');
  assert.deepEqual(readdirSync(w.requests), []);
  assert.equal(readdirSync(join(w.root, 'rejected')).length, 121);
  assert.equal(lstatSync(join(w.root, 'rejected')).mode & 0o7777, 0o700);
  // A rejected folder that is not review's alone stops the pass.
  chmodSync(join(w.root, 'rejected'), 0o755);
  assert.match((await runnerPass(w.ctx)).error, /rejected has mode 755, not 700/);
});

test('L66 starvation planted: only starts are capped, 50 a pass, oldest first by when the runner first saw each request', async () => {
  const w = await ready();
  const card = (i) => `C-${String(i).padStart(3, '0')}`;
  for (let i = 1; i <= 150; i++) { w.cards.set(card(i), { state: 'in_review', head: HEAD, tier: 2 }); w.heads.set(card(i), HEAD); }
  // A refused request is no start: these 60 are all read in the pass, uncounted.
  for (let i = 0; i < 60; i++) w.ask({ card: 'C-404', request_id: `bad-${i}` });
  for (let i = 1; i <= 100; i++) w.ask({ card: card(i), request_id: `z-${String(i).padStart(3, '0')}` });
  let r = await runnerPass(w.ctx);
  assert.equal(r.started.length, MAX_STARTS_PER_PASS);
  assert.equal(r.refused.filter((x) => /C-404 is not in the Record/.test(x.reason)).length, 60);
  assert.equal(readdirSync(w.requests).length, 50, 'the rest wait');
  // Newer requests whose names sort first wait behind the older ones.
  w.clock.t += MIN;
  for (let i = 101; i <= 150; i++) w.ask({ card: card(i), request_id: `a-${String(i).padStart(3, '0')}` });
  r = await runnerPass(w.ctx);
  assert.deepEqual(r.started.map((s) => s.card), Array.from({ length: 50 }, (_, j) => card(51 + j)));
  w.clock.t += MIN;
  r = await runnerPass(w.ctx);
  assert.deepEqual(r.started.map((s) => s.card), Array.from({ length: 50 }, (_, j) => card(101 + j)));
  assert.deepEqual(readdirSync(w.requests), []);
});

test('L66 starvation: more than 200 requests waiting is told to Joe once', async () => {
  const w = await ready();
  for (let i = 0; i <= MAX_PENDING; i++) w.ask({ card: 'C-404', request_id: `p-${i}` });
  let r = await runnerPass(w.ctx);
  assert.ok(r.alerts.some((a) => /201 review requests are waiting \(more than 200\)/.test(a.text)));
  for (let i = 0; i <= MAX_PENDING; i++) w.ask({ card: 'C-404', request_id: `p2-${i}` });
  r = await runnerPass(w.ctx);
  assert.equal(r.alerts.length, 0, 'told once while it lasts');
  r = await runnerPass(w.ctx);
  for (let i = 0; i <= MAX_PENDING; i++) w.ask({ card: 'C-404', request_id: `p3-${i}` });
  assert.ok((await runnerPass(w.ctx)).alerts.some((a) => /requests are waiting/.test(a.text)), 'told again once it came back');
});

test('L66: a card id with .. is refused, in a request and in the shared definition', () => {
  for (const id of ['a..b', '..', 'C-1/..', '...']) assert.equal(CARD_ID.test(id), false, id);
  for (const id of ['C-1', 'c.1', 'R-0b-05']) assert.equal(CARD_ID.test(id), true, id);
  const d = tempDir('m4-runner-');
  writeFileSync(join(d, 'q.json'), JSON.stringify({ card: 'a..b', head: HEAD, role: 'reviewer', request_id: 'q' }));
  assert.match(readRequest(d, 'q.json').reason, /card id is not a plain id/);
});

test('L68 planted: a verdict that can\'t be counted holds the head: no new review starts on it, Joe is told, and the session is marked ended', async () => {
  const w = await ready();
  // The real check (M9 sessionVerdict, the Merge Gate's own read), on the real outbox: a verdict for another head can't be counted.
  w.ctx.handedIn = (x) => sessionVerdict({ outboxRoot: w.outboxRoot, uids: UIDS, ...x });
  const verdict = (sid, head) => writeFileSync(join(w.outboxRoot, 'reviewer', sid, `verdict-${sid}.md`), `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 0, fields: { head, pass: true } })}\n`, { mode: 0o644 });
  w.ask();
  await runnerPass(w.ctx);
  verdict('S-1', HEAD2);
  w.end('S-1');
  let r = await runnerPass(w.ctx);
  assert.ok(r.alerts.some((a) => /reviewer for card C-1 at aaaaaaa handed in a verdict that can't be counted \(the verdict names head bbbbbbb, not aaaaaaa\)\. It counts as a failure, so this head can't pass; no new reviewer starts on it/.test(a.text)), r.alerts.map((a) => a.text).join(' | '));
  assert.equal(w.ended('S-1').ok, true, 'marked ended');
  assert.equal(w.ended('S-1').ended.handed_in, null);
  // The Merge Gate's read: the session's verdict can't be counted, so it counts as a failure there.
  const hr = headReviews({ launches: join(w.root, 'launches'), outboxRoot: w.outboxRoot, uids: UIDS, card: 'C-1', head: HEAD });
  assert.deepEqual(hr.sessions.map((x) => [x.session_id, Boolean(x.problem)]), [['S-1', true]]);
  // No new review on that head, however long it waits, and nothing more is told.
  w.clock.t += RETRY_MS;
  w.ask();
  r = await runnerPass(w.ctx);
  refusedFor(r, /already started for card C-1 at aaaaaaa; one start per head/);
  assert.equal(r.alerts.length, 0);
  assert.equal(w.starts.length, 1);
  // A new head is a new review. Two verdict files there can't be counted either, and hold that head too.
  w.cards.set('C-1', { state: 'in_review', head: HEAD2, tier: 2 });
  w.heads.set('C-1', HEAD2);
  w.ask({ head: HEAD2 });
  assert.deepEqual((await runnerPass(w.ctx)).started.map((x) => x.session_id), ['S-2']);
  verdict('S-2', HEAD2);
  writeFileSync(join(w.outboxRoot, 'reviewer', 'S-2', 'verdict-again.md'), readFileSync(join(w.outboxRoot, 'reviewer', 'S-2', 'verdict-S-2.md')));
  w.end('S-2');
  r = await runnerPass(w.ctx);
  assert.ok(r.alerts.some((a) => /more than one verdict file was left, so none counts\)\. It counts as a failure/.test(a.text)), r.alerts.map((a) => a.text).join(' | '));
  w.clock.t += RETRY_MS;
  w.ask({ head: HEAD2 });
  refusedFor(await runnerPass(w.ctx), /already started for card C-1 at bbbbbbb; one start per head/);
  assert.equal(w.starts.length, 2);
  // A verdict that can't even be read holds as well: it is never a failed start.
  const x = await ready({ handedIn: () => { throw new Error('the outbox could not be listed'); } });
  x.ask(); await runnerPass(x.ctx); x.end('S-1');
  r = await runnerPass(x.ctx);
  assert.ok(r.alerts.some((a) => /can't be counted \(its verdict could not be read \(the outbox could not be listed\)\)/.test(a.text)));
  x.clock.t += RETRY_MS; x.ask();
  refusedFor(await runnerPass(x.ctx), /one start per head/);
  assert.equal(x.starts.length, 1);
  // The port's answers by name.
  assert.equal(sessionVerdict({ outboxRoot: w.outboxRoot, uids: UIDS, role: 'reviewer', sessionId: 'S-1', card: 'C-9', head: HEAD2 }).reason, 'the verdict names card C-1, not C-9');
  mkdirSync(join(w.outboxRoot, 'reviewer', 'S-9'));
  assert.deepEqual(sessionVerdict({ outboxRoot: w.outboxRoot, uids: UIDS, role: 'reviewer', sessionId: 'S-9', card: 'C-1', head: HEAD }), { ok: false, none: true, reason: 'no verdict was handed in' });
});

test('L66 pid contract: a start counts only when its pid is claude\'s, and nothing but claude is ever stopped', async () => {
  // The start returns the launcher's pid (not claude's): the start fails, and nothing is counted as running.
  const w = await ready({ start: async () => ({ ok: true, pid: 4242 }) });
  w.ask();
  const r = await runnerPass(w.ctx);
  refusedFor(r, /the start gave process 4242, which is not claude/);
  assert.deepEqual(w.status().running, []);
  // A stray whose pid is now another program's is left alone, and Joe is told.
  const v = await ready();
  v.live.push({ pid: 88, sessionId: 'gone' });
  v.ctx.processName = (p) => (p === 88 ? '/usr/bin/vim notes.txt' : null);
  const r2 = await runnerPass(v.ctx);
  assert.deepEqual(v.stops, []);
  assert.ok(r2.alerts.some((a) => /process 88, session gone\) and not stopped, because the process is no longer claude/.test(a.text)));
  // A name that can't be read is not claude either.
  v.ctx.processName = () => { throw new Error('ps failed'); };
  v.live.push({ pid: 89 });
  await runnerPass(v.ctx);
  assert.deepEqual(v.stops, []);
});

test('L66 version stamp planted: the status carries the installed copy\'s commit, and the Dispatcher\'s read returns it', async () => {
  const w = await ready({ installedCommit: () => HEAD2 });
  await runnerPass(w.ctx);
  assert.equal(w.status().installed_commit, HEAD2);
  assert.equal(readReviewStatus({ file: join(w.root, 'status.json'), now: T0, uid: ME }).installed_commit, HEAD2);
  // None, or not a commit, or a throw: the status says null.
  for (const installedCommit of [() => null, () => 'main', () => { throw new Error('no stamp'); }]) {
    const x = await ready({ installedCommit });
    assert.equal(x.status().installed_commit, null);
    assert.equal(readReviewStatus({ file: join(x.root, 'status.json'), now: T0, uid: ME }).installed_commit, null);
  }
});

test('L66: the launch record\'s owner check, through a stat port: a record another user owns is refused', async () => {
  const w = await ready();
  w.ask();
  await runnerPass(w.ctx);
  const root = join(w.root, 'launches');
  const q = { root, uids: UIDS, role: 'reviewer', card: 'C-1', head: HEAD, sessionId: 'S-1' };
  assert.equal(runnerLaunchFor(q).ok, true);
  const otherOwner = (fd) => { const st = fstatSync(fd); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: OTHER }); };
  assert.match(runnerLaunchFor({ ...q, fstat: otherOwner }).reason, /the launch record is not owned by the review user for session S-1/);
  const all = runnerLaunches({ root, uids: UIDS, fstat: otherOwner });
  assert.deepEqual(all.launches, []);
  assert.match(all.refused[0].reason, /not owned by the review user/);
});

test('L68 planted: the card\'s revision moves between a verdict and its intake: nothing starts again, and Joe is told once the Record has had its time', async () => {
  const w = await ready();
  let rev = 4;
  w.ctx.readCard = (c) => (w.cards.has(c) ? { ok: true, doc: w.cards.get(c), rev } : { ok: false });
  w.ctx.handedIn = (x) => sessionVerdict({ outboxRoot: w.outboxRoot, uids: UIDS, ...x });
  let taken = { ok: false, reason: 'the Record holds no verdict of session S-1' };
  w.ctx.verdictTaken = () => taken;
  w.ask();
  await runnerPass(w.ctx);
  // The reviewer read the card at revision 4; the card moves on to 5 while it works. The verdict still counts (L68 (3)).
  writeFileSync(join(w.outboxRoot, 'reviewer', 'S-1', 'verdict-S-1.md'), `${JSON.stringify({ entity: 'verdict', card: 'C-1', expectRev: 4, fields: { head: HEAD, pass: true } })}\n`, { mode: 0o644 });
  rev = 5;
  w.end('S-1');
  let r = await runnerPass(w.ctx);
  assert.equal(r.alerts.length, 0, r.alerts.map((a) => a.text).join(' | '));
  assert.equal(w.ended('S-1').ended.handed_in, true);
  // Within the wait, nothing is told; after it, the Record not having taken it is told once. Nothing starts again.
  w.ask();
  r = await runnerPass(w.ctx);
  refusedFor(r, /already started for card C-1 at aaaaaaa; one start per head/);
  assert.equal(r.alerts.length, 0);
  w.clock.t += INTAKE_WAIT_MS;
  w.ask();
  r = await runnerPass(w.ctx);
  refusedFor(r, /one start per head/);
  assert.ok(r.alerts.some((a) => /reviewer for card C-1 at aaaaaaa handed in a verdict the Record has not taken \(the Record holds no verdict of session S-1\)\. Nothing starts again/.test(a.text)), r.alerts.map((a) => a.text).join(' | '));
  w.clock.t += RETRY_MS;
  w.ask();
  r = await runnerPass(w.ctx);
  refusedFor(r, /one start per head/);
  assert.equal(r.alerts.length, 0, 'told once');
  // A Record that can't be read is told the same way, and starts nothing either.
  w.ctx.verdictTaken = () => { throw new Error('the Record is not its owner\'s alone'); };
  for (let i = 0; i < MAX_FAILED_STARTS + 1; i++) { w.clock.t += INTAKE_WAIT_MS; w.ask(); refusedFor(await runnerPass(w.ctx), /one start per head/); }
  assert.equal(w.starts.length, 1);
  // The control: a Record that took the verdict tells nothing.
  const x = await ready({ handedIn: () => ({ ok: true, verdict: {} }), verdictTaken: () => ({ ok: true }) });
  x.ask(); await runnerPass(x.ctx); x.end('S-1'); await runnerPass(x.ctx);
  x.clock.t += INTAKE_WAIT_MS; x.ask();
  r = await runnerPass(x.ctx);
  refusedFor(r, /one start per head/);
  assert.equal(r.alerts.length, 0);
});

test('L68: every session the runner launched is marked ended: when it ends, or by the sweep once it is lost track of', async () => {
  // Ended with no verdict: marked, handed_in false, and its head may be tried again (the record gives it no say).
  const w = await ready();
  w.ask(); await runnerPass(w.ctx);
  assert.equal(w.ended('S-1').none, true, 'not marked while it runs');
  w.end('S-1');
  await runnerPass(w.ctx);
  assert.equal(w.ended('S-1').ended.handed_in, false);
  assert.equal(w.ended('S-1').ended.how, 'ended');
  assert.equal(lstatSync(join(w.root, 'ended')).mode & 0o7777, 0o755);
  assert.equal(lstatSync(join(w.root, 'ended', 'S-1.json')).mode & 0o777, 0o644);
  const hr = headReviews({ launches: join(w.root, 'launches'), outboxRoot: w.outboxRoot, uids: UIDS, card: 'C-1', head: HEAD });
  assert.deepEqual(hr.sessions.map((x) => [x.session_id, x.verdict, x.ended]), [['S-1', null, true]]);
  // Never written over, by the sweep or anything else.
  w.clock.t += SWEEP_AFTER_MS;
  await runnerPass(w.ctx);
  assert.equal(w.ended('S-1').ended.how, 'ended');

  // A start whose pid isn't claude's leaves its launch record (the session may have started): the sweep marks it ended
  // once its launch is 5 minutes old, on a pass where no live claude of review's is a stray.
  const v = await ready({ start: async (x) => { v.starts.push(x); v.live.push({ pid: 7000, sessionId: x.sessionId }); return { ok: true, pid: 4242 }; } });
  v.ctx.processName = (p) => (p === 7000 ? `${CLAUDE} --session-id S-1` : null);
  v.ask();
  refusedFor(await runnerPass(v.ctx), /the start gave process 4242, which is not claude/);
  assert.equal(v.ended('S-1').none, true);
  v.clock.t += SWEEP_AFTER_MS;
  // The claude it did start is a stray: stopped, and nothing is swept on that pass.
  let r = await runnerPass(v.ctx);
  assert.deepEqual(v.stops.map((x) => x.pid), [7000]);
  assert.equal(v.ended('S-1').none, true, 'not swept while a stray claude was live');
  r = await runnerPass(v.ctx);
  assert.equal(v.ended('S-1').ended.how, 'swept');
  assert.ok(r.alerts.some((a) => /reviewer session S-1 for card C-1 at aaaaaaa was not being tracked by the review runner; it is now marked ended/.test(a.text)), r.alerts.map((a) => a.text).join(' | '));
  assert.equal((await runnerPass(v.ctx)).alerts.length, 0, 'told once');

  // A stray that can't be stopped holds the sweep back; a young launch isn't swept; a running one never is.
  const u = await ready({ start: async () => ({ ok: true, pid: 4242 }) });
  u.ask(); await runnerPass(u.ctx);
  await runnerPass(u.ctx);
  assert.equal(u.ended('S-1').none, true, 'under 5 minutes old');
  u.clock.t += SWEEP_AFTER_MS;
  u.live.push({ pid: 5000, sessionId: 'S-1' });
  u.ctx.processName = (p) => (p === 5000 ? `${CLAUDE} --session-id S-1` : null);
  u.ctx.stop = async () => { throw new Error('no such process'); };
  await runnerPass(u.ctx);
  await runnerPass(u.ctx);
  assert.equal(u.ended('S-1').none, true, 'not swept while a claude it could not stop is live');
  const t = await ready();
  t.ask(); await runnerPass(t.ctx);
  t.clock.t += 10 * SWEEP_AFTER_MS;
  await runnerPass(t.ctx);
  assert.equal(t.ended('S-1').none, true, 'a session it runs is never swept');

  // An ended folder that is not review's alone stops the pass.
  chmodSync(join(t.root, 'ended'), 0o775);
  assert.match((await runnerPass(t.ctx)).error, /the ended records: the review launches folder can be written by others/);
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
  w.ctx.handedIn = () => ({ ok: true });
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
  // L66: a second name for the file, or a folder others can write or that is someone else's, is an error too.
  linkSync(file, join(w.root, 'second-name.json'));
  assert.throws(() => readReviewStatus({ file, now: T0, uid: ME }), /has more than one name/);
  const v = await ready();
  const vf = join(v.root, 'status.json');
  chmodSync(v.root, 0o775);
  assert.throws(() => readReviewStatus({ file: vf, now: T0, uid: ME }), /folder can be written by others/);
  chmodSync(v.root, 0o755);
  const stat = (p) => { const st = lstatSync(p); return p === v.root ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: OTHER }) : st; };
  assert.throws(() => readReviewStatus({ file: vf, now: T0, uid: ME, stat }), /folder is not owned by the review user/);
  assert.throws(() => readReviewStatus({ file: join(v.base, 'none', 'status.json'), now: T0, uid: ME }), /folder is missing/);
  assert.equal(readReviewStatus({ file: vf, now: T0, uid: ME }).ok, true);
});
