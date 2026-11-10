// review-requests.test.mjs — lead call L65: the Dispatcher's side of the review runner. It only writes request files
// and reads the runner's status; nothing here starts a process. Throwaway folders only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { writeReviewRequest, reviewPorts, statusAlerts, MAIN_UNREAD, mainSeenHead, STAMP_GRACE_MS } from './review-requests.mjs';
import { STATUS_STALE_MS } from '../M4-workshop/launcher/review-runner.mjs';
import { RUNNER_LOG } from '../M4-workshop/launcher/review-daemons.mjs';

const ME = process.getuid();
const HEAD = 'ab'.repeat(20);
const T0 = Date.parse('2026-10-29T12:00:00Z');
const MINUTE = 60_000;

test('L65: a request is written whole under its final name, never over another, and bad inputs write nothing', () => {
  const dir = tempDir('m11-req-');
  let n = 0;
  const newId = () => `q-${++n}`;
  const r = writeReviewRequest({ dir, card: 'C-1', head: HEAD, role: 'auditor', newId });
  assert.deepEqual(r, { ok: true, requestId: 'q-1' });
  assert.deepEqual(readdirSync(dir), ['q-1.json'], 'no half-written or temporary file is left');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'q-1.json'), 'utf8')), { card: 'C-1', head: HEAD, role: 'auditor', request_id: 'q-1' });
  assert.equal(lstatSync(join(dir, 'q-1.json')).mode & 0o777, 0o644);
  // The same id again: refused, the first kept.
  const again = writeReviewRequest({ dir, card: 'C-2', head: HEAD, role: 'reviewer', newId: () => 'q-1' });
  assert.equal(again.ok, false);
  assert.match(again.reason, /could not be written \(EEXIST\)/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'q-1.json'), 'utf8')).card, 'C-1');
  // A link planted at the temporary name is not followed, and, being someone else's, is not taken away (#294 r3 m2).
  const elsewhere = tempDir('m11-req-x-');
  symlinkSync(join(elsewhere, 'target'), join(dir, '.q-9.t1.tmp'));
  assert.equal(writeReviewRequest({ dir, card: 'C-1', head: HEAD, role: 'reviewer', newId: () => 'q-9', tmpId: () => 't1' }).ok, false);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(lstatSync(join(dir, '.q-9.t1.tmp')).isSymbolicLink(), 'the planted name is left where it was');
  unlinkSync(join(dir, '.q-9.t1.tmp'));
  // The hidden name is new each call: one planted at the old fixed name is never met, and the request is written.
  symlinkSync(join(elsewhere, 'target'), join(dir, '.q-9.tmp'));
  assert.equal(writeReviewRequest({ dir, card: 'C-1', head: HEAD, role: 'reviewer', newId: () => 'q-9' }).ok, true);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(lstatSync(join(dir, '.q-9.tmp')).isSymbolicLink());
  unlinkSync(join(dir, '.q-9.tmp'));
  unlinkSync(join(dir, 'q-9.json'));
  const bad = [
    [{ card: '../C-1' }, /not a card id/], [{ card: 7 }, /not a card id/],
    [{ head: HEAD.slice(1) }, /names no head/], [{ head: HEAD.toUpperCase() }, /names no head/], [{ head: undefined }, /names no head/],
    [{ role: 'worker' }, /"worker" is not a review role/], [{ role: undefined }, /not a review role/],
    [{ newId: () => '../x' }, /request id/], [{ newId: () => '' }, /request id/],
  ];
  for (const [over, re] of bad) {
    const before = readdirSync(dir).length;
    const x = writeReviewRequest({ dir, card: 'C-1', head: HEAD, role: 'reviewer', newId: () => 'q-bad', ...over });
    assert.equal(x.ok, false, JSON.stringify(over));
    assert.match(x.reason, re, JSON.stringify(over));
    assert.equal(readdirSync(dir).length, before, 'nothing written');
  }
  // A folder that isn't there is a failed request, not a throw.
  assert.match(writeReviewRequest({ dir: join(dir, 'gone'), card: 'C-1', head: HEAD, role: 'reviewer' }).reason, /ENOENT/);
});

