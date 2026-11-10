// plan-go.test.mjs — L440, L442, L443: the Dispatcher asks for a card's go and records the answer, on a real Record, with
// real M2 asks and fake reviewer, repo and alert-delivery ports.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, OWNER_ID, PRODUCT, must } from '../M2-approvals/fixtures.test-helper.mjs';
import { leadCard, planFile, product, roadmap, seed } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { doneBar } from '../M2-approvals/go.mjs';
import { outbox, sendAlerts } from './alerts.mjs';
import { move } from './moves.mjs';
import { intakePass } from './outbox-intake.mjs';
import { recordLeadLaunch } from './lead-restart.mjs';
import { schedulePass } from '../M2-approvals/schedule.mjs';
import { GO_REASK_MS, namedSession, planAuthor, planGoPass, PLAN_ASK_FACT, PLAN_PORT_MS, PLAN_REVIEW_FACT, PLAN_REVIEW_LEAD, PLAN_REVIEW_SLOW_MS, PLAN_SLOW_FACT, PLAN_START_HOLD_MS, PLAN_TURN_FACT } from './plan-go.mjs';
import { approvalsStep, approvalsAlerts, APPROVALS_PRODUCT_MS } from './tick.mjs';
import { fakeAlert } from '../../test/fake-alert.test-helper.mjs';
import { planRows } from '../../wiring/review-ports.mjs';
import { sleepMs } from '../M9-record/lock.mjs';
import { startGate, fileSet } from './gate.mjs';
import { rulesWith } from './fixtures.test-helper.mjs';

const HOUR = 3_600_000;
const row = (id, over = {}) => ({ id, what: `row ${id}`, module: 'M1', tier: 2, done_when: `tests pass for ${id}`, status: 'planned', ...over });
const ROWS = { 'R-1': row('R-1') };
const SHA = 'e'.repeat(64);

const LIVE_RULES = { 'caps.rounds': 3, 'product_state_rules.active.start': 'within_caps', 'product_state_rules.paused.start': 'none' };

function world(values = {}) {
  const t = env({ values: { ...LIVE_RULES, ...values } });
  product(t);
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one' });
  g.repo.main = M0;
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const w = { t, M0, sent: [], started: [], answers: [], replies: [], reviewer: 'S-review', answer: { ok: true } };
  w.ports = {
    startPlanReview: async (x) => { w.started.push(x); return { ok: true, session: w.reviewer }; },
    planReviewAnswer: async (x) => { w.answers.push(x); return w.answer; },
    planRows: async () => ROWS, planView: async () => view, mainSha: async () => M0,
    replyToLead: async (x) => { w.replies.push(x); return { ok: true }; },
  };
  return w;
}

// One pass, then its alerts delivered, so a mark lands as it does in the tick.
async function pass(w, over = {}, ctxOver = {}) {
  const now = w.t.clock.t;
  const rec = ctxOver.record ?? w.t.record;
  const r = await planGoPass({ ...w.t.ctx, ...ctxOver }, { ...w.ports, alert: outbox(rec, now), ...over });
  await sendAlerts(w.t.record, async (text) => { w.sent.push(text); return true; }, now);
  return r;
}
const card = (w, id, over = {}) => leadCard(w.t, id, { done_when: doneBar(ROWS), ...over });
const t1 = (w, id, over = {}) => card(w, id, { tier: 1, plan_sha256: SHA, main_commit: w.M0, ...over });
const asks = (w) => askStore(w.t.record).asks();
const later = (w, ms) => { w.t.clock.t += ms; };
// M2 closing an ask, as the same actor (its writeDoc is fenced to its own folder).
function close(w, id, state) { const a = askStore(w.t.record).ask(id); if (state === 'expired') must(w.t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: a.rev, doc: { ...a.doc, state: 'open', reask_count: 1, lapsed_at: new Date(w.t.clock.t).toISOString() } })); const b = askStore(w.t.record).ask(id); must(w.t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: b.rev, doc: { ...b.doc, state } })); }
// The Lead changes the card's plan.
function replan(w, id, files) {
  const c = w.t.record.read('card', id);
  const to = files ?? [...c.doc.files, 'src/b.mjs'];
  // A card made from a plan file is changed only by a plan file (L490 m2).
  if (!c.doc.plan_sha256) { must(roadmap(w.t, { id, expectRev: c.rev, fields: { files: to } })); return; }
  const d = c.doc;
  must(planFile(w.t, [{ id, tier: d.tier, module: d.module, depends_on: d.depends_on, brief: { goal: d.what, done_when: d.done_when, files: to } }], { head: d.main_commit }));
}

// The owner's tap on a go box, as M2's binding records it. M2's writeDoc is fenced to its own folder, so this writes as
// the same actor directly.
function answer(w, id, choice, approves) {
  const put = (doc) => { const a = askStore(w.t.record).ask(id); must(w.t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: a.rev, doc: { ...a.doc, ...doc } })); };
  put({ state: 'pushed', raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0 });
  put({ state: 'answered', answer: { channel: 'tap', choice, approves, session_id: 'S-1', tool_use_id: 'toolu_1', at: new Date(w.t.clock.t).toISOString() } });
}

test('Tier 2: asked with no plan check and no reviewer, once', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 1);
  assert.equal(asks(w)[0].doc.kind, 'go_t2');
  assert.equal(asks(w)[0].doc.plan_check, undefined);
  assert.equal(w.started.length, 0);
});

// A3a: the wired planRows, reading the row files among the card's files from GitHub at main, gives M2 rows its go checks accept, and a row
// file whose pass test has drifted from the card's bar is told, never asked on.
function githubRows(w, files) {
  const base = '/repos/sample-org/sample-app';
  const gh = { get: async (p) => {
    if (p === `${base}/git/ref/heads/main`) return { status: 200, json: { object: { sha: 'f'.repeat(40) } } };
    const m = new RegExp(`^${base}/contents/docs/blueprint/rows/([^/?]+)\\.yaml\\?ref=${'f'.repeat(40)}$`).exec(p);
    if (m && files[m[1]] !== undefined) return { status: 200, json: { encoding: 'base64', content: Buffer.from(files[m[1]]).toString('base64') } };
    return { status: 404, json: null };
  } };
  return planRows({ gh, entry: { product: PRODUCT, owner: 'sample-org', repo: 'sample-app' }, rec: w.t.record });
}
test('A3a: the wired planRows reads rows M2 asks a go on; a drifted, missing or unnamed row is told, not asked', async () => {
  const files = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
  const w = world();
  card(w, 'A', { files });
  const yaml = (id, done) => `id: ${id}\nwhat: row ${id}\nmodule: M1\ntier: 2\ndone_when: ${done}\nstatus: planned\n`;
  await pass(w, { planRows: githubRows(w, { 'R-1': yaml('R-1', ROWS['R-1'].done_when) }) });
  assert.equal(asks(w).length, 1, w.sent.join(' | '));
  const w2 = world();
  card(w2, 'A', { files });
  await pass(w2, { planRows: githubRows(w2, { 'R-1': yaml('R-1', 'a different test') }) });
  assert.equal(asks(w2).length, 0);
  assert.ok(w2.sent.some((s) => /card A could not be asked for a go: the card's done_when is not its rows' pass tests/.test(s)), w2.sent.join(' | '));
  const w3 = world();
  card(w3, 'A', { files });
  await pass(w3, { planRows: githubRows(w3, {}) });
  assert.equal(asks(w3).length, 0);
  assert.ok(w3.sent.some((s) => /planRows: row R-1 is missing at main fffffff/.test(s)), w3.sent.join(' | '));
  const w4 = world();
  card(w4, 'A');
  await pass(w4, { planRows: githubRows(w4, { 'R-1': yaml('R-1', ROWS['R-1'].done_when) }) });
  assert.equal(asks(w4).length, 0);
  assert.ok(w4.sent.some((s) => /card A names no row file/.test(s)), w4.sent.join(' | '));
});

test('only the root is asked: a fix card runs on its root\'s go', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  // A real fix card is made only from a merged round; here the same doc shape, as the Record would hand it back.
  const rec = { ...w.t.record, list: (e) => w.t.record.list(e).map((c) => (e === 'card' && c.id === 'B' ? { ...c, doc: { ...c.doc, fix_of: 'A' } } : c)) };
  await pass(w, {}, { record: rec });
  assert.deepEqual(asks(w).map((a) => a.doc.card), ['A']);
});

test('L443: a go-free kind by its allowed creator is not asked; by the wrong creator it is', async () => {
  const on = { 'approvals.plan_go.go_free.lead_daily_card': ['*.md'] };
  const w = world(on);
  card(w, 'A', { kind: 'lead_daily_card' });
  await pass(w);
  assert.equal(asks(w).length, 0, 'made by its allowed creator');
  const rec = { ...w.t.record, meta: (e, id) => ({ ...w.t.record.meta(e, id), createdBy: 'dispatcher' }) };
  await pass(w, {}, { record: rec });
  assert.deepEqual(asks(w).map((a) => a.doc.card), ['A'], 'made by the wrong creator');
});

test('a card with a go on its plan, or past draft, is left alone', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Go', true);
  await pass(w);
  assert.ok(w.t.record.read('go', 'go-A'));
  await pass(w);
  assert.equal(asks(w).length, 1);
});

test('L442 ruling 2: a Tier-1 card with no plan hash or main commit is left alone and told once a day per card', async () => {
  const w = world();
  card(w, 'A', { tier: 1 });
  card(w, 'B', { tier: 1, plan_sha256: SHA });
  await pass(w);
  await pass(w);
  assert.equal(w.sent.filter((s) => /card A is Tier 1/.test(s)).length, 1);
  assert.equal(w.sent.filter((s) => /card B is Tier 1/.test(s)).length, 1);
  later(w, 23 * HOUR);
  await pass(w);
  assert.equal(w.sent.filter((s) => /card A is Tier 1/.test(s)).length, 1, 'a whole day apart, not just a few ticks');
  later(w, 2 * HOUR);
  await pass(w);
  assert.equal(w.sent.filter((s) => /card A is Tier 1/.test(s)).length, 2);
  assert.equal(asks(w).length, 0);
  assert.equal(w.started.length, 0);
});

test('Tier 1: one fresh reviewer per plan, and a pass from its answer raises the go with the plan check', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0].lead, PLAN_REVIEW_LEAD);
  assert.equal(w.started[0].card, 'A');
  assert.equal(asks(w).length, 0, 'never raised without a pass');
  await pass(w);
  assert.equal(w.started.length, 1, 'no second reviewer');
  assert.equal(asks(w).length, 0, 'still working');
  assert.deepEqual(w.sent, [], 'a reviewer at work is nothing to tell');
  assert.equal(w.answers[0].session, 'S-review');
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  const [a] = asks(w);
  assert.equal(a.doc.kind, 'go_t1');
  assert.equal(a.doc.plan_check.reviewer_session, 'S-review');
  assert.equal(a.doc.plan_check.author_session, 'L-1');
  assert.equal(a.doc.plan_check.pass, true);
  await pass(w);
  assert.equal(w.started.length, 1);
  assert.equal(asks(w).length, 1);
});

