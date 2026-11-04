// schedule.test.mjs — R-0b-51 / R-0b-53 on a faked clock: pushes only at 08:00 or 17:00 (owner's zone); urgent at once
// and every 2 hours; re-pushes never restart the 12-hour clock; a lapsed ask is re-asked once in the next window, then
// stops; an approval with no merge within 24 hours goes back; nothing merges on a lapsed approval; approvals given while
// the Mini is down lapse the same way; a held decision is not raised while cards on its module are open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, OWNER_ID, session, write, box, tap, PRODUCT, must } from './fixtures.test-helper.mjs';
import { leadCard, put } from '../M9-record/fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { askStore, consumeAsk, writeDoc } from './ask-store.mjs';
import { boxSession, createAsk, processSession, nextBox } from './binding.mjs';
import { readDecision } from './decision.mjs';
import { approvalStands, heldBy, readApprove, schedulePass } from './schedule.mjs';
import { approvalsAlertText } from '../M11-dispatcher/tick.mjs';
import { TIME_REASKED_LINE, UNDO_OPEN_QUESTION_LINE, lapseAt } from './kinds.mjs';

const MIN = 60_000; const HOUR = 60 * MIN;
// 2026-10-01 is summer time in Los Angeles (UTC-7): 08:00 local = 15:00Z, 17:00 local = 00:00Z next day.
const AT = (s) => Date.parse(s);
const W8 = AT('2026-10-01T15:00:00Z'); const W17 = AT('2026-10-02T00:00:00Z');

function world(values = {}) {
  const t = env({ values });
  const pushes = [];
  let ahead = 0;   // how far GitHub's clock runs ahead of the Mini's
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t + ahead });
  g.repo.main = g.repo.commit([], { 'src/a.mjs': 'one' });
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app', stateDir: join(t.base, 'm2-state'), push: (e) => { pushes.push({ ...e, at: t.clock.t }); return true; } });
  const at = (ms) => { t.clock.t = ms; return schedulePass(t.ctx); };
  return { t, g, pushes, at, setAhead: (ms) => { ahead = ms; } };
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

// L205 (#108 r2): a GitHub read that fails while checking whether an Approve stands is not GitHub's "no": the answer
// says `unreadable`, with the error as `cause`, and the Merge Gate waits on it. GitHub's own "no" is not unreadable.
test('L205: an Approve whose GitHub read fails is unreadable, not withdrawn; once read it stands again', async () => {
  const w = riskyWorld();
  await w.at(W8);
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
  w.t.clock.t = W8 + HOUR;
  assert.equal((await readApprove(w.t.ctx, 'R-1', { view: w.view })).counted, true);
  const get = w.g.gh.get;
  let down = true;
  w.g.gh.get = async (p) => (down && /\/reviews/.test(p) ? { status: 502, json: null } : get(p));
  const r = await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view });
  assert.deepEqual([r.ok, r.unreadable], [false, true], JSON.stringify(r));
  assert.match(String(r.cause?.message), /^GitHub answered 502 for /);
  down = false;
  assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, true);
  w.g.review(7, { state: 'CHANGES_REQUESTED', commit_id: w.H, submitted_at: W8 + 2 * HOUR });
  const no = await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view });
  assert.deepEqual([no.ok, no.unreadable], [false, undefined], 'GitHub\'s answer: changes asked for');
});