function status(dir, body, mode = 0o644) {
  const file = join(dir, 'status.json');
  writeFileSync(file, JSON.stringify(body), { mode });
  chmodSync(file, mode);
  return file;
}

test('L65: hasReviewer reads the runner\'s status: the card, role and head must all match; an untrusted status throws', () => {
  const dir = tempDir('m11-status-');
  mkdirSync(join(dir, 'requests'));
  const running = [{ card: 'C-1', role: 'reviewer', head: HEAD, session_id: 's-1' }, { card: 'C-2', role: 'auditor', head: HEAD, session_id: 's-2' }];
  const alerts = [{ id: 'x', at: new Date(T0).toISOString(), text: 'hi' }];
  const file = status(dir, { written_at: new Date(T0).toISOString(), ok: true, running, alerts });
  let now = T0 + MINUTE;
  const p = reviewPorts({ requests: join(dir, 'requests'), status: file, reviewUid: ME, now: () => now, newId: () => 'q-1' });
  assert.equal(p.hasReviewer('C-1', 'reviewer', HEAD), true);
  assert.equal(p.hasReviewer('C-1', 'auditor', HEAD), false, 'the role must match');
  assert.equal(p.hasReviewer('C-1', 'reviewer', 'cd'.repeat(20)), false, 'a reviewer of an older head is not one for this head');
  assert.equal(p.hasReviewer('C-3', 'reviewer', HEAD), false);
  assert.equal(p.hasReviewer('C-1', 'reviewer', undefined), false, 'a card with no head has no reviewer of it');
  assert.equal(p.hasReviewer('C-2', 'auditor', HEAD), true);
  assert.deepEqual(p.reviewAlerts(), alerts);
  assert.deepEqual(p.requestReview({ card: 'C-3', head: HEAD, role: 'reviewer' }), { ok: true, requestId: 'q-1' });
  assert.deepEqual(readdirSync(join(dir, 'requests')), ['q-1.json']);
  // Stale: an error, never "no reviewer".
  now = T0 + STATUS_STALE_MS + 1;
  assert.throws(() => p.hasReviewer('C-3', 'reviewer', HEAD), /minutes old/);
  assert.throws(() => p.reviewAlerts(), /minutes old/);
  now = T0;
  // Not the review user's, writable by others, missing, or with no uid to check: errors.
  assert.throws(() => reviewPorts({ requests: dir, status: file, reviewUid: ME + 1, now: () => now }).hasReviewer('C-1', 'reviewer', HEAD), /not owned by the review user/);
  assert.throws(() => reviewPorts({ requests: dir, status: file, now: () => now }).hasReviewer('C-1', 'reviewer', HEAD), /uid is not known/);
  assert.throws(() => reviewPorts({ requests: dir, status: join(dir, 'none.json'), reviewUid: ME, now: () => now }).hasReviewer('C-1', 'reviewer', HEAD), /missing/);
  chmodSync(file, 0o666);
  assert.throws(() => p.hasReviewer('C-1', 'reviewer', HEAD), /written by others/);
});

test('L688: planReviewsRunning lists only the plan reviewers in the runner\'s status, and an untrusted status throws (never none)', () => {
  const dir = tempDir('m11-status-');
  const at = new Date(T0).toISOString();
  const running = [{ card: 'C-1', role: 'reviewer', head: HEAD, session_id: 's-1', started_at: at },
    { card: 'C-2', role: 'plan_reviewer', head: HEAD, session_id: 's-2', started_at: at, pid: 7 },
    { card: 'C-3', role: 'auditor', head: HEAD, session_id: 's-3', started_at: at }];
  const file = status(dir, { written_at: at, ok: true, running, alerts: [] });
  let now = T0 + MINUTE;
  const p = reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => now });
  assert.deepEqual(p.planReviewsRunning(), [{ card: 'C-2', session_id: 's-2', started_at: at }]);
  assert.equal(p.hasReviewer('C-2', 'reviewer', HEAD), false, 'a plan reviewer is no reviewer of the change');
  now = T0 + STATUS_STALE_MS + 1;
  assert.throws(() => p.planReviewsRunning(), /minutes old/);
  now = T0;
  assert.throws(() => reviewPorts({ requests: dir, status: file, reviewUid: ME + 1, now: () => now }).planReviewsRunning(), /not owned by the review user/);
});

