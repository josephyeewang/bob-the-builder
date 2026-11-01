// schedule.test.mjs — R-0b-51 / R-0b-53 on a faked clock: pushes only at 08:00 or 17:00 (owner's zone); urgent at once
// and every 2 hours; re-pushes never restart the 12-hour clock; a lapsed ask is re-asked once in the next window, then
// stops; an approval with no merge within 24 hours goes back; nothing merges on a lapsed approval; approvals given while
// the Mini is down lapse the same way; a held decision is not raised while cards on its module are open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { env, OWNER_ID, session, write, box, PRODUCT, must } from './fixtures.test-helper.mjs';
import { leadCard, put } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore, writeDoc } from './ask-store.mjs';
import { createAsk, processSession } from './binding.mjs';
import { readDecision } from './decision.mjs';
import { approvalStands, heldBy, readApprove, schedulePass } from './schedule.mjs';
import { UNDO_OPEN_QUESTION_LINE } from './kinds.mjs';

const MIN = 60_000; const HOUR = 60 * MIN;
// 2026-10-01 is summer time in Los Angeles (UTC-7): 08:00 local = 15:00Z, 17:00 local = 00:00Z next day.
const AT = (s) => Date.parse(s);
const W8 = AT('2026-10-01T15:00:00Z'); const W17 = AT('2026-10-02T00:00:00Z');

function world(values = {}) {
  const t = env({ values });
  const pushes = [];
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  g.repo.main = g.repo.commit([], { 'src/a.mjs': 'one' });
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app', stateDir: join(t.base, 'm2-state'), push: (e) => { pushes.push({ ...e, at: t.clock.t }); return true; } });
  const at = (ms) => { t.clock.t = ms; return schedulePass(t.ctx); };
  return { t, g, pushes, at };
}
const ask = (w, id) => askStore(w.t.record).ask(id).doc;
const yesNo = (w, id = 'Q-1', over = {}) => must(createAsk(w.t.ctx, { id, kind: 'tap_yes_no', card: 'C-1', title: 'Ship the export', ...over }));

test('a non-urgent ask goes out only at 08:00 or 17:00, once per window, and only if it existed when the window began', async () => {
  const w = world();
  yesNo(w);
  await w.at(AT('2026-10-01T12:00:00Z'));   // 05:00
  await w.at(W8 - MIN);                      // 07:59
  assert.equal(w.pushes.length, 0);
  await w.at(W8);
  assert.deepEqual(w.pushes.map((p) => p.ask), ['Q-1']);
  w.t.clock.t = W8 + 10 * MIN;
  yesNo(w, 'Q-2');
  await w.at(W8 + 30 * MIN);
  assert.equal(w.pushes.length, 1, 'Q-1 not again; Q-2 was made after 08:00 began');
  await w.at(W8 + 3 * HOUR);
  assert.equal(w.pushes.length, 1, 'nothing between windows');
  await w.at(W17);
  assert.deepEqual(w.pushes.map((p) => p.ask), ['Q-1', 'Q-2'], 'Q-1 is not re-pushed (re-push is for urgent kinds only)');
  assert.equal(ask(w, 'Q-1').raised_at, new Date(W8).toISOString());
});

test('a missed window (the Mini was down) is not replayed later', async () => {
  const w = world();
  yesNo(w);
  await w.at(W8 + 61 * MIN);
  assert.equal(w.pushes.length, 0);
  await w.at(W17 + 5 * MIN);
  assert.equal(w.pushes.length, 1);
});

test('the trip zone is used while the product is away', async () => {
  const w = world();
  must(w.t.record.write({ actor: 'approvals', entity: 'product', id: PRODUCT, expectRev: 0, doc: { state: 'away', away: { tz: 'Europe/London' } } }));
  w.t.clock.t = AT('2026-10-01T06:00:00Z');
  yesNo(w);
  await w.at(AT('2026-10-01T07:00:00Z'));   // 08:00 in London (UTC+1)
  assert.equal(w.pushes.length, 1);
});

test('urgent asks go out at once and every 2 hours; re-pushes never restart the 12-hour clock', async () => {
  const w = world();
  const t0 = AT('2026-10-01T12:00:00Z');
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo the export' }));
  await w.at(t0);
  await w.at(t0 + HOUR);
  await w.at(t0 + 2 * HOUR);
  await w.at(t0 + 3 * HOUR);
  await w.at(t0 + 4 * HOUR);
  assert.deepEqual(w.pushes.map((p) => (p.at - t0) / HOUR), [0, 2, 4]);
  assert.equal(ask(w, 'U-1').raised_at, new Date(t0).toISOString());
  await w.at(t0 + 12 * HOUR);
  assert.equal(ask(w, 'U-1').reask_count, 1, 'lapsed 12 hours after the first push, not the last');
});

