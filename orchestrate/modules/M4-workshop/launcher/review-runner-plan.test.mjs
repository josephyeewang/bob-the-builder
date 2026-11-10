// review-runner-plan.test.mjs — lead call L703: the review runner starts a plan reviewer for a Tier-1 draft card's plan,
// once per plan, from a package it made itself out of the plan file's checked bytes, and keeps the answer in its own
// ended record for the Dispatcher. Every outside effect is a fake; the folders are throwaway ones this test's user owns
// (standing in for the review user).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, symlinkSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runnerPass, needsRole, readRequest, packagePlan, planAnswerFor, readPlanEnded, PLAN_REQUEST_ID, RETRY_MS, SWEEP_AFTER_MS, MAX_FAILED_STARTS, PLAN_FILE_NAME, PLAN_ANSWER_NAME } from './review-runner.mjs';
import { planFingerprint } from '../../../shared/plan-fingerprint.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { reviewPorts as dispatcherPorts, writePlanReviewRequest } from '../../M11-dispatcher/review-requests.mjs';
import { recordPlanFile } from './review-runner-main.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, script: OTHER, reviewer: ME, auditor: ME, plan_reviewer: ME };
const MAIN = 'e'.repeat(40);
const T0 = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const CLAUDE = '/pinned/claude';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PLAN = '{"cards":[{"id":"C-7"}]}\n';

function card(over = {}) {
  return { product: 'app', state: 'draft', tier: 1, files: ['src/a.mjs'], done_when: 'it works', plan_sha256: sha(PLAN), main_commit: MAIN, ...over };
}
const fingerprintOf = (id, d) => planFingerprint({ product: d.product, card_id: id, tier: d.tier, files: d.files, done_when: d.done_when, plan_sha256: d.plan_sha256, main_commit: d.main_commit }).sha256;

function world(over = {}) {
  const base = tempDir('m4-runner-plan-');
  const root = join(base, 'review');
  const outboxRoot = join(base, 'outbox');
  for (const d of [root, outboxRoot]) { mkdirSync(d, { mode: 0o755 }); chmodSync(d, 0o755); }
  // The Lead's outbox, where intake took the plan from (the planFile port finds it from the Record's intake fact).
  const leadBox = join(outboxRoot, 'lead', 'L-1');
  mkdirSync(leadBox, { recursive: true });
  const planPath = join(leadBox, 'plan-1.json');
  writeFileSync(planPath, PLAN);
  const clock = { t: T0 };
  const cards = new Map([['C-7', card()], ['C-2', { ...card(), tier: 2 }]]);
  const live = [];
  const starts = [];
  let n = 0;
  let pid = 2000;
  const ctx = {
    root, outboxRoot, uids: UIDS, reviewHome: join(base, 'review-home'), claudeBin: CLAUDE,
    processName: (p) => { const s = live.find((x) => x.pid === p); return s ? `${CLAUDE} --session-id ${s.sessionId}` : null; },
    now: () => clock.t, ownUid: () => ME, newId: () => `P-${++n}`,
    isAdmin: async () => false,
    readCard: (c) => (cards.has(c) ? { ok: true, doc: cards.get(c) } : { ok: false, missing: true }),
    currentHead: () => { throw new Error('a plan reviewer reads no card head'); },
    treeOf: async () => { throw new Error('a plan reviewer reads no tree'); },
    setAsideByJoe: () => [],
    sessions: async () => live.slice(),
    stop: async (s) => { const i = live.findIndex((x) => x.pid === s.pid); if (i >= 0) live.splice(i, 1); },
    start: async (x) => { starts.push(x); const p = ++pid; live.push({ pid: p, sessionId: x.sessionId }); return { ok: true, pid: p }; },
    planFile: async () => ({ ok: true, path: planPath }),
    accountInUse: () => 'a',
    handedIn: () => ({ ok: false, none: true }),
    verdictTaken: () => ({ ok: true }),
    planReviewCap: () => 4,
    ...over,
  };
  let q = 0;
  const ask = (body = {}) => {
    // The Dispatcher's id for the card's plan (L726 m1), unless the test names another.
    const b0 = { card: 'C-7', fingerprint: fingerprintOf('C-7', cards.get('C-7') ?? card()), role: 'plan_reviewer', ...body };
    const b = { ...b0, request_id: Object.hasOwn(body, 'request_id') ? body.request_id : (typeof b0.card === 'string' && typeof b0.fingerprint === 'string' ? PLAN_REQUEST_ID(b0.card, b0.fingerprint) : `pq-${++q}`) };
    for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
    writeFileSync(join(root, 'requests', `${b.request_id}.json`), JSON.stringify(b), { mode: 0o644 });
    return b;
  };
  const end = (sid) => { const i = live.findIndex((x) => x.sessionId === sid); if (i >= 0) live.splice(i, 1); };
  const answer = (sid, text) => writeFileSync(join(outboxRoot, 'plan_reviewer', sid, PLAN_ANSWER_NAME), text, { mode: 0o644 });
  const read = (b) => planAnswerFor({ root, uid: ME, card: b.card, fingerprint: b.fingerprint, session: b.request_id });
  const status = () => JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'));
  return { base, root, outboxRoot, planPath, clock, cards, live, starts, ctx, ask, end, answer, read, status };
}
async function ready(over) { const w = world(over); const r = await runnerPass(w.ctx); assert.equal(r.ok, true, r.error); return w; }
const refusedFor = (r, re) => assert.ok(r.refused.some((x) => re.test(x.reason)), `no refusal like ${re}: ${r.refused.map((x) => x.reason).join(' | ')}`);