test('L440: nothing in the Record can stand in for the reviewer\'s answer', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  const fact = PLAN_REVIEW_FACT('A');
  const cur = w.t.record.read('fact', fact);
  must(w.t.record.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: cur.rev, doc: { ...cur.doc, pass: true, material: 0, answer: 'PASS' } }));
  await pass(w);
  assert.equal(asks(w).length, 0);
  w.answer = { ok: true, answer: '1. Is the file list right?' };
  await pass(w);
  assert.equal(asks(w).length, 0, 'the fact says PASS, the reviewer did not');
  assert.ok(w.sent.some((s) => /did not pass card A: Is the file list right/.test(s)), w.sent.join(' | '));
});

test('a new plan gets a new review', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  const { doc } = w.t.record.read('card', 'A');
  must(planFile(w.t, [{ id: 'A', tier: 1, module: doc.module, depends_on: [], brief: { goal: 'a changed plan', done_when: doc.done_when, files: doc.files } }], { head: w.M0 }));
  await pass(w);
  assert.equal(w.started.length, 2);
  assert.notEqual(w.started[0].fingerprint, w.started[1].fingerprint);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  assert.notEqual(w.t.record.read('card', 'A').doc.plan_sha256, doc.plan_sha256);
  assert.equal(asks(w)[0].doc.plan_check.plan_sha256, w.t.record.read('card', 'A').doc.plan_sha256);
});

for (const [name, setup, told] of [
  ['a question', (w) => { w.answer = { ok: true, answer: '1. Is the file list right?' }; }, /plan reviewer did not pass card A: Is the file list right\?/],
  ['an unreadable answer', (w) => { w.answer = { ok: true, answer: 'looks fine to me' }; }, /answer on card A could not be read/],
  ['an answer that can\'t be fetched', (w) => { w.answer = { ok: false, reason: 'no such file' }; }, /answer on card A could not be read: no such file/],
]) {
  test(`L440: ${name} reaches the owner once a day, and no go is raised`, async () => {
    const w = world();
    t1(w, 'A');
    await pass(w);
    setup(w);
    await pass(w);
    await pass(w);
    assert.equal(w.sent.filter((s) => told.test(s)).length, 1, w.sent.join(' | '));
    later(w, 25 * HOUR);
    await pass(w);
    assert.equal(w.sent.filter((s) => told.test(s)).length, 2);
    assert.equal(asks(w).length, 0);
  });
}

test('a reviewer that can\'t start is told, is tried again, and nothing is raised', async () => {
  const w = world();
  t1(w, 'A');
  const refused = { startPlanReview: async () => ({ ok: false, reason: 'outage: nothing starts' }) };
  await pass(w, refused);
  await pass(w, refused);
  assert.equal(w.sent.filter((s) => /no plan reviewer could start for card A.*outage: nothing starts/.test(s)).length, 1);
  await pass(w);
  assert.equal(w.started.length, 1);
  assert.equal(asks(w).length, 0);
});

// #294 r3 m1: a plan the runner holds at the cap has no reviewer yet, so it is told as waiting for a slot, after the
// same hour, and never as a reviewer that has not answered.
test('a plan waiting at the plan reviewers\' cap is told as waiting for a slot, not as a silent reviewer', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  const slot = { planReviewAnswer: async () => ({ ok: true, waiting: 'slot' }) };
  later(w, PLAN_REVIEW_SLOW_MS - 1);
  await pass(w, slot);
  assert.equal(w.sent.filter((s) => /waiting for a reviewer slot/.test(s)).length, 0, 'not before the hour');
  later(w, 1);
  await pass(w, slot);
  assert.equal(w.sent.filter((s) => /card A's plan is waiting for a reviewer slot/.test(s)).length, 1);
  assert.equal(w.sent.filter((s) => /has not answered yet/.test(s)).length, 0);
  assert.equal(asks(w).length, 0);
});

test('a reviewer silent for over an hour is told; before that it is not', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  later(w, PLAN_REVIEW_SLOW_MS - 1);
  await pass(w);
  assert.equal(w.sent.filter((s) => /has not answered yet/.test(s)).length, 0);
  later(w, 1);
  await pass(w);
  assert.equal(w.sent.filter((s) => /has not answered yet/.test(s)).length, 1);
});

test('L442 ruling 3: a plan not written by a named session gets no pass, and the owner is told', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  const rec = { ...w.t.record, diary: () => [{ actor: 'dispatcher', writes: [{ entity: 'card', id: 'A', doc: {} }] }] };
  await pass(w, {}, { record: rec });
  assert.ok(w.sent.some((s) => /plan was last written by dispatcher, not a named session/.test(s)), w.sent.join(' | '));
  assert.equal(asks(w).length, 0);
});

test('L442 ruling 3: the reviewer may not be the plan\'s author', async () => {
  const w = world();
  w.reviewer = 'L-1';
  t1(w, 'A');
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  assert.ok(w.sent.some((s) => /checked by the session that wrote it/.test(s)), w.sent.join(' | '));
  assert.equal(asks(w).length, 0);
});

test('planAuthor: the latest write that changed the plan, not the latest write', () => {
  const line = (actor, doc, id = 'A') => ({ actor, writes: [{ entity: 'card', id, doc }] });
  const lines = [line('lead:S-1', { files: ['a'] }), line('lead:S-2', { files: ['b'] }), line('dispatcher', { files: ['b'], state: 'ready' }), line('lead:S-3', { files: ['z'] }, 'B')];
  assert.equal(planAuthor(lines, 'A'), 'lead:S-2');
  assert.equal(planAuthor(lines, 'none'), null);
  assert.equal(namedSession('lead:S-2'), 'S-2');
  for (const a of ['dispatcher', 'lead:', ':S', null]) assert.equal(namedSession(a), null);
});

test('a refused raise is told once a day and the next card still runs', async () => {
  const w = world();
  card(w, 'A', { done_when: 'not the bar' });
  card(w, 'B');
  await pass(w);
  await pass(w);
  assert.equal(w.sent.filter((s) => /card A could not be asked for a go/.test(s)).length, 1, w.sent.join(' | '));
  assert.deepEqual(asks(w).map((a) => a.doc.card), ['B']);
});

test('one card whose port throws does not stop the next, and it is told', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await pass(w, { planRows: async ({ card: c }) => { if (c === 'A') throw new Error('rows gone'); return ROWS; } });
  assert.ok(w.sent.some((s) => /asking for a go on card A failed: planRows: rows gone/.test(s)), w.sent.join(' | '));
  assert.deepEqual(asks(w).map((a) => a.doc.card), ['B']);
});

test('L442 ruling 5: an answered go becomes the go record, and its ask is closed once', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const id = asks(w)[0].id;
  answer(w, id, 'Go', true);
  const r = await pass(w);
  assert.ok(r.events.includes('go go-A'), r.events.join(' | '));
  assert.equal(w.t.record.read('go', 'go-A').doc.ask, id);
  assert.equal(askStore(w.t.record).ask(id).doc.state, 'consumed');
  const rev = w.t.record.read('go', 'go-A').rev;
  const again = await pass(w);
  assert.equal(again.events.length, 0);
  assert.equal(w.t.record.read('go', 'go-A').rev, rev);
});

test('L442 ruling 5: a go that can\'t be recorded is told once a day, and no go is written', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Go', true);
  const rec = { ...w.t.record, write: (x) => (x.entity === 'go' ? { ok: false, reason: 'disk full' } : w.t.record.write(x)) };
  await pass(w, {}, { record: rec });
  await pass(w, {}, { record: rec });
  assert.equal(w.sent.filter((s) => /owner's go on card A could not be recorded: the record refused the go: disk full/.test(s)).length, 1, w.sent.join(' | '));
  assert.equal(w.t.record.read('go', 'go-A'), null);
});

test('L462 m6: answers that can\'t be read are told under the product, and the cards still run', async () => {
  const w = world();
  card(w, 'A');
  const rec = { ...w.t.record, list: (e) => { if (e === 'ask') throw new Error('asks unreadable'); return w.t.record.list(e); } };
  await assert.doesNotReject(pass(w, {}, { record: rec }));
  assert.ok(w.sent.some((s) => /answered gos could not be read/.test(s)), w.sent.join(' | '));
});

test('L462 m1: a go on a plan the card moved on from is left alone, and the card\'s new go is not told about it', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Go', true);
  replan(w, 'A');
  await pass(w);
  assert.equal(w.t.record.read('go', 'go-A'), null, 'a go on the old plan is not the new plan\'s');
  answer(w, asks(w).find((a) => a.doc.state === 'open').id, 'Go', true);
  await pass(w);
  assert.ok(w.t.record.read('go', 'go-A'));
  for (let d = 0; d < 5; d += 1) { later(w, 25 * HOUR); await pass(w); }
  assert.deepEqual(w.sent, []);
});

test('L462 m1: an answered ask is left alone once another ask gave this plan its go', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const [a] = asks(w);
  answer(w, a.id, 'Go', true);
  const { fingerprint: plan_fingerprint, fingerprint_inputs, rows, tier, files } = a.doc;
  const at = new Date(w.t.clock.t).toISOString();
  must(w.t.record.write({ actor: 'approvals', entity: 'go', id: 'go-A', expectRev: 0, doc: { product: PRODUCT, card_id: 'A', plan_fingerprint, fingerprint_inputs, ask: 'go-A-other', binding: { kind: 'tap', session_id: 'S-1', tool_use_id: 't', at },
    rows, tier, files, done_bar: fingerprint_inputs.done_bar, main_commit: null, rechecked: [], at } }));
  const r = await pass(w);
  assert.deepEqual(r.events, ['ready A'], 'no second go; the go it has moves the card on');
  assert.equal(w.t.record.read('go', 'go-A').doc.ask, 'go-A-other');
  assert.equal(askStore(w.t.record).ask(a.id).doc.state, 'answered');
});

test('L450: a declined plan is not asked again, its Lead hears once, and the owner\'s hold tell lists it daily', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Not now', false);
  await pass(w);
  await pass(w);
  assert.equal(w.t.record.read('go', 'go-A'), null);
  assert.equal(asks(w).length, 1);
  assert.equal(w.replies.length, 1, 'told once, not on every tick');
  assert.equal(w.replies[0].lead, 'L-1');
  assert.match(w.replies[0].text, /declined the plan for card A/);
  assert.equal(w.sent.filter((s) => /declined card A/.test(s)).length, 1);
  later(w, 25 * HOUR);
  await pass(w);
  assert.equal(asks(w).length, 1, 'a day later it is still not asked');
  assert.equal(w.replies.length, 1);
  assert.equal(w.sent.filter((s) => /declined card A/.test(s)).length, 2, 'the hold tell comes back daily');
});