// L295 Minor 1: a push that can't go out is told once per ask and cause, not every pass. An urgent undo is tried every
// pass; with no phone channel it was told every minute. A push that goes through clears the ask's marks, so a later
// failure is told again; an alert the sink did not take is not marked, and is told next pass.
test('L295 Minor 1: a refused push is told once per ask and cause; a push that goes through clears the marks', async () => {
  const w = world();
  delete w.t.ctx.push;
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
  const noPush = (id) => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === id).length;
  w.t.sink.answer = false;
  await w.at(W8);
  assert.equal(noPush('U-1'), 0, 'the sink refused: not marked');
  w.t.sink.answer = true;
  for (let i = 1; i <= 5; i++) await w.at(W8 + i * MIN);
  assert.equal(noPush('U-1'), 1, 'told once over five passes');
  must(createAsk(w.t.ctx, { id: 'U-2', kind: 'undo', card: 'C-2', title: 'Undo two' }));
  await w.at(W8 + 6 * MIN);
  await w.at(W8 + 7 * MIN);
  assert.deepEqual([noPush('U-1'), noPush('U-2')], [1, 1], 'once per ask');
  // The channel comes: both go out, and their marks go.
  let up = true;
  w.t.ctx.push = () => up;
  await w.at(W8 + 8 * MIN);
  assert.equal(ask(w, 'U-1').state, 'pushed');
  assert.deepEqual(JSON.parse(readFileSync(join(w.t.ctx.stateDir, 'ask-alerts.json'), 'utf8')), {});
  // A later failure of the re-push is a new cause, told once.
  up = false;
  const notSent = () => w.t.alerts.filter((a) => a.type === 'push_not_sent' && a.ask === 'U-1').length;
  await w.at(W8 + 8 * MIN + 2 * HOUR);
  await w.at(W8 + 8 * MIN + 2 * HOUR + MIN);
  await w.at(W8 + 8 * MIN + 4 * HOUR);
  assert.equal(notSent(), 1);
  // L309 MAT-2: told again each day while the ask still waits: not at +2 h, again past +24 h.
  await w.at(W8 + 8 * MIN + 2 * HOUR + 23 * HOUR);
  assert.equal(notSent(), 1, 'under a day: not again');
  await w.at(W8 + 8 * MIN + 2 * HOUR + 25 * HOUR);
  assert.equal(notSent(), 2, 'a day on and still waiting: told again');
  await w.at(W8 + 8 * MIN + 2 * HOUR + 26 * HOUR);
  assert.equal(notSent(), 2);
});

// L309 MAT-2: an ask never pushed has no time limit, so its cause is re-told each day, not once ever.
test('L309 MAT-2: an ask with no phone channel is told again each day while it waits', async () => {
  const w = world();
  delete w.t.ctx.push;
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
  const noPush = () => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === 'U-1').length;
  await w.at(W8);
  await w.at(W8 + 2 * HOUR);
  assert.equal(noPush(), 1, '+2 h: not again');
  await w.at(W8 + 25 * HOUR);
  assert.equal(noPush(), 2, '+25 h: again');
  await w.at(W8 + 26 * HOUR);
  assert.equal(noPush(), 2);
  await w.at(W8 + 50 * HOUR);
  assert.equal(noPush(), 3);
});

// L309 Minor 2: an ask-alerts file that can't be read or parsed is "nothing told", never "already told", and is
// replaced by a readable one, so the cause is told once more, not every pass.
test('L309 Minor 2: a corrupt or unreadable ask-alerts.json tells again, once', async () => {
  for (const how of ['corrupt', 'unreadable']) {
    const w = world();
    delete w.t.ctx.push;
    must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
    const noPush = () => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === 'U-1').length;
    await w.at(W8);
    assert.equal(noPush(), 1);
    const f = join(w.t.ctx.stateDir, 'ask-alerts.json');
    if (how === 'corrupt') writeFileSync(f, '{ not json');
    else chmodSync(f, 0o200);
    await w.at(W8 + MIN);
    assert.equal(noPush(), 2, `${how}: told again`);
    await w.at(W8 + 2 * MIN);
    assert.equal(noPush(), 2, `${how}: the file was replaced, so not every pass`);
    assert.equal(typeof JSON.parse(readFileSync(f, 'utf8'))['U-1'], 'object');
  }
});

