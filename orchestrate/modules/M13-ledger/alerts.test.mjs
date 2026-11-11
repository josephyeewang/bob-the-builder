import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRecord } from '../../shared/record.mjs';
import { createHash } from 'node:crypto';
import { makeAlerts, alertKey, fakeIssues, HOME_PREFIX, lastLine, wasTold, clockAhead, clockTooFast, CLOCK_AHEAD_MS, sweepFactId, sweepListFactId, SWEEP_NOTE, SWEEP_EVERY_MS, SWEEP_LIST_TRUST_MS } from './alerts.mjs';
import { makeMasker } from '../M12-sensors/mask.mjs';
import { makeFactWriter, TROUBLE_SOURCES } from '../M12-sensors/facts.mjs';
import { dueToTell, STILL_WAITING_MS, FUTURE_SKEW_MS } from '../../shared/still-waiting.mjs';
import { dueToTell as notifyDue, RETELL_MS, FUTURE_SKEW_MS as NOTIFY_SKEW } from './outside-check/notify.mjs';

const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const idFor = (key) => `alert-${hashOf(key)}`;
/** What an issue's footer says. */
const foot = (gh, n = 1) => Object.fromEntries(/^<!-- orch:alert v1 (.*) -->$/.exec(lastLine(gh.issues.get(n).body))[1].split(' ').map((x) => x.split('=')));
/** What the Record caches for a key: nothing but where to look. */
const cached = (rec, key) => makeFactWriter(rec, { actor: 'ledger' }).get(idFor(key));

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

test('L401: the issue holds the state; the Record holds only where to look', async () => {
  const { gh, alerts, rec } = setup();
  await alerts.raise({ key: 'k', title: 't', body: 'b', status: 'down' });
  const facts = rec.list('fact');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].doc.status, 'open');
  assert.equal(facts[0].doc.issue, 1);
  for (const k of ['body', 'title', 'since', 'count', 'told_at', 'status_text']) assert.equal(facts[0].doc[k], undefined, k);
  assert.equal(rec.diary().at(-1).actor, 'ledger');
  const f = foot(gh);
  assert.equal(f.key, idFor('k'));
  assert.equal(f.status, hashOf('down'));
  assert.equal(f.since, '2026-11-03T08:00:00.000Z');
  assert.equal(f.told, f.since);
  assert.equal(f.cleared, '-');
  assert.equal(f.count, '1');
  assert.equal(f.owed, '-');
  assert.equal(f.owed_at, '-');
  assert.ok(!gh.issues.get(1).body.includes('down'), 'a hash, so no alert text is copied');
});

test('L401: the footer stays last and within GitHub\'s limit whatever the alert says', async () => {
  const { gh, alerts } = setup();
  await alerts.raise({ key: 'k', title: 't', body: 'x'.repeat(70_000) });
  assert.ok(gh.issues.get(1).body.length < 65_536);
  assert.equal(foot(gh).key, idFor('k'));
});

test('L401 MAT-B: a footer only counts on the last line, so alert text quoting one means nothing', async () => {
  const { gh, alerts } = setup();
  const key = 'k';
  await alerts.raise({ key, title: 't', body: 'first', status: 's' });
  const fake = gh.issues.get(1).body.split('\n').at(-1).replace(/cleared=-/, 'cleared=2026-01-01T00:00:00.000Z');
  // The text now quotes a footer of the same key that says cleared, and another issue quotes it too.
  await alerts.raise({ key, title: 't', body: `quoting ${fake}\n${fake}\nend`, status: 's' });
  assert.equal(foot(gh).cleared, '-');
  gh.ownerCloses(1);
  assert.equal(await alerts.raise({ key, title: 't', body: 'first', status: 's' }), 'suppressed', 'the quoted cleared line is not read');
  const other = setup();
  const n = await other.gh.open({ title: 'x', body: `${fake}\nsome words after it` });
  assert.equal(await other.alerts.raise({ key, title: 't', body: 'b' }), 'opened');
  assert.equal(other.gh.issues.get(n).comments.length, 0);
  assert.equal(other.gh.issues.size, 2, 'an issue quoting the footer in its text is not this alert\'s');
});

test('L399: an issue another app wrote, carrying this key\'s footer, is neither reused nor read as this alert\'s', async () => {
  const { gh, alerts, rec } = setup();
  await alerts.raise({ key: 'k', title: 't', body: 'b', status: 's' });
  gh.issues.get(1).ours = false;
  assert.equal(await alerts.raise({ key: 'k', title: 't', body: 'b', status: 's' }), 'opened');
  assert.equal(gh.issues.size, 2);
  assert.equal(gh.calls.filter(([c, n]) => c === 'edit' && n === 1).length, 0);
  assert.equal(cached(rec, 'k').issue, 2);
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
    assert.equal(cached(l.rec, 'k'), null, 'no open alert without an issue');
    l.gh.open = real.open; l.gh.read = real.read; l.gh.edit = real.edit;
    l.tick(1);
    assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b' }), 'opened');
    assert.equal(cached(l.rec, 'k').issue, 1);
    assert.equal(/since=(\S+)/.exec(real.issues.get(1).body)[1], '2026-11-03T08:01:00.000Z', 'times are the tick, not the record clock');
  }
});

test('L143: an open alert saved without an issue (before the fix) is opened again, never read as closed by the owner', async () => {
  const l = lossSetup();
  l.writer.put(idFor('k'), { kind: 'fact.alert', key: 'k', title: 't', body: 'b', status_text: 'b', status: 'open', since: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z', count: 1 });
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b' }), 'opened');
  assert.equal(opens(l.gh), 1);
  assert.equal(cached(l.rec, 'k').status, 'open');
  assert.equal(cached(l.rec, 'k').issue, 1);
});

test('L143: a change notice whose comment answered false answers false, keeps the old status, and is sent next pass', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'first', status: 's1' });
  const comment = l.gh.comment;
  l.gh.comment = async () => false;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), false);
  assert.equal(foot(l.gh).status, hashOf('s1'));
  assert.notEqual(foot(l.gh).owed, '-');
  l.gh.comment = comment;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), 'changed');
  assert.deepEqual(l.gh.issues.get(1).comments.map((c) => c.split('\n')[0]), ['Changed: second']);
  assert.equal(foot(l.gh).owed, '-');
  assert.equal(foot(l.gh).status, hashOf('s2'));
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'second', status: 's2' }), 'updated', 'sent once, not again');
  assert.equal(l.gh.issues.get(1).comments.length, 1);
});

test('L143: an edit that answered false answers false and nothing goes out', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
  l.gh.edit = async () => false;
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'c', status: 's2' }), false);
  assert.equal(l.gh.issues.get(1).comments.length, 0, 'no comment after a lost edit');
  assert.equal(await l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's1' }), false, 'a quiet edit too');
  assert.equal(await l.alerts.clear({ key: 'k' }), false);
  assert.equal(l.gh.issues.get(1).closed, false, 'no close after a lost edit');
  assert.equal(foot(l.gh).status, hashOf('s1'));
});

test('L143: a close that answered false answers false and keeps the alert open; the next clear closes it', async () => {
  const l = lossSetup();
  await l.alerts.raise({ key: 'k', title: 't', body: 'b' });
  const close = l.gh.close;
  l.gh.close = async () => false;
  assert.equal(await l.alerts.clear({ key: 'k' }), false);
  assert.equal(cached(l.rec, 'k').status, 'open');
  l.gh.close = close;
  assert.equal(await l.alerts.clear({ key: 'k' }), 'cleared');
  assert.equal(l.gh.issues.get(1).closed, true);
});

test('L143: every GitHub call that throws makes raise or clear throw and saves nothing', async () => {
  for (const m of ['open', 'edit', 'comment', 'read', 'close']) {
    const l = lossSetup();
    if (m !== 'open') await l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's1' });
    const before = cached(l.rec, 'k');
    l.gh[m] = async () => { throw new Error('github down'); };
    const call = m === 'close' ? l.alerts.clear({ key: 'k' }) : l.alerts.raise({ key: 'k', title: 't', body: 'b', status: 's2' });
    await assert.rejects(call, /github down/, m);
    assert.deepEqual(cached(l.rec, 'k'), before, `${m}: nothing saved`);
  }
});

