// #219 audit M-1: the one check on a worker's outbox. What the Dispatcher and the push script do with its answer is in
// M11 pass.test.mjs and push.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { workerOutboxProblem } from './session-outbox.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';

const SID = 'S-1';

test('the shape: only <anything>/worker/<this session> passes', () => {
  assert.equal(workerOutboxProblem('/outboxes/worker/S-1', SID), null);
  for (const [outbox, re] of [
    [undefined, /not named/], [null, /not named/], ['', /not named/], [7, /not named/],
    ['outboxes/worker/S-1', /full path/],
    ['/outboxes/worker/S-2', /own folder/], ['/outboxes/worker', /own folder/], ['/', /plain path/],
    ['/outboxes/reviewer/S-1', /worker outbox/], ['/S-1', /worker outbox/],
    ['/outboxes/worker/x/../S-1', /plain path/], ['/outboxes/worker/./S-1', /plain path/], ['/outboxes//worker/S-1', /plain path/], ['/outboxes/worker/S-1/', /plain path/],
  ]) assert.match(String(workerOutboxProblem(outbox, SID)), re, String(outbox));
  for (const sid of [undefined, null, '', 7]) assert.match(workerOutboxProblem('/outboxes/worker/S-1', sid), /own folder/);
});

test('with the root: the real folder must be <root>/worker/<session>, through any link', () => {
  const root = realpathSync(tempDir('orch-outbox-'));
  mkdirSync(join(root, 'worker', SID), { recursive: true });
  mkdirSync(join(root, 'worker', 'S-old'));
  assert.equal(workerOutboxProblem(join(root, 'worker', SID), SID, { root }), null);
  // A root reached through a link is the same root.
  const viaLink = `${root}-link`;
  symlinkSync(root, viaLink);
  assert.equal(workerOutboxProblem(join(viaLink, 'worker', SID), SID, { root }), null);
  assert.equal(workerOutboxProblem(join(root, 'worker', SID), SID, { root: viaLink }), null);
  // The right name that is really an older attempt's folder.
  symlinkSync(join(root, 'worker', 'S-old'), join(root, 'worker', 'S-2'));
  assert.match(workerOutboxProblem(join(root, 'worker', 'S-2'), 'S-2', { root }), /not inside the outbox root/);
  // Outside the root, however well named; a folder that isn't there; a root that isn't.
  mkdirSync(join(root, 'other', 'worker', SID), { recursive: true });
  assert.match(workerOutboxProblem(join(root, 'other', 'worker', SID), SID, { root }), /not inside the outbox root/);
  assert.match(workerOutboxProblem(join(root, 'worker', 'S-3'), 'S-3', { root }), /could not be read \(ENOENT\)/);
  assert.match(workerOutboxProblem(join(root, 'worker', SID), SID, { root: join(root, 'nope') }), /could not be read \(ENOENT\)/);
  // A root of null is not known, as undefined; only the shape is checked.
  assert.equal(workerOutboxProblem('/outboxes/worker/S-1', SID, { root: null }), null);
});