// L315: a bad rules config raises no asks, so it is told again each day while the same problem stands, and its mark goes
// once the config reads fine. L317: a told time more than a minute ahead counts as not told.
test('L315: a bad config is told again each day while it stands; L317: a told time 30 days ahead is not "told"', async () => {
  const w = world({ 'approvals.push_windows': [] });
  yesNo(w);
  const cfg = () => w.t.alerts.filter((a) => a.type === 'approvals_config').length;
  await w.at(W8);
  assert.equal(cfg(), 1);
  await w.at(W8 + 2 * HOUR);
  assert.equal(cfg(), 1, '+2 h: quiet');
  await w.at(W8 + 25 * HOUR);
  assert.equal(cfg(), 2, '+25 h: told again');
  await w.at(W8 + 26 * HOUR);
  assert.equal(cfg(), 2);
  const f = join(w.t.ctx.stateDir, 'config-alert.json');
  const m = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...m, told_at: new Date(Date.parse(m.told_at) + 30 * 24 * HOUR).toISOString() }));
  await w.at(W8 + 27 * HOUR);
  assert.equal(cfg(), 3, 'a told time 30 days ahead: told now');
  await w.at(W8 + 28 * HOUR);
  assert.equal(cfg(), 3);
});

// L331 Minor 2: the config mark goes once the config reads fine, so the same problem coming back is told at once,
// not held back by the day an earlier copy of it was told.
test('L331 Minor 2: a fixed config clears its mark, and the same problem coming back is told at once', async () => {
  const w = world({ 'approvals.push_windows': [] });
  const bad = w.t.ctx.rules;
  yesNo(w);
  const cfg = () => w.t.alerts.filter((a) => a.type === 'approvals_config').length;
  const f = join(w.t.ctx.stateDir, 'config-alert.json');
  await w.at(W8);
  assert.equal(cfg(), 1);
  assert.ok(existsSync(f));
  w.t.ctx.rules = env().ctx.rules;   // the same rules with a config that reads fine
  await w.at(W8 + HOUR);
  assert.equal(existsSync(f), false, 'the mark is gone once the config reads fine');
  assert.equal(cfg(), 1);
  w.t.ctx.rules = bad;
  await w.at(W8 + 2 * HOUR);
  assert.equal(cfg(), 2, 'the same problem again, an hour later: told at once');
});

test('L317: an ask-alerts told time 30 days ahead is not "told": the ask that cannot be pushed is told now', async () => {
  const w = world();
  delete w.t.ctx.push;
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
  const noPush = () => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === 'U-1').length;
  await w.at(W8);
  assert.equal(noPush(), 1);
  const f = join(w.t.ctx.stateDir, 'ask-alerts.json');
  const m = JSON.parse(readFileSync(f, 'utf8'));
  for (const k of Object.keys(m['U-1'])) m['U-1'][k] = { told_at: new Date(Date.parse(m['U-1'][k].told_at) + 30 * 24 * HOUR).toISOString() };
  writeFileSync(f, JSON.stringify(m));
  await w.at(W8 + MIN);
  assert.equal(noPush(), 2);
  await w.at(W8 + 2 * MIN);
  assert.equal(noPush(), 2);
});

// L321's rule on the ask marks: no mark to read is "not told". It tells, and never counts as told a moment ago.
test('L326: an ask-alerts mark that is null is due', async () => {
  const w = world();
  delete w.t.ctx.push;
  must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo' }));
  const noPush = () => w.t.alerts.filter((a) => a.type === 'approvals_no_push' && a.ask === 'U-1').length;
  await w.at(W8);
  assert.equal(noPush(), 1);
  const f = join(w.t.ctx.stateDir, 'ask-alerts.json');
  const m = JSON.parse(readFileSync(f, 'utf8'));
  for (const k of Object.keys(m['U-1'])) m['U-1'][k] = null;
  writeFileSync(f, JSON.stringify(m));
  await w.at(W8 + MIN);
  assert.equal(noPush(), 2, 'a null mark is not told');
  await w.at(W8 + 2 * MIN);
  assert.equal(noPush(), 2, 'and it is marked again');
});