test('L703: needsRole gives a plan reviewer only a Tier-1 draft, and never lets a draft through for a reviewer or auditor', () => {
  assert.equal(needsRole({ state: 'draft', tier: 1 }, 'plan_reviewer'), true);
  assert.equal(needsRole({ state: 'draft', tier: 2 }, 'plan_reviewer'), false);
  assert.equal(needsRole({ state: 'in_review', tier: 1 }, 'plan_reviewer'), false);
  assert.equal(needsRole({ state: 'ready', tier: 1 }, 'plan_reviewer'), false);
  assert.equal(needsRole(null, 'plan_reviewer'), false);
  for (const role of ['reviewer', 'auditor']) assert.equal(needsRole({ state: 'draft', tier: 1 }, role), false, role);
  assert.equal(needsRole({ state: 'in_review', tier: 1 }, 'auditor'), true);
});

test('L703: a plan request is read in its own shape, and only a plan reviewer\'s may name a fingerprint', () => {
  const dir = tempDir('m4-plan-req-');
  const put = (name, body) => { writeFileSync(join(dir, name), JSON.stringify(body)); return readRequest(dir, name); };
  const fp = 'f'.repeat(64);
  const good = put('a.json', { card: 'C-7', fingerprint: fp, role: 'plan_reviewer', request_id: 'r1' });
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.req.fingerprint, fp);
  assert.match(put('b.json', { card: 'C-7', fingerprint: fp, role: 'reviewer', request_id: 'r2' }).reason, /only a plan reviewer's request names a fingerprint/);
  assert.match(put('c.json', { card: 'C-7', fingerprint: 'F'.repeat(64), role: 'plan_reviewer', request_id: 'r3' }).reason, /fingerprint is not 64 hex/);
  assert.match(put('d.json', { card: 'C-7', fingerprint: fp, head: MAIN, role: 'plan_reviewer', request_id: 'r4' }).reason, /must hold exactly/);
  assert.match(put('e.json', { card: 'C-7', role: 'plan_reviewer', request_id: 'r5' }).reason, /must hold exactly/);
});

test('L703: a good plan request starts one plan reviewer at the plan\'s main commit, from a package of the checked plan bytes', async () => {
  const w = await ready();
  const b = w.ask();
  assert.deepEqual(await w.read(b), { ok: true }, 'asked, nothing launched yet: still working');
  const r = await runnerPass(w.ctx);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.started.map((s) => [s.card, s.role, s.session_id]), [['C-7', 'plan_reviewer', 'P-1']]);
  const s = w.starts[0];
  assert.equal(s.role, 'plan_reviewer');
  assert.equal(s.head, MAIN, 'the reviewer reads main as the plan was made on it');
  assert.equal(s.fingerprint, b.fingerprint);
  assert.equal(s.outbox, join(w.outboxRoot, 'plan_reviewer', 'P-1'));
  assert.equal(s.planFile, join(w.root, 'packages', 'P-1', PLAN_FILE_NAME));
  assert.equal(readFileSync(s.planFile, 'utf8'), PLAN);
  assert.equal(readFileSync(join(w.root, 'packages', 'P-1.sha256'), 'utf8').trim(), sha(PLAN), 'the pin is the plan the card names');
  // Its launch record is in plan-launches/, never launches/, so the Merge Gate never counts it toward a merge.
  assert.deepEqual(readdirSync(join(w.root, 'launches')), []);
  assert.deepEqual(readdirSync(join(w.root, 'plan-launches')), ['P-1.json']);
  const doc = JSON.parse(readFileSync(join(w.root, 'plan-launches', 'P-1.json'), 'utf8'));
  assert.deepEqual([doc.card, doc.role, doc.fingerprint, doc.request_id, doc.main_commit], ['C-7', 'plan_reviewer', b.fingerprint, b.request_id, MAIN]);
  const st = w.status();
  assert.deepEqual(st.running.map((x) => [x.card, x.role, x.session_id, x.fingerprint]), [['C-7', 'plan_reviewer', 'P-1', b.fingerprint]]);
  assert.deepEqual(await w.read(b), { ok: true }, 'running: still working');
});