test('L402: an alert with no issue, and one the Record says has settled, clear without calling GitHub', async () => {
  const calls = [];
  const no = (name) => async () => { calls.push(name); throw new Error(`${name} called`); };
  const l = lossSetup({ open: no('open'), edit: no('edit'), comment: no('comment'), close: no('close'), read: no('read'), findOpen: no('findOpen') });
  l.writer.put(idFor('k'), { kind: 'fact.alert', key: 'k', title: 't', body: 'b', status_text: 'b', status: 'open', since: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z', count: 1 });
  assert.equal(await l.alerts.clear({ key: 'k' }), 'none');
  assert.equal(await l.alerts.clear({ key: 'never raised' }), 'none');
  l.writer.put(idFor('settled'), { kind: 'fact.alert', key: 'settled', issue: 3, status: 'cleared' });
  assert.equal(await l.alerts.clear({ key: 'settled' }), 'none');
  assert.deepEqual(calls, []);
});

test('L402: a clear finds the issue gone: nothing to do on GitHub, and it settles', async () => {
  const { gh, alerts, rec } = setup();
  await alerts.raise({ key: 'k', title: 't', body: 'b' });
  gh.issues.delete(1);
  assert.equal(await alerts.clear({ key: 'k' }), 'cleared');
  assert.equal(cached(rec, 'k').status, 'cleared');
  assert.deepEqual(gh.calls.filter(([c]) => c === 'close'), []);
});

test('L402: a clear that can\'t read the issue answers false and does nothing', async () => {
  const { gh, alerts, rec } = setup();
  await alerts.raise({ key: 'k', title: 't', body: 'b' });
  gh.read = async () => false;
  assert.equal(await alerts.clear({ key: 'k' }), false);
  assert.equal(await alerts.raise({ key: 'k', title: 't', body: 'b' }), false, 'a raise the same');
  assert.equal(cached(rec, 'k').status, 'open');
  assert.equal(gh.issues.get(1).closed, false);
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
  assert.match(gh.issues.get(1).comments[0], /^Still open since 2026-11-03T08:00:00\.000Z: first line\n/);
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

test('L315: a reminder whose comment answered false answers false and is sent next pass', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(25 * 60);
  const comment = gh.comment;
  gh.comment = async () => false;
  assert.equal(await alerts.raise(standing), false);
  gh.comment = comment;
  clock.tick(1);
  assert.equal(await alerts.raise(standing), 'reminded');
  assert.equal(comments(gh), 1);
});

test('L315: a reminder whose comment throws makes raise throw, and the next pass sends it', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(25 * 60);
  const comment = gh.comment;
  gh.comment = async () => { throw new Error('GitHub is down'); };
  await assert.rejects(alerts.raise(standing), /GitHub is down/);
  gh.comment = comment;
  assert.equal(await alerts.raise(standing), 'reminded');
});

test('L315: an issue the owner closed is not commented on: closing it is their answer', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  for (let d = 0; d < 3; d++) { clock.tick(25 * 60); assert.equal(await alerts.raise(standing), 'suppressed'); }
  assert.equal(comments(gh), 0);
});

test('L315: a told time that cannot be read or is in the future tells now', async () => {
  for (const [plant, min, want] of [[null, 60, 'updated'], [null, 25 * 60, 'reminded'], ['not-a-time', 60, 'reminded'], ['2099-01-01T00:00:00.000Z', 60, 'reminded']]) {
    const { gh, alerts, clock } = setup();
    await alerts.raise(standing);
    assert.equal(foot(gh).told, '2026-11-03T08:00:00.000Z', 'opening is telling');
    if (plant) gh.issues.get(1).body = gh.issues.get(1).body.replace(/told=\S+/, `told=${plant}`);
    clock.tick(min);
    assert.equal(await alerts.raise(standing), want, String(plant));
  }
});

test('L371: a standing alert is commented on once a day, not every pass', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  for (let m = 10; m <= 49 * 60; m += 10) { clock.tick(10); await alerts.raise(standing); }
  assert.equal(comments(gh), 2, 'at +24 h and +48 h');
  assert.equal(foot(gh).told, '2026-11-05T08:00:00.000Z');
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
  const { gh, alerts, clock, rec } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  assert.equal(await alerts.raise(standing), 'suppressed');
  clock.tick(1);
  assert.equal(await alerts.raise({ ...standing, status: 'a different cause' }), 'opened', 'once it was already read as closed');
  assert.equal(gh.issues.size, 2);
  assert.equal(gh.issues.get(1).closed, true, 'the closed one stays closed');
  assert.equal(gh.issues.get(2).closed, false);
  assert.equal(cached(rec, standing.key).issue, 2);
  assert.equal(cached(rec, standing.key).status, 'open');
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
  const { gh, alerts, rec } = setup();
  await alerts.raise(standing);
  gh.ownerCloses(1);
  await alerts.raise(standing);
  const open = gh.open;
  gh.open = async () => undefined;
  const other = { ...standing, status: 'a different cause' };
  assert.equal(await alerts.raise(other), false);
  assert.equal(cached(rec, standing.key).issue, 1, 'nothing saved');
  gh.open = open;
  assert.equal(await alerts.raise(other), 'opened');
});

// The Record refusing: it only says where to look, so nothing about what the owner hears may change.
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
  const make = () => makeAlerts({ rec, gh, owner: 'o', now: clock.now, writer });
  return { gh, alerts: make(), make, clock, world, rec, writer };
}
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

test('L401: a Record refusing: one comment a day over 120 passes and 50 h, and every pass still counts as told', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  w.world.refuse = () => true;
  const { at, answers } = await overTime(w, () => standing);
  assert.equal(comments(w.gh), 3, 'due on the first pass, then every 24 h over the next 50 h');
  perDay(at);
  assert.equal(opens(w.gh), 1);
  for (const a of answers) assert.equal(wasTold(a), true);
});

test('L401: a Record refusing on a status change: one comment, then the same day-by-day', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  const changed = { ...standing, status: 'other cause' };
  const { at, answers } = await overTime(w, () => changed);
  assert.equal(comments(w.gh), 3, 'at the first pass, and 24 h and 48 h on');
  perDay(at);
  assert.equal(opens(w.gh), 1);
  assert.equal(answers[0], 'changed');
  for (const a of answers) assert.equal(wasTold(a), true);
});

test('L401: a Record refusing from the start: one issue over 120 passes and 50 h, and it is told', async () => {
  const w = refusing();
  w.world.refuse = () => true;
  const { answers } = await overTime(w, () => standing);
  assert.equal(opens(w.gh), 1);
  assert.equal(comments(w.gh), 2, 'the first opened it; then the daily reminders');
  assert.equal(answers[0], 'opened');
  for (const a of answers) assert.equal(wasTold(a), true);
});

test('L401: once the Record takes writes again, the alert goes on from the issue GitHub already holds', async () => {
  const w = refusing();
  w.world.refuse = () => true;
  await w.alerts.raise(standing);
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(cached(w.rec, standing.key).issue, 1);
  assert.equal(opens(w.gh), 1);
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
});

test('L401: told is GitHub\'s time for the comment, so the next 24 h run from it', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  const comment = w.gh.comment;
  w.gh.comment = async (...a) => { await comment(...a); return { at: '2026-11-04T07:59:00.000Z' }; };
  assert.equal(await w.alerts.raise(standing), 'reminded');
  assert.equal(foot(w.gh).told, '2026-11-04T07:59:00.000Z');
});

test('L401: a comment time from the future, or none, never moves told ahead of this pass', async () => {
  for (const at of ['2026-11-20T00:00:00.000Z', undefined, 'garbage']) {
    const w = refusing();
    await w.alerts.raise(standing);
    w.clock.tick(25 * 60);
    const comment = w.gh.comment;
    w.gh.comment = async (...a) => { await comment(...a); return { at }; };
    assert.equal(await w.alerts.raise(standing), 'reminded');
    assert.equal(foot(w.gh).told, '2026-11-04T09:00:00.000Z', String(at));
  }
});

test('L389: a new status still notifies at once; only the same status is held back', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise({ ...standing, status: 'A' });
  for (const status of ['B', 'C', 'B', 'A']) { clock.tick(10); assert.equal(await alerts.raise({ ...standing, status }), 'changed'); }
  assert.equal(comments(gh), 4);
});

test('L401: suppressed, updated and cleared keep their answers with the Record refusing, and it says why', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  assert.equal(w.alerts.cacheTrouble(), null);
  w.world.refuse = () => true;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(w.alerts.cacheTrouble(), null, 'nothing to keep, so nothing refused');
  assert.equal(await w.alerts.clear({ key: standing.key }), 'cleared');
  assert.match(w.alerts.cacheTrouble(), /the store is full/);
  assert.equal(w.gh.calls.filter(([c]) => c === 'close').length, 1);
  assert.equal(await w.alerts.clear({ key: standing.key }), 'cleared');
  assert.equal(w.gh.calls.filter(([c]) => c === 'close').length, 1, 'the second try closes nothing');
  const x = refusing();
  await x.alerts.raise(standing);
  x.gh.ownerCloses(1);
  x.world.refuse = () => true;
  assert.equal(await x.alerts.raise(standing), 'suppressed');
  assert.equal(opens(x.gh), 1);
});

test('L393: a refused issue list sends nothing', async () => {
  const y = refusing();
  y.gh.findOpen = async () => false;
  assert.equal(await y.alerts.raise(standing), false);
  assert.equal(opens(y.gh), 0);
  await y.gh.open({ title: 't', body: 'x' });
  assert.equal(await y.alerts.clear({ key: standing.key, look: true }), false);
});

// L393 MAT-A: a clear the Record refused leaves it saying "open" over the robot's own close.
test('L393: a refused clear, then the cause comes back: a new issue, never suppressed', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  await w.alerts.clear({ key: standing.key });
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'opened');
  assert.equal(cached(w.rec, standing.key).issue, 2);
  for (let i = 0; i < 5; i++) { w.clock.tick(25 * 60); assert.notEqual(await w.alerts.raise(standing), 'suppressed'); }
  assert.equal(opens(w.gh), 2);
});

test('L393: the same, with the Record still refusing when it comes back: one new issue, then it goes on once the Record takes it', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.world.refuse = () => true;
  await w.alerts.clear({ key: standing.key });
  for (let i = 0; i < 6; i++) { w.clock.tick(10); assert.notEqual(await w.alerts.raise(standing), false); }
  assert.equal(opens(w.gh), 2);
  w.world.refuse = () => false;
  w.clock.tick(10);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(cached(w.rec, standing.key).issue, 2);
  assert.equal(opens(w.gh), 2);
});

test('L402 MAT-A2: the owner closes, it clears with the Record refusing, and it comes back: the footer says cleared, so a new issue', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.gh.ownerCloses(1);
  w.world.refuse = () => true;
  assert.equal(await w.alerts.clear({ key: standing.key }), 'cleared');
  assert.notEqual(foot(w.gh).cleared, '-');
  assert.equal(w.gh.calls.filter(([c]) => c === 'close').length, 0, 'it was closed already');
  assert.equal(comments(w.gh), 0, 'the edit is silent');
  assert.equal(cached(w.rec, standing.key).status, 'open', 'the Record never heard');
  assert.equal(await w.alerts.raise(standing), 'opened');
});

