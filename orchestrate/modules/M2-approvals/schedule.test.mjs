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
import { askStore, consumeAsk, writeDoc } from './ask-store.mjs';
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

// L133 m-2: written `expired` first, a close that failed plus a lost alert left the decision pull request open,
// nothing retried it, and Joe was never told. Now the close comes first and `expired` waits for a close that worked
// or an alert that went through; until then each pass tries both again.
test('L133 m-2: an expiring decision whose close fails and whose alert is refused stays un-expired, and both are retried', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  assert.ok(pr);
  await w.at(W8 + 13 * HOUR);
  await w.at(W8 + 24 * HOUR);
  assert.equal(ask(w, 'D-1').state, 'pushed');
  const realGh = w.t.ctx.gh;
  const close = { fail: true, tries: 0 };
  w.t.ctx.gh = { ...realGh, patch: async (path, body) => {
    if (path.endsWith(`/pulls/${pr}`) && body?.state === 'closed') { close.tries += 1; if (close.fail) return { status: 502 }; }
    return realGh.patch(path, body);
  } };
  const notClosed = () => w.t.alerts.filter((a) => a.type === 'decision_pr_not_closed');
  // The close fails and the sink refuses the alert (as M11's outbox does when it can't queue).
  w.t.sink.answer = false;
  await w.at(W8 + 36 * HOUR);
  assert.equal(close.tries, 1);
  assert.equal(ask(w, 'D-1').state, 'pushed', 'not expired: nothing would retry the close');
  assert.equal(w.g.pulls.get(pr).state, 'open');
  assert.equal(notClosed().length, 0);
  // The close still fails, but the alert goes through: Joe is told, and the ask expires.
  w.t.sink.answer = true;
  await w.at(W8 + 37 * HOUR);
  assert.equal(close.tries, 2, 'the close was tried again');
  assert.equal(notClosed().length, 1);
  assert.equal(notClosed()[0].pr, pr);
  assert.equal(ask(w, 'D-1').state, 'expired');
  await w.at(W8 + 38 * HOUR);
  assert.equal(close.tries, 2, 'an expired ask is not closed again');
  assert.equal(notClosed().length, 1, 'and Joe is told once');
});

test('L133 m-2: a sink that throws counts as not told, and a close that works on the retry expires the ask with no alert', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  await w.at(W8 + 13 * HOUR);
  await w.at(W8 + 24 * HOUR);
  const realGh = w.t.ctx.gh;
  const close = { fail: true };
  w.t.ctx.gh = { ...realGh, patch: async (path, body) => (close.fail && path.endsWith(`/pulls/${pr}`) ? Promise.reject(new Error('network down')) : realGh.patch(path, body)) };
  const realAlert = w.t.ctx.alert;
  w.t.ctx.alert = () => { throw new Error('sink broke'); };
  await w.at(W8 + 36 * HOUR);
  assert.equal(ask(w, 'D-1').state, 'pushed');
  w.t.ctx.alert = realAlert;
  close.fail = false;
  await w.at(W8 + 37 * HOUR);
  assert.equal(ask(w, 'D-1').state, 'expired');
  assert.equal(w.g.pulls.get(pr).state, 'closed');
  assert.equal(w.t.alerts.filter((a) => a.type === 'decision_pr_not_closed').length, 0);
});

// L135: the same shape after an answer (decision.mjs readDecision). The answer is written with CLOSE_DUE; the mark comes
// off once the close worked or Joe was told, and until then each schedule pass retries the close and the alert.
async function answeredWithFailingClose(w, { sink }) {
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  assert.ok(pr);
  const realGh = w.t.ctx.gh;
  const close = { fail: true, tries: 0 };
  w.t.ctx.gh = { ...realGh, patch: async (path, body) => {
    if (path.endsWith(`/pulls/${pr}`) && body?.state === 'closed') { close.tries += 1; if (close.fail) return { status: 502 }; }
    return realGh.patch(path, body);
  } };
  const realAlert = w.t.ctx.alert;
  if (sink === 'throws') w.t.ctx.alert = (a) => { if (a?.type === 'decision_pr_not_closed') throw new Error('sink broke'); return realAlert(a); };
  else w.t.sink.answer = false;
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  const r = await readDecision(w.t.ctx, 'D-1');
  assert.deepEqual([r.ok, r.counted, r.choice], [true, true, 'CSV'], r.reason);
  const restore = () => { w.t.ctx.alert = realAlert; w.t.sink.answer = true; };
  return { pr, close, restore };
}
const notClosed = (w) => w.t.alerts.filter((a) => a.type === 'decision_pr_not_closed');

