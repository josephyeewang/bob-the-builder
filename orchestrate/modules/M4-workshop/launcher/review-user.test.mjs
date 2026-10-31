// review-user.test.mjs — lead call L44: a reviewer or auditor runs only as the separate review user, starts through
// sudo without ever asking, and writes into an outbox folder only that user can write. Fakes only: no user switch,
// no sudo, no real session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { reviewUser, startCommand, reviewOutbox, checkReviewOutbox, prepareReviewOutbox, SUDO, MKDIR, REVIEW_USER } from './review-user.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const SELF = 501;
const REVIEW = 503;
const UIDS = { lead: SELF, worker: SELF, writer: SELF, reviewer: REVIEW, auditor: REVIEW };
const refused = (r, re) => { assert.equal(r.ok, false, 'expected a refusal'); assert.match(r.reason, re); };

// A fake lstat: each path answers as a plain folder owned by `uid` with `mode`, unless `over[path]` says otherwise.
const fakeStat = (over = {}, base = { uid: REVIEW, mode: 0o40755 }) => (p) => {
  const o = Object.hasOwn(over, p) ? over[p] : base;
  if (o === null) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
  return { uid: o.uid, mode: o.mode, isSymbolicLink: () => o.link === true, isDirectory: () => o.dir !== false && o.link !== true };
};

test('L44: the review user must be its own Mac user', () => {
  assert.deepEqual(reviewUser({ role: 'worker', uids: UIDS, self: SELF }), { ok: true, runAs: null });
  assert.deepEqual(reviewUser({ role: 'reviewer', uids: UIDS, self: SELF }), { ok: true, runAs: { user: REVIEW_USER, uid: REVIEW } });
  assert.deepEqual(reviewUser({ role: 'auditor', uids: UIDS, self: SELF }).runAs.uid, REVIEW);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: undefined }, self: SELF }), /no review user id is set for reviewer/);
  refused(reviewUser({ role: 'reviewer', uids: undefined, self: SELF }), /no review user id/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: -1 }, self: SELF }), /no review user id/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: '503' }, self: SELF }), /no review user id/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, reviewer: 0 }, self: SELF }), /may not be root/);
  refused(reviewUser({ role: 'auditor', uids: { ...UIDS, auditor: SELF, worker: 600, lead: 600, writer: 600 }, self: SELF }), /launcher's own user/);
  refused(reviewUser({ role: 'reviewer', uids: { ...UIDS, worker: REVIEW }, self: SELF }), /not a separate Mac user \(shared with worker\)/);
});

test('L44: the start runs as the review user through sudo -n, never asking; other roles are unchanged', () => {
  const runAs = { user: REVIEW_USER, uid: REVIEW };
  assert.deepEqual(startCommand({ bin: '/opt/claude', args: ['-p', 'x'], runAs }), { bin: SUDO, args: ['-n', '-H', '-u', REVIEW_USER, '--', '/opt/claude', '-p', 'x'] });
  assert.deepEqual(startCommand({ bin: '/opt/claude', args: ['-p', 'x'], runAs: null }), { bin: '/opt/claude', args: ['-p', 'x'] });
  assert.throws(() => startCommand({ bin: 'claude', args: [], runAs }), /full path/);
  assert.throws(() => startCommand({ bin: '/opt/claude', args: [1], runAs }), /strings/);
  assert.throws(() => startCommand({ bin: '/opt/claude', args: [], runAs: { user: 'someone', uid: REVIEW } }), /not the review user/);
  assert.throws(() => startCommand({ bin: '/opt/claude', args: [], runAs: { user: REVIEW_USER, uid: 0 } }), /not the review user/);
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

test('L44: the session outbox is made by the review user, never reused, and checked after', () => {
  const args = { outboxRoot: '/x/out', role: 'auditor', sessionId: 'A-1', uid: REVIEW };
  const made = new Set();
  const runs = [];
  const stat = (p) => fakeStat(made.has(p) || p === '/x/out/auditor' ? {} : { [p]: null })(p);
  const run = (cmd) => { runs.push(cmd); made.add(cmd.args.at(-1)); return { status: 0 }; };
  assert.deepEqual(prepareReviewOutbox({ ...args, run, stat }), { ok: true, outbox: '/x/out/auditor/A-1' });
  assert.deepEqual(runs, [{ bin: SUDO, args: ['-n', '-u', REVIEW_USER, '--', MKDIR, '-m', '0755', '/x/out/auditor/A-1'] }]);
  // the same session id again: the folder is there, so nothing runs
  refused(prepareReviewOutbox({ ...args, run, stat }), /already there; a session id is never reused/);
  assert.equal(runs.length, 1);
  // the mkdir fails (sudo -n with no rule, say), or throws
  refused(prepareReviewOutbox({ ...args, sessionId: 'A-2', run: () => ({ status: 1 }), stat }), /could not make the outbox folder \(exit 1\)/);
  refused(prepareReviewOutbox({ ...args, sessionId: 'A-3', run: () => { throw new Error('timed out'); }, stat }), /could not make the outbox folder \(timed out\)/);
  // made, but by the wrong user: the check after catches it
  const wrong = (p) => fakeStat(p === '/x/out/auditor/A-4' && made.has(p) ? { [p]: { uid: SELF, mode: 0o40755 } } : made.has(p) || p === '/x/out/auditor' ? {} : { [p]: null })(p);
  refused(prepareReviewOutbox({ ...args, sessionId: 'A-4', run, stat: wrong }), /not owned by the review user/);
  refused(prepareReviewOutbox({ ...args, sessionId: 'no/good', run, stat }), /session id/);
});