test('L402: a closed issue keeps only a person\'s answer: a bot\'s close or an unreadable one opens anew', async () => {
  const y = refusing();
  await y.alerts.raise(standing);
  y.gh.ownerCloses(1);
  y.gh.issues.get(1).byOwner = false; // the client says no person closed it: a bot, or GitHub doesn't say
  y.clock.tick(10);
  assert.equal(await y.alerts.raise(standing), 'opened');
});

test('L402: an issue reopened after a clear is told once as back, and the footer loses cleared', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  await alerts.clear({ key: standing.key });
  gh.issues.get(1).closed = false;
  clock.tick(10);
  assert.equal(await alerts.raise(standing), 'changed');
  assert.equal(gh.issues.size, 1);
  assert.match(gh.issues.get(1).comments.at(-1), /^Back: first line/);
  assert.equal(foot(gh).cleared, '-');
  clock.tick(10);
  assert.equal(await alerts.raise(standing), 'updated');
});

test('L402: a close that failed leaves cleared on an open issue, and the condition returning is told as back', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  const close = gh.close;
  gh.close = async () => false;
  assert.equal(await alerts.clear({ key: standing.key }), false);
  gh.close = close;
  assert.notEqual(foot(gh).cleared, '-');
  clock.tick(1);
  assert.equal(await alerts.clear({ key: standing.key }), 'cleared');
  assert.equal(gh.issues.get(1).closed, true);
  const y = setup();
  await y.alerts.raise(standing);
  y.gh.close = async () => false;
  await y.alerts.clear({ key: standing.key });
  assert.equal(await y.alerts.raise(standing), 'changed');
  assert.equal(y.gh.issues.size, 1);
});

test('L402: a clear keeps the alert\'s own text, also when that text looks like the footer\'s rule line', async () => {
  const { gh, alerts } = setup();
  const body = 'above\n\n---\nfirst seen by me\nbelow';
  await alerts.raise({ key: 'k', title: 't', body });
  await alerts.clear({ key: 'k' });
  assert.ok(gh.issues.get(1).body.startsWith(`${body}\n\n---\nfirst seen 2026`));
});

// ---- The notice is three steps (L402): each one failing, then the next pass ----

function failsLastEdit(w) {
  const edit = w.gh.edit;
  let n = 0;
  w.gh.edit = async (...a) => { n += 1; return n === 2 ? false : edit(...a); };
  return () => { w.gh.edit = edit; };
}

test('L402 owed: the last edit fails: the comment is not sent twice, and the next pass only finishes the edit', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(1);
  const heal = failsLastEdit(w);
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), false);
  heal();
  assert.equal(comments(w.gh), 1);
  assert.notEqual(foot(w.gh).owed, '-');
  w.clock.tick(1);
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), 'updated');
  assert.equal(comments(w.gh), 1, 'the mark on the robot\'s comment says it went out');
  assert.equal(foot(w.gh).owed, '-');
  assert.equal(foot(w.gh).status, hashOf('worse'));
  assert.equal(foot(w.gh).told, '2026-11-03T08:01:00.000Z', 'the comment\'s time');
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), 'updated');
  assert.equal(comments(w.gh), 1);
});

test('L402 owed: a reminder the same way: the 24 h run from the comment that went out', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(24 * 60);
  const heal = failsLastEdit(w);
  assert.equal(await w.alerts.raise(standing), false);
  heal();
  w.clock.tick(60);
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(comments(w.gh), 1);
  assert.equal(foot(w.gh).told, '2026-11-04T08:00:00.000Z');
  w.clock.tick(23 * 60);
  assert.equal(await w.alerts.raise(standing), 'reminded');
});

test('L402 owed: the status moves on after the comment went out: the new status is told too', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(1);
  const heal = failsLastEdit(w);
  await w.alerts.raise({ ...standing, status: 'worse' });
  heal();
  w.clock.tick(1);
  assert.equal(await w.alerts.raise({ ...standing, status: 'worst' }), 'changed');
  assert.equal(comments(w.gh), 2);
  assert.equal(foot(w.gh).status, hashOf('worst'));
  assert.equal(foot(w.gh).owed, '-');
});

test('L402 owed: the comment never went out, and the status moved on: one notice, of the new status', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  const comment = w.gh.comment;
  w.gh.comment = async () => false;
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), false);
  w.gh.comment = comment;
  w.clock.tick(1);
  assert.equal(await w.alerts.raise({ ...standing, status: 'worst' }), 'changed');
  assert.equal(comments(w.gh), 1);
  assert.equal(foot(w.gh).status, hashOf('worst'));
  assert.equal(foot(w.gh).owed, '-');
});

test('L402 owed: when the read of the comments fails nothing is sent, and owed stays for the next pass', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(1);
  const heal = failsLastEdit(w);
  await w.alerts.raise({ ...standing, status: 'worse' });
  heal();
  const read = w.gh.latestOwnComment;
  w.gh.latestOwnComment = async () => false;
  for (let i = 0; i < 3; i++) { w.clock.tick(1); assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), false); }
  assert.equal(comments(w.gh), 1);
  assert.notEqual(foot(w.gh).owed, '-');
  w.gh.latestOwnComment = read;
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), 'updated');
  assert.equal(comments(w.gh), 1);
});

test('L402 owed: a mark on an older comment, under a newer comment of the robot\'s, reads as not found: one more notice, never silence', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.clock.tick(1);
  const heal = failsLastEdit(w);
  await w.alerts.raise({ ...standing, status: 'worse' });
  heal();
  await w.gh.comment(1, 'some later robot comment');
  w.clock.tick(1);
  assert.equal(await w.alerts.raise({ ...standing, status: 'worse' }), 'changed');
});

// ---- Today's issues (L402). The old form goes after the first cutover, and these tests with it. ----

function oldIssue({ record, closed = false, byOwner = false, body = 'old text' } = {}) {
  const w = refusing();
  const id = idFor(standing.key);
  w.gh.open({ title: 't', body: `${body}\n\n---\nfirst seen 2026-11-01T00:00:00.000Z · last seen x · seen 4 times\n<!-- alert-key ${id} -->` });
  Object.assign(w.gh.issues.get(1), { closed, byOwner });
  w.gh.calls.length = 0;
  if (record) w.writer.put(id, { kind: 'fact.alert', key: standing.key, issue: 1, ...record });
  return w;
}
const oldOpen = { status: 'open', status_text: standing.status, title: 't', body: 'old', since: '2026-11-01T00:00:00.000Z', last: '2026-11-01T00:00:00.000Z', told_at: '2026-11-03T07:00:00.000Z', count: 4 };

test('L402 old issues: the Record knows it: status and told come from there, and the next write makes it v1', async () => {
  const w = oldIssue({ record: oldOpen });
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(comments(w.gh), 0);
  const f = foot(w.gh);
  assert.equal(f.status, hashOf(standing.status));
  assert.equal(f.told, '2026-11-03T07:00:00.000Z');
  assert.equal(f.since, '2026-11-01T00:00:00.000Z');
  assert.equal(f.count, '5');
});

test('L402 old issues: the Record knows it and the status moved: told once', async () => {
  const w = oldIssue({ record: oldOpen });
  assert.equal(await w.alerts.raise({ ...standing, status: 'other' }), 'changed');
  assert.equal(comments(w.gh), 1);
});

test('L402 old issues: the Record has no row: found by its old marker, one quiet update, no notice', async () => {
  const w = oldIssue();
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(comments(w.gh), 0);
  assert.equal(opens(w.gh), 0);
  assert.equal(foot(w.gh).told, '2026-11-03T08:00:00.000Z');
  assert.equal(foot(w.gh).status, hashOf(standing.status));
});

test('L402 old issues: closed, and the Record says cleared: it is honoured, so a new issue', async () => {
  const w = oldIssue({ record: { ...oldOpen, status: 'cleared', cleared: '2026-11-02T00:00:00.000Z' }, closed: true });
  assert.equal(await w.alerts.raise(standing), 'opened');
  assert.equal(w.gh.issues.size, 2);
});

test('r4 m5: an old issue the Record says the owner closed: GitHub decides who closed it, never the Record', async () => {
  const owner = oldIssue({ record: { ...oldOpen, status: 'closed-by-owner' }, closed: true, byOwner: true });
  assert.equal(await owner.alerts.raise(standing), 'suppressed');
  assert.equal(await owner.alerts.raise({ ...standing, status: 'other' }), 'opened', 'for that cause only');
  const app = oldIssue({ record: { ...oldOpen, status: 'closed-by-owner' }, closed: true, byOwner: false });
  assert.equal(await app.alerts.raise(standing), 'opened', 'another app closing it is no answer from the owner');
});

test('r4 m4: an old issue keeps its Record fields until its new footer has landed', async () => {
  // Reopened, so the Record's status differs and a cache write would replace its fields.
  const w = oldIssue({ record: { ...oldOpen, status: 'closed-by-owner' } });
  const { edit } = w.gh;
  w.gh.edit = async () => false;
  assert.equal(await w.alerts.raise(standing), false);
  assert.equal(cached(w.rec, standing.key).told_at, oldOpen.told_at, 'nothing lost when the edit is refused');
  w.gh.edit = edit;
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(foot(w.gh).told, oldOpen.told_at);
  assert.equal(cached(w.rec, standing.key).status, 'open', 'cached once it landed');
});

test('r4 c5: a line the owner adds under the footer: it is a lost footer, told once, and the footer is last again', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  gh.issues.get(1).body += '\nthanks, looking at it';
  assert.equal(await alerts.raise(standing), 'changed');
  assert.equal(comments(gh), 1);
  assert.equal(foot(gh).status, hashOf(standing.status));
  assert.equal(await alerts.raise(standing), 'updated');
  assert.equal(comments(gh), 1);
});

