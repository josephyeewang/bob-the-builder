// #219 audit M-1: the one check on a worker's outbox. What the Dispatcher and the push script do with its answer is in
// M11 pass.test.mjs and push.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { workerOutboxProblem, outboxProblemFor } from './session-outbox.mjs';
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
  const viaLink = join(tempDir('orch-outbox-'), 'link');
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

test('L767: a script session\'s outbox is <root>/script/<session>; a role names one folder, a list any of its folders', () => {
  assert.equal(workerOutboxProblem('/outboxes/script/S-1', SID, { role: 'script' }), null);
  assert.match(workerOutboxProblem('/outboxes/worker/S-1', SID, { role: 'script' }), /is not a script outbox/);
  assert.match(workerOutboxProblem('/outboxes/script/S-1', SID), /is not a worker outbox/, 'the default is the worker');
  assert.equal(workerOutboxProblem('/outboxes/script/S-1', SID, { role: ['worker', 'script'] }), null);
  assert.match(workerOutboxProblem('/outboxes/reviewer/S-1', SID, { role: ['worker', 'script'] }), /is not a worker or script outbox/);
  for (const role of ['reviewer', 'lead', [], ['worker', 'reviewer'], null, 7]) assert.match(workerOutboxProblem('/outboxes/worker/S-1', SID, { role }), /no runner role/, JSON.stringify(role));
  const root = realpathSync(tempDir('orch-outbox-'));
  mkdirSync(join(root, 'script', SID), { recursive: true }); mkdirSync(join(root, 'worker', 'S-2'), { recursive: true });
  assert.equal(workerOutboxProblem(join(root, 'script', SID), SID, { root, role: 'script' }), null);
  assert.equal(workerOutboxProblem(join(root, 'script', SID), SID, { root, role: ['worker', 'script'] }), null);
  // The real folder must be under the same role it is named under: a script name linked to a worker folder is refused.
  symlinkSync(join(root, 'worker', 'S-2'), join(root, 'script', 'S-2'));
  assert.match(workerOutboxProblem(join(root, 'script', 'S-2'), 'S-2', { root, role: ['worker', 'script'] }), /not inside the outbox root/);
});

// L836: a session's outbox is in its own product's folder, <outboxRoot>/<product>/<role>/<session id>.
test('L836: outboxProblemFor checks the outbox in the session\'s own product\'s folder', () => {
  const root = realpathSync(tempDir('m4-outbox-product-'));
  const SID = 'S-1';
  for (const p of [['p1', 'worker', SID], ['p2', 'worker', SID], ['worker', SID], ['p1', 'script', SID]]) mkdirSync(join(root, ...p), { recursive: true });
  const ask = (outbox, product, role) => outboxProblemFor(outbox, SID, { outboxRoot: root, product, ...(role ? { role } : {}) });
  assert.equal(ask(join(root, 'p1', 'worker', SID), 'p1'), null);
  assert.equal(ask(join(root, 'p1', 'script', SID), 'p1', ['worker', 'script']), null);
  assert.match(ask(join(root, 'p2', 'worker', SID), 'p1'), /not inside the outbox root/, 'another product\'s folder');
  assert.match(ask(join(root, 'worker', SID), 'p1'), /not inside the outbox root/, 'the old flat place');
  assert.match(ask(join(root, 'p1', 'script', SID), 'p1'), /is not a worker outbox/, 'the role is still checked');
  // m3: compared through realpath: a product folder that is a link to another product's is not this product's, and a
  // root reached through a link is the same root.
  symlinkSync(join(root, 'p2'), join(root, 'p1x'));
  assert.match(ask(join(root, 'p1x', 'worker', SID), 'p1x'), /not inside the outbox root/, 'p1x links to p2');
  const linkedRoot = join(tempDir('m4-outbox-link-'), 'root');
  symlinkSync(root, linkedRoot);
  assert.equal(outboxProblemFor(join(root, 'p1', 'worker', SID), SID, { outboxRoot: linkedRoot, product: 'p1' }), null, 'a linked root');
  assert.equal(outboxProblemFor(join(linkedRoot, 'p1', 'worker', SID), SID, { outboxRoot: root, product: 'p1' }), null, 'an outbox named through the linked root');
  for (const product of [undefined, '', 'P1', '..', 'p1/x', 'worker', 'Script']) assert.match(ask(join(root, 'p1', 'worker', SID), product), /^has no product folder to be in \(/, String(product));
  // c3: a root that is no full path is no place, never read against wherever the process runs.
  for (const bad of ['', 'outboxes', './outboxes', 7]) assert.match(outboxProblemFor(join(root, 'p1', 'worker', SID), SID, { outboxRoot: bad, product: 'p1' }), /the outbox root is not a full path/, String(bad));
  // #403 r1 M1: with no root, the shape, and the folder above the role must be this product's: never another
  // product's, the old flat place, or a product name the runner can't hold.
  assert.match(outboxProblemFor(join(root, 'p2', 'worker', SID), SID, { product: 'p1' }), /is not in product p1's own folder/, 'another product');
  assert.match(outboxProblemFor(join(root, 'worker', SID), SID, { product: 'p1' }), /is not in product p1's own folder/, 'the flat layout');
  assert.match(outboxProblemFor(join(root, 'p1', 'p1', 'worker', SID).replace('/p1/p1/', '/../p1/'), SID, { product: 'p1' }), /is not a plain path/, '..');
  for (const product of ['..', undefined, 'P1', 'worker']) assert.match(outboxProblemFor(join(root, 'p1', 'worker', SID), SID, { product }), /^has no product folder to be in \(/, String(product));
  assert.equal(outboxProblemFor(join(root, 'p1', 'worker', SID), SID, { product: 'p1' }), null);
  assert.equal(outboxProblemFor(join(root, 'p1', 'script', SID), SID, { product: 'p1', role: 'script' }), null);
  assert.match(outboxProblemFor('worker/S-1', SID, { product: 'p1' }), /not a full path/);
});