test('L450: a changed plan after a decline is a new ask', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Not now', false);
  await pass(w);
  replan(w, 'A');
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 2);
  assert.notEqual(asks(w)[0].doc.fingerprint, asks(w)[1].doc.fingerprint);
});

for (const [name, said] of [['false', false], ['nothing', undefined], ['ok: false', { ok: false, reason: 'no room' }]]) {
  test(`L462 m4: a Lead note answered with ${name} is not delivered: it is tried again`, async () => {
    const w = world();
    card(w, 'A');
    await pass(w);
    answer(w, asks(w)[0].id, 'Not now', false);
    let tries = 0;
    const replyToLead = async () => { tries += 1; return said; };
    await pass(w, { replyToLead });
    await pass(w, { replyToLead });
    assert.equal(tries, 2);
    assert.equal(w.t.record.read('fact', PLAN_ASK_FACT('A'))?.doc.lead_heard_at, undefined);
    assert.equal(w.sent.filter((s) => /Lead could not be told/.test(s)).length, 1);
  });
}

test('L450: a Lead that could not be told is tried again, and the owner hears why', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Not now', false);
  let tries = 0;
  await pass(w, { replyToLead: async () => { tries += 1; throw new Error('note folder gone'); } });
  assert.equal(tries, 1);
  assert.equal(w.sent.filter((s) => /Lead could not be told .*note folder gone/.test(s)).length, 1);
  await pass(w);
  assert.equal(w.replies.length, 1, 'the mark is kept only once it heard');
  await pass(w);
  assert.equal(w.replies.length, 1);
});

test('L450: an ask that ran out is asked again at most once in 24 hours, and listed meanwhile', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  assert.equal(w.t.record.read('fact', PLAN_ASK_FACT('A')).doc.fingerprint, asks(w)[0].doc.fingerprint);
  close(w, asks(w)[0].id, 'expired');
  later(w, HOUR);
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 1, 'no re-ask on every tick');
  assert.equal(w.sent.filter((s) => /ran out with no answer/.test(s)).length, 1);
  later(w, GO_REASK_MS - HOUR - 1);
  await pass(w);
  assert.equal(asks(w).length, 1, 'just under a day from the ask');
  later(w, 1);
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 2, 'asked once more, and only once');
});

test('L450: with the asked-at mark gone or unreadable, the ask\'s own time holds the 24 hours', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const f = w.t.record.read('fact', PLAN_ASK_FACT('A'));
  must(w.t.record.write({ actor: 'dispatcher', entity: 'fact', id: PLAN_ASK_FACT('A'), expectRev: f.rev, doc: { ...f.doc, asked_at: 'not a time' } }));
  close(w, asks(w)[0].id, 'expired');
  await pass(w);
  assert.equal(asks(w).length, 1);
  later(w, GO_REASK_MS);
  await pass(w);
  assert.equal(asks(w).length, 2);
});

test('L450: a withdrawn ask is asked again only for a new plan, and listed meanwhile', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  close(w, asks(w)[0].id, 'withdrawn');
  later(w, 2 * GO_REASK_MS);
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 1);
  assert.equal(w.sent.filter((s) => /was withdrawn/.test(s)).length, 1);
  assert.equal(w.replies.length, 0, 'the system withdrew it: the Lead has nothing to change');
  replan(w, 'A');
  await pass(w);
  assert.equal(asks(w).length, 2);
});

test('L450: the latest ask decides: expired then declined stays declined', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  close(w, asks(w)[0].id, 'expired');
  later(w, GO_REASK_MS);
  await pass(w);
  const again = asks(w).find((a) => a.doc.state === 'open');
  answer(w, again.id, 'Not now', false);
  later(w, 2 * GO_REASK_MS);
  await pass(w);
  assert.equal(asks(w).length, 2);
  assert.equal(w.replies.length, 1);
});

test('L462 M1: a go ask nobody answers is told daily, naming the card and the ask, and never asked twice', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const told = () => w.sent.filter((s) => s.includes('card A') && s.includes(asks(w)[0].id)).length;
  later(w, GO_REASK_MS - 1);
  await pass(w);
  assert.deepEqual(w.sent, [], 'under a day old: nothing to tell');
  later(w, 1);
  await pass(w);
  await pass(w);
  assert.equal(told(), 1);
  later(w, 23 * HOUR);
  await pass(w);
  assert.equal(told(), 1, 'once a day');
  later(w, 2 * HOUR);
  await pass(w);
  assert.equal(told(), 2);
  assert.equal(asks(w).length, 1);
});

test('L462 M1: the age is from the first push, then the raise, then the ask itself', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const [a] = asks(w);
  const put = (doc) => must(w.t.record.write({ actor: 'approvals', entity: 'ask', id: a.id, expectRev: askStore(w.t.record).ask(a.id).rev, doc: { ...askStore(w.t.record).ask(a.id).doc, ...doc } }));
  later(w, 3 * GO_REASK_MS);
  put({ state: 'pushed', raised_at: new Date(w.t.clock.t - HOUR).toISOString(), first_pushed_at: new Date(w.t.clock.t - 2 * HOUR).toISOString(), raised_reask: 0 });
  await pass(w);
  assert.deepEqual(w.sent, [], 'pushed two hours ago');
  put({ first_pushed_at: 'not a time' });
  await pass(w);
  assert.deepEqual(w.sent, [], 'raised an hour ago');
  put({ raised_at: 'not a time' });
  await pass(w);
  assert.equal(w.sent.length, 1, 'only the ask\'s own time is left');
});

test('L462 M1, L523: on real M2 scheduling, one push a day, and the owner hears daily with no answer', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const pushes = [];
  w.t.ctx.stateDir = join(w.t.base, 'm2-state');
  mkdirSync(w.t.ctx.stateDir, { recursive: true });
  w.t.ctx.push = async (e) => { pushes.push(e); return true; };
  for (let i = 0; i < 4 * 48; i += 1) { later(w, HOUR / 2); await schedulePass(w.t.ctx); await pass(w); }
  assert.equal(pushes.length, 4, 'one push a day over four days, never one a pass');
  assert.equal(asks(w).length, 1);
  assert.ok(w.sent.filter((s) => s.includes('card A')).length >= 3, w.sent.join(' | '));
});

test('L450: a live ask under a day old is left waiting, told nothing', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  later(w, HOUR);
  await pass(w);
  assert.equal(asks(w).length, 1);
  assert.deepEqual(w.sent, []);
});

test('L462 m2: a changed plan withdraws the older live ask, and only that one stays to answer', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  replan(w, 'A', ['src/a.mjs', 'src/b.mjs']);
  await pass(w);
  replan(w, 'A', ['src/a.mjs', 'src/c.mjs']);
  await pass(w);
  const [one, two, three] = asks(w);
  assert.deepEqual([one, two, three].map((a) => a.doc.state), ['withdrawn', 'withdrawn', 'open']);
  assert.equal(one.doc.withdrawn_for, two.doc.fingerprint);
  assert.equal(two.doc.withdrawn_for, three.doc.fingerprint);
  later(w, 25 * HOUR);
  await pass(w);
  assert.equal(asks(w).length, 3, 'the live plan is not asked again');
  assert.ok(!w.sent.some((s) => /withdrawn/.test(s)), w.sent.join(' | '));
});

test('L462 m2: a withdrawn ask\'s open question box is released, so a late tap counts nothing', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const [a] = asks(w);
  const box = { session_id: 'S-1', tool_use_id: 'toolu_1', status: 'bound', bound_at: new Date(w.t.clock.t).toISOString(), version: 'first' };
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id: a.id, expectRev: a.rev, doc: { ...a.doc, state: 'pushed', raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0, boxes: [box] } }));
  replan(w, 'A');
  await pass(w);
  const [old] = askStore(w.t.record).ask(a.id).doc.boxes;
  assert.equal(old.status, 'released');
  assert.equal(old.reason, 'withdrawn');
});

test('L462 m2: a go on the newest ask still starts from there, with the old ones withdrawn', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  replan(w, 'A');
  await pass(w);
  const live = asks(w).find((a) => a.doc.state === 'open');
  answer(w, live.id, 'Go', true);
  await pass(w);
  assert.equal(w.t.record.read('go', 'go-A').doc.ask, live.id);
});

test('L462 m2: plan A, then B, then A again before any answer: A is asked again', async () => {
  const w = world();
  const files = card(w, 'A').files;
  await pass(w);
  replan(w, 'A');
  await pass(w);
  replan(w, 'A', files);
  await pass(w);
  await pass(w);
  assert.deepEqual(asks(w).map((a) => a.doc.state), ['withdrawn', 'withdrawn', 'open']);
  assert.equal(asks(w)[2].doc.fingerprint, asks(w)[0].doc.fingerprint);
  assert.deepEqual(w.sent, []);
});

test('L462 m2: a Tier-1 ask\'s pull request is closed when a new plan replaces it', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  const [a] = asks(w);
  const closed = [];
  const gh = { ...w.t.ctx.gh, patch: async (path, body) => { closed.push([path, body]); return { status: 200 }; } };
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id: a.id, expectRev: a.rev, doc: { ...a.doc, state: 'pushed', pr: 7, raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0 } }));
  replan(w, 'A');
  await pass(w, {}, { gh });
  assert.equal(asks(w).length, 1, 'a new plan is reviewed before it replaces the ask');
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w, {}, { gh });
  await pass(w, {}, { gh });
  assert.equal(askStore(w.t.record).ask(a.id).doc.state, 'withdrawn');
  assert.deepEqual(closed, [['/repos/sample-org/sample-app/pulls/7', { state: 'closed' }]]);
});

test('L462 m2: an old ask that can\'t be withdrawn stops the raise, is told, and is tried again', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  replan(w, 'A');
  const rec = { ...w.t.record, write: (x) => (x.entity === 'ask' && x.doc?.state === 'withdrawn' ? { ok: false, reason: 'disk full' } : w.t.record.write(x)) };
  await pass(w, {}, { record: rec });
  assert.equal(asks(w).length, 1, 'no second live ask');
  assert.ok(w.sent.some((s) => /card A could not be asked for a go: .*could not be withdrawn: disk full/.test(s)), w.sent.join(' | '));
  await pass(w);
  assert.deepEqual(asks(w).map((a) => a.doc.state), ['withdrawn', 'open']);
});