test('r4 m1: a close refused after its note went out says nothing more on the retry', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  const said = (t) => gh.issues.get(1).comments.filter((c) => c === t).length;
  const note = 'Cleared: the condition no longer holds.';
  const { close } = gh;
  gh.close = async (i, text) => { await gh.comment(i, text); return false; };
  assert.equal(await alerts.clear({ key: standing.key }), false);
  gh.close = close;
  assert.equal(await alerts.clear({ key: standing.key }), 'cleared');
  assert.equal(said(note), 1);
  assert.equal(gh.issues.get(1).closed, true);
});

test('r4 m1: a close whose note never went out still says it, and a read that fails retries next pass', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  const { close, latestOwnComment } = gh;
  gh.close = async () => false;
  assert.equal(await alerts.clear({ key: standing.key }), false);
  gh.close = close;
  gh.latestOwnComment = async () => false;
  assert.equal(await alerts.clear({ key: standing.key }), false);
  assert.equal(gh.issues.get(1).closed, false);
  gh.latestOwnComment = latestOwnComment;
  assert.equal(await alerts.clear({ key: standing.key }), 'cleared');
  assert.deepEqual(gh.issues.get(1).comments, ['Cleared: the condition no longer holds.']);
});

test('r4 m3: GitHub\'s clock 20 minutes behind and a lost answer: the comment is still found, so no second one', async () => {
  const { gh, alerts, clock } = setup();
  await alerts.raise(standing);
  clock.tick(60);
  const spoke = [];
  const { comment } = gh;
  gh.comment = async (i, text) => { await comment(i, text); spoke.push({ at: new Date(clock.now().getTime() - 20 * 60000).toISOString(), body: text }); return false; };
  gh.latestOwnComment = async (i, since) => spoke.filter((c) => c.at >= since).at(-1) ?? null;
  assert.equal(await alerts.raise({ ...standing, status: 'worse' }), false);
  gh.comment = comment;
  clock.tick(1);
  assert.equal(await alerts.raise({ ...standing, status: 'worse' }), 'updated');
  assert.equal(comments(gh), 1);
});

test('L402 old issues: closed, and the Record says only open: the closer decides', async () => {
  const owner = oldIssue({ record: oldOpen, closed: true, byOwner: true });
  assert.equal(await owner.alerts.raise(standing), 'suppressed');
  const robot = oldIssue({ record: oldOpen, closed: true, byOwner: false });
  assert.equal(await robot.alerts.raise(standing), 'opened');
});

test('L402 old issues: a clear rewrites it as cleared, keeping its text', async () => {
  const w = oldIssue({ record: oldOpen });
  assert.equal(await w.alerts.clear({ key: standing.key }), 'cleared');
  assert.notEqual(foot(w.gh).cleared, '-');
  assert.ok(w.gh.issues.get(1).body.startsWith('old text\n\n---\nfirst seen 2026-11-01'));
  assert.equal(w.gh.issues.get(1).closed, true);
});

test('L402: a footer deleted by hand: an open issue gets it back with one notice; a closed one follows the closer rule', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  w.gh.issues.get(1).body = 'the owner tidied this up';
  assert.equal(await w.alerts.raise(standing), 'changed');
  assert.equal(comments(w.gh), 1);
  assert.equal(foot(w.gh).status, hashOf(standing.status));
  assert.equal(await w.alerts.raise(standing), 'updated');
  const o = refusing();
  await o.alerts.raise(standing);
  o.gh.issues.get(1).body = 'tidied';
  o.gh.ownerCloses(1);
  assert.equal(await o.alerts.raise(standing), 'suppressed');
  const r = refusing();
  await r.alerts.raise(standing);
  r.gh.issues.get(1).body = 'tidied';
  r.gh.issues.get(1).closed = true;
  assert.equal(await r.alerts.raise(standing), 'opened');
});

test('L402: a stale number, or another key\'s footer under it, means a look on GitHub, never a wrong edit', async () => {
  const w = refusing();
  await w.alerts.raise(standing);
  await w.alerts.raise({ ...standing, key: 'other key' });
  w.writer.put(idFor(standing.key), { kind: 'fact.alert', key: standing.key, issue: 2, status: 'open' });
  const edits = w.gh.calls.length;
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.deepEqual(w.gh.calls.slice(edits), [['edit', 1]]);
  assert.equal(cached(w.rec, standing.key).issue, 1);
  w.writer.put(idFor(standing.key), { kind: 'fact.alert', key: standing.key, issue: 99, status: 'open' });
  assert.equal(await w.alerts.raise(standing), 'updated');
  assert.equal(cached(w.rec, standing.key).issue, 1);
});

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

// ---- cacheTrouble (L402): the Record refusing on two passes running gets one alert of its own ----

const troubleIssues = (gh) => [...gh.issues.values()].filter((i) => /refusing alert writes/.test(i.title));

test('L402 cacheTrouble: one refusal raises nothing; the second pass raises one alert; it clears once a write lands', async () => {
  const w = refusing();
  w.world.refuse = () => true;
  // Each pass makes its own alerts, as the channel does: nothing is counted in memory.
  let a = w.make();
  assert.equal(await a.raise(standing), 'opened');
  assert.match(a.cacheTrouble(), /the store is full/);
  assert.equal(await a.reportTrouble('p', 'test'), 'none');
  assert.equal(troubleIssues(w.gh).length, 0, 'one refusal may be nothing');
  assert.equal(a.cacheTrouble(), null, 'reported');
  for (let i = 0; i < 3; i++) {
    w.clock.tick(10);
    a = w.make();
    await a.raise(standing);
    await a.reportTrouble('p', 'test');
  }
  assert.equal(troubleIssues(w.gh).length, 1, 'one alert however long it lasts');
  const issue = troubleIssues(w.gh)[0];
  assert.equal(issue.closed, false);
  assert.match(issue.body, /the store is full/);
  assert.equal(comments(w.gh), 0);
  w.world.refuse = () => false;
  w.clock.tick(10);
  a = w.make();
  await a.raise(standing);
  assert.equal(await a.reportTrouble('p', 'test'), 'cleared');
  assert.equal(issue.closed, true);
  assert.match(issue.comments.at(-1), /taking alert writes again/);
});

test('L402 cacheTrouble: a clean pass makes no GitHub call for it', async () => {
  const { gh, alerts } = setup();
  await alerts.raise(standing);
  await alerts.reportTrouble('p', 'test'); // the pass that opened it: a write landed, so this one looks
  const seen = gh.calls.length;
  let lists = 0;
  gh.findOpen = async () => { lists += 1; return null; };
  await alerts.raise(standing);
  await alerts.reportTrouble('p', 'test');
  assert.equal(lists, 0);
  assert.equal(gh.calls.length, seen + 1);
});

const oneRefused = async (w) => {
  w.world.refuse = () => true;
  await w.make().raise(standing);
  const a = w.make();
  await a.raise(standing);
  w.world.refuse = (doc) => doc.key === standing.key; // its own alert is taken; the refused one still isn't
  await a.reportTrouble('p', 'test');
};

test('r5 m3: a quiet pass retries the exact write refused: the alert closes once the Record takes it, not before', async () => {
  const w = refusing();
  await oneRefused(w);
  const issue = troubleIssues(w.gh)[0];
  assert.equal(issue.closed, false);
  const own = cached(w.rec, alertKey('p', 'alerts', 'record-refusing:test'));
  assert.deepEqual([own.retry_key, own.retry_issue, own.retry_status], [standing.key, 1, 'open'], 'kept by the fact shape, which drops what it doesn\'t know');
  let tries = 0;
  w.world.refuse = (doc) => { if (doc.key === standing.key) tries += 1; return doc.key === standing.key; };
  assert.equal(await w.make().reportTrouble('p', 'test'), 'none');
  assert.equal(issue.closed, false, 'still refused, so still open');
  assert.equal(tries, 1, 'once a pass');
  w.world.refuse = () => false;
  assert.equal(await w.make().reportTrouble('p', 'test'), 'cleared');
  assert.equal(issue.closed, true);
  assert.equal(cached(w.rec, standing.key).issue, 1, 'the refused alert has its number at last');
});

const clearRefused = async (w) => {
  await w.make().raise(standing);
  w.world.refuse = (doc) => doc.key === standing.key;
  await w.make().clear({ key: standing.key });
  const a = w.make();
  await a.clear({ key: standing.key }); // GitHub shows it closed and the Record doesn't: the second refusal
  await a.reportTrouble('p', 'test');
};

test('L422: a refused clear is retried as a clear, and leaves the entry cleared, whatever the entry says meanwhile', async () => {
  const w = refusing();
  await clearRefused(w);
  assert.equal(w.gh.issues.get(1).closed, true);
  assert.equal(cached(w.rec, standing.key).status, 'open', 'the refusal: the Record still points at it');
  const issue = troubleIssues(w.gh)[0];
  assert.equal(cached(w.rec, alertKey('p', 'alerts', 'record-refusing:test')).retry_status, 'cleared');
  assert.equal(await w.make().reportTrouble('p', 'test'), 'none', 'still refused');
  assert.equal(issue.closed, false);
  w.world.refuse = () => false;
  assert.equal(await w.make().reportTrouble('p', 'test'), 'cleared');
  assert.equal(issue.closed, true);
  assert.equal(cached(w.rec, standing.key).status, 'cleared', 'not open: an open entry would point at a closed issue');
  assert.equal(await w.make().clear({ key: standing.key }), 'none', 'so the next clear has nothing to do');
});

