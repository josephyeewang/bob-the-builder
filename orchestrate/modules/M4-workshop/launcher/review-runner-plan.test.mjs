// review-runner-plan.test.mjs — lead call L703: the review runner starts a plan reviewer for a Tier-1 draft card's plan,
// once per plan, from a package it made itself out of the plan file's checked bytes, and keeps the answer in its own
// ended record for the Dispatcher. Every outside effect is a fake; the folders are throwaway ones this test's user owns
// (standing in for the review user).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, symlinkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runnerPass, needsRole, readRequest, packagePlan, planAnswerFor, readPlanEnded, RETRY_MS, SWEEP_AFTER_MS, MAX_FAILED_STARTS, PLAN_FILE_NAME, PLAN_ANSWER_NAME } from './review-runner.mjs';
import { planFingerprint } from '../../../shared/plan-fingerprint.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { reviewPorts as dispatcherPorts } from '../../M11-dispatcher/review-requests.mjs';
import { recordPlanFile } from './review-runner-main.mjs';

const ME = process.getuid();
const OTHER = ME + 1;
const UIDS = { lead: OTHER, worker: OTHER, front_door: OTHER, learning: OTHER, writer: OTHER, incident: OTHER, scout: OTHER, thinking: OTHER, reviewer: ME, auditor: ME, plan_reviewer: ME };
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
    ...over,
  };
  let q = 0;
  const ask = (body = {}) => {
    const b = { card: 'C-7', fingerprint: fingerprintOf('C-7', cards.get('C-7') ?? card()), role: 'plan_reviewer', request_id: `pq-${++q}`, ...body };
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

test('L703: one plan reviewer per plan; a new plan gets a new one', async () => {
  const w = await ready();
  w.ask();
  await runnerPass(w.ctx);
  w.ask();
  refusedFor(await runnerPass(w.ctx), /a plan reviewer is already running for card C-7's plan/);
  w.end('P-1');
  w.answer('P-1', 'PASS\n');
  await runnerPass(w.ctx);
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
  w.ask({ request_id: b.request_id + '-again' });
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