// L329 (L321 sweep): every stored time M2 reads for "has it lapsed / is a push due" goes through shared pastTime. A time
// that can't be read, or lies an hour ahead (a clock that went back, a bad write), counts as long past: an expiry lapses
// now and a push goes out now, never waits on a time it can't trust. Two plants per site.
const PLANTS = (now) => [['unreadable', 'not a time'], ['1 h ahead', new Date(now + HOUR).toISOString()]];
const plant = (w, id, fields) => {
  const c = w.t.record.read('ask', id);
  must(w.t.record.write({ actor: 'approvals', entity: 'ask', id, expectRev: c.rev, doc: { ...c.doc, ...fields } }), `plant ${id}`);
};

for (const [name, at] of PLANTS(W8 + HOUR)) {
  test(`L329 kinds lapseAt + runOut: a raised_at ${name} lapses the ask at the next pass`, async () => {
    const w = world();
    yesNo(w);
    await w.at(W8);
    assert.equal(ask(w, 'Q-1').state, 'pushed');
    plant(w, 'Q-1', { raised_at: at });
    await w.at(W8 + HOUR);
    assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').reask_count], ['open', 1], 'lapsed now, not never (or an hour late)');
  });

  test(`L329 binding nextBox and tryBind: an ask whose raised_at is ${name} is not offered, and a box for it is refused as lapsed`, async () => {
    const w = world();
    session(w.t, 'FD-1');
    yesNo(w);
    await w.at(W8);
    w.t.clock.t = W8 + HOUR;
    assert.equal(nextBox(w.t.ctx, { sessionId: 'FD-1', role: 'front_door' })?.ask, 'Q-1', 'control: offered while it stands');
    plant(w, 'Q-1', { raised_at: at });
    assert.equal(nextBox(w.t.ctx, { sessionId: 'FD-1', role: 'front_door' }), null);
    const b = box(ask(w, 'Q-1').payload, W8 + HOUR);
    write(w.t, 'FD-1', b.entry);
    const r = must(processSession(w.t.ctx, { sessionId: 'FD-1', sourcePath: w.t.log('FD-1') }));
    assert.ok(r.events.some((e) => e.type === 'mismatched_question' && e.reason === 'the ask has lapsed'), JSON.stringify(r.events));
  });

  test(`L329 schedule: an urgent ask whose last_push_at is ${name} is re-pushed now`, async () => {
    const w = world();
    const t0 = AT('2026-10-01T12:00:00Z');
    must(createAsk(w.t.ctx, { id: 'U-1', kind: 'undo', card: 'C-1', title: 'Undo the export' }));
    await w.at(t0);
    assert.equal(w.pushes.length, 1);
    plant(w, 'U-1', { last_push_at: at === 'not a time' ? at : new Date(t0 + 30 * MIN + HOUR).toISOString() });
    await w.at(t0 + 30 * MIN);
    assert.equal(w.pushes.length, 2, 'pushed again at once, not held back by the stored time');
  });

  test(`L329 schedule: a non-urgent ask whose created_at is ${name} goes out in the next window`, async () => {
    const w = world();
    yesNo(w);
    plant(w, 'Q-1', { created_at: at === 'not a time' ? at : new Date(W8 + HOUR).toISOString() });
    await w.at(W8);
    assert.deepEqual(w.pushes.map((p) => p.ask), ['Q-1'], 'never kept out of every window');
  });

  test(`L329 schedule: a merge approval whose raised_at is ${name} no longer stands, and goes back at the next pass`, async () => {
    const w = riskyWorld();
    await w.at(W8);
    w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
    w.t.clock.t = W8 + HOUR;
    assert.equal((await readApprove(w.t.ctx, 'R-1', { view: w.view })).counted, true);
    assert.equal((await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view })).ok, true, 'control');
    plant(w, 'R-1', { raised_at: at === 'not a time' ? at : new Date(W8 + 2 * HOUR).toISOString() });
    const s = await approvalStands(w.t.ctx, 'R-1', { head: w.H, view: w.view });
    assert.deepEqual([s.ok, s.reason], [false, 'the approval lapsed: no merge within 24 hours']);
    await w.at(W8 + HOUR + MIN);
    assert.deepEqual([ask(w, 'R-1').state, ask(w, 'R-1').reask_count], ['open', 1], 'an unused approval never outlives a time it cannot trust');
  });
}