test('an undo push carries the "answer or skip the open question first" line while a box is open', async () => {
  const w = world();
  const t0 = AT('2026-10-01T12:00:00Z');
  w.t.clock.t = t0;
  session(w.t, 'S-1');
  yesNo(w);
  const q = ask(w, 'Q-1');
  const b = box(q.payload, t0);
  write(w.t, 'S-1', b.entry);
  must(processSession(w.t.ctx, { sessionId: 'S-1', sourcePath: w.t.log('S-1') }));
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-2', title: 'Undo the export' }));
  await w.at(t0 + MIN);
  assert.equal(w.pushes.find((p) => p.ask === 'U-1').line, UNDO_OPEN_QUESTION_LINE);
  assert.equal(w.pushes.some((p) => p.ask === 'Q-1'), false, 'an ask with a live box is not pushed');
});

test('a lapsed ask is re-asked once in the next window, then stops', async () => {
  const w = world();
  yesNo(w);
  await w.at(W8);                     // raised 08:00
  await w.at(W8 + 12 * HOUR - MIN);
  assert.equal(ask(w, 'Q-1').reask_count, 0);
  await w.at(W8 + 12 * HOUR);         // 20:00: lapses
  assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').reask_count], ['open', 1]);
  const next8 = W8 + 24 * HOUR;
  await w.at(next8);                  // re-asked at the next 08:00
  assert.equal(w.pushes.length, 2);
  await w.at(next8 + 12 * HOUR);
  assert.equal(ask(w, 'Q-1').state, 'expired');
  await w.at(next8 + 24 * HOUR);
  assert.equal(w.pushes.length, 2, 'stops');
});

test('an ask that lapsed while the Mini was down lapses the same way', async () => {
  const w = world();
  yesNo(w);
  await w.at(W8);
  await w.at(W8 + 30 * HOUR);   // the first pass after a long outage
  assert.equal(ask(w, 'Q-1').reask_count, 1);
});

function riskyWorld() {
  const w = world();
  const view = makeGitView({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app' });
  const H = w.g.repo.commit([w.g.repo.main], { 'src/a.mjs': 'two' });
  w.g.openPull({ number: 7, head: H });
  must(createAsk(w.t.ctx, { id: 'R-1', kind: 'risky_approve', card: 'C-1', title: 'Change auth', tier: 1, risky: ['auth'], extra: { pr: 7 } }));
  return { ...w, view, H };
}

test('a risky change: Approve on the head counts; the approval stands for that head for 24 hours from raised, then goes back', async () => {
  const w = riskyWorld();
  await w.at(W8);
  assert.equal(ask(w, 'R-1').state, 'pushed');
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
  w.t.clock.t = W8 + HOUR;
  const r = await readApprove(w.t.ctx, 'R-1', { view: w.view });
  assert.deepEqual([r.counted, r.head], [true, w.H]);
  assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, true);
  assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: 'b'.repeat(40), view: w.view })).ok, false, 'another head');
  w.t.clock.t = W8 + 24 * HOUR;
  assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, false, 'nothing merges on a lapsed approval, even before a pass runs');
  await w.at(W8 + 25 * HOUR);   // between windows
  assert.deepEqual([ask(w, 'R-1').state, ask(w, 'R-1').reask_count, ask(w, 'R-1').answer], ['open', 1, undefined]);
  await w.at(W8 + 33 * HOUR);  // 17:00 next day: re-asked, a new review request
  assert.equal(ask(w, 'R-1').state, 'pushed');
  assert.equal(ask(w, 'R-1').raised_at, new Date(W8 + 33 * HOUR).toISOString());
});

test('an Approve given after the ask lapsed (the Mini was down) counts nothing', async () => {
  const w = riskyWorld();
  await w.at(W8);
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + 13 * HOUR });
  w.t.clock.t = W8 + 14 * HOUR;
  assert.equal((await readApprove(w.t.ctx, 'R-1', { view: w.view })).counted, false);
});

test('a decision Approve given after its lapse counts nothing', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  assert.ok(pr, 'the decision pull request opened in the window');
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: W8 + 13 * HOUR });
  w.t.clock.t = W8 + 13 * HOUR;
  assert.equal((await readDecision(w.t.ctx, 'D-1')).counted, false);
  await w.at(W8 + 13 * HOUR);
  assert.equal(ask(w, 'D-1').reask_count, 1);
  await w.at(W8 + 24 * HOUR);
  assert.equal(ask(w, 'D-1').state, 'pushed', 're-asked: the owner\'s review requested again');
  await w.at(W8 + 36 * HOUR);
  assert.equal(ask(w, 'D-1').state, 'expired');
  assert.equal(w.g.pulls.get(pr).state, 'closed', 'an expired decision\'s pull request is closed');
});