test('L462 m3: a fix card its root\'s go doesn\'t cover is told daily, naming the root and why', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B', { files: ['src/a.mjs', 'src/z.mjs'] });
  const fix = (c) => (c?.id === 'B' ? { ...c, doc: { ...c.doc, fix_of: 'A' } } : c);
  const rec = { ...w.t.record, list: (e) => w.t.record.list(e).map((c) => (e === 'card' ? fix(c) : c)), read: (e, id) => (e === 'card' ? fix(w.t.record.read(e, id)) : w.t.record.read(e, id)) };
  await pass(w, {}, { record: rec });
  answer(w, asks(w)[0].id, 'Go', true);
  await pass(w, {}, { record: rec });
  assert.ok(w.t.record.read('go', 'go-A'));
  const told = () => w.sent.filter((s) => /card B runs on root card A's go, so it waits.*no go from the owner matches/.test(s)).length;
  await pass(w, {}, { record: rec });
  assert.equal(told(), 1, w.sent.join(' | '));
  later(w, 23 * HOUR);
  await pass(w, {}, { record: rec });
  assert.equal(told(), 1);
  later(w, 2 * HOUR);
  await pass(w, {}, { record: rec });
  assert.equal(told(), 2);
  assert.equal(asks(w).length, 1);
});

for (const [port, setup] of [
  ['startPlanReview', (w) => t1(w, 'A')],
  ['planRows', (w) => card(w, 'A')],
  ['planView', (w) => card(w, 'A')],
  ['mainSha', (w) => card(w, 'A')],
]) {
  test(`L462 m5: a ${port} that hangs is told under its card, and the next card still runs`, () => ownClock(async () => {
    const w = world();
    setup(w);
    card(w, 'B');
    const real = w.ports[port];
    let first = true;
    const hangsOnce = (x) => { if (!first) return real(x); first = false; return new Promise(() => {}); };
    await pass(w, { portMs: 20, passMs: 2000, [port]: hangsOnce });
    assert.ok(w.sent.some((s) => new RegExp(`card A failed: ${port}: it did not answer within 20 ms`).test(s)), w.sent.join(' | '));
    assert.deepEqual(asks(w).map((a) => a.doc.card), ['B']);
  }));
}

test('L462 m5: a planReviewAnswer or replyToLead that hangs costs only its limit, and is told', () => ownClock(async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  await pass(w, { portMs: 20, passMs: 2000, planReviewAnswer: () => new Promise(() => {}) });
  assert.ok(w.sent.some((s) => /card A failed: planReviewAnswer: it did not answer within 20 ms/.test(s)), w.sent.join(' | '));
  const v = world();
  card(v, 'A');
  await pass(v);
  answer(v, asks(v)[0].id, 'Not now', false);
  await pass(v, { portMs: 20, passMs: 2000, replyToLead: () => new Promise(() => {}) });
  assert.ok(v.sent.some((s) => /Lead could not be told .*replyToLead: it did not answer within 20 ms/.test(s)), v.sent.join(' | '));
}));

test('L462: a port not wired yet is told once for the product, not once per card', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await pass(w, { planRows: async () => { throw new Error('not wired yet: planRows (R-0b-162)'); } });
  assert.equal(w.sent.filter((s) => /not wired yet/.test(s)).length, 1, w.sent.join(' | '));
  assert.match(w.sent[0], new RegExp(`no go can be asked on product ${PRODUCT}`));
  const v = world();
  card(v, 'A');
  await pass(v);
  answer(v, asks(v)[0].id, 'Not now', false);
  await pass(v, { replyToLead: async () => { throw new Error('not wired yet: replyToLead (R-0b-162)'); } });
  assert.ok(v.sent.some((s) => /no go can be asked on product/.test(s)), v.sent.join(' | '));
  assert.ok(!v.sent.some((s) => /Lead could not be told/.test(s)), v.sent.join(' | '));
});

test('L462: a review that started but could not be noted has its own tell, and hides no refused start', async () => {
  const w = world();
  t1(w, 'A');
  const rec = { ...w.t.record, write: (x) => (x.entity === 'fact' && x.id === PLAN_REVIEW_FACT('A') && x.doc?.session ? { ok: false, reason: 'disk full' } : w.t.record.write(x)) };
  await pass(w, {}, { record: rec });
  assert.ok(w.sent.some((s) => /started but could not be noted/.test(s)), w.sent.join(' | '));
  await pass(w);
  assert.equal(w.started.length, 1, 'the unconfirmed start is not repeated');
  later(w, PLAN_START_HOLD_MS);
  await pass(w, { startPlanReview: async () => ({ ok: false, reason: 'outage' }) });
  assert.ok(w.sent.some((s) => /no plan reviewer could start/.test(s)), w.sent.join(' | '));
});

test('L462: with no diary line for the plan, the tell says so plainly', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w, {}, { record: { ...w.t.record, diary: () => [] } });
  assert.ok(w.sent.some((s) => /the diary doesn't say who wrote card A's plan/.test(s)), w.sent.join(' | '));
  assert.ok(!w.sent.some((s) => /no reason given/.test(s)));
});

test('L450: plan A, then B, then A again asks for A again, as its go was replaced', async () => {
  const w = world();
  // It stays in draft through all this only because it waits on a dependency: a card with a go otherwise moves to ready.
  seed(w.t, 'card', 'D', { state: 'running', product: PRODUCT });
  const files = card(w, 'A', { depends_on: ['D'] }).files;
  const yes = async () => { answer(w, asks(w).find((a) => a.doc.state === 'open').id, 'Go', true); await pass(w); };
  await pass(w);
  await yes();
  replan(w, 'A');
  await pass(w);
  await yes();
  replan(w, 'A', files);
  await pass(w);
  await pass(w);
  assert.equal(asks(w).length, 3);
  await yes();
  assert.equal(w.t.record.read('go', 'go-A').doc.plan_fingerprint, asks(w)[0].doc.fingerprint);
  await pass(w);
  assert.equal(asks(w).length, 3, 'its go is back: nothing more to ask');
});

test('another product\'s card and ask are left alone', async () => {
  const w = world();
  card(w, 'A');
  await pass(w, {}, { product: `${PRODUCT}-other` });
  assert.equal(asks(w).length, 0);
  await pass(w);
  answer(w, asks(w)[0].id, 'Go', true);
  await pass(w, {}, { product: `${PRODUCT}-other` });
  assert.equal(w.t.record.read('go', 'go-A'), null);
  assert.deepEqual(w.sent, []);
});

test('a card past draft is not asked', async () => {
  const w = world();
  card(w, 'A');
  const rec = { ...w.t.record, list: (e) => w.t.record.list(e).map((c) => (e === 'card' ? { ...c, doc: { ...c.doc, state: 'ready' } } : c)) };
  await pass(w, {}, { record: rec });
  assert.equal(asks(w).length, 0);
});

// ---- L467: a pass under a hang. Each tick is its own process: when the step ends, main exits, so a pass cut off by the
// product's deadline writes nothing more. Time is scaled down by 20, the same ratio as the real limits. These tests run on
// the test's own clock (ownClock), so only a hang costs time, never the Record's writes or a busy machine.
const SCALED = { portMs: PLAN_PORT_MS / 20, productMs: APPROVALS_PRODUCT_MS / 20 };
const ROOMY_MS = 60_000;
const ids10 = Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);

// `wallMs`: the step's limit. Under ownClock it runs on the test's clock with the pass's budget, so `stepError` says whether
// the pass stopped in time; under timeJumps it runs on real time, so those tests give it room.
async function tickAsProcess(w, over, wallMs = SCALED.productMs) {
  const now = w.t.clock.t;
  let alive = true;
  const base = w.t.record;
  const rec = Object.create(base, { write: { value: (x) => (alive ? base.write(x) : { ok: false, reason: 'process gone' }) } });
  const before = w.sent.length;
  w.stepError = null;
  await approvalsStep({ rec, rules: w.t.ctx.rules, now, alert: outbox(rec, now), approvals: () => [{ ...w.t.ctx }], what: 'plan-go', productMs: wallMs,
    pass: (ctx) => planGoPass(ctx, { ...w.ports, alert: outbox(rec, now), portMs: SCALED.portMs, passMs: SCALED.productMs, ...over }) }).catch((e) => { w.stepError = e.message; });
  alive = false;
  await sendAlerts(base, async (text) => { w.sent.push(text); return true; }, now);
  const told = w.sent.slice(before);
  return ids10.filter((id) => told.some((s) => new RegExp(`card ${id}\\b`).test(s)));
}

const hangsFor = (w, who) => (x) => (who(x.card) ? new Promise(() => {}) : w.ports.planRows(x));

test('L467: with every card hanging, the first tick names all of them and the step never fails', () => ownClock(async () => {
  const w = world();
  ids10.forEach((id) => card(w, id));
  const planRows = hangsFor(w, () => true);
  const named = await tickAsProcess(w, { planRows });
  assert.equal(w.stepError, null);
  assert.deepEqual(named, ids10, 'every card is named in the first tick');
  assert.ok(w.sent.some((s) => /card C10 was not reached/.test(s)), w.sent.join(' | '));
}));

// The second run makes each healthy call take a quarter of the product's deadline in real time, as a busy machine can: on
// the real clock the four healthy cards would use up the pass, and on the test's own it costs nothing.
for (const [busy, realMs] of [['', 0], [', on a busy machine too', SCALED.productMs / 4]]) {
  test(`L467: with the first six hanging, all are named at once, the healthy four are asked next, and the turn is kept in a fact${busy}`, () => ownClock(async () => {
    const w = world();
    ids10.forEach((id) => card(w, id));
    const planRows = (x) => {
      if (Number(x.card.slice(1)) <= 6) return new Promise(() => {});
      if (realMs) sleepMs(realMs);
      return w.ports.planRows(x);
    };
    const first = await tickAsProcess(w, { planRows });
    assert.equal(w.stepError, null);
    assert.deepEqual(first, ids10, 'all ten named in the first tick');
    assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('C01')).doc.slow_at);
    assert.equal(w.t.record.read('fact', PLAN_SLOW_FACT('C10')), null);
    later(w, HOUR);
    await tickAsProcess(w, { planRows });
    assert.equal(w.stepError, null);
    assert.deepEqual(asks(w).map((a) => a.doc.card).sort(), ['C07', 'C08', 'C09', 'C10'], w.sent.join(' | '));
  }));
}

test('L467: a card that hung stops being slow once its calls answer, and a not-reached card is told only once a day', () => ownClock(async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await pass(w, { portMs: 20, passMs: 1000, planRows: (x) => (x.card === 'A' ? new Promise(() => {}) : w.ports.planRows(x)) });
  assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('A')).doc.slow_at);
  await pass(w, { portMs: 20, passMs: 1000 });
  assert.equal(w.t.record.read('fact', PLAN_SLOW_FACT('A')).doc.slow_at, null);
  const v = world();
  card(v, 'A');
  await pass(v, { portMs: 20, passMs: 1 });
  await pass(v, { portMs: 20, passMs: 1 });
  assert.equal(v.sent.filter((s) => /card A was not reached/.test(s)).length, 1, v.sent.join(' | '));
  later(v, 25 * HOUR);
  await pass(v, { portMs: 20, passMs: 1 });
  assert.equal(v.sent.filter((s) => /card A was not reached/.test(s)).length, 2);
  assert.deepEqual(asks(v), []);
}));