for (const sink of ['false', 'throws']) {
  test(`L135: an answered decision whose close fails and whose alert ${sink === 'false' ? 'answers false' : 'throws'} keeps pr_close_due, and the pass retries until closed`, async () => {
    const w = world();
    const { pr, close, restore } = await answeredWithFailingClose(w, { sink });
    assert.equal(ask(w, 'D-1').state, 'answered', 'the answer is kept and counted');
    assert.equal(ask(w, 'D-1').pr_close_due, true, 'a close still due is on the record');
    assert.equal(w.g.pulls.get(pr).state, 'open');
    assert.equal(notClosed(w).length, 0, 'Joe not told');
    // A pass with the close still failing and the alert still lost: tried again, the mark stays.
    let r = await w.at(w.t.clock.t + HOUR);
    assert.equal(close.tries, 2);
    assert.equal(ask(w, 'D-1').pr_close_due, true);
    // The close works: the mark comes off, with no alert, and no later pass closes it again.
    close.fail = false; restore();
    r = await w.at(w.t.clock.t + HOUR);
    assert.equal(close.tries, 3);
    assert.equal(w.g.pulls.get(pr).state, 'closed');
    assert.equal(ask(w, 'D-1').pr_close_due, undefined);
    assert.equal(ask(w, 'D-1').state, 'answered');
    assert.ok(r.events.some((e) => e.type === 'decision_pr_close_retried' && e.ask === 'D-1'));
    assert.equal(notClosed(w).length, 0);
    await w.at(w.t.clock.t + HOUR);
    assert.equal(close.tries, 3, 'not closed again');
  });
}

test('L135: when the close still fails but the alert goes through, Joe is told once and the mark comes off', async () => {
  const w = world();
  const { pr, close, restore } = await answeredWithFailingClose(w, { sink: 'false' });
  restore();
  await w.at(w.t.clock.t + HOUR);
  assert.equal(close.tries, 2);
  assert.equal(notClosed(w).length, 1);
  assert.equal(notClosed(w)[0].pr, pr);
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  await w.at(w.t.clock.t + HOUR);
  assert.equal(close.tries, 2, 'not retried once Joe was told');
  assert.equal(notClosed(w).length, 1);
});

test('L135: a close that works first time leaves no mark, and a mark whose clearing write was refused is cleared by the pass', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  assert.equal((await readDecision(w.t.ctx, 'D-1')).counted, true);
  assert.equal(w.g.pulls.get(pr).state, 'closed');
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  // A crash between the answer and the close (or a refused clearing write) leaves the mark: the pass clears it.
  const a = askStore(w.t.record).ask('D-1');
  must(writeDoc(w.t.record, 'ask', a, { ...a.doc, pr_close_due: true }));
  const r = await w.at(w.t.clock.t + HOUR);
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  assert.ok(r.events.some((e) => e.type === 'decision_pr_close_retried'));
});

// L142 (r4 probes P-A, P-D, P-F; plants R1, R2, R5): the crash order is pinned, not only that a mark exists. A close
// that never answers stands for a process that dies while the close is in flight.
const NEVER = () => new Promise(() => {});
function closeBy(w, pr, fn) {
  const real = w.t.ctx.gh;
  w.t.ctx.gh = { ...real, patch: (path, body) => (path.endsWith(`/pulls/${pr}`) && body?.state === 'closed' ? fn(() => real.patch(path, body)) : real.patch(path, body)) };
}
// Waits until the close is reached (the process is then "dead" mid-close), not a fixed time: a slow machine can't
// check the record before the code under test got there.
async function reached(seen) {
  for (let i = 0; i < 10000 && !seen.close; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(seen.close, 'the close was reached');
}

test('L142 m2: the mark is on the record with the answer before the close; a crash during the close is finished by the next pass', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  let hang = true;
  const seen = { close: 0 };
  closeBy(w, pr, (go) => { seen.close += 1; return hang ? NEVER() : go(); });
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  readDecision(w.t.ctx, 'D-1'); // never settles: the process dies here
  await reached(seen);
  assert.equal(ask(w, 'D-1').state, 'answered');
  assert.equal(ask(w, 'D-1').pr_close_due, true, 'the mark was written with the answer, before the close');
  assert.equal(w.g.pulls.get(pr).state, 'open');
  hang = false;
  const r = await w.at(w.t.clock.t + HOUR);
  assert.equal(w.g.pulls.get(pr).state, 'closed');
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  assert.ok(r.events.some((e) => e.type === 'decision_pr_close_retried'));
  assert.equal(notClosed(w).length, 0);
});