test('a held decision is not raised while a card on its module is open; closing it raises the ask in the next window', async () => {
  const w = world();
  leadCard(w.t, 'K-1', { module: 'M3' });
  leadCard(w.t, 'K-2', { module: 'M4' });
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'K-9', title: 'Decided entry for M3', choices: ['Keep', 'Drop'], recommended: 'Keep', extra: { modules: ['M3'] } }));
  const r = await w.at(W8);
  assert.equal(ask(w, 'D-1').state, 'open');
  assert.match(r.events.find((e) => e.type === 'held').reason, /K-1/);
  must(put(w.t.record, 'approvals', 'card', 'K-1', { state: 'cancelled' }), 'cancel K-1');
  await w.at(W17);
  assert.equal(ask(w, 'D-1').state, 'pushed');
});

test('a held decision with unknown modules stays held', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'K-9', title: 'Decided entry', choices: ['Keep', 'Drop'], recommended: 'Keep', extra: { modules: [] } }));
  await w.at(W8);
  assert.equal(ask(w, 'D-1').state, 'open');
});

test('missing settings: nothing is pushed and the owner is alerted once', async () => {
  const w = world({ 'approvals.push_windows': [] });
  yesNo(w);
  await w.at(W8);
  await w.at(W17);
  assert.equal(w.pushes.length, 0);
  assert.equal(w.t.alerts.filter((a) => a.type === 'approvals_config').length, 1);
});

test('L130: a config alert the sink refuses (answers false, as M11\'s outbox does) is not kept as sent, so it goes out next pass', async () => {
  const w = world({ 'approvals.push_windows': [] });
  yesNo(w);
  w.t.sink.answer = false;
  await w.at(W8);
  assert.equal(w.t.alerts.filter((a) => a.type === 'approvals_config').length, 0);
  w.t.sink.answer = true;
  await w.at(W17);
  await w.at(W17 + HOUR);
  assert.equal(w.t.alerts.filter((a) => a.type === 'approvals_config').length, 1, 'once it goes through, then not again');
});

test('a push that was not sent is tried again next pass, and records nothing', async () => {
  const w = world();
  let up = false;
  w.t.ctx.push = () => up;
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
  await w.at(W8);
  assert.equal(ask(w, 'U-1').state, 'open');
  up = true;
  await w.at(W8 + MIN);
  assert.equal(ask(w, 'U-1').state, 'pushed');
});

test('an urgent ask with a live box is not re-pushed', async () => {
  const w = world();
  const t0 = AT('2026-10-01T12:00:00Z');
  w.t.clock.t = t0;
  session(w.t, 'S-1');
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo the export' }));
  await w.at(t0);
  write(w.t, 'S-1', box(ask(w, 'U-1').payload, t0 + MIN).entry);
  w.t.clock.t = t0 + MIN;
  must(processSession(w.t.ctx, { sessionId: 'S-1', sourcePath: w.t.log('S-1') }));
  await w.at(t0 + 3 * HOUR);
  assert.equal(w.pushes.length, 1);
});

test('a card with no module holds every held decision; the decision\'s own card never does', () => {
  const doc = { kind: 'decision', card: 'K-9', modules: ['M3'] };
  assert.match(heldBy({ list: () => [{ id: 'X', doc: { state: 'draft' } }] }, doc), /every module/);
  assert.match(heldBy({ list: () => [{ id: 'X', corrupt: true }] }, doc), /every module/, 'an unreadable card holds too');
  assert.equal(heldBy({ list: () => [{ id: 'K-9', doc: { state: 'draft', module: 'M3' } }, { id: 'Y', doc: { state: 'merged' } }] }, doc), null);
  assert.equal(heldBy({ list: () => [{ id: 'X', doc: { state: 'draft' } }] }, { kind: 'decision', card: 'K-9' }), null, 'a decision with no modules field is not a held decision');
});

test('a "Request changes" after the approval was counted withdraws it before the merge (audit round 1 M-1)', async () => {
  for (const user of [undefined, 777]) {
    const w = riskyWorld();
    await w.at(W8);
    w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
    w.t.clock.t = W8 + HOUR;
    assert.equal((await readApprove(w.t.ctx, 'R-1', { view: w.view })).counted, true);
    assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, true);
    w.g.review(7, { ...(user ? { user } : {}), state: 'CHANGES_REQUESTED', commit_id: w.H, submitted_at: W8 + 2 * HOUR });
    w.t.clock.t = W8 + 2 * HOUR;
    assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, false, user ? 'another account' : 'the owner');
  }
});