test('L467: a card that needs no call still goes on once the time is up', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Go', true);
  await pass(w, { portMs: 20, passMs: 1 });
  assert.ok(askStore(w.t.record).go('go-A'), 'the go is recorded with no port at all');
  assert.ok(!w.sent.some((s) => /not reached/.test(s)), w.sent.join(' | '));
});

test('L467: a card told as not reached while time is up has no start mark left behind', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w, { portMs: 20, passMs: 1 });
  assert.equal(w.started.length, 0);
  await pass(w);
  assert.equal(w.started.length, 1);
  assert.ok(!w.sent.some((s) => /never confirmed/.test(s)), w.sent.join(' | '));
});

test('L467 m-a: a view.isDir that hangs is limited, told under its card, and the next card still runs', () => ownClock(async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  let first = true;
  const hung = { isDir: () => { if (first) { first = false; return new Promise(() => {}); } return false; } };
  await pass(w, { portMs: 20, passMs: 1000, planView: async () => hung });
  assert.ok(w.sent.some((s) => /card A could not be asked for a go: .*isDir: it did not answer within 20 ms/.test(s)), w.sent.join(' | '));
  assert.deepEqual(asks(w).map((a) => a.doc.card), ['B']);
  assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('A')).doc.slow_at);
}));

test('L467 m-a: time up before isDir counts as out of time, not as a failed read', async () => {
  const w = world();
  card(w, 'A');
  const asked = [];
  const planView = async () => ({ isDir: (sha, f) => { asked.push(f); return false; } });
  await timeJumps((jump) => pass(w, { portMs: 100, passMs: 1000, planView, mainSha: async () => { jump(); return w.M0; } }));
  assert.deepEqual(asked, []);
  assert.ok(w.sent.some((s) => /card A was not finished/.test(s)), w.sent.join(' | '));
  assert.ok(!w.sent.some((s) => /could not be asked/.test(s)), w.sent.join(' | '));
});

// Runs f on a clock the budget reads and only the test moves, so which call runs out of time doesn't depend on how fast the
// test runs or how busy the machine is. `jump(by)` sets it to that far past the start; `spend(ms)` adds a call's cost.
async function timeJumps(f) {
  const real = Date.now;
  const start = real();
  let extra = 0;
  Date.now = () => start + extra;
  try { return await f((by = 60_000) => { extra = by; }, (ms) => { extra += ms; }); } finally { Date.now = real; }
}

// Runs f with timers and Date on a clock only the test moves. It moves 1 ms at a time, and only once nothing but a timer is
// left to run, so a call that hangs costs exactly its limit, and the Record's writes, the machine's load and every call
// that answers cost nothing. The pass's budget (Date.now), each call's limit and the step's deadline (setTimeout) all read it.
async function ownClock(f) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let done = false;
  const run = Promise.resolve().then(f);
  run.then(() => { done = true; }, () => { done = true; });
  try {
    while (!done) {
      await new Promise((r) => setImmediate(r));
      if (!done) mock.timers.tick(1);
    }
    return await run;
  } finally { mock.timers.reset(); }
}

// A Tier-1 ask with a pull request, asked for plan A, and the plan moved on.
async function askWithPr(w) {
  t1(w, 'A');
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  const [a] = asks(w);
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id: a.id, expectRev: a.rev, doc: { ...a.doc, state: 'pushed', pr: 7, raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0 } }));
  replan(w, 'A');
  await pass(w);
  return a.id;
}

test('L467 m-a: a close of an old pull request that hangs is limited, and the card is told and marked slow', () => ownClock(async () => {
  const w = world();
  await askWithPr(w);
  const gh = { ...w.t.ctx.gh, patch: () => new Promise(() => {}) };
  await pass(w, { portMs: 20, passMs: 1000 }, { gh });
  assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('A')).doc.slow_at);
}));

test('L467 m-a: with no time left for the close, the old ask stays and the card is told it ran out', async () => {
  const w = world();
  const id = await askWithPr(w);
  const calls = [];
  const gh = { ...w.t.ctx.gh, patch: async (...a) => { calls.push(a); return { status: 200 }; } };
  const dirs = w.t.record.read('card', 'A').doc.files.length;
  let read = 0;
  await timeJumps((jump) => pass(w, { portMs: 100, passMs: 1000, planView: async () => ({ isDir: () => { read += 1; if (read === dirs) jump(); return false; } }) }, { gh }));
  assert.equal(read, dirs, 'every file was read, so it is the close that was stopped');
  assert.deepEqual(calls, []);
  assert.equal(askStore(w.t.record).ask(id).doc.state, 'pushed');
  assert.ok(w.sent.some((s) => /card A was not finished/.test(s)), w.sent.join(' | '));
});

test('L467 m-b: a start that hangs leaves a mark: no second start, told daily, and started again after the hold', () => ownClock(async () => {
  const w = world();
  t1(w, 'A');
  const startPlanReview = (x) => { w.started.push(x); return new Promise(() => {}); };
  await pass(w, { portMs: 20, passMs: 1000, startPlanReview });
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0].key, `A-${w.started[0].fingerprint}`);
  const told = () => w.sent.filter((s) => /plan reviewer for card A may have started, but that was never confirmed/.test(s)).length;
  await pass(w);
  await pass(w);
  assert.equal(w.started.length, 1, 'a mark under a day old counts as started');
  assert.equal(told(), 1);
  later(w, PLAN_START_HOLD_MS - HOUR);
  await pass(w);
  assert.equal(w.started.length, 1);
  later(w, HOUR);
  await pass(w);
  assert.equal(w.started.length, 2, 'after the hold the start is tried again');
}));

test('L467 m-b: the mark is on the Record before the start is called, and a mark that can\'t be written starts nothing', async () => {
  const w = world();
  t1(w, 'A');
  let seen = null;
  await pass(w, { startPlanReview: async () => { seen = w.t.record.read('fact', PLAN_REVIEW_FACT('A'))?.doc; return { ok: true, session: 'S-review' }; } });
  assert.ok(seen.starting_at);
  assert.ok(!seen.session);
  const v = world();
  t1(v, 'A');
  const rec = { ...v.t.record, write: (x) => (x.entity === 'fact' && x.id === PLAN_REVIEW_FACT('A') ? { ok: false, reason: 'disk full' } : v.t.record.write(x)) };
  await pass(v, {}, { record: rec });
  assert.equal(v.started.length, 0);
  assert.ok(v.sent.some((s) => /no plan reviewer was started for card A: the start could not be noted first: disk full/.test(s)), v.sent.join(' | '));
});

test('L467 m-b: a clear no clears the mark, so the next pass tries; a start that threw keeps it', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w, { startPlanReview: async () => ({ ok: false, reason: 'outage' }) });
  await pass(w);
  assert.equal(w.started.length, 1);
  const v = world();
  t1(v, 'A');
  await pass(v, { startPlanReview: async () => { throw new Error('connection lost'); } });
  await pass(v);
  assert.equal(v.started.length, 0);
  assert.ok(v.sent.some((s) => /never confirmed/.test(s)), v.sent.join(' | '));
});

test('L467 m-b: a start port not wired yet started nothing, so it leaves no mark', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w, { startPlanReview: async () => { throw new Error('not wired yet: startPlanReview (R-0b-162)'); } });
  await pass(w);
  assert.equal(w.started.length, 1);
});

test('L467 m-b: a new plan is not held by the old plan\'s mark', () => ownClock(async () => {
  const w = world();
  t1(w, 'A');
  await pass(w, { portMs: 20, passMs: 1000, startPlanReview: () => new Promise(() => {}) });
  replan(w, 'A');
  await pass(w);
  assert.equal(w.started.length, 1);
}));

const OPEN_PR = (id) => new RegExp(`Ask ${id} was withdrawn; approving pull request 7 won't count`);
function closingFails(w) {
  const c = { status: 500, calls: 0 };
  c.gh = { ...w.t.ctx.gh, patch: async () => { c.calls += 1; return { status: c.status }; } };
  return c;
}
function closes(w, alert, c) {
  const stateDir = join(w.t.base, 'm2-state');
  mkdirSync(stateDir, { recursive: true });
  return schedulePass({ ...w.t.ctx, stateDir, gh: c.gh, alert });
}
const told = (alert, id) => alert.texts.filter((x) => OPEN_PR(id).test(x?.text)).length;

test('L477 m3: a failed close still replaces the ask; the close is retried, the owner told daily while it stays open, and it ends when it closes', async () => {
  const w = world();
  const id = await askWithPr(w);
  const c = closingFails(w);
  await pass(w, {}, { gh: c.gh });
  assert.equal(c.calls, 1);
  const old = askStore(w.t.record).ask(id).doc;
  assert.equal(old.state, 'withdrawn');
  assert.equal(old.pr_close_due, true);
  assert.equal(asks(w).length, 2, 'the new plan is asked');
  const alert = fakeAlert();
  await closes(w, alert, c);
  await closes(w, alert, c);
  assert.equal(told(alert, id), 1, 'once a day');
  assert.equal(c.calls, 3, 'the close is tried every pass');
  later(w, 25 * HOUR);
  await closes(w, alert, c);
  assert.equal(told(alert, id), 2, 'again the next day');
  assert.equal(askStore(w.t.record).ask(id).doc.pr_close_due, true, 'telling is not closing');
  c.status = 200;
  await closes(w, alert, c);
  const done = askStore(w.t.record).ask(id).doc;
  assert.equal(done.pr_close_due, undefined);
  assert.equal(done.pr_open_told_at, undefined);
  assert.equal(done.state, 'withdrawn');
  later(w, 25 * HOUR);
  const calls = c.calls;
  await closes(w, alert, c);
  assert.equal(c.calls, calls);
  assert.equal(told(alert, id), 2);
});

test('L477 m3: a tell nobody took is not marked, so the next pass tells again', async () => {
  const w = world();
  const id = await askWithPr(w);
  const c = closingFails(w);
  await pass(w, {}, { gh: c.gh });
  await closes(w, fakeAlert({ answer: false }), c);
  assert.equal(askStore(w.t.record).ask(id).doc.pr_open_told_at, undefined);
  const alert = fakeAlert();
  await closes(w, alert, c);
  assert.equal(told(alert, id), 1);
});

test('L477 m3: an answered decision is still let go once the owner is told', async () => {
  const w = world();
  const id = await askWithPr(w);
  const a = askStore(w.t.record).ask(id);
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: a.rev, doc: { ...a.doc, state: 'answered', answer: { channel: 'github_review', choice: 'Not now', approves: false, declined: true, at: new Date(w.t.clock.t).toISOString() }, pr_close_due: true } }));
  const c = closingFails(w);
  const alert = fakeAlert();
  await closes(w, alert, c);
  assert.equal(askStore(w.t.record).ask(id).doc.pr_close_due, undefined);
  assert.ok(alert.texts.some((x) => x?.type === 'decision_pr_not_closed'));
  assert.equal(told(alert, id), 0);
});

