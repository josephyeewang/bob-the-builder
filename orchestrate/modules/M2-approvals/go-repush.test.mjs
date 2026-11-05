// go-repush.test.mjs — L523: a go ask still waiting reaches the owner's phone once a day, through M2, beside the daily hold
// tell. Never per tick, never once it stopped waiting, and a push that fails is told. A Tier-1 go is answered on GitHub, so
// its reminder only points there and a tap counts for nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { box, env, must, OWNER_ID, session, tap, write } from './fixtures.test-helper.mjs';
import { leadCard, put } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { createAsk, nextBox, processSession } from './binding.mjs';
import { readDecision } from './decision.mjs';
import { doneBar, goFingerprint, raiseGo } from './go.mjs';
import { GO_REPUSH_MS } from './kinds.mjs';
import { schedulePass } from './schedule.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const W8 = Date.parse('2026-10-01T15:00:00Z');
const W17 = Date.parse('2026-10-02T00:00:00Z');
const row = (id, over = {}) => ({ id, what: `row ${id}`, module: 'M1', tier: 2, done_when: `tests pass for ${id}`, status: 'planned', ...over });

function world() {
  const t = env();
  t.clock.t = W8 - HOUR;
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  const M0 = g.repo.commit([], { 'src/a.mjs': 'one' });
  g.repo.main = M0;
  const pushes = [];
  const phone = { answer: () => true };
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app', stateDir: join(t.base, 'm2-state'), push: (e) => { const a = phone.answer(e); if (a === true) pushes.push({ ...e, at: t.clock.t }); return a; } });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const at = (ms) => { t.clock.t = ms; return schedulePass(t.ctx); };
  return { t, g, M0, view, pushes, phone, at };
}

async function tier2(w, id = 'A') {
  const rows = { 'R-1': row('R-1') };
  leadCard(w.t, id, { done_when: doneBar(rows), files: ['src/a.mjs'] });
  const r = await raiseGo(w.t.ctx, { cardId: id, rows, view: w.view, mainSha: w.M0 });
  assert.equal(r.ok, true, r.reason);
  return r.id;
}

async function tier1(w, id = 'T') {
  const plan = { tier: 1, plan_sha256: 'from the plan file', main_commit: w.M0, files: ['src/a.mjs'] };
  const rows = { 'R-1': row('R-1', { tier: 1 }) };
  leadCard(w.t, id, { done_when: doneBar(rows), ...plan });
  const fp = goFingerprint(w.t.ctx, id);
  assert.equal(fp.ok, true, fp.reason);
  const planCheck = { pass: true, material: 0, card: id, fingerprint: fp.fingerprint, plan_sha256: w.t.record.read('card', id).doc.plan_sha256, reviewer_session: 'S-review', author_session: 'S-lead' };
  const r = await raiseGo(w.t.ctx, { cardId: id, rows, view: w.view, mainSha: w.M0, planCheck });
  assert.equal(r.ok, true, r.reason);
  assert.equal(askStore(w.t.record).ask(r.id).doc.kind, 'go_t1');
  return r.id;
}

const doc = (w, id) => askStore(w.t.record).ask(id).doc;
const change = (w, id, fields) => { const a = askStore(w.t.record).ask(id); must(writeDoc(w.t.record, 'ask', a, { ...a.doc, ...fields })); };
// A day of ticks, ten minutes apart.
async function aDay(w, from) { for (let m = 0; m < 24 * 60; m += 10) await w.at(from + m * MIN); }

test('L523: a Tier-2 go waiting reaches the phone once a day, however often the pass runs, and its clock is kept', async () => {
  const w = world();
  const id = await tier2(w);
  await w.at(W8);
  assert.equal(w.pushes.length, 1, 'the first push');
  const raised = doc(w, id).raised_at;
  await aDay(w, W8 + 10 * MIN);
  assert.equal(w.pushes.length, 2, 'one reminder in the first day');
  assert.equal(w.pushes[1].at, W8 + DAY, 'at the window, a day on');
  assert.equal(w.pushes[1].kind, 'go_t2');
  assert.match(w.pushes[1].view, /Go/, 'it carries the go view');
  assert.equal(w.pushes[1].line, undefined, 'a tap go has no pointer line');
  await aDay(w, W8 + DAY + 10 * MIN);
  await aDay(w, W8 + 2 * DAY + 10 * MIN);
  assert.equal(w.pushes.length, 4, 'one a day');
  assert.equal(doc(w, id).raised_at, raised, 'a reminder does not restart the ask');
  assert.equal(doc(w, id).state, 'pushed');
});