test('L66, L315: a failed runner pass and an installed copy behind main are holds, each naming its cause', () => {
  const MAIN = 'c'.repeat(40);
  const ok = { ok: true, error: null, installed_commit: MAIN, alerts: [], running: [] };
  assert.deepEqual(statusAlerts(ok, () => MAIN), []);
  // A failed pass: one hold, the same each time it is read; another cause is the same hold with another `since`.
  const f1 = statusAlerts({ ...ok, ok: false, error: 'the requests could not be listed (EACCES)' }, () => MAIN);
  assert.equal(f1.length, 1);
  assert.match(f1[0].text, /last pass failed: the requests could not be listed \(EACCES\)/);
  assert.deepEqual(statusAlerts({ ...ok, ok: false, error: 'the requests could not be listed (EACCES)' }, () => MAIN), f1);
  assert.notEqual(statusAlerts({ ...ok, ok: false, error: 'another cause' }, () => MAIN)[0].since, f1[0].since);
  // L437: the class of the first error, as pass.mjs causeOf reads it. More errors after it, or other numbers, are the same trouble.
  const since = (error) => statusAlerts({ ...ok, ok: false, error }, () => MAIN)[0].since;
  assert.equal(since('the requests could not be listed (EACCES); session 12 could not be marked'), f1[0].since);
  assert.equal(since('card 12 failed'), since('card 345 failed'));
  // L458: what varies by pass makes no new trouble: an id, or the detail in brackets, even cut off by the 300 limit.
  const uuid = (n) => `${String(n).repeat(8).slice(0, 8)}-aaaa-bbbb-cccc-dddddddddddd`.replace(/\d/g, (d) => 'abcdef0123'[d]);
  assert.equal(since(`session ${uuid(1)} could not be marked ended (EIO)`), since(`session ${uuid(2)} could not be marked ended (ENOSPC)`));
  assert.equal(since(`session S-a could not be set aside (EIO)`), since(`session S-b could not be set aside (EIO)`));
  assert.equal(since('the review sessions could not be listed (it broke (twice)), so none starts'), since('the review sessions could not be listed (other), so none starts'));
  assert.equal(since('the review folders could not be made (cut off'), since('the review folders could not be made (EACCES)'));
  assert.equal(since(`lost ${uuid(1)} here`), since(`lost ${uuid(2)} here`));
  assert.notEqual(since('session S-a could not be marked ended (EIO)'), since('session S-a could not be set aside (EIO)'), 'another class is another trouble');
  // The stamp: behind main, or none, is named by the installed commit; without main's head, nothing.
  const behind = statusAlerts({ ...ok, installed_commit: HEAD }, () => MAIN);
  assert.equal(behind.length, 1);
  assert.match(behind[0].text, /installed copy is at abababa, but main is at ccccccc/);
  assert.equal(statusAlerts({ ...ok, installed_commit: HEAD }, () => 'd'.repeat(40))[0].since, behind[0].since, 'main moving on is the same trouble');
  // m-f (audit r2): plain words, and where the runner's log is: the path when the wiring gives it, else the file's name.
  const none = statusAlerts({ ...ok, installed_commit: null }, () => MAIN)[0].text;
  assert.match(none, /no commit stamp \(the file that says which commit of main the copy was made from\).*the review runner says what to do in its log, review-runner\.err\.log, in the folder the Mac setup chose for the review jobs' logs\.$/);
  assert.equal(RUNNER_LOG, 'review-runner.err.log');
  assert.match(statusAlerts({ ...ok, installed_commit: null }, () => MAIN, T0, { runnerLog: '/logs/review-runner.err.log' })[0].text, /says what to do in its log, \/logs\/review-runner\.err\.log\.$/);
  assert.doesNotMatch(none, /<|\.v-|installed-commit|L\d+/, 'no placeholders, folder names or lead-call numbers');
  assert.deepEqual(statusAlerts({ ...ok, installed_commit: HEAD }, undefined), [], 'no port: no stamp check');
  // L470 m2: the port's error is in the words, on one line and cut to 100 characters, and never in the cause.
  const failed = (message) => statusAlerts({ ...ok, installed_commit: HEAD }, () => { throw new Error(message); })[0];
  assert.equal(failed('no\n  remote').text, `${MAIN_UNREAD} The read said: no remote`);
  assert.equal(failed('x'.repeat(300)).text, `${MAIN_UNREAD} The read said: ${'x'.repeat(100)}`);
  assert.equal(failed('one').since, failed('another').since);
  // L437 m1, L465: main can't be read, so the stamp hold is kept and says so, under one cause whatever went wrong.
  for (const mainHead of [() => null, () => 'main', () => ({ commit: null })]) {
    assert.deepEqual(statusAlerts({ ...ok, installed_commit: HEAD }, mainHead), [{ id: 'stamp', hold: true, keep: true, since: 'main-unreadable', text: MAIN_UNREAD }]);
  }
  // Through the ports, read from the real status file.
  const dir = tempDir('m11-status-');
  const file = status(dir, { written_at: new Date(T0).toISOString(), ok: false, error: 'the review user is an admin', installed_commit: HEAD, running: [], alerts: [{ id: 'x', at: 'y', text: 'z' }] });
  const got = reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => T0, mainHead: () => MAIN }).reviewAlerts();
  assert.deepEqual(got.map((a) => a.id), ['x', 'runner-failed', 'stamp']);
});