test('L467 m-c: six calls at the port limit fit inside the product\'s deadline', () => {
  assert.ok(PLAN_PORT_MS * 6 <= APPROVALS_PRODUCT_MS);
});

test('L467: an answered go on a plan the card left counts again if the plan comes back', async () => {
  const w = world();
  const files = card(w, 'A').files;
  await pass(w);
  const first = asks(w)[0].id;
  answer(w, first, 'Go', true);
  replan(w, 'A');
  await pass(w);
  assert.equal(askStore(w.t.record).ask(first).doc.state, 'answered', 'an answered ask is not withdrawn');
  replan(w, 'A', files);
  await pass(w);
  assert.equal(askStore(w.t.record).go('go-A')?.doc.ask, first);
});

test('L467: one answered go that can\'t be recorded is told under its card, and the next is still recorded', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await pass(w);
  for (const a of asks(w)) answer(w, a.id, 'Go', true);
  const bad = asks(w).find((a) => a.doc.card === 'A').id;
  const rec = Object.create(w.t.record, { read: { value: (e, id) => { if (e === 'ask' && id === bad && rec.armed) throw new Error('ask unreadable'); return w.t.record.read(e, id); } } });
  rec.armed = true;
  await pass(w, {}, { record: rec });
  assert.ok(w.sent.some((s) => /the owner's go on card A could not be recorded: ask unreadable/.test(s)), w.sent.join(' | '));
  assert.ok(askStore(w.t.record).go('go-B'));
  assert.equal(askStore(w.t.record).go('go-A'), null);
});

test('L467: a product\'s causes can\'t be a card\'s: they carry a dot, which no card id may', async () => {
  const w = world();
  card(w, 'A');
  await pass(w, { planRows: async () => { throw new Error('not wired yet: planRows (R-0b-162)'); } });
  assert.match(JSON.stringify(w.t.record.list('fact').map((f) => f.id)), /hold-plan-go-product\./);
});

test('L477 m1: a card whose own calls use up the pass goes behind the rest, each told why, and the others are asked', async () => {
  const w = world();
  const ids = ['C01', 'C02', 'C03', 'C04'];
  card(w, 'C01', { files: Array.from({ length: 12 }, (_, i) => `src/f${i}.mjs`) });
  ids.slice(1).forEach((id) => card(w, id));
  let cur = null;
  const planRows = (x) => { cur = x.card; return w.ports.planRows(x); };
  await timeJumps(async (jump, spend) => {
    // Each of C01's calls costs 0.9 of a port limit on the test's clock: under the limit, and enough to use up the pass.
    const planView = async (x) => {
      const v = await w.ports.planView(x);
      return { isDir: (sha, f) => { if (cur !== 'C01') return v.isDir(sha, f); spend(SCALED.portMs * 0.9); return false; } };
    };
    await tickAsProcess(w, { planRows, planView }, ROOMY_MS);
    assert.equal(w.stepError, null);
    assert.deepEqual(asks(w), []);
    assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('C01')).doc.slow_at, 'it never hung, and it is still marked');
    assert.ok(w.sent.some((s) => /card C01 was not finished: this card's own calls were slow/.test(s)), w.sent.join(' | '));
    assert.ok(w.sent.some((s) => /card C02 was not reached: slow calls on C01 used up/.test(s)), w.sent.join(' | '));
    later(w, 25 * HOUR);
    await tickAsProcess(w, { planRows, planView }, ROOMY_MS);
    assert.equal(w.stepError, null);
    assert.deepEqual(asks(w).map((a) => a.doc.card).sort(), ['C02', 'C03', 'C04']);
  });
});

test('L477 m1: calls that took more than a port limit between them mark a card that finished', async () => {
  const w = world();
  card(w, 'A', { files: ['src/a.mjs', 'src/b.mjs'] });
  card(w, 'B');
  await timeJumps((jump, spend) => {
    const planView = async () => ({ isDir: () => { spend(60); return false; } });
    return pass(w, { portMs: 100, passMs: 1000, planView: async (x) => (x.product ? planView() : null) });
  });
  assert.equal(asks(w).length, 2, 'both asked');
  assert.ok(w.t.record.read('fact', PLAN_SLOW_FACT('A')).doc.slow_at);
});

test('L477 m1: a pass with nothing slow to blame says other cards, and its card keeps its place', async () => {
  const w = world();
  card(w, 'A');
  await pass(w, { passMs: 0 });
  assert.ok(w.sent.some((s) => /card A was not reached: slow calls on other cards used up/.test(s)), w.sent.join(' | '));
  assert.equal(w.t.record.read('fact', PLAN_SLOW_FACT('A')), null);
});

test('L477 m2: a start answered with no readable session keeps its mark: one start a day, not one a pass', async () => {
  const w = world();
  t1(w, 'A');
  const startPlanReview = async (x) => { w.started.push(x); return { ok: true, session: 42 }; };
  for (let i = 0; i < 47; i += 1) { await pass(w, { startPlanReview }); later(w, HOUR / 2); }
  assert.equal(w.started.length, 1);
  later(w, HOUR);
  await pass(w, { startPlanReview });
  assert.equal(w.started.length, 2, 'tried again after the hold');
});

test('L477 m2: a clear no clears the mark, so the next pass tries', async () => {
  const w = world();
  t1(w, 'A');
  const startPlanReview = async (x) => { w.started.push(x); return { ok: false, reason: 'no room' }; };
  await pass(w, { startPlanReview });
  await pass(w, { startPlanReview });
  assert.equal(w.started.length, 2);
});

test('L477 m5: a start that timed out is not started again two hours later', () => ownClock(async () => {
  const w = world();
  t1(w, 'A');
  const startPlanReview = (x) => { w.started.push(x); return new Promise(() => {}); };
  await pass(w, { portMs: 20, passMs: 1000, startPlanReview });
  later(w, 2 * HOUR);
  await pass(w, { portMs: 20, passMs: 1000, startPlanReview });
  assert.equal(w.started.length, 1);
  later(w, PLAN_START_HOLD_MS);
  await pass(w, { portMs: 20, passMs: 1000, startPlanReview });
  assert.equal(w.started.length, 2);
}));

test('L477 item (i): a go recorded on A withdraws B\'s live ask after A -> B -> A, and B coming back is asked', async () => {
  const w = world();
  const files = card(w, 'A').files;
  await pass(w);
  const a1 = asks(w)[0].id;
  answer(w, a1, 'Go', true);
  replan(w, 'A');
  await pass(w);
  const b1 = asks(w).find((a) => a.id !== a1);
  assert.equal(b1.doc.state, 'open');
  replan(w, 'A', files);
  // Held in draft here: a card that reached ready has a frozen plan (L473), so B could not come back.
  const base = w.t.record;
  const rec = Object.create(base, { write: { value: (x) => (x.entity === 'card' && x.doc?.state === 'ready' ? { ok: false, reason: 'held in draft' } : base.write(x)) } });
  await pass(w, {}, { record: rec });
  assert.equal(w.t.record.read('go', 'go-A').doc.ask, a1);
  const after = askStore(w.t.record).ask(b1.id).doc;
  assert.equal(after.state, 'withdrawn');
  assert.equal(after.withdrawn_for, askStore(w.t.record).ask(a1).doc.fingerprint);
  assert.equal(after.pr_close_due, undefined, 'a tap ask has nothing to close');
  replan(w, 'A');
  await pass(w);
  assert.equal(asks(w).length, 3, 'B is a live plan again, so it is asked');
});

test('L477 item (i): a Tier-1 ask withdrawn that way has its pull request closed by the next schedule pass', async () => {
  const w = world();
  const files = t1(w, 'A').files;
  await pass(w);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  const a1 = asks(w)[0].id;
  answer(w, a1, 'go', true);
  replan(w, 'A');
  await pass(w);
  await pass(w);
  const b = asks(w).find((a) => a.id !== a1);
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id: b.id, expectRev: b.rev, doc: { ...b.doc, state: 'pushed', pr: 7, raised_at: new Date(w.t.clock.t).toISOString(), raised_reask: 0 } }));
  replan(w, 'A', files);
  await pass(w);
  assert.equal(askStore(w.t.record).ask(b.id).doc.state, 'withdrawn');
  assert.equal(askStore(w.t.record).ask(b.id).doc.pr_close_due, true);
  const c = closingFails(w);
  c.status = 200;
  await closes(w, fakeAlert(), c);
  assert.equal(c.calls, 1);
  assert.equal(askStore(w.t.record).ask(b.id).doc.pr_close_due, undefined);
});

test('L477 item (i): a withdrawal the record refuses leaves the go\'s ask to be tried again, so none is left live', async () => {
  const w = world();
  const files = card(w, 'A').files;
  await pass(w);
  const a1 = asks(w)[0].id;
  answer(w, a1, 'Go', true);
  replan(w, 'A');
  await pass(w);
  const b1 = asks(w).find((a) => a.id !== a1).id;
  replan(w, 'A', files);
  const base = w.t.record;
  const rec = Object.create(base, { write: { value: (x) => (x.entity === 'ask' && x.id === b1 ? { ok: false, reason: 'refused' } : base.write(x)) } });
  await pass(w, {}, { record: rec });
  assert.equal(askStore(base).ask(a1).doc.state, 'answered');
  assert.ok(w.sent.some((s) => /go on card A could not be recorded: the go is recorded, but ask/.test(s)), w.sent.join(' | '));
  await pass(w);
  assert.equal(askStore(base).ask(a1).doc.state, 'consumed');
  assert.equal(askStore(base).ask(b1).doc.state, 'withdrawn');
});

test('R3: not reached has its own cause, so a card told it failed today still hears it was not reached', async () => {
  const w = world();
  card(w, 'A');
  await pass(w, { planRows: async () => { throw new Error('broke'); } });
  await pass(w, { passMs: 0 });
  assert.ok(w.sent.some((s) => /card A failed: planRows: broke/.test(s)), w.sent.join(' | '));
  assert.ok(w.sent.some((s) => /card A was not reached/.test(s)), w.sent.join(' | '));
});

test('O2: of the slow cards, the one slow longest ago goes first', async () => {
  const w = world();
  ['A', 'B', 'C'].forEach((id) => card(w, id));
  const mark = (id, ago) => must(w.t.record.write({ actor: 'dispatcher', entity: 'fact', id: PLAN_SLOW_FACT(id), expectRev: 0, doc: { slow_at: new Date(w.t.clock.t - ago).toISOString() } }));
  mark('A', HOUR);
  mark('B', 2 * HOUR);
  const order = [];
  await pass(w, { planRows: async (x) => { order.push(x.card); return ROWS; } });
  assert.deepEqual(order, ['C', 'B', 'A']);
});