test('r5 m3: no retry on a pass that landed a write, or that has trouble of its own, or for an entry that has the number by now', async () => {
  const w = refusing();
  await oneRefused(w);
  let tries = 0;
  w.world.refuse = (doc) => { if (doc.key === standing.key) tries += 1; return doc.key === standing.key; };
  const b = w.make();
  await b.raise({ ...standing, key: alertKey('p', 'kind', 'other') });
  await b.reportTrouble('p', 'test');
  assert.equal(tries, 0, 'a write landed');

  const t = refusing();
  await oneRefused(t);
  let tried = 0;
  t.world.refuse = (doc) => { if (doc.key === standing.key) tried += 1; return true; };
  const d = t.make();
  await d.raise({ ...standing, key: alertKey('p', 'kind', 'third') });
  const before = tried;
  await d.reportTrouble('p', 'test');
  assert.equal(tried, before, 'this pass has trouble of its own');

  const c = refusing();
  await oneRefused(c);
  c.world.refuse = () => false;
  assert.ok(c.writer.put(idFor(standing.key), { kind: 'fact.alert', key: standing.key, issue: 1, status: 'open' }).ok);
  let writes = 0;
  c.world.refuse = (doc) => { if (doc.key === standing.key) writes += 1; return false; };
  assert.equal(await c.make().reportTrouble('p', 'test'), 'cleared', 'the number landed some other way');
  assert.equal(writes, 0, 'the entry holds both already');

  const n = refusing();
  await oneRefused(n);
  n.world.refuse = () => false;
  assert.ok(n.writer.put(idFor(standing.key), { kind: 'fact.alert', key: standing.key, issue: 9, status: 'open' }).ok);
  await n.make().reportTrouble('p', 'test');
  assert.equal(cached(n.rec, standing.key).issue, 1, 'a different number is not the refused write landing');
});

test('r4 MAT-1: two callers, the Record refusing one alert of one of them: one issue, not hundreds, and no false notes', async () => {
  const w = refusing();
  const stuck = { ...standing, key: alertKey('p', 'watcher', 'cannot-read') };
  const clean = { ...standing, key: alertKey('p', 'heartbeat', 'x') };
  w.world.refuse = (doc) => doc.key === stuck.key;
  await w.make().raise(clean);
  let closes = 0;
  const { close } = w.gh;
  w.gh.close = async (i, t) => { closes += 1; return close(i, t); };
  for (let min = 0; min < 600; min++) {
    w.clock.tick(1);
    const watcher = w.make();
    await watcher.raise(stuck);
    await watcher.reportTrouble('p', 'prod-watcher');
    if (min % 10 === 0) {
      const heart = w.make();
      // A new alert each time, so the heartbeat's pass has a write land and does look for its own trouble alert.
      await heart.raise({ ...clean, key: alertKey('p', 'heartbeat', `y${min}`) });
      await heart.reportTrouble('p', 'heartbeat');
    }
  }
  assert.equal(troubleIssues(w.gh).length, 1);
  assert.equal(closes, 0);
  assert.equal(troubleIssues(w.gh)[0].closed, false);
});

test('r4 MAT-1: each caller has its own alert, and one that doesn\'t say who it is is a caller\'s bug', async () => {
  const { alerts } = setup();
  await assert.rejects(alerts.reportTrouble('p'), /the caller's name/);
  const w = refusing();
  w.world.refuse = () => true;
  for (const who of ['heartbeat', 'prod-watcher', 'heartbeat', 'prod-watcher']) {
    const a = w.make();
    await a.raise(standing);
    await a.raise(standing);
    await a.reportTrouble('p', who);
  }
  assert.equal(troubleIssues(w.gh).length, 2);
});

test('r5 m1: the alerts object asks the client first, so a pass that made no GitHub call still says the login is unknown', async () => {
  const gh = { ...fakeIssues(), loginTrouble: null, ready: async () => { gh.loginTrouble = 'the robot\'s own login could not be read'; } };
  assert.match(await makeAlerts({ rec: memoryRecord(), gh, owner: 'o' }).loginTrouble(), /could not be read/);
  assert.equal(await makeAlerts({ rec: memoryRecord(), gh: fakeIssues(), owner: 'o' }).loginTrouble(), null);
});

test('r5 m2: the three callers\' names are distinct; c1: the alert\'s title says whose it is', async () => {
  assert.equal(new Set(Object.values(TROUBLE_SOURCES)).size, 3);
  const w = refusing();
  w.world.refuse = () => true;
  await w.make().raise(standing);
  const a = w.make();
  await a.raise(standing);
  await a.reportTrouble('p', TROUBLE_SOURCES.WATCHER);
  assert.equal(troubleIssues(w.gh)[0].title, `p: the Record is refusing alert writes (${TROUBLE_SOURCES.WATCHER})`);
});

test('L768, L801 M1: a robot clock ahead of GitHub\'s, by minutes or days, reminds once a day by GitHub\'s time, and says so once', async () => {
  const make = (aheadMin) => {
    let t = Date.parse('2026-11-03T08:00:00Z');
    const robot = { now: () => new Date(t + aheadMin * 60000) };
    const gh = fakeIssues({ now: robot.now, serverNow: () => new Date(t) });
    const lines = [];
    const alerts = makeAlerts({ rec: memoryRecord(), gh, owner: 'owner-login', now: robot.now, log: (s) => lines.push(s) });
    return { gh, alerts, lines, tick: (min) => { t += min * 60000; } };
  };
  // The audit's probe: the alert stands, raised every hour for 6 days, the robot's clock fast by a fixed amount.
  for (const aheadMin of [0, 7, 30, 23 * 60, 3 * 24 * 60]) {
    const w = make(aheadMin);
    const answers = [];
    for (let h = 0; h <= 6 * 24; h++) { answers.push(await w.alerts.raise(standing)); w.tick(60); }
    const told = answers.map((a, i) => (a === 'reminded' ? i : null)).filter((i) => i !== null);
    assert.ok(told.length >= 5 && told.length <= 6, `${aheadMin} min ahead: ${told.length} reminders in 6 days`);
    for (let i = 1; i < told.length; i++) assert.ok(told[i] - told[i - 1] >= 24, `${aheadMin} min ahead: never sooner than a day by GitHub's clock (hours ${told[i - 1]}, ${told[i]})`);
    assert.equal(comments(w.gh), told.length);
    assert.equal(w.lines.length, aheadMin > 5 ? 1 : 0, `${aheadMin} min ahead: one log line while the clock stays wrong`);
    if (aheadMin > 5) assert.match(w.lines[0], new RegExp(`^alerts: this computer's clock is ${aheadMin} minutes ahead of GitHub's; daily reminders are counted by GitHub's time`));
  }
  const near = make(3);
  await near.alerts.raise(standing);
  near.tick(2 * 60);
  assert.equal(await near.alerts.raise(standing), 'updated');
  near.tick(23 * 60);
  assert.equal(await near.alerts.raise(standing), 'reminded');
  assert.equal(comments(near.gh), 1);
  assert.deepEqual(near.lines, [], 'a clock within the limit logs nothing');
  const edge = make(4);
  await edge.alerts.raise(standing);
  edge.tick(24 * 60 - 2);
  assert.equal(await edge.alerts.raise(standing), 'updated', 'a day less 2 minutes by GitHub\'s clock: the opening\'s told stamp is GitHub\'s');
  edge.tick(3);
  assert.equal(await edge.alerts.raise(standing), 'reminded');
  assert.equal(clockAhead({ lastServerTime: null }, 5), null, 'no Date header: not known, and the old count stands');
  assert.equal(clockTooFast({ lastServerTime: 0 }, CLOCK_AHEAD_MS + 1), true);
  assert.equal(clockTooFast({ lastServerTime: 0 }, CLOCK_AHEAD_MS), false);
  assert.equal(CLOCK_AHEAD_MS, 5 * 60_000, 'the limit is pinned (L801 m1): a few minutes, the most a kept clock drifts');
  // Said once per round (production makes a new makeAlerts each round, r2 m1), however many alerts the round raises;
  // within a round, said again only after the clock has been right in between.
  let g = Date.parse('2026-11-03T08:00:00Z'); let ahead = 10 * 60000;
  const rec = memoryRecord();
  const gh = fakeIssues({ now: () => new Date(g + ahead), serverNow: () => new Date(g) });
  const other = { ...standing, key: alertKey('product 1', 'kind', 'y') };
  const perRound = [];
  for (const skew of [10, 10, 0, 10]) {
    ahead = skew * 60000;
    const lines = [];
    const a = makeAlerts({ rec, gh, owner: 'owner-login', now: () => new Date(g + ahead), log: (s) => lines.push(s) });
    await a.raise(standing); await a.raise(other);
    perRound.push(lines.length);
    g += 60 * 60000;
  }
  assert.deepEqual(perRound, [1, 1, 0, 1], 'one line a round while wrong, two alerts each round');
  const lines = [];
  const a = makeAlerts({ rec, gh, owner: 'owner-login', now: () => new Date(g + ahead), log: (s) => lines.push(s) });
  for (const skew of [10, 0, 10]) { ahead = skew * 60000; await a.raise(standing); }
  assert.equal(lines.length, 2, 'within a round, said again after being right');
  // The opening logs it too, not only the quiet reminder path (L801 self-review m4).
  const lines2 = [];
  const gh2 = fakeIssues({ now: () => new Date(g + 20 * 60000), serverNow: () => new Date(g) });
  const a2 = makeAlerts({ rec: memoryRecord(), gh: gh2, owner: 'owner-login', now: () => new Date(g + 20 * 60000), log: (s) => lines2.push(s) });
  assert.equal(await a2.raise(standing), 'opened');
  assert.equal(lines2.length, 1);
});

test('L801 r2 m2: a comment GitHub gives no time for is stamped by GitHub\'s time, so a clock 3 days fast still reminds once a day', async () => {
  let t = Date.parse('2026-11-03T08:00:00Z');
  const ahead = 3 * 24 * 60 * 60000;
  const robot = () => new Date(t + ahead);
  const base = fakeIssues({ now: robot, serverNow: () => new Date(t) });
  const gh = Object.create(base);
  gh.comment = async (...args) => { const c = await base.comment(...args); return c && typeof c === 'object' ? {} : c; };
  const alerts = makeAlerts({ rec: memoryRecord(), gh, owner: 'owner-login', now: robot, log: () => {} });
  const answers = [];
  for (let h = 0; h <= 6 * 24; h++) { answers.push(await alerts.raise(standing)); t += 60 * 60000; }
  const told = answers.map((a, i) => (a === 'reminded' ? i : null)).filter((i) => i !== null);
  assert.ok(told.length >= 5 && told.length <= 6, `${told.length} reminders in 6 days`);
  for (let i = 1; i < told.length; i++) assert.ok(told[i] - told[i - 1] >= 24, `never sooner than a day (hours ${told[i - 1]}, ${told[i]})`);
});

// L402, L957: the daily sweep of alert issues left open after their cause cleared. An issue opened while the Record
// refused its number is one: when its cause clears, clear finds nothing to close. The sweep closes on proof only: a
// clear in the same round that answered 'none' for that key.
function sweepWorld() {
  const { gh, rec, clock } = setup();
  const world = { refuse: false, kinds: [] };
  const w = makeFactWriter(rec, { actor: 'ledger', now: clock.now });
  const writer = { ...w, put: (id, doc) => ((world.refuse && doc.kind === 'fact.alert') || world.kinds.includes(doc.kind) ? { ok: false, reason: 'the store is full' } : w.put(id, doc)) };
  const round = (over = {}) => makeAlerts({ rec, gh: over.gh ?? gh, owner: 'owner-login', now: clock.now, writer: over.writer ?? writer });
  return { gh, rec, clock, world, writer, round, alerts: round() };
}
const A = alertKey('product 1', 'old-version-live', 'production');
const B = alertKey('product 1', 'no-stage', 'rules');
const C = alertKey('product 1', 'account-changed', '7');
const P2 = alertKey('product 2', 'old-version-live', 'production');
const listed = (gh) => gh.calls.filter(([c]) => c === 'listOpen').length;
/** An issue opened while the Record refused its number. */
// A minute passes after it, so a clear's proof comes after its last raise (a raise at or after the proof stands, L959 m5).
const orphan = async (w, key, body = 'It holds.') => { w.world.refuse = true; await w.alerts.raise({ key, title: key, body }); w.world.refuse = false; w.clock.tick(1); };

test('L402 sweep: an issue whose number the Record refused is closed once a clear shows its cause gone; a standing one and one nothing clears stay', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await orphan(w, C, 'A one-time notice: nothing ever clears it.');
  await w.alerts.raise({ key: B, title: 'no stage', body: 'The rules entry has no stage.' });
  w.clock.tick(60);
  const r = w.round();
  await r.raise({ key: B, title: 'no stage', body: 'The rules entry has no stage.' });
  assert.equal(await r.clear({ key: A }), 'none', 'the cause cleared, but clear has no number to close');
  assert.equal(w.gh.issues.get(1).closed, false);
  const sweptAt = w.clock.now().toISOString();
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: true, closed: [1], failed: [], kept: [], why: null });
  assert.equal(w.gh.issues.get(1).closed, true);
  assert.equal(w.gh.issues.get(1).comments.at(-1), SWEEP_NOTE);
  assert.notEqual(foot(w.gh, 1).cleared, '-', 'the footer says it cleared, so the cause coming back opens a new issue');
  assert.equal(cached(w.rec, A).status, 'cleared');
  for (const n of [2, 3]) assert.equal(w.gh.issues.get(n).closed, false, `issue ${n}: a notice nothing cleared, and B standing`);
  const { ts, ...mark } = w.writer.get(sweepFactId(A));
  assert.deepEqual(mark, { kind: 'fact.alert-sweep', alert: idFor(A), issue: 1, swept_at: sweptAt }, 'A\'s own mark, for the issue the list held');
  assert.equal(w.writer.get(sweepFactId(C)), null, 'no mark for a key with no proof');
  w.clock.tick(30);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual(await r2.sweep({ product: 'product 1' }), { swept: false, closed: [], failed: [], kept: [], why: null }, 'known clear: the list not read again within the hour (L973 1)');
  assert.equal(listed(w.gh), 1);
  assert.equal(await r2.raise({ key: A, title: A, body: 'It holds.' }), 'opened', 'back: a new issue');
  w.clock.tick(SWEEP_EVERY_MS / 60000);
  const r3 = w.round();
  await r3.clear({ key: C });
  assert.deepEqual((await r3.sweep({ product: 'product 1' })).closed, [2], 'the next day, with its own proof');
  assert.equal(w.gh.issues.get(4).closed, false, 'A, raised again, stands');
});