test('L142 m3: the retry keeps the mark on the record while its close is in flight; a crash there is finished by the next pass', async () => {
  const w = world();
  const { pr, close, restore } = await answeredWithFailingClose(w, { sink: 'false' });
  close.fail = false; restore();
  let hang = true;
  const seen = { close: 0 };
  closeBy(w, pr, (go) => { seen.close += 1; return hang ? NEVER() : go(); });
  w.at(w.t.clock.t + HOUR); // the retry's close never answers: the process dies here
  await reached(seen);
  assert.equal(ask(w, 'D-1').pr_close_due, true, 'the mark stays until the close or the alert has answered');
  hang = false;
  await w.at(w.t.clock.t + HOUR);
  assert.equal(w.g.pulls.get(pr).state, 'closed');
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  assert.equal(notClosed(w).length, 0);
});

test('L142 c3: an answered ask consumed while its close is still due is still retried, and stays consumed', async () => {
  const w = world();
  const { pr, close, restore } = await answeredWithFailingClose(w, { sink: 'false' });
  must(consumeAsk(w.t.ctx, 'D-1'));
  assert.equal(ask(w, 'D-1').state, 'consumed');
  assert.equal(ask(w, 'D-1').pr_close_due, true, 'consuming keeps the mark');
  close.fail = false; restore();
  await w.at(w.t.clock.t + HOUR);
  assert.equal(w.g.pulls.get(pr).state, 'closed');
  assert.equal(ask(w, 'D-1').pr_close_due, undefined);
  assert.equal(ask(w, 'D-1').state, 'consumed');
});

test('L142 m4: a GitHub client that throws before it answers is a failed close; the pass goes on and another ask is still pushed', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  closeBy(w, pr, () => { throw new Error('client bug'); });
  w.t.sink.answer = false;
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  const d = await readDecision(w.t.ctx, 'D-1');
  assert.deepEqual([d.ok, d.counted], [true, true], 'the answer is still counted');
  assert.equal(ask(w, 'D-1').pr_close_due, true);
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-2', title: 'Undo it' }));
  const before = w.pushes.length;
  const r = await w.at(w.t.clock.t + HOUR);
  assert.equal(r.ok, true, 'the pass finished');
  assert.equal(ask(w, 'U-1').state, 'pushed');
  assert.deepEqual(w.pushes.slice(before).map((p) => p.ask), ['U-1'], "the other ask's push went out");
  assert.equal(ask(w, 'D-1').pr_close_due, true, 'still due: retried next pass');
  assert.equal(w.g.pulls.get(pr).state, 'open');
});

test('L142 m4, sink answers true: a GitHub client that throws is a failed close that tells Joe once, and the mark comes off', async () => {
  const w = world();
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  const pr = ask(w, 'D-1').pr;
  let tries = 0;
  closeBy(w, pr, () => { tries += 1; throw new Error('client bug'); });
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: w.t.clock.t + MIN });
  w.t.clock.t += 2 * MIN;
  const d = await readDecision(w.t.ctx, 'D-1');
  assert.deepEqual([d.ok, d.counted], [true, true], 'the answer is still counted');
  assert.equal(tries, 1);
  assert.equal(notClosed(w).length, 1, 'the throw is a failed close: Joe is told');
  assert.equal(notClosed(w)[0].pr, pr);
  assert.equal(ask(w, 'D-1').pr_close_due, undefined, 'told, so the mark comes off');
  await w.at(w.t.clock.t + HOUR);
  assert.equal(tries, 1, 'not retried once Joe was told');
  assert.equal(notClosed(w).length, 1, 'told once');
  assert.equal(w.g.pulls.get(pr).state, 'open');
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