// L362 MAT-1, a standing rule: a time from outside the Mini's clock is stored as min(theirs, now). With GitHub ahead, a
// stored raised_at read strictly (pastTime) would lapse the ask at the next pass, and the re-ask too, so Joe's Approve
// could never count. Every outside-sourced stored time, with a clock 10 minutes ahead.
const AHEAD = 10 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const run = (w, sid = 'FD-1') => must(processSession(w.t.ctx, { sessionId: sid, sourcePath: w.t.log(sid) }));

test('L362 GitHub 10 min ahead: a risky ask raised on its time is stored at the Mini\'s now, stays raised, and its Approve counts', async () => {
  const w = riskyWorld();
  w.setAhead(AHEAD);
  await w.at(W8);
  assert.equal(ask(w, 'R-1').raised_at, iso(W8), 'raised_at from schedule.mjs: not ahead of now');
  await w.at(W8 + MIN);
  assert.deepEqual([ask(w, 'R-1').state, ask(w, 'R-1').reask_count], ['pushed', 0], 'never lapsed by GitHub\'s clock');
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR + AHEAD });
  w.t.clock.t = W8 + HOUR;
  assert.equal((await readApprove(w.t.ctx, 'R-1', { view: w.view })).counted, true);
  assert.equal(ask(w, 'R-1').answer.binding.submitted_at, iso(W8 + HOUR), 'submitted_at: not ahead of now');
});

test('L362 GitHub 10 min ahead: a decision raised on its time stays raised, and its answer is stored at the Mini\'s now', async () => {
  const w = world();
  w.setAhead(AHEAD);
  must(createAsk(w.t.ctx, { id: 'D-1', kind: 'decision', card: 'C-1', title: 'Which format', choices: ['CSV', 'JSON'], recommended: 'CSV' }));
  await w.at(W8);
  assert.equal(ask(w, 'D-1').raised_at, iso(W8), 'raised_at from decision.mjs: not ahead of now');
  await w.at(W8 + MIN);
  assert.deepEqual([ask(w, 'D-1').state, ask(w, 'D-1').reask_count], ['pushed', 0]);
  const pr = ask(w, 'D-1').pr;
  w.g.review(pr, { state: 'APPROVED', commit_id: w.g.pulls.get(pr).head, submitted_at: W8 + HOUR + AHEAD });
  w.t.clock.t = W8 + HOUR;
  assert.equal((await readDecision(w.t.ctx, 'D-1')).counted, true);
  assert.equal(ask(w, 'D-1').answer.binding.submitted_at, iso(W8 + HOUR), 'submitted_at: not ahead of now');
});

test('L362 a session log 10 min ahead: the box\'s times and the tap\'s are stored at the Mini\'s now', async () => {
  const w = world();
  session(w.t, 'FD-1');
  yesNo(w);
  w.t.clock.t = W8 + HOUR;
  const input = ask(w, 'Q-1').payload;
  const b = box(input, W8 + HOUR + AHEAD);
  write(w.t, 'FD-1', b.entry);
  run(w);
  const d = ask(w, 'Q-1');
  assert.deepEqual([d.boxes[0].bound_at, d.first_pushed_at, d.raised_at], [iso(W8 + HOUR), iso(W8 + HOUR), iso(W8 + HOUR)]);
  await w.at(W8 + HOUR + MIN);
  assert.equal(ask(w, 'Q-1').state, 'pushed', 'never lapsed by the log\'s clock');
  write(w.t, 'FD-1', tap(b.id, input, 'Yes', W8 + HOUR + AHEAD + MIN));
  run(w);
  assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').answer.at], ['answered', iso(W8 + HOUR + MIN)]);
});