test('L957 plant: with no proof, the list not read whole, the robot\'s login unknown or the day\'s mark refused, the sweep closes nothing and says why', async () => {
  {
    const w = sweepWorld();
    await orphan(w, A);
    const r = w.round();
    assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: false, closed: [], failed: [], kept: [], why: null }, 'nothing cleared this round');
    await r.clear({ key: A });
    await r.raise({ key: A, title: A, body: 'It holds again.' });
    assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [], 'raised after its clear: the proof is gone');
    assert.equal(w.gh.issues.get(1).closed, false);
    assert.equal(w.gh.issues.size, 1);
  }
  {
    const w = sweepWorld();
    await orphan(w, A);
    const r = w.round();
    await r.clear({ key: B });
    assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [], 'proof for another key only');
    assert.equal(w.gh.issues.get(1).closed, false);
  }
  const lists = [
    ['a refused list', async () => false],
    ['a list that is not one', async () => ({ number: 1 })],
    ['an entry with no number', async function () { return (await this.real(() => true)).map((x) => ({ ...x, number: 'one' })); }],
    ['an entry with no body', async function () { return (await this.real(() => true)).map((x) => ({ number: x.number })); }],
  ];
  for (const [name, listOpen] of lists) {
    const w = sweepWorld();
    await orphan(w, A);
    const r = w.round({ gh: { ...w.gh, real: w.gh.listOpen, listOpen, lastAnswer: 'GitHub answered 502 to GET /issues' } });
    await r.clear({ key: A });
    const out = await r.sweep({ product: 'product 1' });
    assert.equal(out.swept, false, name);
    assert.match(out.why, /could not be read whole \(GitHub answered 502/, name);
    assert.equal(w.gh.issues.get(1).closed, false, name);
  }
  {
    const w = sweepWorld();
    await orphan(w, A);
    const r = w.round({ gh: { ...w.gh, listOpen: w.gh.listOpen, loginTrouble: 'the robot\'s own login could not be read' } });
    await r.clear({ key: A });
    assert.match((await r.sweep({ product: 'product 1' })).why, /login is not known/);
    assert.equal(w.gh.issues.get(1).closed, false);
  }
  {
    const w = sweepWorld();
    await orphan(w, A);
    const { listOpen, ...rest } = w.gh;
    const r = w.round({ gh: rest });
    await r.clear({ key: A });
    assert.match((await r.sweep({ product: 'product 1' })).why, /cannot list open issues/);
    assert.equal(w.gh.issues.get(1).closed, false);
  }
  {
    const w = sweepWorld();
    await orphan(w, A);
    const r = w.round({ writer: { ...w.writer, put: () => ({ ok: false, reason: 'the store is full' }) } });
    await r.clear({ key: A });
    assert.match((await r.sweep({ product: 'product 1' })).why, /refused the sweep's mark \(the store is full\), so GitHub was not asked/);
    assert.equal(listed(w.gh), 0);
    assert.equal(w.gh.issues.get(1).closed, false);
  }
});

test('L957: the sweep closes only the robot\'s own issue with the key\'s orch:alert v1 footer as its last line, never another product\'s', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await w.gh.open({ title: 'copy', body: w.gh.issues.get(1).body });
  w.gh.issues.get(2).ours = false;
  await w.gh.open({ title: 'old form', body: `An old-form alert.\n<!-- alert-key ${idFor(B)} -->` });
  await w.gh.open({ title: 'after', body: `${w.gh.issues.get(1).body.replace(idFor(A), idFor(C))}\nand a line after the footer` });
  await orphan(w, P2);
  // Every open issue listed, the robot's or not, so the sweep's own checks decide.
  let asked = null;
  const all = { ...w.gh, listOpen: async (test) => { asked = test; return [...w.gh.issues].filter(([, x]) => !x.closed).map(([number, x]) => ({ number, body: x.body })); } };
  const r = w.round({ gh: all });
  for (const k of [A, B, C]) await r.clear({ key: k });
  assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [1]);
  for (const n of [2, 3, 4, 5]) assert.equal(w.gh.issues.get(n).closed, false, `issue ${n}`);
  assert.deepEqual([3, 4, 5].map((n) => asked(lastLine(w.gh.issues.get(n).body))), [false, false, true], 'GitHub is asked for footer issues only');
  const r2 = w.round();
  await r2.clear({ key: P2 });
  assert.deepEqual((await r2.sweep({ product: 'product 2' })).closed, [5], 'product 2 closes its own, by its own proof');
});

test('L957: a close GitHub refused is in the answer, not tried again that day, and closed by the next day\'s proof', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round({ gh: { ...w.gh, close: async () => false } });
  await r.clear({ key: A });
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: true, closed: [], failed: [1], kept: [], why: null });
  assert.equal(w.gh.issues.get(1).closed, false);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).swept, false, 'the day is marked');
  w.clock.tick(SWEEP_EVERY_MS / 60000);
  const r3 = w.round();
  await r3.clear({ key: A });
  assert.deepEqual((await r3.sweep({ product: 'product 1' })).closed, [1]);
  assert.equal(w.gh.issues.get(1).closed, true);
  assert.equal(w.gh.issues.get(1).comments.filter((c) => c === SWEEP_NOTE).length, 1);
});