test('L523: a push a day means a full day: just under it is none, and a day after a late push is what counts', async () => {
  const w = world();
  assert.equal(GO_REPUSH_MS, DAY);
  await tier2(w);
  await w.at(W8 + 30 * MIN);
  await w.at(W8 + 30 * MIN + DAY - 1);
  assert.equal(w.pushes.length, 1);
  await w.at(W8 + 30 * MIN + DAY);
  assert.equal(w.pushes.length, 2);
});

test('L523: outside a window no reminder goes, and the next window takes it', async () => {
  const w = world();
  await tier2(w);
  await w.at(W8);
  await w.at(W8 + DAY + 61 * MIN);
  assert.equal(w.pushes.length, 1, 'past the window');
  await w.at(W17 + DAY);
  assert.equal(w.pushes.length, 2, 'the 17:00 window');
});

for (const [name, fields] of [['answered', { state: 'answered', answer: { channel: 'tap', choice: 'Go', approves: true, session_id: 'S-1', tool_use_id: 'toolu_1', at: new Date(W8).toISOString() } }],
  ['withdrawn', { state: 'withdrawn' }], ['expired', { state: 'expired', reask_count: 1 }]]) {
  test(`L523: an ask ${name} gets no more reminders`, async () => {
    const w = world();
    const id = await tier2(w);
    await w.at(W8);
    if (fields.state === 'expired') change(w, id, { state: 'open', reask_count: 1, lapsed_at: new Date(W8).toISOString() });
    change(w, id, fields);
    await aDay(w, W8 + DAY - 10 * MIN);
    assert.equal(w.pushes.length, 1);
  });
}

test('L523: a push that fails is told, once a day, and tried until it goes', async () => {
  const w = world();
  const id = await tier2(w);
  await w.at(W8);
  const stamped = doc(w, id).last_push_at;
  const lost = () => w.t.alerts.filter((a) => a.type === 'push_not_sent' && a.ask === id);
  w.phone.answer = () => false;
  await w.at(W8 + DAY);
  assert.equal(lost().length, 1, 'told');
  await w.at(W8 + DAY + 5 * MIN);
  w.phone.answer = () => { throw new Error('the phone channel fell over'); };
  await w.at(W8 + DAY + 10 * MIN);
  assert.equal(lost().length, 1, 'once a day, not per tick');
  assert.equal(doc(w, id).last_push_at, stamped, 'a failed push is not a push');
  await w.at(W8 + 2 * DAY);
  assert.equal(lost().length, 2, 'again the next day');
  w.phone.answer = () => true;
  await w.at(W8 + 2 * DAY + 5 * MIN);
  assert.equal(w.pushes.length, 2, 'the next try that works goes out');
  assert.equal(doc(w, id).last_push_at, new Date(W8 + 2 * DAY + 5 * MIN).toISOString());
});

test('L523: a card no longer in draft gets no reminder, and neither does one that cannot be read', async () => {
  const w = world();
  const id = await tier2(w);
  await w.at(W8);
  must(put(w.t.record, 'approvals', 'card', 'A', { state: 'cancelled', cancel_reason: 'no longer wanted' }), 'cancel');
  await aDay(w, W8 + DAY - 10 * MIN);
  assert.equal(w.pushes.length, 1);
  assert.equal(doc(w, id).state, 'pushed', 'the ask itself is left to its own withdrawal');
  const v = world();
  await tier2(v);
  await v.at(W8);
  v.t.ctx.record = Object.create(v.t.record, { read: { value: (e, x) => (e === 'card' ? { corrupt: true } : v.t.record.read(e, x)) } });
  await v.at(W8 + DAY);
  assert.equal(v.pushes.length, 1, 'corrupt');
  v.t.ctx.record = Object.create(v.t.record, { read: { value: (e, x) => (e === 'card' ? null : v.t.record.read(e, x)) } });
  await v.at(W8 + DAY + MIN);
  assert.equal(v.pushes.length, 1, 'missing');
});

test('L523: an ask with a live box gets no reminder: it is on the screen already', async () => {
  const w = world();
  const id = await tier2(w);
  await w.at(W8);
  session(w.t, 'S-1');
  change(w, id, { boxes: [{ session_id: 'S-1', tool_use_id: 'toolu_1', status: 'bound', version: 'payload', bound_at: new Date(W8).toISOString() }] });
  await w.at(W8 + DAY);
  assert.equal(w.pushes.length, 1);
});