test('A5: time running out while telling the Lead is out of time, not a Lead that could not be told', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  answer(w, asks(w)[0].id, 'Not now', false);
  await pass(w, { passMs: 0 });
  assert.ok(!w.sent.some((s) => /the Lead could not be told/.test(s)), w.sent.join(' | '));
  assert.ok(w.sent.some((s) => /card A was not reached/.test(s)), w.sent.join(' | '));
});

test('L477 m4: with a little over one port limit left no call goes out, so the notes after it still fit', async () => {
  const w = world();
  card(w, 'A');
  const viewed = [];
  await timeJumps((jump) => pass(w, { portMs: 1000, passMs: 6000, planRows: async () => { jump(4900); return ROWS; }, planView: async (x) => { viewed.push(x); return w.ports.planView(x); } }));
  assert.deepEqual(viewed, []);
  assert.ok(w.sent.some((s) => /card A was not finished/.test(s)), w.sent.join(' | '));
});

test('L480 R1: a card that ran out after its own quick calls is told it was starved, under its own cause, and keeps its place', async () => {
  const w = world();
  card(w, 'A');
  await pass(w, { passMs: 0 });
  // The clock jumps while M2 reads the rows: after the card's calls were timed, before its next one.
  await timeJumps((jump) => pass(w, { portMs: 100, passMs: 1000, planRows: async () => ({ get 'R-1'() { jump(); return ROWS['R-1']; } }) }));
  assert.equal(w.t.record.read('fact', PLAN_SLOW_FACT('A')), null);
  assert.ok(w.sent.some((s) => /card A was not finished: slow calls on other cards used up/.test(s)), w.sent.join(' | '));
  assert.ok(!w.sent.some((s) => /own calls were slow/.test(s)), w.sent.join(' | '));
  assert.ok(w.sent.some((s) => /card A was not reached/.test(s)), 'told apart from not reached the same day');
});

test('L480 R1: a card starved part way names the slow card', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  const hangA = (x) => (x.card === 'A' ? new Promise(() => {}) : w.ports.planRows(x));
  await timeJumps((jump) => pass(w, { portMs: 20, passMs: 1000, planRows: async (x) => { if (x.card === 'A') return hangA(x); return { get 'R-1'() { jump(); return ROWS['R-1']; } }; } }));
  assert.ok(w.sent.some((s) => /card B was not finished: slow calls on A used up/.test(s)), w.sent.join(' | '));
  assert.equal(w.t.record.read('fact', PLAN_SLOW_FACT('B')), null);
});

test('L480 R2: at the real limits, moderate cards that never finish take turns, so the tail is reached and none is marked slow', async () => {
  const w = world();
  ids10.forEach((id) => t1(w, id));
  w.answer = { ok: true };
  const reached = [];
  // Each call costs 0.6 of a port limit on a clock that moves for nothing else: the ninth call goes out with exactly the
  // last-call margin left, so real time must not count or the machine's load decides this test.
  await timeJumps(async (jump, spend) => {
    const costs = (f) => (x) => { reached.at(-1).push(x.card); spend(PLAN_PORT_MS * 0.6); return f(x); };
    const ports = { portMs: PLAN_PORT_MS, passMs: APPROVALS_PRODUCT_MS, startPlanReview: costs(w.ports.startPlanReview), planReviewAnswer: costs(w.ports.planReviewAnswer) };
    for (let i = 0; i < 3; i += 1) {
      reached.push([]);
      await pass(w, ports);
      later(w, HOUR);
    }
  });
  assert.deepEqual(reached[0], ids10.slice(0, 9));
  assert.deepEqual(reached[1], [ids10[9], ...ids10.slice(0, 8)]);
  // The test's clock stands still within a pass, so cards reached in one pass tie and keep their list order.
  assert.deepEqual(reached[2], [ids10[8], ...ids10.slice(0, 8)]);
  assert.deepEqual(ids10.filter((id) => w.t.record.read('fact', PLAN_SLOW_FACT(id))?.doc?.slow_at), []);
});

test('L480 R2: of the cards not slow, the least recently reached goes first, and any slow card still goes behind them', async () => {
  const w = world();
  ['A', 'B', 'C', 'D'].forEach((id) => card(w, id));
  const fact = (id, doc) => must(w.t.record.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: 0, doc }));
  const ago = (ms) => new Date(w.t.clock.t - ms).toISOString();
  fact(PLAN_TURN_FACT('A'), { reached_at: ago(HOUR) });
  fact(PLAN_TURN_FACT('B'), { reached_at: ago(2 * HOUR) });
  fact(PLAN_TURN_FACT('D'), { reached_at: ago(3 * HOUR) });
  fact(PLAN_SLOW_FACT('D'), { slow_at: ago(HOUR) });
  const order = [];
  await pass(w, { planRows: async (x) => { order.push(x.card); return ROWS; } });
  assert.deepEqual(order, ['C', 'B', 'A', 'D']);
});

const turn = (w, id) => w.t.record.read('fact', PLAN_TURN_FACT(id));
// A first card whose call uses up the pass, so every card after it is left out.
const eatsThePass = (w, jump, id = 'A') => async (x) => { if (x.card === id) jump(); return w.ports.planRows(x); };

test('L484 W1: a pass that reaches every card writes no turns, so a healthy product adds nothing to the diary', async () => {
  const w = world();
  ['A', 'B', 'C'].forEach((id) => card(w, id));
  await pass(w);
  later(w, HOUR);
  await pass(w);
  assert.equal(asks(w).length, 3);
  assert.deepEqual(['A', 'B', 'C'].map((id) => turn(w, id)), [null, null, null]);
});

test('L484 W1: a pass that leaves a card out notes, at its end, only the cards that made a call', async () => {
  const w = world();
  card(w, 'WAITS');
  await pass(w);
  card(w, 'A');
  card(w, 'B');
  let inCall = 'not called';
  await timeJumps((jump) => pass(w, { planRows: async (x) => { inCall = turn(w, x.card); return eatsThePass(w, jump)(x); } }));
  assert.equal(inCall, null, 'nothing is written before the pass ends');
  assert.ok(w.sent.some((s) => /card B was not reached/.test(s)), w.sent.join(' | '));
  assert.equal(turn(w, 'A').doc.reached_at, new Date(w.t.clock.t).toISOString());
  assert.equal(turn(w, 'B'), null, 'not reached, so it stays first');
  assert.equal(turn(w, 'WAITS'), null, 'it made no call, so it had no turn to note');
});

test('L484 W1: a last card that leaves itself unfinished counts as a card left out, so the turns are noted', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await timeJumps((jump) => pass(w, { planRows: eatsThePass(w, jump, 'B') }));
  assert.ok(w.sent.some((s) => /card B was not finished: this card's own calls were slow/.test(s)), w.sent.join(' | '));
  assert.ok(turn(w, 'A') && turn(w, 'B'));
});

test('L484 W1: a turn the record refuses is told, once the pass is over', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  const base = w.t.record;
  const rec = Object.create(base, { write: { value: (x) => (x.id === PLAN_TURN_FACT('A') ? { ok: false, reason: 'disk full' } : base.write(x)) } });
  await timeJumps((jump) => pass(w, { planRows: eatsThePass(w, jump) }, { record: rec }));
  assert.ok(w.sent.some((s) => /card A's turn in the plan-go order could not be noted: disk full/.test(s)), w.sent.join(' | '));
});

test('L477 m3: a close that worked leaves no mark and tells nobody', async () => {
  const w = world();
  const id = await askWithPr(w);
  const c = closingFails(w);
  c.status = 200;
  await pass(w, {}, { gh: c.gh });
  assert.equal(c.calls, 1);
  const old = askStore(w.t.record).ask(id).doc;
  assert.equal(old.state, 'withdrawn');
  assert.equal(old.pr_close_due, undefined);
});

test('R-0b-170: end to end: a plan file in the Lead\'s outbox becomes a Tier-1 draft card, and the plan-go step reviews it and asks for its go', async () => {
  const w = world();
  const dir = join(w.t.outRoot, 'lead', 'L-1');
  mkdirSync(dir, { recursive: true });
  must(recordLeadLaunch({ rec: w.t.record, now: w.t.clock.t, alert: fakeAlert(), sessionId: 'L-1', head: w.M0, product: PRODUCT }));
  const text = JSON.stringify({ cards: [{ id: 'A', wave: 1, tier: 1, module: 'M1', brief: { goal: 'the goal', done_when: doneBar(ROWS), files: ['src/a.mjs'], not_in_scope: 'anything else' } }] });
  writeFileSync(join(dir, 'plan-a.json'), text);
  const said = fakeAlert();
  const [r] = await intakePass({ rec: w.t.record, now: w.t.clock.t, sessions: [{ sessionId: 'L-1', role: 'lead', outbox: dir, uid: process.getuid() }], wait: async () => {},
    alert: said, note: () => {}, startReadonly: () => ({ ok: true }), replyToLead: async () => ({ ok: true }) });
  assert.equal(r.applied, true, JSON.stringify(r));
  const { doc } = w.t.record.read('card', 'A');
  assert.deepEqual([doc.state, doc.tier, doc.main_commit, doc.plan_sha256], ['draft', 1, w.M0, createHash('sha256').update(text).digest('hex')]);
  await pass(w);
  assert.equal(w.started.length, 1, 'a fresh reviewer read the plan');
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  assert.deepEqual(asks(w).map((a) => [a.doc.kind, a.doc.card]), [['go_t1', 'A']]);
  assert.equal(asks(w)[0].doc.plan_check.plan_sha256, doc.plan_sha256);
  assert.equal(asks(w)[0].doc.plan_check.author_session, 'L-1', 'the author is the Lead that handed the plan in');
  answer(w, asks(w)[0].id, 'go', true);
  await pass(w);
  assert.equal(w.t.record.read('card', 'A').doc.state, 'ready', w.sent.join(' | '));
  assert.deepEqual(w.t.record.ready().map((c) => c.id), ['A'], 'and a worker can take it');
  assert.deepEqual(said.texts, []);
});

// ---- R-0b-170: the move from draft to ready, once a go covers the card.
async function withGo(w, id) {
  await pass(w);
  answer(w, asks(w).find((a) => a.doc.card === id && a.doc.state !== 'consumed').id, 'Go', true);
}
const stateOf = (w, id) => w.t.record.read('card', id).doc.state;

test('L696 M1: a card whose rows are only its row files gets its go, moves to ready and passes the start gate', async () => {
  const files = ['src/a.mjs', 'docs/blueprint/rows/R-1.yaml'];
  const yaml = (id) => `id: ${id}\nwhat: row ${id}\nmodule: M1\ntier: 2\ndone_when: ${ROWS[id].done_when}\nstatus: planned\n`;
  const w = world();
  card(w, 'A', { files });
  w.ports.planRows = githubRows(w, { 'R-1': yaml('R-1') });
  await withGo(w, 'A');
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'ready', w.sent.join(' | '));
  const doc = w.t.record.read('card', 'A').doc;
  assert.equal(doc.rows, undefined, 'the card names its rows only through its files');
  const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
  const g = startGate({ rules: rulesWith(), rec: w.t.record, card: { id: 'A', ...doc }, kind: 'editing', product: PRODUCT, b: GREEN, running: [] });
  assert.deepEqual(g, { ok: true });
  assert.ok(fileSet({ id: 'A', ...doc }, { dailyPatterns: [] }).files.has('docs/blueprint/rows/r-1.yaml'), 'the row is in the card\'s file set');
});

test('R-0b-170: an ordinary card moves to ready in the pass that records its go, once', async () => {
  const w = world();
  card(w, 'A');
  await withGo(w, 'A');
  const r = await pass(w);
  assert.equal(stateOf(w, 'A'), 'ready');
  assert.deepEqual(r.events, ['go go-A', 'ready A']);
  assert.equal(w.t.record.diary().filter((d) => d.kind === 'go_ready').length, 1);
  const rev = w.t.record.read('card', 'A').rev;
  assert.deepEqual((await pass(w)).events, []);
  assert.equal(w.t.record.read('card', 'A').rev, rev, 'a card past draft is left alone');
});

test('R-0b-170: no go, a declined go or a go on an older plan does not move a card', async () => {
  const w = world();
  card(w, 'A');
  card(w, 'B');
  await pass(w);
  const a = asks(w).find((x) => x.doc.card === 'B');
  answer(w, a.id, 'Go', true);
  replan(w, 'B');
  await pass(w);
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'draft');
  assert.equal(stateOf(w, 'B'), 'draft', 'the go was on the plan before this one');
  const d = world();
  card(d, 'A');
  await pass(d);
  answer(d, asks(d)[0].id, 'Not now', false);
  await pass(d);
  assert.equal(stateOf(d, 'A'), 'draft');
});