test('L136 m4: reviewPorts hands runnerLog to the no-stamp alert, so Joe is told where the log really is', () => {
  const MAIN = 'c'.repeat(40);
  const dir = tempDir('m11-runnerlog-');
  const file = status(dir, { written_at: new Date(T0).toISOString(), ok: true, error: null, installed_commit: null, running: [], alerts: [] });
  const log = join('/', 'logs', RUNNER_LOG);
  const text = (over) => reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => T0, mainHead: () => MAIN, ...over }).reviewAlerts().map((a) => a.text);
  const [given] = text({ runnerLog: log });
  assert.match(given, /no commit stamp/);
  assert.ok(given.endsWith(`says what to do in its log, ${log}.`), given);
  // Control: without it, the alert falls back to the file's name and says which folder to look in.
  assert.match(text({})[0], /says what to do in its log, review-runner\.err\.log, in the folder the Mac setup chose for the review jobs' logs\.$/);
});

test('item 20(c) planted: a copy behind main is told only once it has stayed behind for the grace period', () => {
  const MAIN = 'c'.repeat(40);
  const ok = { ok: true, error: null, installed_commit: HEAD, alerts: [], running: [] };
  const now = T0;
  const behindFor = (ms) => statusAlerts(ok, () => ({ commit: MAIN, since: now - ms }), now);
  assert.equal(STAMP_GRACE_MS, 30 * 60_000);
  assert.deepEqual(behindFor(0), [], 'main just moved: the updater has not had its turn');
  assert.deepEqual(behindFor(STAMP_GRACE_MS - 1), []);
  const late = behindFor(STAMP_GRACE_MS);
  assert.equal(late.length, 1);
  assert.deepEqual([late[0].id, late[0].since], ['stamp', HEAD]);
  assert.match(late[0].text, /installed copy is at abababa, but main is at ccccccc/);
  // The port is asked about the installed commit, so `since` can be when main first moved past it.
  const asked = [];
  statusAlerts(ok, (x) => { asked.push(x); return { commit: MAIN, since: now }; }, now);
  assert.deepEqual(asked, [HEAD]);
  // No stamp is told at once, grace or not; so is a head with no `since`, a `since` dated ahead, or a plain string.
  assert.match(statusAlerts({ ...ok, installed_commit: null }, () => ({ commit: MAIN, since: now }), now)[0].text, /no commit stamp/);
  for (const head of [{ commit: MAIN }, { commit: MAIN, since: 'soon' }, { commit: MAIN, since: now + 6 * 60_000 }, MAIN]) {
    assert.equal(statusAlerts(ok, () => head, now).length, 1, JSON.stringify(head));
  }
  // At main: nothing, whatever `since` says.
  assert.deepEqual(statusAlerts({ ...ok, installed_commit: MAIN }, () => ({ commit: MAIN, since: now - 9e9 }), now), []);
  // Through the ports, the clock is the ports' own.
  const dir = tempDir('m11-grace-');
  const file = status(dir, { written_at: new Date(T0).toISOString(), ok: true, error: null, installed_commit: HEAD, running: [], alerts: [] });
  const at = (ms) => reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => T0, mainHead: () => ({ commit: MAIN, since: T0 - ms }) }).reviewAlerts().length;
  assert.deepEqual([at(60_000), at(STAMP_GRACE_MS + 60_000)], [0, 1]);
});