test('L523: a Tier-1 reminder goes to the phone and points to the pull request, leaving the ask and its review as they are', async () => {
  const w = world();
  const id = await tier1(w);
  await w.at(W8);
  const { pr, raised_at: raised, state } = doc(w, id);
  assert.ok(Number.isSafeInteger(pr), 'the first round opens the pull request');
  assert.equal(w.pushes.length, 0, 'a first Tier-1 ask goes to GitHub, not the phone');
  const revs = w.t.record.read('ask', id).rev;
  await aDay(w, W8 + DAY - 10 * MIN);
  assert.equal(w.pushes.length, 1);
  const [p] = w.pushes;
  assert.equal(p.kind, 'go_t1');
  assert.equal(p.line, `Answer this on pull request #${pr} on GitHub. Nothing tapped here counts.`);
  assert.match(p.view, /Approve this pull request on GitHub with no text/);
  assert.equal(doc(w, id).raised_at, raised);
  assert.equal(doc(w, id).state, state);
  assert.equal(doc(w, id).pr, pr);
  assert.equal(w.t.record.read('ask', id).rev, revs + 1, 'one write, for the push mark');
  await aDay(w, W8 + 2 * DAY);
  assert.equal(w.pushes.length, 2, 'once a day');
});

test('L523: a tap on a Tier-1 reminder counts for nothing, and the Approve on GitHub still does', async () => {
  const w = world();
  const id = await tier1(w);
  await w.at(W8);
  await w.at(W8 + DAY);
  assert.equal(w.pushes.length, 1);
  const before = doc(w, id);
  assert.equal(nextBox(w.t.ctx, { sessionId: 'S-1', role: 'front_door' }), null, 'no box is offered for it');
  session(w.t, 'S-1');
  const input = { questions: [{ question: `[ask ${id}] Go on ${before.card}?`, header: 'Go', multiSelect: false, options: [{ label: 'Go', description: 'yes' }, { label: 'Not now', description: 'no' }] }] };
  const b = box(input, w.t.clock.t + MIN);
  write(w.t, 'S-1', b.entry, tap(b.id, input, 'Go', w.t.clock.t + 2 * MIN));
  w.t.clock.t += 3 * MIN;
  const r = processSession(w.t.ctx, { sessionId: 'S-1', sourcePath: w.t.log('S-1') });
  assert.ok(r.events.some((e) => e.type === 'mismatched_question'), JSON.stringify(r.events));
  const after = doc(w, id);
  assert.deepEqual([after.state, after.raised_at, after.answer], [before.state, before.raised_at, before.answer]);
  assert.ok(!(after.boxes ?? []).some((x) => x.status === 'bound'), 'no box bound');
  assert.equal((await readDecision(w.t.ctx, id)).counted, false, 'no verdict came of it');
  assert.equal(doc(w, id).state, 'pushed');
  w.g.review(after.pr, { state: 'APPROVED', commit_id: w.g.pulls.get(after.pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  assert.equal((await readDecision(w.t.ctx, id)).counted, true, 'the reminder did not move the answer');
});

test('L523: with no phone channel a waiting Tier-1 go is told so, once a day', async () => {
  const w = world();
  const id = await tier1(w);
  await w.at(W8);
  delete w.t.ctx.push;
  const said = () => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === id);
  await w.at(W8 + DAY);
  await w.at(W8 + DAY + 5 * MIN);
  await w.at(W8 + DAY + 10 * MIN);
  assert.equal(said().length, 1);
  await w.at(W8 + 2 * DAY);
  assert.equal(said().length, 2);
  assert.equal(doc(w, id).state, 'pushed');
});

test('L523: only a go is reminded: another ask raised by its box and still waiting is not pushed again', async () => {
  const w = world();
  leadCard(w.t, 'C-1');
  must(createAsk(w.t.ctx, { id: 'Q-1', kind: 'tap_yes_no', card: 'C-1', title: 'Ship the export' }));
  change(w, 'Q-1', { state: 'pushed', raised_at: new Date(W8 - 30 * MIN).toISOString(), raised_reask: 0 });
  await w.at(W8);
  await w.at(W8 + 9 * HOUR);
  assert.equal(w.pushes.length, 0);
});

test('L523: a Tier-1 go whose raised time is gone is asked on GitHub again, not reminded', async () => {
  const w = world();
  const id = await tier1(w);
  await w.at(W8);
  change(w, id, { raised_at: 'not a time' });
  await w.at(W17);
  assert.equal(w.pushes.length, 0);
  assert.notEqual(doc(w, id).raised_at, 'not a time', 'the review request gave it a new time');
});