// L362 MAT-2: a created_at that can't be read proves nothing about a box. The box never binds (an old box must not answer
// a new ask); the pass raises the ask afresh and tells Joe, and a tap on the old box is told why.
const NOW = W8 + 2 * HOUR;   // outside a window, so the pass only re-raises
const reasked = (w) => w.t.alerts.filter((a) => a.type === 'ask_time_unreadable');
for (const [name, bad] of [['null', null], ['garbage', 'not a time'], ['1 h ahead', iso(NOW + HOUR)]]) {
  test(`L362 a created_at that is ${name}: a box never binds on it, Joe is told, the ask is raised afresh, and a new box answers it`, async () => {
    const w = world();
    session(w.t, 'FD-1');
    yesNo(w);
    w.t.clock.t = NOW;
    plant(w, 'Q-1', { created_at: bad });
    const input = ask(w, 'Q-1').payload;
    const old = box(input, NOW);
    write(w.t, 'FD-1', old.entry);
    const r = run(w);
    assert.deepEqual(r.events.map((e) => [e.type, e.line]), [['mismatched_question', TIME_REASKED_LINE]], 'never bound');
    assert.equal(ask(w, 'Q-1').state, 'open');

    const e = await w.at(NOW + MIN);
    assert.ok(e.events.some((x) => x.type === 'reasked_time_unreadable' && x.line === TIME_REASKED_LINE), JSON.stringify(e.events));
    assert.equal(reasked(w).length, 1);
    assert.equal(approvalsAlertText('sample-app', reasked(w)[0]), 'The question about C-1 is being asked again because its time could not be read. An earlier copy of it no longer counts.', 'what Joe actually receives');
    const d = ask(w, 'Q-1');
    assert.deepEqual([d.state, d.created_at, d.time_reasked_at, d.reask_count, d.raised_at], ['open', iso(NOW + MIN), iso(NOW + MIN), 0, undefined], 'raised afresh; the one re-ask is not spent');

    await w.at(NOW + 2 * MIN);
    assert.equal(reasked(w).length, 1, 'told once: its time reads now');

    write(w.t, 'FD-1', tap(old.id, input, 'Yes', NOW + 3 * MIN));
    const closed = run(w).events;
    assert.deepEqual(closed.map((x) => [x.type, x.line]), [['closed', TIME_REASKED_LINE]], 'the old tap is told why, and counts nothing');
    assert.equal(ask(w, 'Q-1').state, 'open');

    w.t.clock.t = NOW + 4 * MIN;
    const fresh = box(input, NOW + 4 * MIN);
    write(w.t, 'FD-1', fresh.entry, tap(fresh.id, input, 'Yes', NOW + 4 * MIN));
    run(w);
    assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').answer.choice], ['answered', 'Yes']);
  });
}

test('L362 a box already live when the time goes bad is released, and its tap gets the asked-again line, not "had closed"', async () => {
  const w = world();
  session(w.t, 'FD-1');
  yesNo(w);
  w.t.clock.t = NOW;
  const input = ask(w, 'Q-1').payload;
  const b = box(input, NOW);
  write(w.t, 'FD-1', b.entry);
  run(w);
  assert.equal(ask(w, 'Q-1').state, 'pushed', 'control: bound');
  plant(w, 'Q-1', { created_at: 'not a time' });
  await w.at(NOW + MIN);
  const d = ask(w, 'Q-1');
  assert.deepEqual([d.state, d.boxes[0].status, d.boxes[0].reason, d.raised_at, d.raised_reask], ['open', 'released', 'time_unreadable', undefined, undefined], 'its old raise is gone, so this round is raised afresh');
  write(w.t, 'FD-1', tap(b.id, input, 'Yes', NOW + 2 * MIN));
  assert.deepEqual(run(w).events.map((e) => [e.type, e.line]), [['closed', TIME_REASKED_LINE]]);
  assert.equal(ask(w, 'Q-1').answer, undefined);
});

