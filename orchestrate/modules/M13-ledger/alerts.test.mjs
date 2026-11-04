import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { createHash } from 'node:crypto';
import { makeAlerts, alertKey, fakeIssues, wasTold } from './alerts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { makeFactWriter } from '../M12-sensors/facts.mjs';
import { dueToTell, STILL_WAITING_MS, FUTURE_SKEW_MS } from '../../shared/still-waiting.mjs';
import { dueToTell as notifyDue, RETELL_MS, FUTURE_SKEW_MS as NOTIFY_SKEW } from './outside-check/notify.mjs';

const idFor = (key) => `alert-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

function setup() {
  let t = Date.parse('2026-11-03T08:00:00Z');
  const clock = { now: () => new Date(t), tick: (min) => { t += min * 60000; } };
  const gh = fakeIssues({ now: clock.now });
  const rec = memoryRecord();
  const alerts = makeAlerts({ rec, gh, owner: 'owner-login', now: clock.now });
  return { gh, alerts, clock, rec };
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
  assert.deepEqual(l.gh.issues.get(1).comments.map((c) => c.split('\n')[0]), ['Changed: second']);
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

// L315: an open issue assigned to the owner does not count as telling them again. A comment notifies; a body edit doesn't.
const comments = (gh) => gh.calls.filter(([c]) => c === 'comment').length;
const standing = { key: alertKey('product 1', 'kind', 'x'), title: 'A standing alert', body: 'first line\nsecond line', status: 'down' };

test('L315: a condition that stands is commented on again every 24 h, not more often, and stops when it clears', async () => {
  const { gh, alerts, clock } = setup();
  assert.equal(await alerts.raise(standing), 'opened');
  clock.tick(2 * 60);
  assert.equal(await alerts.raise(standing), 'updated');
  assert.equal(comments(gh), 0, 'quiet at +2 h');
  clock.tick(23 * 60);
  assert.equal(await alerts.raise(standing), 'reminded');
  assert.equal(comments(gh), 1, 'told at +25 h');
  assert.match(gh.issues.get(1).comments[0], /^Still open since 2026-11-03T08:00:00\.000Z: first line$/);
  clock.tick(60);
  assert.equal(await alerts.raise(standing), 'updated');
  assert.equal(comments(gh), 1, 'the 24 h run from the last comment');
  clock.tick(24 * 60);
  assert.equal(await alerts.raise(standing), 'reminded');
  assert.equal(comments(gh), 2);
  await alerts.clear({ key: standing.key });
  clock.tick(48 * 60);
  assert.equal(await alerts.raise(standing), 'opened', 'a condition that comes back is a new alert');
  assert.equal(comments(gh), 2);
});

test('L315: a change of status counts as telling, so the 24 h run from it', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(23 * 60);
  assert.equal(await alerts.raise({ ...standing, status: 'worse' }), 'changed');
  clock.tick(2 * 60);
  assert.equal(await alerts.raise({ ...standing, status: 'worse' }), 'updated');
  assert.equal(comments(gh), 1);
  clock.tick(22 * 60);
  assert.equal(await alerts.raise({ ...standing, status: 'worse' }), 'reminded');
  assert.equal(comments(gh), 2);
});

test('L315: a reminder whose comment answered false answers false, saves nothing, and is sent next pass', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(25 * 60);
  const comment = gh.comment;
  gh.comment = async () => false;
  assert.equal(await alerts.raise(standing), false);
  assert.equal(alerts.state(standing.key).count, 1, 'nothing saved');
  gh.comment = comment;
  clock.tick(1);
  assert.equal(await alerts.raise(standing), 'reminded');
  assert.equal(comments(gh), 1);
});

test('L315: a reminder whose comment throws makes raise throw and saves nothing', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(25 * 60);
  gh.comment = async () => { throw new Error('GitHub is down'); };
  await assert.rejects(alerts.raise(standing), /GitHub is down/);
  assert.equal(alerts.state(standing.key).count, 1);
});

test('L315: an issue the owner closed is not commented on: closing it is their answer', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  for (let d = 0; d < 3; d++) { clock.tick(25 * 60); assert.equal(await alerts.raise(standing), 'suppressed'); }
  assert.equal(comments(gh), 0);
});

test('L315: an alert saved before told_at is dated from when it opened; a told_at that cannot be read or is in the future tells now', async () => {
  for (const [plant, min, want] of [[undefined, 60, 'updated'], [undefined, 25 * 60, 'reminded'], ['not a time', 60, 'reminded'], ['2099-01-01T00:00:00.000Z', 60, 'reminded']]) {
    const { rec, alerts, clock } = setup();
    await alerts.raise(standing);
    const writer = makeFactWriter(rec, { actor: 'ledger', now: clock.now });
    const { told_at, ...old } = alerts.state(standing.key);
    assert.ok(told_at, 'opening is telling');
    writer.put(idFor(standing.key), { ...old, ...(plant === undefined ? {} : { told_at: plant }) });
    clock.tick(min);
    assert.equal(await alerts.raise(standing), want, String(plant));
  }
});

// L371 item 1: the told mark passes the fact allow-list. Without told_at on the alert shape it is dropped on write, and
// every pass reads as not told: 119 comments in two hours.
test('L371: the told mark survives the write, so a standing alert is commented on once a day, not every pass', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  assert.equal(alerts.state(standing.key).told_at, '2026-11-03T08:00:00.000Z');
  for (let m = 10; m <= 49 * 60; m += 10) { clock.tick(10); await alerts.raise(standing); }
  assert.equal(comments(gh), 2, 'at +24 h and +48 h');
  assert.equal(alerts.state(standing.key).told_at, '2026-11-05T08:00:00.000Z');
});

// L371 item 2: notify.mjs ships alone into the outside repo, so it keeps a copy of the rule. Same table, same answers.
test('L371: notify.mjs\'s copy of the 24 h rule answers as the shared rule does', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const H = 60 * 60_000;
  // The number and the Date are recent on purpose: only ISO text can be read, so both must tell, and a copy that reads
  // them would call them fresh. An old number tells either way, and would hide that.
  // The offset row is an hour ago as a time, but sorts after now as text, so a copy comparing text reads it as ahead and says due.
  const table = [null, undefined, '', 'garbage', now - H, new Date(now - H), ago(-30_000), ago(-59_999), ago(-60_000), ago(-60_001), ago(-H), ago(0), ago(23 * H), ago(24 * H - 1), ago(24 * H), ago(25 * H), '2026-11-03T13:00:00+02:00'];
  for (const told of table) assert.equal(notifyDue(told, now), dueToTell({ told_at: told }, now), `told ${String(told)}`);
  assert.equal(RETELL_MS, STILL_WAITING_MS);
  assert.equal(NOTIFY_SKEW, FUTURE_SKEW_MS);
  // The table is worth something only if it holds both answers.
  assert.deepEqual([...new Set(table.map((x) => notifyDue(x, now)))].sort(), [false, true]);
});

// L371 item 3: closing an issue answers that cause. A close never silences a later problem.
test('L371: after the owner closes an issue, a different cause opens a new one, and the same cause stays quiet', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  assert.equal(await alerts.raise(standing), 'suppressed');
  clock.tick(1);
  assert.equal(await alerts.raise({ ...standing, status: 'a different cause' }), 'opened', 'once it was already read as closed');
  assert.equal(gh.issues.size, 2);
  assert.equal(gh.issues.get(1).closed, true, 'the closed one stays closed');
  assert.equal(gh.issues.get(2).closed, false);
  assert.equal(alerts.state(standing.key).issue, 2);
  assert.equal(alerts.state(standing.key).status, 'open');
  assert.equal(await alerts.raise({ ...standing, status: 'a different cause' }), 'updated', 'the new issue is the live one');
});

test('L371: a different cause on the very pass that finds the issue closed opens a new one', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  assert.equal(await alerts.raise({ ...standing, status: 'a different cause' }), 'opened');
  assert.equal(gh.issues.size, 2);
});

test('L371: with no status, a different body is a different cause, and the same body stays quiet', async () => {
  const { gh, alerts } = setup();
  const plain = { key: standing.key, title: 'A plain alert', body: 'deploy A is live' };
  await alerts.raise(plain);
  gh.ownerCloses(1);
  assert.equal(await alerts.raise(plain), 'suppressed');
  assert.equal(await alerts.raise({ ...plain, body: 'deploy B is live' }), 'opened');
});

test('L371: the same cause coming back after it cleared opens a new issue, closed by the owner or not', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  assert.equal(await alerts.raise(standing), 'suppressed');
  assert.equal(await alerts.clear({ key: standing.key }), 'cleared');
  assert.equal(await alerts.raise(standing), 'opened');
  assert.equal(gh.issues.size, 2);
});

test('L371: opening the new issue when GitHub loses it answers false, and the next pass tries again', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  await alerts.raise(standing);
  const open = gh.open;
  gh.open = async () => undefined;
  const other = { ...standing, status: 'a different cause' };
  assert.equal(await alerts.raise(other), false);
  assert.equal(alerts.state(standing.key).status, 'closed-by-owner', 'nothing saved');
  gh.open = open;
  assert.equal(await alerts.raise(other), 'opened');
});

// L389 MAT-1: the Record is what remembers what was told, so when it refuses, the limit has to come from GitHub.
const writerOf = (rec, clock) => makeFactWriter(rec, { actor: 'ledger', now: clock.now, masker: makeMasker() });

// `refuse` says which writes the Record refuses right now; everything else goes through.
function refusing() {
  let t = Date.parse('2026-11-03T08:00:00Z');
  const clock = { now: () => new Date(t), tick: (min) => { t += min * 60000; } };
  const gh = fakeIssues({ now: clock.now });
  const rec = memoryRecord();
  const real = writerOf(rec, clock);
  const world = { refuse: () => false };
  const writer = { get: real.get, put: (id, doc) => (world.refuse(doc) ? { ok: false, reason: 'the store is full' } : real.put(id, doc)) };
  const alerts = makeAlerts({ rec, gh, owner: 'o', now: clock.now, writer });
  return { gh, alerts, clock, world };
}
const REFUSED = /the Record refused to save this alert's state: the store is full/;
const perDay = (at) => { for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 24 * 60, `comments at ${at[i - 1]} and ${at[i]} min`); };

// 120 one-minute passes, then to 50 h in 10-minute passes.
async function overTime({ gh, alerts, clock }, alert) {
  const at = []; const answers = [];
  let m = 0;
  while (m < 50 * 60) {
    const step = m < 120 ? 1 : 10;
    clock.tick(step); m += step;
    const before = comments(gh);
    answers.push(await alerts.raise(alert()));
    if (comments(gh) > before) at.push(m);
  }
  return { at, answers };
}

test('L389: a refused reminder save: one comment a day over 120 passes and 50 h, and every pass answers the refusal', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  w.world.refuse = () => true;
  const { at, answers } = await overTime(w, () => standing);
  assert.equal(comments(w.gh), 3, 'due on the first pass, then every 24 h over the next 50 h');
  perDay(at);
  assert.equal(opens(w.gh), 1);
  for (const a of answers) { assert.equal(wasTold(a), false); assert.match(a.refused, REFUSED); }
});

test('L389: a refused save on a status change: one comment a day, and every pass answers the refusal', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  const changed = { ...standing, status: 'other cause' };
  const { at, answers } = await overTime(w, () => changed);
  assert.equal(comments(w.gh), 3, 'at the first pass, and 24 h and 48 h on');
  perDay(at);
  assert.equal(opens(w.gh), 1);
  for (const a of answers) assert.match(a.refused, REFUSED);
});

test('L389: a refused save on opening: one issue over 120 passes and 50 h, no comments, and every pass answers the refusal', async () => {
  const w = refusing();
  w.world.refuse = () => true;
  const { answers } = await overTime(w, () => standing);
  assert.equal(opens(w.gh), 1);
  assert.equal(comments(w.gh), 0);
  for (const a of answers) assert.match(a.refused, REFUSED);
});

test('L389: once the Record takes writes again, the alert goes on from the issue GitHub already holds', async () => {
  const w = refusing();
  w.world.refuse = () => true;
  await w.alerts.raise(standing);
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(w.alerts.state(standing.key).issue, 1);
  assert.equal(opens(w.gh), 1);
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
});

test('L389: a save lost after the reminder went out is made good next pass, and the next reminder runs from that comment', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  w.world.refuse = () => true;
  assert.ok((await w.alerts.raise(standing)).refused);
  w.world.refuse = () => false;
  w.clock.tick(60);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(w.alerts.state(standing.key).told_at, '2026-11-04T08:00:00.000Z', 'GitHub\'s comment time, not this pass');
  assert.equal(comments(w.gh), 1);
  w.clock.tick(23 * 60);
  assert.equal(await w.alerts.raise(standing), 'reminded');
});

test('L389: a comment time from the future never moves told_at ahead', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  const first = w.alerts.state(standing.key).told_at;
  w.clock.tick(25 * 60);
  const ahead = '2026-11-20T00:00:00.000Z';
  w.gh.latestOwnComment = async () => ({ at: ahead, body: '' });
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.notEqual(w.alerts.state(standing.key).told_at, ahead);
  assert.notEqual(w.alerts.state(standing.key).told_at, first);
});

test('L389: a new status still notifies at once; only the same status is held back', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise({ ...standing, status: 'A' });
  for (const status of ['B', 'C', 'B', 'A']) { clock.tick(10); assert.equal(await alerts.raise({ ...standing, status }), 'changed'); }
  assert.equal(comments(gh), 4);
});

test('L389: suppressed, updated and cleared each answer a refused save', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  w.clock.tick(10);
  assert.match((await w.alerts.raise(standing)).refused, REFUSED);
  assert.match((await w.alerts.clear({ key: standing.key })).refused, REFUSED);
  assert.equal(w.gh.calls.filter(([c]) => c === 'close').length, 1);
  assert.match((await w.alerts.clear({ key: standing.key })).refused, REFUSED);
  assert.equal(w.gh.calls.filter(([c]) => c === 'close').length, 1, 'the second try only writes again');
  const x = refusing();
  await x.alerts.raise(standing);
  x.gh.ownerCloses(1);
  x.world.refuse = () => true;
  assert.match((await x.alerts.raise(standing)).refused, REFUSED);
  assert.equal(opens(x.gh), 1);
});

// L393 m1: that read only matters once the Record has refused, so holding back on it would lose real alerts.
test('L393: a comment read GitHub refuses still sends; a refused issue list sends nothing', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  w.gh.latestOwnComment = async () => false;
  assert.equal(await w.alerts.raise(standing), 'reminded');
  assert.equal(await w.alerts.raise({ ...standing, status: 'other cause' }), 'changed');
  assert.equal(comments(w.gh), 2);
  const y = refusing();
  y.gh.findOpen = async () => false;
  assert.equal(await y.alerts.raise(standing), false);
  assert.equal(opens(y.gh), 0);
});

// L393 MAT-A: a clear the Record refused leaves it saying "open" over the robot's own close.
test('L393: a refused clear, then the cause comes back: a new issue, never suppressed', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  assert.match((await w.alerts.clear({ key: standing.key })).refused, REFUSED);
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'opened');
  assert.equal(w.alerts.state(standing.key).issue, 2);
  for (let i = 0; i < 5; i++) { w.clock.tick(25 * 60); assert.notEqual(await w.alerts.raise(standing), 'suppressed'); }
  assert.equal(opens(w.gh), 2);
});

test('L393: the same, with the Record still refusing when it comes back: one new issue, then it goes on once the Record takes it', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  await w.alerts.clear({ key: standing.key });
  for (let i = 0; i < 6; i++) { w.clock.tick(10); assert.match((await w.alerts.raise(standing)).refused, REFUSED); }
  assert.equal(opens(w.gh), 2);
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(w.alerts.state(standing.key).issue, 2);
  assert.equal(opens(w.gh), 2);
});

test('L393: a close only GitHub can name decides: the owner\'s holds, one it can\'t read opens anew', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.gh.ownerCloses(1);
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'suppressed');
  w.gh.closedByOwner = async () => assert.fail('a saved owner\'s close is not read again');
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'suppressed');
  const y = refusing();
  await y.alerts.raise(standing);
  y.gh.ownerCloses(1);
  y.gh.closedByOwner = async () => false;
  y.clock.tick(10);
  assert.equal(await y.alerts.raise(standing), 'opened');
});

// L389 m2: with a status, the status alone is the cause, on a closed issue and an open one.
test('L389: once a status is passed, a body change is never a new cause', async () => {
  const { gh, alerts, clock } = setup();
  const red = (m) => ({ key: standing.key, title: 't', body: `down ${m} minutes`, status: 'red' });
  await alerts.raise(red(1));
  clock.tick(10);
  assert.equal(await alerts.raise(red(11)), 'updated');
  assert.equal(comments(gh), 0);
  gh.ownerCloses(1);
  for (const m of [21, 31, 41]) { clock.tick(10); assert.equal(await alerts.raise(red(m)), 'suppressed'); }
  assert.equal(opens(gh), 1);
  assert.equal(comments(gh), 0);
});