test('L75 m-2: the stamp alert waits from root\'s record of main, read the way the updater writes it', () => {
  const MAIN = 'c'.repeat(40);
  const top = tempDir('m11-seen-');
  chmodSync(top, 0o755);
  const installRoot = join(top, 'inst');
  const file = `${installRoot}.main-seen.json`;
  const write = (s, mode = 0o644) => { writeFileSync(file, JSON.stringify(s), { mode }); chmodSync(file, mode); };
  const port = (over = {}) => mainSeenHead({ installRoot, main: () => MAIN, owner: ME, top, ...over });
  // The updater has seen this head: its own `since`.
  write({ commit: MAIN, since: T0 - 5 * MINUTE, installed: HEAD, checked_at: T0 - MINUTE });
  assert.deepEqual(port()(HEAD), { commit: MAIN, since: T0 - 5 * MINUTE });
  const ok = { ok: true, error: null, installed_commit: HEAD, alerts: [], running: [] };
  assert.deepEqual(statusAlerts(ok, port(), T0), [], 'inside the grace');
  assert.equal(statusAlerts(ok, port(), T0 + STAMP_GRACE_MS).length, 1);
  // Main moved after the last fetch: from that fetch.
  write({ commit: 'd'.repeat(40), since: T0 - 9 * MINUTE, installed: 'd'.repeat(40), checked_at: T0 - 2 * MINUTE });
  assert.deepEqual(port()('d'.repeat(40)), { commit: MAIN, since: T0 - 2 * MINUTE });
  // The same copy already behind: main moving on does not start the grace again (L437 MAT-3).
  write({ commit: 'd'.repeat(40), since: T0 - 9 * MINUTE, installed: HEAD, checked_at: T0 - 2 * MINUTE });
  assert.deepEqual(port()(HEAD), { commit: MAIN, since: T0 - 9 * MINUTE });
  // A record others can write, of another owner's, or missing: no `since`, so the alert is told at once.
  write({ commit: MAIN, since: T0, installed: HEAD, checked_at: T0 }, 0o666);
  assert.deepEqual(port()(HEAD), { commit: MAIN, since: null });
  write({ commit: MAIN, since: T0, installed: HEAD, checked_at: T0 });
  assert.deepEqual(port({ owner: ME + 1 })(HEAD), { commit: MAIN, since: null });
  assert.equal(statusAlerts(ok, port({ owner: ME + 1 }), T0).length, 1);
  assert.deepEqual(port({ installRoot: join(top, 'none') })(HEAD), { commit: MAIN, since: null });
  // reviewPorts builds it from installRoot and main; the record must be root's, so this test user's is not trusted.
  const dir = tempDir('m11-seenp-');
  const sfile = join(dir, 'status.json');
  writeFileSync(sfile, JSON.stringify({ written_at: new Date(T0).toISOString(), ...ok }), { mode: 0o644 });
  const got = reviewPorts({ requests: dir, status: sfile, reviewUid: ME, now: () => T0, installRoot, main: () => MAIN }).reviewAlerts();
  assert.deepEqual(got.map((a) => a.id), ['stamp']);
});