test('L362 a box from before the re-raise, first read after it, is refused and its tap told the same', async () => {
  const w = world();
  session(w.t, 'FD-1');
  yesNo(w);
  w.t.clock.t = NOW;
  plant(w, 'Q-1', { created_at: 'not a time' });
  await w.at(NOW + MIN);
  const input = ask(w, 'Q-1').payload;
  const old = box(input, NOW);
  write(w.t, 'FD-1', old.entry, tap(old.id, input, 'Yes', NOW + 2 * MIN));
  assert.deepEqual(run(w).events.map((e) => [e.type, e.line]), [['mismatched_question', TIME_REASKED_LINE], ['closed', TIME_REASKED_LINE]]);
  assert.equal(ask(w, 'Q-1').answer, undefined);
});

test('L362 a healthy ask keeps its refusal: a box older than the ask binds nothing, with no asked-again line', async () => {
  const w = world();
  session(w.t, 'FD-1');
  w.t.clock.t = NOW;
  yesNo(w);
  const input = ask(w, 'Q-1').payload;
  const old = box(input, NOW - MIN);
  write(w.t, 'FD-1', old.entry, tap(old.id, input, 'Yes', NOW));
  const events = run(w).events;
  assert.deepEqual(events.map((e) => [e.type, e.reason, e.line]), [['mismatched_question', 'asked before the ask was created', undefined]]);
});

for (const answer of [false, 'throws']) {
  test(`L362 a tell the sink refuses (${answer}) leaves the ask as it is, and the next pass tells and re-raises`, async () => {
    const w = world();
    yesNo(w);
    w.t.clock.t = NOW;
    plant(w, 'Q-1', { created_at: 'not a time' });
    w.t.sink.answer = answer;
    await w.at(NOW + MIN);
    assert.equal(ask(w, 'Q-1').created_at, 'not a time', 'never raised without Joe being told');
    delete w.t.sink.answer;
    await w.at(NOW + 2 * MIN);
    assert.equal(ask(w, 'Q-1').created_at, iso(NOW + 2 * MIN));
    assert.equal(reasked(w).length, 1);
  });
}

test('L362 only a waiting tap ask is re-raised: a GitHub ask and an answered ask keep their created_at', async () => {
  const w = riskyWorld();
  yesNo(w);
  await w.at(W8);
  must(writeDoc(w.t.record, 'ask', askStore(w.t.record).ask('Q-1'), { ...ask(w, 'Q-1'), state: 'answered', answer: { choice: 'Yes' } }));
  plant(w, 'R-1', { created_at: 'not a time' });
  plant(w, 'Q-1', { created_at: 'not a time' });
  await w.at(W8 + MIN);
  assert.deepEqual([ask(w, 'R-1').created_at, ask(w, 'Q-1').created_at, reasked(w).length], ['not a time', 'not a time', 0]);
});

// L362 m1: the newest Front Door is the diary's newest, never the one with the latest stored launch time.
const launchAt = (w, sid, launched_at) => must(w.t.record.write({ actor: 'dispatcher', entity: 'launch', id: `launch-${sid}`, expectRev: 0,
  doc: { session_id: sid, role: 'front_door', card: 'C-0', head: 'a'.repeat(40), rev: 1, launched_at } }), 'launch');

test('L362 m1: a stale launch stamped days ahead does not beat the live one', () => {
  const w = world();
  launchAt(w, 'FD-1', iso(w.t.clock.t + 72 * HOUR));
  launchAt(w, 'FD-2', iso(w.t.clock.t));
  assert.equal(boxSession(w.t.record, 'FD-2').ok, true);
  assert.equal(boxSession(w.t.record, 'FD-1').replaced, true);
});