test('R-0b-170: a card waiting on a dependency stays in draft with nothing told or refused, and moves once it has merged', async () => {
  const w = world();
  seed(w.t, 'card', 'D', { state: 'running', product: PRODUCT });
  card(w, 'A', { depends_on: ['D'] });
  await withGo(w, 'A');
  const base = w.t.record;
  let tried = 0;
  const record = Object.create(base, { write: { value: (x) => { if (x.kind === 'go_ready') tried += 1; return base.write(x); } } });
  await pass(w, {}, { record });
  await pass(w, {}, { record });
  assert.equal(stateOf(w, 'A'), 'draft');
  assert.deepEqual(w.sent, []);
  assert.equal(tried, 0, 'no write is tried only to be refused, which would alert');
  const d = w.t.record.read('card', 'D');
  seed(w.t, 'card', 'D', { ...d.doc, state: 'merged' });
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'ready');
});

test('R-0b-170: a card on a paused product waits quietly, and moves when it resumes', async () => {
  const w = world();
  card(w, 'A');
  await withGo(w, 'A');
  const p = w.t.record.read('product', PRODUCT);
  seed(w.t, 'product', PRODUCT, { ...p.doc, state: 'paused' });
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'draft');
  assert.deepEqual(w.sent, []);
  seed(w.t, 'product', PRODUCT, { ...p.doc });
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'ready');
});

test('R-0b-170: a card whose dependency will never merge is told to the owner once a day, and stays in draft', async () => {
  const w = world();
  seed(w.t, 'card', 'D', { state: 'cancelled', product: PRODUCT });
  card(w, 'A', { depends_on: ['D'] });
  await withGo(w, 'A');
  await pass(w);
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'draft');
  const told = () => w.sent.filter((s) => /card A has its go but can't start: dependency D is cancelled/.test(s)).length;
  assert.equal(told(), 1, w.sent.join(' | '));
  later(w, 25 * HOUR);
  await pass(w);
  assert.equal(told(), 2);
});

test('L490: a card whose dependency was reverted is told at once, at 24 hours and at 48 hours, and stays in draft', async () => {
  const w = world();
  seed(w.t, 'card', 'D', { state: 'reverted', product: PRODUCT });
  card(w, 'A', { depends_on: ['D'] });
  await withGo(w, 'A');
  const told = () => w.sent.filter((s) => /card A has its go but can't start: dependency D is reverted/.test(s)).length;
  await pass(w);
  await pass(w);
  assert.equal(told(), 1, w.sent.join(' | '));
  later(w, 24 * HOUR);
  await pass(w);
  assert.equal(told(), 2, 'at 24 hours');
  later(w, 24 * HOUR);
  await pass(w);
  assert.equal(told(), 3, 'at 48 hours');
  assert.equal(stateOf(w, 'A'), 'draft');
});

test('L490 m7: a card whose product record can\'t be read is told once, then daily; it never waits quietly', async () => {
  const w = world();
  card(w, 'A');
  await withGo(w, 'A');
  const base = w.t.record;
  const corrupt = { id: PRODUCT, corrupt: true, reason: 'unreadable' };
  const record = Object.create(base, { read: { value: (e, id) => (e === 'product' ? corrupt : base.read(e, id)) }, lookup: { value: (e, id) => (e === 'product' ? corrupt : base.lookup?.(e, id)) } });
  const told = () => w.sent.filter((s) => /card A has its go but can't start: product .* record can't be read/.test(s)).length;
  await pass(w, {}, { record });
  await pass(w, {}, { record });
  assert.equal(told(), 1, w.sent.join(' | '));
  later(w, 25 * HOUR);
  await pass(w, {}, { record });
  assert.equal(told(), 2);
  assert.equal(stateOf(w, 'A'), 'draft');
});

test('R-0b-170: a write the Record refuses at the last moment is told, and the next pass tries again', async () => {
  const w = world();
  card(w, 'A');
  await withGo(w, 'A');
  const base = w.t.record;
  const record = Object.create(base, { write: { value: (x) => (x.kind === 'go_ready' ? { ok: false, reason: 'turned down' } : base.write(x)) } });
  await pass(w, {}, { record });
  assert.equal(stateOf(w, 'A'), 'draft');
  const told = () => w.sent.filter((s) => /card A has its go but can't start: turned down/.test(s)).length;
  assert.equal(told(), 1, w.sent.join(' | '));
  await pass(w, {}, { record });
  assert.equal(told(), 1, 'once a day');
  assert.ok(w.t.record.read('fact', 'hold-plan-go-A-ready'), 'under its own cause');
  later(w, 25 * HOUR);
  await pass(w, {}, { record });
  assert.equal(told(), 2);
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'ready');
});

test('L473: the Record itself refuses draft to ready with no go covering the card, whatever the Dispatcher asks', async () => {
  const w = world();
  card(w, 'A');
  const none = move(w.t.record, 'card', 'A', { state: 'ready' }, { kind: 'go_ready' });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no go from the owner matches this plan/);
  assert.equal(stateOf(w, 'A'), 'draft');
});

test('L473: a go on an older plan does not cover the card at the Record either', async () => {
  const w = world();
  seed(w.t, 'card', 'D', { state: 'running', product: PRODUCT });
  card(w, 'A', { depends_on: ['D'] });
  await withGo(w, 'A');
  await pass(w);
  replan(w, 'A');
  const d = w.t.record.read('card', 'D');
  seed(w.t, 'card', 'D', { ...d.doc, state: 'merged' });
  const r = move(w.t.record, 'card', 'A', { state: 'ready' }, { kind: 'go_ready' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no go from the owner matches this plan/);
});

test('R-0b-170: a go-free card is left in draft for its own step', async () => {
  const w = world({ 'approvals.plan_go.go_free.lead_daily_card': ['*.md'] });
  card(w, 'A', { kind: 'lead_daily_card' });
  await pass(w);
  assert.equal(stateOf(w, 'A'), 'draft');
});

test('R-0b-170: moving a card needs no port, so a pass that has run out of time still moves it', async () => {
  const w = world();
  card(w, 'A');
  await withGo(w, 'A');
  await pass(w, { passMs: 0 });
  assert.equal(stateOf(w, 'A'), 'ready');
});

test('L486: a refused write on a close still due is told once, then daily, through the whole step, and the close goes on being tried', async () => {
  const w = world();
  const id = await askWithPr(w);
  const c = closingFails(w);
  await pass(w, {}, { gh: c.gh });
  c.status = 200;
  const base = w.t.record;
  let refusing = true;
  const rec = Object.create(base, { write: { value: (x) => (refusing && x.entity === 'ask' && x.id === id ? { ok: false, reason: 'refused' } : base.write(x)) } });
  const stateDir = join(w.t.base, 'm2-state');
  mkdirSync(stateDir, { recursive: true });
  const step = async () => {
    const now = w.t.clock.t;
    await approvalsStep({ rec, rules: w.t.ctx.rules, now, alert: outbox(rec, now), approvals: () => [{ ...w.t.ctx, stateDir, gh: c.gh }] });
    await sendAlerts(base, async (text) => { w.sent.push(text); return true; }, now);
  };
  const refusals = () => w.sent.filter((s) => s.includes('approvals write refused') && s.includes(id)).length;
  const calls = c.calls;
  for (let i = 0; i < 4; i += 1) { await step(); later(w, HOUR / 2); }
  assert.equal(refusals(), 1, w.sent.join(' | '));
  assert.equal(c.calls, calls + 4, 'the close is tried every pass');
  assert.equal(askStore(base).ask(id).doc.pr_close_due, true);
  later(w, 25 * HOUR);
  await step();
  assert.equal(refusals(), 2, 'again the next day');
  refusing = false;
  await step();
  assert.equal(askStore(base).ask(id).doc.pr_close_due, undefined, 'the write that was refused goes through once it can');
  assert.equal(refusals(), 2);
});

test('L486: each ask is its own cause, and only the refused write is held', async () => {
  const w = world();
  const rec = w.t.record;
  const now = w.t.clock.t;
  const say = approvalsAlerts(outbox(rec, now), 'p', rec, now);
  const send = () => sendAlerts(rec, async (text) => { w.sent.push(text); return true; }, now);
  say({ type: 'approvals_write_refused', ask: 'A-1', reason: 'no' });
  await send();
  say({ type: 'approvals_write_refused', ask: 'A-1', reason: 'no' });
  say({ type: 'approvals_write_refused', ask: 'A-2', reason: 'no' });
  await send();
  assert.equal(w.sent.filter((s) => s.includes('ask A-1')).length, 1);
  assert.equal(w.sent.filter((s) => s.includes('ask A-2')).length, 1);
  say({ type: 'approvals_config', reason: 'bad' });
  await send();
  say({ type: 'approvals_config', reason: 'bad' });
  await send();
  assert.equal(w.sent.filter((s) => s.includes('approvals config')).length, 2, 'only the write refusal is held here');
});