test('L957 review: the sweep stops when the robot\'s login goes unknown after a close, and a client that cannot say closes nothing', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await orphan(w, B);
  const gh = { ...w.gh, listOpen: w.gh.listOpen, loginTrouble: null };
  gh.close = async (...a) => { const r = await w.gh.close(...a); gh.loginTrouble = 'the robot\'s own login could not be read'; return r; };
  const r = w.round({ gh });
  for (const k of [A, B]) await r.clear({ key: k });
  const out = await r.sweep({ product: 'product 1' });
  assert.equal(out.swept, false);
  assert.deepEqual(out.closed, [1], 'what it closed before it stopped');
  assert.match(out.why, /login is not known/);
  assert.equal(w.gh.issues.get(2).closed, false);
  const w2 = sweepWorld();
  await orphan(w2, A);
  const { loginTrouble, ...silent } = w2.gh;
  const r2 = w2.round({ gh: silent });
  await r2.clear({ key: A });
  assert.match((await r2.sweep({ product: 'product 1' })).why, /login is not known/);
  assert.equal(w2.gh.issues.get(1).closed, false);
});

test('L957 review: one alerts object for two products sweeps only the named product\'s keys', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await orphan(w, P2);
  const r = w.round();
  for (const k of [A, P2]) await r.clear({ key: k });
  assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [1]);
  assert.equal(w.gh.issues.get(2).closed, false, 'product 2 is left for its own sweep');
  assert.deepEqual((await r.sweep({ product: 'product 2' })).closed, [2]);
});

test('L959 M1, M2: each key has its own day: a key proven on any pass, by any caller, closes on that pass', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await orphan(w, B);
  // Pass 1, one caller: B's cause clears and B closes. Pass 2, a minute on: A's cause clears (a key cleared only when
  // its cause changes is proven on that one pass), and A closes on that same pass, though B was swept today.
  const watcher = w.round();
  await watcher.clear({ key: B });
  assert.deepEqual((await watcher.sweep({ product: 'product 1' })).closed, [2]);
  w.clock.tick(1);
  const heartbeat = w.round();
  await heartbeat.clear({ key: A });
  assert.deepEqual((await heartbeat.sweep({ product: 'product 1' })).closed, [1], 'proven on a pass after another key\'s sweep');
  // Another product's proof, or a home check's, writes no mark of this product's and lists nothing.
  const r = w.round();
  await r.clear({ key: P2 });
  await r.clear({ key: alertKey(HOME_PREFIX, 'stopped', 'schedule') });
  const before = listed(w.gh);
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: false, closed: [], failed: [], kept: [], why: null });
  assert.equal(listed(w.gh), before);
  assert.equal(w.writer.get(sweepFactId(P2)), null);
  assert.notEqual(sweepFactId(alertKey('a.b', 'k', 's')), sweepFactId(alertKey('a-b', 'k', 's')), 'products differing by a dot keep apart (m3)');
  await assert.rejects(r.sweep({ product: HOME_PREFIX }), /home checks/, 'the home prefix is not a product (m4)');
});

test('L959 m1: the answer names the issue the clear closed, not the one listed', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await w.gh.open({ title: 'copy', body: w.gh.issues.get(1).body });
  const backwards = { ...w.gh, listOpen: async (test) => (await w.gh.listOpen(test)).reverse() };
  const r = w.round({ gh: backwards });
  await r.clear({ key: A });
  // Listed as [2, 1]; the key's clear finds issue 1 first, then 2.
  assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [1, 2]);
});

test('L959 m2: the robot\'s login going unknown inside the clear\'s own look closes nothing', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const gh = { ...w.gh, listOpen: w.gh.listOpen, loginTrouble: null };
  gh.findOpen = async (test) => { gh.loginTrouble = 'the robot\'s own login could not be read'; return w.gh.findOpen(test); };
  const r = w.round({ gh });
  await r.clear({ key: A });
  const out = await r.sweep({ product: 'product 1' });
  assert.deepEqual(out.closed, []);
  assert.match(out.why, /login is not known/);
  assert.equal(w.gh.issues.get(1).closed, false);
  assert.equal(w.gh.calls.filter(([c]) => c === 'edit' || c === 'close').length, 0, 'not even the footer edited');
});

test('L959 m5: an issue another caller raised again after the proof is not closed', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round();
  await r.clear({ key: A });
  w.clock.tick(1);
  // Another process (its own makeAlerts) finds the cause back, and the Record refuses again.
  w.world.refuse = true;
  assert.equal(await w.round().raise({ key: A, title: A, body: 'It holds again.', status: 'again' }), 'changed');
  w.world.refuse = false;
  w.clock.tick(1);
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: true, closed: [], failed: [], kept: [1], why: null }, 'kept, and said');
  assert.equal(w.gh.issues.get(1).closed, false);
  // A quiet raise moves only "last seen": that counts too.
  const w2 = sweepWorld();
  await orphan(w2, A);
  const r2 = w2.round();
  await r2.clear({ key: A });
  w2.clock.tick(1);
  w2.world.refuse = true;
  assert.equal(await w2.round().raise({ key: A, title: A, body: 'It holds.' }), 'updated');
  w2.world.refuse = false;
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, []);
  assert.equal(w2.gh.issues.get(1).closed, false);
});

test('L959 m6: a clear that looked on GitHub and found nothing is no proof', async () => {
  const w = sweepWorld();
  const r = w.round();
  assert.equal(await r.clear({ key: A, look: true }), 'none');
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: false, closed: [], failed: [], kept: [], why: null });
  assert.equal(listed(w.gh), 0);
  assert.equal(w.writer.get(sweepFactId(A)), null);
});

test('L959 plants: a raise GitHub lost after the clear ends the proof; an old-form issue is never swept, however old its Record', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  let lose = false;
  const gh = { ...w.gh, listOpen: w.gh.listOpen, edit: async (...a) => (lose ? false : w.gh.edit(...a)), comment: async (...a) => (lose ? false : w.gh.comment(...a)) };
  const r = w.round({ gh });
  await r.clear({ key: A });
  lose = true;
  assert.equal(await r.raise({ key: A, title: A, body: 'It holds again.', status: 'again' }), false, 'back, but GitHub lost the raise');
  lose = false;
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: false, closed: [], failed: [], kept: [], why: null });
  assert.equal(w.gh.issues.get(1).closed, false);
  // An old-form issue whose Record says it was told long ago.
  const w2 = sweepWorld();
  const old = '2026-10-01T00:00:00.000Z';
  w2.writer.put(idFor(B), { kind: 'fact.alert', key: B, status_text: 'x', since: old, told_at: old });
  await w2.gh.open({ title: 'old form', body: `An old-form alert.\n<!-- alert-key ${idFor(B)} -->` });
  w2.clock.tick(1);
  const all = { ...w2.gh, listOpen: async () => [...w2.gh.issues].map(([number, x]) => ({ number, body: x.body })) };
  const r2 = w2.round({ gh: all });
  await r2.clear({ key: B });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, []);
  assert.equal(w2.gh.issues.get(1).closed, false);
});

test('L959: when the key\'s clear finds an old-form copy before its v1 issue, the sweep keeps it (only a v1 footer is swept)', async () => {
  const w = sweepWorld();
  const old = '2026-10-01T00:00:00.000Z';
  await orphan(w, B);
  w.writer.put(idFor(B), { kind: 'fact.alert', key: B, status_text: 'x', since: old, told_at: old });
  await w.gh.open({ title: 'old form', body: `An old-form alert.\n<!-- alert-key ${idFor(B)} -->` });
  w.clock.tick(1);
  // GitHub's search answers the old-form copy (issue 2) first.
  const gh = { ...w.gh, listOpen: w.gh.listOpen, findOpen: async (test) => { for (const [k, x] of [...w.gh.issues].reverse()) if (!x.closed && test(lastLine(x.body))) return k; return null; } };
  const r = w.round({ gh });
  await r.clear({ key: B });
  assert.deepEqual(await r.sweep({ product: 'product 1' }), { swept: true, closed: [], failed: [], kept: [2], why: null }, 'listed issue 1, its clear found the old-form copy, issue 2, and named it (L965 c1)');
  for (const n of [1, 2]) assert.equal(w.gh.issues.get(n).closed, false, `issue ${n}`);
});

test('L959 review: a refused mark keeps only its own key back; the answer names only an issue this sweep closed; clear takes one argument', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  await orphan(w, B);
  // A key's own mark refused after its issue was tried: both still closed, and the answer names the key (L965 c4).
  const markOf = sweepFactId(B);
  const r = w.round({ writer: { ...w.writer, put: (id, doc) => (id === markOf ? { ok: false, reason: 'the store is full' } : w.writer.put(id, doc)) } });
  for (const k of [A, B]) await r.clear({ key: k });
  const out = await r.sweep({ product: 'product 1' });
  assert.deepEqual(out.closed, [1, 2]);
  assert.equal(out.why, `the Record refused the mark of ${B}, so it may be tried again before the day is out`);
  assert.equal(w.writer.get(markOf), null);
  // The Record comes to point at an issue already closed between the proof and the sweep: nothing is named closed.
  const w2 = sweepWorld();
  await orphan(w2, A);
  const r2 = w2.round();
  await r2.clear({ key: A });
  w2.gh.issues.get(1).closed = true;
  w2.writer.put(idFor(A), { kind: 'fact.alert', key: A, issue: 1, status: 'open' });
  await w2.gh.open({ title: 'copy', body: w2.gh.issues.get(1).body });
  const out2 = await r2.sweep({ product: 'product 1' });
  assert.equal(out2.closed.includes(1), false, 'issue 1 was closed before the sweep');
  // A second argument (keys.map(alerts.clear) passes an index) changes nothing: the sweep's proof is its own.
  const w3 = sweepWorld();
  await orphan(w3, A);
  assert.equal(await w3.round().clear({ key: A, look: true }, 1), 'cleared');
  assert.equal(w3.gh.issues.get(1).closed, true);
});

