// review-requests.test.mjs — lead call L65: the Dispatcher's side of the review runner. It only writes request files
// and reads the runner's status; nothing here starts a process. Throwaway folders only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { writeReviewRequest, reviewPorts } from './review-requests.mjs';
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
