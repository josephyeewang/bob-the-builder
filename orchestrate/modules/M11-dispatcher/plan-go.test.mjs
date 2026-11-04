// plan-go.test.mjs — L440, L442, L443: the Dispatcher asks for a card's go and records the answer, on a real Record, with
// real M2 asks and fake reviewer, repo and alert-delivery ports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env, OWNER_ID, PRODUCT, must } from '../M2-approvals/fixtures.test-helper.mjs';
import { leadCard, roadmap } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from '../M2-approvals/fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore } from '../M2-approvals/ask-store.mjs';
import { doneBar } from '../M2-approvals/go.mjs';
import { outbox, sendAlerts } from './alerts.mjs';
import { schedulePass } from '../M2-approvals/schedule.mjs';
import { GO_REASK_MS, namedSession, planAuthor, planGoPass, PLAN_ASK_FACT, PLAN_REVIEW_FACT, PLAN_REVIEW_LEAD, PLAN_REVIEW_SLOW_MS } from './plan-go.mjs';

const HOUR = 3_600_000;
const row = (id, over = {}) => ({ id, what: `row ${id}`, module: 'M1', tier: 2, done_when: `tests pass for ${id}`, status: 'planned', ...over });
const ROWS = { 'R-1': row('R-1') };
const SHA = 'e'.repeat(64);

function world(values = {}) {
  const t = env({ values });
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
function replan(w, id, files) { const c = w.t.record.read('card', id); must(roadmap(w.t, { id, expectRev: c.rev, fields: { ...c.doc, files: files ?? [...c.doc.files, 'src/b.mjs'] } })); }

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
  const cur = w.t.record.read('card', 'A');
  must(roadmap(w.t, { id: 'A', expectRev: cur.rev, fields: { plan_sha256: 'd'.repeat(64) } }));
  await pass(w);
  assert.equal(w.started.length, 2);
  assert.notEqual(w.started[0].fingerprint, w.started[1].fingerprint);
  w.answer = { ok: true, answer: 'PASS' };
  await pass(w);
  assert.equal(asks(w)[0].doc.plan_check.plan_sha256, 'd'.repeat(64));
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
  assert.deepEqual(r.events, []);
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

test('L462 M1: on real M2 scheduling, one push, then the owner hears daily with no answer', async () => {
  const w = world();
  card(w, 'A');
  await pass(w);
  const pushes = [];
  w.t.ctx.stateDir = join(w.t.base, 'm2-state');
  mkdirSync(w.t.ctx.stateDir, { recursive: true });
  w.t.ctx.push = async (e) => { pushes.push(e); return true; };
  for (let i = 0; i < 4 * 48; i += 1) { later(w, HOUR / 2); await schedulePass(w.t.ctx); await pass(w); }
  assert.equal(pushes.length, 1, 'M2 pushes a go ask once');
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
  const told = () => w.sent.filter((s) => /card B runs on root card A's go, which doesn't cover it.*no go from the owner matches/.test(s)).length;
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
  test(`L462 m5: a ${port} that hangs is told under its card, and the next card still runs`, async () => {
    const w = world();
    setup(w);
    card(w, 'B');
    const real = w.ports[port];
    let first = true;
    const hangsOnce = (x) => { if (!first) return real(x); first = false; return new Promise(() => {}); };
    await pass(w, { portMs: 20, [port]: hangsOnce });
    assert.ok(w.sent.some((s) => new RegExp(`card A failed: ${port}: it did not answer within 20 ms`).test(s)), w.sent.join(' | '));
    assert.deepEqual(asks(w).map((a) => a.doc.card), ['B']);
  });
}

test('L462 m5: a planReviewAnswer or replyToLead that hangs costs only its limit, and is told', async () => {
  const w = world();
  t1(w, 'A');
  await pass(w);
  await pass(w, { portMs: 20, planReviewAnswer: () => new Promise(() => {}) });
  assert.ok(w.sent.some((s) => /card A failed: planReviewAnswer: it did not answer within 20 ms/.test(s)), w.sent.join(' | '));
  const v = world();
  card(v, 'A');
  await pass(v);
  answer(v, asks(v)[0].id, 'Not now', false);
  await pass(v, { portMs: 20, replyToLead: () => new Promise(() => {}) });
  assert.ok(v.sent.some((s) => /Lead could not be told .*replyToLead: it did not answer within 20 ms/.test(s)), v.sent.join(' | '));
});

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
  const rec = { ...w.t.record, write: (x) => (x.entity === 'fact' && x.id === PLAN_REVIEW_FACT('A') ? { ok: false, reason: 'disk full' } : w.t.record.write(x)) };
  await pass(w, {}, { record: rec });
  assert.ok(w.sent.some((s) => /started but could not be noted/.test(s)), w.sent.join(' | '));
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
  const files = card(w, 'A').files;
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