test('L362 m1: a live launch with a garbage time does not sort oldest', () => {
  const w = world();
  launchAt(w, 'FD-1', iso(w.t.clock.t));
  launchAt(w, 'FD-2', 'not a time');
  assert.equal(boxSession(w.t.record, 'FD-2').ok, true);
  assert.equal(boxSession(w.t.record, 'FD-1').replaced, true);
});

// L362 m2, m3: the plants that survived the audit of #180.
test('L362 m2 and P9: a pushed merge approval with no readable raised time says why it counted nothing', async () => {
  for (const raised_at of [null, 'not a time']) {
    const w = riskyWorld();
    await w.at(W8);
    w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
    w.t.clock.t = W8 + HOUR;
    plant(w, 'R-1', { raised_at });
    const r = await readApprove(w.t.ctx, 'R-1', { view: w.view });
    assert.deepEqual([r.counted, r.reason], [false, 'the ask has no readable raised time this round']);
  }
});

test('L362 P9: a raised_at an hour ahead counts no Approve, even one stamped after it', async () => {
  const w = riskyWorld();
  await w.at(W8);
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + 3 * HOUR });
  w.t.clock.t = W8 + HOUR;
  plant(w, 'R-1', { raised_at: iso(W8 + 2 * HOUR) });
  const r = await readApprove(w.t.ctx, 'R-1', { view: w.view });
  assert.deepEqual([r.counted, r.lapsed], [false, true]);
});

test('L362 P9b: an Approve is read only for this round\'s raise', async () => {
  const w = riskyWorld();
  await w.at(W8);
  w.g.review(7, { state: 'APPROVED', commit_id: w.H, submitted_at: W8 + HOUR });
  w.t.clock.t = W8 + HOUR;
  assert.ok(lapseAt(ask(w, 'R-1'), W8 + HOUR) > W8, 'control');
  plant(w, 'R-1', { raised_reask: 5 });
  const r = await readApprove(w.t.ctx, 'R-1', { view: w.view });
  assert.deepEqual([r.counted, r.reason], [false, 'the ask has no readable raised time this round']);
});

test('L362 P6b: a raised_at 30 s ahead is kept, and runs 12 hours from that time', async () => {
  const w = world();
  yesNo(w);
  await w.at(W8);
  const ahead = W8 + HOUR + 30_000;
  plant(w, 'Q-1', { raised_at: iso(ahead) });
  assert.equal(lapseAt(ask(w, 'Q-1'), W8 + HOUR), ahead + 12 * HOUR);
  await w.at(W8 + HOUR);
  assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').reask_count], ['pushed', 0], 'a small drift is no lapse');
});

for (const raised_at of [12345, '']) {
  test(`L362 P13: a raised_at of ${JSON.stringify(raised_at)} lapses the ask, not never`, async () => {
    const w = world();
    yesNo(w);
    await w.at(W8);
    plant(w, 'Q-1', { raised_at });
    assert.equal(lapseAt(ask(w, 'Q-1'), W8 + HOUR), -Infinity);
    await w.at(W8 + HOUR);
    assert.deepEqual([ask(w, 'Q-1').state, ask(w, 'Q-1').reask_count], ['open', 1]);
  });
}

// L326: the config mark names its problem, so a different problem is told at once, not held back by the day.
test('L326: a different config problem is told at once', async () => {
  const w = world({ 'approvals.push_windows': [] });
  const reasons = () => w.t.alerts.filter((a) => a.type === 'approvals_config').map((a) => a.reason);
  await w.at(W8);
  assert.equal(reasons().length, 1);
  w.t.ctx.rules = world({ 'accounts.joe.github_id': 'not a number' }).t.ctx.rules;
  await w.at(W8 + HOUR);
  assert.equal(reasons().length, 2);
  assert.notEqual(reasons()[0], reasons()[1]);
});
