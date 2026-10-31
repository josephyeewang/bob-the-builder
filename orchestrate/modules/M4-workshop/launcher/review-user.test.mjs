// review-user.test.mjs — lead call L44: a reviewer or auditor runs only as the separate review user, starts through
// sudo without ever asking, and writes into an outbox folder only that user can write. Fakes only: no user switch,
// no sudo, no real session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { reviewUser, uidsProblem, reviewOutbox, checkReviewOutbox, REVIEW_USER } from './review-user.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const SELF = 501;
const REVIEW = 503;
const UIDS = { lead: SELF, worker: SELF, writer: SELF, incident: SELF, scout: SELF, front_door: SELF, thinking: SELF, learning: SELF, reviewer: REVIEW, auditor: REVIEW };
const refused = (r, re) => { assert.equal(r.ok, false, 'expected a refusal'); assert.match(r.reason, re); };

// A fake lstat: each path answers as a plain folder owned by `uid` with `mode`, unless `over[path]` says otherwise.
const fakeStat = (over = {}, base = { uid: REVIEW, mode: 0o40755 }) => (p) => {
  const o = Object.hasOwn(over, p) ? over[p] : base;
  if (o === null) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
  return { uid: o.uid, mode: o.mode, isSymbolicLink: () => o.link === true, isDirectory: () => o.dir !== false && o.link !== true };
};

test('L44, L65: a review role starts only as its own separate Mac user, from the runner running as that user', () => {
  assert.deepEqual(reviewUser({ role: 'worker', uids: UIDS, self: SELF }), { ok: true, runAs: null });
  assert.deepEqual(reviewUser({ role: 'reviewer', uids: UIDS, self: REVIEW }), { ok: true, runAs: { user: REVIEW_USER, uid: REVIEW } });
  assert.deepEqual(reviewUser({ role: 'auditor', uids: UIDS, self: REVIEW }).runAs.uid, REVIEW);
  // Started by anyone else (the Dispatcher's user, say) it is refused: there is no switch to the review user any more.
  refused(reviewUser({ role: 'reviewer', uids: UIDS, self: SELF }), /started only by the review runner, running as the review user \(uid 503\), not uid 501/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: undefined }, self: REVIEW }), /leaves out reviewer/);
  refused(reviewUser({ role: 'reviewer', uids: undefined, self: REVIEW }), /no map of role to Mac user id/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: -1 }, self: REVIEW }), /leaves out reviewer/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: '503' }, self: REVIEW }), /leaves out reviewer/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: 0 }, self: 0 }), /may not be root/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, worker: REVIEW }, self: REVIEW }), /not a separate Mac user \(shared with worker\)/);
});

test('L65 m-1: the role map must name every role in the design table', () => {
  assert.equal(uidsProblem(UIDS), null);
  const { scout: _s, ...noScout } = UIDS;
  assert.match(uidsProblem(noScout), /leaves out scout/);
  // A role left out could share the review user unseen: that is refused before the shared-user check runs.
  refused(reviewUser({ role: 'reviewer', uids: noScout, self: REVIEW }), /leaves out scout/);
  assert.match(uidsProblem(null), /no map/);
});

test('L44: the outbox folder is <root>/<role>/<session id>, for a review role and a good session id only', () => {
  assert.equal(reviewOutbox({ outboxRoot: '/x/out', role: 'reviewer', sessionId: 'R-1' }), '/x/out/reviewer/R-1');
  assert.throws(() => reviewOutbox({ outboxRoot: '/x/out', role: 'worker', sessionId: 'R-1' }), /not a review role/);
  assert.throws(() => reviewOutbox({ outboxRoot: 'out', role: 'reviewer', sessionId: 'R-1' }), /full path/);
  for (const bad of ['../W-1', 'R 1', 'R/1', '', 'x'.repeat(129)]) {
    assert.throws(() => reviewOutbox({ outboxRoot: '/x/out', role: 'reviewer', sessionId: bad }), /session id/, bad);
  }
});

test('L44: the role and session folders must be plain folders that only the review user can write', () => {
  const args = { outboxRoot: '/x/out', role: 'reviewer', sessionId: 'R-1', uid: REVIEW };
  assert.deepEqual(checkReviewOutbox({ ...args, stat: fakeStat() }), { ok: true, outbox: '/x/out/reviewer/R-1' });
  for (const [path, what] of [['/x/out/reviewer', 'role'], ['/x/out/reviewer/R-1', 'session']]) {
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: null }) }), new RegExp(`${what} outbox folder is missing`));
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: { uid: REVIEW, mode: 0o120755, link: true } }) }), new RegExp(`${what} outbox folder is a link`));
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: { uid: REVIEW, mode: 0o100644, dir: false } }) }), new RegExp(`${what} outbox folder is not a folder`));
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: { uid: SELF, mode: 0o40755 } }) }), new RegExp(`${what} outbox folder is not owned by the review user`));
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: { uid: REVIEW, mode: 0o40775 } }) }), new RegExp(`${what} outbox folder can be written by others`));
    refused(checkReviewOutbox({ ...args, stat: fakeStat({ [path]: { uid: REVIEW, mode: 0o40757 } }) }), new RegExp(`${what} outbox folder can be written by others`));
  }
  refused(checkReviewOutbox({ ...args, sessionId: '../W-1', stat: fakeStat() }), /session id/);
});

test('L44: a real folder that is a link, or a file, is refused (lstat, never followed)', () => {
  const root = tempDir('m4-review-');
  const uid = process.getuid();
  mkdirSync(join(root, 'reviewer', 'R-1'), { recursive: true, mode: 0o755 });
  const base = { outboxRoot: root, role: 'reviewer', uid };
  assert.equal(checkReviewOutbox({ ...base, sessionId: 'R-1' }).ok, (lstatSync(join(root, 'reviewer')).mode & 0o022) === 0);
  mkdirSync(join(root, 'elsewhere'), { mode: 0o755 });
  symlinkSync(join(root, 'elsewhere'), join(root, 'reviewer', 'R-2'));
  refused(checkReviewOutbox({ ...base, sessionId: 'R-2' }), /session outbox folder is a link/);
  writeFileSync(join(root, 'reviewer', 'R-3'), 'x');
  refused(checkReviewOutbox({ ...base, sessionId: 'R-3' }), /session outbox folder is not a folder/);
});
