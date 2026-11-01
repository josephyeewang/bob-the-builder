// review-requests.test.mjs — lead call L65: the Dispatcher's side of the review runner. It only writes request files
// and reads the runner's status; nothing here starts a process. Throwaway folders only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { writeReviewRequest, reviewPorts, statusAlerts, mainSeenHead, STAMP_GRACE_MS } from './review-requests.mjs';
import { STATUS_STALE_MS } from '../M4-workshop/launcher/review-runner.mjs';

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
  // A link planted at the temporary name is not followed.
  const elsewhere = tempDir('m11-req-x-');
  symlinkSync(join(elsewhere, 'target'), join(dir, '.q-9.tmp'));
  assert.equal(writeReviewRequest({ dir, card: 'C-1', head: HEAD, role: 'reviewer', newId: () => 'q-9' }).ok, false);
  assert.deepEqual(readdirSync(elsewhere), []);
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

test('L66: a failed runner pass and an installed copy behind main are told, each once per cause', () => {
  const MAIN = 'c'.repeat(40);
  const ok = { ok: true, error: null, installed_commit: MAIN, alerts: [], running: [] };
  assert.deepEqual(statusAlerts(ok, () => MAIN), []);
  // A failed pass: one alert per cause, the same id each time it is read.
  const f1 = statusAlerts({ ...ok, ok: false, error: 'the requests could not be listed (EACCES)' }, () => MAIN);
  assert.equal(f1.length, 1);
  assert.match(f1[0].text, /last pass failed: the requests could not be listed \(EACCES\)/);
  assert.deepEqual(statusAlerts({ ...ok, ok: false, error: 'the requests could not be listed (EACCES)' }, () => MAIN), f1);
  assert.notEqual(statusAlerts({ ...ok, ok: false, error: 'another cause' }, () => MAIN)[0].id, f1[0].id);
  // The stamp: behind main, or none, is told once per installed commit; without main's head, nothing.
  const behind = statusAlerts({ ...ok, installed_commit: HEAD }, () => MAIN);
  assert.equal(behind.length, 1);
  assert.match(behind[0].text, /installed copy is at abababa, but main is at ccccccc/);
  assert.equal(statusAlerts({ ...ok, installed_commit: HEAD }, () => 'd'.repeat(40))[0].id, behind[0].id, 'main moving on does not tell it again');
  assert.match(statusAlerts({ ...ok, installed_commit: null }, () => MAIN)[0].text, /no commit stamp/);
  for (const mainHead of [undefined, () => null, () => 'main', () => { throw new Error('no'); }]) assert.deepEqual(statusAlerts({ ...ok, installed_commit: HEAD }, mainHead), []);
  // Through the ports, read from the real status file.
  const dir = tempDir('m11-status-');
  const file = status(dir, { written_at: new Date(T0).toISOString(), ok: false, error: 'the review user is an admin', installed_commit: HEAD, running: [], alerts: [{ id: 'x', at: 'y', text: 'z' }] });
  const got = reviewPorts({ requests: dir, status: file, reviewUid: ME, now: () => T0, mainHead: () => MAIN }).reviewAlerts();
  assert.deepEqual(got.map((a) => a.id.replace(/-[0-9a-f]{24}$/, '-#')), ['x', 'runner-failed-#', `stamp-${HEAD}`]);
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
  assert.equal(late[0].id, `stamp-${HEAD}`);
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
  write({ commit: 'd'.repeat(40), since: T0 - 9 * MINUTE, installed: HEAD, checked_at: T0 - 2 * MINUTE });
  assert.deepEqual(port()(HEAD), { commit: MAIN, since: T0 - 2 * MINUTE });
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
  assert.deepEqual(got.map((a) => a.id), [`stamp-${HEAD}`]);
});