test('L703 planted: a plan request is refused for each check, and nothing starts', async () => {
  const cases = [
    ['a card in review', (w) => { w.cards.set('C-7', { ...card(), state: 'in_review' }); w.ask(); }, /does not need a plan reviewer \(it is in_review, tier 1\)/],
    ['a Tier-2 card', (w) => w.ask({ card: 'C-2', fingerprint: fingerprintOf('C-2', w.cards.get('C-2')) }), /does not need a plan reviewer \(it is draft, tier 2\)/],
    ['an unknown card', (w) => w.ask({ card: 'C-404' }), /card C-404 is not in the Record/],
    ['another plan\'s fingerprint', (w) => w.ask({ fingerprint: '0'.repeat(64) }), /the request names plan 000000000000, but card C-7's plan is/],
    ['a plan that can\'t be fingerprinted', (w) => { w.cards.set('C-7', { ...card(), files: [] }); w.ask({ fingerprint: '1'.repeat(64) }); }, /can't be fingerprinted/],
    ['a reviewer for a draft card', (w) => w.ask({ fingerprint: undefined, head: MAIN, role: 'reviewer' }), /does not need a reviewer \(it is draft\)/],
    ['an auditor for a draft card', (w) => w.ask({ fingerprint: undefined, head: MAIN, role: 'auditor' }), /does not need a auditor \(it is draft, tier 1\)/],
  ];
  for (const [what, plant, re] of cases) {
    const w = await ready({ currentHead: () => MAIN, treeOf: async () => 'c'.repeat(40) });
    plant(w);
    const r = await runnerPass(w.ctx);
    assert.equal(w.starts.length, 0, what);
    refusedFor(r, re);
    assert.deepEqual(readdirSync(join(w.root, 'plan-launches')), [], `${what}: no launch record`);
    assert.deepEqual(readdirSync(join(w.root, 'launches')), [], `${what}: no review launch record`);
  }
});

// The runner's memory of request ids is kept short (KEEP_SEEN); this stands in for one that has let an id go, so
// the checks behind it are reached.
const forgetSeen = (w) => {
  const f = join(w.root, 'state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...st, seen: [] }));
};

test('L703: one plan reviewer per plan; a new plan gets a new one', async () => {
  const w = await ready();
  w.ask();
  await runnerPass(w.ctx);
  // The same plan asked again has the same id (L726 m1), so it is refused as seen; and were it forgotten, the runner
  // still sees the reviewer running, and then the launch.
  w.ask();
  refusedFor(await runnerPass(w.ctx), /request id [0-9a-f]{64} was seen before/);
  forgetSeen(w);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /a plan reviewer is already running for card C-7's plan/);
  w.end('P-1');
  w.answer('P-1', 'PASS\n');
  await runnerPass(w.ctx);
  forgetSeen(w);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /a plan reviewer was already started for card C-7's plan .*; one per plan/);
  assert.equal(w.starts.length, 1);
  // A new plan: a new file, a new plan_sha256, so a new fingerprint and a new reviewer.
  const plan2 = '{"cards":[{"id":"C-7","v":2}]}\n';
  writeFileSync(w.planPath, plan2);
  w.cards.set('C-7', card({ plan_sha256: sha(plan2) }));
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.deepEqual(r.started.map((s) => s.session_id), ['P-2']);
});

test('L703: the answer is the one the runner read at the end, kept in its own ended record; none or a bad one is told as such', async () => {
  const w = await ready();
  const b = w.ask();
  await runnerPass(w.ctx);
  w.answer('P-1', 'PASS\n');
  assert.deepEqual(await w.read(b), { ok: true }, 'an answer file before the end is not read');
  w.end('P-1');
  await runnerPass(w.ctx);
  const e = readPlanEnded(join(w.root, 'plan-ended'), ME, 'P-1');
  assert.equal(e.ok, true, e.reason);
  assert.equal(e.ended.answer_sha256, sha('PASS\n'));
  assert.deepEqual(await w.read(b), { ok: true, answer: 'PASS\n' });
  // A change to the outbox after the end changes nothing: the Dispatcher reads the runner's record.
  w.answer('P-1', '1. Why?\n');
  assert.deepEqual(await w.read(b), { ok: true, answer: 'PASS\n' });
  assert.deepEqual(await w.read({ ...b, request_id: 'other' }), { ok: true }, 'another request\'s session is not this one');
  assert.deepEqual(await w.read({ ...b, fingerprint: '0'.repeat(64) }), { ok: true }, 'another plan\'s session is not this one');
  assert.equal(w.ctx.removeCopy, undefined);

  // No answer at all.
  const w2 = await ready();
  const b2 = w2.ask();
  await runnerPass(w2.ctx);
  w2.end('P-1');
  await runnerPass(w2.ctx);
  const a2 = await w2.read(b2);
  assert.equal(a2.ok, false);
  assert.match(a2.reason, /ended without an answer/);

  // The plan it was given changed while it ran: its answer can't count.
  const w3 = await ready();
  const b3 = w3.ask();
  await runnerPass(w3.ctx);
  w3.answer('P-1', 'PASS\n');
  writeFileSync(join(w3.root, 'packages', 'P-1', PLAN_FILE_NAME), 'another plan\n');
  w3.end('P-1');
  await runnerPass(w3.ctx);
  const a3 = await w3.read(b3);
  assert.equal(a3.ok, false);
  assert.match(a3.reason, /can't be counted \(the review package changed while the session ran \(its plan\.txt's sha256/);
});

test('L703: a plan reviewer whose claude never ran is tried again by the runner itself, RETRY_MS apart, then the owner is told', async () => {
  let fail = true;
  const w = await ready({ start: async (x) => { w.starts.push(x); return fail ? { ok: false, reason: 'no claude' } : (() => { const p = 3000 + w.starts.length; w.live.push({ pid: p, sessionId: x.sessionId }); return { ok: true, pid: p }; })(); } });
  const b = w.ask();
  const r1 = await runnerPass(w.ctx);
  refusedFor(r1, /the plan reviewer could not be started: no claude/);
  assert.equal(readPlanEnded(join(w.root, 'plan-ended'), ME, 'P-1').ended.answer_sha256, 'never_ran');
  assert.deepEqual(await w.read(b), { ok: true }, 'never ran, tried again: still working, not an end');
  // No request comes again (plan-go asks once per plan); the runner tries again itself, not before RETRY_MS.
  w.clock.t += RETRY_MS - 1;
  const quiet = await runnerPass(w.ctx);
  assert.equal(w.starts.length, 1);
  assert.deepEqual(quiet.refused, [], 'a try not yet due is passed over quietly, not refused each pass');
  // A request that comes again before then starts nothing either.
  forgetSeen(w);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /the last start of a plan reviewer for card C-7 failed less than 15 minutes ago/);
  assert.equal(w.starts.length, 1);
  w.clock.t += 1;
  fail = false;
  const r2 = await runnerPass(w.ctx);
  assert.deepEqual(r2.started.map((s) => s.session_id), ['P-2']);
  assert.equal(w.status().running[0].session_id, 'P-2');
  assert.deepEqual(await w.read(b), { ok: true }, 'the retry runs: still working');
  w.answer('P-2', 'PASS\n');
  w.end('P-2');
  await runnerPass(w.ctx);
  assert.deepEqual(await w.read(b), { ok: true, answer: 'PASS\n' }, 'the newest launch that ran answers');

  // Every try fails: the owner is told once, and it stops.
  const v = await ready({ start: async (x) => { v.starts.push(x); return { ok: false, reason: 'no claude' }; } });
  v.ask();
  let told = [];
  for (let i = 0; i < MAX_FAILED_STARTS + 2; i++) { const r = await runnerPass(v.ctx); told = [...told, ...r.alerts]; v.clock.t += RETRY_MS; }
  assert.equal(v.starts.length, MAX_FAILED_STARTS);
  assert.equal(told.filter((a) => a.id.startsWith('plan-gave-up-')).length, 1);
  assert.match(told.find((a) => a.id.startsWith('plan-gave-up-')).text, /No plan reviewer could be started for card C-7 .* after 3 tries \(last: no claude\)/);
});

test('L703: a plan file that changed after intake, or is gone, starts nothing; the card stays a draft and the owner is told', async () => {
  const w = await ready();
  w.ask();
  writeFileSync(w.planPath, 'edited after intake\n');
  const r = await runnerPass(w.ctx);
  assert.equal(w.starts.length, 0);
  refusedFor(r, /the plan file changed after intake/);
  assert.ok(r.alerts.some((a) => a.id.startsWith('plan-file-') && /The card stays a draft; a new plan gets a new reviewer/.test(a.text)));
  assert.deepEqual(readdirSync(join(w.root, 'plan-launches')), []);
  // Not tried again: the same plan can't come back.
  w.clock.t += RETRY_MS;
  await runnerPass(w.ctx);
  assert.equal(w.starts.length, 0);

  const g = await ready({ planFile: async () => ({ ok: true, path: join(tempDir('m4-plan-gone-'), 'plan-1.json') }) });
  g.ask();
  refusedFor(await runnerPass(g.ctx), /the plan file is gone/);
  assert.equal(g.starts.length, 0);
});

test('L703: the plan file is read once; a change on disk between the check and the package write never reaches the package', () => {
  const dir = tempDir('m4-plan-pkg-');
  const path = join(dir, 'plan-1.json');
  writeFileSync(path, PLAN);
  const pkgDir = join(dir, 'packages', 'P-1');
  mkdirSync(join(dir, 'packages'));
  const p = packagePlan({ path, sha256: sha(PLAN), dir: pkgDir, between: () => writeFileSync(path, 'swapped after the hash\n') });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.sha256, sha(PLAN));
  assert.equal(readFileSync(p.file, 'utf8'), PLAN, 'the package holds the bytes that were hashed');
  assert.equal(sha(readFileSync(p.file)), p.sha256, 'and so matches the pin');
  assert.equal(lstatSync(p.file).mode & 0o777, 0o644);
  // A link, a folder, a file too big: refused.
  // A link to a file holding the very plan is still refused: no link is followed.
  const real = join(dir, 'real.json');
  writeFileSync(real, PLAN);
  const link = join(dir, 'link.json');
  symlinkSync(real, link);
  const viaLink = packagePlan({ path: link, sha256: sha(PLAN), dir: join(dir, 'packages', 'P-5') });
  assert.equal(viaLink.ok, false, 'a link is never followed');
  assert.match(viaLink.reason, /the plan file is a link/);
  assert.match(packagePlan({ path: dir, sha256: sha(PLAN), dir: join(dir, 'packages', 'P-2') }).reason, /not a plain file/);
  assert.match(packagePlan({ path, sha256: sha(PLAN), dir: join(dir, 'packages', 'P-3'), max: 3 }).reason, /changed after intake \(it is now too big\)/);
  assert.match(packagePlan({ path: join(dir, 'none.json'), sha256: sha(PLAN), dir: join(dir, 'packages', 'P-4') }).reason, /gone/);
});

test('L703: a plan launch the runner lost track of is swept once 5 minutes old, its answer read as at any end', async () => {
  const w = await ready();
  const b = w.ask();
  await runnerPass(w.ctx);
  // The runner loses its memory of the session (as if it stopped before saving), and the session ends.
  const state = JSON.parse(readFileSync(join(w.root, 'state.json'), 'utf8'));
  writeFileSync(join(w.root, 'state.json'), JSON.stringify({ ...state, running: [] }), { mode: 0o600 });
  w.answer('P-1', 'PASS\n');
  w.end('P-1');
  w.clock.t += SWEEP_AFTER_MS - 1;
  await runnerPass(w.ctx);
  assert.deepEqual(await w.read(b), { ok: true }, 'not yet 5 minutes old');
  w.clock.t += 1;
  const r = await runnerPass(w.ctx);
  assert.ok(r.alerts.some((a) => a.id === 'swept-P-1'));
  assert.deepEqual(await w.read(b), { ok: true, answer: 'PASS\n' });
});

test('L703: the Dispatcher\'s read throws on folders it can\'t trust, never "working"', async () => {
  const w = await ready();
  const b = w.ask();
  await runnerPass(w.ctx);
  chmodSync(join(w.root, 'plan-launches'), 0o777);
  assert.throws(() => planAnswerFor({ root: w.root, uid: ME, card: 'C-7', fingerprint: b.fingerprint, session: b.request_id }), /can be written by others/);
  chmodSync(join(w.root, 'plan-launches'), 0o755);
  assert.throws(() => planAnswerFor({ root: w.root, uid: OTHER, card: 'C-7', fingerprint: b.fingerprint, session: b.request_id }), /not owned by the review user/);
  // No plan reviewer was ever started: no folder yet, so working.
  const fresh = tempDir('m4-plan-none-');
  assert.deepEqual(planAnswerFor({ root: fresh, uid: ME, card: 'C-7', fingerprint: b.fingerprint, session: b.request_id }), { ok: true });
});

test('L703 end to end: the Dispatcher asks through the requests folder, the runner starts and ends the reviewer, the Dispatcher reads the answer', async () => {
  const w = await ready();
  const d = dispatcherPorts({ requests: join(w.root, 'requests'), status: join(w.root, 'status.json'), reviewUid: ME, now: () => w.clock.t });
  const fp = fingerprintOf('C-7', w.cards.get('C-7'));
  const s = d.startPlanReview({ card: 'C-7', fingerprint: fp, key: `C-7-${fp}` });
  assert.equal(s.ok, true, s.reason);
  const read = () => d.planReviewAnswer({ card: 'C-7', fingerprint: fp, session: s.session });
  assert.deepEqual(read(), { ok: true });
  await runnerPass(w.ctx);
  assert.equal(w.starts.length, 1);
  assert.deepEqual(d.planReviewsRunning().map((r) => [r.card, r.session_id]), [['C-7', 'P-1']], 'the tick counts it');
  assert.deepEqual(read(), { ok: true });
  // plan-go asks once per plan; were it asked again, nothing more starts.
  assert.equal(d.startPlanReview({ card: 'C-7', fingerprint: fp, key: `C-7-${fp}` }).session, s.session);
  await runnerPass(w.ctx);
  assert.equal(w.starts.length, 1);
  w.answer('P-1', '1. Which row covers the export?\n');
  w.end('P-1');
  await runnerPass(w.ctx);
  assert.deepEqual(read(), { ok: true, answer: '1. Which row covers the export?\n' });
  assert.deepEqual(d.planReviewsRunning(), []);
});

test('L703: the real planFile port finds the plan by the Record\'s note of what intake applied, and only names a Lead outbox path', () => {
  const base = tempDir('m4-plan-record-');
  const recordRoot = join(base, 'record');
  const fact = join(recordRoot, 'docs', 'fact');
  mkdirSync(fact, { recursive: true, mode: 0o755 });
  const outboxRoot = join(base, 'outbox');
  const note = (session, name, doc, id = `intake-applied-${session}-${name}`) => writeFileSync(join(fact, `${id}.json`), JSON.stringify({ entity: 'fact', id, rev: 1, doc: { session, name, ...doc } }), { mode: 0o644 });
  const find = (sum = sha(PLAN), uid = ME) => recordPlanFile({ recordRoot, recordUid: uid, outboxRoot, plan_sha256: sum });
  assert.match(find().reason, /notes no plan applied/);
  note('L-1', 'plan-1.json', { state: 'refused', sha256: sha(PLAN) });
  note('L-1', 'plan-2.json', { state: 'applying', sha256: sha(PLAN) });
  note('L-1', 'plan-3.json', { state: 'applied', sha256: 'b'.repeat(64) });
  note('L-1', '../../etc/plan-4.json', { state: 'applied', sha256: sha(PLAN) }, 'intake-applied-L-1-x');
  note('L-2', 'plan-5.json', { state: 'applied', sha256: sha(PLAN) }, 'intake-applied-L-9-plan-5.json');
  // Filed under their own names, but a name that leaves the outbox file, or another kind of file, is no plan.
  note('L-1', '..', { state: 'applied', sha256: sha(PLAN) });
  note('L-1', 'verdict-1.json', { state: 'applied', sha256: sha(PLAN) });
  assert.match(find().reason, /notes no plan applied/, 'refused, not yet applied, another plan, a path, .., another kind, a note under another name: none counts');
  note('L-1', 'plan-6.json', { state: 'applied', sha256: sha(PLAN) });
  assert.deepEqual(find(), { ok: true, path: join(outboxRoot, 'lead', 'L-1', 'plan-6.json') });
  assert.match(find('nope').reason, /names no plan sha256/);
  assert.match(find(sha(PLAN), OTHER).reason, /not the Record owner's alone/);
});

// L726 m1: a request anyone could write, with the right card and plan but not the Dispatcher's id, can't take the plan's
// one start; it is refused and kept as one hold for its cause, and the Dispatcher's own request then starts.
test('L726 m1 planted: a plan request with another id is refused, and the Dispatcher\'s request still starts', async () => {
  const w = await ready();
  const forged = w.ask({ request_id: 'forged-1' });
  const r1 = await runnerPass(w.ctx);
  refusedFor(r1, /a plan review request must have the id the Dispatcher gives card C-7's plan; forged-1 is not it/);
  assert.deepEqual(r1.started, []);
  assert.deepEqual(r1.alerts, [], 'anyone may write a request: no alert a file');
  const st = JSON.parse(readFileSync(join(w.root, 'state.json'), 'utf8'));
  assert.equal(st.unread_requests['plan request with another id'].file, 'forged-1.json');
  const real = w.ask();
  assert.equal(real.request_id, PLAN_REQUEST_ID('C-7', forged.fingerprint));
  const r2 = await runnerPass(w.ctx);
  assert.deepEqual(r2.started.map((s) => s.session_id), ['P-1']);
  // Its status names the request, so the Dispatcher counts the one it asked for once.
  assert.equal(w.status().running[0].request_id, real.request_id);
  // The answer is read by the Dispatcher's id.
  w.answer('P-1', 'PASS\n');
  w.end('P-1');
  await runnerPass(w.ctx);
  assert.deepEqual(await w.read(real), { ok: true, answer: 'PASS\n' });
});

// L726 m2: once a request is for the card's plan as it is now, a refusal that ends it is told once, with its cause.
test('L726 m2 planted: a refused request for the card\'s real plan is told once, with its cause; a made-up one is not told', async () => {
  // A start that gives a process that is not claude ends the request: told, with that cause.
  const w = await ready({ start: async () => ({ ok: true, pid: 1 }) });
  w.ask();
  const r = await runnerPass(w.ctx);
  const told = r.alerts.filter((a) => /^plan-refused-/.test(a.id));
  assert.equal(told.length, 1, JSON.stringify(r.alerts));
  assert.match(told[0].text, /did not start a plan reviewer for card C-7 \(plan [0-9a-f]{12}\): the plan reviewer start gave process 1, which is not claude/);
  // A card not in the Record, or a plan the card does not have: refused, never told (anyone may write one).
  for (const body of [{ card: 'C-99' }, { fingerprint: 'a'.repeat(64) }]) {
    const b = w.ask(body);
    const x = await runnerPass(w.ctx);
    assert.ok(x.refused.some((y) => y.request_id === b.request_id), JSON.stringify(body));
    assert.deepEqual(x.alerts, [], JSON.stringify(body));
  }
});

// L735 m2-r2: the plan's own reviewer running, or already started, is no refusal of the Dispatcher's request. A replay of
// the plan's id is refused quietly, and a flood of other ids can't push the Dispatcher's out of what the runner has seen.
test('L735 m2-r2 planted: a replay of the plan\'s id while its reviewer runs, or once it answered, is refused but never told', async () => {
  const w = await ready();
  const b = w.ask();
  await runnerPass(w.ctx);
  assert.equal(w.starts.length, 1);
  const quiet = async (re) => {
    w.ask();
    const r = await runnerPass(w.ctx);
    refusedFor(r, re);
    assert.deepEqual(r.alerts.filter((a) => /^plan-refused-/.test(a.id)), [], JSON.stringify(r.alerts));
  };
  forgetSeen(w);
  await quiet(/a plan reviewer is already running for card C-7's plan/);
  w.answer('P-1', 'PASS\n');
  w.end('P-1');
  await runnerPass(w.ctx);
  forgetSeen(w);
  await quiet(/a plan reviewer was already started for card C-7's plan [0-9a-f]{12}; one per plan/);
  assert.equal(w.starts.length, 1);
  assert.deepEqual(await w.read(b), { ok: true, answer: 'PASS\n' });
  // Plan requests under other ids are not remembered as seen, so the plan's own id stays seen past any number of them.
  for (let i = 0; i < 510; i++) w.ask({ request_id: `junk-${i}` });
  await runnerPass(w.ctx);
  const st = JSON.parse(readFileSync(join(w.root, 'state.json'), 'utf8'));
  assert.ok(st.seen.includes(b.request_id), 'the plan\'s id is still seen');
  assert.ok(!st.seen.some((x) => x.startsWith('junk-')), 'no other id is');
  await quiet(/request id [0-9a-f]+ was seen before/);
});

// L735 m1-r2: anyone may write the requests folder and work out a plan's request name, so a file already under it counts
// as asked only when it is the Dispatcher's own, with these very bytes. Any other is said, with its cause, so plan-go
// takes no cap slot for it and tells it (its `start` hold).
test('L735 m1-r2 planted: a file put first under the plan\'s request name is said, never taken as asked', async () => {
  const w = await ready();
  const d = dispatcherPorts({ requests: join(w.root, 'requests'), status: join(w.root, 'status.json'), reviewUid: ME, now: () => w.clock.t });
  const fp = fingerprintOf('C-7', w.cards.get('C-7'));
  const name = join(w.root, 'requests', `${PLAN_REQUEST_ID('C-7', fp)}.json`);
  const ask = () => d.startPlanReview({ card: 'C-7', fingerprint: fp, key: `C-7-${fp}` });
  const mine = ask();
  assert.equal(mine.ok, true, mine.reason);
  assert.deepEqual(ask(), { ok: true, session: mine.session }, 'its own request, still waiting: asked');
  const bytes = readFileSync(name);
  for (const [junk, re] of [['not json', /it holds another request/], [`${bytes.toString()} `, /it holds another request/], [JSON.stringify({ ...JSON.parse(bytes), request_id: 'other-1' }), /it holds another request/],
    // The same size, one byte apart.
    [bytes.toString().replace(/"card":"C-7"/, '"card":"C-8"'), /it holds another request/]]) {
    unlinkSync(name);
    writeFileSync(name, junk, { mode: 0o644 });
    const r = ask();
    assert.equal(r.ok, false, junk);
    assert.match(r.reason, /another file stands under this plan's request name, so the request was not written/);
    assert.match(r.reason, re);
  }
  unlinkSync(name);
  const elsewhere = join(w.base, 'elsewhere.json');
  writeFileSync(elsewhere, bytes);
  symlinkSync(elsewhere, name);
  assert.match(ask().reason, /another file stands under this plan's request name, .*can't be opened \(ELOOP\)/);
  unlinkSync(name);
  mkdirSync(name);
  assert.match(ask().reason, /it is not a plain file/);
  rmdirSync(name);
  assert.equal(ask().ok, true, 'once it is gone, the Dispatcher asks');
  // The same bytes, but not the Dispatcher's own file (as the writer sees it here, under another uid): said.
  const other = writePlanReviewRequest({ dir: join(w.root, 'requests'), card: 'C-7', fingerprint: fp, key: `C-7-${fp}`, uid: OTHER });
  assert.match(other.reason, new RegExp(`it is uid ${ME}'s, not the Dispatcher's`));
});

// L735 M1: the runner keeps the plan reviewers' cap itself, across every product's requests. Two products' requests
// reach the one shared runner (each as its Dispatcher's gate would let it through; the gates are not run here): with
// 3 running and a cap of 4, the runner starts exactly one; the other waits as the runner's own, never counted as a failed start, and
// starts once one ends. A request no Dispatcher wrote is held by the same cap.
test('L735 M1 planted: two products share one runner; 3 running, cap 4: exactly 1 starts, the other waits and starts when one ends', async () => {
  const caps = [];
  const w = await ready({ planReviewCap: (product) => { caps.push(product); return 4; } });
  const two = (id, product) => { w.cards.set(id, card({ product })); return fingerprintOf(id, w.cards.get(id)); };
  // Three running already, from both products.
  for (const [id, product] of [['C-10', 'app'], ['C-11', 'p2'], ['C-12', 'p2']]) w.ask({ card: id, fingerprint: two(id, product) });
  await runnerPass(w.ctx);
  assert.equal(w.starts.length, 3);
  // Each product's Dispatcher, through its own ports, asks for one more: both are under the cap as each one counts.
  const a = dispatcherPorts({ requests: join(w.root, 'requests'), status: join(w.root, 'status.json'), reviewUid: ME, now: () => w.clock.t });
  const bp = dispatcherPorts({ requests: join(w.root, 'requests'), status: join(w.root, 'status.json'), reviewUid: ME, now: () => w.clock.t });
  const fa = two('C-3', 'app');
  const fb = two('C-4', 'p2');
  assert.equal(a.startPlanReview({ card: 'C-3', fingerprint: fa, key: `C-3-${fa}` }).ok, true);
  assert.equal(bp.startPlanReview({ card: 'C-4', fingerprint: fb, key: `C-4-${fb}` }).ok, true);
  const r = await runnerPass(w.ctx);
  assert.equal(w.starts.length, 4, 'exactly one more starts');
  assert.equal(r.started.length, 1);
  const waiting = r.started[0].card === 'C-3' ? 'C-4' : 'C-3';
  refusedFor(r, new RegExp(`4 plan reviewers already run \\(cap 4\\); card ${waiting}'s waits`));
  assert.ok(caps.includes('app') && caps.includes('p2'), 'the cap is the card\'s own product\'s');
  // It waits, pass after pass, never told and never given up on.
  for (let i = 0; i < MAX_FAILED_STARTS + 2; i++) {
    w.clock.t += RETRY_MS;
    const x = await runnerPass(w.ctx);
    assert.deepEqual(x.started, []);
    assert.deepEqual(x.alerts, [], JSON.stringify(x.alerts));
  }
  // A request no Dispatcher wrote, under a plan's own id, is held by the same cap.
  w.ask({ card: 'C-5', fingerprint: two('C-5', 'app') });
  assert.deepEqual((await runnerPass(w.ctx)).started, []);
  assert.equal(w.starts.length, 4);
  // One ends: the one that waited longest starts, and only it.
  w.end('P-1');
  const y = await runnerPass(w.ctx);
  assert.deepEqual(y.started.map((s) => s.card), [waiting]);
  assert.equal(w.starts.length, 5);
});

// #294 self-review m1: a start the runner can't follow (it gave a process that is not claude) still holds its cap slot
// for the rest of the pass, so a second request in the same pass waits rather than passing the cap by one.
test('L735 M1 planted: a start the runner can\'t follow holds its cap slot for the rest of the pass', async () => {
  let n = 0;
  const w = await ready({ planReviewCap: () => 1, start: async () => { n += 1; return { ok: true, pid: 1 }; } });
  w.cards.set('C-3', card());
  w.ask();
  w.ask({ card: 'C-3', fingerprint: fingerprintOf('C-3', w.cards.get('C-3')) });
  const r = await runnerPass(w.ctx);
  assert.equal(n, 1, 'one start only: the untracked one holds the one slot');
  refusedFor(r, /1 plan reviewers already run \(cap 1\)/);
});

test('L735 M1: a cap that can\'t be read starts no plan reviewer, and is told once the runner gives up', async () => {
  const w = await ready({ planReviewCap: () => { throw new Error('no budget module'); } });
  w.ask();
  refusedFor(await runnerPass(w.ctx), /the plan reviewers' cap could not be read \(no budget module\)/);
  let told = [];
  for (let i = 0; i < MAX_FAILED_STARTS + 1; i++) { w.clock.t += RETRY_MS; told = [...told, ...(await runnerPass(w.ctx)).alerts]; }
  assert.ok(told.some((a) => /the plan reviewers' cap could not be read/.test(a.text)), JSON.stringify(told));
  assert.deepEqual(w.starts, []);
});

// L726 m3: a map of Mac users from before the plan reviewer blocks plan reviews alone; the runner tries again itself
// and tells the cause when it gives up, and setting it up lets the plan's reviewer start.
test('L726 m3 planted: a map without plan_reviewer refuses plan starts with the cause; the runner\'s pass still runs', async () => {
  const { plan_reviewer: _p, ...noPlan } = UIDS;
  const w = await ready({ uids: noPlan });
  w.ask();
  const r = await runnerPass(w.ctx);
  assert.equal(r.ok, true, r.error);
  refusedFor(r, /the plan reviewer could not be started: the review user is not set up for plan reviews: the map of role to Mac user id leaves out plan_reviewer/);
  assert.deepEqual(w.starts, []);
  let told = [];
  for (let i = 0; i < MAX_FAILED_STARTS + 1; i++) { w.clock.t += RETRY_MS; told = [...told, ...(await runnerPass(w.ctx)).alerts]; }
  assert.ok(told.some((a) => /after \d+ tries \(last: the review user is not set up for plan reviews/.test(a.text)), JSON.stringify(told));
  assert.deepEqual(w.starts, []);
  const other = await ready({ uids: { ...UIDS, plan_reviewer: OTHER } });
  other.ask();
  refusedFor(await runnerPass(other.ctx), /the plan reviewer's Mac user \(uid \d+\) is not the review user/);
  assert.deepEqual(other.starts, []);
});
