// sessions.test.mjs — the Front Door's sessions by their outbox folder's name (Track A step 6).
// Run: node --test orchestrate/modules/M1-front-door/sessions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { SESSION_ID } from '../../shared/record-names.mjs';
import { frontDoorSessionId, frontDoorSessions, isFrontDoorSession } from './sessions.mjs';

test('a start\'s session id names the product and the time, and is a session id the Record takes', () => {
  const id = frontDoorSessionId('orchestrate-test', new Date(2026, 10, 23, 9, 5, 7));
  assert.equal(id, 'fd-orchestrate-test-20261123090507');
  assert.match(id, SESSION_ID);
  assert.ok(isFrontDoorSession(id, 'orchestrate-test'));
  assert.ok(!isFrontDoorSession(id, 'orchestrate'), 'product a never takes product a-b\'s tab');
  assert.ok(!isFrontDoorSession('fd-orchestrate-2026112309050', 'orchestrate'), 'thirteen digits is not a start');
  for (const bad of ['', 'A', 'a/b', '../x', 'a b']) assert.throws(() => frontDoorSessionId(bad), /not a product name/, bad);
});

test('frontDoorSessions lists this product\'s plain folders only, as front_door sessions of the owner; none set up is none', () => {
  const root = tempDir('m1-fd-sessions-');
  assert.deepEqual(frontDoorSessions({ outboxRoot: root, product: 'p', uid: 501 }), [], 'no Front Door folder yet');
  const fd = join(root, 'front_door');
  mkdirSync(join(fd, 'fd-p-20261123090507'), { recursive: true });
  mkdirSync(join(fd, 'fd-p-x-20261123090507'));
  writeFileSync(join(fd, 'fd-p-20261123090508'), 'a file, not a folder');
  symlinkSync(join(fd, 'fd-p-20261123090507'), join(fd, 'fd-p-20261123090509'));
  assert.deepEqual(frontDoorSessions({ outboxRoot: root, product: 'p', uid: 501 }),
    [{ sessionId: 'fd-p-20261123090507', role: 'front_door', outbox: join(fd, 'fd-p-20261123090507'), uid: 501, card: null, product: 'p' }]);
  assert.throws(() => frontDoorSessions({ outboxRoot: root, product: 'p', uid: undefined }), /owner's Mac user id/);
  assert.throws(() => frontDoorSessions({ outboxRoot: root, product: 'p', uid: 1, list: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } }), /no/, 'a folder that can\'t be listed throws, never "none"');
});