test('L965 m1: an alert\'s text quoting an old "last seen" does not hide a raise after the proof', async () => {
  const w = sweepWorld();
  const body = 'Quoted: x · last seen 2000-01-01T00:00:00.000Z · y';
  await orphan(w, A, body);
  const r = w.round();
  await r.clear({ key: A });
  w.clock.tick(1);
  // Another caller's quiet raise: told stays at the opening, so only the robot's own "last seen" shows it.
  w.world.refuse = true;
  assert.equal(await w.round().raise({ key: A, title: A, body }), 'updated');
  w.world.refuse = false;
  const out = await r.sweep({ product: 'product 1' });
  assert.deepEqual(out.kept, [1]);
  assert.equal(w.gh.issues.get(1).closed, false);
});

test('L965 m2: a key orphaned again within the day closes on its next proof; a key with no issue gets no mark; the list is not read every pass', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r1 = w.round();
  await r1.clear({ key: A });
  await r1.clear({ key: B });
  assert.deepEqual((await r1.sweep({ product: 'product 1' })).closed, [1]);
  assert.equal(w.writer.get(sweepFactId(B)), null, 'B had no issue: no mark of its own');
  // An hour on, A is back and orphaned again (issue 2); a minute later it clears, once.
  w.clock.tick(60);
  await orphan(w, A, 'It holds again.');
  const r2 = w.round();
  await r2.clear({ key: A });
  await r2.clear({ key: B });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [2], 'its second orphan, the same day');
  // B and A cleared again on every pass: known clear, so the list is not read again that day.
  const before = listed(w.gh);
  for (let n = 0; n < 3; n++) { w.clock.tick(1); const r = w.round(); await r.clear({ key: A }); await r.clear({ key: B }); await r.sweep({ product: 'product 1' }); }
  assert.equal(listed(w.gh), before);
  // A day on, the list is read again.
  w.clock.tick(SWEEP_EVERY_MS / 60000);
  const r3 = w.round(); await r3.clear({ key: B }); await r3.sweep({ product: 'product 1' });
  assert.equal(listed(w.gh), before + 1);
});

test('L965 review m1, L973 m4: a kept issue is not known clear and is held back an hour, so it closes on its proof an hour on', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round();
  await r.clear({ key: A });
  w.clock.tick(1);
  w.world.refuse = true;
  assert.equal(await w.round().raise({ key: A, title: A, body: 'It holds again.', status: 'again' }), 'changed');
  w.world.refuse = false;
  w.clock.tick(1);
  assert.deepEqual((await r.sweep({ product: 'product 1' })).kept, [1]);
  assert.equal(w.writer.get(sweepFactId(A)).kept, true, 'kept: its mark holds it back an hour (L973 m4)');
  // An hour on it truly clears: the list is read again and the issue closes, not a day later.
  w.clock.tick(60);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [1]);
  assert.equal(w.gh.issues.get(1).closed, true);
});

// L973: the known-clear list is trusted an hour, so every wait behind it is about an hour at most (r3 demos D1-D4).
const SWEEP_LIST = 'fact.alert-sweep-list';
const whileListed = (w, gh, fn) => ({ ...gh, listOpen: async (f) => { const l = await gh.listOpen(f); await fn(); return l; } });

test('L973 D1: a second orphan whose raise could not take its key off the list closes within the hour, and the refusal is told', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round();
  await r.clear({ key: A });
  assert.deepEqual((await r.sweep({ product: 'product 1' })).closed, [1]);
  // 20 minutes on, A is back while the whole Record refuses: issue 2, and the forget refused too.
  w.clock.tick(20);
  w.world.kinds = ['fact.alert', SWEEP_LIST];
  const raiser = w.round();
  assert.equal(await raiser.raise({ key: A, title: A, body: 'It holds again.' }), 'opened');
  w.world.kinds = [];
  assert.equal(raiser.cacheTrouble(), 'the store is full');
  w.clock.tick(1);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [], 'still on the list');
  assert.equal(w.gh.issues.get(2).closed, false);
  // An hour from the list's first write, its next proof reads the list and closes it.
  w.clock.tick(40);
  const r3 = w.round();
  await r3.clear({ key: A });
  assert.deepEqual((await r3.sweep({ product: 'product 1' })).closed, [2]);
});

test('L973 m1a: a forget the Record refuses is told under the Record refusing', async () => {
  const w = sweepWorld();
  const r = w.round();
  assert.equal(await r.clear({ key: B }), 'none');
  await r.sweep({ product: 'product 1' });
  assert.ok(w.writer.get(sweepListFactId('product 1')).clear_ids.includes(idFor(B)), 'B known clear');
  w.clock.tick(1);
  w.world.kinds = [SWEEP_LIST];
  const raiser = w.round();
  assert.equal(await raiser.raise({ key: B, title: B, body: 'No stage.' }), 'opened');
  w.world.kinds = [];
  assert.equal(raiser.cacheTrouble(), 'the store is full');
  assert.equal(await raiser.reportTrouble('product 1', 'sensors'), 'opened', 'told: the Record is refusing');
});

test('L973 D2: a raise while the sweep waits on its list stays off the list, so its orphan closes on its next proof', async () => {
  const w = sweepWorld();
  const r0 = w.round();
  await r0.clear({ key: B });
  await r0.sweep({ product: 'product 1' });
  w.clock.tick(1);
  await orphan(w, A);
  let fired = false;
  const gh = whileListed(w, w.gh, async () => {
    if (fired) return;
    fired = true;
    // Another caller: B back while its number is refused (an orphan), and A raised again (so A is kept).
    w.world.refuse = true; await w.round().raise({ key: B, title: B, body: 'No stage.' }); w.world.refuse = false;
    w.clock.tick(1);
    await w.round().raise({ key: A, title: A, body: 'It holds again.' });
  });
  const r = w.round({ gh });
  await r.clear({ key: A });
  await r.clear({ key: B });
  assert.deepEqual((await r.sweep({ product: 'product 1' })).kept, [1]);
  assert.equal(w.writer.get(sweepListFactId('product 1')).clear_ids.includes(idFor(B)), false, 'the forget stands');
  w.clock.tick(1);
  const r2 = w.round();
  await r2.clear({ key: B });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [2], 'B\'s orphan, at once');
});

test('L973 D3, m4: a key one caller keeps raising and another clearing reads the list at most once an hour', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const before = listed(w.gh);
  for (let n = 0; n < 5; n++) {
    w.clock.tick(10);
    const r = w.round();
    await r.clear({ key: A });
    w.world.refuse = true; await w.round().raise({ key: A, title: A, body: 'It holds.' }); w.world.refuse = false;
    w.clock.tick(1);
    await r.sweep({ product: 'product 1' });
  }
  assert.equal(listed(w.gh) - before, 1);
  assert.equal(w.gh.issues.get(1).closed, false);
});

test('L973 D4, m3: a list read that throws leaves no id known clear, so the next pass closes', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round({ gh: { ...w.gh, listOpen: async () => { throw new Error('the network is down'); } } });
  await r.clear({ key: A });
  await assert.rejects(r.sweep({ product: 'product 1' }), /network is down/);
  assert.equal(w.writer.get(sweepListFactId('product 1')).clear_ids.includes(idFor(A)), false);
  w.clock.tick(10);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [1]);
});

test('L973 P7: the list keeps its first write\'s time, so an old id is needed again an hour on though a new one came later', async () => {
  const w = sweepWorld();
  const r = w.round();
  await r.clear({ key: A });
  await r.sweep({ product: 'product 1' });
  const at = w.writer.get(sweepListFactId('product 1')).listed_at;
  w.clock.tick(23);
  const r2 = w.round();
  await r2.clear({ key: B });
  await r2.sweep({ product: 'product 1' });
  assert.equal(w.writer.get(sweepListFactId('product 1')).listed_at, at, 'not moved by a later write');
  const before = listed(w.gh);
  w.clock.tick(SWEEP_LIST_TRUST_MS / 60000 - 23);
  const r3 = w.round();
  await r3.clear({ key: A });
  await r3.sweep({ product: 'product 1' });
  assert.equal(listed(w.gh), before + 1, 'A read again an hour from the first write');
});

test('L973 P10: a login unknown before the loop leaves nothing known clear, and the issue closes on the next pass', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  const r = w.round({ gh: { ...w.gh, listOpen: w.gh.listOpen, loginTrouble: 'the robot\'s own login could not be read' } });
  await r.clear({ key: A });
  assert.match((await r.sweep({ product: 'product 1' })).why, /login is not known/);
  assert.equal(w.writer.get(sweepListFactId('product 1')).clear_ids.includes(idFor(A)), false);
  w.clock.tick(1);
  const r2 = w.round();
  await r2.clear({ key: A });
  assert.deepEqual((await r2.sweep({ product: 'product 1' })).closed, [1]);
});

test('L973 m5, 4: a refused final list write is said; a product with "|" is refused', async () => {
  const w = sweepWorld();
  await orphan(w, A);
  // The list's first write lands, its rewrite (A kept, so off the list) is refused.
  let n = 0;
  const writer = { ...w.writer, put: (id, doc) => (doc.kind === SWEEP_LIST && n++ > 0 ? { ok: false, reason: 'full' } : w.writer.put(id, doc)) };
  const r = w.round({ writer });
  await r.clear({ key: A });
  w.clock.tick(1);
  w.world.refuse = true; await w.round().raise({ key: A, title: A, body: 'It holds.' }); w.world.refuse = false;
  w.clock.tick(1);
  const out = await r.sweep({ product: 'product 1' });
  assert.deepEqual(out.kept, [1]);
  assert.match(out.why, /refused the sweep's list mark, so a key it tried may wait up to an hour/);
  assert.throws(() => alertKey('a|b', 'k', 's'), /has no "\|"/);
  await assert.rejects(w.round().sweep({ product: 'a|b' }), /has no "\|"/);
});
