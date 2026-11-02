import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { createHash } from 'node:crypto';
import { makeAlerts, alertKey, fakeIssues } from './alerts.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';

function setup() {
  let t = Date.parse('2026-11-03T08:00:00Z');
  const clock = { now: () => new Date(t), tick: (min) => { t += min * 60000; } };
  const gh = fakeIssues();
  const alerts = makeAlerts({ rec: memoryRecord(), gh, owner: 'owner-login', now: clock.now });
  return { gh, alerts, clock };
}

test('review-0b-7 M10: 120 faked minutes of a persistent condition → exactly 1 issue, 0 extra comments, body updated', async () => {
  const { gh, alerts, clock } = setup();
  const key = alertKey('product 1', 'unsupported-deploy', 'dpl_x');
  for (let m = 0; m < 120; m++) { await alerts.raise({ key, title: 'Unsupported production deploy', body: 'deploy dpl_x is live' }); clock.tick(1); }
  assert.equal(gh.calls.filter(([c]) => c === 'open').length, 1);
  assert.equal(gh.calls.filter(([c]) => c === 'comment').length, 0);
  assert.equal(gh.issues.get(1).assignee, 'owner-login');
  assert.match(gh.issues.get(1).body, /seen 120 times/);
});

test('a change of the condition comments once; clearing closes; coming back opens a new issue', async () => {
  const { gh, alerts } = setup();
  const key = alertKey('p', 'heartbeat', 'red');
  await alerts.raise({ key, title: 'Heartbeat red', body: 'Dispatcher pass late' });
  await alerts.raise({ key, title: 'Heartbeat red', body: 'Dispatcher pass late' });
  assert.equal(await alerts.raise({ key, title: 'Heartbeat red', body: 'M10 Rules unreadable' }), 'changed');
  assert.equal(gh.issues.get(1).comments.length, 1);
  assert.equal(await alerts.clear({ key }), 'cleared');
  assert.equal(gh.issues.get(1).closed, true);
  assert.equal(await alerts.raise({ key, title: 'Heartbeat red', body: 'again' }), 'opened');
  assert.equal(gh.issues.size, 2);
});

test('an issue the owner closed while the condition holds is not reopened until it clears and comes back', async () => {
  const { gh, alerts } = setup();
  const key = alertKey('p', 'setting-changed', 'fp1');
  await alerts.raise({ key, title: 'Setting changed', body: 'b' });
  gh.ownerCloses(1);
  for (let i = 0; i < 5; i++) assert.equal(await alerts.raise({ key, title: 'Setting changed', body: 'b' }), 'suppressed');
  assert.equal(gh.issues.size, 1);
  await alerts.clear({ key });
  assert.equal(await alerts.raise({ key, title: 'Setting changed', body: 'b' }), 'opened');
  assert.equal(gh.issues.size, 2);
});

test('alert state lives in the record as a Ledger fact', async () => {
  const rec = memoryRecord();
  const alerts = makeAlerts({ rec, gh: fakeIssues(), owner: 'o' });
  await alerts.raise({ key: 'k', title: 't', body: 'b' });
  const facts = rec.list('fact');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].doc.status, 'open');
  assert.equal(rec.diary().at(-1).actor, 'ledger');
});

// ---- L143: a GitHub call that answers false, or an open with no issue number, is a lost alert ----

// A record clock apart from the tick's (L143): the writer stamps facts from its own fixed clock, raise reads the tick.
function lossSetup(over = {}) {
  let t = Date.parse('2026-11-03T08:00:00Z');
  const rec = memoryRecord();
  const gh = Object.assign(fakeIssues(), over);
  const writer = makeFactWriter(rec, { actor: 'ledger', now: () => new Date('2026-01-01T00:00:00Z') });
  const alerts = makeAlerts({ rec, gh, owner: 'o', now: () => new Date(t), writer });
  return { rec, gh, alerts, writer, tick: (min) => { t += min * 60e3; } };
}
const opens = (gh) => gh.calls.filter(([c]) => c === 'open').length;

test('L143: an open with no issue number answers false and saves nothing; the next pass opens it', async () => {
  for (const lost of [false, undefined, null, 0, -1, 1.5, '7', { number: 7 }]) {
    const real = fakeIssues();
    const l = lossSetup({ open: async () => lost });
    assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b' }), false, `open answered ${JSON.stringify(lost)}`);
    assert.equal(l.alerts.state('k'), null, 'no open alert without an issue');
    l.gh.open = real.open; l.gh.isClosed = real.isClosed;
    l.tick(1);
    assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b' }), 'opened');
    assert.equal(l.alerts.state('k').issue, 1);
    assert.equal(l.alerts.state('k').since, '2026-11-03T08:01:00.000Z', 'times are the tick, not the record clock');
  }
});

test('L143: an open alert saved without an issue (before the fix) is opened again, never read as closed by the owner', async () => {
  const l = lossSetup();
  const id = `alert-${createHash('sha256').update('k').digest('hex').slice(0, 16)}`;
  l.writer.put(id, { kind: 'fact.alert', key: 'k', title: 't', body: 'b', status_text: 'b', status: 'open', since: 'x', last: 'x', count: 1 });
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b' }), 'opened');
  assert.equal(opens(l.gh), 1);
  assert.equal(l.alerts.state('k').status, 'open');
  assert.equal(l.alerts.state('k').issue, 1);
});

test('L143: a change notice whose comment answered false answers false, keeps the old status, and is sent next pass', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'first', status: 's1' });
  const comment = l.gh.comment;
  l.gh.comment = async () => false;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), false);
  assert.equal(l.alerts.state('k').status_text, 's1');
  assert.equal(l.alerts.state('k').count, 1, 'the lost pass is not counted');
  l.gh.comment = comment;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), 'changed');
  assert.deepEqual(l.gh.issues.get(1).comments, ['Changed: second']);
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), 'updated', 'sent once, not again');
  assert.equal(l.gh.issues.get(1).comments.length, 1);
});

test('L143: an edit that answered false answers false and saves nothing', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  l.gh.edit = async () => false;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'c', status: 's2' }), false);
  assert.equal(l.gh.issues.get(1).comments.length, 0, 'no comment after a lost edit');
  assert.equal(l.alerts.state('k').status_text, 's1');
});

test('L143: a close that answered false answers false and keeps the alert open; the next clear closes it', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'b' });
  const close = l.gh.close;
  l.gh.close = async () => false;
  assert.equal(await l.alerts.clear({ key: 'k' }), false);
  assert.equal(l.alerts.state('k').status, 'open');
  l.gh.close = close;
  assert.equal(await l.alerts.clear({ key: 'k' }), 'cleared');
  assert.equal(l.gh.issues.get(1).closed, true);
});

test('L143: every GitHub call that throws makes raise or clear throw and saves nothing', async () => {
  for (const m of ['open', 'edit', 'comment', 'isClosed', 'close']) {
    const l = lossSetup();
    if (m !== 'open') await l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
    const before = l.alerts.state('k');
    l.gh[m] = async () => { throw new Error('github down'); };
    const call = m === 'close' ? l.alerts.clear({ key: 'k' }) : l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's2' });
    await assert.rejects(call, /github down/, m);
    assert.deepEqual(l.alerts.state('k'), before, `${m}: nothing saved`);
  }
});

test('L152 m2: an open alert saved without an issue (before L143) clears without calling GitHub', async () => {
  const calls = [];
  const no = (name) => async (...a) => { calls.push(name); throw new Error(`${name} called`); };
  const l = lossSetup({ open: no('open'), edit: no('edit'), comment: no('comment'), close: no('close'), isClosed: no('isClosed') });
  const id = `alert-${createHash('sha256').update('k').digest('hex').slice(0, 16)}`;
  l.writer.put(id, { kind: 'fact.alert', key: 'k', title: 't', body: 'b', status_text: 'b', status: 'open', since: 'x', last: 'x', count: 1 });
  assert.equal(await l.alerts.clear({ key: 'k' }), 'cleared');
  assert.deepEqual(calls, []);
  assert.equal(l.alerts.state('k').status, 'cleared');
});
